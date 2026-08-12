const test = require("node:test");
const assert = require("node:assert/strict");

const settings = require("../settings.js");

const { PROTOCOLS } = settings;

/**
 * 只有「自定义」预设才认外部传入的地址与协议，其余预设一律用自己写死的那套。
 * 想单独验端点拼接逻辑的用例，得先声明自己是自定义配置。
 */
const custom = (overrides) => ({
  presetId: settings.CUSTOM_PRESET_ID,
  ...overrides,
});

// ============================================================
// base_url 校验
// ============================================================

test("接受 https 地址并去掉尾部斜杠", () => {
  const result = settings.validateBaseUrl("https://api.deepseek.com/");
  assert.equal(result.ok, true);
  assert.equal(result.url, "https://api.deepseek.com");
  assert.equal(result.origin, "https://api.deepseek.com/");
});

test("保留路径中的版本号", () => {
  assert.equal(
    settings.validateBaseUrl("https://api.openai.com/v1").url,
    "https://api.openai.com/v1",
  );
  assert.equal(
    settings.validateBaseUrl("https://dashscope.aliyuncs.com/compatible-mode/v1").url,
    "https://dashscope.aliyuncs.com/compatible-mode/v1",
  );
});

test("粘进来的完整端点会被还原成 base", () => {
  assert.equal(
    settings.validateBaseUrl("https://api.openai.com/v1/chat/completions").url,
    "https://api.openai.com/v1",
  );
  assert.equal(
    settings.validateBaseUrl(
      "https://api.anthropic.com/v1/messages",
      PROTOCOLS.ANTHROPIC,
    ).url,
    "https://api.anthropic.com",
  );
});

test("Anthropic 协议下 base 里多余的 /v1 会被去掉，避免拼成 /v1/v1/messages", () => {
  const result = settings.validateBaseUrl(
    "https://api.anthropic.com/v1",
    PROTOCOLS.ANTHROPIC,
  );
  assert.equal(result.url, "https://api.anthropic.com");
  assert.equal(
    settings.chatCompletionsUrl(
      custom({
        protocol: PROTOCOLS.ANTHROPIC,
        aiBaseUrl: "https://api.anthropic.com/v1",
        aiModel: "m",
      }),
    ),
    "https://api.anthropic.com/v1/messages",
  );
});

test("明文 http 只对本机放行", () => {
  assert.equal(settings.validateBaseUrl("http://localhost:11434/v1").ok, true);
  assert.equal(settings.validateBaseUrl("http://127.0.0.1:8000/v1").ok, true);

  const remote = settings.validateBaseUrl("http://api.example.com/v1");
  assert.equal(remote.ok, false);
  assert.match(remote.error, /https/);
});

test("拒绝非 http(s) 协议与非法 URL", () => {
  for (const bad of [
    "ftp://example.com",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "not a url",
    "",
  ]) {
    assert.equal(settings.validateBaseUrl(bad).ok, false, `不该接受：${bad}`);
  }
});

test("originOf 产出可直接用于权限申请的来源", () => {
  assert.equal(
    settings.originOf("https://api.openai.com/v1"),
    "https://api.openai.com/",
  );
  assert.equal(
    settings.originOf("http://localhost:11434/v1"),
    "http://localhost:11434/",
  );
  assert.equal(settings.originOf("不是地址"), null);
});

// ============================================================
// 端点拼接
// ============================================================

test("两种协议拼出各自的对话端点", () => {
  assert.equal(
    settings.chatCompletionsUrl(
      custom({
        protocol: PROTOCOLS.OPENAI,
        aiBaseUrl: "https://api.deepseek.com",
        aiModel: "m",
      }),
    ),
    "https://api.deepseek.com/chat/completions",
  );
  assert.equal(
    settings.chatCompletionsUrl(
      custom({
        protocol: PROTOCOLS.ANTHROPIC,
        aiBaseUrl: "https://api.anthropic.com",
        aiModel: "m",
      }),
    ),
    "https://api.anthropic.com/v1/messages",
  );
});

test("两种协议拼出各自的模型列表端点", () => {
  assert.equal(
    settings.modelsUrl(
      custom({
        protocol: PROTOCOLS.OPENAI,
        aiBaseUrl: "https://api.openai.com/v1",
        aiModel: "m",
      }),
    ),
    "https://api.openai.com/v1/models",
  );
  assert.equal(
    settings.modelsUrl(
      custom({
        protocol: PROTOCOLS.ANTHROPIC,
        aiBaseUrl: "https://api.anthropic.com",
        aiModel: "m",
      }),
    ),
    "https://api.anthropic.com/v1/models",
  );
});

test("地址非法时端点返回 null 而不是拼出一个坏 URL", () => {
  assert.equal(
    settings.chatCompletionsUrl(custom({ aiBaseUrl: "http://evil.example.com" })),
    null,
  );
});

// ============================================================
// 归一化
// ============================================================

