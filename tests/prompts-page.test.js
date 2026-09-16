const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const settings = require("../settings.js");

test("prompts.html 提供左右分栏与保存/恢复控件", () => {
  const html = fs.readFileSync(path.join(ROOT, "prompts.html"), "utf8");
  assert.match(html, /class=["']prompts-layout["']/);
  assert.match(html, /id=["']promptNav["']/);
  assert.match(html, /id=["']promptBody["']/);
  assert.match(html, /id=["']promptSaveBtn["']/);
  assert.match(html, /id=["']promptRestoreBtn["']/);
});

test("设置页改为提示词入口而非窄框编辑", () => {
  const html = fs.readFileSync(path.join(ROOT, "options.html"), "utf8");
  assert.match(html, /管理提示词/);
  assert.match(html, /href=["']prompts\.html["']/);
  assert.doesNotMatch(html, /id=["']analysisSystemPrompt["']/);
});

test("能力列表与 prompts 目录系统提示词文件一致", () => {
  const files = fs
    .readdirSync(path.join(ROOT, "prompts"))
    .filter((name) => name.endsWith(".md"))
    .sort();
  const declared = settings.SYSTEM_PROMPT_FILES.slice().sort();
  assert.deepEqual(declared, files);
});
