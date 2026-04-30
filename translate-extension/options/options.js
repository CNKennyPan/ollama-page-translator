// ============================================================
// Ollama Page Translator — Options Page
// ============================================================

const ollamaHost = document.getElementById('ollamaHost');
const model = document.getElementById('model');
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
