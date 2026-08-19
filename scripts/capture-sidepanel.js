#!/usr/bin/env node
/**
 * 用 Playwright 截当前仓库里的侧边栏源码，不含浏览器外壳。
 * 走本地 HTTP、禁止缓存，所以每次都是磁盘上这一版 HTML/CSS/JS，
 * 不依赖 Chrome 里有没有点「重新加载」。
 *
 *   npm install --no-save playwright
 *   npx playwright install chromium
 *   node scripts/capture-sidepanel.js
 *
 * 输出：imgs/transcript.png、overview.png、explain.png、notes.png、notes-refine.png
 */
"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "imgs");
const PANEL_WIDTH = 440;
const DEVICE_SCALE = 3;
const BVID = "BV1L3arnN01A";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

const SEGMENTS = [
  {
    id: "s1",
    start: 8,
    text: "今天把一堂课拆成三步：先抓住结构，再核对概念，最后用自己的话写下来。",
  },
  {
    id: "s2",
    start: 32,
    text: "结构就是章节。视频在讲什么、先讲什么、后讲什么，心里要有一张地图。",
  },
  {
    id: "s3",
    start: 61,
    text: "概念要对齐。听到一个术语，先问它在这一分钟里到底指什么，不要急着往下记。",
  },
  {
    id: "s4",
    start: 94,
    text: "间隔重复不是把同一句话抄三遍，而是隔一会儿再用自己的话复述一次。",
  },
  {
    id: "s5",
    start: 128,
    text: "写下来的时候带上时间戳。过几天回看，可以直接跳到当时那一段。",
  },
  {
    id: "s6",
    start: 156,
    text: "金句适合收藏，但不该替代结构。没有章节，金句只是散落的句子。",
  },
  {
    id: "s7",
    start: 188,
    text: "最后检查一遍：这堂课我能用三句话讲给别人听吗？能，才算听懂了。",
  },
];

const TRANSLATED = {
  s1: "Today we break a lecture into three steps: structure, concepts, then write it in your own words.",
  s2: "Structure means chapters. Know what the video covers, and in what order.",
  s3: "Align the concepts. When a term appears, ask what it means in this minute.",
  s4: "Spaced repetition is not copying the same sentence three times.",
  s5: "Write it down with a timestamp so you can jump back days later.",
  s6: "Key quotes are worth saving, but they do not replace structure.",
  s7: "A final check: can you explain this lecture in three sentences?",
};

const POLISHED = Object.fromEntries(SEGMENTS.map((segment) => [segment.id, segment.text]));

const ANALYSIS = {
  chapters: [
    {
      timestamp: "0:08",
      timestampSeconds: 8,
      title: "把一堂课拆成三步",
      summary: "先抓住结构，再核对概念，最后用自己的话写下带时间戳的笔记。",
    },
    {
      timestamp: "1:01",
      timestampSeconds: 61,
      title: "概念要对齐",
      summary: "术语出现时先问它在这一分钟里指什么，再用间隔重复把它留下来。",
    },
    {
      timestamp: "2:08",
      timestampSeconds: 128,
      title: "笔记要能跳回去",
      summary: "金句挂在章节下面；没有结构，收藏只是散落的句子。",
    },
  ],
  keyQuotes: [
    {
      timestamp: "0:32",
      timestampSeconds: 32,
      quote: "心里要有一张地图。",
    },
    {
      timestamp: "1:34",
      timestampSeconds: 94,
      quote: "间隔重复不是把同一句话抄三遍。",
    },
    {
      timestamp: "2:36",
      timestampSeconds: 156,
      quote: "没有章节，金句只是散落的句子。",
    },
  ],
};

const NOTES = [
  {
    id: "note_1",
    bvid: BVID,
    page: 1,
    timestamp: "0:32",
    timestampSeconds: 32,
    timestampedUrl: `https://www.bilibili.com/video/${BVID}?t=32`,
    text: "先画出章节地图，再往里面挂概念和金句。",
    videoTitle: "如何把一堂课真正听懂",
    ownerName: "学习方法实验室",
    createdAt: 1,
  },
  {
    id: "note_2",
    bvid: BVID,
    page: 1,
    timestamp: "1:34",
    timestampSeconds: 94,
    timestampedUrl: `https://www.bilibili.com/video/${BVID}?t=94`,
    text: "间隔重复：隔一会儿用自己的话复述，不要当场连抄三遍。",
    videoTitle: "如何把一堂课真正听懂",
    ownerName: "学习方法实验室",
    createdAt: 2,
    aiDraft: {
      text: "间隔重复的关键不是当场连抄，而是隔一段时间再用自己的话复述一次。隔得越开、越要说给人听，印象才越牢。",
      basedOnRevision: 1,
      conflict: false,
      createdAt: 3,
    },
  },
  {
    id: "note_3",
    bvid: BVID,
    page: 1,
    timestamp: "2:36",
    timestampSeconds: 156,
    timestampedUrl: `https://www.bilibili.com/video/${BVID}?t=156`,
    text: "金句可以收藏，但必须挂在所属章节下面，否则回看时找不到上下文。",
    videoTitle: "如何把一堂课真正听懂",
    ownerName: "学习方法实验室",
    createdAt: 3,
  },
];

