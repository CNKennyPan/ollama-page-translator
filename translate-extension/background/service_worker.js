// ============================================================
// Ollama Page Translator — Background Service Worker
// ============================================================

// --- Cache (per page session) ---
const translationCache = new Map();

// --- Translation logs (session + persisted) ---
const MAX_LOGS = 200;
let translationLogs = [];

async function loadLogs() {
  try {
    const result = await chrome.storage.local.get('translationLogs');
    if (result.translationLogs) translationLogs = result.translationLogs.slice(-MAX_LOGS);
  } catch { /* first run */ }
}

async function saveLogs() {
  try {
    // Keep only the most recent MAX_LOGS
    const trimmed = translationLogs.slice(-MAX_LOGS);
    await chrome.storage.local.set({ translationLogs: trimmed });
    translationLogs = trimmed;
  } catch { /* storage may be full — silently trim */ }
}

function addLogEntry(entry) {
  translationLogs.push({
    ...entry,
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
  });
  saveLogs();
}

// Load logs on startup
loadLogs();

// --- Default settings ---
const DEFAULT_SETTINGS = {
  ollamaHost: 'http://127.0.0.1:11434',
  model: 'huihui_ai/hy-mt1.5-abliterated:1.8b',
  sourceLang: 'auto',
  targetLang: 'zh-CN',
  timeout: 120,
};

// --- Settings access ---
async function getSettings() {
  const result = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...result };
}

// --- Context menu ---
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'translate-selection',
    title: '用 Ollama 翻译选中文本',
    contexts: ['selection'],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'translate-selection' && info.selectionText) {
    const settings = await getSettings();
    try {
      const timeoutMs = (settings.timeout || 120) * 1000;
      const translations = await callOllama(
        settings.ollamaHost,
        settings.model,
        [info.selectionText],
        settings.sourceLang,
        settings.targetLang,
        timeoutMs
      );
      if (translations && translations[0]) {
        await chrome.tabs.sendMessage(tab.id, {
          action: 'replace-selection',
          translation: translations[0],
        });
      }
    } catch (err) {
      await chrome.tabs.sendMessage(tab.id, {
        action: 'show-error',
        message: `翻译失败: ${err.message}`,
      });
    }
  }
});

// --- Ollama API call ---

/**
 * Call Ollama /api/chat to translate an array of texts.
 * Returns a string array of translations in the same order.
 */
async function callOllama(host, model, texts, sourceLang, targetLang, timeoutMs) {
  const sourceText = sourceLang === 'auto' ? 'auto-detected source language' : sourceLang;
  const langPair = `${sourceText} to ${targetLang}`;

  const systemPrompt = `You are a professional translator. Translate the following texts from ${langPair}.
Return ONLY a valid JSON array of translated strings in the same order as the input.
Each element must be the translation of the corresponding input text.

Rules:
- Preserve the original meaning and tone
- Keep numbers, URLs, email addresses, and code snippets unchanged
- Do not add any explanation, notes, or formatting outside the JSON array
- The response must be parseable JSON

Example input: ["Hello", "How are you?"]
Example output: ["你好", "你好吗？"]`;

  const response = await fetch(`${host}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: JSON.stringify(texts) },
      ],
      stream: false,
      options: { temperature: 0.1 },
      format: {
        type: 'array',
        items: { type: 'string' },
      },
    }),
    signal: AbortSignal.timeout(timeoutMs || 120000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ollama HTTP ${response.status}: ${text.slice(0, 200)}`);
  }

  const data = await response.json();
  const content = (data.message && data.message.content) || '';

  // Strip markdown code fences if present
  const cleaned = content.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();

  let translations;
  try {
    translations = JSON.parse(cleaned);
  } catch {
    // Try to extract JSON array from the response
    const match = cleaned.match(/\[[\s\S]*?\]/);
    if (match) {
      try {
        translations = JSON.parse(match[0]);
      } catch {
        throw new Error(`Ollama 返回了无效的 JSON:\n${content.slice(0, 300)}`);
      }
    } else {
      throw new Error(`Ollama 返回了无效的 JSON:\n${content.slice(0, 300)}`);
    }
  }

  if (!Array.isArray(translations)) {
    throw new Error(`Ollama 返回的不是数组:\n${content.slice(0, 300)}`);
  }

  return translations;
}

