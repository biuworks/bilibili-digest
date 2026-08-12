/** 字幕 / 概览缓存 —— 对齐上游的 `digest_{videoId}` 策略：30 天过期 + 最多 20 条 LRU。 */
var BILI_CACHE = (() => {
  const CACHE_PREFIX = "digest_";
  const MAX_ENTRIES = 20;
  const TTL_MS = 30 * 24 * 60 * 60 * 1000;

  function defaultStorage() {
    if (typeof chrome !== "undefined" && chrome?.storage?.local) {
      return chrome.storage.local;
    }
    throw new Error("没有可用的存储后端");
  }

  // 分 P 视频各自成一条缓存，避免 p1 的字幕覆盖 p2。
  function cacheKey(bvid, page = 1) {
    const suffix = Number(page) > 1 ? `_p${Math.floor(Number(page))}` : "";
    return `${CACHE_PREFIX}${bvid}${suffix}`;
  }

  async function load(bvid, { storage = defaultStorage(), page = 1, now = Date.now() } = {}) {
    const key = cacheKey(bvid, page);
    try {
      const result = await storage.get(key);
      const cached = result?.[key];
      if (!cached) return null;
      if (now - Number(cached.timestamp || 0) > TTL_MS) {
        await storage.remove(key);
        return null;
      }
      return cached;
    } catch (error) {
      console.error("[Bilibili Digest] 读取缓存失败：", error);
      return null;
    }
  }

  // 淘汰要 get(null) 全库读一遍，只在可能新增条目时才值得做；
  // 顺句 / 翻译 / 概览的回写只是更新已有条目，应传 evict: false。
  async function save(
    bvid,
    data,
    {
      storage = defaultStorage(),
      page = 1,
      now = Date.now(),
      maxEntries = MAX_ENTRIES,
      evict: shouldEvict = true,
    } = {},
  ) {
    const key = cacheKey(bvid, page);
    try {
      await storage.set({ [key]: { ...data, timestamp: now } });
      if (shouldEvict) await evict({ storage, maxEntries, now });
      return true;
    } catch (error) {
      console.error("[Bilibili Digest] 写入缓存失败：", error);
      return false;
    }
  }

  // 先清过期条目，再按写入时间淘汰最旧的，把总量压回 maxEntries。
  async function evict({
    storage = defaultStorage(),
    maxEntries = MAX_ENTRIES,
    now = Date.now(),
  } = {}) {
    try {
      const all = (await storage.get(null)) || {};
      let keys = Object.keys(all).filter((key) => key.startsWith(CACHE_PREFIX));

      const expired = keys.filter(
        (key) => now - Number(all[key]?.timestamp || 0) > TTL_MS,
      );
      if (expired.length) {
        await storage.remove(expired);
        const expiredSet = new Set(expired);
        keys = keys.filter((key) => !expiredSet.has(key));
      }

      if (keys.length <= maxEntries) return expired;

      const stale = keys
        .map((key) => ({ key, timestamp: Number(all[key]?.timestamp) || 0 }))
        .sort((a, b) => a.timestamp - b.timestamp)
        .slice(0, keys.length - maxEntries)
        .map((entry) => entry.key);
      if (stale.length) await storage.remove(stale);
      return [...expired, ...stale];
    } catch (error) {
      console.error("[Bilibili Digest] 清理缓存失败：", error);
      return [];
    }
  }

  async function remove(bvid, { storage = defaultStorage(), page = 1 } = {}) {
    await storage.remove(cacheKey(bvid, page));
  }

  return {
    CACHE_PREFIX,
    MAX_ENTRIES,
    TTL_MS,
    cacheKey,
    load,
    save,
    evict,
    remove,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = BILI_CACHE;
}
