/**
 * 字幕管线：缓存优先的字幕获取、轨道选择后的内容组装、学习资料快照的恢复，
 * 以及概览 / 顺句 / 翻译共用的缓存「读—改—写」助手。
 *
 * 依赖注入与纯 lib 的分工见 lib/notes-service.js 头注。
 */
var BILI_TRANSCRIPT_SERVICE = (() => {
  const API =
    typeof BILI_API !== "undefined" ? BILI_API : require("./bili-api.js");
  const TRANSCRIPT =
    typeof BILI_TRANSCRIPT !== "undefined"
      ? BILI_TRANSCRIPT
      : require("./transcript.js");
  const LEARNING_STORE =
    typeof BILI_LEARNING_STORE !== "undefined"
      ? BILI_LEARNING_STORE
      : require("./learning-store.js");

  function createTranscriptService({
    // 缓存带 IndexedDB 环境耦合，必须注入而不能摸全局（跨 realm 加载时
    // 全局会解析到定义时的 realm，见 lib/ai-transport.js 的 fetch 注释）。
    cache,
    // 迁移闸与概览仓储：字幕过期后要靠长期学习资料把概览接回来。
    dataReady,
    learningRepository,
    getSettings,
    logDebug = () => {},
    logError = () => {},
  }) {
    if (!cache || !dataReady || !learningRepository || !getSettings) {
      throw new Error("字幕服务需要缓存、迁移闸、概览仓储与设置读取");
    }

    /** 字幕缓存只有 30 天；用户生成过的概览属于学习资料，过期后仍应能与笔记重聚。 */
    async function restoreLearningAnalysis(payload, bvid, page) {
      const failuresOf = (record) =>
        Array.isArray(record?.analysisFailures) ? record.analysisFailures : [];

      if (payload?.analysis) {
        if (Array.isArray(payload.analysisFailures)) return payload;
        await dataReady();
        const record = await LEARNING_STORE.loadLearningRecord(bvid, page, {
          repository: learningRepository(),
        });
        return { ...payload, analysisFailures: failuresOf(record) };
      }
      await dataReady();
      const record = await LEARNING_STORE.loadLearningRecord(bvid, page, {
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

    // 优先命中缓存，未命中走 view → player/wbi/v2 → 字幕 JSON。
    async function fetchTranscript(
      bvidInput,
      { page = 1, forceRefresh = false } = {},
    ) {
      const bvid = API.parseBvid(bvidInput);
      if (!bvid) {
        return {
          success: false,
          error: "INVALID_BVID",
          message: "没有识别到 BV 号，请在 B 站播放页使用。",
        };
      }

      const pageNumber = Number(page) > 0 ? Math.floor(Number(page)) : 1;

      if (!forceRefresh) {
        const cached = await cache.load(bvid, { page: pageNumber });
        if (cached?.transcript?.length) {
          logDebug("[Bilibili Digest] 命中字幕缓存：", bvid);
          const restored = await restoreLearningAnalysis(cached, bvid, pageNumber);
          // 标志放在展开之后：旧版本写进缓存的脏标志不能盖过本次的真实值。
          return { ...restored, success: true, fromCache: true };
        }
      }

      try {
        const settings = await getSettings();
        const videoInfo = await API.fetchVideoInfo(bvid, { page: pageNumber });
        const { tracks, needLogin } = await API.fetchSubtitleTracks(videoInfo);

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

        const track = API.pickSubtitleTrack(
          tracks,
          settings.subtitleLangPreference,
        );
        const entries = await API.fetchSubtitleTrackContent(track.url);
        if (!entries.length) {
          return {
            success: false,
            error: "EMPTY_TRANSCRIPT",
            message: "字幕文件是空的。",
            videoInfo,
          };
        }

        const segments = TRANSCRIPT.groupTranscriptEntries(entries);
        const texts = TRANSCRIPT.buildTranscriptTexts(entries);

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
        await cache.save(bvid, restored, { page: pageNumber });
        return { ...restored, success: true, fromCache: false };
      } catch (error) {
        logError("[Bilibili Digest] 字幕获取失败：", error);
        return {
          success: false,
          error: error.code || "TRANSCRIPT_FETCH_FAILED",
          message: error.message || "字幕获取失败。",
        };
      }
    }

    /** 概览和笔记都需要字幕，统一从缓存拿，没有再走网络。 */
    async function ensureTranscript(bvid, page) {
      const cached = await cache.load(bvid, { page });
      if (cached?.transcript?.length) return { ...cached, success: true };
      return fetchTranscript(bvid, { page });
    }

    // 缓存的「读—改—写」必须串行：并发批次会各自读到旧快照，后写的覆盖先写的，
    // 表现为「有些段落莫名其妙没保存下来」，既不报错也难复现。
    const cacheWriteQueue =
      typeof BILI_CONCURRENCY !== "undefined"
        ? BILI_CONCURRENCY.createSerialQueue()
        : require("./concurrency.js").createSerialQueue();

    function updateCache(bvid, page, mutate) {
      return cacheWriteQueue(async () => {
        const current = (await cache.load(bvid, { page })) || {};
        const next = mutate(current);
        // 只是更新已有条目，跳过淘汰——淘汰要读全量存储，一次任务几十批经不起这么读。
        await cache.save(bvid, next, { page, evict: false });
        return next;
      });
    }

    // success / fromCache 是每次响应现算的，跟着 spread 写进缓存的话，
    // 下次命中时旧标志会盖掉新标志，落库前必须剥掉。
    function persistable(transcript) {
      const { success, fromCache, ...rest } = transcript;
      return rest;
    }

    return { fetchTranscript, ensureTranscript, updateCache, persistable };
  }

  return { createTranscriptService };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = BILI_TRANSCRIPT_SERVICE;
}
