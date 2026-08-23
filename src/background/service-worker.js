import {
  DEFAULT_SETTINGS,
  formatMimeType,
  makeFilename,
  normalizeSettings
} from '../shared/screenshot-utils.js';

const LIMITS = Object.freeze({
  maxCssHeight: 30000,
  maxCaptures: 80,
  maxCanvasDimension: 32767,
  maxEstimatedWorkingBytes: 180 * 1024 * 1024
});

let captureInProgress = false;
let lastVisibleCaptureAt = 0;
const MIN_CAPTURE_INTERVAL_MS = 525;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'CAPTURE_VISIBLE' && message?.type !== 'CAPTURE_FULL_PAGE') return false;

  runExclusiveCapture(message.type)
    .then(result => sendResponse({ ok: true, ...result }))
    .catch(error => sendResponse({ ok: false, error: friendlyError(error) }));

  return true;
});

async function runExclusiveCapture(type) {
  if (captureInProgress) throw new Error('Another screenshot is already being captured.');
  captureInProgress = true;
  try {
    return type === 'CAPTURE_VISIBLE' ? await captureVisible() : await captureFullPage();
  } finally {
    captureInProgress = false;
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!Number.isInteger(tab?.id) || !Number.isInteger(tab?.windowId)) throw new Error('No active tab was found.');
  if (!isCapturableUrl(tab.url)) throw new Error('This page cannot be captured because Chrome restricts extension access to it.');
  return tab;
}

function isCapturableUrl(url) {
  if (!url) return false;
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:' || protocol === 'file:';
  } catch {
    return false;
  }
}

async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return normalizeSettings(stored);
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'PING' });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: false }, files: ['src/content/page-capture.js'] });
  }
}

async function sendTab(tabId, message) {
  const response = await chrome.tabs.sendMessage(tabId, message);
  if (!response?.ok) throw new Error(response?.error || 'The webpage did not respond.');
  return response;
}

async function downloadDataUrl(dataUrl, filename, saveAs) {
  const downloadId = await chrome.downloads.download({ url: dataUrl, filename, saveAs, conflictAction: 'uniquify' });
  if (!Number.isInteger(downloadId)) throw new Error('Chrome did not start the download.');
  return downloadId;
}

async function pacedCaptureVisibleTab(windowId) {
  const elapsed = Date.now() - lastVisibleCaptureAt;
  if (elapsed < MIN_CAPTURE_INTERVAL_MS) await sleep(MIN_CAPTURE_INTERVAL_MS - elapsed);
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  lastVisibleCaptureAt = Date.now();
  return dataUrl;
}

async function convertDataUrl(dataUrl, format) {
  if (format === 'png') return dataUrl;
  const blob = await dataUrlToBlob(dataUrl);
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Chrome could not prepare the screenshot image.');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, bitmap.width, bitmap.height);
    context.drawImage(bitmap, 0, 0);
    const output = await canvas.convertToBlob({ type: formatMimeType(format), quality: 0.92 });
    return await blobToDataUrl(output);
  } finally {
    bitmap.close();
  }
}

async function captureVisible() {
  const tab = await getActiveTab();
  const settings = await getSettings();
  const pngDataUrl = await pacedCaptureVisibleTab(tab.windowId);
  const dataUrl = await convertDataUrl(pngDataUrl, settings.imageFormat);
  const filename = buildFilename(tab.url, settings, false);
  await downloadDataUrl(dataUrl, filename, settings.saveAs);
  return { filename };
}

