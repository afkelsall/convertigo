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
  let pendingScanRoots = [];             // subtrees awaiting collection — walked lazily at idle, not synchronously
  let activeCollect = null;              // in-progress (resumable) collection TreeWalker for the current root
  let blockScanTimes = new WeakMap();   // block element → timestamp of last scan (#3 throttle)
  let deferredBlocks = new WeakSet();   // blocks with a pending deferred rescan
  let liveBlocks = new WeakSet();       // blocks detected as live-updating — excluded from scanning
  let blockActivity = new WeakMap();    // block element → { windowStart, count } for live detection
  let hoverTarget = null;
  let mutationDebounce = null;
  let pendingMutations = [];
  let isReplaceActive = false;
  let replacedSpans = [];
  let spanSavedNodes = new WeakMap(); // span → detached child nodes saved before replacement

  // Settings — initialized to defaults, loaded async on startup
  let settings = Object.assign({}, window.ConvertigoSettings.DEFAULTS);

  function isPageDisabled() {
    return !!(settings.disabledUrls && settings.disabledUrls.includes(window.location.href));
  }

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
    if (isPageDisabled()) { removePopup(); return; }
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
  // ARIA roles that imply frequently-updating content (live auction bids, countdown
  // timers, status tickers). Highlighting inside these causes a re-scan storm because
  // the page rewrites them constantly — skip them entirely.
  const LIVE_ROLES = new Set(['timer','status','alert','marquee','progressbar']);
  // Blocks whose concatenated text exceeds this are too large to highlight cheaply.
  // We mark them scanned and bail rather than re-parsing on every mutation.
  const MAX_BLOCK_TEXT = 20000;
  // Minimum gap between successive scans of the same block. Live-updating pages fire
  // mutations continuously; this caps each block to one re-walk + re-parse per window.
  const RESCAN_THROTTLE_MS = 1000;
  // Heuristic live-region detection. A block that needs this many scans within the window is
  // treated as live-updating (countdown timers, streaming bids) and excluded from scanning —
  // even if it carries no aria-live/role=timer markup (most live pages don't). This breaks the
  // mutation → unwrap → re-scan loop that pegs the CPU on pages like live auctions.
  const LIVE_WINDOW_MS = 5000;
  const LIVE_SCAN_THRESHOLD = 3;
  // Idle deadline for the scan drain. A large timeout means that on a busy main thread
  // (e.g. heavy page load) we defer scan work to genuine idle instead of forcing wakeups.
  const SCAN_IDLE_TIMEOUT = 10000;
  // Cap on queued blocks awaiting processing — a safety bound against pathological pages.
  // Blocks are de-duplicated (scanQueueSet) and marked ucScanned once handled, so the queue
  // is naturally bounded by the number of distinct unscanned blocks on the page. This needs to
  // be high enough not to drop real blocks on large pages (e.g. big Reddit comment trees), or
  // those values silently never get highlighted.
  const MAX_QUEUE = 8000;
  // Minimum idle time (ms) we require before doing another walk step, so a single collection
  // chunk can't overrun the frame budget. Collection resumes on the next idle callback.
  const COLLECT_MIN_SLICE = 2;

  function isLiveRegionEl(el) {
    if (!el || !el.getAttribute) return false;
    const live = el.getAttribute('aria-live');
    if (live && live !== 'off') return true;
    const role = el.getAttribute('role');
    if (role && LIVE_ROLES.has(role.toLowerCase())) return true;
    return false;
  }

  function isSkippableElement(el) {
    return SKIP_TAGS.has(el.tagName)
      || el.isContentEditable
      || el.id === POPUP_ID
      || (el.classList && el.classList.contains('uc-highlight'))
      || liveBlocks.has(el)
      || isLiveRegionEl(el);
  }

  function isSkippableNode(node) {
    let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    while (el) {
      if (isSkippableElement(el)) return true;
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

  function makeCollectWalker(root) {
    return document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (isSkippableNode(node)) return NodeFilter.FILTER_REJECT;
        if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
  }

  // Reduce a batch of subtree roots to only the top-most ones: drop any root that is a
  // descendant of another root in the same batch. When a page inserts a subtree, the observer
  // reports the container AND many of its descendants as separate added nodes; without this,
  // we would walk the container's whole subtree once per nested root — an O(n × depth) blowup
  // (measured at ~60× redundant text-node visits and a 16s freeze on a Reddit comment tree).
  // Walking only the top-most roots covers every descendant exactly once.
  function coalesceRoots(roots) {
    const set = new Set(roots);
    const top = [];
    for (const r of set) {
      if (!r || !r.isConnected) continue;
      let p = r.parentElement, covered = false;
      while (p) {
        if (set.has(p)) { covered = true; break; }
        p = p.parentElement;
      }
      if (!covered) top.push(r);
    }
    return top;
  }

  // Queue a subtree for scanning. The actual (potentially huge) DOM walk is deferred to the
  // idle drain — never done synchronously here — so a large insertion can't freeze the page.
  function enqueueSubtree(root) {
    if (!root) return;
    pendingScanRoots.push(root);
    if (!scanIdleId) {
      scanIdleId = requestIdleCallback(drainScanQueue, { timeout: SCAN_IDLE_TIMEOUT });
    }
  }

  // Walk pending roots into the block queue, budgeted by the idle deadline. A root too large
  // to finish in one slice leaves its walker in activeCollect to resume on the next idle call.
  function collectStep(deadline) {
    while ((activeCollect || pendingScanRoots.length) && deadline.timeRemaining() > COLLECT_MIN_SLICE) {
      if (!activeCollect) {
        const root = pendingScanRoots.shift();
        if (!root || !root.isConnected) continue;
        activeCollect = makeCollectWalker(root);
      }
      let finished = false;
      while (deadline.timeRemaining() > COLLECT_MIN_SLICE) {
        const node = activeCollect.nextNode();
        if (!node) { finished = true; break; }
        const block = getBlockAncestor(node);
        if (block.dataset.ucScanned || scanQueueSet.has(block)) continue;
        scanQueueSet.add(block);
        scanQueue.push(block);
      }
      if (finished) activeCollect = null;
      else break;   // deadline hit mid-root; resume next idle
    }
    if (scanQueue.length > MAX_QUEUE) {
      const dropped = scanQueue.splice(0, scanQueue.length - MAX_QUEUE);
      for (const el of dropped) scanQueueSet.delete(el);
    }
  }

  function scheduleDeferredRescan(blockEl, lastScan) {
    if (deferredBlocks.has(blockEl)) return;
    deferredBlocks.add(blockEl);
    const wait = Math.max(0, RESCAN_THROTTLE_MS - (Date.now() - lastScan));
    setTimeout(() => {
      deferredBlocks.delete(blockEl);
      if (!blockEl.isConnected) return;
      delete blockEl.dataset.ucScanned;   // clear the suppression flag set when throttled
      enqueueSubtree(blockEl);
    }, wait);
  }

  function processBlockElement(blockEl) {
    if (!blockEl.isConnected) return;
    if (blockEl.dataset.ucScanned) return;
    if (liveBlocks.has(blockEl)) { blockEl.dataset.ucScanned = '1'; return; }

    // Throttle re-scans of the same block (#3). On live-updating pages a flood of mutations
    // would otherwise re-walk + re-parse this block on every change. If we scanned it too
    // recently, mark it scanned to suppress further enqueues this window and schedule a single
    // deferred rescan that captures the latest state once the window elapses.
    const now = Date.now();
    const lastScan = blockScanTimes.get(blockEl);
    if (lastScan !== undefined && now - lastScan < RESCAN_THROTTLE_MS) {
      blockEl.dataset.ucScanned = '1';
      scheduleDeferredRescan(blockEl, lastScan);
      return;
    }
    blockScanTimes.set(blockEl, now);

    // Live-region back-off. Count scans in a rolling window; a block that keeps needing
    // re-scans is almost certainly live-updating. Once it crosses the threshold, classify it
    // as live, strip the highlights we added (the page will keep rewriting them otherwise),
    // and stop — isSkippableNode now rejects everything inside it, so it won't be re-enqueued.
    const act = blockActivity.get(blockEl);
    if (!act || now - act.windowStart > LIVE_WINDOW_MS) {
      blockActivity.set(blockEl, { windowStart: now, count: 1 });
    } else if (++act.count >= LIVE_SCAN_THRESHOLD) {
      liveBlocks.add(blockEl);
      blockActivity.delete(blockEl);
      blockEl.dataset.ucScanned = '1';
      blockEl.querySelectorAll('.uc-highlight').forEach(span => {
        span.replaceWith(document.createTextNode(span.dataset.ucOriginal || span.textContent));
      });
      return;
    }

    // Collect this block's own text nodes (not in nested blocks or highlights).
    // Include whitespace-only nodes — they may be separators between inline elements.
    //
    // We walk elements as well as text so we can FILTER_REJECT entire nested-block and
    // skippable subtrees up front. This is what makes the scan cheap on pages with deep,
    // custom-element-heavy DOMs (e.g. Reddit's shreddit components): the old approach walked
    // every descendant text node and called getBlockAncestor() on each to discard the ones
    // belonging to nested blocks, so a near-root block (BODY/MAIN) effectively re-walked the
    // whole document on every (re)scan — quadratic, and the source of the multi-second freeze.
    // Pruning at the element level means each block visits only its own text. The set of
    // collected nodes is identical to the old getBlockAncestor filter (verified zero-diff).
    const textNodes = [];
    const walker = document.createTreeWalker(
      blockEl,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (BLOCK_TAGS.has(node.tagName)) return NodeFilter.FILTER_REJECT;
            if (isSkippableElement(node)) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_SKIP;
          }
          return node.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      }
    );
    let n;
    while ((n = walker.nextNode())) textNodes.push(n);

    blockEl.dataset.ucScanned = '1';
    if (textNodes.length === 0) return;

    // Build concatenated text with position mapping
    let fullText = '';
    const segments = [];
    for (const tn of textNodes) {
      segments.push({ node: tn, start: fullText.length, end: fullText.length + tn.nodeValue.length });
      fullText += tn.nodeValue;
    }

    // Oversized blocks (e.g. the document.body fallback on non-semantic markup) are too
    // expensive to parse+highlight on every mutation. ucScanned is already set above, so
    // we won't re-walk this block until something inside it actually mutates.
    if (fullText.length > MAX_BLOCK_TEXT) return;

    const unitMatches = window.UnitParser.parse(fullText).map(m => ({ ...m, isCurrency: false }));
    const currencyMatches = window.CurrencyParser.parse(fullText, getCurrencyParseOptions()).map(m => ({ ...m, isCurrency: true }));

    // Merge, sort by index, deduplicate overlaps. Tie-break equal start positions by longer
    // match first (leftmost-longest) so a complete currency match wins over a shorter unit
    // match that shares its start — e.g. "5M€" (€5M) must beat "5M" parsed as 5 metres.
    const allMatches = [...unitMatches, ...currencyMatches]
      .sort((a, b) => a.index - b.index || b.matchLength - a.matchLength);
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
    // Phase 1: lazily walk pending subtrees into the block queue, budgeted by the deadline.
    collectStep(deadline);
    // Phase 2: process queued blocks until the deadline runs out.
    while (scanQueue.length > 0 && deadline.timeRemaining() > 5) {
      const blockEl = scanQueue.shift();
      scanQueueSet.delete(blockEl);
      if (blockEl.isConnected) processBlockElement(blockEl);
    }
    // Discard the mutation records our own span insertions just generated. extractContents()
    // splits text nodes (a characterData mutation) and insertNode adds children; without this,
    // the observer would clear ucScanned and re-enqueue the very blocks we just scanned. This
    // runs synchronously right after our writes, so the only queued records are ours — any real
    // page mutations were already delivered to the observer before this idle callback ran.
    if (ucObserver) ucObserver.takeRecords();
    // Reschedule if any collection or processing work remains.
    if (scanQueue.length > 0 || pendingScanRoots.length > 0 || activeCollect) {
      scanIdleId = requestIdleCallback(drainScanQueue, { timeout: SCAN_IDLE_TIMEOUT });
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
    if (isPageDisabled()) return;
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
    if (!spanSavedNodes.has(span)) spanSavedNodes.set(span, Array.from(span.childNodes));
    span.textContent = replacement;
    span.classList.add('uc-alt-replaced');
    replacedSpans.push(span);
  }

  function activateReplace() {
    if (isPageDisabled()) return;
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
      const saved = spanSavedNodes.get(span);
      if (saved) {
        span.textContent = '';
        saved.forEach(n => span.appendChild(n));
        spanSavedNodes.delete(span);
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
    if (e.key === settings.replaceKey) { activateReplace(); return; }
    // Reconcile a stuck-active state: if the replace key's keyup was never delivered (Alt reveals
    // the browser menu / Alt+Tab steals focus mid-hold), the next keystroke — e.g. typing a
    // comment — reveals the modifier is no longer held, so clear it. Without this, page-scanned
    // units stay replaced without hover and the re-scan churn adds typing lag.
    if (!isReplaceKeyHeld(e) && isReplaceActive) deactivateReplace();
  });

  document.addEventListener('keyup', (e) => {
    if (e.key === settings.replaceKey) { deactivateReplace(); return; }
    if (!isReplaceKeyHeld(e) && isReplaceActive) deactivateReplace();
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
        pendingMutations.push(...mutations);
        clearTimeout(mutationDebounce);
        mutationDebounce = setTimeout(() => {
          const batch = pendingMutations;
          pendingMutations = [];
          // Gather candidate scan roots; coalesced and enqueued once below so overlapping
          // added subtrees aren't walked repeatedly. Stale-span unwrapping stays synchronous.
          const roots = [];
          for (const m of batch) {
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
                  roots.push(rescanRoot);
                }
              } else if (!isSkippableNode(el)) {
                const block = getBlockAncestor(el);
                if (block) delete block.dataset.ucScanned;
                roots.push(block || el);
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
                    roots.push(rescanRoot);
                  }
                } else if (!isSkippableNode(parent)) {
                  // Plain text node added (e.g. page set .textContent replacing our span)
                  const block = getBlockAncestor(parent);
                  if (block) delete block.dataset.ucScanned;
                  roots.push(block || parent);
                }
              } else if (node.nodeType === Node.ELEMENT_NODE && !node.classList.contains('uc-highlight')) {
                // Skip elements added inside skippable subtrees (contenteditable / input /
                // textarea). Rich-text editors like Reddit's Lexical composer churn elements on
                // every keystroke; scanning them yields nothing, and clearing ucScanned on their
                // block ancestor forces a needless re-parse of the enclosing block — the source of
                // stuttery text entry. Symmetric with the text-node branch's isSkippableNode guard.
                if (isSkippableNode(node)) continue;
                // New element added — clear scanned flag so its block gets re-scanned
                const block = getBlockAncestor(node);
                if (block) delete block.dataset.ucScanned;
                roots.push(node);
              }
            }
          }
          // Coalesce overlapping roots, then queue them. The heavy subtree walk happens later,
          // chunked, in the idle drain — never synchronously here.
          for (const r of coalesceRoots(roots)) enqueueSubtree(r);
          // Unwrapping stale spans above generates its own childList mutations. We've already
          // re-enqueued the affected blocks explicitly, so discard those self-generated records
          // to avoid a redundant second pass on the next observer tick.
          if (ucObserver) ucObserver.takeRecords();
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
    pendingScanRoots = [];
    activeCollect = null;
    blockScanTimes = new WeakMap();
    deferredBlocks = new WeakSet();
    liveBlocks = new WeakSet();
    blockActivity = new WeakMap();
    pendingMutations = [];
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
    if (isPageDisabled()) {
      stopPageScan();
      removeAllHighlights();
    } else if (!settings.pageScanEnabled) {
      stopPageScan();
    }
    if (settings.permanentReplace) activateReplace();
  });

  // React to settings changes without page reload
  window.ConvertigoSettings.onChange(newSettings => {
    const wasPageScan = settings.pageScanEnabled;
    const wasDisabled = isPageDisabled();
    const prevUnitSystem = settings.unitSystem;
    settings = newSettings;
    const nowDisabled = isPageDisabled();

    applyHoverCursor(settings.hoverEnabled);

    if (nowDisabled && !wasDisabled) {
      // Page just became disabled — shut everything down
      stopPageScan();
      removeAllHighlights();
      removePopup();
      if (isReplaceActive) deactivateReplace();
    } else if (!nowDisabled && wasDisabled) {
      // Page just became re-enabled — restart as appropriate
      if (settings.pageScanEnabled) startPageScan();
      if (settings.permanentReplace) activateReplace();
    } else if (!nowDisabled) {
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
    }
  });
})();
