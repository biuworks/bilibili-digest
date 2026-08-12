/**
 * 字幕后处理：把逐条字幕重组成可阅读的语义段落。
 *
 * 算法移植自上游 sidepanel.js#groupTranscriptEntries，针对 B 站做了两处调整：
 *  1. 中文信息密度高，CJK 内容用更短的段落阈值，否则一段会长得没法读；
 *  2. B 站 AI 字幕普遍没有标点，额外把「原始字幕行边界」作为可切分点，
 *     避免在无标点时按字符数硬切、把词切成两半。
 */
var BILI_TRANSCRIPT = (() => {
  // 拉丁文本沿用上游阈值；CJK 按字符数折算到相近的信息量。
  const LATIN_LIMITS = Object.freeze({
    minChars: 60,
    idealChars: 180,
    maxChars: 320,
    maxSeconds: 20,
  });

  const CJK_LIMITS = Object.freeze({
    minChars: 30,
    idealChars: 90,
    maxChars: 160,
    maxSeconds: 20,
  });

  const CJK_PATTERN = /[\u3400-\u9fff]/g;

  /** CJK 字符占比超过三成就按中文排版处理。 */
  function limitsForEntries(entries) {
    const sample = (Array.isArray(entries) ? entries : [])
      .slice(0, 200)
      .map((entry) => String(entry?.text || ""))
      .join("");
    if (!sample) return LATIN_LIMITS;
    const cjkCount = (sample.match(CJK_PATTERN) || []).length;
    return cjkCount / sample.length > 0.3 ? CJK_LIMITS : LATIN_LIMITS;
  }

  function normalizeCaptionText(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      // 用后顾断言而非捕获组：捕获组会吃掉右侧汉字，导致连续多个
      // 「汉字 空格 汉字」只清理得掉第一处。
      .replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, "$1")
      .replace(/([，。；：！？])\s+(?=[\u3400-\u9fff])/g, "$1")
      .replace(/\s+([,.;:!?，。；：！？])/g, "$1")
      .trim();
  }

  // 优先切在标点上，退而求其次词边界，最后才按字符数硬切。
  function splitOversizedThought(text, maxChars) {
    const parts = [];
    let rest = normalizeCaptionText(text);

    while (rest.length > maxChars) {
      const windowText = rest.slice(0, maxChars + 1);
      const lowerBound = Math.floor(maxChars * 0.55);
      let cut = -1;

      for (const pattern of [/[;:；：]\s*/g, /[,，]\s*/g, /\s/g]) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(windowText))) {
          if (match.index >= lowerBound) cut = match.index + match[0].length;
        }
        if (cut > 0) break;
      }

      if (cut <= 0) cut = maxChars;
      parts.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }

    if (rest) parts.push(rest);
    return parts;
  }

  /** 把逐条字幕重组成语义段落。每段保留贡献首个文字的那条字幕的时间戳。 */
  function groupTranscriptEntries(entries, limits) {
    if (!Array.isArray(entries) || entries.length === 0) return [];
    const activeLimits = limits || limitsForEntries(entries);

    const pieces = [];
    entries.forEach((entry, entryIndex) => {
      const text = normalizeCaptionText(entry?.text);
      if (!text) return;
      const start = Number.isFinite(Number(entry?.start))
        ? Number(entry.start)
        : 0;
      const duration = Math.max(0, Number(entry?.duration) || 0);
      const sentenceParts = text.match(
        /[^.!?;:,。！？；：，]+(?:[.!?;:,。！？；：，]+["')\]”’）】」』]*|$)/g,
      ) || [text];
      let consumedChars = 0;
      const entryPieces = [];

      sentenceParts.forEach((sentencePart) => {
        const cleanPart = normalizeCaptionText(sentencePart);
        if (!cleanPart) return;
        const oversizedParts = splitOversizedThought(
          cleanPart,
          activeLimits.maxChars,
        );
        oversizedParts.forEach((part, partIndex) => {
          const ratio = text.length
            ? Math.min(1, consumedChars / text.length)
            : 0;
          entryPieces.push({
            text: part,
            start: start + duration * ratio,
            semanticEnd:
              /[.!?。！？]["')\]”’）】」』]*$/.test(part) ||
              oversizedParts.length > 1,
            clauseEnd: /[;:,；：，]["')\]”’）】」』]*$/.test(part),
            entryEnd: false,
            sourceOrder: `${entryIndex}:${partIndex}`,
          });
          consumedChars += part.length + 1;
        });
      });

      if (entryPieces.length) {
        entryPieces[entryPieces.length - 1].entryEnd = true;
        pieces.push(...entryPieces);
      }
    });

    const grouped = [];
    let current = null;

    const flush = () => {
      if (!current || !current.text.trim()) return;
      const index = grouped.length;
      const text = normalizeCaptionText(current.text);
      grouped.push({
        id: `segment-${index}-${Math.round(current.start * 1000)}`,
        start: current.start,
        text,
        texts: [text],
      });
      current = null;
    };

    pieces.forEach((piece) => {
      if (!current) current = { start: piece.start, text: "" };
      current.text = normalizeCaptionText(`${current.text} ${piece.text}`);
      const elapsed = Math.max(0, piece.start - current.start);
      const comfortablySized = current.text.length >= activeLimits.minChars;
      const reachedIdeal = current.text.length >= activeLimits.idealChars;
      const atNaturalBoundary =
        piece.semanticEnd ||
        ((piece.clauseEnd || piece.entryEnd) &&
          (reachedIdeal ||
            current.text.length >= activeLimits.maxChars ||
            elapsed >= activeLimits.maxSeconds));
      const reachedGuardrail =
        atNaturalBoundary &&
        (current.text.length >= activeLimits.maxChars ||
          elapsed >= activeLimits.maxSeconds);
      const reachedHardGuardrail =
        current.text.length >= Math.round(activeLimits.maxChars * 1.2) ||
        elapsed >= activeLimits.maxSeconds + 5;

      if (
        (atNaturalBoundary && (comfortablySized || elapsed >= 8)) ||
        (atNaturalBoundary && reachedIdeal) ||
        reachedGuardrail ||
        reachedHardGuardrail
      ) {
        flush();
      }
    });
    flush();

    return grouped;
  }

  function formatTimestamp(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  }

  // 纯文本用于展示 / 导出；带 [M:SS] 前缀的版本喂给模型，让它能引用真实时间点。
  function buildTranscriptTexts(entries) {
    const lines = Array.isArray(entries) ? entries : [];
    const plain = lines
      .map((entry) => normalizeCaptionText(entry?.text))
      .filter(Boolean)
      .join(" ");
    const timestamped = lines
      .map((entry) => {
        const text = normalizeCaptionText(entry?.text);
        return text ? `[${formatTimestamp(entry?.start)}] ${text}` : "";
      })
      .filter(Boolean)
      .join("\n");
    return { plain: plain.trim(), timestamped: timestamped.trim() };
  }

  /**
   * 决定侧边栏给顺句还是翻译入口。AI 字幕语言码带 `ai-` 前缀，脱掉再看主语言；
   * 拿不到语言码时按中文处理——B 站以中文视频为主，这个方向猜错代价更小。
   */
  function isChineseSubtitle(language) {
    const code = String(language || "")
      .trim()
      .toLowerCase();
    if (!code) return true;
    return code.replace(/^ai[-_]/, "").startsWith("zh");
  }

  return {
    LATIN_LIMITS,
    CJK_LIMITS,
    limitsForEntries,
    isChineseSubtitle,
    normalizeCaptionText,
    splitOversizedThought,
    groupTranscriptEntries,
    formatTimestamp,
    buildTranscriptTexts,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = BILI_TRANSCRIPT;
}