// --- Single message router ---
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // --- Ensure content script is injected ---
  if (request.action === 'ensure-content-script') {
    chrome.tabs.get(request.tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        sendResponse({ ok: false, error: 'Tab not found' });
        return;
      }
      chrome.scripting.executeScript({
        target: { tabId: request.tabId },
        files: ['content/content.js'],
      }).then(() => {
        sendResponse({ ok: true });
      }).catch(() => {
        // File may already be injected – treat as success
        sendResponse({ ok: true });
      });
    });
    return true;
  }

  // --- Ping check (service worker alive) ---
  if (request.action === 'ping') {
    sendResponse({ ok: true });
    return false;
  }

  // --- Get settings ---
  if (request.action === 'get-settings') {
    getSettings().then(sendResponse);
    return true;
  }

  // --- Save settings ---
  if (request.action === 'save-settings') {
    chrome.storage.sync.set(request.settings).then(() => sendResponse({ ok: true }));
    return true;
  }

  // --- Check Ollama connection ---
  if (request.action === 'check-connection') {
    (async () => {
      try {
        const settings = await getSettings();
        const host = request.host || settings.ollamaHost;
        const resp = await fetch(`${host}/api/tags`, {
          signal: AbortSignal.timeout(5000),
        });
        if (resp.ok) {
          const data = await resp.json();
          sendResponse({ ok: true, models: (data.models || []).map(m => m.name) });
        } else {
          sendResponse({ ok: false, error: `HTTP ${resp.status}` });
        }
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  // --- Warm up model (load into memory before translation) ---
  if (request.action === 'warmup-model') {
    (async () => {
      try {
        const settings = await getSettings();
        const resp = await fetch(`${settings.ollamaHost}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: settings.model,
            messages: [{ role: 'user', content: 'test' }],
            stream: false,
            options: { temperature: 0.1 },
          }),
          signal: AbortSignal.timeout(120000),
        });
        if (resp.ok) {
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: `HTTP ${resp.status}` });
        }
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  // --- Translate a chunk of texts ---
  if (request.action === 'translate-chunk') {
    const { texts, sourceLang, targetLang, timeoutMs: requestTimeout } = request;

    (async () => {
      // Check cache first
      const uncached = [];
      const results = [];

      for (const text of texts) {
        const key = `${text}|${sourceLang}|${targetLang}`;
        if (translationCache.has(key)) {
          results.push(translationCache.get(key));
        } else {
          results.push(null);
          uncached.push({ text, index: results.length - 1 });
        }
      }

      if (uncached.length === 0) {
        sendResponse({ ok: true, translations: results });
        return;
      }

      // Call Ollama with uncached texts
      try {
        const settings = await getSettings();
        const uncachedTexts = uncached.map(u => u.text);
        // Use timeout from the request (passed by content script) if provided,
        // otherwise fall back to settings. This ensures retry with longer
        // timeout actually uses the longer timeout on the fetch side too.
        const timeoutMs = requestTimeout || (settings.timeout || 120) * 1000;
        const translations = await callOllama(
          settings.ollamaHost,
          request.model || settings.model,
          uncachedTexts,
          sourceLang,
          targetLang,
          timeoutMs
        );

        // Fill results and cache
        for (let i = 0; i < uncached.length; i++) {
          const idx = uncached[i].index;
          const trans = translations[i] || uncached[i].text;
          results[idx] = trans;
          const key = `${uncached[i].text}|${sourceLang}|${targetLang}`;
          translationCache.set(key, trans);
        }

        sendResponse({ ok: true, translations: results });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();

    return true; // keep channel open
  }

  // --- Save translation log ---
  if (request.action === 'save-translation-log') {
    addLogEntry(request.log);
    sendResponse({ ok: true });
    return false;
  }

  // --- Get translation logs ---
  if (request.action === 'get-translation-logs') {
    sendResponse({ ok: true, logs: translationLogs });
    return false;
  }

  // --- Clear translation logs ---
  if (request.action === 'clear-translation-logs') {
    translationLogs = [];
    chrome.storage.local.remove('translationLogs');
    sendResponse({ ok: true });
    return false;
  }
});