const FIXTURE = {
  bvid: BVID,
  url: `https://www.bilibili.com/video/${BVID}`,
  transcript: {
    success: true,
    fromCache: false,
    language: "zh-CN",
    languageLabel: "中文（自动生成）",
    isAiSubtitle: true,
    videoInfo: {
      title: "如何把一堂课真正听懂",
      owner: "学习方法实验室",
    },
    segments: SEGMENTS,
    polished: POLISHED,
    translated: TRANSLATED,
    analysis: ANALYSIS,
  },
  notes: NOTES,
};

const SHOTS = [
  "transcript.png",
  "overview.png",
  "explain.png",
  "notes.png",
  "notes-refine.png",
];
const LEGACY_SHOTS = ["字幕.png", "概览.png", "解释.png", "笔记.png"];

function startStaticServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      let rel = decodeURIComponent(url.pathname);
      if (rel === "/") rel = "/sidepanel.html";
      const file = path.normalize(path.join(ROOT, rel));
      if (!file.startsWith(ROOT + path.sep) && file !== ROOT) {
        res.writeHead(403).end();
        return;
      }
      fs.readFile(file, (error, data) => {
        if (error) {
          console.error("static 404", rel);
          res.writeHead(404).end("not found");
          return;
        }
        res.writeHead(200, {
          "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
          "Cache-Control": "no-store, no-cache, must-revalidate",
        });
        res.end(data);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
    server.on("error", reject);
  });
}

async function loadPlaywright() {
  try {
    return require("playwright");
  } catch (error) {
    console.error("需要 Playwright。请先执行：");
    console.error("  npm install --no-save playwright && npx playwright install chromium");
    process.exit(1);
  }
}

async function launchBrowser(chromium) {
  // 用 Playwright 自带的 Chromium，避免系统 Chrome 带扩展/策略干扰注入脚本。
  return chromium.launch({ headless: true });
}

async function freezePlayback(page) {
  await page.evaluate(() => {
    document.querySelectorAll(".segment.active").forEach((row) => {
      row.classList.remove("active");
    });
    document.querySelector(".content")?.scrollTo(0, 0);
  });
}

async function fitPanel(page) {
  await page.setViewportSize({ width: PANEL_WIDTH, height: 1100 });
  await page.evaluate(() => document.querySelector(".content")?.scrollTo(0, 0));
  const height = await page.evaluate(() => {
    const header = document.querySelector(".app-header");
    const content = document.querySelector(".content");
    return Math.ceil((header?.offsetHeight || 0) + (content?.scrollHeight || 0) + 16);
  });
  await page.setViewportSize({
    width: PANEL_WIDTH,
    height: Math.min(Math.max(height, 880), 2200),
  });
  await page.evaluate(() => document.querySelector(".content")?.scrollTo(0, 0));
}

async function shot(page, name) {
  await page.screenshot({
    path: path.join(OUT, name),
    type: "png",
    animations: "disabled",
    scale: "device",
    caret: "hide",
  });
}

async function setDraftsVisible(page, visible) {
  await page.evaluate((show) => {
    document.querySelectorAll(".note-ai-draft").forEach((el) => {
      const hasText = Boolean(el.querySelector(".note-ai-draft-text")?.textContent?.trim());
      el.hidden = !show || !hasText;
    });
  }, visible);
}

async function showNoteRefine(page) {
  const draftText =
    "间隔重复的关键不是当场连抄，而是隔一段时间再用自己的话复述一次。隔得越开、越要说给人听，印象才越牢。";
  await page.evaluate((text) => {
    const cards = [...document.querySelectorAll("#notesList .note")];
    const card = cards.find((el) => el.textContent.includes("间隔重复")) || cards[1];
    const draft = card?.querySelector(".note-ai-draft");
    const body = draft?.querySelector(".note-ai-draft-text");
    if (!draft || !body) return;
    if (!body.textContent.trim()) body.textContent = text;
    draft.hidden = false;
  }, draftText);
}

async function showExplain(page) {
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll("#transcriptList .segment")];
    rows.forEach((row) => row.classList.remove("active"));
    const target = rows.find((row) => row.textContent.includes("间隔重复")) || rows[3];
    target?.classList.add("active");
    const host =
      target?.querySelector(".segment-source") ||
      target?.querySelector(".segment-text") ||
      target;
    const popover = document.getElementById("explainPopover");
    document.getElementById("explainTerm").textContent = "间隔重复";
    document.getElementById("explainBody").textContent =
      "间隔重复是把同一条知识隔开一段时间再回忆，而不是当场连抄几遍。隔得越开、越要用自己的话说出来，印象越牢。";
    popover.hidden = false;
    popover.dataset.placement = "bottom";
    const rect = host.getBoundingClientRect();
    const width = popover.offsetWidth;
    popover.style.left = `${Math.min(
      Math.max(8, rect.left + rect.width / 2 - width / 2),
      window.innerWidth - width - 8,
    )}px`;
    popover.style.top = `${rect.bottom + 10}px`;
    popover.style.setProperty("--arrow-x", "50%");
  });
}

