const test = require("node:test");
const assert = require("node:assert/strict");

const T = require("../lib/transcript.js");

const AI_CAPTIONS = [
  "今天我们来讲一下这个算法",
  "它的核心思想其实很简单",
  "就是把问题拆成更小的子问题",
  "然后逐个击破再合并结果",
  "这样时间复杂度会明显下降",
  "接下来我们看一个具体例子",
  "假设有一个长度为八的数组",
  "我们先把它平均分成两半",
  "分别对左右两边排序",
  "最后再做一次归并操作",
].map((text, index) => ({ text, start: index * 3, duration: 3 }));

test("按 CJK 占比自动选择分段阈值", () => {
  assert.equal(T.limitsForEntries(AI_CAPTIONS), T.CJK_LIMITS);
  assert.equal(
    T.limitsForEntries([{ text: "this is an english caption line", start: 0 }]),
    T.LATIN_LIMITS,
  );
  assert.equal(T.limitsForEntries([]), T.LATIN_LIMITS);
});

test("归一化清掉多余空白与中文字符间的空格", () => {
  assert.equal(T.normalizeCaptionText("  你 好   世界  "), "你好世界");
  assert.equal(T.normalizeCaptionText("hello   world"), "hello world");
  assert.equal(T.normalizeCaptionText("你好 ，世界"), "你好，世界");
  assert.equal(T.normalizeCaptionText(null), "");
});

test("超长无标点内容按上限硬切，但优先切在标点或词边界", () => {
  assert.deepEqual(T.splitOversizedThought("abcdefghij", 20), ["abcdefghij"]);

  const withComma = T.splitOversizedThought("aaaaaaaaaaaa，bbbbbbbbbbbb", 16);
  assert.equal(withComma[0], "aaaaaaaaaaaa，");
  assert.equal(withComma[1], "bbbbbbbbbbbb");

  const noBoundary = T.splitOversizedThought("啊".repeat(50), 20);
  assert.ok(noBoundary.every((part) => part.length <= 20));
  assert.equal(noBoundary.join(""), "啊".repeat(50));
});

test("无标点的 AI 字幕在原始字幕行边界切分，不会切碎词语", () => {
  const segments = T.groupTranscriptEntries(AI_CAPTIONS);

  assert.ok(segments.length >= 2, "十条字幕应该分成多段");
  const entryTexts = AI_CAPTIONS.map((entry) => entry.text);
  for (const segment of segments) {
    assert.ok(
      entryTexts.some((text) => segment.text.endsWith(text)),
      `段落应结束于某条原始字幕的末尾：${segment.text}`,
    );
    assert.ok(segment.text.length <= T.CJK_LIMITS.maxChars * 1.2);
  }

  // 分段不能丢字
  assert.equal(segments.map((s) => s.text).join(""), entryTexts.join(""));
});

test("每段保留贡献首个文字的那条字幕的时间戳", () => {
  const segments = T.groupTranscriptEntries(AI_CAPTIONS);
  assert.equal(segments[0].start, 0);
  for (let i = 1; i < segments.length; i += 1) {
    assert.ok(segments[i].start > segments[i - 1].start, "时间戳应递增");
  }
});

test("段落 id 稳定可用于翻译缓存键", () => {
  const first = T.groupTranscriptEntries(AI_CAPTIONS);
  const second = T.groupTranscriptEntries(AI_CAPTIONS);
  assert.deepEqual(
    first.map((s) => s.id),
    second.map((s) => s.id),
  );
  assert.match(first[0].id, /^segment-0-0$/);
});

test("有标点的中文字幕在句末切分", () => {
  const entries = [
    { text: "第一句话讲的是背景，", start: 0, duration: 3 },
    { text: "它决定了后面所有的设计取舍。", start: 3, duration: 3 },
    { text: "第二句话开始讲实现细节，", start: 6, duration: 3 },
    { text: "这里有三个关键点需要注意。", start: 9, duration: 3 },
    { text: "第三句话聊的是性能开销，", start: 12, duration: 3 },
    { text: "主要瓶颈出现在内存分配上。", start: 15, duration: 3 },
    { text: "最后一句话做个总结收尾，", start: 18, duration: 3 },
    { text: "希望这个例子对你有帮助。", start: 21, duration: 3 },
  ];
  const segments = T.groupTranscriptEntries(entries);
  assert.ok(segments.length >= 2);
  for (const segment of segments) {
    assert.match(segment.text, /[。！？]$/, "应该切在句号后");
  }
});

test("英文字幕沿用上游的拉丁阈值与断句行为", () => {
  const entries = [
    { text: "The first idea here is deceptively simple.", start: 0, duration: 4 },
    { text: "You split the problem into halves.", start: 4, duration: 4 },
    { text: "Then you solve each half on its own.", start: 8, duration: 4 },
    { text: "Finally you merge the two sorted halves.", start: 12, duration: 4 },
    { text: "That is the whole trick behind merge sort.", start: 16, duration: 4 },
  ];
  const segments = T.groupTranscriptEntries(entries);
  assert.ok(segments.length >= 1);
  for (const segment of segments) {
    assert.ok(segment.text.length <= T.LATIN_LIMITS.maxChars * 1.2);
    assert.doesNotMatch(segment.text, /\s{2,}/);
  }
});

test("空输入返回空数组", () => {
  assert.deepEqual(T.groupTranscriptEntries([]), []);
  assert.deepEqual(T.groupTranscriptEntries(null), []);
  assert.deepEqual(T.groupTranscriptEntries([{ text: "   ", start: 0 }]), []);
});

test("时间戳格式化为 M:SS", () => {
  assert.equal(T.formatTimestamp(0), "0:00");
  assert.equal(T.formatTimestamp(95), "1:35");
  assert.equal(T.formatTimestamp(3671), "61:11");
  assert.equal(T.formatTimestamp(-5), "0:00");
});

test("同时产出纯文本与带时间戳的文本视图", () => {
  const { plain, timestamped } = T.buildTranscriptTexts([
    { text: "开场白", start: 0, duration: 2 },
    { text: "正文内容", start: 95, duration: 3 },
    { text: "   ", start: 100, duration: 1 },
  ]);

  assert.equal(plain, "开场白 正文内容");
  assert.equal(timestamped, "[0:00] 开场白\n[1:35] 正文内容");
});

// ============================================================
// 字幕语种：决定给顺句还是给翻译
// ============================================================

test("认得出 B 站各种写法的中文字幕轨", () => {
  for (const code of ["zh-CN", "zh-Hans", "ai-zh", "AI-ZH", "zh"]) {
    assert.equal(T.isChineseSubtitle(code), true, `${code} 应判为中文`);
  }
});

test("外文字幕轨不判为中文", () => {
  for (const code of ["en-US", "ai-en", "ja", "ko"]) {
    assert.equal(T.isChineseSubtitle(code), false, `${code} 不应判为中文`);
  }
});

test("拿不到语言码时按中文处理", () => {
  // B 站以中文视频为主，猜中文猜错了只是少一个翻译入口，
  // 猜外文猜错了则会给一屏中文字幕摆上「翻译成中文」。
  assert.equal(T.isChineseSubtitle(""), true);
  assert.equal(T.isChineseSubtitle(null), true);
  assert.equal(T.isChineseSubtitle(undefined), true);
});
