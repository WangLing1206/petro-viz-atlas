/* =========================================================
   案例包库 Pack Library（#/packs）
   ---------------------------------------------------------
   站点自带的案例包（cases/ 目录）在生成插件时会把「清单 + 示范
   文件」原样注册进 window.CASE_PACKS。这个页面把它们列出来，提供：

     · 在线试跑：与上传后完全一致的 sandbox 渲染
     · 下载 .zip：解压后可直接拖回「＋ 添加案例」，验证导入链路
     · 打开场景页：直接看三个 tab

   所以「添加案例」这条路是自证可用的：不写代码也能把这里的包
   下载下来再拖回弹窗。
   ========================================================= */

(function (global) {
  'use strict';

  var esc = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  };

  function all() {
    var P = global.CASE_PACKS || {};
    return Object.keys(P).map(function (k) { return P[k]; }).sort(function (a, b) {
      var sa = (global.ATLAS.index.byScene[a.meta.sceneId] || {}).stageIdx || 99;
      var sb = (global.ATLAS.index.byScene[b.meta.sceneId] || {}).stageIdx || 99;
      return sa - sb || String(a.meta.id).localeCompare(String(b.meta.id));
    });
  }

  function sizeOf(p) {
    var total = 0;
    (p.files || []).forEach(function (f) { total += f.size || 0; });
    return Math.round(total / 1024);
  }

  function chips(p) {
    var M = global.ATLAS.methods;
    return (p.pkg.methods || []).map(function (k) {
      var m = M[k];
      if (!m) return '';
      return '<span class="mtag sm" data-m="' + (m.colorKey || k) + '"><b>' + esc(m.abbr) + '</b>' + esc(m.name) + '</span>';
    }).join('');
  }

  function card(p) {
    var sc = global.ATLAS.index.byScene[p.meta.sceneId] || {};
    var n = (p.files || []).length;
    var is3d = /-3d$/.test(p.meta.id);
    return '<article class="pack-card" data-rv>' +
      '<div class="pc-top"><span class="pc-dir">cases/' + esc(p.dir) + '/</span>' +
      '<span class="db ' + (is3d ? 'three' : 'plain') + '">' +
      (is3d ? '3D 示范' : (p.demo && p.demo.mode === 'auto' ? '整页示范' : esc((p.demo || {}).mode || '示范'))) + '</span></div>' +
      '<h3>' + esc(p.meta.title) + '</h3>' +
      '<div class="pc-scene"><b>' + esc(sc.stageName || '') + '</b> · ' + esc(sc.name || '') + '</div>' +
      '<div class="pc-meta"><span>' + n + ' 个文件 · ' + sizeOf(p) + ' KB</span>' + chips(p) + '</div>' +
      '<p class="pc-intro">' + esc((p.demo || {}).intro || '') + '</p>' +
      '<div class="pc-acts">' +
      '<button class="btn sm primary" data-pv="' + esc(p.meta.id) + '">▶ 在线试跑</button>' +
      '<button class="btn sm" data-zip="' + esc(p.meta.id) + '">↓ 下载 .zip</button>' +
      '<a class="btn sm ghost" href="#/scene/' + esc(p.meta.sceneId) + '?tab=demo&case=' + esc(p.meta.id) + '">场景页 →</a>' +
      '</div></article>';
  }

  function pageHTML() {
    var list = all();
    var covered = {};
    list.forEach(function (p) { covered[p.meta.sceneId] = 1; });
    return '<main class="wrap">' +
      '<nav class="crumb"><a href="#/">总览</a><span class="sep">/</span><span class="cur">案例包</span></nav>' +
      '<div class="page-head"><div class="ph-top"><div>' +
      '<div class="ph-idx">CASE PACKAGES · ' + list.length + ' 个包</div>' +
      '<h1>可直接导入的案例包<span class="en">DROP-IN CASE PACKAGES</span></h1>' +
      '<p class="blurb">下面每一个包都是一个独立文件夹：一份 <b>case.json</b> 清单 + 一套 <b>demo/</b> 示范页。' +
      '它们既已作为插件接入本站，也可以下载下来重新拖回「＋ 添加案例」——导入链路与任何第三方案例包完全一致。</p>' +
      '</div><div class="ph-stat">' +
      '<div><div class="n">' + list.length + '</div><div class="l">案例包</div></div>' +
      '<div><div class="n">' + Object.keys(covered).length + '</div><div class="l">覆盖场景</div></div>' +
      '</div></div></div>' +

      '<div class="pack-how">' +
      '<div class="ph-step"><span class="n">01</span><div><b>下载任意一个包</b><p>下载得到 <code>案例名.zip</code>，解压后是一个同名文件夹（内含 case.json 与 demo/）。</p></div></div>' +
      '<div class="ph-step"><span class="n">02</span><div><b>把文件夹拖进「添加案例」</b><p>点右上角按钮，把整个文件夹拖进虚线框；右侧会逐项校验，红色为必须处理的错误。</p></div></div>' +
      '<div class="ph-step"><span class="n">03</span><div><b>校验通过后添加</b><p>场景页立即出现三个 tab。与内置版本同 id 时，以你上传的这份为准；移除后自动回退。</p></div></div>' +
      '<div class="pack-how-act"><button class="btn primary" data-import>＋ 打开「添加案例」</button>' +
      '<span class="small muted">也可以直接点某个包的「↓ 下载 .zip」开始</span></div>' +
      '</div>' +

      '<div class="pack-grid">' + list.map(card).join('') + '</div>' +

      '<div class="pending" style="margin-top:26px"><div class="pending-top">' +
      '<span class="badge-ready">兼容性</span><h3>别人的案例包同样能导入</h3></div>' +
      '<p>案例与站点之间的接口只有三样东西：<b>case.json 的字段</b>、<b>demo/ 的文件约定</b>、<b>三个 tab 的内容结构</b>。' +
      '只要这两样不变，页面怎么改版都不会影响导入——这也是本次改版只动外壳、不动契约的原因。</p>' +
      '<div class="pending-actions"><a class="btn" href="#/guide">看接入指南的契约字段 →</a>' +
      '<a class="btn ghost" href="#/cases">看案例库的实时校验</a></div></div>' +
      '</main>';
  }

  /* ---------------- 预览弹窗 ---------------- */
  var modal = null, handle = null;

  function closePv() {
    if (modal) modal.hidden = true;
    if (handle) { try { handle.destroy(); } catch (e) { } handle = null; }
    document.documentElement.classList.remove('mdl-open');
  }

  function openPv(id) {
    var p = (global.CASE_PACKS || {})[id];
    if (!p) return;
    if (!modal) {
      modal = document.createElement('div');
      modal.className = 'mdl';
      modal.id = 'pack-preview';
      modal.hidden = true;
      modal.innerHTML =
        '<div class="mdl-bg" data-pv-close></div>' +
        '<div class="mdl-p" role="dialog" aria-modal="true">' +
        '<div class="mdl-h"><div><div class="eyebrow">SANDBOX PREVIEW · cases/' + esc(p.dir) + '/</div>' +
        '<h3 id="pv-title">示范预览</h3></div><button class="mdl-x" data-pv-close aria-label="关闭">✕</button></div>' +
        '<div class="mdl-b pv-body"><div id="pv-body"></div></div>' +
        '<div class="mdl-f"><span class="imp-tip">与上传后完全一致：整页示范跑在 sandbox iframe 里，样式不会污染主站。</span>' +
        '<span style="flex:1"></span>' +
        '<button class="btn" data-pv-close>关闭</button>' +
        '<button class="btn primary" data-zip="' + esc(id) + '">↓ 下载这个包</button></div>' +
        '</div>';
      document.body.appendChild(modal);
      modal.addEventListener('click', function (e) {
        if (e.target.closest('[data-pv-close]')) closePv();
      });
    }
    modal.querySelector('#pv-title').textContent = p.meta.title;
    modal.hidden = false;
    document.documentElement.classList.add('mdl-open');
    var body = modal.querySelector('#pv-body');
    if (handle) { try { handle.destroy(); } catch (e) { } }
    handle = global.CaseDemoHost.create(body, { files: p.files, demo: p.demo, meta: p.meta }, {});
  }

  /* ---------------- 下载 .zip ---------------- */
  function downloadZip(id) {
    var p = (global.CASE_PACKS || {})[id];
    if (!p || !global.CaseImport || !global.CaseImport.makeZip) return;
    var entries = [{ name: p.dir + '/case.json', text: JSON.stringify(p.pkg, null, 2) }];
    (p.files || []).forEach(function (f) {
      if (f.enc === 'text') entries.push({ name: p.dir + '/' + f.name, text: f.data });
    });
    var blob = global.CaseImport.makeZip(entries);
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = p.dir + '.zip';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }

  function bind(root) {
    root.addEventListener('click', function (e) {
      var pv = e.target.closest('[data-pv]');
      if (pv) { openPv(pv.getAttribute('data-pv')); return; }
      var z = e.target.closest('[data-zip]');
      if (z) { downloadZip(z.getAttribute('data-zip')); }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && modal && !modal.hidden) closePv();
    });
  }

  global.Packs = { pageHTML: pageHTML, bind: bind, list: all };
})(window);
