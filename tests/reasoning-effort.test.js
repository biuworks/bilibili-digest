const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SETTINGS = require("../settings.js");
const PROVIDER = require("../lib/ai-provider.js");
const TRANSPORT = require("../lib/ai-transport.js");

const ROOT = path.join(__dirname, "..");
const { PROTOCOLS, REASONING_EFFORTS } = SETTINGS;

function makeSettings(overrides = {}) {
  return SETTINGS.normalize({
    presetId: "custom",
    protocol: PROTOCOLS.OPENAI,
    aiApiKey: "sk-test",
    aiBaseUrl: "https://api.example.com/v1",
    aiModel: "some-model",
    ...overrides,
  });
}

const MESSAGES = [
  { role: "system", content: "你是助理" },
  { role: "user", content: "你好" },
];

// ============================================================
// settings：档位只认已知能力与已知取值
// ============================================================

test("推理强度默认全部关闭", () => {
  const normalized = SETTINGS.normalize({});
  assert.deepEqual(normalized.customReasoningEffort, {});
  assert.equal(SETTINGS.getReasoningEffort(normalized, "qa.md"), REASONING_EFFORTS.OFF);
});

test("未知能力文件与未知档位都被丢掉", () => {
  const normalized = SETTINGS.normalize({
    customReasoningEffort: {
      "qa.md": "high",
      "bogus.md": "high",
      "analysis.md": "turbo",
      "explain.md": "OFF",
    },
  });
  // 只留下合法的那一条；"OFF" 大小写归一后等于 off，不落盘。
  assert.deepEqual(normalized.customReasoningEffort, { "qa.md": "high" });
});

test("能力元数据标出理解类与改写类，供界面给取向提示", () => {
  const byFile = new Map(
    SETTINGS.SYSTEM_PROMPT_CAPABILITIES.map((cap) => [
      cap.file,
      cap.reasoningAdvice,
    ]),
  );
  // 改写类（翻译 / 顺句）提示「通常保持关」。
  assert.equal(byFile.get("translation.md"), "keep-off");
  assert.equal(byFile.get("punctuate.md"), "keep-off");
  // 理解类可以提示「可自行抬档」，但默认值仍然是关。
  assert.equal(byFile.get("analysis.md"), "raise");
  assert.equal(byFile.get("explain.md"), "raise");
  assert.equal(byFile.get("qa.md"), "raise");
  // 每个能力都要有分类，界面才不会漏提示。
  for (const cap of SETTINGS.SYSTEM_PROMPT_CAPABILITIES) {
    assert.ok(cap.reasoningAdvice, `${cap.file} 缺 reasoningAdvice`);
  }
});

test("能力之间的档位互不影响", () => {
  const normalized = SETTINGS.normalize({
    customReasoningEffort: { "qa.md": "high", "analysis.md": "low" },
  });
  assert.equal(SETTINGS.getReasoningEffort(normalized, "qa.md"), "high");
  assert.equal(SETTINGS.getReasoningEffort(normalized, "analysis.md"), "low");
  assert.equal(SETTINGS.getReasoningEffort(normalized, "translation.md"), "off");
});

// ============================================================
// provider：off 必须逐字节等于加这一项之前
// ============================================================

test("档位关闭时 OpenAI 兼容协议请求体与改动前完全一致", () => {
  const request = PROVIDER.buildChatRequest({
    settings: makeSettings(),
    messages: MESSAGES,
    maxTokens: 100,
  });
  assert.deepEqual(request.body, {
    model: "some-model",
    messages: MESSAGES,
    max_tokens: 100,
  });
});

test("档位关闭时 Anthropic 请求体与改动前完全一致", () => {
  const request = PROVIDER.buildChatRequest({
    settings: makeSettings({ presetId: "anthropic", aiModel: "claude-test" }),
    messages: MESSAGES,
    maxTokens: 8000,
    temperature: 0.2,
  });
  // 整体断言，而不是逐项抽查：默认值必须逐字段等于改动前。
  assert.deepEqual(request.body, {
    model: "claude-test",
    max_tokens: 8000,
    messages: [{ role: "user", content: "你好" }],
    thinking: { type: "disabled" },
    system: [
      {
        type: "text",
        text: "你是助理",
        cache_control: { type: "ephemeral" },
      },
    ],
    temperature: 0.2,
  });
});

