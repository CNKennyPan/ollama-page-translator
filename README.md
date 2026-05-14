# Ollama Page Translator

Translate web pages using your local [Ollama](https://ollama.com) models — **all data stays on your machine, never leaves your network**.

A Chrome extension (Manifest V3) that extracts page text, sends it to Ollama's `/api/chat`, and replaces the original text with translations in-place.

## Features

- **Full-page translation** — translates all visible text nodes; skips scripts, styles, SVGs, code blocks, and more
- **Right-click translation** — select any text, right-click → "用 Ollama 翻译选中文本"
- **Auto-translate for dynamic content** — `MutationObserver` watches for DOM changes (live news feeds, SPAs, infinite scroll) and translates new content automatically
- **Batch + deduplication** — texts grouped in chunks of 32; identical text on a page is translated once and applied everywhere (4-10x speedup)
- **In-memory cache** — per-page session cache avoids re-translating the same text
- **Restore original** — one-click restore of all translated text via `data-original` attributes
- **Translation logs** — records URL, time, language pair, node count, and errors for the last 200 translations; viewable in the options page
- **Configurable Ollama settings** — server address, model selection with auto-detect, API timeout (30-600s)
- **Retry on timeout** — failed chunks automatically retry once with a doubled timeout
- **Model warmup** — sends a tiny request before first translation to pre-load the model into memory
- **Progress indicator** — real-time progress bar in the popup during translation
- **Language swap** — quick swap source/target languages in the popup

## How it works

```
┌─────────────────────────────────────┐
│  Chrome Extension (Manifest V3)     │
│                                     │
│  Popup UI  ────┐                    │
│  Options Page ─┤                    │
│                ▼                    │
│  Background Service Worker          │
│   - Routes messages                 │
│   - Calls Ollama API                │
│   - Manages cache & logs            │
│                │                    │
│                ▼                    │
│  Content Script                     │
│   - Extracts DOM text nodes         │
│   - Applies translations in-place   │
│   - MutationObserver for live pages │
│                │                    │
└────────────────┼───────────────────┘
                 │ HTTP (localhost:11434)
                 ▼
          Ollama (local)
     /api/chat — any model
```

## Installation

### 1. Prerequisites

- **[Ollama](https://ollama.com/download)** — must be installed and running (`ollama serve`)
- **Chrome / Edge** — any Chromium-based browser (Manifest V3)
- **At least one model pulled** — see [Recommended models](#recommended-models) below

```bash
# Pull a translation model
ollama pull huihui_ai/hy-mt1.5-abliterated:1.8b

# Or a general-purpose model with good Chinese support
ollama pull qwen2.5:7b

# Verify Ollama is running
ollama list
```

### 2. Load the extension

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked**
4. Select the `translate-extension` directory

### 3. Configure

1. Click the extension icon in the toolbar, then click **设置**
2. Set your Ollama server address (default: `http://127.0.0.1:11434`)
3. Click **检测已安装模型** to auto-detect available models
4. Select your preferred model
5. Adjust timeout if needed (default: 120 seconds)
6. Click **保存设置**

## Usage

### Translate a page

1. Navigate to any page
2. Click the extension icon
3. Select source/target languages
4. Click **翻译页面**

### Restore original text

Click **还原原文** in the popup.

### Right-click translation

1. Select text on any page
2. Right-click → **用 Ollama 翻译选中文本**

## Options

| Setting | Description | Default |
|---------|-------------|---------|
| 服务地址 | Ollama server URL | `http://127.0.0.1:11434` |
| 模型名称 | Model to use for translation | `huihui_ai/hy-mt1.5-abliterated:1.8b` |
| API 超时 | Max wait per chunk (seconds) | `120` |
| 默认源语言 | Default source language | `auto` |
| 默认目标语言 | Default target language | `zh-CN` |

## Recommended model

| Model | Size | Notes |
|-------|------|-------|
| `huihui_ai/hy-mt1.5-abliterated:1.8b` | 1.8B | Dedicated translation model. Fast, good quality, default choice |

Pull it:

```bash
ollama pull huihui_ai/hy-mt1.5-abliterated:1.8b
```

The extension uses `/api/chat` with JSON output format (`temperature: 0.1`) for consistent structured translations.

## Project structure

```
translate-extension/
├── manifest.json              # Manifest V3
├── icons/                     # Extension icons (16, 48, 128)
├── popup/
│   ├── popup.html             # Popup UI
│   ├── popup.css
│   └── popup.js               # Language selection, translate/restore
├── options/
│   ├── options.html           # Settings page
│   ├── options.css
│   └── options.js             # Ollama config, log viewer
├── background/
│   └── service_worker.js      # Core: Ollama API, message routing, cache
└── content/
    └── content.js             # DOM text extraction, MutationObserver, translation application
```

## Privacy

- **All requests go to `localhost:11434`** — no data leaves your machine
- No data collection, no telemetry, no external requests
- Only permissions required: `storage`, `activeTab`, `contextMenus`, `scripting`
- Host permissions limited to `http://127.0.0.1:11434` and `http://localhost:11434`
- Fully open source

## Development

Pure vanilla JavaScript — no build tools, no frameworks. Debug using Chrome's extension inspector:

- `chrome://extensions` → service worker → **Inspect views**
- Right-click popup → **Inspect**
- Page console for content script logs

## License

MIT
