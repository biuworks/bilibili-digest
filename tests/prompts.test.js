const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const AI = require("../lib/ai.js");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, "prompts", file), "utf8");
const backgroundSource = fs.readFileSync(path.join(root, "background.js"), "utf8");

/**
 * background.js 里传的变量名与提示词文件里写的占位符必须一一对应。
 * 对不上的话不会报错，只会把 `{videoTitle}` 这样的字面量原样发给模型——
 * 输出质量悄悄变差，很难在运行时发现。
 */
const PROMPTS = {
  "analysis.md": {
    startFormatted: "0:00",
    minTimestampSeconds: 0,
    durationFormatted: "10:00",
    lateThreshold: "7:30",
    maxTimestampSeconds: 600,
    videoTitle: "测试标题",
    ownerName: "测试 UP",
    videoDescription: "测试简介",
    transcriptText: "[0:00] 测试字幕",
    rangeNote: "这是第 1 / 3 段",
    contextNote: "前情回顾：[0:00] 上一段的结尾",
  },
  "explain.md": {
    videoTitle: "测试标题",
    selectedText: "测试选中",
    transcriptContext: "测试上下文",
  },
  "punctuate.md": {
    videoTitle: "测试标题",
    segmentsJson: '{"segments":[{"id":"s1","text":"测试"}]}',
  },
  "translation.md": {
    targetLangName: "简体中文",
    langRules: "- 测试规则",
    videoTitle: "测试标题",
    segmentsJson: '{"segments":[{"id":"s1","text":"hello"}]}',
  },
  "note-cleanup.md": {
    videoTitle: "测试标题",
    fullContext: "测试上下文",
    beforeText: "前文",
    targetText: "目标",
    afterText: "后文",
  },
  "note-refine.md": {
    videoTitle: "测试标题",
    currentText: "用户当前笔记",
  },
};

// 形如 {videoTitle} 的占位符。提示词里的 JSON 示例都以引号开头（{"chapters"），不会误伤。
const PLACEHOLDER = /\{[A-Za-z][A-Za-z0-9_]*\}/;

for (const [file, variables] of Object.entries(PROMPTS)) {
  test(`${file} 含有系统与用户两个提示词小节`, () => {
    const markdown = read(file);
    for (const heading of ["系统提示词", "用户提示词"]) {
      const section = AI.extractPromptSection(markdown, heading, variables);
      assert.ok(section.trim().length > 0, `${file}#${heading} 是空的`);
    }
  });

  test(`${file} 的占位符能被完全替换`, () => {
    const markdown = read(file);
    for (const heading of ["系统提示词", "用户提示词"]) {
      const section = AI.extractPromptSection(markdown, heading, variables);
      const leftover = section.match(PLACEHOLDER);
      assert.equal(
        leftover,
        null,
        `${file}#${heading} 残留未替换的占位符：${leftover?.[0]}`,
      );
    }
  });

  test(`${file} 里的每个变量都真的被用到了`, () => {
    const markdown = read(file);
    const both = ["系统提示词", "用户提示词"]
      .map((heading) => AI.extractPromptSection(markdown, heading, {}))
      .join("\n");
    for (const key of Object.keys(variables)) {
      assert.ok(
        both.includes(`{${key}}`),
        `${file} 没有用到 background.js 传入的变量 {${key}}`,
      );
    }
  });
}

test("translation.md 的两套语言规则小节都存在且非空", () => {
  // background 按字幕语种在这两节里二选一注入 {langRules}，
  // 调用处不是字面量，上面那条扫描测试逮不到它，这里单独守。
  for (const heading of ["中文规则", "英文规则"]) {
    const rules = AI.extractPromptSection(read("translation.md"), heading, {});
    assert.ok(rules.trim().length > 0, `translation.md#${heading} 是空的`);
  }
});

test("分批/分块任务的系统提示词保持稳定前缀，服务商缓存才能命中", () => {
  // 逐批变化的内容一旦混进系统提示词，几十个批次就要为同样的指令
  // 付几十次全价 prefill。segmentsJson 只允许出现在用户提示词里。
  for (const file of ["punctuate.md", "translation.md"]) {
    const system = AI.extractPromptSection(read(file), "系统提示词", {});
    assert.ok(
      !system.includes("{segmentsJson}"),
      `${file} 的系统提示词不该包含逐批变化的 segmentsJson`,
    );
  }
  // 概览分块时时长、门槛逐块不同，系统提示词必须全静态。
  const analysisSystem = AI.extractPromptSection(read("analysis.md"), "系统提示词", {});
  assert.equal(
    analysisSystem.match(PLACEHOLDER),
    null,
    `analysis.md 系统提示词应为全静态，发现：${analysisSystem.match(PLACEHOLDER)?.[0]}`,
  );
});

test("background.js 引用的提示词文件与小节名都存在", () => {
  const calls = [
    ...backgroundSource.matchAll(/loadPromptSection\(\s*"([^"]+)",\s*"([^"]+)"/g),
  ].map((match) => ({ file: match[1], heading: match[2] }));

  assert.ok(calls.length >= 6, "应当至少有概览、解释、笔记三组提示词调用");
  for (const { file, heading } of calls) {
    assert.ok(PROMPTS[file], `background.js 引用了未知的提示词文件：${file}`);
    // 小节缺失时 extractPromptSection 会抛错，这里就是要它别抛。
    AI.extractPromptSection(read(file), heading, PROMPTS[file]);
  }
});

// 上游没有「顺句」这一环——英文字幕本来就带标点，
// 所以 punctuate.md 是为 B 站的无标点 AI 字幕原创的，不涉及上游署名。
const PORTED_FROM_UPSTREAM = [
  "analysis.md",
  "explain.md",
  "note-cleanup.md",
  "translation.md",
];

test("移植自上游的提示词保留了署名", () => {
  for (const file of PORTED_FROM_UPSTREAM) {
    assert.match(read(file), /youtube-digest/, `${file} 应保留上游 MIT 署名`);
  }
});

test("每份提示词要么标注上游出处，要么标注为原创", () => {
  for (const file of Object.keys(PROMPTS)) {
    const isPorted = PORTED_FROM_UPSTREAM.includes(file);
    assert.match(
      read(file),
      isPorted ? /youtube-digest/ : /上游没有|原创/,
      `${file} 的出处没有交代清楚`,
    );
  }
});
