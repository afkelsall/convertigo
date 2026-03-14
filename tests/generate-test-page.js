'use strict';

const fs   = require('fs');
const path = require('path');

const unitFixtures     = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures.json'), 'utf-8'));
const currencyFixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'currency-fixtures.json'), 'utf-8'));

// Build fixture rows HTML
function fixtureRow(input, label, extra) {
  const escaped = input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const extraAttr = extra ? ` data-dollar-currency="${extra}"` : '';
  return `    <p class="fixture-line" data-fixture-label="${label}"${extraAttr}>${escaped}</p>`;
}

const unitRows = unitFixtures.map((f, i) =>
  fixtureRow(f.input, `U${String(i + 1).padStart(3, '0')}`)
).join('\n');

const currencyRows = currencyFixtures.map((f, i) =>
  fixtureRow(f.input, `C${String(i + 1).padStart(3, '0')}`, f.dollarCurrency || '')
).join('\n');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Convertigo — Full-Page Toggle Test</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }

    body {
      margin: 0;
      background: #111118;
      color: #d0d0e8;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 15px;
      line-height: 1.7;
    }

    /* ── sticky status bar ── */
    #status-bar {
      position: sticky;
      top: 0;
      z-index: 9999;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      background: #1a1a2e;
      border-bottom: 1px solid rgba(255,255,255,0.08);
      padding: 10px 20px;
      font-size: 13px;
      color: #7a7a9a;
    }
    #status-bar .hint { flex: 1; }
    #status-bar .key-badge {
      background: rgba(168,230,207,0.12);
      border: 1px solid rgba(168,230,207,0.3);
      border-radius: 5px;
      padding: 1px 8px;
      font-family: monospace;
      font-size: 12px;
      color: #a8e6cf;
    }
    #status-bar .state {
      font-weight: 600;
      color: #7a7a9a;
      transition: color 0.15s;
    }
    #status-bar.active .state { color: #a8e6cf; }
    #status-bar .counts { font-size: 12px; }

    /* ── layout ── */
    .container {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0;
      min-height: calc(100vh - 45px);
    }

    .section {
      padding: 24px 28px 40px;
    }
    .section:first-child {
      border-right: 1px solid rgba(255,255,255,0.07);
    }

    .section-title {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: #4a4a6a;
      margin: 0 0 20px;
      padding-bottom: 8px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }

    /* ── fixture lines ── */
    .fixture-line {
      position: relative;
      margin: 0;
      padding: 4px 0 4px 52px;
      border-bottom: 1px solid rgba(255,255,255,0.04);
      font-size: 14px;
      min-height: 28px;
    }
    .fixture-line::before {
      content: attr(data-fixture-label);
      position: absolute;
      left: 0;
      top: 4px;
      font-size: 10px;
      font-family: monospace;
      color: #333355;
      width: 44px;
      text-align: right;
      padding-right: 8px;
    }
    .fixture-line:last-child { border-bottom: none; }

    /* ── highlight spans (mirror content.css) ── */
    .uc-highlight {
      border-bottom: 1px dotted rgba(168, 230, 207, 0.45);
      cursor: help;
    }
    .uc-highlight:hover {
      border-bottom-color: rgba(168, 230, 207, 0.85);
      background: rgba(168, 230, 207, 0.06);
    }
    .uc-highlight[data-uc-is-currency="1"] {
      border-bottom-color: rgba(168, 216, 234, 0.45);
    }
    .uc-highlight[data-uc-is-currency="1"]:hover {
      border-bottom-color: rgba(168, 216, 234, 0.85);
      background: rgba(168, 216, 234, 0.06);
    }

    .uc-alt-replaced {
      text-decoration: underline wavy rgba(168, 230, 207, 0.75);
      text-decoration-skip-ink: none;
      border-bottom: none;
    }
    .uc-alt-replaced[data-uc-is-currency="1"] {
      text-decoration-color: rgba(168, 216, 234, 0.75);
    }
  </style>
</head>
<body>

<div id="status-bar">
  <span class="hint">Hold <span class="key-badge">Alt</span> to toggle all conversions — release to restore</span>
  <span class="counts" id="span-counts"></span>
  <span class="state" id="replace-state">Original</span>
</div>

<div class="container">
  <section class="section">
    <h2 class="section-title">Unit fixtures (${unitFixtures.length})</h2>
${unitRows}
  </section>

  <section class="section">
    <h2 class="section-title">Currency fixtures (${currencyFixtures.length}) — target: AUD</h2>
${currencyRows}
  </section>
</div>

<!-- shim browser APIs before lib scripts load -->
<script>
window.browser = {
  runtime: { sendMessage: () => Promise.reject(new Error('standalone')) },
  storage: {
    local: { get: () => Promise.resolve({}) },
    onChanged: { addListener: () => {} }
  }
};
</script>

<script src="../lib/settings.js"></script>
<script src="../lib/parser.js"></script>
<script src="../lib/converter.js"></script>
<script src="../lib/currency-parser.js"></script>
<script src="../lib/currency-converter.js"></script>

