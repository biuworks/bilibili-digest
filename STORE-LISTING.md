# 商店说明

Chrome 应用商店与 Edge 加载项共用这一份，改动请两边同步。
这个文件不进安装包（`scripts/package.sh` 走白名单），只作为提交时的稿件来源。

## 发布状态

| 商店 | 版本 | 上线日期 | 链接 |
| --- | --- | --- | --- |
| Chrome Web Store | 0.2.0 | 2026-08-15（0.1.0）/ 2026-08-22（0.2.0） | https://chromewebstore.google.com/detail/digest-for-bilibili/cfndfabkpfgihcgknbgfnkjlmndhhmfc |
| Microsoft Edge Add-ons | 0.2.0 | 2026-08-17（0.1.0）/ 2026-08-22（0.2.0） | https://microsoftedge.microsoft.com/addons/detail/digest-for-bilibili/jlfmjhkcbnkgghefieaagkcccjojmnkm |

两个商店用**同一个 zip**。0.3.0 相对商店里的 0.2.0：修复了部分用户升级后扩展后台无响应、完全取不到字幕的缺陷；新增全部笔记搜索与 JSON 备份 / 恢复、完整学习稿导出、概览失败分块单独补生成、界面字号自定义。

### 0.4.0 变更摘要草稿（相对 0.3.0）

> 前提：若 0.3.0 审核被拒，0.4.0 的基线改回 0.2.0，两段摘要合并重写。

- 新增「问答」标签页：针对当前视频自由提问，AI 先在字幕里检索相关内容
  再回答；关键结论附带时间戳引用，点击跳回视频对应位置；引用必须能在
  字幕原文中找到，找不到依据时如实回答「未找到」，不编造。
- 字幕搜索与笔记搜索的命中关键词高亮显示。
- 本地存储升级为浏览器数据库（IndexedDB）：笔记、概览与字幕缓存不再受
  容量上限约束，升级时自动迁移，无需任何手动操作。
- 内部架构模块化重构（用户无感），为后续功能打地基。

注意措辞红线：不出现厂商名；IndexedDB 属「本地存储」范畴，
与 PRIVACY.md 的披露一致即可。

---

## 0.4.0 提交包

先把本仓库推到 GitHub，再点提交：商店里的隐私政策 URL 指向 GitHub 上的 `PRIVACY.md`，不能比安装包旧。

### 安装包

```text
dist/digest-for-bilibili-0.4.1.zip
```

Chrome 开发者后台与 Edge 合作伙伴中心上传同一份。若 0.3.0 审核被拒，本次提交的基线按上面「变更摘要草稿」的前提合并重写。

### 商店截图（1280×800）

Chrome 按这个顺序替换（第 3 张为本版新增的问答图）：

```text
store/screenshots/01-transcript.png
store/screenshots/02-overview.png
store/screenshots/03-qa.png
store/screenshots/04-explain.png
store/screenshots/05-notes-search.png
```

Edge 在上面五张之后追加第 6 张：

```text
store/screenshots/06-learning-export.png
```

「笔记 AI 优化」截图自本版起退出商店图集。Edge 扩展徽标仍用 `store/logo-300.png`，图标仍用 `icons/icon128.png`。

### 后台里要改 / 不用改

| 字段 | 操作 |
| --- | --- |
| 安装包 | 上传上面的 zip |
| 详细说明 | 整段替换为下面「详细说明」（已含问答功能与问题文本的隐私描述） |
| 截图 | Chrome 换前五张（新增问答图）；Edge 六张全部替换 |
| 名称、简短说明、类别、单一用途 | 不用改 |
| 权限理由 | 不用改（权限集合没变） |
| 数据披露 | 不用改（仍是 API 密钥 + 网站内容；IndexedDB 属本地存储范畴） |
| 隐私政策 URL | 不用改，但确认 GitHub 上已是最新 `PRIVACY.md` |
| 远程代码 | 仍选「否」 |
| 认证说明 | 不用填。前几个版本都未向审核员提供临时密钥，本次同样不提供 |

