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
    const all = (await storage.get(null)) || {};
    const meta = all[META_KEY];
    if (Number(meta?.schemaVersion) >= SCHEMA_VERSION) {
      return { migrated: false, schemaVersion: SCHEMA_VERSION };
    }

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
    { bvid, page = 1, videoTitle = "", ownerName = "", analysis },
    { storage = defaultStorage(), now = Date.now() } = {},
  ) {
    const normalizedBvid = String(bvid || "").trim();
    if (!normalizedBvid) throw new Error("概览缺少 BV 号");
    const pageNumber = normalizedPage(page);
    const record = {
      schemaVersion: SCHEMA_VERSION,
      learningId: learningId(normalizedBvid, pageNumber),
      bvid: normalizedBvid,
      page: pageNumber,
      videoTitle: String(videoTitle || "").slice(0, 500),
      ownerName: String(ownerName || "").slice(0, 300),
      analysis,
      updatedAt: now,
    };
    await storage.set({ [learningKey(normalizedBvid, pageNumber)]: record });
    return record;
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
    for (const note of ordered) {
      const body = noteBody(note);
      lines.push(body ? `- ${noteLink(note)} ${body}` : `- ${noteLink(note)}`);
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
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = BILI_LEARNING_STORE;
}
