const test = require("node:test");
const assert = require("node:assert/strict");

const TRANSPORT = require("../lib/ai-transport.js");
const SETTINGS = require("../settings.js");

function makeSettings(overrides = {}) {
  return SETTINGS.normalize({
    presetId: "custom",
    protocol: SETTINGS.PROTOCOLS.OPENAI,
    aiApiKey: "test-key",
    aiBaseUrl: "https://api.example.com/v1",
    aiModel: "test-model",
    aiConcurrency: 1,
    aiTimeoutSeconds: 30,
    ...overrides,
  });
}

function makeTransport(fetchImpl, overrides = {}) {
  return TRANSPORT.createAiTransport({
    getSettings: async () => makeSettings(),
    ensureHostPermission: async () => {},
    idleTimeoutMs: 80,
    ...overrides,
    fetch: fetchImpl,
  });
}

// 纯对象响应（没有 body 流），readBoundedAiResponse 会走 response.text() 分支。
function openaiReply(content, extra = {}) {
  return {
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        choices: [{ message: { content }, ...extra }],
      }),
  };
}

function collectRequests(log) {
  return async (url, { body } = {}) => {
    log.push(JSON.parse(body));
    return openaiReply("");
  };
}

const MESSAGES = [{ role: "user", content: "你好" }];

// ============================================================
// requestAiCompletion：配置检查与正常路径
// ============================================================

test("正常请求返回模型文本与本次设置", async () => {
  const t = makeTransport(async () => openaiReply("模型的话"));
  const result = await t.requestAiCompletion({
    messages: MESSAGES,
    maxTokens: 512,
  });
  assert.equal(result.text, "模型的话");
  assert.equal(result.settings.aiModel, "test-model");
});

test("配置不完整时拒绝请求，不发起网络调用", async () => {
  let called = 0;
  const t = TRANSPORT.createAiTransport({
    getSettings: async () => SETTINGS.normalize({}),
    ensureHostPermission: async () => {},
    fetch: async () => {
      called += 1;
      return openaiReply("x");
    },
  });

  await assert.rejects(
    () => t.requestAiCompletion({ messages: MESSAGES, maxTokens: 1 }),
    { code: "NO_AI_CONFIG" },
  );
  assert.equal(called, 0);
});

test("缺少主机权限时原样透出，提示用户去设置页授权", async () => {
  const permissionError = new Error("请先授权");
  permissionError.code = "NEED_HOST_PERMISSION";
  const t = TRANSPORT.createAiTransport({
    getSettings: async () => makeSettings(),
    ensureHostPermission: async () => {
      throw permissionError;
    },
    fetch: async () => openaiReply("x"),
  });

  await assert.rejects(
    () => t.requestAiCompletion({ messages: MESSAGES, maxTokens: 1 }),
    (error) => error === permissionError,
  );
});

// ============================================================
// 空响应自愈
// ============================================================

test("JSON 模式返回空时脱掉 response_format 重试一次", async () => {
  const requests = [];
  const t = makeTransport(collectRequests(requests));

  await assert.rejects(
    () =>
      t.requestAiCompletion({
        messages: MESSAGES,
        maxTokens: 100,
        responseFormat: { type: "json_object" },
      }),
    { code: "EMPTY_AI_RESPONSE" },
  );

  assert.equal(requests.length, 2);
  assert.ok(requests[0].response_format, "第一轮带 JSON 模式");
  assert.equal(requests[1].response_format, undefined, "第二轮已脱掉");
});

test("输出被截断时按四倍放大预算，直到天花板", async () => {
  const requests = [];
  const t = makeTransport(async (url, { body } = {}) => {
    requests.push(JSON.parse(body));
    return openaiReply("", { finish_reason: "length" });
  });

  await assert.rejects(() =>
    t.requestAiCompletion({ messages: MESSAGES, maxTokens: 100 })
  );

  assert.deepEqual(
    requests.map((request) => request.max_tokens),
    [100, 400, 1600],
  );
});

test("预算已到天花板就不再加码，两轮后放弃", async () => {
  const requests = [];
  const t = makeTransport(async (url, { body } = {}) => {
    requests.push(JSON.parse(body));
    return openaiReply("", { finish_reason: "length" });
  });

  await assert.rejects(
    () =>
      t.requestAiCompletion({
        messages: MESSAGES,
        maxTokens: TRANSPORT.OUTPUT_TOKENS_CEILING - 1000,
      }),
    (error) => error.reason === "TRUNCATED",
  );

  assert.deepEqual(
    requests.map((request) => request.max_tokens),
    [TRANSPORT.OUTPUT_TOKENS_CEILING - 1000, TRANSPORT.OUTPUT_TOKENS_CEILING],
  );
});

