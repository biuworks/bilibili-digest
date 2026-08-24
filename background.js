/**
 * Bilibili Digest — service worker（MV3）：
 * 消息中转、字幕获取（WBI 签名）、LLM 调用、侧边栏按 tab 启用。
 */

importScripts(
  "settings.js",
  "lib/wbi.js",
  "lib/bili-api.js",
  "lib/transcript.js",
  "lib/ai.js",
  "lib/ai-provider.js",
  "lib/concurrency.js",
  "lib/task-manager.js",
  // 依赖顺序是硬约束：模块顶层的 typeof 守卫在 importScripts 里立即求值，
  // 被依赖的文件必须先加载，否则 service worker 直接注册失败。
  // 各文件的依赖以其 require 声明为准，manifest.test.js 会校验顺序。
  "lib/idb.js",
  "lib/learning-store.js",
  "lib/cache.js",
  "lib/note-db.js",
  "lib/ai-transport.js",
  "lib/notes-service.js",
);

const DEBUG = false;
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

// AI 请求的传输与策略层在 lib/ai-transport.js；这里注入环境依赖后
// 解构成同名函数，业务代码的调用方式保持不变。
const {
  requestAiCompletion,
  aiErrorResponse,
  throwIfTaskCanceled,
  taskCanceledError,
} = BILI_AI_TRANSPORT.createAiTransport({
  getSettings,
  ensureHostPermission,
  log: debugLog,
  fetch: globalThis.fetch,
});

const AI_TASK_KINDS = new Set(["analysis", "polish", "translate", "note-refine"]);
const aiTasks = BILI_TASKS.createTaskManager({
  onChange(task) {
    chrome.runtime.sendMessage({ action: "aiTaskChanged", task }).catch(() => {});
  },
});

function aiTaskKey(message) {
  if (message.kind === "note-refine") return `note-refine:${message.noteId || ""}`;
  const page = Number(message.page) > 0 ? Math.floor(Number(message.page)) : 1;
  return `${message.kind}:${message.bvid || ""}:p${page}`;
}

// 笔记业务（保存去重、后台润色、AI 候选、备份）在 lib/notes-service.js。
const notesService = BILI_NOTES_SERVICE.createNotesService({
  repositories: { notes: notesRepository, learning: learningRepository },
  dataReady: learningDataReady,
  ensureTranscript,
  loadPromptSection,
  requestAiCompletion,
  settingsValid: async () => BILI_SETTINGS.validate(await getSettings()).ok,
  broadcast: (message) => {
    chrome.runtime.sendMessage(message).catch(() => {});
  },
  onTaskProgress: (taskId, patch) => aiTasks.progress(taskId, patch),
  logWarn: (...args) => console.warn(...args),
});

function startAiTask(message) {
  if (!message.taskId || !AI_TASK_KINDS.has(message.kind)) {
    return {
      success: false,
      error: "INVALID_TASK",
      message: "任务参数不完整。",
    };
  }
  return aiTasks.start({
    id: String(message.taskId),
    kind: message.kind,
    key: aiTaskKey(message),
  });
}

async function runManagedAiOperation(taskId, operation, { autoFinish = false } = {}) {
  const signal = taskId ? aiTasks.signal(taskId) : null;
  if (taskId && !signal) {
    return { success: false, error: "TASK_NOT_FOUND", message: "任务已经结束。" };
  }

  let result;
  try {
    result = await operation(signal);
  } catch (error) {
    result = aiErrorResponse(error);
  } finally {
    if (taskId && autoFinish) {
      const canceled = signal?.aborted;
      aiTasks.finish(taskId, {
        state: canceled ? "canceled" : result?.success ? "completed" : "failed",
        message: canceled ? "已取消" : result?.success ? "已完成" : "生成失败",
      });
    }
  }
  return result;
}

/**
 * MV3 只为「正在处理的事件」保活 service worker，顶层发起的异步调用不算数：
 * 求值一结束浏览器就有权回收 worker，在途的扩展 API 调用会被判死刑，
 * Chromium 回一句 `No SW`。所以这个文件的顶层不做任何异步工作，
 * 需要落地的初始化挂到真实事件上，需要数据的地方惰性触发。
 */

// 内容脚本运行在 B 站页面上下文，不应读到密钥或缓存。
function restrictStorageAccess() {
  chrome.storage.local
    .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
    .catch((error) =>
      console.warn("[Bilibili Digest] 无法限制存储访问级别：", error),
    );
}

const learningStorage = chrome.storage.local;

// 笔记与概览快照的正牌后端是 IndexedDB（见 lib/note-db.js / lib/learning-store.js），
// 连接整个 worker 生命周期复用。indexedDB 在这里显式传入而不是让驱动自己摸全局：
// 模块文件在测试里是跨 realm 加载的，宿主的 globalThis 上没有它。
let notesRepo = null;
function notesRepository() {
  if (!notesRepo) {
    notesRepo = BILI_NOTE_DB.createNotesRepository({
      driver: BILI_NOTE_DB.createIndexedDbDriver({
        indexedDB: globalThis.indexedDB,
      }),
    });
  }
  return notesRepo;
}

