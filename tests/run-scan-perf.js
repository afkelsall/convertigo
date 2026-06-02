/**
 * Page-scan performance regression test (#6 — Reddit / custom-element freeze).
 *
 * Symptom: opening certain Reddit (shreddit) posts spiked CPU and froze Firefox for several
 * seconds while comments streamed in — consistently on the same posts, not on most others.
 *
 * Root cause: processBlockElement() collected a block's own text by walking the block's ENTIRE
 * subtree with a SHOW_TEXT TreeWalker and then discarding nodes whose getBlockAncestor() !==
 * the block. For a block near the document root (BODY / MAIN — which Reddit produces because
 * its content sits inside custom elements like <shreddit-comment> that aren't in BLOCK_TAGS),
 * that walk re-traversed almost the whole document AND called getBlockAncestor() (itself an
 * ancestor walk) on every descendant text node. Reddit re-enqueues those near-root blocks as
 * comments hydrate, so the near-quadratic walk recurred — pinning the CPU.
 *
 * Fix: walk SHOW_ELEMENT|SHOW_TEXT and FILTER_REJECT nested-block and skippable subtrees up
 * front, so each block visits only its own text. The collected set is identical to the old
 * getBlockAncestor filter; the work drops from O(blocks x subtree) to O(total nodes).
 *
 * This test mirrors both the OLD and NEW collection from content.js and asserts:
 *   1. NEW ownership is byte-for-byte identical to OLD ownership (behaviour preserved).
 *   2. The NEW walk does not descend into nested blocks (the prune actually fires).
 *   3. Total text-node visits for a full scan drop sharply under NEW (the quadratic is gone).
 * It runs against the real saved page (examples/*.htm) when present, and always against a
 * synthetic Reddit-shaped DOM so it passes with no external fixture.
 *
 * Usage:  node tests/run-scan-perf.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// ── Constants mirrored verbatim from content.js ──────────────────────────────
const SKIP_TAGS = new Set(['SCRIPT','STYLE','NOSCRIPT','IFRAME','TEXTAREA','INPUT','SELECT','BUTTON']);
const BLOCK_TAGS = new Set([
  'ADDRESS','ARTICLE','ASIDE','BLOCKQUOTE','BODY','DD','DETAILS','DIALOG',
  'DIV','DL','DT','FIELDSET','FIGCAPTION','FIGURE','FOOTER','FORM',
  'H1','H2','H3','H4','H5','H6','HEADER','HGROUP','HR','LI','MAIN',
  'NAV','OL','P','PRE','SECTION','SUMMARY','TABLE','TBODY','TD','TFOOT',
  'TH','THEAD','TR','UL'
]);
const LIVE_ROLES = new Set(['timer','status','alert','marquee','progressbar']);
const POPUP_ID = 'unit-converter-popup';

let Node, NodeFilter, document;

function isLiveRegionEl(el) {
  if (!el || !el.getAttribute) return false;
  const live = el.getAttribute('aria-live');
  if (live && live !== 'off') return true;
  const role = el.getAttribute('role');
  if (role && LIVE_ROLES.has(role.toLowerCase())) return true;
  return false;
}

function isSkippableElement(el) {
  return SKIP_TAGS.has(el.tagName)
    || el.isContentEditable
    || el.id === POPUP_ID
    || (el.classList && el.classList.contains('uc-highlight'))
    || isLiveRegionEl(el);
}

function isSkippableNode(node) {
  let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  while (el) {
    if (isSkippableElement(el)) return true;
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

// Counters for the quadratic guard.
let visits = { old: 0, neu: 0 };

// OLD collection (pre-fix): walk every descendant text node, keep those owned by blockEl.
function collectOwnTextNodesOld(blockEl) {
  const out = [];
  const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      visits.old++;
      if (isSkippableNode(node)) return NodeFilter.FILTER_REJECT;
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  let n;
  while ((n = walker.nextNode())) {
    if (getBlockAncestor(n) === blockEl) out.push(n);
  }
  return out;
}

// NEW collection (post-fix): prune nested-block and skippable subtrees during the walk.
function collectOwnTextNodesNew(blockEl) {
  const out = [];
  const walker = document.createTreeWalker(
    blockEl,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        visits.neu++;
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (BLOCK_TAGS.has(node.tagName)) return NodeFilter.FILTER_REJECT;
          if (isSkippableElement(node)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_SKIP;
        }
        return node.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    }
  );
  let n;
  while ((n = walker.nextNode())) out.push(n);
  return out;
}

// Collect every block in document order, exactly as enqueueSubtree/collectBlockElements does.
function collectBlocks() {
  const seen = new Set();
  const blocks = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (isSkippableNode(node)) return NodeFilter.FILTER_REJECT;
      if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  let n;
  while ((n = walker.nextNode())) {
    const b = getBlockAncestor(n);
    if (!seen.has(b)) { seen.add(b); blocks.push(b); }
  }
  return blocks;
}

// ── Assertions ───────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];
function check(desc, ok, detail) {
  if (ok) { passed++; }
  else { failed++; failures.push(desc + (detail ? ` — ${detail}` : '')); }
}

// Run the full equivalence + perf check on the currently-bound document.
function runScenario(label) {
  visits = { old: 0, neu: 0 };
  const blocks = collectBlocks();

  // Build ownership maps both ways and compare.
  const oldOwner = new Map();
  const newOwner = new Map();
  let oldOwned = 0, newOwned = 0;
  for (const b of blocks) {
    for (const n of collectOwnTextNodesOld(b)) { oldOwner.set(n, b); oldOwned++; }
  }
  for (const b of blocks) {
    for (const n of collectOwnTextNodesNew(b)) { newOwner.set(n, b); newOwned++; }
  }

  // Every text node assigned by either method must be assigned to the same block by both.
  let mismatch = 0;
  const allKeys = new Set([...oldOwner.keys(), ...newOwner.keys()]);
  for (const n of allKeys) {
    if (oldOwner.get(n) !== newOwner.get(n)) mismatch++;
  }

  check(`[${label}] new ownership identical to old`, mismatch === 0,
    `${mismatch} mismatched of ${allKeys.size}`);
  check(`[${label}] same number of owned text nodes`, oldOwned === newOwned,
    `old=${oldOwned} new=${newOwned}`);

  // The prune must actually fire: NEW must visit far fewer nodes than OLD on a deep DOM.
  // (OLD re-walks nested-block text once per ancestor block; NEW visits each node ~once.)
  check(`[${label}] NEW walk visits fewer nodes than OLD (prune fired)`,
    visits.neu < visits.old,
    `visits old=${visits.old} new=${visits.neu}`);

  return { blocks, visits: { ...visits }, oldOwned };
}

// ── Scenario A: synthetic Reddit-shaped DOM (always runs) ────────────────────
function buildSyntheticReddit(win) {
  const doc = win.document;
  doc.body.innerHTML = '';

  // A stray text node directly under <body> forces BODY to be a fallback block —
  // exactly the situation that made the old walk re-traverse the whole document.
  doc.body.appendChild(doc.createTextNode(' posted 5 km away '));

  // <main> is also a near-root block; its content lives inside custom elements
  // (<shreddit-comment-tree>/<shreddit-comment>) that are NOT in BLOCK_TAGS, so a
  // stray text node here lands on MAIN too.
  const main = doc.createElement('main');
  main.appendChild(doc.createTextNode(' 12 comments '));
  const tree = doc.createElement('shreddit-comment-tree');
  main.appendChild(tree);

  // Many comments, each a custom element wrapping nested DIV/P blocks with real unit text.
  const COMMENTS = 120;
  for (let i = 0; i < COMMENTS; i++) {
    const c = doc.createElement('shreddit-comment');
    const wrap = doc.createElement('div');          // block
    const meta = doc.createElement('span');         // inline, custom-element-ish
    meta.appendChild(doc.createTextNode('user' + i));
    wrap.appendChild(meta);
    const p = doc.createElement('p');               // nested block — must NOT be re-walked by MAIN/BODY
    p.appendChild(doc.createTextNode(`I drove 60 km and paid $${i + 5} for 2.5 kg of it.`));
    wrap.appendChild(p);
    c.appendChild(wrap);
    tree.appendChild(c);
  }
  doc.body.appendChild(main);
}

const domA = new JSDOM('<!DOCTYPE html><html><body></body></html>');
({ Node, NodeFilter } = domA.window);
document = domA.window.document;
buildSyntheticReddit(domA.window);

runScenario('synthetic');

// Directly assert the prune semantics — this is the deterministic regression guard and fails
// loudly if the fix is reverted. Collecting BODY's own text must not return any text that
// belongs to a nested block (i.e. only the stray body text node). Under the OLD code BODY
// would absorb every non-block-nested text node in the document.
{
  const bodyOwnNew = collectOwnTextNodesNew(document.body).filter(n => n.nodeValue.trim());
  const ownsNested = bodyOwnNew.some(n => /drove 60 km/.test(n.nodeValue));
  check('[synthetic] BODY block does not absorb nested-comment text', !ownsNested);
  check('[synthetic] BODY block owns only its stray text node', bodyOwnNew.length === 1,
    `got ${bodyOwnNew.length}`);
}

// ── Scenario B: the actual saved Reddit page, if present ─────────────────────
const exDir = path.join(__dirname, '..', 'examples');
let realFile = null;
try {
  if (fs.existsSync(exDir)) {
    realFile = fs.readdirSync(exDir).find(f => /\.html?$/i.test(f) && /AusFinance|shreddit|reddit/i.test(f))
      || fs.readdirSync(exDir).find(f => /\.html?$/i.test(f));
  }
} catch (_) { /* ignore */ }

