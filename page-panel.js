// 页内悬浮外壳：收起时保留 iframe，避免中断字幕、问答和正在执行的任务。
(() => {
  "use strict";
  if (document.getElementById("bili-digest-page-panel")) return;
  let host = null, ui = null, revision = 0, desiredOpen = false;
  let expanded = false, pinned = false, gesture = null, collapseTimer = null;
  let overBubble = false, overPanel = false;
  const defaultLayout = () => ({
    x: Math.max(8, window.innerWidth - 464), y: 90, width: 440, height: 620,
    bubbleX: Math.max(8, window.innerWidth - 64), bubbleY: 24, pinned: false,
  });
  const initialLayout = defaultLayout();
  const bounds = { x: initialLayout.x, y: initialLayout.y, width: initialLayout.width, height: initialLayout.height };
  const bubblePosition = { x: initialLayout.bubbleX, y: initialLayout.bubbleY };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, Math.max(lo, hi)));

  let layoutVersion = 0, pendingSaves = 0, deferredLayout = null;
  function applyLayout(layout) {
    if (!layout) return;
    if (gesture || pendingSaves) {
      if (!deferredLayout || (layout.version || 0) >= (deferredLayout.version || 0)) deferredLayout = layout;
      return;
    }
    if ((layout.version || 0) < layoutVersion) return;
    layoutVersion = layout.version || 0;
    for (const key of ["x", "y", "width", "height"]) {
      if (Number.isFinite(layout[key])) bounds[key] = layout[key];
    }
    if (Number.isFinite(layout.bubbleX)) bubblePosition.x = layout.bubbleX;
    if (Number.isFinite(layout.bubbleY)) bubblePosition.y = layout.bubbleY;
    if (typeof layout.pinned === "boolean") pinned = layout.pinned;
    if (pinned) { cancelCollapse(); expanded = true; }
    else if (!overBubble && !overPanel) expanded = false;
    paint();
  }
  async function saveLayout(layout) {
    revision++;
    pendingSaves++;
    try {
      const result = await chrome.runtime.sendMessage({ action: "setPagePanelLayout", layout });
      pendingSaves--;
      if (result?.success) applyLayout(result.layout);
      else console.warn("[Bilibili Digest] 无法保存悬浮布局");
      if (!pendingSaves && !gesture && deferredLayout) {
        const deferred = deferredLayout; deferredLayout = null; applyLayout(deferred);
      }
    } catch (error) {
      pendingSaves--;
      console.warn("[Bilibili Digest] 无法保存悬浮布局", error);
    }
  }
  function constrain() {
    bounds.width = clamp(bounds.width, Math.min(320, window.innerWidth - 16), window.innerWidth - 16);
    bounds.height = clamp(bounds.height, Math.min(240, window.innerHeight - 16), window.innerHeight - 16);
    bounds.x = clamp(bounds.x, 8, window.innerWidth - bounds.width - 8);
    bounds.y = clamp(bounds.y, 8, window.innerHeight - bounds.height - 8);
    bubblePosition.x = clamp(bubblePosition.x, 8, window.innerWidth - 52);
    bubblePosition.y = clamp(bubblePosition.y, 8, window.innerHeight - 52);
  }
  function paint() {
    if (!ui) return;
    constrain();
    Object.assign(ui.panel.style, { left: `${bounds.x}px`, top: `${bounds.y}px`, width: `${bounds.width}px`, height: `${bounds.height}px` });
    Object.assign(ui.bubble.style, { left: `${bubblePosition.x}px`, top: `${bubblePosition.y}px` });
    ui.panel.hidden = !expanded;
    ui.bubble.setAttribute("aria-expanded", String(expanded));
    ui.pin.setAttribute("aria-pressed", String(pinned));
    ui.pin.textContent = pinned ? "已固定" : "固定";
    ui.pin.title = pinned ? "取消固定，移出后自动收起" : "固定面板，移出后保持展开";
    ui.frame.style.pointerEvents = gesture ? "none" : "auto";
  }
  function cancelCollapse() { clearTimeout(collapseTimer); collapseTimer = null; }
  function show() { cancelCollapse(); expanded = true; paint(); }
  function scheduleCollapse() {
    cancelCollapse();
    if (pinned || gesture || overBubble || overPanel) return;
    // 留出从悬浮按钮跨过间隙进入详情的时间。
    collapseTimer = setTimeout(() => {
      if (!pinned && !gesture && !overBubble && !overPanel) { expanded = false; paint(); }
    }, 260);
  }
  function draggable(element, direction = "move") {
    element.addEventListener("pointerdown", event => {
      if (event.button !== 0 || event.target.closest?.(".actions")) return;
      cancelCollapse();
      gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, original: { ...bounds }, bubble: { ...bubblePosition }, direction };
      element.setPointerCapture(event.pointerId);
      event.preventDefault();
      paint();
    });
    element.addEventListener("pointermove", event => {
      if (!gesture || gesture.id !== event.pointerId) return;
      const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
      const original = gesture.original;
      if (direction === "move") {
        bubblePosition.x = gesture.bubble.x + dx; bubblePosition.y = gesture.bubble.y + dy;
        if (element === ui.bubble) {
          bounds.x = bubblePosition.x; bounds.y = bubblePosition.y + 52;
        } else {
          bounds.x = original.x + dx; bounds.y = original.y + dy;
        }
      } else {
        const minW = Math.min(320, window.innerWidth - 16), minH = Math.min(240, window.innerHeight - 16);
        let left = original.x, top = original.y, right = left + original.width, bottom = top + original.height;
        if (direction.includes("w")) left = clamp(left + dx, 8, right - minW);
        if (direction.includes("e")) right = clamp(right + dx, left + minW, window.innerWidth - 8);
        if (direction.includes("n")) top = clamp(top + dy, 8, bottom - minH);
        if (direction.includes("s")) bottom = clamp(bottom + dy, top + minH, window.innerHeight - 8);
        Object.assign(bounds, { x: left, y: top, width: right - left, height: bottom - top });
      }
      paint();
    });
    const finish = event => {
      if (!gesture || gesture.id !== event.pointerId) return;
      gesture = null;
      if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
      // Pointer capture 会延迟 leave；结束时按实际指针位置重新判断。
      const contains = node => {
        const r = node.getBoundingClientRect();
        return event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom;
      };
      overBubble = contains(ui.bubble);
      overPanel = expanded && contains(ui.panel);
      paint(); scheduleCollapse();
      saveLayout({ ...bounds, bubbleX: bubblePosition.x, bubbleY: bubblePosition.y });
    };
    element.addEventListener("pointerup", finish);
    element.addEventListener("pointercancel", finish);
    element.addEventListener("lostpointercapture", finish);
  }
  function render(open) {
    desiredOpen = open;
    if (!open) {
      cancelCollapse(); gesture = null; expanded = false;
      overBubble = false; overPanel = false;
      host?.remove(); host = null; ui = null; return;
    }
    if (host?.isConnected) return;
    expanded = pinned;
    host = document.createElement("div");
    host.id = "bili-digest-page-panel";
    host.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;display:block!important;";
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `:host{color-scheme:light dark} *{box-sizing:border-box} [hidden]{display:none!important} button{font:13px system-ui;cursor:pointer} .bubble{position:absolute;width:44px;height:44px;border-radius:50%;border:1px solid #ffb4cb;background:#fb7299;color:white;font-weight:750;font-size:16px;box-shadow:0 4px 16px #9f365340;pointer-events:auto;touch-action:none;cursor:grab} .panel{position:absolute;display:flex;flex-direction:column;border:1px solid #e9dce1;border-radius:14px;background:#faf6f7;color:#51424a;box-shadow:0 12px 42px #38202e35;pointer-events:auto;font:13px system-ui} .bar{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:40px;padding:5px 10px;border-bottom:1px solid #ece4e7;cursor:grab;touch-action:none;user-select:none} .title{font-weight:650;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.actions{display:flex;gap:4px}.actions button{border:0;background:transparent;color:inherit;border-radius:6px;padding:5px 8px;white-space:nowrap}.actions button:hover,.actions button[aria-pressed=true]{background:#fb729924;color:#b53b61} iframe{display:block;border:0;width:100%;flex:1;min-height:0;background:#faf6f7;border-radius:0 0 13px 13px} .handle{position:absolute;touch-action:none;z-index:2}.n,.s{height:8px;left:10px;right:10px;cursor:ns-resize}.n{top:-4px}.s{bottom:-4px}.e,.w{width:8px;top:10px;bottom:10px;cursor:ew-resize}.e{right:-4px}.w{left:-4px}.ne,.nw,.se,.sw{width:14px;height:14px}.ne,.se{right:-4px}.nw,.sw{left:-4px}.ne,.nw{top:-4px}.se,.sw{bottom:-4px}.ne,.sw{cursor:nesw-resize}.nw,.se{cursor:nwse-resize}.se:after{content:'◢';position:absolute;right:4px;bottom:3px;font-size:10px;color:#a29a9e}button:focus-visible{outline:2px solid #b53b61;outline-offset:2px}@media(prefers-color-scheme:dark){.panel,iframe{background:#201b1e;color:#e6dce1;border-color:#4a3b43}.bar{border-color:#4a3b43}}`;
    const bubble = document.createElement("button");
    bubble.className = "bubble"; bubble.type = "button"; bubble.textContent = "DG";
    bubble.title = "Digest：移入展开，拖动调整位置";
    bubble.setAttribute("aria-label", "展开 Digest 面板");
    bubble.addEventListener("pointerenter", () => { overBubble = true; show(); });
    bubble.addEventListener("pointerleave", () => { overBubble = false; scheduleCollapse(); });
    bubble.addEventListener("click", show);
    bubble.addEventListener("focus", show);
    draggable(bubble);
    const panel = document.createElement("section"); panel.className = "panel";
    panel.setAttribute("aria-label", "Digest for Bilibili 悬浮面板");
    panel.addEventListener("pointerenter", () => { overPanel = true; cancelCollapse(); });
    panel.addEventListener("pointerleave", () => { overPanel = false; scheduleCollapse(); });
    const bar = document.createElement("div"); bar.className = "bar"; bar.title = "拖动移动面板";
    const title = document.createElement("span"); title.className = "title"; title.textContent = "Digest for Bilibili";
    const actions = document.createElement("div"); actions.className = "actions";
    const pin = document.createElement("button"); pin.className = "pin"; pin.type = "button";
    pin.addEventListener("click", () => { pinned = !pinned; paint(); if (pinned) show(); else scheduleCollapse(); saveLayout({ pinned }); });
    const reset = document.createElement("button"); reset.className = "reset"; reset.type = "button";
    reset.textContent = "恢复默认布局";
    reset.title = "重置大小、位置和固定状态，并同步所有 B 站标签页";
    reset.addEventListener("click", async () => {
      reset.disabled = true;
      try {
        await saveLayout(defaultLayout());
        scheduleCollapse();
      } finally { reset.disabled = false; }
    });
    const close = document.createElement("button"); close.className = "close"; close.type = "button";
    close.textContent = "×"; close.title = "关闭所有 B 站页面中的 Digest，点击插件重新启用";
    close.setAttribute("aria-label", "关闭 Digest");
    close.addEventListener("click", async () => {
      revision++; render(false);
      try { await chrome.runtime.sendMessage({ action: "setPagePanelOpen", open: false }); }
      catch (error) { console.warn("[Bilibili Digest] 无法保存关闭状态", error); }
    });
    const frame = document.createElement("iframe");
    frame.title = "Digest 字幕、概览与笔记"; frame.allow = "clipboard-write";
    frame.src = chrome.runtime.getURL("sidepanel.html?embedded=1");
    actions.append(reset, pin, close); bar.append(title, actions); panel.append(bar, frame);
    draggable(bar);
    for (const direction of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
      const handle = document.createElement("div"); handle.className = `handle ${direction}`;
      handle.title = "拖动调整大小"; draggable(handle, direction); panel.append(handle);
    }
    shadow.append(style, panel, bubble);
    ui = { panel, bubble, pin, frame }; paint();
    document.documentElement.appendChild(host);
  }
  chrome.runtime.onMessage.addListener(message => {
    if (message?.action === "pagePanelLayoutChanged") {
      applyLayout(message.layout);
      return;
    }
    if (message?.action !== "pagePanelStateChanged") return;
    revision++; render(message.open === true);
  });
  async function restore() {
    const ticket = revision;
    try {
      const result = await chrome.runtime.sendMessage({ action: "getPagePanelState" });
      if (ticket === revision && result?.success && !gesture && !pendingSaves) {
        applyLayout(result.layout);
        render(result.open === true);
      }
    } catch (error) { console.warn("[Bilibili Digest] 无法恢复页内面板", error); }
  }
  window.addEventListener("resize", paint);
  window.addEventListener("pageshow", restore);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") restore();
  });
  setInterval(() => { if (desiredOpen && !host?.isConnected) render(true); }, 1500);
  restore();
})();
