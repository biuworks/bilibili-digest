/**
 * Bilibili Digest — service worker（MV3）：
 * 消息中转、字幕获取（WBI 签名）、LLM 调用、侧边栏按 tab 启用。
 */

importScripts(
  "settings.js",
  "lib/wbi.js",
  "lib/bili-api.js",
  "lib/transcript.js",
  "lib/cache.js",
  "lib/ai.js",
  "lib/ai-provider.js",
  "lib/concurrency.js",
  "lib/learning-store.js",
);

const DEBUG = false;
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

// 两道超时各管一段，边界是「响应头是否已到达」：之前是模型在生成，归可配的
// 硬超时管；之后 body 应连续到达，静默 50 秒即视为连接出了问题，不必可配。
const AI_IDLE_TIMEOUT_MS = 50_000;
const AI_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
// 加码重试的天花板。再往上多数模型会因超过自身输出上限直接拒绝请求。
const MAX_OUTPUT_TOKENS = 32_768;
const NOTES_STORAGE_KEY = BILI_LEARNING_STORE.NOTES_KEY;

// 内容脚本运行在 B 站页面上下文，不应读到密钥或缓存。
chrome.storage.local
  .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  .catch((error) =>
    console.warn("[Bilibili Digest] 无法限制存储访问级别：", error),
  );

// 旧版本直接把笔记数组写在 storage.local。所有读写都等这次轻量迁移完成，
// 避免升级后的第一个操作和迁移同时改写数据。
const learningStorage = chrome.storage.local;
const learningDataReady = BILI_LEARNING_STORE.ensureMigrated({
  storage: learningStorage,
}).catch((error) => {
  console.error("[Bilibili Digest] 学习资料迁移失败：", error);
  // 迁移失败也先让旧笔记可读；后续写入会给出明确错误，不能因为升级元数据
  // 没写进去就把用户原有内容整个挡住。
  return { migrated: false, error };
});

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
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) =>
    console.warn("[Bilibili Digest] 无法设置侧边栏点击行为：", error),
  );

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
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
    handleAnalyzeTranscript(message.bvid, {
      page: message.page,
      forceRefresh: message.forceRefresh,
    })
      .then(sendResponse)
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message?.action === "polishSegments") {
    handlePolishSegments(message.bvid, {
      page: message.page,
      segmentIds: message.segmentIds,
    })
      .then(sendResponse)
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message?.action === "translateSegments") {
    handleTranslateSegments(message.bvid, {
      page: message.page,
      segmentIds: message.segmentIds,
    })
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
    handleSaveNote(message)
      .then(sendResponse)
      .catch((error) => sendResponse(noteWriteErrorResponse(error)));
    return true;
  }

  if (message?.action === "getNotes") {
    handleGetNotes(message.bvid, message.page)
      .then(sendResponse)
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message?.action === "deleteNote") {
    handleDeleteNote(message.noteId)
      .then(sendResponse)
      .catch((error) => sendResponse(noteWriteErrorResponse(error)));
    return true;
  }

  if (message?.action === "updateNote") {
    handleUpdateNote(message.noteId, message.text)
      .then(sendResponse)
      .catch((error) => sendResponse(noteWriteErrorResponse(error)));
    return true;
  }

  if (message?.action === "checkVideoAvailable") {
    handleCheckVideoAvailable(message.bvid)
      .then(sendResponse)
      // 检查本身出错不该挡住用户，放行让 B 站自己说话。
      .catch(() => sendResponse({ available: true }));
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
  if (payload?.analysis) return payload;
  await learningDataReady;
  const record = await BILI_LEARNING_STORE.loadLearningRecord(bvid, page, {
    storage: learningStorage,
  });
  if (!record?.analysis) return payload;
  return { ...payload, analysis: record.analysis, analysisSource: "learning" };
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

// 协议差异由 lib/ai-provider.js 处理，这里只管超时、大小上限、空响应的诊断与重试。
async function requestAiCompletion({
  messages,
  maxTokens,
  temperature,
  responseFormat,
}) {
  const settings = await getSettings();
  const check = BILI_SETTINGS.validate(settings);
  if (!check.ok) {
    const error = new Error(`AI 还没配置好：${check.errors.join(" ")}`);
    error.code = "NO_AI_CONFIG";
    throw error;
  }
  await ensureHostPermission(settings.aiBaseUrl);

  let format = responseFormat;
  let tokens = maxTokens;
  let diagnosis = null;

  // 空响应有两种能自愈的成因，各给一次机会，所以最多三轮。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const request = BILI_AI_PROVIDER.buildChatRequest({
      settings,
      messages,
      maxTokens: tokens,
      temperature,
      responseFormat: format,
    });
    const data = await sendAiRequest(settings, request);

    const text = BILI_AI_PROVIDER.parseChatResponse(settings.protocol, data);
    if (text.trim()) return { text, settings };

    diagnosis = BILI_AI_PROVIDER.diagnoseEmptyResponse(settings.protocol, data);

    if (format && diagnosis.retryWithoutJsonMode) {
      debugLog("[Bilibili Digest] JSON 模式返回空，脱掉 response_format 重试");
      format = null;
      continue;
    }

    // 预算被吃光了就加码重试——max_tokens 按实际生成计费，加码不额外花钱。
    if (diagnosis.retryWithMoreTokens && tokens < MAX_OUTPUT_TOKENS) {
      tokens = Math.min(tokens * 4, MAX_OUTPUT_TOKENS);
      debugLog("[Bilibili Digest] 输出被截断，放大预算重试：", tokens);
      continue;
    }

    break;
  }

  const error = new Error(diagnosis.message);
  error.code = "EMPTY_AI_RESPONSE";
  error.reason = diagnosis.reason;
  throw error;
}

