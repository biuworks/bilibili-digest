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
  chunkMode: document.getElementById("analysisChunkMode"),
  overlapChars: document.getElementById("analysisOverlapChars"),
  uiFontScale: document.getElementById("uiFontScale"),
};
const customFields = document.getElementById("customFields");
const presetHint = document.getElementById("presetHint");
const endpointPreview = document.getElementById("endpointPreview");
const modelsHint = document.getElementById("modelsHint");
const modelOptions = document.getElementById("modelOptions");
const statusEl = document.getElementById("status");

let statusTimer = null;
let backupStatusTimer = null;

// 拉取模型列表 / 测试连接直连用户配置的端点，不走后台的超时与重试；
// 端点挂起时至少要能自己停下来，不能让状态永远停在「正在…」。
async function fetchWithTimeout(url, init, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

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
    analysisChunkMode: fields.chunkMode.value,
    analysisOverlapChars: fields.overlapChars.value,
    uiFontScale: fields.uiFontScale.value,
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
  modelOptions.value = "";
  modelOptions.hidden = true;
  fields.model.hidden = false;
}

function showModelOptions(models) {
  clearModelOptions();
  const currentModel = fields.model.value;

  // 手填值不在服务端列表里时仍保留为当前选项，不替用户擅自改配置。
  if (currentModel && !models.includes(currentModel)) {
    const current = document.createElement("option");
    current.value = currentModel;
    current.textContent = `${currentModel}（当前）`;
    modelOptions.appendChild(current);
  }

  for (const id of models) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = id;
    modelOptions.appendChild(option);
  }

  const manual = document.createElement("option");
  manual.value = "";
  manual.textContent = "手动填写模型名称…";
  modelOptions.appendChild(manual);

  modelOptions.value = currentModel;
  fields.model.hidden = true;
  modelOptions.hidden = false;
  modelOptions.focus();
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
  fields.chunkMode.value = settings.analysisChunkMode;
  fields.overlapChars.value = settings.analysisOverlapChars;
  fields.uiFontScale.value = settings.uiFontScale;
  BILI_SETTINGS.applyUiFontScale(settings.uiFontScale);

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
    showStatus(`未获得 ${origin} 的访问权限，AI 功能将无法使用。`, {
      sticky: true,
    });
    return false;
  }

  await chrome.storage.local.set({ [BILI_SETTINGS.STORAGE_KEY]: settings });
  // 越界的数值会被 normalize 夹回范围内，把结果写回表单，避免显示与实际不符。
  fields.concurrency.value = settings.aiConcurrency;
  fields.timeout.value = settings.aiTimeoutSeconds;
  fields.chunkMode.value = settings.analysisChunkMode;
  fields.overlapChars.value = settings.analysisOverlapChars;
  fields.uiFontScale.value = settings.uiFontScale;
  showStatus("已保存并授权");
  return true;
}

// ============================================================
// 拉取模型列表 / 测试连接
// ============================================================

function ensurePermissionInteractive(settings) {
  const origin = BILI_SETTINGS.originOf(settings.aiBaseUrl);
  if (!origin) {
    showStatus("API 地址不合法。", { sticky: true });
    return Promise.resolve(false);
  }
  // request 必须直接发生在点击调用栈里。已授权的来源会直接返回 true，
  // 不会重复弹窗；避免先 await contains 导致 Edge/Chrome 丢失用户手势。
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
    showStatus("需获得授权后才能访问该地址。", { sticky: true });
    return;
  }

  showStatus("正在获取模型列表…", { sticky: true });
  try {
    const request = BILI_AI_PROVIDER.buildModelsRequest(settings);
    const response = await fetchWithTimeout(request.url, { headers: request.headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      showStatus(
        `获取失败：${BILI_AI_PROVIDER.parseErrorMessage(data, response.status)}`,
        { sticky: true },
      );
      return;
    }

    const models = BILI_AI_PROVIDER.parseModelsResponse(data);
    if (!models.length) {
      showStatus("服务未返回模型列表，请手动填写模型名称。", { sticky: true });
      return;
    }

    // 还没填模型时顺手填第一个，省得用户再去翻列表。
    if (!fields.model.value) fields.model.value = models[0];
    showModelOptions(models);
    modelsHint.textContent = `已获取 ${models.length} 个模型，可直接选择或切换为手动填写。`;
    showStatus("模型列表已更新");
  } catch (error) {
    showStatus(
      error?.name === "AbortError"
        ? "获取超时（30 秒），请检查服务地址或稍后再试。"
        : `获取失败：${error.message}。请检查接口地址与网络连接。`,
      { sticky: true },
    );
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
    showStatus("需获得授权后才能访问该地址。", { sticky: true });
    return;
  }

  showStatus("正在测试连接…", { sticky: true });
  try {
    const request = BILI_AI_PROVIDER.buildChatRequest({
      settings,
      messages: [{ role: "user", content: "回复两个字：可用" }],
      maxTokens: 32,
    });
    const response = await fetchWithTimeout(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      showStatus(
        `测试失败：${BILI_AI_PROVIDER.parseErrorMessage(data, response.status)}`,
        { sticky: true },
      );
      return;
    }

    const text = BILI_AI_PROVIDER.parseChatResponse(settings.protocol, data);
    showStatus(
      text.trim() ? `连接正常，模型返回：${text.trim().slice(0, 30)}` : "连接正常，但返回内容为空。",
      { sticky: true },
    );
  } catch (error) {
    showStatus(
      error?.name === "AbortError"
        ? "测试超时（30 秒），请检查服务地址或稍后再试。"
        : `测试失败：${error.message}。请检查接口地址、协议与网络连接。`,
      { sticky: true },
    );
  }
}

