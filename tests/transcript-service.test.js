const test = require("node:test");
const assert = require("node:assert/strict");

const BVID = "BV1xx411c7mD";

// ---- 假 B 站 API（网络桩）：必须在 require 模块之前挂上全局，
// ---- 顶层的 typeof 守卫才会走注入分支。
const apiCalls = [];
globalThis.BILI_API = {
  parseBvid: (value) => (/BV[0-9A-Za-z]{10}/.test(String(value || "")) ? BVID : null),
  fetchVideoInfo: async () => {
    apiCalls.push("fetchVideoInfo");
    return { title: "测试视频", owner: { name: "UP 主" } };
  },
  fetchSubtitleTracks: async () => ({
    tracks: [
      { url: "https://subtitle.example/json", lang: "zh-CN", langLabel: "中文", isAi: false },
      { url: "https://subtitle.example/ai", lang: "ai-zh", langLabel: "AI 中文", isAi: true },
    ],
    needLogin: false,
  }),
  pickSubtitleTrack: (tracks) => tracks[0],
  fetchSubtitleTrackContent: async (url) => {
    apiCalls.push(`content:${url}`);
    // 生产里 bili-api 已把 B 站的 {from,to,content} 归一成 {start,duration,text}。
    return url.includes("json")
      ? [
          { start: 0, duration: 2, text: "第一句" },
          { start: 2, duration: 2, text: "第二句" },
        ]
      : [];
  },
};

const SERVICE_MODULE = require("../lib/transcript-service.js");
const LEARNING_STORE = require("../lib/learning-store.js");
const IDB = require("../lib/idb.js");
const { createMemoryIndexedDb } = require("./helpers/memory-idb.js");

function makeFakeCache(initial = {}) {
  const rows = new Map(Object.entries(initial));
  const calls = { load: 0, save: 0 };
  return {
    rows,
    calls,
    async load(bvid, { page = 1 } = {}) {
      calls.load += 1;
      const key = `${bvid}:p${page}`;
      return rows.has(key) ? structuredClone(rows.get(key)) : null;
    },
    async save(bvid, data, { page = 1 } = {}) {
      calls.save += 1;
      rows.set(`${bvid}:p${page}`, structuredClone(data));
      return true;
    },
  };
}

function makeHarness({ cache = makeFakeCache(), learningRecords = {} } = {}) {
  const idb = createMemoryIndexedDb();
  const learningRepo = LEARNING_STORE.createLearningRepository({
    driver: IDB.createObjectStoreDriver({ storeName: "learning", indexedDB: idb }),
  });
  const storageLike = {
    data: { ...learningRecords },
    async get(key) {
      if (key == null) return structuredClone(this.data);
      const out = {};
      for (const k of [].concat(key)) if (k in this.data) out[k] = structuredClone(this.data[k]);
      return out;
    },
    async set(entries) {
      Object.assign(this.data, structuredClone(entries));
    },
    async remove(key) {
      for (const k of [].concat(key)) delete this.data[k];
    },
  };

  // 迁移闸直接把散存的概览搬进仓储，等价于生产里迁移链的最终状态。
  const repo = LEARNING_STORE.createLearningRepository({
    driver: IDB.createObjectStoreDriver({ storeName: "learning", indexedDB: idb }),
  });

  const service = SERVICE_MODULE.createTranscriptService({
    cache,
    dataReady: async () => {},
    learningRepository: () => repo,
    getSettings: async () => ({ subtitleLangPreference: "" }),
    logDebug: () => {},
    logError: () => {},
  });
  return { service, repo, storageLike };
}

const baseDeps = () => makeHarness();

// ============================================================
// 获取管线
// ============================================================

test("无效 BV 号直接拒绝", async () => {
  const { service } = baseDeps();
  const result = await service.fetchTranscript("不是BV号");
  assert.equal(result.success, false);
  assert.equal(result.error, "INVALID_BVID");
});

test("缓存命中时不再走网络，脏标志被现算值覆盖", async () => {
  apiCalls.length = 0;
  const cache = makeFakeCache({
    [`${BVID}:p1`]: {
      transcript: [{ start: 0, text: "缓存句" }],
      success: false,
      fromCache: false,
    },
  });
  const { service } = makeHarness({ cache });

  const result = await service.fetchTranscript(BVID, { page: 1 });

  assert.equal(result.success, true);
  assert.equal(result.fromCache, true);
  assert.equal(apiCalls.length, 0, "命中缓存不应访问网络");
});

