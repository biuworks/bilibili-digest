const test = require("node:test");
const assert = require("node:assert/strict");

const AI = require("../lib/ai.js");
const TRANSCRIPT = require("../lib/transcript.js");

// ============================================================
// 提示词模板
// ============================================================

const SAMPLE_MARKDOWN = [
  "# 标题",
  "",
  "## 系统提示词",
  "",
  "```",
  "你好 {name}，时长 {duration}。",
  "```",
  "",
  "## 用户提示词",
  "",
  "```",
  "内容：{body}",
  "```",
  "",
  "## 变量",
  "",
  "- `{name}` — 名字",
].join("\n");

test("按小节标题取出代码块并替换变量", () => {
  assert.equal(
    AI.extractPromptSection(SAMPLE_MARKDOWN, "系统提示词", {
      name: "小明",
      duration: "3:20",
    }),
    "你好 小明，时长 3:20。",
  );
  assert.equal(
    AI.extractPromptSection(SAMPLE_MARKDOWN, "用户提示词", { body: "正文" }),
    "内容：正文",
  );
});

test("只取本小节的代码块，不会串到下一节", () => {
  const section = AI.extractPromptSection(SAMPLE_MARKDOWN, "系统提示词", {});
  assert.doesNotMatch(section, /内容/);
});

test("未提供的变量替换成空串，而不是留下占位符", () => {
  const section = AI.extractPromptSection(SAMPLE_MARKDOWN, "系统提示词", {
    name: null,
    duration: undefined,
  });
  assert.equal(section, "你好 ，时长 。");
});

test("小节不存在或没有代码块时报错", () => {
  assert.throws(() => AI.extractPromptSection(SAMPLE_MARKDOWN, "不存在"), /不存在/);
  assert.throws(
    () => AI.extractPromptSection("## 空节\n\n没有代码块\n", "空节"),
    /代码块/,
  );
});

// ============================================================
// 模型输出解析
// ============================================================

test("解析普通 JSON", () => {
  assert.deepEqual(AI.parseLooseJson('{"a":1}'), { a: 1 });
});

