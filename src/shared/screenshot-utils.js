export const DEFAULT_SETTINGS = Object.freeze({
  filenamePrefix: 'screenshot',
  downloadFolder: 'Webpage Screenshots',
  scrollDelay: 200,
  saveAs: false,
  imageFormat: 'png',
  includeWebsiteName: true,
  restoreScrollPosition: true
});

const SUPPORTED_FORMATS = new Set(['png', 'jpeg', 'webp']);

const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function avoidReservedName(value, fallback) {
  if (!value || WINDOWS_RESERVED_NAMES.test(value)) return `${fallback}-${value || 'file'}`;
  return value;
}

export function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

export function sanitizeFilenamePart(input, fallback = 'page', maxLength = 80) {
  const cleaned = String(input ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, maxLength);
  return avoidReservedName(cleaned || fallback, fallback);
}

export function sanitizeRelativeFolder(input) {
  const segments = String(input ?? '')
    .normalize('NFKC')
    .replace(/\\/g, '/')
    .split('/')
    .map(segment => segment.trim())
    .filter(segment => segment && segment !== '.' && segment !== '..')
    .map(segment => segment
      .replace(/[\x00-\x1f<>:"|?*]+/g, '-')
      .replace(/[. ]+$/g, '')
      .replace(/^\.+$/g, '')
      .slice(0, 60))
    .map(segment => avoidReservedName(segment, 'folder'))
    .filter(Boolean)
    .slice(0, 8);

  return segments.join('/');
}

export function timestampString(date = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function normalizeImageFormat(value) {
  const format = String(value || '').toLowerCase();
  return SUPPORTED_FORMATS.has(format) ? format : DEFAULT_SETTINGS.imageFormat;
}

export function formatMimeType(format) {
  const normalized = normalizeImageFormat(format);
  return normalized === 'png' ? 'image/png' : normalized === 'jpeg' ? 'image/jpeg' : 'image/webp';
}

export function formatExtension(format) {
  return normalizeImageFormat(format) === 'jpeg' ? 'jpg' : normalizeImageFormat(format);
}

export function makeFilename({ prefix, hostname, fullPage, folder, format = 'png', includeWebsiteName = true }) {
  const cleanPrefix = sanitizeFilenamePart(prefix, 'screenshot', 40);
  const cleanHost = sanitizeFilenamePart(hostname, 'page', 80);
  const cleanFolder = sanitizeRelativeFolder(folder);
  const extension = formatExtension(format);
  const pieces = [fullPage ? `fullpage-${cleanPrefix}` : cleanPrefix];
  if (includeWebsiteName) pieces.push(cleanHost);
  pieces.push(timestampString());
  const base = `${pieces.join('-')}.${extension}`;
  return cleanFolder ? `${cleanFolder}/${base}` : base;
}

export function normalizeSettings(raw = {}) {
  return {
    filenamePrefix: sanitizeFilenamePart(raw.filenamePrefix, DEFAULT_SETTINGS.filenamePrefix, 40),
    downloadFolder: sanitizeRelativeFolder(raw.downloadFolder),
    scrollDelay: clampInteger(raw.scrollDelay, 75, 1000, DEFAULT_SETTINGS.scrollDelay),
    saveAs: Boolean(raw.saveAs),
    imageFormat: normalizeImageFormat(raw.imageFormat),
    includeWebsiteName: raw.includeWebsiteName === undefined ? DEFAULT_SETTINGS.includeWebsiteName : Boolean(raw.includeWebsiteName),
    restoreScrollPosition: raw.restoreScrollPosition === undefined ? DEFAULT_SETTINGS.restoreScrollPosition : Boolean(raw.restoreScrollPosition)
  };
}
