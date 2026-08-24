const test = require("node:test");
const assert = require("node:assert/strict");

const HIGHLIGHT = require("../lib/highlight.js");

const texts = (segments) => segments.map((segment) => segment.text).join("");

test("空关键词原样返回，不产生命中片段", () => {
  assert.deepEqual(HIGHLIGHT.splitMatches("任意文本", ""), [
    { text: "任意文本", hit: false },
  ]);
  assert.deepEqual(HIGHLIGHT.splitMatches("任意文本", "   "), [
    { text: "任意文本", hit: false },
  ]);
  // 空文本 + 空关键词：什么都不给。
  assert.deepEqual(HIGHLIGHT.splitMatches("", ""), []);
});

test("无命中原样返回整段", () => {
  assert.deepEqual(HIGHLIGHT.splitMatches("学习笔记", "复习"), [
    { text: "学习笔记", hit: false },
  ]);
});

test("大小写不敏感，但命中片段保留原文大小写", () => {
  const segments = HIGHLIGHT.splitMatches("学 JavaScript 就是 Java", "javascript");
  assert.equal(texts(segments), "学 JavaScript 就是 Java");
  assert.deepEqual(
    segments.filter((segment) => segment.hit).map((segment) => segment.text),
    ["JavaScript"],
  );
});

test("多处命中切成 片段-命中-片段 交替", () => {
  const segments = HIGHLIGHT.splitMatches("aXbXc", "x");
  assert.deepEqual(segments, [
    { text: "a", hit: false },
    { text: "X", hit: true },
    { text: "b", hit: false },
    { text: "X", hit: true },
    { text: "c", hit: false },
  ]);
});

test("相邻命中之间不留空白片段", () => {
  const segments = HIGHLIGHT.splitMatches("aa", "a");
  assert.deepEqual(segments, [
    { text: "a", hit: true },
    { text: "a", hit: true },
  ]);
});

test("命中贯穿到首尾时不产生空的边缘片段", () => {
  assert.deepEqual(HIGHLIGHT.splitMatches("abc", "abc"), [
    { text: "abc", hit: true },
  ]);
  assert.deepEqual(HIGHLIGHT.splitMatches("abc", "ab"), [
    { text: "ab", hit: true },
    { text: "c", hit: false },
  ]);
});

test("关键词比原文长时视为未命中", () => {
  assert.deepEqual(HIGHLIGHT.splitMatches("短", "这是一段长得多的关键词"), [
    { text: "短", hit: false },
  ]);
});

test("中文与混合内容照常工作", () => {
  const segments = HIGHLIGHT.splitMatches("UP 主讲机器学习", "机器");
  assert.deepEqual(segments, [
    { text: "UP 主讲", hit: false },
    { text: "机器", hit: true },
    { text: "学习", hit: false },
  ]);
});

test("hasMatch 汇总是否存在命中", () => {
  assert.equal(HIGHLIGHT.hasMatch([{ text: "a", hit: false }]), false);
  assert.equal(
    HIGHLIGHT.hasMatch(HIGHLIGHT.splitMatches("有命中", "命中")),
    true,
  );
});
