/**
 * 极简内存版 IndexedDB，只覆盖 lib/note-db.js 用到的那一小块表面：
 * open + onupgradeneeded 建库、单对象仓库、事务内 get/getAll/put/delete/count/clear。
 *
 * 为什么不用现成的假实现（如 fake-indexeddb）：本项目零依赖、CI 不跑 npm install。
 * 这个假实现的职责是让真实的 IndexedDB 驱动代码（事件时序、事务提交语义）
 * 在 node --test 里原样跑起来，而不是模拟完整规范。
 *
 * 时序约定与真实 IDB 一致：请求成功先于事务完成；所有事件都异步派发，
 * 驱动代码必须先挂 handler。事务在最后一个未决请求落地后提交。
 */

"use strict";

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function createRequest() {
  const request = {
    result: undefined,
    error: null,
    onsuccess: null,
    onerror: null,
    onupgradeneeded: null,
    onblocked: null,
  };
  request.__done = false;
  request.__succeed = (value) => {
    if (request.__done) return;
    request.__done = true;
    request.result = value;
    queueMicrotask(() => request.onsuccess?.({ target: request }));
  };
  request.__fail = (error) => {
    if (request.__done) return;
    request.__done = true;
    request.error = error;
    queueMicrotask(() => request.onerror?.({ target: request }));
  };
  return request;
}

function createStore() {
  const rows = new Map();
  return {
    get(key) {
      const request = createRequest();
      queueMicrotask(() =>
        request.__succeed(rows.has(key) ? clone(rows.get(key)) : undefined),
      );
      return request;
    },
    getAll() {
      const request = createRequest();
      queueMicrotask(() => request.__succeed([...rows.values()].map(clone)));
      return request;
    },
    count() {
      const request = createRequest();
      queueMicrotask(() => request.__succeed(rows.size));
      return request;
    },
    // 真实 IDB 对不可克隆数据同步抛 DataCloneError，这里用同样的「同步抛」
    // 让驱动代码的 try/catch 与生产环境走同一条路。
    put(value) {
      if (!value || typeof value !== "object" || !("id" in value)) {
        throw new TypeError("存储的记录必须有 id");
      }
      const request = createRequest();
      queueMicrotask(() => {
        rows.set(value.id, clone(value));
        request.__succeed(value.id);
      });
      return request;
    },
    delete(key) {
      const request = createRequest();
      queueMicrotask(() => {
        rows.delete(key);
        request.__succeed(undefined);
      });
      return request;
    },
    clear() {
      const request = createRequest();
      queueMicrotask(() => {
        rows.clear();
        request.__succeed(undefined);
      });
      return request;
    },
  };
}

const WRITABLE_METHODS = new Set(["put", "delete", "clear"]);

function createMemoryIndexedDb() {
  const databases = new Map();

  // 测试注入口：让下一次写操作以指定错误失败，模拟配额满、IO 出错等场景。
  let pendingWriteFailure = null;

  function failNextWrite(error) {
    pendingWriteFailure = error instanceof Error ? error : new Error(String(error));
  }

  function openDatabase(name) {
    if (!databases.has(name)) databases.set(name, new Map());
    const stores = databases.get(name);
    return {
      objectStoreNames: { contains: (store) => stores.has(store) },
      close() {},
      createObjectStore(storeName, options) {
        if (stores.has(storeName)) throw new Error(`对象仓库已存在：${storeName}`);
        if (options?.keyPath !== "id") throw new Error("本假实现只支持 keyPath: id");
        const store = createStore();
        stores.set(storeName, store);
        return store;
      },
      transaction(storeName, mode) {
        if (mode !== "readonly" && mode !== "readwrite") {
          throw new TypeError(`未知的事务模式：${mode}`);
        }
        const store = stores.get(storeName);
        if (!store) throw new Error(`没有名为 ${storeName} 的对象仓库`);

        const state = { pending: 0, done: false };
        const tx = {
          mode,
          error: null,
          oncomplete: null,
          onerror: null,
          onabort: null,
          abort() {
            finish("abort", new Error("事务已中止"));
          },
        };

        function finish(kind, error) {
          if (state.done) return;
          state.done = true;
          tx.error = error || null;
          // 用宏任务派发提交/中止：浏览器里事务也是在控制权交回事件循环后才
          // 提交的，驱动代码「先 await 请求、再挂 oncomplete」的顺序才成立；
          // 若用微任务，提交会抢在驱动挂上 handler 之前跑掉。
          setTimeout(() => {
            if (kind === "complete") tx.oncomplete?.();
            else tx.onabort?.({ target: tx });
          }, 0);
        }

        // 每个未决请求落地时计数减一，归零即提交——不依赖微任务轮数的巧合，
        // 多个请求排进同一事务也能等到全部完成再提交。
        function track(request) {
          state.pending += 1;
          const succeed = request.__succeed;
          const fail = request.__fail;
          request.__succeed = (value) => {
            succeed(value);
            settle();
          };
          request.__fail = (error) => {
            fail(error);
            settle();
          };
          return request;
        }

        function settle() {
          state.pending -= 1;
          if (state.pending <= 0 && !state.done) finish("complete");
        }

        const proxyStore = {};
        for (const method of ["get", "getAll", "count", "put", "delete", "clear"]) {
          proxyStore[method] = (...args) => {
            if (state.done) throw new Error("事务已经结束");
            if (mode === "readonly" && WRITABLE_METHODS.has(method)) {
              const error = new Error("只读事务不能写入");
              finish("abort", error);
              throw error;
            }
            if (
              mode === "readwrite" &&
              WRITABLE_METHODS.has(method) &&
              pendingWriteFailure
            ) {
              const failure = pendingWriteFailure;
              pendingWriteFailure = null;
              finish("abort", failure);
              throw failure;
            }
            return track(store[method](...args));
          };
        }

        tx.objectStore = () => proxyStore;
        return tx;
      },
    };
  }

  return {
    __failNextWrite: failNextWrite,
    open(name) {
      const request = createRequest();
      queueMicrotask(() => {
        const db = openDatabase(name);
        // 与真实 IDB 不同，这里每次 open 都派发升级事件：驱动侧有
        // objectStoreNames.contains 守卫，重复建库不会发生，测试却能覆盖建库路径。
        request.result = db;
        request.onupgradeneeded?.({ target: request });
        request.__succeed(db);
      });
      return request;
    },
  };
}

module.exports = { createMemoryIndexedDb };
