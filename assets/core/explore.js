/* =========================================================
   场景星图 · 联动分析台
   ---------------------------------------------------------
   把 61 个候选场景看成一幅可刷选的多变量散点：
     · 颜色 = 主要 AI 方法
     · 位置 = 环节 / 方法 / 难度 / 案例覆盖 四种布局（可动画重排）
     · 大小 = 需要的数据源数量
     · 铜环 = 已经有可运行案例
   左栏环节、右栏方法×环节热图与场景清单同步过滤；
   在图上拖一个框，三处一起收窄。
   ========================================================= */
(function (global) {
  'use strict';

  var A = global.ATLAS || {};
  var M = A.methods || {};
  var MKEYS = Object.keys(M);
  var DIFFS = ['低', '中', '高'];
  var DR = { '低': 1, '中': 2, '高': 3 };
  var MCOL = { cv: '#123b3a', ts: '#a86a1f', nlp: '#4f6066', opt: '#2b5570', kg: '#6f6636' };
  var GRAY = '#8a948c';

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function hash(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return ((h >>> 0) % 10000) / 10000;
  }
  function colorOf(m) {
    var mk = (M[m] && (M[m].colorKey || m)) || m;
    return MCOL[mk] || GRAY;
  }
  function methodName(m) { return (M[m] && M[m].name) || m; }

  /* ---------------- 数据 ---------------- */
  function prep() {
    var pts = (A.allScenes || []).map(function (sc) {
      var st = (A.index && A.index.byStage && A.index.byStage[sc.stageId]) || {};
      var ms = (sc.methods || []).filter(function (k) { return M[k]; });
      if (!ms.length) ms = [MKEYS[0] || 'cv'];
      var cn = (global.Cases && Cases.bySceneAll) ? Cases.bySceneAll(sc.id).length : 0;
      var mi = MKEYS.indexOf(ms[0]);
      return {
        id: sc.id, name: sc.name, point: sc.point || '',
        stageId: sc.stageId, stageName: st.name || sc.stageName || '未分环节',
        stageIdx: st.idx || sc.stageIdx || 1,
        diff: sc.diff || '中', diffRank: DR[sc.diff] || 2,
        methods: ms, methodIdx: mi < 0 ? 1 : mi + 1,
        dataN: (sc.data || []).length || 2,
        caseN: cn,
        j1: hash(sc.id + 'x') * 2 - 1,
        j2: hash(sc.id + 'y') * 2 - 1,
        _x: 0, _y: 0
      };
    });
    /* 同一环节 / 方法 / 难度里的点横向摊开，避免完全重叠 */
    function spread(name, key, maxSpan) {
      var groups = {};
      pts.forEach(function (p) { var k = key(p); (groups[k] = groups[k] || []).push(p); });
      Object.keys(groups).forEach(function (k) {
        var arr = groups[k].sort(function (a, b) { return String(a.id).localeCompare(String(b.id)); });
        var gap = arr.length > 1 ? Math.min(0.17, maxSpan / (arr.length - 1)) : 0;
        arr.forEach(function (p, i) {
          p._spr = p._spr || { stage: {}, method: {}, difficulty: {}, coverage: {} };
          p._spr[name][k] = (i - (arr.length - 1) / 2) * gap;
        });
      });
    }
    spread('stage', function (p) { return p.stageIdx; }, 0.72);
    spread('method', function (p) { return p.methodIdx; }, 0.95);
    spread('difficulty', function (p) { return p.diffRank; }, 0.62);
    spread('coverage', function (p) { return p.caseN; }, 0.58);
    return pts;
  }

  var LAY = {
    stage: { name: '按环节', xlab: '作业环节', ylab: '技术难度', xd: [0.4, 13.6], yd: [0.4, 3.6] },
    method: { name: '按技术', xlab: '技术类别', ylab: '技术难度', xd: [0.4, MKEYS.length + 0.6], yd: [0.4, 3.6] },
    difficulty: { name: '按难度', xlab: '技术难度', ylab: '数据源数量', xd: [0.4, 3.6], yd: [1.4, 4.6] },
    coverage: { name: '按案例', xlab: '已有案例数', ylab: '技术难度', xd: [-0.6, 2.6], yd: [0.4, 3.6] }
  };
  var LAY_ORDER = ['stage', 'method', 'difficulty', 'coverage'];

  function posOf(p, layout) {
    var sp = (p._spr && p._spr[layout]) || {};
    var x, y;
    if (layout === 'stage') {
      x = p.stageIdx + (sp[p.stageIdx] || 0) + p.j1 * 0.035;
      y = p.diffRank + p.j2 * 0.08;
    } else if (layout === 'method') {
      x = p.methodIdx + (sp[p.methodIdx] || 0) + p.j1 * 0.03;
      y = p.diffRank + p.j2 * 0.08;
    } else if (layout === 'difficulty') {
      x = p.diffRank + (sp[p.diffRank] || 0) + p.j1 * 0.03;
      y = p.dataN + p.j2 * 0.10;
    } else {
      x = p.caseN + (sp[p.caseN] || 0) + p.j1 * 0.03;
      y = p.diffRank + p.j2 * 0.08;
    }
    return { x: x, y: y };
  }

  /* ---------------- 图 ---------------- */
  function Chart(host, opts) {
    opts = opts || {};
    this.host = host;
    this.opts = opts;
    this.mini = !!opts.mini;
    this.points = opts.points || prep();
    this.W = 900;
    this.H = this.mini ? 270 : 540;
    this.geo = {
      l: this.mini ? 50 : 78,
      r: this.mini ? 18 : 26,
      t: this.mini ? 20 : 26,
      b: this.mini ? 38 : 58
    };
    this.geo.pw = this.W - this.geo.l - this.geo.r;
    this.geo.ph = this.H - this.geo.t - this.geo.b;
    this.layout = opts.layout || 'stage';
    this.nodes = {};
    this.raf = null;
    this.brushOn = opts.brush !== false && !this.mini && !(global.matchMedia && global.matchMedia('(max-width:760px)').matches);
    this.buildDom();
    this.buildPoints();
    this.setLayout(this.layout, true);
    if (this.brushOn) this.bindBrush();
  }

  Chart.prototype.buildDom = function () {
    var host = this.host;
    host.innerHTML = '';
    host.classList.add('ex-chart');
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 ' + this.W + ' ' + this.H);
    svg.setAttribute('class', 'ex-svg' + (this.mini ? ' ex-svg-mini' : ''));
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', '场景星图：可框选的多变量散点');
    if (this.brushOn) svg.style.touchAction = 'none';
    svg.innerHTML = '<g class="ex-grid"></g><g class="ex-axes"></g><g class="ex-points"></g>' +
      '<rect class="ex-brushrect" x="0" y="0" width="0" height="0" visibility="hidden"></rect>';
    host.appendChild(svg);
    var tip = document.createElement('div');
    tip.className = 'ex-tip';
    host.appendChild(tip);
    this.svg = svg;
    this.tip = tip;
    this.axesLayer = svg.querySelector('.ex-axes');
    this.pointsLayer = svg.querySelector('.ex-points');
    this.brushRect = svg.querySelector('.ex-brushrect');
  };

  Chart.prototype.sx = function (v) {
    var d = LAY[this.layout].xd;
    return this.geo.l + (v - d[0]) / (d[1] - d[0]) * this.geo.pw;
  };
  Chart.prototype.sy = function (v) {
    var d = LAY[this.layout].yd;
    return this.geo.t + this.geo.ph - (v - d[0]) / (d[1] - d[0]) * this.geo.ph;
  };

  Chart.prototype.buildPoints = function () {
    var self = this;
    var html = this.points.map(function (p) {
      var c = colorOf(p.methods[0]);
      var r = self.rad(p);
      return '<g class="ex-ptg" data-id="' + esc(p.id) + '">' +
        '<circle class="ex-ring" cx="450" cy="260" r="' + (r + 2.4) + '" fill="none" stroke="#b4762a" stroke-width=".9" opacity="0"></circle>' +
        '<circle class="ex-dot" cx="450" cy="260" r="' + r + '" fill="' + c + '" stroke="#fbf8f0" stroke-width="1.2" opacity="0"></circle>' +
        '</g>';
    }).join('');
    this.pointsLayer.innerHTML = html;
    this.points.forEach(function (p) {
      var g = self.pointsLayer.querySelector('[data-id="' + p.id + '"]');
      var dot = g.querySelector('.ex-dot');
      var ring = g.querySelector('.ex-ring');
      self.nodes[p.id] = { g: g, dot: dot, ring: ring };
      g.addEventListener('pointerenter', function (e) {
        self.showTip(p, e);
        if (self.opts.onHover) self.opts.onHover(p.id);
      });
      g.addEventListener('pointermove', function (e) { self.showTip(p, e); });
      g.addEventListener('pointerleave', function () {
        self.hideTip();
        if (self.opts.onHover) self.opts.onHover(null);
      });
      g.addEventListener('click', function (e) {
        e.stopPropagation();
        if (self._moved) return;
        if (self.opts.onPoint) self.opts.onPoint(p.id);
        else location.hash = '#/scene/' + p.id;
      });
    });
  };

  Chart.prototype.rad = function (p) {
    return 4.6 + Math.max(0, Math.min(2, p.dataN - 2)) * 2.1;
  };

  Chart.prototype.drawAxes = function (fade) {
    var self = this, L = this.geo.l, T = this.geo.t, W = this.W, H = this.H, B = this.geo.b;
    var cfg = LAY[this.layout];
    var html = '';
    function gridX(v) {
      var x = self.sx(v);
      return '<line x1="' + x.toFixed(1) + '" y1="' + T + '" x2="' + x.toFixed(1) + '" y2="' + (H - B) + '" stroke="rgba(27,42,38,.065)"/>';
    }
    function gridY(v) {
      var y = self.sy(v);
      return '<line x1="' + L + '" y1="' + y.toFixed(1) + '" x2="' + (W - self.geo.r) + '" y2="' + y.toFixed(1) + '" stroke="rgba(27,42,38,.065)"/>';
    }
    var xTicks = [], yTicks = [];
    if (this.layout === 'stage') {
      (A.stages || []).forEach(function (st) {
        xTicks.push({ v: st.idx, t: st.name });
      });
      yTicks = [{ v: 1, t: '低' }, { v: 2, t: '中' }, { v: 3, t: '高' }];
    } else if (this.layout === 'method') {
      MKEYS.forEach(function (k, i) { xTicks.push({ v: i + 1, t: self.mini ? M[k].abbr : M[k].name }); });
      yTicks = [{ v: 1, t: '低' }, { v: 2, t: '中' }, { v: 3, t: '高' }];
    } else if (this.layout === 'difficulty') {
      xTicks = [{ v: 1, t: '低' }, { v: 2, t: '中' }, { v: 3, t: '高' }];
      yTicks = [{ v: 2, t: '2 项' }, { v: 3, t: '3 项' }, { v: 4, t: '4 项' }];
    } else {
      xTicks = [{ v: 0, t: this.mini ? '0' : '无案例' }, { v: 1, t: this.mini ? '1' : '1 个' }, { v: 2, t: this.mini ? '2+' : '2 个以上' }];
      yTicks = [{ v: 1, t: '低' }, { v: 2, t: '中' }, { v: 3, t: '高' }];
    }
    xTicks.forEach(function (t) { html += gridX(t.v); });
    yTicks.forEach(function (t) { html += gridY(t.v); });
    /* 轴 */
    html += '<path d="M' + L + ' ' + T + 'V' + (H - B) + 'H' + (W - this.geo.r) + '" fill="none" stroke="#cbbfa7" stroke-width="1"/>';
    xTicks.forEach(function (t) {
      var x = self.sx(t.v);
      html += '<text x="' + x.toFixed(1) + '" y="' + (H - B + 15) + '" text-anchor="middle" font-size="' + (self.layout === 'stage' ? 9 : 9.5) + '" fill="#6c7872" font-family="sans-serif">' + esc(t.t) + '</text>';
    });
    yTicks.forEach(function (t) {
      var y = self.sy(t.v);
      html += '<text x="' + (L - 8) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="end" font-size="9" fill="#6c7872" font-family="sans-serif">' + esc(t.t) + '</text>';
    });
    html += '<text x="' + (L + self.geo.pw / 2) + '" y="' + (H - 9) + '" text-anchor="middle" font-size="9.5" fill="#98a199">' + esc(cfg.xlab) + ' →</text>';
    html += '<text x="14" y="' + (T + self.geo.ph / 2) + '" text-anchor="middle" font-size="9.5" fill="#98a199" transform="rotate(-90 14 ' + (T + self.geo.ph / 2) + ')">' + esc(cfg.ylab) + ' →</text>';
    if (fade) {
      this.axesLayer.style.opacity = '0';
      var self2 = this;
      clearTimeout(this._axT);
      this._axT = setTimeout(function () {
        self2.axesLayer.innerHTML = html;
        self2.axesLayer.style.opacity = '1';
      }, 170);
    } else {
      this.axesLayer.innerHTML = html;
      this.axesLayer.style.opacity = '1';
    }
  };

  Chart.prototype.setLayout = function (layout, first) {
    if (!LAY[layout]) return;
    this.layout = layout;
    var self = this;
    this.drawAxes(!first);
    var targets = this.points.map(function (p) {
      var d = posOf(p, layout);
      return { x: self.sx(d.x), y: self.sy(d.y) };
    });
    if (first) {
      this.points.forEach(function (p, i) {
        p._x = 450 + p.j1 * 20;
        p._y = self.H / 2 + p.j2 * 20;
        var n = self.nodes[p.id];
        n.dot.setAttribute('cx', p._x); n.dot.setAttribute('cy', p._y);
        n.ring.setAttribute('cx', p._x); n.ring.setAttribute('cy', p._y);
        n.dot.setAttribute('opacity', '1');
      });
      this.animateTo(targets, 850);
    } else {
      this.animateTo(targets, 650);
    }
    if (this.opts.onLayout) this.opts.onLayout(layout);
  };

  Chart.prototype.animateTo = function (targets, dur) {
    var self = this;
    if (this.raf) cancelAnimationFrame(this.raf);
    var from = this.points.map(function (p) { return { x: p._x, y: p._y }; });
    var t0 = performance.now();
    function frame(now) {
      var t = Math.min(1, (now - t0) / Math.max(1, dur));
      var e = 1 - Math.pow(1 - t, 3);
      self.points.forEach(function (p, i) {
        var x = from[i].x + (targets[i].x - from[i].x) * e;
        var y = from[i].y + (targets[i].y - from[i].y) * e;
        p._x = x; p._y = y;
        var n = self.nodes[p.id];
        n.dot.setAttribute('cx', x.toFixed(1)); n.dot.setAttribute('cy', y.toFixed(1));
        n.ring.setAttribute('cx', x.toFixed(1)); n.ring.setAttribute('cy', y.toFixed(1));
      });
      if (t < 1) self.raf = requestAnimationFrame(frame);
      else self.raf = null;
    }
    this.raf = requestAnimationFrame(frame);
  };

  Chart.prototype.setFilter = function (fn, hover, brush) {
    var self = this;
    this.points.forEach(function (p) {
      var on = fn(p);
      var hm = true;
      if (hover) {
        if (hover.type === 'stage') hm = p.stageId === hover.id;
        else if (hover.type === 'method') hm = p.methods.indexOf(hover.id) >= 0;
        else if (hover.type === 'cell') hm = p.stageId === hover.stage && p.methods.indexOf(hover.method) >= 0;
      }
      var n = self.nodes[p.id];
      var op = on ? (hm ? 1 : 0.24) : 0.10;
      n.dot.setAttribute('opacity', op);
      n.g.style.pointerEvents = on ? 'auto' : 'none';
      var ringOn = on && p.caseN > 0;
      n.ring.setAttribute('opacity', ringOn ? (hm ? 0.9 : 0.3) : 0);
      var selected = brush && brush.has(p.id);
      n.dot.setAttribute('stroke', selected ? '#a86a1f' : '#fbf8f0');
      n.dot.setAttribute('stroke-width', selected ? 2.2 : 1.2);
      n.dot.setAttribute('r', selected ? self.rad(p) + 1 : self.rad(p));
    });
  };

  Chart.prototype.clearBrush = function () {
    this.brushRect.setAttribute('visibility', 'hidden');
    this.brushRect.setAttribute('width', '0');
    this.brushRect.setAttribute('height', '0');
  };

  Chart.prototype.showTip = function (p, e) {
    var t = this.tip, host = this.host;
    var r = host.getBoundingClientRect();
    var x = e.clientX - r.left + 14, y = e.clientY - r.top + 12;
    t.innerHTML = '<b>' + esc(p.name) + '</b>' +
      '<span>' + esc(p.stageName) + ' · 难度 ' + esc(p.diff) + '</span>' +
      '<span>' + p.methods.map(function (m) { return esc(methodName(m)); }).join(' · ') + '</span>' +
      '<span>数据源 ' + p.dataN + ' 项' + (p.caseN ? ' · 已有 ' + p.caseN + ' 个案例' : '') + '</span>' +
      '<span class="ex-tip-go">点击打开场景 →</span>';
    t.style.left = x + 'px';
    t.style.top = y + 'px';
    t.classList.add('on');
    if (x > r.width - 220) t.style.left = Math.max(8, x - 230) + 'px';
    if (y > r.height - 120) t.style.top = Math.max(8, y - 130) + 'px';
  };
  Chart.prototype.hideTip = function () { this.tip.classList.remove('on'); };

  Chart.prototype.bindBrush = function () {
    var self = this, svg = this.svg, start = null, moved = false;
    function pt(e) {
      var p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY;
      return p.matrixTransform(svg.getScreenCTM().inverse());
    }
    svg.addEventListener('pointerdown', function (e) {
      if (e.target.closest('.ex-ptg')) return;
      start = pt(e); moved = false;
      self._moved = false;
      self.brushRect.setAttribute('x', start.x); self.brushRect.setAttribute('y', start.y);
      self.brushRect.setAttribute('width', 0); self.brushRect.setAttribute('height', 0);
      self.brushRect.setAttribute('visibility', 'visible');
      try { svg.setPointerCapture(e.pointerId); } catch (err) { }
    });
    svg.addEventListener('pointermove', function (e) {
      if (!start) return;
      var p = pt(e);
      var x = Math.min(start.x, p.x), y = Math.min(start.y, p.y);
      var w = Math.abs(p.x - start.x), h = Math.abs(p.y - start.y);
      if (w > 4 || h > 4) { moved = true; self._moved = true; }
      self.brushRect.setAttribute('x', x); self.brushRect.setAttribute('y', y);
      self.brushRect.setAttribute('width', w); self.brushRect.setAttribute('height', h);
    });
    svg.addEventListener('pointerup', function (e) {
      if (!start) return;
      var p = pt(e);
      var x0 = Math.min(start.x, p.x), x1 = Math.max(start.x, p.x);
      var y0 = Math.min(start.y, p.y), y1 = Math.max(start.y, p.y);
      start = null;
      self.brushRect.setAttribute('visibility', 'hidden');
      setTimeout(function () { self._moved = false; }, 30);
      if (!moved || x1 - x0 < 5 || y1 - y0 < 5) {
        if (self.opts.onBrush) self.opts.onBrush(null);
        return;
      }
      var ids = self.points.filter(function (q) {
        return q._x >= x0 && q._x <= x1 && q._y >= y0 && q._y <= y1;
      }).map(function (q) { return q.id; });
      if (self.opts.onBrush) self.opts.onBrush(ids);
    });
  };

  /* ---------------- 全页 ---------------- */
  function pageHTML() {
    var n = (A.allScenes || []).length;
    var chips = MKEYS.map(function (k) {
      return '<button class="ex-chip on" type="button" data-m="' + k + '" style="--m:' + colorOf(k) + '">' +
        '<i></i>' + esc(M[k].abbr) + ' ' + esc(M[k].name) + '</button>';
    }).join('');
    var dchips = DIFFS.map(function (d) {
      return '<button class="ex-chip on" type="button" data-d="' + d + '">' + d + '</button>';
    }).join('');
    return '<main class="wrap explore-page" id="explore-root">' +
      '<nav class="crumb"><a href="#/">总览</a><span class="sep">/</span><span class="cur">场景星图</span></nav>' +
      '<div class="page-head"><div class="ph-top"><div>' +
      '<div class="ph-idx">SCENE CONSTELLATION · 联动分析</div>' +
      '<h1>把 ' + n + ' 个场景摊在一张图上</h1>' +
      '<p class="blurb">每颗星是一个可智能化的场景：<b>颜色</b>是主要方法，<b>位置</b>是环节与难度，<b>大小</b>是需要的数据源数量，<b>铜环</b>是已经有可运行案例。在图上拖一个框，左侧环节与右侧热图会同步收窄。</p>' +
      '</div><div class="ph-stat">' +
      '<div><div class="n">' + (A.stages || []).length + '</div><div class="l">环节</div></div>' +
      '<div><div class="n">' + n + '</div><div class="l">场景</div></div>' +
      '<div><div class="n">' + MKEYS.length + '</div><div class="l">方法</div></div>' +
      '<div><div class="n">' + (global.Cases ? Cases.list().length : 0) + '</div><div class="l">案例</div></div>' +
      '</div></div></div>' +

      '<div class="ex-toolbar">' +
      '<div class="ex-layouts" role="tablist" aria-label="星图布局">' +
      LAY_ORDER.map(function (k, i) {
        return '<button class="ex-lay' + (i === 0 ? ' on' : '') + '" type="button" data-layout="' + k + '" role="tab">' + LAY[k].name + '</button>';
      }).join('') +
      '</div>' +
      '<div class="ex-filters"><span>方法</span>' + chips + '<span class="ex-fsep">难度</span>' + dchips + '</div>' +
      '<div class="ex-actions">' +
      '<button class="ex-btn" type="button" id="ex-play">自动重排</button>' +
      '<button class="ex-btn" type="button" id="ex-clear">清除筛选</button>' +
      '<span class="ex-count" id="ex-count">—</span>' +
      '</div></div>' +

      '<div class="ex-grid">' +
      '<aside class="ex-panel ex-rail">' +
      '<div class="ex-panel-h"><b>环节</b><span>点选 / 悬停联动</span></div>' +
      '<div id="ex-stages"></div>' +
      '</aside>' +

      '<section class="ex-panel ex-plot">' +
      '<div class="ex-panel-h"><b id="ex-plot-title">按环节 · 技术难度</b><span>拖动框选（桌面）· 点击场景打开</span></div>' +
      '<div class="ex-chart-host" id="ex-chart"></div>' +
      '<div class="ex-legend">' +
      '<span><i class="ex-sw" style="background:#123b3a"></i>颜色 = 主要方法</span>' +
      '<span><i class="ex-sw" style="width:9px;height:9px;border-radius:50%;background:#123b3a"></i>大小 = 数据源数量</span>' +
      '<span><i class="ex-sw" style="width:9px;height:9px;background:none;border:1px solid #b4762a;border-radius:50%"></i>铜环 = 已有案例</span>' +
      '<span class="ex-brushhint">在空白处拖框刷选</span>' +
      '</div>' +
      '</section>' +

      '<aside class="ex-panel ex-side">' +
      '<div class="ex-panel-h"><b>方法 × 环节</b><span>点格子筛选</span></div>' +
      '<div class="ex-heat" id="ex-heat"></div>' +
      '<div class="ex-panel-h ex-panel-h2"><b>当前场景</b><span id="ex-list-n">—</span></div>' +
      '<div class="ex-list" id="ex-list"></div>' +
      '</aside>' +
      '</div>' +
      '</main>';
  }

  function mount(root) {
    if (!root) return;
    var points = prep();
    var state = {
      layout: 'stage', methods: new Set(MKEYS), diffs: new Set(DIFFS),
      stage: null, brush: null, hover: null
    };
    var listEl = root.querySelector('#ex-list');
    var countEl = root.querySelector('#ex-count');
    var listN = root.querySelector('#ex-list-n');
    var plotTitle = root.querySelector('#ex-plot-title');
    var stagesEl = root.querySelector('#ex-stages');
    var heatEl = root.querySelector('#ex-heat');
    var autoTimer = null, autoIdx = 0;

    var chart = new Chart(root.querySelector('#ex-chart'), {
      brush: true,
      layout: 'stage',
      points: points,
      onPoint: function (id) { location.hash = '#/scene/' + id; },
      onBrush: function (ids) { state.brush = ids && ids.length ? new Set(ids) : null; apply(); },
      onHover: function (id) {
        var p = id ? points.filter(function (x) { return x.id === id; })[0] : null;
        state.hover = p ? { type: 'stage', id: p.stageId } : null;
        apply();
      },
      onLayout: function (k) {
        plotTitle.textContent = LAY[k].name + (k === 'difficulty' ? ' · 数据源' : k === 'coverage' ? ' · 案例' : ' · 技术难度');
      }
    });

    function matches(p) {
      if (!p.methods.some(function (m) { return state.methods.has(m); })) return false;
      if (!state.diffs.has(p.diff)) return false;
      if (state.stage && p.stageId !== state.stage) return false;
      if (state.brush && !state.brush.has(p.id)) return false;
      return true;
    }

    function stopAuto() {
      if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
      var b = root.querySelector('#ex-play');
      if (b) { b.textContent = '自动重排'; b.classList.remove('on'); }
    }

    function setLayout(k, fromAuto) {
      if (!fromAuto) stopAuto();
      state.layout = k;
      [].forEach.call(root.querySelectorAll('.ex-lay'), function (b) { b.classList.toggle('on', b.dataset.layout === k); });
      chart.setLayout(k);
    }

    function apply() {
      var vis = points.filter(matches);
      chart.setFilter(matches, state.hover, state.brush);
      countEl.textContent = vis.length + ' / ' + points.length + (state.brush ? ' · 框选 ' + state.brush.size : '');
      listN.textContent = vis.length + ' 个';
      /* 环节行：显示当前可见数量 */
      [].forEach.call(stagesEl.querySelectorAll('.ex-stage'), function (row) {
        var id = row.dataset.stage;
        var n = vis.filter(function (p) { return p.stageId === id; }).length;
        var c = row.querySelector('[data-count]');
        if (c) c.textContent = n;
        row.classList.toggle('on', state.stage === id);
        row.classList.toggle('zero', n === 0);
      });
      /* 热图：选中态 */
      [].forEach.call(heatEl.querySelectorAll('.ex-cell'), function (c) {
        c.classList.toggle('on', state.stage === c.dataset.stage && state.methods.size === 1 && state.methods.has(c.dataset.method));
      });
      renderList(vis);
    }

    function renderStages() {
      var counts = A.countByStageMethod ? A.countByStageMethod() : {};
      stagesEl.innerHTML = (A.stages || []).map(function (st) {
        var c = counts[st.id] || {};
        var keys = MKEYS.filter(function (k) { return c[k] > 0; });
        var bar = keys.map(function (k) {
          return '<i style="flex:' + c[k] + ';background:' + colorOf(k) + '"></i>';
        }).join('');
        return '<button class="ex-stage" type="button" data-stage="' + st.id + '">' +
          '<span class="ex-stage-no">' + (st.idx < 10 ? '0' : '') + st.idx + '</span>' +
          '<span class="ex-stage-main"><span class="ex-stage-nm">' + esc(st.name) + '</span>' +
          '<span class="ex-stage-bar">' + (bar || '<i style="flex:1;background:var(--paper-3)"></i>') + '</span></span>' +
          '<span class="ex-stage-n" data-count>' + st.scenes.length + '</span></button>';
      }).join('');
      [].forEach.call(stagesEl.querySelectorAll('.ex-stage'), function (b) {
        b.addEventListener('click', function () {
          stopAuto();
          var id = b.dataset.stage;
          state.stage = state.stage === id ? null : id;
          apply();
        });
        b.addEventListener('mouseenter', function () { state.hover = { type: 'stage', id: b.dataset.stage }; apply(); });
        b.addEventListener('mouseleave', function () { state.hover = null; apply(); });
      });
    }

    function renderHeat() {
      var counts = A.countByStageMethod ? A.countByStageMethod() : {};
      var head = '<tr><th></th>' + MKEYS.map(function (k) { return '<th>' + esc(M[k].abbr) + '</th>'; }).join('') + '</tr>';
      var body = (A.stages || []).map(function (st) {
        var c = counts[st.id] || {};
        return '<tr><th>' + esc(st.name) + '</th>' + MKEYS.map(function (k) {
          var n = c[k] || 0;
          var op = n ? (0.10 + Math.min(0.42, n * 0.09)).toFixed(2) : '0';
          return '<td><button class="ex-cell" type="button" data-stage="' + st.id + '" data-method="' + k + '"' +
            ' style="background:rgba(18,59,58,' + op + ')" title="' + esc(st.name) + ' · ' + esc(M[k].name) + '：' + n + ' 个场景">' +
            (n || '·') + '</button></td>';
        }).join('') + '</tr>';
      }).join('');
      heatEl.innerHTML = '<table class="ex-heattable"><thead>' + head + '</thead><tbody>' + body + '</tbody></table>';
      [].forEach.call(heatEl.querySelectorAll('.ex-cell'), function (b) {
        b.addEventListener('click', function () {
          stopAuto();
          var st = b.dataset.stage, m = b.dataset.method;
          var same = state.stage === st && state.methods.size === 1 && state.methods.has(m);
          if (same) { state.stage = null; state.methods = new Set(MKEYS); }
          else { state.stage = st; state.methods = new Set([m]); }
          syncChips();
          apply();
        });
        b.addEventListener('mouseenter', function () {
          state.hover = { type: 'cell', stage: b.dataset.stage, method: b.dataset.method };
          apply();
        });
        b.addEventListener('mouseleave', function () { state.hover = null; apply(); });
      });
    }

    function syncChips() {
      [].forEach.call(root.querySelectorAll('.ex-chip[data-m]'), function (b) {
        b.classList.toggle('on', state.methods.has(b.dataset.m));
      });
      [].forEach.call(root.querySelectorAll('.ex-chip[data-d]'), function (b) {
        b.classList.toggle('on', state.diffs.has(b.dataset.d));
      });
    }

    function renderList(vis) {
      if (!vis.length) {
        listEl.innerHTML = '<div class="ex-empty">没有匹配的场景。松开一个筛选，或在图上重新框选。</div>';
        return;
      }
      var sorted = vis.slice().sort(function (a, b) { return a.stageIdx - b.stageIdx || a.diffRank - b.diffRank; });
      var shown = sorted.slice(0, 12);
      listEl.innerHTML = shown.map(function (p) {
        return '<a class="ex-item" href="#/scene/' + esc(p.id) + '">' +
          '<span><span class="ex-item-nm">' + esc(p.name) + '</span>' +
          '<span class="ex-item-meta">' + esc(p.stageName) + ' · ' + esc(p.diff) + ' · ' +
          p.methods.map(function (m) { return esc(M[m] ? M[m].abbr : m); }).join(' / ') + '</span></span>' +
          '<span class="ex-item-r">' + (p.caseN ? '<b class="ex-item-case">案例</b>' : '<span>' + p.dataN + ' 源</span>') + '</span></a>';
      }).join('') + (sorted.length > shown.length ? '<div class="ex-more">还有 ' + (sorted.length - shown.length) + ' 个，缩小筛选后可见</div>' : '');
    }

    /* 顶部筛选 */
    [].forEach.call(root.querySelectorAll('.ex-chip[data-m]'), function (b) {
      b.addEventListener('click', function () {
        stopAuto();
        var m = b.dataset.m;
        if (state.methods.has(m)) state.methods.delete(m); else state.methods.add(m);
        syncChips(); apply();
      });
      b.addEventListener('mouseenter', function () { state.hover = { type: 'method', id: b.dataset.m }; apply(); });
      b.addEventListener('mouseleave', function () { state.hover = null; apply(); });
    });
    [].forEach.call(root.querySelectorAll('.ex-chip[data-d]'), function (b) {
      b.addEventListener('click', function () {
        stopAuto();
        var d = b.dataset.d;
        if (state.diffs.has(d)) state.diffs.delete(d); else state.diffs.add(d);
        syncChips(); apply();
      });
    });
    [].forEach.call(root.querySelectorAll('.ex-lay'), function (b) {
      b.addEventListener('click', function () { setLayout(b.dataset.layout, false); });
    });
    var play = root.querySelector('#ex-play');
    if (play) play.addEventListener('click', function () {
      if (autoTimer) { stopAuto(); return; }
      play.classList.add('on'); play.textContent = '暂停重排';
      autoIdx = LAY_ORDER.indexOf(state.layout);
      autoTimer = setInterval(function () {
        autoIdx = (autoIdx + 1) % LAY_ORDER.length;
        setLayout(LAY_ORDER[autoIdx], true);
      }, 2800);
    });
    var clear = root.querySelector('#ex-clear');
    if (clear) clear.addEventListener('click', function () {
      stopAuto();
      state.methods = new Set(MKEYS); state.diffs = new Set(DIFFS);
      state.stage = null; state.brush = null; state.hover = null;
      chart.clearBrush(); syncChips(); apply();
    });

    renderStages(); renderHeat(); syncChips(); apply();
    window.__EXPLORE__ = { state: state, points: points, chart: chart };
  }

  /* ---------------- 首页 mini ---------------- */
  function mountMini(host) {
    if (!host || host.__exMini) return;
    host.__exMini = 1;
    var points = prep();
    host.innerHTML = '<div class="ex-mini-bar">' +
      '<div class="ex-mini-tabs">' + LAY_ORDER.map(function (k, i) {
        return '<button type="button" class="ex-mini-tab' + (i === 0 ? ' on' : '') + '" data-layout="' + k + '">' + LAY[k].name + '</button>';
      }).join('') + '</div>' +
      '<span class="ex-mini-cnt">' + points.length + ' 个场景</span>' +
      '<a class="ex-mini-link" href="#/explore">打开联动分析台 →</a></div>' +
      '<div class="ex-mini-chart"></div>' +
      '<div class="ex-mini-legend"><span><i style="background:#123b3a"></i>CV</span><span><i style="background:#a86a1f"></i>TS</span><span><i style="background:#4f6066"></i>NLP</span><span><i style="background:#2b5570"></i>OPT</span><span><i style="background:#6f6636"></i>KG</span><span>点大小 = 数据源数量 · 铜环 = 已有案例</span></div>';
    var chart = new Chart(host.querySelector('.ex-mini-chart'), {
      mini: true, layout: 'stage', points: points, brush: false,
      onPoint: function (id) { location.hash = '#/scene/' + id; }
    });
    [].forEach.call(host.querySelectorAll('.ex-mini-tab'), function (b) {
      b.addEventListener('click', function () {
        [].forEach.call(host.querySelectorAll('.ex-mini-tab'), function (x) { x.classList.toggle('on', x === b); });
        chart.setLayout(b.dataset.layout);
      });
    });
  }

  global.Explore = { pageHTML: pageHTML, mount: mount, mountMini: mountMini };
})(window);