function showBackupStatus(text, { sticky = false } = {}) {
  const node = document.getElementById("backupStatus");
  node.textContent = text;
  // 与主状态区各用各的计时器：共用一个会互相清掉对方的消息，留下永远
  // 不消失的提示。
  clearTimeout(backupStatusTimer);
  if (!sticky) {
    backupStatusTimer = setTimeout(() => {
      node.textContent = "";
    }, 4000);
  }
}

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

async function exportBackup() {
  try {
    const result = await chrome.runtime.sendMessage({ action: "exportLearningBackup" });
    if (!result?.success || !result.backup) {
      showBackupStatus(result?.message || "导出失败。", { sticky: true });
      return;
    }
    downloadJson(result.backup, "bilibili-digest-backup.json");
    showBackupStatus(
      `已导出 ${result.backup.notes.length} 条笔记、${result.backup.learning.length} 份概览。`,
    );
  } catch (error) {
    showBackupStatus(`导出失败：${error.message}`, { sticky: true });
  }
}

async function importBackupFromFile(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  let payload;
  try {
    payload = JSON.parse(await file.text());
  } catch (error) {
    showBackupStatus("无法解析该文件，请确认为本扩展导出的 JSON 备份。", { sticky: true });
    return;
  }
  if (!window.confirm("确认将备份合并至本机数据？相同条目以更新时间较新者为准，本机独有的笔记不会被删除，API 密钥不受影响。")) {
    return;
  }
  try {
    const result = await chrome.runtime.sendMessage({
      action: "importLearningBackup",
      backup: payload,
    });
    if (!result?.success) {
      showBackupStatus(result?.message || "恢复失败。", { sticky: true });
      return;
    }
    showBackupStatus(
      `合并完成：新增 ${result.notesAdded} 条笔记，更新 ${result.notesUpdated} 条。`,
    );
  } catch (error) {
    showBackupStatus(`恢复失败：${error.message}`, { sticky: true });
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
modelOptions.addEventListener("change", () => {
  if (modelOptions.value) {
    fields.model.value = modelOptions.value;
    return;
  }
  modelOptions.hidden = true;
  fields.model.hidden = false;
  fields.model.focus();
});

document.getElementById("saveBtn").addEventListener("click", save);
document.getElementById("fetchModelsBtn").addEventListener("click", fetchModels);
document.getElementById("testBtn").addEventListener("click", testConnection);
document.getElementById("backupExportBtn").addEventListener("click", exportBackup);
document.getElementById("backupImportBtn").addEventListener("click", () => {
  document.getElementById("backupImportInput").click();
});
document.getElementById("backupImportInput").addEventListener("change", importBackupFromFile);

for (const input of [fields.baseUrl, fields.apiKey, fields.model]) {
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") save();
  });
}

async function saveUiFontScale(writeBack = true) {
  const stored = await chrome.storage.local.get(BILI_SETTINGS.STORAGE_KEY);
  const settings = BILI_SETTINGS.normalize({
    ...stored[BILI_SETTINGS.STORAGE_KEY],
    uiFontScale: fields.uiFontScale.value,
  });
  // 回写输入框只发生在 change（失焦/回车）：input 事件里每敲一键就钳制
  // 回写，会把正在输入的「1」变成 80，用户永远输不进 120。
  if (writeBack) fields.uiFontScale.value = settings.uiFontScale;
  await chrome.storage.local.set({ [BILI_SETTINGS.STORAGE_KEY]: settings });
  BILI_SETTINGS.applyUiFontScale(settings.uiFontScale);
}

fields.uiFontScale.addEventListener("change", () => saveUiFontScale(true));
fields.uiFontScale.addEventListener("input", () => saveUiFontScale(false));

load();
