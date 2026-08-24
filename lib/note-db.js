/**
 * 笔记的 IndexedDB 存储。
 *
 * 为什么搬出 chrome.storage.local：笔记数组是单 key 整存整取，每改一条都要
 * 重写全量序列化文本，而 storage.local 有约 10 MiB 的硬上限，笔记和概览快照
 * 永久累积迟早撞顶。IndexedDB 按条存取，配额按可用磁盘算，对这种只增不减的
 * 学习资料是正确的后端。字幕缓存与概览快照见 lib/cache.js 与本文件的迁移段。
 *
 * 安全边界与 storage.local 的 TRUSTED_CONTENTS 等效：内容脚本运行在页面源上，
 * 扩展的 IndexedDB 属于扩展源（chrome-extension://…），页面脚本碰不到，
 * 侧边栏也不直接打开它——所有读写都走 background 的消息协议。
 *
 * 分层：lib/idb.js 提供按 id 存取的驱动；这里补上排序、校验和领域语义。
 */
var BILI_NOTE_DB = (() => {
  const IDB =
    typeof BILI_IDB !== "undefined" ? BILI_IDB : require("./idb.js");
  const LEARNING_STORE =
    typeof BILI_LEARNING_STORE !== "undefined"
      ? BILI_LEARNING_STORE
      : require("./learning-store.js");
  const META_KEY = LEARNING_STORE.META_KEY;
  const NOTES_KEY = LEARNING_STORE.NOTES_KEY;

  const DATABASE_NAME = IDB.DATABASE_NAME;
  const STORE_NAME = "notes";

  // ============================================================
  // 驱动（委托给 lib/idb.js，保留原工厂名以兼容既有调用点）
  // ============================================================

  function createIndexedDbDriver({
    databaseName = DATABASE_NAME,
    storeName = STORE_NAME,
    indexedDB,
  } = {}) {
    return IDB.createObjectStoreDriver({
      databaseName,
      storeName,
      indexedDB,
    });
  }

  const createMemoryDriver = IDB.createMemoryDriver;

  // ============================================================
  // 仓储层
  // ============================================================

  function isValidNote(note) {
    return Boolean(note && typeof note === "object" && String(note.id || "").trim());
  }

  // 列表沿用旧数组的语义：最新在前。以 createdAt 倒序近似原来的 unshift 顺序。
  function byNewestFirst(left, right) {
    return (Number(right.createdAt) || 0) - (Number(left.createdAt) || 0);
  }

  function createNotesRepository({ driver }) {
    if (!driver) throw new Error("笔记仓储需要存储驱动");
    return {
      driver,
      async all() {
        const rows = await driver.getAll();
        return rows.filter(isValidNote).sort(byNewestFirst);
      },
      async find(id) {
        const row = await driver.get(id);
        return isValidNote(row) ? row : null;
      },
      async count() {
        return driver.count();
      },
      async commit({ put = [], remove = [] } = {}) {
        await driver.write({
          put: put.filter(isValidNote),
          remove: [...remove],
        });
      },
    };
  }

  // ============================================================
  // 一次性迁移：storage.local 的笔记数组 → IndexedDB
  // ============================================================

  /**
   * 安全顺序是刻意的：先写数据、再验数量、才记标记、最后删旧 key。
   * 任何一步失败，旧数据都原地不动，下次启动从头再来；bulkPut 按 id 覆盖，
   * 重跑天然幂等。标记并进 META_KEY 而不是升 SCHEMA_VERSION：
   * v2 迁移的语义保持不变，这里只是追加一个独立完成标记。
   */
  async function ensureNotesInIdb({
    storage,
    repository,
    now = Date.now(),
  } = {}) {
    const metaOnly = (await storage.get(META_KEY)) || {};
    const meta = metaOnly[META_KEY];
    if (meta?.notesIdb) {
      return { migrated: false };
    }

    const stored = (await storage.get(NOTES_KEY)) || {};
    const legacy = Array.isArray(stored[NOTES_KEY]) ? stored[NOTES_KEY] : [];

    // 只挑结构完整的记录；字段级规范化（revision/contentSource 等）由 v2
    // 迁移负责，这里不重复做——两步迁移各自失败都不影响对方重试。
    const seen = new Set();
    const notes = [];
    for (const note of legacy) {
      if (!isValidNote(note) || seen.has(note.id)) continue;
      seen.add(note.id);
      notes.push(note);
    }

    if (notes.length) {
      await repository.commit({ put: notes });
      const storedCount = await repository.count();
      if (storedCount < notes.length) {
        throw new Error(
          `笔记迁移后数量不符：应有 ${notes.length}，实有 ${storedCount}`,
        );
      }
    }

    await storage.set({
      [META_KEY]: { ...meta, notesIdb: true, notesIdbMigratedAt: now },
    });
    if (legacy.length) {
      await storage.remove(NOTES_KEY);
    }
    return { migrated: true, count: notes.length };
  }

  return {
    DATABASE_NAME,
    STORE_NAME,
    createIndexedDbDriver,
    createMemoryDriver,
    createNotesRepository,
    ensureNotesInIdb,
    isValidNote,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = BILI_NOTE_DB;
}
