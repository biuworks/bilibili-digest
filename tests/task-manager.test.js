const test = require("node:test");
const assert = require("node:assert/strict");

const TASKS = require("../lib/task-manager.js");

test("同一目标同类任务只能运行一个", () => {
  const manager = TASKS.createTaskManager({ now: () => 1000 });
  const first = manager.start({ id: "task-1", kind: "analysis", key: "analysis:BV:p1" });
  const repeated = manager.start({ id: "task-2", kind: "analysis", key: "analysis:BV:p1" });

  assert.equal(first.success, true);
  assert.equal(repeated.success, false);
  assert.equal(repeated.error, "TASK_ALREADY_RUNNING");
  assert.equal(repeated.task.id, "task-1");
  assert.equal(manager.list().length, 1);
});

test("取消任务会中止信号并广播取消状态", () => {
  const changes = [];
  const manager = TASKS.createTaskManager({
    now: () => 1000,
    onChange: (task) => changes.push(task),
  });
  manager.start({ id: "task-1", kind: "note-refine", key: "note:1" });

  const result = manager.cancel("task-1");

  assert.equal(result.success, true);
  assert.equal(manager.signal("task-1").aborted, true);
  assert.equal(changes.at(-1).state, "canceled");
  assert.equal(changes.at(-1).message, "已取消");
});

test("进度只更新运行中的任务，结束后从活动列表移除", () => {
  const changes = [];
  const manager = TASKS.createTaskManager({ onChange: (task) => changes.push(task) });
  manager.start({ id: "task-1", kind: "analysis", key: "analysis:1" });
  manager.progress("task-1", { done: 2, total: 5, phase: "generating", message: "正在生成" });

  const current = manager.get("task-1");
  assert.deepEqual(current, {
    id: "task-1",
    kind: "analysis",
    key: "analysis:1",
    state: "running",
    done: 2,
    total: 5,
    phase: "generating",
    message: "正在生成",
    createdAt: current.createdAt,
    updatedAt: current.updatedAt,
  });
  assert.equal(typeof current.createdAt, "number");
  assert.equal(typeof current.updatedAt, "number");

  const finished = manager.finish("task-1", { state: "completed", message: "已完成" });
  assert.equal(finished.state, "completed");
  assert.equal(changes.at(-1).state, "completed");
  assert.deepEqual(manager.list(), []);
});