test("容忍 markdown 代码围栏", () => {
  assert.deepEqual(AI.parseLooseJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(AI.parseLooseJson('```\n{"a":1}\n```'), { a: 1 });
});

test("容忍 JSON 前后夹带的解释性文字", () => {
  assert.deepEqual(
    AI.parseLooseJson('好的，这是结果：{"a":1} 希望有帮助'),
    { a: 1 },
  );
});

test("容忍数组或对象末尾多出来的逗号", () => {
  assert.deepEqual(AI.parseLooseJson('{"a":[1,2,],}'), { a: [1, 2] });
});

test("完全不是 JSON 时才抛错", () => {
  assert.throws(() => AI.parseLooseJson("这不是 JSON"));
});

// ============================================================
// 概览校验
// ============================================================

test("丢弃超出视频时长的时间戳", () => {
  const result = AI.validateAnalysis(
    {
      chapters: [
        { title: "开场", timestampSeconds: 0 },
        { title: "越界", timestampSeconds: 99999 },
        { title: "结尾", timestampSeconds: 100 },
      ],
      keyQuotes: [
        { quote: "有效", timestampSeconds: 50 },
        { quote: "越界", timestampSeconds: 500 },
      ],
    },
    120,
  );

  assert.deepEqual(
    result.chapters.map((c) => c.title),
    ["开场", "结尾"],
  );
  assert.equal(result.keyQuotes.length, 1);
});

test("上游的 keyMoments 数据链已砍掉：即使模型输出了也不透传", () => {
  // 上游消费它的功能被上游自己禁用了，留着这条链等于每块概览都为
  // 无人阅读的数据付 token。校验层是最后一道闸，别让它再漏回界面。
  const result = AI.validateAnalysis({ keyMoments: [0, 50] }, 120);
  assert.equal("keyMoments" in result, false);
});

test("显示用时间戳由校验过的秒数反推，不采信模型给的字符串", () => {
  const result = AI.validateAnalysis(
    { chapters: [{ title: "章", timestampSeconds: 95, timestamp: "9:99" }] },
    600,
  );
  assert.equal(result.chapters[0].timestamp, "1:35");
});

test("按时间戳升序排列，不管模型给的顺序", () => {
  const result = AI.validateAnalysis(
    {
      chapters: [
        { title: "第三", timestampSeconds: 300 },
        { title: "第一", timestampSeconds: 10 },
        { title: "第二", timestampSeconds: 100 },
      ],
    },
    600,
  );
  assert.deepEqual(
    result.chapters.map((c) => c.title),
    ["第一", "第二", "第三"],
  );
});

test("缺标题、缺秒数、类型不对的条目一律丢掉", () => {
  const result = AI.validateAnalysis(
    {
      chapters: [
        { title: "", timestampSeconds: 10 },
        { title: "没有秒数" },
        { title: "秒数不是数字", timestampSeconds: "abc" },
        { title: "正常", timestampSeconds: 10 },
      ],
      keyQuotes: [{ quote: 123, timestampSeconds: 10 }],
    },
    600,
  );
  assert.equal(result.chapters.length, 1);
  assert.equal(result.keyQuotes.length, 0);
});

test("字段完全缺失或畸形时返回空结构而不是抛错", () => {
  assert.deepEqual(AI.validateAnalysis(null, 100), {
    chapters: [],
    keyQuotes: [],
  });
  assert.deepEqual(AI.validateAnalysis({ chapters: "不是数组" }, 100).chapters, []);
});

test("超长文本被截断，条目数量有上限", () => {
  const result = AI.validateAnalysis(
    {
      chapters: Array.from({ length: 150 }, (_, i) => ({
        title: "标".repeat(400),
        summary: "摘".repeat(2000),
        timestampSeconds: i,
      })),
    },
    600,
  );
  assert.equal(result.chapters.length, 100);
  assert.equal(result.chapters[0].title.length, 300);
  assert.equal(result.chapters[0].summary.length, 1500);
});

// ============================================================
// 时长变量
// ============================================================

test("时长取元数据与字幕末尾时间戳里的较大值", () => {
  const transcript = "[0:00] 开头\n[5:00] 中间\n[9:30] 结尾";

  // 元数据时长偏小（B 站偶尔如此），以字幕为准
  const fromTranscript = AI.analysisTimingVariables(transcript, 100);
  assert.equal(fromTranscript.maxTimestampSeconds, 570);
  assert.equal(fromTranscript.durationFormatted, "9:30");

  // 元数据更大时以元数据为准
  const fromMetadata = AI.analysisTimingVariables(transcript, 1200);
  assert.equal(fromMetadata.maxTimestampSeconds, 1200);
});

test("lateThreshold 落在 75% 处，用来逼模型覆盖后半段", () => {
  const timing = AI.analysisTimingVariables("[0:00] 开头", 400);
  assert.equal(timing.lateThreshold, "5:00");
});

test("没有字幕也没有时长时不会崩", () => {
  const timing = AI.analysisTimingVariables("", 0);
  assert.equal(timing.maxTimestampSeconds, 0);
  assert.equal(timing.durationFormatted, "0:00");
});

// ============================================================
// 概览分块
// ============================================================

const makeAnalysisSegments = (count, length) =>
  Array.from({ length: count }, (_, i) => ({
    id: `s${i}`,
    start: i * 30,
    text: "字".repeat(length),
  }));

test("短字幕不分块，避免多余的往返", () => {
  const chunks = AI.planAnalysisChunks(makeAnalysisSegments(10, 100));
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].index, 0);
  assert.equal(chunks[0].startSeconds, 0);
});

