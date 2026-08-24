const test = require("node:test");
const assert = require("node:assert/strict");

const CACHE = require("../lib/cache.js");
const LEARNING_STORE = require("../lib/learning-store.js");
const { createMemoryDriver } = require("../lib/idb.js");
const { memoryStorage } = require("./helpers/memory-storage.js");

const BVID = "BV1GJ411x7h7";

const META_KEY = () => LEARNING_STORE.META_KEY;

// 直接往驱动里铺种子条目。
async function seed(driver, entries) {
  await driver.write({
    put: entries.map(({ id, timestamp }) => ({
      id,
      timestamp,
      transcript: [],
    })),
  });
}

test("缓存键按分 P 区分", () => {
  assert.equal(CACHE.cacheKey(BVID), `digest_${BVID}`);
  assert.equal(CACHE.cacheKey(BVID, 1), `digest_${BVID}`);
  assert.equal(CACHE.cacheKey(BVID, 3), `digest_${BVID}_p3`);
});

test("写入后可读回，并带上写入时间", async () => {
  const driver = createMemoryDriver();
  await CACHE.save(BVID, { transcript: [{ text: "hi" }] }, { driver, now: 1000 });

  const loaded = await CACHE.load(BVID, { driver, now: 2000 });
  assert.equal(loaded.transcript[0].text, "hi");
  assert.equal(loaded.timestamp, 1000);
});

test("不同分 P 互不覆盖", async () => {
  const driver = createMemoryDriver();
  await CACHE.save(BVID, { transcript: ["p1"] }, { driver, page: 1 });
  await CACHE.save(BVID, { transcript: ["p2"] }, { driver, page: 2 });

  assert.deepEqual((await CACHE.load(BVID, { driver, page: 1 })).transcript, ["p1"]);
  assert.deepEqual((await CACHE.load(BVID, { driver, page: 2 })).transcript, ["p2"]);
});

test("未命中返回 null", async () => {
  const driver = createMemoryDriver();
  assert.equal(await CACHE.load(BVID, { driver }), null);
});

test("超过 30 天的条目读取时失效并被删除", async () => {
  const driver = createMemoryDriver();
  await CACHE.save(BVID, { transcript: ["old"] }, { driver, now: 0 });

  const loaded = await CACHE.load(BVID, { driver, now: CACHE.TTL_MS + 1 });
  assert.equal(loaded, null);
  assert.equal(await driver.count(), 0, "过期条目应被清掉");
});

test("刚好卡在 30 天边界仍然有效", async () => {
  const driver = createMemoryDriver();
  await CACHE.save(BVID, { transcript: ["edge"] }, { driver, now: 0 });
  assert.ok(await CACHE.load(BVID, { driver, now: CACHE.TTL_MS }));
});

test("超出上限时淘汰最旧的条目", async () => {
  const driver = createMemoryDriver();
  await seed(
    driver,
    Array.from({ length: 5 }, (_, i) => ({
      id: `digest_video${i}`,
      timestamp: i + 1,
    })),
  );

  await CACHE.evict({ driver, maxEntries: 3, now: 10 });

  const remaining = (await driver.getAll()).map((row) => row.id).sort();
  assert.deepEqual(remaining, ["digest_video2", "digest_video3", "digest_video4"]);
});

test("过期条目先于 LRU 被清理", async () => {
  const driver = createMemoryDriver();
  await seed(driver, [
    { id: "digest_fresh", timestamp: 1_000_000 },
    { id: "digest_stale", timestamp: 0 },
  ]);

  const removed = await CACHE.evict({
    driver,
    maxEntries: 10,
    now: CACHE.TTL_MS + 1_000_000,
  });

  assert.deepEqual(removed, ["digest_stale"]);
  const ids = (await driver.getAll()).map((row) => row.id);
  assert.ok(ids.includes("digest_fresh"));
});

test("写入时顺带做一次淘汰", async () => {
  const driver = createMemoryDriver();
  await seed(
    driver,
    Array.from({ length: 20 }, (_, i) => ({
      id: `digest_video${i}`,
      timestamp: i + 1,
    })),
  );

  await CACHE.save(BVID, { transcript: [] }, { driver, now: 100, maxEntries: 20 });

  const rows = await driver.getAll();
  assert.equal(rows.length, 20);
  const ids = rows.map((row) => row.id);
  assert.ok(ids.includes(`digest_${BVID}`), "新条目应保留");
  assert.ok(!ids.includes("digest_video0"), "最旧的条目应被淘汰");
});

