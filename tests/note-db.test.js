const test = require("node:test");
const assert = require("node:assert/strict");

const NOTE_DB = require("../lib/note-db.js");
const LEARNING_STORE = require("../lib/learning-store.js");
const { createMemoryIndexedDb } = require("./helpers/memory-idb.js");
const { memoryStorage } = require("./helpers/memory-storage.js");

const makeStorage = memoryStorage;

function note(id, overrides = {}) {
  return { id, text: `笔记 ${id}`, createdAt: 1000, ...overrides };
}

test("IndexedDB 打开失败后允许重连：瞬时故障不毒化整个生命周期", async () => {
  const realIdb = createMemoryIndexedDb();
  let shouldFail = true;
  const flakyIdb = {
    open(name, version) {
      if (shouldFail) {
        const request = { onupgradeneeded: null, onsuccess: null, onerror: null, result: null };
        queueMicrotask(() => request.onerror?.({ target: request }));
        return request;
      }
      return realIdb.open(name, version);
    },
  };
  const driver = NOTE_DB.createIndexedDbDriver({ indexedDB: flakyIdb });

  await assert.rejects(() => driver.count(), { message: "IndexedDB 打开失败" });
  shouldFail = false; // 磁盘/连接恢复
  assert.equal(await driver.count(), 0, "被拒绝的打开 promise 不能被永久缓存");
});

// ============================================================
// 内存驱动
// ============================================================

test("内存驱动的读写与拷贝隔离", async () => {
  const driver = NOTE_DB.createMemoryDriver([note("a")]);
  const rows = await driver.getAll();
  assert.equal(rows.length, 1);

  // 改动返回值不得影响库内数据：与 IndexedDB 的反序列化语义一致。
  rows[0].text = "被篡改";
  assert.equal((await driver.get("a")).text, "笔记 a");

  await driver.write({ put: [note("b", { createdAt: 2000 })], remove: ["a"] });
  assert.deepEqual(
    (await driver.getAll()).map((row) => row.id),
    ["b"],
  );
  assert.equal(await driver.count(), 1);
});

// ============================================================
// 真实 IndexedDB 驱动（跑在假 IndexedDB 上）
// ============================================================

test("IndexedDB 驱动：建库、写入、读取、删除走完整事件链", async () => {
  const indexedDB = createMemoryIndexedDb();
  const driver = NOTE_DB.createIndexedDbDriver({ indexedDB });

  assert.equal(await driver.count(), 0);
  await driver.write({
    put: [note("a", { createdAt: 1 }), note("b", { createdAt: 2 })],
  });
  assert.equal(await driver.count(), 2);

  const found = await driver.get("a");
  assert.equal(found.text, "笔记 a");
  assert.equal(await driver.get("missing"), undefined);

  // 同一个连接上再开事务，升级事件重复派发也不能重建仓库或丢数据。
  await driver.write({ put: [note("c")] });
  await driver.write({ remove: ["a"] });
  assert.deepEqual(
    (await driver.getAll()).map((row) => row.id).sort(),
    ["b", "c"],
  );

  // 空 write 是合法的空操作。
  await driver.write({});
  await driver.write({ put: [], remove: [] });
  assert.equal(await driver.count(), 2);
});

test("IndexedDB 驱动：事务失败时整体回滚且抛出原始错误", async () => {
  const indexedDB = createMemoryIndexedDb();
  const driver = NOTE_DB.createIndexedDbDriver({ indexedDB });
  await driver.write({ put: [note("a")] });

  const failure = new Error("模拟磁盘配额耗尽");
  indexedDB.__failNextWrite(failure);

  await assert.rejects(
    () => driver.write({ put: [note("b")], remove: ["a"] }),
    (error) => error === failure,
  );
  // 回滚后旧数据原封不动。
  assert.deepEqual(
    (await driver.getAll()).map((row) => row.id),
    ["a"],
  );
});

test("IndexedDB 驱动：没有 indexedDB 全局时报错而不是悬空", async () => {
  assert.throws(
    () => NOTE_DB.createIndexedDbDriver({ indexedDB: undefined }),
    /IndexedDB/,
  );
});

test("IndexedDB 驱动：同一连接上的并发事务各自成立", async () => {
  const indexedDB = createMemoryIndexedDb();
  const driver = NOTE_DB.createIndexedDbDriver({ indexedDB });

  // mutateNotes 的串行队列之外，导出 / 导入也会与写路径并发触达驱动。
  await Promise.all([
    driver.write({ put: [note("a")] }),
    driver.getAll(),
    driver.write({ put: [note("b")] }),
  ]);
  assert.equal(await driver.count(), 2);
});

// ============================================================
// 仓储层
// ============================================================

test("仓储层过滤坏记录并按创建时间倒序", async () => {
  const driver = NOTE_DB.createMemoryDriver([
    note("old", { createdAt: 100 }),
    null,
    { nope: true },
    note("new", { createdAt: 300 }),
    note("mid", { createdAt: 200 }),
    "junk",
  ]);
  const repository = NOTE_DB.createNotesRepository({ driver });

  assert.deepEqual(
    (await repository.all()).map((row) => row.id),
    ["new", "mid", "old"],
  );
  assert.equal((await repository.find("mid")).text, "笔记 mid");
  assert.equal(await repository.find("missing"), null);
  assert.equal(await repository.count(), 3);

  await repository.commit({ put: [note("newer", { createdAt: 400 })], remove: ["old"] });
  assert.deepEqual(
    (await repository.all()).map((row) => row.id),
    ["newer", "new", "mid"],
  );
});