test("较短模式可以降低不分块阈值", () => {
  const segments = makeAnalysisSegments(20, 250);
  assert.equal(AI.planAnalysisChunks(segments).length, 1);
  assert.ok(
    AI.planAnalysisChunks(segments, { maxChars: 3500, singleChars: 3500 }).length > 1,
  );
});

test("长字幕按分段边界切块，每块不超过上限", () => {
  const chunks = AI.planAnalysisChunks(makeAnalysisSegments(100, 300), {
    maxChars: 6000,
  });
  assert.ok(chunks.length > 1, "三万字应当被切开");
  for (const chunk of chunks) {
    const chars = chunk.segments.reduce((sum, s) => sum + s.text.length, 0);
    assert.ok(chars <= 6300, `某块字数 ${chars} 明显超出上限`);
  }
});

test("分块覆盖全部分段，既不丢也不重", () => {
  const segments = makeAnalysisSegments(100, 300);
  const chunks = AI.planAnalysisChunks(segments, { maxChars: 6000 });
  const ids = chunks.flatMap((chunk) => chunk.segments.map((s) => s.id));
  assert.deepEqual(ids, segments.map((s) => s.id));
});

test("每块带上自己的时间区间与带时间戳的文本", () => {
  const chunks = AI.planAnalysisChunks(makeAnalysisSegments(100, 300), {
    maxChars: 6000,
  });
  const second = chunks[1];
  assert.ok(second.startSeconds > 0, "第二块不该从 0 秒开始");
  assert.ok(second.endSeconds >= second.startSeconds);
  assert.match(second.text, /^\[\d+:\d{2}\] /);
});

test("没有分段时返回空数组", () => {
  assert.deepEqual(AI.planAnalysisChunks([]), []);
  assert.deepEqual(AI.planAnalysisChunks(null), []);
  assert.deepEqual(AI.planAnalysisChunks([{ id: "a", start: 0, text: "" }]), []);
});

test("除第一块外，每块带上一块结尾作为前情", () => {
  const chunks = AI.planAnalysisChunks(makeAnalysisSegments(100, 300), {
    maxChars: 6000,
    overlapChars: 400,
  });
  assert.equal(chunks[0].contextText, "", "第一块前面没有内容可回顾");
  for (const chunk of chunks.slice(1)) {
    assert.match(chunk.contextText, /^\[\d+:\d{2}\] /);
    // 够用就停：只多喂一点上下文，不是把上一块整个再发一遍。
    assert.ok(
      chunk.contextText.length >= 400 && chunk.contextText.length < 1200,
      `前情长度 ${chunk.contextText.length} 不在预期区间`,
    );
  }
});

test("前情取自上一块的末尾，而不是本块自己的开头", () => {
  const segments = makeAnalysisSegments(100, 300);
  const chunks = AI.planAnalysisChunks(segments, { maxChars: 6000 });
  const previous = chunks[0].segments[chunks[0].segments.length - 1];
  assert.ok(
    chunks[1].contextText.includes(`[${TRANSCRIPT.formatTimestamp(previous.start)}]`),
    "前情应当以上一块的最后一段收尾",
  );
});

test("关掉重叠就没有前情，老行为原样保留", () => {
  const chunks = AI.planAnalysisChunks(makeAnalysisSegments(100, 300), {
    maxChars: 6000,
    overlapChars: 0,
  });
  assert.ok(chunks.every((chunk) => chunk.contextText === ""));
});

test("分块时丢弃早于本块起点的时间戳，前情不归本块认领", () => {
  const result = AI.validateAnalysis(
    {
      chapters: [
        { title: "前情里的一章", timestampSeconds: 100 },
        { title: "本块的一章", timestampSeconds: 400 },
      ],
      keyQuotes: [
        { quote: "前情里的金句", timestampSeconds: 120 },
        { quote: "本块的金句", timestampSeconds: 500 },
      ],
    },
    900,
    300,
  );
  assert.deepEqual(
    result.chapters.map((chapter) => chapter.title),
    ["本块的一章"],
  );
  assert.deepEqual(
    result.keyQuotes.map((quote) => quote.quote),
    ["本块的金句"],
  );
});