test("默认配置是 DeepSeek，且模型名是实测验证过的那个", () => {
  const normalized = settings.normalize({});
  assert.equal(normalized.presetId, "deepseek");
  assert.equal(normalized.protocol, PROTOCOLS.OPENAI);
  assert.equal(normalized.aiBaseUrl, "https://api.deepseek.com");
  assert.equal(normalized.aiModel, "deepseek-v4-flash");
});

test("用户自定义的地址与模型会被保留，不再被强制覆盖", () => {
  const normalized = settings.normalize({
    presetId: "custom",
    protocol: PROTOCOLS.OPENAI,
    aiApiKey: "  sk-test  ",
    aiBaseUrl: "  https://my-proxy.example.com/v1/  ",
    aiModel: "  my-model  ",
  });
  assert.equal(normalized.protocol, PROTOCOLS.OPENAI);
  assert.equal(normalized.aiApiKey, "sk-test");
  assert.equal(normalized.aiBaseUrl, "https://my-proxy.example.com/v1");
  assert.equal(normalized.aiModel, "my-model");
});

test("Anthropic 兼容代理：剥掉 /v1 再拼回去，最终端点不变", () => {
  // 存的是剥掉 /v1 的形式，但用户填的和最终请求的地址是一致的，
  // 所以这个规整对用户不可见——除非它把两头搞反，那就会拼出 /v1/v1/messages。
  const normalized = settings.normalize({
    presetId: "custom",
    protocol: PROTOCOLS.ANTHROPIC,
    aiApiKey: "k",
    aiBaseUrl: "https://my-proxy.example.com/v1",
    aiModel: "m",
  });
  assert.equal(normalized.aiBaseUrl, "https://my-proxy.example.com");
  assert.equal(
    settings.chatCompletionsUrl(normalized),
    "https://my-proxy.example.com/v1/messages",
  );
});

test("选了具体厂商时，存量的地址与协议一律让位给预设", () => {
  // 设置页把这两栏藏了起来，输入框里很可能还留着上次自定义的值。
  // 如果存量值能盖过预设，用户就会拿着 A 家的密钥去打 B 家的接口。
  const normalized = settings.normalize({
    presetId: "deepseek",
    protocol: PROTOCOLS.ANTHROPIC,
    aiBaseUrl: "https://leftover-proxy.example.com/v1",
    aiApiKey: "sk-test",
    aiModel: "deepseek-v4-flash",
  });
  assert.equal(normalized.aiBaseUrl, "https://api.deepseek.com");
  assert.equal(normalized.protocol, PROTOCOLS.OPENAI);
  assert.equal(
    settings.chatCompletionsUrl(normalized),
    "https://api.deepseek.com/chat/completions",
  );
});

test("厂商换域名时，老用户跟着预设走而不是被存量值钉死", () => {
  const anthropic = settings.normalize({
    presetId: "anthropic",
    aiBaseUrl: "https://api.anthropic.com/v1/messages",
    aiApiKey: "k",
    aiModel: "m",
  });
  assert.equal(anthropic.aiBaseUrl, "https://api.anthropic.com");
  assert.equal(anthropic.protocol, PROTOCOLS.ANTHROPIC);
});

test("只有「自定义」才认用户填的地址与协议", () => {
  const normalized = settings.normalize({
    presetId: settings.CUSTOM_PRESET_ID,
    protocol: PROTOCOLS.ANTHROPIC,
    aiBaseUrl: "https://my-proxy.example.com",
    aiApiKey: "k",
    aiModel: "m",
  });
  assert.equal(normalized.aiBaseUrl, "https://my-proxy.example.com");
  assert.equal(normalized.protocol, PROTOCOLS.ANTHROPIC);
});

test("自定义时不填地址会落到空值，由 validate 报错而不是静默用 DeepSeek", () => {
  const normalized = settings.normalize({
    presetId: settings.CUSTOM_PRESET_ID,
    aiApiKey: "k",
    aiModel: "m",
  });
  assert.equal(normalized.aiBaseUrl, "");
  assert.equal(settings.validate(normalized).ok, false);
});

test("换预设时模型回落到该预设的默认值", () => {
  // DeepSeek 是唯一带默认模型的预设
  assert.equal(settings.normalize({ presetId: "deepseek" }).aiModel, "deepseek-v4-flash");
  // 其余预设没有默认模型，应当留空让用户去拉取
  assert.equal(settings.normalize({ presetId: "openai" }).aiModel, "");
});

test("未知的协议或预设回落到默认值", () => {
  const normalized = settings.normalize({
    presetId: "不存在的服务商",
    protocol: "不存在的协议",
  });
  assert.equal(normalized.presetId, "deepseek");
  assert.equal(normalized.protocol, PROTOCOLS.OPENAI);
});

test("非法地址原样保留，交给设置页报错，而不是悄悄改回默认值", () => {
  const normalized = settings.normalize({
    presetId: "custom",
    aiBaseUrl: "http://api.example.com",
  });
  assert.equal(normalized.aiBaseUrl, "http://api.example.com");
  assert.equal(settings.validate(normalized).ok, false);
});

