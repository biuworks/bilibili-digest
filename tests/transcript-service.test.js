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
      { url: "https://subtitle.example/en", lang: "en-US", langLabel: "英语", isAi: true },
    ],
    needLogin: false,
  }),
  pickSubtitleTrack: (tracks) => tracks[0],
  pickSubtitleTrackByLang: (tracks, lang) =>
    tracks.find((track) => track.lang === lang) || tracks[0],
  fetchSubtitleTrackContent: async (url) => {
    apiCalls.push(`content:${url}`);
    // 生产里 bili-api 已把 B 站的 {from,to,content} 归一成 {start,duration,text}。
    if (url.includes("/en")) {
      return [
        { start: 0, duration: 2, text: "First line" },
        { start: 2, duration: 2, text: "Second line" },
      ];
    }
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
  assert.match(noSubtitle.message, /没有 CC 字幕/);
  assert.match(noSubtitle.message, /烧录字幕/);

  // 还原给后续用例。
  globalThis.BILI_API.fetchSubtitleTracks = async () => ({
    tracks: [
      { url: "https://subtitle.example/json", lang: "zh-CN", langLabel: "中文", isAi: false },
      { url: "https://subtitle.example/ai", lang: "ai-zh", langLabel: "AI 中文", isAi: true },
      { url: "https://subtitle.example/en", lang: "en-US", langLabel: "英语", isAi: true },
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

test("指定 lang 走对应轨道：缓存语言不符时重新拉取", async () => {
  apiCalls.length = 0;
  const cache = makeFakeCache({
    [`${BVID}:p1`]: {
      transcript: [{ start: 0, text: "中文缓存句" }],
      language: "zh-CN",
      languageLabel: "中文",
    },
  });
  const { service } = makeHarness({ cache });

  const result = await service.fetchTranscript(BVID, { page: 1, lang: "en-US" });

  assert.equal(result.success, true);
  assert.equal(result.fromCache, false, "语言不符的缓存不应命中");
  assert.ok(apiCalls.includes("content:https://subtitle.example/en"), "应拉英文轨");
  assert.equal(result.language, "en-US");
  assert.equal(result.isAiSubtitle, true);
  assert.ok(result.transcriptText.includes("First line"));
  assert.equal(cache.rows.get(`${BVID}:p1`).language, "en-US", "缓存换成新语言");
});

test("同语言缓存仍可按 lang 命中", async () => {
  apiCalls.length = 0;
  const cache = makeFakeCache({
    [`${BVID}:p1`]: {
      transcript: [{ start: 0, text: "英文缓存句" }],
      language: "en-US",
      languageLabel: "英语",
    },
  });
  const { service } = makeHarness({ cache });

  const result = await service.fetchTranscript(BVID, { page: 1, lang: "en-US" });

  assert.equal(result.success, true);
  assert.equal(result.fromCache, true);
  assert.equal(apiCalls.length, 0);
});

test("列表暂时为空时用缓存里的轨道地址，不说成没有字幕", async () => {
  const originalList = globalThis.BILI_API.fetchSubtitleTracks;
  const originalContent = globalThis.BILI_API.fetchSubtitleTrackContent;
  apiCalls.length = 0;
  globalThis.BILI_API.fetchSubtitleTracks = async () => {
    apiCalls.push("list-empty");
    return { tracks: [], needLogin: false };
  };
  globalThis.BILI_API.fetchSubtitleTrackContent = async (url) => {
    apiCalls.push(`content:${url}`);
    return [{ start: 0, duration: 1, text: "English line" }];
  };
  try {
    const cache = makeFakeCache({
      [`${BVID}:p1`]: {
        transcript: [{ start: 0, text: "中文" }],
        language: "zh-CN",
        videoInfo: { cid: 9, title: "t", ownerMid: 1 },
        availableTracks: [
          { lang: "zh-CN", langLabel: "中文", isAi: false, url: "https://subtitle.example/json" },
          { lang: "en-US", langLabel: "English", isAi: false, url: "https://subtitle.example/en" },
        ],
      },
    });
    const result = await makeHarness({ cache }).service.fetchTranscript(BVID, { lang: "en-US" });
    assert.equal(result.success, true);
    assert.equal(result.error, undefined);
    assert.equal(result.language, "en-US");
    assert.match(result.transcriptText, /English line/);
    assert.equal(apiCalls.includes("list-empty"), false);
  } finally {
    globalThis.BILI_API.fetchSubtitleTracks = originalList;
    globalThis.BILI_API.fetchSubtitleTrackContent = originalContent;
  }
});

test("字幕下载失败不会被说成视频没有字幕", async () => {
  const originalList = globalThis.BILI_API.fetchSubtitleTracks;
  const originalContent = globalThis.BILI_API.fetchSubtitleTrackContent;
  globalThis.BILI_API.fetchSubtitleTracks = async () => ({
    tracks: [
      { url: "https://subtitle.example/en", lang: "en-US", langLabel: "English", isAi: false },
    ],
    needLogin: false,
  });
  globalThis.BILI_API.fetchSubtitleTrackContent = async () => {
    const error = new Error("字幕下载失败（HTTP 403）。");
    error.code = "SUBTITLE_DOWNLOAD_FAILED";
    throw error;
  };
  try {
    const result = await baseDeps().service.fetchTranscript(BVID, { lang: "en-US" });
    assert.equal(result.success, false);
    assert.equal(result.error, "SUBTITLE_DOWNLOAD_FAILED");
    assert.ok(Array.isArray(result.availableTracks));
    assert.match(result.message, /HTTP 403/);
  } finally {
    globalThis.BILI_API.fetchSubtitleTracks = originalList;
    globalThis.BILI_API.fetchSubtitleTrackContent = originalContent;
  }
});

test("简体正文为空时改用同语种里有内容的中文（中国），点名英文仍用英文", async () => {
  const originalList = globalThis.BILI_API.fetchSubtitleTracks;
  const originalContent = globalThis.BILI_API.fetchSubtitleTrackContent;
  const originalPick = globalThis.BILI_API.pickSubtitleTrack;
  const originalByLang = globalThis.BILI_API.pickSubtitleTrackByLang;
  globalThis.BILI_API.fetchSubtitleTracks = async () => ({
    tracks: [
      { url: "https://cdn.example/hans.json", lang: "zh-Hans", langLabel: "中文（简体）", isAi: false },
      { url: "https://cdn.example/cn.json", lang: "zh-CN", langLabel: "中文（中国）", isAi: false },
      { url: "https://cdn.example/en.json", lang: "en", langLabel: "English", isAi: false },
    ],
    needLogin: false,
  });
  globalThis.BILI_API.pickSubtitleTrack = (tracks) =>
    tracks.find((track) => track.lang === "zh-Hans") || tracks[0];
  globalThis.BILI_API.pickSubtitleTrackByLang = (tracks, lang) =>
    tracks.find((track) => track.lang === lang) || null;
  globalThis.BILI_API.fetchSubtitleTrackContent = async (url) => {
    if (String(url).includes("cn.json")) return [{ start: 0, duration: 1, text: "德谟克利特" }];
    if (String(url).includes("en.json")) return [{ start: 0, duration: 1, text: "atoms" }];
    return [];
  };
  try {
    const chinese = await baseDeps().service.fetchTranscript(BVID);
    assert.equal(chinese.success, true, chinese.message);
    assert.equal(chinese.language, "zh-CN");
    assert.match(chinese.transcriptText, /德谟克利特/);

    const english = await baseDeps().service.fetchTranscript(BVID, { lang: "en" });
    assert.equal(english.success, true, english.message);
    assert.equal(english.language, "en");
    assert.match(english.transcriptText, /atoms/);
    assert.doesNotMatch(english.transcriptText, /德谟克利特/);
  } finally {
    globalThis.BILI_API.fetchSubtitleTracks = originalList;
    globalThis.BILI_API.fetchSubtitleTrackContent = originalContent;
    globalThis.BILI_API.pickSubtitleTrack = originalPick;
    globalThis.BILI_API.pickSubtitleTrackByLang = originalByLang;
  }
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
