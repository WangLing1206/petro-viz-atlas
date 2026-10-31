/* =========================================================
   案例包 → 站点插件 生成器
   ---------------------------------------------------------
   用法：  node tools/build-cases.mjs
          node tools/build-cases.mjs --check    只检查，不写文件

   它做四件事：
     1. 把 tools/demo-base.css 复制成每个案例包的 demo/demo.css
        （保证所有示范页共用同一套皮肤）
     2. 读 cases/<包名>/case.json 与包内全部文件，生成
        assets/cases/<id>.case.js —— 与「上传案例包」完全同构的
        注册代码：清单进 tabs，示范文件内联后交给 CaseDemoHost，
        所以插件版与上传版的外观、行为一致。
     3. 把包清单导出到 window.CASE_PACKS，供「案例包」页在线试跑
        与一键下载 .zip（下载出来的包可以直接拖回「添加案例」）。
     4. 重写 index.html 里 <!-- CASES:BEGIN --> 与 <!-- CASES:END -->
        之间的脚本标签块，新案例不需要手工加 script。

   案例包的「源」只有 cases/ 这一个目录，assets/cases/*.case.js
   都是生成物，不要手改。
   ========================================================= */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CASES_DIR = path.join(ROOT, 'cases');
const OUT_DIR = path.join(ROOT, 'assets', 'cases');
const INDEX = path.join(ROOT, 'index.html');
const BASE_CSS = fs.readFileSync(path.join(HERE, 'demo-base.css'), 'utf8');

const CHECK_ONLY = process.argv.includes('--check');

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', ico: 'image/x-icon', json: 'application/json', csv: 'text/csv',
  txt: 'text/plain', pdf: 'application/pdf', woff: 'font/woff', woff2: 'font/woff2'
};
const TEXT_EXT = ['json', 'js', 'mjs', 'css', 'html', 'htm', 'svg', 'txt', 'csv', 'tsv', 'md', 'xml'];

const extOf = (n) => (/\.([a-z0-9]+)$/i.exec(n) || [, ''])[1].toLowerCase();
const isText = (n) => TEXT_EXT.includes(extOf(n));

function walk(dir, base = dir, out = []) {
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, base, out);
    else out.push({ rel: path.relative(base, full).split(path.sep).join('/'), full, size: st.size });
  }
  return out;
}

