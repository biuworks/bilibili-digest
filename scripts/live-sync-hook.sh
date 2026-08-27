#!/usr/bin/env bash
# git post-commit 钩子（源文件，安装见 scripts/install-live-hook.sh）。
#
# 作用：提交里动了扩展运行时文件时，自动把新构建同步到升级测试目录的 live/，
# 避免「代码改了、live 还是旧版、在浏览器里试了半天试不出新功能」。
#
# 设计取舍：
# - 只在「上一个提交改了运行时文件」时才触发。改 README / 截图 / 商店材料时
#   不重打包，提交不发慢，live 也不需要反复换。
# - 检测清单用运行时文件的前缀（manifest / background / 页面脚本 / lib 等），
#   与 scripts/package.sh 的白名单语义一致；package.sh 改清单时这里不用动。
# - live 目录不存在则静默跳过（其他开发机上没有升级测试目录很正常）。
set -euo pipefail

REPO="$(git rev-parse --show-toplevel)"

if [ ! -d "$HOME/ext-upgrade-test/live" ]; then
  exit 0
fi

changed="$(git diff-tree --no-commit-id --name-only -r HEAD 2>/dev/null || true)"
runtime="$(printf '%s\n' "$changed" | grep -E \
  '^(manifest\.json|package\.json|background\.js|content\.js|settings\.js|options\.(html|js|css)|sidepanel\.(html|js|css)|lib/|prompts/|_locales/)' \
  || true)"

if [ -z "$runtime" ]; then
  exit 0
fi

echo ""
echo ">> 提交涉及扩展运行时文件，自动同步升级测试 live/（npm test + 打包 + 切换）……"
bash "$REPO/scripts/sync-live.sh"
echo ""
echo ">> 已同步。去 chrome://extensions 找到 Digest for Bilibili，点一次「重新加载」。" 
