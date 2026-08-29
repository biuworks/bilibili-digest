/**
 * 概览生成管线：分块规划、并发执行、偶发失败的自动补轮、失败区间的
 * 单独补块，以及快照落库（字幕缓存 + 长期学习资料）。
 *
 * 「部分块失败仍然出结果」是刻意的：全军覆没通常是配置错误，
 * 把第一个真实错误透出去；零星失败多半是超时或限流，静默补一轮。
 *
 * 环境依赖全部注入；纯 lib 按仓库惯例顶层守卫解析。
 */
var BILI_ANALYSIS_SERVICE = (() => {
  const AI = typeof BILI_AI !== "undefined" ? BILI_AI : require("./ai.js");
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
  const SETTINGS =
    typeof BILI_SETTINGS !== "undefined"
      ? BILI_SETTINGS
      : require("../settings.js");

  function taskCanceledError() {
    const error = new Error("任务已取消。");
    error.code = "TASK_CANCELED";
    return error;
  }

  function createAnalysisService({
    cache,
    dataReady,
    learningRepository,
    getSettings,
    ensureTranscript,
    updateCache,
    persistable,
    loadPromptSection,
    requestAiCompletion,
    aiErrorResponse,
    // 进度上报：任务中心 + 侧边栏广播（面板没开时吞错）。
    broadcast,
    onTaskProgress,
    logDebug = () => {},
    logError = () => {},
  }) {
    if (
      !cache ||
      !dataReady ||
      !learningRepository ||
      !getSettings ||
      !ensureTranscript ||
      !updateCache ||
      !persistable ||
      !loadPromptSection ||
      !requestAiCompletion ||
      !aiErrorResponse
    ) {
      throw new Error("概览服务缺少必要依赖");
    }

    function throwIfTaskCanceled(signal) {
      if (signal?.aborted) throw taskCanceledError();
    }

    function reportProgress(kind, done, total, { taskId, phase, message } = {}) {
      if (taskId) onTaskProgress(taskId, { done, total, phase, message });
      broadcast({ action: "aiProgress", kind, done, total, phase, message, taskId });
    }

    async function analyzeTranscript(
      bvidInput,
      { page = 1, forceRefresh = false, signal, taskId } = {},
    ) {
      const bvid = API.parseBvid(bvidInput);
      if (!bvid) {
        return { success: false, error: "INVALID_BVID", message: "没有识别到 BV 号。" };
      }
      const pageNumber = Number(page) > 0 ? Math.floor(Number(page)) : 1;

      const cached = await cache.load(bvid, { page: pageNumber });
      if (!forceRefresh && cached?.analysis) {
        const failures = Array.isArray(cached.analysisFailures)
          ? cached.analysisFailures
          : [];
        return {
          success: true,
          fromCache: true,
          analysis: cached.analysis,
          analysisFailures: failures,
          failedChunks: failures.length,
        };
      }
      if (!forceRefresh) {
        await dataReady();
        const record = await LEARNING_STORE.loadLearningRecord(bvid, pageNumber, {
          repository: learningRepository(),
        });
        if (record?.analysis) {
          const failures = Array.isArray(record.analysisFailures)
            ? record.analysisFailures
            : [];
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
        const chunkOptions = SETTINGS.analysisChunkOptions(settings);
        const chunks = AI.planAnalysisChunks(transcript.segments, chunkOptions);
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

        logDebug(
          `[Bilibili Digest] 概览分 ${chunks.length} 块，并发 ${settings.aiConcurrency}`,
        );
        reportProgress("analysis", 0, chunks.length, {
          taskId,
          phase: "generating",
          message: `正在生成第 0/${chunks.length} 块`,
        });

        const results = await analyzePlannedChunks(
          chunks,
          chunks.length,
          common,
          settings,
          { signal, taskId },
        );
        throwIfTaskCanceled(signal);

        const parts = results
          .filter((result) => result.status === "fulfilled" && result.value)
          .map((result) => result.value);
        const remaining = AI.chunkFailureRanges(chunks, results);

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
        const analysis = AI.mergeAnalyses(parts, totalDuration);
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
        logError("[Bilibili Digest] 概览生成失败：", error);
        return aiErrorResponse(error);
      }
    }

    async function retryFailedAnalysis(
      bvidInput,
      { page = 1, signal, taskId } = {},
    ) {
      const bvid = API.parseBvid(bvidInput);
      if (!bvid) {
        return { success: false, error: "INVALID_BVID", message: "没有识别到 BV 号。" };
      }
      const pageNumber = Number(page) > 0 ? Math.floor(Number(page)) : 1;
      const cached = await cache.load(bvid, { page: pageNumber });
      const transcript = cached?.transcript?.length
        ? { ...cached, success: true }
        : await ensureTranscript(bvid, pageNumber);
      if (!transcript.success) return transcript;

      await dataReady();
      const record = await LEARNING_STORE.loadLearningRecord(bvid, pageNumber, {
        repository: learningRepository(),
      });
      const existing = transcript.analysis || record?.analysis;
      const storedFailures =
        Array.isArray(transcript.analysisFailures) && transcript.analysisFailures.length
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
        const chunkOptions = SETTINGS.analysisChunkOptions(settings);
        const chunks = AI.planAnalysisChunks(transcript.segments, chunkOptions);
        const selected = AI.chunksForFailureRanges(chunks, storedFailures);
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

        logDebug(`[Bilibili Digest] 补 ${selected.length} 个失败分块`);
        reportProgress("analysis", 0, selected.length, {
          taskId,
          phase: "retrying",
          message: `正在补第 0/${selected.length} 个失败块`,
        });

        const results = await analyzePlannedChunks(
          selected,
          chunks.length,
          common,
          settings,
          {
            signal,
            taskId,
            progressMessage: (done, total) => `正在补第 ${done}/${total} 个失败块`,
            retryPartialOnly: false,
          },
        );
        throwIfTaskCanceled(signal);

        const parts = results
          .filter((result) => result.status === "fulfilled" && result.value)
          .map((result) => result.value);
        const remaining = AI.chunkFailureRanges(selected, results);
        const analysis = parts.length
          ? AI.mergeRetryIntoAnalysis(existing, parts, selected, totalDuration)
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
        logError("[Bilibili Digest] 补失败块失败：", error);
        return aiErrorResponse(error);
      }
    }

    async function persistAnalysisSnapshot(
      bvid,
      pageNumber,
      transcript,
      analysis,
      analysisFailures,
    ) {
      // current 必须赢过任务开始时的快照：概览要跑几分钟，期间顺句/翻译
      // 批次会持续写 polished/translated，反向展开会把它们回滚到任务起点。
      // 快照只负责补缺（current 不存在或缺字段的新拉取场景）。
      await updateCache(bvid, pageNumber, (current) => ({
        ...persistable(transcript),
        ...current,
        analysis,
        analysisFailures,
      }));
      await dataReady();
      await LEARNING_STORE.saveLearningRecord(
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
      const label =
        progressMessage || ((done, total) => `正在生成第 ${done}/${total} 块`);
      const results = await (
        typeof BILI_CONCURRENCY !== "undefined"
          ? BILI_CONCURRENCY
          : require("./concurrency.js")
      ).mapWithConcurrency(chunks, settings.aiConcurrency, analyzeOne, (done, total) =>
        reportProgress("analysis", done, total, {
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
        logDebug(`[Bilibili Digest] ${failedIndexes.length} 块失败，自动补一轮`);
        const retried = await (
          typeof BILI_CONCURRENCY !== "undefined"
            ? BILI_CONCURRENCY
            : require("./concurrency.js")
        ).mapWithConcurrency(failedIndexes.map((index) => chunks[index]), settings.aiConcurrency, analyzeOne);
        failedIndexes.forEach((chunkIndex, i) => {
          if (retried[i].status === "fulfilled") results[chunkIndex] = retried[i];
        });
      }
      return results;
    }

    // 时长相关变量按本块区间算，好让模型只覆盖这一段。
    async function analyzeChunk(chunk, chunkCount, common, { signal } = {}) {
      const timing = AI.analysisTimingVariables(chunk.text, chunk.endSeconds);
      const rangeNote =
        chunkCount > 1
          ? `注意：这是长视频切分后的第 ${chunk.index + 1} / ${chunkCount} 段，` +
            `覆盖 ${TRANSCRIPT.formatTimestamp(chunk.startSeconds)} 到 ` +
            `${TRANSCRIPT.formatTimestamp(chunk.endSeconds)}。` +
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
        startFormatted: TRANSCRIPT.formatTimestamp(chunk.startSeconds),
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
        maxTokens: AI.estimateOutputTokens(chunk.text.length, {
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

      return AI.validateAnalysis(
        AI.parseLooseJson(text),
        timing.maxTimestampSeconds,
        chunk.startSeconds,
      );
    }

    return { analyzeTranscript, retryFailedAnalysis };
  }

  return { createAnalysisService };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = BILI_ANALYSIS_SERVICE;
}
