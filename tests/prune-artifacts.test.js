const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const script = path.join(root, "scripts", "prune-artifacts.sh");

test("回滚材料只保留修改时间最新的 6 个版本", () => {
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), "bilibili-artifacts-"));

  try {
    fs.writeFileSync(path.join(artifacts, "README.txt"), "根目录文件不属于版本");
    for (let index = 1; index <= 8; index += 1) {
      const version = path.join(artifacts, `version-${index}`);
      fs.mkdirSync(version);
      fs.writeFileSync(path.join(version, "rollback.sh"), "#!/bin/sh\n");
      const timestamp = new Date(`2026-01-${String(index).padStart(2, "0")}T00:00:00Z`);
      fs.utimesSync(version, timestamp, timestamp);
    }

    const result = spawnSync("bash", [script, artifacts, "6"], {
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      fs.readdirSync(artifacts).sort(),
      [
        "README.txt",
        "version-3",
        "version-4",
        "version-5",
        "version-6",
        "version-7",
        "version-8",
      ],
    );
    assert.match(result.stdout, /删除 2 个旧版本，保留 6 个最新版本/);
  } finally {
    fs.rmSync(artifacts, { recursive: true, force: true });
  }
});
