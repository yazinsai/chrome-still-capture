const captureView = document.getElementById('capture-view');
const successView = document.getElementById('success-view');
const errorView = document.getElementById('error-view');
const historyView = document.getElementById('history-view');

const captureBtn = document.getElementById('capture-btn');
const expirationSelect = document.getElementById('expiration');
const snapshotUrlInput = document.getElementById('snapshot-url');
const copyBtn = document.getElementById('copy-btn');
const expiresText = document.getElementById('expires-text');
const newCaptureBtn = document.getElementById('new-capture-btn');
const retryBtn = document.getElementById('retry-btn');
const errorMessage = document.getElementById('error-message');
const historyToggle = document.getElementById('history-toggle');
const backBtn = document.getElementById('back-btn');
const clearHistoryBtn = document.getElementById('clear-history-btn');
const historyList = document.getElementById('history-list');

const STORAGE_KEY = 'snapshot_history';

function showView(view) {
  captureView.classList.toggle('hidden', view !== 'capture');
  successView.classList.toggle('hidden', view !== 'success');
  errorView.classList.toggle('hidden', view !== 'error');
  historyView.classList.toggle('hidden', view !== 'history');

  // Show/hide history button based on view
  historyToggle.style.display = view === 'history' ? 'none' : 'flex';
}

function setLoading(loading) {
  captureBtn.disabled = loading;
  captureBtn.classList.toggle('loading', loading);
}

async function getHistory() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] || [];
}

async function saveToHistory(item) {
  const history = await getHistory();
  history.unshift(item);
  // Keep only last 50 items
  if (history.length > 50) history.pop();
  await chrome.storage.local.set({ [STORAGE_KEY]: history });
}

async function clearHistory() {
  await chrome.storage.local.set({ [STORAGE_KEY]: [] });
  renderHistory([]);
}

function renderHistory(history) {
  if (history.length === 0) {
    historyList.innerHTML = '<p class="empty-history">No snapshots yet</p>';
    return;
  }

  historyList.innerHTML = history.map((item, index) => `
    <div class="history-item" data-index="${index}">
      <div class="history-item-title">${escapeHtml(item.title || 'Untitled')}</div>
      <div class="history-item-meta">
        <span>${formatDate(item.createdAt)}</span>
        <div class="history-item-actions">
          <button class="copy-btn-small" data-url="${escapeHtml(item.url)}">Copy</button>
          <button class="open-btn" data-url="${escapeHtml(item.url)}">Open</button>
        </div>
      </div>
    </div>
  `).join('');

  // Add event listeners
  historyList.querySelectorAll('.copy-btn-small').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await navigator.clipboard.writeText(btn.dataset.url);
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = 'Copy', 1500);
    });
  });

  historyList.querySelectorAll('.open-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      chrome.tabs.create({ url: btn.dataset.url });
    });
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatDate(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
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

    // Save to history
    await saveToHistory({
      url: response.url,
      title: tab.title,
      sourceUrl: tab.url,
      createdAt: new Date().toISOString(),
      expiresAt: response.expiresAt,
    });

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
    setTimeout(() => copyBtn.classList.remove('copied'), 2000);
  } catch (err) {
    snapshotUrlInput.select();
    document.execCommand('copy');
  }
}

// Event listeners
captureBtn.addEventListener('click', captureCurrentPage);
copyBtn.addEventListener('click', copyToClipboard);
newCaptureBtn.addEventListener('click', () => showView('capture'));
retryBtn.addEventListener('click', () => {
  showView('capture');
  captureCurrentPage();
});

historyToggle.addEventListener('click', async () => {
  const history = await getHistory();
  renderHistory(history);
  showView('history');
});

backBtn.addEventListener('click', () => showView('capture'));

clearHistoryBtn.addEventListener('click', async () => {
  if (confirm('Clear all history?')) {
    await clearHistory();
  }
});

// Initialize - make sure we start in capture view
showView('capture');
