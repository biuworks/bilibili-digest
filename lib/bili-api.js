/**
 * B 站字幕数据源 —— 替代上游的 Supadata。
 *
 * 取字幕要走三步：
 *  1. `x/web-interface/view` 用 BV 号换 aid / cid / 标题 / 分 P（无需签名）
 *  2. `x/player/wbi/v2` 用 aid + cid 换字幕轨列表（需 WBI 签名）
 *  3. 直接下载字幕轨 JSON：`{body: [{from, to, content}]}`，一次返回全量
 *
 * AI 字幕对未登录用户通常为空，因此 api.bilibili.com 请求都带浏览器 cookie。
 */
var BILI_API = (() => {
  // service worker 里 wbi.js 由 importScripts 注入为全局；Node 测试里走 require。
  const wbiModule =
    typeof BILI_WBI !== "undefined"
      ? BILI_WBI
      : typeof require === "function"
        ? require("./wbi.js")
        : null;

  const VIEW_URL = "https://api.bilibili.com/x/web-interface/view";
  const PLAYER_URL = "https://api.bilibili.com/x/player/wbi/v2";

  // 优先级从高到低：UP 主中文字幕 > AI 中文 > 英文。
  const DEFAULT_LANG_PREFERENCE = Object.freeze([
    "zh-CN",
    "zh-Hans",
    "zh-Hant",
    "zh",
    "ai-zh",
    "en-US",
    "en",
    "ai-en",
  ]);

  class BiliApiError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "BiliApiError";
      this.code = code;
    }
  }

  function parseBvid(input) {
    const text = String(input || "");
    const match = text.match(/BV[0-9A-Za-z]{10}/);
    return match ? match[0] : null;
  }

  function parsePageNumber(input) {
    const match = String(input || "").match(/[?&]p=(\d+)/);
    const page = match ? Number(match[1]) : 1;
    return Number.isFinite(page) && page > 0 ? page : 1;
  }

  function canonicalVideoUrl(bvid, seconds, page = 1) {
    if (!/^BV[0-9A-Za-z]{10}$/.test(String(bvid || ""))) {
      throw new Error("无效的 BV 号");
    }
    const url = new URL(`https://www.bilibili.com/video/${bvid}`);
    if (page > 1) url.searchParams.set("p", String(page));
    const start = Math.max(0, Math.floor(Number(seconds) || 0));
    if (start > 0) url.searchParams.set("t", String(start));
    return url.toString();
  }

  async function readEnvelope(response, what) {
    if (!response.ok) {
      throw new BiliApiError("HTTP_ERROR", `${what} 请求失败：HTTP ${response.status}`);
    }
    const payload = await response.json();
    if (payload?.code !== 0) {
      const code = payload?.code;
      if (code === -404 || code === 62002 || code === 62004) {
        throw new BiliApiError("VIDEO_UNAVAILABLE", "视频不存在或已失效。");
      }
      if (code === -403) {
        throw new BiliApiError("FORBIDDEN", "没有权限访问该视频的字幕。");
      }
      if (code === -352) {
        throw new BiliApiError(
          "RISK_CONTROL",
          "请求被 B 站风控拦截，稍后重试或先在浏览器里正常打开该视频。",
        );
      }
      throw new BiliApiError(
        "API_ERROR",
        payload?.message || `${what} 返回错误码 ${code}`,
      );
    }
    return payload.data;
  }

  function normalizeVideoInfo(data, page = 1) {
    const pages = Array.isArray(data?.pages) ? data.pages : [];
    const target = pages.find((item) => Number(item?.page) === page) || pages[0];
    return {
      bvid: data?.bvid || "",
      aid: Number(data?.aid) || 0,
      cid: Number(target?.cid ?? data?.cid) || 0,
      page,
      // 分 P 视频用分 P 标题更贴近用户所见。
      title: (pages.length > 1 && target?.part) || data?.title || "",
      description: data?.desc || "",
      owner: data?.owner?.name || "",
      duration: Number(target?.duration ?? data?.duration) || 0,
      pageCount: pages.length || 1,
    };
  }

  async function fetchVideoInfo(bvid, { fetchImpl = fetch, page = 1 } = {}) {
    const url = new URL(VIEW_URL);
    url.searchParams.set("bvid", bvid);
    const response = await fetchImpl(url.toString(), {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    const data = await readEnvelope(response, "视频信息");
    const info = normalizeVideoInfo(data, page);
    if (!info.cid) {
      throw new BiliApiError("NO_CID", "未能拿到该视频的 cid。");
    }
    return info;
  }

  function normalizeSubtitleTracks(playerData) {
    const raw = playerData?.subtitle?.subtitles;
    if (!Array.isArray(raw)) return [];
    return raw
      .map((track) => {
        const url = String(track?.subtitle_url || "");
        if (!url) return null;
        return {
          id: String(track?.id ?? ""),
          lang: String(track?.lan || ""),
          langLabel: String(track?.lan_doc || track?.lan || ""),
          url: url.startsWith("//") ? `https:${url}` : url,
          // ai_type 存在即为机器生成；部分响应只在 lan 前缀体现。
          isAi:
            Number(track?.ai_status) > 0 ||
            Number(track?.ai_type) > 0 ||
            String(track?.lan || "").startsWith("ai-"),
        };
      })
      .filter(Boolean);
  }

  // need_login_subtitle 用来区分「未登录看不见」和「真的没字幕」。
  function subtitleNeedsLogin(playerData) {
    return !!playerData?.need_login_subtitle;
  }

  // 先比语言优先级，同语言下人工字幕优先于 AI 字幕。
  function pickSubtitleTrack(tracks, preference = DEFAULT_LANG_PREFERENCE) {
    if (!Array.isArray(tracks) || tracks.length === 0) return null;
    const rank = (track) => {
      const index = preference.indexOf(track.lang);
      return index === -1 ? preference.length : index;
    };
    return [...tracks].sort((a, b) => {
      const byLang = rank(a) - rank(b);
      if (byLang !== 0) return byLang;
      return Number(a.isAi) - Number(b.isAi);
    })[0];
  }

  async function fetchSubtitleTracks(
    { aid, cid, bvid },
    { fetchImpl = fetch, wbi = wbiModule } = {},
  ) {
    const keys = await wbi.fetchWbiKeys({ fetchImpl });
    const url = wbi.signedUrl(PLAYER_URL, { aid, cid, bvid }, keys);
    const response = await fetchImpl(url, {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    const data = await readEnvelope(response, "字幕列表");
    return {
      tracks: normalizeSubtitleTracks(data),
      needLogin: subtitleNeedsLogin(data),
    };
  }

  async function fetchSubtitleTrackContent(trackUrl, { fetchImpl = fetch } = {}) {
    const response = await fetchImpl(trackUrl, {
      // 字幕 CDN 的鉴权在 URL 参数里，附带 cookie 反而可能触发跨站限制。
      credentials: "omit",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new BiliApiError(
        "SUBTITLE_DOWNLOAD_FAILED",
        `字幕下载失败：HTTP ${response.status}`,
      );
    }
    return normalizeSubtitleBody(await response.json());
  }

  function normalizeSubtitleBody(payload) {
    const body = Array.isArray(payload?.body) ? payload.body : [];
    return body
      .map((line) => {
        const text = String(line?.content || "").trim();
        if (!text) return null;
        const start = Number(line?.from) || 0;
        const end = Number(line?.to) || start;
        return {
          text,
          start: Math.max(0, start),
          duration: Math.max(0, end - start),
        };
      })
      .filter(Boolean);
  }

  return {
    VIEW_URL,
    PLAYER_URL,
    DEFAULT_LANG_PREFERENCE,
    BiliApiError,
    parseBvid,
    parsePageNumber,
    canonicalVideoUrl,
    normalizeVideoInfo,
    normalizeSubtitleTracks,
    normalizeSubtitleBody,
    subtitleNeedsLogin,
    pickSubtitleTrack,
    fetchVideoInfo,
    fetchSubtitleTracks,
    fetchSubtitleTrackContent,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = BILI_API;
}
