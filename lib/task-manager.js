/** AI 任务生命周期：去重、进度、取消与状态广播。 */
var BILI_TASKS = (() => {
  const snapshot = (entry) => {
    if (!entry) return null;
    const { controller, ...task } = entry;
    return { ...task };
  };

  function createTaskManager({ onChange = () => {}, now = () => Date.now() } = {}) {
    const active = new Map();

    const emit = (entry) => {
      const task = snapshot(entry);
      try {
        onChange(task);
      } catch (error) {
        // 状态监听失败不影响实际任务。
      }
      return task;
    };

    function start({ id, kind, key }) {
      const duplicate = [...active.values()].find(
        (entry) => entry.key === key && entry.state === "running",
      );
      if (duplicate) {
        return {
          success: false,
          error: "TASK_ALREADY_RUNNING",
          message: "同一任务已经在运行。",
          task: snapshot(duplicate),
        };
      }

      const timestamp = now();
      const entry = {
        id,
        kind,
        key,
        state: "running",
        done: 0,
        total: 0,
        phase: "preparing",
        message: "正在准备…",
        createdAt: timestamp,
        updatedAt: timestamp,
        controller: new AbortController(),
      };
      active.set(id, entry);
      return { success: true, task: emit(entry) };
    }

    function progress(id, patch = {}) {
      const entry = active.get(id);
      if (!entry || entry.state !== "running") return null;
      for (const key of ["done", "total", "phase", "message"]) {
        if (patch[key] !== undefined) entry[key] = patch[key];
      }
      entry.updatedAt = now();
      return emit(entry);
    }

    function cancel(id) {
      const entry = active.get(id);
      if (!entry) {
        return { success: false, error: "TASK_NOT_FOUND", message: "任务已经结束。" };
      }
      if (entry.state !== "canceled") {
        entry.state = "canceled";
        entry.phase = "canceled";
        entry.message = "已取消";
        entry.updatedAt = now();
        entry.controller.abort();
        emit(entry);
      }
      return { success: true, task: snapshot(entry) };
    }

    function finish(id, { state = "completed", message = "已完成" } = {}) {
      const entry = active.get(id);
      if (!entry) return null;
      if (entry.state !== "canceled") {
        entry.state = state;
        entry.phase = state;
        entry.message = message;
        entry.updatedAt = now();
      }
      const task = emit(entry);
      active.delete(id);
      return task;
    }

    const get = (id) => snapshot(active.get(id));
    const signal = (id) => active.get(id)?.controller.signal || null;
    const list = () => [...active.values()].map(snapshot);

    return { start, progress, cancel, finish, get, signal, list };
  }

  return { createTaskManager };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = BILI_TASKS;
}