/* 文本文件里可能有 </script>，内联进 JS 字符串时必须拆开 */
const safe = (s) => s.replace(/<\//g, '<\\/');

function readPkgFiles(pkgDir) {
  return walk(pkgDir)
    .filter((f) => f.rel !== 'case.json')
    .map((f) => {
      const text = isText(f.rel);
      const data = text ? fs.readFileSync(f.full, 'utf8') : fs.readFileSync(f.full).toString('base64');
      return {
        name: f.rel,
        size: f.size,
        mime: MIME[extOf(f.rel)] || (text ? 'text/plain' : 'application/octet-stream'),
        enc: text ? 'text' : 'dataurl',
        data: text ? data : '' /* 二进制素材本仓库不需要；留字段给将来的图 */,
        __binary: !text
      };
    });
}

function buildPlugin(pkg, pkgDir, dirName) {
  const files = readPkgFiles(pkgDir);
  const cfg = pkg.tabs && pkg.tabs.demo ? pkg.tabs.demo : {};
  const demo = {
    mode: cfg.mode || 'auto',
    html: cfg.html || 'demo/index.html',
    js: cfg.js || 'demo/demo.js',
    label: cfg.label || '可运行示范',
    intro: cfg.intro || '',
    height: cfg.height || 640
  };
  const meta = { id: pkg.id, sceneId: pkg.sceneId, title: pkg.title };

  const filesJson = safe(JSON.stringify(files.map((f) => ({
    name: f.name, size: f.size, mime: f.mime, enc: f.enc, data: f.data
  }))));
  const demoJson = safe(JSON.stringify(demo));
  const metaJson = safe(JSON.stringify(meta));
  const pkgJson = safe(JSON.stringify(pkg));

  return `/* =========================================================
   案例插件（自动生成，请勿直接编辑）
   ---------------------------------------------------------
   来源：cases/${dirName}/   ——  改内容请改案例包，然后运行
        node tools/build-cases.mjs
   本文件与原案例包同构：清单进 tabs，示范文件内联后交给
   CaseDemoHost 渲染（整页模式 = sandbox iframe），
   与通过「＋ 添加案例」上传同一份包的效果完全一致。
   ========================================================= */

(function () {
  'use strict';

  var META = ${metaJson};
  var DEMO = ${demoJson};
  var FILES = ${filesJson};
  var PKG = ${pkgJson};

  /* 供「案例包」页使用：在线试跑 + 一键下载 zip + 复制包结构 */
  var LIB = (window.CASE_PACKS = window.CASE_PACKS || {});
  LIB[META.id] = { dir: ${JSON.stringify(dirName)}, meta: META, demo: DEMO, files: FILES, pkg: PKG };

  var handle = null;

  Cases.register({
    id: META.id,
    sceneId: META.sceneId,
    title: META.title,
    status: PKG.status || 'ready',
    version: PKG.version || '1.0.0',
    updated: PKG.updated || '',
    methods: PKG.methods || null,
    packDir: ${JSON.stringify(dirName)},
    tabs: {
      background: PKG.tabs.background,
      workflow: PKG.tabs.workflow,
      demo: {
        label: DEMO.label,
        intro: DEMO.intro,
        mode: DEMO.mode,
        mount: function (root, ctx) {
          if (handle) { try { handle.destroy(); } catch (e) {} handle = null; }
          handle = CaseDemoHost.create(root, { files: FILES, demo: DEMO, meta: META }, ctx);
        },
        unmount: function () {
          if (handle) { try { handle.destroy(); } catch (e) {} handle = null; }
        }
      }
    }
  });
})();
`;
}

/* ---------------- 主流程 ---------------- */
if (!fs.existsSync(CASES_DIR)) {
  console.error('找不到 cases/ 目录：' + CASES_DIR);
  process.exit(1);
}
fs.mkdirSync(OUT_DIR, { recursive: true });

const pkgs = [];
const report = [];
const problems = [];

for (const dirName of fs.readdirSync(CASES_DIR).sort()) {
  const pkgDir = path.join(CASES_DIR, dirName);
  if (!fs.statSync(pkgDir).isDirectory()) continue;
  const jsonPath = path.join(pkgDir, 'case.json');
  if (!fs.existsSync(jsonPath)) { problems.push(`${dirName}: 缺 case.json`); continue; }

  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); }
  catch (e) { problems.push(`${dirName}: case.json 不是合法 JSON — ${e.message}`); continue; }

  if (!pkg.id || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(pkg.id)) { problems.push(`${dirName}: id 不规范（${pkg.id}）`); continue; }
  if (!pkg.sceneId) { problems.push(`${dirName}: 缺 sceneId`); continue; }
  if (pkg.id !== dirName) { problems.push(`${dirName}: 目录名与 id 不一致（id=${pkg.id}），请保持一致`); continue; }
  const demoDir = path.join(pkgDir, 'demo');
  const hasHtml = fs.existsSync(path.join(demoDir, 'index.html'));
  const hasJs = fs.existsSync(path.join(demoDir, 'demo.js'));
  if (!hasHtml && !hasJs) problems.push(`${dirName}: 缺 demo/index.html 或 demo/demo.js`);
  const demoMode = pkg.tabs && pkg.tabs.demo && pkg.tabs.demo.mode;
  if (demoMode === 'page' && !hasHtml) problems.push(`${dirName}: demo.mode=page 但没有 demo/index.html`);
  if (demoMode === 'module' && !hasJs) problems.push(`${dirName}: demo.mode=module 但没有 demo/demo.js`);

  /* 1. 同步公共皮肤 */
  if (!CHECK_ONLY) fs.writeFileSync(path.join(demoDir, 'demo.css'), BASE_CSS);

  /* 2. 生成插件 */
  const code = buildPlugin(pkg, pkgDir, dirName);
  if (!CHECK_ONLY) fs.writeFileSync(path.join(OUT_DIR, pkg.id + '.case.js'), code);

  pkgs.push(pkg.id);
  report.push({
    id: pkg.id, dir: dirName, scene: pkg.sceneId, title: pkg.title,
    files: readPkgFiles(pkgDir).length,
    kb: Math.round((fs.statSync(jsonPath).size + readPkgFiles(pkgDir).reduce((a, f) => a + f.size, 0)) / 1024)
  });
}

/* 3. 重写 index.html 的案例脚本块 */
let indexHTML = fs.readFileSync(INDEX, 'utf8');
const BEGIN = '<!-- CASES:BEGIN （本区块由 tools/build-cases.mjs 生成，勿手改） -->';
const END = '<!-- CASES:END -->';
const block = BEGIN + '\n' +
  pkgs.map((id) => `<script src="assets/cases/${id}.case.js?v=20261030g"></script>`).join('\n') +
  '\n' + END;
const re = new RegExp(BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?' + END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
if (re.test(indexHTML)) {
  const next = indexHTML.replace(re, block);
  if (next !== indexHTML && !CHECK_ONLY) fs.writeFileSync(INDEX, next);
} else {
  problems.push('index.html 里找不到 <!-- CASES:BEGIN --> / <!-- CASES:END --> 标记块');
}

report.sort((a, b) => a.id.localeCompare(b.id));
console.log('案例包 → 插件：共 ' + report.length + ' 个');
for (const r of report) {
  console.log(`  ${r.id.padEnd(22)} ${r.scene.padEnd(6)} ${String(r.kb).padStart(4)} KB  ${r.title}`);
}
if (problems.length) {
  console.log('\n需要处理：');
  problems.forEach((p) => console.log('  ! ' + p));
  process.exitCode = 1;
} else {
  console.log('\n全部通过' + (CHECK_ONLY ? '（--check 模式，没有写文件）' : ''));
}
