const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const LEARNING_STORE = require("../lib/learning-store.js");
const CONCURRENCY = require("../lib/concurrency.js");
const TRANSCRIPT = require("../lib/transcript.js");
const AI = require("../lib/ai.js");
const SETTINGS = require("../settings.js");
const AI_PROVIDER = require("../lib/ai-provider.js");
const TASKS = require("../lib/task-manager.js");

const ROOT = path.join(__dirname, "..");
const BVID = "BV1xx411c7mD";

function memoryStorage(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    setAccessLevel: async () => {},
    async get(key) {
      if (key === null || key === undefined) return structuredClone(data);
      const keys = Array.isArray(key) ? key : [key];
      const result = {};
      for (const item of keys) {
        if (item in data) result[item] = structuredClone(data[item]);
      }
      return result;
    },
    async set(entries) {
      Object.assign(data, structuredClone(entries));
    },
    async remove(key) {
      for (const item of Array.isArray(key) ? key : [key]) delete data[item];
    },
  };
}

function createBackground({
  initial = {},
  cached = null,
  storage: suppliedStorage,
  aiReply = null,
} = {}) {
  const storage = suppliedStorage || memoryStorage(initial);
  if (aiReply !== null) {
    storage.data[SETTINGS.STORAGE_KEY] = {
      presetId: "custom",
      protocol: SETTINGS.PROTOCOLS.OPENAI,
      aiApiKey: "test-key",
      aiBaseUrl: "https://example.com/v1",
      aiModel: "test-model",
      aiConcurrency: 1,
      aiTimeoutSeconds: 30,
    };
  }
  let messageListener;
  const broadcasts = [];
  const context = {
    console,
    setTimeout,
    clearTimeout,
    AbortController,
    TextDecoder,
    fetch: async (url, options = {}) => {
      const target = String(url);
      if (target.startsWith("prompts/")) {
        const file = path.join(ROOT, target);
        return {
          ok: fs.existsSync(file),
          text: async () => fs.readFileSync(file, "utf8"),
        };
      }
      if (aiReply !== null) {
        const reply =
          typeof aiReply === "function" ? await aiReply({ url, options }) : String(aiReply);
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              choices: [{ message: { content: JSON.stringify({ quote: reply }) } }],
            }),
        };
      }
      throw new Error("测试不应访问网络");
    },
    importScripts() {},
    chrome: {
      storage: { local: storage },
      sidePanel: { setPanelBehavior: async () => {}, open: async () => {} },
      runtime: {
        getURL: (value) => value,
        openOptionsPage() {},
        onInstalled: { addListener() {} },
        onMessage: {
          addListener(listener) {
            messageListener = listener;
          },
        },
        sendMessage: async (message) => {
          broadcasts.push(message);
        },
      },
      permissions: { contains: async () => true },
    },
    BILI_LEARNING_STORE: LEARNING_STORE,
    BILI_CONCURRENCY: CONCURRENCY,
    BILI_TRANSCRIPT: TRANSCRIPT,
    BILI_CACHE: {
      load: async () => (cached ? structuredClone(cached) : null),
      save: async () => true,
    },
    BILI_API: {
      parseBvid: (value) => (String(value || "").includes("BV") ? BVID : null),
      canonicalVideoUrl: (bvid, seconds, page) =>
        `https://www.bilibili.com/video/${bvid}?p=${page}&t=${seconds}`,
      fetchVideoInfo: async () => ({ title: "标题", owner: { name: "UP 主" } }),
    },
    BILI_SETTINGS: SETTINGS,
    BILI_AI: AI,
    BILI_AI_PROVIDER: AI_PROVIDER,
    BILI_TASKS: TASKS,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "background.js"), "utf8"), context);

  async function send(message) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("消息没有回复")), 1000);
      messageListener(message, {}, (result) => {
        clearTimeout(timeout);
        resolve(result);
      });
    });
  }

  return { storage, send, broadcasts };
}

test("后台任务协议拒绝同目标重复任务，并支持查询与取消", async () => {
  const ctx = createBackground();
  const first = await ctx.send({
    action: "startAiTask",
    taskId: "analysis-1",
    kind: "analysis",
    bvid: BVID,
    page: 1,
  });
  const repeated = await ctx.send({
    action: "startAiTask",
    taskId: "analysis-2",
    kind: "analysis",
    bvid: BVID,
    page: 1,
  });

  assert.equal(first.success, true);
  assert.equal(repeated.error, "TASK_ALREADY_RUNNING");
  assert.equal(repeated.task.id, "analysis-1");

  const active = await ctx.send({ action: "getAiTasks" });
  assert.equal(active.tasks.length, 1);
  assert.equal(active.tasks[0].state, "running");

  const canceled = await ctx.send({ action: "cancelAiTask", taskId: "analysis-1" });
  assert.equal(canceled.success, true);
  assert.equal(canceled.task.state, "canceled");
  assert.ok(
    ctx.broadcasts.some(
      (message) => message.action === "aiTaskChanged" && message.task.state === "canceled",
    ),
  );
});

