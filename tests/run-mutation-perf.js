/**
 * Mutation-handler performance regression test (#7 — Reddit comment-tree freeze).
 *
 * Symptom: opening a busy Reddit post froze Firefox for ~16 seconds. Instrumentation pinned it
 * to ONE mutation batch whose synchronous handler ran 16,135ms: 96 enqueueSubtree() calls that
 * collectively walked 321,811 text nodes — on a page with only ~5,000. The ~60x blowup came
 * from the observer reporting a freshly-inserted subtree as the container AND many of its
 * descendants as separate added nodes; each was walked in full, so nested subtrees were
 * re-walked once per ancestor. All of it ran synchronously in the observer callback.
 *
 * Fix (content.js):
 *   1. coalesceRoots() — reduce a batch of added roots to only the top-most (drop any root
 *      that is a descendant of another root in the batch), so each subtree is walked once.
 *   2. Lazy, budgeted collection — the actual subtree walk is deferred to the idle drain and
 *      chunked by the idle deadline (resumable walker), so a big insertion can never block the
 *      main thread.
 *
 * This test mirrors both and asserts:
 *   1. coalesceRoots returns only the top-most roots.
 *   2. Walking coalesced roots visits each node ~once (OLD per-root walk is many-x more).
 *   3. The budgeted collectStep is resumable and yields exactly the same blocks as one full
 *      walk, while never exceeding its per-slice node budget (no synchronous freeze).
 * Runs against a synthetic comment tree, plus the real saved page when present.
 *
 * Usage:  node tests/run-mutation-perf.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SKIP_TAGS = new Set(['SCRIPT','STYLE','NOSCRIPT','IFRAME','TEXTAREA','INPUT','SELECT','BUTTON']);
const BLOCK_TAGS = new Set([
  'ADDRESS','ARTICLE','ASIDE','BLOCKQUOTE','BODY','DD','DETAILS','DIALOG',
  'DIV','DL','DT','FIELDSET','FIGCAPTION','FIGURE','FOOTER','FORM',
  'H1','H2','H3','H4','H5','H6','HEADER','HGROUP','HR','LI','MAIN',
  'NAV','OL','P','PRE','SECTION','SUMMARY','TABLE','TBODY','TD','TFOOT',
  'TH','THEAD','TR','UL'
]);

let Node, NodeFilter, document;

function isSkippableNode(node) {
  let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  while (el) {
    if (SKIP_TAGS.has(el.tagName) || el.isContentEditable
      || (el.classList && el.classList.contains('uc-highlight'))) return true;
    el = el.parentElement;
  }
  return false;
}

function getBlockAncestor(node) {
  let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  while (el) {
    if (BLOCK_TAGS.has(el.tagName)) return el;
    el = el.parentElement;
  }
  return document.body;
}

let visits = 0;
function makeCollectWalker(root) {
  return document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      visits++;
      if (isSkippableNode(node)) return NodeFilter.FILTER_REJECT;
      if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
}

// Mirror of content.js coalesceRoots.
function coalesceRoots(roots) {
  const set = new Set(roots);
  const top = [];
  for (const r of set) {
    if (!r || !r.isConnected) continue;
    let p = r.parentElement, covered = false;
    while (p) { if (set.has(p)) { covered = true; break; } p = p.parentElement; }
    if (!covered) top.push(r);
  }
  return top;
}

// ── Assertions ───────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];
function check(desc, ok, detail) {
  if (ok) passed++;
  else { failed++; failures.push(desc + (detail ? ` — ${detail}` : '')); }
}

// Build a synthetic comment tree: a container holding many comments, each with nested blocks.
function buildCommentTree(doc, count) {
  const container = doc.createElement('div');
  for (let i = 0; i < count; i++) {
    const comment = doc.createElement('shreddit-comment');
    const body = doc.createElement('div');
    const p = doc.createElement('p');
    p.appendChild(doc.createTextNode(`Comment ${i}: drove 60 km, paid $${i + 5}.`));
    body.appendChild(p);
    comment.appendChild(body);
    container.appendChild(comment);
  }
  return container;
}

// Simulate the observer's added-node list for inserting `container`: the container PLUS every
// descendant element (this is the pathological shape that caused the 60x re-walk).
function allElements(root) {
  const out = [root];
  const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let n;
  while ((n = w.nextNode())) out.push(n);
  return out;
}

// ── Scenario A: synthetic comment tree ───────────────────────────────────────
const domA = new JSDOM('<!DOCTYPE html><html><body></body></html>');
({ Node, NodeFilter } = domA.window);
document = domA.window.document;

const container = buildCommentTree(document, 100);
document.body.appendChild(container);
const addedNodes = allElements(container);   // container + all descendant elements

// (1) coalesce returns only the container (every other added node descends from it).
const top = coalesceRoots(addedNodes);
check('[synthetic] coalesce reduces all added nodes to the single top-most root',
  top.length === 1 && top[0] === container,
  `got ${top.length} roots`);

// (2) OLD (walk every added root) vs NEW (walk only coalesced roots) visit counts.
visits = 0;
for (const r of addedNodes) { const w = makeCollectWalker(r); while (w.nextNode()) {} }
const oldVisits = visits;

visits = 0;
for (const r of top) { const w = makeCollectWalker(r); while (w.nextNode()) {} }
const newVisits = visits;

// Shallow synthetic tree shows a modest multiple; the real-page scenario below exercises the
// deep-DOM blowup (~15x) that actually caused the freeze.
check('[synthetic] coalesced walk visits each node fewer times than per-root walk',
  newVisits * 2 <= oldVisits,
  `old=${oldVisits} new=${newVisits}`);

// (3) Budgeted, resumable collection yields the same blocks as one full walk, and never
// exceeds its per-slice node budget (proving it can't run as one synchronous freeze).
function fullWalkBlocks(roots) {
  const set = new Set();
  for (const r of roots) {
    const w = makeCollectWalker(r);
    let n;
    while ((n = w.nextNode())) set.add(getBlockAncestor(n));
  }
  return set;
}

// Resumable collectStep mirroring content.js: walks pending roots into a block list, stopping
// when the (simulated) idle deadline runs low; leaves a partial walker to resume next call.
function runBudgetedCollection(roots, sliceBudget) {
  const COLLECT_MIN_SLICE = 2;
  const pending = roots.slice();
  let active = null;
  const queued = new Set();
  let maxSlice = 0, slices = 0;

  while (active || pending.length) {
    slices++;
    let used = 0;                                   // nodes visited this slice
    const deadline = { timeRemaining: () => sliceBudget - used + COLLECT_MIN_SLICE + 1 };
    // (timeRemaining stays > COLLECT_MIN_SLICE until `used` reaches sliceBudget)
    while ((active || pending.length) && deadline.timeRemaining() > COLLECT_MIN_SLICE) {
      if (!active) {
        const root = pending.shift();
        if (!root || !root.isConnected) continue;
        active = makeCollectWalker(root);
      }
      let finished = false;
      while (deadline.timeRemaining() > COLLECT_MIN_SLICE) {
        const node = active.nextNode();
        used++;
        if (!node) { finished = true; break; }
        queued.add(getBlockAncestor(node));
      }
      if (finished) active = null;
      else break;
    }
    if (used > maxSlice) maxSlice = used;
    if (slices > 100000) break;   // guard against an infinite loop in a broken implementation
  }
  return { queued, maxSlice, slices };
}

const expectedBlocks = fullWalkBlocks(top);
const SLICE = 50;
const budgeted = runBudgetedCollection(top, SLICE);

check('[synthetic] budgeted collection finds exactly the full-walk block set',
  budgeted.queued.size === expectedBlocks.size
    && [...expectedBlocks].every(b => budgeted.queued.has(b)),
  `budgeted=${budgeted.queued.size} full=${expectedBlocks.size}`);
check('[synthetic] collection ran in multiple resumable slices (not one synchronous pass)',
  budgeted.slices > 1, `slices=${budgeted.slices}`);
check('[synthetic] no slice exceeded its node budget (can\'t freeze the main thread)',
  budgeted.maxSlice <= SLICE + 2, `maxSlice=${budgeted.maxSlice} budget=${SLICE}`);

// ── Scenario B: the real saved Reddit page, if present ───────────────────────
const exDir = path.join(__dirname, '..', 'examples');
let realFile = null;
try {
  if (fs.existsSync(exDir)) {
    realFile = fs.readdirSync(exDir).find(f => /\.html?$/i.test(f) && /AusFinance|shreddit|reddit/i.test(f))
      || fs.readdirSync(exDir).find(f => /\.html?$/i.test(f));
  }
} catch (_) { /* ignore */ }

