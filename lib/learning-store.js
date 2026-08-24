/** 长期学习资料：笔记数据迁移，以及不会随字幕缓存过期的概览快照。 */
var BILI_LEARNING_STORE = (() => {
  const SCHEMA_VERSION = 2;
  const META_KEY = "bili_digest_data_meta";
  const NOTES_KEY = "bili_digest_notes";
  const LEARNING_PREFIX = "bili_digest_learning_";

  function defaultStorage() {
    if (typeof chrome !== "undefined" && chrome?.storage?.local) {
      return chrome.storage.local;
    }
    throw new Error("没有可用的存储后端");
  }

  function normalizedPage(page) {
    const value = Math.floor(Number(page));
    return Number.isFinite(value) && value > 0 ? value : 1;
  }

  function learningId(bvid, page = 1) {
    return `${String(bvid || "").trim()}:p${normalizedPage(page)}`;
  }

  function learningKey(bvid, page = 1) {
    return `${LEARNING_PREFIX}${learningId(bvid, page)}`;
  }

  function migrateLegacyNote(note, now) {
    if (!note || typeof note !== "object") return null;
    const page = normalizedPage(note.page);
    const createdAt = Number(note.createdAt) || now;
    return {
      ...note,
      page,
      createdAt,
      updatedAt: Number(note.updatedAt) || createdAt,
      ...(note.bvid ? { learningId: learningId(note.bvid, page) } : {}),
      revision: Math.max(1, Math.floor(Number(note.revision) || 1)),
      contentSource: ["raw", "ai", "user", "legacy"].includes(note.contentSource)
        ? note.contentSource
        : "legacy",
    };
  }

  async function ensureMigrated({ storage = defaultStorage(), now = Date.now() } = {}) {
    // 先只读版本标记。迁移只在升级那一次真正要做事，之后每次 service worker
    // 启动都会走到这里；若为此把整个 storage（含全部字幕缓存）读出来反序列化，
    // 就是纯粹的启动开销，缓存越多越慢，也越容易在读完之前被浏览器回收。
    const metaOnly = (await storage.get(META_KEY)) || {};
    if (Number(metaOnly[META_KEY]?.schemaVersion) >= SCHEMA_VERSION) {
      return { migrated: false, schemaVersion: SCHEMA_VERSION };
    }

    const all = (await storage.get(null)) || {};

    const notes = Array.isArray(all[NOTES_KEY])
      ? all[NOTES_KEY]
          .map((note) => migrateLegacyNote(note, now))
          .filter(Boolean)
      : [];

    const migratedRecords = {};
    for (const [key, cached] of Object.entries(all)) {
      const match = /^digest_(BV[0-9A-Za-z]+?)(?:_p(\d+))?$/.exec(key);
      if (!match || !cached?.analysis) continue;
      const [, bvid, rawPage] = match;
      const page = normalizedPage(rawPage);
      const targetKey = learningKey(bvid, page);
      if (all[targetKey]) continue;
      migratedRecords[targetKey] = {
        schemaVersion: SCHEMA_VERSION,
        learningId: learningId(bvid, page),
        bvid,
        page,
        videoTitle: String(cached.videoInfo?.title || "").slice(0, 500),
        ownerName: String(cached.videoInfo?.owner || "").slice(0, 300),
        analysis: cached.analysis,
        updatedAt: Number(cached.timestamp) || now,
      };
    }

    await storage.set({
      [NOTES_KEY]: notes,
      [META_KEY]: { schemaVersion: SCHEMA_VERSION, migratedAt: now },
      ...migratedRecords,
    });
    return { migrated: true, schemaVersion: SCHEMA_VERSION };
  }

  async function saveLearningRecord(
    { bvid, page = 1, videoTitle = "", ownerName = "", analysis, analysisFailures },
    { storage = defaultStorage(), now = Date.now() } = {},
  ) {
    const normalizedBvid = String(bvid || "").trim();
    if (!normalizedBvid) throw new Error("概览缺少 BV 号");
    const pageNumber = normalizedPage(page);
    const failures = normalizeAnalysisFailures(analysisFailures);
    const record = {
      schemaVersion: SCHEMA_VERSION,
      learningId: learningId(normalizedBvid, pageNumber),
      bvid: normalizedBvid,
      page: pageNumber,
      videoTitle: String(videoTitle || "").slice(0, 500),
      ownerName: String(ownerName || "").slice(0, 300),
      analysis,
      updatedAt: now,
      ...(failures.length ? { analysisFailures: failures } : {}),
    };
    await storage.set({ [learningKey(normalizedBvid, pageNumber)]: record });
    return record;
  }

  function normalizeAnalysisFailures(value) {
    if (!Array.isArray(value)) return [];
    return value
      .map((item) => {
        const startSeconds = Math.max(0, Math.floor(Number(item?.startSeconds) || 0));
        const endSeconds = Math.max(
          startSeconds,
          Math.floor(Number(item?.endSeconds) || startSeconds),
        );
        return {
          index: Math.max(0, Math.floor(Number(item?.index) || 0)),
          startSeconds,
          endSeconds,
        };
      })
      .filter((item) => Number.isFinite(item.startSeconds));
  }

  async function loadLearningRecord(
    bvid,
    page = 1,
    { storage = defaultStorage() } = {},
  ) {
    const key = learningKey(bvid, page);
    const stored = await storage.get(key);
    const record = stored?.[key];
    return record && typeof record === "object" ? record : null;
  }

  function pageUrl(note) {
    const bvid = String(note?.bvid || "").trim();
    if (/^BV[0-9A-Za-z]{10}$/.test(bvid)) {
      const url = new URL(`https://www.bilibili.com/video/${bvid}`);
      const page = normalizedPage(note?.page);
      if (page > 1) url.searchParams.set("p", String(page));
      return url.toString();
    }
    const raw = String(note?.timestampedUrl || "").trim();
    if (!raw) return "";
    try {
      const url = new URL(raw);
      url.searchParams.delete("t");
      return url.toString();
    } catch (error) {
      return raw;
    }
  }

  function noteStamp(note) {
    const stamp = String(note?.timestamp || "").trim();
    if (stamp) return stamp;
    const seconds = Math.max(0, Math.floor(Number(note?.timestampSeconds) || 0));
    const minutes = Math.floor(seconds / 60);
    const rest = String(seconds % 60).padStart(2, "0");
    return `${minutes}:${rest}`;
  }

  function noteLink(note) {
    const stamp = noteStamp(note);
    const href = String(note?.timestampedUrl || "").trim();
    return href ? `[${stamp}](${href})` : stamp;
  }

  // 列表项里的换行必须缩进，否则后续行会跳出列表，把文档结构打乱。
  function noteBody(note) {
    return String(note?.text || "")
      .replace(/\r\n/g, "\n")
      .trim()
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n  ");
  }

  function formatGroup(notes) {
    const first = notes[0] || {};
    const title = String(first.videoTitle || first.bvid || "未命名视频")
      .replace(/\s+/g, " ")
      .trim();
    const owner = String(first.ownerName || "").trim();
    const page = normalizedPage(first.page);
    const url = pageUrl(first);
    const lines = [`# ${title}`, ""];
    const meta = [owner, page > 1 ? `P${page}` : ""].filter(Boolean).join(" · ");
    if (meta) lines.push(meta);
    if (url) lines.push(url);
    if (meta || url) lines.push("");

    const ordered = [...notes].sort(
      (left, right) =>
        (Number(left.timestampSeconds) || 0) - (Number(right.timestampSeconds) || 0),
    );
    for (const note of ordered) lines.push(formatNoteItem(note));
    return `${lines.join("\n").trimEnd()}\n`;
  }

  function formatNoteItem(note) {
    const body = noteBody(note);
    return body ? `- ${noteLink(note)} ${body}` : `- ${noteLink(note)}`;
  }

  function formatStamp(seconds, fallback) {
    const stamp = String(fallback || "").trim();
    if (stamp) return stamp;
    const value = Math.max(0, Math.floor(Number(seconds) || 0));
    return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
  }

  function videoHref(bvid, page, seconds) {
    const id = String(bvid || "").trim();
    if (!/^BV[0-9A-Za-z]{10}$/.test(id)) return "";
    const url = new URL(`https://www.bilibili.com/video/${id}`);
    const pageNumber = normalizedPage(page);
    if (pageNumber > 1) url.searchParams.set("p", String(pageNumber));
    const start = Math.max(0, Math.floor(Number(seconds) || 0));
    if (start > 0) url.searchParams.set("t", String(start));
    return url.toString();
  }

  function mdLink(label, href) {
    return href ? `[${label}](${href})` : label;
  }

  function yamlScalar(value) {
    const text = String(value ?? "");
    if (text === "") return '""';
    if (
      /[\n\r:#{}[\],&*?!<>=%@`|]/.test(text) ||
      text !== text.trim() ||
      /^(true|false|null|~|\d+(\.\d+)?)$/i.test(text) ||
      text.includes('"') ||
      text.includes("'")
    ) {
      return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    }
    return text;
  }

  function isoDate(value) {
    const date = value instanceof Date ? value : new Date(value || Date.now());
    if (Number.isNaN(date.getTime())) return "";
    return date.toISOString().slice(0, 10);
  }

  // 与概览界面同一套归属：金句落到最后一个 start <= 自己的章节；章前的算 orphan。
  function groupQuotesIntoChapters(chapters, quotes) {
    const chapterList = (Array.isArray(chapters) ? chapters : []).filter((chapter) =>
      Number.isFinite(Number(chapter?.timestampSeconds)),
    );
    const quoteList = (Array.isArray(quotes) ? quotes : []).filter((quote) =>
      Number.isFinite(Number(quote?.timestampSeconds)),
    );
    const grouped = chapterList.map((chapter) => ({ chapter, quotes: [] }));
    const orphans = [];
    for (const quote of quoteList) {
      const seconds = Number(quote.timestampSeconds);
      let owner = -1;
      for (let i = 0; i < chapterList.length; i += 1) {
        if (Number(chapterList[i].timestampSeconds) <= seconds) owner = i;
        else break;
      }
      if (owner >= 0) grouped[owner].quotes.push(quote);
      else orphans.push(quote);
    }
    return { grouped, orphans };
  }

  function formatTranscriptLines(transcript, bvid, page) {
    if (!transcript || !Array.isArray(transcript.segments) || !transcript.segments.length) {
      return [];
    }
    const mode = transcript.mode === "bilingual" || transcript.mode === "translated"
      ? transcript.mode
      : "original";
    return transcript.segments.map((segment) => {
      const stamp = formatStamp(segment.start, segment.timestamp);
      const href = videoHref(bvid, page, segment.start);
      const link = mdLink(stamp, href);
      if (mode === "bilingual") {
        const source = String(segment.source || segment.display || "").trim();
        const translation = String(segment.translation || "").trim();
        const head = source ? `- ${link} ${source}` : `- ${link}`;
        return translation ? `${head}\n  ${translation}` : head;
      }
      const text = String(
        mode === "translated"
          ? segment.translation || segment.display || ""
          : segment.display || segment.source || "",
      ).trim();
      return text ? `- ${link} ${text}` : `- ${link}`;
    });
  }

  /**
   * 当前视频的学习稿：YAML + 章节（金句挂在章下）+ 笔记 + 可选字幕。
   * 缺的部分整节省略；aiDraft 不进稿。没有正文时返回空串。
   */
  function learningAsMarkdown({
    title = "",
    author = "",
    bvid = "",
    page = 1,
    exportedAt,
    analysis,
    notes,
    transcript,
  } = {}) {
    const pageNumber = normalizedPage(page);
    const chapters = Array.isArray(analysis?.chapters) ? analysis.chapters : [];
    const quotes = Array.isArray(analysis?.keyQuotes) ? analysis.keyQuotes : [];
    const noteList = Array.isArray(notes)
      ? notes.filter((note) => note && typeof note === "object")
      : [];
    const transcriptLines = formatTranscriptLines(transcript, bvid, pageNumber);
    if (!chapters.length && !quotes.length && !noteList.length && !transcriptLines.length) {
      return "";
    }

    const url = videoHref(bvid, pageNumber, 0) || pageUrl({ bvid, page: pageNumber });
    const { grouped, orphans } = groupQuotesIntoChapters(chapters, quotes);
    const lines = [
      "---",
      `title: ${yamlScalar(title || bvid || "未命名视频")}`,
      `bvid: ${yamlScalar(bvid)}`,
      `page: ${pageNumber}`,
      `author: ${yamlScalar(author)}`,
      `url: ${yamlScalar(url)}`,
      `created_at: ${yamlScalar(isoDate(exportedAt))}`,
      "tags:",
      "  - bilibili-digest",
      "---",
      "",
    ];

    if (grouped.length) {
      lines.push("## 视频概览", "");
      for (const { chapter } of grouped) {
        const stamp = formatStamp(chapter.timestampSeconds, chapter.timestamp);
        const href = videoHref(bvid, pageNumber, chapter.timestampSeconds);
        const heading = String(chapter.title || "").trim() || stamp;
        lines.push(`- ${mdLink(stamp, href)} ${heading}`);
      }
      lines.push("");
      lines.push("## 章节", "");
      for (const { chapter, quotes: nested } of grouped) {
        const stamp = formatStamp(chapter.timestampSeconds, chapter.timestamp);
        const href = videoHref(bvid, pageNumber, chapter.timestampSeconds);
        const heading = String(chapter.title || "").trim() || stamp;
        lines.push(`### ${mdLink(stamp, href)} ${heading}`, "");
        const summary = String(chapter.summary || "").trim();
        if (summary) lines.push(summary, "");
        for (const quote of nested) {
          const quoteStamp = formatStamp(quote.timestampSeconds, quote.timestamp);
          const quoteHref = videoHref(bvid, pageNumber, quote.timestampSeconds);
          const quoteText = String(quote.quote || "").trim();
          lines.push(
            quoteText
              ? `> ${mdLink(quoteStamp, quoteHref)} ${quoteText}`
              : `> ${mdLink(quoteStamp, quoteHref)}`,
          );
          lines.push("");
        }
      }
    }

    const looseQuotes = grouped.length ? orphans : quotes;
    if (looseQuotes.length) {
      lines.push("## 金句", "");
      for (const quote of looseQuotes) {
        const stamp = formatStamp(quote.timestampSeconds, quote.timestamp);
        const href = videoHref(bvid, pageNumber, quote.timestampSeconds);
        const text = String(quote.quote || "").trim();
        lines.push(text ? `- ${mdLink(stamp, href)} ${text}` : `- ${mdLink(stamp, href)}`);
      }
      lines.push("");
    }

    if (noteList.length) {
      lines.push("## 我的时间戳笔记", "");
      const ordered = [...noteList].sort(
        (left, right) =>
          (Number(left.timestampSeconds) || 0) - (Number(right.timestampSeconds) || 0),
      );
      for (const note of ordered) lines.push(formatNoteItem(note));
      lines.push("");
    }

    if (transcriptLines.length) {
      lines.push("## 完整字幕", "");
      lines.push(...transcriptLines);
      lines.push("");
    }

    return `${lines.join("\n").trimEnd()}\n`;
  }

  /**
   * 把当前列表编成 Markdown。grouped 为 false 时当成同一视频/分 P；
   * 为 true 时按 learningId 分组，组内按时间戳升序，组之间按最新笔记倒序。
   * 只读已保存正文，忽略 aiDraft。
   */
  function notesAsMarkdown(notes, { grouped = false } = {}) {
    const list = Array.isArray(notes)
      ? notes.filter((note) => note && typeof note === "object")
      : [];
    if (!list.length) return "";
    if (!grouped) return formatGroup(list);

    const groups = new Map();
    for (const note of list) {
      const key = note.learningId || learningId(note.bvid, note.page);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(note);
    }
    const orderedGroups = [...groups.values()].sort((left, right) => {
      const latest = (group) =>
        Math.max(...group.map((note) => Number(note.createdAt) || 0));
      return latest(right) - latest(left);
    });
    return orderedGroups.map(formatGroup).join("\n");
  }

  const BACKUP_KIND = "bilibili-digest-backup";

  function filterNotes(notes, query) {
    const list = Array.isArray(notes)
      ? notes.filter((note) => note && typeof note === "object")
      : [];
    const needle = String(query || "").trim().toLowerCase();
    if (!needle) return list;
    return list.filter((note) => {
      const hay = [note.text, note.videoTitle, note.ownerName, note.timestamp, note.bvid]
        .map((value) => String(value || "").toLowerCase())
        .join("\n");
      return hay.includes(needle);
    });
  }

  function collectLearningRecords(all) {
    const records = [];
    for (const [key, value] of Object.entries(all || {})) {
      if (!key.startsWith(LEARNING_PREFIX) || !value || typeof value !== "object") continue;
      records.push(value);
    }
    return records;
  }

  function cloneNoteForBackup(note) {
    if (!note || typeof note !== "object") return null;
    const { aiDraft, pending, ...rest } = note;
    return rest;
  }

  function isoDateTime(value) {
    const date = value instanceof Date ? value : new Date(value || Date.now());
    if (Number.isNaN(date.getTime())) return "";
    return date.toISOString();
  }

  function buildBackup({ notes, learning, exportedAt } = {}) {
    return {
      kind: BACKUP_KIND,
      schemaVersion: SCHEMA_VERSION,
      exportedAt: isoDateTime(exportedAt),
      notes: (Array.isArray(notes) ? notes : []).map(cloneNoteForBackup).filter(Boolean),
      learning: (Array.isArray(learning) ? learning : []).filter(
        (record) => record && typeof record === "object",
      ),
    };
  }

  function parseBackup(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return {
        ok: false,
        error: "INVALID_BACKUP",
        message: "这不是一份有效的学习资料备份。",
      };
    }
    if (payload.kind !== BACKUP_KIND) {
      return {
        ok: false,
        error: "INVALID_BACKUP",
        message: "这不是 Digest for Bilibili 的备份文件。",
      };
    }
    if (Number(payload.schemaVersion) > SCHEMA_VERSION) {
      return {
        ok: false,
        error: "BACKUP_TOO_NEW",
        message: "这份备份来自更新的版本，请先升级扩展。",
      };
    }
    if (!Array.isArray(payload.notes)) {
      return {
        ok: false,
        error: "INVALID_BACKUP",
        message: "备份里缺少笔记列表。",
      };
    }
    if (payload.learning != null && !Array.isArray(payload.learning)) {
      return {
        ok: false,
        error: "INVALID_BACKUP",
        message: "备份里的概览格式不正确。",
      };
    }
    return { ok: true, backup: payload };
  }

  function newerRecord(incoming, current) {
    if (!current) return true;
    return (Number(incoming?.updatedAt) || 0) >= (Number(current?.updatedAt) || 0);
  }

  function mergeBackup(existingNotes, existingLearning, backup) {
    const notesById = new Map();
    for (const note of Array.isArray(existingNotes) ? existingNotes : []) {
      if (note?.id) notesById.set(note.id, note);
    }
    let notesAdded = 0;
    let notesUpdated = 0;
    for (const raw of backup?.notes || []) {
      const note = cloneNoteForBackup(raw);
      if (!note?.id) continue;
      const current = notesById.get(note.id);
      if (!current) {
        notesById.set(note.id, note);
        notesAdded += 1;
      } else if (newerRecord(note, current)) {
        notesById.set(note.id, { ...current, ...note });
        notesUpdated += 1;
      }
    }

    const learningById = new Map();
    for (const record of Array.isArray(existingLearning) ? existingLearning : []) {
      const id = record?.learningId || learningId(record?.bvid, record?.page);
      if (id) learningById.set(id, record);
    }
    let learningAdded = 0;
    let learningUpdated = 0;
    for (const record of Array.isArray(backup?.learning) ? backup.learning : []) {
      if (!record || typeof record !== "object") continue;
      const id = record.learningId || learningId(record.bvid, record.page);
      if (!id) continue;
      const current = learningById.get(id);
      if (!current) {
        learningById.set(id, record);
        learningAdded += 1;
      } else if (newerRecord(record, current)) {
        learningById.set(id, { ...current, ...record });
        learningUpdated += 1;
      }
    }

    return {
      notes: [...notesById.values()],
      learning: [...learningById.values()],
      notesAdded,
      notesUpdated,
      learningAdded,
      learningUpdated,
    };
  }

  return {
    SCHEMA_VERSION,
    META_KEY,
    NOTES_KEY,
    LEARNING_PREFIX,
    learningId,
    learningKey,
    ensureMigrated,
    saveLearningRecord,
    loadLearningRecord,
    notesAsMarkdown,
    learningAsMarkdown,
    filterNotes,
    collectLearningRecords,
    buildBackup,
    parseBackup,
    mergeBackup,
    BACKUP_KIND,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = BILI_LEARNING_STORE;
}
