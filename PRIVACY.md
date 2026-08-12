# 隐私政策

**Digest for Bilibili**（以下称「本扩展」）
生效日期：2026 年 8 月 13 日

本扩展没有服务器。开发者不接收、不存储、也无法访问你的任何数据。
下面把三类数据分别讲清楚：存在哪、什么时候离开浏览器、怎么删。

## 本扩展不收集的

不收集身份信息、不做用户画像、不埋点、不接入任何分析或广告 SDK，
不读取浏览历史，也不向开发者或任何第三方出售、转让数据。
本扩展不加载远程代码，所有逻辑都在安装包内。

## 存在你本机的数据

全部写入 `chrome.storage.local`，只保存在你这台设备上，不使用会同步到
Google 账号的 `chrome.storage.sync`。卸载扩展时由浏览器一并清除。

| 内容 | 存储键 | 保留期 |
| --- | --- | --- |
| 模型服务配置：服务商、API 地址、模型名、并发与超时、**API 密钥** | `bili_digest_settings` | 直到你修改或清空 |
| 字幕、翻译与 AI 概览的缓存 | `digest_<视频 BV 号>` | 30 天，且最多保留 20 个视频，超出按最早写入淘汰 |
| 你手动记下的笔记（时间戳、原句、整理后的文字、视频标题与链接） | `bili_digest_notes` | 直到你删除 |

**关于 API 密钥**：它属于身份验证信息，因此明确告知——密钥仅存于本地，
仅用于在你发起 AI 功能时向你自己指定的模型服务发起请求，除该服务外不发往任何地址。

## 离开浏览器的网络请求

本扩展只在两种情况下联网。

**一、B 站官方接口**（`api.bilibili.com`、`*.hdslb.com`）
用于获取视频信息与字幕文件。B 站的字幕（尤其是 AI 字幕）需要登录后才可见，
因此这些请求由浏览器按同源规则自动附带你已有的 B 站登录 Cookie，
与你在 bilibili.com 页面上的正常浏览行为一致。本扩展未申请 `cookies` 权限，
不读取、不保存、也不传输 Cookie 的内容。字幕文件本身的下载不携带 Cookie。

**二、你自己配置的 AI 服务**（地址由你在设置页填写）
使用顺句、翻译、概览、划词解释或笔记整理时，相应的字幕文本、你选中的文字
和视频标题会随请求发往该服务，并在请求头中携带你的 API 密钥。
这个地址完全由你决定，可以是 OpenAI、Anthropic、DeepSeek 等厂商，
也可以是你本机运行的 Ollama——填本机地址时数据不出设备。

本扩展在安装时只申请 B 站相关域名的权限。AI 服务的域名在安装时无法预知，
因此通过可选权限在你点击「保存并授权」时按域名单独申请，你可以随时在
Chrome 的扩展详情页收回。

这些第三方服务如何处理收到的数据，适用它们各自的隐私政策，不在本扩展控制范围内。
请在选择服务商前阅读对方的条款。

## 你的控制方式

- 删除单个视频的缓存或单条笔记：在侧边栏内直接操作
- 清空密钥：在设置页把 API 密钥字段留空并保存
- 收回 AI 服务的域名授权：Chrome → 扩展程序 → 本扩展 → 详情 → 网站访问权限
- 清除全部数据：卸载扩展

## 政策变更

若数据处理方式发生变化，会在更新前修改本文件并同步更新商店的数据披露。
本文件的历史修改可在 [GitHub 仓库](https://github.com/biuworks/bilibili-digest/commits/main/PRIVACY.md)
的提交记录中完整查看。

## 联系方式

问题与反馈请提交至 [GitHub Issues](https://github.com/biuworks/bilibili-digest/issues)。

---

## English Summary

**Digest for Bilibili** has no backend. The developer receives no data whatsoever.

- **No collection**: no personal identifiers, no analytics, no tracking, no ads, no
  browsing history, no sale or transfer of data to anyone. No remotely hosted code.
- **Stored locally only** (`chrome.storage.local`, never `storage.sync`): AI provider
  settings including your API key; transcript/overview cache (30-day TTL, 20-video LRU);
  and notes you create. All removed when you uninstall.
- **Leaves the browser in two cases**: (1) requests to Bilibili's own APIs to fetch video
  metadata and subtitles — the browser attaches your existing Bilibili login cookies
  because subtitles require sign-in; the extension holds no `cookies` permission and
  never reads or transmits cookie contents; (2) requests to the AI endpoint **you**
  configure, carrying transcript text, selected text, video title, and your API key in
  the request header. That endpoint may be a commercial provider or a local Ollama
  instance, in which case nothing leaves your machine.
- **Host permissions**: only Bilibili domains are requested at install time. The AI
  endpoint's domain is unknown at install time and is requested at runtime, per origin,
  via optional permissions, and can be revoked at any time from Chrome's extension page.

Third-party AI providers handle received data under their own privacy policies.