// 真正发出请求，守住超时与响应大小（分工见 AI_IDLE_TIMEOUT_MS 处的说明）。
async function sendAiRequest(settings, request) {
  const controller = new AbortController();
  let timeoutKind = "";
  let idleTimer;
  let hardTimer;

  const abortFor = (kind) => {
    if (controller.signal.aborted) return;
    timeoutKind = kind;
    controller.abort();
  };
  const resetIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => abortFor("idle"), AI_IDLE_TIMEOUT_MS);
  };

  const hardTimeoutMs = settings.aiTimeoutSeconds * 1000;
  hardTimer = setTimeout(() => abortFor("hard"), hardTimeoutMs);
  // 空闲计时绝不能在这里起表：非流式请求在模型生成完之前一个字节都不会到，
  // 提前起表等于把「模型在慢慢想」当成「服务端死了」。这一段只由硬超时负责。

  try {
    const response = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: controller.signal,
    });
    // 响应头到了，body 应连续到达，空闲超时从这一刻起才有判断力。
    resetIdleTimer();

    const data = await readBoundedAiResponse(response, resetIdleTimer);
    if (!response.ok) {
      const error = new Error(
        BILI_AI_PROVIDER.parseErrorMessage(data, response.status),
      );
      error.status = response.status;
      throw error;
    }

    return data;
  } catch (error) {
    if (timeoutKind === "idle") {
      const timeout = new Error("响应传到一半断了，请重试。");
      timeout.code = "AI_IDLE_TIMEOUT";
      throw timeout;
    }
    if (timeoutKind === "hard") {
      const timeout = new Error(
        `请求超过 ${settings.aiTimeoutSeconds} 秒上限。可以在设置页调高超时，或降低并发。`,
      );
      timeout.code = "AI_HARD_TIMEOUT";
      throw timeout;
    }
    // fetch 对跨域被拒和网络不通都只抛笼统的 TypeError，给一句能指导下一步的提示。
    if (error instanceof TypeError) {
      const network = new Error(
        `连不上 ${settings.aiBaseUrl}。请检查地址是否正确、服务是否在运行，以及是否已在设置页授权。`,
      );
      network.code = "AI_NETWORK_ERROR";
      throw network;
    }
    throw error;
  } finally {
    clearTimeout(idleTimer);
    clearTimeout(hardTimer);
  }
}

/** 边读边计字节数，避免异常大的响应把内存吃满。 */
async function readBoundedAiResponse(response, onActivity) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    onActivity();
    return JSON.parse(text.trimStart());
  }

  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    onActivity();
    bytes += value?.byteLength ?? 0;
    if (bytes > AI_MAX_RESPONSE_BYTES) {
      await reader.cancel?.().catch(() => {});
      const error = new Error("响应超过 2 MiB 上限。");
      error.code = "AI_RESPONSE_TOO_LARGE";
      throw error;
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return JSON.parse(text.trimStart());
}

