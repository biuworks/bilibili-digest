const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const readJson = (file) =>
  JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const readText = (file) => fs.readFileSync(path.join(root, file), "utf8");
const exists = (file) => fs.existsSync(path.join(root, file));

const manifest = readJson("manifest.json");
const localizedMessages = readJson(
  `_locales/${manifest.default_locale}/messages.json`,
);
const resolveManifestText = (value) => {
  const match = /^__MSG_([^_].*)__$/.exec(value);
  return match ? localizedMessages[match[1]]?.message : value;
};
const manifestName = resolveManifestText(manifest.name);
const manifestDescription = resolveManifestText(manifest.description);

test("商店主语言声明为简体中文并随安装包发布本地化消息", () => {
  assert.equal(manifest.default_locale, "zh_CN");
  assert.equal(manifest.name, "__MSG_extensionName__");
  assert.equal(manifest.description, "__MSG_extensionDescription__");

  assert.equal(localizedMessages.extensionName.message, "Digest for Bilibili");
  assert.ok(localizedMessages.extensionDescription.message.length > 0);
  assert.ok(localizedMessages.extensionDescription.message.length <= 132);
  assert.match(readText("scripts/package.sh"), /DIRS=\([^)]*_locales[^)]*\)/);
});

test("是一份 MV3 清单", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.version);
  // 侧边栏 API 需要 Chrome 116+。Edge 的版本号跟 Chromium 对齐，同一个门槛
  // 对它一样成立（Edge 自 114 起支持侧边栏）。
  assert.ok(Number(manifest.minimum_chrome_version) >= 116);

  // 版本号要手动同步的地方不止一处，漂移了不会报错、只会让商店包和仓库对不上。
  const pkg = readJson("package.json");
  assert.equal(pkg.version, manifest.version, "package.json 版本与清单不一致");

  const listing = readText("STORE-LISTING.md");
  assert.ok(
    listing.includes(`digest-for-bilibili-${manifest.version}.zip`),
    "STORE-LISTING.md 的安装包文件名还是旧版本号",
  );
});

/**
 * 侧边栏的 per-tab enabled 在两个浏览器上语义不同：Chrome 每个标签页各管各的，
 * Edge 是窗口级的——某个标签页被 disable，切过去就会把整个窗口的侧边栏关掉，
 * 正在跑的 AI 任务跟着断。所以路径只由清单提供，代码里不按标签页开关。
 */
