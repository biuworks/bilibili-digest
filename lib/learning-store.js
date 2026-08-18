/** 长期学习资料：笔记数据迁移，以及不会随字幕缓存过期的概览快照。 */
var BILI_LEARNING_STORE = (() => {
  const SCHEMA_VERSION = 1;
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
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = BILI_LEARNING_STORE;
}
