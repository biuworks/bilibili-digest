/** 共享的非机密配置：默认值、厂商预设与校验逻辑。密钥由 options.js 写入存储。 */
var BILI_SETTINGS = (() => {
  const STORAGE_KEY = "bili_digest_settings";

  // 只做两种协议：「OpenAI 兼容」是事实标准，Anthropic 是唯一值得单独适配的例外。
  const PROTOCOLS = Object.freeze({
    OPENAI: "openai",
    ANTHROPIC: "anthropic",
  });

  // 只预置 protocol 和 baseUrl；model 故意留空——模型名换代很快，
  // 写死等于埋一个过期默认值，设置页有「拉取模型列表」兜底。
  const PRESETS = Object.freeze([
    {
      id: "deepseek",
      label: "DeepSeek",
      protocol: PROTOCOLS.OPENAI,
      baseUrl: "https://api.deepseek.com",
      // 唯一预置模型：本项目已实测验证过。
      model: "deepseek-v4-flash",
      docsUrl: "https://platform.deepseek.com/api_keys",
    },
    {
      id: "openai",
      label: "OpenAI",
      protocol: PROTOCOLS.OPENAI,
      baseUrl: "https://api.openai.com/v1",
      model: "",
      docsUrl: "https://platform.openai.com/api-keys",
    },
    {
      id: "anthropic",
      label: "Anthropic Claude",
      protocol: PROTOCOLS.ANTHROPIC,
      baseUrl: "https://api.anthropic.com",
      model: "",
      docsUrl: "https://console.anthropic.com/settings/keys",
    },
    {
      id: "gemini",
      label: "Google Gemini（OpenAI 兼容端点）",
      protocol: PROTOCOLS.OPENAI,
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      model: "",
      docsUrl: "https://aistudio.google.com/apikey",
    },
    {
      id: "moonshot",
      label: "月之暗面 Kimi",
      protocol: PROTOCOLS.OPENAI,
      baseUrl: "https://api.moonshot.cn/v1",
      model: "",
      docsUrl: "https://platform.moonshot.cn/console/api-keys",
    },
    {
      id: "zhipu",
      label: "智谱 GLM",
      protocol: PROTOCOLS.OPENAI,
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      model: "",
      docsUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    },
    {
      id: "dashscope",
      label: "阿里云百炼（通义千问）",
      protocol: PROTOCOLS.OPENAI,
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "",
      docsUrl: "https://bailian.console.aliyun.com/",
    },
    {
      id: "siliconflow",
      label: "硅基流动 SiliconFlow",
      protocol: PROTOCOLS.OPENAI,
      baseUrl: "https://api.siliconflow.cn/v1",
      model: "",
      docsUrl: "https://cloud.siliconflow.cn/account/ak",
    },
    {
      id: "openrouter",
      label: "OpenRouter",
      protocol: PROTOCOLS.OPENAI,
      baseUrl: "https://openrouter.ai/api/v1",
      model: "",
      docsUrl: "https://openrouter.ai/keys",
    },
    {
      id: "ollama",
      label: "本地 Ollama",
      protocol: PROTOCOLS.OPENAI,
      baseUrl: "http://localhost:11434/v1",
      model: "",
      docsUrl: "https://ollama.com/",
    },
    {
      id: "custom",
      label: "自定义",
      protocol: PROTOCOLS.OPENAI,
      baseUrl: "",
      model: "",
      docsUrl: "",
    },
  ]);

  const DEFAULT_PRESET = PRESETS[0];
  const CUSTOM_PRESET_ID = "custom";

  // 并发上限压在 8：再高容易撞限流；超时上限 10 分钟是为了照顾本地推理。
  const LIMITS = Object.freeze({
    concurrency: Object.freeze({ min: 1, max: 8, default: 3 }),
    timeoutSeconds: Object.freeze({ min: 30, max: 600, default: 120 }),
    analysisOverlapChars: Object.freeze({ min: 0, max: 2000, default: 400 }),
    uiFontScale: Object.freeze({ min: 80, max: 160, default: 100 }),
  });

  const ANALYSIS_CHUNK_MODES = Object.freeze({
    auto: Object.freeze({ maxChars: 6000, singleChars: 8000 }),
    short: Object.freeze({ maxChars: 3500, singleChars: 3500 }),
    long: Object.freeze({ maxChars: 12000, singleChars: 14000 }),
  });

  const DEFAULTS = Object.freeze({
    presetId: DEFAULT_PRESET.id,
    protocol: DEFAULT_PRESET.protocol,
    aiApiKey: "",
    aiBaseUrl: DEFAULT_PRESET.baseUrl,
    aiModel: DEFAULT_PRESET.model,
    aiConcurrency: LIMITS.concurrency.default,
    aiTimeoutSeconds: LIMITS.timeoutSeconds.default,
    analysisChunkMode: "auto",
    analysisOverlapChars: LIMITS.analysisOverlapChars.default,
    uiFontScale: LIMITS.uiFontScale.default,
    // 字幕轨优先级：UP 主中文 > AI 中文 > 英文（见 lib/bili-api.js）。
    subtitleLangPreference: Object.freeze([
      "zh-CN",
      "zh-Hans",
      "zh-Hant",
      "zh",
      "ai-zh",
      "en-US",
      "en",
      "ai-en",
    ]),
  });

  const LANG_CODE_PATTERN = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{2,8})*$/;

  const LEGACY_UI_FONT_SCALES = Object.freeze({
    default: 100,
    large: 115,
    xlarge: 125,
  });

  function normalizeUiFontScale(source) {
    if (source && typeof source === "object") {
      if (source.uiFontScale != null && source.uiFontScale !== "") {
        return clampNumber(source.uiFontScale, LIMITS.uiFontScale);
      }
      if (Object.hasOwn(LEGACY_UI_FONT_SCALES, source.uiFontSize)) {
        return LEGACY_UI_FONT_SCALES[source.uiFontSize];
      }
      return LIMITS.uiFontScale.default;
    }
    return clampNumber(source, LIMITS.uiFontScale);
  }

  function applyUiFontScale(
    scale,
    root = typeof document !== "undefined" ? document.documentElement : null,
  ) {
    const value = normalizeUiFontScale(scale);
    if (root?.style?.setProperty) {
      root.style.setProperty("--ui-font-zoom", String(value / 100));
    }
    return value;
  }

  function clampNumber(value, { min, max, default: fallback }) {
    // 空值不能交给 Number()——它把 null 和 "" 都算作 0，「没配过」会被夹成下界。
    if (value === null || value === undefined || value === "") return fallback;

    const number = Math.floor(Number(value));
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
  }

  function normalizeLangPreference(input) {
    if (!Array.isArray(input)) return [...DEFAULTS.subtitleLangPreference];
    const cleaned = input
      .map((lang) => (typeof lang === "string" ? lang.trim() : ""))
      .filter((lang) => LANG_CODE_PATTERN.test(lang))
      .slice(0, 20);
    return cleaned.length ? cleaned : [...DEFAULTS.subtitleLangPreference];
  }

  const presetById = (id) => PRESETS.find((preset) => preset.id === id) || null;

  const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

  // 密钥会随请求发到这个地址，所以这里也是安全边界：明文 http 只对本机放行
  //（本地推理服务不配证书），其余一律要求 https。
  function validateBaseUrl(input, protocol = PROTOCOLS.OPENAI) {
    const text = String(input || "").trim();
    if (!text) return { ok: false, error: "请填写 API 地址。" };

    let parsed;
    try {
      parsed = new URL(text);
    } catch (error) {
      return { ok: false, error: "API 地址不是合法的 URL。" };
    }

    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return { ok: false, error: "API 地址必须以 http:// 或 https:// 开头。" };
    }
    if (parsed.protocol === "http:" && !LOCAL_HOSTS.has(parsed.hostname)) {
      return {
        ok: false,
        error: "仅本机地址允许使用 http，其余地址须使用 https，否则密钥将以明文传输。",
      };
    }

    // 用户常常直接把文档里的完整端点粘进来。与其报错，不如把它还原成 base。
    let pathname = parsed.pathname.replace(/\/+$/, "");
    for (const suffix of ["/chat/completions", "/v1/messages", "/messages"]) {
      if (pathname.endsWith(suffix)) {
        pathname = pathname.slice(0, -suffix.length);
        break;
      }
    }
    // Anthropic 的端点自带 /v1，base 里再留一个会拼成 /v1/v1/messages。
    if (protocol === PROTOCOLS.ANTHROPIC && pathname.endsWith("/v1")) {
      pathname = pathname.slice(0, -3);
    }

    const url = `${parsed.origin}${pathname}`;
    return { ok: true, url, origin: `${parsed.origin}/` };
  }

  // 申请 host 权限时用的来源，形如 https://api.deepseek.com/。
  function originOf(baseUrl) {
    const result = validateBaseUrl(baseUrl);
    return result.ok ? result.origin : null;
  }

  function chatCompletionsUrl(settings) {
    const { aiBaseUrl, protocol } = normalize(settings);
    const base = validateBaseUrl(aiBaseUrl, protocol);
    if (!base.ok) return null;
    return protocol === PROTOCOLS.ANTHROPIC
      ? `${base.url}/v1/messages`
      : `${base.url}/chat/completions`;
  }

  function modelsUrl(settings) {
    const { aiBaseUrl, protocol } = normalize(settings);
    const base = validateBaseUrl(aiBaseUrl, protocol);
    if (!base.ok) return null;
    return protocol === PROTOCOLS.ANTHROPIC
      ? `${base.url}/v1/models`
      : `${base.url}/models`;
  }

  function normalize(input = {}) {
    const source = input && typeof input === "object" ? input : {};

    const preset = presetById(source.presetId) || DEFAULT_PRESET;
    const isCustom = preset.id === CUSTOM_PRESET_ID;

    // 选了具体厂商时，协议和地址完全由预设说了算——厂商换域名时老用户跟着
    // 升级走，而不是被存储里的旧值钉死。
    const protocol = !isCustom
      ? preset.protocol
      : Object.values(PROTOCOLS).includes(source.protocol)
        ? source.protocol
        : preset.protocol;

    const rawBaseUrl = !isCustom
      ? preset.baseUrl
      : typeof source.aiBaseUrl === "string" && source.aiBaseUrl.trim()
        ? source.aiBaseUrl.trim()
        : preset.baseUrl;
    const rawModel =
      typeof source.aiModel === "string" && source.aiModel.trim()
        ? source.aiModel.trim()
        : preset.model;
    // 整理不通过就原样保留，让设置页把错误指出来，而不是悄悄改回默认值。
    const checked = validateBaseUrl(rawBaseUrl, protocol);

    return {
      presetId: preset.id,
      protocol,
      aiApiKey: typeof source.aiApiKey === "string" ? source.aiApiKey.trim() : "",
      aiBaseUrl: checked.ok ? checked.url : rawBaseUrl,
      aiModel: rawModel.slice(0, 200),
      aiConcurrency: clampNumber(source.aiConcurrency, LIMITS.concurrency),
      aiTimeoutSeconds: clampNumber(source.aiTimeoutSeconds, LIMITS.timeoutSeconds),
      analysisChunkMode: Object.hasOwn(ANALYSIS_CHUNK_MODES, source.analysisChunkMode)
        ? source.analysisChunkMode
        : DEFAULTS.analysisChunkMode,
      analysisOverlapChars: clampNumber(
        source.analysisOverlapChars,
        LIMITS.analysisOverlapChars,
      ),
      uiFontScale: normalizeUiFontScale(source),
      subtitleLangPreference: normalizeLangPreference(source.subtitleLangPreference),
    };
  }

  function analysisChunkOptions(settings = {}) {
    const normalized = normalize(settings);
    return {
      ...ANALYSIS_CHUNK_MODES[normalized.analysisChunkMode],
      overlapChars: normalized.analysisOverlapChars,
    };
  }

  // 配置是否足以发起一次请求。设置页和 background 共用同一套判断。
  function validate(settings) {
    const normalized = normalize(settings);
    const errors = [];
    if (!normalized.aiApiKey && !isLocalBaseUrl(normalized.aiBaseUrl)) {
      errors.push("请填写 API 密钥。");
    }
    const base = validateBaseUrl(normalized.aiBaseUrl, normalized.protocol);
    if (!base.ok) errors.push(base.error);
    if (!normalized.aiModel) errors.push("请填写模型名称，或点击「拉取模型列表」进行选择。");
    return { ok: errors.length === 0, errors, settings: normalized };
  }

  // 本地推理服务通常不校验密钥，不该因为密钥为空就拦下来。
  function isLocalBaseUrl(baseUrl) {
    try {
      return LOCAL_HOSTS.has(new URL(String(baseUrl)).hostname);
    } catch (error) {
      return false;
    }
  }

  return {
    STORAGE_KEY,
    PROTOCOLS,
    PRESETS,
    CUSTOM_PRESET_ID,
    DEFAULTS,
    LIMITS,
    ANALYSIS_CHUNK_MODES,
    analysisChunkOptions,
    normalize,
    normalizeUiFontScale,
    applyUiFontScale,
    normalizeLangPreference,
    validate,
    validateBaseUrl,
    isLocalBaseUrl,
    originOf,
    presetById,
    chatCompletionsUrl,
    modelsUrl,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = BILI_SETTINGS;
}
