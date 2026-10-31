/* =========================================================
   全部案例示范页自检（开发期测试）
   ---------------------------------------------------------
   node tools/test-cases.mjs [cases/<包名>]
   逐个打开 cases/<包名>/demo/index.html，检查：
     · 运行时错误 / console.error
     · 页面高度（是否渲染出了内容）
     · .dfig / canvas / svg 的数量（可视化是否画出来）
     · #note 是否有解释文字
   ========================================================= */

import fs from 'node:fs';
import path from 'node:path';
import { cdpSession, ROOT, sleep } from './shot.mjs';

const EARLY = `
window.__err = [];
window.__log = [];
window.onerror = function (m, s, l, c) { window.__err.push(m + ' @' + l + ':' + c); };
window.addEventListener('unhandledrejection', function (e) { window.__err.push('promise: ' + e.reason); });
(function(){ var ce = console.error; console.error = function(){ window.__log.push([].join.call(arguments, ' ')); ce.apply(console, arguments); }; })();
`;

const only = process.argv[2];
const dirs = only
  ? [only]
  : fs.readdirSync(path.join(ROOT, 'cases')).filter((d) => fs.existsSync(path.join(ROOT, 'cases', d, 'case.json')));

const rows = [];
for (const d of dirs) {
  const id = path.basename(d);
  const file = path.join(ROOT, 'cases', id, 'demo', 'index.html');
  if (!fs.existsSync(file)) {
    let mode = '';
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'cases', id, 'case.json'), 'utf8'));
      mode = ((pkg.tabs || {}).demo || {}).mode || '';
    } catch (e) { /* 读不到就当普通缺页 */ }
    rows.push({ id, skip: mode === 'module' ? '模块示范（随站点运行，见路由巡检）' : '缺 demo/index.html' });
    continue;
  }
  const s = await cdpSession({ width: 1120, height: 900 });
  try {
    await s.goto('file:///' + file.replace(/\\/g, '/'), 1200, EARLY);
    await sleep(500);
    const info = await s.evalJs(`(function(){
      return {
        err: window.__err, log: window.__log,
        h: document.body.scrollHeight,
        figs: document.querySelectorAll('.dfig').length,
        svgs: document.querySelectorAll('svg').length,
        canvases: document.querySelectorAll('canvas').length,
        note: ((document.getElementById('note')||{}).innerText || '').length,
        ctrls: document.querySelectorAll('input[type=range], .seg button, .tog, .dbtn').length
      };
    })()`);
    rows.push({ id, ...info });
  } catch (e) {
    rows.push({ id, err: ['open failed: ' + e.message] });
  } finally { s.close(); }
}

console.log('案例'.padEnd(24) + '高度  图表 svg canvas 控件 说明文字  错误');
let bad = 0;
for (const r of rows) {
  if (r.skip) { console.log(r.id.padEnd(24) + '  ← ' + r.skip); continue; }
  const e = (r.err || []).length + (r.log || []).length;
  if (e) bad++;
  console.log(
    r.id.padEnd(24) +
    String(r.h).padStart(5) +
    String(r.figs).padStart(5) +
    String(r.svgs).padStart(4) +
    String(r.canvases).padStart(6) +
    String(r.ctrls).padStart(5) +
    String(r.note).padStart(8) +
    String(e).padStart(5) +
    (e ? '  ← ' + JSON.stringify((r.err || []).concat(r.log || [])).slice(0, 120) : '')
  );
}
console.log(bad ? '\n有 ' + bad + ' 个案例需要处理' : '\n全部通过');