let learningRepo = null;
function learningRepository() {
  if (!learningRepo) {
    learningRepo = BILI_LEARNING_STORE.createLearningRepository({
      driver: BILI_IDB.createObjectStoreDriver({
        storeName: "learning",
        indexedDB: globalThis.indexedDB,
      }),
    });
  }
  return learningRepo;
}

// 旧版本把笔记数组写在 storage.local，再往前连概览都挤在字幕缓存里。所有
// 读写都等这条迁移链完成：v2 数据迁移 → 笔记 → 字幕缓存 → 概览快照，
// 前一步是后一步的数据来源（v2 提升的概览要等最后一步统一搬走）。
// 整个 worker 生命周期只跑一次，但失败时要把记忆清掉：否则一次偶发失败会让
// 这条 worker 上的后续操作全部停在降级状态，直到浏览器下次回收它为止。
let learningMigration = null;
function learningDataReady() {
  if (!learningMigration) {
    learningMigration = (async () => {
      await BILI_LEARNING_STORE.ensureMigrated({
        storage: learningStorage,
      });
      await BILI_NOTE_DB.ensureNotesInIdb({
        storage: learningStorage,
        repository: notesRepository(),
      });
      await BILI_CACHE.ensureCacheInIdb({
        storage: learningStorage,
      });
      await BILI_LEARNING_STORE.ensureLearningInIdb({
        storage: learningStorage,
        repository: learningRepository(),
      });
    })().catch((error) => {
      console.error("[Bilibili Digest] 学习资料迁移失败：", error);
      learningMigration = null;
      // 迁移失败也先让旧笔记可读；后续写入会给出明确错误，不能因为升级元数据
      // 没写进去就把用户原有内容整个挡住。
      return { migrated: false, error };
    });
  }
  return learningMigration;
}

async function getSettings() {
  const stored = await chrome.storage.local.get(BILI_SETTINGS.STORAGE_KEY);
  return BILI_SETTINGS.normalize(stored[BILI_SETTINGS.STORAGE_KEY]);
}

// ============================================================
// 侧边栏
// ============================================================

/**
 * 侧边栏对所有页面可用，路径由清单的 side_panel.default_path 给出，这里
 * 不按标签页 setOptions。原因是 per-tab 的 enabled 在两个浏览器上语义不同：
 * Chrome 每个标签页各管各的，Edge 则是窗口级——切到一个 disabled 的标签页会
 * 把整个窗口的侧边栏关掉，切回来也不会自动恢复，正在跑的 AI 任务跟着断
 * （microsoft/MicrosoftEdge-Extensions#142）。改成全局可用之后两边行为一致，
 * 顺带躲开了 setOptions 重载面板打断任务的老毛病；非播放页由侧边栏自己显示引导。
 */

// 让浏览器自己响应工具栏图标的点击。自己调 open() 要求调用发生在用户手势里，
// 而手势的判定 Edge 比 Chrome 严，交给浏览器是两边都稳的唯一做法。
function enableActionClickToOpen() {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) =>
      console.warn("[Bilibili Digest] 无法设置侧边栏点击行为：", error),
    );
}

// 这两项都是持久化设置，装好/升级/浏览器启动时各设一次即可，不必每次
// worker 醒来都重设——那正是会撞上 `No SW` 的顶层异步。
function initializeOnce() {
  restrictStorageAccess();
  enableActionClickToOpen();
}

chrome.runtime.onStartup.addListener(initializeOnce);

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  initializeOnce();
  if (reason === "install") chrome.runtime.openOptionsPage();
  // 升级正是数据迁移该发生的时刻，而且这里是真事件，有 keepalive 兜着。
  // 万一仍被打断，各读写路径上的 learningDataReady() 会再补一次。
  await learningDataReady();
});

/**
 * 播放页上那个注入的 Digest 按钮走这条路。手势能否从内容脚本的消息传递到这里，
 * Chrome 认，Edge 不一定认。被拒绝时如实回话，让页面上的按钮改口引导用户去点
 * 工具栏图标——那条路由浏览器自己处理，一定有效。
 */
