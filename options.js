/**
 * Bilibili Digest — 设置页（BYOK）。密钥只写 chrome.storage.local，
 * 只发往用户自己填的地址；字幕功能不依赖这里的任何配置。
 * host 权限也在这里申请：chrome.permissions.request 必须在用户手势里调用。
 */

"use strict";

const fields = {
  preset: document.getElementById("preset"),
  protocol: document.getElementById("protocol"),
  baseUrl: document.getElementById("aiBaseUrl"),
  apiKey: document.getElementById("aiApiKey"),
  model: document.getElementById("aiModel"),
  concurrency: document.getElementById("aiConcurrency"),
  timeout: document.getElementById("aiTimeoutSeconds"),
};
const customFields = document.getElementById("customFields");
const presetHint = document.getElementById("presetHint");
const endpointPreview = document.getElementById("endpointPreview");
const modelsHint = document.getElementById("modelsHint");
const modelOptions = document.getElementById("modelOptions");
const statusEl = document.getElementById("status");

let statusTimer = null;

function showStatus(text, { sticky = false } = {}) {
  statusEl.textContent = text;
  clearTimeout(statusTimer);
  if (!sticky) {
    statusTimer = setTimeout(() => {
      statusEl.textContent = "";
    }, 4000);
  }
}

// ============================================================
// 表单
// ============================================================

function fillPresets() {
  for (const preset of BILI_SETTINGS.PRESETS) {
    const option = document.createElement("option");
    option.value = preset.id;
    option.textContent = preset.label;
    fields.preset.appendChild(option);
  }
}

const isCustomPreset = () =>
  fields.preset.value === BILI_SETTINGS.CUSTOM_PRESET_ID;

function currentSettings() {
  // 选了具体厂商时不提交协议与地址：这两栏藏着，可能还留着上次自定义的旧值。
  const custom = isCustomPreset();
  return BILI_SETTINGS.normalize({
    presetId: fields.preset.value,
    protocol: custom ? fields.protocol.value : undefined,
    aiBaseUrl: custom ? fields.baseUrl.value : undefined,
    aiApiKey: fields.apiKey.value,
    aiModel: fields.model.value,
    aiConcurrency: fields.concurrency.value,
    aiTimeoutSeconds: fields.timeout.value,
  });
}

function updateEndpointPreview() {
  endpointPreview.textContent =
    fields.protocol.value === BILI_SETTINGS.PROTOCOLS.ANTHROPIC
      ? "/v1/messages"
      : "/chat/completions";
}

// 厂商预设的协议与地址是写死的，不摆在界面上占地方。
function toggleCustomFields() {
  customFields.hidden = !isCustomPreset();
}

function applyPreset(presetId) {
  const preset = BILI_SETTINGS.presetById(presetId);
  if (!preset) return;

  // 「自定义」不该把用户已经填好的地址和模型清空。
  if (preset.id !== BILI_SETTINGS.CUSTOM_PRESET_ID) {
    fields.protocol.value = preset.protocol;
    fields.baseUrl.value = preset.baseUrl;
    fields.model.value = preset.model;
  }
  toggleCustomFields();
  presetHint.textContent = "";
  if (preset.docsUrl) {
    const link = document.createElement("a");
    link.href = preset.docsUrl;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = "获取密钥 →";
    presetHint.appendChild(link);
  }
  updateEndpointPreview();
  clearModelOptions();
}

function clearModelOptions() {
  modelOptions.textContent = "";
}

async function load() {
  fillPresets();
  const stored = await chrome.storage.local.get(BILI_SETTINGS.STORAGE_KEY);
  const settings = BILI_SETTINGS.normalize(stored[BILI_SETTINGS.STORAGE_KEY]);

  fields.preset.value = settings.presetId;
  fields.protocol.value = settings.protocol;
  fields.baseUrl.value = settings.aiBaseUrl;
  fields.apiKey.value = settings.aiApiKey;
  fields.model.value = settings.aiModel;
  fields.concurrency.value = settings.aiConcurrency;
  fields.timeout.value = settings.aiTimeoutSeconds;

  const preset = BILI_SETTINGS.presetById(settings.presetId);
  if (preset?.docsUrl) applyPresetHintOnly(preset);
  toggleCustomFields();
  updateEndpointPreview();
}

// 载入已保存的配置时只补文档链接，不要用预设覆盖用户改过的地址。
function applyPresetHintOnly(preset) {
  presetHint.textContent = "";
  const link = document.createElement("a");
  link.href = preset.docsUrl;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = "获取密钥 →";
  presetHint.appendChild(link);
}

// ============================================================
// 权限
// ============================================================

// 必须在用户手势的同步调用栈里发起，调用方不能在此之前 await 任何东西。
function requestHostPermission(origin) {
  return chrome.permissions.request({ origins: [origin] });
}

// ============================================================
// 保存
// ============================================================

