// ============================================================
// Ollama Page Translator — Popup
// ============================================================

const translateBtn = document.getElementById('translateBtn');
const restoreBtn = document.getElementById('restoreBtn');
const swapBtn = document.getElementById('swapLang');
const sourceLang = document.getElementById('sourceLang');
const targetLang = document.getElementById('targetLang');
const progressArea = document.getElementById('progressArea');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const statusArea = document.getElementById('statusArea');
const statusText = document.getElementById('statusText');
const modelDisplay = document.getElementById('modelDisplay');
const openOptions = document.getElementById('openOptions');

let currentTabId = null;

// --- Init ---
document.addEventListener('DOMContentLoaded', async () => {
  // Load settings
  const settings = await getSettings();
  sourceLang.value = settings.sourceLang || 'auto';
  targetLang.value = settings.targetLang || 'zh-CN';
  modelDisplay.textContent = `模型: ${settings.model || '未设置'}`;

  // Get current tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) currentTabId = tab.id;

  // Try to ping content script to see if it's ready
  try {
    await sendMessageToTab({ action: 'ping' });
  } catch {
    // Content script may not be injected yet — that's ok
  }
});

// --- Translate ---
translateBtn.addEventListener('click', async () => {
  if (!currentTabId) return;

  hideStatus();
  hideProgress();
  translateBtn.disabled = true;
  restoreBtn.disabled = true;

  showProgress('正在准备...', 0);

  // First save current language settings
  await saveSettings({
    sourceLang: sourceLang.value,
    targetLang: targetLang.value,
  });

  // Send translate command to content script
  try {
    await sendMessageToTab({
      action: 'translate',
      sourceLang: sourceLang.value,
      targetLang: targetLang.value,
    });
    // Status/progress handled by onMessage listener
  } catch (err) {
    hideProgress();
    showStatus(`错误: ${err.message}`, 'error');
    translateBtn.disabled = false;
    restoreBtn.disabled = false;
  }
});

// --- Restore ---
restoreBtn.addEventListener('click', async () => {
  if (!currentTabId) return;

  hideStatus();
  restoreBtn.disabled = true;

  try {
    const resp = await sendMessageToTab({ action: 'restore' });
    restoreBtn.disabled = false;
    if (resp && resp.ok) {
      showStatus(`已还原 ${resp.count} 个元素`, 'info');
    }
  } catch (err) {
    showStatus(`还原失败: ${err.message}`, 'error');
    restoreBtn.disabled = false;
  }
});

// --- Swap languages ---
swapBtn.addEventListener('click', () => {
  const temp = sourceLang.value;
  sourceLang.value = targetLang.value;
  targetLang.value = temp;
});

// --- Open options ---
openOptions.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// --- Listen for progress/status from content script ---
chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'translation-progress') {
    const pct = Math.round((request.current / request.total) * 100);
    showProgress(`翻译中: ${request.current}/${request.total}`, pct);
  }

  if (request.action === 'translation-status') {
    if (request.status === 'started') {
      showProgress('开始翻译...', 0);
    } else if (request.status === 'completed') {
      hideProgress();
      showStatus(`翻译完成: ${request.translated || 0}/${request.total || 0} 个文本`, 'success');
      restoreBtn.disabled = false;
      translateBtn.disabled = false;
    } else if (request.status === 'error') {
      hideProgress();
      showStatus(`翻译出错: ${request.error}`, 'error');
      translateBtn.disabled = false;
    }
  }
});

// --- Helpers ---

function showProgress(text, pct) {
  progressArea.classList.remove('hidden');
  progressText.textContent = text;
  progressFill.style.width = `${Math.min(pct, 100)}%`;
}

function hideProgress() {
  progressArea.classList.add('hidden');
  progressFill.style.width = '0%';
}

function showStatus(text, type) {
  statusArea.classList.remove('hidden', 'success', 'error', 'info');
  statusArea.classList.add(type);
  statusText.textContent = text;

  // Auto-hide after 5s
  clearTimeout(window._statusTimer);
  window._statusTimer = setTimeout(() => hideStatus(), 5000);
}

function hideStatus() {
  statusArea.classList.add('hidden');
}

async function getSettings() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'get-settings' }, resolve);
  });
}

function saveSettings(settings) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'save-settings', settings }, resolve);
  });
}

async function ensureContentScript(tabId) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { action: 'ensure-content-script', tabId },
      (resp) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (resp && resp.ok) {
          resolve();
        } else {
          reject(new Error((resp && resp.error) || '注入 content script 失败'));
        }
      }
    );
  });
}

async function sendMessageToTab(msg, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!currentTabId) {
      reject(new Error('没有活动的标签页'));
      return;
    }

    const timer = setTimeout(() => {
      reject(new Error('请求超时，检查 Ollama 是否运行'));
    }, timeoutMs);

    chrome.tabs.sendMessage(currentTabId, msg, async (resp) => {
      if (chrome.runtime.lastError) {
        clearTimeout(timer);
        // Content script not injected — inject and retry once
        try {
          await ensureContentScript(currentTabId);
          await new Promise(r => setTimeout(r, 150));
          chrome.tabs.sendMessage(currentTabId, msg, (resp2) => {
            clearTimeout(timer);
            if (chrome.runtime.lastError) {
              reject(new Error('无法连接到页面，请刷新后重试'));
            } else {
              resolve(resp2);
            }
          });
        } catch (injectErr) {
          clearTimeout(timer);
          reject(new Error(`注入 content script 失败: ${injectErr.message}`));
        }
      } else {
        clearTimeout(timer);
        resolve(resp);
      }
    });
  });
}
