#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACTS_DIR="${1:-${ROOT_DIR}/artifacts}"
KEEP="${2:-6}"

if [[ ! "${KEEP}" =~ ^[0-9]+$ ]]; then
  echo "保留数量必须是非负整数：${KEEP}" >&2
  exit 2
fi

if [[ ! -d "${ARTIFACTS_DIR}" ]]; then
  echo "没有 artifacts 目录，无需清理：${ARTIFACTS_DIR}"
  exit 0
fi

# 一个一级子目录代表一份完整回滚材料；根目录文件不纳入版本计数。
mapfile -d '' versions < <(
  find "${ARTIFACTS_DIR}" -mindepth 1 -maxdepth 1 -type d \
    -printf '%T@\t%p\0' \
    | sort -z -t $'\t' -k1,1nr -k2,2r
)

total=${#versions[@]}
deleted=0
for ((index = KEEP; index < total; index += 1)); do
  version_path="${versions[index]#*$'\t'}"
  rm -rf -- "${version_path}"
  ((deleted += 1))
done

retained=$((total - deleted))
echo "artifacts：删除 ${deleted} 个旧版本，保留 ${retained} 个最新版本。"
