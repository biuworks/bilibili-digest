const test = require("node:test");
const assert = require("node:assert/strict");

const API = require("../lib/bili-api.js");

const BVID = "BV1GJ411x7h7";

test("从播放页 URL 与裸字符串里解析 BV 号", () => {
  assert.equal(API.parseBvid(`https://www.bilibili.com/video/${BVID}?p=2`), BVID);
  assert.equal(API.parseBvid(BVID), BVID);
  assert.equal(API.parseBvid("https://www.bilibili.com/"), null);
  assert.equal(API.parseBvid(null), null);
});

test("解析分 P 序号，缺省为第 1 P", () => {
  assert.equal(API.parsePageNumber(`https://www.bilibili.com/video/${BVID}?p=3`), 3);
  assert.equal(API.parsePageNumber(`https://www.bilibili.com/video/${BVID}`), 1);
  assert.equal(API.parsePageNumber(`https://www.bilibili.com/video/${BVID}?p=0`), 1);
});

test("时间戳深链使用 B 站的 ?t=秒 形式", () => {
  assert.equal(
    API.canonicalVideoUrl(BVID, 95),
    `https://www.bilibili.com/video/${BVID}?t=95`,
  );
  assert.equal(
    API.canonicalVideoUrl(BVID, 95, 2),
    `https://www.bilibili.com/video/${BVID}?p=2&t=95`,
  );
  assert.equal(
    API.canonicalVideoUrl(BVID, 0),
    `https://www.bilibili.com/video/${BVID}`,
  );
  assert.throws(() => API.canonicalVideoUrl("notabvid", 10), /BV/);
});

test("分 P 视频取对应分 P 的 cid、时长与标题", () => {
  const data = {
    bvid: BVID,
    aid: 12345,
    cid: 111,
    title: "合集总标题",
    desc: "简介",
    duration: 900,
    owner: { name: "某 UP" },
    pages: [
      { page: 1, cid: 111, part: "第一集", duration: 300 },
      { page: 2, cid: 222, part: "第二集", duration: 600 },
    ],
  };

  const first = API.normalizeVideoInfo(data, 1);
  assert.equal(first.cid, 111);
  assert.equal(first.title, "第一集");
  assert.equal(first.duration, 300);
  assert.equal(first.owner, "某 UP");
  assert.equal(first.pageCount, 2);

  const second = API.normalizeVideoInfo(data, 2);
  assert.equal(second.cid, 222);
  assert.equal(second.title, "第二集");
  assert.equal(second.duration, 600);
});

test("单 P 视频用视频标题而非分 P 标题", () => {
  const info = API.normalizeVideoInfo({
    bvid: BVID,
    aid: 1,
    cid: 999,
    title: "视频标题",
    duration: 120,
    pages: [{ page: 1, cid: 999, part: "视频标题", duration: 120 }],
  });
  assert.equal(info.title, "视频标题");
  assert.equal(info.pageCount, 1);
});

test("字幕轨补全协议头并识别 AI 字幕", () => {
  const tracks = API.normalizeSubtitleTracks({
    subtitle: {
      subtitles: [
        {
          id: 1,
          lan: "zh-CN",
          lan_doc: "中文（中国）",
          subtitle_url: "//i0.hdslb.com/bfs/subtitle/abc.json",
        },
        {
          id: 2,
          lan: "ai-zh",
          lan_doc: "中文（自动生成）",
          subtitle_url: "//aisubtitle.hdslb.com/bfs/ai_subtitle/prod/def.json",
          ai_status: 2,
          ai_type: 0,
        },
        { id: 3, lan: "en-US", lan_doc: "英语", subtitle_url: "" },
      ],
    },
  });

  assert.equal(tracks.length, 2, "没有 URL 的轨道应被丢弃");
  assert.equal(tracks[0].url, "https://i0.hdslb.com/bfs/subtitle/abc.json");
  assert.equal(tracks[0].isAi, false);
  assert.equal(tracks[1].isAi, true);
});

test("没有字幕字段时返回空列表而不是抛错", () => {
  assert.deepEqual(API.normalizeSubtitleTracks({}), []);
  assert.deepEqual(API.normalizeSubtitleTracks(null), []);
});

test("选轨顺序：按语言偏好，同语言下人工字幕优先于 AI", () => {
  const tracks = [
    { lang: "en-US", langLabel: "英语", url: "u1", isAi: false },
    { lang: "ai-zh", langLabel: "中文自动", url: "u2", isAi: true },
    { lang: "zh-CN", langLabel: "中文", url: "u3", isAi: false },
  ];
  assert.equal(API.pickSubtitleTrack(tracks).lang, "zh-CN");

  const aiOnly = [
    { lang: "ai-zh", langLabel: "中文自动", url: "u2", isAi: true },
    { lang: "en-US", langLabel: "英语", url: "u1", isAi: false },
  ];
  assert.equal(API.pickSubtitleTrack(aiOnly).lang, "ai-zh");

  const sameLang = [
    { lang: "zh-CN", langLabel: "中文", url: "ai", isAi: true },
    { lang: "zh-CN", langLabel: "中文", url: "human", isAi: false },
  ];
  assert.equal(API.pickSubtitleTrack(sameLang).url, "human");

  assert.equal(API.pickSubtitleTrack([]), null);
});