// ============================================================
// 超时、取消与响应大小（直接驱动 sendAiRequest）
// ============================================================

function makeHangingFetch() {
  return (url, { signal } = {}) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }
      signal?.addEventListener("abort", () => reject(new Error("aborted")), {
        once: true,
      });
    });
}

test("硬超时：模型迟迟不吐响应头，按可配上限中止", async () => {
  const t = makeTransport(makeHangingFetch(), { getSettings: async () => ({}) });
  await assert.rejects(
    () =>
      t.sendAiRequest(
        { aiBaseUrl: "https://api.example.com", aiTimeoutSeconds: 0.05 },
        { url: "https://api.example.com/v1/chat", headers: {}, body: {} },
      ),
    { code: "AI_HARD_TIMEOUT" },
  );
});

test("空闲超时：响应头到了但 body 断流，单独判罚", async () => {
  // 响应头立刻到达；body 的 read 在 abort 前永远挂起（与真实 fetch 一致，
  // abort 会让未决的 read 以拒绝收场）。
  const stalled = (url, { signal } = {}) => ({
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          read: () =>
            new Promise((resolve, reject) => {
              if (signal?.aborted) {
                reject(new Error("aborted"));
                return;
              }
              signal?.addEventListener(
                "abort",
                () => reject(new Error("aborted")),
                { once: true },
              );
            }),
          cancel: async () => {},
        };
      },
    },
    text: () => new Promise(() => {}),
  });
  const t = makeTransport(stalled, { getSettings: async () => ({}) });

  await assert.rejects(
    () =>
      t.sendAiRequest(
        { aiBaseUrl: "https://api.example.com", aiTimeoutSeconds: 30 },
        { url: "https://api.example.com/v1/chat", headers: {}, body: {} },
      ),
    { code: "AI_IDLE_TIMEOUT" },
  );
});

test("外部取消优先于一切超时，报 TASK_CANCELED", async () => {
  const controller = new AbortController();
  const t = makeTransport(makeHangingFetch(), { getSettings: async () => ({}) });
  const pending = t.sendAiRequest(
    { aiBaseUrl: "https://api.example.com", aiTimeoutSeconds: 30 },
    { url: "https://api.example.com/v1/chat", headers: {}, body: {} },
    controller.signal,
  );
  controller.abort();
  await assert.rejects(() => pending, { code: "TASK_CANCELED" });
});

test("流式读取超过大小上限时中止并报错", async () => {
  const encoder = new TextEncoder();
  const chunk = encoder.encode("0123456789");
  const big = {
    ok: true,
    status: 200,
    body: {
      getReader() {
        let reads = 0;
        return {
          async read() {
            reads += 1;
            return reads > 5 ? { done: true } : { done: false, value: chunk };
          },
          cancel: async () => {},
        };
      },
    },
  };
  const t = makeTransport(async () => big, {
    getSettings: async () => ({}),
    maxResponseBytes: 32,
  });

  await assert.rejects(
    () =>
      t.sendAiRequest(
        { aiBaseUrl: "https://api.example.com", aiTimeoutSeconds: 30 },
        { url: "https://api.example.com/v1/chat", headers: {}, body: {} },
      ),
    { code: "AI_RESPONSE_TOO_LARGE" },
  );
});

// ============================================================
// 错误翻译
// ============================================================

test("网络层 TypeError 翻译成带下一步指引的提示", async () => {
  const t = makeTransport(async () => {
    throw new TypeError("Failed to fetch");
  }, { getSettings: async () => ({}) });

  await assert.rejects(
    () =>
      t.sendAiRequest(
        { aiBaseUrl: "https://api.example.com", aiTimeoutSeconds: 30 },
        { url: "https://api.example.com/v1/chat", headers: {}, body: {} },
      ),
    { code: "AI_NETWORK_ERROR" },
  );
});

test("HTTP 状态映射成用户能行动的错误码", () => {
  assert.equal(aiError({ status: 401 }).error, "INVALID_AI_KEY");
  assert.equal(aiError({ status: 403 }).error, "INVALID_AI_KEY");
  assert.equal(aiError({ status: 404 }).error, "MODEL_OR_ENDPOINT_NOT_FOUND");
  assert.equal(aiError({ status: 429 }).error, "RATE_LIMITED");
  assert.equal(aiError({}).error, "AI_REQUEST_FAILED");

  function aiError(props) {
    return TRANSPORT.aiErrorResponse(Object.assign(new Error("x"), props));
  }
});