async function handleOpenSidePanel(tab) {
  if (!tab) return { success: false };

  try {
    // 传 windowId 而不是 tabId：侧边栏是窗口级的，没有按标签页区分的路径。
    await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch (error) {
    console.warn("[Bilibili Digest] 打开侧边栏被拒绝：", error);
    return { success: false, needsToolbarClick: true };
  }

  // 侧边栏可能本来就开着而且停在别的视频上，广播一次让它跟过来。
  // 刚打开的那种情形不必担心广播丢失，面板自己启动时就会同步当前标签页。
  chrome.runtime
    .sendMessage({ action: "startDigestFromButton" })
    .catch(() => {});
  return { success: true };
}

// ============================================================
// 消息路由
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.action === "startAiTask") {
    sendResponse(startAiTask(message));
    return false;
  }

  if (message?.action === "getAiTasks") {
    sendResponse({ success: true, tasks: aiTasks.list() });
    return false;
  }

  if (message?.action === "cancelAiTask") {
    sendResponse(aiTasks.cancel(message.taskId));
    return false;
  }

  if (message?.action === "finishAiTask") {
    const task = aiTasks.finish(message.taskId, {
      state: message.state,
      message: message.message,
    });
    sendResponse({ success: Boolean(task), task });
    return false;
  }

  if (message?.action === "updateAiTaskProgress") {
    const task = aiTasks.progress(message.taskId, {
      done: message.done,
      total: message.total,
      phase: message.phase,
      message: message.message,
    });
    sendResponse({ success: Boolean(task), task });
    return false;
  }

  if (message?.action === "fetchTranscript") {
    handleFetchTranscript(message.bvid, {
      page: message.page,
      forceRefresh: message.forceRefresh,
    })
      .then(sendResponse)
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true; // 保持消息通道开启以异步回复
  }

  if (message?.action === "checkConfig") {
    getSettings()
      .then((settings) => {
        const check = BILI_SETTINGS.validate(settings);
        sendResponse({ ready: check.ok, errors: check.errors });
      })
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message?.action === "openOptions") {
    chrome.runtime.openOptionsPage();
    sendResponse({ success: true });
    return false;
  }

  if (message?.action === "openSidePanel") {
    handleOpenSidePanel(sender.tab)
      .then(sendResponse)
      .catch(() => sendResponse({ success: false, needsToolbarClick: true }));
    return true;
  }

  if (message?.action === "analyzeTranscript") {
    runManagedAiOperation(
      message.taskId,
      (signal) => handleAnalyzeTranscript(message.bvid, {
        page: message.page,
        forceRefresh: message.forceRefresh,
        signal,
        taskId: message.taskId,
      }),
      { autoFinish: true },
    )
      .then(sendResponse)
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message?.action === "retryFailedAnalysis") {
    runManagedAiOperation(
      message.taskId,
      (signal) => handleRetryFailedAnalysis(message.bvid, {
        page: message.page,
        signal,
        taskId: message.taskId,
      }),
      { autoFinish: true },
    )
      .then(sendResponse)
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message?.action === "polishSegments") {
    runManagedAiOperation(message.taskId, (signal) =>
      handlePolishSegments(message.bvid, {
        page: message.page,
        segmentIds: message.segmentIds,
        signal,
      }),
    )
      .then(sendResponse)
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message?.action === "translateSegments") {
    runManagedAiOperation(message.taskId, (signal) =>
      handleTranslateSegments(message.bvid, {
        page: message.page,
        segmentIds: message.segmentIds,
        signal,
      }),
    )
      .then(sendResponse)
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message?.action === "explainSelection") {
    handleExplainSelection(
      message.selectedText,
      message.transcriptContext,
      message.videoTitle,
    )
      .then(sendResponse)
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message?.action === "saveNote") {
    notesService
      .saveNote(message)
      .then(sendResponse)
      .catch((error) => sendResponse(notesService.noteWriteErrorResponse(error)));
    return true;
  }

  if (message?.action === "getNotes") {
    notesService
      .getNotes(message.bvid, message.page)
      .then(sendResponse)
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message?.action === "deleteNote") {
    notesService
      .deleteNote(message.noteId)
      .then(sendResponse)
      .catch((error) => sendResponse(notesService.noteWriteErrorResponse(error)));
    return true;
  }

  if (message?.action === "updateNote") {
    notesService
      .updateNote(message.noteId, message.text)
      .then(sendResponse)
      .catch((error) => sendResponse(notesService.noteWriteErrorResponse(error)));
    return true;
  }

  if (message?.action === "generateNoteDraft") {
    runManagedAiOperation(
      message.taskId,
      (signal) =>
        notesService.generateNoteDraft(message.noteId, {
          signal,
          taskId: message.taskId,
        }),
      { autoFinish: true },
    )
      .then(sendResponse)
      .catch((error) => sendResponse(aiErrorResponse(error)));
    return true;
  }

  if (message?.action === "resolveNoteDraft") {
    notesService
      .resolveNoteDraft(message.noteId, message.mode, message.expectedRevision)
      .then(sendResponse)
      .catch((error) => sendResponse(notesService.noteWriteErrorResponse(error)));
    return true;
  }

  if (message?.action === "checkVideoAvailable") {
    handleCheckVideoAvailable(message.bvid)
      .then(sendResponse)
      // 检查本身出错不该挡住用户，放行让 B 站自己说话。
      .catch(() => sendResponse({ available: true }));
    return true;
  }

  if (message?.action === "exportLearningBackup") {
    notesService
      .exportLearningBackup()
      .then(sendResponse)
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message?.action === "importLearningBackup") {
    notesService
      .importLearningBackup(message.backup)
      .then(sendResponse)
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  return false;
});

// ============================================================
// 字幕管线
// ============================================================

