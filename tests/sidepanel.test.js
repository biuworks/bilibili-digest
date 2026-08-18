const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/**
 * 侧边栏的渲染集成测试。
 *
 * 这里加载的是真正的 sidepanel.js，只把 DOM 和 chrome API 换成桩，
 * 然后走完整的 loadTranscript 流程。这样测的是真实的分支与调用顺序，
 * 而不是另写一份逻辑自己跟自己对答案。
 *
 * 之所以不用浏览器端到端：侧边栏跑在 chrome-extension:// 里，
 * 需要先把扩展装进真实浏览器，还得有 B 站登录态和一个真的 AI 密钥，
 * 每跑一次都要花钱、且结果不确定。而这个 bug 的因果完全在渲染路径上，
 * 在这一层就能钉死。
 */

const ROOT = path.join(__dirname, "..");

/** 属性随便读写、方法都不做事的元素桩，够渲染路径用即可。 */
function createElement(tag = "div") {
  const queried = new Map();
  const listeners = new Map();
  return {
    tagName: tag,
    className: "",
    textContent: "",
    hidden: false,
    disabled: false,
    style: {},
    dataset: {},
    children: [],
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    append(...nodes) {
      this.children.push(...nodes);
    },
    insertBefore(node) {
      this.children.push(node);
      return node;
    },
    remove() {},
    scrolled: false,
    scrollIntoView() {
      this.scrolled = true;
    },
    focus() {},
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    removeEventListener() {},
    async dispatch(type, event = {}) {
      for (const listener of listeners.get(type) || []) {
        await listener({ preventDefault() {}, stopPropagation() {}, ...event });
      }
    },
    // 同一个选择器要返回同一个对象，否则写进去的值下次就读不到了。
    querySelector(selector) {
      if (!queried.has(selector)) queried.set(selector, createElement("div"));
      return queried.get(selector);
    },
    querySelectorAll() {
      return [];
    },
  };
}

function createContext({ transcript, analysis, videoAvailable = { available: true } }) {
  const elements = new Map();
  const byId = (id) => {
    if (!elements.has(id)) elements.set(id, createElement("div"));
    return elements.get(id);
  };

  const sent = [];
  const openedTabs = [];
  const seeks = [];
  const context = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    CSS: { escape: (value) => value },
    window: { getSelection: () => null },
    document: {
      getElementById: byId,
      createElement: (tag) => createElement(tag),
      createElementNS: (namespace, tag) => createElement(tag),
      createDocumentFragment: () => createElement("#fragment"),
      querySelectorAll: () => [],
      addEventListener() {},
    },
    navigator: { clipboard: { writeText: async () => {} } },
    chrome: {
      runtime: {
        async sendMessage(message) {
          sent.push(message);
          if (message.action === "fetchTranscript") return transcript;
          if (message.action === "analyzeTranscript") return analysis;
          if (message.action === "translateSegments") {
            const translated = {};
            for (const id of message.segmentIds) translated[id] = `${id} 的译文`;
            return { success: true, translated };
          }
          if (message.action === "checkVideoAvailable") return videoAvailable;
          return { success: true };
        },
        onMessage: { addListener() {} },
      },
      tabs: {
        query: async () => [{ id: 1, url: "https://www.bilibili.com/video/BV1xx411c7mD" }],
        sendMessage: async (tabId, message) => {
          if (message?.action === "seekTo") seeks.push(message.seconds);
          return {};
        },
        create: async (options) => {
          openedTabs.push(options.url);
          return { id: 2 };
        },
        onActivated: { addListener() {} },
        onUpdated: { addListener() {} },
      },
      windows: { getCurrent: async () => ({ id: 1 }) },
      storage: { local: { get: async () => ({}) } },
    },
    BILI_TRANSCRIPT: require("../lib/transcript.js"),
    BILI_AI: require("../lib/ai.js"),
    BILI_CONCURRENCY: require("../lib/concurrency.js"),
    BILI_SETTINGS: require("../settings.js"),
  };
  context.globalThis = context;

  vm.createContext(context);
  // sidepanel.js 顶层用的是 const，在 vm 里不会挂到全局对象上，
  // 所以在末尾追加一行，从同一个词法作用域里把要测的绑定递出来。
  const source = fs.readFileSync(path.join(ROOT, "sidepanel.js"), "utf8");
  vm.runInContext(
    `${source}\n;globalThis.__api = { state, loadTranscript, analyze, segmentDisplayText, paintSegmentText, setTranscriptMode, selectionContext, applySearchFilter, updateFollowPill, jumpToActive, closeSearch, renderNoteCard, playNote, loadNotes, syncQuoteButtonsWithNotes };`,
    context,
  );

  return {
    ...context.__api,
    el: byId,
    chrome: context.chrome,
    sent,
    openedTabs,
    seeks,
  };
}

