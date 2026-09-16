(() => {
  const CAPABILITIES = BILI_SETTINGS.SYSTEM_PROMPT_CAPABILITIES;
  const nav = document.getElementById("promptNav");
  const title = document.getElementById("promptTitle");
  const meta = document.getElementById("promptMeta");
  const body = document.getElementById("promptBody");
  const status = document.getElementById("promptStatus");
  const saveBtn = document.getElementById("promptSaveBtn");
  const restoreBtn = document.getElementById("promptRestoreBtn");

  let currentFile = CAPABILITIES[0]?.file || "analysis.md";
  let savedSnapshot = "";
  let statusTimer = null;
  const customized = new Map();

  function showStatus(text, { sticky = false } = {}) {
    status.textContent = text || "";
    clearTimeout(statusTimer);
    if (!sticky && text) {
      statusTimer = setTimeout(() => {
        status.textContent = "";
      }, 4000);
    }
  }

  function isDirty() {
    return body.value !== savedSnapshot;
  }

  function confirmLeaveIfDirty() {
    if (!isDirty()) return true;
    return window.confirm("当前提示词尚未保存，确认丢弃修改并切换吗？");
  }

  function renderNav() {
    nav.textContent = "";
    for (const item of CAPABILITIES) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.file = item.file;
      if (item.file === currentFile) btn.classList.add("active");
      const label = document.createElement("span");
      label.className = "nav-label";
      label.textContent = item.label;
      const badge = document.createElement("span");
      badge.className = "badge" + (customized.get(item.file) ? " custom" : "");
      badge.textContent = customized.get(item.file) ? "已自定义" : "内置";
      btn.append(label, badge);
      btn.addEventListener("click", () => selectCapability(item.file));
      li.appendChild(btn);
      nav.appendChild(li);
    }
  }

  async function refreshBadges() {
    const result = await chrome.runtime.sendMessage({ action: "listSystemPromptStates" });
    if (!result?.success) {
      showStatus(result?.message || result?.error || "无法读取提示词状态", { sticky: true });
      return;
    }
    customized.clear();
    for (const row of result.items || []) {
      customized.set(row.file, Boolean(row.customized));
    }
    renderNav();
  }

  async function loadCurrent() {
    const item = CAPABILITIES.find((row) => row.file === currentFile) || CAPABILITIES[0];
    title.textContent = item.label;
    showStatus("加载中…", { sticky: true });
    const result = await chrome.runtime.sendMessage({
      action: "getSystemPromptState",
      file: item.file,
    });
    if (!result?.success) {
      showStatus(result?.message || result?.error || "加载失败", { sticky: true });
      return;
    }
    body.value = result.effective || "";
    savedSnapshot = body.value;
    meta.textContent = result.customized
      ? `文件 ${item.file} · 已保存自定义版本`
      : `文件 ${item.file} · 未自定义，以下为完整内置文案（仅展示）`;
    customized.set(item.file, Boolean(result.customized));
    renderNav();
    showStatus("");
  }

  async function selectCapability(file) {
    if (file === currentFile) return;
    if (!confirmLeaveIfDirty()) return;
    currentFile = file;
    renderNav();
    await loadCurrent();
  }

  async function saveCurrent() {
    const result = await chrome.runtime.sendMessage({
      action: "saveSystemPrompt",
      file: currentFile,
      prompt: body.value,
    });
    if (!result?.success) {
      showStatus(result?.message || result?.error || "保存失败", { sticky: true });
      return;
    }
    showStatus(result.customized ? "已保存自定义提示词。" : "已清除自定义，将使用内置。");
    await refreshBadges();
    await loadCurrent();
  }

  async function restoreCurrent() {
    if (
      !window.confirm(
        "确认恢复为内置系统提示词？这将清除该项已保存的自定义文案，不会删除学习资料。",
      )
    ) {
      return;
    }
    const result = await chrome.runtime.sendMessage({
      action: "restoreSystemPrompt",
      file: currentFile,
    });
    if (!result?.success) {
      showStatus(result?.message || result?.error || "还原失败", { sticky: true });
      return;
    }
    showStatus("已恢复为内置提示词。");
    await refreshBadges();
    await loadCurrent();
  }

  window.addEventListener("beforeunload", (event) => {
    if (!isDirty()) return;
    event.preventDefault();
    event.returnValue = "";
  });

  saveBtn.addEventListener("click", () => {
    saveCurrent().catch((error) => showStatus(error.message, { sticky: true }));
  });
  restoreBtn.addEventListener("click", () => {
    restoreCurrent().catch((error) => showStatus(error.message, { sticky: true }));
  });

  refreshBadges()
    .then(loadCurrent)
    .catch((error) => showStatus(error.message, { sticky: true }));
})();
