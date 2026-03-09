/* content.js - Selection listener and popup injection */
(function () {
  const POPUP_ID = 'unit-converter-popup';
  const CURRENCY_SECTION_CLASS = 'uc-currency-section';
  const RECONSTRUCTED_CLASS = 'uc-reconstructed';
  let keyDebounce = null;

  function removePopup() {
    const existing = document.getElementById(POPUP_ID);
    if (existing) existing.remove();
  }

  // Replace each matched measurement in the original text with its converted equivalent
  function buildReconstructedString(originalText, conversions, currencyConversions) {
    let result = originalText;
    const allConversions = [
      ...conversions.map(c => ({ ...c, isCurrency: false })),
      ...currencyConversions.map(c => ({ ...c, isCurrency: true }))
    ].sort((a, b) => b.index - a.index);

    for (const { index, matchLength, suffix, convResult, isCurrency, original } of allConversions) {
      if (!convResult) continue;
      let replacement;
      if (isCurrency) {
        // Keep the original symbol (e.g. '$') with just the converted number
        // so "$500" becomes "$713.65" rather than "AU$ 713.65" inline
        const PREFIX_SYMBOLS = ['$', '€', '£', '¥'];
        const firstChar = original[0];
        replacement = PREFIX_SYMBOLS.includes(firstChar)
          ? firstChar + convResult[0].number
          : convResult[0].number;
      } else {
        replacement = convResult[0].formatted + (suffix ? ' ' + suffix : '');
      }
      result = result.slice(0, index) + replacement + result.slice(index + matchLength);
    }
    return result;
  }

  // Build the currency section DOM — used for both the spinner and the final results
  function buildCurrencySection(currencyConversions, currencyError, isLoading) {
    const wrap = document.createElement('div');
    wrap.className = CURRENCY_SECTION_CLASS;

    if (isLoading) {
      const spinner = document.createElement('div');
      spinner.className = 'uc-currency-spinner';
      spinner.textContent = 'Loading rates…';
      wrap.appendChild(spinner);
      return wrap;
    }

    if (currencyError) {
      const errorRow = document.createElement('div');
      errorRow.className = 'uc-currency-error';
      errorRow.textContent = 'Currency rates unavailable';
      wrap.appendChild(errorRow);
      return wrap;
    }

    const currencySeen = new Set();
    currencyConversions.forEach(({ original, convResult }) => {
      if (!convResult) return;
      if (currencySeen.has(original)) return;
      currencySeen.add(original);

      const row = document.createElement('div');
      row.className = 'uc-row uc-currency';

      const orig = document.createElement('span');
      orig.className = 'uc-original';
      orig.textContent = original;
      row.appendChild(orig);

      const arrow = document.createElement('span');
      arrow.className = 'uc-arrow';
      arrow.textContent = '→';

      const convSpan = document.createElement('span');
      convSpan.className = 'uc-converted';
      convSpan.textContent = convResult[0].formatted;

      row.appendChild(arrow);
      row.appendChild(convSpan);
      wrap.appendChild(row);
    });

    const rateDate = window.CurrencyConverter.getRateDate();
    if (rateDate) {
      const dateNote = document.createElement('div');
      dateNote.className = 'uc-rate-date';
      dateNote.textContent = (window.CurrencyConverter.isStale() ? 'Rates (stale): ' : 'Rates: ') + rateDate;
      wrap.appendChild(dateNote);
    }

    return wrap;
  }

  function buildPopup(conversions, reconstructed, selectedText, currencySection, hasDivider) {
    const popup = document.createElement('div');
    popup.id = POPUP_ID;

    const btnGroup = document.createElement('div');
    btnGroup.className = 'uc-btn-group';

    const copyTestBtn = document.createElement('button');
    copyTestBtn.className = 'uc-copy-test';
    copyTestBtn.textContent = '{}';
    copyTestBtn.title = 'Copy as test JSON';
    copyTestBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const seen = new Set();
      const expected = [];
      conversions.forEach(({ original, convResult }) => {
        if (!convResult || seen.has(original)) return;
        seen.add(original);
        convResult.forEach(conv => {
          const label = conv.label ? ' (' + conv.label + ')' : '';
          expected.push(original + ' \u2192 ' + conv.formatted + label);
        });
      });
      const json = ',\n  {\n'
        + '    "input": ' + JSON.stringify(selectedText) + ',\n'
        + '    "expected": [' + expected.map(e => JSON.stringify(e)).join(', ') + ']\n'
        + '  }';
      navigator.clipboard.writeText(json).then(() => {
        copyTestBtn.textContent = '\u2713';
        setTimeout(() => { copyTestBtn.textContent = '{}'; }, 1500);
      });
    });
    btnGroup.appendChild(copyTestBtn);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'uc-close';
    closeBtn.textContent = '×';
    closeBtn.title = 'Close';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removePopup();
    });
    btnGroup.appendChild(closeBtn);
    popup.appendChild(btnGroup);

    const label = document.createElement('div');
    label.className = 'uc-label';
    label.textContent = 'Unit Conversion';
    popup.appendChild(label);

    // Reconstructed string block (shown when multiple measurements detected)
    if (reconstructed) {
      const block = document.createElement('div');
      block.className = RECONSTRUCTED_CLASS;
      block.textContent = reconstructed;
      popup.appendChild(block);

      const divider = document.createElement('div');
      divider.className = 'uc-divider';
      popup.appendChild(divider);
    }

    // Unit conversion rows (deduplicated)
    const results = document.createElement('div');
    results.className = 'uc-results';
    const seen = new Set();

    conversions.forEach(({ original, suffix, convResult }) => {
      if (!convResult) return;
      const key = `${original}`;
      if (seen.has(key)) return;
      seen.add(key);

      convResult.forEach((conv, i) => {
        const row = document.createElement('div');
        row.className = 'uc-row';
        if (i > 0) row.className += ' uc-row-cont';
        if (i < convResult.length - 1) row.className += ' uc-row-grouped';

        const orig = document.createElement('span');
        orig.className = 'uc-original';
        orig.textContent = original;
        if (i > 0) orig.style.visibility = 'hidden';
        row.appendChild(orig);

        const arrow = document.createElement('span');
        arrow.className = 'uc-arrow';
        arrow.textContent = '→';

        const convSpan = document.createElement('span');
        convSpan.className = 'uc-converted';
        convSpan.textContent = conv.formatted + (conv.label ? ' (' + conv.label + ')' : '');

        row.appendChild(arrow);
        row.appendChild(convSpan);
        results.appendChild(row);
      });
    });

    popup.appendChild(results);

    // Currency section (spinner, results, or error) — separated by divider if unit rows exist
    if (currencySection) {
      if (hasDivider) {
        const divider = document.createElement('div');
        divider.className = 'uc-divider';
        popup.appendChild(divider);
      }
      popup.appendChild(currencySection);
    }

    return popup;
  }

  async function handleSelection() {
    const selection = window.getSelection();
    const text = selection ? selection.toString().trim() : '';

    if (text.length < 2) { removePopup(); return; }

    // --- Synchronous unit conversion ---
    const parsed = window.UnitParser.parse(text);
    const conversions = parsed.map((p) => {
      let convResult;
      if (p.isRange) {
        const r1 = window.UnitConverter.convert(p.value, p.unit);
        const r2 = window.UnitConverter.convert(p.value2, p.unit);
        if (r1 && r2) {
          convResult = r1.map((c1, i) => {
            const c2 = r2[i];
            const sp = c1.formatted.lastIndexOf(' ');
            const num2 = c2.formatted.slice(0, c2.formatted.lastIndexOf(' '));
            return { ...c1, formatted: c1.formatted.slice(0, sp) + '-' + num2 + c1.formatted.slice(sp) };
          });
        }
      } else {
        convResult = window.UnitConverter.convert(p.value, p.unit);
      }
      return { ...p, convResult };
    }).filter(c => c.convResult);

    // On .au sites, bare '$' is already AUD — skip conversion for those
    const hostname = window.location.hostname;
    const dollarCurrency = hostname.endsWith('.au') ? 'AUD' : 'USD';
    const currencyParsed = window.CurrencyParser.parse(text, { dollarCurrency });

    if (conversions.length === 0 && currencyParsed.length === 0) {
      removePopup();
      return;
    }

    const hasDivider = conversions.length > 0 && currencyParsed.length > 0;

    // Show popup immediately — with spinner if currency rates aren't loaded yet
    const needsLoad = currencyParsed.length > 0;
    const showSpinner = needsLoad && !window.CurrencyConverter.isReady();

    // Initial reconstructed string uses only unit conversions (currency not ready yet)
    const initialReconstructed = conversions.length > 1
      ? buildReconstructedString(text, conversions, [])
      : null;

    const initialCurrencySection = needsLoad
      ? buildCurrencySection([], false, showSpinner)
      : null;

    removePopup();
    const popup = buildPopup(conversions, initialReconstructed, text, initialCurrencySection, hasDivider);
    document.body.appendChild(popup);

    // --- Async currency conversion — updates popup in place ---
    if (needsLoad) {
      let currencyConversions = [];
      let currencyError = false;

      try {
        await window.CurrencyConverter.init();
        if (window.CurrencyConverter.hasError()) {
          currencyError = true;
        } else {
          currencyConversions = currencyParsed.map((p) => ({
            ...p,
            convResult: window.CurrencyConverter.convert(p.value, p.currency, p.multiplier)
          })).filter(c => c.convResult);
        }
      } catch (e) {
        currencyError = true;
      }

      // Popup may have been closed while we were waiting
      const livePopup = document.getElementById(POPUP_ID);
      if (!livePopup) return;

      // Swap spinner for real results
      const oldSection = livePopup.querySelector('.' + CURRENCY_SECTION_CLASS);
      if (oldSection) {
        oldSection.replaceWith(buildCurrencySection(currencyConversions, currencyError, false));
      }

      // Update reconstructed string now that currency values are available
      const totalCount = conversions.length + currencyConversions.length;
      if (totalCount > 1) {
        const fullReconstructed = buildReconstructedString(text, conversions, currencyConversions);
        const reconEl = livePopup.querySelector('.' + RECONSTRUCTED_CLASS);
        if (reconEl) {
          reconEl.textContent = fullReconstructed;
        } else if (!initialReconstructed) {
          // Wasn't shown before (only 1 unit conv), now we have more — insert it
          const label = livePopup.querySelector('.uc-label');
          const block = document.createElement('div');
          block.className = RECONSTRUCTED_CLASS;
          block.textContent = fullReconstructed;
          const divider = document.createElement('div');
          divider.className = 'uc-divider';
          label.after(block, divider);
        }
      }
    }
  }

  // Mouse selection
  document.addEventListener('mouseup', (e) => {
    if (e.target.closest && e.target.closest(`#${POPUP_ID}`)) return;
    setTimeout(handleSelection, 10);
  });

  // Keyboard selection (Shift+Arrow, etc.)
  document.addEventListener('keyup', (e) => {
    if (!e.shiftKey) return;
    if (keyDebounce) clearTimeout(keyDebounce);
    keyDebounce = setTimeout(handleSelection, 200);
  });

  // Track selection changes — close/refresh when selection changes or clears
  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    const text = sel ? sel.toString().trim() : '';
    if (!text) {
      removePopup();
    }
  });
})();
