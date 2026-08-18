const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");

function createElement(tagName = "div") {
  const listeners = new Map();
  let text = "";
  const element = {
    tagName: tagName.toUpperCase(),
    value: "",
    hidden: false,
    children: [],
    focused: false,
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    async dispatch(type, event = {}) {
      for (const listener of listeners.get(type) || []) await listener(event);
    },
    focus() {
      this.focused = true;
    },
  };
  Object.defineProperty(element, "textContent", {
    get: () => text,
    set(value) {
      text = String(value);
      if (text === "") element.children = [];
    },
  });
  return element;
}

async function createContext() {
  const elements = new Map();
  const permissionRequests = [];
  const byId = (id) => {
    if (!elements.has(id)) {
      const tag = id === "modelOptions" || id === "preset" || id === "protocol"
        ? "select"
        : id.endsWith("Btn")
          ? "button"
          : "div";
      const element = createElement(tag);
      if (id === "modelOptions") element.hidden = true;
      elements.set(id, element);
    }
    return elements.get(id);
  };

  const settings = require("../settings.js");
  const context = {
    console,
    setTimeout: () => 1,
    clearTimeout: () => {},
    document: {
      getElementById: byId,
      createElement,
    },
    chrome: {
      storage: {
        local: {
          get: async () => ({
            [settings.STORAGE_KEY]: {
              presetId: settings.CUSTOM_PRESET_ID,
              protocol: settings.PROTOCOLS.OPENAI,
              aiBaseUrl: "https://api.example.com/v1",
              aiApiKey: "sk-test",
              aiModel: "already-filled-model",
            },
          }),
          set: async () => {},
        },
      },
      permissions: {
        contains: async () => true,
        request: async (request) => {
          permissionRequests.push(request);
          return true;
        },
      },
    },
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [{ id: "model-b" }, { id: "model-a" }],
      }),
    }),
    BILI_SETTINGS: settings,
    BILI_AI_PROVIDER: require("../lib/ai-provider.js"),
  };
  context.globalThis = context;
  vm.createContext(context);

  const source = fs.readFileSync(path.join(ROOT, "options.js"), "utf8");
  vm.runInContext(
    `${source}\n;globalThis.__api = { fetchModels, clearModelOptions };`,
    context,
  );
  await new Promise((resolve) => setImmediate(resolve));
  return { ...context.__api, el: byId, permissionRequests };
}

test("模型列表使用原生 select，不依赖会过滤当前输入值的 datalist", () => {
  const html = fs.readFileSync(path.join(ROOT, "options.html"), "utf8");
  assert.doesNotMatch(html, /<datalist\b/i);
  assert.doesNotMatch(html, /\blist=["']modelOptions["']/i);
  assert.match(html, /<select[^>]+id=["']modelOptions["'][^>]+hidden/i);
});

test("设置页提供自动、较短、较长三档概览分块模式", () => {
  const html = fs.readFileSync(path.join(ROOT, "options.html"), "utf8");
  assert.match(html, /id=["']analysisChunkMode["']/);
  for (const value of ["auto", "short", "long"]) {
    assert.match(html, new RegExp(`value=["']${value}["']`));
  }
});

test("设置页允许调整相邻分块重复的上下文字符数", () => {
  const html = fs.readFileSync(path.join(ROOT, "options.html"), "utf8");
  assert.match(html, /id=["']analysisOverlapChars["']/);
  assert.match(html, /重复上下文字符数/);
});

test("拉取后在原位置用下拉框替换输入框，不显示两套重复控件", async () => {
  const ctx = await createContext();

  await ctx.el("fetchModelsBtn").dispatch("click");

  const picker = ctx.el("modelOptions");
  assert.deepEqual(
    ctx.permissionRequests.map((request) => request.origins[0]),
    ["https://api.example.com/"],
    "权限申请应直接发生在按钮点击调用栈，兼容 Chrome 与 Edge 的用户手势要求",
  );
  assert.equal(picker.hidden, false);
  assert.equal(ctx.el("aiModel").hidden, true);
  assert.deepEqual(
    picker.children.map((option) => option.value),
    ["already-filled-model", "model-a", "model-b", ""],
  );
  assert.equal(ctx.el("aiModel").value, "already-filled-model");

  picker.value = "model-b";
  await picker.dispatch("change");
  assert.equal(ctx.el("aiModel").value, "model-b");

  picker.value = "";
  await picker.dispatch("change");
  assert.equal(picker.hidden, true);
  assert.equal(ctx.el("aiModel").hidden, false);
  assert.equal(ctx.el("aiModel").focused, true);
});
