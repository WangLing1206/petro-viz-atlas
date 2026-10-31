/* =========================================================
   案例 01 的可运行示范 · 测井曲线智能分层
   ---------------------------------------------------------
   纯前端，无依赖：
     合成井曲线（已知真实界面）→ 最优分段（DP + 惩罚项）→ 容差匹配打分
   对外只暴露 window.WelllogLayerDemo(root, ctx)

   本示范只覆盖真实流程中的一个子集：
     DP 最优分段 + 最小层厚约束 + 容差打分
   不含滑窗特征、1D U-Net、层序/邻井规则后处理。
   ========================================================= */

(function () {
  'use strict';

  /* ---------- 常量 ---------- */
  var N = 640;          // 采样点数
  var STEP = 0.125;     // m / 点
  var TOP = 2000;       // 井段顶深 m
  var MINSEG = 8;       // 最小层厚 1 m = 8 点（硬约束）
  var TOL = 4;          // 容差 ±0.5 m = 4 点（与内容页“≤0.5 m”一致）
  var GRMAX = 150;      // GR 轴上限，API

  /* 浅色配色：所有色值与 tokens.css 保持一致 */
  var C = {
    curve: '#2f3a3f',
    grid: '#eeeae0',
    gridSoft: '#f4f1e9',
    text: '#79828a',
    textDim: '#9ba3a9',
    truth: '#3f6b6a',
    det: '#a9742c',
    hover: '#b9c0c5',
    thin: '#f0e0c8'
  };

  /* 单曲线 GR 推测，仅作示意；阈值按区块标定，本示范固定 */
  var LITH = [
    { max: 45, name: '砂岩', color: '#b98b4e' },
    { max: 70, name: '粉砂岩', color: '#a3855f' },
    { max: 100, name: '泥岩', color: '#6b89a3' },
    { max: 999, name: '富有机质泥岩', color: '#8878ab' }
  ];
  function lithOf(v) {
    for (var i = 0; i < LITH.length; i++) if (v < LITH[i].max) return LITH[i];
    return LITH[3];
  }

  /* ---------- 随机数 ---------- */
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  /* ---------- 合成井 ---------- */
  function makeWell(seed, nLayers, noise) {
    var rnd = mulberry32(seed);
    var gauss = function () {
      var u = 0, v = 0;
      while (u === 0) u = rnd();
      while (v === 0) v = rnd();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };

    var raw = [], i, sum = 0;
    for (i = 0; i < nLayers; i++) { var w = 0.7 + rnd() * 1.5; raw.push(w); sum += w; }
    var th = [], remaining = N;
    for (i = 0; i < nLayers; i++) {
      var v;
      if (i === nLayers - 1) { v = remaining; }
      else {
        var maxAllowed = remaining - 30 * (nLayers - i - 1);
        v = Math.round(raw[i] / sum * N);
        v = Math.min(Math.max(v, 30), Math.max(30, maxAllowed));
      }
      th.push(v); remaining -= v;
    }

    /* 埋一个 0.625—0.875 m 的薄层：厚度从邻层借，层数不变 */
    if (nLayers >= 7 && rnd() < 0.8) {
      var j0 = 1 + Math.floor(rnd() * (nLayers - 3));
      for (var t2 = 0; t2 < nLayers; t2++) {
        var c2 = 1 + ((j0 - 1 + t2) % (nLayers - 2));
        if (th[c2] >= 46) {
          var thin = 5 + Math.floor(rnd() * 3);
          var move = th[c2] - thin;
          th[c2] = thin;
          th[c2 - 1] += move;
          break;
        }
      }
    }

    var valsByLayer = [], prev = 60 + rnd() * 40;
    for (i = 0; i < nLayers; i++) {
      var vv = 24 + rnd() * 106;
      if (Math.abs(vv - prev) < 10) vv = prev + (vv > prev ? 1 : -1) * (10 + rnd() * 8);
      vv = Math.min(136, Math.max(20, vv));
      valsByLayer.push(vv); prev = vv;
    }

    var cut = [], acc = 0;
    for (i = 0; i < nLayers; i++) { cut.push(acc); acc += th[i]; }
    var step = new Float64Array(N);
    for (i = 0; i < N; i++) {
      var li = 0;
      for (var j = 0; j < nLayers; j++) if (i >= cut[j]) li = j;
      step[i] = valsByLayer[li];
    }

    /* 仪器响应：3 点核平滑，制造约 2 个采样点的过渡带 */
    var sm = new Float64Array(N);
    for (i = 0; i < N; i++) {
      var s = 0, wsum = 0;
      for (var q = -1; q <= 1; q++) {
        var idx = i + q;
        if (idx >= 0 && idx < N) { s += step[idx] * (2 - Math.abs(q)); wsum += (2 - Math.abs(q)); }
      }
      sm[i] = s / wsum;
    }
    step = sm;

    var x = new Float64Array(N);
    for (i = 0; i < N; i++) x[i] = step[i] + gauss() * noise;

    return { x: x, cut: cut.slice(1), layers: th, vals: valsByLayer };
  }

  /* ---------- 最优分段（动态规划 + 惩罚项）---------- */
  function segment(x, beta) {
    var n = x.length, i, t, s;
    var cs = new Float64Array(n + 1), cs2 = new Float64Array(n + 1);
    for (i = 0; i < n; i++) { cs[i + 1] = cs[i] + x[i]; cs2[i + 1] = cs2[i] + x[i] * x[i]; }
    function cost(a, b) {
      var m = b - a; if (m <= 0) return 0;
      var sum = cs[b] - cs[a];
      return cs2[b] - cs2[a] - sum * sum / m;
    }
    var F = new Float64Array(n + 1), prev = new Int32Array(n + 1);
    F[0] = 0; prev[0] = 0;
    for (t = 1; t <= n; t++) {
      var best = cost(0, t), bp = 0;
      if (t > MINSEG * 2) {
        for (s = MINSEG; s <= t - MINSEG; s++) {
          var v = F[s] + cost(s, t) + beta;
          if (v < best) { best = v; bp = s; }
        }
      }
      F[t] = best; prev[t] = bp;
    }
    var bounds = [], cur = n;
    while (cur > 0) {
      var p = prev[cur];
      if (p <= 0) break;
      bounds.push(p); cur = p;
    }
    return bounds.reverse();
  }

  /* ---------- 稳健噪声估计 ---------- */
  function sigmaHat(x) {
    var d = [], i;
    for (i = 1; i < x.length; i++) d.push(Math.abs(x[i] - x[i - 1]));
    d.sort(function (a, b) { return a - b; });
    var med = d[Math.floor(d.length / 2)];
    return Math.max(0.8, med / 0.6745 / Math.SQRT2);
  }

  /* ---------- 容差匹配打分 ---------- */
  function score(det, tru) {
    var used = tru.map(function () { return false; });
    var tp = 0, errSum = 0;
    det.forEach(function (d) {
      var bi = -1, bd = 1e9;
      tru.forEach(function (t, i) {
        if (!used[i]) { var df = Math.abs(t - d); if (df < bd) { bd = df; bi = i; } }
      });
      if (bi >= 0 && bd <= TOL) { used[bi] = true; tp++; errSum += bd; }
    });
    var fp = det.length - tp;
    var fn = tru.filter(function (t, i) { return !used[i]; }).length;
    var pDen = tp + fp, rDen = tp + fn;
    var p = pDen ? tp / pDen : 0;
    var r = rDen ? tp / rDen : 0;
    var f1 = (p + r) ? 2 * p * r / (p + r) : 0;
    /* F2：β=2，召回权重是精确率的 4 倍 */
    var f2 = (4 * p + r) ? 5 * p * r / (4 * p + r) : 0;
    return {
      tp: tp, fp: fp, fn: fn, p: p, r: r, f1: f1, f2: f2,
      mae: tp ? errSum * STEP / tp : 0,
      matchedTrue: used, pDen: pDen, rDen: rDen
    };
  }

  function mean(a, b, x) { var s = 0; for (var i = a; i < b; i++) s += x[i]; return s / (b - a); }

  /* =========================================================
     主渲染
     ========================================================= */
  function WelllogLayerDemo(root) {
    var state = { seed: 20261022, layers: 10, noise: 8, beta: 3, showTrue: true };
    var well, sig, det, sc, fitData = [];
    var rafId = 0, timerId = 0;

    root.innerHTML = '' +
      '<style>#c-true:focus-visible + i{outline:2px solid var(--jade);outline-offset:2px;border-radius:9px}</style>' +
      '<div class="demo">' +
      '<div class="demo-head">' +
      '<div><span class="kicker">INTERACTIVE · 最优分段（DP 子集）</span>' +
      '<h3 style="margin-top:8px">把一条 GR 曲线切成地质单元</h3>' +
      '<p>这是一口程序合成的井：真实层界面已知，所以能给算法精确打分。本示范只演示流程中的<b>最优分段（DP + β 惩罚）+ 最小层厚 1 m 约束</b>这一子集，不含滑窗特征、1D U-Net 与层序规则。拖动 β 改变“每增加一个界面要付出的代价”，看它怎么从过分割滑到欠分割。</p>' +
      '<p style="font-size:10.5px;color:var(--ink-4)">合成井会故意埋入 <b>0.63—0.88 m</b> 薄层（默认井即有一层），小于最小层厚 <b>1 m</b>：DP 无法按真实厚度切出该层，通常会被合并。图中黄色标出的是<b>最小层厚规则导致的漏检</b>，不是算法“发现”了薄层。</p></div>' +
      '<button class="btn primary" type="button" data-act="new">换一口井 ↻</button>' +
      '</div>' +

      '<div class="demo-ctl">' +
      '<div class="ctl"><label for="c-noise">噪声 σ</label><input type="range" min="2" max="24" step="1" value="8" id="c-noise" aria-label="噪声标准差（API）"><span class="val" id="v-noise">8</span></div>' +
      '<div class="ctl"><label for="c-layers">真实层数</label><input type="range" min="5" max="14" step="1" value="10" id="c-layers" aria-label="真实层数"><span class="val" id="v-layers">10</span></div>' +
      '<div class="ctl"><label for="c-beta">惩罚 β</label><input type="range" min="0.2" max="12" step="0.1" value="3" id="c-beta" aria-label="惩罚系数 beta"><span class="val" id="v-beta">3.0</span></div>' +
      '<label class="ctl tog on" for="c-true"><input type="checkbox" id="c-true" checked style="position:absolute;width:1px;height:1px;opacity:0"><i></i>显示真实界面</label>' +
      '<div class="ctl"><label for="c-seed">种子</label><input id="c-seed" type="number" min="1" step="1" value="20261022" style="width:88px;font-family:var(--mono);font-size:10.5px;padding:4px 6px;border:1px solid var(--line-2);border-radius:5px;background:var(--card);color:var(--ink-2)"><button type="button" class="btn sm" data-act="copy">复制</button></div>' +
      '</div>' +

      '<div class="demo-grid">' +
      '<div class="track-wrap"><div class="track">' +
      '<svg id="logsvg" viewBox="0 0 462 620" role="img" aria-label="GR 曲线与分层结果"></svg>' +
      '</div>' +
      '<div id="readout" style="margin-top:8px;padding:6px 9px;border:1px solid var(--line-2);border-radius:5px;background:var(--card-soft);font-family:var(--mono);font-size:10px;color:var(--ink-2);min-height:27px;line-height:1.5">在曲线上移动或点选查看读数（GR 单位：API）</div>' +
      '<div class="track-legend">' +
      '<span><i style="background:' + C.curve + '"></i>GR 曲线</span>' +
      '<span><i style="background:' + C.det + '"></i>检出界面</span>' +
      '<span><i class="dash"></i>真实界面</span>' +
      '<span><i style="background:' + C.thin + ';height:8px;width:11px;border-radius:2px"></i>薄层告警（&lt;1 m 被最小层厚合并）</span>' +
      '</div>' +
      '<div class="lith-legend" style="display:flex;flex-wrap:wrap;gap:6px 12px;margin-top:8px;padding-top:8px;border-top:1px solid var(--line);font-size:9.5px;color:var(--ink-4)">' +
      '<span style="flex-basis:100%">岩性（<b>GR 单曲线推测，示意</b>；阈值 45 / 70 / 100 API，按区块标定，本示范固定）：</span>' +
      LITH.map(function (l) {
        return '<span style="display:flex;align-items:center;gap:5px"><i style="width:9px;height:9px;border-radius:2px;background:' + l.color + ';display:block"></i>' + l.name + '</span>';
      }).join('') +
      '</div>' +
      '</div>' +

      '<div class="demo-side">' +
      '<div class="metrics" id="metrics"></div>' +
      '<div id="tolnote" style="font-size:10.5px;color:var(--ink-4);line-height:1.65"></div>' +
      '<div class="verdict" id="verdict"></div>' +
      '<div class="fitbox"><div class="ft"><span>F1 vs 惩罚系数 β（y 轴 0—1）</span><span id="fit-note"></span></div>' +
      '<svg id="fitsvg" viewBox="0 0 360 120"></svg></div>' +
      '<div class="hintbox"><b>最小层厚 1 m（8 点）是硬约束</b>：厚度小于它的层无法被独立切出，这是本示范的明确设定，不是算法缺陷。β 太小 → 噪声波动被当界面（过分割）；β 太大 → 真实薄层被合并（欠分割）。<b>漏检 FN 的代价高于多检 FP</b>：漏一个界面要人工重扫整段，多一个候选只需点一下删除，所以这里用 F2（召回优先）辅助判断。' +
      '</div></div></div>' +

      '<div class="ltable-wrap"><table class="ltable" id="ltable"></table></div>' +
      '</div>';

    var svg = root.querySelector('#logsvg');
    var fitSvg = root.querySelector('#fitsvg');
    var readout = root.querySelector('#readout');
    var metricsEl = root.querySelector('#metrics');
    var tolEl = root.querySelector('#tolnote');
    var verdictEl = root.querySelector('#verdict');
    var tableEl = root.querySelector('#ltable');

    /* ------- 几何 ------- */
    var W = 462, H = 620, padL = 58, padT = 24, padB = 26, pw = 330, ph = H - padT - padB;
    function X(v) { return padL + Math.max(0, Math.min(v, GRMAX)) / GRMAX * pw; }
    function Y(i) { return padT + i / (N - 1) * ph; }

    /* ------- 真实层区间（含厚度），用于薄层告警 ------- */
    function trueLayers() {
      var edges = [0].concat(well.cut).concat([N]);
      var out = [];
      for (var i = 0; i < edges.length - 1; i++) {
        out.push({ a: edges[i], b: edges[i + 1], thick: (edges[i + 1] - edges[i]) * STEP });
      }
      return out;
    }

    /* 薄层必须由两个“不同”的检出界面分别靠近 a、b，才算独立成层。
       旧逻辑只要 b 附近有一个界面就误判为已检出。 */
    function thinDetected(L) {
      var ai = -1;
      for (var i = 0; i < det.length; i++) if (Math.abs(det[i] - L.a) <= TOL) { ai = i; break; }
      if (ai < 0) return false;
      for (var j = 0; j < det.length; j++) if (j !== ai && Math.abs(det[j] - L.b) <= TOL) return true;
      return false;
    }

    /* ------- 计算 ------- */
    function recompute(full) {
      well = makeWell(state.seed, state.layers, state.noise);
      sig = sigmaHat(well.x);
      det = segment(well.x, state.beta * sig * sig * Math.log(N));
      sc = score(det, well.cut);
      if (full) buildFit();
    }

    function betaOf(k) { return k * sig * sig * Math.log(N); }

    function buildFit() {
      fitData = [];
      for (var k = 0.2; k <= 12.01; k += 0.4) {
        var b = segment(well.x, betaOf(k));
        fitData.push({ k: k, f1: score(b, well.cut).f1 });
      }
    }

    /* ------- 主图 ------- */
    function drawTrack() {
      var s = '';
      s += '<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="#ffffff"/>';

      for (var d = 0; d <= 80; d += 10) {
        var yy = padT + d / 80 * ph;
        s += '<line x1="' + padL + '" y1="' + yy + '" x2="' + (padL + pw) + '" y2="' + yy + '" stroke="' + C.grid + '"/>';
        s += '<text x="44" y="' + (yy + 3.5) + '" fill="' + C.textDim + '" font-size="9" font-family="monospace" text-anchor="end">' + (TOP + d) + '</text>';
      }
      [0, 50, 100, 150].forEach(function (v) {
        var xx = X(v);
        s += '<line x1="' + xx + '" y1="' + padT + '" x2="' + xx + '" y2="' + (padT + ph) + '" stroke="' + C.gridSoft + '"/>';
        s += '<text x="' + xx + '" y="' + (padT + ph + 15) + '" fill="' + C.textDim + '" font-size="9" font-family="monospace" text-anchor="middle">' + v + '</text>';
      });
      s += '<text x="' + (padL + pw) + '" y="' + (padT + ph + 15) + '" fill="' + C.textDim + '" font-size="8.5" font-family="monospace" text-anchor="end">API</text>';
      s += '<text x="6" y="' + (padT - 10) + '" fill="' + C.text + '" font-size="9" font-family="monospace">深度(m)</text>';
      s += '<text x="' + padL + '" y="14" fill="' + C.text + '" font-size="9" font-family="monospace">GR (API)</text>';

      // 检出层段：底色 + 左侧色条（色条移到 50—53，避开深度刻度）
      var starts = [0].concat(det).concat([N]);
      for (var i = 0; i < starts.length - 1; i++) {
        var a = starts[i], b = starts[i + 1];
        var m = mean(a, b, well.x), li = lithOf(m);
        var y0 = Y(a), y1 = Y(b - 1) + (Y(1) - Y(0));
        s += '<rect x="' + padL + '" y="' + y0.toFixed(1) + '" width="' + pw + '" height="' + Math.max(1, y1 - y0).toFixed(1) + '" fill="' + li.color + '" opacity="0.10"/>';
        s += '<rect x="50" y="' + y0.toFixed(1) + '" width="3" height="' + Math.max(1, y1 - y0).toFixed(1) + '" rx="1.5" fill="' + li.color + '" opacity="0.75"/>';
      }

      // 薄层告警：真实厚度 < 1 m 且没有被两个独立界面分开
      trueLayers().forEach(function (L) {
        if (L.thick >= 1.0) return;
        if (thinDetected(L)) return;
        var y0 = Y(L.a), y1 = Y(L.b - 1) + (Y(1) - Y(0));
        s += '<rect x="' + padL + '" y="' + y0.toFixed(1) + '" width="' + pw + '" height="' + Math.max(2, y1 - y0).toFixed(1) + '" fill="' + C.thin + '" opacity=".55"/>';
        var my = (y0 + y1) / 2;
        s += '<line x1="' + (padL + pw + 6) + '" y1="' + my + '" x2="' + (padL + pw + 16) + '" y2="' + my + '" stroke="' + C.det + '" stroke-width="1"/>';
        s += '<text x="' + (padL + pw + 19) + '" y="' + (my + 3) + '" fill="' + C.det + '" font-size="8" font-family="monospace">' + L.thick.toFixed(2) + 'm 漏检</text>';
      });

      // 真实界面（薄层处两个标签很接近，自动避让）
      if (state.showTrue) {
        var prevLabelY = -999;
        well.cut.forEach(function (c) {
          var yy = Y(c);
          s += '<line x1="' + padL + '" y1="' + yy + '" x2="' + (padL + pw) + '" y2="' + yy + '" stroke="' + C.truth + '" stroke-width="1" stroke-dasharray="4 5" opacity="0.65"/>';
          var ly = yy - 3, lx = padL + pw - 2, anchor = 'end';
          if (ly - prevLabelY < 9) { lx = padL + 2; anchor = 'start'; ly = yy + 9; }
          s += '<text x="' + lx + '" y="' + ly + '" fill="' + C.truth + '" font-size="8" font-family="monospace" text-anchor="' + anchor + '" opacity="0.85">真 ' + (TOP + c * STEP).toFixed(2) + '</text>';
          prevLabelY = ly;
        });
      }

      // 曲线（X 双端 clamp 0—150，σ=24 时也不会越界）
      var path = '';
      for (var p = 0; p < N; p++) path += (p ? 'L' : 'M') + X(well.x[p]).toFixed(1) + ' ' + Y(p).toFixed(1);
      s += '<path d="' + path + '" fill="none" stroke="' + C.curve + '" stroke-width="1.15" stroke-linejoin="round"/>';

      // 检出界面（标签过密时只画线，不叠字）
      var prevDetY = -999;
      det.forEach(function (c) {
        var yy = Y(c);
        s += '<line x1="' + padL + '" y1="' + yy + '" x2="' + (padL + pw + 4) + '" y2="' + yy + '" stroke="' + C.det + '" stroke-width="1.2"/>';
        s += '<path d="M' + (padL + pw + 4) + ' ' + yy + ' l5 -3 l0 6 z" fill="' + C.det + '"/>';
        if (yy - prevDetY >= 9) {
          s += '<text x="' + (padL + pw + 12) + '" y="' + (yy + 3) + '" fill="' + C.det + '" font-size="8.5" font-family="monospace">' + (TOP + c * STEP).toFixed(2) + '</text>';
          prevDetY = yy;
        }
      });

      s += '<line id="xh" x1="' + padL + '" y1="0" x2="' + (padL + pw) + '" y2="0" stroke="' + C.hover + '" stroke-dasharray="3 3" style="display:none"/>';
      s += '<rect id="hit" x="' + padL + '" y="' + padT + '" width="' + pw + '" height="' + ph + '" fill="transparent" style="cursor:crosshair;touch-action:pan-y"/>';

      svg.innerHTML = s;

      var hit = svg.querySelector('#hit'), xh = svg.querySelector('#xh');
      function readAt(clientY) {
        var r = svg.getBoundingClientRect();
        var sy = (clientY - r.top) / r.height * H;
        var idx = Math.round((sy - padT) / ph * (N - 1));
        if (idx < 0 || idx >= N) { xh.style.display = 'none'; return; }
        var yy = Y(idx);
        xh.setAttribute('y1', yy); xh.setAttribute('y2', yy);
        xh.style.display = '';
        var s2 = [0].concat(det).concat([N]), li2 = 0;
        for (var q = 0; q < s2.length - 1; q++) if (idx >= s2[q] && idx < s2[q + 1]) li2 = q;
        var lito = lithOf(mean(s2[li2], s2[li2 + 1], well.x));
        var raw = well.x[idx];
        var grTxt = raw.toFixed(0) + (raw < 0 || raw > GRMAX ? '（轴上截断）' : '');
        readout.textContent = '深度 ' + (TOP + idx * STEP).toFixed(2) + ' m · GR ' + grTxt +
          ' API · 岩性（GR 推测）' + lito.name;
      }
      hit.addEventListener('pointermove', function (e) { readAt(e.clientY); });
      hit.addEventListener('pointerdown', function (e) { readAt(e.clientY); });
      hit.addEventListener('pointerleave', function () { xh.style.display = 'none'; });
    }

    /* ------- 指标 ------- */
    function drawMetrics() {
      var has = det.length > 0;
      function fmt(v, den) { return (has && den) ? v.toFixed(2) : '—'; }
      var cls = (has && sc.f2 >= 0.85) ? 'good' : (has && sc.f2 >= 0.6) ? 'warn' : 'bad';
      metricsEl.innerHTML =
        '<div class="metric ' + cls + '"><div class="l">F1</div><div class="v">' + fmt(sc.f1, 1) + '</div></div>' +
        '<div class="metric ' + cls + '"><div class="l">F2 · 召回优先</div><div class="v">' + fmt(sc.f2, 1) + '</div></div>' +
        '<div class="metric"><div class="l">召回 R</div><div class="v">' + fmt(sc.r, sc.rDen) + '<small>' + sc.tp + '/' + sc.rDen + '</small></div></div>' +
        '<div class="metric"><div class="l">精确 P</div><div class="v">' + fmt(sc.p, sc.pDen) + '<small>' + sc.tp + '/' + sc.pDen + '</small></div></div>';

      var hitRate = sc.rDen ? (sc.tp / sc.rDen * 100).toFixed(0) + '%' : '—';
      tolEl.innerHTML = '容差 <b>±0.5 m</b>（4 采样点）：<b>≤0.5 m 命中率 ' + hitRate + '</b>（' + sc.tp + '/' + sc.rDen + '）' +
        ' · 平均偏差 ' + (sc.tp ? sc.mae.toFixed(2) + ' m' : '—') +
        ' · 漏检 <b>' + sc.fn + '</b> 处 · 多检 ' + sc.fp + ' 处';

      var nn = det.length + 1, nt = well.cut.length + 1;
      var msg;
      if (!det.length) {
        msg = '未检出任何界面：β 过大或曲线过于平缓。';
      } else if (sc.f2 >= 0.85 && sc.r >= 0.9) {
        msg = '界面基本对齐：层数 ' + nn + ' vs 真实 ' + nt + '，F1 = ' + sc.f1.toFixed(2) + '、F2 = ' + sc.f2.toFixed(2) + '，可以直接进入人工复核。';
      } else if (nn > nt + 1) {
        msg = '当前 <b>过分割</b>：切出 ' + nn + ' 个层，真实只有 ' + nt + ' 个。β 偏小，噪声波动被当成了界面。';
      } else if (nn < nt - 1) {
        msg = '当前 <b>欠分割</b>：只切出 ' + nn + ' 个层，真实有 ' + nt + ' 个。β 偏大或噪声过大，相邻层被合并了。';
      } else {
        msg = '层数接近但位置有偏差：共 ' + nn + ' 层，命中 ' + sc.tp + ' 个界面。';
      }
      msg += ' <b>漏检 ' + sc.fn + ' 处 vs 多检 ' + sc.fp + ' 处</b>：漏检要人工重扫整段，代价高于多检（多一个候选只需点一下删除），因此判断时优先看召回 / F2，而不是只看 F1。';
      if (sc.fn > sc.fp) msg += ' 当前以漏检为主，可降低 β 或放宽最小层厚。';
      else if (sc.fp > sc.fn) msg += ' 当前以多检为主，可提高 β。';
      var thinMiss = trueLayers().filter(function (L) { return L.thick < 1.0 && !thinDetected(L); }).length;
      if (thinMiss) msg += ' 图中黄色 ' + thinMiss + ' 层是 &lt;1 m 薄层，被最小层厚 1 m 规则合并——这是规则性漏检，不是算法“发现”的异常。';
      verdictEl.innerHTML = msg;
    }

    /* ------- 调参曲线 ------- */
    function drawFit() {
      var w = 360, h = 120, m = { l: 30, r: 8, t: 14, b: 20 };
      var ymin = 0, ymax = 1;
      function fx(k) { return m.l + (k - 0.2) / 11.8 * (w - m.l - m.r); }
      function fy(v) { return m.t + (1 - (v - ymin) / (ymax - ymin)) * (h - m.t - m.b); }

      var s = '';
      [0, 0.5, 1].forEach(function (v) {
        s += '<line x1="' + m.l + '" y1="' + fy(v) + '" x2="' + (w - m.r) + '" y2="' + fy(v) + '" stroke="' + C.grid + '"/>';
        s += '<text x="' + (m.l - 5) + '" y="' + (fy(v) + 3) + '" fill="' + C.textDim + '" font-size="8" font-family="monospace" text-anchor="end">' + v.toFixed(1) + '</text>';
      });
      s += '<text x="6" y="9" fill="' + C.textDim + '" font-size="8" font-family="monospace">F1</text>';
      var pts = fitData.map(function (d) { return fx(d.k).toFixed(1) + ',' + fy(d.f1).toFixed(1); }).join(' ');
      s += '<polyline points="' + pts + '" fill="none" stroke="' + C.truth + '" stroke-width="1.5" opacity="0.85"/>';

      var best = fitData.reduce(function (a, b) { return b.f1 > a.f1 ? b : a; }, fitData[0]);
      s += '<circle cx="' + fx(best.k) + '" cy="' + fy(best.f1) + '" r="2.6" fill="' + C.truth + '"/>';
      var bx = fx(best.k) + 5, banchor = 'start';
      if (Math.abs(best.k - state.beta) < 1.0 || fx(best.k) > w - 72) { bx = fx(best.k) - 5; banchor = 'end'; }
      s += '<text x="' + bx + '" y="' + (fy(best.f1) - 5) + '" fill="' + C.truth + '" font-size="8" font-family="monospace" text-anchor="' + banchor + '">best β=' + best.k.toFixed(1) + '</text>';

      var cx = fx(state.beta);
      s += '<line x1="' + cx + '" y1="' + m.t + '" x2="' + cx + '" y2="' + (h - m.b) + '" stroke="' + C.det + '" stroke-width="1" stroke-dasharray="3 3"/>';
      s += '<circle cx="' + cx + '" cy="' + fy(sc.f1) + '" r="3.2" fill="' + C.det + '"/>';
      var lx = cx + 4, anchor = 'start';
      if (cx > w - 76) { lx = cx - 4; anchor = 'end'; }
      s += '<text x="' + lx + '" y="' + (h - m.b - 6) + '" fill="' + C.det + '" font-size="8" font-family="monospace" text-anchor="' + anchor + '">当前 β=' + state.beta.toFixed(1) + '</text>';

      s += '<text x="' + m.l + '" y="' + (h - 4) + '" fill="' + C.textDim + '" font-size="8" font-family="monospace">β 0.2</text>';
      s += '<text x="' + (w - m.r) + '" y="' + (h - 4) + '" fill="' + C.textDim + '" font-size="8" font-family="monospace" text-anchor="end">12.0</text>';
      fitSvg.innerHTML = s;
      root.querySelector('#fit-note').textContent = fitData.length + ' 次 DP · 当前 β=' + state.beta.toFixed(1) + ' · 峰值 F1=' + best.f1.toFixed(2);
    }

    /* ------- 分层表 ------- */
    function drawTable() {
      var starts = [0].concat(det).concat([N]);
      var rows = '';
      for (var i = 0; i < starts.length - 1; i++) {
        var a = starts[i], b = starts[i + 1];
        var mm = mean(a, b, well.x), li = lithOf(mm);
        var top = TOP + a * STEP, bot = TOP + b * STEP;
        var judge = '—', cls = '';
        if (i === 0) { judge = '井段顶'; }
        else {
          var matched = false;
          well.cut.forEach(function (c, ci) { if (sc.matchedTrue[ci] && Math.abs(c - a) <= TOL) matched = true; });
          judge = matched ? '✓ 命中' : '✗ 多余界面';
          cls = matched ? 'ok' : 'extra';
        }
        rows += '<tr><td>' + (i + 1) + '</td>' +
          '<td>' + top.toFixed(2) + '</td>' +
          '<td>' + bot.toFixed(2) + '</td>' +
          '<td>' + (bot - top).toFixed(2) + '</td>' +
          '<td>' + mm.toFixed(0) + '</td>' +
          '<td class="lith"><span class="swatch" style="background:' + li.color + '"></span>' + li.name + '</td>' +
          '<td class="' + cls + '">' + judge + '</td></tr>';
      }
      var missed = [];
      well.cut.forEach(function (c, ci) { if (!sc.matchedTrue[ci]) missed.push(c); });
      if (missed.length) {
        rows += '<tr><td colspan="7" style="padding-top:12px;color:var(--bad);font-family:var(--sans);font-size:10.5px;letter-spacing:.04em">漏检界面（FN）· 真实界面 ±0.5 m 内没有检出</td></tr>';
        missed.forEach(function (c) {
          rows += '<tr><td>—</td><td>' + (TOP + c * STEP).toFixed(2) + '</td><td>—</td><td>—</td><td>—</td><td>—</td><td class="miss">✗ 漏检界面</td></tr>';
        });
      }
      tableEl.innerHTML = '<thead><tr><th>层</th><th>顶深 (m)</th><th>底深 (m)</th><th>厚度 (m)</th><th>平均 GR</th><th>岩性（GR 推测）</th><th>判定</th></tr></thead><tbody>' + rows + '</tbody>';
    }

    function paint() { drawTrack(); drawMetrics(); drawFit(); drawTable(); }

    /* ------- 事件 ------- */
    var seedInput = root.querySelector('#c-seed');

    root.querySelector('[data-act="new"]').addEventListener('click', function () {
      state.seed = Math.floor(Math.random() * 1e9);
      seedInput.value = state.seed;
      recompute(true); paint();
    });

    root.querySelector('#c-noise').addEventListener('input', function () {
      state.noise = +this.value;
      root.querySelector('#v-noise').textContent = this.value;
      scheduleFull();
    });

    root.querySelector('#c-layers').addEventListener('input', function () {
      state.layers = +this.value;
      root.querySelector('#v-layers').textContent = this.value;
      scheduleFull();
    });

    root.querySelector('#c-beta').addEventListener('input', function () {
      state.beta = +this.value;
      root.querySelector('#v-beta').textContent = (+this.value).toFixed(1);
      if (rafId) return;
      rafId = requestAnimationFrame(function () {
        rafId = 0;
        det = segment(well.x, betaOf(state.beta));
        sc = score(det, well.cut);
        paint();
      });
    });

    var trueBox = root.querySelector('#c-true');
    trueBox.addEventListener('change', function () {
      state.showTrue = trueBox.checked;
      trueBox.closest('label').classList.toggle('on', state.showTrue);
      drawTrack();
    });

    seedInput.addEventListener('change', function () {
      var v = parseInt(seedInput.value, 10);
      if (!isFinite(v) || v < 1) { seedInput.value = state.seed; return; }
      state.seed = v;
      seedInput.value = v;
      recompute(true); paint();
    });

    root.querySelector('[data-act="copy"]').addEventListener('click', function () {
      var btn = this, text = String(state.seed);
      function done() { btn.textContent = '已复制'; setTimeout(function () { btn.textContent = '复制'; }, 1400); }
      function fallback() {
        seedInput.focus(); seedInput.select();
        try { document.execCommand('copy'); done(); } catch (e) { btn.textContent = '请手动复制'; }
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, fallback);
      } else fallback();
    });

    /* 噪声/层数会触发 30 次 DP，拖动时用 60 ms 防抖；β 只用 rAF 重算一次 */
    function scheduleFull() {
      if (timerId) clearTimeout(timerId);
      timerId = setTimeout(function () {
        timerId = 0;
        recompute(true); paint();
      }, 60);
    }

    window.WelllogLayerDemoCleanup = function () {
      if (timerId) { clearTimeout(timerId); timerId = 0; }
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    };

    /* ------- 初始化 ------- */
    recompute(true);
    paint();
  }

  window.WelllogLayerDemo = WelllogLayerDemo;
})();