// ============================================================
// 一次性迁移
// ============================================================

test("迁移把旧笔记搬进 IndexedDB，成功后才删旧 key 并记标记", async () => {
  const storage = makeStorage({
    [LEARNING_STORE.META_KEY]: { schemaVersion: 2, migratedAt: 1 },
    [LEARNING_STORE.NOTES_KEY]: [
      note("n1", { createdAt: 30 }),
      note("n2", { createdAt: 10 }),
    ],
  });
  const repository = NOTE_DB.createNotesRepository({
    driver: NOTE_DB.createMemoryDriver(),
  });

  const result = await NOTE_DB.ensureNotesInIdb({
    storage,
    repository,
    now: 5000,
  });
  assert.equal(result.migrated, true);
  assert.equal(result.count, 2);

  assert.deepEqual(
    (await repository.all()).map((row) => row.id),
    ["n1", "n2"],
  );
  assert.equal(storage.data[LEARNING_STORE.NOTES_KEY], undefined);
  assert.equal(storage.data[LEARNING_STORE.META_KEY].notesIdb, true);
  assert.equal(storage.data[LEARNING_STORE.META_KEY].notesIdbMigratedAt, 5000);
  // v2 的迁移标记不能被动到。
  assert.equal(storage.data[LEARNING_STORE.META_KEY].schemaVersion, 2);
});

test("迁移幂等：第二次启动不再搬运，也不复活旧数据", async () => {
  const storage = makeStorage({
    [LEARNING_STORE.NOTES_KEY]: [note("n1")],
  });
  const repository = NOTE_DB.createNotesRepository({
    driver: NOTE_DB.createMemoryDriver(),
  });

  await NOTE_DB.ensureNotesInIdb({ storage, repository });
  // 用户在新版本里继续用了一段时间，旧 key 下又出现了内容（比如降级再升级）。
  storage.data[LEARNING_STORE.NOTES_KEY] = [note("n1"), note("ghost")];

  const second = await NOTE_DB.ensureNotesInIdb({ storage, repository });
  assert.equal(second.migrated, false);
  assert.deepEqual(
    (await repository.all()).map((row) => row.id),
    ["n1"],
  );
});

test("迁移去重并跳过无效记录", async () => {
  const storage = makeStorage({
    [LEARNING_STORE.NOTES_KEY]: [
      note("dup"),
      note("dup", { text: "重复的" }),
      { broken: true },
      note("good"),
    ],
  });
  const repository = NOTE_DB.createNotesRepository({
    driver: NOTE_DB.createMemoryDriver(),
  });

  const result = await NOTE_DB.ensureNotesInIdb({ storage, repository });
  assert.equal(result.count, 2);
  assert.deepEqual(
    (await repository.all()).map((row) => row.id),
    ["dup", "good"],
  );
});

test("迁移数量校验失败时保留旧数据，下次还能重试", async () => {
  const storage = makeStorage({
    [LEARNING_STORE.NOTES_KEY]: [note("n1"), note("n2")],
  });
  // 驱动故意吞掉一半写入，模拟中途损坏。
  const lossy = NOTE_DB.createMemoryDriver();
  const realWrite = lossy.write.bind(lossy);
  let dropped = false;
  lossy.write = async (payload) => {
    if (!dropped && payload.put?.length > 1) {
      dropped = true;
      return realWrite({ put: payload.put.slice(0, 1), remove: payload.remove });
    }
    return realWrite(payload);
  };
  const repository = NOTE_DB.createNotesRepository({ driver: lossy });

  await assert.rejects(() => NOTE_DB.ensureNotesInIdb({ storage, repository }), /数量不符/);
  assert.equal(storage.data[LEARNING_STORE.NOTES_KEY].length, 2, "旧 key 原地不动");
  assert.equal(storage.data[LEARNING_STORE.META_KEY]?.notesIdb, undefined, "不能记完成标记");

  // 换回正常驱动，重试成功。
  const healthy = NOTE_DB.createNotesRepository({ driver: NOTE_DB.createMemoryDriver() });
  const retried = await NOTE_DB.ensureNotesInIdb({ storage, repository: healthy });
  assert.equal(retried.migrated, true);
  assert.equal((await healthy.all()).length, 2);
});

test("空库也记完成标记，不让每次启动都空跑一遍", async () => {
  const storage = makeStorage({});
  const repository = NOTE_DB.createNotesRepository({
    driver: NOTE_DB.createMemoryDriver(),
  });

  const result = await NOTE_DB.ensureNotesInIdb({ storage, repository });
  assert.equal(result.migrated, true);
  assert.equal(result.count, 0);
  assert.equal(storage.data[LEARNING_STORE.META_KEY].notesIdb, true);
});

test("端到端：真实 IndexedDB 驱动接住整条迁移路径", async () => {
  const storage = makeStorage({
    [LEARNING_STORE.NOTES_KEY]: [note("e1"), note("e2")],
  });
  const repository = NOTE_DB.createNotesRepository({
    driver: NOTE_DB.createIndexedDbDriver({
      indexedDB: createMemoryIndexedDb(),
    }),
  });

  await NOTE_DB.ensureNotesInIdb({ storage, repository });
  assert.deepEqual(
    (await repository.all()).map((row) => row.id),
    ["e1", "e2"],
  );
  assert.equal(storage.data[LEARNING_STORE.NOTES_KEY], undefined);
});
