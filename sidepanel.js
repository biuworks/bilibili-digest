/**
 * Bilibili Digest — 侧边栏：字幕 / 概览 / 笔记三个标签页。
 *
 * 字幕区三视图（原文 / 译文 / 双语）人人都有，翻译方向由字幕语种决定；
 * 「顺句」只给中文字幕，且与三视图可叠加（开着顺句时原文指顺句稿）。
 * 侧边栏是全窗口共享的，标签页查询都限定在本面板所属窗口内。
 */

"use strict";

const POLL_INTERVAL_MS = 1000;
// 用户手动滚动后先别抢滚动条；有「回到当前句」浮标兜底，这个窗口可以放宽。
const AUTOSCROLL_SUPPRESS_MS = 8000;

const state = {
  windowId: null,
  tabId: null,
  bvid: null,
  page: 1,
  data: null,
    analysis: null,
    analysisFailures: [],
  polished: {}, // 分段 id → 顺句后的文字
  polishMode: false,
  translated: {}, // 分段 id → 译文（中文字幕对应英文，外文字幕对应中文）
  transcriptMode: "original", // original | translated | bilingual
  isChinese: true, // 决定顺句入口的有无与翻译方向的提示
  polishRun: 0, // 换视频/切换显示方式时自增，用来作废进行中的批次
  view: "idle", // idle | loading | error | ready
  errorResult: null,
  tab: "transcript",
    notesScope: "video", // video | all
    notes: [],
    notesQuery: "",
  activeIndex: -1,
  lastUserScrollAt: 0,
  lastAutoScrollAt: 0,
  searchQuery: "", // 搜索期间暂停自动跟随，命中行之外全部藏起
  aiTasks: { analysis: null, rewrite: null },
};

const el = (id) => document.getElementById(id);

// ============================================================
// 与 service worker 通信
// ============================================================

/**
 * MV3 的 service worker 随时会被回收，再唤醒之间有一段空窗。这期间发出的
 * 消息浏览器会直接拒掉，报「Receiving end does not exist」——它意味着后台
 * 压根没收到，处理函数一定没执行过，所以重发一定安全。
 */
const BACKGROUND_UNREACHABLE_PATTERNS = [
  "Could not establish connection",
  "Receiving end does not exist",
];

/**
 * 这一类不同：通道是通的，消息可能已经在后台跑了一半才断线。重发写操作会
 * 造成重复执行（多一条笔记、多一次计费），所以只有调用方明确声明幂等时才重试。
 */
const BACKGROUND_DROPPED_PATTERNS = [
  "message port closed",
  "Extension context invalidated",
];

const BACKGROUND_MAX_ATTEMPTS = 3;
const BACKGROUND_RETRY_DELAY_MS = 200;

function errorMatches(error, patterns) {
  const text = String(error?.message || error || "");
  return patterns.some((pattern) => text.includes(pattern));
}

function isBackgroundUnreachable(error) {
  return errorMatches(error, BACKGROUND_UNREACHABLE_PATTERNS);
}

function isBackgroundDropped(error) {
  return errorMatches(error, BACKGROUND_DROPPED_PATTERNS);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 所有发往 service worker 的消息都走这里。idempotent 只放开「可能已执行过」
// 那一类的重试，默认关闭：宁可报错，也不重复扣一次模型调用或多存一条笔记。
async function sendToBackground(message, { idempotent = false } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= BACKGROUND_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      lastError = error;
      const retryable =
        isBackgroundUnreachable(error) || (idempotent && isBackgroundDropped(error));
      if (!retryable || attempt === BACKGROUND_MAX_ATTEMPTS) break;
      await delay(BACKGROUND_RETRY_DELAY_MS * attempt);
    }
  }
  throw lastError;
}

const BACKGROUND_UNAVAILABLE = "BACKGROUND_UNAVAILABLE";

// 重试完还是够不着后台，就别再假装是字幕出了问题：请求根本没发出去，
// 和账号、密钥、网络都无关，用户该做的是把扩展重新启用一次。
function backgroundErrorResult(error) {
  if (!isBackgroundUnreachable(error) && !isBackgroundDropped(error)) {
    return { message: error.message };
  }
  return {
    error: BACKGROUND_UNAVAILABLE,
    message:
      "扩展的后台进程没有响应，请求没能发出去。这与 B 站账号、AI 密钥和网络都无关。"
      + "请打开浏览器的扩展管理页，把本扩展关闭再重新开启，然后点下方重试；"
      + "若仍然无效，卸载后重新安装即可恢复。",
  };
}

function makeTaskId(kind) {
  const suffix = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  return `${kind}-${suffix}`;
}

async function startAiTask(kind, target = {}) {
  const taskId = makeTaskId(kind);
  const result = await sendToBackground({
    action: "startAiTask",
    taskId,
    kind,
    ...target,
  });
  return result?.success ? taskId : null;
}

// 字幕行的 DOM 索引，renderSegments 时重建。直接持有节点引用让查找变 O(1)：
// 用 querySelector 找行的话，上千段的视频全量重画就是 O(n²)，切视图会卡。
const segmentView = {
  rows: [], // 与 segments 同下标
  byId: new Map(), // 分段 id → { row, text, searchText }
  activeRow: null,
};

// 金句按钮的「已保存」完全跟着真实笔记数据走，不靠会话内存硬记：
// videoNoteSeconds 是「当前视频已有笔记的时刻集合」，渲染、保存、删除都从它派生。
let videoNoteSeconds = new Set();

// 已渲染的金句按钮引用（quoteKey → { button, seconds }），
// 笔记数据变化时用来同步按钮状态，不必整块重渲染概览。
const quoteSaveButtons = new Map();

// 金句笔记的标识：同一视频同一时刻只有一条，重渲染后按钮状态也能对得上。
function quoteNoteKey(quote) {
  return `${state.bvid}:${state.page}:${quote.timestampSeconds}:${quote.quote}`;
}

// 从笔记存储里重读当前视频已有的笔记时刻。
async function refreshVideoNoteSeconds() {
  if (!state.bvid) {
    videoNoteSeconds = new Set();
    return;
  }
  try {
    const result = await sendToBackground(
      { action: "getNotes", bvid: state.bvid, page: state.page },
      { idempotent: true },
    );
    videoNoteSeconds = new Set(
      (result?.notes || []).map((note) => Number(note.timestampSeconds)),
    );
  } catch (error) {
    // 读不到就保持现状：按钮状态旧一点，总比全盘解锁误加重复笔记好。
  }
}

// 笔记增删后，把概览里金句按钮的「已保存 / 存为笔记」与真实数据对齐。
async function syncQuoteButtonsWithNotes() {
  await refreshVideoNoteSeconds();
  for (const { button, seconds } of quoteSaveButtons.values()) {
    const saved = videoNoteSeconds.has(seconds);
    button.disabled = saved;
    button.textContent = saved ? "已保存" : "存为笔记";
  }
}

// ============================================================
// 渲染调度
// ============================================================

const SECTIONS = [
  "loadingState",
  "idleState",
  "errorState",
  "transcriptPanel",
  "overviewPanel",
  "notesPanel",
  "qaPanel",
];

// 笔记独立于字幕管线：即使字幕拉取失败，之前存的笔记也应该能看。
function render() {
  for (const id of SECTIONS) el(id).hidden = true;

  if (state.tab === "notes") {
    el("notesPanel").hidden = false;
    return;
  }
  if (state.tab === "qa") {
    el("qaPanel").hidden = false;
    return;
  }
  if (state.view !== "ready") {
    el(`${state.view}State`).hidden = false;
    return;
  }
  el(state.tab === "overview" ? "overviewPanel" : "transcriptPanel").hidden = false;
}

function setView(view, errorResult = null) {
  state.view = view;
  state.errorResult = errorResult;

  // 取字幕期间让刷新按钮的图标转起来，明示「正在做」。
  el("refreshBtn").classList.toggle("spinning", view === "loading");

  if (view === "error" && errorResult) {
    const needLogin = errorResult.error === "NEED_LOGIN";
    const backgroundDown = errorResult.error === BACKGROUND_UNAVAILABLE;
    el("errorTitle").textContent = needLogin
      ? "字幕需要登录"
      : backgroundDown
        ? "扩展后台未响应"
        : "没能取到字幕";
    el("errorText").textContent =
      errorResult.message || errorResult.error || "未知错误，请重试。";
    el("errorLoginLink").hidden = !needLogin;
  }
  render();
}

function switchTab(tab) {
  state.tab = tab;
  for (const button of document.querySelectorAll(".tab")) {
    const active = button.dataset.tab === tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  }
  hideExplain();
  updateFollowPill();
  if (tab === "notes") loadNotes();
  if (tab === "qa") loadQaHistory();
  render();
}

// ============================================================
// 当前标签页
// ============================================================

// 播放页是 /video/BVxxx，合集播放页把 BV 号放在 ?bvid= 里，两种都要认。
function parseBvid(url) {
  const text = String(url || "");
  if (!text.includes("bilibili.com")) return null;
  const match = text.match(/BV[0-9A-Za-z]{10}/);
  return match ? match[0] : null;
}

function parsePage(url) {
  const match = String(url || "").match(/[?&]p=(\d+)/);
  const page = match ? Number(match[1]) : 1;
  return Number.isFinite(page) && page > 0 ? page : 1;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, windowId: state.windowId });
  return tab || null;
}

// 跟随当前标签页：换了视频就重新取字幕，不是播放页就回到提示态。
async function syncWithActiveTab({ force = false } = {}) {
  const tab = await activeTab();
  const bvid = parseBvid(tab?.url);

  if (!bvid) {
    state.bvid = null;
    state.data = null;
    state.analysis = null;
    state.analysisFailures = [];
    setView("idle");
    // 笔记页不跟字幕管线走：离开视频页后「本视频」立刻没了参照物，
    // 重读一遍，别让上一个视频的笔记赖在列表里。
    if (state.tab === "notes") loadNotes();
    return;
  }

  const page = parsePage(tab.url);
  const unchanged = bvid === state.bvid && page === state.page && state.data;
  state.tabId = tab.id;
  state.bvid = bvid;
  state.page = page;
  if (unchanged && !force) return;

  state.analysis = null;
  state.analysisFailures = [];
  await loadTranscript({ force });
  if (state.tab === "notes") loadNotes();
  if (state.tab === "qa") loadQaHistory();
}