// ============================================================
// 概览合并
// ============================================================

test("合并多块结果并按时间排序", () => {
  const merged = AI.mergeAnalyses(
    [
      {
        chapters: [{ title: "第二块的章", timestampSeconds: 300, timestamp: "5:00" }],
        keyQuotes: [{ quote: "后面的金句", timestampSeconds: 320, timestamp: "5:20" }],
      },
      {
        chapters: [{ title: "第一块的章", timestampSeconds: 10, timestamp: "0:10" }],
        keyQuotes: [{ quote: "前面的金句", timestampSeconds: 20, timestamp: "0:20" }],
      },
    ],
    600,
  );

  assert.deepEqual(
    merged.chapters.map((c) => c.title),
    ["第一块的章", "第二块的章"],
  );
  assert.deepEqual(
    merged.keyQuotes.map((q) => q.quote),
    ["前面的金句", "后面的金句"],
  );
});

test("块边界产生的重复章节与重复金句被去掉", () => {
  const merged = AI.mergeAnalyses(
    [
      {
        chapters: [{ title: "边界章节", timestampSeconds: 100, timestamp: "1:40" }],
        keyQuotes: [{ quote: "同一句话", timestampSeconds: 100, timestamp: "1:40" }],
      },
      {
        chapters: [{ title: "边界章节（重复）", timestampSeconds: 100, timestamp: "1:40" }],
        keyQuotes: [{ quote: "同一句话", timestampSeconds: 105, timestamp: "1:45" }],
      },
    ],
    600,
  );
  assert.equal(merged.chapters.length, 1);
  assert.equal(merged.keyQuotes.length, 1);
});

test("合并时仍然剔除超出视频时长的条目", () => {
  const merged = AI.mergeAnalyses(
    [{ chapters: [{ title: "越界", timestampSeconds: 9999, timestamp: "166:39" }] }],
    600,
  );
  assert.equal(merged.chapters.length, 0);
});

test("部分块为空或畸形时，合并仍然产出其余块的结果", () => {
  const merged = AI.mergeAnalyses(
    [
      null,
      {},
      { chapters: [{ title: "唯一有效的章", timestampSeconds: 10, timestamp: "0:10" }] },
    ],
    600,
  );
  assert.equal(merged.chapters.length, 1);
  assert.deepEqual(AI.mergeAnalyses([], 600).chapters, []);
  assert.deepEqual(AI.mergeAnalyses(null, 600).chapters, []);
});

test("失败区间能对回当前分块，补进去时覆盖该时段旧条目", () => {
  const chunks = AI.planAnalysisChunks(makeAnalysisSegments(40, 300), { maxChars: 6000 });
  assert.ok(chunks.length >= 2);
  const failed = AI.chunkFailureRanges(chunks, [
    { status: "fulfilled", value: {} },
    { status: "rejected", reason: new Error("限流") },
  ]);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].index, 1);
  assert.deepEqual(
    AI.chunksForFailureRanges(chunks, failed).map((chunk) => chunk.index),
    [1],
  );

  const merged = AI.mergeRetryIntoAnalysis(
    {
      chapters: [
        { title: "保留", timestampSeconds: 10, timestamp: "0:10" },
        { title: "旧的后半", timestampSeconds: failed[0].startSeconds, timestamp: "x" },
      ],
      keyQuotes: [],
    },
    [
      {
        chapters: [
          { title: "新的后半", timestampSeconds: failed[0].startSeconds + 5, timestamp: "y" },
        ],
      },
    ],
    failed,
    2000,
  );
  assert.deepEqual(
    merged.chapters.map((chapter) => chapter.title),
    ["保留", "新的后半"],
  );
});