// 优先命中缓存，未命中走 view → player/wbi/v2 → 字幕 JSON。
async function handleFetchTranscript(bvidInput, { page = 1, forceRefresh = false } = {}) {
  const bvid = BILI_API.parseBvid(bvidInput);
  if (!bvid) {
    return {
      success: false,
      error: "INVALID_BVID",
      message: "没有识别到 BV 号，请在 B 站播放页使用。",
    };
  }

  const pageNumber = Number(page) > 0 ? Math.floor(Number(page)) : 1;

  if (!forceRefresh) {
    const cached = await BILI_CACHE.load(bvid, { page: pageNumber });
    if (cached?.transcript?.length) {
      debugLog("[Bilibili Digest] 命中字幕缓存：", bvid);
      const restored = await restoreLearningAnalysis(cached, bvid, pageNumber);
      // 标志放在展开之后：旧版本写进缓存的脏标志不能盖过本次的真实值。
      return { ...restored, success: true, fromCache: true };
    }
  }

  try {
    const settings = await getSettings();
    const videoInfo = await BILI_API.fetchVideoInfo(bvid, { page: pageNumber });
    const { tracks, needLogin } = await BILI_API.fetchSubtitleTracks(videoInfo);

    if (!tracks.length) {
      return {
        success: false,
        error: needLogin ? "NEED_LOGIN" : "NO_SUBTITLE",
        message: needLogin
          ? "该视频的字幕需要登录后才能查看，请先在浏览器里登录 B 站账号。"
          : "该视频没有可用字幕。",
        videoInfo,
      };
    }

    const track = BILI_API.pickSubtitleTrack(
      tracks,
      settings.subtitleLangPreference,
    );
    const entries = await BILI_API.fetchSubtitleTrackContent(track.url);
    if (!entries.length) {
      return {
        success: false,
        error: "EMPTY_TRANSCRIPT",
        message: "字幕文件是空的。",
        videoInfo,
      };
    }

    const segments = BILI_TRANSCRIPT.groupTranscriptEntries(entries);
    const texts = BILI_TRANSCRIPT.buildTranscriptTexts(entries);

    const result = {
      videoInfo,
      transcript: entries,
      segments,
      transcriptText: texts.plain,
      transcriptTextTimestamped: texts.timestamped,
      language: track.lang,
      languageLabel: track.langLabel,
      isAiSubtitle: track.isAi,
      availableTracks: tracks.map(({ lang, langLabel, isAi }) => ({
        lang,
        langLabel,
        isAi,
      })),
    };

    const restored = await restoreLearningAnalysis(result, bvid, pageNumber);
    await BILI_CACHE.save(bvid, restored, { page: pageNumber });
    return { ...restored, success: true, fromCache: false };
  } catch (error) {
    console.error("[Bilibili Digest] 字幕获取失败：", error);
    return {
      success: false,
      error: error.code || "TRANSCRIPT_FETCH_FAILED",
      message: error.message || "字幕获取失败。",
    };
  }
}

// 字幕缓存只有 30 天；用户生成过的概览属于学习资料，过期后仍应能与笔记重聚。
async function restoreLearningAnalysis(payload, bvid, page) {
  const failuresOf = (record) =>
    Array.isArray(record?.analysisFailures) ? record.analysisFailures : [];

  if (payload?.analysis) {
    if (Array.isArray(payload.analysisFailures)) return payload;
    await learningDataReady();
    const record = await BILI_LEARNING_STORE.loadLearningRecord(bvid, page, {
      repository: learningRepository(),
    });
    return { ...payload, analysisFailures: failuresOf(record) };
  }
  await learningDataReady();
  const record = await BILI_LEARNING_STORE.loadLearningRecord(bvid, page, {
    repository: learningRepository(),
  });
  if (!record?.analysis) return payload;
  return {
    ...payload,
    analysis: record.analysis,
    analysisFailures: failuresOf(record),
    analysisSource: "learning",
  };
}

// ============================================================
// 模型调用
// ============================================================

const promptFileCache = new Map();

async function loadPromptSection(fileName, heading, variables = {}) {
  let markdown = promptFileCache.get(fileName);
  if (!markdown) {
    const response = await fetch(chrome.runtime.getURL(`prompts/${fileName}`));
    if (!response.ok) {
      throw new Error(`提示词文件读取失败：${fileName}`);
    }
    markdown = await response.text();
    promptFileCache.set(fileName, markdown);
  }
  return BILI_AI.extractPromptSection(markdown, heading, variables);
}

/**
 * 用户可以填任意 API 地址，而 MV3 不允许 fetch 未授权的域名。
 * 域名在安装时是未知的，所以走 optional_host_permissions 在设置页运行时申请。
 */
async function ensureHostPermission(baseUrl) {
  const origin = BILI_SETTINGS.originOf(baseUrl);
  if (!origin) {
    const error = new Error("API 地址不合法，请到设置页检查。");
    error.code = "INVALID_BASE_URL";
    throw error;
  }

  const granted = await chrome.permissions.contains({ origins: [origin] });
  if (!granted) {
    const error = new Error(
      `扩展还没有访问 ${origin} 的权限。请打开设置页，点「保存并授权」。`,
    );
    error.code = "NEED_HOST_PERMISSION";
    throw error;
  }
}

// ============================================================
// AI 概览
// ============================================================

/** 概览和笔记都需要字幕，统一从缓存拿，没有再走网络。 */
async function ensureTranscript(bvid, page) {
  const cached = await BILI_CACHE.load(bvid, { page });
  if (cached?.transcript?.length) return { ...cached, success: true };
  return handleFetchTranscript(bvid, { page });
}

// 缓存的「读—改—写」必须串行：并发批次会各自读到旧快照，后写的覆盖先写的，
// 表现为「有些段落莫名其妙没保存下来」，既不报错也难复现。
const cacheWriteQueue = BILI_CONCURRENCY.createSerialQueue();

