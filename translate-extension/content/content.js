// ============================================================
// Ollama Page Translator — Content Script
// ============================================================

(function () {

// Prevent double injection (manifest + dynamic injection)
if (window.__ollamaTranslatorLoaded) return;
window.__ollamaTranslatorLoaded = true;

// --- State ---
let isTranslating = false;
let totalNodes = 0;

// Translation log entry collector (sent to service worker on completion)
const pendingLog = { errors: [] };

// Auto-translate state (MutationObserver for dynamic content)
let autoTranslateLang = null;
let mutationObserver = null;
let autoTranslateDebounce = null;
let isAutoTranslating = false;
let warmupDone = false;

// --- Skip these elements entirely ---
const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO',
  'CODE', 'PRE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION',
  'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED',
]);

const CHUNK_SIZE = 32;

// --- Text node extraction ---

/**
 * Collect all translatable text nodes from the body.
 * Returns [{id, text, node}]
 */
function collectTextNodes() {
  const results = [];
  let id = 0;

  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) => {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;

        // Skip if parent is a tag we don't touch
        if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;

        // Skip if already translated
        if (parent.hasAttribute('data-translated')) return NodeFilter.FILTER_REJECT;

        // Skip invisible elements
        const style = window.getComputedStyle(parent);
        if (style.display === 'none' || style.visibility === 'hidden') {
          return NodeFilter.FILTER_REJECT;
        }

        const text = node.textContent.trim();
        // Skip empty, too short, or non-text content
        if (!text || text.length < 2) return NodeFilter.FILTER_REJECT;

        // Skip if only numbers, whitespace, punctuation
        if (/^[\d\s.,!?;:()\-—]+$/.test(text)) return NodeFilter.FILTER_REJECT;

        return NodeFilter.FILTER_ACCEPT;
      },
    }
  );

  let node;
  while ((node = walker.nextNode()) !== null) {
    results.push({ id: id++, text: node.textContent.trim(), node });
  }

  return results;
}

/**
 * Split array into chunks.
 */
function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * Send text chunk to background service worker and get translations.
 * Includes a timeout so the page doesn't hang forever.
 * On failure, retries once with a longer timeout.
 */