async function main() {
  const { chromium } = await loadPlaywright();
  const { server, port } = await startStaticServer();
  const browser = await launchBrowser(chromium);
  const page = await browser.newPage({
    viewport: { width: PANEL_WIDTH, height: 1100 },
    deviceScaleFactor: DEVICE_SCALE,
    colorScheme: "light",
  });

  await page.addInitScript((fixture) => {
    const empty = { addListener() {} };
    globalThis.chrome = {
      windows: { getCurrent: async () => ({ id: 1 }) },
      tabs: {
        query: async () => [{ id: 1, url: fixture.url }],
        sendMessage: async (_tabId, message) => {
          if (message?.action === "getPlaybackTime") return null;
          return {};
        },
        create: async () => ({ id: 2 }),
        onActivated: empty,
        onUpdated: empty,
      },
      runtime: {
        id: "digest-screenshot",
        lastError: undefined,
        getURL: (file) => file,
        async sendMessage(message) {
          if (message?.action === "fetchTranscript") return fixture.transcript;
          if (message?.action === "getNotes") return { success: true, notes: fixture.notes };
          if (message?.action === "checkVideoAvailable") return { available: true };
          if (message?.action === "explainSelection") {
            return {
              success: true,
              explanation:
                "间隔重复是把同一条知识隔开一段时间再回忆，而不是当场连抄几遍。隔得越开、越要用自己的话说出来，印象越牢。",
            };
          }
          return { success: true };
        },
        onMessage: empty,
        openOptionsPage() {},
      },
      storage: { local: { get: async () => ({}) } },
    };
  }, FIXTURE);

  page.on("pageerror", (error) => console.error("pageerror:", error.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") console.error("console:", msg.text());
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`http://127.0.0.1:${port}/sidepanel.html?shot=${Date.now()}`, {
    waitUntil: "load",
  });
  await page.addStyleTag({
    content: `
      *, *::before, *::after { animation: none !important; transition: none !important; }
      html, body { background: #faf6f7 !important; }
    `,
  });
  try {
    await page.waitForSelector("#transcriptList .segment", { timeout: 15000 });
  } catch (error) {
    const debug = await page.evaluate(() => ({
      idle: document.getElementById("idleTitle")?.textContent,
      error: document.getElementById("errorText")?.textContent,
      loading: document.getElementById("loadingTitle")?.textContent,
      hidden: {
        idle: document.getElementById("idleState")?.hidden,
        loading: document.getElementById("loadingState")?.hidden,
        error: document.getElementById("errorState")?.hidden,
        transcript: document.getElementById("transcriptPanel")?.hidden,
      },
      chrome: typeof chrome,
      segments: document.querySelectorAll("#transcriptList .segment").length,
    }));
    console.error("侧边栏未进入字幕就绪态：", debug);
    throw error;
  }
  await page.waitForFunction(() => {
    const rows = document.querySelectorAll("#transcriptList .segment");
    return rows.length >= 7 && document.getElementById("transcriptViewLabel")?.textContent === "双语";
  });
  await page.evaluate(() => document.fonts.ready);
  await freezePlayback(page);
  await page.evaluate(() => {
    const first = document.querySelector("#transcriptList .segment");
    first?.classList.add("active");
  });
  await fitPanel(page);
  await shot(page, "transcript.png");

  await page.click('.tab[data-tab="overview"]');
  await page.waitForSelector("#chapterList .chapter");
  await freezePlayback(page);
  await fitPanel(page);
  await shot(page, "overview.png");

  await page.click('.tab[data-tab="transcript"]');
  await page.waitForSelector("#transcriptList .segment");
  await freezePlayback(page);
  await fitPanel(page);
  await showExplain(page);
  await page.waitForTimeout(120);
  await shot(page, "explain.png");

  await page.click('.tab[data-tab="notes"]');
  await page.waitForSelector("#notesList .note");
  await page.evaluate(() => {
    const popover = document.getElementById("explainPopover");
    if (popover) popover.hidden = true;
  });
  await freezePlayback(page);
  await setDraftsVisible(page, false);
  await fitPanel(page);
  await shot(page, "notes.png");

  await showNoteRefine(page);
  await page.waitForSelector(".note-ai-draft:not([hidden]) .note-ai-draft-text");
  await fitPanel(page);
  await shot(page, "notes-refine.png");

  await browser.close();
  server.close();

  for (const name of LEGACY_SHOTS) {
    const file = path.join(OUT, name);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }

  console.log(`已写入 ${SHOTS.map((name) => `imgs/${name}`).join("、")}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
