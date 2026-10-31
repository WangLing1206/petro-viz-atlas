/* =========================================================
   端到端验收：案例包导入链路（开发期测试，可反复运行）
   ---------------------------------------------------------
   node tools/test-import.mjs

   用 DevTools 协议把真实文件塞进 <input type=file>（等价于用户
   选择/拖入文件夹），然后走完整流程：
     ① 第三方包 firstbreak-pick-case → 校验 → 添加 → 场景页三个 tab
     ② 刷新后是否还在（localStorage 持久化）
     ③ 同 id 覆盖内置案例（workover-plan-kg）→ 警告而不是报错
     ④ 移除上传版 → 回退到内置插件版
   ========================================================= */

import fs from 'node:fs';
import path from 'node:path';
import { cdpSession, ROOT, sleep } from './shot.mjs';

const SITE = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/');
const FB = path.join(ROOT, 'firstbreak-pick-case');
const MY = path.join(ROOT, 'cases', 'workover-plan-kg');

const s = await cdpSession({ width: 1280, height: 1000 });
const out = [];
const log = (k, v) => { out.push(k + ' = ' + v); process.stderr.write('· ' + k + String.fromCharCode(10)); };

async function setFiles(selectors, files) {
  const doc = await s.send('DOM.getDocument', { depth: -1 });
  const node = await s.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: selectors });
  if (!node || !node.nodeId) return false;
  await s.send('DOM.setFileInputFiles', { nodeId: node.nodeId, files });
  await sleep(600);
  return true;
}