async function translateChunk(texts, sourceLang, targetLang, timeoutMs = 120000) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await _translateChunkOnce(texts, sourceLang, targetLang, timeoutMs * attempt);
    } catch (err) {
      if (attempt === 2) throw err; // both attempts failed
      console.warn(`[Ollama Translator] Retrying chunk after: ${err.message}`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

async function _translateChunkOnce(texts, sourceLang, targetLang, timeoutMs) {
  return new Promise((resolve, reject) => {
    // Service worker uses timeoutMs for the fetch AbortSignal.
    // We add 5s buffer so the service worker's fetch times out first
    // and returns a clean error, rather than us timing out and
    // leaving the fetch dangling.
    const safetyTimeout = timeoutMs + 5000;
    const timer = setTimeout(() => {
      reject(new Error(`翻译请求超时 (${timeoutMs/1000}秒)，请检查 Ollama 是否运行或增大超时设置`));
    }, safetyTimeout);

    chrome.runtime.sendMessage(
      {
        action: 'translate-chunk',
        texts,
        sourceLang,
        targetLang,
        timeoutMs,  // pass to service worker so fetch timeout matches
      },
      (response) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (!response || !response.ok) {
          reject(new Error((response && response.error) || '翻译请求失败'));
        } else {
          resolve(response.translations);
        }
      }
    );
  });
}

/**
 * Warm up the model by sending a tiny request to Ollama.
 * This ensures the model is loaded in memory before we start translating chunks.
 * Only runs once per page session.
 */
async function warmupModel() {
  if (warmupDone) return;
  warmupDone = true;
  try {
    await chrome.runtime.sendMessage({ action: 'warmup-model' });
  } catch (err) {
    // Non-fatal — translation may still succeed if model is already loaded
    console.warn('[Ollama Translator] Model warmup failed:', err.message);
  }
}

/**
 * Apply translations to text nodes.
 */
function applyTranslations(nodeList, translations) {
  let count = 0;
  for (let i = 0; i < nodeList.length && i < translations.length; i++) {
    const { node } = nodeList[i];
    const original = node.textContent.trim();
    const translated = (translations[i] || '').trim();

    if (!translated || translated === original) continue;

    const parent = node.parentElement;
    if (!parent) continue;

    // Save original text
    parent.setAttribute('data-original', parent.getAttribute('data-original') || original);
    parent.setAttribute('data-translated', '1');
    node.textContent = translated;
    count++;
  }
  return count;
}

/**
 * Main translation function.
 */
async function translatePage(sourceLang, targetLang) {
  if (isTranslating) return;
  isTranslating = true;

  // Reset log for this session
  pendingLog.errors = [];
  pendingLog.sourceLang = sourceLang;
  pendingLog.targetLang = targetLang;
  pendingLog.timestamp = Date.now();

  // Notify popup: starting
  chrome.runtime.sendMessage({
    action: 'translation-status',
    status: 'started',
  });

  try {
    // Strip all data-translated markers so lazy-loaded content under
    // previously marked parents can be collected on re-translate.
    document.querySelectorAll('[data-translated]').forEach((el) => {
      el.removeAttribute('data-translated');
    });

    // Warm up the model on first translation so model loading time
    // doesn't count against the first chunk's timeout.
    await warmupModel();

    // 1. Collect text nodes
    const allNodes = collectTextNodes();
    totalNodes = allNodes.length;
    pendingLog.totalNodes = totalNodes;

    if (totalNodes === 0) {
      chrome.runtime.sendMessage({
        action: 'translation-status',
        status: 'completed',
        total: 0,
        translated: 0,
      });
      isTranslating = false;
      return;
    }

    // 2. Deduplicate: group nodes by identical text to translate once
    const textToNodes = new Map();
    for (const item of allNodes) {
      if (!textToNodes.has(item.text)) textToNodes.set(item.text, []);
      textToNodes.get(item.text).push(item);
    }
    const uniqueTexts = Array.from(textToNodes.keys());
    const chunks = chunkArray(uniqueTexts, CHUNK_SIZE);
    let translatedCount = 0;

    // 3. Translate each chunk serially
    for (let i = 0; i < chunks.length; i++) {
      const chunkTexts = chunks[i];

      try {
        const translations = await translateChunk(chunkTexts, sourceLang, targetLang);

        // Apply to all nodes that share each original text
        for (let j = 0; j < chunkTexts.length && j < translations.length; j++) {
          const originalText = chunkTexts[j];
          const translated = (translations[j] || '').trim();
          if (!translated || translated === originalText) continue;

          const nodes = textToNodes.get(originalText);
          for (const { node } of nodes) {
            const parent = node.parentElement;
            if (!parent) continue;
            parent.setAttribute('data-original', parent.getAttribute('data-original') || originalText);
            parent.setAttribute('data-translated', '1');
            node.textContent = translated;
            translatedCount++;
          }
        }
      } catch (err) {
        console.warn(`[Ollama Translator] Chunk ${i + 1}/${chunks.length} failed:`, err.message);
        pendingLog.errors.push(`Chunk ${i + 1}: ${err.message}`);
        // Continue with remaining chunks
      }

      // Report progress (scaled by total nodes for user perception)
      const processed = Math.min(((i + 1) / chunks.length) * totalNodes, totalNodes);
      chrome.runtime.sendMessage({
        action: 'translation-progress',
        current: Math.round(processed),
        total: totalNodes,
      });
    }

    // 4. Done — send translation log to service worker
    pendingLog.translatedCount = translatedCount;
    pendingLog.url = window.location.href;

    chrome.runtime.sendMessage({
      action: 'save-translation-log',
      log: { ...pendingLog },
    });

    chrome.runtime.sendMessage({
      action: 'translation-status',
      status: 'completed',
      total: totalNodes,
      translated: translatedCount,
    });

    // Set up MutationObserver to auto-translate dynamically added content
    setupAutoTranslate(sourceLang, targetLang);
  } catch (err) {
    pendingLog.errors.push(err.message);
    chrome.runtime.sendMessage({
      action: 'translation-status',
      status: 'error',
      error: err.message,
    });
  }

  isTranslating = false;
}

/**
 * Restore all translated nodes to original text.
 */
function restorePage() {
  const nodes = document.querySelectorAll('[data-translated]');
  let count = 0;

  nodes.forEach((el) => {
    const original = el.getAttribute('data-original');
    if (original) {
      el.textContent = original;
    }
    el.removeAttribute('data-translated');
    el.removeAttribute('data-original');
    count++;
  });

  return count;
}

// --- MutationObserver for dynamic content ---

/**
 * Set up MutationObserver to auto-translate dynamically added content
 * (e.g. live news feeds, infinite scroll, SPAs).
 */
function setupAutoTranslate(sourceLang, targetLang) {
  autoTranslateLang = { sourceLang, targetLang };

  if (mutationObserver) mutationObserver.disconnect();

  mutationObserver = new MutationObserver((mutations) => {
    const addedElements = [];
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.hasAttribute('data-translated')) continue;
          if (SKIP_TAGS.has(node.tagName)) continue;
          if (node.textContent.trim().length >= 2) {
            addedElements.push(node);
          }
        }
      }
    }

    if (addedElements.length === 0) return;

    clearTimeout(autoTranslateDebounce);
    autoTranslateDebounce = setTimeout(() => {
      translateNewNodes(addedElements);
    }, 1500);
  });

  mutationObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

