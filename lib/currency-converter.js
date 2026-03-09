/* currency-converter.js - Convert currencies to AUD using live exchange rates */
(function () {
  const TARGET_CURRENCY = 'AUD';

  let rates = null;
  let rateDate = null;
  let loadError = null;
  let initPromise = null;

  function todayUTC() {
    return new Date().toISOString().slice(0, 10);
  }

  // Request rates from background script. Caches per day; subsequent calls are no-ops.
  function init() {
    if (rates && rateDate === todayUTC()) return Promise.resolve();
    if (initPromise) return initPromise;

    initPromise = browser.runtime.sendMessage({ type: 'getRates' })
      .then(response => {
        if (response && response.rates) {
          rates = response.rates;
          rateDate = response.date;
          loadError = null;
        } else {
          loadError = (response && response.error) || 'Unknown error';
        }
      })
      .catch(err => {
        loadError = err.message || 'Failed to connect to background';
      })
      .finally(() => {
        initPromise = null;
      });

    return initPromise;
  }

  // Scale factors matching the parser's MULT pattern
  const MULTIPLIER_SCALE = {
    'k': 1e3,  'thousand': 1e3,
    'm': 1e6,  'million':  1e6,
    'b': 1e9,  'billion':  1e9,
    't': 1e12, 'trillion': 1e12,
  };

  // Returns [{ formatted, number, label }] or null
  // multiplier — optional string from parser (e.g. 'billion', 'K') to keep in output
  function convert(value, fromCurrency, multiplier) {
    if (!rates) return null;
    const rate = rates[fromCurrency];
    if (!rate) return null;

    // rates are base=AUD: rate = units of fromCurrency per 1 AUD
    // so: value fromCurrency / rate = AUD amount
    const aud = value / rate;

    let displayValue = aud;
    let suffix = '';
    if (multiplier) {
      const scale = MULTIPLIER_SCALE[multiplier.toLowerCase()];
      if (scale) {
        displayValue = aud / scale;
        // Single-letter suffixes (K, M, B) attach directly; words get a space
        suffix = multiplier.length === 1 ? multiplier : ' ' + multiplier;
      }
    }

    const number = new Intl.NumberFormat('en-AU', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(displayValue) + suffix;
    const formatted = 'AU$ ' + number;

    return [{ formatted, number, label: null }];
  }

  function getRateDate() {
    return rateDate;
  }

  function hasError() {
    return !!loadError;
  }

  function isStale() {
    return rateDate !== null && rateDate !== todayUTC();
  }

  // For testing only — inject rates directly without going through the background script
  function _setRates(r, date) {
    rates = r;
    rateDate = date;
    loadError = null;
  }

  // Returns true if rates are loaded and current — init() will be a no-op
  function isReady() {
    return rates !== null && rateDate === todayUTC();
  }

  window.CurrencyConverter = { init, convert, getRateDate, hasError, isStale, isReady, _setRates };
})();