// ============================================================
// 字幕
// ============================================================

// 同一视频的同一次取字幕只有一个在途请求。开新标签页/从别的页点进视频时，
// onActivated 和 onUpdated 会前后脚各触发一次同步，不合并就会拉两遍、
// 界面闪两下。相同 key 的调用共享同一个 promise；不同 key 的调用
// （换视频、强制刷新）排队等上一个落地再发，避免两个结果先后到达互相覆盖。
let transcriptLoad = null; // { key, promise }

// 消息通道偶尔会无声无息地死掉（service worker 被回收时）。sendMessage 的
// promise 若永远不落地，后面所有加载都会卡在「等上一个」上，所以设一道保险。
const TRANSCRIPT_FETCH_TIMEOUT_MS = 30_000;

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function loadTranscript({ force = false } = {}) {
  const key = `${state.bvid}:${state.page}:${force ? "force" : "normal"}`;
  if (transcriptLoad?.key === key) return transcriptLoad.promise;
  if (transcriptLoad) await transcriptLoad.promise;

  const promise = (async () => {
    // 请求发出后用户可能又切了视频：结果回来时先对一下「票」，
    // 票对不上就不写界面，旧视频的字幕不会闪一下又换掉。
    const requestedBvid = state.bvid;
    const requestedPage = state.page;

    el("loadingTitle").textContent = "正在获取字幕…";
    el("loadingSubtitle").textContent = force ? "已跳过缓存" : "";
    el("videoMeta").hidden = true;
    setView("loading");

    let result;
    try {
      result = await withTimeout(
        sendToBackground(
          {
            action: "fetchTranscript",
            bvid: requestedBvid,
            page: requestedPage,
            forceRefresh: force,
          },
          { idempotent: true },
        ),
        TRANSCRIPT_FETCH_TIMEOUT_MS,
        "字幕获取超时，请重试。",
      );
    } catch (error) {
      if (state.bvid !== requestedBvid || state.page !== requestedPage) return;
      setView("error", backgroundErrorResult(error));
      return;
    }

    if (state.bvid !== requestedBvid || state.page !== requestedPage) return;

    if (!result?.success) {
      if (result?.videoInfo) renderMeta(result.videoInfo, null, false);
      setView("error", result);
      return;
    }

    state.data = result;
    state.activeIndex = -1;
    // 之前顺过的句、翻过的译随缓存一起回来了，直接复用，不必再花一次钱。
    state.polished = result.polished || {};
    state.translated = result.translated || {};
    state.polishRun += 1;
    // 缓存里有就直接摆出来，否则用户会以为上次白跑了。
    state.polishMode = Object.keys(state.polished).length > 0;
    state.isChinese = BILI_TRANSCRIPT.isChineseSubtitle(result.language);
    state.transcriptMode = Object.keys(state.translated).length > 0 ? "bilingual" : "original";
    renderMeta(result.videoInfo, result, result.fromCache);
    renderSegments(result.segments);
    // 换了视频，上一个视频的搜索词不该继续过滤新列表。
    closeSearch();
    updateTranscriptControls();
    await restoreOverview(result.analysis, {
      analysisFailures: result.analysisFailures,
    });
    setView("ready");
  })();

  transcriptLoad = { key, promise };
  try {
    return await promise;
  } finally {
    // 只清自己这一趟：等待期间可能已经有新的加载把它换掉了。
    if (transcriptLoad?.promise === promise) transcriptLoad = null;
  }
}

function renderMeta(videoInfo, result, fromCache) {
  el("videoTitle").textContent = videoInfo?.title || "";
  el("videoOwner").textContent = videoInfo?.owner || "";

  const badge = el("subtitleBadge");
  if (result) {
    badge.textContent = `${result.languageLabel || result.language}${result.isAiSubtitle ? " · AI" : ""}`;
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }

  el("cacheBadge").hidden = !fromCache;
  el("videoMeta").hidden = false;
}

function renderSegments(segments = []) {
  const list = el("transcriptList");
  list.textContent = "";
  el("segmentCount").textContent = segmentCountText();
  segmentView.rows = [];
  segmentView.byId = new Map();
  segmentView.activeRow = null;

  const fragment = document.createDocumentFragment();
  segments.forEach((segment, index) => {
    const row = document.createElement("div");
    row.className = "segment";
    row.dataset.index = String(index);
    row.dataset.id = segment.id;

    const time = document.createElement("span");
    time.className = "segment-time";
    time.textContent = BILI_TRANSCRIPT.formatTimestamp(segment.start);

    const text = document.createElement("span");
    text.className = "segment-text";
    paintSegmentText(text, segment);

    row.append(time, text);
    row.addEventListener("click", (event) => onEntryClick(event, segment.start));
    fragment.appendChild(row);
    segmentView.rows.push(row);
    segmentView.byId.set(segment.id, {
      row,
      text,
      // 搜索用的可匹配文本在这里一次算好，逐键过滤时直接读，不再每敲一个字符重建。
      searchText: buildSegmentSearchText(segment),
    });
  });
  list.appendChild(fragment);
}

// 这一段的「原文」——中文字幕开着顺句时，原文指的是顺句稿。
function sourceText(segment) {
  if (state.isChinese && state.polishMode && state.polished[segment.id]) {
    return state.polished[segment.id];
  }
  return segment.text;
}

// 这一段该显示什么文字。双语模式要两行，不走这里，见 paintSegmentText。
function segmentDisplayText(segment) {
  if (state.transcriptMode === "translated") {
    // 还没翻到这一段时先摆原文，比留一片空白好读。
    return state.translated[segment.id] || sourceText(segment);
  }
  return sourceText(segment);
}

// 把文字写进节点，命中搜索词的部分套上 <mark>。字幕是外部内容，
// 一律 textContent 逐节点写、不拼 HTML；切片逻辑统一走 lib/highlight.js
// （与笔记搜索同一套匹配语义），这里只负责按字幕的样式拼装节点。
function writeText(node, text) {
  const source = String(text || "");
  const segments = BILI_HIGHLIGHT.splitMatches(source, state.searchQuery);
  if (!BILI_HIGHLIGHT.hasMatch(segments)) {
    // 一条也没命中：双语的另一行命中了，这一行照常显示。
    node.textContent = source;
    return;
  }

  node.textContent = "";
  for (const segment of segments) {
    if (!segment.text) continue;
    if (segment.hit) {
      const hit = document.createElement("mark");
      hit.className = "search-hit";
      hit.textContent = segment.text;
      node.appendChild(hit);
    } else {
      const plain = document.createElement("span");
      plain.textContent = segment.text;
      node.appendChild(plain);
    }
  }
}

function paintSegmentText(node, segment) {
  if (state.transcriptMode === "bilingual") {
    node.textContent = "";
    const source = document.createElement("span");
    source.className = "segment-source";
    writeText(source, sourceText(segment));

    const translation = document.createElement("span");
    const ready = state.translated[segment.id];
    translation.className = ready
      ? "segment-translation"
      : "segment-translation pending";
    if (ready) writeText(translation, ready);
    else translation.textContent = "翻译中…";

    node.append(source, translation);
    return;
  }
  writeText(node, segmentDisplayText(segment));
}

// 用户正在选词时，点击不应该被当成跳转。
function hasTextSelection() {
  const selection = window.getSelection();
  return !!selection && selection.rangeCount > 0 && !selection.isCollapsed;
}

function onEntryClick(event, seconds) {
  if (hasTextSelection()) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  seekTo(seconds);
}

async function seekTo(seconds) {
  if (!state.tabId) return;
  try {
    await chrome.tabs.sendMessage(state.tabId, {
      action: "seekTo",
      seconds: Math.floor(seconds),
    });
  } catch (error) {
    // 页面刚刷新时 content script 可能还没就位，忽略即可。
  }
}

// ============================================================
// 播放进度跟随
// ============================================================

