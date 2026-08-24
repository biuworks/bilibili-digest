const test = require("node:test");
const assert = require("node:assert/strict");

const STORE = require("../lib/learning-store.js");

function memoryStorage(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(key) {
      if (key === null || key === undefined) return structuredClone(data);
      const keys = Array.isArray(key) ? key : [key];
      const result = {};
      for (const item of keys) {
        if (item in data) result[item] = structuredClone(data[item]);
      }
      return result;
    },
    async set(entries) {
      Object.assign(data, structuredClone(entries));
    },
    async remove(key) {
      for (const item of Array.isArray(key) ? key : [key]) delete data[item];
    },
  };
}

test("旧版裸数组笔记会原地迁移，并补齐可持续迭代的字段", async () => {
  const storage = memoryStorage({
    bili_digest_notes: [
      {
        id: "note_1",
        bvid: "BV1xx411c7mD",
        timestampSeconds: 65,
        text: "旧笔记",
        createdAt: 1000,
      },
    ],
  });

  const result = await STORE.ensureMigrated({ storage, now: 2000 });

  assert.equal(result.migrated, true);
  assert.equal(storage.data[STORE.META_KEY].schemaVersion, STORE.SCHEMA_VERSION);
  assert.deepEqual(storage.data[STORE.NOTES_KEY][0], {
    id: "note_1",
    bvid: "BV1xx411c7mD",
    timestampSeconds: 65,
    text: "旧笔记",
    createdAt: 1000,
    page: 1,
    updatedAt: 1000,
    learningId: "BV1xx411c7mD:p1",
    revision: 1,
    contentSource: "legacy",
  });
});

test("v1 笔记升级到 v2 后具备 revision 与内容来源", async () => {
  const storage = memoryStorage({
    [STORE.META_KEY]: { schemaVersion: 1, migratedAt: 1000 },
    [STORE.NOTES_KEY]: [
      {
        id: "note_v1",
        bvid: "BV1xx411c7mD",
        page: 1,
        text: "用户已有正文",
        rawText: "原始字幕",
        createdAt: 1000,
        updatedAt: 1500,
      },
    ],
  });

  await STORE.ensureMigrated({ storage, now: 2000 });

  assert.equal(STORE.SCHEMA_VERSION, 2);
  assert.equal(storage.data[STORE.META_KEY].schemaVersion, 2);
  assert.equal(storage.data[STORE.NOTES_KEY][0].revision, 1);
  assert.equal(storage.data[STORE.NOTES_KEY][0].contentSource, "legacy");
});

test("迁移可以重复执行，不会改写已迁移数据", async () => {
  const storage = memoryStorage({
    [STORE.META_KEY]: { schemaVersion: STORE.SCHEMA_VERSION, migratedAt: 1000 },
    [STORE.NOTES_KEY]: [{ id: "note_1", text: "已经迁移" }],
  });

  const result = await STORE.ensureMigrated({ storage, now: 9999 });

  assert.equal(result.migrated, false);
  assert.equal(storage.data[STORE.META_KEY].migratedAt, 1000);
  assert.deepEqual(storage.data[STORE.NOTES_KEY], [{ id: "note_1", text: "已经迁移" }]);
});

// 迁移完成后，每次 service worker 启动都会走这条路径。若为此把整个 storage
// 读出来反序列化，缓存越多启动越慢，也越容易在读完前被浏览器回收（`No SW`）。
test("已迁移时只读版本标记，不会全量读取存储", async () => {
  const storage = memoryStorage({
    [STORE.META_KEY]: { schemaVersion: STORE.SCHEMA_VERSION, migratedAt: 1000 },
    [STORE.NOTES_KEY]: [{ id: "note_1", text: "已经迁移" }],
    digest_BV1xx411c7mD_p1: { timestamp: 1000, analysis: { chapters: [] } },
  });
  const requestedKeys = [];
  const original = storage.get.bind(storage);
  storage.get = async (key) => {
    requestedKeys.push(key);
    return original(key);
  };

  const result = await STORE.ensureMigrated({ storage, now: 9999 });

  assert.equal(result.migrated, false);
  assert.deepEqual(requestedKeys, [STORE.META_KEY]);
});

