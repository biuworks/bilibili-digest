/**
 * AI 协议适配层：把「OpenAI 兼容」和「Anthropic」的差异全部收在这里。
 * 全是纯函数（配置 → {url, headers, body}），网络调用留在 background.js。
 */
var BILI_AI_PROVIDER = (() => {
  const settingsModule =
    typeof BILI_SETTINGS !== "undefined"
      ? BILI_SETTINGS
      : typeof require === "function"
        ? require("../settings.js")
        : null;

  const { PROTOCOLS, REASONING_EFFORTS } = settingsModule;

  // Anthropic 的版本号是必填头部，写死一个已知可用的日期版本。
  const ANTHROPIC_VERSION = "2023-06-01";

  /**
   * 默认关掉推理：顺句、翻译这类按规则改写的任务，推理只会拖慢。
   * 用户可在「管理提示词」页按能力放开，档位见 REASONING_EFFORTS。
   */
  const THINKING_DISABLED = Object.freeze({ type: "disabled" });

  // 档位到各家参数的换算只在这里做一次：
  // - Anthropic：thinking.budget_tokens（整数），必须严格小于 max_tokens
  // - OpenAI o 系列 / gpt-5：reasoning_effort 枚举
  // - DeepSeek：只认 thinking 开关，没有中间档位——低/中/高是同一个请求形状
  const ANTHROPIC_THINKING_BUDGET = Object.freeze({
    low: 2048,
    medium: 8192,
    high: 16_384,
  });

  // 三家认的档位名一致（off 之外），校验时共用一份。
  const REASONING_LEVELS = Object.freeze(Object.keys(ANTHROPIC_THINKING_BUDGET));

  /**
   * 档位对应的思考预算，调用方把它加在正文的 max_tokens 之外：
   * budget_tokens 恒小于 max_tokens，正文也不会被思考挤掉。
   * off 或未知档位返回 0，表示这次不抬档。
   *
   * 代价是 max_tokens 会变大。输出上限很小的老模型可能直接拒绝，
   * 那时把档位调低即可——扩展没有模型清单，猜不出它的上限。
   */
  function anthropicThinkingBudget(reasoningEffort) {
    return ANTHROPIC_THINKING_BUDGET[String(reasoningEffort || "")] || 0;
  }

  // thinking 不是 OpenAI 标准参数，发给不认识它的服务可能被拒，
  // 只在地址指向 DeepSeek（沿用了 Anthropic 的形状）时才加。
  // 其余厂商在这里保持上一版行为：什么都不发，严格网关不会因为未知字段 400。
  function vendorExtras(baseUrl, reasoningEffort = REASONING_EFFORTS.OFF) {
    try {
      // 精确到域名本身或其子域：endsWith 会把 mydeepseek.com 这类形近
      // 域名也放进来，严格网关收到未知参数 thinking 会直接 400。
      const host = new URL(String(baseUrl)).hostname;
      if (host === "deepseek.com" || host.endsWith(".deepseek.com")) {
        // DeepSeek 的 thinking 只有开/关两态，档位差异得由预算和提示词承担。
        return {
          thinking:
            reasoningEffort === REASONING_EFFORTS.OFF
              ? THINKING_DISABLED
              : { type: "enabled" },
        };
      }
    } catch (error) {
      // 地址非法时交给调用方校验，这里不额外加字段。
    }
    return {};
  }

  /** 只有推理模型认 reasoning_effort；其它模型发了会被拒。 */
  function openaiReasoningEffort(isReasoningModel, reasoningEffort) {
    if (!isReasoningModel) return "";
    const value = String(reasoningEffort || "");
    return REASONING_LEVELS.includes(value) ? value : "";
  }

  // Anthropic 把 system 放在顶层，不接受 role 为 system 的消息。
  function splitSystemMessages(messages) {
    const list = Array.isArray(messages) ? messages : [];
    const system = list
      .filter((message) => message?.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    const rest = list
      .filter((message) => message?.role !== "system")
      .map((message) => ({ role: message.role, content: message.content }));
    return { system, messages: rest };
  }

  function buildChatRequest({
    settings,
    messages,
    maxTokens,
    temperature,
    responseFormat,
    reasoningEffort = REASONING_EFFORTS.OFF,
  }) {
    const url = settingsModule.chatCompletionsUrl(settings);
    if (!url) throw new Error("API 地址不合法，请到设置页检查。");

    if (settings.protocol === PROTOCOLS.ANTHROPIC) {
      const split = splitSystemMessages(messages);
      const thinkingBudget = anthropicThinkingBudget(reasoningEffort);
      const body = {
        model: settings.aiModel,
        // Anthropic 的 max_tokens 是必填项；开着思考时把思考预算加在正文之外，
        // 正文（尤其 JSON 输出）仍有完整的那一份。关闭时直接发原值，
        // 与改动前逐字节一致（也避免 undefined + 0 变成 NaN）。
        max_tokens: thinkingBudget ? maxTokens + thinkingBudget : maxTokens,
        messages: split.messages,
        thinking: thinkingBudget
          ? { type: "enabled", budget_tokens: thinkingBudget }
          : THINKING_DISABLED,
      };
      if (split.system) {
        // 几十个批次共用同一份系统提示词；Anthropic 的前缀缓存要显式打标记，
        // 否则每批都付全价 prefill。内容太短达不到门槛时服务端直接忽略，无副作用。
        body.system = [
          {
            type: "text",
            text: split.system,
            cache_control: { type: "ephemeral" },
          },
        ];
      }
      // 开着思考时 Anthropic 只接受默认温度，别再塞一个和思考打架的值进去。
      if (!thinkingBudget && typeof temperature === "number") {
        body.temperature = temperature;
      }

      return {
        url,
        headers: {
          "Content-Type": "application/json",
          "x-api-key": settings.aiApiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          // 没有这个头，浏览器里的请求会被 CORS 挡掉；它就是为 BYOK 场景设计的。
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body,
      };
    }

    // OpenAI 的推理系列（o1/o3/o4-mini、gpt-5）不接受 max_tokens 与自定义
    // temperature：参数名叫 max_completion_tokens，temperature 只认默认值。
    // 其余 OpenAI 兼容服务仍按标准参数发送。
    const openaiReasoning = /^(o\d|gpt-5)/i.test(String(settings.aiModel || ""));
    const body = {
      model: settings.aiModel,
      messages: Array.isArray(messages) ? messages : [],
      ...vendorExtras(settings.aiBaseUrl, reasoningEffort),
    };
    if (openaiReasoning) {
      body.max_completion_tokens = maxTokens;
    } else {
      body.max_tokens = maxTokens;
      if (typeof temperature === "number") body.temperature = temperature;
    }
    // 只有推理模型认识这个字段；其余模型维持旧请求形状，不多发一个未知参数。
    const effort = openaiReasoningEffort(openaiReasoning, reasoningEffort);
    if (effort) body.reasoning_effort = effort;
    if (responseFormat) body.response_format = responseFormat;

    return {
      url,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.aiApiKey}`,
      },
      body,
    };
  }

  // 取不到文本时返回空串，由调用方统一报「空响应」。
  function parseChatResponse(protocol, data) {
    if (protocol === PROTOCOLS.ANTHROPIC) {
      const blocks = Array.isArray(data?.content) ? data.content : [];
      return blocks
        .filter((block) => block?.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("");
    }
    const content = data?.choices?.[0]?.message?.content;
    return typeof content === "string" ? content : "";
  }

  function parseErrorMessage(data, status) {
    const payload = data && typeof data === "object" ? data : {};
    const message =
      payload.error?.message ||
      payload.error?.type ||
      payload.message ||
      (typeof payload.error === "string" ? payload.error : "");
    return message || `服务返回 ${status}`;
  }

  /**
   * 模型返回 200 却没有正文时，判断成因：协议选错、token 截断、推理占满配额、
   * JSON 模式有毛病——每种对应的动作不同。两个 retry 标志对应可自愈的成因；
   * message 按「重试过仍不行」的口径写，因为它只在重试用尽后才会被看到。
   */
  function diagnoseEmptyResponse(protocol, data) {
    const payload = data && typeof data === "object" ? data : {};

    if (protocol === PROTOCOLS.ANTHROPIC) {
      // 拿到的是 OpenAI 形状的响应，说明协议选错了。
      if (!Array.isArray(payload.content) && Array.isArray(payload.choices)) {
        return {
          reason: "PROTOCOL_MISMATCH",
          message:
            "响应看起来是 OpenAI 格式，但当前选的是 Anthropic 协议。请到设置页把「API 协议」改成 OpenAI 兼容。",
          retryWithoutJsonMode: false,
        };
      }
      if (payload.stop_reason === "max_tokens") {
        return {
          reason: "TRUNCATED",
          message:
            "模型还没输出正文就到了 token 上限，多半是思考占满了额度。已经放大预算重试过，仍然不够，建议换一个非推理模型。",
          retryWithoutJsonMode: false,
          retryWithMoreTokens: true,
        };
      }
      // 只有 thinking 块、没有 text 块
      if (
        Array.isArray(payload.content) &&
        payload.content.some((block) => block?.type === "thinking")
      ) {
        return {
          reason: "REASONING_ONLY",
          message:
            "模型只输出了思考过程，没有正文。建议在设置页换一个非推理模型。",
          retryWithoutJsonMode: false,
        };
      }
      return {
        reason: "EMPTY_CONTENT",
        message: "模型返回了空内容，请重试。",
        retryWithoutJsonMode: false,
      };
    }

    if (!Array.isArray(payload.choices) || !payload.choices.length) {
      // 拿到的是 Anthropic 形状的响应，说明协议选错了。
      if (Array.isArray(payload.content)) {
        return {
          reason: "PROTOCOL_MISMATCH",
          message:
            "响应看起来是 Anthropic 格式，但当前选的是 OpenAI 兼容协议。请到设置页把「API 协议」改成 Anthropic。",
          retryWithoutJsonMode: false,
        };
      }
      return {
        reason: "NO_CHOICES",
        message:
          "响应里没有 choices 字段，这个地址可能不是 OpenAI 兼容接口。请到设置页核对 API 地址与协议。",
        retryWithoutJsonMode: false,
      };
    }

    const choice = payload.choices[0] || {};
    const message = choice.message || {};
    // 推理模型把内容放在 reasoning_content，content 反而是空的。
    const reasoning = message.reasoning_content || message.reasoning;

    if (choice.finish_reason === "length") {
      return {
        reason: "TRUNCATED",
        message: reasoning
          ? "模型把 token 配额全用在思考上了，没能输出正文。已经放大预算重试过，仍然不够，建议换一个非推理模型。"
          : "输出被 token 上限截断了，放大预算重试后仍然不够。可以换一个输出更简洁的模型试试。",
        retryWithoutJsonMode: false,
        retryWithMoreTokens: true,
      };
    }
    if (reasoning) {
      return {
        reason: "REASONING_ONLY",
        message:
          "模型只输出了思考过程，没有正文。建议在设置页换一个非推理模型。",
        retryWithoutJsonMode: false,
      };
    }

    // 剩下最常见的是 JSON 模式偶发返回空串；提示词本身已要求 JSON，
    // 去掉 response_format 再试一次通常能成。
    return {
      reason: "EMPTY_CONTENT",
      message: "模型返回了空内容，请重试。",
      retryWithoutJsonMode: true,
    };
  }

  function buildModelsRequest(settings) {
    const url = settingsModule.modelsUrl(settings);
    if (!url) throw new Error("API 地址不合法，请到设置页检查。");

    const headers =
      settings.protocol === PROTOCOLS.ANTHROPIC
        ? {
            "x-api-key": settings.aiApiKey,
            "anthropic-version": ANTHROPIC_VERSION,
            "anthropic-dangerous-direct-browser-access": "true",
          }
        : { Authorization: `Bearer ${settings.aiApiKey}` };

    return { url, headers };
  }

  function parseModelsResponse(data) {
    const list = Array.isArray(data?.data)
      ? data.data
      : Array.isArray(data?.models)
        ? data.models
        : [];
    return list
      .map((item) =>
        typeof item === "string" ? item : item?.id || item?.name || "",
      )
      .filter((id) => typeof id === "string" && id)
      .sort((a, b) => a.localeCompare(b));
  }

  return {
    ANTHROPIC_VERSION,
    ANTHROPIC_THINKING_BUDGET,
    anthropicThinkingBudget,
    vendorExtras,
    openaiReasoningEffort,
    splitSystemMessages,
    buildChatRequest,
    parseChatResponse,
    parseErrorMessage,
    diagnoseEmptyResponse,
    buildModelsRequest,
    parseModelsResponse,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = BILI_AI_PROVIDER;
}
