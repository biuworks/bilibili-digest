/**
 * AI 请求的传输与策略层：超时、响应大小上限、空响应的自愈重试、错误翻译。
 * 协议差异（请求/响应形状）不归这里管，见 lib/ai-provider.js。
 *
 * 从 background.js 拆出来的原因：这一层是纯策略逻辑，唯一的环境依赖
 * （读设置、申请主机权限）都能注入，拆出来才能直连单测，
 * 而不是只能靠 vm 沙箱集成测试间接覆盖。
 *
 * 双重超时各管一段，边界是「响应头是否已到达」：之前是模型在生成，
 * 归可配的硬超时管；之后 body 应连续到达，静默即视为连接出了问题。
 */
var BILI_AI_TRANSPORT = (() => {
  const PROVIDER =
    typeof BILI_AI_PROVIDER !== "undefined"
      ? BILI_AI_PROVIDER
      : require("./ai-provider.js");
  const SETTINGS =
    typeof BILI_SETTINGS !== "undefined"
      ? BILI_SETTINGS
      : require("../settings.js");

  // 加码重试的天花板。再往上多数模型会因超过自身输出上限直接拒绝请求。
  const OUTPUT_TOKENS_CEILING = 32_768;
  const DEFAULT_IDLE_TIMEOUT_MS = 50_000;
  const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

  function taskCanceledError() {
    const error = new Error("任务已取消。");
    error.code = "TASK_CANCELED";
    return error;
  }

  /**
   * 截断修复的实现单点在 lib/ai.js（信封与内容两层共用同一算法）。
   * 本文件在 importScripts 里后于 ai.js 加载，运行时模块必在；
   * node 测试走 require。不能写成顶层依赖，manifest.test.js 会拦。
   */
  function repairTruncatedJson(text) {
    const AI =
      typeof BILI_AI !== "undefined" ? BILI_AI : require("./ai.js");
    return AI.repairTruncatedJson(text);
  }

  /** 信封解析：截断的 body 补齐后解析；修不动才翻译成能看懂的报错。 */
  function parseResponseEnvelope(text) {
    const raw = text.trimStart();
    try {
      return JSON.parse(raw);
    } catch {
      try {
        return JSON.parse(repairTruncatedJson(raw));
      } catch {
        const truncated = new Error("AI 响应不完整，请重试。");
        truncated.code = "AI_RESPONSE_TRUNCATED";
        throw truncated;
      }
    }
  }

  function throwIfTaskCanceled(signal) {
    if (signal?.aborted) throw taskCanceledError();
  }

  /**
   * deps：
   * - getSettings(): 读用户 AI 配置（background 的 chrome.storage 实现）
   * - ensureHostPermission(baseUrl): MV3 对未授权域名禁止 fetch，
   *   域名安装时未知，由设置页经 optional_host_permissions 运行时申请。
   * - log(): 调试日志（background 的 debugLog）
   * - idleTimeoutMs / maxResponseBytes: 测试注入口
   */
  function createAiTransport({
    getSettings,
    ensureHostPermission,
    log = () => {},
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    // 模块可能被测试跨 realm 加载，裸 fetch 会解析到定义时的全局而不是
    // 运行环境；生产（importScripts 同 realm）可不传，测试必须显式注入。
    fetch: fetchImpl,
  } = {}) {
    if (!getSettings || !ensureHostPermission) {
      throw new Error("AI 传输层需要 getSettings 与 ensureHostPermission");
    }
    const doFetch = fetchImpl || fetch;

    // 协议差异由 provider 处理，这里只管自愈：空响应有两种能救的成因，
    // 各给一次机会，所以最多三轮。
    async function requestAiCompletion({
      messages,
      maxTokens,
      temperature,
      responseFormat,
      signal,
    }) {
      throwIfTaskCanceled(signal);
      const settings = await getSettings();
      const check = SETTINGS.validate(settings);
      if (!check.ok) {
        const error = new Error(`AI 还没配置好：${check.errors.join(" ")}`);
        error.code = "NO_AI_CONFIG";
        throw error;
      }
      await ensureHostPermission(settings.aiBaseUrl);

      let format = responseFormat;
      let tokens = maxTokens;
      let diagnosis = null;

      for (let attempt = 0; attempt < 3; attempt += 1) {
        throwIfTaskCanceled(signal);
        const request = PROVIDER.buildChatRequest({
          settings,
          messages,
          maxTokens: tokens,
          temperature,
          responseFormat: format,
        });
        const data = await sendAiRequest(settings, request, signal);

        const text = PROVIDER.parseChatResponse(settings.protocol, data);
        if (text.trim()) return { text, settings };

        diagnosis = PROVIDER.diagnoseEmptyResponse(settings.protocol, data);

        if (format && diagnosis.retryWithoutJsonMode) {
          log("[Bilibili Digest] JSON 模式返回空，脱掉 response_format 重试");
          format = null;
          continue;
        }

        // 预算被吃光了就加码重试——max_tokens 按实际生成计费，加码不额外花钱。
        if (diagnosis.retryWithMoreTokens && tokens < OUTPUT_TOKENS_CEILING) {
          tokens = Math.min(tokens * 4, OUTPUT_TOKENS_CEILING);
          log("[Bilibili Digest] 输出被截断，放大预算重试：", tokens);
          continue;
        }

        break;
      }

      const error = new Error(diagnosis.message);
      error.code = "EMPTY_AI_RESPONSE";
      error.reason = diagnosis.reason;
      throw error;
    }

    // 真正发出请求，守住超时与响应大小。
    async function sendAiRequest(settings, request, externalSignal) {
      const controller = new AbortController();
      let timeoutKind = "";
      let idleTimer;
      let hardTimer;

      const abortFor = (kind) => {
        if (controller.signal.aborted) return;
        timeoutKind = kind;
        controller.abort();
      };
      const onExternalAbort = () => abortFor("external");
      if (externalSignal?.aborted) onExternalAbort();
      else externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
      const resetIdleTimer = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => abortFor("idle"), idleTimeoutMs);
      };

      const hardTimeoutMs = settings.aiTimeoutSeconds * 1000;
      hardTimer = setTimeout(() => abortFor("hard"), hardTimeoutMs);
      // 空闲计时绝不能在这里起表：非流式请求在模型生成完之前一个字节都不会到，
      // 提前起表等于把「模型在慢慢想」当成「服务端死了」。这一段只由硬超时负责。

      try {
        const response = await doFetch(request.url, {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify(request.body),
          signal: controller.signal,
        });
        // 响应头到了，body 应连续到达，空闲超时从这一刻起才有判断力。
        resetIdleTimer();

        const data = await readBoundedAiResponse(response, resetIdleTimer);
        if (!response.ok) {
          const error = new Error(
            PROVIDER.parseErrorMessage(data, response.status),
          );
          error.status = response.status;
          throw error;
        }

        return data;
      } catch (error) {
        if (timeoutKind === "external" || externalSignal?.aborted) {
          throw taskCanceledError();
        }
        if (timeoutKind === "idle") {
          const timeout = new Error("响应传到一半断了，请重试。");
          timeout.code = "AI_IDLE_TIMEOUT";
          throw timeout;
        }
        if (timeoutKind === "hard") {
          const timeout = new Error(
            `请求超过 ${settings.aiTimeoutSeconds} 秒上限。可以在设置页调高超时，或降低并发。`,
          );
          timeout.code = "AI_HARD_TIMEOUT";
          throw timeout;
        }
        // fetch 对跨域被拒和网络不通都只抛笼统的 TypeError，给一句能指导下一步的提示。
        if (error instanceof TypeError) {
          const network = new Error(
            `连不上 ${settings.aiBaseUrl}。请检查地址是否正确、服务是否在运行，以及是否已在设置页授权。`,
          );
          network.code = "AI_NETWORK_ERROR";
          throw network;
        }
        throw error;
      } finally {
        externalSignal?.removeEventListener("abort", onExternalAbort);
        clearTimeout(idleTimer);
        clearTimeout(hardTimer);
      }
    }

    /** 边读边计字节数，避免异常大的响应把内存吃满。 */
    async function readBoundedAiResponse(response, onActivity) {
      const reader = response.body?.getReader?.();
      if (!reader) {
        const text = await response.text();
        onActivity();
        return parseResponseEnvelope(text);
      }

      const decoder = new TextDecoder();
      let text = "";
      let bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        onActivity();
        bytes += value?.byteLength ?? 0;
        if (bytes > maxResponseBytes) {
          await reader.cancel?.().catch(() => {});
          const error = new Error("响应超过 2 MiB 上限。");
          error.code = "AI_RESPONSE_TOO_LARGE";
          throw error;
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      return parseResponseEnvelope(text);
    }

    return {
      requestAiCompletion,
      sendAiRequest,
      readBoundedAiResponse,
      // 模块级函数一并从工厂透出，调用方解构成同名别名即可无缝替换旧定义。
      aiErrorResponse,
      throwIfTaskCanceled,
      taskCanceledError,
    };
  }

  /** 把模型服务的错误翻译成用户能看懂、且知道下一步该干什么的提示。 */
  function aiErrorResponse(error) {
    // 这几类都要用户去设置页动手，原样透出提示即可。
    const actionable = [
      "NO_AI_CONFIG",
      "NEED_HOST_PERMISSION",
      "INVALID_BASE_URL",
      "AI_NETWORK_ERROR",
    ];
    if (error.code === "TASK_CANCELED") {
      return { success: false, error: "TASK_CANCELED", message: "任务已取消。" };
    }
    if (actionable.includes(error.code)) {
      return { success: false, error: error.code, message: error.message };
    }
    if (error.status === 401 || error.status === 403) {
      return {
        success: false,
        error: "INVALID_AI_KEY",
        message: "服务拒绝了这个密钥，请在设置里检查密钥和地址是否匹配。",
      };
    }
    if (error.status === 404) {
      return {
        success: false,
        error: "MODEL_OR_ENDPOINT_NOT_FOUND",
        message: "服务返回 404，多半是模型名写错或 API 地址不对，请到设置页核对。",
      };
    }
    if (error.status === 429) {
      return {
        success: false,
        error: "RATE_LIMITED",
        message: "服务限流了，稍等一会儿再试。",
      };
    }
    return {
      success: false,
      error: error.code || "AI_REQUEST_FAILED",
      message: error.message || "AI 请求失败。",
    };
  }

  return {
    createAiTransport,
    aiErrorResponse,
    taskCanceledError,
    throwIfTaskCanceled,
    repairTruncatedJson,
    OUTPUT_TOKENS_CEILING,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = BILI_AI_TRANSPORT;
}
