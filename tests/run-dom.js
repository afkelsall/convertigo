/**
 * DOM-based regression test for the full-page key-toggle feature.
 *
 * Simulates the complete scan → activate-replace → deactivate-replace lifecycle
 * from content/content.js using jsdom, against all unit and currency fixtures.
 *
 * Usage:  node tests/run-dom.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// ---------- Bootstrap jsdom ----------
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
const window   = dom.window;
const document = window.document;

global.window      = window;
global.document    = document;
global.Node        = window.Node;
global.NodeFilter  = window.NodeFilter;

// Shim browser globals expected by the library scripts
global.browser = {
  runtime: { sendMessage: () => Promise.reject(new Error('not available in tests')) },
  storage: {
    local: { get: () => Promise.resolve({}) },
    onChanged: { addListener: () => {} }
  }
};

// Load library scripts in dependency order
const libDir = path.join(__dirname, '..', 'lib');
require(path.join(libDir, 'settings.js'));
require(path.join(libDir, 'parser.js'));
require(path.join(libDir, 'converter.js'));
require(path.join(libDir, 'currency-parser.js'));
require(path.join(libDir, 'currency-converter.js'));

// Inject mock exchange rates (base = AUD, so 1 AUD = X units of foreign currency)
const MOCK_RATES = {
  USD: 0.625, EUR: 0.58,  GBP: 0.5,   JPY: 95.0,
  CAD: 0.87,  NZD: 1.08,  HKD: 4.88,  SGD: 0.84,
  CHF: 0.55,  CNY: 4.55,  INR: 52.5,  KRW: 850,
  BGN: 1.13,  BRL: 3.15,  CZK: 14.6,  DKK: 4.33,
  HUF: 230,   IDR: 9800,  ILS: 2.25,  ISK: 86,
  MXN: 10.8,  MYR: 2.95,  NOK: 6.72,  PHP: 35.5,
  PLN: 2.52,  RON: 2.88,  SEK: 6.55,  THB: 22.1,
  TRY: 20.2,  ZAR: 11.8
};

window.CurrencyConverter._setRates(MOCK_RATES, '2026-03-09');
window.CurrencyConverter.setTargetCurrency('AUD');

const settings = Object.assign({}, window.ConvertigoSettings.DEFAULTS, { targetCurrency: 'AUD' });

// ---------- Core functions mirroring content.js ----------

function processTextNode(textNode, currencyParseOpts) {
  const text   = textNode.nodeValue;
  const parent = textNode.parentElement;
  if (!parent) return;

  const unitMatches     = window.UnitParser.parse(text).map(m => ({ ...m, isCurrency: false }));
  const currencyMatches = window.CurrencyParser.parse(text, currencyParseOpts).map(m => ({ ...m, isCurrency: true }));

  const allMatches = [...unitMatches, ...currencyMatches].sort((a, b) => a.index - b.index);
  const deduped = [];
  let lastEnd = -1;
  for (const m of allMatches) {
    if (m.index >= lastEnd) {
      deduped.push(m);
      lastEnd = m.index + m.matchLength;
    }
  }

  if (deduped.length === 0) return;

  const fragment = document.createDocumentFragment();
  let cursor = 0;
  for (const m of deduped) {
    if (m.index > cursor) {
      fragment.appendChild(document.createTextNode(text.slice(cursor, m.index)));
    }
    const span = document.createElement('span');
    span.className = 'uc-highlight';
    span.dataset.ucOriginal   = text.slice(m.index, m.index + m.matchLength);
    span.dataset.ucIsCurrency = m.isCurrency ? '1' : '0';
    span.textContent = span.dataset.ucOriginal;
    fragment.appendChild(span);
    cursor = m.index + m.matchLength;
  }
  if (cursor < text.length) {
    fragment.appendChild(document.createTextNode(text.slice(cursor)));
  }
  parent.replaceChild(fragment, textNode);
}

function processBlockElement(blockEl, currencyParseOpts) {
  if (!blockEl.isConnected) return;
  if (blockEl.dataset.ucScanned) return;

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

  const unitMatches     = window.UnitParser.parse(fullText).map(m => ({ ...m, isCurrency: false }));
  const currencyMatches = window.CurrencyParser.parse(fullText, currencyParseOpts).map(m => ({ ...m, isCurrency: true }));
  const allMatches = [...unitMatches, ...currencyMatches].sort((a, b) => a.index - b.index);

  const deduped = [];
  let lastEnd = -1;
  for (const m of allMatches) {
    if (m.index >= lastEnd) { deduped.push(m); lastEnd = m.index + m.matchLength; }
  }
  if (deduped.length === 0) return;

  for (let i = deduped.length - 1; i >= 0; i--) {
    const m = deduped[i];
    const matchStart = m.index;
    const matchEnd   = m.index + m.matchLength;
    const matchText  = fullText.slice(matchStart, matchEnd);

    const startSeg = segments.find(s => matchStart >= s.start && matchStart < s.end);
    const endSeg   = segments.find(s => matchEnd   >  s.start && matchEnd   <= s.end);
    if (!startSeg || !endSeg) continue;

    const range = document.createRange();
    range.setStart(startSeg.node, matchStart - startSeg.start);
    range.setEnd(endSeg.node,     matchEnd   - endSeg.start);

    const span = document.createElement('span');
    span.className = 'uc-highlight';
    span.dataset.ucOriginal   = matchText;
    span.dataset.ucIsCurrency = m.isCurrency ? '1' : '0';
    span.appendChild(range.extractContents());
    range.insertNode(span);

    let prev = span.previousSibling;
    while (prev && prev.nodeType === Node.ELEMENT_NODE && prev.textContent === '') {
      const toRemove = prev;
      prev = prev.previousSibling;
      toRemove.remove();
    }
  }
}

function getUnitReplacementText(original) {
  const parsed = window.UnitParser.parse(original);
  if (!parsed.length) return null;
  const p = parsed[0];

  if (p.isDimension) {
    const parts = p.values.map(v => window.UnitConverter.convert(v, p.unit, settings));
    if (!parts[0]) return null;
    const unit = parts[0][0].formatted.split(' ').slice(1).join(' ');
    const nums = parts.map(r => r ? r[0].formatted.split(' ')[0] : '?');
    return nums.join(' x ') + ' ' + unit;
  }

  if (p.isRange) {
    const r1 = window.UnitConverter.convert(p.value,  p.unit, settings);
    const r2 = window.UnitConverter.convert(p.value2, p.unit, settings);
    if (!r1 || !r2) return null;
    const c1 = r1[0], c2 = r2[0];
    const sp  = c1.formatted.lastIndexOf(' ');
    const num2 = c2.formatted.slice(0, c2.formatted.lastIndexOf(' '));
    return c1.formatted.slice(0, sp) + '-' + num2 + c1.formatted.slice(sp);
  }

  const result = window.UnitConverter.convert(p.value, p.unit, settings);
  return result ? result[0].formatted : null;
}

function replaceHighlightSpan(span, replacedSpans) {
  const original = span.dataset.ucOriginal;
  if (!original) return;
  let replacement = null;

  if (span.dataset.ucIsCurrency === '1') {
    if (window.CurrencyConverter.isReady()) {
      const cp = window.CurrencyParser.parse(original, { dollarCurrency: 'USD', targetCurrency: 'AUD' });
      if (cp.length) {
        const res = window.CurrencyConverter.convert(cp[0].value, cp[0].currency, cp[0].multiplier);
        if (res) replacement = res[0].formatted;
      }
    }
  } else {
    replacement = getUnitReplacementText(original);
  }

  if (!replacement) return;
  span.textContent = replacement;
  span.classList.add('uc-alt-replaced');
  replacedSpans.push(span);
}

function deactivateReplace(replacedSpans) {
  for (const span of replacedSpans) {
    if (span.dataset.ucOriginal) span.textContent = span.dataset.ucOriginal;
    span.classList.remove('uc-alt-replaced');
  }
}

// ---------- Load fixtures ----------
const unitFixtures     = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures.json'), 'utf-8'));
const currencyFixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'currency-fixtures.json'), 'utf-8'));

// ---------- Build DOM ----------
const body = document.body;

// Unit fixture paragraphs
for (let i = 0; i < unitFixtures.length; i++) {
  const p = document.createElement('p');
  p.textContent = unitFixtures[i].input;
  p.dataset.fixtureType = 'unit';
  p.dataset.fixtureIdx  = String(i);
  body.appendChild(p);
}

// Currency fixture paragraphs
for (let i = 0; i < currencyFixtures.length; i++) {
  const p = document.createElement('p');
  p.textContent = currencyFixtures[i].input;
  p.dataset.fixtureType = 'currency';
  p.dataset.fixtureIdx  = String(i);
  body.appendChild(p);
}

// ---------- Simulate page scan ----------
for (const p of body.children) {
  const fixtureType = p.dataset.fixtureType;
  const fixtureIdx  = parseInt(p.dataset.fixtureIdx, 10);
  const fixture = fixtureType === 'unit' ? unitFixtures[fixtureIdx] : currencyFixtures[fixtureIdx];
  const dollarCurrency = fixture.dollarCurrency || 'USD';
  const currencyParseOpts = { dollarCurrency, targetCurrency: 'AUD' };

  // Collect text nodes first (processing replaces them)
  const textNodes = [];
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (node.nodeValue.trim()) textNodes.push(node);
  }
  for (const tn of textNodes) processTextNode(tn, currencyParseOpts);
}

// ---------- Phase 1: Verify scan (detection) ----------
let scanPassed = 0, scanFailed = 0;
const scanFailures = [];

for (const p of body.children) {
  const fixtureType = p.dataset.fixtureType;
  const fixtureIdx  = parseInt(p.dataset.fixtureIdx, 10);
  const fixture = fixtureType === 'unit' ? unitFixtures[fixtureIdx] : currencyFixtures[fixtureIdx];

  if (fixtureType === 'unit') {
    // For unit fixtures: verify unit spans (ignore currency spans which are legitimately detected too).
    // The expected originals come from what UnitParser.parse() would return — each match's .original.
    const unitSpans = [...p.querySelectorAll('.uc-highlight[data-uc-is-currency="0"]')];
    const expectedOriginals = window.UnitParser.parse(fixture.input).map(m => m.original);
    const actualOriginals   = unitSpans.map(s => s.dataset.ucOriginal);

    const ok = expectedOriginals.length === actualOriginals.length &&
               expectedOriginals.every((exp, i) => actualOriginals[i] === exp);

    if (ok) {
      scanPassed++;
    } else {
      scanFailed++;
      scanFailures.push({ type: 'unit', input: fixture.input, expectedOriginals, actualOriginals });
    }
  } else {
    // Currency fixtures: verify currency spans match fixture expected originals.
    const currencySpans = [...p.querySelectorAll('.uc-highlight[data-uc-is-currency="1"]')];
    const expectedOriginals = fixture.expected.map(e => e.original);
    const actualOriginals   = currencySpans.map(s => s.dataset.ucOriginal);

    const ok = expectedOriginals.length === actualOriginals.length &&
               expectedOriginals.every((exp, i) => actualOriginals[i] === exp);

    if (ok) {
      scanPassed++;
    } else {
      scanFailed++;
      scanFailures.push({ type: 'currency', note: fixture.note, input: fixture.input, expectedOriginals, actualOriginals });
    }
  }
}

// ---------- Phase 2: Simulate activate-replace ----------
const replacedSpans = [];
for (const span of document.querySelectorAll('.uc-highlight')) {
  replaceHighlightSpan(span, replacedSpans);
}

// ---------- Phase 3: Verify replacements ----------
let replacePassed = 0, replaceFailed = 0;
const replaceFailures = [];

for (const p of body.children) {
  const fixtureType = p.dataset.fixtureType;
  const fixtureIdx  = parseInt(p.dataset.fixtureIdx, 10);
  const fixture = fixtureType === 'unit' ? unitFixtures[fixtureIdx] : currencyFixtures[fixtureIdx];
  const spans = p.querySelectorAll('.uc-highlight');

  if (spans.length === 0) {
    // No spans → no replacement to verify; already checked in scan phase
    replacePassed++;
    continue;
  }

  let allOk = true;
  const details = [];

  for (const span of spans) {
    const original = span.dataset.ucOriginal;
    let expectedReplacement;

    if (span.dataset.ucIsCurrency === '1') {
      const dollarCurrency = fixture.dollarCurrency || 'USD';
      const cp = window.CurrencyParser.parse(original, { dollarCurrency, targetCurrency: 'AUD' });
      if (cp.length) {
        const res = window.CurrencyConverter.convert(cp[0].value, cp[0].currency, cp[0].multiplier);
        expectedReplacement = res ? res[0].formatted : null;
      }
    } else {
      expectedReplacement = getUnitReplacementText(original);
    }

    const actual = span.textContent;
    const hasClass = span.classList.contains('uc-alt-replaced');

    if (!expectedReplacement) {
      // Span exists but produced no replacement — should not have been replaced
      if (actual !== original || hasClass) {
        allOk = false;
        details.push({ original, expected: original + ' (unreplaced)', actual });
      }
    } else if (actual !== expectedReplacement || !hasClass) {
      allOk = false;
      details.push({ original, expected: expectedReplacement, actual });
    }
  }

  if (allOk) {
    replacePassed++;
  } else {
    replaceFailed++;
    replaceFailures.push({
      type: fixtureType,
      input: fixture.input,
      note: fixture.note || '',
      details
    });
  }
}

// ---------- Phase 4: Simulate deactivate-replace ----------
deactivateReplace(replacedSpans);

// ---------- Phase 5: Verify restore ----------
let restorePassed = 0, restoreFailed = 0;
const restoreFailures = [];

for (const span of document.querySelectorAll('.uc-highlight')) {
  const original = span.dataset.ucOriginal;
  const actual   = span.textContent;
  const hasClass = span.classList.contains('uc-alt-replaced');

  if (actual === original && !hasClass) {
    restorePassed++;
  } else {
    restoreFailed++;
    restoreFailures.push({ original, actual, hasClass });
  }
}

// ---------- Mixed unit + currency dedup test ----------
let mixedPassed = 0, mixedFailed = 0;
const mixedFailures = [];

const mixedCase = {
  text: 'The $50 widget weighs 2.5 kg and is 30 cm wide',
  expectedCurrencyOriginals: ['$50'],
  expectedUnitOriginals: ['2.5 kg', '30 cm']
};

const mixedEl = document.createElement('p');
mixedEl.textContent = mixedCase.text;
document.body.appendChild(mixedEl);

const mTextNodes = [];
const mWalker = document.createTreeWalker(mixedEl, NodeFilter.SHOW_TEXT);
let mNode;
while ((mNode = mWalker.nextNode())) {
  if (mNode.nodeValue.trim()) mTextNodes.push(mNode);
}
for (const tn of mTextNodes) processTextNode(tn, { dollarCurrency: 'USD', targetCurrency: 'AUD' });

const mCurrSpans = [...mixedEl.querySelectorAll('.uc-highlight[data-uc-is-currency="1"]')];
const mUnitSpans = [...mixedEl.querySelectorAll('.uc-highlight[data-uc-is-currency="0"]')];

const actualCurrOrig = mCurrSpans.map(s => s.dataset.ucOriginal);
if (JSON.stringify(actualCurrOrig) === JSON.stringify(mixedCase.expectedCurrencyOriginals)) {
  mixedPassed++;
} else {
  mixedFailed++;
  mixedFailures.push(`currency spans: expected ${JSON.stringify(mixedCase.expectedCurrencyOriginals)}, got ${JSON.stringify(actualCurrOrig)}`);
}

const actualUnitOrig = mUnitSpans.map(s => s.dataset.ucOriginal);
if (JSON.stringify(actualUnitOrig) === JSON.stringify(mixedCase.expectedUnitOriginals)) {
  mixedPassed++;
} else {
  mixedFailed++;
  mixedFailures.push(`unit spans: expected ${JSON.stringify(mixedCase.expectedUnitOriginals)}, got ${JSON.stringify(actualUnitOrig)}`);
}

// Verify no span overlaps by walking all spans in document order and checking positions in source text
const allMixedSpans = [...mixedEl.querySelectorAll('.uc-highlight')];
let lastEndPos = 0;
let noOverlap = true;
for (const span of allMixedSpans) {
  const orig = span.dataset.ucOriginal;
  const pos = mixedCase.text.indexOf(orig, lastEndPos);
  if (pos === -1 || pos < lastEndPos) { noOverlap = false; break; }
  lastEndPos = pos + orig.length;
}
if (noOverlap) {
  mixedPassed++;
} else {
  mixedFailed++;
  mixedFailures.push('spans overlap or are out of order in original text');
}

// ---------- Split-tag tests ----------
const splitFixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'split-tag-fixtures.json'), 'utf-8'));

const splitContainer = document.createElement('div');
document.body.appendChild(splitContainer);

// Build DOM from each fixture's html
for (let i = 0; i < splitFixtures.length; i++) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = splitFixtures[i].html;
  const el = wrapper.firstElementChild;
  el.dataset.splitIdx = String(i);
  splitContainer.appendChild(el);
}

// Phase ST-1: Scan each fixture block
for (const el of splitContainer.children) {
  const idx     = parseInt(el.dataset.splitIdx, 10);
  const fixture = splitFixtures[idx];
  const opts    = { dollarCurrency: fixture.dollarCurrency || 'USD', targetCurrency: 'AUD' };

  if (fixture.isMultiBlock) {
    // negative case: process each child <p> independently
    for (const child of el.querySelectorAll('p')) {
      processBlockElement(child, opts);
    }
  } else {
    processBlockElement(el, opts);
  }
}

// Phase ST-2: Verify scan detection
let splitScanPassed = 0, splitScanFailed = 0;
const splitScanFailures = [];

for (const el of splitContainer.children) {
  const idx     = parseInt(el.dataset.splitIdx, 10);
  const fixture = splitFixtures[idx];

  const spans          = [...el.querySelectorAll('.uc-highlight')];
  const actualOriginals = spans.map(s => s.dataset.ucOriginal);
  const expected        = fixture.expectedOriginals;

  const ok = expected.length === actualOriginals.length &&
             expected.every((e, i) => actualOriginals[i] === e);
  if (ok) {
    splitScanPassed++;
  } else {
    splitScanFailed++;
    splitScanFailures.push({ note: fixture.note, expected, actual: actualOriginals });
  }

  if (fixture.expectedBlockText !== undefined) {
    // Check the block's textContent matches (catches double-symbol in Firefox)
    const actualBlockText = el.textContent;
    if (actualBlockText === fixture.expectedBlockText) {
      splitScanPassed++;
    } else {
      splitScanFailed++;
      splitScanFailures.push({ note: fixture.note + ' [block text]', expected: [fixture.expectedBlockText], actual: [actualBlockText] });
    }

    // Check no orphaned empty elements were left outside .uc-highlight spans
    // (extractContents leaves empty partial-ancestor clones behind, causing double symbols)
    const orphaned = [...el.querySelectorAll('*')].filter(node =>
      !node.classList.contains('uc-highlight') &&
      node.closest('.uc-highlight') === null &&
      node.textContent === ''
    );
    if (orphaned.length === 0) {
      splitScanPassed++;
    } else {
      splitScanFailed++;
      splitScanFailures.push({
        note: fixture.note + ' [orphaned empty elements]',
        expected: ['no orphaned empty elements outside .uc-highlight'],
        actual: orphaned.map(n => n.outerHTML)
      });
    }
  }
}

// Phase ST-3: Verify replacement
const splitReplacedSpans = [];

for (const span of splitContainer.querySelectorAll('.uc-highlight')) {
  replaceHighlightSpan(span, splitReplacedSpans);
}

let splitReplacePassed = 0, splitReplaceFailed = 0;
const splitReplaceFailures = [];

for (const el of splitContainer.children) {
  const idx     = parseInt(el.dataset.splitIdx, 10);
  const fixture = splitFixtures[idx];
  const spans   = [...el.querySelectorAll('.uc-highlight')];

  if (spans.length === 0 && fixture.expectedOriginals.length === 0) {
    splitReplacePassed++;
    continue;
  }

  let allOk = true;
  const details = [];

  for (let si = 0; si < spans.length; si++) {
    const span     = spans[si];
    const original = span.dataset.ucOriginal;
    // expected[si] is "original -> converted"; extract the converted part
    const expectedEntry = fixture.expected[si] || '';
    const arrowIdx      = expectedEntry.indexOf(' -> ');
    const expectedText  = arrowIdx >= 0 ? expectedEntry.slice(arrowIdx + 4) : null;
    const actual        = span.textContent;
    const hasClass      = span.classList.contains('uc-alt-replaced');

    if (!expectedText) {
      if (actual !== original || hasClass) {
        allOk = false;
        details.push({ original, expected: original + ' (unreplaced)', actual });
      }
    } else if (actual !== expectedText || !hasClass) {
      allOk = false;
      details.push({ original, expected: expectedText, actual });
    }
  }

  if (allOk) {
    splitReplacePassed++;
  } else {
    splitReplaceFailed++;
    splitReplaceFailures.push({ note: fixture.note, details });
  }
}

// Phase ST-4: Verify restore
deactivateReplace(splitReplacedSpans);

let splitRestorePassed = 0, splitRestoreFailed = 0;
const splitRestoreFailures = [];

for (const span of splitContainer.querySelectorAll('.uc-highlight')) {
  const original = span.dataset.ucOriginal;
  const actual   = span.textContent;
  const hasClass = span.classList.contains('uc-alt-replaced');
  if (actual === original && !hasClass) {
    splitRestorePassed++;
  } else {
    splitRestoreFailed++;
    splitRestoreFailures.push({ note: 'restore', original, actual, hasClass });
  }
}

// ---------- Dynamic update (mutation) simulation tests ----------
// These test the fix for highlights disappearing when page values update dynamically
// (e.g. FlightAware speed/altitude). Mirrors the mutation observer logic in content.js.

const MUT_BLOCK_TAGS = new Set([
  'ADDRESS','ARTICLE','ASIDE','BLOCKQUOTE','BODY','DD','DETAILS','DIALOG',
  'DIV','DL','DT','FIELDSET','FIGCAPTION','FIGURE','FOOTER','FORM',
  'H1','H2','H3','H4','H5','H6','HEADER','HGROUP','HR','LI','MAIN',
  'NAV','OL','P','PRE','SECTION','SUMMARY','TABLE','TBODY','TD','TFOOT',
  'TH','THEAD','TR','UL'
]);

function getBlockAncestorForMut(node) {
  let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  while (el) {
    if (MUT_BLOCK_TAGS.has(el.tagName)) return el;
    el = el.parentElement;
  }
  return document.body;
}

// Mirrors the characterData branch of the mutation handler in content.js
function simCharacterData(textNode, opts) {
  const el = textNode.parentElement;
  if (!el) return;
  const staleSpan = el.classList.contains('uc-highlight') ? el : null;
  if (staleSpan) {
    const block = getBlockAncestorForMut(staleSpan);
    const rescanRoot = block || staleSpan.parentElement;
    staleSpan.replaceWith(document.createTextNode(staleSpan.textContent));
    if (rescanRoot) {
      delete rescanRoot.dataset.ucScanned;
      processBlockElement(rescanRoot, opts);
    }
  } else {
    const block = getBlockAncestorForMut(el);
    if (block) delete block.dataset.ucScanned;
    processBlockElement(block || el, opts);
  }
}

// Mirrors the TEXT_NODE addedNodes branch of the mutation handler in content.js
function simTextNodeAdded(textNode, opts) {
  const parent = textNode.parentElement;
  if (!parent) return;
  if (parent.classList.contains('uc-highlight')) {
    const block = getBlockAncestorForMut(parent);
    const rescanRoot = block || parent.parentElement;
    parent.replaceWith(document.createTextNode(parent.textContent));
    if (rescanRoot) {
      delete rescanRoot.dataset.ucScanned;
      processBlockElement(rescanRoot, opts);
    }
  } else {
    const block = getBlockAncestorForMut(parent);
    if (block) delete block.dataset.ucScanned;
    processBlockElement(block || parent, opts);
  }
}

// Mirrors the ELEMENT_NODE addedNodes branch of the mutation handler in content.js
function simElementAdded(element, opts) {
  const block = getBlockAncestorForMut(element);
  if (block) delete block.dataset.ucScanned;
  processBlockElement(block || element, opts);
}

const mutOpts = { dollarCurrency: 'USD', targetCurrency: 'AUD' };
const mutContainer = document.createElement('div');
document.body.appendChild(mutContainer);

let mutPassed = 0, mutFailed = 0;
const mutFailures = [];

function mutCheck(desc, ok) {
  if (ok) { mutPassed++; } else { mutFailed++; mutFailures.push(desc); }
}

// T1: characterData inside span — framework mutates textNode.nodeValue directly
// (React-style: holds a reference to the text node and updates it in place)
{
  const p = document.createElement('p');
  p.textContent = '130 mph';
  mutContainer.appendChild(p);
  processBlockElement(p, mutOpts);
  const span = p.querySelector('.uc-highlight');
  mutCheck('T1: initial highlight for "130 mph"',
    span !== null && span.dataset.ucOriginal === '130 mph');

  if (span && span.firstChild) {
    span.firstChild.nodeValue = '135 mph';          // page mutates text node in-place
    simCharacterData(span.firstChild, mutOpts);
    const updated = p.querySelector('.uc-highlight');
    mutCheck('T1: re-highlighted with updated value "135 mph"',
      updated !== null && updated.dataset.ucOriginal === '135 mph');
    mutCheck('T1: stale span with old ucOriginal is gone',
      p.querySelector('[data-uc-original="130 mph"]') === null);
  }
}

// T2: textContent replacement — page sets element.textContent, destroying our span
{
  const p = document.createElement('p');
  p.textContent = '2,200 ft';
  mutContainer.appendChild(p);
  processBlockElement(p, mutOpts);
  mutCheck('T2: initial highlight for "2,200 ft"',
    p.querySelector('.uc-highlight') !== null);

  p.textContent = '2,400 ft';                       // destroys span, adds text node
  simTextNodeAdded(p.firstChild, mutOpts);
  const updated = p.querySelector('.uc-highlight');
  mutCheck('T2: re-highlighted after textContent replacement',
    updated !== null && updated.dataset.ucOriginal === '2,400 ft');
}

// T3: initially empty block — scan marks it scanned, then value arrives
{
  const p = document.createElement('p');
  p.textContent = '';
  mutContainer.appendChild(p);
  processBlockElement(p, mutOpts);
  mutCheck('T3: no highlights in empty block',
    p.querySelectorAll('.uc-highlight').length === 0);
  mutCheck('T3: ucScanned set on empty block so duplicate scans are skipped',
    p.dataset.ucScanned === '1');

  p.textContent = '130 mph';                        // data arrives late
  simTextNodeAdded(p.firstChild, mutOpts);
  const span = p.querySelector('.uc-highlight');
  mutCheck('T3: highlight created after value arrives in empty block',
    span !== null && span.dataset.ucOriginal === '130 mph');
}

// T4: element replacement — page removes old element and inserts a new one
{
  const td = document.createElement('td');
  const inner = document.createElement('span');
  inner.textContent = '130 mph';
  td.appendChild(inner);
  mutContainer.appendChild(td);
  processBlockElement(td, mutOpts);
  mutCheck('T4: initial highlight inside replaced element',
    td.querySelector('.uc-highlight') !== null);

  td.textContent = '';                              // remove all children (including highlight)
  const newInner = document.createElement('span');
  newInner.textContent = '140 mph';
  td.appendChild(newInner);
  simElementAdded(newInner, mutOpts);
  const updated = td.querySelector('.uc-highlight');
  mutCheck('T4: re-highlighted after element replacement',
    updated !== null && updated.dataset.ucOriginal === '140 mph');
}

// T5: value changes to non-convertible text — highlight not re-created
{
  const p = document.createElement('p');
  p.textContent = '130 mph';
  mutContainer.appendChild(p);
  processBlockElement(p, mutOpts);
  mutCheck('T5: initial highlight for "130 mph"',
    p.querySelector('.uc-highlight') !== null);

  p.textContent = '—';
  simTextNodeAdded(p.firstChild, mutOpts);
  mutCheck('T5: no highlight after value changes to non-unit text',
    p.querySelectorAll('.uc-highlight').length === 0);
}

// T6: multiple sequential updates — highlights track latest value
{
  const p = document.createElement('p');
  p.textContent = '100 mph';
  mutContainer.appendChild(p);
  processBlockElement(p, mutOpts);

  p.textContent = '110 mph';
  simTextNodeAdded(p.firstChild, mutOpts);
  p.textContent = '120 mph';
  simTextNodeAdded(p.firstChild, mutOpts);

  const spans = p.querySelectorAll('.uc-highlight');
  mutCheck('T6: exactly one highlight after two sequential updates',
    spans.length === 1);
  mutCheck('T6: highlight reflects latest value "120 mph"',
    spans[0] && spans[0].dataset.ucOriginal === '120 mph');
}

// T7: characterData on text node NOT inside a span — plain re-scan
{
  const p = document.createElement('p');
  p.textContent = 'Loading...';
  mutContainer.appendChild(p);
  processBlockElement(p, mutOpts);
  mutCheck('T7: no highlights for "Loading..."',
    p.querySelectorAll('.uc-highlight').length === 0);

  // Simulate: text node changes to a real value (not inside a span)
  p.firstChild.nodeValue = '55 mph';
  simCharacterData(p.firstChild, mutOpts);
  const span = p.querySelector('.uc-highlight');
  mutCheck('T7: highlight created after characterData on plain text node',
    span !== null && span.dataset.ucOriginal === '55 mph');
}

// ---------- Report ----------
const total = unitFixtures.length + currencyFixtures.length;
console.log(`\nScan detection:      ${scanPassed} passed, ${scanFailed} failed, ${total} total`);
console.log(`Replace activation:  ${replacePassed} passed, ${replaceFailed} failed, ${total} total`);
console.log(`Restore deactivate:  ${restorePassed} passed, ${restoreFailed} failed (per-span)`);
console.log(`Mixed dedup tests:   ${mixedPassed} passed, ${mixedFailed} failed, ${mixedPassed + mixedFailed} total`);
console.log(`Split-tag detection: ${splitScanPassed} passed, ${splitScanFailed} failed, ${splitFixtures.length} total`);
console.log(`Split-tag replace:   ${splitReplacePassed} passed, ${splitReplaceFailed} failed, ${splitFixtures.length} total`);
console.log(`Split-tag restore:   ${splitRestorePassed} passed, ${splitRestoreFailed} failed (per-span)`);
console.log(`Dynamic update:      ${mutPassed} passed, ${mutFailed} failed, ${mutPassed + mutFailed} total\n`);

for (const f of scanFailures) {
  const note = f.note ? ` [${f.note}]` : '';
  console.log(`FAIL (scan/${f.type})${note}: "${f.input}"`);
  console.log(`  expected originals: ${JSON.stringify(f.expectedOriginals)}`);
  console.log(`  actual   originals: ${JSON.stringify(f.actualOriginals)}`);
  console.log();
}

for (const f of replaceFailures) {
  const note = f.note ? ` [${f.note}]` : '';
  console.log(`FAIL (replace/${f.type})${note}: "${f.input}"`);
  for (const d of f.details) {
    console.log(`  span "${d.original}": expected "${d.expected}", got "${d.actual}"`);
  }
  console.log();
}

for (const f of restoreFailures) {
  console.log(`FAIL (restore): original="${f.original}", actual="${f.actual}", hasClass=${f.hasClass}`);
}

for (const msg of mixedFailures) {
  console.log(`FAIL (mixed dedup): ${msg}`);
}
if (mixedFailures.length) console.log();

for (const f of splitScanFailures) {
  console.log(`FAIL (split-tag scan): [${f.note}]`);
  console.log(`  expected: ${JSON.stringify(f.expected)}`);
  console.log(`  actual:   ${JSON.stringify(f.actual)}`);
  console.log();
}

for (const f of splitReplaceFailures) {
  console.log(`FAIL (split-tag replace): [${f.note}]`);
  for (const d of f.details) {
    console.log(`  span "${d.original}": expected "${d.expected}", got "${d.actual}"`);
  }
  console.log();
}

for (const f of splitRestoreFailures) {
  console.log(`FAIL (split-tag restore): original="${f.original}", actual="${f.actual}", hasClass=${f.hasClass}`);
}
if (splitRestoreFailures.length) console.log();

for (const msg of mutFailures) {
  console.log(`FAIL (dynamic update): ${msg}`);
}
if (mutFailures.length) console.log();

const anyFailed = scanFailed > 0 || replaceFailed > 0 || restoreFailed > 0 || mixedFailed > 0 ||
                  splitScanFailed > 0 || splitReplaceFailed > 0 || splitRestoreFailed > 0 || mutFailed > 0;
if (!anyFailed) {
  console.log('All DOM toggle tests passed.');
}
process.exit(anyFailed ? 1 : 0);
