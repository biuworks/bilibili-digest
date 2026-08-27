#!/usr/bin/env bash
# 安装/卸载「提交后自动同步升级测试 live/」的 git 钩子。
#
#   bash scripts/install-live-hook.sh          # 安装
#   bash scripts/install-live-hook.sh --uninstall
#
# 钩子本体提交在仓库里（scripts/live-sync-hook.sh），安装只是把它复制进
# .git/hooks/，重装扩展后重新跑一次即可——不会把本机私货混进仓库。
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$REPO/.git/hooks/post-commit"
SOURCE="$REPO/scripts/live-sync-hook.sh"

if [ "${1:-}" = "--uninstall" ]; then
  if [ -f "$HOOK" ] && cmp -s "$HOOK" "$SOURCE"; then
    rm "$HOOK"
    echo "已卸载 post-commit 钩子。"
  else
    echo "没有可卸载的钩子（或自定义过，保留不动）。"
  fi
  exit 0
fi

mkdir -p "$(dirname "$HOOK")"
cp "$SOURCE" "$HOOK"
chmod +x "$HOOK"
echo "已安装 post-commit 钩子：提交涉及扩展运行时文件时自动同步 live/。"