function highlightActive(currentSeconds) {
  const segments = state.data?.segments || [];
  if (!segments.length || state.tab !== "transcript") return;

  // 分段按开始时间有序，二分找「最后一个 start <= 当前时刻」的下标。
  let low = 0;
  let high = segments.length - 1;
  let index = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (segments[mid].start <= currentSeconds) {
      index = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (index === state.activeIndex) return;

  segmentView.activeRow?.classList.remove("active");
  state.activeIndex = index;
  segmentView.activeRow = index >= 0 ? segmentView.rows[index] || null : null;
  if (!segmentView.activeRow) return;
  segmentView.activeRow.classList.add("active");

  // 搜索时列表被过滤过，滚动条属于搜索结果，不抢。
  if (state.searchQuery) return;
  if (Date.now() - state.lastUserScrollAt < AUTOSCROLL_SUPPRESS_MS) return;
  state.lastAutoScrollAt = Date.now();
  segmentView.activeRow.scrollIntoView({ block: "center", behavior: "smooth" });
}

async function trackPlayback() {
  if (!state.tabId || !state.data || state.view !== "ready") return;
  try {
    const response = await chrome.tabs.sendMessage(state.tabId, {
      action: "getPlaybackTime",
    });
    if (response) highlightActive(Number(response.currentTime) || 0);
  } catch (error) {
    // content script 不在（页面正在跳转）——下一轮再试。
  }
  // 挂在轮询里而不是滚动事件里，抑制窗口过期后浮标才能自己消失。
  updateFollowPill();
}

// ============================================================
// 「回到当前句」浮标 + 字幕搜索
// ============================================================

// 自动跟随停下来时（用户滚开了，或正在搜索），给一条一键回到播放位置的路。
function updateFollowPill() {
  const suppressed = Date.now() - state.lastUserScrollAt < AUTOSCROLL_SUPPRESS_MS;
  const show =
    state.view === "ready" &&
    state.tab === "transcript" &&
    state.activeIndex >= 0 &&
    (Boolean(state.searchQuery) || suppressed);
  el("followPill").hidden = !show;
}

function scrollToActive() {
  const row = segmentView.rows[state.activeIndex];
  if (!row) return;
  // 记一笔，免得这次滚动被滚动监听当成「用户滚开了」。
  state.lastAutoScrollAt = Date.now();
  row.scrollIntoView({ block: "center", behavior: "smooth" });
}

function jumpToActive() {
  // 从搜索结果跳回来时顺手收掉搜索，否则当前句多半被过滤藏着；
  // closeSearch 自己会把视线送回当前句，这里不必再滚一次。
  if (state.searchQuery) closeSearch();
  else scrollToActive();
  state.lastUserScrollAt = 0;
  updateFollowPill();
}

// 搜索匹配「屏幕上可能出现过的所有文字」：原文、顺句稿、译文。
// 结果按分段缓存（renderSegments 建、repaintSegmentText 更新）：逐键过滤时
// 上千段的视频每敲一个字符就重建并小写化一遍，纯属白烧 CPU。
function buildSegmentSearchText(segment) {
  return [segment.text, state.polished[segment.id], state.translated[segment.id]]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

function applySearchFilter(query) {
  state.searchQuery = String(query || "").trim().toLowerCase();
  const segments = state.data?.segments || [];

  let hits = 0;
  let firstHit = null;
  segments.forEach((segment, index) => {
    const cached = segmentView.byId.get(segment.id);
    const searchText = cached?.searchText ?? buildSegmentSearchText(segment);
    const match = !state.searchQuery || searchText.includes(state.searchQuery);
    if (match) {
      hits += 1;
      if (!firstHit) firstHit = segmentView.rows[index] || null;
    }
    const row = segmentView.rows[index];
    if (row) row.hidden = !match;
  });

  // 重画是为了给命中的字套上 <mark>，光靠过滤眼睛没有落点。
  repaintSegmentText();
  el("searchCount").textContent = state.searchQuery ? `${hits} 条命中` : "";

  // 滚到首个命中行，否则用户看到一片空白会以为搜索没生效。
  // 逐键过滤时用瞬时滚动，平滑动画会互相打架。
  if (state.searchQuery && firstHit) {
    state.lastAutoScrollAt = Date.now();
    firstHit.scrollIntoView({ block: "center", behavior: "auto" });
  }
  updateFollowPill();
}

function openSearch() {
  el("searchRow").hidden = false;
  el("searchInput").focus?.();
}

function closeSearch() {
  el("searchRow").hidden = true;
  el("searchInput").value = "";
  applySearchFilter("");
  // 收起搜索后视线还留在某条命中上，把它送回正在播的那句。
  scrollToActive();
}

// ============================================================
// 进度条
// ============================================================

const PROGRESS_NODES = {
  // 顺句和翻译按语种二选一，同一时刻只会有一个在跑，共用这一条进度。
  rewrite: { row: "rewriteProgress", bar: "rewriteProgressBar", text: "rewriteProgressText" },
  analysis: { row: null, bar: "overviewProgressBar", text: "overviewProgressText" },
};

function showProgress(kind, done, total, message = "") {
  const nodes = PROGRESS_NODES[kind];
  if (!nodes) return;
  if (nodes.row) el(nodes.row).hidden = false;

  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  el(nodes.bar).style.width = `${percent}%`;
  el(nodes.text).textContent = message
    || (total > 0 ? `${done}/${total} 批完成（${percent}%）` : "正在准备…");
}

function hideProgress(kind) {
  const nodes = PROGRESS_NODES[kind];
  if (!nodes) return;
  if (nodes.row) el(nodes.row).hidden = true;
  el(nodes.bar).style.width = "0%";
}

// 设置在设置页改动后不会自动同步过来，每次用之前读一遍。
async function loadSettings() {
  const stored = await chrome.storage.local.get(BILI_SETTINGS.STORAGE_KEY);
  return BILI_SETTINGS.normalize(stored[BILI_SETTINGS.STORAGE_KEY]);
}

function applyStoredUiFontScale(raw) {
  BILI_SETTINGS.applyUiFontScale(BILI_SETTINGS.normalize(raw).uiFontScale);
}

async function watchUiFontScale() {
  const stored = await chrome.storage.local.get(BILI_SETTINGS.STORAGE_KEY);
  applyStoredUiFontScale(stored[BILI_SETTINGS.STORAGE_KEY]);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[BILI_SETTINGS.STORAGE_KEY]) return;
    applyStoredUiFontScale(changes[BILI_SETTINGS.STORAGE_KEY].newValue);
  });
}

function segmentCountText() {
  return `${state.data?.segments?.length || 0} 段`;
}

// 借分段计数那一行显示临时提示，几秒后还原。
function showSegmentNotice(message) {
  el("segmentCount").textContent = message;
  setTimeout(() => {
    el("segmentCount").textContent = segmentCountText();
  }, 5000);
}

// 顺句只给中文字幕（外文字幕本来就带标点）；顺句和翻译任何一个在跑时
// 两套控件都锁住，免得两轮改写互相踩对方的批次。
function updateTranscriptControls(running) {
  const busy = Boolean(running);

  const button = el("polishBtn");
  button.hidden = !state.isChinese;
  button.disabled = busy;
  button.textContent =
    running === "polish" ? "顺句中" : state.polishMode ? "恢复原文" : "顺句";
  el("transcriptProcessMenu").hidden = !state.data;

  const modes = el("transcriptMode");
  modes.hidden = !state.data;
  for (const node of modes.querySelectorAll(".segmented-btn")) {
    const active = node.dataset.mode === state.transcriptMode;
    node.classList.toggle("active", active);
    node.setAttribute("aria-pressed", String(active));
    node.disabled = busy;
  }
  el("transcriptViewLabel").textContent =
    running === "polish"
      ? "顺句中"
      : state.transcriptMode === "translated"
        ? "译文"
        : state.transcriptMode === "bilingual"
          ? "双语"
          : state.polishMode
            ? "顺句"
            : "原文";
  el("rewriteStopBtn").hidden = !busy;
}

// 只重画文字，不重建整个列表——重建会丢掉高亮和滚动位置。
function repaintSegmentText(segmentIds) {
  const segments = state.data?.segments || [];
  const wanted = segmentIds ? new Set(segmentIds) : null;

  for (const segment of segments) {
    if (wanted && !wanted.has(segment.id)) continue;
    const nodes = segmentView.byId.get(segment.id);
    if (nodes) {
      paintSegmentText(nodes.text, segment);
      // 顺句稿 / 译文变了，搜索要能命中新文字，同步刷新缓存的匹配文本。
      nodes.searchText = buildSegmentSearchText(segment);
    }
  }
}

// 顺句和翻译是同一套流程，差异集中在这张表里。
const REWRITE_KINDS = Object.freeze({
  polish: {
    action: "polishSegments",
    field: "polished",
    label: "顺句",
    plan: (segments) => BILI_AI.planPunctuationBatches(segments),
  },
  translate: {
    action: "translateSegments",
    field: "translated",
    label: "翻译",
    plan: (segments) => BILI_AI.planTranslationBatches(segments),
  },
});

// 偶发失败（限流、超时抖动）自动补一轮前的等待。太短会撞回同一次限流窗口。
const REWRITE_RETRY_DELAY_MS = 1500;

async function togglePolish() {
  if (!state.data) return;

  state.polishMode = !state.polishMode;
  // 关掉再打开时，上一轮还在飞的批次不应该再往界面上写。
  state.polishRun += 1;
  repaintSegmentText();
  updateTranscriptControls();

  if (state.polishMode) await runRewrite("polish", state.polishRun);
}

async function setTranscriptMode(mode) {
  if (!state.data) return;
  if (!["original", "translated", "bilingual"].includes(mode)) return;
  if (mode === state.transcriptMode) return;

  state.transcriptMode = mode;
  state.polishRun += 1;
  repaintSegmentText();
  updateTranscriptControls();

  if (mode !== "original") await runRewrite("translate", state.polishRun);
}

// 从当前播放位置切开、后半段优先：眼前的内容几秒内就有结果，
// 前面的部分随后补齐——总量和费用完全不变。
function orderFromPlayback(todo) {
  const segments = state.data?.segments || [];
  const active = segments[state.activeIndex];
  if (!active) return todo;

  const ahead = [];
  const behind = [];
  for (const segment of todo) {
    (segment.start >= active.start ? ahead : behind).push(segment);
  }
  return [...ahead, ...behind];
}

async function runRewrite(kind, run) {
  if (state.aiTasks.rewrite) return;
  const task = REWRITE_KINDS[kind];
  const segments = state.data?.segments || [];
  const todo = segments.filter((segment) => !state[task.field][segment.id]);
  if (!todo.length) {
    updateTranscriptControls();
    return;
  }

  const taskId = await startAiTask(kind, {
    bvid: state.bvid,
    page: state.page,
  });
  if (!taskId) {
    showSegmentNotice(`${task.label}任务已经在运行。`);
    return;
  }
  state.aiTasks.rewrite = { id: taskId, kind, label: task.label };

  const batches = task.plan(orderFromPlayback(todo));
  const concurrency = (await loadSettings()).aiConcurrency;

  showProgress("rewrite", 0, batches.length);
  updateTranscriptControls(kind);

  const runBatch = async (batch) => {
    if (run !== state.polishRun) return null;
    const result = await sendToBackground({
      action: task.action,
      taskId,
      bvid: state.bvid,
      page: state.page,
      segmentIds: batch.map((segment) => segment.id),
    });
    if (!result?.success) throw new Error(result?.message || `${task.label}失败`);

    // 每批一回来就刷到界面上，用户可以边生成边往下读。
    if (run === state.polishRun) {
      const done = result[task.field] || {};
      Object.assign(state[task.field], done);
      repaintSegmentText(Object.keys(done));
    }
    return result;
  };

  const results = await BILI_CONCURRENCY.mapWithConcurrency(
    batches,
    concurrency,
    runBatch,
    (done, total) => {
      if (run === state.polishRun) {
        showProgress("rewrite", done, total, `正在处理第 ${done}/${total} 批`);
        sendToBackground({
          action: "updateAiTaskProgress",
          taskId,
          done,
          total,
          phase: "generating",
          message: `正在处理第 ${done}/${total} 批`,
        }).catch(() => {});
      }
    },
  );

  // 偶发失败（限流、超时抖动）静默补一轮，别让用户手点。
  // 全军覆没就不补了——那多半是配置错误，重试只会把同一个错误再撞一遍。
  const failedIndexes = results
    .map((result, index) => (result.status === "rejected" ? index : -1))
    .filter((index) => index >= 0);
  if (
    failedIndexes.length &&
    failedIndexes.length < batches.length &&
    run === state.polishRun
  ) {
    await new Promise((resolve) => setTimeout(resolve, REWRITE_RETRY_DELAY_MS));
    const retried = await BILI_CONCURRENCY.mapWithConcurrency(
      failedIndexes.map((index) => batches[index]),
      concurrency,
      runBatch,
    );
    failedIndexes.forEach((batchIndex, i) => {
      if (retried[i].status === "fulfilled") results[batchIndex] = retried[i];
    });
  }

  if (run !== state.polishRun) {
    await finishRewriteTask(taskId, "canceled", "已取消");
    return;
  }
  hideProgress("rewrite");

  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length === batches.length) {
    // 全失败多半是没配好或被限流，退回原文并说明原因。
    if (kind === "polish") state.polishMode = false;
    else state.transcriptMode = "original";
    repaintSegmentText();
    showSegmentNotice(failures[0].reason?.message || `${task.label}失败`);
  } else if (failures.length) {
    // 部分失败仍保留已成功的部分，剩下的再点一次即可补齐。
    showSegmentNotice(`${failures.length} 批失败，再点一次「${task.label}」可以补齐。`);
  }
  updateTranscriptControls();
  await finishRewriteTask(taskId, "completed", "已完成");
}

