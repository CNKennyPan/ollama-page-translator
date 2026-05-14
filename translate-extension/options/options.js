// ============================================================
// Ollama Page Translator — Options Page
// ============================================================

const ollamaHost = document.getElementById('ollamaHost');
const model = document.getElementById('model');
const timeout = document.getElementById('timeout');
const modelList = document.getElementById('modelList');
const defaultSourceLang = document.getElementById('defaultSourceLang');
const defaultTargetLang = document.getElementById('defaultTargetLang');
const detectModelsBtn = document.getElementById('detectModelsBtn');
const detectResult = document.getElementById('detectResult');
const saveBtn = document.getElementById('saveBtn');
const saveResult = document.getElementById('saveResult');

// --- Load current settings ---
document.addEventListener('DOMContentLoaded', async () => {
  const settings = await getSettings();
  ollamaHost.value = settings.ollamaHost || 'http://127.0.0.1:11434';
  model.value = settings.model || 'huihui_ai/hy-mt1.5-abliterated:1.8b';
  defaultSourceLang.value = settings.sourceLang || 'auto';
  defaultTargetLang.value = settings.targetLang || 'zh-CN';
  timeout.value = settings.timeout || 120;
});

// --- Detect models ---
detectModelsBtn.addEventListener('click', async () => {
  detectResult.textContent = '检测中...';
  detectResult.className = 'detect-result';

  const host = ollamaHost.value.trim() || 'http://127.0.0.1:11434';

  try {
    const resp = await fetch(`${host}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }

    const data = await resp.json();
    const models = (data.models || []).map(m => m.name);

    if (models.length === 0) {
      detectResult.textContent = 'Ollama 已连接，但没有找到模型';
      detectResult.className = 'detect-result';
      return;
    }

    // Update datalist
    modelList.innerHTML = models.map(name => `<option value="${name}">`).join('');
    detectResult.textContent = `找到 ${models.length} 个模型: ${models.join(', ')}`;
    detectResult.className = 'detect-result success';
  } catch (err) {
    detectResult.textContent = `连接失败: ${err.message}`;
    detectResult.className = 'detect-result error';
  }
});

// --- Save settings ---
saveBtn.addEventListener('click', async () => {
  saveResult.textContent = '保存中...';
  saveResult.className = 'save-result';

  const settings = {
    ollamaHost: ollamaHost.value.trim() || 'http://127.0.0.1:11434',
    model: model.value.trim() || 'huihui_ai/hy-mt1.5-abliterated:1.8b',
    sourceLang: defaultSourceLang.value,
    targetLang: defaultTargetLang.value,
    timeout: parseInt(timeout.value, 10) || 120,
  };

  try {
    await saveSettings(settings);
    saveResult.textContent = '✓ 已保存';
    saveResult.className = 'save-result success';
    setTimeout(() => { saveResult.textContent = ''; }, 3000);
  } catch (err) {
    saveResult.textContent = `保存失败: ${err.message}`;
    saveResult.className = 'save-result error';
  }
});

// --- Helpers ---

function getSettings() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'get-settings' }, resolve);
  });
}

function saveSettings(settings) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: 'save-settings', settings }, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(resp);
      }
    });
  });
}

// --- Translation Log Viewer ---

const refreshLogsBtn = document.getElementById('refreshLogsBtn');
const clearLogsBtn = document.getElementById('clearLogsBtn');
const logList = document.getElementById('logList');

function formatTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function renderLogs(logs) {
  if (!logs || logs.length === 0) {
    logList.innerHTML = '<p style="color:#6c757d;font-size:13px;">暂无翻译记录</p>';
    return;
  }

  // Show most recent first
  const reversed = [...logs].reverse();

  logList.innerHTML = reversed.map((entry) => {
    const time = formatTime(entry.timestamp);
    const errs = entry.errors && entry.errors.length > 0
      ? `<div style="color:#dc3545;font-size:12px;margin-top:4px;">⚠ ${entry.errors.map(e => escapeHtml(e)).join('; ')}</div>`
      : '';
    return `<div style="background:#f8f9fa;border:1px solid #e9ecef;border-radius:6px;padding:10px 12px;margin-bottom:8px;font-size:13px;line-height:1.5;">
      <div style="display:flex;justify-content:space-between;color:#6c757d;font-size:12px;margin-bottom:4px;">
        <span>${escapeHtml(entry.url || '?')}</span>
        <span>${time}</span>
      </div>
      <div>
        <strong>${escapeHtml(entry.sourceLang || '?')}</strong> → <strong>${escapeHtml(entry.targetLang || '?')}</strong>
        &nbsp;·&nbsp; ${entry.translatedCount ?? '?'}/${entry.totalNodes ?? '?'} 个文本
        ${errs}
      </div>
    </div>`;
  }).join('');
}

async function loadLogs() {
  logList.innerHTML = '<p style="color:#6c757d;font-size:13px;">加载中...</p>';
  try {
    const resp = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'get-translation-logs' }, resolve);
    });
    if (resp && resp.ok) {
      renderLogs(resp.logs);
    } else {
      logList.innerHTML = '<p style="color:#dc3545;font-size:13px;">获取日志失败</p>';
    }
  } catch (err) {
    logList.innerHTML = `<p style="color:#dc3545;font-size:13px;">${escapeHtml(err.message)}</p>`;
  }
}

refreshLogsBtn.addEventListener('click', loadLogs);

clearLogsBtn.addEventListener('click', async () => {
  if (!confirm('确定清空所有翻译日志？')) return;
  try {
    await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'clear-translation-logs' }, resolve);
    });
    renderLogs([]);
  } catch (err) {
    alert('清空失败: ' + err.message);
  }
});

// Auto-load logs when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  // Also load logs after a short delay (settings load first)
  setTimeout(loadLogs, 300);
});
