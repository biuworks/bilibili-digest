const test = require("node:test");
const assert = require("node:assert/strict");

const C = require("../lib/qa-citations.js");

test("时间戳解析：M:SS 双向转换，非法输入拒绝", () => {
  assert.equal(C.timestampToSeconds("03:12"), 192);
  assert.equal(C.timestampToSeconds("0:05"), 5);
  assert.equal(C.timestampToSeconds("75:20"), 4520, "超一小时延续分钟制");
  assert.equal(C.timestampToSeconds("3:5"), null, "秒必须两位");
  assert.equal(C.timestampToSeconds(""), null);
  assert.equal(C.secondsToTimestamp(192), "3:12");
});

test("extractTimestamps 抽出全部合法 token", () => {
  const found = C.extractTimestamps("开头 [0:32] 中间 [12:00] 结尾 [bad]");
  assert.deepEqual(found, [
    { raw: "[0:32]", seconds: 32 },
    { raw: "[12:00]", seconds: 720 },
  ]);
});

const CONTEXT = "[0:10] 第一句话讲概念\n[1:00] 第二句给出结论 [2:00] 收尾";
const RANGE = { min: 0, max: 130 };

test("区间闸 + 原文闸：合法引用通过", () => {
  const { valid, invalidCount } = C.validateCitations({
    citations: [{ startSeconds: 60, quote: "第二句给出结论" }],
    contextText: CONTEXT,
    timeRange: RANGE,
  });
  assert.equal(invalidCount, 0);
  assert.deepEqual(valid, [{ startSeconds: 60, quote: "第二句给出结论" }]);
});

test("摘录带空白差异时仍算命中", () => {
  const { valid, invalidCount } = C.validateCitations({
    citations: [{ startSeconds: 10, quote: "第一句话 讲概念" }],
    contextText: CONTEXT,
    timeRange: RANGE,
  });
  assert.equal(invalidCount, 0);
  assert.equal(valid[0].quote, "第一句话 讲概念", "保留模型原样摘录");
});

test("越界时间戳被剔除", () => {
  const { valid, invalidCount } = C.validateCitations({
    citations: [{ startSeconds: 500, quote: "第一句话讲概念" }],
    contextText: CONTEXT,
    timeRange: RANGE,
  });
  assert.equal(invalidCount, 1);
  assert.equal(valid.length, 0);
});

test("字幕里找不到的 quote 视为幻觉被剔除", () => {
  const { valid, invalidCount } = C.validateCitations({
    citations: [{ startSeconds: 10, quote: "字幕里根本没有这句话" }],
    contextText: CONTEXT,
    timeRange: RANGE,
  });
  assert.equal(invalidCount, 1);
  assert.equal(valid.length, 0);
});

test("citations 不是数组或字段残缺时不抛错", () => {
  const result = C.validateCitations({
    citations: null,
    contextText: CONTEXT,
    timeRange: RANGE,
  });
  assert.deepEqual(result, { valid: [], invalidCount: 0 });

  const partial = C.validateCitations({
    citations: [{}, { startSeconds: 10 }],
    contextText: CONTEXT,
    timeRange: RANGE,
  });
  assert.equal(partial.invalidCount, 2);
});

test("clickableTimestamps 返回落在区间内的秒数集合", () => {
  const clickable = C.clickableTimestamps(
    "见 [0:10] 与 [2:30]，后者越界",
    RANGE,
  );
  assert.ok(clickable.has(10));
  assert.ok(!clickable.has(150), "2:30 = 150s 超出 max 130");
});

test("extractTimestamps 支持区间格式，取起点", () => {
  const found = C.extractTimestamps("依据见 [0:11-0:23] 与单点 [2:00]");
  assert.deepEqual(found, [
    { raw: "[0:11-0:23]", seconds: 11 },
    { raw: "[2:00]", seconds: 120 },
  ]);
});

test("splitAnswerByTimestamps：单点、区间、混合与无时间戳", () => {
  assert.deepEqual(C.splitAnswerByTimestamps("结论 [0:11-0:23] 收尾"), [
    { text: "结论 " },
    { text: "[0:11-0:23]", seconds: 11 },
    { text: " 收尾" },
  ]);
  assert.deepEqual(C.splitAnswerByTimestamps("没有时间戳"), [
    { text: "没有时间戳" },
  ]);
  const mixed = C.splitAnswerByTimestamps("[1:00]和[1:30-2:00]");
  assert.deepEqual(
    mixed.filter((segment) => segment.seconds != null).map((s) => s.seconds),
    [60, 90],
  );
});
