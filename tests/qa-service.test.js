const test = require("node:test");
const assert = require("node:assert/strict");

const QA_SERVICE = require("../lib/qa-service.js");
const LEARNING_STORE = require("../lib/learning-store.js");
const IDB = require("../lib/idb.js");
const { createMemoryIndexedDb } = require("./helpers/memory-idb.js");

const TRANSCRIPT_FIXTURE = [{ start: 0, text: "字幕句子" }];
const SEGMENTS_FIXTURE = [{ id: "s0", start: 0, duration: 10, text: "字幕句子" }];

function makeService({ reply } = {}) {
  const idb = createMemoryIndexedDb();
  return QA_SERVICE.createQaService({
    cache: { load: async () => null },
    dataReady: async () => {},
    ensureTranscript: async () => ({
      success: true,
      transcript: TRANSCRIPT_FIXTURE,
      videoInfo: { title: "标题", owner: "UP" },
    }),
    learningRepository: () =>
      LEARNING_STORE.createLearningRepository({
        driver: IDB.createObjectStoreDriver({ storeName: "learning", indexedDB: idb }),
      }),
    getSettings: async () => ({}),
    repository: () =>
      QA_SERVICE.createQaRepository({
        driver: IDB.createObjectStoreDriver({ storeName: "qa", indexedDB: idb }),
      }),
    loadPromptSection: async (file, heading, vars) => vars.transcriptText ?? "p",
    requestAiCompletion: async () => ({ text: JSON.stringify(reply) }),
    aiErrorResponse: (error) => ({ success: false, error: error.message }),
  });
}

test("问答历史落库失败时，已生成的回答照常返回并如实标注", async () => {
  const service = QA_SERVICE.createQaService({
    cache: { load: async () => null },
    dataReady: async () => {},
    ensureTranscript: async () => ({
      success: true,
      transcript: TRANSCRIPT_FIXTURE,
      segments: SEGMENTS_FIXTURE,
      videoInfo: { title: "标题", duration: 60 },
    }),
    learningRepository: () => ({ find: async () => null }),
    getSettings: async () => ({}),
    loadPromptSection: async (file, heading, vars) => vars.transcriptText ?? "p",
    repository: () => ({
      save: async () => {
        throw new Error("磁盘满");
      },
      all: async () => [],
    }),
    requestAiCompletion: async () => ({ text: JSON.stringify({ answer: "结论 [0:00]" }) }),
    aiErrorResponse: (error) => ({ success: false, error: error.message }),
  });

  const result = await service.askQuestion({ bvid: "BV1xx411c7mD", page: 1, question: "结论？" });
  assert.equal(result.success, true, "落库失败不该吞掉已经生成、已经花了钱的回答");
  assert.equal(result.historySaved, false);
});

test("回答原样透传，不做二次加工", async () => {
  let captured = false;
  const idb = createMemoryIndexedDb();
  const service = QA_SERVICE.createQaService({
    cache: { load: async () => null },
    dataReady: async () => {},
    ensureTranscript: async () => ({
      success: true,
      transcript: TRANSCRIPT_FIXTURE,
      segments: SEGMENTS_FIXTURE,
      videoInfo: { title: "标题", duration: 60 },
    }),
    learningRepository: () =>
      LEARNING_STORE.createLearningRepository({
        driver: IDB.createObjectStoreDriver({ storeName: "learning", indexedDB: idb }),
      }),
    getSettings: async () => ({}),
    repository: () =>
      QA_SERVICE.createQaRepository({
        driver: IDB.createObjectStoreDriver({ storeName: "qa", indexedDB: idb }),
      }),
    loadPromptSection: async (file, heading, vars) => vars.transcriptText ?? "p",
    requestAiCompletion: async () => {
      captured = true;
      return { text: JSON.stringify({ answer: "  “结论 [0:02]。”  " }) };
    },
    aiErrorResponse: (error) => ({ success: false, error: error.message }),
  });

  const result = await service.askQuestion({ bvid: "BV1xx411c7mD", page: 1, question: "问题" });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(
    result.entry.answer,
    "  “结论 [0:02]。”  ",
    "模型输出原样保存，渲染层的样式归渲染层管",
  );
  assert.deepEqual(result.entry.citations, [
    { startSeconds: 2, quote: "字幕句子" },
  ], "依据由本地从字幕提取");
  assert.ok(captured);
});