test("自定义语言偏好可以改变选轨结果", () => {
  const tracks = [
    { lang: "zh-CN", langLabel: "中文", url: "zh", isAi: false },
    { lang: "en-US", langLabel: "英语", url: "en", isAi: false },
  ];
  assert.equal(API.pickSubtitleTrack(tracks, ["en-US", "zh-CN"]).url, "en");
});

test("字幕正文转成 {text, start, duration}", () => {
  const entries = API.normalizeSubtitleBody({
    body: [
      { from: 0, to: 2.5, content: "第一句" },
      { from: 2.5, to: 5, content: "  第二句  " },
      { from: 5, to: 6, content: "   " },
      { from: 6, to: 6, content: "零时长" },
    ],
  });

  assert.equal(entries.length, 3, "空白字幕行应被丢弃");
  assert.deepEqual(entries[0], { text: "第一句", start: 0, duration: 2.5 });
  assert.equal(entries[1].text, "第二句");
  assert.equal(entries[2].duration, 0);
});

test("字幕正文缺失时返回空数组", () => {
  assert.deepEqual(API.normalizeSubtitleBody({}), []);
  assert.deepEqual(API.normalizeSubtitleBody(null), []);
});

test("非零业务码映射成带 code 的错误", async () => {
  const cases = [
    { code: -404, expected: "VIDEO_UNAVAILABLE" },
    { code: -403, expected: "FORBIDDEN" },
    { code: -352, expected: "RISK_CONTROL" },
    { code: -400, expected: "API_ERROR" },
  ];

  for (const { code, expected } of cases) {
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({ code, message: "boom" }),
    });
    await assert.rejects(
      () => API.fetchVideoInfo(BVID, { fetchImpl }),
      (error) => error.code === expected,
      `业务码 ${code} 应映射为 ${expected}`,
    );
  }
});

test("HTTP 失败映射成 HTTP_ERROR", async () => {
  await assert.rejects(
    () => API.fetchVideoInfo(BVID, { fetchImpl: async () => ({ ok: false, status: 500 }) }),
    (error) => error.code === "HTTP_ERROR",
  );
});

test("fetchVideoInfo 带上 cookie 并请求正确的地址", async () => {
  let seenUrl = "";
  let seenInit = null;
  const fetchImpl = async (url, init) => {
    seenUrl = url;
    seenInit = init;
    return {
      ok: true,
      json: async () => ({
        code: 0,
        data: { bvid: BVID, aid: 1, cid: 2, title: "t", duration: 10, pages: [] },
      }),
    };
  };

  const info = await API.fetchVideoInfo(BVID, { fetchImpl });
  assert.match(seenUrl, /x\/web-interface\/view\?bvid=BV1GJ411x7h7$/);
  assert.equal(seenInit.credentials, "include");
  assert.equal(info.cid, 2);
});

test("字幕列表请求带 WBI 签名", async () => {
  const stubWbi = {
    fetchWbiKeys: async () => ({ imgKey: "img", subKey: "sub" }),
    signedUrl: (base, params) =>
      `${base}?cid=${params.cid}&w_rid=stub&wts=1`,
  };
  let seenUrl = "";
  const fetchImpl = async (url) => {
    seenUrl = url;
    return {
      ok: true,
      json: async () => ({
        code: 0,
        data: {
          subtitle: {
            subtitles: [
              { id: 1, lan: "zh-CN", lan_doc: "中文", subtitle_url: "//x/a.json" },
            ],
          },
        },
      }),
    };
  };

  const { tracks, needLogin } = await API.fetchSubtitleTracks(
    { aid: 1, cid: 222, bvid: BVID },
    { fetchImpl, wbi: stubWbi },
  );
  assert.match(seenUrl, /w_rid=stub/);
  assert.equal(tracks[0].url, "https://x/a.json");
  assert.equal(needLogin, false);
});

test("未登录导致字幕不可见时能与「真的没字幕」区分开", async () => {
  // 真实响应形态：code=0、data 完整，但 subtitles 为空且 need_login_subtitle 为真。
  const stubWbi = {
    fetchWbiKeys: async () => ({ imgKey: "img", subKey: "sub" }),
    signedUrl: (base) => base,
  };
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      code: 0,
      data: {
        need_login_subtitle: true,
        subtitle: { allow_submit: false, lan: "", lan_doc: "", subtitles: [] },
      },
    }),
  });

  const { tracks, needLogin } = await API.fetchSubtitleTracks(
    { aid: 1, cid: 2, bvid: BVID },
    { fetchImpl, wbi: stubWbi },
  );
  assert.equal(tracks.length, 0);
  assert.equal(needLogin, true);

  assert.equal(API.subtitleNeedsLogin({ need_login_subtitle: false }), false);
  assert.equal(API.subtitleNeedsLogin({}), false);
});

test("字幕文件下载不携带 cookie", async () => {
  let seenInit = null;
  const fetchImpl = async (url, init) => {
    seenInit = init;
    return { ok: true, json: async () => ({ body: [{ from: 0, to: 1, content: "hi" }] }) };
  };

  const entries = await API.fetchSubtitleTrackContent("https://x/a.json", { fetchImpl });
  assert.equal(seenInit.credentials, "omit");
  assert.equal(entries[0].text, "hi");
});

test("字幕文件下载失败给出可识别的错误码", async () => {
  await assert.rejects(
    () =>
      API.fetchSubtitleTrackContent("https://x/a.json", {
        fetchImpl: async () => ({ ok: false, status: 403 }),
      }),
    (error) => error.code === "SUBTITLE_DOWNLOAD_FAILED",
  );
});