async function finishRewriteTask(taskId, taskState, message) {
  if (state.aiTasks.rewrite?.id !== taskId) return;
  await sendToBackground(
    { action: "finishAiTask", taskId, state: taskState, message },
    { idempotent: true },
  ).catch(() => {});
  state.aiTasks.rewrite = null;
  hideProgress("rewrite");
  updateTranscriptControls();
}

async function cancelRewrite() {
  const task = state.aiTasks.rewrite;
  if (!task) return;
  state.polishRun += 1;
  showProgress("rewrite", 0, 0, "正在停止…");
  await sendToBackground(
    { action: "cancelAiTask", taskId: task.id },
    { idempotent: true },
  );
  if (task.kind === "translate") {
    state.transcriptMode = "original";
    repaintSegmentText();
  }
  showSegmentNotice(`${task.label}已取消，已经完成的内容会保留。`);
}

// ============================================================
// AI 概览
// ============================================================

const OVERVIEW_EMPTY_TITLE = "生成 AI 概览";
const OVERVIEW_EMPTY_TEXT =
  "把整段字幕交给大模型，产出覆盖全片的章节和 3-5 条金句。需要先在设置页配置 AI 服务。";

function resetOverview() {
  state.analysis = null;
  state.analysisFailures = [];
  const empty = el("overviewEmpty");
  // 上一个视频可能把这里改成了错误提示，换视频时要还原。
  empty.querySelector(".state-title").textContent = OVERVIEW_EMPTY_TITLE;
  empty.querySelector(".state-text").textContent = OVERVIEW_EMPTY_TEXT;
  const label = el("analyzeBtn").querySelector("span");
  if (label) label.textContent = "生成概览";
  empty.hidden = false;
  el("overviewLoading").hidden = true;
  el("overviewResult").hidden = true;
}

// 概览随字幕缓存一起回来，有就直接摆出来——否则一次已完成的生成会看起来像失败了。
async function restoreOverview(analysis, { analysisFailures = [] } = {}) {
  resetOverview();
  if (!analysis) return;
  state.analysis = analysis;
  state.analysisFailures = Array.isArray(analysisFailures) ? analysisFailures : [];
  // 先对齐笔记数据，再渲染：金句按钮的「已保存」从一开始就跟着真实数据走。
  await refreshVideoNoteSeconds();
  renderAnalysis(analysis, true);
}

async function analyze({ force = false, retryFailed = false } = {}) {
  if (!state.bvid) return;
  if (state.aiTasks.analysis) return;
  if (retryFailed && !state.analysisFailures.length) return;
  // 与字幕加载同款票据：生成期间用户可能已经切到别的视频，
  // 旧视频的概览不许写进当前界面。
  const requestedBvid = state.bvid;
  const requestedPage = state.page;
  const previousAnalysis = state.analysis;
  const previousFailures = state.analysisFailures;
  const taskId = await startAiTask("analysis", {
    bvid: requestedBvid,
    page: requestedPage,
  });
  if (!taskId) {
    el("overviewEmpty").querySelector(".state-title").textContent = "概览正在生成";
    el("overviewEmpty").querySelector(".state-text").textContent =
      "同一视频已经有一个概览任务在运行。";
    return;
  }
  state.aiTasks.analysis = { id: taskId, bvid: requestedBvid, page: requestedPage };
  el("cancelAnalysisBtn").disabled = false;
  el("cancelAnalysisBtn").textContent = "停止生成";
  el("overviewEmpty").hidden = true;
  el("overviewResult").hidden = true;
  el("overviewLoading").hidden = false;
  el("overviewLoadingTitle").textContent = retryFailed ? "正在补失败块…" : "正在生成概览…";
  // 分块数量由 background 算，这里先归零，等第一条进度广播回来再填。
  showProgress("analysis", 0, 0);

  let result;
  try {
    result = await sendToBackground({
      action: retryFailed ? "retryFailedAnalysis" : "analyzeTranscript",
      taskId,
      bvid: requestedBvid,
      page: requestedPage,
      forceRefresh: force,
    });
  } catch (error) {
    result = { success: false, ...backgroundErrorResult(error) };
  }

  // 结果属于旧视频：background 已经把它落进旧视频的缓存，切回去时会自动摆出来。
  // 这里直接丢弃，loading 态由新视频的 restoreOverview 收掉。
  if (state.aiTasks.analysis?.id === taskId) state.aiTasks.analysis = null;
  el("cancelAnalysisBtn").disabled = false;
  el("cancelAnalysisBtn").textContent = "停止生成";
  el("overviewLoadingTitle").textContent = "正在生成概览…";

  if (state.bvid !== requestedBvid || state.page !== requestedPage) return;

  el("overviewLoading").hidden = true;
  hideProgress("analysis");

  if (!result?.success) {
    // 概览失败不该把整个面板打回错误态——字幕还在，用户可以继续读。
    const canceled = result?.error === "TASK_CANCELED";
    if (canceled && previousAnalysis) {
      state.analysis = previousAnalysis;
      state.analysisFailures = previousFailures;
      renderAnalysis(previousAnalysis, true);
      el("overviewMeta").textContent += retryFailed
        ? " · 已取消补失败块，保留上次结果"
        : " · 已取消重新生成，保留上次结果";
      return;
    }
    el("overviewEmpty").hidden = false;
    el("overviewEmpty").querySelector(".state-title").textContent =
      canceled ? "概览生成已取消" : retryFailed ? "补失败块失败" : "概览生成失败";
    el("overviewEmpty").querySelector(".state-text").textContent =
      canceled ? "已经完成的请求不会写入残缺概览，可以随时重新生成。" : result?.message || "请稍后重试。";
    const label = el("analyzeBtn").querySelector("span");
    if (label) label.textContent = canceled ? "重新生成" : "重试";
    return;
  }

  state.analysis = result.analysis;
  state.analysisFailures = Array.isArray(result.analysisFailures) ? result.analysisFailures : [];
  await refreshVideoNoteSeconds();
  renderAnalysis(result.analysis, result.fromCache);
}

async function cancelAnalysis() {
  const task = state.aiTasks.analysis;
  if (!task) return;
  el("cancelAnalysisBtn").disabled = true;
  el("cancelAnalysisBtn").textContent = "正在停止…";
  showProgress("analysis", 0, 0, "正在停止…");
  await sendToBackground(
    { action: "cancelAiTask", taskId: task.id },
    { idempotent: true },
  );
}

function renderChapterCard(chapter) {
  const card = document.createElement("div");
  card.className = "chapter";

  const head = document.createElement("div");
  head.className = "entry-head";
  const time = document.createElement("span");
  time.className = "entry-time";
  time.textContent = chapter.timestamp;
  const title = document.createElement("span");
  title.className = "entry-title";
  title.textContent = chapter.title;
  head.append(time, title);

  const summary = document.createElement("p");
  summary.className = "entry-text";
  summary.textContent = chapter.summary;

  card.append(head, summary);
  card.addEventListener("click", (event) =>
    onEntryClick(event, chapter.timestampSeconds),
  );
  return card;
}

function renderQuoteCard(quote, { nested = false } = {}) {
  const card = document.createElement("div");
  card.className = nested ? "quote nested" : "quote";

  const head = document.createElement("div");
  head.className = "entry-head";
  const time = document.createElement("span");
  time.className = "entry-time";
  time.textContent = quote.timestamp;
  time.addEventListener("click", (event) => {
    // 嵌套在章节卡里时，点时间戳只该跳金句时刻，不能再冒泡触发章节跳转。
    if (nested) event.stopPropagation();
    onEntryClick(event, quote.timestampSeconds);
  });
  head.appendChild(time);

  const text = document.createElement("p");
  text.className = "entry-text";
  text.textContent = quote.quote;

  const actions = document.createElement("div");
  actions.className = "entry-actions";
  const saveBtn = document.createElement("button");
  saveBtn.className = "ghost-btn";
  // 「已保存」完全跟着真实笔记数据走：这个时刻已有笔记就禁用，
  // 笔记删掉后 syncQuoteButtonsWithNotes 会把它解锁回来。
  const savedKey = quoteNoteKey(quote);
  const seconds = Number(quote.timestampSeconds);
  const alreadySaved = videoNoteSeconds.has(seconds);
  saveBtn.textContent = alreadySaved ? "已保存" : "存为笔记";
  saveBtn.disabled = alreadySaved;
  quoteSaveButtons.set(savedKey, { button: saveBtn, seconds });
  saveBtn.addEventListener("click", async (event) => {
    event.stopPropagation();
    if (saveBtn.disabled) return;
    saveBtn.disabled = true;
    saveBtn.textContent = "保存中…";
    // 金句已经是模型整理过的文本，直接落库，不必再润色一遍。
    const result = await sendToBackground({
      action: "saveNote",
      bvid: state.bvid,
      page: state.page,
      timestamp: quote.timestampSeconds,
      text: quote.quote,
    });
    const saved = Boolean(result?.success);
    if (saved) videoNoteSeconds.add(seconds);
    saveBtn.textContent = saved ? "已保存" : "保存失败";
    setTimeout(() => {
      if (!videoNoteSeconds.has(seconds)) {
        saveBtn.disabled = false;
        saveBtn.textContent = "存为笔记";
      }
    }, 1500);
  });
  actions.appendChild(saveBtn);

  card.append(head, text, actions);
  return card;
}

