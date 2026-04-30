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

// --- Skip these elements entirely ---
const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO',
  'CODE', 'PRE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION',
  'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED',
]);

const CHUNK_SIZE = 8;

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
 */
async function translateChunk(texts, sourceLang, targetLang, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('翻译请求超时，请检查 Ollama 是否运行'));
    }, timeoutMs);

    chrome.runtime.sendMessage(
      {
        action: 'translate-chunk',
        texts,
        sourceLang,
        targetLang,
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

  // Notify popup: starting
  chrome.runtime.sendMessage({
    action: 'translation-status',
    status: 'started',
  });

  try {
    // 1. Collect text nodes
    const allNodes = collectTextNodes();
    totalNodes = allNodes.length;

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

    // 2. Split into chunks
    const chunks = chunkArray(allNodes, CHUNK_SIZE);
    let translatedCount = 0;

    // 3. Translate each chunk serially
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const texts = chunk.map(n => n.text);

      try {
        const translations = await translateChunk(texts, sourceLang, targetLang);
        const applied = applyTranslations(chunk, translations);
        translatedCount += applied;
      } catch (err) {
        console.warn(`[Ollama Translator] Chunk ${i + 1}/${chunks.length} failed:`, err.message);
        // Continue with remaining chunks
      }

      // Report progress
      const processed = Math.min((i + 1) * CHUNK_SIZE, totalNodes);
      chrome.runtime.sendMessage({
        action: 'translation-progress',
        current: processed,
        total: totalNodes,
      });
    }

    // 4. Done
    chrome.runtime.sendMessage({
      action: 'translation-status',
      status: 'completed',
      total: totalNodes,
      translated: translatedCount,
    });
  } catch (err) {
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

// --- Message listener ---
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  switch (request.action) {
    case 'translate':
      translatePage(request.sourceLang, request.targetLang)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true; // async response

    case 'restore':
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