const SEGMENTS = [
  { id: "s1", start: 0, text: "第一段原文" },
  { id: "s2", start: 5, text: "第二段原文" },
];

const ANALYSIS = {
  chapters: [
    { timestamp: "0:00", timestampSeconds: 0, title: "开场", summary: "讲了开场" },
  ],
  keyQuotes: [{ timestamp: "0:05", timestampSeconds: 5, quote: "一句金句" }],
};

function transcriptResult(extra = {}) {
  return {
    success: true,
    fromCache: true,
    segments: SEGMENTS,
    videoInfo: { title: "标题", owner: "UP主" },
    ...extra,
  };
}

// ============================================================
// 缓存里已有的结果要自动摆出来
// ============================================================

test("缓存里带着概览时，进来就直接展示，不用再点一次生成", async () => {
  const ctx = createContext({
    transcript: transcriptResult({ analysis: ANALYSIS }),
  });
  ctx.state.bvid = "BV1xx411c7mD";

  await ctx.loadTranscript();

  assert.equal(
    ctx.el("overviewResult").hidden,
    false,
    "结果就在手上却不显示，用户会以为上次生成失败了",
  );
  assert.equal(ctx.el("overviewEmpty").hidden, true);
  assert.deepEqual(ctx.state.analysis, ANALYSIS);
});

test("没有概览时保持空态，不会摆出一个空壳", async () => {
  const ctx = createContext({ transcript: transcriptResult() });
  ctx.state.bvid = "BV1xx411c7mD";

  await ctx.loadTranscript();

  assert.equal(ctx.el("overviewResult").hidden, true);
  assert.equal(ctx.el("overviewEmpty").hidden, false);
  assert.equal(ctx.state.analysis, null);
});

test("开新标签页时事件成对触发，同一次加载只发一个请求", async () => {
  const ctx = createContext({ transcript: transcriptResult() });
  ctx.state.bvid = "BV1xx411c7mD";

  // onActivated 与 onUpdated 会前后脚各触发一次同步，
  // 两次并发的 loadTranscript 必须合并成一次请求，否则视频会拉两遍。
  await Promise.all([ctx.loadTranscript(), ctx.loadTranscript()]);

  assert.equal(
    ctx.sent.filter((message) => message.action === "fetchTranscript").length,
    1,
    "并发触发的两次加载不该真的拉两遍字幕",
  );
});

test("加载期间切了视频，旧视频的结果不写入界面", async () => {
  const ctx = createContext({ transcript: transcriptResult() });
  ctx.state.bvid = "BV1xx411c7mD";

  // 卡住请求，模拟网络慢：期间用户切到了另一个视频。
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const original = ctx.chrome.runtime.sendMessage;
  ctx.chrome.runtime.sendMessage = async (message) => {
    if (message.action === "fetchTranscript") {
      await gate;
      return transcriptResult();
    }
    return original(message);
  };

  const pending = ctx.loadTranscript();
  ctx.state.bvid = "BV1yy411c7mD";
  release();
  await pending;

  assert.equal(
    ctx.state.data,
    null,
    "结果回来时票已对不上：旧视频的字幕不该闪一下又覆盖新视频的界面",
  );
});

test("概览生成期间切了视频，旧视频的概览不写入界面", async () => {
  const ctx = createContext({ transcript: transcriptResult() });
  ctx.state.bvid = "BV1xx411c7mD";
  await ctx.loadTranscript();

  // 卡住概览生成：期间用户切到另一个视频。
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const original = ctx.chrome.runtime.sendMessage;
  ctx.chrome.runtime.sendMessage = async (message) => {
    if (message.action === "analyzeTranscript") {
      await gate;
      return { success: true, analysis: ANALYSIS };
    }
    return original(message);
  };

  const pending = ctx.analyze();
  ctx.state.bvid = "BV1yy411c7mD";
  release();
  await pending;

  assert.equal(
    ctx.state.analysis,
    null,
    "旧视频的概览回来时票已对不上，不能覆盖新视频的概览区",
  );
});

