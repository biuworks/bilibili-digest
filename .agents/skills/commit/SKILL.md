---
name: commit
description: 按本仓库的中文 Conventional Commits 规范创建 git 提交。只要用户要求提交、commit、把改动入库、或让你生成/润色提交信息，就使用本 skill；涵盖类型选择、中文主题行写法、body 规则、提交前检查，以及本仓库特有约定（不自动 push、钩子同步 live、release 流程）。
---

# 提交规范（中文 Conventional Commits）

本仓库历史提交风格不一（`0.4.2 发版：…`、`引号剥离改穷举码位集…`、中英 body 混排）。
统一为：**type 保留英文关键字（对 commitlint/changelog 等工具链友好），描述用中文**。

## 格式

```
<type>(<scope>): <主题行>

<body>
```

- `type` 必填，`scope` 可选（用中文模块名，如 `fix(问答):`）
- 主题行：中文动宾短语，≤ 50 字，结尾不加句号；中英文/数字之间留空格
- 主题行说清「改了什么」；「为什么」和影响面放 body

## type 一览

| type | 用途 | 本仓库实例 |
| --- | --- | --- |
| feat | 新功能 | `feat: 问答生成中支持点击停止取消` |
| fix | 缺陷修复 | `fix: 概览落库不再回滚并发写入的顺句结果` |
| docs | 文档 | `docs: 商店稿件补 0.4.2 变更摘要` |
| refactor | 重构（不改行为） | `refactor: 顺句批次规划抽为纯函数` |
| perf | 性能优化 | `perf: 笔记查询按索引替代全量过滤` |
| test | 测试 | `test: 补 noteContextAt 首句前用例` |
| chore | 构建/杂项 | `chore: 打包脚本支持版本号覆盖` |
| release | 发版（版本号变更） | `release: 0.4.2 发版，商店稿件同步更新` |
| revert | 回滚 | `revert: revert: 主题行` |
| style / ci | 纯格式 / CI 配置（本仓库少用） | |

`release:` 是本仓库扩展：凡动 `manifest.json` 版本号的提交都用它，且
manifest.json、package.json、STORE-LISTING.md 三处必须同步（契约测试看守）。

## body

- 默认不写；一处改动一句话讲得清就不要 body
- 要写就用 `- ` 短句列表，一行一个点，每行 ≤ 40 个中文字符
- 讲动机与影响面，不复述 diff。示例（真实提交）：

```
fix: 概览落库不再回滚并发写入的顺句结果

- updateCache 两处展开反转为快照只补缺：概览生成期间新顺的句子不再被旧快照覆盖
- noteContextAt 早于首句字幕时落第一行，不再错取视频结尾那句
- 各补一个针对性用例
```

## 流程

1. 先 `git status --short` 和 `git diff --stat` 看清改动，再决定 type 与拆分；
   一笔逻辑改动一个提交，不把无关文件混进来
2. 涉及运行时文件（manifest、background、lib/、prompts/、sidepanel 等）先
   `npm test`，全绿才提交
3. `git add` 写具体路径，不要 `-A` 盲加
4. 多行提交信息用 heredoc：`git commit -m "$(cat <<'EOF' … EOF)"`
5. 提交后向用户报 hash。**不自动 push**——用户明说推送才 `git push`

## 本仓库约定

- post-commit 钩子会在运行时文件入库后自动跑测试、打包并同步
  `~/ext-upgrade-test/live/`，提交输出里出现打包日志属正常，无需处理
- main 分支直接提交，不主动开分支
- `dist/`、`store/`、`.local-extension-test/` 不入库，不要 add 进来
