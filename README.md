# Digest for Bilibili

把 B 站视频变成学习资源的浏览器扩展：在播放页旁边开一个侧边栏，
提供字幕阅读、双语对照、AI 概览、划词解释和带时间戳的笔记。

**B 站网页端的 [youtube-digest](https://github.com/zarazhangrui/youtube-digest) 复刻项目**，
架构蓝本与提示词起点来自上游仓库（MIT）。

---

<a id="store-install"></a>

## 🚀 安装（Chrome 与 Edge 商店）

v0.1.0 已通过两家浏览器商店审核并公开发布：

[![Chrome Web Store](https://img.shields.io/badge/Chrome_Web_Store-Digest_for_Bilibili-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/digest-for-bilibili/cfndfabkpfgihcgknbgfnkjlmndhhmfc)
[![Microsoft Edge Add-ons](https://img.shields.io/badge/Microsoft_Edge_Add--ons-Digest_for_Bilibili-0078D7?style=for-the-badge&logo=microsoftedge&logoColor=white)](https://microsoftedge.microsoft.com/addons/detail/digest-for-bilibili/jlfmjhkcbnkgghefieaagkcccjojmnkm)

| 商店 | 上线日期 | 安装链接 |
| --- | --- | --- |
| Chrome Web Store | 2026-08-15 | [安装 Digest for Bilibili](https://chromewebstore.google.com/detail/digest-for-bilibili/cfndfabkpfgihcgknbgfnkjlmndhhmfc) |
| Microsoft Edge Add-ons | 2026-08-17 | [安装 Digest for Bilibili](https://microsoftedge.microsoft.com/addons/detail/digest-for-bilibili/jlfmjhkcbnkgghefieaagkcccjojmnkm) |

点击对应商店的徽章或表格链接即可安装。商店搜索索引可能稍晚更新，直达链接可正常使用。

---

## 字幕

字幕直接取自 B 站官方接口，不经第三方服务。

- **三视图**：原文 / 译文 / 双语，翻译是双向的——中文字幕译成英文，外文字幕译成中文，方向按字幕轨语种自动选择
- **顺句**：B 站的 AI 字幕没有标点、同音错别字很多，开启后由 AI 补标点、改错别字，只做可读性修复，不改措辞和时间轴
- **跟随播放**：当前句高亮，点任意一句跳到对应时间点，跟丢了有「回到当前句」浮标
- 全文搜索（快捷键 `/`）、一键复制、导出 TXT

![字幕的双语对照视图](imgs/字幕.png)

## 概览

让 AI 通读整篇字幕，产出带时间戳的章节和金句——金句按时间戳挂在所属章节之下，
形成「章节 → 金句」的层次结构，点章节或金句即可跳转到视频对应位置。

长视频不是一次请求生成的：字幕先按分段边界切块，每块附带上一块的结尾作为上下文，
并发生成后合并去重。部分块失败也不会让整次生成作废，已完成的部分照常显示。

![概览的章节列表](imgs/概览.png)

## 划词解释

看到不懂的术语或概念，选中它点「解释」，AI 会结合前后文用大白话讲清楚。
解释浮层就贴在选中的那段文字旁边。

![划词解释的浮层](imgs/解释.png)

## 笔记

播放时点播放器上的「笔记」按钮或按 `n`，记下当前时间点。
AI 会把当时那句字幕整理成通顺的一句话，笔记卡片支持编辑、回放、复制和跳转链接。
笔记按视频与分 P 保存，可以只看当前分 P，也可以翻全部视频的历史笔记；超过 100 条后
也不会静默删除旧内容。

![笔记列表](imgs/笔记.png)

## 安装

商店安装见顶部 [🚀 安装](#store-install)。

Chrome 和 Edge 用的是同一份代码、同一个安装包，功能没有差别。
两者都需要 116 及以上的版本——这是侧边栏 API 的门槛。

本地加载：跑 `npm run package` 得到 `dist/` 下的 zip，解压后打开扩展管理页
（Chrome 是 `chrome://extensions`，Edge 是 `edge://extensions`），
开启开发者模式，点「加载已解压的扩展程序」选中解压出来的目录。

装好后会自动打开设置页。字幕阅读开箱即用，顺句、翻译、概览、划词解释
和笔记整理要先在那里填一个 AI 服务的地址和密钥。

商店审核材料（提交底稿）见 [STORE-LISTING.md](STORE-LISTING.md)。

## 许可与致谢

[MIT](LICENSE)。本项目源自 [youtube-digest](https://github.com/zarazhangrui/youtube-digest)
（MIT，Copyright (c) Zara Zhang），架构蓝本与部分提示词模板来自该仓库，
沿用相同协议并保留其署名——详见 LICENSE 与 `prompts/` 各文件头部的出处说明。
