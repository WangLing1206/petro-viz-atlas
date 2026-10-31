/* =========================================================
   修井周期预测 · 可运行示范
   ---------------------------------------------------------
   ① 7 道标准工序，每道工序的耗时 = f(井深, 故障类型, 复杂度)
   ② 分位数：每道工序给 P10 / P50 / P90（对数正态形状）
   ③ 蒙特卡洛：2000 次抽样相加，工序间用共同因子模拟相关性
   ④ 输出总工期分布、P50/P90、按期完工概率、方差贡献最大的工序

   统计口径说明：
   · 共同因子载荷 LOAD = 0.35，因此任意两道工序的两两相关是
     LOAD² = 0.12（不是 0.35）。界面上两个数都写出来，避免把
     「载荷」误读成「相关系数」。
   · 随机流固定（不含井深/故障等输入），即 common random numbers：
     拖动井深时中位数平滑变化，P50/P90 不会因换种子而抖动。
   · 甘特图上的累计完成时刻由同一组蒙特卡洛样本逐工序累加得到，
     因此最后一行 P50/P90 与直方图的总 P50/P90 完全一致。
   ========================================================= */
(function () {
  'use strict';

  var FAULTS = [
    { key: 'fish', name: '落物打捞', f: 1.00 },
    { key: 'casing', name: '套管整形', f: 1.25 },
    { key: 'water', name: '找堵水', f: 0.85 },
    { key: 'sand', name: '冲砂防砂', f: 0.90 },
    { key: 'part', name: '管柱断脱', f: 1.35 }
  ];

  /* 工序：a=固定耗时(天)，b=每千米井深增加(天/km)，s=对数正态形状参数(越小越集中) */
  var PROCS = [
    { name: '起原井管柱', a: 0.35, b: 0.55, s: 0.20 },
    { name: '洗井 / 循环', a: 0.20, b: 0.12, s: 0.28 },
    { name: '打捞 / 磨铣', a: 1.10, b: 0.90, s: 0.55 },
    { name: '通井', a: 0.35, b: 0.30, s: 0.30 },
    { name: '下泵 / 下管柱', a: 0.45, b: 0.45, s: 0.22 },
    { name: '试压', a: 0.20, b: 0.03, s: 0.35 },
    { name: '交井 / 收尾', a: 0.25, b: 0.02, s: 0.40 }
  ];

  var DEFAULTS = { fault: 'fish', depth: 2400, mill: true, kill: true, plan: 10 };
  var state = { fault: DEFAULTS.fault, depth: DEFAULTS.depth, mill: DEFAULTS.mill, kill: DEFAULTS.kill, plan: DEFAULTS.plan };

  /* 固定种子，保证同样输入得到同样结果 */
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function faultOf(k) { return FAULTS.filter(function (f) { return f.key === k; })[0]; }

  /* 每道工序的中位数耗时（允许覆盖 state，用于对照计算） */
  function medians(over) {
    var o = over || {};
    var faultKey = o.fault != null ? o.fault : state.fault;
    var depth = o.depth != null ? o.depth : state.depth;
    var mill = o.mill != null ? o.mill : state.mill;
    var kill = o.kill != null ? o.kill : state.kill;
    var f = faultOf(faultKey).f;
    var km = depth / 1000;
    var comp = f * (mill ? 1.18 : 1);
    var killMul = kill ? 1.06 : 1;
    return PROCS.map(function (p, i) {
      var m = p.a + p.b * km;
      /* 复杂度主要影响与井下作业相关的工序 */
      var w = i === 2 ? 1.0 : i === 0 || i === 4 ? 0.45 : i === 3 ? 0.35 : 0.12;
      /* 压井使各工序中位数约 +6%（不是 0.3—0.8 天的独立工序） */
      return Math.max(0.12, m * (1 + (comp - 1) * w) * killMul);
    });
  }

  /* ---------- 蒙特卡洛 ---------- */
  var M = 2000;
  var LOAD = 0.35;             /* 共同因子载荷 */
  var PAIR = LOAD * LOAD;      /* 工序两两相关 = 0.1225 ≈ 0.12 */
  var SEED = 101581;           /* 固定随机流，不含井深/故障——common random numbers */

  function simulate(over) {
    var med = medians(over);
    var r = mulberry32(SEED);
    function nd() {
      var u = 0, v = 0;
      while (u === 0) u = r();
      while (v === 0) v = r();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }
    var totals = [], perProc = PROCS.map(function () { return []; });
    for (var i = 0; i < M; i++) {
      var z0 = nd(), sum = 0;
      for (var p = 0; p < PROCS.length; p++) {
        var zi = LOAD * z0 + Math.sqrt(1 - PAIR) * nd();
        var v = med[p] * Math.exp(PROCS[p].s * zi);
        perProc[p].push(v);
        sum += v;
      }
      totals.push(sum);
    }
    /* 逐工序累计完成时刻：cum[p][i] = 第 i 次抽样下前 p+1 道工序的完成时刻 */
    var cum = [], run = new Array(M);
    for (var k = 0; k < M; k++) run[k] = 0;
    for (var q = 0; q < PROCS.length; q++) {
      for (var j = 0; j < M; j++) run[j] += perProc[q][j];
      cum.push(run.slice());
    }
    totals.sort(function (a, b) { return a - b; });
    return { totals: totals, perProc: perProc, cum: cum, med: med };
  }

  function q(sorted, p) {
    var i = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
    return sorted[i];
  }
  function meanOf(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s / a.length; }
  function varianceOf(a, m) { var s = 0; for (var i = 0; i < a.length; i++) { var d = a[i] - m; s += d * d; } return s / a.length; }

  /* ---------- 绘制：甘特 ---------- */
  var C = { jade: '#1d4e50', jadeL: '#c8dbd2', clay: '#a9742c', clayL: '#f0e0c8', bad: '#a64b3c', ink3: '#6f7a7c', ink4: '#99a3a4', line: '#efece1' };

  function drawGantt(res, stats, keyIdx) {
    var L = 92, R = 150, T = 26, B = 38, W = 680, H = 272;
    var rowH = (H - T - B) / PROCS.length;
    var tmax = Math.ceil(stats.p90 * 1.05 / 2) * 2;
    if (tmax < stats.p90 * 1.02) tmax += 2;
    var x = function (t) { return L + t / tmax * (W - L - R); };
    var s = '';

    /* 时间网格：刻度放在顶部，轴标题移到图外（见 figure 头部） */
    for (var t = 0; t <= tmax + 1e-9; t += 2) {
      s += '<line x1="' + x(t).toFixed(1) + '" y1="' + T + '" x2="' + x(t).toFixed(1) + '" y2="' + (H - B) + '" stroke="' + C.line + '"/>' +
        '<text x="' + x(t).toFixed(1) + '" y="' + (T - 8) + '" font-size="9" fill="' + C.ink4 + '" text-anchor="middle" font-family="monospace">' + t + '</text>';
    }

    var prev50 = 0;
    PROCS.forEach(function (p, i) {
      var arr = res.cum[i].slice().sort(function (a, b) { return a - b; });
      var c10 = q(arr, 0.1), c50 = q(arr, 0.5), c90 = q(arr, 0.9);
      var y = T + i * rowH + rowH / 2;
      var isKey = i === keyIdx;
      s += '<text x="' + (L - 8) + '" y="' + (y + 3.5) + '" font-size="10" text-anchor="end" fill="' + (isKey ? C.clay : '#4a585c') + '">' + p.name + '</text>';
      /* 浅色条：累计完成时刻的 P10—P90 区间（同一组 MC 样本） */
      s += '<rect x="' + x(c10).toFixed(1) + '" y="' + (y - 8) + '" width="' + Math.max(1.5, x(c90) - x(c10)).toFixed(1) + '" height="16" rx="4" fill="' + (isKey ? C.clayL : C.jadeL) + '"/>';
      /* 深色段：中位排期下本工序占用的时间 */
      s += '<rect x="' + x(prev50).toFixed(1) + '" y="' + (y - 5) + '" width="' + Math.max(1.5, x(c50) - x(prev50)).toFixed(1) + '" height="10" rx="3" fill="' + (isKey ? C.clay : C.jade) + '"/>';
      s += '<text x="' + (W - R + 8) + '" y="' + (y + 3.2) + '" font-size="8.5" font-family="monospace" fill="' + C.ink3 + '">完成 ' + c10.toFixed(1) + '—' + c90.toFixed(1) + ' 天</text>';
      prev50 = c50;
    });

    /* 总 P50 / P90 竖线：与直方图同一统计口径 */
    var xp50 = x(stats.p50), xp90 = x(stats.p90);
    s += '<line x1="' + xp50.toFixed(1) + '" y1="' + (T - 2) + '" x2="' + xp50.toFixed(1) + '" y2="' + (H - B + 4) + '" stroke="' + C.jade + '" stroke-width="1.4"/>';
    s += '<line x1="' + xp90.toFixed(1) + '" y1="' + (T - 2) + '" x2="' + xp90.toFixed(1) + '" y2="' + (H - B + 4) + '" stroke="' + C.clay + '" stroke-width="1.4" stroke-dasharray="4 3"/>';
    s += '<text x="' + xp50.toFixed(1) + '" y="' + (H - 9) + '" font-size="9" font-family="monospace" fill="' + C.jade + '" text-anchor="middle">总 P50 ' + stats.p50.toFixed(1) + ' 天</text>';
    s += '<text x="' + xp90.toFixed(1) + '" y="' + (H - 9) + '" font-size="9" font-family="monospace" fill="' + C.clay + '" text-anchor="middle">总 P90 ' + stats.p90.toFixed(1) + ' 天</text>';

    document.getElementById('gantt').innerHTML = s;
  }

  /* ---------- 绘制：总工期分布 ---------- */
  function niceStep(v) {
    var cand = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000];
    for (var i = 0; i < cand.length; i++) if (v / cand[i] <= 5.5) return cand[i];
    return 2000;
  }

  function drawHist(totals, stats, keyIdx) {
    var L = 46, R = 16, T = 20, B = 46, W = 680, H = 234;
    var lo = Math.floor(totals[0] * 2) / 2, hi = Math.ceil(totals[totals.length - 1] * 2) / 2;
    var bins = 32, bw = (hi - lo) / bins, counts = new Array(bins).fill(0);
    totals.forEach(function (v) {
      var b = Math.min(bins - 1, Math.floor((v - lo) / bw));
      counts[b]++;
    });
    var cmax = Math.max.apply(null, counts);
    var ystep = niceStep(cmax);
    var x = function (v) { return L + (v - lo) / (hi - lo) * (W - L - R); };
    var yb = function (c) { return H - B - c / (Math.ceil(cmax / ystep) * ystep) * (H - T - B); };
    var s = '';

    /* y 轴：频数刻度 */
    s += '<text x="6" y="12" font-size="8.5" fill="' + C.ink4 + '" font-family="monospace">频数</text>';
    for (var c = 0; c <= Math.ceil(cmax / ystep) * ystep + 1e-9; c += ystep) {
      var yy = yb(c);
      s += '<line x1="' + L + '" y1="' + yy.toFixed(1) + '" x2="' + (W - R) + '" y2="' + yy.toFixed(1) + '" stroke="' + C.line + '"/>';
      s += '<text x="' + (L - 6) + '" y="' + (yy + 3).toFixed(1) + '" font-size="8.5" fill="' + C.ink4 + '" text-anchor="end" font-family="monospace">' + c + '</text>';
    }
    s += '<line x1="' + L + '" y1="' + T + '" x2="' + L + '" y2="' + (H - B) + '" stroke="#d3c9b6"/>';

    for (var i = 0; i < bins; i++) {
      var v0 = lo + i * bw, v1 = v0 + bw;
      var col;
      if (v1 <= state.plan) col = '#c8dbd2';                 /* 全部落在计划内 */
      else if (v0 >= state.plan) col = 'rgba(176,84,74,.55)'; /* 全部超期 */
      else col = '#e6d3ae';                                   /* 跨界 bin：部分超期 */
      s += '<rect x="' + x(v0).toFixed(1) + '" y="' + yb(counts[i]).toFixed(1) + '" width="' + Math.max(1, x(v1) - x(v0) - 1).toFixed(1) + '" height="' + (H - B - yb(counts[i])).toFixed(1) + '" fill="' + col + '"/>';
    }
    s += '<line x1="' + L + '" y1="' + (H - B) + '" x2="' + (W - R) + '" y2="' + (H - B) + '" stroke="#d3c9b6"/>';

    var span = hi - lo;
    var stepX = span > 20 ? 5 : span > 10 ? 2 : 1;
    for (var t = Math.ceil(lo); t <= hi; t += stepX) {
      s += '<text x="' + x(t).toFixed(1) + '" y="' + (H - B + 14) + '" font-size="9" fill="' + C.ink4 + '" text-anchor="middle" font-family="monospace">' + t + '</text>';
    }
    /* 轴标题单独一行，避免与最右刻度重叠 */
    s += '<text x="' + ((L + W - R) / 2).toFixed(1) + '" y="' + (H - 8) + '" font-size="9" fill="' + C.ink4 + '" text-anchor="middle">总工期 / 天</text>';

    function vline(v, col, label, dash, ly, anchor, xOverride) {
      var xx = xOverride != null ? xOverride : x(v);
      return '<line x1="' + xx.toFixed(1) + '" y1="' + T + '" x2="' + xx.toFixed(1) + '" y2="' + (H - B) + '" stroke="' + col + '" stroke-width="1.3"' + (dash ? ' stroke-dasharray="4 3"' : '') + '/>' +
        '<text x="' + (xx + (anchor === 'end' ? -4 : 4)).toFixed(1) + '" y="' + ly + '" font-size="9" fill="' + col + '" font-family="monospace" text-anchor="' + (anchor || 'start') + '">' + label + '</text>';
    }

    s += vline(stats.p10, C.jade, 'P10 ' + stats.p10.toFixed(1), true, T + 12);
    s += vline(stats.p90, C.clay, 'P90 ' + stats.p90.toFixed(1), true, T + 12);

    /* 计划线夹到坐标轴内；计划与 P50 很接近时合并标注 */
    var lowOutside = state.plan < lo, highOutside = state.plan > hi;
    var closeToP50 = !lowOutside && !highOutside && Math.abs(state.plan - stats.p50) <= 0.6;

    if (closeToP50) {
      s += '<line x1="' + x(stats.p50).toFixed(1) + '" y1="' + T + '" x2="' + x(stats.p50).toFixed(1) + '" y2="' + (H - B) + '" stroke="' + C.jade + '" stroke-width="1.4"/>';
      s += '<line x1="' + x(state.plan).toFixed(1) + '" y1="' + T + '" x2="' + x(state.plan).toFixed(1) + '" y2="' + (H - B) + '" stroke="' + C.bad + '" stroke-width="1.3" stroke-dasharray="4 3" opacity=".55"/>';
      s += '<text x="' + (x(stats.p50) + 4).toFixed(1) + '" y="' + (T + 24) + '" font-size="9" fill="' + C.bad + '" font-family="monospace">P50 ' + stats.p50.toFixed(1) + ' ≈ 计划 ' + state.plan + ' 天</text>';
    } else {
      s += vline(stats.p50, C.jade, 'P50 ' + stats.p50.toFixed(1), false, T + 24);
      if (lowOutside) {
        s += vline(state.plan, C.bad, '计划 ' + state.plan + ' 天 · 低于全部样本', false, T + 36, 'start', L);
      } else if (highOutside) {
        s += vline(state.plan, C.bad, '计划 ' + state.plan + ' 天 · 高于全部样本', false, T + 36, 'end', W - R);
      } else {
        s += vline(state.plan, C.bad, '计划 ' + state.plan + ' 天', false, T + 36);
      }
    }
    document.getElementById('hist').innerHTML = s;
  }

  /* ---------- 渲染 ---------- */
  var el = function (id) { return document.getElementById(id); };

  function syncControls() {
    el('r-depth').value = state.depth;
    el('o-depth').textContent = state.depth + ' m';
    el('r-plan').value = state.plan;
    el('o-plan').textContent = state.plan + ' 天';
    [].forEach.call(el('seg-fault').children, function (b) {
      var on = b.getAttribute('data-f') === state.fault;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    [['tog-mill', 'mill'], ['tog-kill', 'kill']].forEach(function (p) {
      var t = el(p[0]);
      t.classList.toggle('on', state[p[1]]);
      t.setAttribute('aria-checked', state[p[1]] ? 'true' : 'false');
    });
  }

  /* ---------- CDF：计划工期 → 按期概率 ---------- */
  function drawCdf(totals, stats) {
    var svg = el('cdf');
    if (!svg) return;
    var sorted = totals.slice().sort(function (a, b) { return a - b; });
    var min = sorted[0], max = sorted[sorted.length - 1];
    var W = 320, H = 170, L = 34, R = 12, T = 16, B = 30;
    var x = function (v) { return L + (v - min) / Math.max(0.01, max - min) * (W - L - R); };
    var y = function (p) { return T + (1 - p) * (H - T - B); };
    var s = '';
    /* 网格与坐标 */
    [0, 0.25, 0.5, 0.75, 1].forEach(function (p) {
      s += '<line x1="' + L + '" y1="' + y(p) + '" x2="' + (W - R) + '" y2="' + y(p) + '" stroke="#eee8da"/>';
      s += '<text x="' + (L - 5) + '" y="' + (y(p) + 3) + '" text-anchor="end" font-size="8" font-family="monospace" fill="#98a199">' + Math.round(p * 100) + '%</text>';
    });
    for (var t = 0; t <= 4; t++) {
      var vv = min + (max - min) * t / 4;
      s += '<line x1="' + x(vv) + '" y1="' + (H - B) + '" x2="' + x(vv) + '" y2="' + (H - B + 4) + '" stroke="#cbbfa7"/>';
      s += '<text x="' + x(vv) + '" y="' + (H - B + 14) + '" text-anchor="middle" font-size="8" font-family="monospace" fill="#98a199">' + vv.toFixed(0) + '</text>';
    }
    s += '<text x="' + (W - R) + '" y="' + (H - 4) + '" text-anchor="end" font-size="8.5" fill="#98a199">总工期 / 天</text>';
    /* CDF 曲线 */
    var d = '', area = 'M' + x(min) + ' ' + y(0);
    for (var i = 0; i <= 160; i++) {
      var v = min + (max - min) * i / 160;
      var p = inCdf(sorted, v);
      d += (i ? 'L' : 'M') + x(v).toFixed(1) + ' ' + y(p).toFixed(1);
      area += 'L' + x(v).toFixed(1) + ' ' + y(p).toFixed(1);
    }
    area += 'L' + x(max) + ' ' + y(0) + 'Z';
    s += '<path d="' + area + '" fill="rgba(18,59,58,.08)"/>';
    s += '<path d="' + d + '" fill="none" stroke="#123b3a" stroke-width="1.8"/>';
    /* P50 / P90 参考线 */
    [[stats.p50, 'P50'], [stats.p90, 'P90']].forEach(function (m) {
      s += '<line x1="' + x(m[0]) + '" y1="' + T + '" x2="' + x(m[0]) + '" y2="' + (H - B) + '" stroke="#b4762a" stroke-width=".8" stroke-dasharray="3 3" opacity=".55"/>';
      s += '<text x="' + x(m[0]) + '" y="' + (H - B - 3) + '" text-anchor="middle" font-size="8" fill="#8a5718" font-family="monospace">' + m[1] + '</text>';
    });
    /* 计划线 + 交点 */
    var px = x(Math.max(min, Math.min(max, state.plan)));
    var pp = inCdf(sorted, state.plan);
    s += '<line x1="' + px + '" y1="' + T + '" x2="' + px + '" y2="' + (H - B) + '" stroke="#9c4235" stroke-width="1.2" stroke-dasharray="4 3"/>';
    s += '<circle cx="' + px + '" cy="' + y(pp) + '" r="3.4" fill="#fbf8f0" stroke="#9c4235" stroke-width="1.8"/>';
    s += '<text x="' + Math.min(px + 6, W - R - 58) + '" y="' + Math.max(T + 10, y(pp) - 7) + '" font-size="9" fill="#9c4235">计划 ' + state.plan + ' 天 · ' + Math.round(pp * 100) + '%</text>';
    svg.innerHTML = s;
  }

  function render() {
    var res = simulate();
    var totals = res.totals;
    var stats = {
      p10: q(totals, 0.1), p50: q(totals, 0.5), p70: q(totals, 0.7),
      p75: q(totals, 0.75), p90: q(totals, 0.9)
    };
    stats.mean = meanOf(totals);
    var nPlan = totals.filter(function (v) { return v <= state.plan; }).length;
    stats.prob = nPlan / totals.length;
    /* 未达到 100% 时最多显示 99%，避免把 99.6% 写成“100% 一定完工” */
    var pct = stats.prob >= 1 ? 100 : Math.min(99, Math.round(stats.prob * 100));

    /* 方差贡献：cov(工序, 总工期) / var(总工期)，串联时各项之和为 1 */
    var rawT = res.cum[PROCS.length - 1];
    var meanT = meanOf(rawT), varT = varianceOf(rawT, meanT);
    var shares = res.perProc.map(function (arr) {
      var m = meanOf(arr), cov = 0;
      for (var i = 0; i < arr.length; i++) cov += (arr[i] - m) * (rawT[i] - meanT);
      return cov / arr.length / varT;
    });
    var keyIdx = 0;
    shares.forEach(function (v, i) { if (v > shares[keyIdx]) keyIdx = i; });

    /* 压井效应：只用于文案，同样使用固定随机流，差值稳定 */
    var alt = simulate({ kill: !state.kill });
    var p50Alt = q(alt.totals, 0.5);
    var killDelta = state.kill ? stats.p50 - p50Alt : p50Alt - stats.p50;

    el('st-p50').innerHTML = stats.p50.toFixed(1) + '<small>天</small>';
    el('st-p90').innerHTML = stats.p90.toFixed(1) + '<small>天</small>';
    el('st-prob').innerHTML = pct + '<small>%</small>';
    el('st-w').innerHTML = (stats.p90 - stats.p10).toFixed(1) + '<small>天</small>';
    el('mc-hint').textContent = '2000 次 · 共同因子载荷 0.35 / 工序两两相关 ' + PAIR.toFixed(2) + ' · 均值 ' + stats.mean.toFixed(1) + ' 天';

    drawGantt(res, stats, keyIdx);
    drawHist(totals, stats, keyIdx);
    drawCdf(totals, stats);

    /* 按期概率条 + 分位对照表（含 P70） */
    var marks = [0.1, 0.25, 0.5, 0.7, 0.75, 0.9];
    el('prob').innerHTML =
      '<div style="display:flex;align-items:baseline;gap:10px"><span class="mono" style="font-size:26px;color:' + (stats.prob > 0.75 ? 'var(--ok)' : stats.prob > 0.5 ? 'var(--warn)' : 'var(--bad)') + '">' +
      pct + '%</span><span style="font-size:11.5px;color:var(--ink-3)">按计划工期 <b>' + state.plan + ' 天</b> 完工的概率</span></div>' +
      '<div style="display:flex;height:8px;border-radius:4px;overflow:hidden;background:var(--paper-3);margin:9px 0 6px">' +
      '<i style="display:block;height:100%;width:' + (stats.prob * 100).toFixed(1) + '%;background:var(--jade)"></i></div>' +
      '<table class="dtable">' + marks.map(function (p) {
        var v = q(totals, p);
        return '<tr><td>P' + Math.round(p * 100) + ' 工期</td><td class="num">' + v.toFixed(1) + ' 天</td>' +
          '<td class="num">' + (v <= state.plan ? '<span class="db ok">计划内</span>' : '<span class="db bad">超期</span>') + '</td></tr>';
      }).join('') + '</table>';

    el('proc').innerHTML = res.perProc.map(function (arr, i) {
      var a = arr.slice().sort(function (x, y) { return x - y; });
      var p10 = q(a, 0.1), p50 = q(a, 0.5), p90 = q(a, 0.9);
      var share = Math.round(shares[i] * 100);
      return '<tr' + (i === keyIdx ? ' class="keep"' : '') + '><td>' + PROCS[i].name + (i === keyIdx ? ' <span class="db warn">方差 ' + share + '%</span>' : '') + '</td>' +
        '<td class="num">' + p10.toFixed(1) + '</td><td class="num">' + p50.toFixed(1) + '</td><td class="num">' + p90.toFixed(1) + '</td>' +
        '<td class="num">' + (p90 - p10).toFixed(1) + '</td></tr>';
    }).join('') + '<tr><td><b>合计</b></td><td class="num">' + stats.p10.toFixed(1) + '</td><td class="num">' + stats.p50.toFixed(1) +
      '</td><td class="num">' + stats.p90.toFixed(1) + '</td><td class="num">' + (stats.p90 - stats.p10).toFixed(1) + '</td></tr>';

    el('factors').innerHTML = [
      ['井深', state.depth + ' m', (state.depth / 1000).toFixed(1) + ' km 影响起下钻与打捞工序的中位数'],
      ['故障类型', faultOf(state.fault).name, '复杂度系数 ×' + faultOf(state.fault).f.toFixed(2)],
      ['是否磨铣', state.mill ? '是' : '否', state.mill ? '打捞工序中位数 ×1.18，区间显著变宽' : '仅打捞，工序较集中'],
      ['是否压井', state.kill ? '是' : '否', state.kill
        ? '压井使各工序中位数约 +6%（本井 P50 约 +' + killDelta.toFixed(1) + ' 天）'
        : '不压井：相比压井，本井 P50 约 -' + killDelta.toFixed(1) + ' 天']
    ].map(function (r) {
      return '<div style="display:flex;justify-content:space-between;gap:10px;font-size:11px;padding:5px 0;border-bottom:1px solid var(--line)">' +
        '<span style="color:var(--ink-3)">' + r[0] + '</span><span style="text-align:right"><b>' + r[1] + '</b><div style="font-size:10px;color:var(--ink-4)">' + r[2] + '</div></span></div>';
    }).join('');

    /* 计划工期建议：按概率分档，不再固定“再拖 2 天” */
    var minT = totals[0], maxT = totals[totals.length - 1];
    var gain1 = (inCdf(totals, state.plan + 1) - inCdf(totals, state.plan)) * 100;
    var planMsg;
    if (state.plan > maxT) {
      planMsg = '计划 <b>' + state.plan + ' 天</b> 高于全部 2000 次抽样（最长 ' + maxT.toFixed(1) + ' 天），按期概率 100%。' +
        '这个计划已没有留余量的必要，可收窄到 P90 = <b>' + stats.p90.toFixed(1) + ' 天</b>，仍覆盖约 90%。';
    } else if (state.plan < minT) {
      planMsg = '计划 <b>' + state.plan + ' 天</b> 低于全部 2000 次抽样（最短 ' + minT.toFixed(1) + ' 天），按期概率 0%，明显偏紧；' +
        '当前井况的 P10 为 <b>' + stats.p10.toFixed(1) + ' 天</b>。';
    } else if (stats.prob < 0.2) {
      planMsg = '按期概率仅 <b>' + pct + '%</b>，计划偏紧：每增加 1 天约 +' + gain1.toFixed(1) + ' 个百分点。' +
        '当前 P50 = <b>' + stats.p50.toFixed(1) + ' 天</b>、P90 = <b>' + stats.p90.toFixed(1) + ' 天</b>。';
    } else if (stats.prob <= 0.8) {
      planMsg = '计划处于 P10—P90 之间：每增加 1 天约 +' + gain1.toFixed(1) + ' 个百分点；' +
        '到 P50 = <b>' + stats.p50.toFixed(1) + ' 天</b> 约 50%，到 P90 = <b>' + stats.p90.toFixed(1) + ' 天</b> 约 90%。';
    } else if (stats.prob <= 0.9) {
      planMsg = '计划已接近 P90（' + stats.p90.toFixed(1) + ' 天）：余量基本够用，每再增 1 天只 +' + gain1.toFixed(1) + ' 个百分点。' +
        '若排班允许，可回收到 P75 = <b>' + stats.p75.toFixed(1) + ' 天</b>（覆盖约 75%）。';
    } else {
      planMsg = '按期概率已超过 <b>' + pct + '%</b>：每再增 1 天只 +' + gain1.toFixed(1) + ' 个百分点，' +
        '没有必要继续留余量；P90 = <b>' + stats.p90.toFixed(1) + ' 天</b> 已覆盖约 90% 的情形。';
    }

    el('note').innerHTML = '总工期的方差主要来自 <b>' + PROCS[keyIdx].name + '</b>（方差贡献 ' + Math.round(shares[keyIdx] * 100) + '%，P10—P90 宽 ' +
      (q(res.perProc[keyIdx].slice().sort(function (a, b) { return a - b; }), 0.9) - q(res.perProc[keyIdx].slice().sort(function (a, b) { return a - b; }), 0.1)).toFixed(1) + ' 天），' +
      '它是最不确定的工序。注意：串联作业里每一道工序都在关键路径上，“压缩它的区间”主要降低总工期的 <b>P90 与区间宽度</b>；' +
      '要把 <b>P50</b> 压下来，得降低各工序的中位数（工艺、资源、队伍熟练度）或把部分工序改成并行。' +
      '<br><br>' + planMsg;
  }

  function inCdf(sorted, v) {
    if (v < sorted[0]) return 0;
    if (v >= sorted[sorted.length - 1]) return 1;
    var n = 0;
    for (var i = 0; i < sorted.length; i++) { if (sorted[i] <= v) n++; else break; }
    return n / sorted.length;
  }

  /* ---------- 控件 ---------- */
  el('seg-fault').innerHTML = FAULTS.map(function (f) {
    var on = f.key === state.fault;
    return '<button type="button" data-f="' + f.key + '" class="' + (on ? 'on' : '') + '" aria-pressed="' + (on ? 'true' : 'false') + '" aria-label="故障类型：' + f.name + '">' + f.name + '</button>';
  }).join('');
  el('seg-fault').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    state.fault = b.getAttribute('data-f');
    [].forEach.call(el('seg-fault').children, function (x) {
      var on = x === b;
      x.classList.toggle('on', on);
      x.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    render();
  });

  function slider(id, out, key, unit) {
    var r = el(id);
    r.addEventListener('input', function () {
      state[key] = Number(r.value);
      el(out).textContent = r.value + unit;
      render();
    });
  }
  slider('r-depth', 'o-depth', 'depth', ' m');
  slider('r-plan', 'o-plan', 'plan', ' 天');

  [['tog-mill', 'mill'], ['tog-kill', 'kill']].forEach(function (p) {
    var t = el(p[0]);
    t.addEventListener('click', function () {
      state[p[1]] = !state[p[1]];
      t.classList.toggle('on', state[p[1]]);
      t.setAttribute('aria-checked', state[p[1]] ? 'true' : 'false');
      render();
    });
  });

  el('btn-reset').addEventListener('click', function () {
    state.fault = DEFAULTS.fault;
    state.depth = DEFAULTS.depth;
    state.mill = DEFAULTS.mill;
    state.kill = DEFAULTS.kill;
    state.plan = DEFAULTS.plan;
    syncControls();
    render();
  });

  syncControls();
  render();
})();
