const test = require("node:test");
const assert = require("node:assert/strict");

const NOTES_SERVICE = require("../lib/notes-service.js");
const LEARNING_STORE = require("../lib/learning-store.js");
const NOTE_DB = require("../lib/note-db.js");
const IDB = require("../lib/idb.js");
const { createMemoryIndexedDb } = require("./helpers/memory-idb.js");

const BVID = "BV1xx411c7mD";
const TRANSCRIPT_FIXTURE = [
  { start: 0, text: "第一句话" },
  { start: 10, text: "第二句话" },
  { start: 20, text: "第三句话" },
];

/**
 * 构造服务与配套探针。
 * aiReply 可传函数以完全接管模型返回；传 null 表示请求应被拒之门外。
 */
function makeHarness({
  settingsValid = true,
  aiQuote = null,
  ensureTranscript,
} = {}) {
  const idb = createMemoryIndexedDb();
  const notesRepo = NOTE_DB.createNotesRepository({
    driver: NOTE_DB.createIndexedDbDriver({ indexedDB: idb }),
  });
  const learningRepo = LEARNING_STORE.createLearningRepository({
    driver: IDB.createObjectStoreDriver({ storeName: "learning", indexedDB: idb }),
  });

  const broadcasts = [];
  const promptCalls = [];
  const aiRequests = [];

  const service = NOTES_SERVICE.createNotesService({
    repositories: { notes: () => notesRepo, learning: () => learningRepo },
    dataReady: async () => {},
    ensureTranscript:
      ensureTranscript ||
      (async () => ({
        success: true,
        transcript: TRANSCRIPT_FIXTURE,
        videoInfo: { title: "测试视频", owner: "UP 主" },
      })),
    loadPromptSection: async (file, heading) => {
      promptCalls.push({ file, heading });
      return `提示词 ${file}/${heading}`;
    },
    requestAiCompletion: async ({ maxTokens }) => {
      aiRequests.push({ maxTokens });
      return { text: JSON.stringify({ quote: aiQuote ?? "" }) };
    },
    settingsValid: async () => settingsValid,
    broadcast: (message) => broadcasts.push(message),
  });

  return {
    service,
    notesRepo,
    learningRepo,
    broadcasts,
    promptCalls,
    aiRequests,
  };
}

async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

// ============================================================
// 保存
// ============================================================

test("保存笔记：正文来自命中那句，同秒重复保存去重", async () => {
  const h = makeHarness();

  const first = await h.service.saveNote({ bvid: BVID, page: 1, timestamp: 12 });
  assert.equal(first.success, true);
  assert.equal(first.note.text.includes("第二句话"), true);
  assert.equal(first.note.timestampedUrl.includes("t=12"), true);
  assert.equal(first.note.learningId, `${BVID}:p1`);

  const again = await h.service.saveNote({ bvid: BVID, page: 1, timestamp: 12 });
  assert.equal(again.duplicate, true);
  assert.equal(again.note.id, first.note.id);
  assert.equal((await h.notesRepo.all()).length, 1);
});

test("没有可用的字幕时明确报错", async () => {
  const h = makeHarness({
    ensureTranscript: async () => ({ success: true, transcript: [] }),
  });
  const result = await h.service.saveNote({ bvid: BVID, page: 1, timestamp: 5 });
  assert.equal(result.success, false);
  assert.equal(result.error, "NO_TRANSCRIPT");
});

test("配置可用时先落原始字幕再后台润色；不可用则直接落定", async () => {
  const polished = makeHarness({ settingsValid: true, aiQuote: "润色后的话" });
  const pendingSave = await polished.service.saveNote({
    bvid: BVID,
    page: 1,
    timestamp: 11,
  });
  assert.equal(pendingSave.note.pending, true);

  // 后台润色不阻塞保存返回，但最终会把正文换掉并清掉 pending。
  assert.equal(
    await waitFor(async () => {
      const [note] = await polished.notesRepo.all();
      return note.text === "润色后的话" && !note.pending;
    }),
    true,
    "润色完成后应替换正文",
  );

  const plain = makeHarness({ settingsValid: false });
  const direct = await plain.service.saveNote({
    bvid: BVID,
    page: 1,
    timestamp: 11,
  });
  assert.equal(direct.note.pending, false);
});

test("手动提供的文字不再过模型（概览里存为笔记的路径）", async () => {
  const h = makeHarness({ settingsValid: true, aiQuote: "不应出现" });
  const result = await h.service.saveNote({
    bvid: BVID,
    page: 1,
    timestamp: 3,
    text: "已经写好的话",
  });
  assert.equal(result.note.text, "已经写好的话");
  assert.equal(h.aiRequests.length, 0);
});

// ============================================================
// 编辑与 AI 候选
// ============================================================

test("编辑正文提升版本号并丢弃过期候选", async () => {
  const h = makeHarness();
  const saved = await h.service.saveNote({ bvid: BVID, page: 1, timestamp: 5 });

  const updated = await h.service.updateNote(saved.note.id, "  新正文  ");
  assert.equal(updated.note.text, "新正文");
  assert.equal(updated.note.revision, 2);
  assert.equal(updated.note.contentSource, "user");
  assert.equal(updated.note.aiDraft, undefined);

  const empty = await h.service.updateNote(saved.note.id, "  ");
  assert.equal(empty.error, "EMPTY_NOTE");
});

