const test = require("node:test");
const assert = require("node:assert/strict");

const provider = require("../lib/ai-provider.js");
const settings = require("../settings.js");

const { PROTOCOLS } = settings;

const openaiSettings = settings.normalize({
  presetId: "custom",
  protocol: PROTOCOLS.OPENAI,
  aiApiKey: "sk-test",
  aiBaseUrl: "https://api.example.com/v1",
  aiModel: "some-model",
});

const anthropicSettings = settings.normalize({
  presetId: "anthropic",
  protocol: PROTOCOLS.ANTHROPIC,
  aiApiKey: "sk-ant-test",
  aiBaseUrl: "https://api.anthropic.com",
  aiModel: "claude-test",
});

const MESSAGES = [
  { role: "system", content: "你是助理" },
  { role: "user", content: "你好" },
];

// ============================================================
// OpenAI 兼容协议
// ============================================================

test("OpenAI 协议：端点、鉴权头与消息结构", () => {
  const request = provider.buildChatRequest({
    settings: openaiSettings,
    messages: MESSAGES,
    maxTokens: 100,
  });

  assert.equal(request.url, "https://api.example.com/v1/chat/completions");
  assert.equal(request.headers.Authorization, "Bearer sk-test");
  assert.equal(request.body.model, "some-model");
  assert.equal(request.body.max_tokens, 100);
  // system 留在 messages 里，这是与 Anthropic 的关键差异
  assert.deepEqual(request.body.messages, MESSAGES);
});

test("OpenAI 协议：JSON 模式与温度按需附加", () => {
  const withFormat = provider.buildChatRequest({
    settings: openaiSettings,
    messages: MESSAGES,
    maxTokens: 100,
    temperature: 0.2,
    responseFormat: { type: "json_object" },
  });
  assert.deepEqual(withFormat.body.response_format, { type: "json_object" });
  assert.equal(withFormat.body.temperature, 0.2);

  const without = provider.buildChatRequest({
    settings: openaiSettings,
    messages: MESSAGES,
    maxTokens: 100,
  });
  assert.equal("response_format" in without.body, false);
  assert.equal("temperature" in without.body, false);
});

test("OpenAI 协议：从 choices 里取文本", () => {
  assert.equal(
    provider.parseChatResponse(PROTOCOLS.OPENAI, {
      choices: [{ message: { content: "回复内容" } }],
    }),
    "回复内容",
  );
  assert.equal(provider.parseChatResponse(PROTOCOLS.OPENAI, {}), "");
  assert.equal(provider.parseChatResponse(PROTOCOLS.OPENAI, null), "");
});

// ============================================================
// DeepSeek 专属字段的隔离
// ============================================================

test("thinking 字段只发给 DeepSeek", () => {
  const deepseek = settings.normalize({
    aiApiKey: "k",
    aiBaseUrl: "https://api.deepseek.com",
    aiModel: "deepseek-v4-flash",
  });
  const request = provider.buildChatRequest({
    settings: deepseek,
    messages: MESSAGES,
    maxTokens: 100,
  });
  assert.deepEqual(request.body.thinking, { type: "disabled" });
});

test("其它 OpenAI 兼容服务不会收到 DeepSeek 的私有字段", () => {
  const request = provider.buildChatRequest({
    settings: openaiSettings,
    messages: MESSAGES,
    maxTokens: 100,
  });
  assert.equal(
    "thinking" in request.body,
    false,
    "把 DeepSeek 私有字段发给别家服务，可能被判为非法参数而整个请求失败",
  );
});

test("地址非法时 vendorExtras 不抛错", () => {
  assert.deepEqual(provider.vendorExtras("不是地址"), {});
  assert.deepEqual(provider.vendorExtras(""), {});
});

// ============================================================
// Anthropic 协议
// ============================================================

test("Anthropic 协议：端点与三个必需头部", () => {
  const request = provider.buildChatRequest({
    settings: anthropicSettings,
    messages: MESSAGES,
    maxTokens: 100,
  });

  assert.equal(request.url, "https://api.anthropic.com/v1/messages");
  assert.equal(request.headers["x-api-key"], "sk-ant-test");
  assert.equal(request.headers["anthropic-version"], provider.ANTHROPIC_VERSION);
  // 少了这个头，浏览器里的请求会被 CORS 挡掉
  assert.equal(
    request.headers["anthropic-dangerous-direct-browser-access"],
    "true",
  );
  assert.equal(request.headers.Authorization, undefined);
});

test("Anthropic 协议：system 被提到顶层，messages 里不留 system 角色", () => {
  const request = provider.buildChatRequest({
    settings: anthropicSettings,
    messages: MESSAGES,
    maxTokens: 100,
  });

  assert.deepEqual(request.body.system, [
    {
      type: "text",
      text: "你是助理",
      // 顺句/翻译/概览的几十个批次共用同一份系统提示词，
      // 不打这个标记就要为同样的内容付几十次全价 prefill。
      cache_control: { type: "ephemeral" },
    },
  ]);
  assert.deepEqual(request.body.messages, [{ role: "user", content: "你好" }]);
  assert.equal(
    request.body.messages.some((message) => message.role === "system"),
    false,
    "Anthropic 会拒绝 role 为 system 的消息",
  );
});

