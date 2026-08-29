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
  let text = "";
  return {
    tagName: tag,
    className: "",
    hidden: false,
    disabled: false,
    style: {},
    dataset: {},
    children: [],
    attributes: {},
    // 与真实 DOM 一致：对 textContent 赋值会清掉全部子节点，
    // 否则「先清空再重渲染」的列表在测试里会残留旧节点。
    get textContent() {
      return text;
    },
    set textContent(value) {
      text = String(value ?? "");
      this.children.length = 0;
    },
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
    prepend(...nodes) {
      this.children.unshift(...nodes);
    },
    insertBefore(node) {
      this.children.push(node);
      return node;
    },
    contains(node) {
      return this === node || this.children.some((child) => child?.contains?.(node));
    },
    closest() {
      return null;
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 500, bottom: 500, width: 500, height: 500 };
    },
    remove() {},
    scrolled: false,
    scrollIntoView() {
      this.scrolled = true;
    },
    focus() {},
    click() {},
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

function createContext({
  transcript,
  analysis,
  videoAvailable = { available: true },
  notes = [],
  replies = {},
}) {
  const elements = new Map();
  const byId = (id) => {
    if (!elements.has(id)) elements.set(id, createElement("div"));
    return elements.get(id);
  };

  const sent = [];
  const openedTabs = [];
  const seeks = [];
  const downloads = [];
  const context = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    CSS: { escape: (value) => value },
    window: { getSelection: () => null, innerWidth: 500 },
    document: {
      getElementById: byId,
      createElement: (tag) => {
        const node = createElement(tag);
        if (tag === "a") {
          node.click = () => {
            downloads.push({ href: node.href, download: node.download });
          };
        }
        return node;
      },
      createElementNS: (namespace, tag) => createElement(tag),
      createDocumentFragment: () => createElement("#fragment"),
      querySelectorAll: () => [],
      querySelector: (selector) => selector === ".content" ? byId("content") : null,
      addEventListener() {},
      documentElement: { dataset: {} },
    },
    navigator: {
      clipboard: {
        writes: [],
        async writeText(text) {
          this.writes.push(text);
        },
      },
    },
    chrome: {
      runtime: {
        async sendMessage(message) {
          sent.push(message);
          if (replies[message.action]) {
            const reply = replies[message.action];
            return typeof reply === "function" ? await reply(message) : reply;
          }
          if (message.action === "fetchTranscript") return transcript;
          if (message.action === "analyzeTranscript") return analysis;
          if (message.action === "retryFailedAnalysis") {
            return {
              success: true,
              analysis: ANALYSIS,
              analysisFailures: [],
              failedChunks: 0,
            };
          }
          if (message.action === "translateSegments") {
            const translated = {};
            for (const id of message.segmentIds) translated[id] = `${id} 的译文`;
            return { success: true, translated };
          }
          if (message.action === "checkVideoAvailable") return videoAvailable;
          if (message.action === "getNotes") return { success: true, notes };
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
      storage: {
        local: { get: async () => ({}) },
        onChanged: { addListener() {} },
      },
    },
    BILI_TRANSCRIPT: require("../lib/transcript.js"),
    BILI_AI: require("../lib/ai.js"),
    BILI_CONCURRENCY: require("../lib/concurrency.js"),
    BILI_LEARNING_STORE: require("../lib/learning-store.js"),
    BILI_HIGHLIGHT: require("../lib/highlight.js"),
    BILI_QA_CITATIONS: require("../lib/qa-citations.js"),
    BILI_SETTINGS: require("../settings.js"),
    Blob,
    URL,
  };
  context.globalThis = context;

  vm.createContext(context);
  // sidepanel.js 顶层用的是 const，在 vm 里不会挂到全局对象上，
  // 所以在末尾追加一行，从同一个词法作用域里把要测的绑定递出来。
  const source = fs.readFileSync(path.join(ROOT, "sidepanel.js"), "utf8");
  vm.runInContext(
    `${source}\n;globalThis.__api = { state, loadTranscript, switchSubtitleLang, analyze, cancelAnalysis, cancelRewrite, segmentDisplayText, paintSegmentText, setTranscriptMode, selectionContext, onSelectionChange, applySearchFilter, updateFollowPill, jumpToActive, closeSearch, renderNoteCard, playNote, loadNotes, syncQuoteButtonsWithNotes, exportNotes, exportLearning, renderNotes, applyNotesSearch, renderAnalysis, sendToBackground, submitQuestion, onQaButtonClick, switchTab, appendAnswerText };`,
    context,
  );

  return {
    ...context.__api,
    el: byId,
    chrome: context.chrome,
    navigator: context.navigator,
    sent,
    openedTabs,
    seeks,
    downloads,
    window: context.window,
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
// service worker 被回收后的消息通道
// ============================================================

const UNREACHABLE = "Could not establish connection. Receiving end does not exist.";
const PORT_CLOSED = "The message port closed before a response was received.";

test("后台唤醒空窗期发出的消息会自动重发", async () => {
  const ctx = createContext({ transcript: transcriptResult() });
  let attempts = 0;
  ctx.chrome.runtime.sendMessage = async (message) => {
    attempts += 1;
    if (attempts < 3) throw new Error(UNREACHABLE);
    return { success: true, echoed: message.action };
  };

  const result = await ctx.sendToBackground({ action: "getNotes" });

  assert.equal(attempts, 3);
  assert.deepEqual(result, { success: true, echoed: "getNotes" });
});

test("通道中断后写操作不重发，避免重复扣费或多存一条笔记", async () => {
  const ctx = createContext({ transcript: transcriptResult() });
  let attempts = 0;
  ctx.chrome.runtime.sendMessage = async () => {
    attempts += 1;
    throw new Error(PORT_CLOSED);
  };

  await assert.rejects(() => ctx.sendToBackground({ action: "saveNote" }));
  assert.equal(
    attempts,
    1,
    "通道断开只说明没收到回复，后台可能已经执行过了，写操作重发会做第二遍",
  );
});

test("通道中断后只读操作仍会重发", async () => {
  const ctx = createContext({ transcript: transcriptResult() });
  let attempts = 0;
  ctx.chrome.runtime.sendMessage = async () => {
    attempts += 1;
    throw new Error(PORT_CLOSED);
  };

  await assert.rejects(() =>
    ctx.sendToBackground({ action: "getNotes" }, { idempotent: true }),
  );
  assert.equal(attempts, 3);
});

test("业务错误原样抛出，不做无谓重试", async () => {
  const ctx = createContext({ transcript: transcriptResult() });
  let attempts = 0;
  ctx.chrome.runtime.sendMessage = async () => {
    attempts += 1;
    throw new Error("这条笔记已经不存在了。");
  };

  await assert.rejects(() => ctx.sendToBackground({ action: "deleteNote" }));
  assert.equal(attempts, 1);
});

test("后台始终不可达时，不再把它伪装成字幕失败", async () => {
  const ctx = createContext({ transcript: transcriptResult() });
  ctx.state.bvid = "BV1xx411c7mD";
  ctx.chrome.runtime.sendMessage = async () => {
    throw new Error(UNREACHABLE);
  };

  await ctx.loadTranscript();

  assert.equal(ctx.el("errorTitle").textContent, "扩展后台未响应");
  assert.match(
    ctx.el("errorText").textContent,
    /与 B 站账号、AI 密钥和网络都无关/,
    "用户会照着提示去折腾密钥和梯子，必须先把这条路堵死",
  );
  assert.doesNotMatch(
    ctx.el("errorText").textContent,
    /Receiving end does not exist/,
    "浏览器的英文原文对用户没有任何指导意义",
  );
  assert.equal(ctx.el("errorLoginLink").hidden, true);
});

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

test("概览生成可取消，重复点击不会启动第二个任务", async () => {
  const ctx = createContext({ transcript: transcriptResult() });
  ctx.state.bvid = "BV1xx411c7mD";
  await ctx.loadTranscript();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const original = ctx.chrome.runtime.sendMessage;
  ctx.chrome.runtime.sendMessage = async (message) => {
    ctx.sent.push(message);
    if (message.action === "startAiTask") {
      return { success: true, task: { id: message.taskId, state: "running" } };
    }
    if (message.action === "analyzeTranscript") {
      await gate;
      return { success: false, error: "TASK_CANCELED", message: "任务已取消。" };
    }
    if (message.action === "cancelAiTask") {
      release();
      return { success: true, task: { id: message.taskId, state: "canceled" } };
    }
    return original(message);
  };

  const pending = ctx.analyze();
  await new Promise((resolve) => setImmediate(resolve));
  await ctx.analyze();
  await ctx.cancelAnalysis();
  await pending;

  assert.equal(ctx.sent.filter((message) => message.action === "startAiTask").length, 1);
  assert.equal(ctx.sent.filter((message) => message.action === "analyzeTranscript").length, 1);
  assert.equal(ctx.sent.filter((message) => message.action === "cancelAiTask").length, 1);
  assert.match(ctx.el("overviewEmpty").querySelector(".state-title").textContent, /取消/);
});

test("取消重新生成时恢复上一次概览，不让已有结果消失", async () => {
  const ctx = createContext({ transcript: transcriptResult({ analysis: ANALYSIS }) });
  ctx.state.bvid = "BV1xx411c7mD";
  await ctx.loadTranscript();
  const original = ctx.chrome.runtime.sendMessage;
  ctx.chrome.runtime.sendMessage = async (message) => {
    if (message.action === "startAiTask") return { success: true };
    if (message.action === "analyzeTranscript") {
      return { success: false, error: "TASK_CANCELED", message: "任务已取消。" };
    }
    return original(message);
  };

  await ctx.analyze({ force: true });

  assert.deepEqual(ctx.state.analysis, ANALYSIS);
  assert.equal(ctx.el("overviewResult").hidden, false);
  assert.equal(ctx.el("overviewEmpty").hidden, true);
  assert.match(ctx.el("overviewMeta").textContent, /保留上次结果/);
});

test("笔记卡片始终标出 UP 主，标题只在别的视频上出现", () => {
  const ctx = createContext({ transcript: transcriptResult() });
  ctx.state.bvid = NOTE.bvid;
  ctx.state.page = NOTE.page;
  const current = ctx.renderNoteCard(NOTE);
  assert.equal(findByClass(current, "note-source-owner").textContent, "别的 UP");
  assert.equal(findByClass(current, "note-source-title"), null);

  ctx.state.bvid = "BV1xx411c7mD";
  const away = ctx.renderNoteCard(NOTE);
  assert.equal(findByClass(away, "note-source-title").textContent, "另一个视频");
  assert.equal(findByClass(away, "note-source-owner").textContent, "别的 UP");
});

test("失败块会显示补入口，点击只发补失败块请求", async () => {
  const ctx = createContext({
    transcript: transcriptResult({
      analysis: ANALYSIS,
      analysisFailures: [{ index: 1, startSeconds: 300, endSeconds: 600 }],
    }),
  });
  ctx.state.bvid = "BV1xx411c7mD";
  await ctx.loadTranscript();
  assert.equal(ctx.el("retryFailedChunksBtn").hidden, false);
  assert.match(ctx.el("overviewMeta").textContent, /1 块失败/);

  const original = ctx.chrome.runtime.sendMessage;
  ctx.chrome.runtime.sendMessage = async (message) => {
    if (message.action === "startAiTask") {
      return { success: true, task: { id: message.taskId, state: "running" } };
    }
    if (message.action === "retryFailedAnalysis") {
      return {
        success: true,
        analysis: {
          ...ANALYSIS,
          chapters: [
            ...ANALYSIS.chapters,
            { timestamp: "5:00", timestampSeconds: 300, title: "后半", summary: "补上" },
          ],
        },
        analysisFailures: [],
      };
    }
    return original(message);
  };

  await ctx.analyze({ retryFailed: true });
  assert.equal(ctx.el("retryFailedChunksBtn").hidden, true);
  assert.match(ctx.el("overviewMeta").textContent, /2 章节/);
  assert.doesNotMatch(ctx.el("overviewMeta").textContent, /失败/);
});

test("侧边栏只保留顶部全局设置入口，不在功能菜单重复跳转", () => {
  const html = fs.readFileSync(path.join(ROOT, "sidepanel.html"), "utf8");
  assert.match(html, /id=["']cancelAnalysisBtn["']/);
  assert.match(html, /id=["']rewriteStopBtn["']/);
  assert.match(html, /id=["']optionsBtn["']/);
  assert.match(html, /id=["']reanalyzeBtn["']/);
  assert.match(html, /id=["']retryFailedChunksBtn["']/);
  assert.doesNotMatch(html, /id=["']overviewGenerateMenu["']/);
  assert.doesNotMatch(html, /id=["']overviewSettingsBtn["']/);
  assert.doesNotMatch(html, /id=["']transcriptSettingsBtn["']/);
  assert.doesNotMatch(html, />\s*(?:生成设置|处理设置)\s*</);
});

test("概览工具栏的文字选区不会触发划词解释浮层", () => {
  const ctx = createContext({ transcript: transcriptResult({ analysis: ANALYSIS }) });
  const selectedNode = createElement("span");
  selectedNode.parentElement = { closest: () => ctx.el("overviewPanel") };
  ctx.state.tab = "overview";
  ctx.el("explainTooltip").hidden = true;
  ctx.window.getSelection = () => ({
    isCollapsed: false,
    rangeCount: 1,
    anchorNode: selectedNode,
    toString: () => "3 章节 · 4 金句",
    getRangeAt: () => ({
      cloneRange() { return this; },
      getBoundingClientRect: () => ({ left: 20, top: 20, width: 120, height: 20 }),
    }),
  });

  ctx.onSelectionChange();

  assert.equal(ctx.el("explainTooltip").hidden, true);
});

// ============================================================
// 字幕语言切换：多条轨道时字幕徽章变下拉菜单
// ============================================================

const ZHVV_AI_TRACKS = [
  { lang: "zh-CN", langLabel: "中文", isAi: false },
  { lang: "ai-zh", langLabel: "中文", isAi: true },
  { lang: "en-US", langLabel: "英语", isAi: true },
];

test("多条字幕轨：徽章变成下拉菜单，点选后切换字幕语言", async () => {
  const replies = {
    fetchTranscript: async (message) => {
      if (message.lang === "en-US") {
        return transcriptResult({
          fromCache: false,
          language: "en-US",
          languageLabel: "英语（自动生成）",
          isAiSubtitle: true,
          availableTracks: ZHVV_AI_TRACKS,
        });
      }
      return transcriptResult({
        language: "zh-CN",
        languageLabel: "中文",
        isAiSubtitle: false,
        availableTracks: ZHVV_AI_TRACKS,
      });
    },
  };
  const ctx = createContext({ transcript: null, replies });
  ctx.state.bvid = "BV1xx411c7mD";

  await ctx.loadTranscript();

  const menu = ctx.el("subtitleMenu");
  assert.equal(menu.hidden, false, "多条轨道时应显示语言菜单");
  assert.equal(ctx.el("subtitleBadge").hidden, true, "badge 让位给菜单 summary");
  assert.equal(ctx.el("subtitleMenuLabel").textContent, "中文");
  const buttons = ctx.el("subtitleMenuPopover").children;
  assert.equal(buttons.length, 3);
  assert.equal(buttons[2].textContent, "英语 · AI");

  await buttons[2].dispatch("click");

  assert.equal(ctx.state.isChinese, false, "切到英文字幕应清掉中文态");
  assert.equal(ctx.el("subtitleMenuLabel").textContent, "英语（自动生成） · AI");
  const request = [...ctx.sent]
    .reverse()
    .find((message) => message.action === "fetchTranscript");
  assert.equal(request.lang, "en-US");
  assert.equal(request.forceRefresh, false, "切语言只指定 lang，不必强制绕过缓存");
});

test("只有一条字幕轨：照常显示徽章，不出现语言菜单", async () => {
  const ctx = createContext({
    transcript: transcriptResult({
      language: "zh-CN",
      languageLabel: "中文",
      isAiSubtitle: false,
      availableTracks: [{ lang: "zh-CN", langLabel: "中文", isAi: false }],
    }),
  });
  ctx.state.bvid = "BV1xx411c7mD";

  await ctx.loadTranscript();

  assert.equal(ctx.el("subtitleMenu").hidden, true);
  assert.equal(ctx.el("subtitleBadge").hidden, false);
  assert.equal(ctx.el("subtitleBadge").textContent, "中文");
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

test("字幕改写可停止，取消后不再继续启动新批次", async () => {
  const ctx = createContext({ transcript: transcriptResult() });
  ctx.state.bvid = NOTE.bvid;
  await ctx.loadTranscript();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  ctx.chrome.runtime.sendMessage = async (message) => {
    ctx.sent.push(message);
    if (message.action === "startAiTask") {
      return { success: true, task: { id: message.taskId, state: "running" } };
    }
    if (message.action === "translateSegments") {
      await gate;
      return { success: false, error: "TASK_CANCELED", message: "任务已取消。" };
    }
    if (message.action === "cancelAiTask") {
      release();
      return { success: true, task: { id: message.taskId, state: "canceled" } };
    }
    if (message.action === "finishAiTask") return { success: true };
    if (message.action === "updateAiTaskProgress") return { success: true };
    return { success: true };
  };

  const pending = ctx.setTranscriptMode("translated");
  await new Promise((resolve) => setImmediate(resolve));
  await ctx.cancelRewrite();
  await pending;

  assert.equal(ctx.sent.filter((message) => message.action === "startAiTask").length, 1);
  assert.equal(ctx.sent.filter((message) => message.action === "translateSegments").length, 1);
  assert.equal(ctx.sent.filter((message) => message.action === "cancelAiTask").length, 1);
  assert.equal(ctx.state.transcriptMode, "original");
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

test("工具栏动作区垂直居中，条数和导出按钮才会对齐", () => {
  const css = fs.readFileSync(path.join(ROOT, "sidepanel.css"), "utf8");
  assert.match(
    css,
    /\.panel-toolbar-actions\s*\{[^}]*align-items:\s*center/,
    "条数是 span、导出是按钮，缺了居中会被 stretch 拉成一高一低",
  );
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

test("AI 优化先展示候选，用户确认后才替换笔记", async () => {
  const ctx = createContext({ transcript: transcriptResult() });
  ctx.state.bvid = NOTE.bvid;
  const sent = [];
  ctx.chrome.runtime.sendMessage = async (message) => {
    sent.push(message);
    if (message.action === "generateNoteDraft") {
      return {
        success: true,
        note: {
          ...NOTE,
          revision: 3,
          contentSource: "user",
          aiDraft: {
            text: "AI 优化候选",
            basedOnRevision: 3,
            conflict: false,
          },
        },
      };
    }
    if (message.action === "resolveNoteDraft") {
      return {
        success: true,
        note: {
          ...NOTE,
          text: "AI 优化候选",
          revision: 4,
          contentSource: "ai",
        },
      };
    }
    return { success: true };
  };

  const card = ctx.renderNoteCard({
    ...NOTE,
    revision: 3,
    contentSource: "user",
  });
  await findButtonByLabel(card, "AI 优化").dispatch("click");

  assert.equal(sent[0].action, "startAiTask");
  assert.equal(sent[0].kind, "note-refine");
  assert.equal(sent[1].action, "generateNoteDraft");
  assert.equal(sent[1].taskId, sent[0].taskId);
  assert.equal(findByClass(card, "entry-text").textContent, NOTE.text);
  assert.equal(findByClass(card, "note-ai-draft").hidden, false);
  assert.equal(findByClass(card, "note-ai-draft-text").textContent, "AI 优化候选");

  await findButtonByLabel(card, "替换当前").dispatch("click");

  assert.equal(sent[2].action, "resolveNoteDraft");
  assert.equal(sent[2].mode, "replace");
  assert.equal(sent[2].expectedRevision, 3);
  assert.equal(findByClass(card, "entry-text").textContent, "AI 优化候选");
  assert.equal(findByClass(card, "note-ai-draft").hidden, true);
});

test("AI 笔记优化按钮运行时变成停止，重复点击会取消而不是重复生成", async () => {
  const ctx = createContext({ transcript: transcriptResult() });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const sent = [];
  ctx.chrome.runtime.sendMessage = async (message) => {
    sent.push(message);
    if (message.action === "startAiTask") return { success: true };
    if (message.action === "generateNoteDraft") {
      await gate;
      return { success: false, error: "TASK_CANCELED", message: "任务已取消。" };
    }
    if (message.action === "cancelAiTask") {
      release();
      return { success: true };
    }
    return { success: true };
  };

  const card = ctx.renderNoteCard({ ...NOTE, revision: 2 });
  const optimize = findButtonByLabel(card, "AI 优化");
  const pending = optimize.dispatch("click");
  await new Promise((resolve) => setImmediate(resolve));
  await optimize.dispatch("click");
  await pending;

  assert.equal(sent.filter((message) => message.action === "generateNoteDraft").length, 1);
  assert.equal(sent.filter((message) => message.action === "cancelAiTask").length, 1);
  assert.match(noticeOf(card).textContent, /已取消/);
  assert.equal(findByClass(card, "entry-text").textContent, NOTE.text);
});

test("基于旧版本生成的 AI 候选会明确提示冲突", () => {
  const ctx = createContext({ transcript: transcriptResult() });
  const card = ctx.renderNoteCard({
    ...NOTE,
    revision: 4,
    aiDraft: {
      text: "基于旧版本的建议",
      basedOnRevision: 3,
      conflict: true,
    },
  });

  const warning = findByClass(card, "note-ai-draft-warning");
  assert.equal(warning.hidden, false);
  assert.match(warning.textContent, /生成期间.*修改/);
});

test("确认 AI 候选发生版本冲突时同步显示后台返回的最新正文", async () => {
  const ctx = createContext({ transcript: transcriptResult() });
  ctx.state.bvid = NOTE.bvid;
  ctx.chrome.runtime.sendMessage = async (message) => {
    assert.equal(message.action, "resolveNoteDraft");
    assert.equal(message.mode, "replace");
    assert.equal(message.expectedRevision, 3);
    return {
      success: false,
      error: "NOTE_CONFLICT",
      message: "笔记已被其他操作更新，请确认最新内容后重试。",
      note: {
        ...NOTE,
        text: "并发保存的新正文",
        revision: 4,
        contentSource: "user",
        aiDraft: {
          text: "基于旧版本的 AI 候选",
          basedOnRevision: 3,
          conflict: true,
        },
      },
    };
  };

  const card = ctx.renderNoteCard({
    ...NOTE,
    text: "用户再次修改",
    revision: 3,
    contentSource: "user",
    aiDraft: {
      text: "基于旧版本的 AI 候选",
      basedOnRevision: 3,
      conflict: false,
    },
  });

  await findButtonByLabel(card, "替换当前").dispatch("click");

  assert.match(noticeOf(card).textContent, /笔记已被其他操作更新/);
  assert.equal(findByClass(card, "entry-text").textContent, "并发保存的新正文");
  assert.equal(findByClass(card, "note-ai-draft").hidden, false);
  assert.equal(
    findByClass(card, "note-ai-draft-text").textContent,
    "基于旧版本的 AI 候选",
  );
  assert.equal(findByClass(card, "note-ai-draft-warning").hidden, false);
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

test("笔记导出下载当前列表的 Markdown，空列表不写文件", () => {
  const ctx = createContext({ transcript: transcriptResult() });
  ctx.state.notesScope = "video";
  ctx.el("exportNotesBtn").textContent = "导出";

  ctx.exportNotes();
  assert.deepEqual(ctx.downloads, []);
  assert.equal(ctx.el("exportNotesBtn").textContent, "没有笔记");

  ctx.renderNotes([
    {
      ...NOTE,
      timestampSeconds: 90,
      timestamp: "1:30",
      text: "后记",
      aiDraft: { text: "不该出现" },
    },
    NOTE,
  ]);
  ctx.exportNotes();

  assert.equal(ctx.downloads.length, 1);
  assert.equal(ctx.downloads[0].download, "另一个视频-笔记.md");
});

test("「全部」范围导出用固定文件名，且不提供学习稿", () => {
  const ctx = createContext({ transcript: transcriptResult() });
  ctx.state.notesScope = "all";
  ctx.renderNotes([NOTE]);
  ctx.exportNotes();
  assert.equal(ctx.downloads[0].download, "bilibili-digest-笔记.md");
  assert.equal(ctx.el("exportLearningBtn").hidden, true);
  assert.equal(ctx.el("exportLearningTranscriptBtn").hidden, true);

  ctx.state.notesScope = "video";
  ctx.renderNotes([NOTE]);
  assert.equal(ctx.el("exportLearningBtn").hidden, false);
});

test("笔记搜索过滤当前列表，导出也只含匹配项", () => {
  const ctx = createContext({ transcript: transcriptResult() });
  ctx.state.notesScope = "video";
  ctx.renderNotes([
    NOTE,
    { ...NOTE, id: "other", text: "另一条关于结构", videoTitle: "第二课" },
  ]);
  ctx.applyNotesSearch("结构");
  assert.match(ctx.el("notesCount").textContent, /1\//);
  assert.equal(ctx.el("notesEmpty").hidden, true);

  // 命中的卡片里，正文命中处应包成 <mark>。桩的 querySelector 不查真实
  // 子树，直接遍历 children。
  function collectMarks(nodes, found = []) {
    for (const node of nodes) {
      if (node?.tagName === "mark") found.push(node);
      if (Array.isArray(node?.children)) collectMarks(node.children, found);
    }
    return found;
  }
  const marks = collectMarks(ctx.el("notesList").children);
  assert.ok(marks.length >= 1, "搜索命中应渲染出 mark 高亮");
  assert.equal(marks[0].textContent, "结构");

  ctx.exportNotes();
  assert.equal(ctx.downloads.length, 1);
  assert.equal(ctx.downloads[0].download, "第二课-笔记.md");

  ctx.applyNotesSearch("");
  assert.equal(
    collectMarks(ctx.el("notesList").children).length,
    0,
    "清空关键词后不应残留高亮",
  );

  ctx.applyNotesSearch("没有这种内容");
  assert.equal(ctx.el("notesEmptyTitle").textContent, "没有匹配的笔记");
});

test("学习稿会拉取当前视频笔记并写成 Markdown 文件名", async () => {
  const note = {
    ...NOTE,
    bvid: "BV1xx411c7mD",
    timestampSeconds: 5,
    timestamp: "0:05",
    text: "记下开场",
  };
  const ctx = createContext({ transcript: transcriptResult(), notes: [note] });
  ctx.state.bvid = "BV1xx411c7mD";
  ctx.state.tab = "overview";
  await ctx.loadTranscript();
  ctx.state.analysis = ANALYSIS;
  ctx.el("exportLearningBtn").textContent = "学习稿";

  await ctx.exportLearning();

  assert.equal(ctx.downloads.length, 1);
  assert.equal(ctx.downloads[0].download, "标题-学习稿.md");
  assert.ok(ctx.sent.some((message) => message.action === "getNotes"));
});

test("学习稿可附带当前字幕视图；空内容不写文件", async () => {
  const ctx = createContext({
    transcript: transcriptResult(),
    notes: [],
  });
  ctx.state.bvid = "BV1xx411c7mD";
  ctx.state.tab = "notes";
  ctx.state.notesScope = "video";
  await ctx.loadTranscript();
  ctx.state.analysis = null;
  ctx.renderNotes([]);
  ctx.el("exportLearningBtn").textContent = "学习稿";

  await ctx.exportLearning();
  assert.deepEqual(ctx.downloads, []);
  assert.equal(ctx.el("exportLearningBtn").textContent, "没有可导出的内容");

  await ctx.exportLearning({ includeTranscript: true });
  assert.equal(ctx.downloads.length, 1);
  assert.equal(ctx.downloads[0].download, "标题-学习稿.md");
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

test("提问后立即进入进行态：清输入、上占位卡，完成后替换为真卡", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const realEntry = {
    id: "qa_real",
    bvid: "BV1xx411c7mD",
    page: 1,
    question: "这个视频的结论是什么？",
    answer: "“结论在 [0:05]。”",
    citations: [{ startSeconds: 5, quote: "字幕原句" }],
    clickable: [5],
    createdAt: Date.now(),
  };
  const ctx = createContext({
    transcript: transcriptResult(),
    replies: {
      getQaHistory: async () => ({ success: true, entries: [] }),
      startAiTask: async () => ({ success: true }),
      askQuestion: async () => {
        await gate;
        return { success: true, entry: realEntry };
      },
    },
  });
  ctx.state.bvid = "BV1xx411c7mD";
  ctx.state.page = 1;
  ctx.switchTab("qa");
  // 等历史加载落地，避免它和提交竞态。
  await new Promise((resolve) => setTimeout(resolve, 0));

  ctx.el("qaInput").value = "  这个视频的结论是什么？  ";
  const pending = ctx.submitQuestion();

  // 同步阶段就能观察到：输入已清空，占位卡带 pending 样式。
  assert.equal(ctx.el("qaInput").value, "");
  const pendingCards = ctx.el("qaList").children.filter((card) =>
    card.className.includes("qa-pending"),
  );
  assert.equal(pendingCards.length, 1, "应有进行态占位卡");

  release();
  await pending;

  const cards = ctx.el("qaList").children;
  assert.equal(cards.length, 1, "占位卡应被真卡替换");
  assert.equal(cards[0].className.includes("qa-pending"), false);
  const questionNode = cards[0].children.find(
    (child) => child.className === "qa-question",
  );
  assert.match(questionNode.textContent, /结论是什么/);
  // 渲染层剥离成对引号：历史旧数据也能正常显示。
  const answerNode = cards[0].children.find(
    (child) => child.className === "entry-text",
  );
  assert.equal(answerNode.textContent.includes("“"), false);
});

test("问答失败时恢复输入并移除占位卡", async () => {
  const ctx = createContext({
    transcript: transcriptResult(),
    replies: {
      getQaHistory: async () => ({ success: true, entries: [] }),
      startAiTask: async () => ({ success: true }),
      askQuestion: async () => ({
        success: false,
        error: "NO_AI_CONFIG",
        message: "AI 还没配置好。",
      }),
    },
  });
  ctx.state.bvid = "BV1xx411c7mD";
  ctx.state.page = 1;
  ctx.switchTab("qa");
  await new Promise((resolve) => setTimeout(resolve, 0));

  ctx.el("qaInput").value = "会失败的问题";
  await ctx.submitQuestion();

  assert.equal(ctx.el("qaList").children.length, 0, "占位卡已移除");
  assert.equal(ctx.el("qaInput").value, "会失败的问题", "输入内容还给用户");
  assert.equal(ctx.el("qaHint").hidden, false);
  assert.match(ctx.el("qaHint").textContent, /还没配置好/);
});

test("生成中「停止」可点且发送取消，Enter 不承担取消", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const ctx = createContext({
    transcript: transcriptResult(),
    replies: {
      getQaHistory: async () => ({ success: true, entries: [] }),
      startAiTask: async () => ({ success: true }),
      askQuestion: async () => {
        await gate;
        return { success: false, error: "TASK_CANCELED" };
      },
      cancelAiTask: async () => ({ success: true }),
    },
  });
  ctx.state.bvid = "BV1xx411c7mD";
  ctx.state.page = 1;
  ctx.switchTab("qa");
  await new Promise((resolve) => setTimeout(resolve, 0));

  ctx.el("qaInput").value = "问一半想撤回";
  const pending = ctx.submitQuestion();
  // 让 startAiTask 的微任务落地，qaActiveTaskId 就位。
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(ctx.el("qaAskBtn").disabled, false, "生成中按钮不置灰，才点得到停止");
  assert.equal(ctx.el("qaAskBtn").textContent, "停止");

  // Enter 路径：进行中既不重复提问，也不取消。
  await ctx.submitQuestion();
  assert.equal(
    ctx.sent.filter((message) => message.action === "askQuestion").length,
    1,
    "Enter 不会重复提问",
  );

  // 静态按钮绑定挂在 DOMContentLoaded 里，桩环境不触发；按仓库惯例
  // 直接调用绑定的处理函数。
  await ctx.onQaButtonClick();
  assert.equal(
    ctx.sent.filter((message) => message.action === "cancelAiTask").length,
    1,
    "点停止应发送取消",
  );

  release();
  await pending;

  assert.match(ctx.el("qaHint").textContent, /已取消/);
  assert.equal(ctx.el("qaList").children.length, 0, "占位卡已移除");
});

test("问答卡片只有复制操作，且有成功反馈", async () => {
  const entry = {
    id: "qa_1",
    bvid: "BV1xx411c7mD",
    page: 1,
    question: "问题",
    answer: "回答正文",
    citations: [{ startSeconds: 30, quote: "引用原句" }],
    clickable: [30],
    createdAt: Date.now(),
  };
  const ctx = createContext({
    transcript: transcriptResult(),
    replies: {
      getQaHistory: async () => ({ success: true, entries: [entry] }),
    },
  });
  ctx.state.bvid = "BV1xx411c7mD";
  ctx.state.page = 1;
  ctx.switchTab("qa");
  await new Promise((resolve) => setTimeout(resolve, 0));

  const card = ctx.el("qaList").children[0];
  const actions = card.children.find((child) => child.className === "entry-actions");
  assert.equal(actions.children.length, 1, "只保留复制按钮");

  // 引用区折叠为一行摘要，展开才能看到原句。
  const citationsNode = card.children.find(
    (child) => child.className === "qa-citations",
  );
  assert.equal(citationsNode.tagName, "details");
  assert.equal(citationsNode.children[0].textContent, "字幕依据 · 1 条");

  await actions.children[0].dispatch("click");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(ctx.navigator.clipboard.writes, [
    "回答正文\n[0:30] 引用原句",
  ]);
  assert.equal(ctx.el("toast").hidden, false);
  assert.match(ctx.el("toast").textContent, /已复制/);
});


test("回答正文支持区间时间戳：显示区间、跳到起点", () => {
  const ctx = createContext({ transcript: transcriptResult() });
  const node = createElement("div");
  ctx.appendAnswerText(node, "依据见 [0:11-0:23] 与 [9:99] 越界", new Set([11]));

  const buttons = node.children.filter((child) => child.tagName === "button");
  assert.equal(buttons.length, 1, "越界的时间戳不渲染成按钮");
  assert.equal(buttons[0].textContent, "0:11-0:23");
  // 桩的 textContent 不聚合子节点，从 children 重建全文核对。
  const rendered = node.children
    .map((child) => (typeof child === "string" ? child : child.textContent))
    .join("");
  assert.equal(rendered, "依据见 0:11-0:23 与 [9:99] 越界");
});
