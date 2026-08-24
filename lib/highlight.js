/**
 * 搜索命中高亮的纯函数部分：把文本按命中的关键词切片。
 * 与 learning-store.filterNotes 同一套语义——大小写不敏感的包含匹配。
 *
 * 返回片段数组而不直接碰 DOM：渲染层（textContent + <mark>）怎么拼
 * 是侧边栏的事，这里保持零依赖可直连单测。绝不走 innerHTML。
 */
var BILI_HIGHLIGHT = (() => {
  /**
   * splitMatches("Java 和 javascript", "java")
   *   => [{text:"Java",hit:true},{text:" 和 ",hit:false},{text:"javascript",hit:true}]
   * 关键词为空（或全是空白）时原样返回一个未命中片段。
   */
  function splitMatches(text, query) {
    const source = String(text ?? "");
    const needle = String(query ?? "").trim().toLowerCase();
    if (!needle) {
      return source ? [{ text: source, hit: false }] : [];
    }

    const haystack = source.toLowerCase();
    if (!haystack.includes(needle)) {
      return [{ text: source, hit: false }];
    }

    const segments = [];
    let cursor = 0;
    while (cursor <= haystack.length - needle.length) {
      const index = haystack.indexOf(needle, cursor);
      if (index === -1) break;
      if (index > cursor) {
        segments.push({ text: source.slice(cursor, index), hit: false });
      }
      // 命中片段保留原文的大小写，不显示被小写的版本。
      segments.push({ text: source.slice(index, index + needle.length), hit: true });
      cursor = index + needle.length;
    }
    if (cursor < source.length) {
      segments.push({ text: source.slice(cursor), hit: false });
    }
    return segments;
  }

  /** 片段里是否存在命中——渲染层决定走高亮路径还是原样 textContent。 */
  function hasMatch(segments) {
    return segments.some((segment) => segment.hit);
  }

  return { splitMatches, hasMatch };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = BILI_HIGHLIGHT;
}