test("侧边栏全局可用，图标点击交给浏览器处理", () => {
  assert.ok(manifest.side_panel?.default_path, "侧边栏路径应当由清单提供");
  assert.ok(manifest.permissions.includes("sidePanel"));

  const source = readText("background.js");
  assert.doesNotMatch(
    source,
    /sidePanel[\s\S]{0,40}setOptions\(/,
    "按标签页 setOptions 会让 Edge 在切标签页时关掉侧边栏",
  );
  assert.match(
    source,
    /openPanelOnActionClick:\s*true/,
    "自己接管图标点击要靠用户手势，Edge 的判定比 Chrome 严，交给浏览器两边都稳",
  );
});

test("同一份清单能投 Chrome 应用商店和 Edge 加载项", () => {
  // 这两条都是 Edge 认证会直接打回的硬性要求。
  assert.equal(manifest.update_url, undefined, "商店版清单不能带 update_url");
  for (const field of [manifestName, manifestDescription]) {
    assert.doesNotMatch(field, /chrome/i, "名称和描述里不能出现 Chrome");
  }
});

test("描述不超过 132 字符，且不宣传尚未实现的功能", () => {
  // 商店对这个字段有 132 字符的硬上限，超了要等到上传那一刻才报错。
  assert.ok(manifestDescription.length > 0);
  assert.ok(
    manifestDescription.length <= 132,
    `描述有 ${manifestDescription.length} 字符，超过商店 132 的上限`,
  );

  // 描述先于实现出现，就是在向用户承诺一个装完找不到的功能。
  // 认这个消息名而不是「translat」这几个字母：注释里提一句翻译不算接线。
  const translationWired = readText("sidepanel.js").includes("translateSegments");
  if (!translationWired) {
    for (const field of [manifestDescription, readJson("package.json").description]) {
      assert.doesNotMatch(
        field,
        /bilingual|translation/i,
        "双语翻译尚未接线，描述里不应出现",
      );
    }
  }
});

/**
 * 清单里但凡引用了不存在的文件，浏览器就整个拒绝加载扩展，
 * 而且报错信息经常只指向清单本身。这条测试把问题提前暴露在命令行里。
 */
test("清单引用的每个文件都真实存在", () => {
  const referenced = [
    manifest.background?.service_worker,
    manifest.side_panel?.default_path,
    manifest.options_ui?.page,
    ...(manifest.content_scripts || []).flatMap((entry) => entry.js || []),
    ...Object.values(manifest.action?.default_icon || {}),
    ...Object.values(manifest.icons || {}),
  ].filter(Boolean);

  assert.ok(referenced.length > 0);
  for (const file of referenced) {
    assert.ok(exists(file), `清单引用了不存在的文件：${file}`);
  }
});

test("service worker importScripts 的依赖都存在", () => {
  const source = readText(manifest.background.service_worker);
  const block = source.match(/importScripts\(([\s\S]*?)\);/);
  assert.ok(block, "background.js 应通过 importScripts 引入依赖");

  const files = [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(files.includes("settings.js"));
  for (const file of files) {
    assert.ok(exists(file), `importScripts 引用了不存在的文件：${file}`);
  }
});

/**
 * lib 模块是 IIFE 挂全局 + require 双导出，浏览器里靠 importScripts 的顺序
 * 保证「被依赖者先加载」——模块顶层的 typeof 守卫在求值时立即走完，
 * 排在后面就会在 service worker 里抛 `require is not defined`，
 * 表现是整个扩展注册失败。各文件的依赖以其 require("./x.js") 声明为准。
 */
test("importScripts 的加载顺序满足模块间依赖", () => {
  const source = readText(manifest.background.service_worker);
  const block = source.match(/importScripts\(([\s\S]*?)\);/);
  const files = [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  const position = new Map(files.map((file, index) => [file, index]));

  for (const file of files) {
    if (!file.startsWith("lib/")) continue;
    const body = readText(file);
    // lib 内部的 require 是同目录相对引用，统一解析回仓库根路径再比对。
    for (const [, dep] of body.matchAll(/require\("\.\/([^"]+)"\)/g)) {
      const depPath = file.includes("/")
        ? `${file.slice(0, file.lastIndexOf("/"))}/${dep}`
        : dep;
      assert.ok(
        position.has(depPath),
        `${file} 依赖 ${depPath}，但它不在 importScripts 列表里`,
      );
      assert.ok(
        position.get(depPath) < position.get(file),
        `${file} 在 ${depPath} 之前加载，service worker 里会直接抛 require is not defined`,
      );
    }
  }
});

/**
 * 页面脚本依赖的 lib 全局（BILI_XXX）由 HTML 的 <script> 标签提供。
 * 漏挂标签不会报打包错，只会在用户点到对应功能时抛
 * `XXX is not defined`——问答页首日就踩过这个坑。
 */
test("页面脚本引用的全局模块都有对应的 script 标签", () => {
  // BILI_QA_CITATIONS -> qa-citations.js；设置模块是根目录的特例。
  const globalToFile = (name) =>
    name === "BILI_SETTINGS"
      ? "settings.js"
      : `${name.slice(5).toLowerCase().replace(/_/g, "-")}.js`;

  for (const page of ["sidepanel.html", "options.html"]) {
    const html = readText(page);
    const pageDir = path.dirname(page);
    const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(
      (match) => match[1],
    );
    const loadedFiles = new Set(
      scripts.map((file) => path.posix.normalize(path.join(pageDir, file)).split("/").pop()),
    );

    const referencedGlobals = new Set();
    for (const file of scripts) {
      if (!file.endsWith(".js")) continue;
      const source = readText(path.posix.normalize(path.join(pageDir, file)));
      for (const match of source.matchAll(/\bBILI_[A-Z][A-Z_]*\b/g)) {
        referencedGlobals.add(match[0]);
      }
    }

    for (const name of referencedGlobals) {
      const file = globalToFile(name);
      assert.ok(
        loadedFiles.has(file),
        `${page} 的脚本用到 ${name}，但没有加载 ${file}`,
      );
    }
  }
});

test("HTML 引用的脚本与样式都存在", () => {
  for (const page of ["sidepanel.html", "options.html"]) {
    const html = readText(page);
    const assets = [
      ...[...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]),
      ...[...html.matchAll(/<link[^>]+href="([^"]+)"/g)].map((m) => m[1]),
    ];
    assert.ok(assets.length > 0, `${page} 应引用脚本或样式`);
    for (const asset of assets) {
      assert.ok(exists(asset), `${page} 引用了不存在的文件：${asset}`);
    }
  }
});

test("安装时索要的权限只限 B 站，且全部走 https", () => {
  const hosts = manifest.host_permissions || [];
  assert.ok(hosts.every((host) => host.startsWith("https://")), "不应出现明文 http");

  // 字幕 JSON 托管在 hdslb CDN，漏了它字幕就下载不下来。
  assert.ok(hosts.some((host) => host.includes("api.bilibili.com")));
  assert.ok(hosts.some((host) => host.includes("hdslb.com")));

  // AI 服务地址由用户自定义，必须留到运行时申请。
  // 一旦有人图省事把它写进 host_permissions，安装时就会索要全网权限。
  for (const host of hosts) {
    assert.match(
      host,
      /bilibili\.com|hdslb\.com/,
      `出现了预期之外的主机权限：${host}`,
    );
  }
});

test("自定义 AI 地址走可选权限，且明文 http 只对本机放行", () => {
  const optional = manifest.optional_host_permissions || [];
  assert.ok(optional.length > 0, "缺少 optional_host_permissions，自定义地址会被 CORS 拦下");
  assert.ok(
    optional.includes("https://*/*"),
    "需要 https://*/* 才能在运行时申请任意 https 服务商",
  );

  for (const host of optional) {
    if (!host.startsWith("http://")) continue;
    assert.match(
      host,
      /^http:\/\/(localhost|127\.0\.0\.1)\//,
      `明文 http 只应对本机放行，出现了：${host}`,
    );
  }
});

test("内容脚本只注入播放页，不是整个站点", () => {
  const matches = (manifest.content_scripts || []).flatMap((e) => e.matches);
  assert.ok(matches.length > 0);
  for (const pattern of matches) {
    assert.match(
      pattern,
      /^https:\/\/www\.bilibili\.com\/(video|list)\//,
      `内容脚本的匹配范围过宽：${pattern}`,
    );
  }
});

test("侧边栏与设置页的存储读写走同一个 storage key", () => {
  const settings = require("../settings.js");
  assert.equal(settings.STORAGE_KEY, "bili_digest_settings");
  for (const file of ["background.js", "options.js"]) {
    assert.match(
      readText(file),
      /BILI_SETTINGS\.STORAGE_KEY/,
      `${file} 应通过 BILI_SETTINGS.STORAGE_KEY 访问存储`,
    );
  }
});