/** 把模型服务的错误翻译成用户能看懂、且知道下一步该干什么的提示。 */
function aiErrorResponse(error) {
  // 这几类都要用户去设置页动手，原样透出提示即可。
  const actionable = [
    "NO_AI_CONFIG",
    "NEED_HOST_PERMISSION",
    "INVALID_BASE_URL",
    "AI_NETWORK_ERROR",
  ];
  if (actionable.includes(error.code)) {
    return { success: false, error: error.code, message: error.message };
  }
  if (error.status === 401 || error.status === 403) {
    return {
      success: false,
      error: "INVALID_AI_KEY",
      message: "服务拒绝了这个密钥，请在设置里检查密钥和地址是否匹配。",
    };
  }
  if (error.status === 404) {
    return {
      success: false,
      error: "MODEL_OR_ENDPOINT_NOT_FOUND",
      message: "服务返回 404，多半是模型名写错或 API 地址不对，请到设置页核对。",
    };
  }
  if (error.status === 429) {
    return {
      success: false,
      error: "RATE_LIMITED",
      message: "服务限流了，稍等一会儿再试。",
    };
  }
  return {
    success: false,
    error: error.code || "AI_REQUEST_FAILED",
    message: error.message || "AI 请求失败。",
  };
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
function reportProgress(kind, done, total) {
  chrome.runtime
    .sendMessage({ action: "aiProgress", kind, done, total })
    .catch(() => {});
}

async function handleAnalyzeTranscript(bvidInput, { page = 1, forceRefresh = false } = {}) {
  const bvid = BILI_API.parseBvid(bvidInput);
  if (!bvid) {
    return { success: false, error: "INVALID_BVID", message: "没有识别到 BV 号。" };
  }
  const pageNumber = Number(page) > 0 ? Math.floor(Number(page)) : 1;

  const cached = await BILI_CACHE.load(bvid, { page: pageNumber });
  if (!forceRefresh && cached?.analysis) {
    return { success: true, fromCache: true, analysis: cached.analysis };
  }
  if (!forceRefresh) {
    await learningDataReady;
    const record = await BILI_LEARNING_STORE.loadLearningRecord(bvid, pageNumber, {
      storage: learningStorage,
    });
    if (record?.analysis) {
      return {
        success: true,
        fromCache: true,
        analysisSource: "learning",
        analysis: record.analysis,
      };
    }
  }

  const transcript = cached?.transcript?.length
    ? { ...cached, success: true }
    : await ensureTranscript(bvid, pageNumber);
  if (!transcript.success) return transcript;

  try {
    const settings = await getSettings();
    const chunks = BILI_AI.planAnalysisChunks(transcript.segments);
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
    reportProgress("analysis", 0, chunks.length);

    const analyzeOne = (chunk) => analyzeChunk(chunk, chunks.length, common);
    const results = await BILI_CONCURRENCY.mapWithConcurrency(
      chunks,
      settings.aiConcurrency,
      analyzeOne,
      (done, total) => reportProgress("analysis", done, total),
    );

    // 部分块失败多半是偶发超时或限流，静默补一轮；全军覆没通常是配置错误，不补。
    const failedIndexes = results
      .map((result, index) => (result.status === "rejected" ? index : -1))
      .filter((index) => index >= 0);
    if (failedIndexes.length && failedIndexes.length < chunks.length) {
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

    const parts = results
      .filter((result) => result.status === "fulfilled" && result.value)
      .map((result) => result.value);
    const failures = results.filter((result) => result.status === "rejected");

    if (!parts.length) {
      // 全军覆没时把第一个真实错误透出去，它比「生成失败」有用得多。
      throw failures[0]?.reason || new Error("概览生成失败。");
    }

    const analysis = BILI_AI.mergeAnalyses(parts, totalDuration);
    if (!analysis.chapters.length && !analysis.keyQuotes.length) {
      return {
        success: false,
        error: "EMPTY_ANALYSIS",
        message: "模型没有产出有效的章节或金句，请重试。",
      };
    }

    // 概览与字幕存在同一条缓存里，下次打开直接命中。
    await updateCache(bvid, pageNumber, (current) => ({
      ...current,
      ...persistable(transcript),
      analysis,
    }));

    // 与 30 天字幕缓存分开保存，之后导出时概览不会先于笔记消失。
    await learningDataReady;
    await BILI_LEARNING_STORE.saveLearningRecord(
      {
        bvid,
        page: pageNumber,
        videoTitle: transcript.videoInfo?.title || "",
        ownerName: transcript.videoInfo?.owner || "",
        analysis,
      },
      { storage: learningStorage },
    );

    return {
      success: true,
      fromCache: false,
      analysis,
      chunkCount: chunks.length,
      // 部分块失败仍然出结果，但要如实告诉用户这份概览是不完整的。
      failedChunks: failures.length,
    };
  } catch (error) {
    console.error("[Bilibili Digest] 概览生成失败：", error);
    return aiErrorResponse(error);
  }
}

// 时长相关变量按本块区间算，好让模型只覆盖这一段。
async function analyzeChunk(chunk, chunkCount, common) {
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

async function handleSegmentRewrite(kind, bvidInput, { page = 1, segmentIds = [] } = {}) {
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
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    const { accepted, rejected } = align(BILI_AI.parseLooseJson(text), todo);
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

// ============================================================
// 笔记
// ============================================================

// 笔记的「读—改—写」也要串行：润色是保存后异步落笔的，会和新增 / 删除并发。
const notesWriteQueue = BILI_CONCURRENCY.createSerialQueue();

function noteWriteErrorResponse(error) {
  const detail = String(error?.message || error || "");
  if (/quota|exceed|storage.+full|空间不足/i.test(detail)) {
    return {
      success: false,
      error: "STORAGE_FULL",
      message: "浏览器本地存储空间不足，已有笔记没有被删除。",
    };
  }
  return {
    success: false,
    error: "NOTE_WRITE_FAILED",
    message: detail || "笔记保存失败，请重试。",
  };
}

function mutateNotes(mutate) {
  return notesWriteQueue(async () => {
    await learningDataReady;
    const stored = await chrome.storage.local.get(NOTES_STORAGE_KEY);
    const notes = Array.isArray(stored[NOTES_STORAGE_KEY]) ? stored[NOTES_STORAGE_KEY] : [];
    const next = mutate(notes);
    await chrome.storage.local.set({ [NOTES_STORAGE_KEY]: next });
    return next;
  });
}

// 请模型把口语字幕整理成通顺的笔记。失败返回 null，笔记保持原始字幕。
async function polishNoteText(context, videoTitle) {
  try {
    const variables = {
      videoTitle: videoTitle || "未知",
      fullContext: context.fullContext,
      beforeText: context.beforeText || "（无）",
      targetText: context.targetText,
      afterText: context.afterText || "（无）",
    };
    const [systemPrompt, userPrompt] = await Promise.all([
      loadPromptSection("note-cleanup.md", "系统提示词", variables),
      loadPromptSection("note-cleanup.md", "用户提示词", variables),
    ]);

    const { text } = await requestAiCompletion({
      maxTokens: 512,
      responseFormat: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    const parsed = BILI_AI.parseLooseJson(text);
    if (typeof parsed?.quote === "string" && parsed.quote.trim()) {
      return parsed.quote.trim().slice(0, 3000);
    }
    return null;
  } catch (error) {
    // 润色失败不该让笔记丢掉，原始文本已经在库里了。
    console.warn("[Bilibili Digest] 笔记润色失败，保留原始字幕：", error.message);
    return null;
  }
}

// 后台润色完成后把正文换掉。笔记可能已被删除，map 不命中就什么都不做。
async function polishNoteWhenReady(noteId, context, videoTitle) {
  const polished = await polishNoteText(context, videoTitle);
  await mutateNotes((notes) =>
    notes.map((note) =>
      note.id === noteId && note.pending
        ? {
            ...note,
            text: polished || note.text,
            pending: false,
            updatedAt: Date.now(),
          }
        : note,
    ),
  );
  chrome.runtime.sendMessage({ action: "noteUpdated", noteId }).catch(() => {});
}

async function handleSaveNote({ bvid: bvidInput, page = 1, timestamp, text: manualText }) {
  const bvid = BILI_API.parseBvid(bvidInput);
  if (!bvid) {
    return { success: false, error: "INVALID_BVID", message: "没有识别到 BV 号。" };
  }
  const pageNumber = Number(page) > 0 ? Math.floor(Number(page)) : 1;
  const seconds = Math.max(0, Math.floor(Number(timestamp) || 0));

  const transcript = await ensureTranscript(bvid, pageNumber);
  if (!transcript.success) return transcript;

  const videoTitle = transcript.videoInfo?.title || "";
  // 概览里的「存为笔记」已经有整理好的文字，不必再过一次模型。
  let noteText = String(manualText || "").trim();
  let rawText = noteText;
  let polishContext = null;

  if (!noteText) {
    const context = BILI_AI.noteContextAt(transcript.transcript, seconds);
    if (!context) {
      return { success: false, error: "NO_TRANSCRIPT", message: "没有可用的字幕。" };
    }
    rawText = context.targetText;
    // 先用原始字幕落库，保存立即完成；润色在后台跑完再替换正文。
    noteText = [context.beforeText, context.targetText, context.afterText]
      .filter(Boolean)
      .join(" ");
    // 本地推理服务往往不需要密钥，所以用完整校验而不是只看密钥有没有填。
    const settings = await getSettings();
    if (BILI_SETTINGS.validate(settings).ok) polishContext = context;
  }

  const note = {
    id: `note_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    bvid,
    page: pageNumber,
    videoTitle: videoTitle.slice(0, 500),
    ownerName: (transcript.videoInfo?.owner || "").slice(0, 300),
    timestamp: BILI_TRANSCRIPT.formatTimestamp(seconds),
    timestampSeconds: seconds,
    timestampedUrl: BILI_API.canonicalVideoUrl(bvid, seconds, pageNumber),
    text: noteText,
    rawText,
    // 界面靠它显示「润色中」；配合 createdAt 识别润色中途挂掉留下的僵尸标记
    pending: Boolean(polishContext),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    learningId: BILI_LEARNING_STORE.learningId(bvid, pageNumber),
  };

  // 同一时刻只该有一条笔记：金句重复点「存为笔记」、或同一秒连按 n，都会攒出
  // 内容重复的笔记。去重放在串行队列里做，双击并发时也不会两边都插进去。
  let existing = null;
  await mutateNotes((notes) => {
    existing =
      notes.find(
        (item) =>
          item.bvid === bvid &&
          Number(item.page || 1) === pageNumber &&
          item.timestampSeconds === seconds,
      ) || null;
    if (existing) return notes;
    notes.unshift(note);
    return notes;
  });

  if (existing) {
    // 对调用方而言「已存在」也是成功：按钮照常显示「已保存」，不再广播刷新。
    return { success: true, duplicate: true, note: existing };
  }

  // 侧边栏可能开着笔记页，通知它刷新。
  chrome.runtime.sendMessage({ action: "noteSaved", note }).catch(() => {});

  // 故意不 await：让播放页的按钮立刻得到「已保存」。
  if (polishContext) polishNoteWhenReady(note.id, polishContext, videoTitle);

  // 兼容升级前已经生成、但只存在短期缓存中的概览。
  if (transcript.analysis) {
    BILI_LEARNING_STORE.saveLearningRecord(
      {
        bvid,
        page: pageNumber,
        videoTitle,
        ownerName: transcript.videoInfo?.owner || "",
        analysis: transcript.analysis,
      },
      { storage: learningStorage },
    ).catch((error) =>
      console.warn("[Bilibili Digest] 概览长期保存失败：", error),
    );
  }

  return { success: true, note };
}

async function handleGetNotes(bvidInput, page) {
  await learningDataReady;
  const stored = await chrome.storage.local.get(NOTES_STORAGE_KEY);
  const notes = Array.isArray(stored[NOTES_STORAGE_KEY]) ? stored[NOTES_STORAGE_KEY] : [];
  const bvid = bvidInput ? BILI_API.parseBvid(bvidInput) : null;
  const pageNumber = Number(page) > 0 ? Math.floor(Number(page)) : null;
  return {
    success: true,
    notes: bvid
      ? notes.filter(
          (note) =>
            note.bvid === bvid &&
            (!pageNumber || Number(note.page || 1) === pageNumber),
        )
      : notes,
    totalCount: notes.length,
  };
}

async function handleDeleteNote(noteId) {
  await mutateNotes((notes) => notes.filter((note) => note.id !== noteId));
  return { success: true };
}

async function handleUpdateNote(noteId, input) {
  const text = String(input || "").trim();
  if (!text) {
    return {
      success: false,
      error: "EMPTY_NOTE",
      message: "笔记正文不能为空。",
    };
  }
  if (text.length > 3000) {
    return {
      success: false,
      error: "NOTE_TOO_LONG",
      message: "笔记正文不能超过 3000 个字符。",
    };
  }

  let updated = null;
  await mutateNotes((notes) =>
    notes.map((note) => {
      if (note.id !== noteId) return note;
      updated = { ...note, text, pending: false, updatedAt: Date.now() };
      return updated;
    }),
  );
  if (!updated) {
    return {
      success: false,
      error: "NOTE_NOT_FOUND",
      message: "这条笔记已经不存在了。",
    };
  }

  chrome.runtime.sendMessage({ action: "noteUpdated", noteId }).catch(() => {});
  return { success: true, note: updated };
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