test("档位关闭时 DeepSeek 请求体与改动前完全一致", () => {
  const request = PROVIDER.buildChatRequest({
    settings: makeSettings({
      presetId: "deepseek",
      aiBaseUrl: "https://api.deepseek.com",
      aiModel: "deepseek-v4-flash",
    }),
    messages: MESSAGES,
    maxTokens: 100,
  });
  assert.deepEqual(request.body, {
    model: "deepseek-v4-flash",
    messages: MESSAGES,
    thinking: { type: "disabled" },
    max_tokens: 100,
  });
});

// ============================================================
// provider：各协议的映射
// ============================================================

test("OpenAI 推理模型按档位转发 reasoning_effort", () => {
  const settings = makeSettings({
    aiBaseUrl: "https://api.openai.com/v1",
    aiModel: "o3-mini",
  });
  for (const level of [REASONING_EFFORTS.LOW, REASONING_EFFORTS.MEDIUM, REASONING_EFFORTS.HIGH]) {
    const request = PROVIDER.buildChatRequest({
      settings,
      messages: MESSAGES,
      maxTokens: 4000,
      reasoningEffort: level,
    });
    assert.equal(request.body.reasoning_effort, level);
  }
});

test("非推理模型不发 reasoning_effort，保持旧请求形状", () => {
  const request = PROVIDER.buildChatRequest({
    settings: makeSettings({ aiModel: "qwen-max" }),
    messages: MESSAGES,
    maxTokens: 4000,
    reasoningEffort: REASONING_EFFORTS.HIGH,
  });
  assert.equal("reasoning_effort" in request.body, false);
  assert.equal(request.body.max_tokens, 4000);
});

test("Anthropic 按档位换算 thinking 预算，并把它加在正文之外", () => {
  const request = PROVIDER.buildChatRequest({
    settings: makeSettings({ presetId: "anthropic", aiModel: "claude-test" }),
    messages: MESSAGES,
    maxTokens: 8000,
    reasoningEffort: REASONING_EFFORTS.HIGH,
  });
  const budget = request.body.thinking.budget_tokens;
  assert.equal(budget, PROVIDER.ANTHROPIC_THINKING_BUDGET.high);
  // 正文仍是 8000，预算加在上面：budget_tokens 恒严格小于 max_tokens。
  assert.equal(request.body.max_tokens, 8000 + budget);
});

test("Anthropic 开着思考时不发自定义温度", () => {
  const request = PROVIDER.buildChatRequest({
    settings: makeSettings({ presetId: "anthropic", aiModel: "claude-test" }),
    messages: MESSAGES,
    maxTokens: 8000,
    temperature: 0.2,
    reasoningEffort: REASONING_EFFORTS.MEDIUM,
  });
  assert.equal("temperature" in request.body, false);
});

test("小请求抬档时不挤占正文", () => {
  // 划词解释只有 1024 token：预算只能加在正文之外，否则正文会被压没。
  const request = PROVIDER.buildChatRequest({
    settings: makeSettings({ presetId: "anthropic", aiModel: "claude-test" }),
    messages: MESSAGES,
    maxTokens: 1024,
    reasoningEffort: REASONING_EFFORTS.HIGH,
  });
  const budget = request.body.thinking.budget_tokens;
  assert.equal(request.body.thinking.type, "enabled");
  assert.equal(request.body.max_tokens - budget, 1024, "正文额度原样保留");
});

test("档位在任何正文额度下都不坍缩成同一个请求", () => {
  // 预算若按正文额度收窄，小请求上低/中/高会撞成同一个值。
  for (const maxTokens of [512, 1024, 2048, 8000]) {
    const budgets = [
      REASONING_EFFORTS.LOW,
      REASONING_EFFORTS.MEDIUM,
      REASONING_EFFORTS.HIGH,
    ].map((reasoningEffort) => {
      const request = PROVIDER.buildChatRequest({
        settings: makeSettings({ presetId: "anthropic", aiModel: "claude-test" }),
        messages: MESSAGES,
        maxTokens,
        reasoningEffort,
      });
      const budget = request.body.thinking.budget_tokens;
      assert.ok(budget < request.body.max_tokens);
      return budget;
    });
    assert.deepEqual(
      budgets,
      [
        PROVIDER.ANTHROPIC_THINKING_BUDGET.low,
        PROVIDER.ANTHROPIC_THINKING_BUDGET.medium,
        PROVIDER.ANTHROPIC_THINKING_BUDGET.high,
      ],
      `maxTokens=${maxTokens}`,
    );
  }
});

