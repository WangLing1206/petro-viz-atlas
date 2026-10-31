/* =========================================================
   示范页自检 / 页面探针（开发期辅助）
   ---------------------------------------------------------
   1) 自检一个案例包的示范页：
        node tools/check-demo.mjs cases/<包名>
        → 打开 demo/index.html，收集 JS 错误与关键元素内容

   2) 在站内跑一段脚本并回读结果（可带 hash 路由）：
        node tools/probe.mjs <脚本文件> ["#/scene/wo1?tab=demo"] [等待ms]
        → 脚本最后 return 一个值（字符串会自动打印）

   脚本可以用：
        window.__err        已收集的运行时错误数组
        window.CASE_PACKS   案例包清单（站内）
        __extra             自定义返回值
   ========================================================= */

import fs from 'node:fs';
import path from 'node:path';
import { cdpSession, ROOT } from './shot.mjs';

const EARLY = `
window.__err = [];
window.onerror = function (m, s, l, c) { window.__err.push(m + ' @' + l + ':' + c); };
window.addEventListener('unhandledrejection', function (e) { window.__err.push('promise: ' + e.reason); });
`;

function pretty(v) {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v, null, 1); } catch (e) { return String(v); }
}

const mode = (process.argv[1] || '').replace(/\\/g, '/').endsWith('check-demo.mjs') ? 'demo' : 'probe';

if (mode === 'demo') {
  const pkg = process.argv[2];
  const extra = process.argv[3] || '';
  if (!pkg) { console.error('用法：node tools/check-demo.mjs cases/<包名> ["附加JS"]'); process.exit(1); }
  const htmlPath = path.join(ROOT, pkg, 'demo', 'index.html');
  if (!fs.existsSync(htmlPath)) { console.log('没有找到 ' + htmlPath); process.exit(1); }
  const url = 'file:///' + htmlPath.replace(/\\/g, '/');
  const s = await cdpSession({ width: 1120, height: 900 });
  try {
    await s.goto(url, 1200, EARLY);
    if (extra) { await s.evalJs('(function(){try{' + extra + '}catch(e){window.__err.push("extra: "+e.message)}})()'); await sleepMs(500); }
    const info = await s.evalJs(`(function(){
      var ids = {};
      ['graph','plans','cases','bars','note','st-sim','st-days','alarms','hits','clist','sect','proc','prob','advice','probs','feats','orders','zs','rank','parts','cm'].forEach(function(id){
        var el = document.getElementById(id);
        ids[id] = el ? ((el.innerText || el.textContent || '') + '').trim().length : -1;
      });
      return {
        err: window.__err,
        ids: ids,
        svgs: [].map.call(document.querySelectorAll('svg'), function(s){ return (s.id||'?') + ':' + s.innerHTML.length; }).join(' '),
        stats: [].map.call(document.querySelectorAll('.dstat .v'), function(n){ return (n.innerText || n.textContent || '').trim(); }).join(' | '),
        height: document.body.scrollHeight,
        note: (function(n){ return n ? (n.innerText || n.textContent || '').slice(0,110) : ''; })(document.getElementById('note'))
      };
    })()`);
    console.log(pretty(info));
    if (process.env.EXTRA) console.log(pretty(await s.evalJs(process.env.EXTRA)));
  } finally { s.close(); }
} else {
  const scriptFile = process.argv[2];
  const hash = process.argv[3] || '';
  const wait = Number(process.argv[4] || 1600);
  if (!scriptFile) { console.error('用法：node tools/probe.mjs <脚本文件> ["#/hash"] [等待ms]'); process.exit(1); }
  const code = fs.readFileSync(path.resolve(scriptFile), 'utf8');
  const url = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/') + hash;
  const s = await cdpSession({ width: 1280, height: 1000 });
  try {
    await s.goto(url, wait, EARLY);
    const out = await s.evalJs('(function(){' + code + '})()');
    console.log(pretty(out));
  } finally { s.close(); }
}

function sleepMs(ms) { return new Promise((r) => setTimeout(r, ms)); }
