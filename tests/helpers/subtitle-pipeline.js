// Offline integration harness: only HTTP and persistence are replaced. WBI signing,
// protobuf parsing, track normalization/selection and transcript assembly are real.
// These are synthetic contract fixtures, NOT recordings of the named live videos.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");

const ROOT = path.join(__dirname, "../..");
const CDN = "https://aisubtitle.hdslb.com/bfs/subtitle/";
const track = (lan, file, lan_doc = lan) => ({
  lan, lan_doc, subtitle_url: `${CDN}${file}.json`,
});
const body = (count, label) => ({ body: Array.from({ length: count }, (_, i) => ({
  from: i * 2, to: i * 2 + 1, content: `${label} ${i + 1}`,
})) });
const json = (value, status = 200) => ({
  ok: status === 200, status, json: async () => structuredClone(value),
});

function protobufTracks(tracks) {
  const varint = (value) => {
    const bytes = [];
    do { bytes.push((value & 127) | (value > 127 ? 128 : 0)); value >>>= 7; } while (value);
    return Buffer.from(bytes);
  };
  const field = (id, value) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    return Buffer.concat([varint(id * 8 + 2), varint(bytes.length), bytes]);
  };
  return field(1, Buffer.concat(tracks.map((item) => field(3, Buffer.concat([
    field(3, item.lan), field(4, item.lan_doc), field(5, item.subtitle_url),
  ])))));
}

function createPipeline({ bvid, tracksAt, contentAt, loggedOut = false, viewAt } = {}) {
  const requests = [];
  const rows = new Map();
  const saves = [];
  let lists = 0;
  const fetch = async (input, init) => {
    const url = new URL(input);
    requests.push({ url: String(url), init });
    if (url.pathname === "/x/web-interface/view") {
      assert.equal(url.searchParams.get("bvid"), bvid);
      return json({ code: 0, data: { bvid, aid: 9, cid: 8, title: "Synthetic fixture", owner: { mid: 7 } } });
    }
    if (url.pathname === "/x/web-interface/nav") {
      return json({ code: 0, data: { wbi_img: {
        img_url: "https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png",
        sub_url: "https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png",
      } } });
    }
    if (url.pathname === "/x/player/wbi/v2") {
      assert.match(url.searchParams.get("w_rid"), /^[a-f0-9]{32}$/);
      lists += 1;
      return json({ code: 0, data: { need_login_subtitle: loggedOut,
        subtitle: { subtitles: loggedOut ? [] : tracksAt(lists) },
      } });
    }
    if (url.pathname === "/x/v2/subtitle/web/view") {
      assert.equal(url.searchParams.get("oid"), "8");
      assert.equal(url.searchParams.get("pid"), "9");
      if (viewAt) return viewAt();
      const bytes = protobufTracks(tracksAt(lists));
      return { ok: true, arrayBuffer: async () => Uint8Array.from(bytes).buffer };
    }
    assert.equal(url.origin, "https://aisubtitle.hdslb.com", `Unexpected HTTP request: ${url}`);
    const value = await contentAt(url, lists);
    return typeof value?.json === "function" ? value : json(value);
  };
  const context = vm.createContext({
    fetch, URL, TextEncoder, TextDecoder, Uint8Array, DataView, console,
    BILI_TRANSCRIPT: require("../../lib/transcript.js"),
    BILI_CONCURRENCY: require("../../lib/concurrency.js"),
    BILI_LEARNING_STORE: require("../../lib/learning-store.js"),
  });
  for (const file of ["wbi.js", "bili-api.js", "transcript-service.js"]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, "lib", file), "utf8"), context, { filename: file });
  }
  const service = context.BILI_TRANSCRIPT_SERVICE.createTranscriptService({
    cache: {
      load: async (id, { page }) => structuredClone(rows.get(`${id}:p${page}`) || null),
      save: async (id, data, { page }) => {
        const copy = structuredClone(data);
        rows.set(`${id}:p${page}`, copy);
        saves.push(copy);
      },
    },
    dataReady: async () => {},
    learningRepository: () => ({ find: async () => null }),
    getSettings: async () => ({ subtitleLangPreference: "" }),
  });
  return { service, rows, saves, requests,
    downloads: () => requests.filter(({ url }) => url.startsWith(CDN)),
  };
}

module.exports = { createPipeline, track, body, json, protobufTracks, CDN };
