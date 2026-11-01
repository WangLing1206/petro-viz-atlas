/* =========================================================
   应用外壳 Shell
   ---------------------------------------------------------
   职责：路由、页面骨架、导航、把案例挂到场景页上。
   不含任何具体案例的业务内容 —— 那些都在 assets/cases/*.js
   ========================================================= */

(function (global) {
  'use strict';

  var A = global.ATLAS;
  var M = A.methods;
  var K = global.K;
  var esc = K.esc, pad = K.pad, rich = K.rich;

  var view = document.getElementById('view');
  var mounted = null;          // 当前挂载中的示范，切页时调用其 unmount
  var mountedKey = '';

  /* =========================================================
     一、路由
     ========================================================= */
  function parseHash() {
    var h = location.hash.replace(/^#/, '') || '/';
    var qi = h.indexOf('?'), qs = '';
    if (qi >= 0) { qs = h.slice(qi + 1); h = h.slice(0, qi); }
    var q = {};
    qs.split('&').forEach(function (kv) {
      if (!kv) return;
      var p = kv.split('=');
      q[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || '');
    });
    return { parts: h.split('/').filter(Boolean), q: q };
  }

  function go(hash) { location.hash = hash; }

  /* file:// 协议下部分浏览器会拒绝 replaceState，失败时静默降级 */
  function setHashQuiet(hash) {
    try { history.replaceState(null, '', hash); }
    catch (e) { /* 忽略：地址栏不同步不影响功能 */ }
  }

  /* =========================================================
     二、公共片段
     ========================================================= */
  function header() {
    var r = parseHash();
    var cur = r.parts[0] || 'home';
    function on(k) { return cur === k ? ' on' : ''; }
    var onStage = r.parts.length === 0 ? ' over' : '';
    var adminName = Admin.loggedIn() ? '管理后台' : '管理';
    return '<header class="hdr' + onStage + '"><div class="hdr-in">' +
      '<a class="brand" href="#/">' +
      '<span class="brand-mark"><img src="assets/brand/logo.svg" width="34" height="34" alt=""></span>' +
      '<span class="brand-txt"><b>石油智能可视化图鉴</b><span>PETRO-VIZ ATLAS</span></span></a>' +
      '<nav class="nav" aria-label="主导航">' +
      '<a class="nav-item' + on('home') + '" href="#/">总览</a>' +
      '<a class="nav-item' + on('chain') + '" href="#/chain">作业链</a>' +
      '<a class="nav-item' + on('explore') + '" href="#/explore">星图</a>' +
      '<a class="nav-item' + on('cases') + '" href="#/cases">案例库</a>' +
      '<div class="nav-more"><button type="button" aria-expanded="false">更多' +
      '<svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 4l3 3 3-3"/></svg></button>' +
      '<div class="more-pop">' +
      '<a href="#/packs">案例包 <small>' + Object.keys(global.CASE_PACKS || {}).length + '</small></a>' +
      '<a href="#/guide">接入指南 <small>MANUAL</small></a>' +
      '<a href="#/admin">' + adminName + ' <small>CONSOLE</small></a>' +
      '</div></div>' +
      '</nav>' +
      '<button class="hdr-search" type="button" data-cmdk aria-label="搜索全站">' +
      '<svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="8.5" cy="8.5" r="5.5"/><path d="M13 13l4 4"/></svg>' +
      '搜索 <kbd>⌘K</kbd></button>' +
      '<button class="hdr-add" type="button" data-import><b>＋</b> 添加案例</button>' +
      '<button class="nav-burger" type="button" aria-label="打开菜单" aria-expanded="false"><i></i></button>' +
      '</div></header>' +
      '<div class="mobile-nav">' +
      '<a href="#/">总览<span>INDEX</span></a>' +
      '<a href="#/chain">作业链<span>13 STAGES</span></a>' +
      '<a href="#/explore">场景星图<span>CONSTELLATION</span></a>' +
      '<a href="#/cases">案例库<span>' + Cases.list().length + ' CASES</span></a>' +
      '<a href="#/packs">案例包<span>PACKS</span></a>' +
      '<a href="#/guide">接入指南<span>MANUAL</span></a>' +
      '<a href="#/admin">' + adminName + '<span>CONSOLE</span></a>' +
      '</div>';
  }

  function footer() {
    var s = Cases.stats();
    return '<footer class="ftr"><div class="wrap"><div class="ftr-in">' +
      '<div class="ftr-brand">' +
      '<div class="fb-mark"><img src="assets/brand/logo.svg" alt=""><b>' + esc(A.meta.title) + '</b></div>' +
      '<p>把石油作业链拆成一个个能定义的技术问题：介入点、数据条件、难度与可运行示范。给选题、立项与技术选型一个共同的坐标系。</p>' +
      '<div class="fb-meta">' + esc(A.meta.version) + ' · 更新 ' + esc(A.meta.updated) + ' · 纯静态 / 可离线</div></div>' +
      '<div class="ftr-col"><h5>地图</h5>' +
      '<a href="#/">总览</a><a href="#/chain">作业链</a><a href="#/explore">场景星图</a></div>' +
      '<div class="ftr-col"><h5>案例</h5>' +
      '<a href="#/cases">案例库（' + s.registered + '）</a>' +
      '<a href="#/packs">案例包</a><a href="#/guide">接入新案例</a></div>' +
      '<div class="ftr-col"><h5>参与</h5>' +
      '<p>发现错误或想补一个场景？</p>' +
      '<a href="mailto:' + esc(A.meta.email) + '">' + esc(A.meta.email) + '</a>' +
      '<a href="#/guide">贡献一份案例包</a></div>' +
      '</div>' +
      '<div class="ftr-bot"><span>场景 ' + A.allScenes.length + ' · 环节 ' + A.stages.length + ' · 案例 ' + s.registered + '</span>' +
      '<span>无后端 · 无追踪 · file:// 可直接打开</span>' +
      '<span>build ' + esc(A.meta.updated) + ' · v4</span></div>' +
      '</div></footer>';
  }

  function crumb(items) {
    return '<nav class="crumb">' + items.map(function (it, i) {
      var last = i === items.length - 1;
      return (i ? '<span class="sep">/</span>' : '') +
        (last ? '<span class="cur">' + esc(it[1]) + '</span>' : '<a href="' + it[0] + '">' + esc(it[1]) + '</a>');
    }).join('') + '</nav>';
  }

  function methodChip(k) {
    var ck = (M[k] && (M[k].colorKey || k)) || 'cv';
    return '<span class="mtag" data-m="' + ck + '"><b>' + M[k].abbr + '</b>' + esc(M[k].name) + '</span>';
  }

  function caseChip(k) {  /* 案例 methods 标签（小号） */
    var m = M[k];
    if (!m) return '';
    var ck = m.colorKey || k;
    return '<span class="mtag sm" data-m="' + ck + '"><b>' + esc(m.abbr) + '</b>' + esc(m.name) + '</span>';
  }

  /* 案例卡片元数据与封面由 assets/field/ 提供；没有数据的
     案例卡片自动退回 workflow.stats 与场景简介。 */
  function fieldOf(c) { return (c && global.fieldCase) ? global.fieldCase(c.id) : null; }
  function photoOf(key) { return (key && global.fieldPhoto) ? global.fieldPhoto(key) : null; }
  function photoCredit(p) { return (p && global.fieldPhotoCredit) ? global.fieldPhotoCredit(p) : ''; }

  function stageBar(stageId) {
    var counts = A.countByStageMethod()[stageId];
    var keys = Object.keys(counts).filter(function (k) { return counts[k] > 0; });
    if (!keys.length) return '<div class="step-bar"><i class="empty"></i></div>';
    return '<div class="step-bar">' + keys.map(function (k) {
      var ck = (M[k] && (M[k].colorKey || k)) || 'cv';
      return '<i style="flex:' + counts[k] + ';background:var(--c-' + ck + ')"></i>';
    }).join('') + '</div>';
  }

  /* =========================================================
     三、首页
     ========================================================= */
  function homeHTML() {
    var s = A.stats();
    var cs = Cases.stats();
    var total = A.allScenes.length;
    var coverPct = total ? Math.round(cs.coveredScenes / total * 100) : 0;

    return '<main class="v3-home">' +
      '<section class="stage hero" id="hero">' +
      '<canvas class="stage-canvas" id="hero-fx" aria-hidden="true"></canvas>' +
      '<div class="stage-veil" aria-hidden="true"></div>' +
      '<div class="stage-fallback" aria-hidden="true">' +
      '<div class="fx-cube"><div class="fx-face top"></div><div class="fx-face left"></div><div class="fx-face right"></div><div class="fx-glow"></div><div class="fx-well"></div></div>' +
      '</div>' +
      '<div class="stage-note" role="status"><b>三维场景未启动</b><span>当前环境没有可用的 Canvas（或脚本被拦截），下面显示静态示意；其余功能不受影响。</span></div>' +

      '<div class="wrap hero-grid">' +
      '<div class="hero-copy">' +
      '<p class="hero-kicker">石油勘探开发 · 智能化可能性地图</p>' +
      '<h1>一条作业链，<em>' + total + ' 个可被算法接手的位置</em></h1>' +
      '<p class="hero-lede">从地质勘察到加工，按作业顺序拆到「一个可定义的技术问题」：<b>介入点</b>、<b>数据条件</b>、<b>难度</b>画在同一张图上。能跑的案例，直接在浏览器里跑给你看。</p>' +
      '<div class="hero-acts">' +
      '<a class="btn primary lg" href="#/chain">浏览作业链 <span class="ar">→</span></a>' +
      '<a class="btn glass lg" href="#/scene/pr1?tab=demo">跑一个示范</a>' +
      '<a class="btn ghost lg" href="#/cases">' + cs.registered + ' 个案例</a>' +
      '</div>' +
      '<div class="hero-stats">' +
      '<div><b>' + A.stages.length + '</b><span>作业环节</span></div>' +
      '<div><b>' + total + '</b><span>候选场景</span></div>' +
      '<div><b>' + cs.registered + '</b><span>已接入案例</span></div>' +
      '<div><b>' + cs.withDemo + '</b><span>可运行示范</span></div>' +
      '</div></div>' +

      '<div class="hero-side">' +
      '<div class="hero-readout" id="stage-state">' +
      '<div class="hr-no" id="ss-no">01 / 04</div>' +
      '<div class="hr-name"><b id="ss-name">井场</b><span id="ss-en">WELL PAD</span></div>' +
      '<p id="ss-desc">地面这一层是能看见的：井架、游车、储罐、火炬，井口下面才是作业对象。</p>' +
      '</div></div></div>' +

      '<div class="wrap hero-rail">' +
      '<div class="hud-states" role="tablist" aria-label="三维场景状态">' +
      '<button class="hstate on" data-state="0" type="button"><i>01</i><span class="hname">井场</span><span class="pbar"><em></em></span></button>' +
      '<button class="hstate" data-state="1" type="button"><i>02</i><span class="hname">井筒</span><span class="pbar"><em></em></span></button>' +
      '<button class="hstate" data-state="2" type="button"><i>03</i><span class="hname">地形</span><span class="pbar"><em></em></span></button>' +
      '<button class="hstate" data-state="3" type="button"><i>04</i><span class="hname">油气分布</span><span class="pbar"><em></em></span></button>' +
      '<button class="hud-btn" id="fx-toggle" type="button" aria-pressed="false">暂停</button>' +
      '</div>' +
      '<span class="hero-hint">' +
      '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M10 3v14M3 10h14M10 3l-2.4 2.4M10 3l2.4 2.4M10 17l-2.4-2.4M10 17l2.4-2.4M3 10l2.4-2.4M3 10l2.4 2.4M17 10l-2.4-2.4M17 10l-2.4 2.4"/></svg>' +
      '拖动旋转 · 滚轮缩放 · 右下角切换剖面</span>' +
      '</div></section>' +

      '<section class="map-console"><div class="wrap">' +
      '<div class="sec-h" data-rv>' +
      '<div class="sh-l"><span class="sh-no">01</span><div>' +
      '<h2>先找位置：13 个环节，' + total + ' 个候选场景</h2>' +
      '<p>点环节看它下面的场景与方法构成；「矩阵」看哪里已经被占满，或切到「星图」把 61 个场景摊成一张可刷选的散点。</p>' +
      '</div></div>' +
      '<div class="sh-r"><a class="btn sm ghost" href="#/explore">打开场景星图 →</a><a class="btn sm ghost" href="#/chain">竖向链条 →</a></div>' +
      '</div>' +
      chainConsoleHTML() +
      '</div></section>' +

      reelHTML() +
      starterHTML() +

      '<section class="section tight" style="padding:10px 0 54px"><div class="wrap">' +
      '<div class="pending" style="margin-top:0">' +
      '<div class="pending-top"><span class="kicker">EXTEND</span><h3>这张地图也能装下你自己的案例</h3></div>' +
      '<p>案例是一个文件夹：<b>case.json</b> 写三块内容，<b>demo/</b> 放一个纯前端示范。上传文件夹就能出现在这里，也可以按内置案例的方式生成插件。</p>' +
      '<div class="pending-actions">' +
      '<a class="btn primary" href="#/guide">看接入指南 →</a>' +
      '<a class="btn" href="#/packs">浏览案例包（' + Object.keys(global.CASE_PACKS || {}).length + ' 个）</a>' +
      '<a class="btn ghost" href="#/cases">案例库与校验</a></div>' +
      '</div></div></section>' +
      '</main>';
  }

  /* ---------- 作业链控制台 ---------- */
  function chainConsoleHTML() {
    var counts = A.countByStageMethod();
    var maxScenes = Math.max.apply(null, A.stages.map(function (st) { return st.scenes.length; }));

    var segs = A.stages.map(function (st) {
      var c = counts[st.id] || {};
      var keys = Object.keys(c).filter(function (k) { return c[k] > 0; });
      var bar = keys.map(function (k) {
        return '<i style="flex:' + c[k] + ';background:var(--c-' + (M[k].colorKey || k) + ')"></i>';
      }).join('');
      return '<button class="cseg' + (st.idx === 1 ? ' on' : '') + '" type="button" role="tab"' +
        ' aria-selected="' + (st.idx === 1 ? 'true' : 'false') + '" data-stage="' + st.id + '" data-href="#/stage/' + st.id + '">' +
        '<span class="cs-no">' + pad(st.idx) + '</span>' +
        '<span class="cs-nm">' + esc(st.name) + '</span>' +
        '<span class="cs-cnt">' + st.scenes.length + ' 场景</span>' +
        '<span class="cs-bar">' + (bar || '<i style="flex:1;background:var(--paper-3)"></i>') + '</span></button>';
    }).join('');

    var panels = A.stages.map(function (st, si) {
      var c = counts[st.id] || {};
      var diff = { '低': 0, '中': 0, '高': 0 };
      st.scenes.forEach(function (sc) { diff[sc.diff] = (diff[sc.diff] || 0) + 1; });
      var casesInStage = 0;
      st.scenes.forEach(function (sc) { casesInStage += Cases.bySceneAll(sc.id).length; });

      var mkeys = Object.keys(M).filter(function (k) { return c[k] > 0; });
      var maxM = Math.max.apply(null, mkeys.map(function (k) { return c[k]; }).concat([1]));
      var methodBars = mkeys.map(function (k) {
        return '<div class="spm"><span>' + M[k].abbr + '</span><span class="trk"><i style="width:' +
          (c[k] / maxM * 100).toFixed(1) + '%;background:var(--c-' + (M[k].colorKey || k) + ')"></i></span><b>' + c[k] + '</b></div>';
      }).join('');

      var rows = st.scenes.slice(0, 5).map(function (sc, i) {
        var cn = Cases.bySceneAll(sc.id).length;
        return '<a class="sc-row" href="#/scene/' + sc.id + '">' +
          '<span class="scr-no">' + pad(i + 1) + '</span>' +
          '<span><span class="scr-nm">' + esc(sc.name) +
          (cn ? '<span class="sc-ready">已接入 ×' + cn + '</span>' : '') + '</span>' +
          '<span class="scr-pt">' + esc(sc.point) + '</span></span>' +
          '<span class="scr-r">' +
          sc.methods.map(function (k) {
            return '<span class="mtag sm" data-m="' + (M[k].colorKey || k) + '"><b>' + M[k].abbr + '</b></span>';
          }).join('') +
          '<span class="dtag" data-d="' + sc.diff + '">' + sc.diff + '</span>' +
          '<span class="scr-go">→</span></span></a>';
      }).join('');

      return '<div class="stage-panel" data-stage="' + st.id + '"' + (si ? ' hidden' : '') + '>' +
        '<div class="sp-left">' +
        '<div class="sp-idx">' + pad(st.idx) + ' / ' + pad(A.stages.length) + '<span>' + esc(st.en) + '</span></div>' +
        '<h3>' + esc(st.name) + '</h3>' +
        '<p>' + esc(st.blurb) + '</p>' +
        '<div class="sp-facts">' +
        '<div><b>' + st.scenes.length + '</b><span>候选场景</span></div>' +
        '<div><b>' + diff['低'] + '</b><span>低难度</span></div>' +
        '<div><b>' + casesInStage + '</b><span>已接入案例</span></div>' +
        '</div>' +
        '<div class="sp-method">' + methodBars + '</div>' +
        '<div class="sp-actions"><a class="btn sm primary" href="#/stage/' + st.id + '">进入环节 →</a></div>' +
        '</div>' +
        '<div class="sp-right">' +
        '<div class="sp-head"><b>这个环节里的候选场景</b><span>按作业顺序排列 · 只显示前 5 个</span></div>' +
        '<div class="scene-list">' + rows + '</div>' +
        '<div class="sp-more"><span>共 ' + st.scenes.length + ' 个场景，其中 ' + casesInStage + ' 个已有案例</span>' +
        '<a class="btn sm ghost" href="#/stage/' + st.id + '">全部场景 →</a></div>' +
        '</div></div>';
    }).join('');

    return '<div class="console" id="map-console">' +
      '<div class="console-bar">' +
      '<div class="ctabs" role="tablist" aria-label="地图视图">' +
      '<button class="ctab on" type="button" data-view="stage" role="tab" aria-selected="true">按环节 <b>STAGE</b></button>' +
      '<button class="ctab" type="button" data-view="matrix" role="tab" aria-selected="false">矩阵 <b>MATRIX</b></button>' +
      '<button class="ctab" type="button" data-view="stars" role="tab" aria-selected="false">星图 <b>PLOT</b></button>' +
      '</div>' +
      '<span class="console-hint"><i></i>点选环节，右侧即时预览</span>' +
      '</div>' +
      '<div class="console-body">' +
      '<div class="cview" data-view="stage">' +
      '<div class="chain-band" role="tablist" aria-label="环节">' + segs + '</div>' +
      panels +
      '</div>' +
      '<div class="cview" data-view="matrix" hidden>' + matrixHTML() + '</div>' +
      '<div class="cview" data-view="stars" hidden><div class="ex-mini" id="star-mini"></div></div>' +
      '</div></div>';
  }

  /* ---------- 案例拉片 ---------- */
  function sortedCases() {
    return Cases.list().slice().sort(function (a, b) {
      var sa = (A.index.byScene[a.sceneId] || {}).stageIdx || 99;
      var sb = (A.index.byScene[b.sceneId] || {}).stageIdx || 99;
      return sa - sb || String(a.id).localeCompare(String(b.id));
    });
  }

  function plateOf(c) {
    if (global.Plate) return global.Plate.of(c.id);
    return caseGlyph(c.id);
  }

  function reelHTML() {
    var list = sortedCases();
    var stagesWithCase = {};
    list.forEach(function (c) {
      var sc = A.index.byScene[c.sceneId];
      if (sc) stagesWithCase[sc.stageId] = 1;
    });
    var filters = ['<button class="rf on" type="button" data-stage="*">全部 <b>' + list.length + '</b></button>'].concat(
      A.stages.filter(function (st) { return stagesWithCase[st.id]; }).map(function (st) {
        var n = list.filter(function (c) { return (A.index.byScene[c.sceneId] || {}).stageId === st.id; }).length;
        return '<button class="rf" type="button" data-stage="' + st.id + '">' + pad(st.idx) + ' ' + esc(st.name) + ' <b>' + n + '</b></button>';
      })).join('');

    var cards = list.map(function (c) {
      var sc = A.index.byScene[c.sceneId] || {};
      var st = A.index.byStage[sc.stageId] || {};
      var f = fieldOf(c);
      var ms = (c.methods && c.methods.length ? c.methods : (sc.methods || [])).slice(0, 3);
      var kpis = f
        ? '<div class="reel-kpis"><div><b>' + esc(f.library.kpiMain[0]) + '</b><span>' + esc(f.library.kpiMain[1]) + '</span></div>' +
          '<div><b>' + esc(f.library.kpiAlt[0]) + '</b><span>' + esc(f.library.kpiAlt[1]) + '</span></div></div>'
        : '';
      return '<article class="reel-card" data-stage="' + esc(sc.stageId || '') + '">' +
        '<a class="reel-plate" href="#/scene/' + sc.id + '?tab=demo&case=' + esc(c.id) + '" aria-label="' + esc(c.title || sc.name) + '">' +
        plateOf(c) +
        '<span class="rp-stage">' + pad(st.idx || 0) + ' · ' + esc(st.name || '') + '</span>' +
        '<span class="rp-play">▶ 试跑示范</span></a>' +
        '<div class="reel-body">' +
        '<div class="rb-top">' + ms.map(function (k) {
          var m = M[k]; if (!m) return '';
          return '<span class="mtag sm" data-m="' + (m.colorKey || k) + '"><b>' + esc(m.abbr) + '</b>' + esc(m.name) + '</span>';
        }).join('') + '</div>' +
        '<h3><a href="#/scene/' + sc.id + '?case=' + esc(c.id) + '">' + esc(c.title || sc.name) + '</a></h3>' +
        '<p>' + esc((f && f.library.summary) || sc.point || '') + '</p>' +
        kpis +
        '<div class="reel-foot"><span>' + esc((f && f.site.block) || sc.name || '') + '</span>' +
        '<a href="#/scene/' + sc.id + '?tab=demo&case=' + esc(c.id) + '">打开案例 →</a></div>' +
        '</div></article>';
    }).join('');

    return '<section class="reel-sec"><div class="wrap" data-rv>' +
      '<div class="reel-head">' +
      '<div><span class="kicker">案例拉片 · ' + Cases.list().length + ' 个可运行示范</span>' +
      '<h2 style="font-size:clamp(23px,2.5vw,32px);margin-top:10px;letter-spacing:-.02em">每张图，都是这个案例的核心产出</h2>' +
      '<p style="font-size:var(--fs-2);color:var(--ink-3);margin-top:7px;max-width:62ch">示功图族、工具矩阵、帕累托前沿、修井甘特、井径展开……封面不是通用图，而是按案例数据画的图版；点开就能在浏览器里跑。</p></div>' +
      '<a class="btn sm ghost" href="#/cases">全部案例 →</a></div>' +
      '<div class="reel-filters" role="group" aria-label="按环节筛选案例">' + filters + '</div>' +
      '<div class="reel">' + cards + '</div>' +
      '</div></section>';
  }

  /* ---------- 起步推荐 ---------- */
  function starterHTML() {
    return '<section class="start-sec"><div class="wrap" data-rv>' +
      '<div class="sec-h">' +
      '<div class="sh-l"><span class="sh-no">02</span><div>' +
      '<h2>不知道从哪开始？按你手上的条件选</h2>' +
      '<p>把「数据形态 × 团队技能 × 目标」当成三个旋钮。右边给出三个场景排序，理由写在下面——这不是评分模型，只是一条把 61 个场景缩小到 3 个的检索路径。</p>' +
      '</div></div></div>' +
      '<div class="start">' +
      '<div class="start-cfg">' +
      '<h3>你的条件</h3>' +
      '<p>选完立刻更新；默认是「有图像数据、做视觉、想快速见效」。</p>' +
      '<div class="cfg-row"><div class="cfg-lbl"><i>01</i>手上主要是什么数据？</div>' +
      '<div class="cfg-opts" data-cfg="data">' +
      '<button class="cfg on" type="button" data-v="image">图像 / 视频 / 成像</button>' +
      '<button class="cfg" type="button" data-v="curve">曲线 / 参数时序</button>' +
      '<button class="cfg" type="button" data-v="text">文本 / 报告 / 图件</button>' +
      '<button class="cfg" type="button" data-v="table">表格 / 多指标化验</button>' +
      '</div></div>' +
      '<div class="cfg-row"><div class="cfg-lbl"><i>02</i>团队更擅长哪一类方法？</div>' +
      '<div class="cfg-opts" data-cfg="method">' +
      Object.keys(M).map(function (k, i) {
        return '<button class="cfg' + (i === 0 ? ' on' : '') + '" type="button" data-v="' + k + '">' + M[k].abbr + ' · ' + esc(M[k].name) + '</button>';
      }).join('') +
      '</div></div>' +
      '<div class="cfg-row"><div class="cfg-lbl"><i>03</i>这次的目标是什么？</div>' +
      '<div class="cfg-opts" data-cfg="goal">' +
      '<button class="cfg on" type="button" data-v="quick">快速见效</button>' +
      '<button class="cfg" type="button" data-v="hard">啃硬骨头</button>' +
      '<button class="cfg" type="button" data-v="platform">搭长期平台</button>' +
      '</div></div>' +
      '</div>' +
      '<div class="start-res">' +
      '<div class="sr-head"><b>匹配到的三个场景</b><span>按条件实时计算</span></div>' +
      '<div class="sr-list"></div>' +
      '<div class="sr-foot"><span>规则：方法匹配 3 分 · 数据相关最多 2 分 · 难度与目标匹配 0—2 分 · 已有示范加 1.5 分。</span>' +
      '<a class="btn sm ghost" href="#/chain">看完整链条</a></div>' +
      '</div></div>' +
      '</div></section>';
  }


  function matrixHTML() {
    var counts = A.countByStageMethod();
    var keys = Object.keys(M);
    var head = '<tr><th>环节</th>' + keys.map(function (k) {
      return '<th>' + M[k].abbr + '</th>';
    }).join('') + '<th>合计</th></tr>';

    var body = A.stages.map(function (st) {
      var c = counts[st.id];
      var rowTotal = st.scenes.length;
      return '<tr data-stage="' + st.id + '"><th><i>' + pad(st.idx) + '</i>' + esc(st.name) + '</th>' +
        keys.map(function (k) {
          var n = c[k] || 0;
          return '<td data-m="' + k + '" class="' + (n ? '' : 'zero') + '"><a href="#/stage/' + st.id + '?m=' + k + '">' + (n || '·') + '</a></td>';
        }).join('') +
        '<td><a href="#/stage/' + st.id + '">' + rowTotal + '</a></td></tr>';
    }).join('');

    var foot = '<tr><th>合计</th>' + keys.map(function (k) {
      return '<td>' + (A.index.byMethod[k] || []).length + '</td>';
    }).join('') + '<td>' + A.allScenes.length + '</td></tr>';

    return '<div class="matrix-view"><table class="mx"><thead>' + head + '</thead><tbody>' + body +
      '</tbody><tfoot>' + foot + '</tfoot></table>' +
      '<p class="small muted" style="font-size:9.5px;margin:10px 0 0">数字 = 该环节里用到该方法的场景数；点格子带筛选条件进入环节页。</p></div>';
  }

  /* =========================================================
     四、链条总览页
     ========================================================= */
  function chainHTML() {
    var counts = A.countByStageMethod();
    var rail = A.stages.map(function (st, i) {
      return '<a href="#st-' + st.id + '" data-stage="' + st.id + '"' + (i === 0 ? ' class="on"' : '') + '>' +
        '<b>' + pad(st.idx) + '</b>' + esc(st.name) + '</a>';
    }).join('');

    var blocks = A.stages.map(function (st) {
      var chips = st.scenes.map(function (sc) {
        var ck = (M[sc.methods[0]] && (M[sc.methods[0]].colorKey || sc.methods[0])) || 'cv';
        var cn = Cases.bySceneAll(sc.id).length;
        return '<a href="#/scene/' + sc.id + '" title="' + esc(sc.point) + '">' +
          '<i style="--m:var(--c-' + ck + ')"></i>' + esc(sc.name) +
          (cn ? '<b style="color:var(--ok)">●</b>' : '') +
          '<span class="dtag" data-d="' + sc.diff + '">' + sc.diff + '</span></a>';
      }).join('');
      return '<section class="depth-block" id="st-' + st.id + '" data-stage="' + st.id + '">' +
        '<div class="db-head">' +
        '<span class="db-no">' + pad(st.idx) + '</span>' +
        '<div><h2>' + esc(st.name) + '<span class="en">' + esc(st.en).toUpperCase() + '</span></h2>' +
        '<p>' + esc(st.blurb) + '</p></div>' +
        '<div class="db-cnt"><b>' + st.scenes.length + '</b><span>个候选场景</span></div>' +
        '</div>' +
        '<div class="db-chain">' + chips + '</div>' +
        '<div style="margin-top:12px"><a class="btn sm ghost" href="#/stage/' + st.id + '">进入环节看清单 →</a></div>' +
        '</section>';
    }).join('');

    return '<main class="wrap chain-page">' +
      crumb([['#/', '总览'], ['#/chain', '作业链']]) +
      '<div class="page-head"><div class="ph-top"><div>' +
      '<div class="ph-idx">CHAIN · ' + A.stages.length + ' 个环节</div>' +
      '<h1>从地质勘察到加工的全链条</h1>' +
      '<p class="blurb">上游到下游按作业顺序排列。每一段列出该环节的全部候选场景，左侧色点表示主要方法，右侧难度标出投入门槛；带 <b style="color:var(--ok)">●</b> 的场景已有可运行案例。</p>' +
      '</div><div class="ph-stat">' +
      '<div><div class="n">' + A.stages.length + '</div><div class="l">环节</div></div>' +
      '<div><div class="n">' + A.allScenes.length + '</div><div class="l">场景</div></div>' +
      '<div><div class="n">' + Cases.list().length + '</div><div class="l">案例</div></div>' +
      '</div></div></div>' +
      '<div class="depth-wrap">' +
      '<aside class="depth-rail" aria-label="环节索引">' + rail + '</aside>' +
      '<div class="depth-list">' + blocks + '</div>' +
      '</div></main>';
  }

  /* =========================================================
     五、环节页
     ========================================================= */
  function stageHTML(st, q) {
    var counts = {};
    st.scenes.forEach(function (s) { counts[s.diff] = (counts[s.diff] || 0) + 1; });
    var mFilter = q.m || '';
    var dFilter = q.d || '';

    var methodKeys = Object.keys(M).filter(function (k) {
      return st.scenes.some(function (s) { return s.methods.indexOf(k) >= 0; });
    });
    var methBtns = ['<button class="chip' + (mFilter ? '' : ' on') + '" data-f="m" data-v="">全部方法</button>'].concat(
      methodKeys.map(function (k) {
        return '<button class="chip' + (mFilter === k ? ' on' : '') + '" data-f="m" data-v="' + k + '" data-m="' + k + '">' + M[k].abbr + ' ' + esc(M[k].name) + '</button>';
      })).join('');

    var diffBtns = ['<button class="chip' + (dFilter ? '' : ' on') + '" data-f="d" data-v="">全部难度</button>'].concat(
      ['低', '中', '高'].map(function (d) {
        return '<button class="chip' + (dFilter === d ? ' on' : '') + '" data-f="d" data-v="' + d + '">' + d + '</button>';
      })).join('');

    var list = st.scenes.map(function (sc) {
      var cn = Cases.bySceneAll(sc.id).length;
      return '<a class="scene-row' + (sc.status === 'ext' ? ' is-ext' : '') + '" href="#/scene/' + sc.id + '" data-m="' + sc.methods.join(' ') + '" data-d="' + sc.diff + '">' +
        '<div class="sr-n">' + esc(sc.id.toUpperCase()) + '</div>' +
        '<div><div class="sr-name">' + esc(sc.name) +
        (cn ? '<span class="badge-ready">已接入案例' + (cn > 1 ? ' ×' + cn : '') + '</span>' : '') +
        '<span class="arrow">→</span></div>' +
        '<div class="sr-point">' + esc(sc.point) + '</div>' +
        '<div class="sr-meta">' + sc.methods.map(function (k) {
          var ck = (M[k] && (M[k].colorKey || k)) || 'cv';
          return '<span class="mtag" data-m="' + ck + '"><b>' + M[k].abbr + '</b>' + esc(M[k].name) + '</span>';
        }).join('') + '</div></div>' +
        '<div class="sr-right"><span class="dtag" data-d="' + sc.diff + '">难度 ' + sc.diff + '</span>' +
        (sc.demo ? '<span class="badge-wip" style="border-style:solid;color:var(--jade-d);background:var(--jade-l);border-color:rgba(47,125,107,.2)">可运行</span>' : '') +
        '</div></a>';
    }).join('');

    var idx = A.stages.indexOf(st);
    var prev = A.stages[idx - 1], next = A.stages[idx + 1];

    return '<main class="wrap">' +
      crumb([['#/', '总览'], ['#/chain', '作业链'], ['#/stage/' + st.id, st.name]]) +
      '<div class="page-head"><div class="ph-top"><div>' +
      '<div class="ph-idx">' + pad(st.idx) + ' / ' + pad(A.stages.length) + '</div>' +
      '<h1>' + esc(st.name) + '环节的可智能化场景<span class="en">' + esc(st.en) + '</span></h1>' +
      '<p class="blurb">' + esc(st.blurb) + '</p></div>' +
      '<div class="ph-stat">' +
      '<div><div class="n">' + st.scenes.length + '</div><div class="l">场景</div></div>' +
      '<div><div class="n">' + (counts.低 || 0) + '</div><div class="l">低难度</div></div>' +
      '<div><div class="n">' + (counts.高 || 0) + '</div><div class="l">高难度</div></div>' +
      '</div></div></div>' +

      '<div class="filters"><span class="lbl">方法</span>' + methBtns +
      '<span class="divider"></span><span class="lbl">难度</span>' + diffBtns +
      '<span class="count" id="f-count">' + st.scenes.length + ' 个场景</span></div>' +
      '<div class="scenes" id="scene-list">' + list + '</div>' +
      '<div class="pager">' +
      (prev ? '<a href="#/stage/' + prev.id + '" class="prev"><span class="dir">← 上一环节</span><span class="nm">' + pad(prev.idx) + ' ' + esc(prev.name) + '</span></a>' : '') +
      (next ? '<a href="#/stage/' + next.id + '" class="next"><span class="dir">下一环节 →</span><span class="nm">' + pad(next.idx) + ' ' + esc(next.name) + '</span></a>' : '') +
      '</div></main>';
  }

  /* 总览联动：方法筛选强调 + 作业链与矩阵双向点亮（纯视觉层，不改数据与链接） */
  function bindOverview(root) {
    var chain = root.querySelector('#ov-chain');
    var matrix = root.querySelector('#ov-matrix');
    if (!chain || !matrix) return;
    var steps = [].slice.call(chain.querySelectorAll('.step[data-stage]'));
    var rows = [].slice.call(matrix.querySelectorAll('tr[data-stage]'));
    var cells = [].slice.call(matrix.querySelectorAll('td[data-m]'));
    function rowOf(id) {
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].getAttribute('data-stage') === id) return rows[i];
      }
      return null;
    }
    function stepOf(id) {
      for (var i = 0; i < steps.length; i++) {
        if (steps[i].getAttribute('data-stage') === id) return steps[i];
      }
      return null;
    }
    function hot(id, onFlag) {
      var r = rowOf(id), s = stepOf(id);
      if (r) r.classList.toggle('hot', onFlag);
      if (s) s.classList.toggle('hot', onFlag);
    }
    steps.forEach(function (s) {
      var id = s.getAttribute('data-stage');
      s.addEventListener('mouseenter', function () { hot(id, true); });
      s.addEventListener('mouseleave', function () { hot(id, false); });
      s.addEventListener('focus', function () { hot(id, true); });
      s.addEventListener('blur', function () { hot(id, false); });
    });
    rows.forEach(function (r) {
      var id = r.getAttribute('data-stage');
      r.addEventListener('mouseenter', function () { hot(id, true); });
      r.addEventListener('mouseleave', function () { hot(id, false); });
    });
    var btns = [].slice.call(root.querySelectorAll('.chain-filter [data-cm]'));
    if (!btns.length) return;
    btns.forEach(function (b) {
      b.addEventListener('click', function () {
        btns.forEach(function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        var m = b.getAttribute('data-cm');
        steps.forEach(function (s) {
          var ms = (s.getAttribute('data-methods') || '').split(' ');
          s.classList.toggle('dim', m !== '*' && ms.indexOf(m) < 0);
        });
        cells.forEach(function (td) {
          td.classList.toggle('dim', m !== '*' && td.getAttribute('data-m') !== m);
        });
      });
    });
  }

  /* 首页：导航透明/实底、场景状态标签、暂停、进度条 */
  var stageScroll = null;
  function bindStage() {
    var hdr = view.querySelector('.hdr');
    var stage = view.querySelector('.stage');
    var canvas = document.getElementById('hero-fx');
    var btn = document.getElementById('fx-toggle');
    var bar = null;
    var hero3d = false;

    function heroApi() {
      if (hero3d && global.FX3D) return global.FX3D;
      return global.FX || null;
    }

    function paintState(i, s) {
      var no = document.getElementById('ss-no');
      var nm = document.getElementById('ss-name');
      var en = document.getElementById('ss-en');
      var ds = document.getElementById('ss-desc');
      var box = document.getElementById('stage-state');
      if (box) {
        box.classList.add('swap');
        global.setTimeout(function () {
          if (no) no.textContent = s.no;
          if (nm) nm.textContent = s.name;
          if (en) en.textContent = s.en;
          if (ds) ds.textContent = s.desc;
          box.classList.remove('swap');
        }, 170);
      }
      [].forEach.call(view.querySelectorAll('.hstate'), function (b, k) {
        b.classList.toggle('on', k === i);
      });
      bar = view.querySelector('.hstate.on .pbar em');
      var stg = view.querySelector('.stage');
      if (stg && !stg.__firstPaint) {
        stg.classList.add('flash');
        global.setTimeout(function () { stg.classList.remove('flash'); }, 620);
      }
      if (stg) stg.__firstPaint = false;
    }

    var heroOpts = {
      onState: paintState,
      onProgress: function (p) {
        if (bar) bar.style.width = (p * 100).toFixed(1) + '%';
      }
    };
    /* 优先 three.js + glTF 井场；不可用时退回 Canvas 2D 场景 */
    if (stage && global.FX3D) {
      try { hero3d = !!global.FX3D.mount(stage, heroOpts); } catch (e) { hero3d = false; }
    }
    if (!hero3d && canvas && global.FX) {
      if (stage) stage.__firstPaint = true;
      global.FX.hero(canvas, heroOpts);
    }
    var heroStates = (heroApi() && heroApi().states) || [];
    if (heroStates.length) {
      [].forEach.call(view.querySelectorAll('.hstate .hname'), function (n, k) {
        if (heroStates[k]) n.textContent = heroStates[k].name;
      });
    }
    if (hero3d || canvas) {
      [].forEach.call(view.querySelectorAll('.hstate'), function (b) {
        b.addEventListener('click', function () {
          var api = heroApi();
          if (api) api.go(Number(b.getAttribute('data-state')));
        });
      });
    }

    if (btn) {
      btn.addEventListener('click', function () {
        var api = heroApi();
        if (!api) return;
        var paused = btn.getAttribute('aria-pressed') === 'true';
        if (paused) {
          api.resume();
          btn.textContent = '暂停';
          btn.setAttribute('aria-pressed', 'false');
        } else {
          api.pause();
          btn.textContent = '继续';
          btn.setAttribute('aria-pressed', 'true');
        }
      });
    }

    if (!hdr) return;
    var fn = function () {
      var h = stage ? stage.offsetHeight : global.innerHeight;
      if (global.scrollY > h * 0.62) hdr.classList.add('solid');
      else hdr.classList.remove('solid');
    };
    global.addEventListener('scroll', fn, { passive: true });
    fn();
    stageScroll = fn;
    return true;
  }

  function bindFilters(root) {
    var listEl = root.querySelector('#scene-list');
    if (!listEl) return;
    var st = { m: '', d: '' };
    var chips = root.querySelectorAll('.filters .chip');
    [].forEach.call(chips, function (c) {
      if (c.classList.contains('on')) st[c.dataset.f] = c.dataset.v;
    });

    function apply() {
      var n = 0;
      [].forEach.call(listEl.children, function (row) {
        var ms = (row.dataset.m || '').split(' ');
        var okM = !st.m || ms.indexOf(st.m) >= 0;
        var okD = !st.d || row.dataset.d === st.d;
        var show = okM && okD;
        row.style.display = show ? '' : 'none';
        if (show) n++;
      });
      var cnt = root.querySelector('#f-count');
      if (cnt) cnt.textContent = n + ' 个场景';
      if (!n) {
        if (!listEl.querySelector('.filter-empty')) {
          var d = document.createElement('div');
          d.className = 'empty filter-empty';
          d.innerHTML = '<b>没有符合条件的场景</b>换个筛选条件试试。';
          listEl.appendChild(d);
        }
      } else {
        var e = listEl.querySelector('.filter-empty');
        if (e) e.remove();
      }
    }

    [].forEach.call(chips, function (c) {
      c.addEventListener('click', function () {
        var f = c.dataset.f;
        st[f] = c.dataset.v;
        [].forEach.call(chips, function (x) {
          if (x.dataset.f === f) x.classList.toggle('on', x === c);
        });
        apply();
        var hash = '#/stage/' + parseHash().parts[1] + (st.m ? '?m=' + st.m + (st.d ? '&d=' + st.d : '') : (st.d ? '?d=' + st.d : ''));
        setHashQuiet(hash);
      });
    });
    apply();
  }

  /* =========================================================
     七、场景详情页（案例自动挂载）
     ========================================================= */
  function sceneHTML(sc, q) {
    var st = A.index.byStage[sc.stageId];
    var allCases = Cases.bySceneAll(sc.id);
    var c = allCases.filter(function (x) { return x.id === q.case; })[0] || allCases[0] || null;

    var caseSwitch = '';
    if (allCases.length > 1) {
      caseSwitch = '<div class="case-switch"><span class="cs-lbl">本场景有 ' + allCases.length +
        ' 个案例，当前展示</span>' + allCases.map(function (x) {
          var on = c && x.id === c.id;
          return '<button class="chip' + (on ? ' on' : '') + '" data-case="' + esc(x.id) + '">' +
            esc(x.title || x.id) + '</button>';
        }).join('') + '</div>';
    }

    var tabs = [];
    if (c) {
      if (c.tabs.background) tabs.push({ key: 'bg', num: '01', name: c.tabs.background.label || '专业背景', en: 'BACKGROUND' });
      if (c.tabs.workflow) tabs.push({ key: 'flow', num: '02', name: c.tabs.workflow.label || '案例流程', en: 'WORKFLOW' });
      if (c.tabs.demo) tabs.push({ key: 'demo', num: '03', name: c.tabs.demo.label || '可运行示范', en: 'LIVE DEMO' });
    }

    var tabBtns = tabs.map(function (t, i) {
      return '<button class="tab' + (i === 0 ? ' on' : '') + '" data-tab="' + t.key + '" data-kind="' + t.key + '">' +
        '<span class="num">' + t.num + '</span>' + esc(t.name) + '<span class="tk">' + t.en + '</span></button>';
    }).join('');

    var panels = '';
    var pn = 0;
    function panel(key, html) {
      return '<div class="panel' + (pn++ === 0 ? ' on' : '') + '" data-panel="' + key + '">' + html + '</div>';
    }
    if (c) {
      if (c.tabs.background) panels += panel('bg', renderBackground(sc, c));
      if (c.tabs.workflow) panels += panel('flow', renderWorkflow(sc, c));
      if (c.tabs.demo) panels += panel('demo', renderDemoShell(sc, c));
    }

    var cBadge = allCases.length
      ? '<span class="badge-ready">' + esc(c.id) + ' · v' + esc(c.version || '—') + '</span>' +
        (allCases.length > 1 ? '<span class="tag">共 ' + allCases.length + ' 个案例</span>' : '')
      : '<span class="badge-wip">未接入案例</span>';

    var judge = (c && c.tabs.background && c.tabs.background.judge) || [];
    var judgeRows = judge.slice(0, 4).map(function (j) {
      return '<div class="jc-row"><span class="k">' + esc(j.label) + '</span>' +
        '<span class="v">' + (j.html || rich(j.value)) +
        (j.desc ? '<small>' + rich(j.desc) + '</small>' : '') + '</span></div>';
    }).join('');
    if (!judgeRows) {
      judgeRows = '<div class="jc-row"><span class="k">方法</span><span class="v">' +
        sc.methods.map(function (k) { return esc(M[k].name); }).join(' / ') + '</span></div>' +
        '<div class="jc-row"><span class="k">数据</span><span class="v">' + esc(sc.data[0][0]) + '<small>' + esc(sc.data[0][1]) + '</small></span></div>' +
        '<div class="jc-row"><span class="k">难度</span><span class="v">' + esc(sc.diff) + '<small>' + esc(sc.diffWhy) + '</small></span></div>' +
        '<div class="jc-row"><span class="k">示范</span><span class="v">' + (c && c.tabs.demo ? '可运行' : '待接入') + '</span></div>';
    }

    var head = '<div class="scene-hero">' +
      '<div class="sh-main">' +
      '<div class="sh-kicker">' +
      '<a class="tag" href="#/stage/' + st.id + '">环节 ' + pad(st.idx) + ' · ' + esc(st.name) + '</a>' +
      sc.methods.map(function (k) {
        var ck = (M[k] && (M[k].colorKey || k)) || 'cv';
        return '<span class="mtag" data-m="' + ck + '"><b>' + M[k].abbr + '</b>' + esc(M[k].name) + '</span>';
      }).join('') +
      cBadge +
      '</div>' +
      '<h1 class="dh-title">' + esc(sc.name) + '</h1>' +
      '<p class="sh-sub">' + esc(sc.intro) + '</p>' +
      '<div class="sh-tags">' + K.dtag(sc.diff) +
      (sc.status === 'ext' ? '<span class="badge-wip">待扩展</span>' : '') +
      '<span class="tag"><span class="dot" style="color:var(--ink-4)"></span>' + esc(sc.id.toUpperCase()) + '</span>' +
      (sc.cross && sc.cross.length ? '<span class="tag">交叉环节 · ' + esc(sc.cross.join(' / ')) + '</span>' : '') +
      '</div></div>' +
      '<aside class="judge-card">' +
      '<div class="jc-h"><b>30 秒判断</b><span>' + (c ? 'CASE ' + esc(c.id) : 'SCENE') + '</span></div>' +
      '<div class="jc-body">' + judgeRows + '</div></aside></div>';

    var body = c
      ? caseSwitch + '<div class="tabs" id="tabs">' + tabBtns + '</div>' + panels
      : pendingHTML(sc);

    return '<main class="wrap scene-page">' +
      crumb([['#/', '总览'], ['#/chain', '作业链'], ['#/stage/' + st.id, st.name], ['#/scene/' + sc.id, sc.name]]) +
      head + body + relatedHTML(sc) + '</main>';
  }

  /* ---- 有案例：三块内容由案例提供，这里只套版式 ---- */
  function renderBackground(sc, c) {
    var b = c.tabs.background;
    var sections = b.sections || [];
    var nav = sections.map(function (s, i) {
      return '<a href="#bg-sec-' + (i + 1) + '"><i>' + pad(i + 1) + '</i>' + esc(s.title) + '</a>';
    }).join('');

    var out = '<div class="panel-bg"><div class="panel-main">';
    if (b.lede) out += '<div class="lede-block"><p>' + rich(b.lede) + '</p></div>';
    sections.forEach(function (s, i) {
      out += '<div id="bg-sec-' + (i + 1) + '">' +
        K.sec4(i + 1, s.en || '', s.title, s.html || s.body || '') + '</div>';
    });
    out += '</div>';

    out += '<aside class="panel-aside">' +
      '<div class="aside-card"><h5>本页目录</h5><nav class="aside-nav">' + nav + '</nav></div>' +
      '<div class="aside-card" id="readiness">' +
      '<h5>数据准备度</h5>' +
      '<div style="display:flex;align-items:center;gap:12px">' +
      '<svg width="46" height="46" viewBox="0 0 46 46" aria-hidden="true">' +
      '<circle cx="23" cy="23" r="18" fill="none" stroke="var(--paper-3)" stroke-width="4"/>' +
      '<circle id="cl-gauge" cx="23" cy="23" r="18" fill="none" stroke="var(--clay)" stroke-width="4" stroke-linecap="round" transform="rotate(-90 23 23)" stroke-dasharray="0 113"/>' +
      '</svg>' +
      '<div><b style="font-family:var(--mono);font-size:20px;font-weight:500;line-height:1">0%</b>' +
      '<div style="font-size:9px;color:var(--ink-4);margin-top:3px">勾选清单后更新</div></div></div>' +
      '<p id="cl-note" style="font-size:9.5px;line-height:1.6;color:var(--ink-3);margin-top:9px">先勾选你手上已有的数据。</p></div>' +
      '<div class="aside-card"><h5>参考方向</h5><div class="refs" style="gap:5px">' +
      sc.refs.map(function (r) {
        return '<span class="ref">' + esc(r) + '</span>';
      }).join('') + '</div></div>' +
      '</aside></div>';
    return out;
  }

  function renderWorkflow(sc, c) {
    var w = c.tabs.workflow;
    var steps = w.steps || [];
    var nodes = steps.map(function (s, i) {
      return '<button class="step-node' + (i === 0 ? ' on' : '') + '" type="button" data-step="' + i + '" role="tab">' +
        '<i>STEP ' + pad(i + 1) + '</i><b>' + esc(s.name || ('步骤 ' + (i + 1))) + '</b></button>';
    }).join('');
    var panes = steps.map(function (s, i) {
      return '<div class="step-pane" data-pane="' + i + '"' + (i ? ' hidden' : '') + '>' +
        '<div class="step-body">' +
        '<div><h4>' + esc(s.name || ('步骤 ' + (i + 1))) + '</h4>' +
        (s.role ? '<span class="mtag sm" data-m="cv" style="margin-bottom:9px"><b>ROLE</b>' + esc(s.role) + '</span>' : '') +
        '<p>' + rich(s['do'] || '') + '</p></div>' +
        '<div class="sb-side">' +
        (s.effect ? '<div class="sb-note"><b>预期效果</b><span>' + rich(s.effect) + '</span></div>' : '') +
        (s.trap ? '<div class="sb-note" style="border-color:var(--bad)"><b style="color:var(--bad)">常见坑</b><span>' + rich(s.trap) + '</span></div>' : '') +
        '</div></div></div>';
    }).join('');

    var out = '<div class="flow-head">' +
      '<div><span class="kicker clay">案例流程</span>' +
      '<h2 style="margin-top:9px">' + esc(w.title || '一条真实项目走过的路') + '</h2>' +
      (w.lead || []).map(function (p) { return '<p class="lead">' + rich(p) + '</p>'; }).join('') + '</div>' +
      (w.stats ? flowStats(w.stats) : '') + '</div>';

    out += '<div class="stepper">' +
      '<div class="step-rail" role="tablist" aria-label="流程步骤">' + nodes + '</div>' +
      '<div class="step-panes">' + panes + '</div>' +
      '<div class="step-ctrl" style="padding:0 24px 16px">' +
      '<button class="btn sm ghost step-prev" type="button">← 上一步</button>' +
      '<button class="btn sm step-play" type="button" aria-pressed="false">播放</button>' +
      '<button class="btn sm ghost step-next" type="button">下一步 →</button>' +
      '<span class="step-prog"><i style="width:0"></i></span></div>' +
      '</div>';

    if (w.metrics) {
      out += K.sec4(0, 'METRICS', w.metrics.title || '怎么算“做对了”', w.metrics.html || '');
    }
    if (w.fails) {
      out += '<div class="sec4"><div class="sn">FAIL<span>失败模式</span></div><div class="sec4-body">' +
        '<h3>这类任务通常死在哪</h3>' +
        '<p>下面这些失败模式在同类项目里反复出现。它们多半不是模型能力问题，而是任务定义与数据规范问题。</p>' +
        K.fails(w.fails) + '</div></div>';
    }
    return out;
  }

  function flowStats(stats) {
    return '<div class="flow-stats">' + stats.slice(0, 4).map(function (x) {
      return '<div><b>' + esc(x[1]) + '</b><span>' + esc(x[0]) + '</span></div>';
    }).join('') + '</div>';
  }

  function renderDemoShell(sc, c) {
    return '<div class="demo-shell">' +
      '<div class="demo-toolbar">' +
      '<span class="demo-dots"><i></i><i></i><i></i></span>' +
      '<span class="dt-name">SANDBOX · ' + esc(c.id) + ' · 与主站样式隔离</span>' +
      '<span class="dt-sp"></span>' +
      '<button class="dt-btn" type="button" data-demo-full>全屏</button>' +
      '</div>' +
      '<div class="demo-body"><div id="case-demo-root"></div></div>' +
      '<div class="demo-foot"><span>示范在 sandbox iframe 中运行：脚本、样式与主站互不影响。</span>' +
      '<span>切换 tab 或离开页面时自动销毁</span></div>' +
      '</div>';
  }


  /* ---- 无案例：展示速览 + 接入引导 ---- */
  function pendingHTML(sc) {
    var dataRows = sc.data.map(function (d) { return [d[0], d[1], d[2]]; });
    return '<div style="padding-top:8px">' +
      '<div class="sec4" style="border-top:0">' +
      '<div class="sn">01<span>PROBLEM</span></div><div class="sec4-body">' +
      '<h3>业务问题</h3><p>' + esc(sc.problem) + '</p></div></div>' +
      '<div class="sec4"><div class="sn">02<span>INTERVENTION</span></div><div class="sec4-body">' +
      '<h3>AI 介入点</h3><p>' + esc(sc.point) + '</p></div></div>' +
      '<div class="sec4"><div class="sn">03<span>DATA</span></div><div class="sec4-body">' +
      '<h3>数据条件</h3>' + K.dtable(['数据类型', '规模 / 规格', '标注要求'], dataRows) + '</div></div>' +
      '<div class="sec4"><div class="sn">04<span>DIFFICULTY</span></div><div class="sec4-body">' +
      '<h3>技术难度与参考方向</h3>' +
      '<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:4px">' + K.dtag(sc.diff) +
      '<span class="small muted">' + esc(sc.diffWhy) + '</span></div>' + K.meter(sc.diff) +
      K.refs(sc.refs, null) +
      '</div></div>' +

      '<div class="pending"><div class="pending-top"><span class="badge-wip">案例待接入</span>' +
      '<h3>这个场景还没有配套案例</h3></div>' +
      '<p>它的元数据（问题、介入点、数据条件、难度）已经在地图里，但还没有写成可讲解、可运行的具体案例。案例是按插件方式接入的：写一个文件声明三块内容，注册后这个页面就会自动出现 tab 与示范。</p>' +
      '<div class="pending-lines"><div class="pending-line"></div><div class="pending-line"></div><div class="pending-line"></div></div>' +
      '<div class="pending-actions">' +
      '<button class="btn primary" data-import data-scene="' + esc(sc.id) + '">＋ 为这个场景添加案例</button>' +
      '<a class="btn" href="#/cases">看已接入的案例</a>' +
      '<a class="btn ghost" href="#/guide">看接入说明</a>' +
      '</div></div></div>';
  }

  function relatedHTML(sc) {
    var sameStage = A.index.byStage[sc.stageId].scenes.filter(function (s) { return s.id !== sc.id; }).slice(0, 4);
    var sameMethod = (A.index.byMethod[sc.methods[0]] || []).filter(function (s) { return s.id !== sc.id; }).slice(0, 4);
    return '<div class="related"><div class="sec-head" style="margin-bottom:0;border-top:0;padding-top:0"><div>' +
      '<span class="kicker">RELATED</span><h2 style="font-size:18px;margin-top:8px">相关场景</h2></div></div>' +
      '<div class="rel-grid">' +
      '<div class="rel-col"><h5>同环节 · ' + esc(A.index.byStage[sc.stageId].name) + '</h5>' +
      sameStage.map(function (s) {
        return '<a class="rel-item" href="#/scene/' + s.id + '"><span class="nm">' + esc(s.name) + '</span><span class="go">→</span></a>';
      }).join('') + '</div>' +
      '<div class="rel-col"><h5>同方法 · ' + esc(M[sc.methods[0]].name) + '</h5>' +
      sameMethod.map(function (s) {
        return '<a class="rel-item" href="#/scene/' + s.id + '"><span class="nm">' + esc(s.name) + '</span><span class="go">' + esc(s.stageName) + ' →</span></a>';
      }).join('') + '</div></div>' +
      '<div style="margin-top:18px;display:flex;gap:9px;flex-wrap:wrap">' +
      '<a class="btn" href="#/stage/' + sc.stageId + '">← 返回' + esc(sc.stageName) + '环节</a>' +
      '<a class="btn ghost" href="#/">返回总览</a></div></div>';
  }

  /* ---- tab 交互与示范挂载 ---- */
  function bindTabs(sc, c) {
    var tabsEl = document.getElementById('tabs');
    if (!tabsEl) return;

    function activate(key, scroll) {
      [].forEach.call(tabsEl.children, function (b) {
        b.classList.toggle('on', b.dataset.tab === key);
      });
      [].forEach.call(document.querySelectorAll('.panel'), function (p) {
        p.classList.toggle('on', p.dataset.panel === key);
      });
      if (key === 'demo') mountDemo(sc, c);
      else if (mounted) {
        if (mounted.unmount) { try { mounted.unmount(); } catch (e) { } }
        mounted = null; mountedKey = '';
        var dr = document.getElementById('case-demo-root');
        if (dr) dr.innerHTML = '';
      }
      if (scroll) {
        var y = tabsEl.getBoundingClientRect().top + window.scrollY - 62;
        window.scrollTo({ top: y, behavior: 'smooth' });
      }
    }

    tabsEl.addEventListener('click', function (e) {
      var b = e.target.closest('.tab');
      if (!b) return;
      activate(b.dataset.tab, true);
      setHashQuiet('#/scene/' + sc.id + '?tab=' + b.dataset.tab);
    });

    var want = { 1: 'bg', 2: 'flow', 3: 'demo' }[parseHash().q.tab] || parseHash().q.tab;
    if (want && tabsEl.querySelector('[data-tab="' + want + '"]')) activate(want, false);

    bindChecklist();
  }

  function mountDemo(sc, c) {
    var d = c.tabs.demo;
    if (!d || typeof d.mount !== 'function') return;
    var key = c.id;
    if (mountedKey === key) return;
    var root = document.getElementById('case-demo-root');
    if (!root) return;
    if (mounted && mounted.unmount) { try { mounted.unmount(); } catch (e) { } }
    root.innerHTML = '';
    mounted = d;
    mountedKey = key;
    try {
      d.mount(root, { scene: sc, kase: c, K: K, atlas: A });
    } catch (err) {
      root.innerHTML = '<div class="callout warn"><span class="ci">错误</span><span>示范挂载失败：' +
        esc(err.message) + '。检查 <b>' + esc(c.id) + '</b> 的 tabs.demo.mount。</span></div>';
      console.error('[case:' + c.id + '] demo mount failed', err);
    }
  }

  function bindChecklist() {
    var items = document.querySelectorAll('.cl-item');
    if (!items.length) return;
    var total = items.length;
    var fill = document.getElementById('cl-fill');
    var txt = document.getElementById('cl-txt');

    function sync() {
      var n = document.querySelectorAll('.cl-item.done').length;
      if (fill) fill.style.width = (n / total * 100) + '%';
      if (txt) txt.textContent = n + ' / ' + total;
    }
    [].forEach.call(items, function (it) {
      it.setAttribute('tabindex', '0');
      it.setAttribute('role', 'checkbox');
      it.setAttribute('aria-checked', it.classList.contains('done') ? 'true' : 'false');
      it.addEventListener('click', function () {
        it.classList.toggle('done');
        it.setAttribute('aria-checked', it.classList.contains('done') ? 'true' : 'false');
        sync();
      });
      it.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          it.classList.toggle('done');
          it.setAttribute('aria-checked', it.classList.contains('done') ? 'true' : 'false');
          sync();
        }
      });
    });
    sync();
  }

  /* =========================================================
     八、案例库控制台
     ========================================================= */
  /* ---- 案例图形：用方法语义画的小图，代替照片 ---- */
  function caseGlyph(id) {
    var S = 'stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"';
    var A = 'stroke="#d6b678" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"';
    var g;
    switch (id) {
      case 'welllog-layer':
        g = '<path d="M22 8v54M32 8v54" ' + S + ' opacity=".4"/>' +
          '<path d="M22 24c7-9 14 9 22 0M22 44c7 9 14-9 22 0" ' + S + '/>' +
          '<path d="M52 16h56M52 30h56M52 44h56M52 58h56" ' + S + ' stroke-dasharray="2 4" opacity=".5"/>' +
          '<circle cx="88" cy="30" r="2.5" fill="#d6b678"/>';
        break;
      case 'casing-damage-cv':
        g = '<rect x="52" y="6" width="16" height="58" rx="3" ' + S + '/>' +
          '<path d="M60 24L38 16M60 24L82 16M60 46L38 54M60 46L82 54" ' + S + ' opacity=".8"/>' +
          '<path d="M68 31l9 4-9 4" ' + A + '/>' +
          '<ellipse cx="60" cy="10" rx="8" ry="2.5" ' + S + ' opacity=".6"/>';
        break;
      case 'fishing-tool-kg':
        g = '<path d="M12 12h96v46H12z" ' + S + ' opacity=".22"/>';
        for (var r = 0; r < 3; r++) for (var q = 0; q < 4; q++) {
          var x = 16 + q * 22, y = 18 + r * 16;
          g += '<rect x="' + x + '" y="' + y + '" width="14" height="10" rx="2" ' +
            (r === 1 && q === 2 ? 'fill="#d6b678" stroke="#d6b678"' : S + ' opacity=".75"') + '/>';
        }
        break;
      case 'frac-optimize-opt':
        g = '<path d="M14 58h92M14 58V10" ' + S + ' opacity=".35"/>' +
          '<path d="M16 54c22-4 38-14 52-24s24-14 38-16" ' + A + '/>' +
          '<circle cx="30" cy="48" r="2" fill="currentColor"/><circle cx="48" cy="40" r="2" fill="currentColor"/>' +
          '<circle cx="66" cy="30" r="2" fill="currentColor"/><circle cx="84" cy="20" r="2" fill="currentColor"/>' +
          '<circle cx="98" cy="15" r="2.5" fill="#d6b678"/>';
        break;
      case 'gaslogging-fluid-ts':
        g = '<path d="M10 52h100" ' + S + ' stroke-dasharray="3 5" opacity=".4"/>' +
          '<path d="M10 50c10 0 12-22 22-22s10 26 20 26 8-14 16-14 8 18 18 18 8-8 24-8" ' + A + '/>' +
          '<circle cx="32" cy="28" r="2" fill="#d6b678"/><circle cx="68" cy="40" r="2" fill="#d6b678"/>';
        break;
      case 'pipeline-leak-ts':
        g = '<path d="M8 30h104M8 38h104" ' + S + ' opacity=".85"/>' +
          '<path d="M8 26v16M112 26v16" ' + S + ' opacity=".4"/>' +
          '<path d="M70 38l6 12 6-12" ' + A + ' fill="#d6b678" fill-opacity=".22"/>' +
          '<path d="M76 20c-6 0-6 8-12 8M76 20c6 0 6 8 12 8" ' + S + ' opacity=".5"/>';
        break;
      case 'pump-diagnosis-cv':
        g = '<path d="M18 58h92M14 58V10" ' + S + ' opacity=".35"/>' +
          '<path d="M26 46c10-28 30-34 44-22s10 30 26 28 12-12 12-12c-2-18-20-30-38-32S28 20 26 46z" ' + A + '/>' +
          '<circle cx="70" cy="24" r="2" fill="#d6b678"/>';
        break;
      case 'workover-duration-ts':
        g = '<path d="M14 58h92M14 58V10" ' + S + ' opacity=".35"/>' +
          '<rect x="22" y="16" width="30" height="5" rx="2.5" fill="currentColor" opacity=".8"/>' +
          '<rect x="34" y="26" width="42" height="5" rx="2.5" fill="currentColor" opacity=".65"/>' +
          '<rect x="26" y="36" width="54" height="5" rx="2.5" fill="#d6b678"/>' +
          '<rect x="44" y="46" width="34" height="5" rx="2.5" fill="currentColor" opacity=".55"/>' +
          '<path d="M74 12v48" ' + S + ' stroke-dasharray="3 4" opacity=".5"/>';
        break;
      case 'workover-plan-kg':
        g = '<circle cx="60" cy="35" r="8" ' + S + '/>' +
          '<circle cx="26" cy="18" r="5" ' + S + '/><circle cx="94" cy="18" r="5" ' + S + '/>' +
          '<circle cx="26" cy="52" r="5" ' + S + '/><circle cx="94" cy="52" r="5" ' + S + '/>' +
          '<path d="M34 22l18 8M86 22L68 32M34 48l18-8M86 48L68 38" ' + S + ' opacity=".7"/>' +
          '<circle cx="60" cy="35" r="2" fill="#d6b678"/>';
        break;
      case 'workover-risk-ts':
        g = '<path d="M14 58h92M14 58V10" ' + S + ' opacity=".35"/>' +
          '<path d="M16 46h22l10-6 8 4 10-28 8 34 10-6 20-2" ' + A + '/>' +
          '<path d="M14 30h92" ' + S + ' stroke-dasharray="3 4" opacity=".45"/>' +
          '<circle cx="76" cy="16" r="3" fill="#d6b678"/>';
        break;
      default:
        g = '<circle cx="60" cy="35" r="20" ' + S + ' opacity=".5"/><path d="M48 35h24M60 23v24" ' + S + '/>';
    }
    return '<svg viewBox="0 0 120 70" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' + g + '</svg>';
  }

  /* ---- 案例库卡片：内容封面（阶段 / 指标 / 任务图形）+ 案例内容 ---- */
  function libCard(c) {
    var sc = A.index.byScene[c.sceneId] || null;
    var f = fieldOf(c);
    var st = sc ? A.index.byStage[sc.stageId] : null;
    var ms = (c.methods || (sc && sc.methods) || []).map(caseChip).join('') ||
      '<span class="dim-mark">继承场景</span>';
    var href = sc ? '#/scene/' + esc(sc.id) + '?case=' + esc(c.id) : '#/cases';
    var demoHref = sc ? '#/scene/' + esc(sc.id) + '?case=' + esc(c.id) + '&tab=demo' : href;

    var kpis = '';
    if (f) {
      kpis = '<div class="lc-kpis">' +
        '<div><b>' + esc(f.library.kpiMain[0]) + '</b><span>' + esc(f.library.kpiMain[1]) + '</span></div>' +
        '<div><b>' + esc(f.library.kpiAlt[0]) + '</b><span>' + esc(f.library.kpiAlt[1]) + '</span></div></div>';
    } else {
      var sts = ((c.tabs.workflow || {}).stats || []).slice(0, 2);
      kpis = sts.length
        ? '<div class="lc-kpis">' + sts.map(function (x) {
          return '<div><b>' + esc(x[1]) + '</b><span>' + esc(x[0]) + '</span></div>';
        }).join('') + '</div>' : '';
    }

    var status = f
      ? '<span class="lc-status" data-tone="' + esc(f.tone) + '">● ' + esc(f.status) + '</span>'
      : '<span class="lc-status" data-tone="ready">● 已接入</span>';

    var text = [c.id, c.title, sc && sc.name, sc && sc.stageName, f && f.site.name, f && f.site.block,
      f && f.library.summary, (c.methods || []).join(' ')].join(' ');

    return '<article class="lib-card" data-stage="' + esc(sc ? sc.stageId : '') + '"' +
      ' data-methods="' + esc((c.methods || (sc && sc.methods) || []).join(' ')) + '"' +
      ' data-text="' + esc(text.toLowerCase()) + '">' +
      '<a class="lc-cover" href="' + href + '" data-st="' + esc(st ? st.idx : 0) + '">' +
      '<span class="plate" aria-hidden="true">' + plateOf(c) + '</span>' +
      '<span class="lc-stage">' +
      (st ? pad(st.idx) + ' · ' + esc(st.name) : '未绑定场景') + '</span>' +
      status +
      '<span class="lc-open">看案例 →</span></a>' +
      '<div class="lc-body">' +
      '<div class="lc-top"><span class="lc-id mono">' + esc(c.id) + '</span>' +
      (c.imported ? '<span class="badge-local">本地导入</span>' : '') +
      '<span class="lc-methods">' + ms + '</span></div>' +
      '<h3><a href="' + href + '">' + esc(c.title || (sc && sc.name) || c.id) + '</a></h3>' +
      '<p class="lc-sum">' + esc(f ? f.library.summary : (sc ? sc.intro : '')) + '</p>' +
      kpis +
      '<div class="lc-foot">' +
      '<span class="lc-site">' + (f ? '现场 · ' + esc(f.site.name) + ' / ' + esc(f.site.scale) : '案例摘要待补') + '</span>' +
      '<span class="lc-acts">' +
      (c.tabs.demo ? '<a href="' + demoHref + '">▶ 试跑</a>' : '') +
      '<a href="' + href + '">详情 →</a></span>' +
      '</div></div></article>';
  }

  /* =========================================================
     八、案例库（现场视图 + 工程校验）
     ========================================================= */
  function casesHTML() {
    var list = Cases.list().slice().sort(function (a, b) {
      var sa = (A.index.byScene[a.sceneId] || {}).stageIdx || 99;
      var sb = (A.index.byScene[b.sceneId] || {}).stageIdx || 99;
      return sa - sb || String(a.id).localeCompare(String(b.id));
    });
    var checks = Cases.validateAll();
    var s = Cases.stats();
    var pending = A.allScenes.filter(function (sc) { return !Cases.bySceneAll(sc.id).length; });
    var withCover = list.length;

    var stageCount = {}, methodCount = {};
    list.forEach(function (c) {
      var sc = A.index.byScene[c.sceneId];
      if (sc) stageCount[sc.stageId] = (stageCount[sc.stageId] || 0) + 1;
      (c.methods || []).forEach(function (k) { methodCount[k] = (methodCount[k] || 0) + 1; });
    });

    var stageChips = Object.keys(stageCount).map(function (id) {
      var st = A.index.byStage[id];
      return '<button class="lf-chip" data-f-stage="' + esc(id) + '">' +
        '<i data-st="' + esc(st.idx) + '"></i>' + pad(st.idx) + ' ' + esc(st.name) +
        '<span>' + stageCount[id] + '</span></button>';
    }).join('');

    var methodChips = Object.keys(methodCount).map(function (k) {
      var m = M[k];
      return '<button class="lf-chip" data-f-method="' + esc(k) + '">' +
        '<i class="mdot" data-m="' + esc(m.colorKey || k) + '"></i>' + esc(m.name) +
        '<span>' + methodCount[k] + '</span></button>';
    }).join('');

    var heroPhoto = photoOf('hero');
    var heroGlyphs = list.slice(0, 4).map(function (c) {
      return '<span class="lh-glyph">' + caseGlyph(c.id) + '</span>';
    }).join('');
    var hero = '<section class="lib-hero">' +
      (heroPhoto
        ? '<img class="lh-img" src="' + esc(heroPhoto.src) + '" alt="' + esc(heroPhoto.title) + '">'
        : '<div class="lh-glyphs" aria-hidden="true">' + heroGlyphs + '</div>') +
      '<div class="lh-veil"></div>' +
      '<div class="lh-in">' +
      '<span class="lh-kicker">CASE LIBRARY · 智能化案例库</span>' +
      '<h1>智能化的场景，最终要落在生产线上</h1>' +
      '<p>每个案例的封面都是按它自己的数据画出来的图版——打捞工具矩阵、修井排期、管道泄漏定位、示功图工况分类……不是通用场景图。点进去看专业背景、案例流程和可运行示范。</p>' +
      '<div class="lh-stats">' +
      '<div><b>' + list.length + '</b><span>已接入案例</span></div>' +
      '<div><b>' + s.coveredScenes + '<small>/' + A.allScenes.length + '</small></b><span>覆盖场景</span></div>' +
      '<div><b>' + withCover + '</b><span>数据图版</span></div>' +
      '<div><b>' + s.withDemo + '</b><span>可运行示范</span></div>' +
      '</div></div>' +
      (heroPhoto ? '<span class="lh-credit">背景：AI 生成示意图 · 案例封面为数据图版</span>' : '') +
      '</section>';

    var tools = '<div class="lib-tools">' +
      '<div class="lt-search"><input id="lib-q" type="search" placeholder="搜案例、场景、现场或方法，例如「套管」「示功图」…" aria-label="搜索案例"></div>' +
      '<div class="lt-rows">' +
      '<div class="lt-row"><span class="lt-l">环节</span><div class="lt-chips" id="lib-stages">' +
      '<button class="lf-chip on" data-f-stage="*">全部<span>' + list.length + '</span></button>' + stageChips + '</div></div>' +
      '<div class="lt-row"><span class="lt-l">方法</span><div class="lt-chips" id="lib-methods">' +
      '<button class="lf-chip on" data-f-method="*">全部<span>' + list.length + '</span></button>' + methodChips + '</div></div>' +
      '</div>' +
      '<div class="lt-count">显示 <b id="lib-n">' + list.length + '</b> / ' + list.length + ' 个案例' +
      '<button class="lt-reset" id="lib-reset">重置筛选</button></div>' +
      '</div>';

    var cards = '<div class="lib-grid" id="lib-grid">' + list.map(libCard).join('') + '</div>' +
      '<div class="lib-empty" id="lib-empty" hidden><b>没有匹配的案例</b><span>换个关键词，或点「重置筛选」。</span></div>';

    /* ---- 工程校验：保留原有契约校验，但收进展开的详情区 ---- */
    var rows = list.map(function (c) {
      var sc = A.index.byScene[c.sceneId];
      var ck = checks[c.id] || [];
      var errs = ck.filter(function (x) { return x.level === 'error'; }).length;
      var warns = ck.filter(function (x) { return x.level === 'warn'; }).length;
      var state = errs ? '<span class="bad-mark">✕ ' + errs + ' 项错误</span>'
        : warns ? '<span class="mono" style="font-size:11px;color:var(--warn)">! ' + warns + ' 项提醒</span>'
          : '<span class="ok-mark">✓ 通过</span>';
      var tabFlags = ['background', 'workflow', 'demo'].map(function (k) {
        return '<span class="' + (c.tabs[k] ? 'ok-mark' : 'dim-mark') + '" title="' + k + '">' + (c.tabs[k] ? '●' : '○') + '</span>';
      }).join(' ') + '<span style="color:var(--ink-4);margin:0 3px">/</span>' +
        '<span class="' + (fieldOf(c) ? 'ok-mark' : 'dim-mark') + '" title="field">' + (fieldOf(c) ? '●' : '○') + '</span>';
      var mChips = (c.methods || []).map(caseChip).join('') || '<span class="dim-mark">继承场景</span>';
      return '<tr><td class="id">' + esc(c.id) + '</td>' +
        '<td><div class="nm">' + esc(c.title || sc && sc.name) +
        (c.imported ? '<span class="badge-local">本地导入</span>' : '') + '</div>' +
        '<div class="sc">' + (sc ? esc(sc.stageName) + ' / ' + esc(sc.name) : '⚠ sceneId 未匹配') + '</div></td>' +
        '<td>' + mChips + '</td>' +
        '<td class="sc">' + esc(c.version || '—') + '</td>' +
        '<td class="sc">' + esc(c.updated || '—') + '</td>' +
        '<td style="letter-spacing:.16em">' + tabFlags + '</td>' +
        '<td>' + state + '</td>' +
        '<td>' + (sc ? '<a class="btn sm ghost" href="#/scene/' + sc.id + '?case=' + esc(c.id) + '">打开 →</a>' : '—') +
        '<a href="#" class="link-remove" data-remove-case="' + esc(c.id) + '" title="' +
        (c.imported ? '从本机移除这份上传的案例包' : '从站点删除这个插件案例（文件保留，可恢复）') + '">' +
        (c.imported ? '移除' : '删除') + '</a>' +
        '</td></tr>';
    }).join('');

    var blocked = (global.CaseImport && global.CaseImport.blockedList ? global.CaseImport.blockedList() : [])
      .filter(function (id) { return !Cases.get(id); });
    var blockedBlock = '';
    if (blocked.length) {
      blockedBlock =
        '<div class="blocked-box">' +
        '<div class="bb-h"><span class="kicker clay">HIDDEN</span>' +
        '<b>已删除的插件案例（' + blocked.length + '）</b>' +
        '<span class="bb-sub">.js 文件仍在磁盘上，恢复后重新加载页面即可回到上表</span></div>' +
        '<div class="bb-list">' + blocked.map(function (id) {
          return '<span class="bb-item"><span class="mono">' + esc(id) + '</span>' +
            '<a href="#" class="link-remove" data-restore-case="' + esc(id) + '">恢复</a></span>';
        }).join('') + '</div></div>';
    }

    var detail = list.map(function (c) {
      var ck = checks[c.id] || [];
      return '<details class="audit-detail"><summary>' +
        esc(c.id) + ' 的校验明细 <span class="mono">' + ck.length + ' 条</span></summary>' +
        '<div style="padding:0 14px 12px"><table class="contract"><tbody>' +
        ck.map(function (x) {
          var mark = x.level === 'ok' ? '<span class="ok-mark">✓</span>'
            : x.level === 'warn' ? '<span style="color:var(--warn);font-family:var(--mono);font-size:11px">!</span>'
              : '<span class="bad-mark">✕</span>';
          return '<tr><td style="width:22px">' + mark + '</td>' +
            '<td style="font-family:var(--sans)">' + esc(x.label) + '</td>' +
            '<td style="color:var(--ink-4);font-size:11px">' + esc(x.detail) + '</td></tr>';
        }).join('') + '</tbody></table></div></details>';
    }).join('');

    var audit = '<details class="lib-audit" id="lib-audit">' +
      '<summary><span class="la-k">ENGINEERING CHECK</span>' +
      '<b>工程校验与接入状态</b>' +
      '<span class="la-sum">' + list.length + ' 个案例 · 由启动扫描逐项校验 · 点开看明细</span>' +
      '<span class="la-btn">展开</span></summary>' +
      '<div class="la-body">' +
      '<div class="console-bar">' +
      '<span class="num">' + s.coveredScenes + '<small>/' + s.totalScenes + '</small></span>' +
      '<span class="lbl">个场景已有案例实现（共 ' + s.registered + ' 个案例）</span><span class="sp"></span>' +
      '<button class="btn sm primary" data-import>＋ 添加案例</button>' +
      '<button class="btn sm ghost" id="rerun">重新校验</button></div>' +
      '<div class="matrix-wrap" style="box-shadow:var(--sh-1)">' +
      '<table class="sys-table"><thead><tr>' +
      '<th>案例 id</th><th>绑定场景</th><th>涉及技术</th><th>版本</th><th>更新</th><th>内容 / 现场</th><th>校验</th><th></th>' +
      '</tr></thead><tbody>' + (rows || '<tr><td colspan="8" class="empty">还没有任何案例注册</td></tr>') + '</tbody></table></div>' +
      '<p class="small muted" style="margin-top:9px">「内容 / 现场」依次为 background / workflow / demo / field，● 已提供、○ 未提供。同一个场景支持挂多个案例，场景页顶部会出现切换器。删除上传案例会清掉本机存档；删除插件案例只是隐藏，文件不动，可随时恢复。</p>' +
      blockedBlock + '<div style="margin-top:18px">' + detail + '</div>' +
      '</div></details>';

    var backlog = '<div class="section lib-backlog" style="padding:34px 0 56px">' +
      '<div class="sec-head"><div><span class="kicker">BACKLOG</span>' +
      '<h2 style="margin-top:10px">还有 ' + pending.length + ' 个场景等待接入</h2>' +
      '<p>下面这些场景已有元数据，缺的是案例实现。接入一个大约需要「一份专业背景 + 一条流程 + 一个能跑的最小示范」。</p>' +
      '</div></div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:7px">' +
      pending.slice(0, 24).map(function (sc) {
        return '<a class="tag" href="#/scene/' + sc.id + '">' + esc(sc.name) + '</a>';
      }).join('') +
      (pending.length > 24 ? '<span class="tag">… 另有 ' + (pending.length - 24) + ' 个</span>' : '') +
      '</div></div>';

    return '<main class="wrap">' +
      crumb([['#/', '总览'], ['#/cases', '案例库']]) +
      hero + tools + cards + audit + backlog +
      '</main>';
  }

  /* ---- 案例库筛选：环节 × 方法 × 关键词 ---- */
  function bindLibrary(root) {
    var grid = root.querySelector('#lib-grid');
    if (!grid) return;
    var cards = [].slice.call(grid.querySelectorAll('.lib-card'));
    var nEl = root.querySelector('#lib-n');
    var empty = root.querySelector('#lib-empty');
    var qEl = root.querySelector('#lib-q');
    var stage = '*', method = '*', q = '';

    function apply() {
      var n = 0;
      cards.forEach(function (card) {
        var okStage = stage === '*' || card.dataset.stage === stage;
        var okMethod = method === '*' || (' ' + card.dataset.methods + ' ').indexOf(' ' + method + ' ') >= 0;
        var okQ = !q || card.dataset.text.indexOf(q) >= 0;
        var ok = okStage && okMethod && okQ;
        card.hidden = !ok;
        if (ok) n++;
      });
      if (nEl) nEl.textContent = n;
      if (empty) empty.hidden = n > 0;
    }

    function chips(sel, attr, set) {
      var box = root.querySelector(sel);
      if (!box) return;
      [].forEach.call(box.querySelectorAll('.lf-chip'), function (b) {
        b.addEventListener('click', function () {
          [].forEach.call(box.querySelectorAll('.lf-chip'), function (x) { x.classList.remove('on'); });
          b.classList.add('on');
          set(b.getAttribute(attr) || '*');
          apply();
        });
      });
    }
    chips('#lib-stages', 'data-f-stage', function (v) { stage = v; });
    chips('#lib-methods', 'data-f-method', function (v) { method = v; });

    if (qEl) {
      qEl.addEventListener('input', function () {
        q = qEl.value.trim().toLowerCase();
        apply();
      });
    }
    var reset = root.querySelector('#lib-reset');
    if (reset) reset.addEventListener('click', function () {
      stage = '*'; method = '*'; q = '';
      if (qEl) qEl.value = '';
      [].forEach.call(root.querySelectorAll('.lf-chip'), function (b) {
        b.classList.toggle('on', b.getAttribute('data-f-stage') === '*' || b.getAttribute('data-f-method') === '*');
      });
      apply();
    });
  }

  /* =========================================================
     九、接入指南
     ========================================================= */
  function guideHTML() {
    var fileTree = K.tree([
      '<b>项目根目录</b>',
      '├── index.html                <span class="cm">脚本顺序；案例脚本块由工具自动生成</span>',
      '├── cases/                    <span class="dir">← 案例包的「源」：一个文件夹一个案例</span>',
      '│   ├── workover-plan-kg/     <span class="new">case.json + demo/ + README.txt</span>',
      '│   ├── casing-damage-cv/     <span class="new">修井 5 个案例都在这层</span>',
      '│   └── gaslogging-fluid-ts/  <span class="new">…共 9 个案例包</span>',
      '├── tools/                    <span class="cm">开发期工具（不参与线上运行）</span>',
      '│   ├── build-cases.mjs       <span class="cm">案例包 → 插件 + 同步公共皮肤</span>',
      '│   ├── demo-base.css         <span class="cm">示范页公共皮肤（母版）</span>',
      '│   ├── test-import.mjs       <span class="cm">导入链路端到端自检</span>',
      '│   └── shot.mjs / check-demo.mjs  <span class="cm">截图与示范自检</span>',
      '├── assets/',
      '│   ├── data.js               <span class="cm">场景元数据（13 环节 / 61 场景）</span>',
      '│   ├── core/                 <span class="cm">外壳</span>',
      '│   │   ├── tokens.css        <span class="cm">设计令牌（颜色 / 圆角 / 阴影）</span>',
      '│   │   ├── layout.css        <span class="cm">导航 / 深色首页带 / 页脚</span>',
      '│   │   ├── ui.css            <span class="cm">卡片 / 表格 / 四段式 / 示范框</span>',
      '│   │   ├── fx.js             <span class="cm">首页粒子动效（Canvas 2D，零依赖）</span>',
      '│   │   ├── registry.js       <span class="cm">Cases.register 契约与校验</span>',
      '│   │   ├── kit.js            <span class="cm">K.sec4 / K.figure / K.code…</span>',
      '│   │   ├── case-demo-host.js <span class="cm">示范宿主：iframe 整页 / Shadow DOM 模块</span>',
      '│   │   ├── case-upload.js    <span class="cm">案例包导入：校验 / 打包 / 落库</span>',
      '│   │   ├── pack-library.js   <span class="cm">案例包库：在线试跑 / 导出 zip</span>',
      '│   │   └── shell.js          <span class="cm">路由与页面</span>',
      '│   └── cases/                <span class="cm">插件目录：<b>生成物</b>，不要手改</span>',
      '│       ├── welllog-layer.case.js   <span class="cm">手写插件（历史示例）</span>',
      '│       └── &lt;id&gt;.case.js           <span class="cm">由 build-cases.mjs 生成</span>',
      '└── docs/',
      '    └── 如何添加新案例.md      <span class="cm">本页的离线版</span>'
    ]);

    var sample = [
      "Cases.register({",
      "  id: 'logging-mud-loss',          // 必填，kebab-case，全局唯一",
      "  sceneId: 'd3',                    // 必填，data.js 里已有的场景 id",
      "  title: '钻井液漏失层位识别',",
      "  status: 'ready',                  // ready | draft",
      "  version: '1.0.0',",
      "  updated: '2026-10-22',",
      "",
      "  tabs: {",
      "    // ① 专业背景：四段式，返回 HTML 字符串",
      "    background: {",
      "      label: '专业背景',",
      "      judge: [",
      "        { label: '任务', value: '序列分割' },",
      "        { label: '数据', value: '随钻曲线 + 漏失记录' }",
      "      ],",
      "      lede: '一句话说明这个场景到底在做什么。',",
      "      sections: [",
      "        { no: 1, en: 'PROBLEM', title: '当前做法与问题',",
      "          html: '<p>……</p>' + K.figure(svgManual(), 1, '图注') },",
      "        { no: 2, en: 'INTERVENTION', title: 'AI 能做什么', html: '……' },",
      "        { no: 3, en: 'DATA', title: '你需要准备什么',",
      "          html: K.checklist([['随钻曲线', '1 s 采样'], ['漏失记录', '人工登记']]) },",
      "        { no: 4, en: 'DIFFICULTY', title: '技术难度与参考方向', html: '……' }",
      "      ]",
      "    },",
      "",
      "    // ② 案例流程：一条真实项目走过的路",
      "    workflow: {",
      "      label: '案例流程',",
      "      title: '某某区块 18 口井的漏失识别',",
      "      lead: ['项目目标不是做模型，而是把漏失层位定位时间压到 10 分钟。'],",
      "      stats: [['样本井', '18 口'], ['目标准确率', '85%']],",
      "      steps: [",
      "        { name: '数据对齐', do: '……', role: '工程环节',",
      "          effect: '……', trap: '……' }",
      "      ],",
      "      fails: [{ name: '标签滞后', why: '……' }]",
      "    },",
      "",
      "    // ③ 可运行示范（可选）：给一个 DOM 容器就能跑",
      "    demo: {",
      "      label: '可运行示范',",
      "      mount: function (root, ctx) {",
      "        root.innerHTML = '<div>……</div>';",
      "        // ctx.scene / ctx.kase / ctx.K / ctx.atlas 都可直接用",
      "      },",
      "      unmount: function () { /* 清理定时器、事件监听 */ }",
      "    }",
      "  }",
      "});"
    ].join('\n');

    var fields = [
      ['id', '必填', '全局唯一标识，kebab-case。会显示在场景页头部与控制台里。'],
      ['sceneId', '必填', '绑定到 data.js 中的某个场景 id。校验会检查它是否存在。'],
      ['title', '必填', '案例标题，通常与场景名一致或更具体。'],
      ['status', '建议', 'ready = 可用于教学；draft = 内容未定稿，控制台标黄。'],
      ['version', '建议', '语义化版本，改了内容就升一格。'],
      ['updated', '建议', '最后更新日期，方便判断内容是否过期。'],
      ['tabs.background', '必填', '对象。judge（30 秒判断）/ lede（导语）/ sections（四段式数组）。'],
      ['tabs.background.sections[]', '必填', '每段 { no, en, title, html }。建议恰好四段，与全站一致。'],
      ['tabs.workflow', '建议', '对象。title / lead[] / stats[] / steps[] / fails[] / metrics。'],
      ['tabs.workflow.steps[]', '建议', '每步 { name, do, role, effect, trap }。role 会渲染成小标签。'],
      ['tabs.demo', '可选', '对象。mount(root, ctx) 必填；unmount() 用于清理。'],
      ['tabs.demo.label', '可选', '第三个 tab 的显示名，默认「可运行示范」。']
    ].map(function (r) {
      var req = r[1] === '必填' ? '<span class="req">必填</span>'
        : r[1] === '建议' ? '<span class="opt">建议</span>' : '<span class="opt">可选</span>';
      return '<tr><td>' + esc(r[0]) + '</td><td>' + req + '</td><td>' + rich(r[2]) + '</td></tr>';
    }).join('');

    /* 图文说明书：四张来自本站当前界面的截图 */
    function mstep(no, title, copy, bullets, action, img, alt, spots, capNo, caption) {
      return '<li class="mstep">' +
        '<div class="mstep-rail"><span class="mnum">' + no + '</span><span class="mline"></span></div>' +
        '<div class="mstep-body">' +
        '<div class="mstep-copy"><h3>' + title + '</h3><p>' + copy + '</p>' +
        '<ul>' + bullets.map(function (b) { return '<li>' + b + '</li>'; }).join('') + '</ul>' +
        action + '</div>' +
        '<figure class="mshot"><div class="mimg"><img src="' + img + '" alt="' + alt + '" loading="lazy">' +
        spots.map(function (s) {
          return '<span class="mhot" style="left:' + s[0] + '%;top:' + s[1] + '%">' + s[2] + '</span>';
        }).join('') +
        '</div><figcaption><b>' + capNo + '</b>' + caption + '</figcaption></figure>' +
        '</div></li>';
    }
    var manual =
      '<div class="manual">' +
      '<div class="manual-head"><span class="kicker">VISUAL MANUAL</span>' +
      '<h2>四张图走完接入流程</h2>' +
      '<p>下面四张图都来自本站的当前界面：先看一个完整的案例包，再把它拖进「添加案例」，最后在案例库里确认校验通过。每一步左侧的文字对应右侧的截图。</p></div>' +
      '<ol class="manual-steps">' +
      mstep('01', '先看一个完整的案例包',
        '案例包就是一个文件夹：一份清单加一套示范。清单负责元信息与正文，示范负责可运行的那一部分。',
        ['<b>清单</b> case.json：绑定场景、写三个 tab 的内容。',
          '<b>示范</b> demo/index.html + demo.js：整页运行在沙箱里。',
          '<b>素材</b> 图片、JSON 直接放进包内，构建时自动内联。'],
        '<a class="mlink" href="#/packs">打开案例包库 <span>→</span></a>',
        'assets/guide/step-pack.png?v=20261102a', '案例包库页面截图',
        [],
        '图 1', '案例包库：每个包都可以在线试跑或下载 .zip。') +
      mstep('02', '把文件夹拖进「添加案例」',
        '不用改任何文件。点右上角按钮，把整个文件夹拖进虚线框；系统读取清单和示范文件，并在右侧逐项校验。',
        ['<b>红色</b> 必须处理，<b>黄色</b> 可以先忽略。',
          '没有现成包时，可下载模板，或只用清单先占一个位置。',
          '上传的案例保存在本机浏览器，换电脑要重新上传。'],
        '<button class="btn sm primary" data-import>＋ 打开「添加案例」</button>',
        'assets/guide/step-import.png?v=20261102a', '添加案例弹窗截图',
        [],
        '图 2', '添加案例：左侧拖入文件夹，右侧逐项校验，底部确认添加。') +
      mstep('03', '先在沙箱里试跑',
        '校验通过后，场景页会多出第三个 tab「可运行示范」。示范跑在 sandbox iframe 里，样式和脚本与主站隔离。',
        ['<b>专业背景</b> 与 <b>案例流程</b> 来自 case.json。',
          '示范页可以用 Canvas、SVG 或本地内置的前端库。',
          '切换 tab 或离开页面时，示范会被销毁，不留定时器。'],
        '<a class="mlink" href="#/packs">挑一个包在线试跑 <span>→</span></a>',
        'assets/guide/step-demo.png?v=20261102a', '场景页可运行示范截图',
        [],
        '图 3', '场景页：三个 tab，以及沙箱内真实运行的示范。') +
      mstep('04', '在案例库里验收',
        '最后回到案例库，展开页面底部的「工程校验」表：id、绑定场景、三块内容、示范与校验全部通过，才算真正接进站点。',
        ['<b>合并场景</b> 会出现在环节页、方法页与首页统计里。',
          '同 id 上传包会覆盖内置版；移除后自动回退。',
          '案例包页还能下载 .zip，作为别人的导入模板。'],
        '<a class="mlink" href="#/cases">打开案例库 <span>→</span></a>',
        'assets/guide/step-check.png?v=20261102a', '案例库校验截图',
        [],
        '图 4', '案例库：逐项校验通过后，案例才会出现在场景页。') +
      '</ol>' +
      '<div class="manual-foot"><b>图注</b><span>截图来自本站当前界面；每一步左侧文字对应右侧截图。需要离线版或完整字段表，可继续看下面的详细说明，或打开 <a href="docs/如何添加新案例.md">docs/如何添加新案例.md</a>。</span></div>' +
      '</div>';

    return '<main class="wrap">' +
      crumb([['#/', '总览'], ['#/guide', '接入指南']]) +
      '<div class="page-head"><div class="ph-top"><div>' +
      '<div class="ph-idx">EXTENDING</div>' +
      '<h1>怎么把这个系统扩成你自己的案例集</h1>' +
      '<p class="blurb">两条路：不写代码就上传案例包；需要真实算法示范时才写插件。两条路走完，效果一样——场景页自动长出 tab，检索路径自动收录。</p>' +
      '</div></div></div>' +
      manual +

      /* ---- 方式 A：上传案例包 ---- */
      '<div class="sec-head" style="margin-top:4px">' +
      '<div class="sec-rail"><span class="sec-num">A</span><span class="kicker">UPLOAD PACKAGE · 推荐</span>' +
      '<span class="r"><span class="tag">不需要改任何文件</span></span></div>' +
      '<h2>上传一个案例包，三步接进去</h2>' +
      '<p>下载模板（zip，含一个能跑的示范页）→ 改清单、替换演示内容 → 把整个文件夹拖回网站。系统逐项检查格式，通过后当场出现在站点里。</p>' +
      '</div>' +

      '<div class="upcard">' +
      '<div class="upcard-l">' +
      '<h4>案例包是什么</h4>' +
      '<p>是一个<b>文件夹</b>：一份 JSON 清单 + 任意演示文件。清单写名称、所属场景和两块正文（专业背景 / 案例流程）；' +
      '示范可以是一个完整的 <b>index.html</b>、配套的 <b>demo.js</b> / <b>demo.css</b>，以及图片、JSON 数据等素材。</p>' +
      '<p>拖进弹窗时会整个读进浏览器——<b>html 自动内联 css 与 js、图片自动转成内嵌资源</b>，所以不需要服务器，双击 index.html 也能跑。</p>' +
      '<p>示范页跑在 <b>sandbox iframe</b> 里，你可以随便写样式和脚本，不会污染主站；只有 demo.js 没有 html 时，脚本会挂进 <b>Shadow DOM</b>，样式同样隔离。</p>' +
      '<div class="upcard-acts">' +
      '<button class="btn primary" data-import>＋ 打开「添加案例」</button>' +
      '<button class="btn" data-dl-template>↓ 下载案例包模板（.zip）</button>' +
      '</div>' +
      '<div class="upcard-note">模板解压后就是一个可直接运行的完整包：清单 + 示范页 + 样式 + 脚本，改完整个文件夹拖回去即可。' +
      '上传的案例保存在本机浏览器（localStorage），换电脑需重新上传；要永久发布给所有人，用下面的方式 B。</div>' +
      '</div>' +
      '<div class="upcard-r">' +
      '<table class="contract"><thead><tr><th>文件 / 字段</th><th>级别</th><th>说明</th></tr></thead><tbody>' +
      [
        ['case.json', '必填', '清单。建议就用这个名字，放在包根目录'],
        ['demo/index.html', '可选', '整页示范。自动内联 css/js，图片相对路径自动替换'],
        ['demo/demo.css', '可选', '示范页样式，只在沙箱里生效'],
        ['demo/demo.js', '可选', '示范脚本；无 html 时走模块模式，需导出 mount'],
        ['id', '必填', '小写字母 / 数字 / 连字符，全站唯一'],
        ['sceneId', '必填', '绑定场景，等于选定分类（环节 + 方法自动带出）'],
        ['title', '必填', '案例名称，页头与列表都用它'],
        ['tabs.background.sections[]', '必填', '每段 { title, html }；建议四段'],
        ['tabs.background.judge', '可选', '「30 秒判断」四格 { label, value, desc }'],
        ['tabs.workflow.steps[]', '可选', '每步 { name, do, effect, trap }'],
        ['tabs.demo.mode', '可选', 'auto（默认）/ page / module / builtin，一般不用写'],
        ['tabs.demo.builtin', '可选', '复用某个已有案例的示范（填它的 id）']
      ].map(function (r) {
        var req = r[1] === '必填' ? '<span class="req">必填</span>' : '<span class="opt">可选</span>';
        return '<tr><td>' + esc(r[0]) + '</td><td>' + req + '</td><td>' + rich(r[2]) + '</td></tr>';
      }).join('') +
      '</tbody></table>' +
      '</div>' +
      '</div>' +

      /* ---- 方式 B：案例包 + 生成插件 ---- */
      '<div class="sec-head" style="margin-top:26px">' +
      '<div class="sec-rail"><span class="sec-num">B</span><span class="kicker">PACKAGE · 站点内置案例的做法</span></div>' +
      '<h2>写成案例包，再生成插件</h2>' +
      '<p>本站自带的 9 个案例都是这么做的：源是一个<b>文件夹</b>（清单 + demo/），跑一遍生成脚本变成插件。' +
      '好处是同一份内容既能直接上线，又能原样导出成 .zip 给别人导入，两条路永远一致。</p>' +
      '</div>' +

      '<div class="gsteps">' +
      '<div class="gstep"><div class="gn">1</div><div>' +
      '<h3>新建一个案例包文件夹</h3>' +
      '<p>照抄 <b>cases/workover-plan-kg/</b> 的结构：<b>case.json</b>（元信息 + 三块正文）、<b>demo/index.html</b>、<b>demo/demo.js</b>、<b>demo/demo.css</b>、<b>README.txt</b>。</p>' +
      '<p>文件夹名必须等于 case.json 里的 <b>id</b>（kebab-case）；<b>sceneId</b> 必须是 data.js 里已有的场景 id（如 <b>wo1</b>）。要改配色就改 <b>tools/demo-base.css</b>，生成时会同步到所有案例包。</p>' +
      '</div></div>' +

      '<div class="gstep"><div class="gn">2</div><div>' +
      '<h3>跑生成脚本，script 标签自动加</h3>' +
      K.code('node tools/build-cases.mjs  # 生成 assets/cases/<id>.case.js 并重写 index.html 的案例脚本块\n' +
        'node tools/build-cases.mjs --check   # 只检查，不写文件', { file: '终端', note: '零依赖，Node 18+' }) +
      '<p>脚本会做三件事：把公共皮肤复制进每个包的 demo/demo.css；把案例包的清单与文件内联成插件（与上传路径同构）；重写 index.html 里 <b>&lt;!-- CASES:BEGIN --&gt;</b> 标记块。' +
      '<b>不要手改 assets/cases/&lt;id&gt;.case.js</b>——那是生成物，下次构建会被覆盖。</p>' +
      '</div></div>' +

      '<div class="gstep"><div class="gn">3</div><div>' +
      '<h3>两处验收</h3>' +
      '<p>① 进 <a href="#/cases" style="color:var(--jade-d);font-weight:600">案例库</a> 看校验是否全绿（id / sceneId / 三块内容 / demo.mount / demo 标记）；' +
      '② 进 <a href="#/packs" style="color:var(--jade-d);font-weight:600">案例包</a> 点「下载 .zip」，再把解压出的文件夹拖回「＋ 添加案例」——这条链路跑通，说明你的包在别人机器上也能导入。</p>' +
      '<p>两者都过 = 接入完成：场景页的 tab、面包屑、相关场景、方法反查页里的条目都会自动出现，不需要改任何其它文件。</p>' +
      '</div></div>' +
      '</div>' +

      K.callout('<b>想直接复用？</b>「案例包」页里的 9 个包都可以一键下载成 .zip，解压后就是一份可以直接改的完整工程；也可以点「在线试跑」先看效果。', '') + 

      '<div class="section tight">' +
      '<div class="sec-head"><div><span class="kicker">STRUCTURE</span>' +
      '<h2 style="margin-top:8px">文件在哪</h2></div></div>' + fileTree + '</div>' +

      '<div class="section tight">' +
      '<div class="sec-head"><div><span class="kicker">CONTRACT</span>' +
      '<h2 style="margin-top:8px">契约字段</h2>' +
      '<p>只有标「必填」的字段缺失会报错，其余缺失只是控制台里的一条提醒。</p></div></div>' +
      '<div class="matrix-wrap"><table class="contract"><thead><tr><th>字段</th><th>级别</th><th>说明</th></tr></thead><tbody>' +
      fields + '</tbody></table></div></div>' +

      '<div class="section tight">' +
      '<div class="sec-head"><div><span class="kicker">EXAMPLE</span>' +
      '<h2 style="margin-top:8px">一个完整的案例声明</h2>' +
      '<p>这是最小可用的骨架，把省略号换成你的内容即可。</p></div></div>' +
      K.code(sample, { file: 'assets/cases/your-case.case.js' }) +
      '</div>' +

      '<div class="section tight">' +
      '<div class="sec-head"><div><span class="kicker">KIT</span>' +
      '<h2 style="margin-top:8px">内容怎么写：工具箱</h2>' +
      '<p>不要在案例里写 CSS 类名，用这些函数生成结构，版式改动会全站同步。</p></div></div>' +
      K.dtable(['函数', '用途'], [
        ['K.sec4(no, en, title, html)', '四段式中的一段，带编号与英文小标'],
        ['K.figure(svg, no, caption)', '插图 + 图注，图注支持 **粗体**'],
        ['K.judge([{label,value,desc}])', '页面顶部那排"30 秒判断"格子'],
        ['K.checklist(items)', '可勾选的数据准备清单，items 为 [名称, 规格, 标注要求]'],
        ['K.dtable(head, rows)', '普通数据表格'],
        ['K.pipeline(steps)', '带编号的流程步骤，每步可写效果与坑'],
        ['K.fails([{name, why}])', '失败模式四宫格'],
        ['K.cells([[标签, 值]])', '流程页右侧的指标格'],
        ['K.meter(diff)', '三段式难度条'],
        ['K.refs([...], href)', '参考方向胶囊'],
        ['K.callout(text, "warn")', '提示条'],
        ['K.code(str, {file})', '代码块，带语法着色']
      ]) +
      K.callout('文本里可以直接用 **粗体** 与 `等宽` 两种标记，所有函数都会自动转义 HTML，不需要手动防注入。') +
      '</div>' +

      '<div class="section tight">' +
      '<div class="sec-head"><div><span class="kicker">PITFALLS</span>' +
      '<h2 style="margin-top:8px">四个常踩的坑</h2></div></div>' +
      '<div class="fails" style="grid-template-columns:1fr 1fr">' +
      '<div class="fail"><div class="fi">PITFALL 01</div><h5>script 顺序放反</h5><p>案例写在 shell.js 后面，页面已经渲染完了才注册，控制台里能看到但场景页没有 tab。案例脚本必须在 shell.js 之前。</p></div>' +
      '<div class="fail"><div class="fi">PITFALL 02</div><h5>sceneId 拼错</h5><p>id 区分大小写。写错不会报 JS 错误，只是这个案例永远不出现。控制台的"绑定场景"列会显示 ⚠。</p></div>' +
      '<div class="fail"><div class="fi">PITFALL 03</div><h5>demo 里没有清理</h5><p>用 setInterval / addEventListener 的示范要在 unmount 里清掉，否则切换场景后老定时器还在跑。</p></div>' +
      '<div class="fail"><div class="fi">PITFALL 04</div><h5>把样式写死在案例里</h5><p>内联颜色会让案例在改配色时掉队。颜色一律用 var(--jade) 这类令牌，或干脆用 K.* 生成。</p></div>' +
      '</div></div>' +

      '<div class="pending" style="margin-top:36px"><div class="pending-top">' +
      '<span class="badge-ready">下一步</span><h3>从最简单的案例开始</h3></div>' +
      '<p>如果还没有想好做什么，先挑一个 <b>数据现成、任务边界清晰</b> 的场景：把四段式写满、流程写三步、示范可以先不做。一个只有 80 行内容的案例，也比一个空着的场景有用。</p>' +
      '<div class="pending-actions">' +
      '<a class="btn primary" href="#/cases">看当前案例库 →</a>' +
      '<a class="btn" href="#/scene/w1">对照测井分层的写法</a></div></div>' +
      '</main>';
  }

  /* =========================================================
     十一、调度
     ========================================================= */
  function unmountCurrent() {
    if (mounted && mounted.unmount) {
      try { mounted.unmount(); } catch (e) { }
    }
    mounted = null;
    mountedKey = '';
  }

  function render() {
    var r = parseHash();
    var p = r.parts;
    unmountCurrent();
    if (stageScroll) {
      global.removeEventListener('scroll', stageScroll);
      stageScroll = null;
    }
    if (global.FX3D) global.FX3D.destroy();
    if (global.FX) global.FX.destroy();
    window.scrollTo(0, 0);

    var html;
    if (!p.length) html = homeHTML();
    else if (p[0] === 'chain') html = chainHTML();
    else if (p[0] === 'explore') html = global.Explore ? global.Explore.pageHTML() : notFound('星图模块未加载');
    else if (p[0] === 'cases') html = casesHTML();
    else if (p[0] === 'guide') html = guideHTML();
    else if (p[0] === 'packs') html = global.Packs ? global.Packs.pageHTML() : notFound('案例包模块未加载');
    else if (p[0] === 'admin') html = global.Admin ? global.Admin.route(p, r.q) : notFound('管理模块未加载');
    else if (p[0] === 'stage') {
      var st = A.index.byStage[p[1]];
      html = st ? stageHTML(st, r.q) : notFound('没有这个环节');
    } else if (p[0] === 'method') {
      location.hash = '#/explore';
      return;
    } else if (p[0] === 'scene') {
      var sc = A.index.byScene[p[1]];
      html = sc ? sceneHTML(sc, r.q) : notFound('没有这个场景');
    } else html = notFound('页面不存在');

    view.innerHTML = header() + html + footer();

    var heroMounted = false;
    if (!p.length) heroMounted = !!bindStage();

    /* 首页动效由 bindStage 挂载（需要状态回调）；其它页面只做滚动显形 */
    if (global.FX) {
      if (!heroMounted && document.getElementById('hero-fx')) global.FX.hero(document.getElementById('hero-fx'));
      global.FX.reveal(view);
    }

    // 页面级交互
    if (p[0] === 'stage') bindFilters(view);
    if (p[0] === 'scene') {
      var sc2 = A.index.byScene[p[1]];
      var all2 = sc2 && Cases.bySceneAll(sc2.id);
      var c2 = all2 && all2.filter(function (x) { return x.id === r.q.case; })[0] || (all2 && all2[0]) || null;
      if (c2) bindTabs(sc2, c2);
      /* 多案例切换器 */
      [].forEach.call(view.querySelectorAll('.case-switch [data-case]'), function (b) {
        b.addEventListener('click', function () {
          var tab = parseHash().q.tab;
          go('#/scene/' + sc2.id + '?case=' + b.dataset.case + (tab ? '&tab=' + tab : ''));
        });
      });
    }
    if (p[0] === 'cases') {
      bindLibrary(view);
      var rb = document.getElementById('rerun');
      if (rb) rb.addEventListener('click', render);
    }
    if (p[0] === 'packs' && global.Packs) global.Packs.bind(view);
    if (p[0] === 'admin' && global.Admin) global.Admin.bind(view);
    if (global.V3) global.V3.afterRender(view, { parts: p, route: p[0] || 'home', q: r.q });
    if (p[0] === 'explore' && global.Explore) global.Explore.mount(document.getElementById('explore-root'));
    document.title = pageTitle(p) + ' · 石油智能可视化图鉴';
  }

  function pageTitle(p) {
    if (!p.length) return '总览';
    if (p[0] === 'scene') { var s = A.index.byScene[p[1]]; return s ? s.name : '场景'; }
    if (p[0] === 'stage') { var t = A.index.byStage[p[1]]; return t ? t.name : '环节'; }
    if (p[0] === 'method') return M[p[1]] ? M[p[1]].name : '方法';
    if (p[0] === 'admin') return global.Admin && global.Admin.loggedIn() ? '管理后台' : '管理员登录';
    return { chain: '作业链', explore: '场景星图', cases: '案例库', packs: '案例包', guide: '接入指南' }[p[0]] || '地图';
  }

  function notFound(msg) {
    return '<main class="wrap"><div class="empty" style="padding:120px 0"><b>' + esc(msg) + '</b>' +
      '检查地址，或<a href="#/" style="color:var(--jade-d)">回到总览</a>。</div></main>';
  }

  window.addEventListener('hashchange', render);
  render();

  // 启动自检：把注册阶段的异常打到控制台，便于排查
  var probs = Cases.problems();
  if (probs.length) console.warn('[case registry]', probs);

})(window);