// ============================================================
// 金句归类到章节
// ============================================================

const CHAPTERS = [
  { title: "开场", timestampSeconds: 0 },
  { title: "训练目标", timestampSeconds: 112 },
  { title: "泛化实验", timestampSeconds: 276 },
];

test("金句按时间戳归入所属章节，边界归前一章", () => {
  const { grouped, orphans } = AI.groupQuotesIntoChapters(CHAPTERS, [
    { quote: "开场白", timestampSeconds: 30 },
    { quote: "正好压在边界", timestampSeconds: 112 },
    { quote: "泛化的金句", timestampSeconds: 300 },
  ]);

  assert.deepEqual(
    grouped.map((group) => group.quotes.map((quote) => quote.quote)),
    [["开场白"], ["正好压在边界"], ["泛化的金句"]],
  );
  assert.deepEqual(orphans, []);
});

test("章节空档里的金句归入前一个章节", () => {
  const { grouped } = AI.groupQuotesIntoChapters(CHAPTERS, [
    { quote: "落在空档", timestampSeconds: 200 },
  ]);
  assert.deepEqual(grouped[1].quotes.map((quote) => quote.quote), ["落在空档"]);
});

test("第一章之前的金句归为 orphan，而不是塞进第一章", () => {
  const lateChapters = CHAPTERS.filter((chapter) => chapter.timestampSeconds > 0);
  const { grouped, orphans } = AI.groupQuotesIntoChapters(lateChapters, [
    { quote: "片头语", timestampSeconds: 5 },
    { quote: "正文金句", timestampSeconds: 300 },
  ]);

  assert.deepEqual(grouped.map((group) => group.quotes.length), [0, 1]);
  assert.deepEqual(orphans.map((quote) => quote.quote), ["片头语"]);
});

test("没有章节时金句全部归为 orphan", () => {
  const { grouped, orphans } = AI.groupQuotesIntoChapters([], [
    { quote: "唯一金句", timestampSeconds: 42 },
  ]);
  assert.deepEqual(grouped, []);
  assert.equal(orphans.length, 1);
});

test("畸形输入不抛错：非数组或时间戳缺失的条目被忽略", () => {
  const { grouped, orphans } = AI.groupQuotesIntoChapters(null, [
    { quote: "没有时间戳" },
    { quote: "有效金句", timestampSeconds: 10 },
  ]);
  assert.deepEqual(grouped, []);
  assert.deepEqual(orphans.map((quote) => quote.quote), ["有效金句"]);
});

// ============================================================
// 笔记上下文
// ============================================================

const NOTE_TRANSCRIPT = Array.from({ length: 20 }, (_, i) => ({
  text: `第${i}句`,
  start: i * 10,
  duration: 10,
}));

test("定位到时间点所在的那一行，并取出前后文", () => {
  const context = AI.noteContextAt(NOTE_TRANSCRIPT, 105);

  assert.equal(context.index, 10);
  assert.equal(context.targetText, "第10句");
  assert.equal(context.beforeText, "第8句 第9句");
  assert.equal(context.afterText, "第11句 第12句 第13句 第14句");
  // 更大的上下文：前 8 行到后 12 行
  assert.match(context.fullContext, /^第2句 /);
  assert.match(context.fullContext, /第19句$/);
});

test("时间点落在某行开头时算作该行", () => {
  assert.equal(AI.noteContextAt(NOTE_TRANSCRIPT, 100).targetText, "第10句");
});

test("时间点超出字幕范围时退回最后一行", () => {
  const context = AI.noteContextAt(NOTE_TRANSCRIPT, 99999);
  assert.equal(context.index, 19);
  assert.equal(context.targetText, "第19句");
  assert.equal(context.afterText, "");
});

test("开头处不会越界取到负索引", () => {
  const context = AI.noteContextAt(NOTE_TRANSCRIPT, 0);
  assert.equal(context.index, 0);
  assert.equal(context.beforeText, "");
  assert.match(context.fullContext, /^第0句 /);
});

