const test = require("node:test");
const assert = require("node:assert/strict");

const STORE = require("../lib/learning-store.js");

function memoryStorage(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
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

test("旧版裸数组笔记会原地迁移，并补齐可持续迭代的字段", async () => {
  const storage = memoryStorage({
    bili_digest_notes: [
      {
        id: "note_1",
        bvid: "BV1xx411c7mD",
        timestampSeconds: 65,
        text: "旧笔记",
        createdAt: 1000,
      },
    ],
  });

  const result = await STORE.ensureMigrated({ storage, now: 2000 });

  assert.equal(result.migrated, true);
  assert.equal(storage.data[STORE.META_KEY].schemaVersion, STORE.SCHEMA_VERSION);
  assert.deepEqual(storage.data[STORE.NOTES_KEY][0], {
    id: "note_1",
    bvid: "BV1xx411c7mD",
    timestampSeconds: 65,
    text: "旧笔记",
    createdAt: 1000,
    page: 1,
    updatedAt: 1000,
    learningId: "BV1xx411c7mD:p1",
  });
});

test("迁移可以重复执行，不会改写已迁移数据", async () => {
  const storage = memoryStorage({
    [STORE.META_KEY]: { schemaVersion: STORE.SCHEMA_VERSION, migratedAt: 1000 },
    [STORE.NOTES_KEY]: [{ id: "note_1", text: "已经迁移" }],
  });

  const result = await STORE.ensureMigrated({ storage, now: 9999 });

  assert.equal(result.migrated, false);
  assert.equal(storage.data[STORE.META_KEY].migratedAt, 1000);
  assert.deepEqual(storage.data[STORE.NOTES_KEY], [{ id: "note_1", text: "已经迁移" }]);
});

test("升级时把旧字幕缓存里的概览转存为长期学习记录", async () => {
  const analysis = { chapters: [{ title: "旧概览" }], keyQuotes: [] };
  const storage = memoryStorage({
    digest_BV1xx411c7mD_p3: {
      timestamp: 1000,
      videoInfo: { title: "分 P 标题", owner: "UP 主" },
      analysis,
    },
  });

  await STORE.ensureMigrated({ storage, now: 2000 });

  assert.deepEqual(storage.data[STORE.learningKey("BV1xx411c7mD", 3)], {
    schemaVersion: STORE.SCHEMA_VERSION,
    learningId: "BV1xx411c7mD:p3",
    bvid: "BV1xx411c7mD",
    page: 3,
    videoTitle: "分 P 标题",
    ownerName: "UP 主",
    analysis,
    updatedAt: 1000,
  });
  assert.ok(storage.data.digest_BV1xx411c7mD_p3, "原缓存仍应保留");
});

test("概览学习记录按 BV 号和分 P 长期保存，互不覆盖", async () => {
  const storage = memoryStorage();
  const analysis = { chapters: [{ title: "第一章" }], keyQuotes: [] };

  await STORE.saveLearningRecord(
    {
      bvid: "BV1xx411c7mD",
      page: 2,
      videoTitle: "视频标题",
      ownerName: "UP 主",
      analysis,
    },
    { storage, now: 3000 },
  );

  assert.equal(await STORE.loadLearningRecord("BV1xx411c7mD", 1, { storage }), null);
  assert.deepEqual(await STORE.loadLearningRecord("BV1xx411c7mD", 2, { storage }), {
    schemaVersion: STORE.SCHEMA_VERSION,
    learningId: "BV1xx411c7mD:p2",
    bvid: "BV1xx411c7mD",
    page: 2,
    videoTitle: "视频标题",
    ownerName: "UP 主",
    analysis,
    updatedAt: 3000,
  });
});