if (realFile) {
  const domB = new JSDOM(fs.readFileSync(path.join(exDir, realFile), 'utf8'));
  ({ Node, NodeFilter } = domB.window);
  document = domB.window.document;

  // Simulate the observer reporting the whole body subtree as added nodes (container + every
  // descendant element) — the exact pathology from the log.
  const added = allElements(document.body);
  const topB = coalesceRoots(added);

  visits = 0;
  for (const r of added) { const w = makeCollectWalker(r); while (w.nextNode()) {} }
  const oldV = visits;
  visits = 0;
  for (const r of topB) { const w = makeCollectWalker(r); while (w.nextNode()) {} }
  const newV = visits;

  check('[real] coalesce collapses the added-node list to a handful of top-most roots',
    topB.length <= 3, `roots=${topB.length}`);
  check('[real] coalesced walk does far less work than per-root walk',
    newV * 10 <= oldV, `old=${oldV} new=${newV}`);
  console.log(`  (real page: ${added.length} added nodes -> ${topB.length} roots, `
    + `visits per-root=${oldV} coalesced=${newV})`);
} else {
  console.log('  (no examples/*.htm present — skipped real-page scenario)');
}

// ── Report ────────────────────────────────────────────────────────────────────
console.log(`\nMutation-perf regression: ${passed} passed, ${failed} failed\n`);
for (const f of failures) console.log('FAIL: ' + f);
if (!failed) console.log('All mutation-perf tests passed.');
process.exit(failed ? 1 : 0);
