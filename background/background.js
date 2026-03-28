/* background.js - Fetch and cache exchange rates from frankfurter.dev */
(function () {
  const STORAGE_KEY = 'currency_rates';
  const API_URL = 'https://api.frankfurter.dev/v1/latest?base=AUD';

  let cachedRates = null;
  let cacheDate = null;    // ECB rate publication date (e.g. Friday on weekends)
  let fetchedDate = null;  // Date we last successfully called the API
  let fetchError = null;

  function todayUTC() {
    return new Date().toISOString().slice(0, 10);
  }

  function setBadgeError() {
    browser.browserAction.setBadgeText({ text: '!' });
    browser.browserAction.setBadgeBackgroundColor({ color: '#d32f2f' });
  }

  function clearBadge() {
    browser.browserAction.setBadgeText({ text: '' });
  }

  async function fetchRates() {
    try {
      const response = await fetch(API_URL);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();

      cachedRates = data.rates;
      cacheDate = data.date;
      fetchedDate = todayUTC();
      fetchError = null;

      await browser.storage.local.set({
        [STORAGE_KEY]: { date: data.date, fetchedDate: fetchedDate, rates: data.rates }
      });

      clearBadge();
      console.log('[Currency] Rates fetched for', data.date);
      return { rates: cachedRates, date: cacheDate };
    } catch (err) {
      fetchError = err.message;
      setBadgeError();
      console.error('[Currency] Failed to fetch rates:', err.message);
      // Return stale cache if available
      if (cachedRates) {
        return { rates: cachedRates, date: cacheDate, stale: true };
      }
      return { error: fetchError };
    }
  }

  async function loadRates() {
    // Try loading from storage first
    const stored = await browser.storage.local.get(STORAGE_KEY);
    const cached = stored[STORAGE_KEY];

    if (cached && cached.fetchedDate === todayUTC()) {
      cachedRates = cached.rates;
      cacheDate = cached.date;
      fetchedDate = cached.fetchedDate;
      fetchError = null;
      clearBadge();
      console.log('[Currency] Loaded cached rates for', cacheDate);
      return;
    }

    // Stale or missing — seed memory with what we have, then fetch fresh
    if (cached) {
      cachedRates = cached.rates;
      cacheDate = cached.date;
      fetchedDate = cached.fetchedDate || null;
    }
    await fetchRates();
  }

  // Respond to content script requests for rates
  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'getRates') {
      if (cachedRates && fetchedDate === todayUTC()) {
        sendResponse({ rates: cachedRates, date: cacheDate });
        return;
      }
      // Need to fetch (async response)
      fetchRates().then(sendResponse);
      return true; // Keep message channel open for async response
    }

    if (msg.type === 'sendFeedback') {
      fetch('https://api.emailjs.com/api/v1.0/email/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(msg.payload)
      }).then(r => sendResponse({ ok: r.ok, status: r.status }))
        .catch(e => sendResponse({ ok: false, error: e.message }));
      return true; // Keep message channel open for async response
    }
  });

  // Load rates on startup
  loadRates();
})();

// ── Feedback context menu ──────────────────────────────────────────────────

browser.menus.create({
  id: 'convertigo-feedback',
  title: 'Convertigo: Report conversion issue',
  contexts: ['selection']
});

browser.menus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'convertigo-feedback') {
    browser.tabs.sendMessage(tab.id, {
      type: 'openFeedbackModal',
      selectionText: info.selectionText
    });
  }
});
