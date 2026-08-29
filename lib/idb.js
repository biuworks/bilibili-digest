/**
 * 扩展本地 IndexedDB 的底层驱动：一个数据库（bili-digest），多个对象仓库。
 *
 * 为什么搬出 chrome.storage.local：字幕缓存与学习资料只会累积，storage.local
 * 约 10 MiB 的硬上限迟早撞顶；IndexedDB 按条存取、配额按可用磁盘算，才是
 * 这类数据的正确后端。设置（含密钥）仍留在 storage.local。
 *
 * 安全边界与 TRUSTED_CONTEXTS 等效：内容脚本运行在页面源上，扩展的
 * IndexedDB 属于扩展源，页面脚本碰不到；侧边栏也不直接打开它，
 * 所有读写都走 background 的消息协议。
 *
 * 分层约定：驱动只管「按 id 存取一批记录」，每次返回数据的拷贝——调用方
 * 改动返回值不得影响库内内容。这是对齐 IndexedDB 反序列化语义的约定，
 * 测试用的内存驱动同样遵守。
 */
var BILI_IDB = (() => {
  const DATABASE_NAME = "bili-digest";
  const DATABASE_VERSION = 2;
  const STORES = ["notes", "cache", "learning", "qa"];

  function promisifyRequest(request, label) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error || new Error(`IndexedDB 请求失败：${label}`));
    });
  }

  /**
   * 单仓库驱动。升级事件里把缺的仓库一并补齐：连接是各自懒建的，
   * 先到的驱动建库时只有自己的仓库，后来者靠这里补齐其余仓库。
   */
  function createObjectStoreDriver({
    databaseName = DATABASE_NAME,
    version = DATABASE_VERSION,
    storeName,
    // 调用方显式传入；模块可能被测试跨 realm 加载，不能默认摸 globalThis。
    indexedDB,
  } = {}) {
    if (!storeName || !STORES.includes(storeName)) {
      throw new Error(`未登记的对象仓库：${storeName}`);
    }
    if (!indexedDB) {
      throw new Error("当前环境没有 IndexedDB 可用");
    }
    let opening = null;
    function openDatabase() {
      if (!opening) {
        opening = new Promise((resolve, reject) => {
          const request = indexedDB.open(databaseName, version);
          request.onupgradeneeded = () => {
            const db = request.result;
            for (const name of STORES) {
              if (!db.objectStoreNames.contains(name)) {
                db.createObjectStore(name, { keyPath: "id" });
              }
            }
          };
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => {
            // 一次瞬时失败（磁盘忙、连接中断）不该毒化整个生命周期：
            // 清掉缓存让下一次调用重新 open，而不是永远复用这个 rejection。
            opening = null;
            reject(request.error || new Error("IndexedDB 打开失败"));
          };
          request.onblocked = () => {
            // 升级被其他连接阻塞时 promise 永远不落定，消息层会挂死；
            // 明确失败让上层透出可行动的提示。
            opening = null;
            reject(new Error("IndexedDB 正被其他窗口占用，请稍后重试"));
          };
        });
      }
      return opening;
    }

    async function withTransaction(mode, run) {
      const db = await openDatabase();
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      try {
        const result = await run(store);
        await new Promise((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error || new Error("事务已中止"));
          tx.onerror = () => reject(tx.error || new Error("事务失败"));
        });
        return result;
      } catch (error) {
        // run 抛错时事务可能还挂着未决请求，abort 让浏览器立刻收尾；
        // 事务已自行结束时 abort 会抛错，吞掉即可。
        try {
          tx.abort();
        } catch {}
        throw error;
      }
    }

    return {
      async getAll() {
        return withTransaction("readonly", (store) =>
          promisifyRequest(store.getAll(), "getAll"),
        );
      },
      async count() {
        return withTransaction("readonly", (store) =>
          promisifyRequest(store.count(), "count"),
        );
      },
      async get(id) {
        return withTransaction("readonly", (store) =>
          promisifyRequest(store.get(id), "get"),
        );
      },
      /** 单个读写事务内完成全部写入：要么全部落地，要么全部回滚。 */
      async write({ put = [], remove = [] } = {}) {
        if (!put.length && !remove.length) return;
        await withTransaction("readwrite", (store) => {
          for (const record of put) store.put(record);
          for (const id of remove) store.delete(id);
        });
      },
      async clear() {
        await withTransaction("readwrite", (store) => {
          store.clear();
        });
      },
    };
  }

  function createMemoryDriver(initialRecords = []) {
    const rows = new Map();
    for (const record of initialRecords) {
      if (!record || typeof record !== "object" || !record.id) continue;
      rows.set(record.id, structuredClone(record));
    }
    return {
      async getAll() {
        return [...rows.values()].map((record) => structuredClone(record));
      },
      async count() {
        return rows.size;
      },
      async get(id) {
        return rows.has(id) ? structuredClone(rows.get(id)) : undefined;
      },
      async write({ put = [], remove = [] } = {}) {
        for (const record of put) rows.set(record.id, structuredClone(record));
        for (const id of remove) rows.delete(id);
      },
      async clear() {
        rows.clear();
      },
    };
  }

  return {
    DATABASE_NAME,
    DATABASE_VERSION,
    STORES,
    createObjectStoreDriver,
    createMemoryDriver,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = BILI_IDB;
}
