/**
 * 视频问答服务：检索（lib/qa-retrieval.js）→ 生成 → 引用校验
 * （lib/qa-citations.js）→ 历史落库。设计见 QA-DESIGN.md。
 *
 * Phase 1 是单轮独立问答：每次提问只依赖当前字幕与问题本身，
 * 历史仅作记录不回喂模型——token 与状态管理都保持简单。
 */
var BILI_QA_SERVICE = (() => {
  const AI = typeof BILI_AI !== "undefined" ? BILI_AI : require("./ai.js");
  const API =
    typeof BILI_API !== "undefined" ? BILI_API : require("./bili-api.js");
  const LEARNING_STORE =
    typeof BILI_LEARNING_STORE !== "undefined"
      ? BILI_LEARNING_STORE
      : require("./learning-store.js");
  const SETTINGS =
    typeof BILI_SETTINGS !== "undefined"
      ? BILI_SETTINGS
      : require("../settings.js");
  const RETRIEVAL =
    typeof BILI_QA_RETRIEVAL !== "undefined"
      ? BILI_QA_RETRIEVAL
      : require("./qa-retrieval.js");
  const CITATIONS =
    typeof BILI_QA_CITATIONS !== "undefined"
      ? BILI_QA_CITATIONS
      : require("./qa-citations.js");

  /** 历史记录的仓储：与笔记同模式，按条增删，最新在前。 */
  function createQaRepository({ driver }) {
    if (!driver) throw new Error("问答仓储需要存储驱动");
    const isValid = (record) =>
      Boolean(
        record &&
          typeof record === "object" &&
          String(record.id || "").startsWith("qa_"),
      );
    return {
      async all() {
        const rows = await driver.getAll();
        return rows
          .filter(isValid)
          .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
      },
      async find(id) {
        const row = await driver.get(id);
        return isValid(row) ? row : null;
      },
      async save(record) {
        await driver.write({ put: [record] });
      },
      async remove(id) {
        await driver.write({ remove: [id] });
      },
    };
  }

  // 回答控制在 300 字内，2048 tokens 加 JSON 结构与引用开销绰绰有余。
  const ANSWER_MAX_TOKENS = 2048;

  function taskCanceledError() {
    const error = new Error("任务已取消。");
    error.code = "TASK_CANCELED";
    return error;
  }

  function createQaService({
    cache,
    dataReady,
    ensureTranscript,
    learningRepository,
    getSettings,
    loadPromptSection,
    repository,
    requestAiCompletion,
    aiErrorResponse,
    onTaskProgress = () => {},
    logError = () => {},
  }) {
    if (
      !cache ||
      !dataReady ||
      !ensureTranscript ||
      !learningRepository ||
      !getSettings ||
      !repository ||
      !loadPromptSection ||
      !requestAiCompletion ||
      !aiErrorResponse
    ) {
      throw new Error("问答服务缺少必要依赖");
    }

    function throwIfTaskCanceled(signal) {
      if (signal?.aborted) throw taskCanceledError();
    }

    // 零有效引用时整条替换——宁可少答，不可编造。
    const FALLBACK_ANSWER =
      "未能从字幕中找到足够的依据来回答这个问题。" +
      "可以换个说法再问一次，或先确认这个视频里是否有你想问的内容。";

    async function askQuestion({
      bvid: bvidInput,
      page = 1,
      question,
      signal,
      taskId,
    } = {}) {
      const bvid = API.parseBvid(bvidInput);
      const text = String(question || "").trim();
      if (!bvid) {
        return { success: false, error: "INVALID_BVID", message: "没有识别到 BV 号。" };
      }
      if (!text) {
        return { success: false, error: "EMPTY_QUESTION", message: "先输入问题。" };
      }
      if (text.length > 500) {
        return {
          success: false,
          error: "QUESTION_TOO_LONG",
          message: "问题不能超过 500 个字符。",
        };
      }
      const pageNumber = Number(page) > 0 ? Math.floor(Number(page)) : 1;

      try {
        throwIfTaskCanceled(signal);
        onTaskProgress(taskId, { phase: "generating", message: "正在检索相关内容…" });

        // segments 来自缓存优先的字幕管线：重复提问不发新请求。
        const transcript = await ensureTranscript(bvid, pageNumber);
        if (!transcript.success) return transcript;

        await dataReady();
        const record = await LEARNING_STORE.loadLearningRecord(bvid, pageNumber, {
          repository: learningRepository(),
        });
        const chapters = Array.isArray(record?.analysis?.chapters)
          ? record.analysis.chapters
          : [];

        const settings = await getSettings();
        const chunks = AI.planAnalysisChunks(
          transcript.segments,
          SETTINGS.analysisChunkOptions(settings),
        );

        const context = RETRIEVAL.selectContext({
          chunks,
          question: text,
          chapters,
          totalDurationSeconds: Math.floor(
            Number(transcript.videoInfo?.duration) || 0,
          ),
        });
        if (!context.chunks.length) {
          return { success: false, error: "NO_TRANSCRIPT", message: "没有可用的字幕。" };
        }
        const contextText = context.chunks.map((chunk) => chunk.text).join("\n\n");

        onTaskProgress(taskId, { phase: "generating", message: "正在组织回答…" });
        const variables = {
          videoTitle: transcript.videoInfo?.title || "未知",
          ownerName: transcript.videoInfo?.owner || "未知",
          question: text,
          transcriptText: contextText,
        };
        const [systemPrompt, userPrompt] = await Promise.all([
          loadPromptSection("qa.md", "系统提示词", variables),
          loadPromptSection("qa.md", "用户提示词", variables),
        ]);

        const { text: raw } = await requestAiCompletion({
          maxTokens: ANSWER_MAX_TOKENS,
          responseFormat: { type: "json_object" },
          signal,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        });
        throwIfTaskCanceled(signal);

        const parsed = AI.parseLooseJson(raw);
        let answer = typeof parsed?.answer === "string" ? parsed.answer.trim() : "";
        // 模型偶尔会把整个回答当引语包上成对引号，展示前剥掉。
        answer = answer.replace(/^[“"'\s]+/, "").replace(/[”"'\s]+$/, "");

        // 依据原句由本地从字幕提取：模型只负责在正文里标 [分:秒]，
        // 引用内容想编造都没有载体，也不再花输出 token 摘录原句。
        const citations = CITATIONS.buildCitationsFromAnswer(
          answer,
          transcript.transcript,
          context.timeRange,
        );
        if (!answer) {
          answer = FALLBACK_ANSWER;
        } else if (!citations.length) {
          // 正文里没有任何落在字幕范围内的引用：视为没有依据。
          answer = FALLBACK_ANSWER;
        }

        // clickable 一并入库：历史卡片渲染时才知道哪些时间戳可点。
        const entry = {
          id: `qa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          bvid,
          page: pageNumber,
          question: text,
          answer,
          citations,
          clickable: [...CITATIONS.clickableTimestamps(answer, context.timeRange)],
          createdAt: Date.now(),
        };
        await dataReady();
        // 与其它服务一致：repository 是惰性 getter，首次调用才建连接。
        const history = await repository();
        await history.save(entry);

        return { success: true, entry, retrievalMode: context.mode };
      } catch (error) {
        logError("[Bilibili Digest] 问答失败：", error);
        return aiErrorResponse(error);
      }
    }

    async function getQaHistory(bvidInput, page) {
      await dataReady();
      const bvid = API.parseBvid(bvidInput);
      if (!bvid) return { success: true, entries: [] };
      const pageNumber = Number(page) > 0 ? Math.floor(Number(page)) : 1;
      const entries = (await (await repository()).all()).filter(
        (entry) => entry.bvid === bvid && Number(entry.page || 1) === pageNumber,
      );
      return { success: true, entries };
    }

    async function deleteQaEntry(id) {
      await dataReady();
      await (await repository()).remove(String(id || ""));
      return { success: true };
    }

    return { askQuestion, getQaHistory, deleteQaEntry };
  }

  return { createQaService, createQaRepository };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = BILI_QA_SERVICE;
}