test("DeepSeek 只有开关两态，任何非 off 档位都落成 enabled", () => {
  const settings = makeSettings({
    presetId: "deepseek",
    aiBaseUrl: "https://api.deepseek.com",
    aiModel: "deepseek-v4-flash",
  });
  const request = PROVIDER.buildChatRequest({
    settings,
    messages: MESSAGES,
    maxTokens: 100,
    reasoningEffort: REASONING_EFFORTS.LOW,
  });
  assert.deepEqual(request.body.thinking, { type: "enabled" });
});

test("未知厂商不会被塞进未知字段", () => {
  const request = PROVIDER.buildChatRequest({
    settings: makeSettings({ aiBaseUrl: "https://gateway.example.org/v1" }),
    messages: MESSAGES,
    maxTokens: 100,
    reasoningEffort: REASONING_EFFORTS.HIGH,
  });
  assert.equal("thinking" in request.body, false);
  assert.equal("reasoning_effort" in request.body, false);
});

// 上面那条用的是 some-model。推理模型名会单独打开 reasoning_effort，
// 未知主机必须同样不泄漏；对照关闭档的请求体，确认只少这一字段。
test("未知主机上的推理模型开档也不泄漏 reasoning_effort", () => {
  const models = ["o3", "o3-mini", "gpt-5"];
  const levels = [REASONING_EFFORTS.LOW, REASONING_EFFORTS.MEDIUM, REASONING_EFFORTS.HIGH];
  const baseUrls = ["https://gateway.example.org/v1", "https://api.example.com/v1"];
  for (const aiBaseUrl of baseUrls) {
    for (const aiModel of models) {
      for (const reasoningEffort of levels) {
        const opened = PROVIDER.buildChatRequest({
          settings: makeSettings({ aiBaseUrl, aiModel }),
          messages: MESSAGES,
          maxTokens: 128,
          reasoningEffort,
        });
        const closed = PROVIDER.buildChatRequest({
          settings: makeSettings({ aiBaseUrl, aiModel }),
          messages: MESSAGES,
          maxTokens: 128,
        });
        assert.equal(
          "reasoning_effort" in opened.body,
          false,
          `${aiBaseUrl} ${aiModel} ${reasoningEffort}`,
        );
        assert.deepEqual(opened.body, closed.body, `${aiBaseUrl} ${aiModel} ${reasoningEffort}`);
      }
    }
  }
});

test("官方 OpenAI 主机上的推理模型按档位映射 reasoning_effort", () => {
  const models = ["o3", "o3-mini", "gpt-5"];
  const levels = [REASONING_EFFORTS.LOW, REASONING_EFFORTS.MEDIUM, REASONING_EFFORTS.HIGH];
  const baseUrls = [
    "https://api.openai.com/v1",
    "https://API.OPENAI.COM/v1",
    "https://openai.com/v1",
  ];
  for (const aiBaseUrl of baseUrls) {
    for (const aiModel of models) {
      const closed = PROVIDER.buildChatRequest({
        settings: makeSettings({ aiBaseUrl, aiModel }),
        messages: MESSAGES,
        maxTokens: 128,
        reasoningEffort: REASONING_EFFORTS.OFF,
      });
      const omitted = PROVIDER.buildChatRequest({
        settings: makeSettings({ aiBaseUrl, aiModel }),
        messages: MESSAGES,
        maxTokens: 128,
      });
      assert.equal("reasoning_effort" in closed.body, false, `${aiBaseUrl} ${aiModel} off`);
      assert.deepEqual(closed.body, omitted.body, `${aiBaseUrl} ${aiModel} 缺省等于 off`);
      for (const reasoningEffort of levels) {
        const opened = PROVIDER.buildChatRequest({
          settings: makeSettings({ aiBaseUrl, aiModel }),
          messages: MESSAGES,
          maxTokens: 128,
          reasoningEffort,
        });
        assert.equal(opened.body.reasoning_effort, reasoningEffort, `${aiBaseUrl} ${aiModel}`);
        assert.deepEqual(opened.body, { ...closed.body, reasoning_effort: reasoningEffort });
      }
    }
  }
});

