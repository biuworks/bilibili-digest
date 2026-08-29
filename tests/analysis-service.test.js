const test = require("node:test");
const assert = require("node:assert/strict");

const ANALYSIS_SERVICE = require("../lib/analysis-service.js");
const LEARNING_STORE = require("../lib/learning-store.js");
const AI_TRANSPORT = require("../lib/ai-transport.js");
const IDB = require("../lib/idb.js");
const { createMemoryIndexedDb } = require("./helpers/memory-idb.js");

const BVID = "BV1xx411c7mD";

// 两个长分段：short 模式（maxChars 3500）下必然切成两块。
// 第二段带 FAIL 标记，供按内容定向失败的用例使用。
function makeSegments() {
  return [
    { id: "s0", start: 0, duration: 120, text: `正常内容。${"字".repeat(1800)}` },
    { id: "s1", start: 150, duration: 120, text: `FAIL标记。${"字".repeat(1800)}` },
  ];
}

function makeHarness({ segments = makeSegments(), cached = null, aiHook = null } = {}) {
  const idb = createMemoryIndexedDb();
  const rows = new Map();
  if (cached) rows.set(`${BVID}:p1`, structuredClone(cached));

  const cache = {
    async load(bvid, { page = 1 } = {}) {
      const key = `${bvid}:p${page}`;
      return rows.has(key) ? structuredClone(rows.get(key)) : null;
    },
    async save(bvid, data, { page = 1 } = {}) {
      rows.set(`${bvid}:p${page}`, structuredClone(data));
      return true;
    },
    rows,
  };

  const learningRepo = LEARNING_STORE.createLearningRepository({
    driver: IDB.createObjectStoreDriver({ storeName: "learning", indexedDB: idb }),
  });

  const broadcasts = [];
  const progressCalls = [];
  const promptVariables = [];

  let failMode = null; // null | "marker" | "all"
  const service = ANALYSIS_SERVICE.createAnalysisService({
    cache,
    dataReady: async () => {},
    learningRepository: () => learningRepo,
    getSettings: async () => ({
      aiConcurrency: 2,
      analysisChunkMode: "short",
      analysisOverlapChars: 200,
    }),
    ensureTranscript: async () => ({
      success: true,
      videoInfo: { title: "测试视频", owner: "UP 主", duration: 600 },
      segments,
    }),
    updateCache: async (bvid, page, mutate) => {
      const current = rows.get(`${bvid}:p${page}`) || {};
      const next = mutate(current);
      rows.set(`${bvid}:p${page}`, structuredClone(next));
      return next;
    },
    persistable: (transcript) => {
      const { success, fromCache, ...rest } = transcript;
      return rest;
    },
    loadPromptSection: async (file, heading, variables) => {
      promptVariables.push({ file, heading, vars: variables });
      // 模拟真实模板替换：字幕正文必须进用户提示词，按内容定向失败的
      // 用例才成立。
      return `${file}/${heading}\n${variables?.transcriptText ?? ""}`;
    },
    requestAiCompletion: async ({ messages }) => {
      // 供用例在「生成期间」干预 live 缓存，模拟并发的顺句/翻译落库。
      if (aiHook) await aiHook(cache);
      if (failMode === "all") throw Object.assign(new Error("密钥坏了"), { code: "NO_AI_CONFIG" });
      const user = messages.find((m) => m.role === "user")?.content || "";
      if (failMode === "marker" && user.includes("FAIL标记")) {
        throw new Error("偶发超时");
      }
      // 从用户提示词里取本块起点，产出落在合法区间的章节。
      const match = /第 (\d+) \/ (\d+) 段/.exec(user);
      void match;
      const startMatch = /minTimestampSeconds["']?\s*[:=]\s*(\d+)/.exec(user);
      void startMatch;
      // 变量是模板替换进文本的，这里退而求其次：从提示词里抠不出就用 0。
      const seconds = Number(promptVariables.at(-1)?.vars?.minTimestampSeconds ?? 0);
      return {
        text: JSON.stringify({
          chapters: [
            { title: `章@${seconds}`, timestampSeconds: seconds + 1, summary: "摘要" },
          ],
          keyQuotes: [],
        }),
      };
    },
    aiErrorResponse: AI_TRANSPORT.aiErrorResponse,
    broadcast: (message) => broadcasts.push(message),
    onTaskProgress: (taskId, patch) => progressCalls.push({ taskId, patch }),
    logDebug: () => {},
    logError: () => {},
  });

  return {
    service,
    cache,
    learningRepo,
    broadcasts,
    progressCalls,
    promptVariables,
    setFailMode: (mode) => {
      failMode = mode;
    },
  };
}

test("无效 BV 号直接拒绝", async () => {
  const h = makeHarness();
  const result = await h.service.analyzeTranscript("不是BV号");
  assert.equal(result.success, false);
  assert.equal(result.error, "INVALID_BVID");
});

test("缓存里已有概览时直接返回，不再请求模型", async () => {
  const h = makeHarness({
    cached: {
      transcript: [{ start: 0, text: "x" }],
      analysis: { chapters: [{ title: "旧概览" }], keyQuotes: [] },
      analysisFailures: [{ index: 0, startSeconds: 0, endSeconds: 10 }],
    },
  });
  const result = await h.service.analyzeTranscript(BVID);
  assert.equal(result.fromCache, true);
  assert.equal(result.analysis.chapters[0].title, "旧概览");
  assert.equal(result.failedChunks, 1);
});

test("字幕缓存过期后从学习资料恢复概览", async () => {
  const h = makeHarness();
  await h.learningRepo.commit({
    put: [{
      schemaVersion: 2,
      learningId: `${BVID}:p1`,
      bvid: BVID,
      page: 1,
      analysis: { chapters: [{ title: "长期" }], keyQuotes: [] },
      updatedAt: 1000,
    }],
  });
  const result = await h.service.analyzeTranscript(BVID);
  assert.equal(result.analysisSource, "learning");
  assert.equal(result.analysis.chapters[0].title, "长期");
});

test("没有可用分块时报无字幕", async () => {
  const h = makeHarness({ segments: [] });
  const result = await h.service.analyzeTranscript(BVID);
  assert.equal(result.error, "NO_TRANSCRIPT");
});

test("两块全部成功：落缓存与学习资料，失败数为零", async () => {
  const h = makeHarness();
  const result = await h.service.analyzeTranscript(BVID);

  assert.equal(result.success, true);
  assert.equal(result.chunkCount, 2);
  assert.equal(result.failedChunks, 0);
  const stored = h.cache.rows.get(`${BVID}:p1`);
  assert.equal(stored.analysis.chapters.length >= 1, true);
  const record = await h.learningRepo.find(`${BVID}:p1`);
  assert.ok(record.analysis);
});

test("概览落库不回滚生成期间新写入的顺句缓存", async () => {
  // 任务开始时的快照只顺到 s0；生成期间顺句批次把 s1 也写进了 live 缓存。
  // 旧展开顺序（current 在前）会用快照里的旧 polished 盖掉新条目。
  const h = makeHarness({
    cached: {
      transcript: [{ start: 0, text: "x" }],
      segments: makeSegments(),
      videoInfo: { title: "测试视频", owner: "UP 主", duration: 600 },
      polished: { s0: "已顺的 s0" },
    },
    aiHook: (cache) => {
      const row = cache.rows.get(`${BVID}:p1`);
      row.polished = { s0: "已顺的 s0", s1: "新顺的 s1" };
    },
  });

  const result = await h.service.analyzeTranscript(BVID, { forceRefresh: true });

  assert.equal(result.success, true);
  const stored = h.cache.rows.get(`${BVID}:p1`);
  assert.equal(stored.polished.s1, "新顺的 s1", "生成期间的新顺句不被旧快照回滚");
  assert.equal(stored.polished.s0, "已顺的 s0");
  assert.ok(stored.analysis.chapters.length > 0, "概览本身正常写入");
});

test("单块持续失败仍出结果，并如实记录失败区间", async () => {
  const h = makeHarness();
  h.setFailMode("marker");

  const result = await h.service.analyzeTranscript(BVID);

  assert.equal(result.success, true, "部分失败也要给出已完成的概览");
  assert.equal(result.failedChunks, 1);
  const record = await h.learningRepo.find(`${BVID}:p1`);
  assert.equal(record.analysisFailures.length, 1);
  assert.ok(record.analysisFailures[0].startSeconds > 0);
});

test("全军覆没时透出第一个真实错误", async () => {
  const h = makeHarness();
  h.setFailMode("all");
  const result = await h.service.analyzeTranscript(BVID);
  assert.equal(result.success, false);
  assert.equal(result.error, "NO_AI_CONFIG", "配置错误应原样告诉用户");
});

test("补失败块只请求失败区间，成功后清空记录", async () => {
  const h = makeHarness();
  // 先制造一份带失败区间的概览。
  h.setFailMode("marker");
  await h.service.analyzeTranscript(BVID);
  h.setFailMode(null);

  const before = h.promptVariables.filter((v) => v.file === "analysis.md").length;
  const result = await h.service.retryFailedAnalysis(BVID);

  assert.equal(result.success, true);
  assert.equal(result.failedChunks, 0);
  const after = h.promptVariables.filter((v) => v.file === "analysis.md").length;
  assert.equal(after - before <= 2, true, "自动补轮至多重试一次");
  const record = await h.learningRepo.find(`${BVID}:p1`);
  assert.equal(record.analysisFailures, undefined);
});

test("还没有概览时补失败块明确拒绝", async () => {
  const h = makeHarness();
  const result = await h.service.retryFailedAnalysis(BVID);
  assert.equal(result.error, "NO_ANALYSIS");
});