test("取消笔记优化会中止真实模型请求，且不会保存半成品候选", async () => {
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const ctx = createBackground({
    initial: {
      [LEARNING_STORE.NOTES_KEY]: [
        {
          id: "note_1",
          bvid: BVID,
          text: "需要优化的正文",
          createdAt: 1000,
          revision: 1,
        },
      ],
    },
    aiReply: ({ options }) =>
      new Promise((resolve, reject) => {
        markStarted();
        options.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
  });

  await ctx.send({
    action: "startAiTask",
    taskId: "note-task-1",
    kind: "note-refine",
    noteId: "note_1",
  });
  const generating = ctx.send({
    action: "generateNoteDraft",
    taskId: "note-task-1",
    noteId: "note_1",
  });
  await started;
  await ctx.send({ action: "cancelAiTask", taskId: "note-task-1" });
  const result = await generating;

  assert.equal(result.success, false);
  assert.equal(result.error, "TASK_CANCELED");
  assert.equal(ctx.storage.data[LEARNING_STORE.NOTES_KEY][0].aiDraft, undefined);
  assert.deepEqual((await ctx.send({ action: "getAiTasks" })).tasks, []);
});

test("首次读取笔记前完成旧数据迁移", async () => {
  const ctx = createBackground({
    initial: {
      [LEARNING_STORE.NOTES_KEY]: [
        { id: "note_1", bvid: BVID, text: "旧笔记", createdAt: 1000 },
      ],
    },
  });

  const result = await ctx.send({ action: "getNotes" });

  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.notes[0].page, 1);
  assert.equal(result.notes[0].updatedAt, 1000);
  assert.equal(result.notes[0].learningId, `${BVID}:p1`);
  assert.equal(
    ctx.storage.data[LEARNING_STORE.META_KEY].schemaVersion,
    LEARNING_STORE.SCHEMA_VERSION,
  );
});

test("本视频笔记按 BV 号和分 P 精确关联", async () => {
  const ctx = createBackground({
    initial: {
      [LEARNING_STORE.NOTES_KEY]: [
        { id: "p1", bvid: BVID, page: 1, text: "第一 P", createdAt: 1000 },
        { id: "p2", bvid: BVID, page: 2, text: "第二 P", createdAt: 1001 },
      ],
    },
  });

  const result = await ctx.send({ action: "getNotes", bvid: BVID, page: 2 });

  assert.equal(result.notes.length, 1);
  assert.equal(result.notes[0].id, "p2");
});

test("笔记正文可以更新，并记录更新时间", async () => {
  const ctx = createBackground({
    initial: {
      [LEARNING_STORE.NOTES_KEY]: [
        {
          id: "note_1",
          bvid: BVID,
          page: 1,
          text: "旧正文",
          createdAt: 1000,
          revision: 4,
          contentSource: "ai",
          aiDraft: { text: "过期候选", basedOnRevision: 4 },
        },
      ],
    },
  });

  const result = await ctx.send({
    action: "updateNote",
    noteId: "note_1",
    text: "  修改后的正文  ",
  });

  assert.equal(result.success, true);
  assert.equal(result.note.text, "修改后的正文");
  assert.equal(result.note.revision, 5);
  assert.equal(result.note.contentSource, "user");
  assert.equal(result.note.aiDraft, undefined);
  assert.ok(result.note.updatedAt >= result.note.createdAt);
  assert.equal(ctx.storage.data[LEARNING_STORE.NOTES_KEY][0].text, "修改后的正文");
});

test("AI 优化只生成候选，不直接覆盖当前笔记", async () => {
  const ctx = createBackground({
    initial: {
      [LEARNING_STORE.NOTES_KEY]: [
        {
          id: "note_1",
          bvid: BVID,
          page: 1,
          text: "用户修改过的正文",
          videoTitle: "测试视频",
          createdAt: 1000,
          revision: 3,
          contentSource: "user",
        },
      ],
    },
    aiReply: "AI 优化后的候选正文。",
  });

  const result = await ctx.send({ action: "generateNoteDraft", noteId: "note_1" });

  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.note.text, "用户修改过的正文");
  assert.equal(result.note.revision, 3);
  assert.equal(result.note.aiDraft.text, "AI 优化后的候选正文。");
  assert.equal(result.note.aiDraft.basedOnRevision, 3);
  assert.equal(result.note.aiDraft.conflict, false);
});

