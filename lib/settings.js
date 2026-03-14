/* settings.js - Shared settings defaults and storage helpers */
(function () {
  const STORAGE_KEY = 'convertigo_settings';

  const DEFAULTS = {
    targetCurrency: 'AUD',
    unitSystem: 'both',      // 'metric' | 'imperial' | 'both'
    temperaturePref: 'both', // '°c' | '°f' | 'both'
    fuelPref: 'all',         // 'mpg' | 'l100km' | 'kml' | 'all'
    hoverEnabled: true,
    pageScanEnabled: true,
    replaceKey: 'Alt',       // 'Alt' | 'Control' | 'Shift'
    permanentReplace: false, // always show converted values on page
  };

  async function load() {
    try {
      const stored = await browser.storage.local.get(STORAGE_KEY);
      return Object.assign({}, DEFAULTS, stored[STORAGE_KEY] || {});
    } catch (e) {
      return Object.assign({}, DEFAULTS);
    }
  }

  function onChange(callback) {
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[STORAGE_KEY]) {
        const newSettings = Object.assign({}, DEFAULTS, changes[STORAGE_KEY].newValue || {});
        callback(newSettings);
      }
    });
  }

  window.ConvertigoSettings = { DEFAULTS, STORAGE_KEY, load, onChange };
})();
