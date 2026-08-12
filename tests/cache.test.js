const test = require("node:test");
const assert = require("node:assert/strict");

const CACHE = require("../lib/cache.js");

/** chrome.storage.local 的最小内存实现。 */
function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(key) {
      if (key === null || key === undefined) return { ...data };
      const keys = Array.isArray(key) ? key : [key];
      const result = {};
      for (const k of keys) {
        if (k in data) result[k] = data[k];
      }
      return result;
    },
    async set(entries) {
      Object.assign(data, entries);
    },
    async remove(key) {
      for (const k of Array.isArray(key) ? key : [key]) delete data[k];
    },
  };
}

const BVID = "BV1GJ411x7h7";

test("缓存键按分 P 区分", () => {
  assert.equal(CACHE.cacheKey(BVID), `digest_${BVID}`);
  assert.equal(CACHE.cacheKey(BVID, 1), `digest_${BVID}`);
  assert.equal(CACHE.cacheKey(BVID, 3), `digest_${BVID}_p3`);
});

test("写入后可读回，并带上写入时间", async () => {
  const storage = memoryStorage();
  await CACHE.save(BVID, { transcript: [{ text: "hi" }] }, { storage, now: 1000 });

  const loaded = await CACHE.load(BVID, { storage, now: 2000 });
  assert.equal(loaded.transcript[0].text, "hi");
  assert.equal(loaded.timestamp, 1000);
});

test("不同分 P 互不覆盖", async () => {
  const storage = memoryStorage();
  await CACHE.save(BVID, { transcript: ["p1"] }, { storage, page: 1 });
  await CACHE.save(BVID, { transcript: ["p2"] }, { storage, page: 2 });

  assert.deepEqual((await CACHE.load(BVID, { storage, page: 1 })).transcript, ["p1"]);
  assert.deepEqual((await CACHE.load(BVID, { storage, page: 2 })).transcript, ["p2"]);
});

test("未命中返回 null", async () => {
  const storage = memoryStorage();
  assert.equal(await CACHE.load(BVID, { storage }), null);
});

test("超过 30 天的条目读取时失效并被删除", async () => {
  const storage = memoryStorage();
  await CACHE.save(BVID, { transcript: ["old"] }, { storage, now: 0 });

  const loaded = await CACHE.load(BVID, { storage, now: CACHE.TTL_MS + 1 });
  assert.equal(loaded, null);
  assert.equal(Object.keys(storage.data).length, 0, "过期条目应被清掉");
});

test("刚好卡在 30 天边界仍然有效", async () => {
  const storage = memoryStorage();
  await CACHE.save(BVID, { transcript: ["edge"] }, { storage, now: 0 });
  assert.ok(await CACHE.load(BVID, { storage, now: CACHE.TTL_MS }));
});

test("超出上限时淘汰最旧的条目", async () => {
  const storage = memoryStorage();
  for (let i = 0; i < 5; i += 1) {
    storage.data[`digest_video${i}`] = { timestamp: i + 1, transcript: [] };
  }

  await CACHE.evict({ storage, maxEntries: 3, now: 10 });

  const remaining = Object.keys(storage.data).sort();
  assert.deepEqual(remaining, [
    "digest_video2",
    "digest_video3",
    "digest_video4",
  ]);
});

test("淘汰只针对 digest_ 前缀，不碰设置与笔记", async () => {
  const storage = memoryStorage({
    bili_digest_settings: { aiApiKey: "secret" },
    bili_digest_notes: [{ id: "note_1" }],
    digest_a: { timestamp: 1 },
    digest_b: { timestamp: 2 },
  });

  await CACHE.evict({ storage, maxEntries: 1, now: 10 });

  assert.ok(storage.data.bili_digest_settings, "设置不应被淘汰");
  assert.ok(storage.data.bili_digest_notes, "笔记不应被淘汰");
  assert.ok(!storage.data.digest_a, "最旧的字幕缓存应被淘汰");
  assert.ok(storage.data.digest_b);
});

test("过期条目先于 LRU 被清理", async () => {
  const storage = memoryStorage({
    digest_fresh: { timestamp: 1_000_000 },
    digest_stale: { timestamp: 0 },
  });

  const removed = await CACHE.evict({
    storage,
    maxEntries: 10,
    now: CACHE.TTL_MS + 1_000_000,
  });

  assert.deepEqual(removed, ["digest_stale"]);
  assert.ok(storage.data.digest_fresh);
});

test("写入时顺带做一次淘汰", async () => {
  const storage = memoryStorage();
  for (let i = 0; i < 20; i += 1) {
    storage.data[`digest_video${i}`] = { timestamp: i + 1, transcript: [] };
  }

  await CACHE.save(BVID, { transcript: [] }, { storage, now: 100, maxEntries: 20 });

  const keys = Object.keys(storage.data);
  assert.equal(keys.length, 20);
  assert.ok(keys.includes(`digest_${BVID}`), "新条目应保留");
  assert.ok(!keys.includes("digest_video0"), "最旧的条目应被淘汰");
});

test("evict:false 跳过淘汰——批次回写不该每次读全量存储", async () => {
  const storage = memoryStorage();
  for (let i = 0; i < 20; i += 1) {
    storage.data[`digest_video${i}`] = { timestamp: i + 1, transcript: [] };
  }

  await CACHE.save(BVID, { transcript: [] }, {
    storage,
    now: 100,
    maxEntries: 20,
    evict: false,
  });

  // 超了上限也不动别的条目：这类写入只更新已有内容，淘汰留给新增条目的那次。
  assert.equal(Object.keys(storage.data).length, 21);
  assert.ok(storage.data[`digest_${BVID}`]);
  assert.ok(storage.data.digest_video0, "evict:false 时不应淘汰任何条目");
});

test("remove 精确删除单条", async () => {
  const storage = memoryStorage();
  await CACHE.save(BVID, { transcript: [] }, { storage });
  await CACHE.remove(BVID, { storage });
  assert.equal(await CACHE.load(BVID, { storage }), null);
});
