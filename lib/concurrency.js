var BILI_CONCURRENCY = (() => {
  /**
   * 带并发上限的 map，返回 allSettled 形状的结果。
   * 刻意保序（结果要按 id 对回分段）、单个失败不中断全局（一个限流不该丢整轮）。
   */
  async function mapWithConcurrency(items, limit, worker, onProgress) {
    const list = Array.isArray(items) ? items : [];
    const total = list.length;
    const results = new Array(total);
    if (total === 0) return results;

    const size = Math.max(1, Math.min(Math.floor(Number(limit) || 1), total));
    let nextIndex = 0;
    let done = 0;

    const runOne = async () => {
      while (true) {
        // 取号必须是同步的，不能 await 之后再取，否则多个 worker 会拿到同一个下标。
        const index = nextIndex;
        if (index >= total) return;
        nextIndex += 1;

        try {
          results[index] = { status: "fulfilled", value: await worker(list[index], index) };
        } catch (error) {
          results[index] = { status: "rejected", reason: error };
        }

        done += 1;
        if (typeof onProgress === "function") {
          try {
            onProgress(done, total);
          } catch (error) {
            // 进度回调出错不该影响任务本身。
          }
        }
      }
    };

    await Promise.all(Array.from({ length: size }, runOne));
    return results;
  }

  /** 串行队列，保护「读—改—写」临界区：并发写时后写的会拿旧快照覆盖先写的。 */
  function createSerialQueue() {
    let tail = Promise.resolve();

    return function enqueue(task) {
      // 前一个任务失败不能让整条队列卡死，所以这里吞掉它的错误；
      // 错误本身由各自的调用方通过返回的 promise 收到。
      const result = tail.then(task, task);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    };
  }

  return { mapWithConcurrency, createSerialQueue };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = BILI_CONCURRENCY;
}
