/* =========================================================
   v3 交互层
   ---------------------------------------------------------
   只在 shell 渲染完成后接管“表现层”：
   控制台三视图、起步推荐、步骤演示、命令面板、滚动标尺。
   不碰案例契约与路由本身。
   ========================================================= */
(function (global) {
  'use strict';

  var A = global.ATLAS || {};
  var M = A.methods || {};
  var esc = (global.K && global.K.esc) || function (s) { return String(s == null ? '' : s); };

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return [].slice.call((root || document).querySelectorAll(sel)); }

  function methodColor(k) {
    var m = M[k] || {};
    return 'var(--c-' + (m.colorKey || k) + ')';
  }

  /* =========================================================
     1. 页头：实底 / 更多菜单 / 移动导航 / 阅读进度
     ========================================================= */
  function bindHeader(route, parts) {
    var hdr = $('.hdr');
    if (!hdr) return;
    var isHome = !parts.length;
    hdr.classList.toggle('over', isHome);
    if (!isHome) hdr.classList.add('solid');

    var more = $('.nav-more');
    if (more) {
      var btn = more.querySelector('button');
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        more.classList.toggle('open');
        btn.setAttribute('aria-expanded', more.classList.contains('open'));
      });
      document.addEventListener('click', function () { more.classList.remove('open'); });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') more.classList.remove('open'); });
    }

    var burger = $('.nav-burger');
    var mnav = $('.mobile-nav');
    if (burger && mnav) {
      burger.addEventListener('click', function () {
        mnav.classList.toggle('on');
        burger.setAttribute('aria-expanded', mnav.classList.contains('on'));
      });
    }

    var read = $('#read-bar');
    if (!read) {
      read = document.createElement('div');
      read.id = 'read-bar';
      read.className = 'read-bar';
      document.body.appendChild(read);
    }
    var onScroll = function () {
      var h = document.documentElement.scrollHeight - global.innerHeight;
      var y = global.scrollY || 0;
      if (h > 400 && y > 200) { read.classList.add('on'); read.style.width = Math.min(100, y / h * 100) + '%'; }
      else read.classList.remove('on');
      if (!isHome) {
        if (y > 10) hdr.classList.add('solid'); else hdr.classList.add('solid');
      }
    };
    global.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  /* =========================================================
     2. 作业链控制台
     ========================================================= */
  function bindConsole(root) {
    var consoleEl = $('.console', root);
    if (!consoleEl) return;

    /* 三视图切换 */
    var tabs = $$('.ctab', consoleEl);
    var views = $$('.cview', consoleEl);
    var hint = $('.console-hint', consoleEl);
    var HINT = {
      stage: '点选环节，右侧即时预览',
      matrix: '点格子带筛选进入环节页',
      stars: '点场景打开 · 可切换 4 种布局'
    };
    function showView(k) {
      tabs.forEach(function (t) { t.classList.toggle('on', t.dataset.view === k); });
      views.forEach(function (v) { v.hidden = v.dataset.view !== k; });
      if (hint && HINT[k]) hint.innerHTML = '<i></i>' + HINT[k];
      if (k === 'matrix') highlightMatrix(null);
      if (k === 'stars' && global.Explore) {
        var mini = document.getElementById('star-mini');
        if (mini) global.Explore.mountMini(mini);
      }
    }
    tabs.forEach(function (t) {
      t.addEventListener('click', function () { showView(t.dataset.view); });
    });

    /* 环节带 */
    var segs = $$('.cseg', consoleEl);
    var panels = $$('.stage-panel', consoleEl);
    function selectStage(id, focus) {
      segs.forEach(function (s) { s.classList.toggle('on', s.dataset.stage === id); s.setAttribute('aria-selected', s.dataset.stage === id ? 'true' : 'false'); });
      panels.forEach(function (p) { p.hidden = p.dataset.stage !== id; });
      if (focus) {
        var seg = segs.filter(function (s) { return s.dataset.stage === id; })[0];
        if (seg) seg.focus();
      }
    }
    segs.forEach(function (s) {
      s.addEventListener('click', function () { selectStage(s.dataset.stage, false); });
      s.addEventListener('keydown', function (e) {
        var i = segs.indexOf(s);
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          var n = segs[(i + (e.key === 'ArrowRight' ? 1 : segs.length - 1)) % segs.length];
          selectStage(n.dataset.stage, true);
        }
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          var href = s.getAttribute('data-href');
          if (href) location.hash = href;
        }
      });
    });

    /* 矩阵：行 / 列高亮 */
    var mx = $('.mx', consoleEl);
    function highlightMatrix(row) {
      if (!mx) return;
      $$('tr.hot', mx).forEach(function (r) { r.classList.remove('hot'); });
      $$('td.hot', mx).forEach(function (c) { c.classList.remove('hot'); });
      if (!row) return;
      row.classList.add('hot');
    }
    if (mx) {
      $$('tbody tr', mx).forEach(function (tr) {
        tr.addEventListener('mouseenter', function () { highlightMatrix(tr); });
        tr.addEventListener('mouseleave', function () { highlightMatrix(null); });
      });
      $$('td[data-m]', mx).forEach(function (td) {
        td.addEventListener('mouseenter', function () {
          $$('td.hot', mx).forEach(function (c) { c.classList.remove('hot'); });
          td.classList.add('hot');
        });
        td.addEventListener('mouseleave', function () { td.classList.remove('hot'); });
      });
    }
  }

  /* =========================================================
     3. 起步推荐器
     ========================================================= */
  var DATA_KEYS = {
    image: ['图像', '影像', '照片', '成像', '视频', '岩屑', '露头', '图件', '荧光', '切片', '地震'],
    curve: ['曲线', '时序', '信号', '参数', '压力', '流量', '载荷', '振动', '电流', '钻时', '产量', '温度'],
    text: ['文本', '报告', '记录', '注记', '案例', '单据', '说明书', '井史', '设计书', '化验单'],
    table: ['表格', '化验', '实验', '台账', '数据表', '多指标', '配方', '样本']
  };
  var GOAL = {
    quick: { name: '快速见效', diff: { '低': 2, '中': 1, '高': 0 } },
    hard: { name: '啃硬骨头', diff: { '低': 0, '中': 1, '高': 2 } },
    platform: { name: '搭长期平台', diff: { '低': 0, '中': 2, '高': 1 } }
  };

  function dataText(sc) {
    return (sc.data || []).map(function (d) { return d[0] + ' ' + (d[1] || ''); }).join(' ');
  }

  function recommend(method, dataKind, goal) {
    var g = GOAL[goal] || GOAL.quick;
    var kws = DATA_KEYS[dataKind] || [];
    var rows = (A.allScenes || []).map(function (sc) {
      var score = 0, why = [];
      if ((sc.methods || []).indexOf(method) >= 0) { score += 3; why.push(M[method] ? M[method].name + ' 正好对口' : '方法对口'); }
      var t = dataText(sc);
      var hit = kws.filter(function (k) { return t.indexOf(k) >= 0; }).length;
      if (hit) { score += Math.min(2, hit); why.push('已有' + hit + '类相关数据'); }
      score += (g.diff[sc.diff] || 0);
      if (g.diff[sc.diff]) why.push('难度' + sc.diff + '，符合“' + g.name + '”');
      var cases = (global.Cases && global.Cases.bySceneAll) ? global.Cases.bySceneAll(sc.id) : [];
      if (cases.length) { score += 1.5; why.push('已有可运行示范'); }
      return { sc: sc, score: score, why: why };
    }).sort(function (a, b) { return b.score - a.score || a.sc.name.localeCompare(b.sc.name, 'zh'); });
    return rows.filter(function (r) { return r.score > 0; }).slice(0, 3);
  }

  function bindStarter(root) {
    var box = $('.start', root);
    if (!box) return;
    var state = { method: 'cv', data: 'image', goal: 'quick' };
    var list = $('.sr-list', box);
    var groups = $$('.cfg-opts', box);

    function render() {
      var rows = recommend(state.method, state.data, state.goal);
      if (!rows.length) {
        list.innerHTML = '<div class="sr-empty">没有匹配的组合，换一个条件试试。</div>';
        return;
      }
      list.innerHTML = rows.map(function (r, i) {
        var sc = r.sc;
        return '<a class="sr-item" href="#/scene/' + sc.id + '">' +
          '<span class="sri-no">' + '0' + (i + 1) + '</span>' +
          '<span><span class="sri-nm">' + esc(sc.name) + '</span>' +
          '<span class="sri-rs">' + r.why.slice(0, 2).map(esc).join(' · ') + '</span></span>' +
          '<span class="sri-go">' + esc(sc.stageName || '') + ' →</span></a>';
      }).join('');
    }
    groups.forEach(function (g) {
      var key = g.dataset.cfg;
      $$('.cfg', g).forEach(function (b) {
        b.addEventListener('click', function () {
          $$('.cfg', g).forEach(function (x) { x.classList.remove('on'); });
          b.classList.add('on');
          state[key] = b.dataset.v;
          render();
        });
      });
    });
    render();
  }

  /* =========================================================
     4. 案例拉片筛选
     ========================================================= */
  function bindReel(root) {
    var reel = $('.reel', root);
    if (!reel) return;
    var cards = $$('.reel-card', reel);
    var chips = $$('.rf', root);
    chips.forEach(function (c) {
      c.addEventListener('click', function () {
        chips.forEach(function (x) { x.classList.remove('on'); });
        c.classList.add('on');
        var st = c.dataset.stage;
        cards.forEach(function (card) {
          card.hidden = st !== '*' && card.dataset.stage !== st;
        });
        reel.scrollLeft = 0;
      });
    });
  }

  /* =========================================================
     5. 场景页：步骤演示 + 检查清单读数
     ========================================================= */
  function bindStepper(root) {
    var box = $('.stepper', root);
    if (!box) return;
    var nodes = $$('.step-node', box);
    var panels = $$('.step-pane', box);
    var prog = $('.step-prog i', box);
    var play = $('.step-play', box);
    var i = 0, timer = null;
    function go(n) {
      i = (n + nodes.length) % nodes.length;
      nodes.forEach(function (x, k) { x.classList.toggle('on', k === i); x.classList.toggle('done', k < i); });
      panels.forEach(function (p, k) { p.hidden = k !== i; });
      if (prog) prog.style.width = ((i + 1) / nodes.length * 100) + '%';
    }
    function stop() {
      if (timer) { clearInterval(timer); timer = null; }
      if (play) { play.textContent = '播放'; play.setAttribute('aria-pressed', 'false'); }
    }
    nodes.forEach(function (n, k) {
      n.addEventListener('click', function () { stop(); go(k); });
    });
    $$('.step-prev', box).forEach(function (b) { b.addEventListener('click', function () { stop(); go(i - 1); }); });
    $$('.step-next', box).forEach(function (b) { b.addEventListener('click', function () { stop(); go(i + 1); }); });
    if (play) {
      play.addEventListener('click', function () {
        if (timer) { stop(); return; }
        play.textContent = '暂停';
        play.setAttribute('aria-pressed', 'true');
        timer = setInterval(function () { go(i + 1); }, 3200);
      });
    }
    go(0);
  }

  function bindReadiness(root) {
    var cl = $('.checklist', root);
    if (!cl) return;
    var items = $$('.cl-item', cl);
    var fill = $('#cl-fill', cl);
    var txt = $('#cl-txt', cl);
    var gauge = $('#cl-gauge', root);
    var note = $('#cl-note', root);
    function sync() {
      var n = items.filter(function (x) { return x.classList.contains('done'); }).length;
      var pct = items.length ? n / items.length * 100 : 0;
      if (fill) fill.style.width = pct + '%';
      if (txt) txt.textContent = n + ' / ' + items.length;
      if (gauge) {
        gauge.style.strokeDasharray = (pct / 100 * 113).toFixed(1) + ' 113';
        var t = gauge.parentNode.querySelector('b');
        if (t) t.textContent = Math.round(pct) + '%';
      }
      if (note) {
        note.textContent = n === 0 ? '先勾选你手上已有的数据。' :
          n === items.length ? '清单齐了：可以按四段式的路径做一个最小示范。' :
            '还差 ' + (items.length - n) + ' 项；缺的部分通常决定项目周期。';
      }
    }
    items.forEach(function (it) {
      var toggle = function () {
        it.classList.toggle('done');
        it.setAttribute('aria-checked', it.classList.contains('done') ? 'true' : 'false');
        sync();
      };
      it.setAttribute('tabindex', '0');
      it.setAttribute('role', 'checkbox');
      it.setAttribute('aria-checked', it.classList.contains('done') ? 'true' : 'false');
      it.addEventListener('click', toggle);
      it.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });
    });
    sync();
  }

  /* =========================================================
     6. 链条页滚动标尺
     ========================================================= */
  function bindDepth(root) {
    var blocks = $$('.depth-block', root);
    if (!blocks.length) return;
    var links = $$('.depth-rail a', root);
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        var id = en.target.dataset.stage;
        links.forEach(function (a) { a.classList.toggle('on', a.dataset.stage === id); });
      });
    }, { rootMargin: '-30% 0px -60% 0px', threshold: 0 });
    blocks.forEach(function (b) { io.observe(b); });
  }

  /* =========================================================
     7. 命令面板
     ========================================================= */
  var cmdkBuilt = false, cmdkItems = [], cmdkSel = 0;

  function buildIndex() {
    var items = [];
    (A.stages || []).forEach(function (st) {
      items.push({ k: '环节', n: st.name, s: st.scenes.length + ' 个场景', h: '#/stage/' + st.id, key: st.name + ' ' + st.en });
    });
    (A.allScenes || []).forEach(function (sc) {
      items.push({ k: '场景', n: sc.name, s: sc.stageName + ' · 难度' + sc.diff, h: '#/scene/' + sc.id, key: sc.name + ' ' + sc.id + ' ' + sc.stageName + ' ' + (sc.methods || []).join(' ') });
    });
    if (global.Cases) {
      global.Cases.list().forEach(function (c) {
        var sc = A.index.byScene[c.sceneId];
        items.push({ k: '案例', n: c.title || c.id, s: (sc ? sc.stageName : '') + ' · ' + c.id, h: sc ? '#/scene/' + sc.id + '?case=' + c.id + '&tab=demo' : '#/cases', key: (c.title || '') + ' ' + c.id + ' 案例' });
      });
    }
    items.push({ k: '页面', n: '作业链', s: '13 个环节', h: '#/chain', key: '作业链 链条 chain' });
    items.push({ k: '页面', n: '案例库', s: '全部案例', h: '#/cases', key: '案例库 cases' });
    items.push({ k: '页面', n: '案例包', s: '下载 / 试跑', h: '#/packs', key: '案例包 packs' });
    items.push({ k: '页面', n: '接入指南', s: '扩成自己的案例集', h: '#/guide', key: '接入 guide 指南' });
    return items;
  }

  function openCmdk(open) {
    var el = $('#cmdk');
    if (!el) return;
    el.classList.toggle('on', open);
    document.body.style.overflow = open ? 'hidden' : '';
    if (open) {
      if (!cmdkBuilt) { cmdkItems = buildIndex(); cmdkBuilt = true; }
      var input = $('#cmdk-input');
      input.value = '';
      cmdkSel = 0;
      renderCmdk('');
      setTimeout(function () { input.focus(); }, 20);
    }
  }

  function renderCmdk(q) {
    var list = $('#cmdk-list');
    if (!list) return;
    var lq = q.trim().toLowerCase();
    var rows = cmdkItems.filter(function (it) {
      return !lq || it.key.toLowerCase().indexOf(lq) >= 0 || it.n.toLowerCase().indexOf(lq) >= 0;
    }).slice(0, 40);
    if (!rows.length) {
      list.innerHTML = '<div class="cmdk-group">没有匹配项</div>';
      return;
    }
    var groups = {};
    rows.forEach(function (r, i) {
      (groups[r.k] = groups[r.k] || []).push({ r: r, i: i });
    });
    var html = '';
    Object.keys(groups).forEach(function (g) {
      html += '<div class="cmdk-group">' + g + '</div>';
      groups[g].forEach(function (x) {
        html += '<div class="cmdk-item' + (x.i === cmdkSel ? ' sel' : '') + '" data-i="' + x.i + '" data-h="' + esc(x.r.h) + '">' +
          '<span class="ci-k">' + x.r.k + '</span><span class="ci-n">' + esc(x.r.n) + '</span>' +
          '<span class="ci-s">' + esc(x.r.s) + '</span></div>';
      });
    });
    list.innerHTML = html;
    $$('.cmdk-item', list).forEach(function (el) {
      el.addEventListener('mouseenter', function () {
        cmdkSel = Number(el.dataset.i);
        $$('.cmdk-item', list).forEach(function (x) { x.classList.toggle('sel', x === el); });
      });
      el.addEventListener('click', function () {
        openCmdk(false);
        if (el.dataset.h) location.hash = el.dataset.h;
      });
    });
  }

  function bindCmdk() {
    if ($('#cmdk')) return;
    var el = document.createElement('div');
    el.id = 'cmdk';
    el.className = 'cmdk';
    el.innerHTML = '<div class="cmdk-panel" role="dialog" aria-label="站内搜索">' +
      '<div class="cmdk-in">' +
      '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="8.5" cy="8.5" r="5.5"/><path d="M13 13l4 4"/></svg>' +
      '<input id="cmdk-input" type="text" placeholder="搜场景、环节、案例或页面…" autocomplete="off">' +
      '<kbd>ESC</kbd></div>' +
      '<div class="cmdk-list" id="cmdk-list"></div>' +
      '<div class="cmdk-foot"><span><kbd>↑</kbd><kbd>↓</kbd> 选择</span><span><kbd>Enter</kbd> 打开</span><span>回车直达，不必先回首页</span></div>' +
      '</div>';
    document.body.appendChild(el);
    el.addEventListener('click', function (e) { if (e.target === el) openCmdk(false); });
    var input = $('#cmdk-input');
    input.addEventListener('input', function () { cmdkSel = 0; renderCmdk(input.value); });
    input.addEventListener('keydown', function (e) {
      var items = $$('.cmdk-item');
      if (e.key === 'ArrowDown') { e.preventDefault(); cmdkSel = Math.min(items.length - 1, cmdkSel + 1); renderCmdk(input.value); }
      if (e.key === 'ArrowUp') { e.preventDefault(); cmdkSel = Math.max(0, cmdkSel - 1); renderCmdk(input.value); }
      if (e.key === 'Enter') {
        var sel = $('.cmdk-item.sel');
        if (sel) { openCmdk(false); if (sel.dataset.h) location.hash = sel.dataset.h; }
      }
      if (e.key === 'Escape') openCmdk(false);
    });
    document.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openCmdk(true); return; }
      if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
        e.preventDefault(); openCmdk(true);
      }
      if (e.key === 'Escape') openCmdk(false);
    });
    $$('[data-cmdk]').forEach(function (b) { b.addEventListener('click', function () { openCmdk(true); }); });
  }

  /* =========================================================
     8. 示范全屏
     ========================================================= */
  function bindDemo(root) {
    var shell = $('.demo-shell', root);
    if (!shell) return;
    var btn = $('[data-demo-full]', shell);
    if (btn) {
      btn.addEventListener('click', function () {
        shell.classList.toggle('is-full');
        btn.textContent = shell.classList.contains('is-full') ? '退出全屏' : '全屏';
        var ifr = shell.querySelector('iframe');
        if (ifr) ifr.style.height = '';
      });
    }
    global.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && shell.classList.contains('is-full')) {
        shell.classList.remove('is-full');
        if (btn) btn.textContent = '全屏';
      }
    });
  }

  /* =========================================================
     9. 入口
     ========================================================= */
  function afterRender(root, ctx) {
    root = root || document;
    var parts = (ctx && ctx.parts) || [];
    bindHeader(ctx && ctx.route, parts);
    bindCmdk();
    bindConsole(root);
    bindStarter(root);
    bindReel(root);
    bindStepper(root);
    bindReadiness(root);
    bindDepth(root);
    bindDemo(root);

    var line = $('#route-line');
    if (line) {
      line.classList.remove('run');
      void line.offsetWidth;
      line.classList.add('run');
    }
  }

  global.V3 = { afterRender: afterRender, recommend: recommend, openCmdk: openCmdk };
})(window);
