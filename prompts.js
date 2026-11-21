(() => {
  const CAPABILITIES = BILI_SETTINGS.SYSTEM_PROMPT_CAPABILITIES;
  const REASONING_EFFORTS = BILI_SETTINGS.REASONING_EFFORTS;
  const nav = document.getElementById("promptNav");
  const title = document.getElementById("promptTitle");
  const meta = document.getElementById("promptMeta");
  const body = document.getElementById("promptBody");
  const status = document.getElementById("promptStatus");
  const saveBtn = document.getElementById("promptSaveBtn");
  const restoreBtn = document.getElementById("promptRestoreBtn");
  const effortSelect = document.getElementById("promptEffort");
  const effortHint = document.getElementById("promptEffortHint");

  // 档位名到界面文案。off 就是内置行为，解释放在 hint 里。
  const EFFORT_LABELS = Object.freeze({
    [REASONING_EFFORTS.OFF]: "关",
    [REASONING_EFFORTS.LOW]: "低",
    [REASONING_EFFORTS.MEDIUM]: "中",
    [REASONING_EFFORTS.HIGH]: "高",
  });
  // 档位为何对不同模型效果不同：一行说清三种映射，避免用户以为「高」到处生效。
  const EFFORT_HINT = [
    "按厂商映射：Anthropic 走 thinking 预算（不占正文额度），DeepSeek 走 thinking 开关，",
    "o 系列 / gpt-5 走 reasoning_effort；其它模型不受影响。",
  ].join("");
  // 取向提示只是文案：默认值仍是关，开不开由用户决定。
  const EFFORT_ADVICE = Object.freeze({
    raise: "理解型任务抬档可能有收益，可自行抬档。",
    "keep-off": "改写型任务抬档一般只增加等待，建议保持关。",
  });

  let currentFile = CAPABILITIES[0]?.file || "analysis.md";
  let savedSnapshot = "";
  let statusTimer = null;
  const customized = new Map();
  const effortByFile = new Map();

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
      // 开了推理的能力在列表里直接看得出来，不用逐个点开确认。
      const effort = effortByFile.get(item.file);
      const effortLabel =
        effort && effort !== REASONING_EFFORTS.OFF ? EFFORT_LABELS[effort] : "";
      if (effortLabel) {
        const tag = document.createElement("span");
        tag.className = "badge effort";
        tag.textContent = `推理${effortLabel}`;
        btn.appendChild(tag);
      }
      btn.addEventListener("click", () => selectCapability(item.file));
      li.appendChild(btn);
      nav.appendChild(li);
    }
  }

  function renderEffortOptions() {
    effortSelect.textContent = "";
    for (const value of Object.values(REASONING_EFFORTS)) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = EFFORT_LABELS[value];
      effortSelect.appendChild(option);
    }
  }

  function currentAdvice() {
    const capability = CAPABILITIES.find((item) => item.file === currentFile);
    return EFFORT_ADVICE[capability?.reasoningAdvice] || "";
  }

  function syncEffort() {
    const effort = effortByFile.get(currentFile) || REASONING_EFFORTS.OFF;
    effortSelect.value = effort;
    const advice = currentAdvice();
    effortHint.textContent =
      effort === REASONING_EFFORTS.OFF
        ? `关闭时不改变请求形状，与未加这一项时完全一致。${advice}`
        : `${EFFORT_HINT}${advice}`;
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
      effortByFile.set(row.file, row.reasoningEffort);
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
    effortByFile.set(item.file, result.reasoningEffort);
    renderNav();
    syncEffort();
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
        "确认恢复为内置系统提示词？这会同时清除该项已保存的自定义文案与推理强度（回到关闭），不会删除学习资料。",
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
    // loadCurrent 结束时会清空状态栏，所以提示放在重载之后。
    await refreshBadges();
    await loadCurrent();
    showStatus("已恢复为内置提示词，推理强度已回到关闭。");
  }

  // 推理强度和提示词分开保存：它不改变文案，只是这一次调用怎么调模型，
  // 所以不做未保存拦截，选完即生效（与设置页的外观项一致）。
  async function saveEffort() {
    const result = await chrome.runtime.sendMessage({
      action: "saveReasoningEffort",
      file: currentFile,
      effort: effortSelect.value,
    });
    if (!result?.success) {
      showStatus(result?.message || result?.error || "保存失败", { sticky: true });
      // 存失败就把下拉拨回去，别让界面显示一个没落盘的档位。
      syncEffort();
      return;
    }
    effortByFile.set(currentFile, result.reasoningEffort);
    syncEffort();
    renderNav();
    showStatus(
      result.reasoningEffort === REASONING_EFFORTS.OFF
        ? "已关闭推理，恢复默认请求。"
        : "推理强度已保存。",
    );
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
  effortSelect.addEventListener("change", () => {
    saveEffort().catch((error) => showStatus(error.message, { sticky: true }));
  });

  renderEffortOptions();
  refreshBadges()
    .then(loadCurrent)
    .catch((error) => showStatus(error.message, { sticky: true }));
})();
