/* =========================================================
   无头 Chrome 工具（开发期辅助，不属于网站运行时代码）
   ---------------------------------------------------------
   node tools/shot.mjs <url> <out.png> [宽] [高] [等待ms]

   为什么用 CDP 而不是 chrome --screenshot：
     CLI 的 --screenshot 在 headless 下不会把**跨源 / 沙箱 iframe**
     的内容合成进图片，案例示范（整页模式）全是 sandbox iframe，
     用 CLI 截出来会是一片空白，容易误判成"页面坏了"。
     这里改用 DevTools 协议截图，看到的就是用户看到的样子。

   环境变量：
     CLICK="sel1,sel2"   截图前依次点击
     EVAL="js"           截图前执行一段脚本
   ========================================================= */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
];
const CHROME = process.env.CHROME || CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!CHROME) { console.error('找不到 Chrome / Edge，可用环境变量 CHROME 指定'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function cdpSession(opts = {}) {
  const width = opts.width || 1440;
  const height = opts.height || 1000;
  const port = opts.port || (9500 + Math.floor(Math.random() * 400));
  const mobile = !!opts.mobile;
  const profile = path.join(process.env.TEMP || '/tmp', 'zcode-shot-' + process.pid + '-' + port);

  const child = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-features=Translate',
    '--user-data-dir=' + profile,
    '--allow-file-access-from-files', '--hide-scrollbars',
    '--remote-debugging-port=' + port,
    '--window-size=' + width + ',' + height,
    'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let errBuf = '';
  child.stderr.on('data', (d) => { errBuf += d.toString(); });

  let target = null;
  const HOSTS = ['http://127.0.0.1:', 'http://[::1]:'];
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(200);
    for (const h of HOSTS) {
      try {
        const list = await (await fetch(h + port + '/json/list')).json();
        target = list.find((t) => t.type === 'page');
        if (target) break;
      } catch (e) { /* 端口还没起来 / 换了协议族 */ }
    }
  }
  if (!target) {
    child.kill();
    throw new Error('Chrome 调试端口没起来（port=' + port + '）' + String.fromCharCode(10) + errBuf.slice(-800));
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  let send = null;
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || m.error); pending.delete(m.id); return; }
    /* 原生 alert/confirm 会阻塞渲染进程，测试里一律自动接受 */
    if (m.method === 'Page.javascriptDialogOpening' && send) {
      send('Page.handleJavaScriptDialog', { accept: true });
    }
  };
  await new Promise((r) => { ws.onopen = r; });

  send = (method, params) => new Promise((res) => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });

  return {
    send,
    width, height,
    async goto(url, wait = 1400, earlyScript) {
      await send('Page.enable');
      await send('Runtime.enable');
      if (mobile) {
        /* 用「精确 CSS 宽度」而不是 mobile:true：后者会触发缩放到适配，
           innerWidth 会变成 647 之类的怪值，做响应式检查会误判 */
        await send('Emulation.setDeviceMetricsOverride', {
          width, height, deviceScaleFactor: 2, mobile: false
        });
      }
      if (earlyScript) await send('Page.addScriptToEvaluateOnNewDocument', { source: earlyScript });
      const r = await send('Page.navigate', { url });
      await sleep(wait);
      return r;
    },
    async evalJs(expr) {
      const r = await send('Runtime.evaluate', {
        expression: expr, returnByValue: true, awaitPromise: true
      });
      if (r && r.exceptionDetails) return { __error: r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description) };
      return r && r.result ? r.result.value : null;
    },
    async shot(out, maxH = 8000) {
      const lm = await send('Page.getLayoutMetrics');
      const cs = (lm && lm.cssContentSize) || { width, height };
      const h = Math.min(maxH, Math.ceil(cs.height) + 20);
      const r = await send('Page.captureScreenshot', {
        format: 'png', fromSurface: true, captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: Math.ceil(cs.width), height: h, scale: 1 }
      });
      if (!r || !r.data) return false;
      fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
      fs.writeFileSync(path.resolve(out), Buffer.from(r.data, 'base64'));
      return true;
    },
    close() {
      try { ws.close(); } catch (e) { }
      try { child.kill(); } catch (e) { }
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }
    }
  };
}

/* ---------------- CLI ---------------- */
const isMain = process.argv[1] && /shot\.mjs$/.test(process.argv[1].replace(/\\/g, '/'));
if (isMain) {
  const [, , url, out, w = '1440', h = '2000', wait = '1200'] = process.argv;
  if (!url || !out) { console.error('用法：node tools/shot.mjs <url> <out.png> [宽] [高] [等待ms]'); process.exit(1); }
  const s = await cdpSession({ width: Number(w), height: Number(h), mobile: process.env.MOBILE === '1' });
  try {
    await s.goto(url, Number(wait));
    for (const sel of (process.env.CLICK || '').split(',').filter(Boolean)) {
      const ok = await s.evalJs('(function(){var n=document.querySelector(' + JSON.stringify(sel) + ');if(n){n.click();return 1;}return 0;})()');
      await sleep(450);
      if (!ok) console.log('（没有找到点击目标：' + sel + '）');
    }
    if (process.env.EVAL) { await s.evalJs(process.env.EVAL); await sleep(500); }
    /* 整页截图时把「滚动进入」的元素一次性显形，否则首屏以下会是空白 */
    if (process.env.REVEAL !== '0') {
      await s.evalJs("(function(){var n=document.querySelectorAll('[data-rv]');for(var i=0;i<n.length;i++)n[i].classList.add('rv-in');return n.length;})()");
      await sleep(300);
    }
    const ok = await s.shot(out);
    console.log('截图：' + path.resolve(out) + (ok ? ' ✓' : ' ✗'));
  } finally { s.close(); }
}

export { ROOT, CHROME, sleep };
