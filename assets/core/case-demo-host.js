/* =========================================================
   案例示范宿主 Case Demo Host
   ---------------------------------------------------------
   把「案例包里的示范文件」渲染成可交互的页面。两种模式：

   page    —— 包里有 index.html
              整页放进 sandbox iframe，样式/脚本完全隔离，
              写多复杂都不会污染主站。
   module  —— 包里有 demo.js 但没有 html
              挂进 Shadow DOM 并执行 demo.js，导出的 mount(root, api)
              往里画东西；上传的 CSS 也注入 Shadow DOM，不外泄。

   所有文件都转成 data URL 内联，因此 file:// 直接打开也能跑，
   不依赖本地服务器、不发起任何网络请求。

   对外接口：
     CaseDemoHost.create(container, pkg, ctx) -> { mode, destroy() }
     CaseDemoHost.resolveMode(pkg) -> 'page' | 'module' | 'none'
     pkg = { files:[{name,size,mime,enc,data}], demo:{mode,html,js,height} }
   ========================================================= */

(function (global) {
  'use strict';

  var MIME = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
    mp4: 'video/mp4', webm: 'video/webm',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
    json: 'application/json', csv: 'text/csv', txt: 'text/plain', pdf: 'application/pdf'
  };

  var TEXT_EXT = ['json', 'js', 'mjs', 'css', 'html', 'htm', 'svg', 'txt', 'csv', 'tsv', 'md', 'xml', 'yaml', 'yml', 'geojson'];

  /* Shadow DOM 里要继承的设计令牌 */
  var TOKENS = ['--paper', '--paper-2', '--paper-3', '--card', '--card-soft',
    '--line', '--line-2', '--line-3', '--ink', '--ink-2', '--ink-3', '--ink-4', '--ink-inv',
    '--jade', '--jade-d', '--jade-l', '--clay', '--clay-d', '--clay-l',
    '--ok', '--ok-bg', '--warn', '--warn-bg', '--bad', '--bad-bg',
    '--sans', '--mono', '--r-s', '--r-m', '--r-l', '--sh-1', '--sh-2'];

  var BASE_CSS =
    '.cd-box{display:block;font-family:var(--sans,system-ui,sans-serif);' +
    'font-size:13px;line-height:1.72;color:var(--ink,#242b2e);padding:2px 0 6px}' +
    '.cd-err{border:1px solid var(--bad,#b05a51);background:var(--bad-bg,#f9e9e5);' +
    'color:var(--bad,#b05a51);border-radius:8px;padding:11px 13px;font-size:12px;line-height:1.7}' +
    '.cd-err b{display:block;margin-bottom:4px;font-size:12.5px}' +
    '.cd-err code{font-family:var(--mono,monospace);background:rgba(0,0,0,.05);padding:1px 4px;border-radius:3px}';

  var seq = 0;

  /* ---------------- 小工具 ---------------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function extOf(name) {
    var m = /\.([a-z0-9]+)$/i.exec(String(name).split('?')[0].split('#')[0]);
    return m ? m[1].toLowerCase() : '';
  }
  function baseOf(name) { return String(name).split('/').pop(); }
  function isCss(n) { return extOf(n) === 'css'; }
  function isJs(n) { var e = extOf(n); return e === 'js' || e === 'mjs'; }
  function isHtml(n) { var e = extOf(n); return e === 'html' || e === 'htm'; }
  function isText(n) { return TEXT_EXT.indexOf(extOf(n)) >= 0; }
  function mimeOf(n) { return MIME[extOf(n)] || (isText(n) ? 'text/plain' : 'application/octet-stream'); }

  function findFile(files, ref) {
    if (!ref || !files) return null;
    var r = String(ref).replace(/^\.\//, '').split('?')[0].split('#')[0];
    var i, hit = null;
    for (i = 0; i < files.length; i++) if (files[i].name === r) return files[i];
    var bn = baseOf(r).toLowerCase();
    for (i = 0; i < files.length; i++) if (baseOf(files[i].name).toLowerCase() === bn) return files[i];
    return hit;
  }
  function firstExt(files, test) {
    for (var i = 0; i < (files || []).length; i++) if (test(files[i].name)) return files[i];
    return null;
  }

  /* 文件 → 可直接放进 src/href/url() 的地址 */
  function urlOf(f) {
    if (!f) return '';
    if (f.enc === 'dataurl') return f.data;
    return 'data:' + (f.mime || mimeOf(f.name)) + ';charset=utf-8,' + encodeURIComponent(f.data);
  }

  /* ---------------- 模式判定 ---------------- */
  function resolveMode(pkg) {
    var d = (pkg && pkg.demo) || {};
    var files = (pkg && pkg.files) || [];
    var mode = d.mode || 'auto';
    if (mode === 'builtin' || mode === 'page' || mode === 'module') return mode;
    if (findFile(files, d.html) || firstExt(files, isHtml)) return 'page';
    if (findFile(files, d.js) || firstExt(files, isJs)) return 'module';
    return 'none';
  }

  /* ---------------- page 模式：拼一份自包含 HTML ---------------- */
  function cssText(css, map, files) {
    return String(css)
      .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, function (all, q, ref) {
        if (/^(data:|https?:|\/\/)/i.test(ref)) return all;
        var f = findFile(files, ref);
        return f ? 'url("' + map[f.name] + '")' : all;
      })
      .replace(/<\/style/gi, '<\\/style');
  }
  function jsText(js) {
    return String(js).replace(/<\/script/gi, '<\\/script');
  }

  function buildPageDoc(pkg, token) {
    var files = pkg.files || [];
    var d = pkg.demo || {};
    var htmlFile = findFile(files, d.html) || firstExt(files, isHtml);
    var html = htmlFile ? String(htmlFile.data)
      : '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><p>包里没有 HTML 文件。</p></body></html>';

    /* 资源表只收"素材"（图片、JSON 等），html/css/js 本身不进去，避免体积翻倍 */
    var map = {};
    files.forEach(function (f) {
      if (isHtml(f.name) || isJs(f.name) || isCss(f.name)) return;
      map[f.name] = urlOf(f);
      if (!map[baseOf(f.name)]) map[baseOf(f.name)] = urlOf(f);
    });

    var used = {};

    /* 1. <link rel=stylesheet> → <style> */
    html = html.replace(/<link\b[^>]*>/gi, function (tag) {
      if (!/stylesheet/i.test(tag)) return tag;
      var m = /href\s*=\s*["']([^"']+)["']/i.exec(tag);
      var f = m && findFile(files, m[1]);
      if (!f || !isCss(f.name)) return tag;
      used[f.name] = 1;
      return '<style data-src="' + esc(m[1]) + '">' + cssText(f.data, map, files) + '</style>';
    });

    /* 2. <script src> → 内联 */
    html = html.replace(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>\s*<\/script\s*>/gi, function (tag, src) {
      var f = findFile(files, src);
      if (!f || !isJs(f.name)) return tag;
      used[f.name] = 1;
      return '<script data-src="' + esc(src) + '">' + jsText(f.data) + '</script' + '>';
    });

    /* 3. 其它资源引用 → data URL */
    html = html.replace(/\b(src|href|poster)\s*=\s*["']([^"']+)["']/gi, function (all, attr, ref) {
      if (/^(data:|https?:|mailto:|tel:|#|\/\/)/i.test(ref)) return all;
      var f = findFile(files, ref);
      if (!f || isHtml(f.name) || isJs(f.name) || isCss(f.name)) return all;
      return attr + '="' + map[f.name] + '"';
    });

    /* 4. 未被引用的 css / js 追加到末尾 */
    var tail = '';
    files.forEach(function (f) {
      if (used[f.name] || !isCss(f.name)) return;
      used[f.name] = 1;
      tail += '<style data-src="' + esc(f.name) + '">' + cssText(f.data, map, files) + '</style>';
    });
    files.forEach(function (f) {
      if (used[f.name] || !isJs(f.name)) return;
      used[f.name] = 1;
      tail += '<script data-src="' + esc(f.name) + '">' + jsText(f.data) + '</script' + '>';
    });

    /* 5. 注入资源表与高度上报 */
    var assetsJson = JSON.stringify(map).replace(/</g, '\\u003c');
    var head =
      '<script>window.__ASSETS__=' + assetsJson + ';' +
      'window.caseAsset=function(n){return window.__ASSETS__[n]||""};' +
      '(function(){var last=-1;function send(){' +
      'var h=Math.max(document.body?document.body.scrollHeight:0,document.documentElement.scrollHeight);' +
      'h=Math.min(h,4200);if(Math.abs(h-last)>2){last=h;' +
      'try{parent.postMessage({__caseDemo:"' + token + '",h:h},"*")}catch(e){}}}' +
      'document.addEventListener("DOMContentLoaded",send);window.addEventListener("load",send);' +
      'try{if(window.ResizeObserver){new ResizeObserver(send).observe(document.documentElement)}}catch(e){}' +
      'var n=0,t=setInterval(function(){send();if(++n>40)clearInterval(t)},400);' +
      '})();</script' + '>';

    if (/<head[^>]*>/i.test(html)) {
      html = html.replace(/<head[^>]*>/i, function (m) { return m + head; });
    } else if (/<html[^>]*>/i.test(html)) {
      html = html.replace(/<html[^>]*>/i, function (m) { return m + '<head><meta charset="utf-8">' + head + '</head>'; });
    } else {
      html = '<!DOCTYPE html><html><head><meta charset="utf-8">' + head + '</head><body>' + html + '</body></html>';
    }

    if (tail) {
      if (/<\/body>/i.test(html)) html = html.replace(/<\/body>/i, tail + '</body>');
      else html += tail;
    }
    return html;
  }

  function createPage(host, pkg, ctx) {
    var token = 'cd' + (++seq) + Date.now().toString(36);
    var minH = Math.max(240, Math.min(520, Number(pkg.demo && pkg.demo.height) || 520));

    var frame = document.createElement('iframe');
    frame.className = 'cd-iframe';
    frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups allow-downloads');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('title', (pkg.meta && pkg.meta.title ? pkg.meta.title : '案例示范') + '（沙箱）');
    frame.style.height = minH + 'px';
    frame.srcdoc = buildPageDoc(pkg, token);
    host.appendChild(frame);

    function onMsg(e) {
      if (e.source !== frame.contentWindow) return;
      var d = e.data;
      if (!d || d.__caseDemo !== token) return;
      var h = Math.min(6200, Math.max(minH, Number(d.h) + 2));
      frame.style.height = h + 'px';
    }
    global.addEventListener('message', onMsg);

    return {
      mode: 'page',
      destroy: function () {
        global.removeEventListener('message', onMsg);
        frame.remove();
      }
    };
  }

  /* ---------------- module 模式：Shadow DOM + demo.js ---------------- */
  function tokenCss() {
    var cs = global.getComputedStyle(document.documentElement);
    var out = ':host{';
    TOKENS.forEach(function (t) {
      var v = cs.getPropertyValue(t);
      if (v) out += t + ':' + v.trim() + ';';
    });
    return out + '}';
  }

  function errBox(box, title, detail) {
    var d = document.createElement('div');
    d.className = 'cd-err';
    d.innerHTML = '<b>' + esc(title) + '</b>' + esc(detail || '');
    box.appendChild(d);
  }

  function createModule(host, pkg, ctx) {
    var files = pkg.files || [];
    var d = pkg.demo || {};
    var shadow = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

    var style = document.createElement('style');
    style.textContent = tokenCss() + '\n' + BASE_CSS + '\n' +
      files.filter(function (f) { return isCss(f.name); }).map(function (f) { return String(f.data); }).join('\n');
    shadow.appendChild(style);

    var box = document.createElement('div');
    box.className = 'cd-box';
    shadow.appendChild(box);

    var cleanups = [];
    var api = {
      asset: function (name) { return urlOf(findFile(files, name)); },
      readText: function (name) {
        var f = findFile(files, name);
        return Promise.resolve(f && f.enc === 'text' ? f.data : '');
      },
      list: function () { return files.map(function (f) { return f.name; }); },
      scene: (ctx && ctx.scene) || null,
      kase: (ctx && ctx.kase) || null,
      onDestroy: function (fn) { if (typeof fn === 'function') cleanups.push(fn); },
      height: function (px) { if (px) host.style.minHeight = Number(px) + 'px'; }
    };

    var jsFile = findFile(files, d.js) || firstExt(files, isJs);
    var live = null;

    if (!jsFile) {
      errBox(box, '没有找到 demo.js', '把示范脚本命名为 demo.js 放进包里，或改用 index.html 整页模式。');
    } else {
      var code = String(jsFile.data);
      var mod = { exports: {} };
      var fn = null;
      try {
        fn = new Function('module', 'exports', 'api', 'root', 'console', code + '\n;return module.exports;');
      } catch (e) {
        errBox(box, 'demo.js 有语法错误（第 ' + (e.lineNumber || '?') + ' 行附近）', e.message);
      }
      if (fn) {
        try { delete global.__CASE_MOUNT__; } catch (e) { global.__CASE_MOUNT__ = null; }
        var out = null;
        try {
          out = fn(mod, mod.exports, api, box, global.console) || mod.exports;
        } catch (e) {
          errBox(box, 'demo.js 在加载阶段抛出异常', e.message);
        }
        if (out) {
          var cand = (typeof out.mount === 'function') ? out
            : (out.default && typeof out.default.mount === 'function') ? out.default
              : (typeof global.__CASE_MOUNT__ === 'function') ? { mount: global.__CASE_MOUNT__ }
                : null;
          if (!cand) {
            errBox(box, 'demo.js 没有导出 mount',
              '支持三种写法：module.exports={mount(root,api){}}、exports.mount=function(root,api){}、window.__CASE_MOUNT__=function(root,api){}。');
          } else {
            try {
              live = cand.mount(box, api) || cand;
            } catch (e) {
              errBox(box, 'mount() 执行失败', e.message);
            }
          }
        }
      }
    }

    return {
      mode: 'module',
      destroy: function () {
        try { if (live && typeof live.unmount === 'function') live.unmount(); } catch (e) { }
        cleanups.forEach(function (fn) { try { fn(); } catch (e) { } });
        try { if (shadow.host === host) host.innerHTML = ''; } catch (e) { }
      }
    };
  }

  /* ---------------- 入口 ---------------- */
  function create(container, pkg, ctx) {
    if (!container) return { mode: 'none', destroy: function () { } };
    container.innerHTML = '';
    var mode = resolveMode(pkg);
    if (mode === 'page') return createPage(container, pkg, ctx);
    if (mode === 'module') return createModule(container, pkg, ctx);
    return { mode: 'none', destroy: function () { } };
  }

  global.CaseDemoHost = {
    create: create,
    resolveMode: resolveMode,
    buildPageDoc: buildPageDoc,
    findFile: findFile,
    isText: isText,
    mimeOf: mimeOf
  };

})(window);