test("尚未迁移时才会全量读取存储", async () => {
  const storage = memoryStorage({
    [STORE.NOTES_KEY]: [{ id: "note_1", bvid: "BV1xx411c7mD", text: "旧笔记" }],
  });
  const requestedKeys = [];
  const original = storage.get.bind(storage);
  storage.get = async (key) => {
    requestedKeys.push(key);
    return original(key);
  };

  const result = await STORE.ensureMigrated({ storage, now: 9999 });

  assert.equal(result.migrated, true);
  assert.deepEqual(requestedKeys, [STORE.META_KEY, null]);
});

test("升级时把旧字幕缓存里的概览转存为长期学习记录", async () => {
  const analysis = { chapters: [{ title: "旧概览" }], keyQuotes: [] };
  const storage = memoryStorage({
    digest_BV1xx411c7mD_p3: {
      timestamp: 1000,
      videoInfo: { title: "分 P 标题", owner: "UP 主" },
      analysis,
    },
  });

  await STORE.ensureMigrated({ storage, now: 2000 });

  assert.deepEqual(storage.data[STORE.learningKey("BV1xx411c7mD", 3)], {
    schemaVersion: STORE.SCHEMA_VERSION,
    learningId: "BV1xx411c7mD:p3",
    bvid: "BV1xx411c7mD",
    page: 3,
    videoTitle: "分 P 标题",
    ownerName: "UP 主",
    analysis,
    updatedAt: 1000,
  });
  assert.ok(storage.data.digest_BV1xx411c7mD_p3, "原缓存仍应保留");
});

test("概览学习记录按 BV 号和分 P 长期保存，互不覆盖", async () => {
  const storage = memoryStorage();
  const analysis = { chapters: [{ title: "第一章" }], keyQuotes: [] };

  await STORE.saveLearningRecord(
    {
      bvid: "BV1xx411c7mD",
      page: 2,
      videoTitle: "视频标题",
      ownerName: "UP 主",
      analysis,
    },
    { storage, now: 3000 },
  );

  assert.equal(await STORE.loadLearningRecord("BV1xx411c7mD", 1, { storage }), null);
  assert.deepEqual(await STORE.loadLearningRecord("BV1xx411c7mD", 2, { storage }), {
    schemaVersion: STORE.SCHEMA_VERSION,
    learningId: "BV1xx411c7mD:p2",
    bvid: "BV1xx411c7mD",
    page: 2,
    videoTitle: "视频标题",
    ownerName: "UP 主",
    analysis,
    updatedAt: 3000,
  });
});

test("概览失败区间会跟着学习记录保存，成功后清掉", async () => {
  const storage = memoryStorage();
  const analysis = { chapters: [{ title: "前半" }], keyQuotes: [] };
  const failures = [{ index: 1, startSeconds: 600, endSeconds: 1170 }];

  const saved = await STORE.saveLearningRecord(
    {
      bvid: "BV1xx411c7mD",
      page: 1,
      videoTitle: "视频标题",
      ownerName: "UP 主",
      analysis,
      analysisFailures: failures,
    },
    { storage, now: 4000 },
  );
  assert.deepEqual(saved.analysisFailures, failures);

  const cleared = await STORE.saveLearningRecord(
    {
      bvid: "BV1xx411c7mD",
      page: 1,
      videoTitle: "视频标题",
      ownerName: "UP 主",
      analysis,
      analysisFailures: [],
    },
    { storage, now: 5000 },
  );
  assert.equal(cleared.analysisFailures, undefined);
});

const NOTE_A = {
  id: "note_a",
  bvid: "BV1xx411c7mD",
  page: 1,
  learningId: "BV1xx411c7mD:p1",
  videoTitle: "第一个视频",
  ownerName: "UP 甲",
  timestamp: "1:05",
  timestampSeconds: 65,
  timestampedUrl: "https://www.bilibili.com/video/BV1xx411c7mD?t=65",
  text: "较早的一条",
  createdAt: 1000,
  aiDraft: { text: "未确认的草稿" },
};

const NOTE_B = {
  id: "note_b",
  bvid: "BV1xx411c7mD",
  page: 1,
  learningId: "BV1xx411c7mD:p1",
  videoTitle: "第一个视频",
  ownerName: "UP 甲",
  timestamp: "0:12",
  timestampSeconds: 12,
  timestampedUrl: "https://www.bilibili.com/video/BV1xx411c7mD?t=12",
  text: "第一行\n第二行",
  createdAt: 1500,
};

