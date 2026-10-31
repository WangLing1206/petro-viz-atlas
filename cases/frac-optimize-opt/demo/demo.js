/* =========================================================
   压裂参数智能优化 · 可运行示范
   ---------------------------------------------------------
   场景：给定地质条件，选排量 Q（3—8 m³/min）与砂比 S（5—25%），
        在施工压力不超过 76 MPa 的前提下最大化压后产能指数 PI。
   ① 「模拟器」：解析响应面（本示范的模拟器替身，真实项目里是
      压裂数值模拟器或历史井数据拟合的响应面），带脊状最优、
      非凸小起伏与测量噪声；
   ② 代理模型：平方指数核的高斯过程 / RBF 回归（自写几十行，
      含 Cholesky 求解），用已评估点给出产能的均值与方差；
   ③ 采集函数：EI（Expected Improvement）在探索与利用之间权衡，
      每轮挑 3 个新点，候选池限定在压力可行域内；
   ④ 对照：随机采样 / 7×7 网格扫描 与贝叶斯优化在同一评估
      次数下的收敛差异。
   ========================================================= */
(function () {
  'use strict';

  /* ================= 1. 「模拟器」：解析响应面 ================= */
  var QLO = 3, QHI = 8;          // 排量区间 m³/min
  var SLO = 5, SHI = 25;         // 砂比区间 %
  var PLIM = 76;                 // 施工压力上限 MPa（硬约束）
  var RHO_P = 2.65;              // 支撑剂视密度 t/m³
  var PUMP_MIN = 18;             // 单段泵注时长 min（示范固定）
  var MAXN = 30, ROUND = 3;      // 单策略模拟预算 / 每轮新增点数
  var MAXROUND = (MAXN - 6) / ROUND;   // 去掉共享的 6 个初始点
  var EXP = { q: 5.75, s: 17.5 }; // 邻井经验方案（现场套用）

  /* 施工压力：随排量与砂比上升，高排量高砂比区会越过上限 */
  function pres(q, s) {
    return 46 + 5.0 * (q - QLO) + 1.0 * (s - SLO) + 0.09 * (q - QLO) * (s - SLO);
  }
  function feas(q, s) { return pres(q, s) <= PLIM + 1e-9; }
  /* 单段液量 V = Q × 泵注时长；砂量 W = 砂比(体积%) × 视密度 × V。
     这样 W 与「100 m³ 液、约 46 t 砂」自洽，不再用无量纲的 0.17·Q·S。 */
  function fluidVol(q) { return q * PUMP_MIN; }
  function sand(q, s) { return (s / 100) * RHO_P * fluidVol(q); }

  /* 真实响应面：主脊（Q≈6.4、S≈17 附近） + 低排量低砂比的局部次优
     + 轻微非凸起伏。峰值约 100，全空间约 5—100。 */
  function piTrue(q, s) {
    var u = (q - QLO) / 5, v = (s - SLO) / 20;
    var r1 = Math.exp(-(Math.pow((u - 0.66) / 0.15, 2) + Math.pow((v - 0.60) / 0.20, 2)) / 2);
    var r2 = 0.50 * Math.exp(-(Math.pow((u - 0.30) / 0.18, 2) + Math.pow((v - 0.30) / 0.20, 2)) / 2);
    var rip = 0.040 * Math.sin(3.1 * Math.PI * u) * Math.cos(2.4 * Math.PI * v);
    return 96.6 * Math.max(0.05, r1 + r2 + rip);
  }

  /* 测量噪声：坐标哈希得到的确定性正态数，保证同一点可复现 */
  function noiseZ(q, s) {
    var h1 = Math.sin(q * 12.9898 + s * 78.233) * 43758.5453;
    var h2 = Math.sin(q * 39.3468 + s * 11.135) * 24634.6345;
    var u1 = h1 - Math.floor(h1), u2 = h2 - Math.floor(h2);
    if (u1 < 1e-6) u1 = 1e-6;
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
  var state = { noise: 1.5, selected: 'bayes', round: 0, showTrue: true, showProxy: false, showFeas: true };

  /* 一次「模拟」：真值 × 相对噪声（±noise%） */
  function measure(q, s) { return piTrue(q, s) * (1 + state.noise / 100 * noiseZ(q, s) / 3); }

  /* 真实最优：细网格扫描（在示范里充当「已知答案」，用于算遗憾） */
  var SCAN = 480, TRUE_OPT = { q: 0, s: 0, pi: 0, p: 0, w: 0 }, SAFE_OPT = { q: 0, s: 0, pi: 0, p: 0, w: 0 };
  (function scan() {
    for (var i = 0; i <= SCAN; i++) for (var j = 0; j <= SCAN; j++) {
      var q = QLO + (QHI - QLO) * i / SCAN, s = SLO + (SHI - SLO) * j / SCAN;
      var p = pres(q, s); if (p > PLIM) continue;
      var v = piTrue(q, s);
      if (v > TRUE_OPT.pi) TRUE_OPT = { q: q, s: s, pi: v, p: p, w: sand(q, s) };
      if (p <= PLIM - 0.8 && v > SAFE_OPT.pi) SAFE_OPT = { q: q, s: s, pi: v, p: p, w: sand(q, s) };
    }
  })();
  var EXP_PI = piTrue(EXP.q, EXP.s), EXP_P = pres(EXP.q, EXP.s), EXP_W = sand(EXP.q, EXP.s);

  /* ================= 2. 工具：随机数 / 颜色 ================= */
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function hex2(rgb, t, b) {
    var r = parseInt(rgb.slice(1, 3), 16), g = parseInt(rgb.slice(3, 5), 16), bl = parseInt(rgb.slice(5, 7), 16);
    r = Math.round(r + (b[0] - r) * t); g = Math.round(g + (b[1] - g) * t); bl = Math.round(bl + (b[2] - bl) * t);
    return 'rgb(' + r + ',' + g + ',' + bl + ')';
  }
  function mix(a, b, t) {
    return hex2(a, Math.max(0, Math.min(1, t)),
      [parseInt(b.slice(1, 3), 16), parseInt(b.slice(3, 5), 16), parseInt(b.slice(5, 7), 16)]);
  }
  function roundColor(g) {
    if (g <= 0) return '#cdd8e2';                 /* 共享初始设计点 */
    return mix('#c8dbd2', '#123a3d', (g - 1) / (MAXROUND - 1));
  }
  function f1(v) { return (Math.round(v * 10) / 10).toFixed(1); }
  function f2(v) { return (Math.round(v * 100) / 100).toFixed(2); }

  /* ================= 3. 代理模型：GP / RBF 回归 ================= */
  var LEN = 0.15;   /* 平方指数核长度尺度（归一化坐标） */
  function kern(a, b) {
    var dx = (a[0] - b[0]) / LEN, dy = (a[1] - b[1]) / LEN;
    return Math.exp(-0.5 * (dx * dx + dy * dy));
  }
  function chol(A, n) {           /* Cholesky 分解 */
    var L = [], i, j, k;
    for (i = 0; i < n; i++) L.push(new Float64Array(n));
    for (i = 0; i < n; i++) for (j = 0; j <= i; j++) {
      var s = A[i][j];
      for (k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) { if (s <= 1e-12) return null; L[i][j] = Math.sqrt(s); }
      else L[i][j] = s / L[j][j];
    }
    return L;
  }
  function fwd(L, b, n) {
    var y = new Float64Array(n);
    for (var i = 0; i < n; i++) { var s = b[i]; for (var k = 0; k < i; k++) s -= L[i][k] * y[k]; y[i] = s / L[i][i]; }
    return y;
  }
  function bwd(L, b, n) {
    var y = new Float64Array(n);
    for (var i = n - 1; i >= 0; i--) { var s = b[i]; for (var k = i + 1; k < n; k++) s -= L[k][i] * y[k]; y[i] = s / L[i][i]; }
    return y;
  }
  /* 拟合：yn 已归一化（零均值单位方差），sn2 为噪声方差（归一化尺度） */
  function gpFit(xs, yn, sn2) {
    var n = xs.length, A = [], i, j;
    for (i = 0; i < n; i++) A.push(new Float64Array(n));
    for (i = 0; i < n; i++) for (j = 0; j < n; j++) A[i][j] = kern(xs[i], xs[j]);
    for (i = 0; i < n; i++) A[i][i] += sn2 + 1e-8;
    var L = chol(A, n); if (!L) return null;
    return { L: L, n: n, xs: xs, alpha: bwd(L, fwd(L, Float64Array.from(yn), n), n) };
  }
  function gpPredN(m, x) {        /* 归一化尺度下的均值与标准差 */
    var k = new Float64Array(m.n), mu = 0, i;
    for (i = 0; i < m.n; i++) { k[i] = kern(x, m.xs[i]); mu += m.alpha[i] * k[i]; }
    var v = fwd(m.L, k, m.n), s = 1;
    for (i = 0; i < m.n; i++) s -= v[i] * v[i];
    return { mu: mu, sd: Math.sqrt(Math.max(1e-4, s)) };
  }
  function ncdf(z) {              /* 标准正态累积分布（A&S 近似） */
    var b1 = 0.319381530, b2 = -0.356563782, b3 = 1.781477937, b4 = -1.821255978, b5 = 1.330274429, p = 0.2316419;
    var t = 1 / (1 + p * Math.abs(z));
    var poly = ((((b5 * t + b4) * t + b3) * t + b2) * t + b1) * t;
    var v = 0.39894228 * Math.exp(-z * z / 2) * poly;
    return z >= 0 ? 1 - v : v;
  }
  function npdf(z) { return 0.3989422804 * Math.exp(-z * z / 2); }

  function xOf(q) { return (q - QLO) / (QHI - QLO); }
  function sOf(s) { return (s - SLO) / (SHI - SLO); }

  /* ================= 4. 三种采样策略 ================= */
  var INIT = [[4.2, 9.5], [5.1, 20.5], [7.4, 10.5], [3.6, 14.0], [6.6, 6.5], [6.8, 12.0]];
  var GRID = [];   /* 7×7 均匀网格，按行扫描；行从高砂比向低砂比 */
  (function buildGrid() {
    for (var j = 6; j >= 0; j--) {
      var s = SLO + (SHI - SLO) * (j + 0.5) / 7;
      for (var i = 0; i < 7; i++) GRID.push([QLO + (QHI - QLO) * (i + 0.5) / 7, s]);
    }
  })();

  var runs = null;
  var SEQ = ['random', 'grid', 'bayes'];

  function freshRun() { return { samples: [], rejected: 0, g: 0, model: null, ybar: 0, ysd: 1, fitN: -1 }; }
  /* g：轮次（0 = 共享初始设计），t：真实值，y：测得值 */
  function push(run, q, s, g, extra) {
    var o = { q: q, s: s, y: measure(q, s), t: piTrue(q, s), g: g };
    if (extra) { o.mu = extra.mu; o.sd = extra.sd; o.ei = extra.ei; }
    run.samples.push(o);
    return o;
  }
  function reset(keepSel) {
    runs = { random: freshRun(), grid: freshRun(), bayes: freshRun() };
    SEQ.forEach(function (k) { INIT.forEach(function (p) { push(runs[k], p[0], p[1], 0); }); });
    state.round = 0;
    state.lastPicks = [];
    render();
  }
  function bestTrue(run) { var b = 0; for (var i = 0; i < run.samples.length; i++) if (run.samples[i].t > b) b = run.samples[i].t; return b; }
  function bestMeas(run) {
    var b = run.samples[0];
    for (var i = 1; i < run.samples.length; i++) if (run.samples[i].y > b.y) b = run.samples[i];
    return b;
  }
  function curveOf(run) {          /* 逐次评估的「至今最优（真实值）」，单调不降 */
    var out = [], b = 0;
    for (var i = 0; i < run.samples.length; i++) { if (run.samples[i].t > b) b = run.samples[i].t; out.push(b); }
    return out;
  }
  function fitRun(run) {
    if (run.fitN === run.samples.length && run.model) return run;
    var xs = run.samples.map(function (p) { return [xOf(p.q), sOf(p.s)]; });
    var ys = run.samples.map(function (p) { return p.y; });
    var ybar = ys.reduce(function (a, b) { return a + b; }, 0) / ys.length;
    var vs = ys.reduce(function (a, b) { return a + (b - ybar) * (b - ybar); }, 0) / ys.length;
    var ysd = Math.max(1e-6, Math.sqrt(vs));
    var sn = (state.noise / 100 / 3) * ybar / ysd;       /* 1σ 相对噪声 = noise/3 %（与 measure 一致） */
    run.model = gpFit(xs, ys.map(function (v) { return (v - ybar) / ysd; }), sn * sn);
    run.ybar = ybar; run.ysd = ysd; run.fitN = run.samples.length;
    return run;
  }
  function predict(run, q, s) {    /* 返回 PI 单位的均值与标准差 */
    fitRun(run);
    if (!run.model) return { mu: piTrue(q, s), sd: 12 };
    var p = gpPredN(run.model, [xOf(q), sOf(s)]);
    return { mu: run.ybar + p.mu * run.ysd, sd: p.sd * run.ysd };
  }
  function tooClose(run, q, s, d) {
    var x = xOf(q), y = sOf(s);
    return run.samples.some(function (p) {
      return Math.hypot(xOf(p.q) - x, sOf(p.s) - y) < d;
    });
  }

  /* 随机采样：抽 3 个可行且不重复的点；不可行/重复的候选计为「被拒」 */
  function addRandom(run, g, rnd) {
    var n = 0, guard = 0;
    while (n < ROUND && guard++ < 600) {
      var q = QLO + rnd() * (QHI - QLO), s = SLO + rnd() * (SHI - SLO);
      if (!feas(q, s) || tooClose(run, q, s, 0.02)) { run.rejected++; continue; }
      push(run, q, s, g); n++;
    }
  }
  /* 网格搜索：按固定 7×7 网格顺序取下一批点 */
  function addGrid(run, g) {
    var n = 0, guard = 0;
    while (n < ROUND && run.g < GRID.length && guard++ < 400) {
      var p = GRID[run.g++];
      if (!feas(p[0], p[1]) || tooClose(run, p[0], p[1], 0.05)) { run.rejected++; continue; }
      push(run, p[0], p[1], g); n++;
    }
  }
  /* 贝叶斯优化：EI 采集函数，候选池只取可行点 */
  function eiPick(run, g) {
    fitRun(run);
    var cs = [], N = 45, i, j;
    for (i = 0; i <= N; i++) for (j = 0; j <= N; j++) {
      var q = QLO + (QHI - QLO) * i / N, s = SLO + (SHI - SLO) * j / N;
      if (!feas(q, s)) continue;
      if (tooClose(run, q, s, 0.035)) continue;
      cs.push([q, s]);
    }
    var picks = [];
    if (!run.model) {              /* 极端兜底：挑离已采点最远的位置 */
      cs.sort(function (a, b) { return (xOf(b[0]) + sOf(b[1])) - (xOf(a[0]) + sOf(a[1])); });
      picks = cs.slice(0, ROUND).map(function (c) { return { q: c[0], s: c[1] }; });
    } else {
      var fbest = -1e9;
      run.samples.forEach(function (p) { var v = (p.y - run.ybar) / run.ysd; if (v > fbest) fbest = v; });
      var scored = cs.map(function (c) {
        var pr = gpPredN(run.model, [xOf(c[0]), sOf(c[1])]);
        var z = (pr.mu - fbest - 0.01) / pr.sd;
        var ei = (pr.mu - fbest - 0.01) * ncdf(z) + pr.sd * npdf(z);
        return { q: c[0], s: c[1], mu: run.ybar + pr.mu * run.ysd, sd: pr.sd * run.ysd, ei: ei * run.ysd };
      });
      scored.sort(function (a, b) { return b.ei - a.ei; });
      for (i = 0; i < scored.length && picks.length < ROUND; i++) {
        var c = scored[i];
        var far = picks.every(function (p) { return Math.hypot(xOf(p.q) - xOf(c.q), sOf(p.s) - sOf(c.s)) >= 0.10; });
        if (far) picks.push(c);
      }
    }
    run.picks = picks;
    picks.forEach(function (c) { push(run, c.q, c.s, g, c); });
    return picks;
  }

  /* 一轮：三种策略各评估 3 个新点（同一评估次数下可直接比高低） */
  function advanceRaw() {
    if (state.round >= MAXROUND) return false;
    state.round++;
    addRandom(runs.random, state.round, mulberry32(777 + state.round * 7919));
    addGrid(runs.grid, state.round);
    var picks = eiPick(runs.bayes, state.round);
    state.lastPicks = picks;
    return true;
  }

  /* ================= 5. 绘图：响应面 ================= */
  var W = 680, H = 430, PL = 56, PR = 18, PT = 24, PB = 46;
  var PW = W - PL - PR, PH = H - PT - PB;
  function px(q) { return PL + (q - QLO) / (QHI - QLO) * PW; }
  function py(s) { return (H - PB) - (s - SLO) / (SHI - SLO) * PH; }
  function sx(v) { return Math.round(v * 10) / 10; }

  var COLS = ['#f8fbfa', '#eef6f2', '#e7eee9', '#d1e8de', '#bcdccf', '#a1d1be', '#82c0aa', '#5ea892', '#4f7a72', '#1d4e50'];
  var LVLS = [50, 60, 70, 80, 90, 96];

  /* 手写 marching squares：把等值线拼成 path */
  function contourPath(vals, nx, ny, lvl, xfn, yfn) {
    var d = '', j, i;
    function cross(va, vb, xa, ya, xb, yb) {
      var t = (lvl - va) / (vb - va);
      return [sx(xa + (xb - xa) * t), sx(ya + (yb - ya) * t)];
    }
    for (j = 0; j < ny - 1; j++) for (i = 0; i < nx - 1; i++) {
      var v00 = vals[j * nx + i], v10 = vals[j * nx + i + 1], v11 = vals[(j + 1) * nx + i + 1], v01 = vals[(j + 1) * nx + i];
      var x0 = xfn(i / (nx - 1)), x1 = xfn((i + 1) / (nx - 1));
      var y0 = yfn(j / (ny - 1)), y1 = yfn((j + 1) / (ny - 1));
      var p = [];
      if ((v00 - lvl) * (v10 - lvl) < 0) p.push(cross(v00, v10, x0, y0, x1, y0));
      if ((v10 - lvl) * (v11 - lvl) < 0) p.push(cross(v10, v11, x1, y0, x1, y1));
      if ((v11 - lvl) * (v01 - lvl) < 0) p.push(cross(v11, v01, x1, y1, x0, y1));
      if ((v01 - lvl) * (v00 - lvl) < 0) p.push(cross(v01, v00, x0, y1, x0, y0));
      if (p.length === 2) d += 'M' + p[0][0] + ' ' + p[0][1] + 'L' + p[1][0] + ' ' + p[1][1];
      else if (p.length === 4) {
        var vc = (v00 + v10 + v11 + v01) / 4;
        if (vc >= lvl) { d += 'M' + p[0][0] + ' ' + p[0][1] + 'L' + p[1][0] + ' ' + p[1][1]; d += 'M' + p[2][0] + ' ' + p[2][1] + 'L' + p[3][0] + ' ' + p[3][1]; }
        else { d += 'M' + p[1][0] + ' ' + p[1][1] + 'L' + p[2][0] + ' ' + p[2][1]; d += 'M' + p[3][0] + ' ' + p[3][1] + 'L' + p[0][0] + ' ' + p[0][1]; }
      }
    }
    return d;
  }
  /* 归一化坐标 → 屏幕坐标 */
  function cx(t) { return PL + t * PW; }
  function cy(t) { return (H - PB) - t * PH; }

  function drawContour() {
    var st = state.selected, run = runs[st];
    var s = '', i, j;
    var NX = 31, NY = 27, gi, gj;
    var nodes = [], nodeMin = 1e9, nodeMax = -1e9;
    for (gj = 0; gj < NY; gj++) for (gi = 0; gi < NX; gi++) {
      var qq = QLO + (QHI - QLO) * gi / (NX - 1), ss = SLO + (SHI - SLO) * gj / (NY - 1);
      var vv = piTrue(qq, ss);
      nodes.push(vv);
      if (vv < nodeMin) nodeMin = vv;
      if (vv > nodeMax) nodeMax = vv;
    }
    var vmin = Math.max(0, nodeMin), vmax = nodeMax;

    /* ① 数值着色网格 */
    var CX = 64, CY = 52, cw = PW / CX, ch = PH / CY;
    if (state.showTrue) {
      for (j = 0; j < CY; j++) for (i = 0; i < CX; i++) {
        var q1 = QLO + (QHI - QLO) * (i + 0.5) / CX, s1 = SLO + (SHI - SLO) * (j + 0.5) / CY;
        var v = (piTrue(q1, s1) - vmin) / Math.max(1e-6, vmax - vmin);
        var ci = Math.min(COLS.length - 1, Math.max(0, Math.floor(v * COLS.length)));
        s += "<rect x='" + sx(PL + i * cw) + "' y='" + sx(H - PB - (j + 1) * ch) + "' width='" + sx(cw + 0.8) + "' height='" + sx(ch + 0.8) + "' fill='" + COLS[ci] + "'/>";
      }
    } else {
      s += "<rect x='" + PL + "' y='" + PT + "' width='" + PW + "' height='" + PH + "' fill='#fbfaf7'/>";
    }

    /* ② 不可行区（施工压力超限） */
    if (state.showFeas) {
      for (j = 0; j < CY; j++) for (i = 0; i < CX; i++) {
        var q2 = QLO + (QHI - QLO) * (i + 0.5) / CX, s2 = SLO + (SHI - SLO) * (j + 0.5) / CY;
        if (pres(q2, s2) > PLIM) s += "<rect x='" + sx(PL + i * cw) + "' y='" + sx(H - PB - (j + 1) * ch) + "' width='" + sx(cw + 0.8) + "' height='" + sx(ch + 0.8) + "' fill='rgba(192,118,43,.16)'/>";
      }
    }

    /* ③ 真实等值线 */
    if (state.showTrue) LVLS.forEach(function (lv, k) {
      s += "<path d='" + contourPath(nodes, NX, NY, lv, cx, cy) + "' fill='none' stroke='#1d4e50' stroke-width='" + (k === LVLS.length - 1 ? 1.15 : 0.75) + "' opacity='" + (k === LVLS.length - 1 ? 0.42 : 0.22) + "'/>";
    });

    /* ④ 代理预测面（GP 后验均值） */
    if (state.showProxy) {
      var mp = [], mmin = 1e9, mmax = -1e9;
      fitRun(run);
      for (gj = 0; gj < NX; gj++) for (gi = 0; gi < NX; gi++) {
        var qq2 = QLO + (QHI - QLO) * gi / (NX - 1), ss2 = SLO + (SHI - SLO) * gj / (NX - 1);
        var pp = predict(run, qq2, ss2).mu;
        mp.push(pp); if (pp < mmin) mmin = pp; if (pp > mmax) mmax = pp;
      }
      LVLS.forEach(function (lv) {
        if (lv < mmin - 2 || lv > mmax + 2) return;
        s += "<path d='" + contourPath(mp, NX, NX, lv, cx, cy) + "' fill='none' stroke='#355c74' stroke-width='0.9' stroke-dasharray='4 3' opacity='0.5'/>";
      });
    }

    /* ⑤ 压力上限边界线 */
    if (state.showFeas) {
      var bd = '', open = false;
      for (i = 0; i <= 90; i++) {
        var q3 = QLO + (QHI - QLO) * i / 90;
        if (pres(q3, SHI) <= PLIM) { open = false; continue; }
        var lo = SLO, hi = SHI;
        for (var it = 0; it < 26; it++) { var mid = (lo + hi) / 2; if (pres(q3, mid) > PLIM) hi = mid; else lo = mid; }
        var yy = py(lo);
        bd += (open ? 'L' : 'M') + sx(px(q3)) + ' ' + sx(yy); open = true;
      }
      s += "<path d='" + bd + "' fill='none' stroke='#a9742c' stroke-width='1.4'/>";
      s += "<text x='" + sx(px(6.75)) + "' y='" + sx(py(19.4)) + "' font-size='9.5' fill='#83551f' text-anchor='middle'>施工压力 &gt; 76 MPa · 不可行</text>";
    }

    /* ⑥ 坐标轴与网格 */
    s += "<rect x='" + PL + "' y='" + PT + "' width='" + PW + "' height='" + PH + "' fill='none' stroke='#d3c9b6'/>";
    for (i = QLO; i <= QHI; i++) {
      s += "<line x1='" + sx(px(i)) + "' y1='" + PT + "' x2='" + sx(px(i)) + "' y2='" + (H - PB) + "' stroke='#efece1'/>";
      s += "<text x='" + sx(px(i)) + "' y='" + (H - PB + 15) + "' font-size='9.5' fill='#99a3a4' text-anchor='middle' font-family='monospace'>" + i + "</text>";
    }
    for (j = SLO; j <= SHI; j += 5) {
      s += "<line x1='" + PL + "' y1='" + sx(py(j)) + "' x2='" + (W - PR) + "' y2='" + sx(py(j)) + "' stroke='#efece1'/>";
      s += "<text x='" + (PL - 9) + "' y='" + sx(py(j) + 3.5) + "' font-size='9.5' fill='#99a3a4' text-anchor='end' font-family='monospace'>" + j + "</text>";
    }
    s += "<text x='" + (PL - 9) + "' y='" + (PT - 8) + "' font-size='9.5' fill='#6f7a7c' text-anchor='end'>砂比 S / %</text>";
    s += "<text x='" + (W - PR) + "' y='" + (H - PB + 30) + "' font-size='9.5' fill='#6f7a7c' text-anchor='end'>排量 Q / m³·min⁻¹</text>";
    /* 色标 */
    s += "<text x='" + PL + "' y='" + (H - PB + 30) + "' font-size='9' fill='#99a3a4'>产能指数 PI</text>";
    for (i = 0; i < COLS.length; i++) {
      s += "<rect x='" + (PL + 66 + i * 15) + "' y='" + (H - PB + 21) + "' width='15' height='7' fill='" + COLS[i] + "' stroke='#ffffff' stroke-width='0.5'/>";
    }
    s += "<text x='" + (PL + 66 + COLS.length * 15 + 6) + "' y='" + (H - PB + 28) + "' font-size='9' fill='#99a3a4' font-family='monospace'>" + Math.round(vmin) + ' → ' + Math.round(vmax) + "</text>";

    /* ⑦ 采样点：按轮次着色 */
    run.samples.forEach(function (p) {
      if (p.g === 0) return;
      s += "<circle cx='" + sx(px(p.q)) + "' cy='" + sx(py(p.s)) + "' r='3.4' fill='" + roundColor(p.g) + "' stroke='#ffffff' stroke-width='0.9'/>";
    });
    run.samples.forEach(function (p) {
      if (p.g !== 0) return;
      s += "<circle cx='" + sx(px(p.q)) + "' cy='" + sx(py(p.s)) + "' r='3.2' fill='#cdd8e2' stroke='#ffffff' stroke-width='0.9'/>";
    });

    /* ⑧ 邻井经验方案 */
    var ep = px(EXP.q), es = py(EXP.s);
    s += "<path d='M" + sx(ep) + " " + sx(es - 5.4) + "L" + sx(ep + 5.4) + " " + sx(es) + "L" + sx(ep) + " " + sx(es + 5.4) + "L" + sx(ep - 5.4) + " " + sx(es) + "Z' fill='none' stroke='#a64b3c' stroke-width='1.5'/>";
    s += "<text x='" + sx(ep - 8) + "' y='" + sx(es + 12) + "' font-size='9.5' fill='#a64b3c' text-anchor='end'>邻井经验方案</text>";

    /* ⑨ 推荐点：星标 + 十字线 */
    var rec = bestMeas(run), rx = px(rec.q), ry = py(rec.s);
    s += "<line x1='" + sx(rx) + "' y1='" + sx(ry) + "' x2='" + sx(rx) + "' y2='" + (H - PB) + "' stroke='#a9742c' stroke-width='1' stroke-dasharray='3 3' opacity='0.75'/>";
    s += "<line x1='" + PL + "' y1='" + sx(ry) + "' x2='" + sx(rx) + "' y2='" + sx(ry) + "' stroke='#a9742c' stroke-width='1' stroke-dasharray='3 3' opacity='0.75'/>";
    var star = '', k;
    for (k = 0; k < 10; k++) {
      var ang = -Math.PI / 2 + k * Math.PI / 5, rr = (k % 2 === 0) ? 7.6 : 3.2;
      star += (k ? 'L' : 'M') + sx(rx + rr * Math.cos(ang)) + ' ' + sx(ry + rr * Math.sin(ang));
    }
    s += "<path d='" + star + "Z' fill='#a9742c' stroke='#ffffff' stroke-width='1.2'/>";
    s += "<text x='" + sx(rx + 8) + "' y='" + sx(ry - 16) + "' font-size='9.5' font-family='monospace' fill='#8a5718' stroke='#fdfbf5' stroke-width='3' paint-order='stroke'>推荐 Q=" + f2(rec.q) + " / S=" + f1(rec.s) + "</text>";
    s += "<text x='" + sx(rx - 4) + "' y='" + (H - PB + 15) + "' font-size='9' font-family='monospace' fill='#83551f' text-anchor='middle'>" + f2(rec.q) + "</text>";
    s += "<text x='" + (PL - 9) + "' y='" + sx(ry + 3) + "' font-size='9' font-family='monospace' fill='#83551f' text-anchor='end'>" + f1(rec.s) + "</text>";

    document.getElementById('contour').innerHTML = s;
    var hint = document.getElementById('c-hint');
    if (hint) hint.textContent = '第 ' + state.round + ' 轮 · 已评估 ' + run.samples.length + ' 点（' + nameOf(st) + '）';
  }

  function nameOf(k) { return k === 'bayes' ? '贝叶斯优化' : k === 'grid' ? '网格搜索' : '随机采样'; }

  /* ================= 6. 绘图：收敛曲线 ================= */
  function drawConv() {
    var L = 48, R = 104, T = 22, B = 38, PW2 = W - L - R, PH2 = 240 - T - B;
    var yMin = 30, yMax = 105;
    function X(n) { return L + n / MAXN * PW2; }
    function Y(v) { return (240 - B) - (v - yMin) / (yMax - yMin) * PH2; }
    var s = '';
    var tt;
    for (tt = 30; tt <= 100; tt += 10) {
      s += "<line x1='" + L + "' y1='" + sx(Y(tt)) + "' x2='" + (W - R) + "' y2='" + sx(Y(tt)) + "' stroke='#efece1'/>";
      s += "<text x='" + (L - 8) + "' y='" + sx(Y(tt) + 3.5) + "' font-size='9' fill='#99a3a4' text-anchor='end' font-family='monospace'>" + tt + "</text>";
    }
    for (tt = 0; tt <= MAXN; tt += 5) {
      s += "<line x1='" + sx(X(tt)) + "' y1='" + T + "' x2='" + sx(X(tt)) + "' y2='" + (240 - B) + "' stroke='#efe9dd'/>";
      s += "<text x='" + sx(X(tt)) + "' y='" + (240 - B + 14) + "' font-size='9' fill='#99a3a4' text-anchor='middle' font-family='monospace'>" + tt + "</text>";
    }
    s += "<rect x='" + L + "' y='" + T + "' width='" + sx(X(6) - L) + "' height='" + PH2 + "' fill='#f7f5f0'/>";
    s += "<text x='" + sx((L + X(6)) / 2) + "' y='" + (T + 12) + "' font-size='9' fill='#99a3a4' text-anchor='middle'>共享初始设计 6 点</text>";
    /* 真实最优参考线 */
    s += "<line x1='" + L + "' y1='" + sx(Y(TRUE_OPT.pi)) + "' x2='" + (W - R) + "' y2='" + sx(Y(TRUE_OPT.pi)) + "' stroke='#a9742c' stroke-width='1' stroke-dasharray='5 3' opacity='0.7'/>";
    s += "<text x='" + (L + 6) + "' y='" + sx(Y(TRUE_OPT.pi) - 5) + "' font-size='9.5' fill='#83551f'>真实最优 " + f1(TRUE_OPT.pi) + "（细网格扫描）</text>";
    /* 三条曲线 */
    var col = { random: '#99a3a4', grid: '#a9742c', bayes: '#1d4e50' };
    var wid = { random: 1.6, grid: 1.8, bayes: 2.4 };
    var ends = [];
    SEQ.forEach(function (k) {
      var cv = curveOf(runs[k]), d = '';
      cv.forEach(function (v, m) {
        var n = m + 1;
        if (n < 5) return;
        d += (n === 5 ? 'M' : 'L') + sx(X(n)) + ' ' + sx(Y(v));
      });
      s += "<path d='" + d + "' fill='none' stroke='" + col[k] + "' stroke-width='" + wid[k] + "' stroke-linejoin='round'/>";
      var last = cv[cv.length - 1];
      ends.push({ k: k, v: last, x: X(cv.length), y: Y(last) });
      s += "<circle cx='" + sx(X(cv.length)) + "' cy='" + sx(Y(last)) + "' r='" + (k === 'bayes' ? 3.4 : 2.6) + "' fill='" + col[k] + "'/>";
    });
    /* 当前评估次数竖线 */
    var cn = runs.bayes.samples.length;
    s += "<line x1='" + sx(X(cn)) + "' y1='" + T + "' x2='" + sx(X(cn)) + "' y2='" + (240 - B) + "' stroke='#1d4e50' stroke-width='1' stroke-dasharray='3 3' opacity='0.55'/>";
    s += "<text x='" + sx(X(cn)) + "' y='" + (T - 6) + "' font-size='9' fill='#123a3d' text-anchor='" + (cn > 22 ? 'end' : 'middle') + "'>已评估 " + cn + " 次</text>";
    /* 端部标签，按值排序错开 */
    ends.sort(function (a, b) { return b.v - a.v; });
    var lastY = -1e9;
    ends.forEach(function (e) {
      var ly = Math.max(e.y + 3.5, lastY + 12);
      lastY = ly;
      s += "<text x='" + sx(e.x + 8) + "' y='" + sx(ly) + "' font-size='10' fill='" + col[e.k] + "' font-family='monospace'>" + nameOf(e.k).slice(0, 3) + " " + f1(e.v) + "</text>";
    });
    s += "<text x='" + (W - R) + "' y='" + (240 - B + 28) + "' font-size='9' fill='#99a3a4' text-anchor='end'>已评估模拟次数 →</text>";
    document.getElementById('conv').innerHTML = s;
    var h = document.getElementById('v-hint');
    if (h) h.textContent = '同一起点 · 同一评估次数 · 曲线取真实产能（去噪）';
  }

  /* ================= 7. 绘图：帕累托前沿 ================= */
  function drawPareto() {
    var run = runs[state.selected];
    var L = 36, R = 12, T = 16, B = 32, W2 = 340, H2 = 220;
    var xs = run.samples.map(function (p) { return sand(p.q, p.s); });
    var ys = run.samples.map(function (p) { return p.t; });
    var x0 = Math.min.apply(null, xs.concat([sand(EXP.q, EXP.s), TRUE_OPT.w])) - 1.5;
    var x1 = Math.max.apply(null, xs.concat([sand(EXP.q, EXP.s), TRUE_OPT.w])) + 1.5;
    var y0 = Math.max(0, Math.min.apply(null, ys) - 8), y1 = Math.max.apply(null, ys) + 6;
    function X(v) { return L + (v - x0) / Math.max(1e-6, x1 - x0) * (W2 - L - R); }
    function Y(v) { return (H2 - B) - (v - y0) / Math.max(1e-6, y1 - y0) * (H2 - T - B); }
    var s = '', i;
    for (i = 0; i < 4; i++) {
      var xv = x0 + (x1 - x0) * i / 3, yv = y0 + (y1 - y0) * i / 3;
      s += "<line x1='" + sx(X(xv)) + "' y1='" + T + "' x2='" + sx(X(xv)) + "' y2='" + (H2 - B) + "' stroke='#efe9dd'/>";
      s += "<line x1='" + L + "' y1='" + sx(Y(yv)) + "' x2='" + (W2 - R) + "' y2='" + sx(Y(yv)) + "' stroke='#efe9dd'/>";
      s += "<text x='" + sx(X(xv)) + "' y='" + (H2 - B + 13) + "' font-size='8.5' fill='#99a3a4' text-anchor='middle' font-family='monospace'>" + f1(xv) + "</text>";
      s += "<text x='" + (L - 6) + "' y='" + sx(Y(yv) + 3) + "' font-size='8.5' fill='#99a3a4' text-anchor='end' font-family='monospace'>" + Math.round(yv) + "</text>";
    }
    s += "<text x='" + (L - 24) + "' y='" + (T - 4) + "' font-size='9' fill='#6f7a7c'>PI</text>";
    s += "<text x='" + (W2 - R) + "' y='" + (H2 - B + 24) + "' font-size='9' fill='#6f7a7c' text-anchor='end'>单段砂量 / t</text>";
    /* 非支配前缘 */
    var sorted = run.samples.slice().sort(function (a, b) { return sand(a.q, a.s) - sand(b.q, b.s); });
    var front = [], bv = -1e9, d = '';
    sorted.forEach(function (p) {
      if (p.t > bv) { bv = p.t; front.push(p); }
    });
    front.forEach(function (p, k) {
      d += (k ? 'L' : 'M') + sx(X(sand(p.q, p.s))) + ' ' + sx(Y(p.t));
    });
    s += "<path d='" + d + "' fill='none' stroke='#1d4e50' stroke-width='1.6' opacity='0.75'/>";
    run.samples.forEach(function (p) {
      s += "<circle cx='" + sx(X(sand(p.q, p.s))) + "' cy='" + sx(Y(p.t)) + "' r='2.9' fill='#9ccdb9' stroke='#ffffff' stroke-width='0.7'/>";
    });
    front.forEach(function (p) {
      s += "<circle cx='" + sx(X(sand(p.q, p.s))) + "' cy='" + sx(Y(p.t)) + "' r='2.6' fill='#1d4e50'/>";
    });
    /* 经验方案与推荐 */
    var ex = X(sand(EXP.q, EXP.s)), ey = Y(EXP_PI);
    s += "<path d='M" + sx(ex) + " " + sx(ey - 4.6) + "L" + sx(ex + 4.6) + " " + sx(ey) + "L" + sx(ex) + " " + sx(ey + 4.6) + "L" + sx(ex - 4.6) + " " + sx(ey) + "Z' fill='#ffffff' stroke='#a64b3c' stroke-width='1.4'/>";
    s += "<text x='" + sx(ex + 6) + "' y='" + sx(ey + 11) + "' font-size='9' fill='#a64b3c'>经验方案</text>";
    var rec = bestMeas(run), rx = X(sand(rec.q, rec.s)), ry = Y(rec.t);
    var st = '', k2;
    for (k2 = 0; k2 < 10; k2++) {
      var ang = -Math.PI / 2 + k2 * Math.PI / 5, rr = (k2 % 2 === 0) ? 6.2 : 2.6;
      st += (k2 ? 'L' : 'M') + sx(rx + rr * Math.cos(ang)) + ' ' + sx(ry + rr * Math.sin(ang));
    }
    s += "<path d='" + st + "Z' fill='#a9742c' stroke='#ffffff' stroke-width='1'/>";
    document.getElementById('pareto').innerHTML = s;
  }

  /* ================= 8. 推荐方案卡 / 读数 / 说明 ================= */
  function proxyRmse(run) {
    fitRun(run);
    if (!run.model) return NaN;
    var n = 12, se = 0, cnt = 0, i, j;
    for (i = 0; i <= n; i++) for (j = 0; j <= n; j++) {
      var q = QLO + (QHI - QLO) * i / n, s = SLO + (SHI - SLO) * j / n;
      if (!feas(q, s)) continue;
      var e = predict(run, q, s).mu - piTrue(q, s);
      se += e * e; cnt++;
    }
    return Math.sqrt(se / Math.max(1, cnt));
  }
  function el(id) { return document.getElementById(id); }

  function drawCard() {
    var st = state.selected, run = runs[st];
    var rec = bestMeas(run), pr = predict(run, rec.q, rec.s);
    var dPI = (pr.mu / EXP_PI - 1) * 100, dW = (sand(rec.q, rec.s) / EXP_W - 1) * 100;
    var ok = feas(rec.q, rec.s);
    var h = '';
    h += "<div style='display:flex;align-items:baseline;gap:9px;flex-wrap:wrap'>" +
      "<span class='mono' style='font-size:27px;line-height:1.15;color:var(--jade-d)'>" + f1(pr.mu) + "</span>" +
      "<span style='font-size:11px;color:var(--ink-3)'>预测产能指数 PI（GP 后验均值），95% 区间 <b class='mono'>" +
      f1(pr.mu - 1.96 * pr.sd) + "—" + f1(pr.mu + 1.96 * pr.sd) + "</b>；该点实测 <b class='mono'>" + f1(rec.y) + "</b>（去噪真值 " + f1(rec.t) + "）</span></div>";
    h += "<div style='margin:7px 0 2px;display:flex;gap:6px;flex-wrap:wrap'>" +
      (ok ? "<span class='db ok'>施工压力 " + f1(pres(rec.q, rec.s)) + " MPa · 在窗口内</span>" : "<span class='db bad'>压力越限</span>") +
      "<span class='db plain'>" + (rec.g === 0 ? '来自初始设计' : '第 ' + rec.g + ' 轮命中') + "</span>" +
      "<span class='db " + (st === 'bayes' ? 'ok' : 'warn') + "'>" + nameOf(st) + "</span>" +
      "<span class='db plain'>已评估 " + run.samples.length + " 次</span>" +
      (pr.mu < EXP_PI ? "<span class='db warn'>尚未超过邻井经验方案 · 建议继续迭代</span>" : "") + "</div>";
    h += "<table class='dtable'><thead><tr><th>设计变量</th><th class='num'>推荐</th><th class='num'>邻井经验</th><th class='num'>对比</th></tr></thead><tbody>" +
      "<tr><td>排量 Q</td><td class='num'>" + f2(rec.q) + " m³/min</td><td class='num'>" + f2(EXP.q) + "</td><td class='num'>" + (rec.q / EXP.q * 100 - 100 >= 0 ? '+' : '') + Math.round(rec.q / EXP.q * 100 - 100) + "%</td></tr>" +
      "<tr><td>砂比 S</td><td class='num'>" + f1(rec.s) + " %</td><td class='num'>" + f1(EXP.s) + "</td><td class='num'>" + f1(rec.s - EXP.s) + " pt</td></tr>" +
      "<tr><td>单段砂量</td><td class='num'>" + f1(sand(rec.q, rec.s)) + " t</td><td class='num'>" + f1(EXP_W) + "</td><td class='num'>" + (dW >= 0 ? '+' : '') + f1(dW) + "%</td></tr>" +
      "<tr><td>施工压力</td><td class='num'>" + f1(pres(rec.q, rec.s)) + " MPa</td><td class='num'>" + f1(EXP_P) + "</td><td class='num'>上限 " + PLIM + "</td></tr>" +
      "<tr><td>产能指数 PI</td><td class='num'><b>" + f1(pr.mu) + "</b></td><td class='num'>" + f1(EXP_PI) + "</td><td class='num'><b style='color:" + (dPI >= 0 ? 'var(--ok)' : 'var(--bad)') + "'>" + (dPI >= 0 ? '+' : '') + Math.round(dPI) + "%</b></td></tr>" +
      "</tbody></table>";
    h += "<div style='margin-top:8px'>" +
      "<div class='dbar'><span style='min-width:74px'>" + (dPI >= 0 ? '产能提升' : '低于经验方案') + "</span><span class='track'><i style='width:" + Math.max(3, Math.min(100, Math.abs(dPI) * 2)) + "%;background:" + (dPI >= 0 ? 'var(--jade)' : 'var(--bad)') + "'></i></span><span class='val'>" + (dPI >= 0 ? '+' : '') + Math.round(dPI) + "%</span></div>" +
      "<div class='dbar' style='margin-top:5px'><span style='min-width:74px'>砂量变化</span><span class='track'><i class='" + (dW <= 0 ? '' : 'clay') + "' style='width:" + Math.min(100, 45 + dW * 2) + "%'></i></span><span class='val'>" + (dW >= 0 ? '+' : '') + f1(dW) + "%</span></div>" +
      "</div>";
    h += "<p style='font-size:10.5px;color:var(--ink-4);line-height:1.6;margin-top:8px'>备选方案（留 0.8 MPa 压力余量）：" +
      "<b class='mono' style='color:var(--ink-2)'>Q=" + f2(SAFE_OPT.q) + " / S=" + f1(SAFE_OPT.s) + "</b>，预测 PI <b class='mono'>" + f1(SAFE_OPT.pi) +
      "</b>（比贴限方案低 " + f1(TRUE_OPT.pi - SAFE_OPT.pi) + "），砂量 " + f1(SAFE_OPT.w) + " t；压力余量 0.8 MPa 换取更低的砂堵风险。</p>";
    el('card').innerHTML = h;
    var hint = el('card-hint');
    if (hint) hint.textContent = nameOf(st) + ' · 第 ' + state.round + ' 轮';
  }

  function drawCand() {
    var picks = runs.bayes.picks || [];
    var tb = el('cand'), ft = el('cand-foot');
    if (!picks.length) {
      tb.innerHTML = "<tr><td colspan='5' style='color:var(--ink-4)'>点「运行一轮优化」，这里显示 EI 挑出的 3 个候选点</td></tr>";
      if (ft) ft.innerHTML = '';
      return;
    }
    var fb = 0;
    runs.bayes.samples.forEach(function (p) { if (p.y > fb) fb = p.y; });
    tb.innerHTML = picks.map(function (p) {
      /* EI 的两项：均值项主导 = 利用（预测比现在好），方差项主导 = 探索（没探过的地方） */
      var kind = p.sd <= 0.06 * fb ? "<span class='db ok'>利用</span>" : "<span class='db warn'>探索</span>";
      return "<tr><td>" + f2(p.q) + "</td><td class='num'>" + f1(p.s) + "</td><td class='num'>" + f1(p.mu) + " ± " + f1(1.96 * p.sd) + "</td><td class='num'>" + (p.ei < 0.01 ? '≈0' : f2(p.ei)) + "</td><td>" + kind + "</td></tr>";
    }).join('');
    if (ft) {
      var maxEi = Math.max.apply(null, picks.map(function (p) { return p.ei; }));
      var noisePi = (state.noise / 100 / 3) * Math.abs(runs.bayes.ybar);
      var stop = maxEi < 0.35 * noisePi;
      ft.innerHTML = "本轮最大 EI = <b class='mono'>" + (maxEi < 0.01 ? '≈0' : f2(maxEi)) + "</b>，测量噪声水平约 <b class='mono'>" + f1(noisePi) +
        "</b> PI。" + (stop
          ? "<span class='db ok' style='margin-left:4px'>边际收益已低于噪声 · 可以停</span>"
          : "<span class='db plain' style='margin-left:4px'>仍有可观的改进空间 · 继续迭代</span>") +
        "<div style='margin-top:4px'>EI 是「预期改进量」：它同时看代理模型的均值（哪里可能更好）和方差（哪里还没探过），所以越到后期它越会把点送到压力边界与未采样角落。</div>";
    }
  }

  function updateReadouts() {
    var st = state.selected, run = runs[st];
    var bt = bestTrue(run), rec = bestMeas(run);
    var rmse = proxyRmse(run);
    var gap = (TRUE_OPT.pi - bt) / TRUE_OPT.pi * 100;
    var margin = PLIM - pres(rec.q, rec.s);
    el('st-n').innerHTML = run.samples.length + "<small>次</small>";
    el('st-best').innerHTML = f1(bt);
    el('st-true').innerHTML = f1(TRUE_OPT.pi);
    el('st-rmse').innerHTML = isFinite(rmse) ? f2(rmse) : "—";
    el('r-n').innerHTML = run.samples.length + "<small>次</small>";
    el('r-best').innerHTML = f1(bt);
    el('r-gap').innerHTML = f1(gap) + "<small>%</small>";
    el('r-rmse').innerHTML = isFinite(rmse) ? f2(rmse) + "<small>PI</small>" : "—";
    el('r-margin').innerHTML = f1(margin) + "<small>MPa</small>";
  }

  function noteText() {
    var st = state.selected, run = runs[st];
    var nb = f1(bestTrue(runs.bayes)), ng = f1(bestTrue(runs.grid)), nr = f1(bestTrue(runs.random));
    var rec = bestMeas(run), pr = predict(run, rec.q, rec.s);
    var s = '';
    if (state.round === 0) {
      s += "开局只有 <b>6 个共享初始设计点</b>（蓝色），三种策略从同一份信息出发、每轮各评估 3 个新方案。" +
        "右侧曲线是「已评估次数 → 至今最优产能」，口径统一，才能比出谁更省模拟次数。";
    } else {
      s += "已完成第 <b>" + state.round + "</b> 轮：三种策略各评估 <b>" + run.samples.length + "</b> 次模拟，至今最优产能指数 " +
        "贝叶斯 <b>" + nb + "</b> / 网格 <b>" + ng + "</b> / 随机 <b>" + nr + "</b>（真实响应面口径，去噪）。";
      if (st === 'bayes') {
        s += "当前显示贝叶斯优化：先拟合 GP 代理模型，再用 EI = (μ−f⁺)Φ(z) + σφ(z) 选点——第一项奖励「预测比现在好」，第二项按不确定性加权，" +
          "所以它一边沿脊线收敛、一边去没探过的压力边界附近查看；候选池只从压力 ≤ " + PLIM + " MPa 的点里挑，因此它对约束的无效试探为 <b>0</b> 次" +
          "（随机采样已被约束拒绝 <b>" + runs.random.rejected + "</b> 次、网格 <b>" + runs.grid.rejected + "</b> 次）。";
      } else if (st === 'grid') {
        s += "当前显示网格搜索：7×7 固定网格按行扫描，覆盖均匀但步长受限于网格，越限的网格点被直接丢弃（已弃 " + runs.grid.rejected + " 个）；" +
          "它要走到最优脊线所在的那一行，往往要多花十几次模拟。";
      } else {
        s += "当前显示随机采样：不建模、不做推断，点撒在哪全凭运气；不可行或不重复性差的候选会被拒绝（已弃 " + runs.random.rejected + " 个），" +
          "所以它同样评估 30 次，却常在低产能区来回打转。";
      }
    }
    s += "　推荐点 Q=" + f2(rec.q) + "、S=" + f1(rec.s) + "，预测 PI <b>" + f1(pr.mu) + "</b>（95% 区间 " + f1(pr.mu - 1.96 * pr.sd) + "—" + f1(pr.mu + 1.96 * pr.sd) + "），" +
      "全空间真实最优 " + f1(TRUE_OPT.pi) + "（Q=" + f2(TRUE_OPT.q) + "、S=" + f1(TRUE_OPT.s) + "），当前差距 " + f1((TRUE_OPT.pi - bestTrue(run)) / TRUE_OPT.pi * 100) + "%。";
    s += "　<b>可以试：</b>点「运行一轮优化」看 EI 每轮把点送到哪里；打开「代理预测面」看 GP 后验均值（蓝虚线）与真实脊线的偏差；" +
      "把测量噪声拉到 3%—4%，会让代理模型多花几轮压住噪声；再切到「随机采样」或「网格搜索」，对比同一评估次数下的推荐方案。";
    return s;
  }

  /* ---------- 敏感性龙卷风图 ---------- */
  function drawTornado() {
    var svg = el('tornado');
    if (!svg) return;
    var rec = bestMeas(runs[state.selected]);
    var base = piTrue(rec.q, rec.s);
    var cases = [
      { label: '排量 Q −10%', q: Math.max(QLO, rec.q * 0.9), s: rec.s, col: '#123b3a' },
      { label: '排量 Q +10%', q: Math.min(QHI, rec.q * 1.1), s: rec.s, col: '#123b3a' },
      { label: '砂比 S −10%', q: rec.q, s: Math.max(SLO, rec.s * 0.9), col: '#a86a1f' },
      { label: '砂比 S +10%', q: rec.q, s: Math.min(SHI, rec.s * 1.1), col: '#a86a1f' }
    ];
    cases.forEach(function (c) {
      c.pi = piTrue(c.q, c.s);
      c.d = c.pi - base;
      c.feas = feas(c.q, c.s);
    });
    var maxAbs = Math.max.apply(null, cases.map(function (c) { return Math.abs(c.d); }).concat([1]));
    var W = 340, H = 190, L = 104, R = 14, T = 22, B = 24;
    var cx = L + (W - L - R) / 2;
    var half = (W - L - R) / 2 - 8;
    var s = '';
    /* 零线与轴 */
    s += '<line x1="' + cx + '" y1="' + T + '" x2="' + cx + '" y2="' + (H - B) + '" stroke="#45524d" stroke-width="1"/>';
    s += '<text x="' + cx + '" y="' + (H - B + 14) + '" text-anchor="middle" font-size="8.5" fill="#98a199">基准 PI ' + base.toFixed(1) + '</text>';
    s += '<text x="' + (W - R) + '" y="' + (H - B + 14) + '" text-anchor="end" font-size="8.5" fill="#98a199">PI 变化 →</text>';
    var rowH = 22, gap = 8;
    cases.forEach(function (c, i) {
      var y = T + 8 + i * (rowH + gap);
      var w = Math.max(2, Math.abs(c.d) / maxAbs * half);
      var x = c.d >= 0 ? cx : cx - w;
      s += '<text x="' + (L - 8) + '" y="' + (y + 13) + '" text-anchor="end" font-size="9.5" fill="#45524d">' + c.label + '</text>';
      s += '<rect x="' + x.toFixed(1) + '" y="' + y + '" width="' + w.toFixed(1) + '" height="' + rowH + '" fill="' + c.col + '" opacity=".82"' + (c.feas ? '' : ' stroke="#9c4235" stroke-width="1.2" stroke-dasharray="3 2"') + '/>';
      var val = (c.d >= 0 ? '+' : '') + c.d.toFixed(1);
      /* 长条把数值写在条内，短条写在条外；避免压住左侧类目名 */
      var inside = w > 44;
      var tx, anchor, fill;
      if (c.d >= 0) {
        tx = inside ? x + w - 4 : x + w + 4;
        anchor = inside ? 'end' : 'start';
        fill = inside ? '#fbf8f0' : (c.feas ? c.col : '#9c4235');
      } else {
        tx = inside ? x + 4 : x - 4;
        anchor = inside ? 'start' : 'end';
        fill = inside ? '#fbf8f0' : (c.feas ? c.col : '#9c4235');
      }
      s += '<text x="' + tx + '" y="' + (y + 14) + '" text-anchor="' + anchor + '" font-size="9" font-family="monospace" fill="' + fill + '">' + val + (c.feas ? '' : ' 超压') + '</text>';
    });
    svg.innerHTML = s;
  }

  function render() {
    updateReadouts();
    drawContour();
    drawConv();
    drawPareto();
    drawTornado();
    drawCard();
    drawCand();
    el('note').innerHTML = noteText();
    /* 供自检脚本读取：算法状态快照 */
    window.__OPT__ = {
      round: state.round,
      selected: state.selected,
      n: runs.bayes.samples.length,
      curve: {
        bayes: curveOf(runs.bayes).map(function (v) { return Math.round(v * 100) / 100; }),
        grid: curveOf(runs.grid).map(function (v) { return Math.round(v * 100) / 100; }),
        random: curveOf(runs.random).map(function (v) { return Math.round(v * 100) / 100; })
      },
      picked: SEQ.map(function (k) { var b = bestMeas(runs[k]); return { k: k, q: Math.round(b.q * 1000) / 1000, s: Math.round(b.s * 10) / 10, y: Math.round(b.y * 10) / 10, t: Math.round(b.t * 10) / 10, p: Math.round(pres(b.q, b.s) * 10) / 10, w: Math.round(sand(b.q, b.s) * 100) / 100 }; }),
      trueOpt: { q: Math.round(TRUE_OPT.q * 1000) / 1000, s: Math.round(TRUE_OPT.s * 100) / 100, pi: Math.round(TRUE_OPT.pi * 10) / 10, p: Math.round(TRUE_OPT.p * 10) / 10, w: Math.round(TRUE_OPT.w * 100) / 100 },
      safeOpt: { q: Math.round(SAFE_OPT.q * 1000) / 1000, s: Math.round(SAFE_OPT.s * 100) / 100, pi: Math.round(SAFE_OPT.pi * 10) / 10, p: Math.round(SAFE_OPT.p * 10) / 10 },
      expPlan: { q: EXP.q, s: EXP.s, pi: Math.round(EXP_PI * 10) / 10, p: Math.round(EXP_P * 10) / 10, w: Math.round(EXP_W * 100) / 100 },
      rejected: { bayes: runs.bayes.rejected, grid: runs.grid.rejected, random: runs.random.rejected },
      recFeasible: feas(recSel().q, recSel().s),
      noteLen: el('note').textContent.length
    };
  }
  function recSel() { return bestMeas(runs[state.selected]); }

  /* ================= 9. 控件 ================= */
  var STRAT = [['random', '随机采样'], ['grid', '网格搜索'], ['bayes', '贝叶斯优化']];
  el('seg-strat').innerHTML = STRAT.map(function (p) {
    return "<button data-k='" + p[0] + "' class='" + (state.selected === p[0] ? 'on' : '') + "'>" + p[1] + "</button>";
  }).join('');
  el('seg-strat').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    state.selected = b.getAttribute('data-k');
    [].forEach.call(el('seg-strat').children, function (x) { x.classList.toggle('on', x === b); });
    render();
  });
  el('run').addEventListener('click', function () {
    if (!advanceRaw()) { el('auto').textContent = '已跑满 30 次模拟'; return; }
    render();
  });
  el('auto').addEventListener('click', function () {
    var guard = 0;
    while (state.round < MAXROUND && guard++ < 40) {
      if (!advanceRaw()) break;
      /* 连续两轮真实最优提升 < 0.4% 就认为收敛 */
      if (state.round >= 4) {
        var cv = curveOf(runs.bayes), n = cv.length;
        var imp = (cv[n - 1] - cv[n - 7]) / cv[n - 1] * 100;
        if (imp < 0.4) break;
      }
    }
    render();
  });
  el('reset').addEventListener('click', function () { el('auto').textContent = '自动跑到收敛'; reset(); });

  function tog(id, key) {
    var t = el(id);
    t.addEventListener('click', function () {
      state[key] = !state[key];
      t.classList.toggle('on', state[key]);
      render();
    });
  }
  tog('tog-true', 'showTrue'); tog('tog-proxy', 'showProxy'); tog('tog-feas', 'showFeas');

  el('r-noise').addEventListener('input', function () {
    state.noise = Number(this.value);
    el('o-noise').textContent = f1(state.noise) + ' %';
    el('auto').textContent = '自动跑到收敛';
    reset();
  });

  reset();
})();
