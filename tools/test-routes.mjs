/* =========================================================
   路由巡检（开发期测试）
   ---------------------------------------------------------
   node tools/test-routes.mjs
   依次访问所有页面，收集 JS 运行时错误、控制台报错、关键结构
   （tab 数量、卡片数量、iframe 是否存在），输出一张表。
   ========================================================= */

import path from 'node:path';
import { cdpSession, ROOT, sleep } from './shot.mjs';

const SITE = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/');
const EARLY = `
window.__err = [];
window.__log = [];
window.onerror = function (m, s, l, c) { window.__err.push(m + ' @' + l + ':' + c); };
window.addEventListener('unhandledrejection', function (e) { window.__err.push('promise: ' + e.reason); });
(function(){ var ce = console.error; console.error = function(){ window.__log.push([].join.call(arguments, ' ')); ce.apply(console, arguments); }; })();
`;

const ROUTES = [
  ['总览', ''],
  ['作业链', '#/chain'],
  ['场景星图', '#/explore'],
  ['案例库', '#/cases'],
  ['案例包', '#/packs'],
  ['接入指南', '#/guide'],
  ['环节·修井', '#/stage/workover'],
  ['场景·wo1 背景', '#/scene/wo1'],
  ['场景·wo1 示范', '#/scene/wo1?tab=demo'],
  ['场景·wo5 示范', '#/scene/wo5?tab=demo'],
  ['场景·w1 示范', '#/scene/w1?tab=demo'],
  ['管理登录', '#/admin']
];

const s = await cdpSession({ width: 1280, height: 1000 });
const rows = [];
try {
  await s.goto(SITE, 1500, EARLY);
  for (const [name, hash] of ROUTES) {
    if (hash) {
      await s.evalJs('location.hash = ' + JSON.stringify(hash) + '; 1');
      await sleep(900);
    }
    const info = await s.evalJs(`(function(){
      return {
        title: document.title,
        h1: (document.querySelector('h1') || {}).textContent ? document.querySelector('h1').textContent.slice(0, 26) : '',
        cards: document.querySelectorAll('.scene-row,.fcase,.pack-card,.gstep,.lib-card,.cred-card').length,
        tabs: document.querySelectorAll('#tabs .tab').length,
        frame: document.querySelectorAll('iframe').length,
        err: window.__err.length,
        log: window.__log.length,
        bodyLen: document.body.innerText.length
      };
    })()`);
    rows.push({ name, hash: hash || '#/', ...info });
  }
  console.log('页面'.padEnd(14) + 'h1'.padEnd(24) + ' cards tabs frame err log  body');
  for (const r of rows) {
    console.log(
      r.name.padEnd(12) +
      (r.h1 || '-').padEnd(24) +
      String(r.cards).padStart(5) +
      String(r.tabs).padStart(5) +
      String(r.frame).padStart(6) +
      String(r.err).padStart(4) +
      String(r.log).padStart(4) +
      String(r.bodyLen).padStart(7) +
      (r.err ? '   ← ERR' : '')
    );
  }
  const errs = await s.evalJs('JSON.stringify(window.__err)');
  const logs = await s.evalJs('JSON.stringify(window.__log)');
  if (errs && errs !== '[]') console.log('\n运行时错误：' + errs);
  if (logs && logs !== '[]') console.log('\nconsole.error：' + logs);
} finally {
  s.close();
}
