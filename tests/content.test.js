const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/**
 * content script 的注入测试。
 *
 * 加载的是真正的 content.js，只把 DOM 和 chrome API 换成桩。重点守三件事：
 * 页面稳定之前一个节点都不许动（动了会让 B 站的 Vue 放弃 hydration、整页重渲染），
 * 浮动按钮不能挂进 <video> 的直接父节点，以及按钮被重渲染删掉之后能补回来。
 *
 * 桩里的 setTimeout 直接转发给真实计时器并把延时压成 0，
 * 这样脚本里那串「等 load、等播放器、再等一会儿」的 await 能在毫秒内走完。
 */

const ROOT = path.join(__dirname, "..");
const SOURCE = fs.readFileSync(path.join(ROOT, "content.js"), "utf8");

function createDom() {
  const byId = new Map();
  const bySelector = new Map();

  function makeElement(tag = "div") {
    const element = {
      tagName: String(tag).toUpperCase(),
      id: "",
      className: "",
      title: "",
      type: "",
      textContent: "",
      isConnected: true,
      children: [],
      style: { cssText: "", position: "" },
      attributes: {},
      setAttribute(name, value) {
        this.attributes[name] = String(value);
      },
      appendChild(child) {
        this.children.push(child);
        child.isConnected = true;
        if (child.id) byId.set(child.id, child);
        return child;
      },
      append(...nodes) {
        for (const node of nodes) this.appendChild(node);
      },
      remove() {
        this.isConnected = false;
        if (this.id) byId.delete(this.id);
      },
      listeners: {},
      addEventListener(type, handler) {
        (this.listeners[type] ||= []).push(handler);
      },
      // 支持 #id 和 .class 两种形态：前者找 overlay，后者找笔记按钮的文案 span。
      querySelector(selector) {
        const text = String(selector);
        const matches = text.startsWith(".")
          ? (node) => node.className === text.slice(1)
          : (node) => node.id === text.replace(/^#/, "");
        const walk = (node) => {
          for (const child of node.children) {
            if (matches(child)) return child;
            const hit = walk(child);
            if (hit) return hit;
          }
          return null;
        };
        return walk(this);
      },
    };
    return element;
  }

  const document = {
    readyState: "complete",
    title: "测试视频_哔哩哔哩_bilibili",
    createElement: (tag) => makeElement(tag),
    createElementNS: (namespace, tag) => makeElement(tag),
    getElementById: (id) => byId.get(id) || null,
    querySelector: (selector) => bySelector.get(selector) || null,
    addEventListener() {},
  };

  // 播放器已挂上 <video> 是脚本判断「页面稳定了」的条件之一，默认给上。
  bySelector.set("video", makeElement("video"));

  return {
    document,
    makeElement,
    /** 注册一个能被 document.querySelector(selector) 命中的元素。 */
    register(selector, element = makeElement()) {
      bySelector.set(selector, element);
      return element;
    },
  };
}

/** 让脚本里的 await 链跑完。延时都被压成 0，几个宏任务足够。 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

function click(element) {
  const event = { preventDefault() {}, stopPropagation() {} };
  for (const handler of element.listeners.click || []) handler(event);
}

/**
 * 只推进微任务。按钮的临时文案是靠 setTimeout 还原的，而桩把延时压成了 0——
 * 一旦让出宏任务，文案就已经变回去了，什么都测不到。
 */
async function settle() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

function start({
  dom,
  href = "https://www.bilibili.com/video/BV1xx411c7mD",
  sendMessage = () => Promise.resolve({ success: true }),
}) {
  const intervals = [];
  const context = {
    console,
    // 压成 0：脚本等的是「页面稳定」这个事件顺序，不是具体秒数。
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout,
    setInterval: (fn) => {
      intervals.push(fn);
      return intervals.length;
    },
    getComputedStyle: () => ({ position: "relative" }),
    location: { href, search: "" },
    window: { addEventListener() {} },
    document: dom.document,
    chrome: {
      runtime: {
        sendMessage,
        onMessage: { addListener() {} },
      },
    },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(SOURCE, context);

  return { tick: () => intervals.forEach((fn) => fn()) };
}

/** 启动脚本并等它走完「页面稳定」的等待链。 */
async function run(options) {
  const handle = start(options);
  await flush();
  return handle;
}

const OVERLAY_ID = "bili-digest-overlay";
const DIGEST_ID = "bili-digest-button";
const NOTE_ID = "bili-digest-note-button";

test("页面稳定之前一个节点都不动", async () => {
  const dom = createDom();
  const toolbar = dom.register(".video-toolbar-left");
  const player = dom.register("#bilibili-player");

  // 只启动、不等待：这一刻相当于 document_idle，B 站的 Vue 可能还没 hydrate 完。
  const { tick } = start({ dom });

  assert.deepEqual(
    toolbar.children,
    [],
    "hydration 之前改 DOM，Vue 会放弃服务端那棵树整页重渲染——视频会加载两遍",
  );
  assert.deepEqual(player.children, []);

  await flush();

  assert.ok(
    toolbar.children.some((child) => child.id === DIGEST_ID),
    "等页面稳定之后总得把按钮放上去",
  );
  assert.ok(tick);
});

test("浮动按钮不会挂进直接包着 <video> 的那一层", async () => {
  const dom = createDom();

  // 模拟 B 站把 <video> 直接放在首选容器里的情形。往这一层插外来节点，
  // 播放器初始化时会推倒重建，表现就是刷新页面后视频加载两遍。
  const videoWrap = dom.register("#bilibili-player .bpx-player-primary-area");
  const video = dom.makeElement("video");
  videoWrap.appendChild(video);

  const safeHost = dom.register("#bilibili-player");

  await run({ dom });

  assert.equal(
    videoWrap.querySelector(`#${OVERLAY_ID}`),
    null,
    "挂在 <video> 的直接父节点上会让播放器重建视频",
  );
  assert.ok(
    safeHost.querySelector(`#${OVERLAY_ID}`),
    "应该退到下一个不抱着 <video> 的容器",
  );
});

test("所有候选容器都抱着 <video> 时，宁可不挂浮动按钮", async () => {
  const dom = createDom();
  for (const selector of [
    "#bilibili-player .bpx-player-primary-area",
    "#bilibili-player",
    ".bpx-player-container",
    "#playerWrap",
  ]) {
    dom.register(selector).appendChild(dom.makeElement("video"));
  }
  const toolbar = dom.register(".video-toolbar-left");

  await run({ dom });

  assert.equal(dom.document.getElementById(NOTE_ID), null, "没有安全的落点就不挂");
  assert.ok(
    toolbar.children.some((child) => child.id === DIGEST_ID),
    "Digest 按钮在工具栏里，不受浮动容器缺失的影响",
  );
});

test("工具栏存在时 Digest 按钮进工具栏，笔记按钮进播放器浮层", async () => {
  const dom = createDom();
  const toolbar = dom.register(".video-toolbar-left");
  const player = dom.register("#bilibili-player");

  await run({ dom });

  assert.ok(toolbar.children.some((child) => child.id === DIGEST_ID));
  assert.ok(player.querySelector(`#${NOTE_ID}`));
});

test("笔记按钮带图标，文案单独放一个 span", async () => {
  const dom = createDom();
  dom.register(".video-toolbar-left");
  const player = dom.register("#bilibili-player");

  await run({ dom });

  const button = player.querySelector(`#${NOTE_ID}`);
  assert.deepEqual(
    button.children.map((child) => child.tagName),
    ["SVG", "SPAN"],
  );
  assert.equal(button.children[1].textContent, "笔记");
  // 保存反馈改的是这个 span。要是直接写 button.textContent，图标会被一起抹掉。
  assert.ok(button.querySelector(".bili-digest-note-label"));
});

test("笔记写满本地空间时，播放器按钮说明真实原因", async () => {
  const dom = createDom();
  dom.register(".video-toolbar-left");
  const player = dom.register("#bilibili-player");

  await run({
    dom,
    sendMessage: () =>
      Promise.resolve({
        success: false,
        error: "STORAGE_FULL",
        message: "浏览器本地存储空间不足，已有笔记没有被删除。",
      }),
  });

  const button = player.querySelector(`#${NOTE_ID}`);
  click(button);
  await settle();

  assert.equal(button.children[1].textContent, "空间不足");
  assert.match(button.title, /已有笔记没有被删除/);
});

test("按钮被重渲染删掉后，定时自查会补回来", async () => {
  const dom = createDom();
  const toolbar = dom.register(".video-toolbar-left");
  dom.register("#bilibili-player");

  const { tick } = await run({ dom });
  const injected = toolbar.children.find((child) => child.id === DIGEST_ID);
  assert.ok(injected);

  // B 站重渲染工具栏，把我们的按钮一起丢掉。
  injected.remove();
  toolbar.children = [];

  tick();

  assert.ok(
    toolbar.children.some((child) => child.id === DIGEST_ID),
    "重渲染之后按钮没补回来，用户就再也点不开侧边栏了",
  );
});

/**
 * 页面里的按钮靠给 service worker 发消息来开侧边栏，而浏览器要求 open() 发生在
 * 用户手势里。手势能否随消息传过来，Chrome 认，Edge 不一定认。被拒绝时按钮必须
 * 说点什么——一个点了毫无反应的按钮，用户只会当扩展坏了。
 */
test("侧边栏打不开时，Digest 按钮把人指向工具栏图标", async () => {
  const dom = createDom();
  const toolbar = dom.register(".video-toolbar-left");
  dom.register("#bilibili-player");

  await run({
    dom,
    sendMessage: () =>
      Promise.resolve({ success: false, needsToolbarClick: true }),
  });

  const button = toolbar.children.find((child) => child.id === DIGEST_ID);
  click(button);
  await settle();

  assert.match(button.textContent, /工具栏/, "拒绝之后得告诉用户改从哪里打开");
});

test("侧边栏正常打开时按钮不多话", async () => {
  const dom = createDom();
  const toolbar = dom.register(".video-toolbar-left");
  dom.register("#bilibili-player");

  await run({ dom });

  const button = toolbar.children.find((child) => child.id === DIGEST_ID);
  click(button);
  await settle();

  // 每次点都跳一句提示，等于狼来了，真出问题时没人看。
  assert.equal(button.textContent, "Digest");
});

test("不是播放页时什么都不注入", async () => {
  const dom = createDom();
  const toolbar = dom.register(".video-toolbar-left");
  dom.register("#bilibili-player");

  await run({ dom, href: "https://www.bilibili.com/" });

  assert.deepEqual(toolbar.children, []);
});