test("空笔记不会发起 AI 优化请求", async () => {
  let requested = false;
  const ctx = createBackground({
    initial: {
      [LEARNING_STORE.NOTES_KEY]: [
        { id: "note_1", bvid: BVID, text: "  ", createdAt: 1000, revision: 1 },
      ],
    },
    aiReply: () => {
      requested = true;
      return "不应生成";
    },
  });

  const result = await ctx.send({ action: "generateNoteDraft", noteId: "note_1" });

  assert.equal(result.success, false);
  assert.equal(result.error, "EMPTY_NOTE");
  assert.equal(requested, false);
});

test("AI 生成期间发生手动编辑时，候选标记冲突且不覆盖新正文", async () => {
  let markStarted;
  let releaseReply;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const ctx = createBackground({
    initial: {
      [LEARNING_STORE.NOTES_KEY]: [
        {
          id: "note_1",
          bvid: BVID,
          text: "发起时的正文",
          createdAt: 1000,
          revision: 1,
          contentSource: "user",
        },
      ],
    },
    aiReply: () =>
      new Promise((resolve) => {
        releaseReply = resolve;
        markStarted();
      }),
  });

  const generating = ctx.send({ action: "generateNoteDraft", noteId: "note_1" });
  await started;
  await ctx.send({ action: "updateNote", noteId: "note_1", text: "期间手动修改" });
  releaseReply("基于旧正文生成的候选");
  const result = await generating;

  assert.equal(result.note.text, "期间手动修改");
  assert.equal(result.note.revision, 2);
  assert.equal(result.note.aiDraft.basedOnRevision, 1);
  assert.equal(result.note.aiDraft.conflict, true);
});

test("用户明确确认后才用 AI 候选替换正文", async () => {
  const ctx = createBackground({
    initial: {
      [LEARNING_STORE.NOTES_KEY]: [
        {
          id: "note_1",
          bvid: BVID,
          text: "当前正文",
          createdAt: 1000,
          revision: 3,
          contentSource: "user",
          aiDraft: {
            text: "AI 候选",
            basedOnRevision: 3,
            createdAt: 2000,
            conflict: false,
          },
        },
      ],
    },
  });

  const result = await ctx.send({
    action: "resolveNoteDraft",
    noteId: "note_1",
    mode: "replace",
    expectedRevision: 3,
  });

  assert.equal(result.success, true);
  assert.equal(result.note.text, "AI 候选");
  assert.equal(result.note.revision, 4);
  assert.equal(result.note.contentSource, "ai");
  assert.equal(result.note.aiDraft, undefined);
});

test("AI 候选可以追加到当前笔记，也可以直接丢弃", async () => {
  const note = {
    id: "note_1",
    bvid: BVID,
    text: "当前正文",
    createdAt: 1000,
    revision: 2,
    contentSource: "user",
    aiDraft: { text: "补充内容", basedOnRevision: 2, createdAt: 2000 },
  };
  const appended = createBackground({
    initial: { [LEARNING_STORE.NOTES_KEY]: [note] },
  });

  const appendResult = await appended.send({
    action: "resolveNoteDraft",
    noteId: "note_1",
    mode: "append",
    expectedRevision: 2,
  });

  assert.equal(appendResult.success, true);
  assert.equal(appendResult.note.text, "当前正文\n\n补充内容");
  assert.equal(appendResult.note.revision, 3);
  assert.equal(appendResult.note.contentSource, "user");

  const discarded = createBackground({
    initial: { [LEARNING_STORE.NOTES_KEY]: [note] },
  });
  const discardResult = await discarded.send({
    action: "resolveNoteDraft",
    noteId: "note_1",
    mode: "discard",
    expectedRevision: 2,
  });

  assert.equal(discardResult.success, true);
  assert.equal(discardResult.note.text, "当前正文");
  assert.equal(discardResult.note.revision, 2);
  assert.equal(discardResult.note.aiDraft, undefined);
});