test("evict:false 跳过淘汰——批次回写不该每次触发清理", async () => {
  const driver = createMemoryDriver();
  await seed(
    driver,
    Array.from({ length: 20 }, (_, i) => ({
      id: `digest_video${i}`,
      timestamp: i + 1,
    })),
  );

  await CACHE.save(BVID, { transcript: [] }, {
    driver,
    now: 100,
    maxEntries: 20,
    evict: false,
  });

  // 超了上限也不动别的条目：这类写入只更新已有内容，淘汰留给新增条目的那次。
  assert.equal(await driver.count(), 21);
  const ids = (await driver.getAll()).map((row) => row.id);
  assert.ok(ids.includes(`digest_${BVID}`));
  assert.ok(ids.includes("digest_video0"), "evict:false 时不应淘汰任何条目");
});

test("remove 精确删除单条", async () => {
  const driver = createMemoryDriver();
  await CACHE.save(BVID, { transcript: [] }, { driver });
  await CACHE.remove(BVID, { driver });
  assert.equal(await CACHE.load(BVID, { driver }), null);
});

// ============================================================
// 一次性迁移：storage.local → IndexedDB
// ============================================================

test("迁移搬走未过期缓存，丢弃过期与超额条目", async () => {
  const storage = memoryStorage({
    [`digest_${BVID}`]: { transcript: ["新"], timestamp: 900 },
    digest_old: { transcript: ["旧"], timestamp: 10 },
    digest_expired: { transcript: [], timestamp: 0 },
  });
  const driver = createMemoryDriver();

  const result = await CACHE.ensureCacheInIdb({
    storage,
    driver,
    maxEntries: 1,
    now: CACHE.TTL_MS + 5,
  });

  assert.equal(result.migrated, true);
  // 过期的 digest_expired 被扔掉；容量裁到 1 条，只剩最新的。
  const ids = (await driver.getAll()).map((row) => row.id);
  assert.deepEqual(ids, [`digest_${BVID}`]);
  assert.equal(result.count, 1);
  assert.equal(storage.data.digest_old, undefined, "旧 key 应清掉");
  assert.equal(storage.data[`digest_${BVID}`], undefined);
  assert.equal(storage.data[META_KEY()].cacheIdb, true);
});

test("迁移幂等：标记记下后不再重复搬运", async () => {
  const storage = memoryStorage({
    [`digest_${BVID}`]: { transcript: [], timestamp: 100 },
  });
  const driver = createMemoryDriver();

  await CACHE.ensureCacheInIdb({ storage, driver, now: 2000 });
  storage.data[`digest_${BVID}`] = { transcript: [], timestamp: 300 };

  const second = await CACHE.ensureCacheInIdb({ storage, driver, now: 4000 });
  assert.equal(second.migrated, false);
  assert.equal(await driver.count(), 1);
});

test("迁移数量校验失败时不记标记、不清旧数据", async () => {
  // 时间戳要落在 now 的 30 天窗口内，否则会被当过期条目直接扔掉。
  const base = 1_000_000_000_000;
  const storage = memoryStorage({
    digest_a: { transcript: [], timestamp: base + 1 },
    digest_b: { transcript: [], timestamp: base + 2 },
  });
  let dropped = false;
  const lossy = createMemoryDriver();
  const realWrite = lossy.write.bind(lossy);
  lossy.write = async (payload) => {
    if (!dropped && payload.put?.length > 1) {
      dropped = true;
      return realWrite({ put: payload.put.slice(0, 1), remove: payload.remove });
    }
    return realWrite(payload);
  };

  await assert.rejects(
    () => CACHE.ensureCacheInIdb({ storage, driver: lossy, now: base + 10 }),
    /数量不符/,
  );
  assert.ok(storage.data.digest_a && storage.data.digest_b, "旧数据原地不动");
  assert.equal(storage.data[META_KEY()]?.cacheIdb, undefined);
});

test("空库迁移也记标记，不让每次启动都空跑", async () => {
  const storage = memoryStorage({});
  const driver = createMemoryDriver();

  const result = await CACHE.ensureCacheInIdb({ storage, driver, now: 1 });
  assert.equal(result.migrated, true);
  assert.equal(result.count, 0);
  assert.equal(storage.data[META_KEY()].cacheIdb, true);
});