function updateCache(bvid, page, mutate) {
  return cacheWriteQueue(async () => {
    const current = (await BILI_CACHE.load(bvid, { page })) || {};
    const next = mutate(current);
    // 只是更新已有条目，跳过淘汰——淘汰要读全量存储，一次任务几十批经不起这么读。
    await BILI_CACHE.save(bvid, next, { page, evict: false });
    return next;
  });
}

// success / fromCache 是每次响应现算的，跟着 spread 写进缓存的话，
// 下次命中时旧标志会盖掉新标志，落库前必须剥掉。
function persistable(transcript) {
  const { success, fromCache, ...rest } = transcript;
  return rest;
}

// 侧边栏可能没开着，广播失败是正常的。
function reportProgress(kind, done, total, { taskId, phase, message } = {}) {
  if (taskId) aiTasks.progress(taskId, { done, total, phase, message });
  chrome.runtime
    .sendMessage({ action: "aiProgress", kind, done, total, phase, message, taskId })
    .catch(() => {});
}

async function handleAnalyzeTranscript(
  bvidInput,
  { page = 1, forceRefresh = false, signal, taskId } = {},
) {
  const bvid = BILI_API.parseBvid(bvidInput);
  if (!bvid) {
    return { success: false, error: "INVALID_BVID", message: "没有识别到 BV 号。" };
  }
  const pageNumber = Number(page) > 0 ? Math.floor(Number(page)) : 1;

  const cached = await BILI_CACHE.load(bvid, { page: pageNumber });
  if (!forceRefresh && cached?.analysis) {
    const failures = Array.isArray(cached.analysisFailures) ? cached.analysisFailures : [];
    return {
      success: true,
      fromCache: true,
      analysis: cached.analysis,
      analysisFailures: failures,
      failedChunks: failures.length,
    };
  }
  if (!forceRefresh) {
    await learningDataReady();
    const record = await BILI_LEARNING_STORE.loadLearningRecord(bvid, pageNumber, {
      repository: learningRepository(),
    });
    if (record?.analysis) {
      const failures = Array.isArray(record.analysisFailures) ? record.analysisFailures : [];
      return {
        success: true,
        fromCache: true,
        analysisSource: "learning",
        analysis: record.analysis,
        analysisFailures: failures,
        failedChunks: failures.length,
      };
    }
  }

  const transcript = cached?.transcript?.length
    ? { ...cached, success: true }
    : await ensureTranscript(bvid, pageNumber);
  if (!transcript.success) return transcript;

  try {
    throwIfTaskCanceled(signal);
    const settings = await getSettings();
    const chunkOptions = BILI_SETTINGS.analysisChunkOptions(settings);
    const chunks = BILI_AI.planAnalysisChunks(transcript.segments, chunkOptions);
    if (!chunks.length) {
      return { success: false, error: "NO_TRANSCRIPT", message: "没有可用的字幕。" };
    }

    const common = {
      videoTitle: transcript.videoInfo?.title || "未知",
      ownerName: transcript.videoInfo?.owner || "未知",
      videoDescription: transcript.videoInfo?.description || "（无简介）",
    };
    const totalDuration = Math.max(
      Math.floor(Number(transcript.videoInfo?.duration) || 0),
      chunks[chunks.length - 1].endSeconds,
    );

    debugLog(`[Bilibili Digest] 概览分 ${chunks.length} 块，并发 ${settings.aiConcurrency}`);
    reportProgress("analysis", 0, chunks.length, {
      taskId,
      phase: "generating",
      message: `正在生成第 0/${chunks.length} 块`,
    });

    const results = await analyzePlannedChunks(chunks, chunks.length, common, settings, {
      signal,
      taskId,
    });
    throwIfTaskCanceled(signal);

    const parts = results
      .filter((result) => result.status === "fulfilled" && result.value)
      .map((result) => result.value);
    const remaining = BILI_AI.chunkFailureRanges(chunks, results);

    if (!parts.length) {
      // 全军覆没时把第一个真实错误透出去，它比「生成失败」有用得多。
      const failures = results.filter((result) => result.status === "rejected");
      throw failures[0]?.reason || new Error("概览生成失败。");
    }

    reportProgress("analysis", chunks.length, chunks.length, {
      taskId,
      phase: "merging",
      message: "正在合并概览…",
    });
    const analysis = BILI_AI.mergeAnalyses(parts, totalDuration);
    if (!analysis.chapters.length && !analysis.keyQuotes.length) {
      return {
        success: false,
        error: "EMPTY_ANALYSIS",
        message: "模型没有产出有效的章节或金句，请重试。",
      };
    }

    await persistAnalysisSnapshot(bvid, pageNumber, transcript, analysis, remaining);

    return {
      success: true,
      fromCache: false,
      analysis,
      chunkCount: chunks.length,
      analysisFailures: remaining,
      // 部分块失败仍然出结果，但要如实告诉用户这份概览是不完整的。
      failedChunks: remaining.length,
    };
  } catch (error) {
    console.error("[Bilibili Digest] 概览生成失败：", error);
    return aiErrorResponse(error);
  }
}

