/**
 * Regression test runner for unit parser + converter, and currency parser.
 *
 * Usage:  node tests/run.js
 *
 * Test cases live in tests/fixtures.json. To add a new regression case,
 * append an entry with:
 *   { "input": "web text", "expected": ["match → result", ...] }
 *
 * The "expected" values use the format:  original_match → formatted_conversion
 * where formatted_conversion is  "value unit"  (e.g. "30.48 cm").
 *
 * Currency parse test cases live in tests/currency-fixtures.json with format:
 *   { "input": "text", "expected": [{ "currency": "USD", "value": 100, "original": "$100" }] }
 */

const fs = require('fs');
const path = require('path');

// ---------- shim browser globals ----------
const window = {};
global.window = window;

// Shim browser.runtime so currency-converter.js loads without error in Node
global.browser = { runtime: { sendMessage: () => Promise.reject(new Error('not available in tests')) } };

// Load library scripts (they attach to window)
const libDir = path.join(__dirname, '..', 'lib');
require(path.join(libDir, 'parser.js'));
require(path.join(libDir, 'converter.js'));
require(path.join(libDir, 'currency-parser.js'));
require(path.join(libDir, 'currency-converter.js'));

const { parse } = window.UnitParser;
const { convert } = window.UnitConverter;
const { parse: parseCurrency } = window.CurrencyParser;
const { convert: convertCurrency, _setRates } = window.CurrencyConverter;

// ---------- load fixtures ----------
const fixtures = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures.json'), 'utf-8')
);

const currencyFixtures = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'currency-fixtures.json'), 'utf-8')
);

const currencyConversionFixtures = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'currency-conversion-fixtures.json'), 'utf-8')
);

// ---------- run unit tests ----------
let passed = 0;
let failed = 0;
const failures = [];

for (const tc of fixtures) {
  const parsed = parse(tc.input);

  // Build "original → formatted" strings the same way the popup would
  const actual = parsed.flatMap(match => {
    if (match.isDimension) {
      return match.values.flatMap((v, i) => {
        const results = convert(v, match.unit);
        if (!results) return [];
        const dimOriginal = (match.rawValues ? match.rawValues[i] : v) + ' ' + (match.unitText || match.unit);
        return results.map(conv => {
          const label = conv.label ? ` (${conv.label})` : '';
          return `${dimOriginal} \u2192 ${conv.formatted}${label}`;
        });
      });
    }
    let results;
    if (match.isRange) {
      const r1 = convert(match.value, match.unit);
      const r2 = convert(match.value2, match.unit);
      if (!r1 || !r2) return [];
      results = r1.map((c1, i) => {
        const c2 = r2[i];
        const sp = c1.formatted.lastIndexOf(' ');
        const num2 = c2.formatted.slice(0, c2.formatted.lastIndexOf(' '));
        return { ...c1, formatted: c1.formatted.slice(0, sp) + '-' + num2 + c1.formatted.slice(sp) };
      });
    } else {
      results = convert(match.value, match.unit);
      if (!results) return [];
    }
    return results.map(conv => {
      const label = conv.label ? ` (${conv.label})` : '';
      return `${match.original} \u2192 ${conv.formatted}${label}`;
    });
  });

  const ok =
    actual.length === tc.expected.length &&
    actual.every((a, i) => a === tc.expected[i]);

  if (ok) {
    passed++;
  } else {
    failed++;
    failures.push({ input: tc.input, expected: tc.expected, actual });
  }
}

// ---------- run currency parse tests ----------
let cpassed = 0;
let cfailed = 0;
const cfailures = [];

for (const tc of currencyFixtures) {
  const opts = tc.dollarCurrency ? { dollarCurrency: tc.dollarCurrency } : {};
  const actual = parseCurrency(tc.input, opts);

  const ok =
    actual.length === tc.expected.length &&
    actual.every((a, i) => {
      const e = tc.expected[i];
      return a.currency === e.currency &&
             Math.abs(a.value - e.value) < 0.0001 &&
             a.original === e.original;
    });

  if (ok) {
    cpassed++;
  } else {
    cfailed++;
    cfailures.push({
      input: tc.input,
      expected: tc.expected,
      actual: actual.map(({ value, currency, original }) => ({ value, currency, original }))
    });
  }
}

// ---------- run currency conversion tests ----------
let cvpassed = 0;
let cvfailed = 0;
const cvfailures = [];

for (const tc of currencyConversionFixtures) {
  _setRates(tc.rate !== null ? { [tc.currency]: tc.rate } : {}, '2026-03-09');
  const result = convertCurrency(tc.value, tc.currency, tc.multiplier || null);
  const actual = result ? result[0].formatted : null;
  const ok = actual === tc.expected;
  if (ok) {
    cvpassed++;
  } else {
    cvfailed++;
    cvfailures.push({ ...tc, actual });
  }
}

// ---------- report ----------
const cvtotal = currencyConversionFixtures.length;
console.log(`\nUnit tests:            ${passed} passed, ${failed} failed, ${fixtures.length} total`);
console.log(`Currency parse tests:  ${cpassed} passed, ${cfailed} failed, ${currencyFixtures.length} total`);
console.log(`Currency conv. tests:  ${cvpassed} passed, ${cvfailed} failed, ${cvtotal} total\n`);

const allFailures = [...failures, ...cfailures, ...cvfailures];
if (allFailures.length) {
  for (const f of failures) {
    console.log(`FAIL (unit): "${f.input}"`);
    console.log(`  expected: ${JSON.stringify(f.expected)}`);
    console.log(`  actual:   ${JSON.stringify(f.actual)}`);
    console.log();
  }
  for (const f of cfailures) {
    const note = f.note ? ` [${f.note}]` : '';
    console.log(`FAIL (currency parse)${note}: "${f.input}"`);
    console.log(`  expected: ${JSON.stringify(f.expected)}`);
    console.log(`  actual:   ${JSON.stringify(f.actual)}`);
    console.log();
  }
  for (const f of cvfailures) {
    console.log(`FAIL (currency conv): ${f.value} ${f.currency}`);
    console.log(`  expected: ${JSON.stringify(f.expected)}`);
    console.log(`  actual:   ${JSON.stringify(f.actual)}`);
    console.log();
  }
  process.exit(1);
} else {
  console.log('All tests passed.');
}