/**
 * Stop MutationObserver (called on restore or manual disable).
 */
function stopAutoTranslate() {
  if (mutationObserver) {
    mutationObserver.disconnect();
    mutationObserver = null;
  }
  autoTranslateLang = null;
  clearTimeout(autoTranslateDebounce);
}

/**
 * Translate text nodes within newly added DOM elements.
 */
async function translateNewNodes(roots) {
  if (!autoTranslateLang || isAutoTranslating) return;
  isAutoTranslating = true;

  try {
    // Collect translatable text nodes from all new root elements
    const allNodes = [];
    let id = 0;

    for (const root of roots) {
      const walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: (node) => {
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
            if (parent.hasAttribute('data-translated')) return NodeFilter.FILTER_REJECT;
            const text = node.textContent.trim();
            if (!text || text.length < 2) return NodeFilter.FILTER_REJECT;
            if (/^[\d\s.,!?;:()\-—]+$/.test(text)) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          },
        }
      );

      let node;
      while ((node = walker.nextNode()) !== null) {
        allNodes.push({ id: id++, text: node.textContent.trim(), node });
      }
    }

    if (allNodes.length === 0) return;

    // Dedup
    const textToNodes = new Map();
    for (const item of allNodes) {
      if (!textToNodes.has(item.text)) textToNodes.set(item.text, []);
      textToNodes.get(item.text).push(item);
    }
    const uniqueTexts = Array.from(textToNodes.keys());
    const chunks = chunkArray(uniqueTexts, CHUNK_SIZE);

    for (let i = 0; i < chunks.length; i++) {
      const chunkTexts = chunks[i];
      try {
        const translations = await translateChunk(
          chunkTexts,
          autoTranslateLang.sourceLang,
          autoTranslateLang.targetLang,
        );

        for (let j = 0; j < chunkTexts.length && j < translations.length; j++) {
          const originalText = chunkTexts[j];
          const translated = (translations[j] || '').trim();
          if (!translated || translated === originalText) continue;

          const nodes = textToNodes.get(originalText);
          for (const { node } of nodes) {
            const parent = node.parentElement;
            if (!parent) continue;
            if (parent.hasAttribute('data-translated')) continue;
            parent.setAttribute('data-original', parent.getAttribute('data-original') || originalText);
            parent.setAttribute('data-translated', '1');
            node.textContent = translated;
          }
        }
      } catch (err) {
        console.warn('[Ollama Translator] Auto-translate chunk failed:', err.message);
      }
    }
  } finally {
    isAutoTranslating = false;
  }
}

// --- Message listener ---
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  switch (request.action) {
    case 'translate':
      translatePage(request.sourceLang, request.targetLang)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true; // async response

    case 'restore':
      stopAutoTranslate();
      const count = restorePage();
      sendResponse({ ok: true, count });
      return false;

    case 'replace-selection':
      replaceSelection(request.translation);
      sendResponse({ ok: true });
      return false;

    case 'show-error':
      showErrorToast(request.message);
      sendResponse({ ok: true });
      return false;

    case 'disable-auto-translate':
      stopAutoTranslate();
      sendResponse({ ok: true });
      return false;
  }
});

/**
 * Replace the current text selection with translated text.
 */
function replaceSelection(translation) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;

  const range = sel.getRangeAt(0);
  const parent = range.commonAncestorContainer;

  // Save original in parent
  if (parent.nodeType === Node.TEXT_NODE) {
    const p = parent.parentElement;
    if (p) {
      p.setAttribute('data-original', p.getAttribute('data-original') || parent.textContent);
      p.setAttribute('data-translated', '1');
    }
  }

  range.deleteContents();
  range.insertNode(document.createTextNode(translation));
  sel.removeAllRanges();
}

/**
 * Show a simple error toast on the page.
 */
function showErrorToast(message) {
  const existing = document.getElementById('ollama-translator-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'ollama-translator-toast';
  toast.textContent = message;
  Object.assign(toast.style, {
    position: 'fixed',
    bottom: '24px',
    right: '24px',
    background: '#e74c3c',
    color: '#fff',
    padding: '12px 20px',
    borderRadius: '8px',
    fontSize: '14px',
    zIndex: '2147483647',
    boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
    maxWidth: '400px',
    lineHeight: '1.4',
  });

  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}

})();