test("缓存里带着顺句结果时，直接显示顺过的文字", async () => {
  const ctx = createContext({
    transcript: transcriptResult({ polished: { s1: "第一段原文。" } }),
  });
  ctx.state.bvid = "BV1xx411c7mD";

  await ctx.loadTranscript();

  assert.equal(
    ctx.state.polishMode,
    true,
    "顺句是花钱换来的，回来默认显示原文等于让用户以为白顺了",
  );
  assert.equal(ctx.segmentDisplayText(SEGMENTS[0]), "第一段原文。");
  // 没顺到的那条仍然回落到原文
  assert.equal(ctx.segmentDisplayText(SEGMENTS[1]), "第二段原文");
});

test("没有顺句结果时不进入顺句态", async () => {
  const ctx = createContext({ transcript: transcriptResult() });
  ctx.state.bvid = "BV1xx411c7mD";

  await ctx.loadTranscript();

  assert.equal(ctx.state.polishMode, false);
  assert.equal(ctx.segmentDisplayText(SEGMENTS[0]), "第一段原文");
});

test("换视频时，上一个视频的概览不会串台", async () => {
  const ctx = createContext({
    transcript: transcriptResult({ analysis: ANALYSIS }),
  });
  ctx.state.bvid = "BV1xx411c7mD";
  await ctx.loadTranscript();
  assert.equal(ctx.el("overviewResult").hidden, false);

  // 换到一个没有概览的视频
  ctx.chrome.runtime.sendMessage = async (message) =>
    message.action === "fetchTranscript" ? transcriptResult() : { success: true };
  await ctx.loadTranscript();

  assert.equal(ctx.state.analysis, null);
  assert.equal(ctx.el("overviewResult").hidden, true);
  assert.equal(ctx.el("overviewEmpty").hidden, false);
});

// ============================================================
// 生成完成后的渲染
// ============================================================

test("生成成功后立即展示结果，并收起加载态", async () => {
  const ctx = createContext({
    transcript: transcriptResult(),
    analysis: { success: true, analysis: ANALYSIS },
  });
  ctx.state.bvid = "BV1xx411c7mD";
  await ctx.loadTranscript();

  await ctx.analyze();

  assert.equal(ctx.el("overviewLoading").hidden, true);
  assert.equal(ctx.el("overviewResult").hidden, false);
  assert.deepEqual(ctx.state.analysis, ANALYSIS);
});

// ============================================================
// 双语对照：三视图人人都有，顺句只给中文字幕
// ============================================================

const EN = { language: "en-US", languageLabel: "英语（自动生成）" };

test("中文字幕：顺句开关和三视图都给（中文译成英文）", async () => {
  const ctx = createContext({ transcript: transcriptResult({ language: "ai-zh" }) });
  ctx.state.bvid = "BV1xx411c7mD";

  await ctx.loadTranscript();

  assert.equal(ctx.state.isChinese, true);
  assert.equal(ctx.el("polishBtn").hidden, false);
  assert.equal(
    ctx.el("transcriptMode").hidden,
    false,
    "中文字幕也要给三视图——译成英文",
  );
});

test("中文字幕切译文会发翻译请求（方向由 background 定）", async () => {
  const ctx = createContext({ transcript: transcriptResult({ language: "ai-zh" }) });
  ctx.state.bvid = "BV1xx411c7mD";
  await ctx.loadTranscript();

  await ctx.setTranscriptMode("translated");

  assert.ok(
    ctx.sent.some((message) => message.action === "translateSegments"),
    "中文视频切译文视图也应该走同一条翻译链路",
  );
});

test("双语的上行跟着顺句走：开了顺句就显示顺句稿", async () => {
  const ctx = createContext({
    transcript: transcriptResult({
      language: "ai-zh",
      polished: { s1: "第一段，原文。" },
      translated: { s1: "Line one translated." },
    }),
  });
  ctx.state.bvid = "BV1xx411c7mD";
  await ctx.loadTranscript();

  assert.equal(ctx.state.transcriptMode, "bilingual", "缓存里有译文就该直接进双语");
  const node = ctx.el("probe");
  ctx.paintSegmentText(node, SEGMENTS[0]);
  assert.deepEqual(
    node.children.map((child) => child.textContent),
    ["第一段，原文。", "Line one translated."],
    "顺句稿比无标点的 ASR 原文好读，双语上行没理由退回原文",
  );
});

