/**
 * 问答引用的纯函数校验与时间戳解析。防编造的三道闸里，
 * 这里实现前两道（区间闸、原文闸）；第三道「零有效引用替换整条回答」
 * 属于业务编排，在 lib/qa-service.js。
 *
 * 时间戳格式沿用 lib/transcript.js 的 formatTimestamp：M:SS
 * （超过一小时是 75:20 这种延续分钟的形式，不做 H:MM:SS）。
 */
var BILI_QA_CITATIONS = (() => {
  /** "03:12" → 192；非法输入返回 null。 */
  function timestampToSeconds(token) {
    const match = /^(\d{1,3}):([0-5]\d)$/.exec(String(token || "").trim());
    if (!match) return null;
    return Number(match[1]) * 60 + Number(match[2]);
  }

  function secondsToTimestamp(seconds) {
    const value = Math.max(0, Math.floor(Number(seconds) || 0));
    return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
  }

  /** 找出回答文本里的全部 [M:SS]，返回 [{raw, seconds}]，非法 token 跳过。 */
  function extractTimestamps(text) {
    const source = String(text || "");
    const found = [];
    for (const match of source.matchAll(/\[(\d{1,3}:[0-5]\d)\]/g)) {
      const seconds = timestampToSeconds(match[1]);
      if (seconds !== null) found.push({ raw: match[1], seconds });
    }
    return found;
  }

  // 引用比对在「去空白」之后做：模型摘录时常在标点前后加空格，
  // 字幕原文里却没有，逐字比对会误伤。
  function normalizeForMatch(value) {
    return String(value || "").replace(/\s+/g, "");
  }

  function isWithin(seconds, range) {
    if (!range) return true;
    return (
      Number.isFinite(seconds) &&
      seconds >= Math.floor(range.min) &&
      seconds <= Math.ceil(range.max)
    );
  }

  /**
   * 区间闸 + 原文闸。
   *
   * citations: 模型输出的 [{startSeconds, quote}]
   * contextText: 本次实际送入模型的字幕拼文——quote 必须能在其中找到
   * timeRange:  selectContext 返回的 {min, max}
   *
   * 返回 {valid, invalidCount}；valid 保持原对象（便于 service 直接入库）。
   */
  function validateCitations({ citations, contextText, timeRange }) {
    const list = Array.isArray(citations) ? citations : [];
    const haystack = normalizeForMatch(contextText);
    const valid = [];
    let invalidCount = 0;

    for (const citation of list) {
      const seconds = Math.floor(Number(citation?.startSeconds));
      const quote = String(citation?.quote || "").trim();
      const inRange = isWithin(seconds, timeRange);
      const quoted = normalizeForMatch(quote);
      if (!inRange || !quoted || !haystack.includes(quoted)) {
        invalidCount += 1;
        continue;
      }
      valid.push({ startSeconds: seconds, quote });
    }
    return { valid, invalidCount };
  }

  /**
   * 回答正文里的 [M:SS] 哪些可以做成可点击跳转：必须落在合法区间内。
   * 返回合法秒数的 Set——UI 拿它决定某个 token 渲染成按钮还是纯文本。
   */
  function clickableTimestamps(answer, timeRange) {
    return new Set(
      extractTimestamps(answer)
        .filter((item) => isWithin(item.seconds, timeRange))
        .map((item) => item.seconds),
    );
  }

  return {
    timestampToSeconds,
    secondsToTimestamp,
    extractTimestamps,
    validateCitations,
    clickableTimestamps,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = BILI_QA_CITATIONS;
}