async function handleRetryFailedAnalysis(bvidInput, { page = 1, signal, taskId } = {}) {
  const bvid = BILI_API.parseBvid(bvidInput);
  if (!bvid) {
    return { success: false, error: "INVALID_BVID", message: "没有识别到 BV 号。" };
  }
  const pageNumber = Number(page) > 0 ? Math.floor(Number(page)) : 1;
  const cached = await BILI_CACHE.load(bvid, { page: pageNumber });
  const transcript = cached?.transcript?.length
    ? { ...cached, success: true }
    : await ensureTranscript(bvid, pageNumber);
  if (!transcript.success) return transcript;

  await learningDataReady();
  const record = await BILI_LEARNING_STORE.loadLearningRecord(bvid, pageNumber, {
    repository: learningRepository(),
  });
  const existing = transcript.analysis || record?.analysis;
  const storedFailures = Array.isArray(transcript.analysisFailures) && transcript.analysisFailures.length
    ? transcript.analysisFailures
    : record?.analysisFailures;
  if (!existing) {
    return { success: false, error: "NO_ANALYSIS", message: "还没有可补的概览，请先生成。" };
  }
  if (!Array.isArray(storedFailures) || !storedFailures.length) {
    return {
      success: true,
      fromCache: true,
      analysis: existing,
      analysisFailures: [],
      failedChunks: 0,
    };
  }

  try {
    throwIfTaskCanceled(signal);
    const settings = await getSettings();
    const chunkOptions = BILI_SETTINGS.analysisChunkOptions(settings);
    const chunks = BILI_AI.planAnalysisChunks(transcript.segments, chunkOptions);
    const selected = BILI_AI.chunksForFailureRanges(chunks, storedFailures);
    if (!selected.length) {
      return {
        success: false,
        error: "FAILED_CHUNKS_MISMATCH",
        message: "当前分块对不上失败区间，请重新生成整份概览。",
      };
    }

    const common = {
      videoTitle: transcript.videoInfo?.title || "未知",
      ownerName: transcript.videoInfo?.owner || "未知",
      videoDescription: transcript.videoInfo?.description || "（无简介）",
    };
    const totalDuration = Math.max(
      Math.floor(Number(transcript.videoInfo?.duration) || 0),
      chunks[chunks.length - 1].endSeconds,
    );

    debugLog(`[Bilibili Digest] 补 ${selected.length} 个失败分块`);
    reportProgress("analysis", 0, selected.length, {
      taskId,
      phase: "retrying",
      message: `正在补第 0/${selected.length} 个失败块`,
    });

    const results = await analyzePlannedChunks(selected, chunks.length, common, settings, {
      signal,
      taskId,
      progressMessage: (done, total) => `正在补第 ${done}/${total} 个失败块`,
      retryPartialOnly: false,
    });
    throwIfTaskCanceled(signal);

    const parts = results
      .filter((result) => result.status === "fulfilled" && result.value)
      .map((result) => result.value);
    const remaining = BILI_AI.chunkFailureRanges(selected, results);
    const analysis = parts.length
      ? BILI_AI.mergeRetryIntoAnalysis(existing, parts, selected, totalDuration)
      : existing;

    reportProgress("analysis", selected.length, selected.length, {
      taskId,
      phase: "merging",
      message: remaining.length ? "失败块仍未全部补上" : "正在合并概览…",
    });

    await persistAnalysisSnapshot(bvid, pageNumber, transcript, analysis, remaining);

    return {
      success: true,
      fromCache: false,
      analysis,
      chunkCount: selected.length,
      analysisFailures: remaining,
      failedChunks: remaining.length,
    };
  } catch (error) {
    console.error("[Bilibili Digest] 补失败块失败：", error);
    return aiErrorResponse(error);
  }
}

async function persistAnalysisSnapshot(bvid, pageNumber, transcript, analysis, analysisFailures) {
  await updateCache(bvid, pageNumber, (current) => ({
    ...current,
    ...persistable(transcript),
    analysis,
    analysisFailures,
  }));
  await learningDataReady();
  await BILI_LEARNING_STORE.saveLearningRecord(
    {
      bvid,
      page: pageNumber,
      videoTitle: transcript.videoInfo?.title || "",
      ownerName: transcript.videoInfo?.owner || "",
      analysis,
      analysisFailures,
    },
    { repository: learningRepository() },
  );
}