### 给审核员的变更摘要（可选，有「版本说明」栏再贴）

```text
0.4.0 新增视频问答与若干改进，Chrome 与 Edge 使用同一份 MV3 安装包。

- 新增「问答」标签页：针对当前视频提问，AI 先在字幕内检索相关内容再回答；
  关键结论附带可点击的时间戳引用；引用必须能在字幕原文中找到，
  找不到依据时如实回答「未找到」，不编造
- 字幕搜索与笔记搜索的命中关键词高亮显示
- 笔记、概览与字幕缓存改用浏览器内置数据库（IndexedDB）存储，
  不再受旧本地存储的容量上限约束；升级自动迁移，无需手动操作
- 内部模块化重构，用户界面与操作流程不变

权限、主机范围和数据类别与上一版本相同。
```

---

## 0.3.0 提交包

先把本仓库推到 GitHub，再点提交：商店里的隐私政策 URL 指向 GitHub 上的 `PRIVACY.md`，不能比安装包旧。

### 安装包

```text
dist/digest-for-bilibili-0.3.0.zip
```

Chrome 开发者后台与 Edge 合作伙伴中心都上传这一份。ZIP 顶层必须是 `manifest.json`。

### 商店截图（1280×800）

硬上限：Chrome 5 张、Edge 6 张。商店图只维护这 6 张，多一张传不上去。

Chrome 按这个顺序替换：

```text
store/screenshots/01-transcript.png
store/screenshots/02-overview.png
store/screenshots/03-explain.png
store/screenshots/04-notes-search.png
store/screenshots/05-learning-export.png
```

Edge 在上面五张之后追加第 6 张：

```text
store/screenshots/06-notes-refine.png
```

Edge 扩展徽标仍用 `store/logo-300.png`，图标仍用 `icons/icon128.png`。

### 后台里要改 / 不用改

| 字段 | 操作 |
| --- | --- |
| 安装包 | 上传上面的 zip |
| 详细说明 | 整段替换为下面「详细说明」 |
| 截图 | Chrome 换前五张；Edge 六张全部替换 |
| 名称、简短说明、类别、单一用途 | 不用改 |
| 权限理由 | 不用改（权限集合没变） |
| 数据披露 | 不用改（仍是 API 密钥 + 网站内容） |
| 隐私政策 URL | 不用改，但确认 GitHub 上已是最新 `PRIVACY.md` |
| 远程代码 | 仍选「否」 |
| 认证说明 | 不用填。前几个版本都未向审核员提供临时密钥，本次同样不提供 |

### Chrome 应用商店

