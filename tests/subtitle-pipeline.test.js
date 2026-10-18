const test = require("node:test");
const assert = require("node:assert/strict");
const { createPipeline, track, body, json, CDN } = require("./helpers/subtitle-pipeline.js");

const TED = "BV1DXKS6rEYq";
const ATOMS = "BV1Gf4y1y7wc";
const bilingual = [track("zh-Hans", "zh"), track("en", "en", "English")];
const downloads = (h) => h.downloads().map(({ url }) => new URL(url).pathname.split("/").pop());

for (const withKnownUrls of [false, true]) {
  test(`BV1DXKS6rEYq 合成契约：中文缓存后首次 English（缓存轨地址=${withKnownUrls}）`, async () => {
    const h = createPipeline({ bvid: TED, tracksAt: () => bilingual,
      contentAt: (url) => body(url.pathname.endsWith("en.json") ? 157 : 2, url.pathname),
    });
    assert.equal((await h.service.fetchTranscript(TED)).language, "zh-Hans");
    if (!withKnownUrls) delete h.rows.get(`${TED}:p1`).availableTracks;
    h.requests.length = 0;
    const result = await h.service.fetchTranscript(TED, { lang: "en" });
    assert.equal(result.success, true, result.message);
    assert.equal(result.language, "en");
    assert.equal(result.transcript.length, 157);
    assert.deepEqual(downloads(h), ["en.json"]);
    assert.equal(h.rows.get(`${TED}:p1`).language, "en");
    const count = h.requests.length;
    assert.equal((await h.service.fetchTranscript(TED, { lang: "en" })).fromCache, true);
    assert.equal(h.requests.length, count);
  });
}

test("指定 English 已消失：严格选轨返回缺轨，不下载中文或覆盖中文缓存", async () => {
  const h = createPipeline({ bvid: TED, tracksAt: () => [bilingual[0]], contentAt: () => body(2, "中文") });
  await h.service.fetchTranscript(TED);
  h.requests.length = 0;
  const result = await h.service.fetchTranscript(TED, { lang: "en" });
  assert.equal(result.error, "SUBTITLE_TRACK_MISSING");
  assert.equal(result.availableTracks.length, 1);
  assert.deepEqual(downloads(h), []);
  assert.equal(h.saves.length, 1);
  assert.equal(h.rows.get(`${TED}:p1`).language, "zh-Hans");
});

test("缓存英文 URL 过期：重新列轨拿新 auth_key，始终不下载中文", async () => {
  const h = createPipeline({ bvid: TED,
    tracksAt: () => [bilingual[0], { ...bilingual[1], subtitle_url: `${CDN}en.json?auth_key=new` }],
    contentAt: (url) => url.searchParams.get("auth_key") === "old" ? json({}, 403) : body(157, "English"),
  });
  h.rows.set(`${TED}:p1`, { language: "zh-Hans", transcript: [{ text: "中文" }],
    videoInfo: { bvid: TED, aid: 9, cid: 8 }, availableTracks: [
      { lang: "en", url: `${CDN}en.json?auth_key=old` },
    ],
  });
  const result = await h.service.fetchTranscript(TED, { lang: "en" });
  assert.equal(result.success, true, result.message);
  assert.equal(result.transcript.length, 157);
  assert.deepEqual(h.downloads().map(({ url }) => new URL(url).searchParams.get("auth_key")), ["old", "new"]);
});

test("首次英文下载失败：刷新列表后第二个签名成功，仅请求英文", async () => {
  const h = createPipeline({ bvid: TED,
    tracksAt: (n) => [bilingual[0], { ...bilingual[1], subtitle_url: `${CDN}en.json?auth_key=${n}` }],
    contentAt: (url) => url.searchParams.get("auth_key") === "1" ? json({}, 403) : body(157, "English"),
  });
  const result = await h.service.fetchTranscript(TED, { lang: "en" });
  assert.equal(result.success, true, result.message);
  assert.equal(result.language, "en");
  assert.deepEqual(downloads(h), ["en.json", "en.json"]);
});

test("英文持续 403 后用户强制重试：不命中中文缓存，不回退中文，恢复后写英文", async () => {
  let blocked = true;
  const h = createPipeline({ bvid: TED, tracksAt: () => bilingual,
    contentAt: (url) => url.pathname.endsWith("en.json")
      ? (blocked ? json({}, 403) : body(157, "English")) : body(2, "中文"),
  });
  await h.service.fetchTranscript(TED);
  h.requests.length = 0;
  const failed = await h.service.fetchTranscript(TED, { lang: "en" });
  assert.equal(failed.error, "SUBTITLE_DOWNLOAD_FAILED");
  assert.equal(failed.availableTracks.length, 2);
  assert.equal(h.saves.length, 1);
  assert.equal(h.rows.get(`${TED}:p1`).language, "zh-Hans");
  blocked = false;
  const retried = await h.service.fetchTranscript(TED, { forceRefresh: true, lang: "en" });
  assert.equal(retried.language, "en");
  assert.equal(retried.transcript.length, 157);
  assert.ok(downloads(h).every((file) => file === "en.json"));
});

test("点名英文空占位：同语种 English 有正文时回退，不下载中文", async () => {
  const h = createPipeline({ bvid: TED, tracksAt: () => [bilingual[0], track("en-US", "empty"), bilingual[1]],
    contentAt: (url) => url.pathname.endsWith("empty.json") ? body(0) : body(157, "English"),
  });
  const result = await h.service.fetchTranscript(TED, { lang: "en-US" });
  assert.equal(result.language, "en");
  assert.equal(result.transcript.length, 157);
  assert.deepEqual(downloads(h), ["empty.json", "en.json"]);
});

