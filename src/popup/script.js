const visibleButton = document.getElementById('visibleBtn');
const fullButton = document.getElementById('fullBtn');
const settingsButton = document.getElementById('settingsBtn');
const status = document.getElementById('status');

function setBusy(busy, message = '') {
  visibleButton.disabled = busy;
  fullButton.disabled = busy;
  settingsButton.disabled = busy;
  status.className = 'status';
  status.textContent = message;
}

function showStatus(message, isError = false) {
  status.className = `status ${isError ? 'error' : 'success'}`;
  status.textContent = message;
}

async function capture(type) {
  setBusy(true, 'Capturing…');

  try {
    const response = await chrome.runtime.sendMessage({ type });
    if (!response?.ok) throw new Error(response?.error || 'Capture failed.');
    showStatus('Screenshot saved');
  } catch (error) {
    showStatus(error?.message || 'Capture failed.', true);
  } finally {
    visibleButton.disabled = false;
    fullButton.disabled = false;
    settingsButton.disabled = false;
  }
}

visibleButton.addEventListener('click', () => capture('CAPTURE_VISIBLE'));
fullButton.addEventListener('click', () => capture('CAPTURE_FULL_PAGE'));
settingsButton.addEventListener('click', () => chrome.runtime.openOptionsPage());