async function captureFullPage() {
  const tab = await getActiveTab();
  const settings = await getSettings();
  await ensureContentScript(tab.id);

  const sessionId = crypto.randomUUID();
  let prepared = false;
  let completed = false;
  let canvas = null;
  let context = null;
  let scaleX = 1;
  let scaleY = 1;
  let previousEndCss = 0;

  try {
    try { await chrome.tabs.sendMessage(tab.id, { type: 'RESET_CAPTURE_STATE' }); } catch {}

    const prep = await sendTab(tab.id, { type: 'PREPARE_FULL_CAPTURE', delay: settings.scrollDelay, sessionId });
    prepared = true;
    const initial = prep.metrics;
    validateMetrics(initial);

    const captureWidthCss = initial.captureWidth;
    const documentHeightCss = initial.documentHeight;
    const positions = buildVerticalPositions(documentHeightCss, initial.viewportHeight);

    for (let index = 0; index < positions.length; index += 1) {
      await assertTabStillMatches(tab);
      const scroll = await sendTab(tab.id, {
        type: 'SCROLL_TO',
        y: positions[index],
        delay: settings.scrollDelay,
        hideFixed: index > 0,
        sessionId
      });
      const metrics = scroll.metrics;
      validateMetrics(metrics);

      const dataUrl = await pacedCaptureVisibleTab(tab.windowId);
      const blob = await dataUrlToBlob(dataUrl);
      const bitmap = await createImageBitmap(blob);

      try {
        if (!canvas) {
          scaleX = bitmap.width / metrics.browserViewportWidth;
          scaleY = bitmap.height / metrics.browserViewportHeight;
          if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) throw new Error('Chrome returned an invalid screenshot scale.');

          const canvasWidth = Math.max(1, Math.round(captureWidthCss * scaleX));
          const canvasHeight = Math.max(1, Math.round(documentHeightCss * scaleY));
          enforceMemoryLimit(canvasWidth, canvasHeight, bitmap.width, bitmap.height);
          canvas = new OffscreenCanvas(canvasWidth, canvasHeight);
          context = canvas.getContext('2d', { alpha: false, desynchronized: true });
          if (!context) throw new Error('Chrome could not create the screenshot canvas.');
          context.fillStyle = '#ffffff';
          context.fillRect(0, 0, canvasWidth, canvasHeight);
        }

        const currentScaleX = bitmap.width / metrics.browserViewportWidth;
        const currentScaleY = bitmap.height / metrics.browserViewportHeight;
        if (Math.abs(currentScaleX - scaleX) > 0.02 || Math.abs(currentScaleY - scaleY) > 0.02) throw new Error('The page scale changed during capture. Keep browser zoom unchanged and try again.');

        previousEndCss = drawCapture({ context, bitmap, metrics, documentHeightCss, previousEndCss, scaleX, scaleY });
      } finally {
        bitmap.close();
      }
    }

    if (!canvas || previousEndCss <= 0) throw new Error('No screenshot data was produced.');
    const outputBlob = await canvas.convertToBlob({ type: formatMimeType(settings.imageFormat), quality: 0.92 });
    canvas = null;
    context = null;
    const outputDataUrl = await blobToDataUrl(outputBlob);
    const filename = buildFilename(tab.url, settings, true);
    await downloadDataUrl(outputDataUrl, filename, settings.saveAs);
    completed = true;
    return { filename };
  } finally {
    canvas = null;
    context = null;
    if (prepared || sessionId) {
      try {
        await chrome.tabs.sendMessage(tab.id, {
          type: 'RESTORE_AFTER_CAPTURE',
          sessionId,
          restoreScrollPosition: completed ? settings.restoreScrollPosition : true
        });
      } catch {}
    }
  }
}

function validateMetrics(metrics) {
  const values = [
    metrics?.viewportWidth, metrics?.viewportHeight, metrics?.documentHeight, metrics?.scrollY,
    metrics?.captureLeft, metrics?.captureTop, metrics?.captureWidth,
    metrics?.browserViewportWidth, metrics?.browserViewportHeight
  ];
  if (!values.every(Number.isFinite) || metrics.viewportWidth <= 0 || metrics.viewportHeight <= 0 || metrics.documentHeight <= 0 || metrics.captureWidth <= 0) {
    throw new Error('The webpage returned invalid dimensions.');
  }
  if (metrics.documentHeight > LIMITS.maxCssHeight) throw new Error('This page is too tall to capture safely as one image.');
}

