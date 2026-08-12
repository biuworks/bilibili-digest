#!/usr/bin/env bash
# 把工作区里混进来的 CRLF 统一改回 LF。
#
# Windows 侧 git 的 core.autocrlf=true 会在检出时写入 CRLF，而打包脚本直接复制
# 工作区文件——prompts/*.md 的代码块按 \n 解析，混进 \r 会让「概览」在成品包里失效。
# .gitattributes 负责防止再次发生，这个脚本负责收拾已经发生的。
set -euo pipefail

cd "$(dirname "$0")/.."

mapfile -t files < <(
  git ls-files |
    while read -r file; do
      [ -f "$file" ] || continue
      case "$file" in
        *.png | *.zip) continue ;;
      esac
      if grep -qU $'\r' "$file"; then echo "$file"; fi
    done
)

if [ ${#files[@]} -eq 0 ]; then
  echo "没有 CRLF 文件。"
  exit 0
fi

for file in "${files[@]}"; do
  # 原地改写要留住权限位，先写临时文件再覆盖内容而不是替换 inode。
  tr -d '\r' <"$file" >"$file.eol-tmp"
  cat "$file.eol-tmp" >"$file"
  rm -f "$file.eol-tmp"
  echo "已转换：$file"
done
