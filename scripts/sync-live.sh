#!/usr/bin/env bash
# 仓库侧同步入口：把当前工作区打成包，同步到升级测试目录的名下版本并切 live/。
#
# 真正的流水线只在 ~/ext-upgrade-test/sync-040.sh 维护（npm test → package →
# 解压 v040 → switch.sh 040 → diff 终验），这里只是给定型路径一个统一入口，
# 让「同步」永远是一条可记忆的命令，而且能挂进 git 钩子自动执行。
#
#   npm run sync:live      # 手动同步（等价于去 ext-upgrade-test 跑 sync-040.sh）
#   npm run live-hook:install   # 安装 post-commit 钩子：提交后自动同步
#
# 若本机不存在 ~/ext-upgrade-test（比如另一台开发机），退出码保持 0，不打断流水线。
set -euo pipefail

SYNC="$HOME/ext-upgrade-test/sync-040.sh"
if [ ! -f "$SYNC" ]; then
  echo ">> 未找到 $SYNC（升级测试目录不在本机），跳过同步。" >&2
  exit 0
fi

bash "$SYNC"