test("外文字幕给三视图，不给顺句开关", async () => {
  const ctx = createContext({ transcript: transcriptResult(EN) });
  ctx.state.bvid = "BV1xx411c7mD";

  await ctx.loadTranscript();

  assert.equal(ctx.state.isChinese, false);
  assert.equal(ctx.el("transcriptMode").hidden, false);
  assert.equal(
    ctx.el("polishBtn").hidden,
    true,
    "英文字幕本来就带标点，顺句没有意义",
  );
});

test("缓存里带着译文时，进来就是双语，不用再翻一遍", async () => {
  const ctx = createContext({
    transcript: transcriptResult({ ...EN, translated: { s1: "第一段译文" } }),
  });
  ctx.state.bvid = "BV1xx411c7mD";

  await ctx.loadTranscript();

  assert.equal(ctx.state.transcriptMode, "bilingual");
  assert.equal(ctx.state.translated.s1, "第一段译文");
});

test("双语模式下原文和译文各占一行，没翻到的那条给占位", async () => {
  const ctx = createContext({
    transcript: transcriptResult({ ...EN, translated: { s1: "第一段译文" } }),
  });
  ctx.state.bvid = "BV1xx411c7mD";
  await ctx.loadTranscript();

  const node = ctx.el("probe");
  ctx.paintSegmentText(node, SEGMENTS[0]);
  assert.deepEqual(
    node.children.map((child) => child.textContent),
    ["第一段原文", "第一段译文"],
  );

  const pending = ctx.el("probe2");
  ctx.paintSegmentText(pending, SEGMENTS[1]);
  assert.equal(pending.children[1].textContent, "翻译中…");
});

test("切到译文视图会去翻译，结果回填进 state", async () => {
  const ctx = createContext({ transcript: transcriptResult(EN) });
  ctx.state.bvid = "BV1xx411c7mD";
  await ctx.loadTranscript();

  await ctx.setTranscriptMode("translated");

  assert.equal(ctx.state.transcriptMode, "translated");
  assert.equal(ctx.state.translated.s1, "s1 的译文");
  assert.equal(ctx.segmentDisplayText(SEGMENTS[0]), "s1 的译文");
  assert.ok(
    ctx.sent.some((message) => message.action === "translateSegments"),
    "切到译文视图却没发翻译请求",
  );
});

test("切回原文不再发翻译请求", async () => {
  const ctx = createContext({ transcript: transcriptResult(EN) });
  ctx.state.bvid = "BV1xx411c7mD";
  await ctx.loadTranscript();
  await ctx.setTranscriptMode("translated");

  const before = ctx.sent.filter((m) => m.action === "translateSegments").length;
  await ctx.setTranscriptMode("original");

  assert.equal(ctx.state.transcriptMode, "original");
  assert.equal(ctx.segmentDisplayText(SEGMENTS[0]), "第一段原文");
  assert.equal(
    ctx.sent.filter((m) => m.action === "translateSegments").length,
    before,
    "切回原文只是换个显示方式，不该再花钱",
  );
});

test("已经翻过的分段不会再翻第二次", async () => {
  const ctx = createContext({
    transcript: transcriptResult({ ...EN, translated: { s1: "第一段译文", s2: "第二段译文" } }),
  });
  ctx.state.bvid = "BV1xx411c7mD";
  await ctx.loadTranscript();

  await ctx.setTranscriptMode("translated");

  assert.equal(
    ctx.sent.filter((m) => m.action === "translateSegments").length,
    0,
    "缓存里全都有了还去请求，等于白花钱",
  );
  assert.equal(ctx.segmentDisplayText(SEGMENTS[0]), "第一段译文");
});

test("翻译从正在看的位置开始，前面的稍后环绕补齐", async () => {
  const ctx = createContext({ transcript: transcriptResult(EN) });
  ctx.state.bvid = "BV1xx411c7mD";
  await ctx.loadTranscript();

  // 用户看到了第二段（5 秒处）才切译文视图。
  ctx.state.activeIndex = 1;
  await ctx.setTranscriptMode("translated");

  const first = ctx.sent.find((m) => m.action === "translateSegments");
  assert.deepEqual(
    first.segmentIds,
    ["s2", "s1"],
    "眼前这一段应该排在最前，否则长视频里用户要等前面全部翻完",
  );
  // 顺序只影响先后，两段最终都要有结果。
  assert.equal(ctx.state.translated.s1, "s1 的译文");
  assert.equal(ctx.state.translated.s2, "s2 的译文");
});