function renderAnalysis(analysis, fromCache) {
  const failures = Array.isArray(state.analysisFailures) ? state.analysisFailures : [];
  const parts = [
    `${analysis.chapters.length} 章节`,
    `${analysis.keyQuotes.length} 金句`,
  ];
  if (fromCache) parts.push("缓存");
  // 部分块失败时结果是不完整的，必须让用户知道，否则他会以为这就是全片概览。
  if (failures.length) parts.push(`${failures.length} 块失败，结果不完整`);
  el("overviewMeta").textContent = parts.join(" · ");
  el("retryFailedChunksBtn").hidden = !failures.length;

  // 整块重渲染时清掉旧的按钮引用，避免同步到已经不在 DOM 里的按钮。
  quoteSaveButtons.clear();

  // 金句按时间戳挂到所属章节下，形成「章节 → 金句」的层次。
  const { grouped, orphans } = BILI_AI.groupQuotesIntoChapters(
    analysis.chapters,
    analysis.keyQuotes,
  );

  const chapters = el("chapterList");
  chapters.textContent = "";
  for (const { chapter, quotes } of grouped) {
    const card = renderChapterCard(chapter);
    for (const quote of quotes) {
      card.appendChild(renderQuoteCard(quote, { nested: true }));
    }
    chapters.appendChild(card);
  }

  const quoteHeading = el("quoteHeading");
  const quotes = el("quoteList");
  quotes.textContent = "";
  quoteHeading.hidden = true;

  if (!grouped.length && analysis.keyQuotes.length) {
    // 模型没产出章节时退回平铺，金句一行不缺地给用户看。
    quoteHeading.textContent = "金句";
    quoteHeading.hidden = false;
    for (const quote of analysis.keyQuotes) {
      quotes.appendChild(renderQuoteCard(quote));
    }
  } else if (orphans.length) {
    // 落在第一章之前或空档里的金句单列一组，比硬塞进最近的章节诚实。
    quoteHeading.textContent = "其他金句";
    quoteHeading.hidden = false;
    for (const quote of orphans) {
      quotes.appendChild(renderQuoteCard(quote));
    }
  }

  el("overviewEmpty").hidden = true;
  el("overviewResult").hidden = false;
}

// ============================================================
// 笔记
// ============================================================

async function loadNotes() {
  // 「本视频」需要一个参照物：不在播放页时没有「本视频」可言。
  // 此时 getNotes(null) 会被 background 理解成「全部」，于是「本视频」里
  // 摆出一堆别的视频的笔记、按钮全变成「打开」——不许这条路走通。
  if (state.notesScope === "video" && !state.bvid) {
    renderNotes([], { noVideo: true });
    return;
  }
  const result = await sendToBackground(
    {
      action: "getNotes",
      bvid: state.notesScope === "video" ? state.bvid : null,
      page: state.notesScope === "video" ? state.page : null,
    },
    { idempotent: true },
  );
  renderNotes(result?.notes || []);
}

const SVG_NS = "http://www.w3.org/2000/svg";

// 引用 sidepanel.html 顶部雪碧图里的一个图形。
function icon(name) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.appendChild(use);
  return svg;
}

function actionButton({ iconName, label, title, onClick }) {
  const button = document.createElement("button");
  button.className = "ghost-btn";
  button.title = title || label;
  button.appendChild(icon(iconName));
  if (label) {
    const text = document.createElement("span");
    text.textContent = label;
    button.appendChild(text);
  } else {
    button.classList.add("icon-only");
    button.setAttribute("aria-label", title);
  }
  // 把按钮直接递给回调。事件派发结束后 event.currentTarget 会被清空，
  // 回调里一 await（写剪贴板就是）再去读它，拿到的是 null。
  button.addEventListener("click", () => onClick(button));
  return button;
}

function flashActionButton(button, message) {
  const label = button.querySelector("span");
  if (!label) return;
  const original = label.textContent;
  label.textContent = message;
  // 轻轻弹一下，让「已复制」这件事有触觉上的确认。Web Animations API
  // 直接可用；测试桩里的元素没有 animate 方法，用可选链保住兼容。
  button.animate?.(
    [
      { transform: "scale(1)" },
      { transform: "scale(0.9)" },
      { transform: "scale(1)" },
    ],
    { duration: 180, easing: "ease-out" },
  );
  setTimeout(() => {
    label.textContent = original;
  }, 1500);
}

// 「没有视频」在全面板只有一种说法、一种样式：idle 态与笔记页共用这两个常量。
const NO_VIDEO_TITLE = "打开一个 B 站视频";
const NO_VIDEO_TEXT =
  "在 bilibili.com 的播放页打开本面板，就能阅读该视频的字幕。";

const NOTES_EMPTY_TEXT =
  "播放时点播放器上的「笔记」按钮，或按 n，就能记下当前时间点的一条笔记。";

function visibleNotes() {
  return BILI_LEARNING_STORE.filterNotes(state.notes, state.notesQuery);
}

function renderNotes(notes, { noVideo = false } = {}) {
  const list = Array.isArray(notes) ? notes : [];
  state.notes = list;
  const filtered = visibleNotes();
  const searching = Boolean(String(state.notesQuery || "").trim());
  el("notesCount").textContent = searching
    ? `${filtered.length}/${list.length}`
    : list.length
      ? `${list.length} 条`
      : "";
  el("notesSearchRow").hidden = noVideo;
  el("notesSearchCount").textContent = searching ? `${filtered.length} 条匹配` : "";
  el("notesEmpty").hidden = filtered.length > 0;
  const videoScope = state.notesScope !== "all";
  el("exportLearningBtn").hidden = !videoScope;
  el("exportLearningTranscriptBtn").hidden = !videoScope;
  el("notesExportLearningDivider").hidden = !videoScope;

  if (noVideo) {
    // 文案与 idle 态完全一致；图标沿用笔记空态自己的笔记图标，
    // 不再另摆一块品牌方砖（那会像视频页右上角的浮动按钮，显得多余）。
    el("notesEmptyTitle").textContent = NO_VIDEO_TITLE;
    el("notesEmptyText").textContent = NO_VIDEO_TEXT;
  } else if (searching && !filtered.length && list.length) {
    el("notesEmptyTitle").textContent = "没有匹配的笔记";
    el("notesEmptyText").textContent = "试试标题、UP 主或笔记里的词。";
  } else {
    // 「本视频」下空着，多半只是这个视频没记过，别让人以为笔记全丢了。
    el("notesEmptyTitle").textContent =
      state.notesScope === "video" ? "这个视频还没有笔记" : "还没有任何笔记";
    el("notesEmptyText").textContent = NOTES_EMPTY_TEXT;
  }

  const listNode = el("notesList");
  listNode.textContent = "";
  for (const note of filtered) listNode.appendChild(renderNoteCard(note));
}

function applyNotesSearch(query) {
  state.notesQuery = String(query || "");
  renderNotes(state.notes);
}

// Object.assign 不会删除响应里已经移除的 aiDraft；同步笔记状态时要按新对象完整替换。
function replaceNoteState(target, source) {
  for (const key of Object.keys(target)) {
    if (!(key in source)) delete target[key];
  }
  Object.assign(target, source);
}

// ============================================================
// 视频问答
// ============================================================

const QA_FALLBACK_HINT = "未能从字幕中找到足够的依据";
let qaAsking = false;

async function loadQaHistory() {
  if (!state.bvid) {
    renderQaList([]);
    return;
  }
  const result = await sendToBackground({
    action: "getQaHistory",
    bvid: state.bvid,
    page: state.page,
  });
  renderQaList(result?.entries || []);
}

function showQaHint(message) {
  el("qaHint").textContent = message;
  el("qaHint").hidden = false;
}

function setQaAsking(asking) {
  qaAsking = asking;
  el("qaAskBtn").disabled = asking;
  el("qaAskBtn").textContent = asking ? "停止" : "提问";
}

