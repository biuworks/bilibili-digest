/**
 * chrome.storage.local 的最小内存实现，供各测试文件复用。
 * 与真实实现一致：读出的数据是拷贝，改动返回值不影响存储内容。
 */

"use strict";

function memoryStorage(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    setAccessLevel: async () => {},
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

module.exports = { memoryStorage };