test("Anthropic 协议：多条 system 合并，没有 system 时不加该字段", () => {
  const merged = provider.splitSystemMessages([
    { role: "system", content: "第一条" },
    { role: "system", content: "第二条" },
    { role: "user", content: "问题" },
  ]);
  assert.equal(merged.system, "第一条\n\n第二条");

  const request = provider.buildChatRequest({
    settings: anthropicSettings,
    messages: [{ role: "user", content: "只有用户消息" }],
    maxTokens: 100,
  });
  assert.equal("system" in request.body, false);
});

test("Anthropic 协议：max_tokens 必带，且不发 response_format", () => {
  const request = provider.buildChatRequest({
    settings: anthropicSettings,
    messages: MESSAGES,
    maxTokens: 256,
    responseFormat: { type: "json_object" },
  });
  assert.equal(request.body.max_tokens, 256);
  assert.equal(
    "response_format" in request.body,
    false,
    "Anthropic 没有这个参数，发过去会报错",
  );
});

test("Anthropic 协议：显式关闭思考", () => {
  const request = provider.buildChatRequest({
    settings: anthropicSettings,
    messages: MESSAGES,
    maxTokens: 100,
  });
  // Anthropic 的 max_tokens 把思考也算在内，思考一旦放开，整份预算可能在
  // 写出第一个字之前就烧光，最终拿到一个 stop_reason 为 max_tokens 的空响应。
  assert.deepEqual(
    request.body.thinking,
    { type: "disabled" },
    "thinking 是 Anthropic 官方参数，不是私有扩展，可以放心发",
  );
});

test("Anthropic 协议：思考关不掉时，仍能从混合内容里取出正文", () => {
  assert.equal(
    provider.parseChatResponse(PROTOCOLS.ANTHROPIC, {
      content: [
        { type: "thinking", thinking: "我先想一下……" },
        { type: "text", text: "正文" },
      ],
    }),
    "正文",
    "取错块会把一次成功的请求判成空响应",
  );
});

test("Anthropic 协议：拼接 content 里的文本块，忽略非文本块", () => {
  assert.equal(
    provider.parseChatResponse(PROTOCOLS.ANTHROPIC, {
      content: [
        { type: "text", text: "前半段" },
        { type: "tool_use", id: "x" },
        { type: "text", text: "后半段" },
      ],
    }),
    "前半段后半段",
  );
  assert.equal(provider.parseChatResponse(PROTOCOLS.ANTHROPIC, {}), "");
});

// ============================================================
// 错误解析
// ============================================================

test("两种协议的错误体都能提取出可读信息", () => {
  assert.equal(
    provider.parseErrorMessage({ error: { message: "余额不足" } }, 400),
    "余额不足",
  );
  assert.equal(
    provider.parseErrorMessage({ error: { type: "invalid_request_error" } }, 400),
    "invalid_request_error",
  );
  assert.equal(provider.parseErrorMessage({ message: "顶层消息" }, 400), "顶层消息");
});

test("错误体畸形时退回状态码描述", () => {
  assert.match(provider.parseErrorMessage(null, 500), /500/);
  assert.match(provider.parseErrorMessage("纯文本", 502), /502/);
  assert.match(provider.parseErrorMessage({}, 404), /404/);
});

// ============================================================
// 空响应诊断
// ============================================================

test("OpenAI 协议收到 Anthropic 形状的响应时，指出协议选反了", () => {
  const result = provider.diagnoseEmptyResponse(PROTOCOLS.OPENAI, {
    content: [{ type: "text", text: "内容" }],
  });
  assert.equal(result.reason, "PROTOCOL_MISMATCH");
  assert.match(result.message, /Anthropic/);
  assert.equal(result.retryWithoutJsonMode, false);
});

test("Anthropic 协议收到 OpenAI 形状的响应时，同样指出协议选反了", () => {
  const result = provider.diagnoseEmptyResponse(PROTOCOLS.ANTHROPIC, {
    choices: [{ message: { content: "内容" } }],
  });
  assert.equal(result.reason, "PROTOCOL_MISMATCH");
  assert.match(result.message, /OpenAI/);
});

test("没有 choices 也不像 Anthropic 时，提示地址可能不是兼容接口", () => {
  const result = provider.diagnoseEmptyResponse(PROTOCOLS.OPENAI, { foo: "bar" });
  assert.equal(result.reason, "NO_CHOICES");
  assert.match(result.message, /地址|接口/);
});

test("被 token 上限截断时，要求加码重试而不是直接放弃", () => {
  const result = provider.diagnoseEmptyResponse(PROTOCOLS.OPENAI, {
    choices: [{ finish_reason: "length", message: { content: "" } }],
  });
  assert.equal(result.reason, "TRUNCATED");
  assert.equal(result.retryWithMoreTokens, true);
  assert.equal(
    result.retryWithoutJsonMode,
    false,
    "截断和 JSON 模式无关，脱掉它只会白跑一轮",
  );
});

