/* currency-parser.js - Detect currency amounts in selected text */
(function () {

  // Country prefixes that can precede $ to specify the dollar currency.
  // e.g. C$300 → CAD, US$2 → USD. Sorted longest-first so 'Can' is tried before 'C'.
  const COUNTRY_DOLLAR = [
    ['Can', 'CAD'],
    ['US',  'USD'],
    ['AU',  'AUD'],
    ['NZ',  'NZD'],
    ['HK',  'HKD'],
    ['SG',  'SGD'],
    ['C',   'CAD'],
  ];

  // Symbols that appear BEFORE the number (after optional country prefix)
  const PREFIX_SYMBOLS = { '$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY' };

  // All currency codes supported by frankfurter.dev
  const CURRENCY_CODES = [
    'AUD', 'BGN', 'BRL', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK',
    'EUR', 'GBP', 'HKD', 'HUF', 'IDR', 'ILS', 'INR', 'ISK',
    'JPY', 'KRW', 'MXN', 'MYR', 'NOK', 'NZD', 'PHP', 'PLN',
    'RON', 'SEK', 'SGD', 'THB', 'TRY', 'USD', 'ZAR'
  ];

  // Non-standard abbreviations → canonical code (e.g. SF is Swiss Franc)
  const CURRENCY_ALIASES = { 'SF': 'CHF' };

  // Combined lookup: code/alias → canonical code
  const CODE_LOOKUP = {};
  CURRENCY_CODES.forEach(c => { CODE_LOOKUP[c] = c; });
  Object.entries(CURRENCY_ALIASES).forEach(([a, c]) => { CODE_LOOKUP[a] = c; });

  // Number pattern: two alternatives, tried left-to-right.
  // First: requires at least one comma group → handles thousands separators (1,500 or 1,234,567.89)
  // Second: plain decimal without commas (7.3 or 350)
  // This ordering ensures 1,500 is not consumed as just "1" by the plain alternative.
  const NUM = '(\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)';

  // Optional multiplier suffix — must be a complete word (word boundary after)
  // Handles: $350K, $7.3 billion, $5M, $1.2 trillion
  const MULT = '(?:\\s*(K|M|B|thousand|million|billion|trillion)\\b)?';

  const countryPattern = COUNTRY_DOLLAR.map(([p]) => p.replace(/[$]/g, '\\$')).join('|');
  const symbolPattern = Object.keys(PREFIX_SYMBOLS).map(s => s.replace(/[$]/g, '\\$')).join('|');
  const codePattern = Object.keys(CODE_LOOKUP)
    .sort((a, b) => b.length - a.length)
    .join('|');

  // --- Regex 1: prefix symbol (with optional country-dollar prefix and/or trailing code) ---
  // Matches: $15, $95,000, $7.3 billion, €40, £350K, C$300, Can$300, US$2, $10AUD
  const PREFIX_REGEX = new RegExp(
    '(?<![A-Za-z\\d])(?:(' + countryPattern + '))?(' + symbolPattern + ')\\s*' + NUM + MULT + '(?:\\s*(' + codePattern + ')\\b)?',
    'gi'
  );
  // Groups: [1]=countryPrefix, [2]=symbol, [3]=number, [4]=multiplier, [5]=suffixCode

  // --- Regex 2: currency code BEFORE number ---
  // Matches: USD 52, EUR 40, SF 65.50 — requires whitespace between code and number
  const CODE_PREFIX_REGEX = new RegExp(
    '(?<![A-Za-z])(' + codePattern + ')\\s+' + NUM + MULT,
    'gi'
  );
  // Groups: [1]=code, [2]=number, [3]=multiplier

  // --- Regex 3: number then currency code AFTER ---
  // Matches: 52 USD, 1,500 EUR, 200 CAD
  const CODE_SUFFIX_REGEX = new RegExp(
    '(?<![,\\d])' + NUM + MULT + '\\s+(' + codePattern + ')\\b',
    'gi'
  );
  // Groups: [1]=number, [2]=multiplier, [3]=code

  function parseAmount(numStr, multStr) {
    const n = parseFloat(numStr.replace(/,/g, ''));
    if (isNaN(n)) return NaN;
    if (!multStr) return n;
    const m = multStr.toLowerCase();
    if (m === 'k' || m === 'thousand') return n * 1e3;
    if (m === 'm' || m === 'million')  return n * 1e6;
    if (m === 'b' || m === 'billion')  return n * 1e9;
    if (m === 't' || m === 'trillion') return n * 1e12;
    return n;
  }

  // parse(text, options)
  //   options.dollarCurrency — override the currency assumed for bare '$' symbols
  //   e.g. pass 'AUD' on .au sites so "$89" is treated as AUD (and skipped)
  function parse(text, options = {}) {
    const dollarCurrency = options.dollarCurrency || 'USD';
    const targetCurrency = options.targetCurrency || 'AUD';
    const results = [];
    const usedRanges = [];

    function overlaps(start, end) {
      return usedRanges.some(([s, e]) => start < e && end > s);
    }

    function addResult(value, currency, matchStr, matchIndex, multiplier) {
      if (isNaN(value) || value <= 0) return;
      if (currency === targetCurrency) return;
      const end = matchIndex + matchStr.length;
      if (overlaps(matchIndex, end)) return;
      usedRanges.push([matchIndex, end]);
      results.push({
        value,
        currency,
        multiplier: multiplier || null,
        original: matchStr.trim(),
        index: matchIndex,
        matchLength: matchStr.length
      });
    }

    // Pass 1: prefix symbols (with optional country prefix or suffix code)
    PREFIX_REGEX.lastIndex = 0;
    let match;
    while ((match = PREFIX_REGEX.exec(text)) !== null) {
      const countryPrefix = match[1];
      const symbol = match[2];
      const suffixCode = match[5];
      const value = parseAmount(match[3], match[4]);
      let currency;
      if (suffixCode) {
        // Trailing currency code overrides symbol (e.g. $10AUD → AUD)
        currency = CODE_LOOKUP[suffixCode.toUpperCase()];
      } else if (countryPrefix) {
        const entry = COUNTRY_DOLLAR.find(([p]) => p.toLowerCase() === countryPrefix.toLowerCase());
        currency = entry ? entry[1] : dollarCurrency;
      } else if (symbol === '$') {
        currency = dollarCurrency;
      } else {
        currency = PREFIX_SYMBOLS[symbol];
      }
      if (!currency) continue;
      addResult(value, currency, match[0], match.index, match[4] || null);
    }

    // Pass 2: currency code BEFORE number (USD 52, SF 65.50)
    CODE_PREFIX_REGEX.lastIndex = 0;
    while ((match = CODE_PREFIX_REGEX.exec(text)) !== null) {
      const currency = CODE_LOOKUP[match[1].toUpperCase()];
      const value = parseAmount(match[2], match[3]);
      if (!currency) continue;
      addResult(value, currency, match[0], match.index, match[3] || null);
    }

    // Pass 3: currency code AFTER number (52 USD, 1,500 EUR)
    CODE_SUFFIX_REGEX.lastIndex = 0;
    while ((match = CODE_SUFFIX_REGEX.exec(text)) !== null) {
      const currency = CODE_LOOKUP[match[3].toUpperCase()];
      const value = parseAmount(match[1], match[2]);
      if (!currency) continue;
      addResult(value, currency, match[0], match.index, match[2] || null);
    }

    results.sort((a, b) => a.index - b.index);
    return results;
  }

  window.CurrencyParser = { parse };
})();
