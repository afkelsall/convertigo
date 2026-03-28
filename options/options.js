/* options.js - Settings page logic */
(function () {
  const CURRENCY_CODES = [
    'AUD', 'BGN', 'BRL', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK',
    'EUR', 'GBP', 'HKD', 'HUF', 'IDR', 'ILS', 'INR', 'ISK',
    'JPY', 'KRW', 'MXN', 'MYR', 'NOK', 'NZD', 'PHP', 'PLN',
    'RON', 'SEK', 'SGD', 'THB', 'TRY', 'USD', 'ZAR'
  ];

  const CURRENCY_NAMES = {
    AUD: 'AUD – Australian Dollar',
    BGN: 'BGN – Bulgarian Lev',
    BRL: 'BRL – Brazilian Real',
    CAD: 'CAD – Canadian Dollar',
    CHF: 'CHF – Swiss Franc',
    CNY: 'CNY – Chinese Yuan',
    CZK: 'CZK – Czech Koruna',
    DKK: 'DKK – Danish Krone',
    EUR: 'EUR – Euro',
    GBP: 'GBP – British Pound',
    HKD: 'HKD – Hong Kong Dollar',
    HUF: 'HUF – Hungarian Forint',
    IDR: 'IDR – Indonesian Rupiah',
    ILS: 'ILS – Israeli Shekel',
    INR: 'INR – Indian Rupee',
    ISK: 'ISK – Icelandic Króna',
    JPY: 'JPY – Japanese Yen',
    KRW: 'KRW – South Korean Won',
    MXN: 'MXN – Mexican Peso',
    MYR: 'MYR – Malaysian Ringgit',
    NOK: 'NOK – Norwegian Krone',
    NZD: 'NZD – New Zealand Dollar',
    PHP: 'PHP – Philippine Peso',
    PLN: 'PLN – Polish Złoty',
    RON: 'RON – Romanian Leu',
    SEK: 'SEK – Swedish Krona',
    SGD: 'SGD – Singapore Dollar',
    THB: 'THB – Thai Baht',
    TRY: 'TRY – Turkish Lira',
    USD: 'USD – US Dollar',
    ZAR: 'ZAR – South African Rand',
  };

  let saveTimeout = null;

  function populateCurrencySelect(selected) {
    const select = document.getElementById('currency');
    select.innerHTML = '';
    CURRENCY_CODES.forEach(code => {
      const opt = document.createElement('option');
      opt.value = code;
      opt.textContent = CURRENCY_NAMES[code] || code;
      if (code === selected) opt.selected = true;
      select.appendChild(opt);
    });
  }

  function applySettings(settings) {
    populateCurrencySelect(settings.targetCurrency);

    document.querySelectorAll('input[name="unitSystem"]').forEach(r => {
      r.checked = r.value === settings.unitSystem;
    });
    document.querySelectorAll('input[name="temperaturePref"]').forEach(r => {
      r.checked = r.value === settings.temperaturePref;
    });
    document.querySelectorAll('input[name="fuelPref"]').forEach(r => {
      r.checked = r.value === settings.fuelPref;
    });

    document.getElementById('hover-enabled').checked = settings.hoverEnabled;
    document.getElementById('page-scan-enabled').checked = settings.pageScanEnabled;
    document.getElementById('replace-key').value = settings.replaceKey;
    document.getElementById('permanent-replace').checked = settings.permanentReplace;
  }

  function readSettings() {
    return {
      targetCurrency: document.getElementById('currency').value,
      unitSystem: document.querySelector('input[name="unitSystem"]:checked')?.value || 'both',
      temperaturePref: document.querySelector('input[name="temperaturePref"]:checked')?.value || 'both',
      fuelPref: document.querySelector('input[name="fuelPref"]:checked')?.value || 'all',
      hoverEnabled: document.getElementById('hover-enabled').checked,
      pageScanEnabled: document.getElementById('page-scan-enabled').checked,
      replaceKey: document.getElementById('replace-key').value,
      permanentReplace: document.getElementById('permanent-replace').checked,
    };
  }

  function showSaved() {
    const indicator = document.getElementById('saved-indicator');
    indicator.classList.add('visible');
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => indicator.classList.remove('visible'), 1500);
  }

  async function saveSettings() {
    const settings = readSettings();
    await browser.storage.local.set({
      [window.ConvertigoSettings.STORAGE_KEY]: settings
    });
    showSaved();
  }

  async function init() {
    const settings = await window.ConvertigoSettings.load();
    applySettings(settings);

    document.querySelectorAll('select, input[type="radio"], input[type="checkbox"]').forEach(el => {
      el.addEventListener('change', saveSettings);
    });

    // Ctrl+Alt+Shift+D toggles dev mode — no visible UI, confirmed via title flash
    const h1 = document.querySelector('h1');
    document.addEventListener('keydown', async (e) => {
      if (e.ctrlKey && e.altKey && e.shiftKey && e.key === 'D') {
        const current = await window.ConvertigoSettings.load();
        const next = !current.devMode;
        await browser.storage.local.set({
          [window.ConvertigoSettings.STORAGE_KEY]: Object.assign({}, current, { devMode: next })
        });
        const orig = h1.textContent;
        h1.textContent = next ? 'DEV MODE ON' : 'DEV MODE OFF';
        setTimeout(() => { h1.textContent = orig; }, 1500);
      }
    });

    document.getElementById('reset-btn').addEventListener('click', async () => {
      await browser.storage.local.remove(window.ConvertigoSettings.STORAGE_KEY);
      applySettings(window.ConvertigoSettings.DEFAULTS);
      showSaved();
    });

    const mainContent = document.getElementById('main-content');
    const feedbackPanel = document.getElementById('feedback-panel');
    const feedbackDesc = document.getElementById('feedback-desc');
    const feedbackSendBtn = document.getElementById('feedback-send-btn');
    const feedbackBackBtn = document.getElementById('feedback-back-btn');
    const feedbackStatus = document.getElementById('feedback-status');

    document.getElementById('feedback-btn').addEventListener('click', () => {
      mainContent.style.display = 'none';
      feedbackPanel.style.display = 'flex';
      feedbackDesc.focus();
    });

    feedbackBackBtn.addEventListener('click', () => {
      mainContent.style.display = '';
      feedbackPanel.style.display = 'none';
      feedbackDesc.value = '';
      feedbackStatus.textContent = '';
      feedbackSendBtn.disabled = false;
    });

    feedbackSendBtn.addEventListener('click', async () => {
      feedbackSendBtn.disabled = true;
      feedbackStatus.textContent = 'Sending…';
      feedbackStatus.style.color = '#7a7a9a';

      const payload = {
        service_id: 'service_ti37pko',
        template_id: 'template_bjtngpd',
        user_id: '0E2OQG346dXRcEVvs',
        template_params: {
          selected_text: '(general feedback)',
          selection_html: '(none)',
          page_url: '(not included)',
          description: feedbackDesc.value.trim() || '(none)',
          extension_version: browser.runtime.getManifest().version
        }
      };

      try {
        const result = await browser.runtime.sendMessage({ type: 'sendFeedback', payload });
        if (result && result.ok) {
          feedbackStatus.textContent = '✓ Sent!';
          feedbackStatus.style.color = '#a8e6cf';
          feedbackStatus.style.fontStyle = 'normal';
        } else {
          throw new Error(result && result.error ? result.error : 'HTTP ' + (result && result.status));
        }
      } catch (err) {
        feedbackStatus.textContent = 'Error: ' + err.message;
        feedbackStatus.style.color = '#f5c842';
        feedbackStatus.style.fontStyle = 'normal';
        feedbackSendBtn.disabled = false;
      }
    });
  }

  init();
})();
