/** AI 相关的纯逻辑：提示词模板解析、模型输出的宽容解析与校验。网络调用在 background.js。 */
var BILI_AI = (() => {
  const transcriptModule =
    typeof BILI_TRANSCRIPT !== "undefined"
      ? BILI_TRANSCRIPT
      : typeof require === "function"
        ? require("./transcript.js")
        : null;

  const formatTimestamp = (seconds) => transcriptModule.formatTimestamp(seconds);

  /** 从提示词 markdown 里取出某个小节的代码块内容，并替换 {变量}。 */
  function extractPromptSection(markdown, heading, variables = {}) {
    const marker = `## ${heading}`;
    const markerIndex = String(markdown || "").indexOf(marker);
    if (markerIndex === -1) {
      throw new Error(`提示词小节不存在：${heading}`);
    }

    const sectionStart = markerIndex + marker.length;
    const nextSection = markdown.indexOf("\n## ", sectionStart);
    const section = markdown.slice(
      sectionStart,
      nextSection === -1 ? markdown.length : nextSection,
    );

    const fence = section.match(/```(?:[A-Za-z0-9_-]+)?\n([\s\S]*?)\n```/);
    if (!fence) {
      throw new Error(`提示词小节里没有代码块：${heading}`);
    }

    let prompt = fence[1];
    for (const [key, value] of Object.entries(variables)) {
      prompt = prompt.split(`{${key}}`).join(String(value ?? ""));
    }
    return prompt;
  }

  /**
   * 解析模型返回的 JSON，容忍它常犯的小错：
   * 包了 markdown 围栏、在 JSON 前后加了一句话、结尾多一个逗号。
   */
  function parseLooseJson(text) {
    let cleaned = String(text || "").trim();

    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
    }

    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    }

    try {
      return JSON.parse(cleaned);
    } catch (firstError) {
      // 最常见的一种：] 或 } 前面多了个逗号。
      return JSON.parse(cleaned.replace(/,(\s*[}\]])/g, "$1"));
    }
  }

  /**
   * 把模型输出当作不可信数据重建一遍：模型编造超出视频时长的时间戳是常态，
   * 越界条目直接丢掉，显示用的时间戳从校验过的秒数反推、不信模型给的字符串。
   */
  function validateAnalysis(analysis, maxSeconds, minSeconds = 0) {
    const safeMax =
      Number.isFinite(Number(maxSeconds)) && Number(maxSeconds) > 0
        ? Number(maxSeconds)
        : Number.MAX_SAFE_INTEGER;
    // 分块时每块开头带了上一块的结尾，模型有时会顺手为那段也开一章；
    // 那段不归本块管，越界的直接丢掉。
    const safeMin =
      Number.isFinite(Number(minSeconds)) && Number(minSeconds) > 0
        ? Number(minSeconds)
        : 0;

    const safeString = (value, maxLength) =>
      typeof value === "string" ? value.trim().slice(0, maxLength) : "";

    const safeSeconds = (value) => {
      const seconds = Number(value);
      if (!Number.isFinite(seconds) || seconds < safeMin || seconds > safeMax) {
        return null;
      }
      return Math.floor(seconds);
    };

    const chapters = (Array.isArray(analysis?.chapters) ? analysis.chapters : [])
      .slice(0, 100)
      .map((chapter) => {
        const seconds = safeSeconds(chapter?.timestampSeconds);
        const title = safeString(chapter?.title, 300);
        if (seconds === null || !title) return null;
        return {
          title,
          summary: safeString(chapter?.summary, 1500),
          timestampSeconds: seconds,
          timestamp: formatTimestamp(seconds),
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.timestampSeconds - b.timestampSeconds);

    const keyQuotes = (Array.isArray(analysis?.keyQuotes) ? analysis.keyQuotes : [])
      .slice(0, 50)
      .map((quote) => {
        const seconds = safeSeconds(quote?.timestampSeconds);
        const text = safeString(quote?.quote, 3000);
        if (seconds === null || !text) return null;
        return {
          quote: text,
          timestampSeconds: seconds,
          timestamp: formatTimestamp(seconds),
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.timestampSeconds - b.timestampSeconds);

    // 上游还有 keyMoments，但消费它的功能连上游自己都禁用了，这里整条砍掉省 token。
    return { chapters, keyQuotes };
  }

  // 元数据里的时长有时缺失或不准，取「元数据时长」与「字幕最后一个时间戳」的较大值。
  function analysisTimingVariables(transcriptTextTimestamped, videoDuration) {
    const stamps = String(transcriptTextTimestamped || "").match(/\[(\d+):(\d{2})\]/g) || [];
    let lastTranscriptSeconds = 0;
    if (stamps.length) {
      const last = stamps[stamps.length - 1].match(/\[(\d+):(\d{2})\]/);
      lastTranscriptSeconds = Number(last[1]) * 60 + Number(last[2]);
    }

    const effectiveSeconds = Math.max(
      Math.floor(Number(videoDuration) || 0),
      lastTranscriptSeconds,
    );

    return {
      maxTimestampSeconds: effectiveSeconds,
      durationFormatted: formatTimestamp(effectiveSeconds),
      // 「最后一章必须晚于 75%」这条硬要求，是逼模型覆盖全片、
      // 而不是把章节全堆在开头最有效的一招。
      lateThreshold: formatTimestamp(Math.floor(effectiveSeconds * 0.75)),
    };
  }

  /**
   * 按输入长度估算输出 token 上限（ratio：改写接近 1，摘要远小于 1）。
   * max_tokens 是上限而非配额，给宽不花钱；但超过模型自身上限会被拒，
   * 所以给有余量的估算，不够时由调用方加码重试。
   */
  function estimateOutputTokens(
    inputChars,
    { ratio = 1, floor = 1024, ceiling = 8192 } = {},
  ) {
    const chars = Number.isFinite(inputChars) && inputChars > 0 ? inputChars : 0;
    // 中文约一字一 token；固定量留给 JSON 结构、id 和转义字符。
    const estimated = Math.ceil(chars * ratio) + 512;
    return Math.min(ceiling, Math.max(floor, estimated));
  }

  // 单块目标字数。长视频一次性生成概览容易撞超时；切小之后每次都快，还能并发。
  const ANALYSIS_CHUNK_CHARS = 6000;
  // 略高于单块上限：刚过一点就切成两块并不划算，反而多一次往返。
  const ANALYSIS_SINGLE_CHARS = 8000;
  // 每块开头附带的上一块结尾字数。横跨切点的话题两边都看得见，
  // 边界处才不会各开一个半截章节；只作上下文，不为它产出条目。
  const ANALYSIS_OVERLAP_CHARS = 400;

  // 按分段边界切块，保证每块内部的时间戳仍然连续可查。
  function planAnalysisChunks(
    segments,
    { maxChars = ANALYSIS_CHUNK_CHARS, overlapChars = ANALYSIS_OVERLAP_CHARS } = {},
  ) {
    const list = (Array.isArray(segments) ? segments : []).filter(
      (segment) => segment && typeof segment.text === "string" && segment.text,
    );
    if (!list.length) return [];

    const totalChars = list.reduce((sum, segment) => sum + segment.text.length, 0);
    const groups = [];

    if (totalChars <= ANALYSIS_SINGLE_CHARS) {
      groups.push(list);
    } else {
      let current = [];
      let chars = 0;
      for (const segment of list) {
        if (current.length && chars + segment.text.length > maxChars) {
          groups.push(current);
          current = [];
          chars = 0;
        }
        current.push(segment);
        chars += segment.text.length;
      }
      if (current.length) groups.push(current);
    }

    const withTimestamps = (list) =>
      list.map((segment) => `[${formatTimestamp(segment.start)}] ${segment.text}`).join("\n");

    return groups.map((group, index) => {
      const last = group[group.length - 1];
      return {
        index,
        segments: group,
        startSeconds: Math.floor(group[0].start || 0),
        // 末段的结束时间未知，用它的起点兜底；调用方会再跟视频总长取较大值。
        endSeconds: Math.floor(last.start || 0),
        text: withTimestamps(group),
        contextText: withTimestamps(tailSegments(groups[index - 1], overlapChars)),
      };
    });
  }

  // 取一组分段末尾约 chars 个字，用作下一块的前情。至少给一段，
  // 否则正好卡在边界的那句话反而是最缺上下文的一句。
  function tailSegments(group, chars) {
    if (!Array.isArray(group) || !group.length || chars <= 0) return [];
    const tail = [];
    let total = 0;
    for (let i = group.length - 1; i >= 0; i--) {
      tail.unshift(group[i]);
      total += group[i].text.length;
      if (total >= chars) break;
    }
    return tail;
  }

  // 合并各块概览。相邻块边界容易产出重复条目：章节按秒去重，金句按文本去重。
  function mergeAnalyses(parts, maxSeconds) {
    const chapters = [];
    const keyQuotes = [];
    const seenChapter = new Set();
    const seenQuote = new Set();

    for (const part of Array.isArray(parts) ? parts : []) {
      for (const chapter of part?.chapters || []) {
        if (seenChapter.has(chapter.timestampSeconds)) continue;
        seenChapter.add(chapter.timestampSeconds);
        chapters.push(chapter);
      }
      for (const quote of part?.keyQuotes || []) {
        const key = quote.quote.trim();
        if (seenQuote.has(key)) continue;
        seenQuote.add(key);
        keyQuotes.push(quote);
      }
    }

    // 合并后再走一次校验，顺带完成排序与上限裁剪。
    return validateAnalysis({ chapters, keyQuotes }, maxSeconds);
  }

  // 在字幕里定位某个时刻，取出润色所需的前后文（字幕一行往往只是半句话）。
  function noteContextAt(transcript, timestamp) {
    const entries = Array.isArray(transcript) ? transcript : [];
    if (!entries.length) return null;

    const target = Math.max(0, Math.floor(Number(timestamp) || 0));
    let index = entries.findIndex(
      (entry, i) =>
        entry.start <= target && (!entries[i + 1] || entries[i + 1].start > target),
    );
    // 时间戳超出字幕范围时退回最后一行。
    if (index === -1) index = entries.length - 1;

    const join = (from, to) =>
      entries
        .slice(Math.max(0, from), Math.min(entries.length, to))
        .map((entry) => entry.text)
        .filter(Boolean)
        .join(" ");

    return {
      index,
      targetText: entries[index].text,
      beforeText: join(index - 2, index),
      afterText: join(index + 1, index + 5),
      fullContext: join(index - 8, index + 13),
    };
  }

  // 把分段切成批次送给模型。批次太大模型容易漏条或偷懒缩写，太小则费用上去了；
  // 条数和字数双上限——B 站分段长度差异大，只看条数会让某些批次过长。
  function planSegmentBatches(segments, { maxSegments = 8, maxChars = 3000 } = {}) {
    const batches = [];
    let current = [];
    let chars = 0;

    for (const segment of Array.isArray(segments) ? segments : []) {
      const text = String(segment?.text || "");
      if (!text) continue;

      const wouldOverflow =
        current.length >= maxSegments || (current.length > 0 && chars + text.length > maxChars);
      if (wouldOverflow) {
        batches.push(current);
        current = [];
        chars = 0;
      }
      // 单条就超长时让它自己占一批，而不是被丢掉。
      current.push({ id: String(segment.id), text });
      chars += text.length;
    }

    if (current.length) batches.push(current);
    return batches;
  }

  const planPunctuationBatches = (segments, options) =>
    planSegmentBatches(segments, options);

  // 翻译批次比顺句小：翻译要重新组织整句，长批次上更容易漏条或越译越简。
  const planTranslationBatches = (segments, options) =>
    planSegmentBatches(segments, { maxSegments: 4, maxChars: 1200, ...options });

  const NON_CONTENT_PATTERN = /[\s\p{P}\p{S}]/gu;
  const contentLength = (text) =>
    String(text || "").replace(NON_CONTENT_PATTERN, "").length;

  // 模型可能顺手概括或扩写；去掉标点后字数基本不变才算「只加了标点、改了错别字」。
  function looksLikePunctuationFix(polished, source) {
    const sourceLength = contentLength(source);
    const polishedLength = contentLength(polished);
    if (sourceLength === 0) return polishedLength === 0;

    const ratio = polishedLength / sourceLength;
    return ratio >= 0.8 && ratio <= 1.2;
  }

  /**
   * 按 id 把模型返回的结果对回原分段。不能按数组下标对齐：模型偶尔漏条、多条
   * 或打乱顺序，按下标会把文字接到错误的时间戳上。对不上的条目丢弃，保留原文。
   */
  function alignSegmentBatch(parsed, sourceSegments, accept, rejectReason) {
    const sources = new Map(
      (Array.isArray(sourceSegments) ? sourceSegments : []).map((segment) => [
        String(segment.id),
        String(segment.text || ""),
      ]),
    );

    const accepted = {};
    const rejected = [];
    const seen = new Set();

    for (const item of Array.isArray(parsed?.segments) ? parsed.segments : []) {
      const id = typeof item?.id === "string" ? item.id : String(item?.id ?? "");
      const text = typeof item?.text === "string" ? item.text.trim() : "";

      if (!sources.has(id)) {
        rejected.push({ id, reason: "UNKNOWN_ID" });
        continue;
      }
      if (seen.has(id)) {
        rejected.push({ id, reason: "DUPLICATE_ID" });
        continue;
      }
      seen.add(id);

      if (!text) {
        rejected.push({ id, reason: "EMPTY_TEXT" });
        continue;
      }
      if (!accept(text, sources.get(id))) {
        rejected.push({ id, reason: rejectReason });
        continue;
      }
      accepted[id] = text;
    }

    for (const id of sources.keys()) {
      if (!seen.has(id)) rejected.push({ id, reason: "MISSING" });
    }

    return { accepted, rejected };
  }

  function alignPolishedSegments(parsed, sourceSegments) {
    const { accepted, rejected } = alignSegmentBatch(
      parsed,
      sourceSegments,
      looksLikePunctuationFix,
      "CONTENT_CHANGED",
    );
    return { polished: accepted, rejected };
  }

  const cjkCount = (text) => (String(text || "").match(/[\u3400-\u9fff]/g) || []).length;
  const latinCount = (text) => (String(text || "").match(/[A-Za-z]/g) || []).length;

  /**
   * 判断模型是真的翻译了，还是把原文抄了回来。两个方向的证据不同：
   * 译成中文时译文里必须出现中文（原文拉丁字母太少如日韩文则不检查）；
   * 译成英文时看「中文明显变少」而非「出现拉丁字母」——短句英译可能只有 OK 两个字母。
   */
  function looksLikeTranslation(translated, source, targetLang = "zh") {
    if (targetLang === "en") {
      const sourceCjk = cjkCount(source);
      if (sourceCjk < 10) return true;
      return cjkCount(translated) < sourceCjk / 2;
    }
    if (latinCount(source) < 20) return true;
    return cjkCount(translated) > 0;
  }

  function alignTranslatedSegments(parsed, sourceSegments, { targetLang = "zh" } = {}) {
    const { accepted, rejected } = alignSegmentBatch(
      parsed,
      sourceSegments,
      (text, source) => looksLikeTranslation(text, source, targetLang),
      "NOT_TRANSLATED",
    );
    return { translated: accepted, rejected };
  }

  return {
    extractPromptSection,
    parseLooseJson,
    validateAnalysis,
    analysisTimingVariables,
    ANALYSIS_CHUNK_CHARS,
    ANALYSIS_SINGLE_CHARS,
    ANALYSIS_OVERLAP_CHARS,
    estimateOutputTokens,
    planAnalysisChunks,
    mergeAnalyses,
    noteContextAt,
    planSegmentBatches,
    planPunctuationBatches,
    looksLikePunctuationFix,
    alignPolishedSegments,
    planTranslationBatches,
    looksLikeTranslation,
    alignTranslatedSegments,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = BILI_AI;
}