1. 打开 [Chrome 开发者后台](https://chrome.google.com/webstore/devconsole) → Digest for Bilibili → 套件。
2. 上传 `dist/digest-for-bilibili-0.3.0.zip`。
3. 商店资讯：贴「详细说明」，截图按 01–05 顺序替换（Chrome 最多五张）。
4. 隐私：核对披露与远程代码选项未被动过。
5. 提交审核。可选「审核通过后再发布」，两边进度容易对齐。认证说明栏留空。

### Microsoft Edge 加载项

1. 打开 [Edge 合作伙伴中心](https://partner.microsoft.com/dashboard) → Digest for Bilibili。
2. 上传**同一份** zip。
3. 产品详情里替换详细说明；截图按 01–06 顺序替换（前五张与 Chrome 相同，第 6 张为笔记二次优化）；300×300 徽标不用动。
4. 隐私披露与 Chrome 相同。认证说明栏留空。
5. 提交审核。

### 给审核员的变更摘要（可选，有「版本说明」栏再贴）

```text
0.3.0 缺陷修复与功能更新，Chrome 与 Edge 使用同一份 MV3 安装包。

- 修复扩展后台在部分设备上无响应、导致完全取不到字幕的缺陷：后台不再于
  启动阶段发起异步存储读取，该操作会在 service worker 被回收时中断
- 笔记支持跨视频全文搜索，可按正文、视频标题或 UP 主名称检索
- 笔记与概览可导出为 JSON 备份并在其他设备恢复，备份不含 API 密钥
- 当前视频可导出为一份完整学习稿（字幕、概览、笔记）
- 章节概览中生成失败的分块可单独补生成，不必整份重来
- 设置页新增界面字号，可在 80% 至 160% 之间自定义

权限、主机范围和数据类别与 0.2.0 相同。
```

**不要在说明里罗列模型服务商的名字。** 0.1.0 首次提交时，「使用方法」里列了
DeepSeek、OpenAI、Anthropic、Gemini、Kimi、智谱、通义千问、硅基流动、OpenRouter
九个预设名，被 Chrome 应用商店判为「关键字垃圾内容」退回（政策禁止过多或不相关的
元数据）。连 OpenAI 和 Anthropic 这两个本来是协议名的也被点了名，所以别赌哪个算
技术术语——一个都不写。用户在这一步需要知道的只有「有预设、可自定义、本地模型也行」，
具体是哪几家，装完在设置页的下拉里一眼就看到。同理，截图和宣传图里也不要出现服务商 logo。

文案里凡是提到浏览器的地方都要用中性说法。「同步到 Google 账号」「Chrome 的扩展详情页」
这类写法对 Edge 用户是错的，而两个商店用的是同一份稿件。

---

## 详细说明

```text
Digest for Bilibili 在 B 站播放页旁边打开一个侧边栏，把当前视频的字幕变成可读、可搜索、可跳转的学习材料。

功能
• 字幕阅读 — 字幕取自 B 站官方接口，支持原文 / 译文 / 双语三种视图。当前句跟随播放高亮，点任意一句跳到视频对应时间点，支持全文搜索、一键复制和导出 TXT。
• 顺句 — B 站的 AI 字幕没有标点、同音错别字多。开启后由 AI 补标点、改错别字，只做可读性修复，不改措辞、不动时间轴。运行时显示批次进度，可随时停止。
• 双向翻译 — 中文字幕译成英文，外文字幕译成中文，方向按字幕轨语种自动选择。翻译过程同样可停止，已完成的句子继续保留。
• 章节概览 — AI 通读整篇字幕，产出带时间戳的章节和金句，点章节即可跳转到视频对应位置。长视频按分段边界切块并发生成，部分失败不影响已完成的部分。生成期间可停止，完成后可重新生成。
• 视频问答 — 针对当前视频自由提问，AI 先在字幕里检索相关内容再回答，关键结论附时间戳引用，点击跳回视频对应位置。引用必须出自字幕原文，字幕里没有依据时如实说明，不编造。长视频只送入检索命中的片段；生成中可随时停止，问答历史按视频保存，回答可一键复制。
• 划词解释 — 选中字幕里不懂的术语或概念，点「解释」，AI 结合前后文用大白话讲清楚，解释浮层就贴在选中的文字旁边。
• 时间戳笔记 — 播放时按 n 或点播放器上的「笔记」按钮记下当前时间点，AI 把当时那句字幕整理成通顺的一句话。笔记卡片支持编辑、回放、复制和跳转；手动改过正文后可让 AI 生成优化建议，预览后再选择保留、替换或追加。当前列表可导出为带时间戳链接的 Markdown，范围跟「本视频 / 全部」一致。

使用方法
1. 安装后打开扩展的设置页，填入你自己的模型服务地址与 API 密钥，点「保存并授权」。设置页备有常见服务的地址预设，选一个再填上密钥即可；也可以手动填写任意兼容接口的地址，本机运行的推理服务同样支持。
2. 打开任意 B 站视频页，点浏览器工具栏上的扩展图标打开侧边栏。
3. 侧边栏自动加载该视频的字幕。顶部在「字幕 / 概览 / 笔记 / 问答」四个标签间切换。

隐私
本扩展没有开发者运营的服务器。开发者不接收、不存储、也不访问用户数据。设置、字幕缓存和笔记全部保存在扩展的本地存储空间，仅留在用户当前设备上，不使用浏览器账号同步存储；卸载扩展时，这些本地数据会由浏览器一并清除。使用 AI 功能时，相关字幕文本、选中的文字、视频标题和你输入的问题会发送到用户在设置页指定的模型服务地址，数据仅用于完成用户主动发起的 AI 功能。扩展没有分析或广告 SDK，不记录浏览历史，也不加载远程代码。完整隐私政策：https://github.com/biuworks/bilibili-digest/blob/main/PRIVACY.md

权限说明
• 读取和更改 bilibili.com 上的数据 — 在播放页注入「笔记」按钮、识别当前视频编号，并从 B 站官方接口下载字幕文件。仅对视频播放页生效。
• 读取标签页地址 — 侧边栏独立于网页运行，需要知道你当前在看哪个视频，才能加载对应的字幕。
• 访问你指定的 AI 服务地址 — 安装时不申请。你在设置页点「保存并授权」时，才按你填写的那一个域名单独申请，可以随时在浏览器的扩展详情页收回。

说明
本扩展是个人开发的第三方工具，与 bilibili 官方没有关联，也未获其授权或背书。AI 功能使用用户自己的模型服务和 API 密钥，相关调用额度由用户选择的模型服务承担。字幕读取取决于 B 站是否为该视频提供字幕轨，部分 AI 字幕需要用户已登录 B 站。

反馈
Bug 与建议请提交到 https://github.com/biuworks/bilibili-digest/issues

版本 0.4.0 — 新增「问答」：针对当前视频提问，回答附可点击的时间戳引用，无依据时如实说明；搜索命中关键词高亮；本地存储升级为浏览器数据库，容量不再受限，升级自动迁移
版本 0.3.0 — 修复扩展后台无响应导致取不到字幕的缺陷；笔记支持跨视频搜索与 JSON 备份恢复；可导出完整学习稿；概览失败分块可单独补生成；界面字号可自定义
版本 0.2.0 — 侧边栏在同一窗口内保持打开；顺句、翻译、概览和笔记优化可停止；笔记可二次优化并导出 Markdown；笔记不再在 100 条时静默丢弃
版本 0.1.0 — 首次发布
```

## 简短说明

与 `manifest.json` 的 `description` 保持一致（商店对该字段有 132 字符硬上限）。

## 基本字段

**名称**

```text
Digest for Bilibili
```

- **类别**：生产力 / Productivity
- **主要语言**：中文（简体）
- **可见性**：公开
- **定价**：免费

**单一用途声明**

```text
Reads the subtitle track of the Bilibili video the user is currently watching and presents it in a side panel as a searchable, clickable transcript, together with AI-generated learning materials and timestamped notes derived from that transcript.
```

## 商店素材

| 素材 | 尺寸 | 文件 |
| --- | --- | --- |
| 商店图标 | 128×128 | `icons/icon128.png` |
| Edge 扩展徽标 | 300×300 | `store/logo-300.png` |
| 字幕截图 | 1280×800 | `store/screenshots/01-transcript.png` |
| 概览截图 | 1280×800 | `store/screenshots/02-overview.png` |
| 问答截图 | 1280×800 | `store/screenshots/03-qa.png` |
| 划词解释截图 | 1280×800 | `store/screenshots/04-explain.png` |
| 笔记搜索截图 | 1280×800 | `store/screenshots/05-notes-search.png` |
| 学习稿导出截图（Edge 追加） | 1280×800 | `store/screenshots/06-learning-export.png` |

界面变化后，先跑 `node scripts/capture-sidepanel.js` 重截 README 原图，再运行：

```bash
python3 scripts/make-store-screenshots.py
```

截图不得包含 API 密钥、账号昵称、头像等个人信息，也不要出现模型服务商 logo。

## 权限理由

以下英文可直接填入商店后台；改动 `manifest.json` 或存储策略时必须同步核对。

**`sidePanel`**

```text
The extension's interface lives in the browser side panel next to the video player, so the transcript remains visible while the video plays. Clicking the toolbar icon opens this panel.
```

**`storage`**

```text
Stores the user's AI service settings and API key, a local transcript and overview cache, and timestamped notes in extension-local storage. Browser account sync is not used, and the developer cannot access this data.
```

**`tabs`**

```text
The side panel needs the active tab URL to identify the current Bilibili video and load its matching subtitle track, and to react when the user navigates to another video. Only the current tab URL and title are used; browsing history is not collected or transmitted.
```

**主机权限**

```text
Install-time hosts are limited to Bilibili: www.bilibili.com is used by the content script on video pages, api.bilibili.com provides video metadata and subtitle-track information, and the hdslb.com CDN serves subtitle JSON files.

The optional hosts are for the AI endpoint selected by the user. The extension requests access to that single origin only when the user clicks Save and authorize. Loopback HTTP is accepted only for local model services; non-loopback HTTP addresses are rejected.
```

**远程代码**：选择“不使用远程代码”。所有 JavaScript 和提示词都随安装包分发；AI
接口只返回数据，不执行响应内容。

## 数据披露

按商店口径，数据离开设备即属于“收集”。虽然开发者没有服务器，以下两项仍要如实披露：

| 数据类型 | 是否传出设备 | 用途 |
| --- | --- | --- |
| 身份验证信息 | 是 | API Key 仅作为请求头发往用户自行配置的 AI 服务，用于认证 |
| 网站内容 | 是 | 用户主动使用 AI 功能时，相关字幕、选中文字和视频标题发往其自行配置的 AI 服务 |

其余个人身份、健康、财务、位置、通信、浏览记录和用户活动不收集。确认以下三项：

- 数据不出售给第三方。
- 数据不用于扩展核心功能之外的目的。
- 数据不用于信用或贷款判断。

**隐私政策 URL**

```text
https://github.com/biuworks/bilibili-digest/blob/main/PRIVACY.md
```

上传前用无痕窗口确认该链接可访问，并检查 `PRIVACY.md` 与后台披露一致。

## 发布前检查

- [ ] 已 `git push`，GitHub 上的 `PRIVACY.md` 与本次安装包一致。
- [ ] 更新 `manifest.json` 版本号和本文件的发布状态。
- [ ] `npm test` 全部通过。
- [ ] `npm run package` 得到 `dist/digest-for-bilibili-0.4.1.zip`。
- [ ] ZIP 顶层直接包含 `manifest.json`。
- [ ] ZIP 不包含测试、截图、README、隐私政策或本文件。
- [ ] 同一个解压包分别在 Chrome 与 Edge 中旁加载验证。
- [ ] 字幕、顺句、翻译、概览、解释和笔记流程正常。
- [ ] 顺句、翻译、概览、笔记优化可停止，取消不留半成品。
- [ ] 笔记二次优化先出预览，确认后才改写正文。
- [ ] 笔记导出 Markdown 与当前「本视频 / 全部」列表一致。
- [ ] Edge 切到另一个标签页时侧边栏仍在。
- [ ] 商店截图与当前界面一致且不含个人信息。
- [ ] 隐私政策 URL 可公开访问。
- [ ] 联系邮箱已验证。
- [ ] 每项权限理由均已填写。
- [ ] 数据披露与 `PRIVACY.md` 一致。
- [ ] 远程代码选择“否”。
- [ ] 升级路径真机验证：0.3.0 造好笔记 / 概览 / 字幕缓存后覆盖安装
      0.4.0，三类数据原样可用（IndexedDB 自动迁移，无需手动操作）。
- [ ] 问答：正常问题带可点击时间戳引用；无关问题如实回答未找到；
      生成中可停止；历史按视频与分 P 隔离。
- [ ] 长视频（30 分钟以上）问答：记录实际耗时与模型费用各一次，
      确认在预期内（设计预算：送入 ≤1.2 万字符，输出 ≤300 字）。
- [ ] Chrome 与 Edge 双端旁加载各过一遍以上流程。
- [ ] 认证说明栏留空，不向审核员提供临时密钥。
