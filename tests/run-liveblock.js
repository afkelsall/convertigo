/**
 * Live-region back-off regression test (#5).
 *
 * Some live pages (e.g. the Australian Whisky Auctions live-auction listings) update the
 * DOM continuously via countdown timers and streaming bids, WITHOUT declaring aria-live or
 * role="timer" on those elements. The aria/role skip (#2) therefore can't exclude them, and
 * the per-block throttle (#3) only paces re-scans to ~1/sec — so a page full of ticking lots
 * still re-walks + re-parses every block every second forever, pinning the CPU.
 *
 * The fix: processBlockElement counts scans of each block in a rolling LIVE_WINDOW_MS window.
 * A block scanned LIVE_SCAN_THRESHOLD times in that window is classified live, its highlights
 * are stripped, and it is added to liveBlocks. isSkippableNode then rejects everything inside
 * it, so it is never enqueued or parsed again.
 *
 * This mirrors the relevant content.js machinery (content.js is an auto-running IIFE that
 * can't be imported) with an injectable clock so the time-window logic is deterministic.
 *
 * Usage:  node tests/run-liveblock.js
 */

'use strict';

const path = require('path');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
const window   = dom.window;
const document = window.document;

global.window     = window;
global.document   = document;
global.Node       = window.Node;
global.NodeFilter = window.NodeFilter;

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

// ── Constants mirrored from content.js ──────────────────────────────────────
const RESCAN_THROTTLE_MS  = 1000;
const LIVE_WINDOW_MS      = 5000;
const LIVE_SCAN_THRESHOLD = 3;

// ── Injectable clock ────────────────────────────────────────────────────────
let clock = 0;
const now = () => clock;

// ── State mirrored from content.js ──────────────────────────────────────────
let parseCount     = 0;
let blockScanTimes = new WeakMap();
let blockActivity  = new WeakMap();
let liveBlocks     = new WeakSet();

function isSkippableNode(node) {
  let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  while (el) {
    if (el.classList && el.classList.contains('uc-highlight')) return true;
    if (liveBlocks.has(el)) return true;
    el = el.parentElement;
  }
  return false;
}

// Faithful mirror of content.js processBlockElement's guards + throttle + live back-off.
// Returns 'live' | 'throttled' | 'scanned' so the driver can assert outcomes.
function processBlockElement(blockEl) {
  if (!blockEl.isConnected) return 'skip';
  if (blockEl.dataset.ucScanned) return 'skip';
  if (liveBlocks.has(blockEl)) { blockEl.dataset.ucScanned = '1'; return 'live'; }

  const t = now();
  const lastScan = blockScanTimes.get(blockEl);
  if (lastScan !== undefined && t - lastScan < RESCAN_THROTTLE_MS) {
    blockEl.dataset.ucScanned = '1';
    return 'throttled';
  }
  blockScanTimes.set(blockEl, t);

  const act = blockActivity.get(blockEl);
  if (!act || t - act.windowStart > LIVE_WINDOW_MS) {
    blockActivity.set(blockEl, { windowStart: t, count: 1 });
  } else if (++act.count >= LIVE_SCAN_THRESHOLD) {
    liveBlocks.add(blockEl);
    blockActivity.delete(blockEl);
    blockEl.dataset.ucScanned = '1';
    blockEl.querySelectorAll('.uc-highlight').forEach(span => {
      span.replaceWith(document.createTextNode(span.dataset.ucOriginal || span.textContent));
    });
    return 'live';
  }

  // Collect text nodes (skipping our own highlights / live subtrees) and parse.
  const textNodes = [];
  const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (isSkippableNode(node)) return NodeFilter.FILTER_REJECT;
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  let n;
  while ((n = walker.nextNode())) textNodes.push(n);

  blockEl.dataset.ucScanned = '1';
  if (textNodes.length === 0) return 'scanned';

  let fullText = '';
  const segments = [];
  for (const tn of textNodes) {
    segments.push({ node: tn, start: fullText.length, end: fullText.length + tn.nodeValue.length });
    fullText += tn.nodeValue;
  }

  parseCount++;

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
  return 'scanned';
}

