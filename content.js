/**
 * Bilibili Digest — content script（B 站播放页）：注入 Digest / 笔记按钮，
 * n 快捷键记笔记，响应侧边栏的播放器指令。
 *
 * 工具栏选择器是一组候选，全部落空时退化成播放器上的浮动按钮。
 * 贯穿全文件的一条纪律：**页面稳定之前不碰 DOM**，原因见 SETTLE_DELAY_MS。
 */

(() => {
  "use strict";

  const DEBUG = false;
  const debugLog = (...args) => {
    if (DEBUG) console.log("[Bilibili Digest]", ...args);
  };

  const OVERLAY_ID = "bili-digest-overlay";
  const DIGEST_BUTTON_ID = "bili-digest-button";
  const NOTE_BUTTON_ID = "bili-digest-note-button";
  const NOTE_LABEL_CLASS = "bili-digest-note-label";

  // 从左到右依次尝试，命中即用。覆盖新旧两版播放页。
  const TOOLBAR_SELECTORS = [
    ".video-toolbar-left",
    ".video-toolbar-container .toolbar-left",
    "#arc_toolbar_report .toolbar-left",
    ".toolbar-left",
    ".video-toolbar-v1 .toolbar-left",
  ];
  // 浮动按钮挂在哪一层。硬约束：不能挂进直接包着 <video> 的那层——那层归
  // B 站播放器自己管，插外来节点会让它推倒重建，视频加载两遍。
  const PLAYER_SELECTORS = [
    "#bilibili-player .bpx-player-primary-area",
    "#bilibili-player",
    ".bpx-player-container",
    "#playerWrap",
  ];

  // 按钮自查的间隔。B 站重渲染后要靠它把按钮补回去。
  const REINJECT_INTERVAL_MS = 800;

  /**
   * 等页面稳定下来再动 DOM。B 站播放页是 SSR + Vue hydration：hydration 跑完
   * 之前往它管的容器插节点，Vue 会判定两端对不上、把整棵树推倒重渲染，
   * 表现为视频加载两遍。没有公开的「hydration 完成」信号，用三个条件近似：
   * window.load 已发生、<video> 已挂上、再留一点余量。
   */
  const SETTLE_DELAY_MS = 1200;
  const PLAYER_POLL_MS = 200;
  const PLAYER_WAIT_TIMEOUT_MS = 15000;

  // ============================================================
  // 页面读取
  // ============================================================

  // 播放页是 /video/BVxxx，合集播放页把 BV 号放在 ?bvid= 里，所以整个 URL 都要看。
  const currentBvid = () => {
    const match = location.href.match(/BV[0-9A-Za-z]{10}/);
    return match ? match[0] : null;
  };

  const currentPage = () => {
    const match = location.search.match(/[?&]p=(\d+)/);
    const page = match ? Number(match[1]) : 1;
    return Number.isFinite(page) && page > 0 ? page : 1;
  };

  const firstMatch = (selectors) => {
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element) return element;
    }
    return null;
  };

  const holdsVideoDirectly = (element) =>
    Array.prototype.some.call(
      element.children || [],
      (child) => child.tagName === "VIDEO",
    );

  // 外层容器，且不是 <video> 的直接父节点，才能安全挂东西。
  function playerContainer() {
    for (const selector of PLAYER_SELECTORS) {
      const element = document.querySelector(selector);
      if (element && !holdsVideoDirectly(element)) return element;
    }
    return null;
  }

  const videoElement = () =>
    document.querySelector(".bpx-player-video-wrap video") ||
    document.querySelector("video");

  function readVideoInfo() {
    const titleNode =
      document.querySelector("h1.video-title") ||
      document.querySelector(".video-title") ||
      document.querySelector("h1[title]");
    const ownerNode =
      document.querySelector(".up-info-container .up-name") ||
      document.querySelector("a.up-name") ||
      document.querySelector(".up-name");
    const video = videoElement();

    return {
      bvid: currentBvid(),
      page: currentPage(),
      // B 站标题带 "_哔哩哔哩_bilibili" 后缀，DOM 拿不到时才退回它。
      title:
        titleNode?.getAttribute("title")?.trim() ||
        titleNode?.textContent?.trim() ||
        document.title.replace(/_哔哩哔哩.*$/, "").trim(),
      owner: ownerNode?.textContent?.trim() || "",
      duration: Number(video?.duration) || 0,
      currentTime: Number(video?.currentTime) || 0,
    };
  }

  // ============================================================
  // 按钮
  // ============================================================

  const BUTTON_BASE = `display:inline-flex;align-items:center;gap:6px;
     padding:6px 14px;border:none;border-radius:6px;cursor:pointer;
     font-size:13px;line-height:1.4;color:#fff;white-space:nowrap;`;

  const SVG_NS = "http://www.w3.org/2000/svg";

  // 便签 + 笔。跟侧边栏笔记页用的是同一个图形（sidepanel.html 的雪碧图 #i-note）。
  const NOTE_ICON_PATHS = [
    "M8.6 2.4H4.1c-.6 0-1.1.5-1.1 1.1v8.9c0 .6.5 1.1 1.1 1.1h6.2c.6 0 1.1-.5 1.1-1.1V7.9",
    "M11.2 2.2a1.4 1.4 0 0 1 2 2L9.1 8.3l-2.5.5.5-2.5Z",
  ];

  // 逐个节点建 SVG 而非 innerHTML：B 站若启用 Trusted Types，innerHTML 会被拦掉。
  function noteIcon() {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("width", "14");
    svg.setAttribute("height", "14");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.5");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    for (const d of NOTE_ICON_PATHS) {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", d);
      svg.appendChild(path);
    }
    return svg;
  }

  function styleButton(button, { floating }) {
    button.style.cssText = floating
      ? `${BUTTON_BASE}background:rgba(251,114,153,.92);box-shadow:0 2px 8px rgba(0,0,0,.2);`
      : `${BUTTON_BASE}background:#fb7299;margin-left:12px;`;
  }

  // 浮动按钮共用一个纵向容器，否则 Digest 退化成浮动按钮时会和笔记按钮叠在一起。
  function ensureOverlay() {
    const player = playerContainer();
    if (!player) return null;

    let overlay = player.querySelector(`#${OVERLAY_ID}`);
    if (overlay?.isConnected) return overlay;

    // 浮动定位需要一个定位上下文，播放器容器默认可能是 static。
    if (getComputedStyle(player).position === "static") {
      player.style.position = "relative";
    }
    overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.style.cssText = `position:absolute;top:12px;right:12px;z-index:9999;
       display:flex;flex-direction:column;align-items:flex-end;gap:8px;`;
    player.appendChild(overlay);
    return overlay;
  }

  function flashDigestButton(text) {
    const button = document.getElementById(DIGEST_BUTTON_ID);
    if (!button) return;
    button.textContent = text;
    setTimeout(() => {
      if (button.isConnected) button.textContent = "Digest";
    }, 2600);
  }

  // 浏览器可能拒绝从这里程序化打开侧边栏（Edge 对用户手势的判定比 Chrome 严）。
  // 那时唯一走得通的是工具栏图标，它由浏览器自己处理，所以把人指过去。
  async function openSidePanel() {
    let result = null;
    try {
      result = await chrome.runtime.sendMessage({ action: "openSidePanel" });
    } catch (error) {
      // service worker 正在重启之类，下面统一按打不开处理。
    }
    if (!result?.success) flashDigestButton("请点工具栏图标 →");
  }

  function injectDigestButton() {
    const existing = document.getElementById(DIGEST_BUTTON_ID);
    if (existing?.isConnected) return;

    const button = document.createElement("button");
    button.id = DIGEST_BUTTON_ID;
    button.type = "button";
    button.textContent = "Digest";
    button.title = "打开 Digest for Bilibili 侧边栏";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openSidePanel();
    });

    const toolbar = firstMatch(TOOLBAR_SELECTORS);
    if (toolbar) {
      styleButton(button, { floating: false });
      toolbar.appendChild(button);
      debugLog("Digest 按钮已注入工具栏");
      return;
    }

    const overlay = ensureOverlay();
    if (overlay) {
      styleButton(button, { floating: true });
      overlay.appendChild(button);
      debugLog("工具栏未命中，Digest 按钮退化为浮动按钮");
    }
  }

  function injectNoteButton() {
    const existing = document.getElementById(NOTE_BUTTON_ID);
    if (existing?.isConnected) return;

    const overlay = ensureOverlay();
    if (!overlay) return;

    const button = document.createElement("button");
    button.id = NOTE_BUTTON_ID;
    button.type = "button";
    button.title = "在当前时间点记一条笔记（快捷键 n）";
    // 文案单独放一个 span：保存反馈只换这里的字，图标留在原处。
    const label = document.createElement("span");
    label.className = NOTE_LABEL_CLASS;
    label.textContent = "笔记";
    button.append(noteIcon(), label);
    styleButton(button, { floating: true });
    button.style.background = "rgba(0,0,0,.55)";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      saveNoteAtCurrentTime();
    });
    overlay.appendChild(button);
  }

  function injectButtons() {
    if (!currentBvid()) return;
    injectDigestButton();
    injectNoteButton();
  }

  // ============================================================
  // 记笔记
  // ============================================================

  let noteInFlight = false;

  function flashNoteButton(text) {
    const button = document.getElementById(NOTE_BUTTON_ID);
    const label = button?.querySelector(`.${NOTE_LABEL_CLASS}`);
    if (!label) return;
    label.textContent = text;
    setTimeout(() => {
      if (button.isConnected) label.textContent = "笔记";
    }, 1800);
  }

  async function saveNoteAtCurrentTime() {
    const video = videoElement();
    const bvid = currentBvid();
    if (!video || !bvid || noteInFlight) return;

    // 连点几下不该存出几条一样的笔记，在途时忽略而不是排队。
    noteInFlight = true;
    flashNoteButton("保存中…");
    try {
      const result = await chrome.runtime.sendMessage({
        action: "saveNote",
        bvid,
        page: currentPage(),
        timestamp: Math.floor(video.currentTime || 0),
      });
      flashNoteButton(result?.success ? "已保存" : "保存失败");
    } catch (error) {
      flashNoteButton("保存失败");
    } finally {
      noteInFlight = false;
    }
  }

  // 用户在弹幕框或搜索框里打字时，n 是普通字符，不能抢。
  function isTypingTarget(target) {
    if (!target) return false;
    const tag = target.tagName;
    return (
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      target.isContentEditable === true
    );
  }

  function handleKeydown(event) {
    if (event.key !== "n" && event.key !== "N") return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (isTypingTarget(event.target)) return;
    event.preventDefault();
    saveNoteAtCurrentTime();
  }

  // ============================================================
  // 消息处理
  // ============================================================

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.action === "getVideoInfo") {
      sendResponse(readVideoInfo());
      return false;
    }

    if (message?.action === "getPlaybackTime") {
      const video = videoElement();
      sendResponse({
        currentTime: Number(video?.currentTime) || 0,
        paused: video ? video.paused : true,
      });
      return false;
    }

    if (message?.action === "seekTo") {
      const video = videoElement();
      if (!video) {
        sendResponse({ success: false, error: "NO_PLAYER" });
        return false;
      }
      video.currentTime = Math.max(0, Number(message.seconds) || 0);
      // 用户从侧边栏点时间戳意味着想看这一段，暂停着就顺手播起来。
      if (video.paused) video.play().catch(() => {});
      sendResponse({ success: true });
      return false;
    }

    return false;
  });

  // ============================================================
  // 启动
  // ============================================================

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function whenWindowLoaded() {
    if (document.readyState === "complete") return Promise.resolve();
    return new Promise((resolve) =>
      window.addEventListener("load", () => resolve(), { once: true }),
    );
  }

  // <video> 挂上说明应用已渲染过一轮。等不到也别一直等下去。
  async function whenPlayerMounted() {
    const deadline = Date.now() + PLAYER_WAIT_TIMEOUT_MS;
    while (!videoElement() && Date.now() < deadline) {
      await delay(PLAYER_POLL_MS);
    }
  }

  async function init() {
    // 挂监听不碰 DOM，不会干扰 hydration，可以立刻生效。
    document.addEventListener("keydown", handleKeydown);

    await whenWindowLoaded();
    await whenPlayerMounted();
    await delay(SETTLE_DELAY_MS);

    injectButtons();
    // 定时自查而非 MutationObserver：弹幕每飘一条都是 DOM 变更，观察 body 白烧
    // CPU 还会让防抖永远等不到空档。定时器顺带覆盖了 SPA 换页（不触发事件）。
    setInterval(injectButtons, REINJECT_INTERVAL_MS);
  }

  init();
})();