async function analyzePlannedChunks(
  chunks,
  chunkCount,
  common,
  settings,
  { signal, taskId, progressMessage, retryPartialOnly = true } = {},
) {
  const analyzeOne = (chunk) => {
    throwIfTaskCanceled(signal);
    return analyzeChunk(chunk, chunkCount, common, { signal });
  };
  const label = progressMessage || ((done, total) => `正在生成第 ${done}/${total} 块`);
  const results = await BILI_CONCURRENCY.mapWithConcurrency(
    chunks,
    settings.aiConcurrency,
    analyzeOne,
    (done, total) => reportProgress("analysis", done, total, {
      taskId,
      phase: "generating",
      message: label(done, total),
    }),
  );
  throwIfTaskCanceled(signal);

  // 部分块失败多半是偶发超时或限流，静默补一轮；整份全军覆没通常是配置错误，不补。
  // 用户点「补失败块」时，即使这一轮全失败也再给一次机会。
  const failedIndexes = results
    .map((result, index) => (result.status === "rejected" ? index : -1))
    .filter((index) => index >= 0);
  if (
    failedIndexes.length &&
    (!retryPartialOnly || failedIndexes.length < chunks.length)
  ) {
    reportProgress("analysis", chunks.length - failedIndexes.length, chunks.length, {
      taskId,
      phase: "retrying",
      message: `正在重试 ${failedIndexes.length} 个失败分块`,
    });
    debugLog(`[Bilibili Digest] ${failedIndexes.length} 块失败，自动补一轮`);
    const retried = await BILI_CONCURRENCY.mapWithConcurrency(
      failedIndexes.map((index) => chunks[index]),
      settings.aiConcurrency,
      analyzeOne,
    );
    failedIndexes.forEach((chunkIndex, i) => {
      if (retried[i].status === "fulfilled") results[chunkIndex] = retried[i];
    });
  }
  return results;
}

