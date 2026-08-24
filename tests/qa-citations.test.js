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

test("buildCitationsFromAnswer：从字幕本地提取依据，越界与重复剔除", () => {
  const entries = [
    { start: 0, text: "第一句话讲概念" },
    { start: 60, text: "第二句给出结论" },
    { start: 200, text: "收尾" },
  ];
  const range = { min: 0, max: 300 };

  const citations = C.buildCitationsFromAnswer(
    "开头 [0:10] 结论 [1:05] 越界 [9:99] 重复 [0:10]",
    entries,
    range,
  );

  assert.deepEqual(citations, [
    { startSeconds: 10, quote: "第一句话讲概念" },
    { startSeconds: 65, quote: "第二句给出结论" },
  ]);
});

test("buildCitationsFromAnswer：时间戳落在两句之间时归前一句", () => {
  const entries = [
    { start: 0, text: "第一句" },
    { start: 60, text: "第二句" },
  ];
  const citations = C.buildCitationsFromAnswer(
    "引用 [0:59]",
    entries,
    { min: 0, max: 120 },
  );
  assert.deepEqual(citations, [{ startSeconds: 59, quote: "第一句" }]);
});

test("buildCitationsFromAnswer：空字幕或无时间戳返回空数组", () => {
  assert.deepEqual(
    C.buildCitationsFromAnswer("没有引用", [], { min: 0, max: 10 }),
    [],
  );
  assert.deepEqual(
    C.buildCitationsFromAnswer("[0:05] 有引用", [], { min: 0, max: 10 }),
    [],
  );
});

test("clickableTimestamps 返回落在区间内的秒数集合", () => {
  const clickable = C.clickableTimestamps(
    "见 [0:10] 与 [2:30]，后者越界",
    { min: 0, max: 130 },
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
    { text: "0:11-0:23", seconds: 11 },
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

test("stripWrappingQuotes 覆盖全部常见引号码位", () => {
  const pairs = [
    ["\u0022", "\u0022"],
    ["\u201C", "\u201D"],
    ["\uFF02", "\uFF02"],
    ["\u201E", "\u201E"],
    ["\u300C", "\u300D"],
    ["\u300A", "\u300B"],
    ["\u201C", "\u0022"],
  ];
  for (const [left, right] of pairs) {
    const stripped = C.stripWrappingQuotes(
      `${left}回答正文，含 [0:02]。${right}`,
    );
    assert.equal(
      stripped,
      "回答正文，含 [0:02]。",
      `${left}…${right} 应被剥掉`,
    );
  }
});
