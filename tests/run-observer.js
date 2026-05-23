/**
 * Observer self-suppression regression test (#1).
 *
 * Reproduces the high-CPU re-scan loop seen on live sites (Reddit, live-auction pages):
 * when processBlockElement highlights a match it calls range.extractContents(), which
 * splits the surrounding text node and fires a characterData mutation. With a live
 * MutationObserver attached, that self-generated mutation cleared dataset.ucScanned and
 * re-enqueued the very block we just scanned — endless self-induced churn.
 *
 * The fix: drainScanQueue calls ucObserver.takeRecords() after its synchronous writes,
 * discarding the records our own DOM edits generated. This test wires up a real
 * MutationObserver mirroring content.js and asserts:
 *   - scanning a block does NOT re-scan it (no self-induced churn), and
 *   - a genuine page edit afterwards DOES still trigger a re-scan.
 *
 * Usage:  node tests/run-observer.js
 */

'use strict';

const path = require('path');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
const window   = dom.window;
const document = window.document;

global.window           = window;
global.document         = document;
global.Node             = window.Node;
global.NodeFilter       = window.NodeFilter;
global.MutationObserver = window.MutationObserver;

global.browser = {
  runtime: { sendMessage: () => Promise.reject(new Error('not available in tests')) },
  storage: { local: { get: () => Promise.resolve({}) }, onChanged: { addListener: () => {} } }
};

const libDir = path.join(__dirname, '..', 'lib');
require(path.join(libDir, 'settings.js'));
require(path.join(libDir, 'parser.js'));
require(path.join(libDir, 'converter.js'));
require(path.join(libDir, 'currency-parser.js'));
require(path.join(libDir, 'currency-converter.js'));

const opts = { dollarCurrency: 'USD', targetCurrency: 'AUD' };

// ── Minimal mirror of content.js scan + observer machinery ──────────────────
// Instrumented with parseCount so we can prove a block is parsed only once.

let parseCount = 0;
let ucObserver = null;
let scanQueue = [];

function processBlockElement(blockEl) {
  if (!blockEl.isConnected || blockEl.dataset.ucScanned) return;

  const textNodes = [];
  const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
      let el = node.parentElement;
      while (el && el !== blockEl) {
        if (el.classList && el.classList.contains('uc-highlight')) return NodeFilter.FILTER_REJECT;
        el = el.parentElement;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  let n;
  while ((n = walker.nextNode())) textNodes.push(n);

  blockEl.dataset.ucScanned = '1';
  if (textNodes.length === 0) return;

  let fullText = '';
  const segments = [];
  for (const tn of textNodes) {
    segments.push({ node: tn, start: fullText.length, end: fullText.length + tn.nodeValue.length });
    fullText += tn.nodeValue;
  }

  parseCount++;  // count only real parse passes (post-guard, has text)

  const matches = window.UnitParser.parse(fullText);
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    const matchStart = m.index, matchEnd = m.index + m.matchLength;
    const startSeg = segments.find(s => matchStart >= s.start && matchStart < s.end);
    const endSeg   = segments.find(s => matchEnd   >  s.start && matchEnd   <= s.end);
    if (!startSeg || !endSeg) continue;
    const range = document.createRange();
    range.setStart(startSeg.node, matchStart - startSeg.start);
    range.setEnd(endSeg.node, matchEnd - endSeg.start);
    const span = document.createElement('span');
    span.className = 'uc-highlight';
    span.dataset.ucOriginal = fullText.slice(matchStart, matchEnd);
    span.appendChild(range.extractContents());
    range.insertNode(span);
  }
}

// Drains synchronously (no requestIdleCallback in this harness), then discards the
// mutation records our own writes generated — the actual fix under test.
function drainScanQueue() {
  while (scanQueue.length > 0) {
    const blockEl = scanQueue.shift();
    if (blockEl.isConnected) processBlockElement(blockEl);
  }
  if (ucObserver) ucObserver.takeRecords();
}

const BLOCK_TAGS = new Set(['DIV', 'P', 'LI', 'TD', 'SECTION', 'ARTICLE', 'BODY']);
function getBlockAncestor(node) {
  let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  while (el) {
    if (BLOCK_TAGS.has(el.tagName)) return el;
    el = el.parentElement;
  }
  return document.body;
}

function startObserver() {
  ucObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'characterData') {
        const el = m.target.parentElement;
        if (!el) continue;
        const staleSpan = el.classList.contains('uc-highlight') ? el
          : (el.closest ? el.closest('.uc-highlight') : null);
        if (staleSpan) {
          const block = getBlockAncestor(staleSpan);
          staleSpan.replaceWith(document.createTextNode(staleSpan.textContent));
          delete block.dataset.ucScanned;
          scanQueue.push(block);
        } else {
          const block = getBlockAncestor(el);
          delete block.dataset.ucScanned;
          scanQueue.push(block);
        }
      }
    }
    if (scanQueue.length > 0) drainScanQueue();
  });
  ucObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
}

// jsdom delivers MutationObserver callbacks as microtasks; await one to flush them.
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

// ── Tests ───────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
const failures = [];
function check(desc, ok) {
  if (ok) { passed++; } else { failed++; failures.push(desc); }
}

(async function run() {
  startObserver();

  // O1: scanning a block whose match sits mid-text (so extractContents splits the node)
  // must NOT re-scan the block via the self-generated characterData mutation.
  const p = document.createElement('p');
  p.textContent = 'It weighs 50 kg total';   // "50 kg" is mid-text → node split on extract
  document.body.appendChild(p);

  scanQueue.push(p);
  drainScanQueue();
  const countAfterScan = parseCount;

  check('O1: block highlighted on first scan',
    p.querySelector('.uc-highlight') !== null &&
    p.querySelector('.uc-highlight').dataset.ucOriginal === '50 kg');
  check('O1: block parsed exactly once during scan', countAfterScan === 1);

  await flush();  // let any self-generated mutations be delivered

  check('O1: no self-induced re-parse after flush (parseCount unchanged)',
    parseCount === countAfterScan);
  check('O1: ucScanned remained set (block not re-enqueued by our own edits)',
    p.dataset.ucScanned === '1');
  check('O1: scan queue is empty (no churn pending)', scanQueue.length === 0);

  // O2: a genuine page edit (text node value changed by "the page") must still trigger
  // a re-scan — proving takeRecords only discards our edits, not real ones.
  const span = p.querySelector('.uc-highlight');
  span.firstChild.nodeValue = '60 kg';   // simulate page mutating the value in place
  await flush();

  check('O2: real page edit re-scanned the block (parsed again)',
    parseCount === countAfterScan + 1);
  check('O2: highlight reflects the updated value',
    p.querySelector('.uc-highlight') !== null &&
    p.querySelector('.uc-highlight').dataset.ucOriginal === '60 kg');

  await flush();  // ensure the re-scan didn't itself spawn further churn
  check('O2: re-scan settled (no further pending churn)',
    scanQueue.length === 0 && parseCount === countAfterScan + 1);

  // ── Report ──
  console.log(`\nObserver self-suppression (#1): ${passed} passed, ${failed} failed, ${passed + failed} total\n`);
  for (const f of failures) console.log(`FAIL: ${f}`);
  if (!failed) console.log('All observer tests passed.');
  ucObserver.disconnect();
  process.exit(failed ? 1 : 0);
})();
