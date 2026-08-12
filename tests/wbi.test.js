const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const WBI = require("../lib/wbi.js");

// 官方文档给出的示例向量，见 bilibili-API-collect docs/misc/sign/wbi.md
const IMG_KEY = "7cd084941338484aae1ad9425b84077c";
const SUB_KEY = "4932caff0ff746eab6f01bf08b70ac45";
const MIXIN_KEY = "ea1db124af3c7062474693fa704f4ff8";

test("自带的 MD5 与 node:crypto 结果一致", () => {
  const samples = [
    "",
    "abc",
    "The quick brown fox jumps over the lazy dog",
    "中文字幕测试",
    "a".repeat(55),
    "a".repeat(56),
    "a".repeat(64),
    "邓紫棋".repeat(500),
  ];
  for (const sample of samples) {
    assert.equal(
      WBI.md5(sample),
      crypto.createHash("md5").update(sample, "utf8").digest("hex"),
      `md5 不一致：${sample.slice(0, 20)}`,
    );
  }
});

test("从 wbi_img URL 中提取密钥文件名", () => {
  assert.equal(
    WBI.keyFromImageUrl(
      "https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png",
    ),
    IMG_KEY,
  );
  assert.equal(
    WBI.keyFromImageUrl("//i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png?v=1"),
    SUB_KEY,
  );
  assert.equal(WBI.keyFromImageUrl(""), "");
});

test("mixin_key 推导匹配官方示例", () => {
  assert.equal(WBI.MIXIN_KEY_ENC_TAB.length, 64);
  assert.equal(WBI.getMixinKey(IMG_KEY, SUB_KEY), MIXIN_KEY);
  assert.equal(WBI.getMixinKey(IMG_KEY, SUB_KEY).length, 32);
});

test("密钥长度不足时拒绝推导，而不是产出错误签名", () => {
  assert.throws(() => WBI.getMixinKey("short", "key"), /mixin_key/);
});

test("query 编码使用 encodeURIComponent 语义（大写十六进制 + %20）", () => {
  assert.equal(
    WBI.buildQuery({ foo: "one one four", bar: "五一四", baz: 1919810 }),
    "bar=%E4%BA%94%E4%B8%80%E5%9B%9B&baz=1919810&foo=one%20one%20four",
  );
});

test("query 会先剔除值里的 !'()* 字符", () => {
  assert.equal(WBI.buildQuery({ a: "he!l'l(o)*" }), "a=hello");
});

test("w_rid 匹配官方示例向量", () => {
  const signed = WBI.signParams(
    { foo: "114", bar: "514", zab: 1919810 },
    { imgKey: IMG_KEY, subKey: SUB_KEY },
    1702204169,
  );
  assert.equal(signed.wts, 1702204169);
  assert.equal(signed.w_rid, "8f6f2b5b3d485fe1886cec6a0be8c5d4");
  // 原始参数必须原样保留
  assert.equal(signed.foo, "114");
  assert.equal(signed.zab, 1919810);
});

test("signedUrl 拼出带签名的完整地址", () => {
  const url = WBI.signedUrl(
    "https://api.bilibili.com/x/player/wbi/v2",
    { aid: 1, cid: 2, bvid: "BV1xx411c7mD" },
    { imgKey: IMG_KEY, subKey: SUB_KEY },
    1702204169,
  );
  assert.match(url, /^https:\/\/api\.bilibili\.com\/x\/player\/wbi\/v2\?/);
  const query = new URL(url).searchParams;
  assert.equal(query.get("wts"), "1702204169");
  assert.equal(query.get("cid"), "2");
  assert.equal(
    query.get("w_rid"),
    WBI.signParams(
      { aid: 1, cid: 2, bvid: "BV1xx411c7mD" },
      { imgKey: IMG_KEY, subKey: SUB_KEY },
      1702204169,
    ).w_rid,
  );
});

test("nav 响应解析出密钥对", () => {
  const keys = WBI.parseNavResponse({
    code: 0,
    data: {
      wbi_img: {
        img_url: `https://i0.hdslb.com/bfs/wbi/${IMG_KEY}.png`,
        sub_url: `https://i0.hdslb.com/bfs/wbi/${SUB_KEY}.png`,
      },
    },
  });
  assert.deepEqual(keys, { imgKey: IMG_KEY, subKey: SUB_KEY });
});

test("nav 缺少 wbi_img 时报错", () => {
  assert.throws(() => WBI.parseNavResponse({ code: 0, data: {} }), /WBI 密钥/);
});

test("密钥在 TTL 内复用，force 时重新拉取", async () => {
  WBI.clearKeyCache();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return {
      ok: true,
      json: async () => ({
        data: {
          wbi_img: {
            img_url: `https://i0.hdslb.com/bfs/wbi/${IMG_KEY}.png`,
            sub_url: `https://i0.hdslb.com/bfs/wbi/${SUB_KEY}.png`,
          },
        },
      }),
    };
  };

  await WBI.fetchWbiKeys({ fetchImpl });
  await WBI.fetchWbiKeys({ fetchImpl });
  assert.equal(calls, 1, "第二次应命中缓存");

  await WBI.fetchWbiKeys({ fetchImpl, force: true });
  assert.equal(calls, 2);
  WBI.clearKeyCache();
});

test("nav 请求失败时抛错而不是返回半成品密钥", async () => {
  WBI.clearKeyCache();
  await assert.rejects(
    () => WBI.fetchWbiKeys({ fetchImpl: async () => ({ ok: false, status: 503 }) }),
    /503/,
  );
  WBI.clearKeyCache();
});
