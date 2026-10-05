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

  // 人工字幕优先于 AI。同为人工时：具体中文（简体/繁体）> 地区别名 zh-CN > 英文。
  // AI 中文放在人工英文之后，避免「只有机翻中文」的英文视频被固定成中文。
  const DEFAULT_LANG_PREFERENCE = Object.freeze([
    "zh-Hans",
    "zh-Hant",
    "zh",
    "zh-CN",
    "en",
    "en-US",
    "ai-zh",
    "ai-en",
  ]);

  // 页面请求会带这个来源。扩展 service worker 默认不带，B 站会把字幕列表
  // 回成空、或让字幕 CDN 直接拒绝，表现就是「没有字幕」。
  const PAGE_REFERRER = "https://www.bilibili.com/";

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
      if (code === -101) {
        throw new BiliApiError(
          "NEED_LOGIN",
          "该视频的字幕需要登录后才能查看，请先在浏览器里登录 B 站账号。",
        );
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
      ownerMid: Number(data?.owner?.mid) || 0,
      duration: Number(target?.duration ?? data?.duration) || 0,
      pageCount: pages.length || 1,
    };
  }

  function biliRequestInit({ credentials = "include" } = {}) {
    return {
      credentials,
      // 列表接口的空结果不能进 HTTP 缓存，否则切换语言会一直读到「没有字幕」。
      cache: credentials === "include" ? "no-store" : "default",
      referrer: PAGE_REFERRER,
      referrerPolicy: "strict-origin-when-cross-origin",
      headers: {
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
    };
  }

  async function fetchVideoInfo(bvid, { fetchImpl = fetch, page = 1 } = {}) {
    const url = new URL(VIEW_URL);
    url.searchParams.set("bvid", bvid);
    const response = await fetchImpl(url.toString(), biliRequestInit());
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
          authorMid: Number(track?.author_mid) || 0,
        };
      })
      .filter(Boolean);
  }

  function subtitleFileKey(url) {
    try {
      const parsed = new URL(url);
      return `${parsed.host}${parsed.pathname}`;
    } catch {
      return String(url || "");
    }
  }

  function langSpecificity(track) {
    const lang = String(track?.lang || "");
    let score = lang.split("-").filter(Boolean).length;
    if (/Hans|Hant/i.test(lang)) score += 2;
    // 「中文（中国）」是按账号地区塞进来的别名，不如简体/繁体具体。
    if (/（中国）|\(中国\)/.test(String(track?.langLabel || ""))) score -= 3;
    return score;
  }

  function isChineseRegionAlias(track) {
    return (
      /^zh(-|$)/i.test(String(track?.lang || "")) &&
      /（中国）|\(中国\)/.test(String(track?.langLabel || ""))
    );
  }

  function hasSpecificChineseTrack(tracks) {
    return tracks.some((track) => /^zh-(Hans|Hant)/i.test(String(track?.lang || "")));
  }

  /**
   * 播放器菜单不会展示的轨道：
   * - 同一字幕文件出现两次时，留下更具体的语言码
   * - 已有简体/繁体时，丢掉「中文（中国）」这种地区别名
   */
  function filterVisibleSubtitleTracks(tracks, outer = null) {
    const list = Array.isArray(tracks) ? tracks.filter((track) => track?.url) : [];
    const byFile = new Map();
    const deduped = [];
    for (const track of list) {
      const key = subtitleFileKey(track.url);
      const previous = byFile.get(key);
      if (!previous) {
        byFile.set(key, track);
        deduped.push(track);
        continue;
      }
      if (langSpecificity(track) > langSpecificity(previous)) {
        deduped[deduped.indexOf(previous)] = track;
        byFile.set(key, track);
      }
    }

    const outerLan = String(outer?.lan || "");
    const outerLabel = String(outer?.lan_doc || "");
    const specificChinese = hasSpecificChineseTrack(deduped);
    return deduped.filter((track) => {
      if (specificChinese && isChineseRegionAlias(track)) return false;
      if (
        outerLan &&
        track.lang === outerLan &&
        outerLabel &&
        track.langLabel === outerLabel &&
        isChineseRegionAlias(track) &&
        specificChinese
      ) {
        return false;
      }
      return true;
    });
  }

  // need_login_subtitle 用来区分「未登录看不见」和「真的没字幕」。
  function subtitleNeedsLogin(playerData) {
    return !!playerData?.need_login_subtitle;
  }

  function preferenceOrder(preference) {
    return Array.isArray(preference) && preference.length
      ? preference
      : DEFAULT_LANG_PREFERENCE;
  }

  function baseLang(lang) {
    return String(lang || "")
      .replace(/^ai[-_]/i, "")
      .split("-")[0]
      .toLowerCase();
  }

  function sortTracks(tracks, preference) {
    const order = preferenceOrder(preference);
    const rank = (track) => {
      const index = order.indexOf(track.lang);
      return index === -1 ? order.length : index;
    };
    return [...tracks].sort((a, b) => {
      const byLang = rank(a) - rank(b);
      if (byLang !== 0) return byLang;
      return Number(a.isAi) - Number(b.isAi);
    });
  }

  // 有人工轨时不用 AI 轨。UP 主只上传了一种语言时，视为原声语言。
  function pickSubtitleTrack(tracks, preference = DEFAULT_LANG_PREFERENCE, context = {}) {
    if (!Array.isArray(tracks) || tracks.length === 0) return null;
    const human = tracks.filter((track) => !track.isAi);
    const pool = human.length ? human : tracks;
    const ownerMid = Number(context?.ownerMid) || 0;
    if (ownerMid) {
      const own = pool.filter((track) => track.authorMid && Number(track.authorMid) === ownerMid);
      const families = new Set(own.map((track) => baseLang(track.lang)));
      if (own.length && families.size === 1) return sortTracks(own, preference)[0];
    }
    return sortTracks(pool, preference)[0];
  }

  // 用户点名要哪条就用哪条。strict 时列表里没有就返回 null，避免静默退回中文。
  function pickSubtitleTrackByLang(
    tracks,
    lang,
    preference = DEFAULT_LANG_PREFERENCE,
    context = {},
  ) {
    if (!Array.isArray(tracks) || tracks.length === 0) return null;
    const target = lang ? String(lang) : "";
    if (target) {
      const hit = tracks.find((track) => track.lang === target);
      if (hit) return hit;
      if (context?.strict) return null;
    }
    return pickSubtitleTrack(tracks, preference, context);
  }

  async function fetchSubtitleTracks(
    { aid, cid, bvid },
    { fetchImpl = fetch, wbi = wbiModule } = {},
  ) {
    const keys = await wbi.fetchWbiKeys({ fetchImpl });
    const url = wbi.signedUrl(PLAYER_URL, { aid, cid, bvid }, keys);
    const response = await fetchImpl(url, biliRequestInit());
    const data = await readEnvelope(response, "字幕列表");
    return {
      tracks: filterVisibleSubtitleTracks(normalizeSubtitleTracks(data), data?.subtitle),
      needLogin: subtitleNeedsLogin(data),
    };
  }

  async function fetchSubtitleTrackContent(trackUrl, { fetchImpl = fetch } = {}) {
    const response = await fetchImpl(trackUrl, {
      // 字幕 CDN 的鉴权在 URL 参数里，附带 cookie 反而可能触发跨站限制。
      // 仍然带播放页 Referer：不带的话部分轨道会 403 或回空，直到播放器自己请求过。
      // 这里允许 HTTP 缓存，播放器已经拉到的那份可以直接复用。
      ...biliRequestInit({ credentials: "omit" }),
      cache: "default",
    });
    if (!response.ok) {
      throw new BiliApiError(
        "SUBTITLE_DOWNLOAD_FAILED",
        `字幕下载失败（HTTP ${response.status}）。点重试再取一次；若播放器里能切换到该语言，先切换再试。`,
      );
    }
    const payload = await response.json();
    if (
      payload &&
      typeof payload.code === "number" &&
      payload.code !== 0 &&
      !Array.isArray(payload.body)
    ) {
      throw new BiliApiError(
        payload.code === -101 ? "NEED_LOGIN" : "SUBTITLE_DOWNLOAD_FAILED",
        payload.code === -101
          ? "该视频的字幕需要登录后才能查看，请先在浏览器里登录 B 站账号。"
          : payload.message || `字幕下载被拒绝（${payload.code}）。点重试再取一次。`,
      );
    }
    return normalizeSubtitleBody(payload);
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
    PAGE_REFERRER,
    BiliApiError,
    parseBvid,
    parsePageNumber,
    canonicalVideoUrl,
    normalizeVideoInfo,
    normalizeSubtitleTracks,
    filterVisibleSubtitleTracks,
    normalizeSubtitleBody,
    subtitleNeedsLogin,
    pickSubtitleTrack,
    pickSubtitleTrackByLang,
    fetchVideoInfo,
    fetchSubtitleTracks,
    fetchSubtitleTrackContent,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = BILI_API;
}
