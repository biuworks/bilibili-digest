/**
 * 字幕 / 概览缓存 —— 对齐上游的 `digest_{videoId}` 策略：30 天过期 + 最多 20 条 LRU。
 * 后端是扩展自己的 IndexedDB（lib/idb.js 的 cache 仓库）：缓存条目大、只增不减，
 * storage.local 的容量上限和「淘汰靠全库扫描」都扛不住它。
 *
 * 公共 API 与旧版一致（load / save / evict / remove / cacheKey），调用方无感。
 */
var BILI_CACHE = (() => {
  const IDB = typeof BILI_IDB !== "undefined" ? BILI_IDB : require("./idb.js");
  const LEARNING_STORE =
    typeof BILI_LEARNING_STORE !== "undefined"
      ? BILI_LEARNING_STORE
      : require("./learning-store.js");
  const META_KEY = LEARNING_STORE.META_KEY;

  const CACHE_PREFIX = "digest_";
  const STORE_NAME = "cache";
  const MAX_ENTRIES = 20;
  const TTL_MS = 30 * 24 * 60 * 60 * 1000;

  // 分 P 视频各自成一条缓存，避免 p1 的字幕覆盖 p2。
  function cacheKey(bvid, page = 1) {
    const suffix = Number(page) > 1 ? `_p${Math.floor(Number(page))}` : "";
    return `${CACHE_PREFIX}${bvid}${suffix}`;
  }

  // 生产环境（service worker 同 realm）走全局；Node 测试显式注入驱动。
  let defaultDriver = null;
  function resolveDriver(driver) {
    if (driver) return driver;
    if (!defaultDriver) {
      defaultDriver = IDB.createObjectStoreDriver({
        storeName: STORE_NAME,
        indexedDB: globalThis.indexedDB,
      });
    }
    return defaultDriver;
  }

  async function load(
    bvid,
    { driver, page = 1, now = Date.now() } = {},
  ) {
    const key = cacheKey(bvid, page);
    try {
      const cached = await resolveDriver(driver).get(key);
      if (!cached) return null;
      if (now - Number(cached.timestamp || 0) > TTL_MS) {
        await resolveDriver(driver).write({ remove: [key] });
        return null;
      }
      return cached;
    } catch (error) {
      console.error("[Bilibili Digest] 读取缓存失败：", error);
      return null;
    }
  }

  // 回写条目自带 id（= 缓存键），仓库按它覆盖旧记录。
  async function save(
    bvid,
    data,
    {
      driver,
      page = 1,
      now = Date.now(),
      maxEntries = MAX_ENTRIES,
      evict: shouldEvict = true,
    } = {},
  ) {
    const store = resolveDriver(driver);
    const key = cacheKey(bvid, page);
    try {
      await store.write({ put: [{ ...data, id: key, timestamp: now }] });
      if (shouldEvict) await evict({ driver: store, maxEntries, now });
      return true;
    } catch (error) {
      console.error("[Bilibili Digest] 写入缓存失败：", error);
      return false;
    }
  }

  // 先清过期条目，再按写入时间淘汰最旧的，把总量压回 maxEntries。
  // 条目总量有上限，getAll 一把读完全够用，不再需要旧版的全库扫描。
  async function evict({
    driver,
    maxEntries = MAX_ENTRIES,
    now = Date.now(),
  } = {}) {
    const store = resolveDriver(driver);
    try {
      const rows = await store.getAll();
      const fresh = [];
      const expired = [];
      for (const row of rows) {
        (now - Number(row.timestamp || 0) > TTL_MS ? expired : fresh).push(row);
      }
      const sorted = fresh.sort(
        (a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0),
      );
      const stale = sorted.slice(0, Math.max(0, sorted.length - maxEntries));
      const removals = [...expired, ...stale].map((row) => row.id);
      if (removals.length) await store.write({ remove: removals });
      return removals;
    } catch (error) {
      console.error("[Bilibili Digest] 清理缓存失败：", error);
      return [];
    }
  }

  async function remove(bvid, { driver, page = 1 } = {}) {
    await resolveDriver(driver).write({ remove: [cacheKey(bvid, page)] });
  }

  /**
   * 一次性迁移：storage.local 里的旧字幕缓存 → IndexedDB。过期的直接扔，
   * 超出容量的从最旧的开始扔。安全顺序与笔记迁移一致：先写、再验、
   * 记标记、最后删旧 key；中断重跑幂等。缓存是可丢数据，
   * 校验失败宁可放弃迁移也不阻塞启动。
   */
  async function ensureCacheInIdb({
    storage,
    driver,
    maxEntries = MAX_ENTRIES,
    now = Date.now(),
  } = {}) {
    const metaOnly = (await storage.get(META_KEY)) || {};
    const meta = metaOnly[META_KEY];
    if (meta?.cacheIdb) {
      return { migrated: false };
    }

    const store = resolveDriver(driver);
    const all = (await storage.get(null)) || {};
    const legacyKeys = Object.keys(all).filter((key) =>
      key.startsWith(CACHE_PREFIX),
    );

    const movable = legacyKeys
      .map((key) => ({ key, entry: all[key], timestamp: Number(all[key]?.timestamp) || 0 }))
      .filter((item) => item.entry && typeof item.entry === "object")
      .filter((item) => now - item.timestamp <= TTL_MS)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, maxEntries);

    if (movable.length) {
      await store.write({
        put: movable.map((item) => ({
          ...item.entry,
          id: item.key,
          timestamp: item.timestamp,
        })),
      });
      const storedCount = await store.count();
      if (storedCount < movable.length) {
        throw new Error(
          `缓存迁移后数量不符：应有至少 ${movable.length}，实有 ${storedCount}`,
        );
      }
    }

    await storage.set({
      [META_KEY]: { ...meta, cacheIdb: true, cacheIdbMigratedAt: now },
    });
    if (legacyKeys.length) {
      await storage.remove(legacyKeys);
    }
    return { migrated: true, count: movable.length };
  }


  return {
    CACHE_PREFIX,
    STORE_NAME,
    MAX_ENTRIES,
    TTL_MS,
    cacheKey,
    load,
    save,
    evict,
    remove,
    ensureCacheInIdb,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = BILI_CACHE;
}