function buildVerticalPositions(documentHeight, viewportHeight) {
  if (documentHeight <= viewportHeight + 1) return [0];
  const maxScroll = Math.max(0, documentHeight - viewportHeight);
  const positions = [];
  for (let y = 0; y < maxScroll; y += viewportHeight) positions.push(Math.round(y));
  if (!positions.length || positions[positions.length - 1] !== Math.round(maxScroll)) positions.push(Math.round(maxScroll));
  const unique = [...new Set(positions)];
  if (unique.length > LIMITS.maxCaptures) throw new Error('This page requires too many capture steps.');
  return unique;
}

function enforceMemoryLimit(canvasWidth, canvasHeight, frameWidth, frameHeight) {
  if (canvasWidth > LIMITS.maxCanvasDimension || canvasHeight > LIMITS.maxCanvasDimension) {
    throw new Error('This page would exceed Chrome\'s safe screenshot dimensions.');
  }

  const estimatedBytes = (canvasWidth * canvasHeight * 4) + (frameWidth * frameHeight * 4 * 2);
  if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes > LIMITS.maxEstimatedWorkingBytes) {
    throw new Error('This page is too large to capture safely as a single image.');
  }
}

function drawCapture({ context, bitmap, metrics, documentHeightCss, previousEndCss, scaleX, scaleY }) {
  const visibleTopCss = Math.max(0, metrics.captureTop);
  const visibleBottomCss = Math.min(metrics.browserViewportHeight, metrics.captureTop + metrics.viewportHeight);
  const visibleHeightCss = Math.max(0, visibleBottomCss - visibleTopCss);
  if (visibleHeightCss <= 0) return previousEndCss;

  const currentTopCss = Math.max(0, metrics.scrollY);
  const currentBottomCss = Math.min(documentHeightCss, currentTopCss + visibleHeightCss);
  const drawTopCss = Math.max(currentTopCss, previousEndCss);
  if (currentBottomCss <= drawTopCss) return previousEndCss;

  const sourceX = Math.max(0, Math.round(metrics.captureLeft * scaleX));
  const sourceY = Math.max(0, Math.round((visibleTopCss + (drawTopCss - currentTopCss)) * scaleY));
  const sourceWidth = Math.min(bitmap.width - sourceX, Math.round(metrics.captureWidth * scaleX));
  const sourceHeight = Math.min(bitmap.height - sourceY, Math.round((currentBottomCss - drawTopCss) * scaleY));
  if (sourceWidth <= 0 || sourceHeight <= 0) return previousEndCss;

  context.drawImage(bitmap, sourceX, sourceY, sourceWidth, sourceHeight, 0, Math.round(drawTopCss * scaleY), sourceWidth, sourceHeight);
  return currentBottomCss;
}

async function assertTabStillMatches(originalTab) {
  const current = await chrome.tabs.get(originalTab.id);
  if (!current || current.windowId !== originalTab.windowId || current.url !== originalTab.url) throw new Error('The page changed while PageShot was capturing it.');
}

function buildFilename(url, settings, fullPage) {
  let hostname = 'page';
  try { hostname = new URL(url).hostname || 'local-file'; } catch {}
  return makeFilename({
    prefix: settings.filenamePrefix,
    hostname,
    fullPage,
    folder: settings.downloadFolder,
    format: settings.imageFormat,
    includeWebsiteName: settings.includeWebsiteName
  });
}

async function dataUrlToBlob(dataUrl) {
  const response = await fetch(dataUrl);
  if (!response.ok) throw new Error('Chrome could not decode the captured image.');
  return await response.blob();
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(binary)}`;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function friendlyError(error) {
  const message = error?.message || 'Capture failed.';
  if (/Cannot access|permission|restricted|chrome:\/\//i.test(message)) return 'Chrome does not allow PageShot to capture this page.';
  return message;
}