test("Anthropic 撞上 max_tokens 时同样要求加码重试", () => {
  const result = provider.diagnoseEmptyResponse(PROTOCOLS.ANTHROPIC, {
    stop_reason: "max_tokens",
  });
  assert.equal(result.reason, "TRUNCATED");
  assert.equal(result.retryWithMoreTokens, true);
});

test("协议选错这类改配置才能解决的问题，不做无谓重试", () => {
  for (const data of [
    { content: [{ type: "text", text: "x" }] },
    { foo: "bar" },
  ]) {
    const result = provider.diagnoseEmptyResponse(PROTOCOLS.OPENAI, data);
    assert.ok(!result.retryWithMoreTokens, `${result.reason} 不该重试`);
    assert.ok(!result.retryWithoutJsonMode, `${result.reason} 不该重试`);
  }
});

test("推理模型把配额花在思考上时，建议换非推理模型", () => {
  const truncated = provider.diagnoseEmptyResponse(PROTOCOLS.OPENAI, {
    choices: [
      { finish_reason: "length", message: { content: "", reasoning_content: "想了很久" } },
    ],
  });
  assert.equal(truncated.reason, "TRUNCATED");
  assert.match(truncated.message, /推理/);

  const reasoningOnly = provider.diagnoseEmptyResponse(PROTOCOLS.OPENAI, {
    choices: [{ finish_reason: "stop", message: { content: "", reasoning: "想了很久" } }],
  });
  assert.equal(reasoningOnly.reason, "REASONING_ONLY");
  assert.equal(reasoningOnly.retryWithoutJsonMode, false);
  assert.ok(
    !reasoningOnly.retryWithMoreTokens,
    "模型自己认为已经说完了，不是预算不够，加码也没用",
  );
});

test("Anthropic 只输出思考块时同样识别为推理占满", () => {
  assert.equal(
    provider.diagnoseEmptyResponse(PROTOCOLS.ANTHROPIC, {
      content: [{ type: "thinking", thinking: "想了很久" }],
    }).reason,
    "REASONING_ONLY",
  );
  assert.equal(
    provider.diagnoseEmptyResponse(PROTOCOLS.ANTHROPIC, { stop_reason: "max_tokens" })
      .reason,
    "TRUNCATED",
  );
});

test("排除其它可能后，才建议脱掉 JSON 模式重试", () => {
  const result = provider.diagnoseEmptyResponse(PROTOCOLS.OPENAI, {
    choices: [{ finish_reason: "stop", message: { content: "" } }],
  });
  assert.equal(result.reason, "EMPTY_CONTENT");
  assert.equal(
    result.retryWithoutJsonMode,
    true,
    "这是上游踩过的坑：JSON 模式偶发返回空串，去掉它重试就好",
  );
});

test("诊断对畸形输入不抛错", () => {
  for (const data of [null, undefined, "字符串", 42, []]) {
    for (const protocol of [PROTOCOLS.OPENAI, PROTOCOLS.ANTHROPIC]) {
      const result = provider.diagnoseEmptyResponse(protocol, data);
      assert.ok(result.reason, `protocol=${protocol} data=${JSON.stringify(data)}`);
      assert.ok(result.message);
    }
  }
});

// ============================================================
// 模型列表
// ============================================================

test("模型列表请求带上各自协议的鉴权头", () => {
  const openai = provider.buildModelsRequest(openaiSettings);
  assert.equal(openai.url, "https://api.example.com/v1/models");
  assert.equal(openai.headers.Authorization, "Bearer sk-test");

  const anthropic = provider.buildModelsRequest(anthropicSettings);
  assert.equal(anthropic.url, "https://api.anthropic.com/v1/models");
  assert.equal(anthropic.headers["x-api-key"], "sk-ant-test");
  assert.equal(
    anthropic.headers["anthropic-dangerous-direct-browser-access"],
    "true",
  );
});

test("模型列表解析兼容 data/models 两种字段与字符串数组", () => {
  assert.deepEqual(
    provider.parseModelsResponse({ data: [{ id: "b-model" }, { id: "a-model" }] }),
    ["a-model", "b-model"],
  );
  assert.deepEqual(
    provider.parseModelsResponse({ models: [{ name: "m1" }] }),
    ["m1"],
  );
  assert.deepEqual(provider.parseModelsResponse({ data: ["x", "y"] }), ["x", "y"]);
});

test("模型列表为空或畸形时返回空数组", () => {
  assert.deepEqual(provider.parseModelsResponse({}), []);
  assert.deepEqual(provider.parseModelsResponse(null), []);
  assert.deepEqual(provider.parseModelsResponse({ data: [{}, { id: "" }] }), []);
});

// ============================================================
// 地址非法时的行为
// ============================================================

test("地址非法时构造请求直接抛错，不会发出一个坏请求", () => {
  const broken = { ...openaiSettings, aiBaseUrl: "http://evil.example.com" };
  assert.throws(() => provider.buildChatRequest({ settings: broken, messages: [], maxTokens: 1 }), /地址/);
  assert.throws(() => provider.buildModelsRequest(broken), /地址/);
});
