/**
 * B 站字幕数据源 —— 替代上游的 Supadata。
 *
 * 取字幕要走这几步：
 *  1. `x/web-interface/view` 用 BV 号换 aid / cid / 标题 / 分 P（无需签名）
 *  2. `x/player/wbi/v2` 用 aid + cid 换字幕轨列表（需 WBI 签名）
 *  3. 未登录时上一步经常返回空列表，播放器改走 `x/v2/subtitle/web/view`
 *     （protobuf，字幕地址还做了异或混淆）
 *  4. 直接下载字幕轨 JSON：`{body: [{from, to, content}]}`，一次返回全量
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
  const SUBTITLE_VIEW_URL = "https://api.bilibili.com/x/v2/subtitle/web/view";

  // 播放器 core 里用来解开 subtitle.bilibili.com 混淆路径的两把钥匙。
  // 解出来的路径挂到 aisubtitle.hdslb.com，查询串（auth_key）原样接上。
  const SUBTITLE_URL_KEYS = Object.freeze([
    Object.freeze(["nP](wOFRvU.+<fjS{jn-!$D|Dz&\",zT`", "=CFxYRn{.y|uVyO$uh&sikph?N.ilF/`"]),
    Object.freeze(["Bn\"q~|albg@]Go~ACgyDvKnd+)_D}^&J?", "Cu~L!xs~f^&r@'vh=q]q{eeng*sEg^kp#J"]),
  ]);
  const SUBTITLE_URL_SUFFIX = "bilibili";
  const SUBTITLE_CDN_ORIGIN = "https://aisubtitle.hdslb.com";

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

  function xorText(text, key) {
    let out = "";
    for (let i = 0; i < text.length; i += 1) {
      out += String.fromCharCode(text.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    }
    return out;
  }

  // 播放器拿到 //subtitle.bilibili.com/<混淆路径>?auth_key= 后，异或出真实路径，
  // 再改挂到 aisubtitle.hdslb.com。已经是普通地址的原样返回（补上 https）。
  function decodeObfuscatedSubtitleUrl(url) {
    const raw = String(url || "");
    if (!raw.includes("//subtitle.bilibili.com/")) {
      return raw.startsWith("//") ? `https:${raw}` : raw;
    }
    const splitAt = raw.indexOf("?");
    const pathPart = splitAt === -1 ? raw : raw.slice(0, splitAt);
    const query = splitAt === -1 ? "" : raw.slice(splitAt + 1);
    const matched = pathPart.match(/\/\/subtitle\.bilibili\.com\/([^?]+)/);
    if (!matched) return raw.startsWith("//") ? `https:${raw}` : raw;

    let decodedPath = "";
    for (const [prefix, key] of SUBTITLE_URL_KEYS) {
      let plainPath;
      try {
        plainPath = decodeURIComponent(matched[1]);
      } catch (error) {
        continue;
      }
      const plain = xorText(plainPath, `${key}${SUBTITLE_URL_SUFFIX}`);
      if (!plain.startsWith(prefix)) continue;
      decodedPath = plain.split(prefix)[1] || "";
      break;
    }
    if (!decodedPath) return raw.startsWith("//") ? `https:${raw}` : raw;
    const absolute = `${SUBTITLE_CDN_ORIGIN}${decodedPath.startsWith("/") ? "" : "/"}${decodedPath}`;
    return query ? `${absolute}?${query}` : absolute;
  }

  function normalizeSubtitleTracks(playerData) {
    const raw = playerData?.subtitle?.subtitles;
    if (!Array.isArray(raw)) return [];
    return raw
      .map((track) => {
        const url = decodeObfuscatedSubtitleUrl(track?.subtitle_url || "");
        if (!url) return null;
        return {
          id: String(track?.id ?? ""),
          lang: String(track?.lan || ""),
          langLabel: String(track?.lan_doc || track?.lan || ""),
          url,
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

  /**
   * 播放器会把同一份字幕文件列两次。只在同一语种内合并，留下更具体的语言码：
   * 「中文（中国）」和「中文（简体）」指向同一文件时只留简体。
   * 文件不同就都留下——未登录时播放器同时列出这两条，而且往往只有地区别名那份有正文。
   * 不同语种共用一个空占位文件时也不能互相吞掉。
   * outer 保留给调用方传入原始 subtitle 对象，合并不再依赖它。
   */
  function filterVisibleSubtitleTracks(tracks, outer = null) {
    void outer;
    const list = Array.isArray(tracks) ? tracks.filter((track) => track?.url) : [];
    const byFile = new Map();
    const deduped = [];
    for (const track of list) {
      const key = `${baseLang(track.lang)}:${subtitleFileKey(track.url)}`;
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
    return deduped;
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

  function skipVarint(bytes, offset) {
    let index = offset;
    while (index < bytes.length && index - offset < 10) {
      const byte = bytes[index];
      index += 1;
      if ((byte & 0x80) === 0) return index;
    }
    return index;
  }

  function readVarint(bytes, offset) {
    let value = 0;
    let shift = 0;
    let index = offset;
    while (index < bytes.length && shift <= 28) {
      const byte = bytes[index];
      index += 1;
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return [value, index];
      shift += 7;
    }
    return [null, index];
  }

  function utf8Text(bytes) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i);
        if (code < 32 && text[i] !== "\t" && text[i] !== "\n" && text[i] !== "\r") return null;
      }
      return text;
    } catch (error) {
      return null;
    }
  }

  // x/v2/subtitle/web/view 是 protobuf。每条字幕是带 lan / lan_doc / subtitle_url 的子消息。
  function parseSubtitleViewMessages(bytes, depth, found) {
    if (!(bytes instanceof Uint8Array) || depth > 6) return;
    let index = 0;
    const strings = [];
    while (index < bytes.length) {
      const keyRead = readVarint(bytes, index);
      if (keyRead[0] == null) return;
      index = keyRead[1];
      const field = keyRead[0] >>> 3;
      const wire = keyRead[0] & 7;
      if (!field) return;
      if (wire === 0) {
        index = skipVarint(bytes, index);
      } else if (wire === 2) {
        const lenRead = readVarint(bytes, index);
        if (lenRead[0] == null) return;
        index = lenRead[1];
        const length = lenRead[0];
        if (length < 0 || index + length > bytes.length) return;
        const slice = bytes.subarray(index, index + length);
        index += length;
        const text = utf8Text(slice);
        if (text != null) strings.push(text);
        else parseSubtitleViewMessages(slice, depth + 1, found);
      } else if (wire === 5) {
        index += 4;
      } else if (wire === 1) {
        index += 8;
      } else {
        return;
      }
    }
    const url = strings.find(
      (text) => text.includes("subtitle.bilibili.com") || text.includes(".hdslb.com"),
    );
    const lan = strings.find((text) => /^(ai-)?[a-z]{2,3}(-[A-Za-z0-9]+)*$/.test(text));
    if (!url || !lan) return;
    const labels = strings.filter((text) => text !== url && text !== lan && !/^\d+$/.test(text));
    labels.sort((a, b) => b.length - a.length);
    found.push({
      lan,
      lan_doc: labels[0] || lan,
      subtitle_url: url,
    });
  }

  function tracksFromSubtitlePayload(data) {
    if (!data || typeof data !== "object") return [];
    const envelope = data.data?.subtitle || data.subtitle ? (data.data?.subtitle ? data.data : data) : null;
    return envelope ? normalizeSubtitleTracks(envelope) : [];
  }

  async function readSubtitleViewResponse(response) {
    if (typeof response?.arrayBuffer === "function") {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!bytes.length) return [];
      if (bytes[0] === 0x7b || bytes[0] === 0x5b) {
        try {
          return tracksFromSubtitlePayload(JSON.parse(new TextDecoder().decode(bytes)));
        } catch (error) {
          return [];
        }
      }
      const found = [];
      parseSubtitleViewMessages(bytes, 0, found);
      return normalizeSubtitleTracks({ subtitle: { subtitles: found } });
    }
    if (typeof response?.json === "function") {
      try {
        return tracksFromSubtitlePayload(await response.json());
      } catch (error) {
        return [];
      }
    }
    return [];
  }

  async function fetchSubtitleViewTracks({ aid, cid }, { fetchImpl, wbi, keys }) {
    const url = wbi.signedUrl(
      SUBTITLE_VIEW_URL,
      {
        oid: cid,
        pid: aid,
        context_ext: JSON.stringify({ video_type: 1 }),
        type: 1,
        cur_production_type: 0,
        playlist_switch: 0,
      },
      keys,
    );
    const response = await fetchImpl(url, biliRequestInit());
    if (response?.ok === false) return [];
    return readSubtitleViewResponse(response);
  }

  async function fetchSubtitleTracks(
    { aid, cid, bvid },
    { fetchImpl = fetch, wbi = wbiModule } = {},
  ) {
    const keys = await wbi.fetchWbiKeys({ fetchImpl });
    const url = wbi.signedUrl(PLAYER_URL, { aid, cid, bvid }, keys);
    const response = await fetchImpl(url, biliRequestInit());
    const data = await readEnvelope(response, "字幕列表");
    let tracks = filterVisibleSubtitleTracks(normalizeSubtitleTracks(data), data?.subtitle);
    let needLogin = subtitleNeedsLogin(data);
    // 未登录时 wbi/v2 常把 subtitles 留空并标 need_login_subtitle，播放器实际用的是另一条接口。
    if (!tracks.length && aid && cid) {
      try {
        const viewed = await fetchSubtitleViewTracks({ aid, cid }, { fetchImpl, wbi, keys });
        const visible = filterVisibleSubtitleTracks(viewed);
        if (visible.length) {
          tracks = visible;
          needLogin = false;
        }
      } catch (error) {
        // 这条接口失败时沿用 wbi 的结论：空列表加需要登录，或真的没有字幕。
      }
    }
    return { tracks, needLogin };
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
    SUBTITLE_VIEW_URL,
    DEFAULT_LANG_PREFERENCE,
    PAGE_REFERRER,
    BiliApiError,
    parseBvid,
    parsePageNumber,
    canonicalVideoUrl,
    normalizeVideoInfo,
    decodeObfuscatedSubtitleUrl,
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