test("AI 候选只挂草稿不改正文，冲突标记正确", async () => {
  let releaseAi;
  const idb = createMemoryIndexedDb();
  const notesRepo = NOTE_DB.createNotesRepository({
    driver: NOTE_DB.createIndexedDbDriver({ indexedDB: idb }),
  });
  const gate = new Promise((resolve) => {
    releaseAi = resolve;
  });

  const service = NOTES_SERVICE.createNotesService({
    repositories: { notes: () => notesRepo, learning: () => notesRepo },
    dataReady: async () => {},
    ensureTranscript: async () => ({
      success: true,
      transcript: TRANSCRIPT_FIXTURE,
      videoInfo: { title: "标题" },
    }),
    loadPromptSection: async () => "提示词",
    requestAiCompletion: async () => {
      await gate;
      return { text: JSON.stringify({ quote: "候选正文" }) };
    },
    settingsValid: async () => true,
    broadcast: () => {},
  });

  const saved = await service.saveNote({ bvid: BVID, page: 1, timestamp: 6 });
  const generating = service.generateNoteDraft(saved.note.id);

  // 生成期间手动编辑：版本号前进，候选应当带 conflict 标记且不覆盖新正文。
  await service.updateNote(saved.note.id, "期间手动修改");
  releaseAi();
  const result = await generating;

  assert.equal(result.success, true);
  assert.equal(result.note.text, "期间手动修改");
  assert.equal(result.note.aiDraft.basedOnRevision, 1);
  assert.equal(result.note.aiDraft.conflict, true);
});

test("采纳候选：replace 覆盖、append 追加、discard 丢弃", async () => {
  const base = {
    bvid: BVID,
    text: "当前正文",
    createdAt: 1000,
    revision: 3,
    contentSource: "user",
  };

  // replace
  const replaced = makeHarness();
  await replaced.notesRepo.commit({
    put: [
      {
        ...base,
        id: "note_1",
        aiDraft: { text: "AI 候选", basedOnRevision: 3 },
      },
    ],
  });
  const viaReplace = await replaced.service.resolveNoteDraft(
    "note_1",
    "replace",
    3,
  );
  assert.equal(viaReplace.note.text, "AI 候选");
  assert.equal(viaReplace.note.revision, 4);
  assert.equal(viaReplace.note.contentSource, "ai");

  // append
  const appended = makeHarness();
  await appended.notesRepo.commit({
    put: [
      {
        ...base,
        id: "note_2",
        aiDraft: { text: "补充内容", basedOnRevision: 3 },
      },
    ],
  });
  const viaAppend = await appended.service.resolveNoteDraft(
    "note_2",
    "append",
    3,
  );
  assert.equal(viaAppend.note.text, "当前正文\n\n补充内容");
  assert.equal(viaAppend.note.contentSource, "user");

  // discard
  const discarded = makeHarness();
  await discarded.notesRepo.commit({
    put: [{ ...base, id: "note_3", aiDraft: { text: "候选" } }],
  });
  const viaDiscard = await discarded.service.resolveNoteDraft(
    "note_3",
    "discard",
    3,
  );
  assert.equal(viaDiscard.note.text, "当前正文");
  assert.equal(viaDiscard.note.revision, 3);
  assert.equal(viaDiscard.note.aiDraft, undefined);
});

test("版本号不一致时拒绝采纳，两边内容都不动", async () => {
  const h = makeHarness();
  await h.notesRepo.commit({
    put: [
      {
        id: "note_1",
        bvid: BVID,
        text: "更新后的正文",
        createdAt: 1000,
        revision: 4,
        contentSource: "user",
        aiDraft: { text: "旧候选", basedOnRevision: 3 },
      },
    ],
  });

  const result = await h.service.resolveNoteDraft("note_1", "replace", 3);
  assert.equal(result.success, false);
  assert.equal(result.error, "NOTE_CONFLICT");
  const [kept] = await h.notesRepo.all();
  assert.equal(kept.text, "更新后的正文");
  assert.equal(kept.aiDraft.text, "旧候选");
});

// ============================================================
// 备份导出导入
// ============================================================

test("备份导出包含笔记与概览，导入按较新时间合并", async () => {
  const h = makeHarness();
  await h.service.saveNote({ bvid: BVID, page: 1, timestamp: 7, text: "本机笔记" });
  await h.learningRepo.commit({
    put: [
      {
        schemaVersion: 2,
        learningId: `${BVID}:p1`,
        bvid: BVID,
        page: 1,
        analysis: { chapters: [{ title: "旧章" }] },
        updatedAt: 1000,
      },
    ],
  });

  const exported = await h.service.exportLearningBackup();
  assert.equal(exported.backup.notes.length, 1);
  assert.equal(exported.backup.learning.length, 1);

  const imported = await h.service.importLearningBackup({
    kind: LEARNING_STORE.BACKUP_KIND,
    schemaVersion: 2,
    notes: [
      { id: "cloud", bvid: BVID, text: "云端笔记", updatedAt: Date.now() + 9000 },
      {
        id: exported.backup.notes[0].id,
        text: "较新的同条",
        updatedAt: Date.now() + 5000,
      },
    ],
    learning: [
      {
        learningId: `${BVID}:p1`,
        bvid: BVID,
        page: 1,
        analysis: { chapters: [{ title: "新章" }] },
        updatedAt: 9000,
      },
    ],
  });

  assert.equal(imported.success, true);
  assert.equal(imported.notesAdded, 1);
  assert.equal(imported.notesUpdated, 1);
  const notes = await h.notesRepo.all();
  assert.equal(notes.length, 2);
  const shared = notes.find((note) => note.id === exported.backup.notes[0].id);
  assert.equal(shared.text, "较新的同条");
  const learning = await h.learningRepo.find(`${BVID}:p1`);
  assert.equal(learning.analysis.chapters[0].title, "新章");
});

test("无法识别的备份原样拒绝", async () => {
  const h = makeHarness();
  const result = await h.service.importLearningBackup({ notes: [] });
  assert.equal(result.success, false);
  assert.equal(result.error, "INVALID_BACKUP");
});