async function submitQuestion() {
  if (qaAsking) {
    // 进行中按钮变「停止」：只取消在途任务，不清输入。
    const running = el("qaAskBtn").dataset.taskId;
    if (running) await sendToBackground({ action: "cancelAiTask", taskId: running });
    return;
  }
  const question = el("qaInput").value.trim();
  if (!question) return;

  const taskId = `qa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  el("qaAskBtn").dataset.taskId = taskId;
  setQaAsking(true);
  hideQaHint();

  try {
    await sendToBackground({ action: "startAiTask", taskId, kind: "qa" });
    const result = await sendToBackground({
      action: "askQuestion",
      taskId,
      bvid: state.bvid,
      page: state.page,
      question,
    });

    if (!result?.success) {
      showQaHint(result?.message || "问答失败，请重试。");
      return;
    }

    el("qaInput").value = "";
    renderQaListPrepend(result.entry);
  } catch (error) {
    showQaHint(error?.message || "问答失败，请重试。");
  } finally {
    setQaAsking(false);
    delete el("qaAskBtn").dataset.taskId;
    updateQaEmptyState();
  }
}

// 列表以 DOM 为准（prepend 新卡片），这里维护一份轻量镜像供清空判断。
let qaEntriesMirror = [];
function currentQaEntries() {
  return qaEntriesMirror;
}

function renderQaList(entries) {
  qaEntriesMirror = Array.isArray(entries) ? entries : [];
  const listNode = el("qaList");
  listNode.textContent = "";
  for (const entry of qaEntriesMirror) listNode.appendChild(renderQaCard(entry));
  updateQaEmptyState();
}

function renderQaListPrepend(entry) {
  qaEntriesMirror.unshift(entry);
  const listNode = el("qaList");
  listNode.prepend(renderQaCard(entry));
}

function updateQaEmptyState() {
  el("qaEmpty").hidden = qaEntriesMirror.length > 0;
}

function hideQaHint() {
  el("qaHint").hidden = true;
}

/** 回答正文里的 [M:SS] 渲染成可点击的时间戳按钮；越界的保留纯文本。 */
function appendAnswerText(node, answer, clickableSeconds) {
  const source = String(answer || "");
  node.textContent = "";
  let cursor = 0;
  const pattern = /\[(\d{1,3}:[0-5]\d)\]/g;
  const clickable = new Set(clickableSeconds || []);
  for (const match of source.matchAll(pattern)) {
    const seconds = BILI_QA_CITATIONS.timestampToSeconds(match[1]);
    const at = match.index;
    if (at > cursor) node.append(source.slice(cursor, at));
    if (seconds !== null && clickable.has(seconds)) {
      node.append(makeTimestampButton(match[1], seconds));
    } else {
      node.append(match[0]);
    }
    cursor = at + match[0].length;
  }
  if (cursor < source.length) node.append(source.slice(cursor));
}

function makeTimestampButton(label, seconds) {
  const button = document.createElement("button");
  button.className = "entry-time time-btn";
  button.textContent = label;
  button.title = "跳到这个时间点";
  button.addEventListener("click", () => seekTo(seconds));
  return button;
}

function qaCitationText(entry) {
  const lines = entry.citations.map(
    (citation) =>
      `[${BILI_QA_CITATIONS.secondsToTimestamp(citation.startSeconds)}] ${citation.quote}`,
  );
  return [entry.answer, ...lines].filter(Boolean).join("\n").slice(0, 3000);
}

function renderQaCard(entry) {
  const card = document.createElement("div");
  card.className = "note qa-card";

  const head = document.createElement("div");
  head.className = "entry-head";
  const askedAt = document.createElement("span");
  askedAt.className = "qa-asked-at muted";
  askedAt.textContent = new Date(entry.createdAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const remove = actionButton({
    iconName: "trash",
    title: "删除这条问答",
    onClick: async () => {
      await sendToBackground({ action: "deleteQaEntry", id: entry.id }, { idempotent: true });
      renderQaList(currentQaEntries().filter((item) => item.id !== entry.id));
    },
  });
  remove.classList.add("note-delete");
  head.append(askedAt, remove);

  const question = document.createElement("p");
  question.className = "qa-question";
  question.textContent = `问：${entry.question}`;

  const answer = document.createElement("div");
  answer.className = "entry-text";
  appendAnswerText(answer, entry.answer, entry.clickable);

  const citations = document.createElement("div");
  citations.className = "note-source qa-citations";
  for (const citation of entry.citations || []) {
    const row = document.createElement("div");
    row.className = "qa-citation-row";
    row.append(makeTimestampButton(BILI_QA_CITATIONS.secondsToTimestamp(citation.startSeconds), citation.startSeconds));
    const quote = document.createElement("span");
    quote.className = "qa-citation-quote";
    quote.textContent = citation.quote;
    row.appendChild(quote);
    citations.appendChild(row);
  }

  const actions = document.createElement("div");
  actions.className = "entry-actions";
  const saveNoteBtn = actionButton({
    iconName: "note",
    title: "存为笔记",
    onClick: async () => {
      await sendToBackground(
        {
          action: "saveNote",
          bvid: entry.bvid,
          page: entry.page,
          timestamp: (entry.citations || [])[0]?.startSeconds ?? 0,
          text: qaCitationText(entry),
        },
        { idempotent: true },
      );
    },
  });
  const copyBtn = actionButton({
    iconName: "copy",
    title: "复制回答",
    onClick: async () => {
      await navigator.clipboard.writeText(qaCitationText(entry));
    },
  });
  actions.append(saveNoteBtn, copyBtn);

  card.append(head, question, answer);
  if ((entry.citations || []).length) card.append(citations);
  card.append(actions);
  return card;
}

// 搜索时把命中片段包进 <mark>。只用 DOM API：项目不走 innerHTML
// （XSS / Trusted Types 防线）。非搜索路径维持原样 textContent。
function appendHighlighted(parent, text, query) {
  const source = String(text ?? "");
  const segments = BILI_HIGHLIGHT.splitMatches(source, query);
  if (!BILI_HIGHLIGHT.hasMatch(segments)) {
    parent.textContent = source;
    return;
  }
  parent.textContent = "";
  for (const segment of segments) {
    if (!segment.text) continue;
    if (segment.hit) {
      const mark = document.createElement("mark");
      mark.textContent = segment.text;
      parent.append(mark);
    } else {
      parent.append(segment.text);
    }
  }
}

function renderNoteCard(note) {
  const card = document.createElement("div");
  card.className = "note";

  // 状态提示（视频已下架之类）常驻在卡片底部，平时藏着。
  const notice = document.createElement("p");
  notice.className = "note-notice";
  notice.hidden = true;
  // 后台还在润色时说一声，不然正文过几秒突然变了会让人纳闷。
  // 时间上限挡住润色中途 service worker 被回收留下的僵尸标记。
  if (note.pending && Date.now() - note.createdAt < 3 * 60 * 1000) {
    setNoteNotice(notice, "AI 正在润色这条笔记…", "muted");
  }
  const play = () => playNote(note, notice);

  const head = document.createElement("div");
  head.className = "entry-head";

  // 时间戳做成按钮才看得出来能点。
  const time = document.createElement("button");
  time.className = "entry-time time-btn";
  time.textContent = note.timestamp;
  time.title = "跳到这个时间点";
  time.addEventListener("click", play);

  const remove = actionButton({
    iconName: "trash",
    title: "删除这条笔记",
    onClick: async () => {
      await sendToBackground(
        { action: "deleteNote", noteId: note.id },
        { idempotent: true },
      );
      // 数据为准：重读笔记，让概览里对应金句的「已保存」立刻解锁，
      // 否则删了笔记、切回概览还是一张「已保存」的假象。
      await syncQuoteButtonsWithNotes();
      loadNotes();
    },
  });
  remove.classList.add("note-delete");

  head.append(time, remove);

  const searching = Boolean(String(state.notesQuery || "").trim());
  const text = document.createElement("p");
  text.className = "entry-text";
  if (searching) appendHighlighted(text, note.text, state.notesQuery);
  else text.textContent = note.text;

  const away =
    note.bvid !== state.bvid || Number(note.page || 1) !== Number(state.page || 1);

  // 标题只在「不是当前这条视频」时才有用；UP 主始终标出来，
  // 否则按 UP 主搜到了却对不上人。
  const source = document.createElement("div");
  source.className = "note-source";
  if (away && note.videoTitle) {
    const title = document.createElement("span");
    title.className = "note-source-title";
    if (searching) appendHighlighted(title, note.videoTitle, state.notesQuery);
    else title.textContent = note.videoTitle;
    source.appendChild(title);
  }
  if (note.ownerName) {
    const owner = document.createElement("span");
    owner.className = "note-source-owner";
    if (searching) appendHighlighted(owner, note.ownerName, state.notesQuery);
    else owner.textContent = note.ownerName;
    owner.title = "UP 主";
    source.appendChild(owner);
  }
  source.hidden = source.children.length === 0;

  const actions = document.createElement("div");
  actions.className = "entry-actions";

  const aiDraft = document.createElement("div");
  aiDraft.className = "note-ai-draft";
  const aiDraftHead = document.createElement("div");
  aiDraftHead.className = "note-ai-draft-head";
  aiDraftHead.textContent = "AI 优化建议";
  const aiDraftWarning = document.createElement("p");
  aiDraftWarning.className = "note-ai-draft-warning";
  const aiDraftText = document.createElement("p");
  aiDraftText.className = "note-ai-draft-text";
  const aiDraftActions = document.createElement("div");
  aiDraftActions.className = "note-ai-draft-actions";
  const keepCurrent = document.createElement("button");
  keepCurrent.className = "ghost-btn";
  keepCurrent.textContent = "保留当前";
  const appendDraft = document.createElement("button");
  appendDraft.className = "ghost-btn";
  appendDraft.textContent = "追加内容";
  const replaceDraft = document.createElement("button");
  replaceDraft.className = "primary-btn";
  replaceDraft.textContent = "替换当前";
  aiDraftActions.append(keepCurrent, appendDraft, replaceDraft);
  aiDraft.append(aiDraftHead, aiDraftWarning, aiDraftText, aiDraftActions);

  const renderAiDraft = () => {
    const draft = note.aiDraft;
    aiDraft.hidden = !draft?.text;
    aiDraftText.textContent = draft?.text || "";
    aiDraftWarning.hidden = !draft?.conflict;
    aiDraftWarning.textContent = draft?.conflict
      ? "AI 生成期间笔记已被修改；这份建议基于修改前的版本，请确认后再采用。"
      : "";
  };

  const resolveDraft = async (mode, button) => {
    for (const item of [keepCurrent, appendDraft, replaceDraft]) item.disabled = true;
    const original = button.textContent;
    button.textContent = "处理中…";
    try {
      const result = await sendToBackground({
        action: "resolveNoteDraft",
        noteId: note.id,
        mode,
        expectedRevision: note.revision,
      });
      if (!result?.success) {
        if (result?.note) {
          replaceNoteState(note, result.note);
          text.textContent = note.text;
        }
        renderAiDraft();
        setNoteNotice(notice, result?.message || "处理失败，请重试。");
        return;
      }
      replaceNoteState(note, result.note);
      text.textContent = note.text;
      renderAiDraft();
      setNoteNotice(notice, "");
    } catch (error) {
      setNoteNotice(notice, "处理失败，请重试。");
    } finally {
      for (const item of [keepCurrent, appendDraft, replaceDraft]) item.disabled = false;
      button.textContent = original;
    }
  };
  keepCurrent.addEventListener("click", () => resolveDraft("discard", keepCurrent));
  appendDraft.addEventListener("click", () => resolveDraft("append", appendDraft));
  replaceDraft.addEventListener("click", () => resolveDraft("replace", replaceDraft));

  const editor = document.createElement("div");
  editor.className = "note-editor";
  editor.hidden = true;

  const editorInput = document.createElement("textarea");
  editorInput.className = "note-editor-input";
  editorInput.maxLength = 3000;
  editorInput.rows = 4;
  editorInput.setAttribute("aria-label", "笔记正文");

  const editorActions = document.createElement("div");
  editorActions.className = "note-editor-actions";
  const cancelEdit = document.createElement("button");
  cancelEdit.className = "ghost-btn";
  cancelEdit.textContent = "取消";
  const saveEdit = document.createElement("button");
  saveEdit.className = "primary-btn";
  saveEdit.textContent = "保存";
  editorActions.append(cancelEdit, saveEdit);
  editor.append(editorInput, editorActions);

  const closeEditor = () => {
    editor.hidden = true;
    text.hidden = false;
    actions.hidden = false;
  };
  cancelEdit.addEventListener("click", closeEditor);
  saveEdit.addEventListener("click", async () => {
    const nextText = editorInput.value.trim();
    if (!nextText) {
      setNoteNotice(notice, "笔记正文不能为空。");
      editorInput.focus();
      return;
    }

    saveEdit.disabled = true;
    saveEdit.textContent = "保存中…";
    try {
      const result = await sendToBackground({
        action: "updateNote",
        noteId: note.id,
        text: nextText,
      });
      if (!result?.success) {
        setNoteNotice(notice, result?.message || "保存失败，请重试。");
        return;
      }
      replaceNoteState(note, result.note);
      text.textContent = note.text;
      renderAiDraft();
      setNoteNotice(notice, "");
      closeEditor();
    } catch (error) {
      setNoteNotice(notice, "保存失败，请重试。");
    } finally {
      saveEdit.disabled = false;
      saveEdit.textContent = "保存";
    }
  });

  // 别的视频的笔记要开新标签页，图标换成「外链」，免得点下去才发现跳走了。
  let optimizeTaskId = null;
  const optimizeButton = actionButton({
    iconName: "ai",
    label: "AI 优化",
    title: "让 AI 基于当前正文生成优化建议",
    onClick: async (button) => {
      const label = button.querySelector("span");
      if (optimizeTaskId) {
        if (label) label.textContent = "正在停止…";
        await sendToBackground(
          { action: "cancelAiTask", taskId: optimizeTaskId },
          { idempotent: true },
        );
        return;
      }

      const taskId = makeTaskId("note-refine");
      // 先占位再 await，双击也只会启动一次。
      optimizeTaskId = taskId;
      if (label) label.textContent = "停止";
      setNoteNotice(notice, "AI 正在优化当前笔记…", "muted");
      try {
        const started = await sendToBackground({
          action: "startAiTask",
          taskId,
          kind: "note-refine",
          noteId: note.id,
        });
        if (!started?.success) {
          setNoteNotice(notice, started?.message || "这条笔记已经在优化中。");
          return;
        }
        const result = await sendToBackground({
          action: "generateNoteDraft",
          taskId,
          noteId: note.id,
        });
        if (!result?.success) {
          setNoteNotice(
            notice,
            result?.error === "TASK_CANCELED"
              ? "AI 优化已取消，当前正文保持不变。"
              : result?.message || "AI 优化失败，请重试。",
            result?.error === "TASK_CANCELED" ? "muted" : "warn",
          );
          return;
        }
        replaceNoteState(note, result.note);
        text.textContent = note.text;
        renderAiDraft();
        setNoteNotice(notice, "");
      } catch (error) {
        setNoteNotice(notice, "AI 优化失败，请重试。");
      } finally {
        if (optimizeTaskId === taskId) optimizeTaskId = null;
        if (label) label.textContent = "AI 优化";
      }
    },
  });

  actions.append(
    actionButton({
      iconName: away ? "external" : "play",
      label: away ? "打开" : "播放",
      title: away ? "在新标签页打开原视频并跳到这一刻" : "跳到这个时间点",
      onClick: play,
    }),
    actionButton({
      iconName: "note",
      label: "编辑",
      title: "编辑笔记正文",
      onClick: () => {
        editorInput.value = note.text;
        text.hidden = true;
        actions.hidden = true;
        editor.hidden = false;
        setNoteNotice(notice, "");
        editorInput.focus();
      },
    }),
    optimizeButton,
    actionButton({
      iconName: "copy",
      label: "复制",
      title: "复制笔记正文",
      onClick: async (button) => {
        await navigator.clipboard.writeText(note.text);
        flashActionButton(button, "已复制");
      },
    }),
    actionButton({
      iconName: "link",
      label: "链接",
      title: "复制带时间戳的视频链接",
      onClick: async (button) => {
        await navigator.clipboard.writeText(note.timestampedUrl);
        flashActionButton(button, "已复制");
      },
    }),
  );

  renderAiDraft();
  card.append(head, text, source, actions, editor, aiDraft, notice);
  return card;
}

function setNoteNotice(notice, message, tone = "warn") {
  notice.className = `note-notice ${tone}`;
  notice.textContent = message;
  notice.hidden = !message;
}

// 同一个视频就地跳转；别的视频开新标签页，开之前先问一句视频还在不在。
async function playNote(note, notice) {
  if (
    note.bvid === state.bvid &&
    Number(note.page || 1) === Number(state.page || 1)
  ) {
    seekTo(note.timestampSeconds);
    return;
  }

  setNoteNotice(notice, "正在确认视频是否还在…", "muted");
  const result = await sendToBackground(
    { action: "checkVideoAvailable", bvid: note.bvid },
    { idempotent: true },
  );

  if (result?.available === false) {
    setNoteNotice(notice, result.message || "视频已下架，无法查看原视频。");
    return;
  }
  setNoteNotice(notice, "");
  chrome.tabs.create({ url: note.timestampedUrl });
}

function setNotesScope(scope) {
  state.notesScope = scope;
  el("notesScopeVideo").classList.toggle("active", scope === "video");
  el("notesScopeAll").classList.toggle("active", scope === "all");
  loadNotes();
}

// ============================================================
// 划词解释
// ============================================================

const EXPLAIN_GAP = 10; // 浮层与选区之间留的缝
const EXPLAIN_MARGIN = 8; // 浮层与内容区边缘留的缝

let pendingSelection = "";
let pendingRange = null;
// 解释浮层锚在被选中的那段文字上。存 Range 而不是坐标：滚动、改窗宽之后
// 重新取一次 getBoundingClientRect 就能算出新位置。
let explainAnchor = null;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function hideExplain() {
  el("explainTooltip").hidden = true;
  el("explainPopover").hidden = true;
  explainAnchor = null;
}

// 选中字幕里的一段文字后，在选区上方浮出「解释」按钮。
function onSelectionChange() {
  const selection = window.getSelection();
  if (
    state.tab !== "transcript"
    || !selection
    || selection.isCollapsed
    || !selection.rangeCount
    || !el("transcriptList").contains(selection.anchorNode)
  ) {
    el("explainTooltip").hidden = true;
    return;
  }

  const text = selection.toString().trim();
  const container = selection.anchorNode?.parentElement;
  if (!text || text.length > 200 || !container?.closest(".content")) {
    el("explainTooltip").hidden = true;
    return;
  }

  const range = selection.getRangeAt(0);
  pendingSelection = text;
  pendingRange = range.cloneRange();

  const rect = range.getBoundingClientRect();
  const bounds = document.querySelector(".content").getBoundingClientRect();
  const tooltip = el("explainTooltip");
  tooltip.hidden = false;
  tooltip.style.left = `${clamp(
    rect.left + rect.width / 2 - tooltip.offsetWidth / 2,
    EXPLAIN_MARGIN,
    window.innerWidth - tooltip.offsetWidth - EXPLAIN_MARGIN,
  )}px`;
  tooltip.style.top = `${clamp(
    rect.top - tooltip.offsetHeight - 6,
    bounds.top + EXPLAIN_MARGIN,
    bounds.bottom - tooltip.offsetHeight - EXPLAIN_MARGIN,
  )}px`;
}

// 浮层贴在选中文字上方；上面塞不下就翻到下方，并始终留在内容区内不压住顶栏。
function positionExplainPopover() {
  const popover = el("explainPopover");
  if (popover.hidden || !explainAnchor) return;

  const rect = explainAnchor.getBoundingClientRect();
  const bounds = document.querySelector(".content").getBoundingClientRect();
  // 被解释的那句已经滚出视野，浮层再赖着就成了没有出处的一块牌子。
  if (rect.bottom < bounds.top || rect.top > bounds.bottom) {
    hideExplain();
    return;
  }

  const { offsetWidth: width, offsetHeight: height } = popover;
  const minTop = bounds.top + EXPLAIN_MARGIN;
  const maxTop = bounds.bottom - height - EXPLAIN_MARGIN;
  const above = rect.top - height - EXPLAIN_GAP;
  const below = rect.bottom + EXPLAIN_GAP;
  const placement = above >= minTop || below > maxTop ? "top" : "bottom";
  const left = clamp(
    rect.left + rect.width / 2 - width / 2,
    EXPLAIN_MARGIN,
    window.innerWidth - width - EXPLAIN_MARGIN,
  );

  popover.dataset.placement = placement;
  popover.style.left = `${left}px`;
  popover.style.top = `${clamp(placement === "top" ? above : below, minTop, maxTop)}px`;
  // 浮层被边缘挡住而偏移时，小三角仍要对准选区中心。
  popover.style.setProperty(
    "--arrow-x",
    `${clamp(rect.left + rect.width / 2 - left, 16, width - 16)}px`,
  );
}

// 给模型的上下文：选中处所在段落及前后各一段。用户选中的是屏幕上显示的文字，
// 开着顺句或翻译时那不是原文，所以原文、顺句稿、译文都要找。
function selectionContext(selected) {
  const segments = state.data?.segments || [];
  const index = segments.findIndex(
    (segment) =>
      segment.text.includes(selected) ||
      (state.polished[segment.id] || "").includes(selected) ||
      (state.translated[segment.id] || "").includes(selected),
  );
  if (index === -1) return state.data?.transcriptText?.slice(0, 2000) || "";
  return segments
    .slice(Math.max(0, index - 1), index + 2)
    .map((segment) => segmentDisplayText(segment))
    .join(" ");
}

async function explainSelection() {
  const selected = pendingSelection;
  if (!selected) return;

  el("explainTooltip").hidden = true;
  el("explainTerm").textContent = selected;
  el("explainBody").textContent = "正在解释…";
  el("explainPopover").hidden = false;
  explainAnchor = pendingRange;
  positionExplainPopover();

  const result = await sendToBackground({
    action: "explainSelection",
    selectedText: selected,
    transcriptContext: selectionContext(selected),
    videoTitle: state.data?.videoInfo?.title || "",
  });

  el("explainBody").textContent = result?.success
    ? result.explanation
    : result?.message || "解释失败，请重试。";
  // 解释文字填进去，浮层高度变了，得重新贴一次。
  positionExplainPopover();
}

// ============================================================
// 复制 / 导出
// ============================================================

// 导出跟着界面走：看到的是哪一份，导出的就是哪一份。
function transcriptAsText() {
  const bilingual = state.transcriptMode === "bilingual";
  return (state.data?.segments || [])
    .map((segment) => {
      const stamp = `[${BILI_TRANSCRIPT.formatTimestamp(segment.start)}]`;
      if (!bilingual) return `${stamp} ${segmentDisplayText(segment)}`;
      const source = sourceText(segment);
      const translated = state.translated[segment.id];
      return translated
        ? `${stamp} ${source}\n${" ".repeat(stamp.length)} ${translated}`
        : `${stamp} ${source}`;
    })
    .join("\n");
}

function flashButton(button, text) {
  const original = button.textContent;
  button.textContent = text;
  // 与 flashActionButton 同款弹跳确认。
  button.animate?.(
    [
      { transform: "scale(1)" },
      { transform: "scale(0.9)" },
      { transform: "scale(1)" },
    ],
    { duration: 180, easing: "ease-out" },
  );
  setTimeout(() => {
    button.textContent = original;
  }, 1500);
}

async function copyTranscript() {
  if (!state.data) return;
  try {
    await navigator.clipboard.writeText(transcriptAsText());
    flashButton(el("copyBtn"), "已复制");
  } catch (error) {
    flashButton(el("copyBtn"), "复制失败");
  }
}

function exportTranscript() {
  if (!state.data) return;
  const title = state.data.videoInfo?.title || state.bvid;
  const header = `${title}\n${state.data.videoInfo?.owner || ""}\nhttps://www.bilibili.com/video/${state.bvid}\n\n`;
  downloadText(header + transcriptAsText(), `${sanitizeFilename(title)}.txt`, "text/plain;charset=utf-8");
}

