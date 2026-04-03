/* content.js - Selection listener and popup injection */
(function () {
  const POPUP_ID = 'unit-converter-popup';
  const CURRENCY_SECTION_CLASS = 'uc-currency-section';
  const RECONSTRUCTED_CLASS = 'uc-reconstructed';
  const EMAILJS_PUBLIC_KEY = '0E2OQG346dXRcEVvs';
  const EMAILJS_SERVICE_ID = 'service_ti37pko';
  const EMAILJS_TEMPLATE_ID = 'template_bjtngpd';
  let keyDebounce = null;
  let scanQueue = [];
  let scanQueueSet = new WeakSet();
  let scanIdleId = null;
  let hoverTarget = null;
  let mutationDebounce = null;
  let isReplaceActive = false;
  let replacedSpans = [];

  // Settings — initialized to defaults, loaded async on startup
  let settings = Object.assign({}, window.ConvertigoSettings.DEFAULTS);

  function getCurrencyParseOptions() {
    const hostname = window.location.hostname;
    const dollarCurrency = hostname.endsWith('.au') ? 'AUD' : 'USD';
    return { dollarCurrency, targetCurrency: settings.targetCurrency };
  }

  function removePopup() {
    const existing = document.getElementById(POPUP_ID);
    if (existing) existing.remove();
  }

  function getSelectionHtml() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return '';
    const range = sel.getRangeAt(0);
    const fragment = range.cloneContents();
    const container = document.createElement('div');
    container.appendChild(fragment);
    return container.innerHTML;
  }

  // Replace each matched measurement in the original text with its converted equivalent
  function buildReconstructedString(originalText, conversions, currencyConversions) {
    let result = originalText;
    const allConversions = [
      ...conversions.map(c => ({ ...c, isCurrency: false })),
      ...currencyConversions.map(c => ({ ...c, isCurrency: true }))
    ];

    // Group dimension entries that share the same index into a single replacement
    const grouped = [];
    const dimGroups = new Map();
    for (const c of allConversions) {
      if (c.isDimension) {
        const key = c.index;
        if (!dimGroups.has(key)) {
          const group = { ...c, dimValues: [] };
          dimGroups.set(key, group);
          grouped.push(group);
        }
        dimGroups.get(key).dimValues.push(c);
      } else {
        grouped.push(c);
      }
    }

    grouped.sort((a, b) => b.index - a.index);

    for (const entry of grouped) {
      const { index, matchLength, suffix, isCurrency, original } = entry;
      let replacement;
      if (entry.dimValues) {
        // Dimension group: "33.02 x 182.88 cm"
        const unit = entry.dimValues[0].convResult[0].formatted.split(' ').slice(1).join(' ');
        const nums = entry.dimValues.map(d => d.convResult[0].formatted.split(' ')[0]);
        replacement = nums.join(' x ') + ' ' + unit + (suffix ? ' ' + suffix : '');
      } else if (isCurrency) {
        if (!entry.convResult) continue;
        const PREFIX_SYMBOLS = ['$', '€', '£', '¥'];
        const firstChar = original[0];
        replacement = PREFIX_SYMBOLS.includes(firstChar)
          ? firstChar + entry.convResult[0].number
          : entry.convResult[0].number;
      } else {
        if (!entry.convResult) continue;
        replacement = entry.convResult[0].formatted + (suffix ? ' ' + suffix : '');
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

    const feedbackBtn = document.createElement('button');
    feedbackBtn.className = 'uc-feedback-btn';
    feedbackBtn.textContent = '✉';
    feedbackBtn.title = 'Report conversion issue';
    feedbackBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openFeedbackModal(selectedText, getSelectionHtml());
    });
    btnGroup.appendChild(feedbackBtn);

    if (settings.devMode) {
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
    }

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

    conversions.forEach(({ original, suffix, convResult, isDimension, value }, idx) => {
      if (!convResult) return;
      const key = isDimension ? `${original}#${idx}` : `${original}`;
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
    const conversions = parsed.flatMap((p) => {
      if (p.isDimension) {
        return p.values.map((v, i) => {
          const convResult = window.UnitConverter.convert(v, p.unit, settings);
          const dimOriginal = (p.rawValues ? p.rawValues[i] : v) + ' ' + (p.unitText || p.unit);
          return convResult ? { ...p, value: v, original: dimOriginal, convResult } : null;
        }).filter(Boolean);
      }
      let convResult;
      if (p.isRange) {
        const r1 = window.UnitConverter.convert(p.value, p.unit, settings);
        const r2 = window.UnitConverter.convert(p.value2, p.unit, settings);
        if (r1 && r2) {
          convResult = r1.map((c1, i) => {
            const c2 = r2[i];
            const sp = c1.formatted.lastIndexOf(' ');
            const num2 = c2.formatted.slice(0, c2.formatted.lastIndexOf(' '));
            return { ...c1, formatted: c1.formatted.slice(0, sp) + '-' + num2 + c1.formatted.slice(sp) };
          });
        }
      } else {
        convResult = window.UnitConverter.convert(p.value, p.unit, settings);
      }
      return convResult ? [{ ...p, convResult }] : [];
    });

    const currencyParsed = window.CurrencyParser.parse(text, getCurrencyParseOptions());

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
          window.CurrencyConverter.setTargetCurrency(settings.targetCurrency);
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

  // ── Page-scan helpers ─────────────────────────────────────────────────────

  const SKIP_TAGS = new Set(['SCRIPT','STYLE','NOSCRIPT','IFRAME','TEXTAREA','INPUT','SELECT','BUTTON']);
  const BLOCK_TAGS = new Set([
    'ADDRESS','ARTICLE','ASIDE','BLOCKQUOTE','BODY','DD','DETAILS','DIALOG',
    'DIV','DL','DT','FIELDSET','FIGCAPTION','FIGURE','FOOTER','FORM',
    'H1','H2','H3','H4','H5','H6','HEADER','HGROUP','HR','LI','MAIN',
    'NAV','OL','P','PRE','SECTION','SUMMARY','TABLE','TBODY','TD','TFOOT',
    'TH','THEAD','TR','UL'
  ]);

  function isSkippableNode(node) {
    let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    while (el) {
      if (SKIP_TAGS.has(el.tagName)) return true;
      if (el.isContentEditable) return true;
      if (el.id === POPUP_ID) return true;
      if (el.classList && el.classList.contains('uc-highlight')) return true;
      el = el.parentElement;
    }
    return false;
  }

  function getBlockAncestor(node) {
    let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    while (el) {
      if (BLOCK_TAGS.has(el.tagName)) return el;
      el = el.parentElement;
    }
    return document.body;
  }

  function collectBlockElements(root, out) {
    const seen = new Set();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (isSkippableNode(node)) return NodeFilter.FILTER_REJECT;
        if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let node;
    while ((node = walker.nextNode())) {
      const block = getBlockAncestor(node);
      if (block.dataset.ucScanned) continue;
      if (scanQueueSet.has(block)) continue;
      if (!seen.has(block)) {
        seen.add(block);
        scanQueueSet.add(block);
        out.push(block);
      }
    }
  }

  function processBlockElement(blockEl) {
    if (!blockEl.isConnected) return;
    if (blockEl.dataset.ucScanned) return;

    // Collect all text nodes within this block (not in nested blocks or highlights)
    // Include whitespace-only nodes — they may be separators between inline elements
    const textNodes = [];
    const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (isSkippableNode(node)) return NodeFilter.FILTER_REJECT;
        if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let n;
    while ((n = walker.nextNode())) {
      if (getBlockAncestor(n) === blockEl) textNodes.push(n);
    }

    blockEl.dataset.ucScanned = '1';
    if (textNodes.length === 0) return;

    // Build concatenated text with position mapping
    let fullText = '';
    const segments = [];
    for (const tn of textNodes) {
      segments.push({ node: tn, start: fullText.length, end: fullText.length + tn.nodeValue.length });
      fullText += tn.nodeValue;
    }

    const unitMatches = window.UnitParser.parse(fullText).map(m => ({ ...m, isCurrency: false }));
    const currencyMatches = window.CurrencyParser.parse(fullText, getCurrencyParseOptions()).map(m => ({ ...m, isCurrency: true }));

    // Merge, sort by index, deduplicate overlaps
    const allMatches = [...unitMatches, ...currencyMatches].sort((a, b) => a.index - b.index);
    const deduped = [];
    let lastEnd = -1;
    for (const m of allMatches) {
      if (m.index >= lastEnd) {
        deduped.push(m);
        lastEnd = m.index + m.matchLength;
      }
    }

    // Filter out units already in the user's preferred system (they need no conversion)
    const filtered = deduped.filter(m => {
      if (m.isCurrency) return true;
      const srcSystem = window.UnitConverter.UNIT_SYSTEM[m.unit];
      if (!srcSystem) return true;
      if (settings.unitSystem === 'metric' && srcSystem === 'metric') return false;
      if (settings.unitSystem === 'imperial' && srcSystem === 'imperial') return false;
      return true;
    });

    if (filtered.length === 0) return;

    // Process matches in reverse order to preserve DOM positions
    for (let i = filtered.length - 1; i >= 0; i--) {
      const m = filtered[i];
      const matchStart = m.index;
      const matchEnd = m.index + m.matchLength;
      const matchText = fullText.slice(matchStart, matchEnd);

      // Find which text node segments this match spans
      const startSeg = segments.find(s => matchStart >= s.start && matchStart < s.end);
      const endSeg = segments.find(s => matchEnd > s.start && matchEnd <= s.end);
      if (!startSeg || !endSeg || !startSeg.node.isConnected || !endSeg.node.isConnected) continue;

      const range = document.createRange();
      range.setStart(startSeg.node, matchStart - startSeg.start);
      range.setEnd(endSeg.node, matchEnd - endSeg.start);

      const span = document.createElement('span');
      span.className = 'uc-highlight';
      span.dataset.ucOriginal = matchText;
      span.dataset.ucIsCurrency = m.isCurrency ? '1' : '0';

      // extractContents works for both same-node and cross-boundary matches
      const contents = range.extractContents();
      span.appendChild(contents);
      range.insertNode(span);

      // extractContents clones partial ancestors (e.g. <span class="currency-symbol">$</span>)
      // into the fragment but leaves empty shells in the DOM immediately before the inserted span.
      // Remove those empty shells to prevent double-symbol rendering in the browser.
      let prev = span.previousSibling;
      while (prev && prev.nodeType === Node.ELEMENT_NODE && prev.textContent === '') {
        const toRemove = prev;
        prev = prev.previousSibling;
        toRemove.remove();
      }

      replaceSpanIfActive(span);
    }
  }

  function drainScanQueue(deadline) {
    scanIdleId = null;
    while (scanQueue.length > 0 && deadline.timeRemaining() > 5) {
      const blockEl = scanQueue.shift();
      scanQueueSet.delete(blockEl);
      if (blockEl.isConnected) processBlockElement(blockEl);
    }
    if (scanQueue.length > 0) {
      scanIdleId = requestIdleCallback(drainScanQueue, { timeout: 2000 });
    }
  }

  function enqueueSubtree(root) {
    const MAX_QUEUE = 500;
    collectBlockElements(root, scanQueue);
    if (scanQueue.length > MAX_QUEUE) {
      const dropped = scanQueue.splice(0, scanQueue.length - MAX_QUEUE);
      for (const el of dropped) scanQueueSet.delete(el);
    }
    if (!scanIdleId) {
      scanIdleId = requestIdleCallback(drainScanQueue, { timeout: 2000 });
    }
  }

  // ── Hover popup helpers ────────────────────────────────────────────────────

  function positionPopupNearCursor(popup, mouseX, mouseY) {
    popup.style.visibility = 'hidden';
    document.body.appendChild(popup);
    const w = popup.offsetWidth;
    const h = popup.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const GAP = 12;
    const EDGE = 8;

    let left = mouseX + GAP;
    let top = mouseY + GAP;
    if (left + w > vw - EDGE) left = mouseX - w - GAP;
    if (top + h > vh - EDGE) top = mouseY - h - GAP;
    left = Math.max(EDGE, Math.min(left, vw - w - EDGE));
    top = Math.max(EDGE, Math.min(top, vh - h - EDGE));

    popup.style.left = left + 'px';
    popup.style.top = top + 'px';
    popup.style.visibility = '';
  }

  async function showHoverPopup(span, mouseX, mouseY) {
    const original = span.dataset.ucOriginal;
    if (!original) return;

    const parsed = window.UnitParser.parse(original);
    const conversions = parsed.flatMap(p => {
      if (p.isDimension) {
        return p.values.map((v, i) => {
          const convResult = window.UnitConverter.convert(v, p.unit, settings);
          const dimOriginal = (p.rawValues ? p.rawValues[i] : v) + ' ' + (p.unitText || p.unit);
          return convResult ? { ...p, value: v, original: dimOriginal, convResult } : null;
        }).filter(Boolean);
      }
      const convResult = window.UnitConverter.convert(p.value, p.unit, settings);
      return convResult ? [{ ...p, convResult }] : [];
    });
    const currencyParsed = window.CurrencyParser.parse(original, getCurrencyParseOptions());

    if (conversions.length === 0 && currencyParsed.length === 0) return;

    hoverTarget = span;
    const hasDivider = conversions.length > 0 && currencyParsed.length > 0;
    const needsLoad = currencyParsed.length > 0;
    const showSpinner = needsLoad && !window.CurrencyConverter.isReady();
    const initialCurrencySection = needsLoad ? buildCurrencySection([], false, showSpinner) : null;

    removePopup();
    const popup = buildPopup(conversions, null, original, initialCurrencySection, hasDivider);
    popup.classList.add('uc-popup-hover');
    // Hover popup is transient — remove the button group (close / copy-test)
    const btnGroup = popup.querySelector('.uc-btn-group');
    if (btnGroup) btnGroup.remove();

    positionPopupNearCursor(popup, mouseX, mouseY);

    if (needsLoad) {
      let currencyConversions = [];
      let currencyError = false;
      try {
        await window.CurrencyConverter.init();
        if (window.CurrencyConverter.hasError()) {
          currencyError = true;
        } else {
          window.CurrencyConverter.setTargetCurrency(settings.targetCurrency);
          currencyConversions = currencyParsed.map(p => ({
            ...p,
            convResult: window.CurrencyConverter.convert(p.value, p.currency, p.multiplier)
          })).filter(c => c.convResult);
        }
      } catch (e) {
        currencyError = true;
      }

      const livePopup = document.getElementById(POPUP_ID);
      if (!livePopup) return;
      const oldSection = livePopup.querySelector('.' + CURRENCY_SECTION_CLASS);
      if (oldSection) {
        oldSection.replaceWith(buildCurrencySection(currencyConversions, currencyError, false));
      }
    }
  }

  function onHighlightMouseover(e) {
    if (!settings.hoverEnabled) return;
    const span = e.target.closest && e.target.closest('.uc-highlight');
    if (!span) return;
    // If a selection popup is open, don't show hover popup
    const existing = document.getElementById(POPUP_ID);
    if (existing && !existing.classList.contains('uc-popup-hover')) return;
    if (hoverTarget === span) return;
    showHoverPopup(span, e.clientX, e.clientY);
  }

  function onHighlightMouseout(e) {
    if (!hoverTarget) return;
    const popup = document.getElementById(POPUP_ID);
    // Don't close if mouse moved into the popup
    if (popup && e.relatedTarget && popup.contains(e.relatedTarget)) return;
    // Don't close if mouse moved back onto the same highlight span
    if (e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('.uc-highlight') === hoverTarget) return;
    removePopup();
    hoverTarget = null;
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

  // ── Hold-key page-wide replacement ────────────────────────────────────────

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
      const r1 = window.UnitConverter.convert(p.value, p.unit, settings);
      const r2 = window.UnitConverter.convert(p.value2, p.unit, settings);
      if (!r1 || !r2) return null;
      const c1 = r1[0], c2 = r2[0];
      const sp = c1.formatted.lastIndexOf(' ');
      const num2 = c2.formatted.slice(0, c2.formatted.lastIndexOf(' '));
      return c1.formatted.slice(0, sp) + '-' + num2 + c1.formatted.slice(sp);
    }

    const convResult = window.UnitConverter.convert(p.value, p.unit, settings);
    return convResult ? convResult[0].formatted : null;
  }

  function replaceHighlightSpan(span) {
    const original = span.dataset.ucOriginal;
    if (!original) return;
    let replacement = null;

    if (span.dataset.ucIsCurrency === '1') {
      if (window.CurrencyConverter.isReady() && !window.CurrencyConverter.hasError()) {
        window.CurrencyConverter.setTargetCurrency(settings.targetCurrency);
        const cp = window.CurrencyParser.parse(original, getCurrencyParseOptions());
        if (cp.length) {
          const convResult = window.CurrencyConverter.convert(cp[0].value, cp[0].currency, cp[0].multiplier);
          if (convResult) replacement = convResult[0].formatted;
        }
      }
    } else {
      replacement = getUnitReplacementText(original);
    }

    if (!replacement) return;
    if (!span.dataset.ucInnerHtml) span.dataset.ucInnerHtml = span.innerHTML;
    span.textContent = replacement;
    span.classList.add('uc-alt-replaced');
    replacedSpans.push(span);
  }

  function activateReplace() {
    if (isReplaceActive) return;
    isReplaceActive = true;

    // Replace unit spans immediately
    document.querySelectorAll('.uc-highlight').forEach(replaceHighlightSpan);

    // If currency spans weren't replaced (rates not loaded), load and retry
    const unreplacedCurrency = document.querySelectorAll('.uc-highlight[data-uc-is-currency="1"]:not(.uc-alt-replaced)');
    if (unreplacedCurrency.length > 0 && !window.CurrencyConverter.isReady()) {
      window.CurrencyConverter.init().then(() => {
        if (!isReplaceActive) return;
        unreplacedCurrency.forEach(replaceHighlightSpan);
      }).catch(() => {});
    }
  }

  function replaceSpanIfActive(span) {
    if (!isReplaceActive) return;
    replaceHighlightSpan(span);
  }

  function deactivateReplace() {
    if (!isReplaceActive) return;
    if (settings.permanentReplace) return;
    isReplaceActive = false;
    replacedSpans.forEach(span => {
      if (span.dataset.ucInnerHtml) {
        span.innerHTML = span.dataset.ucInnerHtml;
        delete span.dataset.ucInnerHtml;
      } else if (span.dataset.ucOriginal) {
        span.textContent = span.dataset.ucOriginal;
      }
      span.classList.remove('uc-alt-replaced');
    });
    replacedSpans = [];
  }

  function isReplaceKeyHeld(e) {
    return (settings.replaceKey === 'Alt' && e.altKey) ||
           (settings.replaceKey === 'Control' && e.ctrlKey) ||
           (settings.replaceKey === 'Shift' && e.shiftKey);
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === settings.replaceKey) activateReplace();
  });

  document.addEventListener('keyup', (e) => {
    if (e.key === settings.replaceKey) deactivateReplace();
  });

  // Detect modifier held across page loads (keydown auto-repeat may not fire)
  document.addEventListener('mousemove', (e) => {
    const held = isReplaceKeyHeld(e);
    if (held && !isReplaceActive) activateReplace();
    else if (!held && isReplaceActive) deactivateReplace();
  });

  window.addEventListener('blur', deactivateReplace);

  // ── Feedback modal ─────────────────────────────────────────────────────────

  function buildFeedbackEmailBody(selectedText, selectionHtml, includeUrl, pageUrl, description) {
    let body = 'Selected text:\n' + selectedText + '\n\n';
    body += 'Selection HTML:\n' + selectionHtml + '\n\n';
    if (includeUrl && pageUrl) {
      body += 'Page URL:\n' + pageUrl + '\n\n';
    }
    if (description.trim()) {
      body += 'Description:\n' + description.trim() + '\n\n';
    }
    body += '---\nConvertigo v' + browser.runtime.getManifest().version;
    return body;
  }

  function openFeedbackModal(selectedText, selectionHtml) {
    const existingOverlay = document.getElementById('uc-feedback-overlay');
    if (existingOverlay) existingOverlay.remove();
    removePopup();

    const htmlDisplay = selectionHtml.length > 5000
      ? selectionHtml.slice(0, 5000) + '\n… (truncated)'
      : selectionHtml;

    const overlay = document.createElement('div');
    overlay.id = 'uc-feedback-overlay';

    const modal = document.createElement('div');
    modal.className = 'uc-feedback-modal';

    const isGeneral = !selectedText;

    const header = document.createElement('div');
    header.className = 'uc-feedback-header';
    header.textContent = isGeneral ? 'Send Feedback' : 'Report Conversion Issue';
    modal.appendChild(header);

    const body = document.createElement('div');
    body.className = 'uc-feedback-body';

    if (isGeneral) {
      // General feedback: show guidance instead of empty text/HTML fields
      const hint = document.createElement('div');
      hint.className = 'uc-feedback-hint';
      hint.textContent = 'To report a specific conversion issue, select the text on the page and use right-click → Convertigo: Report conversion issue.';
      body.appendChild(hint);
    } else {
      // Selected text
      const textField = document.createElement('div');
      textField.className = 'uc-feedback-field';
      const textLabel = document.createElement('div');
      textLabel.className = 'uc-feedback-field-label';
      textLabel.textContent = 'Selected text:';
      const textValue = document.createElement('div');
      textValue.className = 'uc-feedback-value';
      textValue.textContent = selectedText;
      textField.appendChild(textLabel);
      textField.appendChild(textValue);
      body.appendChild(textField);

      // Selection HTML
      const htmlField = document.createElement('div');
      htmlField.className = 'uc-feedback-field';
      const htmlLabel = document.createElement('div');
      htmlLabel.className = 'uc-feedback-field-label';
      htmlLabel.textContent = 'Selection HTML:';
      const htmlValue = document.createElement('div');
      htmlValue.className = 'uc-feedback-value uc-feedback-html';
      htmlValue.textContent = htmlDisplay;
      htmlField.appendChild(htmlLabel);
      htmlField.appendChild(htmlValue);
      body.appendChild(htmlField);
    }

    // Include page URL checkbox (default off)
    const urlField = document.createElement('div');
    urlField.className = 'uc-feedback-field';
    const urlCheckboxLabel = document.createElement('label');
    urlCheckboxLabel.className = 'uc-feedback-checkbox-label';
    const urlCheckbox = document.createElement('input');
    urlCheckbox.type = 'checkbox';
    urlCheckbox.className = 'uc-feedback-checkbox';
    urlCheckboxLabel.appendChild(urlCheckbox);
    urlCheckboxLabel.appendChild(document.createTextNode(' Include page URL'));
    const urlDisplay = document.createElement('div');
    urlDisplay.className = 'uc-feedback-value uc-feedback-url-display';
    urlDisplay.style.cssText = 'display:none';
    urlField.appendChild(urlCheckboxLabel);
    urlField.appendChild(urlDisplay);
    body.appendChild(urlField);

    // Description (optional)
    const descField = document.createElement('div');
    descField.className = 'uc-feedback-field';
    const descLabel = document.createElement('div');
    descLabel.className = 'uc-feedback-field-label';
    descLabel.textContent = 'Description (optional):';
    const descTextarea = document.createElement('textarea');
    descTextarea.className = 'uc-feedback-desc';
    descTextarea.placeholder = isGeneral
      ? 'Describe your feedback or issue'
      : 'Only needed if it requires more context than the selected text above';
    descTextarea.rows = 3;
    descField.appendChild(descLabel);
    descField.appendChild(descTextarea);
    body.appendChild(descField);

    // Divider + email preview
    const divider = document.createElement('div');
    divider.className = 'uc-feedback-divider';
    body.appendChild(divider);

    const previewLabel = document.createElement('div');
    previewLabel.className = 'uc-feedback-field-label';
    previewLabel.textContent = 'Email preview:';
    body.appendChild(previewLabel);

    const previewEl = document.createElement('pre');
    previewEl.className = 'uc-feedback-preview';
    body.appendChild(previewEl);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'uc-feedback-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'uc-feedback-cancel';
    cancelBtn.textContent = 'Cancel';
    const sendBtn = document.createElement('button');
    sendBtn.className = 'uc-feedback-send';
    sendBtn.textContent = 'Send';
    const statusEl = document.createElement('span');
    statusEl.className = 'uc-feedback-status';
    actions.appendChild(cancelBtn);
    actions.appendChild(sendBtn);
    actions.appendChild(statusEl);
    body.appendChild(actions);

    modal.appendChild(body);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    let pageUrl = '';

    function rebuildPreview() {
      previewEl.textContent = buildFeedbackEmailBody(
        selectedText, htmlDisplay, urlCheckbox.checked, pageUrl, descTextarea.value
      );
    }

    rebuildPreview();

    function closeModal() {
      document.removeEventListener('keydown', escHandler);
      overlay.remove();
    }

    function escHandler(e) {
      if (e.key === 'Escape') closeModal();
    }

    urlCheckbox.addEventListener('change', () => {
      if (urlCheckbox.checked) {
        pageUrl = window.location.href;
        urlDisplay.textContent = pageUrl;
        urlDisplay.style.cssText = '';
      } else {
        pageUrl = '';
        urlDisplay.style.cssText = 'display:none';
      }
      rebuildPreview();
    });

    descTextarea.addEventListener('input', rebuildPreview);
    cancelBtn.addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
    document.addEventListener('keydown', escHandler);

    sendBtn.addEventListener('click', async () => {
      sendBtn.disabled = true;
      statusEl.textContent = 'Sending…';
      statusEl.className = 'uc-feedback-status';

      const selectionHtmlToSend = selectionHtml.length > 5000
        ? selectionHtml.slice(0, 5000) + ' (truncated)'
        : selectionHtml;

      const payload = {
        service_id: EMAILJS_SERVICE_ID,
        template_id: EMAILJS_TEMPLATE_ID,
        user_id: EMAILJS_PUBLIC_KEY,
        template_params: {
          selected_text: selectedText,
          selection_html: selectionHtmlToSend,
          page_url: urlCheckbox.checked ? pageUrl : '(not included)',
          description: descTextarea.value.trim() || '(none)',
          extension_version: browser.runtime.getManifest().version
        }
      };

      try {
        const result = await browser.runtime.sendMessage({ type: 'sendFeedback', payload });
        if (result && result.ok) {
          statusEl.textContent = '✓ Sent!';
          statusEl.className = 'uc-feedback-status uc-feedback-status-ok';
          setTimeout(closeModal, 1500);
        } else {
          throw new Error(result && result.error ? result.error : 'HTTP ' + (result && result.status));
        }
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.className = 'uc-feedback-status uc-feedback-status-error';
        sendBtn.disabled = false;
      }
    });
  }

  // Context menu message handler
  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'openFeedbackModal') {
      openFeedbackModal(msg.selectionText || '', getSelectionHtml());
    }
  });

  // ── Page-scan startup ──────────────────────────────────────────────────────

  // Pre-fetch currency rates so they're ready for hold-key replace and hover
  window.CurrencyConverter.init().catch(() => {});

  // Hover event delegation (one listener each, not per-span)
  document.body.addEventListener('mouseover', onHighlightMouseover);
  document.body.addEventListener('mouseout', onHighlightMouseout);

  let ucObserver = null;

  function startPageScan() {
    enqueueSubtree(document.body);
    if (!ucObserver) {
      ucObserver = new MutationObserver((mutations) => {
        clearTimeout(mutationDebounce);
        mutationDebounce = setTimeout(() => {
          for (const m of mutations) {
            if (m.type === 'characterData') {
              const el = m.target.parentElement;
              if (!el) continue;
              // If a text node inside our span changed (e.g. React mutates text node directly),
              // the span now wraps stale original text — unwrap it so the block can be re-scanned
              const staleSpan = el.classList.contains('uc-highlight') ? el
                : (el.closest ? el.closest('.uc-highlight') : null);
              if (staleSpan) {
                const block = getBlockAncestor(staleSpan);
                const rescanRoot = block || staleSpan.parentElement;
                staleSpan.replaceWith(document.createTextNode(staleSpan.textContent));
                if (rescanRoot) {
                  delete rescanRoot.dataset.ucScanned;
                  enqueueSubtree(rescanRoot);
                }
              } else if (!isSkippableNode(el)) {
                const block = getBlockAncestor(el);
                if (block) delete block.dataset.ucScanned;
                enqueueSubtree(block || el);
              }
              continue;
            }
            for (const node of m.addedNodes) {
              if (node.nodeType === Node.TEXT_NODE) {
                const parent = node.parentElement;
                if (!parent) continue;
                if (parent.classList.contains('uc-highlight')) {
                  // Page set .textContent on our span's parent, replacing our span with a text
                  // node — unwrap the stale span
                  const block = getBlockAncestor(parent);
                  const rescanRoot = block || parent.parentElement;
                  parent.replaceWith(document.createTextNode(parent.textContent));
                  if (rescanRoot) {
                    delete rescanRoot.dataset.ucScanned;
                    enqueueSubtree(rescanRoot);
                  }
                } else if (!isSkippableNode(parent)) {
                  // Plain text node added (e.g. page set .textContent replacing our span)
                  const block = getBlockAncestor(parent);
                  if (block) delete block.dataset.ucScanned;
                  enqueueSubtree(block || parent);
                }
              } else if (node.nodeType === Node.ELEMENT_NODE && !node.classList.contains('uc-highlight')) {
                // New element added — clear scanned flag so its block gets re-scanned
                const block = getBlockAncestor(node);
                if (block) delete block.dataset.ucScanned;
                enqueueSubtree(node);
              }
            }
          }
        }, 200);
      });
      ucObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    }
  }

  function removeAllHighlights() {
    document.querySelectorAll('.uc-highlight').forEach(span => {
      span.replaceWith(document.createTextNode(span.dataset.ucOriginal || span.textContent));
    });
    document.querySelectorAll('[data-uc-scanned]').forEach(el => delete el.dataset.ucScanned);
  }

  function stopPageScan() {
    if (ucObserver) {
      ucObserver.disconnect();
      ucObserver = null;
    }
    if (scanIdleId) {
      cancelIdleCallback(scanIdleId);
      scanIdleId = null;
    }
    scanQueue.length = 0;
    scanQueueSet = new WeakSet();
  }

  // Start page scan immediately with defaults — don't block on async storage read
  startPageScan();

  // Load persisted settings and apply them; stop scan if user disabled it
  function applyHoverCursor(enabled) {
    document.body.classList.toggle('uc-hover-enabled', enabled);
  }

  window.ConvertigoSettings.load().then(loaded => {
    settings = loaded;
    applyHoverCursor(settings.hoverEnabled);
    if (!settings.pageScanEnabled) stopPageScan();
    if (settings.permanentReplace) activateReplace();
  });

  // React to settings changes without page reload
  window.ConvertigoSettings.onChange(newSettings => {
    const wasPageScan = settings.pageScanEnabled;
    const prevUnitSystem = settings.unitSystem;
    settings = newSettings;

    applyHoverCursor(settings.hoverEnabled);

    if (settings.unitSystem !== prevUnitSystem && settings.pageScanEnabled) {
      removeAllHighlights();
      startPageScan();
    } else if (settings.pageScanEnabled && !wasPageScan) {
      startPageScan();
    } else if (!settings.pageScanEnabled && wasPageScan) {
      stopPageScan();
    }

    if (settings.permanentReplace) {
      if (!isReplaceActive) activateReplace();
    } else {
      // Deactivate replace if permanent mode turned off or key changed while active
      if (isReplaceActive) deactivateReplace();
    }
  });
})();
