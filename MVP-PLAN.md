# MVP 实现计划

## 项目结构

```
translate-extension/
├── manifest.json              # Manifest V3
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── popup/
│   ├── popup.html
│   ├── popup.css
│   └── popup.js               # 语言选择、翻译/还原按钮
├── options/
│   ├── options.html
│   ├── options.css
│   └── options.js             # Ollama 地址、模型选择
├── background/
│   └── service_worker.js      # 核心：Ollama API 调用、消息路由、缓存
├── content/
│   └── content.js             # DOM 文本提取/替换、标记
└── _locales/
    ├── zh_CN/
    │   └── messages.json
    └── en/
        └── messages.json
```

## 实现顺序

### Step 1: manifest.json + 基础配置
- Manifest V3
- permissions: storage, activeTab, contextMenus
- host_permissions: http://127.0.0.1:11434/*
- background service worker
- content script (match <all_urls>)
- popup, options page

### Step 2: 图标资源
- 生成简单的 SVG/PNG 图标 (16, 48, 128)

### Step 3: Options 页面
- Ollama 地址输入 (默认 http://127.0.0.1:11434)
- 模型选择下拉 (可手动输入模型名)
- 保存设置到 chrome.storage.sync

### Step 4: Service Worker (核心)
- 监听消息:
  - `translate-page`: 接收文本节点数组，调用 Ollama 翻译
  - `restore-page`: 通知 content script 还原
- Ollama API 调用:
  - POST http://{host}/api/chat
  - System prompt 指定翻译指令 + JSON 输出格式
  - 串行请求，防止 Ollama OOM
- 页面级缓存 (Map<原文hash, 译文>)
- 错误处理 (Ollama 连接失败 → 返回错误消息)

### Step 5: Content Script
- 接收 `start-translate` 消息:
  1. 遍历 document.body 下所有文本节点
  2. 跳过 script/style/svg/code/pre 等
  3. 过滤短文本 (< 2字符)、纯数字、URL
  4. 按 chunk 分组（每批 N 个文本节点，防止 payload 过大）
  5. 发送每个 chunk 到 service worker
  6. 接收译文 → 逐节点替换 textContent
  7. 在替换节点上设置 data-translated="1" 和 data-original
- 接收 `restore` 消息:
  1. 查找所有 data-translated 节点
  2. 用 data-original 恢复
  3. 移除 data 属性
- 显示翻译进度（创建浮动进度条或更新 popup）

### Step 6: Popup
- 源语言下拉 + 目标语言下拉
- "翻译" 按钮 → 发送消息到当前 tab content script
- "还原" 按钮 → 发送还原消息
- 状态显示（准备/翻译中/完成/错误）
- 打开选项页面的链接

### Step 7: 右键菜单
- 选中文本后右键 → "用 Ollama 翻译"
- 选中文本 → 翻译 → 替换选中区域

## 关键 API 设计

### 消息协议

```typescript
// popup → service worker
{ action: "start-translate", tabId: number, sourceLang: string, targetLang: string }

// service worker → content script
{ action: "translate", chunks: string[][] }

// content script → service worker (for each chunk)
{ action: "translate-chunk", texts: string[], sourceLang: string, targetLang: string }

// service worker → content script (response for each chunk)
{ action: "translation-result", texts: string[], translations: string[] }

// content script → popup (progress)
{ action: "translation-progress", current: number, total: number }

// popup → content script
{ action: "restore" }
```

### Ollama Chat API 调用格式

```
POST http://127.0.0.1:11434/api/chat
{
  "model": "qwen2.5:7b",
  "messages": [
    {
      "role": "system",
      "content": "You are a translator. Translate the following texts from {sourceLang} to {targetLang}. Return ONLY a JSON array of translated strings in the same order. Example format: [\"translation1\", \"translation2\"]"
    },
    {
      "role": "user",
      "content": "[\"Hello world\", \"How are you?\"]"
    }
  ],
  "stream": false,
  "options": {
    "temperature": 0.1
  }
}
```

### Content Script 文本提取逻辑

```
function getTextNodes(root):
  遍历所有子节点
  如果是 TEXT_NODE + 非空 + 可见:
    收集到数组
  如果是 ELEMENT_NODE:
    跳过: script, style, svg, canvas, code, pre, [data-translated]
    否则递归 getTextNodes(child)
  返回 [{id, text, node}]
```

## 开发环境

- 纯原生 JS/HTML/CSS，无框架依赖
- 开发时 Chrome 加载未打包扩展
- 调试：chrome://extensions → 检查视图 (service worker / popup / content script)

## 测试清单

- [ ] 安装扩展后正常显示图标
- [ ] Options 页面可设置 Ollama 地址和模型
- [x] Options 页面可设置 API 超时
- [x] Options 页面可查看翻译日志
- [o] Ollama 运行时能正常翻译
- [ ] Ollama 未运行时显示友好错误
- [ ] 全文翻译后所有可见文本被替换
- [ ] script/code 等未被翻译
- [ ] 还原功能恢复全部原文
- [ ] 右键菜单翻译选中文本
- [x] 重复翻译时使用缓存，不重复请求
- [x] 页面导航后缓存清空（符合预期）
- [x] 弹窗显示翻译进度
- [x] 支持源语言/目标语言切换
- [ ] 懒加载内容重新翻译（再点击翻译按钮）
- [ ] Chunk 超时自动重试

## 已实现但未在原始计划中的增强功能

- 批处理 32 节点 + 去重（5a02e23）
- 翻译日志记录 + 持久化（chrome.storage.local）
- 可配置 API 超时
- Chunk 失败自动重试（带超时翻倍）
- 重译时先清除 data-translated 标记，支持懒加载内容