function exportNotes() {
  const menu = el("notesExportMenu");
  if (menu) menu.open = false;
  const notes = visibleNotes();
  const grouped = state.notesScope === "all";
  const markdown = BILI_LEARNING_STORE.notesAsMarkdown(notes, { grouped });
  if (!markdown) {
    flashButton(el("exportNotesBtn"), "没有笔记");
    return;
  }
  const filename = grouped
    ? "bilibili-digest-笔记.md"
    : `${sanitizeFilename(notes[0]?.videoTitle || state.data?.videoInfo?.title || state.bvid || "笔记")}-笔记.md`;
  downloadText(markdown, filename, "text/markdown;charset=utf-8");
}

function currentTranscriptExport() {
  if (!state.data?.segments?.length) return null;
  return {
    mode: state.transcriptMode,
    segments: state.data.segments.map((segment) => ({
      start: segment.start,
      source: sourceText(segment),
      translation: state.translated[segment.id] || "",
      display: segmentDisplayText(segment),
    })),
  };
}

async function notesForLearningExport() {
  if (!state.bvid) return [];
  if (state.tab === "notes" && state.notesScope === "video") {
    return state.notes || [];
  }
  const result = await sendToBackground(
    { action: "getNotes", bvid: state.bvid, page: state.page },
    { idempotent: true },
  );
  return result?.notes || [];
}