test("没有字幕时返回 null", () => {
  assert.equal(AI.noteContextAt([], 10), null);
  assert.equal(AI.noteContextAt(null, 10), null);
});

// ============================================================
// 顺句：分批
// ============================================================

const makeSegments = (count, length = 10) =>
  Array.from({ length: count }, (_, i) => ({
    id: `s${i}`,
    text: "字".repeat(length),
  }));

test("按条数上限分批", () => {
  const batches = AI.planPunctuationBatches(makeSegments(20), { maxSegments: 8 });
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [8, 8, 4],
  );
});

test("按字数上限分批，避免某几批过长", () => {
  const batches = AI.planPunctuationBatches(makeSegments(6, 400), {
    maxSegments: 8,
    maxChars: 1000,
  });
  for (const batch of batches) {
    const chars = batch.reduce((sum, segment) => sum + segment.text.length, 0);
    assert.ok(chars <= 1200, `批次字数 ${chars} 超出预期`);
  }
  assert.ok(batches.length > 1);
});

test("单条就超过字数上限时自己占一批，而不是被丢掉", () => {
  const batches = AI.planPunctuationBatches(
    [{ id: "s0", text: "字".repeat(9000) }],
    { maxChars: 1000 },
  );
  assert.equal(batches.length, 1);
  assert.equal(batches[0][0].id, "s0");
});

test("空分段被跳过，空输入返回空数组", () => {
  const batches = AI.planPunctuationBatches([
    { id: "s0", text: "" },
    { id: "s1", text: "有内容" },
  ]);
  assert.deepEqual(batches, [[{ id: "s1", text: "有内容" }]]);
  assert.deepEqual(AI.planPunctuationBatches([]), []);
  assert.deepEqual(AI.planPunctuationBatches(null), []);
});

// ============================================================
// 顺句：改动幅度守卫
// ============================================================

test("只加标点视为合格", () => {
  assert.ok(
    AI.looksLikePunctuationFix(
      "今天我们聊聊这个话题，先说第一点。",
      "今天我们聊聊这个话题先说第一点",
    ),
  );
});

test("改同音错别字视为合格", () => {
  assert.ok(
    AI.looksLikePunctuationFix("机器学习很有意思。", "机器学系很有意思"),
  );
});

test("模型偷偷概括时判定为不合格", () => {
  assert.equal(
    AI.looksLikePunctuationFix(
      "他介绍了产品。",
      "他先是介绍了这个产品的背景然后讲了它的三个主要功能最后还提到了价格和售后服务的细节",
    ),
    false,
  );
});

test("模型擅自扩写时判定为不合格", () => {
  assert.equal(
    AI.looksLikePunctuationFix(
      "他介绍了产品。（这里说话人指的是他们公司新发布的那款旗舰机型，售价相当有竞争力。）",
      "他介绍了产品",
    ),
    false,
  );
});

// ============================================================
// 输出预算
// ============================================================

test("预算随输入量增长，而不是写死一个常量", () => {
  const small = AI.estimateOutputTokens(500, { ratio: 1.5, floor: 100 });
  const large = AI.estimateOutputTokens(3000, { ratio: 1.5, floor: 100 });
  assert.ok(large > small, "批次变大时预算必须跟着变大，否则大批次会被截断");
});

test("预算带固定余量，短输入也不会小到放不下 JSON 结构", () => {
  assert.ok(AI.estimateOutputTokens(10, { ratio: 1, floor: 0 }) >= 512);
});

test("预算被夹在上下界之间", () => {
  assert.equal(AI.estimateOutputTokens(1, { floor: 2048 }), 2048);
  assert.equal(
    AI.estimateOutputTokens(1_000_000, { ratio: 1, ceiling: 8192 }),
    8192,
    "超过模型自身输出上限的值会被服务直接拒掉",
  );
});