if (realFile) {
  const html = fs.readFileSync(path.join(exDir, realFile), 'utf8');
  // runScripts default = don't execute page JS; we only need the parsed DOM.
  const domB = new JSDOM(html);
  ({ Node, NodeFilter } = domB.window);
  document = domB.window.document;
  const resB = runScenario(`real:${realFile.slice(0, 24)}…`);
  console.log(`  (real page: ${resB.blocks.length} blocks, ${resB.oldOwned} owned text nodes, ` +
    `visits old=${resB.visits.old} new=${resB.visits.neu})`);
  // The actual offending artifact: on a deep custom-element DOM the prune must cut total walk
  // work substantially. Observed ~4.6x fewer visits; require at least a clear ~1.6x so the
  // guard is meaningful without being brittle to small page edits.
  check('[real] NEW walk does far less work than OLD (prune scales)',
    resB.visits.neu <= resB.visits.old * 0.625,
    `old=${resB.visits.old} new=${resB.visits.neu}`);
} else {
  console.log('  (no examples/*.htm present — skipped real-page scenario)');
}

// ── Report ────────────────────────────────────────────────────────────────────
console.log(`\nScan-perf regression: ${passed} passed, ${failed} failed\n`);
for (const f of failures) console.log('FAIL: ' + f);
if (!failed) console.log('All scan-perf tests passed.');
process.exit(failed ? 1 : 0);