test("偶发失败的批次会自动补一轮，不用用户手点", async () => {
  // 5 段会被切成 2 批（每批最多 4 段），好让「部分失败」成立。
  const many = Array.from({ length: 5 }, (_, i) => ({
    id: `s${i + 1}`,
    start: i * 5,
    text: `第 ${i + 1} 段原文`,
  }));
  const ctx = createContext({
    transcript: {
      success: true,
      segments: many,
      videoInfo: { title: "标题", owner: "UP主" },
      language: "en-US",
    },
  });
  ctx.state.bvid = "BV1xx411c7mD";
  await ctx.loadTranscript();

  // 第一个翻译批次模拟限流失败，之后恢复正常。
  const original = ctx.chrome.runtime.sendMessage;
  let failedOnce = false;
  ctx.chrome.runtime.sendMessage = async (message) => {
    if (message.action === "translateSegments" && !failedOnce) {
      failedOnce = true;
      return { success: false, message: "限流" };
    }
    return original(message);
  };

  await ctx.setTranscriptMode("translated");

  for (const segment of many) {
    assert.ok(
      ctx.state.translated[segment.id],
      `${segment.id} 在自动补一轮之后仍然没有译文`,
    );
  }
  assert.ok(
    !ctx.el("segmentCount").textContent.includes("批失败"),
    "补齐之后不该再让用户手点补齐",
  );
});

test("划词解释能在顺句后的文字里找到上下文", async () => {
  const ctx = createContext({
    transcript: transcriptResult({ polished: { s1: "第一段，原文。" } }),
  });
  ctx.state.bvid = "BV1xx411c7mD";
  await ctx.loadTranscript();

  // 屏幕上显示的是顺句稿，用户选中的自然是带标点的版本——原文里并没有这串字。
  const context = ctx.selectionContext("第一段，原文。");
  assert.ok(
    context.includes("第一段，原文。"),
    "在顺句稿里找不到选区，上下文就退化成字幕开头，解释会驴唇不对马嘴",
  );
  assert.ok(context.includes("第二段原文"), "相邻分段也应该进上下文");
});

// ============================================================
// 字幕搜索与「回到当前句」浮标
// ============================================================

