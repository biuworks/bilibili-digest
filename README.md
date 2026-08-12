# Bilibili Digest

把 B 站视频变成学习资源：字幕阅读、双语对照、AI 概览（章节 / 金句）、划词解释、带时间戳笔记。

**B 站网页端的 [youtube-digest](https://github.com/zarazhangrui/youtube-digest) 复刻项目**。架构蓝本与提示词起点来自上游仓库（MIT）。

零依赖的 Chrome MV3 扩展：整个扩展只有原生 HTML/CSS/JS，没有构建步骤；
测试用 Node 自带的 `node:test`，克隆下来不用 `npm install` 就能跑。

## 状态

字幕阅读、双语对照、AI 概览、划词解释、时间戳笔记均可用，功能已对齐上游。

双语对照是**双向**的（上游只有英→中）：中文字幕译成英文，外文字幕译成中文，
方向按字幕轨语种自动选择，字幕区提供原文 / 译文 / 双语三视图。

另有一个上游没有的功能「字幕顺句」：B 站 AI 字幕不带任何标点且同音错别字很多，
开启后由 AI 补标点、改错别字，只做可读性修复，不改动措辞与时间轴。

**字幕功能不需要任何密钥**；顺句 / 概览 / 划词解释 / 笔记润色需要在设置页配置一个大模型服务。

## AI 服务

支持两种协议，地址与模型都可自定义：

- **OpenAI 兼容**——DeepSeek、OpenAI、Gemini（兼容端点）、Kimi、智谱、通义、
  SiliconFlow、OpenRouter，以及 Ollama / vLLM / LM Studio 等本地推理服务
- **Anthropic**——Claude

设置页预置了常见服务商的地址，但**不预置模型名**（模型换代太快，写死等于埋一个过期的默认值），
改用「拉取模型列表」直接问服务端要当前可用的模型。

密钥只存在本机的扩展存储里，只发往你自己填的那个地址。由于服务地址在安装时无法预知，
扩展不会在安装时索要网络权限——保存配置时才向 Chrome 申请访问你填的那一个域名。
明文 `http` 仅对 `localhost` / `127.0.0.1` 放行，以免密钥在网络上裸奔。

### 长视频

长视频的概览不是一次请求生成的——那样输出太长，很容易撞上超时，撞上就一无所获。
字幕会先按分段边界切块，每块单独生成章节与金句，再合并去重。顺句同样分批。
两者都并发执行并显示进度，并发数与单次超时可在设置页调整（默认 3 并发 / 120 秒）。

部分块失败不会让整次生成作废：已完成的部分照常显示，并注明结果不完整。

字幕直接取自 B 站官方接口，不经第三方服务：`x/web-interface/view` 拿 cid，
WBI 签名后调 `x/player/wbi/v2` 拿字幕轨，再下载字幕 JSON。B 站的 AI 字幕通常
需要登录后才可见，所以对 `api.bilibili.com` 的请求会带上浏览器 cookie。

## 开发

```bash
# 单元测试（Node 自带 node:test，无需安装任何依赖）
npm test
```

Chrome 扩展加载：`chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选择本目录。
装好后打开任意 B 站播放页，点工具栏里的 **Digest** 按钮（或点扩展图标）打开侧边栏。

> B 站的 AI 字幕通常需要登录后才可见；扩展跑在浏览器里，自动复用你已有的登录 cookie。

## 目录结构

```
manifest.json        # MV3 清单（B 站权限固定，AI 服务走可选权限运行时申请）
background.js        # service worker：字幕获取 / LLM 中转 / 笔记
lib/wbi.js           # WBI 签名（自带 MD5 + mixin_key 推导）
lib/bili-api.js      # B 站接口：BV→cid→字幕轨→字幕 JSON
lib/transcript.js    # 字幕归一化与语义分段
lib/cache.js         # digest_{bvid} 缓存：30 天过期 + 20 条 LRU
lib/ai.js            # 提示词模板解析、模型输出宽容解析与校验
lib/ai-provider.js   # 协议适配：OpenAI 兼容 / Anthropic 的请求构造与响应解析
lib/concurrency.js   # 并发池 + 串行队列（保护缓存的读—改—写）
content.js           # B 站播放页注入 Digest / 笔记 按钮，n 快捷键
sidepanel.*          # 侧边栏 UI（字幕 / 概览 / 笔记）
options.*            # 设置页（BYOK：协议 / 地址 / 密钥 / 模型 + 权限申请）
settings.js          # 共享配置
icons/               # 扩展图标：logo.svg 是源稿，PNG 由它光栅化后提交
prompts/             # LLM 提示词模板（源自上游，MIT）
tests/               # 单元与 DOM 集成测试（npm test，无需安装任何依赖）
references/          # （不入库）上游参考源码，需要时自行 git clone 到这里
```

## 定位与边界

本项目是**个人学习工具**：只读取 B 站**公开**的字幕数据，请求走用户自己浏览器的
登录态；不做批量抓取，不做视频下载，不做去广告。请在遵守 B 站服务条款的前提下使用。

## 隐私

- 不收集任何数据，没有自建服务器；代码里没有一处上报。
- AI 密钥只存在本机的 `chrome.storage.local`，只发往你自己填写的服务地址。
- 字幕请求直连 B 站官方接口；发给 AI 服务的内容仅限字幕文本与视频标题。

## 许可与致谢

[MIT](LICENSE)。本项目源自 [youtube-digest](https://github.com/zarazhangrui/youtube-digest)
（MIT，Copyright (c) Zara Zhang），架构蓝本与部分提示词模板来自该仓库，
沿用相同协议并保留其署名——详见 LICENSE 与 `prompts/` 各文件头部的出处说明。