test("缓存里的概览过期后能从学习资料恢复", async () => {
  const analysis = { chapters: [{ title: "长期章节" }] };
  const harness = baseDeps();
  await harness.repo.commit({
    put: [{
      schemaVersion: 2,
      learningId: `${BVID}:p1`,
      bvid: BVID,
      page: 1,
      analysis,
      updatedAt: 1000,
    }],
  });
  const cache = makeFakeCache({
    [`${BVID}:p1`]: { transcript: [{ start: 0, text: "缓存句" }] },
  });

  const result = await harness.service.fetchTranscript(BVID, { page: 1 });

  assert.equal(result.analysisSource, "learning");
  assert.deepEqual(result.analysis, analysis);
  void cache;
});

test("无字幕轨区分需要登录与确实没有", async () => {
  globalThis.BILI_API.fetchSubtitleTracks = async () => ({
    tracks: [],
    needLogin: true,
  });
  const needLogin = await baseDeps().service.fetchTranscript(BVID);
  assert.equal(needLogin.error, "NEED_LOGIN");

  globalThis.BILI_API.fetchSubtitleTracks = async () => ({
    tracks: [],
    needLogin: false,
  });
  const noSubtitle = await baseDeps().service.fetchTranscript(BVID);
  assert.equal(noSubtitle.error, "NO_SUBTITLE");

  // 还原给后续用例。
  globalThis.BILI_API.fetchSubtitleTracks = async () => ({
    tracks: [
      { url: "https://subtitle.example/json", lang: "zh-CN", langLabel: "中文", isAi: false },
    ],
    needLogin: false,
  });
});

test("正常拉取组装全部字段并写入缓存", async () => {
  apiCalls.length = 0;
  const cache = makeFakeCache();
  const { service } = makeHarness({ cache });

  const result = await service.fetchTranscript(BVID, { page: 2 });

  assert.equal(result.success, true);
  assert.equal(result.fromCache, false);
  assert.equal(result.language, "zh-CN");
  assert.equal(result.isAiSubtitle, false);
  assert.equal(result.segments.length > 0, true);
  console.log("DEBUG:", JSON.stringify({ text: result.transcriptText, segs: result.segments?.length, keys: Object.keys(result) }));
  assert.ok(result.transcriptText.includes("第一句"));
  assert.equal(cache.calls.save, 1, "应落缓存");
  assert.equal(
    "success" in cache.rows.get(`${BVID}:p2`),
    false,
    "响应专用的标志不进缓存",
  );
});

test("forceRefresh 绕过缓存直接拉新", async () => {
  apiCalls.length = 0;
  const cache = makeFakeCache({
    [`${BVID}:p1`]: { transcript: [{ start: 0, text: "旧缓存" }] },
  });
  const { service } = makeHarness({ cache });

  const result = await service.fetchTranscript(BVID, { page: 1, forceRefresh: true });

  assert.equal(result.fromCache, false);
  assert.ok(apiCalls.includes("fetchVideoInfo"), "应重新访问网络");
});

test("网络层错误码原样透出", async () => {
  globalThis.BILI_API.fetchVideoInfo = async () => {
    const error = new Error("风控了");
    error.code = "RISK_CONTROL";
    throw error;
  };
  const { service } = baseDeps();
  const result = await service.fetchTranscript(BVID);
  assert.equal(result.success, false);
  assert.equal(result.error, "RISK_CONTROL");
});

// ============================================================
// 缓存读改写助手
// ============================================================

test("updateCache 并发串行合并，互不覆盖", async () => {
  const cache = makeFakeCache({
    [`${BVID}:p1`]: { transcript: [], segments: [] },
  });
  const { service } = makeHarness({ cache });

  await Promise.all([
    service.updateCache(BVID, 1, (current) => ({
      ...current,
      polished: [...(current.polished || []), "批A"],
    })),
    service.updateCache(BVID, 1, (current) => ({
      ...current,
      translated: [...(current.translated || []), "批B"],
    })),
  ]);

  const stored = cache.rows.get(`${BVID}:p1`);
  assert.equal(stored.polished?.length, 1);
  assert.equal(stored.translated?.length, 1);
});

test("persistable 剥离响应专用的标志字段", () => {
  const { service } = baseDeps();
  const cleaned = service.persistable({
    success: true,
    fromCache: true,
    videoInfo: { title: "标题" },
  });
  assert.deepEqual(cleaned, { videoInfo: { title: "标题" } });
});