test("样式里必须兜住 hidden，否则整套显隐都是摆设", () => {
  // 本页大量元素既写了 display:flex 又靠 hidden 控制显隐（进度条、搜索栏、
  // 跟随浮标、被搜索过滤掉的字幕行……）。作者样式里的 display 会盖过
  // hidden 属性的浏览器默认值，少了这条兜底，它们一个都藏不住——
  // 而 DOM 桩不跑 CSS，只有在这里静态守住。
  const css = fs.readFileSync(path.join(ROOT, "sidepanel.css"), "utf8");
  assert.match(css, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
});

test("命中的字会被 mark 标出来", async () => {
  const ctx = createContext({ transcript: transcriptResult() });
  ctx.state.bvid = "BV1xx411c7mD";
  await ctx.loadTranscript();

  ctx.applySearchFilter("一段");

  const rows = ctx.el("transcriptList").children[0].children;
  const pieces = rows[0].children[1].children;
  assert.deepEqual(
    pieces.map((piece) => [piece.tagName, piece.textContent]),
    [
      ["span", "第"],
      ["mark", "一段"],
      ["span", "原文"],
    ],
    "一屏语气相近的字幕，光过滤还是要一行行找，标出来眼睛才有落点",
  );
});

test("搜索会把第一条命中滚进视野", async () => {
  const ctx = createContext({ transcript: transcriptResult() });
  ctx.state.bvid = "BV1xx411c7mD";
  await ctx.loadTranscript();

  ctx.applySearchFilter("第二段");

  const rows = ctx.el("transcriptList").children[0].children;
  assert.equal(
    rows[1].scrolled,
    true,
    "不滚过去的话命中行可能在几屏之外，用户会以为搜索没生效",
  );
  assert.equal(rows[0].scrolled, false, "没命中的行不该被滚到");
});

test("搜索会过滤字幕行并报命中数，清空后全部恢复", async () => {
  const ctx = createContext({ transcript: transcriptResult() });
  ctx.state.bvid = "BV1xx411c7mD";
  await ctx.loadTranscript();

  ctx.applySearchFilter("第一段");

  const rows = ctx.el("transcriptList").children[0].children;
  assert.equal(rows[0].hidden, false);
  assert.equal(rows[1].hidden, true, "没命中的行应该藏起来");
  assert.equal(ctx.el("searchCount").textContent, "1 条命中");

  ctx.applySearchFilter("");
  assert.equal(rows[1].hidden, false, "清空搜索后列表要完整回来");
  assert.equal(ctx.el("searchCount").textContent, "");
});

test("搜索能命中顺句稿和译文，不只搜原文", async () => {
  const ctx = createContext({
    transcript: transcriptResult({
      polished: { s1: "第一段，顺过了。" },
      translated: { s2: "Second line translated" },
    }),
  });
  ctx.state.bvid = "BV1xx411c7mD";
  await ctx.loadTranscript();

  // 用户眼里的文字是顺句稿/译文，搜不到等于「明明看得见却找不到」。
  ctx.applySearchFilter("顺过了");
  assert.equal(ctx.el("searchCount").textContent, "1 条命中");

  ctx.applySearchFilter("translated");
  assert.equal(ctx.el("searchCount").textContent, "1 条命中");
});

test("滚开或搜索时浮标出现，点击后回到当前句并复位", async () => {
  const ctx = createContext({ transcript: transcriptResult() });
  ctx.state.bvid = "BV1xx411c7mD";
  await ctx.loadTranscript();
  ctx.state.activeIndex = 1;

  // 用户刚滚动过 → 自动跟随暂停，浮标要给一条回来的路。
  ctx.state.lastUserScrollAt = Date.now();
  ctx.updateFollowPill();
  assert.equal(ctx.el("followPill").hidden, false);

  ctx.jumpToActive();
  assert.equal(ctx.el("followPill").hidden, true, "回来之后浮标该消失");
  assert.equal(ctx.state.lastUserScrollAt, 0, "点浮标等于明确表态要跟随");

  // 搜索期间同样给浮标：列表被过滤，回到当前句要先收搜索。
  ctx.applySearchFilter("第一段");
  ctx.updateFollowPill();
  assert.equal(ctx.el("followPill").hidden, false);
  ctx.jumpToActive();
  assert.equal(ctx.state.searchQuery, "", "从搜索跳回时应顺手收掉搜索");
});

test("换视频时上一个视频的搜索词不会带过来", async () => {
  const ctx = createContext({ transcript: transcriptResult() });
  ctx.state.bvid = "BV1xx411c7mD";
  await ctx.loadTranscript();

  ctx.applySearchFilter("第一段");
  assert.equal(ctx.state.searchQuery, "第一段");

  await ctx.loadTranscript();
  assert.equal(ctx.state.searchQuery, "", "新视频的列表不该被旧搜索词过滤");
});

// ============================================================
// 笔记与「本视频」的参照物
// ============================================================

test("不在播放页时，「本视频」不显示笔记也不发 getNotes 请求", async () => {
  const ctx = createContext({ transcript: transcriptResult() });
  ctx.state.bvid = null;
  ctx.state.notesScope = "video";

  await ctx.loadNotes();

  assert.ok(
    !ctx.sent.some((message) => message.action === "getNotes"),
    "没有「本视频」可参照时向 background 要 null，拿回来的是全部笔记，等于把别的视频的笔记冒充成本视频的",
  );
  assert.equal(ctx.el("notesEmpty").hidden, false);
  // 「没有视频」的描述必须与 idle 态完全一致，不能出现第二种说法。
  assert.equal(ctx.el("notesEmptyTitle").textContent, "打开一个 B 站视频");
  assert.equal(
    ctx.el("notesEmptyText").textContent,
    "在 bilibili.com 的播放页打开本面板，就能阅读该视频的字幕。",
  );
});

test("「全部」不受影响：不在播放页也能浏览历史笔记", async () => {
  const ctx = createContext({ transcript: transcriptResult() });
  ctx.state.bvid = null;
  ctx.state.notesScope = "all";

  await ctx.loadNotes();

  const request = ctx.sent.find((message) => message.action === "getNotes");
  assert.equal(request.bvid, null, "「全部」就该要全部");
  assert.equal(ctx.el("notesEmptyTitle").textContent, "还没有任何笔记");
});

test("本视频笔记请求携带当前分 P，避免同一 BV 的笔记串页", async () => {
  const ctx = createContext({ transcript: transcriptResult() });
  ctx.state.bvid = "BV1xx411c7mD";
  ctx.state.page = 3;
  ctx.state.notesScope = "video";

  await ctx.loadNotes();

  const request = ctx.sent.find((message) => message.action === "getNotes");
  assert.equal(request.bvid, "BV1xx411c7mD");
  assert.equal(request.page, 3);
});

test("金句按钮的「已保存」跟着笔记数据走：删除笔记后立刻解锁", async () => {
  // 该视频在 5 秒处已有一条笔记；概览金句 ANALYSIS.keyQuotes[0] 也在 0:05。
  const notes = [
    { bvid: "BV1xx411c7mD", page: 1, timestampSeconds: 5, id: "note_x" },
  ];
  const ctx = createContext({ transcript: transcriptResult({ analysis: ANALYSIS }) });
  const original = ctx.chrome.runtime.sendMessage;
  ctx.chrome.runtime.sendMessage = async (message) => {
    if (message.action === "getNotes") return { success: true, notes };
    return original(message);
  };
  ctx.state.bvid = "BV1xx411c7mD";

  await ctx.loadTranscript();

  // 章节卡的第 3 个孩子是嵌套金句卡；金句卡的第 3 个孩子是操作行，里面有存笔记按钮。
  const chapter = ctx.el("chapterList").children[0];
  const quoteCard = chapter.children[2];
  const saveBtn = quoteCard.children[2].children[0];

  assert.equal(saveBtn.textContent, "已保存", "该时刻已有笔记，按钮就该是已保存");
  assert.equal(saveBtn.disabled, true);

  // 笔记被删掉，重读数据后按钮解锁——不能还僵在「已保存」。
  notes.length = 0;
  await ctx.syncQuoteButtonsWithNotes();

  assert.equal(
    saveBtn.textContent,
    "存为笔记",
    "笔记删了，概览里的「已保存」必须跟着解锁，两处数据要同步",
  );
  assert.equal(saveBtn.disabled, false);
});

// ============================================================
// 笔记回看
// ============================================================

const NOTE = {
  id: "note_1",
  bvid: "BV1yy411c7mD",
  page: 1,
  timestamp: "1:05",
  timestampSeconds: 65,
  timestampedUrl: "https://www.bilibili.com/video/BV1yy411c7mD?t=65",
  text: "一条笔记",
  videoTitle: "另一个视频",
  ownerName: "别的 UP",
};

/** 卡片底部那行提示，renderNoteCard 把它放在最后。 */
const noticeOf = (card) => card.children[card.children.length - 1];

function findByClass(node, className) {
  if (String(node.className || "").split(/\s+/).includes(className)) return node;
  for (const child of node.children || []) {
    const found = findByClass(child, className);
    if (found) return found;
  }
  return null;
}

function findButtonByLabel(node, label) {
  if (
    node.tagName === "button" &&
    (node.textContent === label ||
      (node.children || []).some((child) => child.textContent === label))
  ) {
    return node;
  }
  for (const child of node.children || []) {
    const found = findButtonByLabel(child, label);
    if (found) return found;
  }
  return null;
}

test("笔记可以在卡片内编辑并保存", async () => {
  const ctx = createContext({ transcript: transcriptResult() });
  ctx.state.bvid = NOTE.bvid;
  const sent = [];
  ctx.chrome.runtime.sendMessage = async (message) => {
    sent.push(message);
    if (message.action === "updateNote") {
      return {
        success: true,
        note: { ...NOTE, text: "修改后的笔记", updatedAt: Date.now() },
      };
    }
    return { success: true };
  };

  const card = ctx.renderNoteCard({ ...NOTE });
  const edit = findButtonByLabel(card, "编辑");
  assert.ok(edit, "笔记操作区应提供编辑按钮");

  await edit.dispatch("click");
  const editor = findByClass(card, "note-editor");
  const textarea = findByClass(card, "note-editor-input");
  assert.equal(editor.hidden, false);
  assert.equal(textarea.value, NOTE.text);

  textarea.value = "  修改后的笔记  ";
  await findButtonByLabel(editor, "保存").dispatch("click");

  assert.equal(sent[0].action, "updateNote");
  assert.equal(sent[0].noteId, NOTE.id);
  assert.equal(sent[0].text, "修改后的笔记");
  assert.equal(findByClass(card, "entry-text").textContent, "修改后的笔记");
  assert.equal(editor.hidden, true);
});

test("点当前视频的笔记就地跳转，不开新标签页", async () => {
  const ctx = createContext({ transcript: transcriptResult() });
  ctx.state.bvid = "BV1xx411c7mD";
  ctx.state.tabId = 1;
  await ctx.loadTranscript();

  const note = { ...NOTE, bvid: "BV1xx411c7mD" };
  await ctx.playNote(note, noticeOf(ctx.renderNoteCard(note)));

  assert.deepEqual(ctx.seeks, [65]);
  assert.deepEqual(ctx.openedTabs, [], "同一个视频还开新标签页就是白开一个");
});

test("点别的视频的笔记，确认视频还在之后开新标签页", async () => {
  const ctx = createContext({ transcript: transcriptResult() });
  ctx.state.bvid = "BV1xx411c7mD";
  ctx.state.tabId = 1;
  await ctx.loadTranscript();

  await ctx.playNote(NOTE, noticeOf(ctx.renderNoteCard(NOTE)));

  assert.deepEqual(ctx.openedTabs, [NOTE.timestampedUrl], "链接要带上时间戳");
  assert.deepEqual(ctx.seeks, [], "别的视频没法在当前页跳转");
});

test("同一 BV 的其他分 P 笔记会打开对应页面，不在当前分 P 错误跳转", async () => {
  const ctx = createContext({ transcript: transcriptResult() });
  ctx.state.bvid = "BV1xx411c7mD";
  ctx.state.page = 1;
  ctx.state.tabId = 1;
  const note = {
    ...NOTE,
    bvid: "BV1xx411c7mD",
    page: 2,
    timestampedUrl: "https://www.bilibili.com/video/BV1xx411c7mD?p=2&t=65",
  };

  await ctx.playNote(note, noticeOf(ctx.renderNoteCard(note)));

  assert.deepEqual(ctx.seeks, []);
  assert.deepEqual(ctx.openedTabs, [note.timestampedUrl]);
});

test("后台还在润色的笔记，卡片上有「润色中」提示；僵尸标记不显示", async () => {
  const ctx = createContext({ transcript: transcriptResult() });
  ctx.state.bvid = "BV1xx411c7mD";
  await ctx.loadTranscript();

  // 刚保存、润色还没回来：要说一声，不然正文过几秒突然变了会让人纳闷。
  const fresh = noticeOf(
    ctx.renderNoteCard({ ...NOTE, pending: true, createdAt: Date.now() }),
  );
  assert.equal(fresh.hidden, false);
  assert.match(fresh.textContent, /润色/);

  // pending 卡了半天多半是润色中途 service worker 被回收，别永远挂着「润色中」。
  const stale = noticeOf(
    ctx.renderNoteCard({ ...NOTE, pending: true, createdAt: Date.now() - 10 * 60 * 1000 }),
  );
  assert.equal(stale.hidden, true);
});

test("视频已下架时给出提示，不再开标签页", async () => {
  const ctx = createContext({
    transcript: transcriptResult(),
    videoAvailable: { available: false, message: "视频已下架，无法查看原视频。" },
  });
  ctx.state.bvid = "BV1xx411c7mD";
  ctx.state.tabId = 1;
  await ctx.loadTranscript();

  const notice = noticeOf(ctx.renderNoteCard(NOTE));
  await ctx.playNote(NOTE, notice);

  assert.deepEqual(
    ctx.openedTabs,
    [],
    "笔记能留三十天，视频早没了还开标签页，用户要等整页加载完才知道",
  );
  assert.equal(notice.hidden, false);
  assert.match(notice.textContent, /已下架/);
});

test("生成失败只影响概览这一块，字幕仍然可读", async () => {
  const ctx = createContext({
    transcript: transcriptResult(),
    analysis: { success: false, message: "模型返回了空内容" },
  });
  ctx.state.bvid = "BV1xx411c7mD";
  await ctx.loadTranscript();

  await ctx.analyze();

  assert.equal(ctx.el("overviewLoading").hidden, true);
  assert.equal(ctx.el("overviewEmpty").hidden, false);
  assert.equal(
    ctx.state.view,
    "ready",
    "概览失败不该把整个面板打回错误态，字幕还在",
  );
});