function closeExportMenus() {
  for (const id of ["notesExportMenu", "overviewExportMenu"]) {
    const menu = el(id);
    if (menu) menu.open = false;
  }
}

async function exportLearning({ includeTranscript = false, trigger } = {}) {
  closeExportMenus();
  const button = trigger || el("exportLearningBtn");
  const notes = await notesForLearningExport();
  const markdown = BILI_LEARNING_STORE.learningAsMarkdown({
    title: state.data?.videoInfo?.title || state.bvid || "",
    author: state.data?.videoInfo?.owner || "",
    bvid: state.bvid || "",
    page: state.page,
    exportedAt: Date.now(),
    analysis: state.analysis,
    notes,
    transcript: includeTranscript ? currentTranscriptExport() : null,
  });
  if (!markdown) {
    flashButton(button, "没有可导出的内容");
    return;
  }
  const title = state.data?.videoInfo?.title || state.bvid || "学习稿";
  downloadText(
    markdown,
    `${sanitizeFilename(title)}-学习稿.md`,
    "text/markdown;charset=utf-8",
  );
}

function downloadText(text, filename, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function sanitizeFilename(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, "_").slice(0, 80) || "transcript";
}

// ============================================================
// 启动
// ============================================================

function setupEventListeners() {
  el("refreshBtn").addEventListener("click", () => {
    if (state.bvid) loadTranscript({ force: true });
  });
  el("optionsBtn").addEventListener("click", () => chrome.runtime.openOptionsPage());
  el("errorRetryBtn").addEventListener("click", () => loadTranscript({ force: true }));
  el("polishBtn").addEventListener("click", () => {
    el("transcriptProcessMenu").open = false;
    togglePolish();
  });
  for (const button of el("transcriptMode").querySelectorAll(".segmented-btn")) {
    button.addEventListener("click", () => {
      el("transcriptProcessMenu").open = false;
      setTranscriptMode(button.dataset.mode);
    });
  }
  el("copyBtn").addEventListener("click", copyTranscript);
  el("exportBtn").addEventListener("click", exportTranscript);
  el("exportNotesBtn").addEventListener("click", exportNotes);
  for (const button of document.querySelectorAll("[data-learning-export]")) {
    button.addEventListener("click", () => {
      exportLearning({
        includeTranscript: button.dataset.learningExport === "transcript",
        trigger: button,
      });
    });
  }
  el("searchBtn").addEventListener("click", () => {
    if (el("searchRow").hidden) openSearch();
    else closeSearch();
  });
  el("searchClose").addEventListener("click", closeSearch);
  el("searchInput").addEventListener("input", (event) => {
    applySearchFilter(event.target.value);
  });
  el("searchInput").addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeSearch();
  });
  el("followPill").addEventListener("click", jumpToActive);
  // 「/」唤起搜索——正在别的输入框里打字时不抢。
  document.addEventListener("keydown", (event) => {
    const tag = event.target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if (event.key === "/" && state.tab === "transcript" && state.view === "ready") {
      event.preventDefault();
      openSearch();
    }
  });
  el("analyzeBtn").addEventListener("click", () => analyze());
  el("reanalyzeBtn").addEventListener("click", () => analyze({ force: true }));
  el("retryFailedChunksBtn").addEventListener("click", () => analyze({ retryFailed: true }));
  el("cancelAnalysisBtn").addEventListener("click", cancelAnalysis);
  el("rewriteStopBtn").addEventListener("click", cancelRewrite);
  el("notesScopeVideo").addEventListener("click", () => setNotesScope("video"));
  el("notesScopeAll").addEventListener("click", () => setNotesScope("all"));
  el("notesSearchInput").addEventListener("input", (event) => {
    applyNotesSearch(event.target.value);
  });
  el("explainBtn").addEventListener("click", explainSelection);
  el("explainClose").addEventListener("click", hideExplain);

  // 按下鼠标就会清空选区，进而触发 selectionchange 把这个按钮藏掉，
  // click 根本没机会发生。阻止默认行为，选区才能活到点击那一刻。
  el("explainTooltip").addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });

  for (const button of document.querySelectorAll(".tab")) {
    button.addEventListener("click", () => switchTab(button.dataset.tab));
  }

  el("qaAskBtn").addEventListener("click", submitQuestion);
  el("qaInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") submitQuestion();
  });

  document.addEventListener("selectionchange", onSelectionChange);

  window.addEventListener("resize", positionExplainPopover);

  document.querySelector(".content").addEventListener(
    "scroll",
    () => {
      positionExplainPopover();
      // 刚刚是我们自己滚的就不算用户操作。
      if (Date.now() - state.lastAutoScrollAt > 1000) {
        state.lastUserScrollAt = Date.now();
        updateFollowPill();
      }
    },
    { passive: true },
  );

  chrome.tabs.onActivated.addListener(({ windowId }) => {
    if (windowId === state.windowId) syncWithActiveTab();
  });

  // B 站换视频走 pushState，浏览器会以 changeInfo.url 的形式上报。
  // 不比对 tabId：syncWithActiveTab 自己会解析当前活动标签页，没变就直接返回。
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.url) syncWithActiveTab();
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.action === "startDigestFromButton") syncWithActiveTab();
    if (message?.action === "noteSaved") {
      // 笔记页刷新列表；概览里金句按钮也同步成「已保存」——
      // 保存可能来自概览自身，也可能来自播放页的 n 键，都以数据为准。
      if (state.tab === "notes") loadNotes();
      syncQuoteButtonsWithNotes();
    }
    if (message?.action === "notesImported" && state.tab === "notes") loadNotes();
    // 笔记先存原始字幕、润色好了再替换正文，所以还有第二次刷新。
    if (message?.action === "noteUpdated" && state.tab === "notes") loadNotes();
    // 概览的分块在 background 里跑，进度只能靠它广播回来。
    if (message?.action === "aiProgress") {
      const current = state.aiTasks[message.kind];
      if (!message.taskId || current?.id === message.taskId) {
        showProgress(message.kind, message.done, message.total, message.message);
      }
    }
    if (message?.action === "aiTaskChanged" && message.task?.state === "running") {
      const task = message.task;
      const current = state.aiTasks[task.kind === "analysis" ? "analysis" : "rewrite"];
      if (current?.id === task.id && task.message) {
        showProgress(task.kind === "analysis" ? "analysis" : "rewrite", task.done, task.total, task.message);
      }
    }
    return false;
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  state.windowId = (await chrome.windows.getCurrent()).id;
  // 「没有视频」的文案单一来源：idle 态与笔记页的空态都从这里取。
  el("idleTitle").textContent = NO_VIDEO_TITLE;
  el("idleText").textContent = NO_VIDEO_TEXT;
  setupEventListeners();
  setInterval(trackPlayback, POLL_INTERVAL_MS);
  await watchUiFontScale();
  await syncWithActiveTab();
});
