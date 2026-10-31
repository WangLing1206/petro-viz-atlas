/* =========================================================
   抽油机井工况诊断 · 可运行示范（v2）
   ---------------------------------------------------------
   ① 参数化生成示功图：上下冲程的载荷曲线由 5 个参数控制
        rod / liquid（杆重与液柱载荷）、fill、leakUp、leakDown
   ② 六个工况 = 六组参数（模板）
   ③ 特征：环面积、上下冲程均载、两侧斜率、去趋势载荷波动
   ④ 分类：特征归一化 + 模板距离 → softmax 概率 → 置信度分级

   井况口径（示范固定值）：泵径 56 mm、泵深 1200 m、冲程 3.0 m、
   冲次 6 min⁻¹；载荷只用于教学对比，不代表某一口真实井。
   ========================================================= */
(function () {
  'use strict';

  var STROKE = 3.0;     // m
  var SPM = 6;          // min^-1

  var CLASSES = [
    { key: 'normal', name: '正常', rod: 20, liquid: 60, leakUp: 0, leakDown: 0, ripple: 0.006, tip: '工况正常，按周期维护即可。' },
    { key: 'starved', name: '供液不足', rod: 20, liquid: 34, leakUp: 0, leakDown: 0.02, ripple: 0.008, tip: '泵充不满：环变矮、面积小。建议核查沉没度与泵径匹配，必要时下调冲次。' },
    { key: 'gas', name: '气锁', rod: 18, liquid: 15, leakUp: 0.16, leakDown: -0.26, ripple: 0.075, tip: '气体占据泵腔：上冲程开始载荷不升、下冲程载荷偏低且换载滞后。建议核实套压、放套管气或加深泵挂。' },
    { key: 'travel', name: '游动阀漏', rod: 20, liquid: 56, leakUp: -0.58, leakDown: 0.03, ripple: 0.006, tip: '游动阀不严：上冲程载荷持续下倾。建议检泵更换阀球与阀座。' },
    { key: 'fixed', name: '固定阀漏', rod: 20, liquid: 56, leakUp: 0.03, leakDown: 0.58, ripple: 0.006, tip: '固定阀不严：下冲程载荷持续回升。建议检泵，同步检查泵筒磨损。' },
    { key: 'break', name: '断脱', rod: 8, liquid: 0, leakUp: 0, leakDown: 0, ripple: 0.004, tip: '抽油杆断脱：载荷极低、环几乎是一条扁线。必须当天处理，避免进一步磨损与落杆。' }
  ];

  /* 结蜡：摩擦阻力在上冲程抬高载荷、下冲程托住杆柱使载荷降低。
     不能用“上冲程抬高 + 下冲程也抬高”去模拟固定阀漏。 */
  var CLSCOL = { normal: '#123b3a', starved: '#a86a1f', gas: '#2b5570', travel: '#6f6636', fixed: '#7a5a3a', break: '#9c4235' };
  var WAX = { lift: 12, up: 0.10, down: -0.18 };

  var state = { cls: 'normal', noise: 0.15, wax: false, pcoord: null };
  var lastF = null;
  var lastPts = null;

  var rnd = (function () { var a = 991; return function () { a = (a * 16807) % 2147483647; return a / 2147483647; }; })();
  function g() { return (rnd() + rnd() + rnd() - 1.5) * 1.2; }

  function ease(s) { return Math.min(1, Math.max(0, s / 0.18)); }

  /* ---------- 生成示功图：位移 0—1（归一化冲程），载荷 kN ---------- */
  function genFault(clsKey, wax, noise) {
    var c = CLASSES.filter(function (x) { return x.key === clsKey; })[0];
    var N = 90, up = [], down = [];
    var rod = c.rod, liq = c.liquid;
    if (wax) { rod += WAX.lift; }
    var Fmin = rod, Fmax = rod + liq, span = Math.max(2, Fmax - Fmin);
    var i, s;
    for (i = 0; i < N; i++) {
      s = i / (N - 1);
      var f = Fmin + span * ease(s);
      f += span * c.leakUp * s;
      if (wax) f += span * WAX.up * s;
      if (c.key === 'gas') f += span * 0.05 * Math.sin(s * Math.PI * 6) * s;
      f += span * c.ripple * g() * 2 + noise * 5.0 * g();
      up.push({ s: s, f: f });
    }
    for (i = N - 1; i >= 0; i--) {
      s = i / (N - 1);
      var f2 = Fmax - span * ease(1 - s);
      f2 += span * c.leakDown * (1 - s);
      if (wax) f2 += span * WAX.down * (1 - s);
      if (c.key === 'gas') f2 += span * 0.05 * Math.sin(s * Math.PI * 5) * (1 - s);
      f2 += span * c.ripple * g() * 2 + noise * 5.0 * g();
      down.push({ s: s, f: f2 });
    }
    return up.concat(down);
  }

  /* ---------- 特征：按固定 100 kN 归一化，避免断脱井“看起来正常” ---------- */
  var SCALE = 100;
  function features(pts) {
    var n = pts.length / 2;
    var up = pts.slice(0, n), down = pts.slice(n);
    var fmin = Math.min.apply(null, pts.map(function (p) { return p.f; }));
    var fmax = Math.max.apply(null, pts.map(function (p) { return p.f; }));
    var upMean = up.reduce(function (a, p) { return a + p.f; }, 0) / n;
    var downMean = down.reduce(function (a, p) { return a + p.f; }, 0) / n;
    var area = 0;
    for (var i = 0; i < n - 1; i++) area += Math.abs(up[i].f - down[n - 1 - i].f) * (1 / (n - 1));
    function slope(arr) {
      var m = arr.length, sx = 0, sy = 0, sxx = 0, sxy = 0;
      arr.forEach(function (p) { sx += p.s; sy += p.f; sxx += p.s * p.s; sxy += p.s * p.f; });
      return (m * sxy - sx * sy) / Math.max(1e-6, m * sxx - sx * sx);
    }
    var mid = Math.floor(n * 0.4);
    /* 去趋势后的高频残差：先做 9 点滑动平均，再算残差 RMS。
       原来的整体方差会被 20→80 kN 的斜坡主导，正常反而大于气锁。 */
    var rip = 0, count = 0;
    for (var j = 4; j < n - 4; j++) {
      var avg = 0;
      for (var k = j - 4; k <= j + 4; k++) avg += up[k].f;
      avg /= 9;
      rip += Math.pow(up[j].f - avg, 2);
      count++;
    }
    return {
      rng: (fmax - fmin) / SCALE,
      area: area / SCALE,
      upMean: upMean / SCALE,
      downMean: downMean / SCALE,
      slopeUp: slope(up.slice(mid)) / SCALE,
      slopeDown: slope(down.slice(mid)) / SCALE,
      ripple: Math.sqrt(rip / Math.max(1, count)) / SCALE
    };
  }

  var TPL = {};
  CLASSES.forEach(function (c) { TPL[c.key] = features(genFault(c.key, false, 0)); });

  var W = { rng: 1.5, area: 1.5, upMean: 1.2, downMean: 1.2, slopeUp: 1.3, slopeDown: 1.3, ripple: 1.0 };
  var RANGE = { rng: 0.18, area: 0.10, upMean: 0.14, downMean: 0.14, slopeUp: 0.22, slopeDown: 0.22, ripple: 0.05 };

  function classify(f) {
    var scores = CLASSES.map(function (c) {
      var t = TPL[c.key], d = 0;
      Object.keys(W).forEach(function (k) {
        var diff = (f[k] - t[k]) / RANGE[k];
        d += W[k] * diff * diff;
      });
      return { key: c.key, name: c.name, d: d };
    });
    var dmin = Math.min.apply(null, scores.map(function (x) { return x.d; }));
    var exps = scores.map(function (x) { return Math.exp(-(x.d - dmin) / 2.4); });
    var sum = exps.reduce(function (a, b) { return a + b; }, 0);
    scores.forEach(function (x, i) { x.p = exps[i] / sum; });
    scores.sort(function (a, b) { return b.p - a.p; });
    return scores;
  }

  var el = function (id) { return document.getElementById(id); };

  /* ---------- 绘图 ---------- */
  var GEO = { W: 420, H: 340, L: 52, R: 18, T: 26, B: 46 };

  function xs(s) { return GEO.L + s * (GEO.W - GEO.L - GEO.R); }
  function ys(f) { return GEO.H - GEO.B - f / 110 * (GEO.H - GEO.T - GEO.B); }

  function pathOf(pts) {
    var d = '';
    pts.forEach(function (p, i) { d += (i ? 'L' : 'M') + xs(p.s).toFixed(1) + ' ' + ys(p.f).toFixed(1); });
    return d;
  }

  function drawDyn(pts, tplKey) {
    var W0 = GEO.W, H0 = GEO.H, L = GEO.L, R = GEO.R, T = GEO.T, B = GEO.B;
    var s = '';
    for (var f = 0; f <= 100; f += 20) {
      s += '<line x1="' + L + '" y1="' + ys(f) + '" x2="' + (W0 - R) + '" y2="' + ys(f) + '" stroke="#f0ede4"/>' +
        '<text x="' + (L - 7) + '" y="' + (ys(f) + 3) + '" font-size="9" fill="#99a3a4" text-anchor="end" font-family="monospace">' + f + '</text>';
    }
    [0, 0.25, 0.5, 0.75, 1].forEach(function (v) {
      s += '<line x1="' + xs(v) + '" y1="' + T + '" x2="' + xs(v) + '" y2="' + (H0 - B) + '" stroke="#f0ede4"/>' +
        '<text x="' + xs(v) + '" y="' + (H0 - B + 14) + '" font-size="9" fill="#99a3a4" text-anchor="middle" font-family="monospace">' + v.toFixed(2) + '</text>';
    });
    s += '<text x="' + (W0 - R) + '" y="' + (H0 - 6) + '" font-size="9" fill="#99a3a4" text-anchor="end">冲程 S（归一化，1.0 = ' + STROKE.toFixed(1) + ' m）</text>';
    s += '<text x="' + (L + 3) + '" y="' + (T - 9) + '" font-size="9" fill="#99a3a4" font-family="monospace">载荷 kN</text>';

    s += '<path d="' + pathOf(genFault(tplKey, false, 0)) + '" fill="none" stroke="#1d4e50" stroke-width="1" stroke-dasharray="4 3" opacity=".5"/>';
    s += '<path d="' + pathOf(pts) + '" fill="none" stroke="#1d4e50" stroke-width="1.9" stroke-linejoin="round"/>';

    var n = pts.length / 2;
    var upMean = pts.slice(0, n).reduce(function (a, p) { return a + p.f; }, 0) / n;
    var dnMean = pts.slice(n).reduce(function (a, p) { return a + p.f; }, 0) / n;
    function line(yv, label, above) {
      var ty = above ? Math.max(T + 9, yv - 5) : Math.min(H0 - B - 4, yv + 12);
      return '<line x1="' + L + '" y1="' + yv + '" x2="' + (W0 - R) + '" y2="' + yv + '" stroke="#a9742c" stroke-width="1" stroke-dasharray="6 3" opacity=".8"/>' +
        '<text x="' + (L + 4) + '" y="' + ty + '" font-size="9" fill="#83551f" font-family="monospace">' + label + '</text>';
    }
    s += line(ys(upMean), '上均 ' + upMean.toFixed(1), true);
    s += line(ys(dnMean), '下均 ' + dnMean.toFixed(1), false);
    s += '<text x="' + (L + 4) + '" y="' + (H0 - B + 30) + '" font-size="9" fill="#99a3a4">上冲程 →（游动阀关、固定阀开）｜下冲程 ←（游动阀开、固定阀关）</text>';
    s += '<g id="dyn-hover" pointer-events="none"></g>';
    el('dyn').innerHTML = s;
  }

  function drawHover(evt) {
    var svg = el('dyn'), gEl = document.getElementById('dyn-hover');
    if (!svg || !gEl || !lastPts) return;
    var r = svg.getBoundingClientRect();
    var x = (evt.clientX - r.left) / r.width * GEO.W;
    var sN = Math.max(0, Math.min(1, (x - GEO.L) / (GEO.W - GEO.L - GEO.R)));
    var n = lastPts.length / 2;
    var up = lastPts.slice(0, n), down = lastPts.slice(n);
    var iu = Math.round(sN * (n - 1));
    var idn = n - 1 - iu;                     // 下冲程按同一位移取点
    var pu = up[iu], pd = down[Math.max(0, Math.min(n - 1, idn))];
    var xx = xs(sN);
    var html = '<line x1="' + xx + '" y1="' + GEO.T + '" x2="' + xx + '" y2="' + (GEO.H - GEO.B) + '" stroke="#b4762a" stroke-width=".8" stroke-dasharray="3 3" opacity=".7"/>' +
      '<circle cx="' + xx + '" cy="' + ys(pu.f) + '" r="2.6" fill="#123b3a"/>' +
      '<circle cx="' + xx + '" cy="' + ys(pd.f) + '" r="2.6" fill="#a86a1f"/>' +
      '<text x="' + Math.min(xx + 6, GEO.W - 108) + '" y="' + (GEO.T + 10) + '" font-size="9" font-family="monospace" fill="#45524d">' +
      'S ' + (sN * STROKE).toFixed(2) + ' m · 上 ' + pu.f.toFixed(1) + ' / 下 ' + pd.f.toFixed(1) + ' kN</text>';
    gEl.innerHTML = html;
  }

  /* ---------- 平行坐标：7 个特征 × 6 类模板 + 当前样本 ---------- */
  var PKEYS = ['rng', 'area', 'upMean', 'downMean', 'slopeUp', 'slopeDown', 'ripple'];
  var PLABEL = { rng: '载荷幅度', area: '环面积', upMean: '上冲程均载', downMean: '下冲程均载', slopeUp: '上冲程斜率', slopeDown: '下冲程斜率', ripple: '载荷波动' };

  function drawPcoord(f) {
    lastF = f;
    var svg = document.getElementById('pcoord');
    if (!svg) return;
    var W = 900, H = 260, L = 56, R = 24, T = 40, B = 38;
    var rows = CLASSES.map(function (c) {
      return { key: c.key, name: c.name, v: TPL[c.key], now: false };
    });
    rows.push({ key: 'now', name: '当前样本', v: f, now: true });
    var range = {};
    PKEYS.forEach(function (k) {
      var vals = rows.map(function (r) { return r.v[k]; });
      var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
      var pad = (hi - lo) * 0.12 || 0.01;
      range[k] = { lo: lo - pad, hi: hi + pad };
    });
    function X(i) { return L + i * (W - L - R) / (PKEYS.length - 1); }
    function Y(k, v) {
      var r = range[k];
      return T + (1 - (v - r.lo) / (r.hi - r.lo)) * (H - T - B);
    }
    var s = '';
    /* 轴与刻度 */
    PKEYS.forEach(function (k, i) {
      var x = X(i);
      s += '<line x1="' + x + '" y1="' + T + '" x2="' + x + '" y2="' + (H - B) + '" stroke="#ddd4c1" stroke-width="1"/>';
      s += '<text x="' + x + '" y="' + (T - 12) + '" text-anchor="middle" font-size="10" fill="#45524d">' + PLABEL[k] + '</text>';
      s += '<text x="' + x + '" y="' + (T - 1) + '" text-anchor="middle" font-size="8.5" font-family="monospace" fill="#98a199">' + range[k].hi.toFixed(3) + '</text>';
      s += '<text x="' + x + '" y="' + (H - B + 13) + '" text-anchor="middle" font-size="8.5" font-family="monospace" fill="#98a199">' + range[k].lo.toFixed(3) + '</text>';
      for (var t = 1; t <= 3; t++) {
        var yy = T + (H - T - B) * t / 4;
        s += '<line x1="' + (x - 3) + '" y1="' + yy + '" x2="' + x + '" y2="' + yy + '" stroke="#cbbfa7"/>';
      }
    });
    /* 模板折线 */
    rows.forEach(function (r) {
      if (r.now) return;
      var hi = state.pcoord === r.key;
      var d = PKEYS.map(function (k, i) { return (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(k, r.v[k]).toFixed(1); }).join('');
      s += '<path d="' + d + '" fill="none" stroke="' + CLSCOL[r.key] + '" stroke-width="' + (hi ? 3 : 1.3) + '" opacity="' + (hi ? 1 : 0.42) + '" stroke-linejoin="round"/>';
      PKEYS.forEach(function (k, i) {
        s += '<circle cx="' + X(i).toFixed(1) + '" cy="' + Y(k, r.v[k]).toFixed(1) + '" r="' + (hi ? 2.6 : 1.6) + '" fill="' + CLSCOL[r.key] + '" opacity="' + (hi ? 1 : 0.5) + '"/>';
      });
    });
    /* 当前样本 */
    var dnow = PKEYS.map(function (k, i) { return (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(k, f[k]).toFixed(1); }).join('');
    s += '<path d="' + dnow + '" fill="none" stroke="#123b3a" stroke-width="3.2" stroke-linejoin="round"/>';
    PKEYS.forEach(function (k, i) {
      s += '<circle cx="' + X(i).toFixed(1) + '" cy="' + Y(k, f[k]).toFixed(1) + '" r="3.4" fill="#fbf8f0" stroke="#123b3a" stroke-width="2"/>';
    });
    s += '<text x="' + (W - R) + '" y="' + (T - 1) + '" text-anchor="end" font-size="9" fill="#8a5718">粗线 = 当前样本</text>';
    svg.innerHTML = s;

    var lg = document.getElementById('pcoord-legend');
    if (lg) {
      lg.innerHTML = CLASSES.map(function (c) {
        return '<span data-k="' + c.key + '" class="' + (state.pcoord === c.key ? 'on' : '') + '"><i style="width:9px;height:3px;border-radius:2px;background:' + CLSCOL[c.key] + ';display:block"></i>' + c.name + '</span>';
      }).join('');
      [].forEach.call(lg.querySelectorAll('[data-k]'), function (el2) {
        el2.addEventListener('mouseenter', function () { state.pcoord = el2.getAttribute('data-k'); if (lastF) drawPcoord(lastF); });
        el2.addEventListener('mouseleave', function () { state.pcoord = null; if (lastF) drawPcoord(lastF); });
      });
    }
  }

  /* ---------- 渲染 ---------- */
  function render() {
    var pts = genFault(state.cls, state.wax, state.noise);
    lastPts = pts;
    var f = features(pts);
    var probs = classify(f);
    var top = probs[0];
    var truth = CLASSES.filter(function (c) { return c.key === state.cls; })[0];

    drawDyn(pts, top.key);   // 画“预测类”的模板，避免拿真值模板自证

    el('dyn-hint').textContent = truth.name + (state.wax ? ' + 结蜡干扰' : '') + ' · 噪声 ' + state.noise.toFixed(2);
    el('st-verdict').textContent = top.name;
    el('st-conf').innerHTML = Math.round(top.p * 100) + '<small>%</small>';
    el('st-area').innerHTML = (f.area * SCALE * STROKE).toFixed(0) + '<small>kJ</small>';

    el('feats').innerHTML = [
      ['载荷幅度 rng', f.rng.toFixed(3), TPL[top.key].rng.toFixed(3)],
      ['环面积 area', f.area.toFixed(4), TPL[top.key].area.toFixed(4)],
      ['上冲程均载', f.upMean.toFixed(3), TPL[top.key].upMean.toFixed(3)],
      ['下冲程均载', f.downMean.toFixed(3), TPL[top.key].downMean.toFixed(3)],
      ['上冲程斜率', f.slopeUp.toFixed(3), TPL[top.key].slopeUp.toFixed(3)],
      ['下冲程斜率', f.slopeDown.toFixed(3), TPL[top.key].slopeDown.toFixed(3)],
      ['载荷波动 ripple', f.ripple.toFixed(4), TPL[top.key].ripple.toFixed(4)]
    ].map(function (r) {
      return '<div style="display:grid;grid-template-columns:1fr 62px 62px;gap:8px;font-size:11px;padding:5px 0;border-bottom:1px solid var(--line)">' +
        '<span style="color:var(--ink-3)">' + r[0] + '</span><span class="mono" style="text-align:right;color:var(--ink)">' + r[1] + '</span>' +
        '<span class="mono" style="text-align:right;color:var(--ink-4)">' + r[2] + '</span></div>';
    }).join('') +
      '<div style="display:grid;grid-template-columns:1fr 62px 62px;gap:8px;font-size:10px;padding-top:5px;color:var(--ink-4)"><span>特征（按 100 kN 归一）</span><span style="text-align:right">实测</span><span style="text-align:right">预测模板</span></div>';

    drawPcoord(f);

    el('probs').innerHTML = probs.map(function (p, i) {
      return '<div class="dbar" data-k="' + p.key + '" style="padding:4px 0"><span style="width:66px;font-size:11px;color:' + (i === 0 ? 'var(--ink)' : 'var(--ink-3)') + '">' + p.name + '</span>' +
        '<span class="track"><i style="width:' + (p.p * 100).toFixed(1) + '%;background:' + (i === 0 ? 'var(--jade)' : 'var(--line-3)') + '"></i></span>' +
        '<span class="val">' + (p.p * 100).toFixed(0) + '%</span></div>';
    }).join('');
    if (lastF) {
      [].forEach.call(document.querySelectorAll('#probs [data-k]'), function (row) {
        row.addEventListener('mouseenter', function () { state.pcoord = row.getAttribute('data-k'); drawPcoord(lastF); });
        row.addEventListener('mouseleave', function () { state.pcoord = null; drawPcoord(lastF); });
      });
    }

    var level = top.p > 0.75 ? 'ok' : top.p > 0.5 ? 'warn' : 'bad';
    var advice = CLASSES.filter(function (c) { return c.key === top.key; })[0];
    var review = state.wax || top.p < 0.75;
    el('advice').innerHTML =
      '<div style="display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-bottom:7px">' +
      '<span class="db ' + (review ? 'warn' : level) + '">' + (review ? '复合工况 · 需人工复核' : '高置信度') + '</span>' +
      '<span style="font-size:12.5px"><b>' + top.name + '</b>（' + Math.round(top.p * 100) + '%）</span></div>' +
      '<p style="font-size:11.5px;color:var(--ink-2);line-height:1.7">' +
      (review
        ? '当前特征同时落在多个模板附近，单幅图不足以定论。建议调取同一口井最近 3—5 个冲程的示功图与载荷差趋势，再结合套压、液面与产量核实。'
        : advice.tip) + '</p>' +
      (state.wax ? '<div class="callout warn" style="margin:9px 0 0;padding:9px 11px;font-size:11px"><span class="ci">注意</span><span>结蜡使上冲程载荷抬高、下冲程载荷降低，容易被误判为阀漏。现场要靠 <b>多日载荷差趋势</b> 与洗井/热洗记录区分，不能只看单幅图。</span></div>' : '');

    /* 混淆矩阵（历史评测，静态口径） */
    var KEYS = CLASSES.map(function (c) { return c.key; });
    var rows = [
      [0.97, 0.01, 0.00, 0.01, 0.01, 0.00],
      [0.04, 0.86, 0.07, 0.01, 0.01, 0.01],
      [0.02, 0.10, 0.84, 0.01, 0.01, 0.02],
      [0.01, 0.01, 0.01, 0.90, 0.04, 0.03],
      [0.01, 0.01, 0.01, 0.05, 0.89, 0.03],
      [0.00, 0.00, 0.00, 0.00, 0.00, 0.99]
    ];
    var cm = '<span class="lb" style="font-size:8px">真实↓ / 预测→</span>' + KEYS.map(function (k) { return '<span style="text-align:center;color:var(--ink-4);font-size:8.5px">' + CLASSES.filter(function (c) { return c.key === k; })[0].name + '</span>'; }).join('');
    rows.forEach(function (r, i) {
      cm += '<span class="lb">' + CLASSES[i].name + '</span>' +
        r.map(function (v) {
          var a = v > 0.5 ? 0.14 + v * 0.7 : v * 1.1;
          return '<i style="background:rgba(18,59,58,' + a.toFixed(2) + ');display:flex;align-items:center;justify-content:center;color:' + (v > 0.5 ? '#f3eee3' : '#45524d') + ';font-family:var(--mono);font-size:8px" title="' + (v * 100).toFixed(0) + '%">' + (v >= 0.05 ? Math.round(v * 100) : '') + '</i>';
        }).join('');
    });
    el('cm').innerHTML = cm;

    el('note').innerHTML = state.wax
      ? '叠加结蜡后，上冲程载荷抬高、下冲程载荷降低，特征「上/下冲程斜率」同时改变，模型在 <b>正常 / 固定阀漏</b> 之间的概率开始分散——这正是工程上要区分「单幅图判断」与「多日趋势判断」的原因。'
      : (top.key === state.cls
        ? '判定正确。注意<b>供液不足</b>与<b>气锁</b>是最容易混的一对：前者是「泵充不满」，后者是「气体占据泵腔」；两者环都会变小，区别在气锁的载荷波动（ripple）更大、下冲程载荷偏低且换载滞后。把噪声拉到 0.6 以上，会看到特征抖动，但 6 类单标签模型仍可能给出高置信度——这正是需要人工复核的边界。'
        : '判定与设定的真实工况不一致：说明当前图形落到了两类工况之间（复合特征），置信度 ' + Math.round(top.p * 100) + '%。这类井在系统里会被标成「低置信度、需人工复核」——把不确定的交给人才是负责任的做法。');
  }

  /* ---------- 控件 ---------- */
  el('seg-fault').innerHTML = CLASSES.map(function (c) {
    return '<button data-c="' + c.key + '" class="' + (c.key === state.cls ? 'on' : '') + '">' + c.name + '</button>';
  }).join('');
  el('seg-fault').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    state.cls = b.getAttribute('data-c');
    [].forEach.call(el('seg-fault').children, function (x) { x.classList.toggle('on', x === b); });
    render();
  });

  var rn = el('r-noise');
  rn.addEventListener('input', function () {
    state.noise = Number(rn.value);
    el('o-noise').textContent = state.noise.toFixed(2);
    render();
  });
  var tw = el('tog-wax');
  tw.setAttribute('role', 'switch');
  tw.setAttribute('aria-checked', 'false');
  tw.setAttribute('tabindex', '0');
  function toggleWax() {
    state.wax = !state.wax;
    tw.classList.toggle('on', state.wax);
    tw.setAttribute('aria-checked', state.wax ? 'true' : 'false');
    render();
  }
  tw.addEventListener('click', toggleWax);
  tw.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleWax(); } });

  var reset = el('btn-reset');
  if (reset) reset.addEventListener('click', function () {
    state.cls = 'normal'; state.noise = 0.15; state.wax = false; state.pcoord = null;
    rn.value = '0.15'; el('o-noise').textContent = '0.15';
    tw.classList.remove('on'); tw.setAttribute('aria-checked', 'false');
    [].forEach.call(el('seg-fault').children, function (x) { x.classList.toggle('on', x.getAttribute('data-c') === 'normal'); });
    render();
  });

  var dyn = el('dyn');
  dyn.addEventListener('pointermove', drawHover);
  dyn.addEventListener('pointerleave', function () { var gEl = document.getElementById('dyn-hover'); if (gEl) gEl.innerHTML = ''; });

  render();
})();