try {
  /* ---------- 1. 第三方包：firstbreak-pick-case ---------- */
  await s.goto(SITE, 1800);
  await s.evalJs('document.querySelector("[data-import]").click()');
  await sleep(400);
  log('modal_open', await s.evalJs('!document.getElementById("import-modal").hidden'));

  await setFiles('#imp-file', [
    path.join(FB, 'case.json'),
    path.join(FB, 'README.txt'),
    path.join(FB, 'demo', 'index.html'),
    path.join(FB, 'demo', 'demo.css'),
    path.join(FB, 'demo', 'demo.js')
  ]);
  const v1 = await s.evalJs(`(function(){
    var items = [].map.call(document.querySelectorAll('#imp-res .imp-item'), function(n){
      return n.getAttribute('data-lv') + ':' + n.querySelector('.imp-m').textContent.trim();
    });
    return { count: document.getElementById('imp-count').textContent.trim(),
             mode: document.getElementById('imp-mode').textContent.trim(),
             title: document.getElementById('imp-title-in').value,
             scene: document.getElementById('imp-scene').value,
             id: document.getElementById('imp-id').value,
             warn: items.filter(function(x){return x.indexOf('error')===0;}).length,
             items: items.slice(0, 6) };
  })()`);
  log('fb_valid', JSON.stringify(v1));
  if (v1.warn) throw new Error('firstbreak 包校验出现错误，终止');

  await s.evalJs('document.getElementById("imp-ok").click()');
  await sleep(1400);
  const afterAdd = await s.evalJs(`(function(){
    var c = Cases.get('firstbreak-stalta');
    var sc = ATLAS.index.byScene['s3'];
    var cases = Cases.bySceneAll('s3');
    return {
      registered: !!c, imported: !!(c && c.imported),
      hash: location.hash,
      sceneName: sc && sc.name,
      tabs: document.querySelectorAll('#tabs .tab').length,
      demoRoot: (document.getElementById('case-demo-root')||{}).innerHTML.length || 0,
      frame: document.querySelectorAll('#case-demo-root iframe').length
    };
  })()`);
  log('fb_added', JSON.stringify(afterAdd));

  /* 点开「可运行示范」tab，确认 sandbox iframe 真的跑起来 */
  await s.evalJs("(document.querySelector('[data-tab=\"demo\"]')||{click:function(){}}).click()");
  await sleep(1600);
  log('fb_demo', await s.evalJs(`(function(){
    var f = document.querySelector('#case-demo-root iframe');
    var inside = null;
    try { inside = f ? f.getAttribute('srcdoc').length : 0; } catch (e) {}
    return JSON.stringify({ frame: !!f, h: f ? Math.round(f.getBoundingClientRect().height) : 0, srcdoc: inside });
  })()`));

  /* ---------- 2. 刷新后仍在 ---------- */
  await s.goto(SITE, 1800);
  log('fb_after_reload', await s.evalJs('!!Cases.get("firstbreak-stalta")'));
  log('fb_storage', await s.evalJs('(function(){try{return JSON.parse(localStorage.getItem("atlas.casepack.v2")||"[]").length;}catch(e){return "ERR";}})()'));

  /* ---------- 3. 同 id 覆盖内置案例 ---------- */
  await s.evalJs('window.confirm = function(){return true;}');
  await s.evalJs('CaseImport.remove("firstbreak-stalta")');
  await sleep(400);
  log('fb_removed', await s.evalJs('!Cases.get("firstbreak-stalta")'));

  await s.evalJs('document.querySelector("[data-import]").click()');
  await sleep(300);
  await setFiles('#imp-file', [
    path.join(MY, 'case.json'),
    path.join(MY, 'README.txt'),
    path.join(MY, 'demo', 'index.html'),
    path.join(MY, 'demo', 'demo.css'),
    path.join(MY, 'demo', 'demo.js')
  ]);
  const v2 = await s.evalJs(`(function(){
    var items = [].map.call(document.querySelectorAll('#imp-res .imp-item'), function(n){
      return n.getAttribute('data-lv') + ':' + n.querySelector('.imp-m').textContent.trim();
    });
    return { count: document.getElementById('imp-count').textContent.trim(),
             errs: items.filter(function(x){return x.indexOf('error')===0;}).length,
             warns: items.filter(function(x){return x.indexOf('warn')===0;}).length,
             firstWarn: (items.filter(function(x){return x.indexOf('warn')===0;})[0]||'') };
  })()`);
  log('sameid_valid', JSON.stringify(v2));
  await s.evalJs('document.getElementById("imp-ok").click()');
  await sleep(1200);
  log('sameid_state', await s.evalJs(`(function(){
    var all = Cases.bySceneAll('wo1');
    return JSON.stringify({ n: all.length, id: all[0] && all[0].id, imported: all[0] && !!all[0].imported,
      tabs: document.querySelectorAll('#tabs .tab').length,
      frame: document.querySelectorAll('#case-demo-root iframe').length });
  })()`));

  /* ---------- 4. 移除上传版 → 回退内置版 ---------- */
  await s.evalJs('CaseImport.remove("workover-plan-kg")');
  await sleep(600);
  log('override_removed', await s.evalJs(`(function(){
    var all = Cases.bySceneAll('wo1');
    return JSON.stringify({ n: all.length, imported: all[0] && !!all[0].imported, restore: (window.Cases&&!!Cases.get('workover-plan-kg')) });
  })()`));

  /* ---------- 5. 同一场景的第二个案例（其他同学的包） ---------- */
  const tmpDir = path.join(ROOT, '_tmp_case');
  fs.mkdirSync(path.join(tmpDir, 'demo'), { recursive: true });
  const pkg = JSON.parse(fs.readFileSync(path.join(FB, 'case.json'), 'utf8'));
  pkg.id = 'firstbreak-stalta-alt';
  pkg.title = '初至波自动拾取（同场景第二版）';
  fs.writeFileSync(path.join(tmpDir, 'case.json'), JSON.stringify(pkg, null, 2));
  for (const f of ['index.html', 'demo.css', 'demo.js']) {
    fs.copyFileSync(path.join(FB, 'demo', f), path.join(tmpDir, 'demo', f));
  }

  /* 先把「初版」重新传回去，再传第二版，才能验证同场景多案例 */
  await s.goto(SITE, 1600);
  await s.evalJs('document.querySelector("[data-import]").click()');
  await sleep(300);
  await setFiles('#imp-file', [
    path.join(FB, 'case.json'),
    path.join(FB, 'demo', 'index.html'),
    path.join(FB, 'demo', 'demo.css'),
    path.join(FB, 'demo', 'demo.js')
  ]);
  await s.evalJs('document.getElementById("imp-ok").click()');
  await sleep(900);

  await s.evalJs('document.querySelector("[data-import]").click()');
  await sleep(300);
  await setFiles('#imp-file', [
    path.join(tmpDir, 'case.json'),
    path.join(tmpDir, 'demo', 'index.html'),
    path.join(tmpDir, 'demo', 'demo.css'),
    path.join(tmpDir, 'demo', 'demo.js')
  ]);
  log('alt_valid', await s.evalJs('document.getElementById("imp-count").textContent.trim()'));
  await s.evalJs('document.getElementById("imp-ok").click()');
  await sleep(1200);
  log('multi_case', await s.evalJs(`(function(){
    var all = Cases.bySceneAll('s3');
    return JSON.stringify({
      n: all.length,
      ids: all.map(function(c){return c.id;}),
      switcher: document.querySelectorAll('.case-switch [data-case]').length
    });
  })()`));
  await s.evalJs('CaseImport.remove("firstbreak-stalta-alt")');
  await sleep(300);
  await s.evalJs('CaseImport.remove("firstbreak-stalta")');
  await sleep(300);
  log('alt_removed', await s.evalJs("!Cases.get('firstbreak-stalta-alt')"));
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { }

  /* ---------- 6. 控制台 / 页面自检 ---------- */
  log('pageErrors', await s.evalJs('JSON.stringify(window.__err||[])'));
  log('registryProblems', await s.evalJs('JSON.stringify(Cases.problems())'));
  log('stats', await s.evalJs('JSON.stringify(Cases.stats())'));
} catch (e) {
  log('FATAL', e.message);
} finally {
  s.close();
  console.log(out.join('\n'));
}