test("BV1Gf4y1y7wc 合成契约：未登录 protobuf → 解混淆 → 空简体回退 90 条中文", async () => {
  // Reuses the decoder vector already checked by bili-api.test.js; not a live URL.
  const obfuscated = "//subtitle.bilibili.com/S%13%1BP.%1D%28%29X%2CR%5Ej%1F%25w%0E%02H%5EHO4%14%7B4%08K%40%3C%7B%00M%0B%0A%1AM%1A%19%0BI%2A2%14%3C%7D%0F%19MW%16%069%17?auth_key=test";
  const h = createPipeline({ bvid: ATOMS, loggedOut: true, tracksAt: () => [
    track("zh-Hans", "empty", "中文（简体）"),
    { lan: "zh-CN", lan_doc: "中文（中国）", subtitle_url: obfuscated },
    track("en-US", "empty", "English(US)"), bilingual[1],
  ], contentAt: (url) => body(url.pathname.endsWith("empty.json") ? 0 : 90, "合成正文") });
  const result = await h.service.fetchTranscript(ATOMS);
  assert.equal(result.success, true, result.message);
  assert.equal(result.language, "zh-CN");
  assert.equal(result.transcript.length, 90);
  assert.equal(result.availableTracks.length, 4, "共享空文件的不同语种不能互相吞掉");
  assert.deepEqual(downloads(h), ["empty.json", "abc.json"]);
  assert.ok(h.downloads()[1].url.endsWith("?auth_key=test"));
  for (const { url, init } of h.requests) {
    const isCdn = url.startsWith(CDN);
    assert.equal(init.credentials, isCdn ? "omit" : "include");
    assert.equal(init.cache, isCdn ? "default" : "no-store");
    assert.equal(init.referrer, "https://www.bilibili.com/");
  }
});

for (const loggedOut of [false, true]) {
  test(`两条列表都空时区分 NO_SUBTITLE / NEED_LOGIN（need_login=${loggedOut}）`, async () => {
    const h = createPipeline({ bvid: ATOMS, loggedOut, tracksAt: () => [], contentAt: () => assert.fail("不能下载") });
    const result = await h.service.fetchTranscript(ATOMS);
    assert.equal(result.error, loggedOut ? "NEED_LOGIN" : "NO_SUBTITLE");
    assert.equal(h.saves.length, 0);
    assert.ok(h.requests.some(({ url }) => url.includes("subtitle/web/view")));
  });
}

test("英文轨正文全空：返回 EMPTY_TRANSCRIPT，不能伪装成 NO_SUBTITLE 或中文成功", async () => {
  const h = createPipeline({ bvid: TED, tracksAt: () => bilingual, contentAt: () => body(0) });
  const result = await h.service.fetchTranscript(TED, { lang: "en" });
  assert.equal(result.success, false);
  assert.equal(result.error, "EMPTY_TRANSCRIPT");
  assert.equal(h.saves.length, 0);
  assert.deepEqual(downloads(h), ["en.json", "en.json"]);
});

test("缓存英文地址首次失败且两条列表都空：仍用已知地址重试，不误报没有字幕", async () => {
  let attempts = 0;
  const h = createPipeline({ bvid: TED, loggedOut: true, tracksAt: () => [],
    contentAt: () => ++attempts === 1 ? json({}, 403) : body(157, "English"),
  });
  h.rows.set(`${TED}:p1`, { language: "zh-Hans", transcript: [{ text: "中文" }],
    videoInfo: { bvid: TED, aid: 9, cid: 8 },
    availableTracks: [{ lang: "en", langLabel: "English", url: `${CDN}en.json` }],
  });
  const result = await h.service.fetchTranscript(TED, { lang: "en" });
  assert.equal(result.success, true, result.message);
  assert.equal(result.language, "en");
  assert.deepEqual(downloads(h), ["en.json", "en.json"]);
  assert.ok(h.requests.some(({ url }) => url.includes("subtitle/web/view")));
});

test("未登录回退接口抛错：保留 NEED_LOGIN，不落库", async () => {
  const h = createPipeline({ bvid: ATOMS, loggedOut: true, tracksAt: () => [],
    viewAt: () => { throw new Error("Synthetic network failure"); },
    contentAt: () => assert.fail("不能下载"),
  });
  const result = await h.service.fetchTranscript(ATOMS);
  assert.equal(result.error, "NEED_LOGIN");
  assert.equal(h.saves.length, 0);
});

test("同中文文件不同签名只留简体，独立有正文的地区中文仍保留并可回退", async () => {
  const h = createPipeline({ bvid: ATOMS, tracksAt: () => [
    { ...track("zh-CN", "empty", "中文（中国）"), subtitle_url: `${CDN}empty.json?auth_key=alias` },
    { ...track("zh-Hans", "empty", "中文（简体）"), subtitle_url: `${CDN}empty.json?auth_key=specific` },
    track("zh-CN", "cn", "中文（中国）"),
  ], contentAt: (url) => body(url.pathname.endsWith("empty.json") ? 0 : 90, "合成中文") });
  const result = await h.service.fetchTranscript(ATOMS);
  assert.equal(result.success, true, result.message);
  assert.equal(result.language, "zh-CN");
  assert.equal(result.availableTracks.length, 2);
  assert.equal(result.availableTracks[0].lang, "zh-Hans");
  assert.deepEqual(downloads(h), ["empty.json", "cn.json"]);
});