test("预算对畸形输入回落到下界", () => {
  for (const bad of [null, undefined, NaN, -100, "字符串"]) {
    assert.equal(
      AI.estimateOutputTokens(bad, { floor: 1024 }),
      1024,
      `输入 ${String(bad)} 时应回落到下界`,
    );
  }
});

test("摘要类任务的预算小于等量输入的改写类任务", () => {
  const rewrite = AI.estimateOutputTokens(6000, { ratio: 1.5, ceiling: 99999 });
  const summarize = AI.estimateOutputTokens(6000, { ratio: 0.5, ceiling: 99999 });
  assert.ok(summarize < rewrite);
});

// ============================================================
// 顺句：按 id 对齐
// ============================================================

const SOURCE_BATCH = [
  { id: "s1", text: "第一段原文内容" },
  { id: "s2", text: "第二段原文内容" },
];

test("按 id 对齐，不受返回顺序影响", () => {
  const { polished, rejected } = AI.alignPolishedSegments(
    {
      segments: [
        { id: "s2", text: "第二段原文内容。" },
        { id: "s1", text: "第一段原文内容。" },
      ],
    },
    SOURCE_BATCH,
  );
  assert.deepEqual(polished, {
    s1: "第一段原文内容。",
    s2: "第二段原文内容。",
  });
  assert.deepEqual(rejected, []);
});

test("模型漏返回的条目被记为 MISSING，其余照常采用", () => {
  const { polished, rejected } = AI.alignPolishedSegments(
    { segments: [{ id: "s1", text: "第一段原文内容。" }] },
    SOURCE_BATCH,
  );
  assert.deepEqual(Object.keys(polished), ["s1"]);
  assert.deepEqual(rejected, [{ id: "s2", reason: "MISSING" }]);
});

test("编造的 id 与重复的 id 都被拒绝", () => {
  const { polished, rejected } = AI.alignPolishedSegments(
    {
      segments: [
        { id: "s1", text: "第一段原文内容。" },
        { id: "s1", text: "第一段原文内容！" },
        { id: "s99", text: "凭空多出来的一段。" },
      ],
    },
    SOURCE_BATCH,
  );
  assert.deepEqual(Object.keys(polished), ["s1"]);
  assert.deepEqual(
    rejected.map((item) => item.reason).sort(),
    ["DUPLICATE_ID", "MISSING", "UNKNOWN_ID"],
  );
});

test("空文本与被改写的内容都不采用，保留原文", () => {
  const { polished, rejected } = AI.alignPolishedSegments(
    {
      segments: [
        { id: "s1", text: "   " },
        { id: "s2", text: "改写了。" },
      ],
    },
    SOURCE_BATCH,
  );
  assert.deepEqual(polished, {});
  assert.deepEqual(
    rejected.map((item) => item.reason).sort(),
    ["CONTENT_CHANGED", "EMPTY_TEXT"],
  );
});

test("返回结构完全畸形时，整批退回原文而不是抛错", () => {
  assert.deepEqual(AI.alignPolishedSegments(null, SOURCE_BATCH).polished, {});
  assert.deepEqual(
    AI.alignPolishedSegments({ segments: "不是数组" }, SOURCE_BATCH).polished,
    {},
  );
  assert.equal(AI.alignPolishedSegments(null, SOURCE_BATCH).rejected.length, 2);
});

// ============================================================
// 翻译
// ============================================================

const EN_BATCH = [
  { id: "s1", text: "This is the first complete sentence of the talk." },
  { id: "s2", text: "And here is the second one, which follows it." },
];

test("翻译按 id 对齐，不受返回顺序影响", () => {
  const { translated, rejected } = AI.alignTranslatedSegments(
    {
      segments: [
        { id: "s2", text: "接下来是第二句。" },
        { id: "s1", text: "这是这场演讲的第一句完整的话。" },
      ],
    },
    EN_BATCH,
  );

  assert.deepEqual(translated, {
    s1: "这是这场演讲的第一句完整的话。",
    s2: "接下来是第二句。",
  });
  assert.deepEqual(rejected, []);
});