test("reasoning_effort 只认解析后的 OpenAI 主机名", () => {
  const deceptive = [
    "https://myopenai.com/v1",
    "https://notopenai.com/v1",
    "https://api.openai.com.evil.example/v1",
    "https://openai.com.evil.example/v1",
    "https://evil.example/api.openai.com/v1",
    "https://evil.example/v1?host=api.openai.com",
    "https://evil.example/v1#api.openai.com",
    "https://api.openai.com@evil.example/v1",
    "https://generativelanguage.googleapis.com/v1beta/openai",
    "https://openrouter.ai/api/v1",
    "https://api.deepseek.com",
    "http://localhost:11434/v1",
  ];
  for (const aiBaseUrl of deceptive) {
    const settings = {
      ...makeSettings({ aiModel: "o3" }),
      aiBaseUrl,
    };
    const request = PROVIDER.buildChatRequest({
      settings,
      messages: MESSAGES,
      maxTokens: 128,
      reasoningEffort: REASONING_EFFORTS.HIGH,
    });
    assert.equal("reasoning_effort" in request.body, false, aiBaseUrl);
  }

  // 用户信息出现在真实主机上时，解析结果仍是 api.openai.com，字段要保留。
  const credentialed = PROVIDER.buildChatRequest({
    settings: {
      ...makeSettings({ aiModel: "gpt-5" }),
      aiBaseUrl: "https://user:secret@api.openai.com/v1",
    },
    messages: MESSAGES,
    maxTokens: 128,
    reasoningEffort: REASONING_EFFORTS.LOW,
  });
  assert.equal(credentialed.body.reasoning_effort, REASONING_EFFORTS.LOW);
});

// ============================================================
// transport：调用方只说「我是谁」，档位由 capability 查表
// ============================================================

test("requestAiCompletion 按 capability 取档位并落到请求体", async () => {
  const bodies = [];
  const transport = TRANSPORT.createAiTransport({
    getSettings: async () =>
      makeSettings({
        aiBaseUrl: "https://api.openai.com/v1",
        aiModel: "o3-mini",
        customReasoningEffort: { "qa.md": "high" },
      }),
    ensureHostPermission: async () => {},
    fetch: async (url, { body } = {}) => {
      bodies.push(JSON.parse(body));
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: "答" } }] }),
      };
    },
  });

  await transport.requestAiCompletion({
    messages: MESSAGES,
    maxTokens: 512,
    capability: "qa.md",
  });
  assert.equal(bodies[0].reasoning_effort, "high");

  // 同一个传输层，换个能力就该回到关闭。
  await transport.requestAiCompletion({
    messages: MESSAGES,
    maxTokens: 512,
    capability: "translation.md",
  });
  assert.equal("reasoning_effort" in bodies[1], false);
});

test("不给 capability 时行为与加这一项之前一致", async () => {
  const bodies = [];
  const transport = TRANSPORT.createAiTransport({
    getSettings: async () => makeSettings({ customReasoningEffort: { "qa.md": "high" } }),
    ensureHostPermission: async () => {},
    fetch: async (url, { body } = {}) => {
      bodies.push(JSON.parse(body));
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: "答" } }] }),
      };
    },
  });

  await transport.requestAiCompletion({ messages: MESSAGES, maxTokens: 512 });
  assert.equal("reasoning_effort" in bodies[0], false);
  assert.equal("thinking" in bodies[0], false);
});

// ============================================================
// 页面：控件存在，且与能力列表一起渲染
// ============================================================

test("管理提示词页提供推理强度控件", () => {
  const html = fs.readFileSync(path.join(ROOT, "prompts.html"), "utf8");
  assert.match(html, /id=["']promptEffort["']/);
  assert.match(html, /id=["']promptEffortHint["']/);
  const script = fs.readFileSync(path.join(ROOT, "prompts.js"), "utf8");
  assert.match(script, /saveReasoningEffort/);
  // 按能力给取向提示，且「恢复默认」联动清推理强度。
  assert.match(script, /reasoningAdvice/);
  assert.match(script, /EFFORT_ADVICE/);
  assert.match(script, /已恢复为内置提示词，推理强度已回到关闭。/);
});
