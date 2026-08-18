const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const LEARNING_STORE = require("../lib/learning-store.js");
const CONCURRENCY = require("../lib/concurrency.js");
const TRANSCRIPT = require("../lib/transcript.js");

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

function createBackground({ initial = {}, cached = null, storage: suppliedStorage } = {}) {
  const storage = suppliedStorage || memoryStorage(initial);
  let messageListener;
  const context = {
    console,
    setTimeout,
    clearTimeout,
    fetch: async () => {
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
        sendMessage: async () => {},
      },
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
    BILI_SETTINGS: {
      STORAGE_KEY: "bili_digest_settings",
      normalize: (value) => value || {},
      validate: () => ({ ok: false }),
    },
    BILI_AI: {},
    BILI_AI_PROVIDER: {},
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

  return { storage, send };
}

test("首次读取笔记前完成旧数据迁移", async () => {
  const ctx = createBackground({
    initial: {
      [LEARNING_STORE.NOTES_KEY]: [
        { id: "note_1", bvid: BVID, text: "旧笔记", createdAt: 1000 },
      ],
    },
  });

  const result = await ctx.send({ action: "getNotes" });

  assert.equal(result.success, true);
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
        { id: "note_1", bvid: BVID, page: 1, text: "旧正文", createdAt: 1000 },
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
  assert.ok(result.note.updatedAt >= result.note.createdAt);
  assert.equal(ctx.storage.data[LEARNING_STORE.NOTES_KEY][0].text, "修改后的正文");
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
