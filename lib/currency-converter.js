/* currency-converter.js - Convert currencies using live exchange rates */
(function () {
  let targetCurrency = 'AUD';

  // Display prefix/suffix for formatted output
  const CURRENCY_DISPLAY = {
    AUD: { prefix: 'AU$' }, USD: { prefix: 'US$' }, CAD: { prefix: 'CA$' },
    NZD: { prefix: 'NZ$' }, HKD: { prefix: 'HK$' }, SGD: { prefix: 'SG$' },
    EUR: { prefix: '€' },   GBP: { prefix: '£' },   JPY: { prefix: '¥' },
    CNY: { prefix: '¥' },   INR: { prefix: '₹' },   KRW: { prefix: '₩' },
    THB: { prefix: '฿' },   PHP: { prefix: '₱' },   ILS: { prefix: '₪' },
    TRY: { prefix: '₺' },   BRL: { prefix: 'R$' },  MXN: { prefix: 'MX$' },
    ZAR: { prefix: 'R' },
  };

  function formatCurrency(code, amount) {
    const disp = CURRENCY_DISPLAY[code];
    const numStr = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(amount);
    if (disp) return disp.prefix + ' ' + numStr;
    return code + ' ' + numStr;
  }

  let rates = null;
  let rateDate = null;
  let loadError = null;
  let initPromise = null;

  function todayUTC() {
    return new Date().toISOString().slice(0, 10);
  }

  // Request rates from background script. Caches per day; subsequent calls are no-ops.
  function init() {
    if (rates && !loadError) return Promise.resolve();
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
  // rates from background are base=AUD (1 AUD = rate units of fromCurrency)
  // Cross-rate: value / rates[from] gives AUD; * rates[target] gives target (AUD rate = 1)
  function convert(value, fromCurrency, multiplier) {
    if (!rates) return null;
    const fromRate = rates[fromCurrency];
    if (!fromRate) return null;

    const target = targetCurrency;
    // AUD is the implicit base (rate = 1)
    const targetRate = target === 'AUD' ? 1 : rates[target];
    if (!targetRate) return null;

    const targetAmount = (value / fromRate) * targetRate;

    let displayValue = targetAmount;
    let suffix = '';
    if (multiplier) {
      const scale = MULTIPLIER_SCALE[multiplier.toLowerCase()];
      if (scale) {
        displayValue = targetAmount / scale;
        suffix = multiplier.length === 1 ? multiplier : ' ' + multiplier;
      }
    }

    const numStr = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(displayValue);
    const number = numStr + suffix;
    const disp = CURRENCY_DISPLAY[target];
    const prefix = disp ? disp.prefix : target;
    const formatted = prefix + ' ' + number;

    return [{ formatted, number, label: null }];
  }

  function setTargetCurrency(code) {
    targetCurrency = code;
  }

  function getTargetCurrency() {
    return targetCurrency;
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

  // Returns true if rates are loaded (possibly stale) — init() may still refresh
  function isReady() {
    return rates !== null && loadError === null;
  }

  window.CurrencyConverter = { init, convert, setTargetCurrency, getTargetCurrency, getRateDate, hasError, isStale, isReady, _setRates };
})();