test("模型把英文原样抄回来时判定为没翻译", () => {
  const { translated, rejected } = AI.alignTranslatedSegments(
    {
      segments: [
        { id: "s1", text: "This is the first complete sentence of the talk." },
        { id: "s2", text: "接下来是第二句。" },
      ],
    },
    EN_BATCH,
  );

  assert.deepEqual(translated, { s2: "接下来是第二句。" });
  assert.deepEqual(rejected, [{ id: "s1", reason: "NOT_TRANSLATED" }]);
});

test("原文本来就没多少拉丁字母时，不拿「有没有中文」当失败依据", () => {
  // 日文、韩文这类原文译出来可能仍是汉字或假名混排，
  // 用「必须出现中文」去判会误杀。
  const source = [{ id: "s1", text: "これは日本語の字幕です" }];
  const { translated, rejected } = AI.alignTranslatedSegments(
    { segments: [{ id: "s1", text: "これは日本語の字幕です" }] },
    source,
  );

  assert.equal(translated.s1, "これは日本語の字幕です");
  assert.deepEqual(rejected, []);
});

test("中译英：把中文原样抄回来判定为没翻译", () => {
  const source = [
    { id: "s1", text: "这是一段完整的中文字幕内容用来测试" },
    { id: "s2", text: "第二段中文字幕内容也足够长了" },
  ];
  const { translated, rejected } = AI.alignTranslatedSegments(
    {
      segments: [
        { id: "s1", text: "这是一段完整的中文字幕内容用来测试" },
        { id: "s2", text: "The second Chinese subtitle line is long enough." },
      ],
    },
    source,
    { targetLang: "en" },
  );

  assert.deepEqual(translated, {
    s2: "The second Chinese subtitle line is long enough.",
  });
  assert.deepEqual(rejected, [{ id: "s1", reason: "NOT_TRANSLATED" }]);
});

test("中译英：短句和保留专有名词的译文不被误杀", () => {
  // 「好的」→ "OK" 这类短译文没几个字母，不能拿「必须出现拉丁字母」当依据；
  // 判据是「中文明显变少」——译文里保留个把专有名词的汉字也没关系。
  const source = [
    { id: "s1", text: "好的好的" },
    { id: "s2", text: "我们今天来聊一聊李白的诗歌创作风格" },
  ];
  const { translated, rejected } = AI.alignTranslatedSegments(
    {
      segments: [
        { id: "s1", text: "OK" },
        { id: "s2", text: "Today we talk about 李白's poetry style." },
      ],
    },
    source,
    { targetLang: "en" },
  );

  assert.equal(translated.s1, "OK");
  assert.equal(translated.s2, "Today we talk about 李白's poetry style.");
  assert.deepEqual(rejected, []);
});

test("翻译同样拒绝漏条、编造 id 和空文本", () => {
  const { translated, rejected } = AI.alignTranslatedSegments(
    {
      segments: [
        { id: "s1", text: "   " },
        { id: "s9", text: "凭空多出来的一条" },
      ],
    },
    EN_BATCH,
  );

  assert.deepEqual(translated, {});
  assert.deepEqual(rejected.map((item) => item.reason).sort(), [
    "EMPTY_TEXT",
    "MISSING",
    "UNKNOWN_ID",
  ]);
});

test("翻译的批次比顺句小", () => {
  const segments = makeSegments(12, 200);
  const translation = AI.planTranslationBatches(segments);
  const punctuation = AI.planPunctuationBatches(segments);

  assert.ok(
    translation.length > punctuation.length,
    "翻译要重组整句，批次大了模型更容易漏条或越译越简",
  );
  assert.ok(translation.every((batch) => batch.length <= 4));
});