test("采用候选前正文又被修改时返回冲突，不覆盖任何内容", async () => {
  const ctx = createBackground({
    initial: {
      [LEARNING_STORE.NOTES_KEY]: [
        {
          id: "note_1",
          bvid: BVID,
          text: "更新后的正文",
          createdAt: 1000,
          revision: 4,
          contentSource: "user",
          aiDraft: {
            text: "旧候选",
            basedOnRevision: 3,
            createdAt: 2000,
            conflict: true,
          },
        },
      ],
    },
  });

  const result = await ctx.send({
    action: "resolveNoteDraft",
    noteId: "note_1",
    mode: "replace",
    expectedRevision: 3,
  });

  assert.equal(result.success, false);
  assert.equal(result.error, "NOTE_CONFLICT");
  assert.equal(ctx.storage.data[LEARNING_STORE.NOTES_KEY][0].text, "更新后的正文");
  assert.equal(ctx.storage.data[LEARNING_STORE.NOTES_KEY][0].aiDraft.text, "旧候选");
});

test("空正文和不存在的笔记不会被写入", async () => {
  const ctx = createBackground({
    initial: {
      [LEARNING_STORE.NOTES_KEY]: [
        { id: "note_1", bvid: BVID, text: "保留", createdAt: 1000 },
      ],
    },
  });

  const empty = await ctx.send({ action: "updateNote", noteId: "note_1", text: "  " });
  const missing = await ctx.send({
    action: "updateNote",
    noteId: "missing",
    text: "新正文",
  });

  assert.equal(empty.error, "EMPTY_NOTE");
  assert.equal(missing.error, "NOTE_NOT_FOUND");
  assert.equal(ctx.storage.data[LEARNING_STORE.NOTES_KEY][0].text, "保留");
});

test("超过 100 条后继续保存，不再静默删除最旧笔记", async () => {
  const existing = Array.from({ length: 100 }, (_, index) => ({
    id: `note_${index}`,
    bvid: BVID,
    page: 1,
    timestampSeconds: index,
    text: `笔记 ${index}`,
    createdAt: 1000 + index,
  }));
  const ctx = createBackground({
    initial: { [LEARNING_STORE.NOTES_KEY]: existing },
    cached: {
      transcript: [{ from: 0, to: 200, content: "字幕" }],
      videoInfo: { title: "标题", owner: "UP 主" },
    },
  });

  const result = await ctx.send({
    action: "saveNote",
    bvid: BVID,
    page: 1,
    timestamp: 101,
    text: "第 101 条",
  });

  assert.equal(result.success, true);
  assert.equal(ctx.storage.data[LEARNING_STORE.NOTES_KEY].length, 101);
  assert.ok(ctx.storage.data[LEARNING_STORE.NOTES_KEY].some((note) => note.id === "note_0"));
});

test("存储空间不足时明确报错，并保留已有笔记", async () => {
  const existing = Array.from({ length: 100 }, (_, index) => ({
    id: `note_${index}`,
    bvid: BVID,
    page: 1,
    timestampSeconds: index,
    text: `笔记 ${index}`,
    createdAt: 1000 + index,
  }));
  const storage = memoryStorage({ [LEARNING_STORE.NOTES_KEY]: existing });
  const set = storage.set.bind(storage);
  storage.set = async (entries) => {
    if (entries[LEARNING_STORE.NOTES_KEY]?.length > 100) {
      throw new Error("QUOTA_BYTES quota exceeded");
    }
    return set(entries);
  };
  const ctx = createBackground({
    storage,
    cached: {
      transcript: [{ from: 0, to: 200, content: "字幕" }],
      videoInfo: { title: "标题", owner: "UP 主" },
    },
  });

  const result = await ctx.send({
    action: "saveNote",
    bvid: BVID,
    page: 1,
    timestamp: 101,
    text: "放不下的笔记",
  });

  assert.equal(result.success, false);
  assert.equal(result.error, "STORAGE_FULL");
  assert.match(result.message, /空间/);
  assert.equal(storage.data[LEARNING_STORE.NOTES_KEY].length, 100);
});

test("字幕缓存没有概览时，会恢复长期保存的概览", async () => {
  const analysis = { chapters: [{ title: "长期章节" }], keyQuotes: [] };
  const learningKey = LEARNING_STORE.learningKey(BVID, 1);
  const ctx = createBackground({
    initial: {
      [learningKey]: {
        schemaVersion: LEARNING_STORE.SCHEMA_VERSION,
        learningId: `${BVID}:p1`,
        bvid: BVID,
        page: 1,
        analysis,
      },
    },
    cached: {
      transcript: [{ from: 0, to: 1, content: "字幕" }],
      segments: [{ id: "s1", start: 0, text: "字幕" }],
      videoInfo: { title: "标题" },
    },
  });

  const result = await ctx.send({ action: "fetchTranscript", bvid: BVID, page: 1 });

  assert.equal(result.success, true);
  assert.deepEqual(result.analysis, analysis);
  assert.equal(result.analysisSource, "learning");
});