// Simulate one "tick" of a live element: the page clears our scanned flag (its mutation
// would have done so via the observer) and the block is re-processed at the current clock.
function tick(blockEl) {
  delete blockEl.dataset.ucScanned;
  return processBlockElement(blockEl);
}

// ── Tests ───────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];
function check(desc, ok) {
  if (ok) { passed++; } else { failed++; failures.push(desc); }
}

// L1: a block that keeps tripping re-scans inside the window is classified live and stops.
(function liveDetection() {
  clock = 0;
  parseCount = 0;
  blockScanTimes = new WeakMap();
  blockActivity  = new WeakMap();
  liveBlocks     = new WeakSet();

  const p = document.createElement('p');
  p.textContent = 'Lot ends in 50 kg';   // contains a parseable unit so it gets highlighted
  document.body.appendChild(p);

  const r1 = processBlockElement(p);                 // t=0   → scan #1
  check('L1: first scan parses and highlights',
    r1 === 'scanned' && parseCount === 1 && p.querySelector('.uc-highlight') !== null);

  clock = 1001; const r2 = tick(p);                  // t=1001 → scan #2 (count=2)
  check('L1: second scan still parses (below threshold)',
    r2 === 'scanned' && parseCount === 2);

  clock = 2002; const r3 = tick(p);                  // t=2002 → scan #3 (count=3 → live)
  check('L1: third scan within window flips block to live', r3 === 'live');
  check('L1: going live did not parse again', parseCount === 2);
  check('L1: highlights stripped when block went live', p.querySelector('.uc-highlight') === null);
  check('L1: block recorded in liveBlocks', liveBlocks.has(p));

  clock = 3003; const r4 = tick(p);                  // further ticks are cheap no-ops
  clock = 4004; const r5 = tick(p);
  check('L1: subsequent ticks short-circuit as live', r4 === 'live' && r5 === 'live');
  check('L1: no further parsing after back-off', parseCount === 2);

  // Text nodes inside a live block must be rejected so it is never re-enqueued.
  const tn = p.firstChild;
  check('L1: live block text is now skippable', tn && isSkippableNode(tn) === true);

  document.body.removeChild(p);
})();

// L2: a block that mutates slowly (scans spaced beyond the window) must NOT be misclassified.
(function noFalsePositive() {
  clock = 0;
  parseCount = 0;
  blockScanTimes = new WeakMap();
  blockActivity  = new WeakMap();
  liveBlocks     = new WeakSet();

  const p = document.createElement('p');
  p.textContent = 'Weighs 50 kg total';
  document.body.appendChild(p);

  processBlockElement(p);                 // t=0
  clock = 6000; tick(p);                  // window elapsed → counter resets
  clock = 12000; tick(p);                 // window elapsed again → counter resets

  check('L2: slow re-scans never trip the live back-off', liveBlocks.has(p) === false);
  check('L2: slow block keeps parsing each genuine change', parseCount === 3);

  document.body.removeChild(p);
})();

// L3: the per-block throttle (#3) still suppresses bursts within RESCAN_THROTTLE_MS,
//     and a throttled hit must NOT count toward the live-detection window.
(function throttleStillCountsOnce() {
  clock = 0;
  parseCount = 0;
  blockScanTimes = new WeakMap();
  blockActivity  = new WeakMap();
  liveBlocks     = new WeakSet();

  const p = document.createElement('p');
  p.textContent = 'Bid 50 kg now';
  document.body.appendChild(p);

  processBlockElement(p);                 // t=0 → scan (count=1)
  clock = 200; const r = tick(p);         // t=200 (<throttle) → throttled, no parse, no count
  check('L3: burst within throttle window is suppressed', r === 'throttled' && parseCount === 1);

  const act = blockActivity.get(p);
  check('L3: throttled hit did not advance the live counter', act && act.count === 1);
  check('L3: block not yet live after a throttled burst', liveBlocks.has(p) === false);

  document.body.removeChild(p);
})();

// ── Report ──
console.log(`\nLive-region back-off (#5): ${passed} passed, ${failed} failed, ${passed + failed} total\n`);
for (const f of failures) console.log(`FAIL: ${f}`);
if (!failed) console.log('All live-block tests passed.');
process.exit(failed ? 1 : 0);
