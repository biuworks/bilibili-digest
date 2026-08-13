#!/usr/bin/env bash
# 打出可直接上传 Chrome 应用商店与 Edge 加载项的 zip。同一个包投两边即可，
# 两个商店对包结构的要求一致（manifest.json 在顶层、不带 update_url）。
#
# 用白名单而不是「排除若干目录」：漏排一个新目录只是包大了，
# 漏排一份密钥或调试文件却是事故，白名单让新增文件默认不进包。
set -euo pipefail

cd "$(dirname "$0")/.."

# 运行时真正被加载的文件。改动 manifest 引用时记得同步这里，
# 末尾的自检会在漏了文件时报错。
FILES=(
  manifest.json
  background.js
  content.js
  settings.js
  sidepanel.html
  sidepanel.css
  sidepanel.js
  options.html
  options.css
  options.js
  icons/icon16.png
  icons/icon48.png
  icons/icon128.png
  LICENSE
)
DIRS=(lib prompts)

version=$(node -p "require('./manifest.json').version")
out="dist/digest-for-bilibili-${version}.zip"

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

for file in "${FILES[@]}"; do
  [ -f "$file" ] || { echo "缺少文件：$file" >&2; exit 1; }
  mkdir -p "$stage/$(dirname "$file")"
  cp "$file" "$stage/$file"
done

for dir in "${DIRS[@]}"; do
  [ -d "$dir" ] || { echo "缺少目录：$dir" >&2; exit 1; }
  cp -r "$dir" "$stage/$dir"
done

# manifest 引用了却没进包的文件，会让浏览器直接拒绝加载整个扩展，
# 而商店的报错通常只指向清单本身，很难定位。
missing=$(cd "$stage" && node -e '
const fs = require("fs");
const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const referenced = [
  manifest.background?.service_worker,
  manifest.side_panel?.default_path,
  manifest.options_ui?.page,
  ...(manifest.content_scripts || []).flatMap((entry) => entry.js || []),
  ...Object.values(manifest.action?.default_icon || {}),
  ...Object.values(manifest.icons || {}),
].filter(Boolean);
const sw = fs.readFileSync(manifest.background.service_worker, "utf8");
const block = sw.match(/importScripts\(([\s\S]*?)\);/);
if (block) referenced.push(...[...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
for (const page of [manifest.side_panel?.default_path, manifest.options_ui?.page]) {
  if (!page) continue;
  const html = fs.readFileSync(page, "utf8");
  referenced.push(...[...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]));
  referenced.push(...[...html.matchAll(/<link[^>]+href="([^"]+)"/g)].map((m) => m[1]));
}
console.log(referenced.filter((file) => !fs.existsSync(file)).join(" "));
')
[ -z "$missing" ] || { echo "这些文件被清单引用但没打进包：$missing" >&2; exit 1; }

# CRLF 会让 prompts/*.md 的代码块解析不出来，「概览」随之失效，
# 而这种失效只有把包装进浏览器才看得见。宁可在这里拦住。
crlf=$(cd "$stage" && grep -rlU $'\r' . --exclude='*.png' || true)
[ -z "$crlf" ] || {
  echo "包内有 CRLF 换行的文件，会导致提示词解析失败：" >&2
  echo "$crlf" >&2
  echo "跑 bash scripts/normalize-eol.sh 修复。" >&2
  exit 1
}

mkdir -p dist
rm -f "$out"
absolute_out="$(pwd)/$out"

# zip 不是所有环境都装了（WSL 默认就没有），python3 的 zipfile 模块可以顶上。
if command -v zip >/dev/null 2>&1; then
  (cd "$stage" && zip -q -r -X "$absolute_out" .)
elif command -v python3 >/dev/null 2>&1; then
  # 传 * 而不是 . ，这样条目直接落在压缩包根部——商店要求 manifest.json 在顶层。
  (cd "$stage" && python3 -m zipfile -c "$absolute_out" *)
else
  echo "需要 zip 或 python3 其中之一来打包。" >&2
  exit 1
fi

echo "$out"
echo "版本 ${version}，大小 $(du -h "$out" | cut -f1)，$(unzip -l "$out" 2>/dev/null | tail -1 | awk '{print $2}' || echo '?') 个文件"