test("normalize 能接受 null 与非对象输入", () => {
  assert.equal(settings.normalize(null).presetId, "deepseek");
  assert.equal(settings.normalize("字符串").presetId, "deepseek");
  assert.equal(settings.normalize(undefined).aiApiKey, "");
});

// ============================================================
// 配置校验
// ============================================================

test("远程服务缺密钥或缺模型都算没配好", () => {
  const noKey = settings.validate({
    presetId: "custom",
    aiBaseUrl: "https://api.example.com/v1",
    aiModel: "m",
  });
  assert.equal(noKey.ok, false);
  assert.match(noKey.errors.join(""), /密钥/);

  const noModel = settings.validate({
    presetId: "custom",
    aiBaseUrl: "https://api.example.com/v1",
    aiApiKey: "k",
  });
  assert.equal(noModel.ok, false);
  assert.match(noModel.errors.join(""), /模型/);
});

test("本地服务允许不填密钥", () => {
  const local = settings.validate({
    presetId: "ollama",
    aiBaseUrl: "http://localhost:11434/v1",
    aiModel: "qwen3",
  });
  assert.equal(local.ok, true, local.errors.join(" "));
});

test("配置齐全时通过校验", () => {
  const ok = settings.validate({
    presetId: "deepseek",
    aiApiKey: "sk-test",
    aiBaseUrl: "https://api.deepseek.com",
    aiModel: "deepseek-v4-flash",
  });
  assert.equal(ok.ok, true, ok.errors.join(" "));
});

// ============================================================
// 并发与超时
// ============================================================

test("并发与超时有合理的默认值", () => {
  const normalized = settings.normalize({});
  assert.equal(normalized.aiConcurrency, settings.LIMITS.concurrency.default);
  assert.equal(normalized.aiTimeoutSeconds, settings.LIMITS.timeoutSeconds.default);
});

test("并发与超时被夹在允许范围内", () => {
  const tooBig = settings.normalize({ aiConcurrency: 999, aiTimeoutSeconds: 99999 });
  assert.equal(tooBig.aiConcurrency, settings.LIMITS.concurrency.max);
  assert.equal(tooBig.aiTimeoutSeconds, settings.LIMITS.timeoutSeconds.max);

  const tooSmall = settings.normalize({ aiConcurrency: 0, aiTimeoutSeconds: 1 });
  assert.equal(tooSmall.aiConcurrency, settings.LIMITS.concurrency.min);
  assert.equal(tooSmall.aiTimeoutSeconds, settings.LIMITS.timeoutSeconds.min);
});

test("并发数为负或非数值时回落到默认值，而不是变成 0 把任务卡死", () => {
  for (const bad of [undefined, null, "", "abc", NaN, {}]) {
    assert.equal(
      settings.normalize({ aiConcurrency: bad }).aiConcurrency,
      settings.LIMITS.concurrency.default,
      `aiConcurrency=${JSON.stringify(bad)} 时回落有误`,
    );
  }
  assert.equal(settings.normalize({ aiConcurrency: -3 }).aiConcurrency, 1);
});

test("表单里的字符串数值能被正确接受", () => {
  // input[type=number] 读出来的是字符串
  const normalized = settings.normalize({
    aiConcurrency: "5",
    aiTimeoutSeconds: "300",
  });
  assert.equal(normalized.aiConcurrency, 5);
  assert.equal(normalized.aiTimeoutSeconds, 300);
});

test("小数被向下取整", () => {
  assert.equal(settings.normalize({ aiConcurrency: 3.9 }).aiConcurrency, 3);
});

// ============================================================
// 预设
// ============================================================

test("每个预设的地址都能通过自身协议的校验", () => {
  for (const preset of settings.PRESETS) {
    if (!preset.baseUrl) continue; // 「自定义」故意留空
    const result = settings.validateBaseUrl(preset.baseUrl, preset.protocol);
    assert.equal(result.ok, true, `${preset.label} 的地址不合法：${result.error}`);
  }
});

test("预设的协议都在已支持的两种之内", () => {
  const known = Object.values(PROTOCOLS);
  for (const preset of settings.PRESETS) {
    assert.ok(known.includes(preset.protocol), `${preset.label} 的协议不受支持`);
  }
});

test("预设 id 不重复，且包含自定义选项", () => {
  const ids = settings.PRESETS.map((preset) => preset.id);
  assert.equal(new Set(ids).size, ids.length, "预设 id 有重复");
  assert.ok(ids.includes("custom"));
});

test("除已验证过的 DeepSeek 外，预设不写死模型名", () => {
  for (const preset of settings.PRESETS) {
    if (preset.id === "deepseek") continue;
    assert.equal(
      preset.model,
      "",
      `${preset.label} 预置了模型名 ${preset.model}，模型换代后会变成过期的默认值`,
    );
  }
});
