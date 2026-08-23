import { DEFAULT_SETTINGS, normalizeSettings } from '../shared/screenshot-utils.js';

const form = document.getElementById('settingsForm');
const status = document.getElementById('status');
const prefixInput = document.getElementById('filenamePrefix');
const folderInput = document.getElementById('downloadFolder');
const delayInput = document.getElementById('scrollDelay');
const saveAsInput = document.getElementById('saveAs');
const imageFormatInput = document.getElementById('imageFormat');
const includeWebsiteNameInput = document.getElementById('includeWebsiteName');
const restoreScrollPositionInput = document.getElementById('restoreScrollPosition');
const pageTitle = document.getElementById('pageTitle');
const pageDescription = document.getElementById('pageDescription');

const manifestVersion = chrome.runtime.getManifest().version;
document.getElementById('versionText').textContent = manifestVersion;
document.getElementById('aboutVersionText').textContent = manifestVersion;

const viewMeta = {
  settingsView: ['Settings', 'Configure how PageShot names, captures, and saves screenshots.'],
  aboutView: ['About', 'Learn about this development build and how PageShot handles your data.']
};

for (const button of document.querySelectorAll('.nav-button')) {
  button.addEventListener('click', () => {
    const target = button.dataset.view;
    document.querySelectorAll('.nav-button').forEach(item => item.classList.toggle('active', item === button));
    document.querySelectorAll('.view').forEach(view => view.classList.toggle('active', view.id === target));
    pageTitle.textContent = viewMeta[target][0];
    pageDescription.textContent = viewMeta[target][1];
  });
}

async function loadSettings() {
  const settings = normalizeSettings(await chrome.storage.local.get(DEFAULT_SETTINGS));
  prefixInput.value = settings.filenamePrefix;
  folderInput.value = settings.downloadFolder;
  delayInput.value = settings.scrollDelay;
  saveAsInput.checked = settings.saveAs;
  imageFormatInput.value = settings.imageFormat;
  includeWebsiteNameInput.checked = settings.includeWebsiteName;
  restoreScrollPositionInput.checked = settings.restoreScrollPosition;
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const settings = normalizeSettings({
    filenamePrefix: prefixInput.value,
    downloadFolder: folderInput.value,
    scrollDelay: delayInput.value,
    saveAs: saveAsInput.checked,
    imageFormat: imageFormatInput.value,
    includeWebsiteName: includeWebsiteNameInput.checked,
    restoreScrollPosition: restoreScrollPositionInput.checked
  });

  await chrome.storage.local.set(settings);
  prefixInput.value = settings.filenamePrefix;
  folderInput.value = settings.downloadFolder;
  delayInput.value = settings.scrollDelay;
  saveAsInput.checked = settings.saveAs;
  imageFormatInput.value = settings.imageFormat;
  includeWebsiteNameInput.checked = settings.includeWebsiteName;
  restoreScrollPositionInput.checked = settings.restoreScrollPosition;
  status.classList.remove('error');
  status.textContent = 'Changes saved';
  window.setTimeout(() => { status.textContent = ''; }, 1400);
});

loadSettings().catch(() => {
  status.classList.add('error');
  status.textContent = 'Could not load settings';
});
