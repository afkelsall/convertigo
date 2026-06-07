/**
 * Editable-churn mutation-handler regression test (stuttery text entry in rich editors).
 *
 * Symptom: typing into a Reddit reply box (a Lexical `contenteditable` rich-text editor) was
 * stuttery — a few characters, a ~200ms freeze, a few more, another freeze. Every keystroke,
 * Lexical reconciles its DOM by inserting/replacing element nodes inside the contenteditable.
 *
 * Cause: the MutationObserver added-node handler in content.js had a gap. Its TEXT_NODE branch
 * guarded with `!isSkippableNode(parent)` (so text typed into an editable is ignored), but its
 * ELEMENT_NODE branch had NO such guard. So each element Lexical added inside the editable ran
 * getBlockAncestor(), cleared dataset.ucScanned on the enclosing block, and enqueued a scan —
 * pure waste, since nothing inside a contenteditable is ever highlighted. The cleared ucScanned
 * also forced a re-parse of the enclosing block on the next mutation.
 *
 * Fix (content.js): add `if (isSkippableNode(node)) continue;` to the ELEMENT_NODE branch,
 * making it symmetric with the TEXT_NODE branch. Elements added inside contenteditable / input /
 * textarea subtrees are now ignored, so typing generates no scan churn.
 *
 * This test mirrors the added-node loop (with the guard) and asserts:
 *   1. An element added inside a contenteditable is NOT enqueued and clears no ucScanned flag.
 *   2. With the guard removed, that same element WOULD be enqueued (proves the guard is load-bearing).
 *   3. An element added in a normal block is still enqueued (the fix doesn't over-suppress).
 * Runs against a synthetic composer, plus the real saved Reddit page when present.
 *
 * Usage:  node tests/run-editable-mutation.js
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

let Node, document;

// content.js uses the live `el.isContentEditable` IDL property (correct in real Firefox).
// jsdom doesn't implement it, so for the test we emulate it by checking the inherited
// `contenteditable` attribute as the upward walk passes the editor element.
function isContentEditableEmu(el) {
  if (!el.getAttribute) return false;
  const v = el.getAttribute('contenteditable');
  return v === '' || v === 'true' || v === 'plaintext-only';
}

function isSkippableNode(node) {
  let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  while (el) {
    if (SKIP_TAGS.has(el.tagName) || isContentEditableEmu(el)
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

// Mirror of content.js's added-node loop for a single added ELEMENT node. `guard` toggles the
// fix so the test can demonstrate the regression it prevents. Returns the effect on the scan
// machinery: roots enqueued and blocks whose ucScanned flag was cleared.
function handleAddedElement(node, { guard }) {
  const roots = [];
  const clearedBlocks = [];
  if (node.nodeType === Node.ELEMENT_NODE && !node.classList.contains('uc-highlight')) {
    if (guard && isSkippableNode(node)) return { roots, clearedBlocks };
    const block = getBlockAncestor(node);
    if (block) { delete block.dataset.ucScanned; clearedBlocks.push(block); }
    roots.push(node);
  }
  return { roots, clearedBlocks };
}

// ── Assertions ───────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];
function check(desc, ok, detail) {
  if (ok) passed++;
  else { failed++; failures.push(desc + (detail ? ` — ${detail}` : '')); }
}

// ── Scenario A: synthetic composer inside a comment block ─────────────────────
const domA = new JSDOM('<!DOCTYPE html><html><body></body></html>');
({ Node } = domA.window);
document = domA.window.document;

// A comment block that has already been scanned, containing a Lexical-style editor.
const commentBlock = document.createElement('div');
commentBlock.dataset.ucScanned = '1';
const editor = document.createElement('div');
editor.setAttribute('contenteditable', 'true');
const para = document.createElement('p');           // Lexical's <p> wrapper
editor.appendChild(para);
commentBlock.appendChild(editor);
document.body.appendChild(commentBlock);

// Lexical inserts a new <span data-lexical-text> on a keystroke.
const typedSpan = document.createElement('span');
typedSpan.setAttribute('data-lexical-text', 'true');
para.appendChild(typedSpan);

const guarded = handleAddedElement(typedSpan, { guard: true });
check('[synthetic] element added inside contenteditable is not enqueued',
  guarded.roots.length === 0, `roots=${guarded.roots.length}`);
check('[synthetic] no ucScanned flag cleared by editable churn',
  guarded.clearedBlocks.length === 0 && commentBlock.dataset.ucScanned === '1');

// Without the guard, the same insertion would churn the scan machinery (the original bug).
const unguarded = handleAddedElement(typedSpan, { guard: false });
check('[synthetic] guard is load-bearing: without it the element IS enqueued',
  unguarded.roots.length === 1, `roots=${unguarded.roots.length}`);

// A normal element added in ordinary page content must still be enqueued (no over-suppression).
// Use a non-block <span> so its nearest BLOCK ancestor is the article wrapper.
const article = document.createElement('div');
article.dataset.ucScanned = '1';
document.body.appendChild(article);
const newSpan = document.createElement('span');
newSpan.appendChild(document.createTextNode('It is 50 kg.'));
article.appendChild(newSpan);
const normal = handleAddedElement(newSpan, { guard: true });
check('[synthetic] element added in normal content is still enqueued',
  normal.roots.length === 1 && normal.clearedBlocks.includes(article)
    && article.dataset.ucScanned === undefined,
  `roots=${normal.roots.length}`);

// ── Scenario B: the real saved Reddit page, if present ────────────────────────
const exDir = path.join(__dirname, '..', 'examples');
let realFile = null;
try {
  if (fs.existsSync(exDir)) {
    realFile = fs.readdirSync(exDir).find(f => /\.html?$/i.test(f) && /entry|composer|reply/i.test(f))
      || fs.readdirSync(exDir).find(f => /\.html?$/i.test(f) && /AusFinance|shreddit|reddit/i.test(f));
  }
} catch (_) { /* ignore */ }

if (realFile) {
  // Strip <style> blocks — jsdom throws on the page's malformed CSS, and this is a
  // DOM-structure test that has no use for stylesheets.
  const html = fs.readFileSync(path.join(exDir, realFile), 'utf8')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  const domB = new JSDOM(html);
  ({ Node } = domB.window);
  document = domB.window.document;

  const realEditor = document.querySelector('[contenteditable="true"]');
  if (realEditor) {
    // Simulate Lexical inserting an element inside the real composer's editable.
    const host = realEditor.querySelector('p') || realEditor;
    const span = document.createElement('span');
    span.setAttribute('data-lexical-text', 'true');
    host.appendChild(span);

    const r = handleAddedElement(span, { guard: true });
    check('[real] element added inside the real Reddit composer is not enqueued',
      r.roots.length === 0 && r.clearedBlocks.length === 0, `roots=${r.roots.length}`);
    console.log(`  (real page: ${realFile} — composer editable found)`);
  } else {
    console.log(`  (real page ${realFile} has no [contenteditable] — skipped real-page scenario)`);
  }
} else {
  console.log('  (no examples/*.htm with a composer present — skipped real-page scenario)');
}

// ── Report ────────────────────────────────────────────────────────────────────
console.log(`\nEditable-churn mutation regression: ${passed} passed, ${failed} failed\n`);
for (const f of failures) console.log('FAIL: ' + f);
if (!failed) console.log('All editable-churn mutation tests passed.');
process.exit(failed ? 1 : 0);