<script>
(function () {
  // ── Mock rates (base = AUD; 1 AUD = X foreign) ──
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
  window.CurrencyConverter._setRates(MOCK_RATES, '${new Date().toISOString().slice(0, 10)}');
  window.CurrencyConverter.setTargetCurrency('AUD');

  const settings = Object.assign({}, window.ConvertigoSettings.DEFAULTS, { targetCurrency: 'AUD' });

  // ── processTextNode (mirrors content.js) ──
  function processTextNode(textNode, currencyParseOpts) {
    const text   = textNode.nodeValue;
    const parent = textNode.parentElement;
    if (!parent) return;

    const unitMatches     = window.UnitParser.parse(text).map(m => ({ ...m, isCurrency: false }));
    const currencyMatches = window.CurrencyParser.parse(text, currencyParseOpts).map(m => ({ ...m, isCurrency: true }));
    const allMatches      = [...unitMatches, ...currencyMatches].sort((a, b) => a.index - b.index);

    const deduped = [];
    let lastEnd = -1;
    for (const m of allMatches) {
      if (m.index >= lastEnd) { deduped.push(m); lastEnd = m.index + m.matchLength; }
    }
    if (!deduped.length) return;

    const frag = document.createDocumentFragment();
    let cursor = 0;
    for (const m of deduped) {
      if (m.index > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, m.index)));
      const span = document.createElement('span');
      span.className = 'uc-highlight';
      span.dataset.ucOriginal   = text.slice(m.index, m.index + m.matchLength);
      span.dataset.ucIsCurrency = m.isCurrency ? '1' : '0';
      span.textContent = span.dataset.ucOriginal;
      frag.appendChild(span);
      cursor = m.index + m.matchLength;
    }
    if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
    parent.replaceChild(frag, textNode);
  }

  // ── getUnitReplacementText (mirrors content.js) ──
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
      const sp = c1.formatted.lastIndexOf(' ');
      return c1.formatted.slice(0, sp) + '-' + c2.formatted.slice(0, c2.formatted.lastIndexOf(' ')) + c1.formatted.slice(sp);
    }
    const res = window.UnitConverter.convert(p.value, p.unit, settings);
    return res ? res[0].formatted : null;
  }

  // ── replaceHighlightSpan / deactivate (mirrors content.js) ──
  let replacedSpans = [];
  let isActive = false;

  function replaceHighlightSpan(span) {
    const original = span.dataset.ucOriginal;
    if (!original) return;
    let replacement = null;

    if (span.dataset.ucIsCurrency === '1') {
      const p = span.closest('[data-dollar-currency]');
      const dollarCurrency = (p && p.dataset.dollarCurrency) || 'USD';
      const cp = window.CurrencyParser.parse(original, { dollarCurrency, targetCurrency: 'AUD' });
      if (cp.length) {
        const res = window.CurrencyConverter.convert(cp[0].value, cp[0].currency, cp[0].multiplier);
        if (res) replacement = res[0].formatted;
      }
    } else {
      replacement = getUnitReplacementText(original);
    }

    if (!replacement) return;
    span.textContent = replacement;
    span.classList.add('uc-alt-replaced');
    replacedSpans.push(span);
  }

  function activateReplace() {
    if (isActive) return;
    isActive = true;
    document.querySelectorAll('.uc-highlight').forEach(replaceHighlightSpan);
    document.getElementById('status-bar').classList.add('active');
    document.getElementById('replace-state').textContent = 'Converted';
  }

  function deactivateReplace() {
    if (!isActive) return;
    isActive = false;
    replacedSpans.forEach(span => {
      if (span.dataset.ucOriginal) span.textContent = span.dataset.ucOriginal;
      span.classList.remove('uc-alt-replaced');
    });
    replacedSpans = [];
    document.getElementById('status-bar').classList.remove('active');
    document.getElementById('replace-state').textContent = 'Original';
  }

  // ── Page scan ──
  function scanParagraph(p) {
    const dollarCurrency = p.dataset.dollarCurrency || 'USD';
    const opts = { dollarCurrency, targetCurrency: 'AUD' };
    const nodes = [];
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) { if (n.nodeValue.trim()) nodes.push(n); }
    nodes.forEach(n => processTextNode(n, opts));
  }

  document.querySelectorAll('.fixture-line').forEach(scanParagraph);

  // Update span count in status bar
  const spanCount = document.querySelectorAll('.uc-highlight').length;
  document.getElementById('span-counts').textContent = spanCount + ' detections';

  // ── Key listeners ──
  document.addEventListener('keydown', e => { if (e.key === 'Alt') { e.preventDefault(); activateReplace(); } });
  document.addEventListener('keyup',   e => { if (e.key === 'Alt') deactivateReplace(); });
  window.addEventListener('blur', deactivateReplace);
  document.addEventListener('mousemove', e => {
    if (e.altKey && !isActive) activateReplace();
    else if (!e.altKey && isActive) deactivateReplace();
  });
})();
</script>
</body>
</html>
`;

const outPath = path.join(__dirname, 'page-toggle-test.html');
fs.writeFileSync(outPath, html, 'utf-8');
console.log('Generated:', outPath);