const NOTE_C = {
  id: "note_c",
  bvid: "BV1yy411c7mD",
  page: 2,
  learningId: "BV1yy411c7mD:p2",
  videoTitle: "第二个视频",
  ownerName: "UP 乙",
  timestamp: "2:00",
  timestampSeconds: 120,
  timestampedUrl: "https://www.bilibili.com/video/BV1yy411c7mD?p=2&t=120",
  text: "另一部的笔记",
  createdAt: 3000,
};

test("空笔记列表导出为空字符串", () => {
  assert.equal(STORE.notesAsMarkdown([]), "");
  assert.equal(STORE.notesAsMarkdown(null, { grouped: true }), "");
});

test("单视频导出按时间戳升序，且不含 AI 草稿", () => {
  const markdown = STORE.notesAsMarkdown([NOTE_A, NOTE_B]);
  assert.equal(
    markdown,
    [
      "# 第一个视频",
      "",
      "UP 甲",
      "https://www.bilibili.com/video/BV1xx411c7mD",
      "",
      "- [0:12](https://www.bilibili.com/video/BV1xx411c7mD?t=12) 第一行",
      "  第二行",
      "- [1:05](https://www.bilibili.com/video/BV1xx411c7mD?t=65) 较早的一条",
      "",
    ].join("\n"),
  );
  assert.doesNotMatch(markdown, /未确认的草稿/);
});

test("全部分组时组内升序、组之间按最新笔记倒序", () => {
  const markdown = STORE.notesAsMarkdown([NOTE_A, NOTE_B, NOTE_C], {
    grouped: true,
  });
  assert.equal(
    markdown,
    [
      "# 第二个视频",
      "",
      "UP 乙 · P2",
      "https://www.bilibili.com/video/BV1yy411c7mD?p=2",
      "",
      "- [2:00](https://www.bilibili.com/video/BV1yy411c7mD?p=2&t=120) 另一部的笔记",
      "",
      "# 第一个视频",
      "",
      "UP 甲",
      "https://www.bilibili.com/video/BV1xx411c7mD",
      "",
      "- [0:12](https://www.bilibili.com/video/BV1xx411c7mD?t=12) 第一行",
      "  第二行",
      "- [1:05](https://www.bilibili.com/video/BV1xx411c7mD?t=65) 较早的一条",
      "",
    ].join("\n"),
  );
});

test("学习稿没有章节、笔记和字幕时导出为空", () => {
  assert.equal(STORE.learningAsMarkdown({}), "");
  assert.equal(STORE.learningAsMarkdown({ notes: [], analysis: { chapters: [] } }), "");
});

test("学习稿带 YAML、章节内金句、笔记，不含 AI 草稿", () => {
  const markdown = STORE.learningAsMarkdown({
    title: "如何听懂",
    author: "实验室",
    bvid: "BV1xx411c7mD",
    page: 1,
    exportedAt: "2026-08-19T12:00:00.000Z",
    analysis: {
      chapters: [
        {
          timestamp: "0:08",
          timestampSeconds: 8,
          title: "拆成三步",
          summary: "先结构后概念。",
        },
      ],
      keyQuotes: [
        { timestamp: "0:32", timestampSeconds: 32, quote: "心里要有一张地图。" },
      ],
    },
    notes: [
      {
        ...NOTE_A,
        aiDraft: { text: "不该出现" },
      },
    ],
  });

  assert.equal(
    markdown,
    [
      "---",
      "title: 如何听懂",
      "bvid: BV1xx411c7mD",
      "page: 1",
      "author: 实验室",
      'url: "https://www.bilibili.com/video/BV1xx411c7mD"',
      "created_at: 2026-08-19",
      "tags:",
      "  - bilibili-digest",
      "---",
      "",
      "## 视频概览",
      "",
      "- [0:08](https://www.bilibili.com/video/BV1xx411c7mD?t=8) 拆成三步",
      "",
      "## 章节",
      "",
      "### [0:08](https://www.bilibili.com/video/BV1xx411c7mD?t=8) 拆成三步",
      "",
      "先结构后概念。",
      "",
      "> [0:32](https://www.bilibili.com/video/BV1xx411c7mD?t=32) 心里要有一张地图。",
      "",
      "## 我的时间戳笔记",
      "",
      "- [1:05](https://www.bilibili.com/video/BV1xx411c7mD?t=65) 较早的一条",
      "",
    ].join("\n"),
  );
  assert.doesNotMatch(markdown, /不该出现/);
});