async function save() {
  const settings = currentSettings();
  const check = BILI_SETTINGS.validate(settings);
  if (!check.ok) {
    showStatus(check.errors.join(" "), { sticky: true });
    return false;
  }

  const origin = BILI_SETTINGS.originOf(settings.aiBaseUrl);
  if (!origin) {
    showStatus("API 地址不合法。", { sticky: true });
    return false;
  }

  // 先申请权限：这一步必须紧跟点击，中间不能有 await，否则手势失效。
  let granted = false;
  try {
    granted = await requestHostPermission(origin);
  } catch (error) {
    showStatus(`申请权限失败：${error.message}`, { sticky: true });
    return false;
  }
  if (!granted) {
    showStatus(`没有拿到访问 ${origin} 的权限，AI 功能会用不了。`, {
      sticky: true,
    });
    return false;
  }

  await chrome.storage.local.set({ [BILI_SETTINGS.STORAGE_KEY]: settings });
  // 越界的数值会被 normalize 夹回范围内，把结果写回表单，避免显示与实际不符。
  fields.concurrency.value = settings.aiConcurrency;
  fields.timeout.value = settings.aiTimeoutSeconds;
  showStatus("已保存并授权");
  return true;
}

// ============================================================
// 拉取模型列表 / 测试连接
// ============================================================

async function ensurePermissionInteractive(settings) {
  const origin = BILI_SETTINGS.originOf(settings.aiBaseUrl);
  if (!origin) {
    showStatus("API 地址不合法。", { sticky: true });
    return false;
  }
  if (await chrome.permissions.contains({ origins: [origin] })) return true;
  return requestHostPermission(origin);
}

async function fetchModels() {
  const settings = currentSettings();
  const base = BILI_SETTINGS.validateBaseUrl(settings.aiBaseUrl, settings.protocol);
  if (!base.ok) {
    showStatus(base.error, { sticky: true });
    return;
  }
  if (!(await ensurePermissionInteractive(settings))) {
    showStatus("需要授权才能访问该地址。", { sticky: true });
    return;
  }

  showStatus("正在拉取模型列表…", { sticky: true });
  try {
    const request = BILI_AI_PROVIDER.buildModelsRequest(settings);
    const response = await fetch(request.url, { headers: request.headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      showStatus(
        `拉取失败：${BILI_AI_PROVIDER.parseErrorMessage(data, response.status)}`,
        { sticky: true },
      );
      return;
    }

    const models = BILI_AI_PROVIDER.parseModelsResponse(data);
    if (!models.length) {
      showStatus("服务没有返回模型列表，请手动填写模型名。", { sticky: true });
      return;
    }

    clearModelOptions();
    for (const id of models) {
      const option = document.createElement("option");
      option.value = id;
      modelOptions.appendChild(option);
    }
    // 还没填模型时顺手填第一个，省得用户再去翻列表。
    if (!fields.model.value) fields.model.value = models[0];
    modelsHint.textContent = `拿到 ${models.length} 个模型，点输入框可以下拉选择。`;
    showStatus("模型列表已更新");
  } catch (error) {
    showStatus(`拉取失败：${error.message}。请检查地址和网络。`, { sticky: true });
  }
}

async function testConnection() {
  const settings = currentSettings();
  const check = BILI_SETTINGS.validate(settings);
  if (!check.ok) {
    showStatus(check.errors.join(" "), { sticky: true });
    return;
  }
  if (!(await ensurePermissionInteractive(settings))) {
    showStatus("需要授权才能访问该地址。", { sticky: true });
    return;
  }

  showStatus("正在测试…", { sticky: true });
  try {
    const request = BILI_AI_PROVIDER.buildChatRequest({
      settings,
      messages: [{ role: "user", content: "回复两个字：可用" }],
      maxTokens: 32,
    });
    const response = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      showStatus(
        `失败：${BILI_AI_PROVIDER.parseErrorMessage(data, response.status)}`,
        { sticky: true },
      );
      return;
    }

    const text = BILI_AI_PROVIDER.parseChatResponse(settings.protocol, data);
    showStatus(
      text.trim() ? `连接正常，模型回复：${text.trim().slice(0, 30)}` : "连接正常，但返回为空。",
      { sticky: true },
    );
  } catch (error) {
    showStatus(`失败：${error.message}。请检查地址、协议和网络。`, { sticky: true });
  }
}

// ============================================================
// 事件
// ============================================================

fields.preset.addEventListener("change", () => applyPreset(fields.preset.value));
fields.protocol.addEventListener("change", () => {
  updateEndpointPreview();
  clearModelOptions();
});
fields.baseUrl.addEventListener("change", clearModelOptions);

document.getElementById("saveBtn").addEventListener("click", save);
document.getElementById("fetchModelsBtn").addEventListener("click", fetchModels);
document.getElementById("testBtn").addEventListener("click", testConnection);

for (const input of [fields.baseUrl, fields.apiKey, fields.model]) {
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") save();
  });
}

load();
