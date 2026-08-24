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

test("剥掉模型包在回答外面的成对引号", async () => {
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
      return { text: JSON.stringify({ answer: "  “整段被引号包住的回答。”  ", citations: [] }) };
    },
    aiErrorResponse: (error) => ({ success: false, error: error.message }),
  });

  const result = await service.askQuestion({ bvid: "BV1xx411c7mD", page: 1, question: "问题" });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.entry.answer, "整段被引号包住的回答。");
  assert.ok(captured);
});