test("章前金句单独成节，含字幕时跟当前视图走", () => {
  const markdown = STORE.learningAsMarkdown({
    title: "课: 开场",
    bvid: "BV1yy411c7mD",
    page: 2,
    exportedAt: "2026-08-19T12:00:00.000Z",
    analysis: {
      chapters: [
        {
          timestamp: "1:00",
          timestampSeconds: 60,
          title: "正题",
          summary: "进入正题。",
        },
      ],
      keyQuotes: [
        { timestamp: "0:10", timestampSeconds: 10, quote: "片头语" },
      ],
    },
    transcript: {
      mode: "bilingual",
      segments: [
        {
          start: 8,
          source: "先抓住结构。",
          translation: "Start with structure.",
        },
      ],
    },
  });

  assert.match(markdown, /^title: "课: 开场"$/m);
  assert.match(markdown, /url: "https:\/\/www\.bilibili\.com\/video\/BV1yy411c7mD\?p=2"/);
  assert.match(markdown, /## 金句/);
  assert.match(
    markdown,
    /- \[0:10\]\(https:\/\/www\.bilibili\.com\/video\/BV1yy411c7mD\?p=2&t=10\) 片头语/,
  );
  assert.doesNotMatch(markdown, /## 我的时间戳笔记/);
  assert.match(
    markdown,
    /- \[0:08\]\(https:\/\/www\.bilibili\.com\/video\/BV1yy411c7mD\?p=2&t=8\) 先抓住结构。\n  Start with structure\./,
  );
});

test("笔记搜索匹配正文、标题和 UP 主", () => {
  assert.equal(STORE.filterNotes([NOTE_A, NOTE_C], "另一部").length, 1);
  assert.equal(STORE.filterNotes([NOTE_A, NOTE_C], "UP 乙")[0].id, "note_c");
  assert.equal(STORE.filterNotes([NOTE_A, NOTE_C], "第一个")[0].id, "note_a");
  assert.equal(STORE.filterNotes([NOTE_A], "   ").length, 1);
  assert.equal(STORE.filterNotes([NOTE_A], "没有这个词").length, 0);
});

test("备份不含 AI 草稿，恢复时较新的覆盖、本机多出来的保留", () => {
  const backup = STORE.buildBackup({
    notes: [{ ...NOTE_A, pending: true }],
    learning: [
      {
        learningId: "BV1xx411c7mD:p1",
        bvid: "BV1xx411c7mD",
        page: 1,
        analysis: { chapters: [] },
        updatedAt: 5000,
      },
    ],
    exportedAt: "2026-08-22T00:00:00.000Z",
  });
  assert.equal(backup.kind, STORE.BACKUP_KIND);
  assert.equal(backup.notes[0].aiDraft, undefined);
  assert.equal(backup.notes[0].pending, undefined);
  assert.doesNotMatch(JSON.stringify(backup), /sk-/);

  const parsed = STORE.parseBackup({ foo: 1 });
  assert.equal(parsed.ok, false);

  const tooNew = STORE.parseBackup({ ...backup, schemaVersion: 99 });
  assert.equal(tooNew.error, "BACKUP_TOO_NEW");

  const merged = STORE.mergeBackup(
    [{ id: "note_a", text: "本机较新", updatedAt: 9000 }, { id: "keep_me", text: "留下" }],
    [
      {
        learningId: "BV1xx411c7mD:p1",
        bvid: "BV1xx411c7mD",
        page: 1,
        analysis: { chapters: [{ title: "旧" }] },
        updatedAt: 1000,
      },
    ],
    backup,
  );
  assert.equal(merged.notes.find((note) => note.id === "keep_me").text, "留下");
  assert.equal(merged.notes.find((note) => note.id === "note_a").text, "本机较新");
  assert.equal(merged.learning[0].updatedAt, 5000);
  assert.equal(merged.notesAdded, 0);
  assert.equal(merged.learningUpdated, 1);
});
