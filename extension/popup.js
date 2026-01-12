const captureView = document.getElementById('capture-view');
const successView = document.getElementById('success-view');
const errorView = document.getElementById('error-view');

const captureBtn = document.getElementById('capture-btn');
const expirationSelect = document.getElementById('expiration');
const snapshotUrlInput = document.getElementById('snapshot-url');
const copyBtn = document.getElementById('copy-btn');
const expiresText = document.getElementById('expires-text');
const newCaptureBtn = document.getElementById('new-capture-btn');
const retryBtn = document.getElementById('retry-btn');
const errorMessage = document.getElementById('error-message');

function showView(view) {
  captureView.hidden = view !== 'capture';
  successView.hidden = view !== 'success';
  errorView.hidden = view !== 'error';
}

function setLoading(loading) {
  captureBtn.disabled = loading;
  captureBtn.querySelector('.btn-text').hidden = loading;
  captureBtn.querySelector('.btn-loading').hidden = !loading;
}

async function captureCurrentPage() {
  setLoading(true);

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab) {
      throw new Error('No active tab found');
    }

    if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      throw new Error('Cannot capture browser internal pages');
    }

    const expiration = expirationSelect.value;

    const response = await chrome.runtime.sendMessage({
      action: 'capture',
      tabId: tab.id,
      expiration,
    });

    if (response.error) {
      throw new Error(response.error);
    }

    snapshotUrlInput.value = response.url;

    if (response.expiresAt) {
      const expiresDate = new Date(response.expiresAt);
      expiresText.textContent = `Expires ${expiresDate.toLocaleDateString()}`;
    } else {
      expiresText.textContent = 'This link never expires';
    }

    showView('success');
  } catch (err) {
    errorMessage.textContent = err.message || 'Something went wrong';
    showView('error');
  } finally {
    setLoading(false);
  }
}

async function copyToClipboard() {
  try {
    await navigator.clipboard.writeText(snapshotUrlInput.value);
    copyBtn.classList.add('copied');
    copyBtn.innerHTML = '<span class="copy-icon">&#10003;</span>';
    setTimeout(() => {
      copyBtn.classList.remove('copied');
      copyBtn.innerHTML = '<span class="copy-icon">&#128203;</span>';
    }, 2000);
  } catch (err) {
    snapshotUrlInput.select();
    document.execCommand('copy');
  }
}

captureBtn.addEventListener('click', captureCurrentPage);
copyBtn.addEventListener('click', copyToClipboard);
newCaptureBtn.addEventListener('click', () => showView('capture'));
retryBtn.addEventListener('click', () => {
  showView('capture');
  captureCurrentPage();
});
