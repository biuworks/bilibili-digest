/**
 * 笔记业务：保存（含去重与后台润色）、编辑、删除、AI 优化候选的生成与采纳，
 * 以及学习资料的备份导出导入。
 *
 * 从 background.js 拆出的原因：这一块有自己的一致性约束（串行读改写、
 * 引用 diff 增量提交、revision 乐观锁），值得独立的测试入口，
 * 也让 background 向「路由 + 生命周期」的目标收缩。
 *
 * 环境依赖全部经 createNotesService 注入；四个纯 lib 用顶层守卫解析
 * （importScripts 顺序由契约测试看住）。
 */
var BILI_NOTES_SERVICE = (() => {
  const LEARNING_STORE =
    typeof BILI_LEARNING_STORE !== "undefined"
      ? BILI_LEARNING_STORE
      : require("./learning-store.js");
  const AI = typeof BILI_AI !== "undefined" ? BILI_AI : require("./ai.js");
  const API =
    typeof BILI_API !== "undefined" ? BILI_API : require("./bili-api.js");
  const TRANSCRIPT =
    typeof BILI_TRANSCRIPT !== "undefined"
      ? BILI_TRANSCRIPT
      : require("./transcript.js");
  const CONCURRENCY =
    typeof BILI_CONCURRENCY !== "undefined"
      ? BILI_CONCURRENCY
      : require("./concurrency.js");

  function createNotesService({
    // 惰性取仓储：background 在拿到 indexedDB 后才建连接。
    repositories,
    // 迁移闸：所有读写等 v2/笔记/缓存/概览四步迁移完成。
    dataReady,
    ensureTranscript,
    loadPromptSection,
    requestAiCompletion,
    // () => Promise<boolean>：AI 配置是否可用，决定要不要后台润色。
    settingsValid,
    // 发侧边栏广播，吞错（面板可能没开）。
    broadcast,
    // 笔记优化的任务进度（aiTasks.progress）。
    onTaskProgress = () => {},
    logWarn = () => {},
  }) {
    if (!repositories?.notes || !repositories?.learning || !dataReady) {
      throw new Error("笔记服务需要仓储与迁移闸");
    }

    // 笔记的「读—改—写」在 IndexedDB 上仍要走串行队列：润色是保存后异步落笔的，
    // 会和新增 / 删除并发，IndexedDB 的事务只保证单次 write 原子，管不了
    // 跨 await 的读改写竞态。
    const writeQueue = CONCURRENCY.createSerialQueue();

    /**
     * 提交按引用相等做增量 diff：mutator 必须原样返回未改动项的同一引用
     * （现有各处都是 spread 出新对象表示「改了」），一次编辑只重写真正
     * 变化的那几条。交给 mutator 的是副本：有的调用方会原地改数组
     * （比如 unshift 新笔记），不能污染用来对照的快照。
     */
    function mutateNotes(mutate) {
      return writeQueue(async () => {
        await dataReady();
        const repository = repositories.notes();
        const current = await repository.all();
        const next = mutate([...current]);
        if (!Array.isArray(next)) {
          throw new Error("笔记变更加工没有返回列表");
        }

        const nextIds = new Set(
          next.filter((note) => note?.id).map((note) => note.id),
        );
        const remove = current
          .filter((note) => !nextIds.has(note.id))
          .map((note) => note.id);
        const currentById = new Map(current.map((note) => [note.id, note]));
        const put = next.filter(
          (note) => note?.id && currentById.get(note.id) !== note,
        );
        if (put.length || remove.length) {
          await repository.commit({ put, remove });
        }
        return next;
      });
    }

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

        const parsed = AI.parseLooseJson(text);
        if (typeof parsed?.quote === "string" && parsed.quote.trim()) {
          return parsed.quote.trim().slice(0, 3000);
        }
        return null;
      } catch (error) {
        // 润色失败不该让笔记丢掉，原始文本已经在库里了。
        logWarn("[Bilibili Digest] 笔记润色失败，保留原始字幕：", error.message);
        return null;
      }
    }

    // 用户主动优化时以当前正文为唯一输入：手动写下的观点不能被原始字幕重置。
    async function refineCurrentNoteText(currentText, videoTitle, { signal } = {}) {
      const variables = {
        videoTitle: videoTitle || "未知",
        currentText,
      };
      const [systemPrompt, userPrompt] = await Promise.all([
        loadPromptSection("note-refine.md", "系统提示词", variables),
        loadPromptSection("note-refine.md", "用户提示词", variables),
      ]);
      const { text } = await requestAiCompletion({
        maxTokens: AI.estimateOutputTokens(currentText.length, {
          ratio: 1.2,
          floor: 512,
          ceiling: 4096,
        }),
        responseFormat: { type: "json_object" },
        signal,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      });
      const parsed = AI.parseLooseJson(text);
      const refined = typeof parsed?.quote === "string" ? parsed.quote.trim() : "";
      if (!refined) {
        const error = new Error("模型没有返回有效的笔记正文，请重试。");
        error.code = "EMPTY_AI_RESPONSE";
        throw error;
      }
      return refined.slice(0, 3000);
    }

    // 后台润色完成后把正文换掉。笔记可能已被删除，map 不命中就什么都不做。
    async function polishNoteWhenReady(noteId, context, videoTitle) {
      const polished = await polishNoteText(context, videoTitle);
      await mutateNotes((notes) =>
        notes.map((note) => {
          if (note.id !== noteId || !note.pending) return note;
          const changed = Boolean(polished && polished !== note.text);
          return {
            ...note,
            text: polished || note.text,
            pending: false,
            updatedAt: changed ? Date.now() : note.updatedAt,
            revision:
              Math.max(1, Number(note.revision) || 1) + (changed ? 1 : 0),
            contentSource: changed ? "ai" : note.contentSource,
          };
        }),
      );
      broadcast({ action: "noteUpdated", noteId });
    }

    async function saveNote({ bvid: bvidInput, page = 1, timestamp, text: manualText }) {
      const bvid = API.parseBvid(bvidInput);
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
        const context = AI.noteContextAt(transcript.transcript, seconds);
        if (!context) {
          return { success: false, error: "NO_TRANSCRIPT", message: "没有可用的字幕。" };
        }
        rawText = context.targetText;
        // 先用原始字幕落库，保存立即完成；润色在后台跑完再替换正文。
        noteText = [context.beforeText, context.targetText, context.afterText]
          .filter(Boolean)
          .join(" ");
        // 本地推理服务往往不需要密钥，所以用完整校验而不是只看密钥有没有填。
        if (await settingsValid()) polishContext = context;
      }

      const note = {
        id: `note_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        bvid,
        page: pageNumber,
        videoTitle: videoTitle.slice(0, 500),
        ownerName: (transcript.videoInfo?.owner || "").slice(0, 300),
        timestamp: TRANSCRIPT.formatTimestamp(seconds),
        timestampSeconds: seconds,
        timestampedUrl: API.canonicalVideoUrl(bvid, seconds, pageNumber),
        text: noteText,
        rawText,
        // 界面靠它显示「润色中」；配合 createdAt 识别润色中途挂掉留下的僵尸标记
        pending: Boolean(polishContext),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        learningId: LEARNING_STORE.learningId(bvid, pageNumber),
        revision: 1,
        contentSource: manualText ? "ai" : "raw",
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
      broadcast({ action: "noteSaved", note });

      // 故意不 await：让播放页的按钮立刻得到「已保存」。但 rejection
      // 必须接住，否则 IDB 写失败会变成未处理的 promise rejection，
      // 笔记卡在 pending 却没有任何日志。
      if (polishContext) {
        polishNoteWhenReady(note.id, polishContext, videoTitle).catch((error) =>
          logWarn("[Bilibili Digest] 笔记后台润色失败：", error),
        );
      }

      // 兼容升级前已经生成、但只存在短期缓存中的概览。
      if (transcript.analysis) {
        LEARNING_STORE.saveLearningRecord(
          {
            bvid,
            page: pageNumber,
            videoTitle,
            ownerName: transcript.videoInfo?.owner || "",
            analysis: transcript.analysis,
          },
          { repository: repositories.learning() },
        ).catch((error) =>
          logWarn("[Bilibili Digest] 概览长期保存失败：", error),
        );
      }

      return { success: true, note };
    }

    async function getNotes(bvidInput, page) {
      await dataReady();
      const notes = await repositories.notes().all();
      const bvid = bvidInput ? API.parseBvid(bvidInput) : null;
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

    async function exportLearningBackup() {
      await dataReady();
      const [notes, learning] = await Promise.all([
        repositories.notes().all(),
        repositories.learning().all(),
      ]);
      return {
        success: true,
        backup: LEARNING_STORE.buildBackup({ notes, learning }),
      };
    }

    async function importLearningBackup(payload) {
      await dataReady();
      const parsed = LEARNING_STORE.parseBackup(payload);
      if (!parsed.ok) return { success: false, error: parsed.error, message: parsed.message };
      // 笔记的读—改—写进串行队列：导入期间用户编辑或后台润色落库的更新，
      // 不能被这里整表 put 的旧快照盖掉。learning 没有并发写路径，保持原样。
      const merged = await writeQueue(async () => {
        const [notes, learning] = await Promise.all([
          repositories.notes().all(),
          repositories.learning().all(),
        ]);
        const result = LEARNING_STORE.mergeBackup(notes, learning, parsed.backup);
        // 笔记与概览各自单事务写入 IndexedDB。中途失败重跑导入即可：
        // 合并按 updatedAt 取新，天然幂等。
        if (result.learning.length) {
          await repositories.learning().commit({ put: result.learning });
        }
        await repositories.notes().commit({ put: result.notes });
        return result;
      });
      broadcast({ action: "notesImported" });
      return {
        success: true,
        notesAdded: merged.notesAdded,
        notesUpdated: merged.notesUpdated,
        learningAdded: merged.learningAdded,
        learningUpdated: merged.learningUpdated,
      };
    }

    async function deleteNote(noteId) {
      await mutateNotes((notes) => notes.filter((note) => note.id !== noteId));
      return { success: true };
    }

    async function updateNote(noteId, input) {
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
          const { aiDraft, ...current } = note;
          updated = {
            ...current,
            text,
            pending: false,
            updatedAt: Date.now(),
            revision: Math.max(1, Number(note.revision) || 1) + 1,
            contentSource: "user",
          };
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

      broadcast({ action: "noteUpdated", noteId });
      return { success: true, note: updated };
    }

    async function generateNoteDraft(noteId, { signal, taskId } = {}) {
      if (taskId) {
        onTaskProgress(taskId, {
          phase: "generating",
          message: "正在生成优化建议…",
        });
      }
      await dataReady();
      const notes = await repositories.notes().all();
      const snapshot = notes.find((note) => note.id === noteId);
      if (!snapshot) {
        return {
          success: false,
          error: "NOTE_NOT_FOUND",
          message: "这条笔记已经不存在了。",
        };
      }

      const currentText = String(snapshot.text || "").trim();
      if (!currentText) {
        return {
          success: false,
          error: "EMPTY_NOTE",
          message: "笔记正文为空，先写下内容再使用 AI 优化。",
        };
      }
      const basedOnRevision = Math.max(1, Number(snapshot.revision) || 1);
      const draftText = await refineCurrentNoteText(currentText, snapshot.videoTitle, { signal });
      if (signal?.aborted) {
        const error = new Error("任务已取消。");
        error.code = "TASK_CANCELED";
        throw error;
      }
      let updated = null;
      await mutateNotes((currentNotes) =>
        currentNotes.map((note) => {
          if (note.id !== noteId) return note;
          const currentRevision = Math.max(1, Number(note.revision) || 1);
          updated = {
            ...note,
            aiDraft: {
              text: draftText,
              basedOnRevision,
              createdAt: Date.now(),
              conflict: currentRevision !== basedOnRevision,
            },
          };
          return updated;
        }),
      );
      if (!updated) {
        return {
          success: false,
          error: "NOTE_NOT_FOUND",
          message: "生成期间这条笔记已被删除。",
        };
      }

      broadcast({ action: "noteUpdated", noteId });
      return { success: true, note: updated };
    }

    async function resolveNoteDraft(noteId, mode, expectedRevision) {
      if (!["replace", "append", "discard"].includes(mode)) {
        return {
          success: false,
          error: "INVALID_DRAFT_ACTION",
          message: "不支持这个候选处理方式。",
        };
      }

      let updated = null;
      let failure = null;
      await mutateNotes((notes) =>
        notes.map((note) => {
          if (note.id !== noteId) return note;
          const revision = Math.max(1, Number(note.revision) || 1);
          if (!note.aiDraft?.text) {
            failure = {
              success: false,
              error: "NOTE_DRAFT_NOT_FOUND",
              message: "AI 候选已经不存在了，请重新生成。",
            };
            return note;
          }
          if (mode === "discard") {
            const { aiDraft, ...current } = note;
            updated = current;
            return updated;
          }
          if (revision !== Number(expectedRevision)) {
            failure = {
              success: false,
              error: "NOTE_CONFLICT",
              message: "笔记内容已经发生变化，请确认最新内容后再操作。",
              note,
            };
            return note;
          }

          const { aiDraft, ...current } = note;
          const text =
            mode === "append"
              ? `${String(note.text || "").trim()}\n\n${aiDraft.text}`.trim()
              : aiDraft.text;
          if (text.length > 3000) {
            failure = {
              success: false,
              error: "NOTE_TOO_LONG",
              message: "追加后超过 3000 个字符，请先精简当前笔记。",
            };
            return note;
          }
          updated = {
            ...current,
            text,
            pending: false,
            updatedAt: Date.now(),
            revision: revision + 1,
            contentSource: mode === "replace" ? "ai" : "user",
          };
          return updated;
        }),
      );
      if (failure) return failure;
      if (!updated) {
        return {
          success: false,
          error: "NOTE_NOT_FOUND",
          message: "这条笔记已经不存在了。",
        };
      }

      broadcast({ action: "noteUpdated", noteId });
      return { success: true, note: updated };
    }

    return {
      saveNote,
      getNotes,
      deleteNote,
      updateNote,
      generateNoteDraft,
      resolveNoteDraft,
      exportLearningBackup,
      importLearningBackup,
      noteWriteErrorResponse,
    };
  }

  return { createNotesService };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = BILI_NOTES_SERVICE;
}
