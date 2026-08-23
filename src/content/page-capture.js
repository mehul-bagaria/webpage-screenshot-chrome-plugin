(() => {
  if (window.__PAGESHOT_LOADED__) return;
  window.__PAGESHOT_LOADED__ = true;

  const state = {
    captureActive: false,
    originalWindowX: 0,
    originalWindowY: 0,
    originalTargetScrollTop: 0,
    rootScrollBehavior: '',
    bodyScrollBehavior: '',
    target: null,
    targetKind: 'document',
    hiddenElements: [],
    sessionId: null,
    captureStartedAt: 0
  };

  const MAX_STICKY_SCAN_ELEMENTS = 10000;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));

  function documentScroller() {
    return document.scrollingElement || document.documentElement || document.body || null;
  }

  function documentHeight() {
    const root = document.documentElement;
    const body = document.body;
    const scroller = documentScroller();
    return Math.max(
      window.innerHeight || 0,
      scroller?.scrollHeight || 0,
      root?.scrollHeight || 0,
      root?.offsetHeight || 0,
      root?.clientHeight || 0,
      body?.scrollHeight || 0,
      body?.offsetHeight || 0,
      body?.clientHeight || 0
    );
  }

  function elementIsCandidate(element) {
    if (!(element instanceof Element)) return false;
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return false;
    if (element.scrollHeight <= element.clientHeight + 4) return false;

    const rect = element.getBoundingClientRect();
    if (rect.width < 80 || rect.height < 80) return false;
    if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= window.innerHeight || rect.left >= window.innerWidth) return false;

    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    return true;
  }

  function collectScrollerCandidates() {
    const candidates = [];
    const docScroller = documentScroller();

    // Always try the native document first. Some sites report overflow:hidden
    // on html/body while the document is still scrollable by window.
    if (docScroller) {
      candidates.push({ kind: 'document', element: docScroller, score: Number.POSITIVE_INFINITY });
    }

    for (const element of document.querySelectorAll('body *')) {
      if (!elementIsCandidate(element)) continue;
      const rect = element.getBoundingClientRect();
      const visibleWidth = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
      const visibleHeight = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
      const scrollRange = Math.max(0, element.scrollHeight - element.clientHeight);
      const visibleArea = visibleWidth * visibleHeight;
      const style = getComputedStyle(element);
      const overflowBonus = /(auto|scroll|overlay)/.test(style.overflowY) ? 4 : 1;
      const score = visibleArea * Math.log2(scrollRange + 2) * overflowBonus;
      candidates.push({ kind: 'element', element, score });
    }

    return candidates
      .slice(0, 1)
      .concat(candidates.slice(1).sort((a, b) => b.score - a.score).slice(0, 24));
  }

  async function probeCandidate(candidate) {
    const element = candidate.element;
    if (!element) return false;

    if (candidate.kind === 'document') {
      if (documentHeight() <= window.innerHeight + 4) return false;

      const oldX = window.scrollX;
      const oldY = window.scrollY;
      const maxScroll = Math.max(0, documentHeight() - window.innerHeight);
      const probeY = oldY < maxScroll - 8 ? Math.min(maxScroll, oldY + 48) : Math.max(0, oldY - 48);
      if (Math.abs(probeY - oldY) < 2) return maxScroll > 4;

      window.scrollTo(oldX, probeY);
      element.scrollTop = probeY;
      await nextFrame();
      const movedY = Math.max(window.scrollY || 0, element.scrollTop || 0);
      window.scrollTo(oldX, oldY);
      element.scrollTop = oldY;
      await nextFrame();
      return Math.abs(movedY - oldY) > 2;
    }

    if (element.scrollHeight <= element.clientHeight + 4) return false;
    const oldTop = element.scrollTop;
    const maxScroll = Math.max(0, element.scrollHeight - element.clientHeight);
    const probeTop = oldTop < maxScroll - 8 ? Math.min(maxScroll, oldTop + 48) : Math.max(0, oldTop - 48);
    if (Math.abs(probeTop - oldTop) < 2) return maxScroll > 4;

    element.scrollTop = probeTop;
    await nextFrame();
    const movedTop = element.scrollTop;
    element.scrollTop = oldTop;
    await nextFrame();
    return Math.abs(movedTop - oldTop) > 2;
  }

  async function findActualScroller() {
    const candidates = collectScrollerCandidates();
    for (const candidate of candidates) {
      try {
        if (await probeCandidate(candidate)) return candidate;
      } catch {
        // Ignore hostile/custom elements and continue through fallbacks.
      }
    }

    // A one-viewport page is still valid. Use the document target so the
    // caller can produce one capture instead of failing with a false negative.
    const docScroller = documentScroller();
    if (docScroller) return { kind: 'document', element: docScroller };
    return null;
  }

  function pageMetrics() {
    const element = state.target || documentScroller();
    const targetKind = state.targetKind || 'document';
    if (!element) throw new Error('PageShot could not access the document scroll area.');

    if (targetKind === 'document') {
      const scrollY = Math.max(window.scrollY || 0, element.scrollTop || 0);
      return {
        targetKind: 'document',
        scrollY,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        documentHeight: documentHeight(),
        captureLeft: 0,
        captureTop: 0,
        captureWidth: window.innerWidth,
        browserViewportWidth: window.innerWidth,
        browserViewportHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1
      };
    }

    const rect = element.getBoundingClientRect();
    return {
      targetKind: 'element',
      scrollY: element.scrollTop,
      viewportWidth: element.clientWidth,
      viewportHeight: element.clientHeight,
      documentHeight: element.scrollHeight,
      captureLeft: rect.left + element.clientLeft,
      captureTop: rect.top + element.clientTop,
      captureWidth: element.clientWidth,
      browserViewportWidth: window.innerWidth,
      browserViewportHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1
    };
  }

  function hideRepeatedFixedElements() {
    if (state.hiddenElements.length) return;

    let scanned = 0;
    for (const element of document.querySelectorAll('body *')) {
      if (scanned >= MAX_STICKY_SCAN_ELEMENTS) break;
      scanned += 1;

      if (state.targetKind === 'element' && !state.target?.contains?.(element)) continue;
      const style = getComputedStyle(element);
      if (style.position !== 'fixed' && style.position !== 'sticky') continue;

      state.hiddenElements.push({
        element,
        hadInlineVisibility: element.style.visibility !== '',
        inlineVisibility: element.style.visibility
      });
      element.style.visibility = 'hidden';
    }
  }

  function restoreHiddenElements() {
    for (const item of state.hiddenElements) {
      if (!item.element?.isConnected) continue;
      if (item.hadInlineVisibility) item.element.style.visibility = item.inlineVisibility;
      else item.element.style.removeProperty('visibility');
    }
    state.hiddenElements.length = 0;
  }

  async function settle(delay) {
    await nextFrame();
    await nextFrame();
    if (delay > 0) await sleep(delay);
  }

  async function prepare(delay, sessionId) {
    if (state.captureActive) restore();

    const detected = await findActualScroller();
    if (!detected?.element) throw new Error('PageShot could not access a page area to capture.');

    state.captureActive = true;
    state.sessionId = String(sessionId || '');
    state.captureStartedAt = Date.now();
    state.target = detected.element;
    state.targetKind = detected.kind;
    state.originalWindowX = window.scrollX;
    state.originalWindowY = window.scrollY;
    state.originalTargetScrollTop = detected.element.scrollTop;
    state.rootScrollBehavior = document.documentElement?.style.scrollBehavior || '';
    state.bodyScrollBehavior = document.body?.style.scrollBehavior || '';

    if (document.documentElement) document.documentElement.style.scrollBehavior = 'auto';
    if (document.body) document.body.style.scrollBehavior = 'auto';

    try {
      if (state.targetKind === 'document') {
        detected.element.scrollTop = 0;
        window.scrollTo(0, 0);
      } else {
        detected.element.scrollTop = 0;
      }
      await settle(delay);
      return pageMetrics();
    } catch (error) {
      restore();
      throw error;
    }
  }

  async function scrollToY(y, delay, hideFixed, sessionId) {
    if (!state.captureActive || !state.target) throw new Error('Full-page capture was not prepared.');
    if (String(sessionId || '') !== state.sessionId) throw new Error('The full-page capture session is no longer active.');
    if (hideFixed) hideRepeatedFixedElements();

    const requested = Math.max(0, Number(y) || 0);
    let maxScroll;
    let expected;

    if (state.targetKind === 'document') {
      maxScroll = Math.max(0, documentHeight() - window.innerHeight);
      expected = Math.min(requested, maxScroll);
      state.target.scrollTop = expected;
      window.scrollTo(0, expected);
    } else {
      maxScroll = Math.max(0, state.target.scrollHeight - state.target.clientHeight);
      expected = Math.min(requested, maxScroll);
      state.target.scrollTop = expected;
    }

    await settle(delay);
    const metrics = pageMetrics();

    if (maxScroll > 4 && Math.abs(metrics.scrollY - expected) > 4) {
      throw new Error(`PageShot could not scroll the selected page area to ${Math.round(expected)} px (reached ${Math.round(metrics.scrollY)} px).`);
    }

    return metrics;
  }

  function restore(restoreScrollPosition = true) {
    restoreHiddenElements();

    if (document.documentElement) document.documentElement.style.scrollBehavior = state.rootScrollBehavior;
    if (document.body) document.body.style.scrollBehavior = state.bodyScrollBehavior;

    if (restoreScrollPosition) {
      if (state.target?.isConnected) state.target.scrollTop = state.originalTargetScrollTop;
      window.scrollTo(state.originalWindowX, state.originalWindowY);
    }

    state.captureActive = false;
    state.sessionId = null;
    state.captureStartedAt = 0;
    state.target = null;
    state.targetKind = 'document';
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    (async () => {
      switch (message?.type) {
        case 'PING':
          return { ok: true };
        case 'GET_PAGE_METRICS':
          return { ok: true, metrics: pageMetrics() };
        case 'RESET_CAPTURE_STATE':
          restore();
          return { ok: true };
        case 'PREPARE_FULL_CAPTURE':
          return { ok: true, metrics: await prepare(message.delay, message.sessionId) };
        case 'SCROLL_TO':
          return { ok: true, metrics: await scrollToY(message.y, message.delay, Boolean(message.hideFixed), message.sessionId) };
        case 'RESTORE_AFTER_CAPTURE':
          if (!message.sessionId || message.sessionId === state.sessionId) restore(message.restoreScrollPosition !== false);
          return { ok: true };
        default:
          return { ok: false, error: 'Unknown PageShot request.' };
      }
    })()
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: error?.message || 'Page operation failed.' }));

    return true;
  });
})();