// 时长相关变量按本块区间算，好让模型只覆盖这一段。
async function analyzeChunk(chunk, chunkCount, common, { signal } = {}) {
  const timing = BILI_AI.analysisTimingVariables(chunk.text, chunk.endSeconds);
  const rangeNote =
    chunkCount > 1
      ? `注意：这是长视频切分后的第 ${chunk.index + 1} / ${chunkCount} 段，` +
        `覆盖 ${BILI_TRANSCRIPT.formatTimestamp(chunk.startSeconds)} 到 ` +
        `${BILI_TRANSCRIPT.formatTimestamp(chunk.endSeconds)}。` +
        `只为这一段产出章节与金句，不要涉及其它时间段。`
      : "";

  // 前情只喂给模型当上下文，产出仍限定在本块区间内，靠 minTimestampSeconds 兜底。
  const contextNote = chunk.contextText
    ? `\n前情回顾（上一段的结尾，只用来理解本段承接什么，不要为它开章节或挑金句）：\n${chunk.contextText}\n`
    : "";

  const variables = {
    ...common,
    ...timing,
    rangeNote,
    contextNote,
    startFormatted: BILI_TRANSCRIPT.formatTimestamp(chunk.startSeconds),
    minTimestampSeconds: chunk.startSeconds,
    transcriptText: chunk.text,
  };
  const [systemPrompt, userPrompt] = await Promise.all([
    loadPromptSection("analysis.md", "系统提示词", variables),
    loadPromptSection("analysis.md", "用户提示词", variables),
  ]);

  const { text } = await requestAiCompletion({
    // 概览是摘要，产出远小于原文；分块之后每块更小。
    // 按正文长度估算即可，前情只进输入不进输出。
    maxTokens: BILI_AI.estimateOutputTokens(chunk.text.length, {
      ratio: 0.5,
      floor: 2048,
    }),
    responseFormat: { type: "json_object" },
    signal,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  return BILI_AI.validateAnalysis(
    BILI_AI.parseLooseJson(text),
    timing.maxTimestampSeconds,
    chunk.startSeconds,
  );
}

// ============================================================
// 逐条改写字幕：顺句（补标点 + 改同音错别字）与翻译（外文 → 中文）
// ============================================================

// 侧边栏按批发过来，这里再兜一道上限，避免异常大的请求。
const REWRITE_MAX_SEGMENTS_PER_CALL = 12;

/**
 * 顺句和翻译走同一条流水线：挑分段 → 查缓存 → 送模型 → 按 id 对回原位 → 写缓存。
 * 真正不同的只有下面这几项；prepare 按本次字幕算出提示词变量和对齐守卫。
 */
const REWRITE_TASKS = Object.freeze({
  polish: {
    label: "顺句",
    cacheKey: "polished",
    promptFile: "punctuate.md",
    // 原地补标点，输出量跟着输入走，再加上 JSON 结构和 id 的开销。
    tokenRatio: 1.5,
    async prepare() {
      return {
        variables: {},
        align: (parsed, todo) => {
          const { polished, rejected } = BILI_AI.alignPolishedSegments(parsed, todo);
          return { accepted: polished, rejected };
        },
      };
    },
  },
  translate: {
    label: "翻译",
    cacheKey: "translated",
    promptFile: "translation.md",
    // 中英互译字符数会变，按字符估 token 时统一放宽。
    tokenRatio: 2,
    async prepare(transcript) {
      // 方向由字幕轨语种决定：中文字幕译成英文，外文字幕译成中文。
      const toEnglish = BILI_TRANSCRIPT.isChineseSubtitle(transcript.language);
      const targetLang = toEnglish ? "en" : "zh";
      return {
        variables: {
          targetLangName: toEnglish ? "英文" : "简体中文",
          langRules: await loadPromptSection(
            "translation.md",
            toEnglish ? "英文规则" : "中文规则",
          ),
        },
        align: (parsed, todo) => {
          const { translated, rejected } = BILI_AI.alignTranslatedSegments(
            parsed,
            todo,
            { targetLang },
          );
          return { accepted: translated, rejected };
        },
      };
    },
  },
});

async function handleSegmentRewrite(
  kind,
  bvidInput,
  { page = 1, segmentIds = [], signal } = {},
) {
  const task = REWRITE_TASKS[kind];
  const bvid = BILI_API.parseBvid(bvidInput);
  if (!bvid) {
    return { success: false, error: "INVALID_BVID", message: "没有识别到 BV 号。" };
  }
  const pageNumber = Number(page) > 0 ? Math.floor(Number(page)) : 1;

  const cached = await BILI_CACHE.load(bvid, { page: pageNumber });
  const transcript = cached?.segments?.length
    ? { ...cached, success: true }
    : await ensureTranscript(bvid, pageNumber);
  if (!transcript.success) return transcript;

  const requested = new Set((segmentIds || []).map(String));
  const segments = (transcript.segments || [])
    .filter((segment) => requested.has(segment.id))
    .slice(0, REWRITE_MAX_SEGMENTS_PER_CALL);
  if (!segments.length) {
    return { success: false, error: "NO_SEGMENTS", message: "没有需要处理的分段。" };
  }

  const done = cached?.[task.cacheKey] || {};
  const todo = segments.filter((segment) => !done[segment.id]);
  if (!todo.length) {
    const hit = {};
    for (const segment of segments) hit[segment.id] = done[segment.id];
    return { success: true, fromCache: true, [task.cacheKey]: hit };
  }

  try {
    throwIfTaskCanceled(signal);
    const { variables: extraVariables, align } = await task.prepare(transcript);
    const payload = {
      segments: todo.map((segment) => ({ id: segment.id, text: segment.text })),
    };
    const variables = {
      ...extraVariables,
      videoTitle: transcript.videoInfo?.title || "未知",
      segmentsJson: JSON.stringify(payload),
    };
    const [systemPrompt, userPrompt] = await Promise.all([
      loadPromptSection(task.promptFile, "系统提示词", variables),
      loadPromptSection(task.promptFile, "用户提示词", variables),
    ]);

    const { text } = await requestAiCompletion({
      maxTokens: BILI_AI.estimateOutputTokens(variables.segmentsJson.length, {
        ratio: task.tokenRatio,
        floor: 2048,
      }),
      // 两者都是照着原文做的，不是创作，温度越低越贴近原意。
      temperature: 0.2,
      responseFormat: { type: "json_object" },
      signal,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    const { accepted, rejected } = align(BILI_AI.parseLooseJson(text), todo);
    throwIfTaskCanceled(signal);
    if (rejected.length) {
      debugLog(`[Bilibili Digest] ${task.label}丢弃的条目：`, rejected);
    }

    // 这些批次是并发跑的，读—改—写要走串行队列，否则会互相覆盖。
    const saved = await updateCache(bvid, pageNumber, (current) => ({
      ...current,
      ...persistable(transcript),
      [task.cacheKey]: { ...(current[task.cacheKey] || {}), ...accepted },
    }));

    // 命中缓存的那部分也一并回给侧边栏，它只认返回值。
    const response = { ...accepted };
    for (const segment of segments) {
      if (!response[segment.id] && saved[task.cacheKey][segment.id]) {
        response[segment.id] = saved[task.cacheKey][segment.id];
      }
    }
    return { success: true, fromCache: false, [task.cacheKey]: response, rejected };
  } catch (error) {
    console.error(`[Bilibili Digest] ${task.label}失败：`, error);
    return aiErrorResponse(error);
  }
}

const handlePolishSegments = (bvid, options) =>
  handleSegmentRewrite("polish", bvid, options);
const handleTranslateSegments = (bvid, options) =>
  handleSegmentRewrite("translate", bvid, options);

// ============================================================
// 划词解释
// ============================================================

async function handleExplainSelection(selectedText, transcriptContext, videoTitle) {
  const text = String(selectedText || "").trim();
  if (!text) {
    return { success: false, error: "EMPTY_SELECTION", message: "没有选中任何文字。" };
  }

  try {
    const variables = {
      videoTitle: videoTitle || "未知",
      selectedText: text.slice(0, 1000),
      transcriptContext: String(transcriptContext || "").slice(0, 4000) || "无",
    };
    const [systemPrompt, userPrompt] = await Promise.all([
      loadPromptSection("explain.md", "系统提示词", variables),
      loadPromptSection("explain.md", "用户提示词", variables),
    ]);

    const { text: explanation } = await requestAiCompletion({
      maxTokens: 1024,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });
    return { success: true, explanation: explanation.trim() };
  } catch (error) {
    console.error("[Bilibili Digest] 划词解释失败：", error);
    return aiErrorResponse(error);
  }
}

// 开新标签页前先问一句视频还在不在，免得用户等页面加载完才看到「稿件不可见」。
// 判不准时一律放行：拦下还能看的视频比多开一个标签页糟糕得多。
async function handleCheckVideoAvailable(bvidInput) {
  const bvid = BILI_API.parseBvid(bvidInput);
  if (!bvid) return { available: false, message: "这条笔记没有记下有效的视频号。" };

  try {
    await BILI_API.fetchVideoInfo(bvid);
    return { available: true };
  } catch (error) {
    if (error?.code === "VIDEO_UNAVAILABLE") {
      return { available: false, message: "视频已下架，无法查看原视频。" };
    }
    return { available: true };
  }
}
