/* =========================================================
   压裂参数智能优化 · 可运行示范（v4 · AI 作业流）
   ---------------------------------------------------------
   这条流水线要回答的不是「最优值是多少」，而是：
     参数空间能不能算 → 代理模型看到了什么 → EI 为什么选这些点
     → 模拟器返回什么 → 什么时候停、交付什么
   ① 参数空间与约束：Q（3—8 m³/min）× S（5—25%），P ≤ 76 MPa；
   ② 初始设计 + 代理：6 个初始点 → 平方指数核 GP（自写 Cholesky），
      给出均值 μ(x) 与标准差 σ(x)；
   ③ EI 采集：EI = (μ−f⁺)Φ(z) + σφ(z)，候选池只取可行点，每轮 Top-3；
   ④ 模拟器评估与回写：解析响应面 + 测量噪声作为模拟器替身，
      真实 PI 回写后重拟合，记录更新前后的代理 RMSE；
   ⑤ 收敛与交付：30 次预算内与网格/随机对照，输出推荐方案、
      预测区间、压力余量备选与帕累托前沿。
   本页响应面与历史井数据均为示范合成口径，不代表某一口真实井。
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
  /* 单段液量 V = Q × 泵注时长；砂量 W = 砂比(体积%) × 视密度 × V。 */
  function fluidVol(q) { return q * PUMP_MIN; }
  function sand(q, s) { return (s / 100) * RHO_P * fluidVol(q); }

  /* 真实响应面：主脊（Q≈6.4、S≈17 附近） + 低排量低砂比的局部次优
     + 轻微非凸起伏。峰值约 96.6，全空间约 5—97。 */
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

  var state = {
    noise: 1.5, selected: 'bayes', stage: 0,
    showTrue: true, showProxy: false, showFeas: true, running: false
  };

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

  /* ================= 2. 工具 ================= */
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
    if (g <= 0) return '#cdd8e2';
    return mix('#c8dbd2', '#123a3d', (g - 1) / (MAXROUND - 1));
  }
  function f1(v) { return (Math.round(v * 10) / 10).toFixed(1); }
  function f2(v) { return (Math.round(v * 100) / 100).toFixed(2); }
  function el(id) { return document.getElementById(id); }
  function nameOf(k) { return k === 'bayes' ? '贝叶斯优化' : k === 'grid' ? '网格搜索' : '随机采样'; }

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
  var pendingPicks = [];
  var pendingN = 0;
  var lastRound = null;
  var initialSnapshot = null;
  var fb = { ok: 0, fix: 0 };
  var SEQ = ['random', 'grid', 'bayes'];

  function freshRun() { return { samples: [], rejected: 0, g: 0, model: null, ybar: 0, ysd: 1, fitN: -1 }; }
  /* g：轮次（0 = 共享初始设计），t：真实值，y：测得值 */
  function push(run, q, s, g, extra) {
    var o = { q: q, s: s, y: measure(q, s), t: piTrue(q, s), g: g };
    if (extra) { o.mu = extra.mu; o.sd = extra.sd; o.ei = extra.ei; }
    run.samples.push(o);
    return o;
  }
  function bestTrue(run) { var b = 0; for (var i = 0; i < run.samples.length; i++) if (run.samples[i].t > b) b = run.samples[i].t; return b; }
  function bestTrueSample(run) {
    var b = run.samples[0];
    for (var i = 1; i < run.samples.length; i++) if (run.samples[i].t > b.t) b = run.samples[i];
    return b;
  }
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
  function n95Of(run) {
    var cv = curveOf(run), thr = TRUE_OPT.pi * 0.95;
    for (var i = 0; i < cv.length; i++) if (cv[i] >= thr) return i + 1;
    return null;
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

  /* 贝叶斯优化：EI 采集函数，候选池只取可行点。只选点，不评估。 */
  function eiCandidates(run) {
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
      picks = cs.slice(0, ROUND).map(function (c) { return { q: c[0], s: c[1], mu: 0, sd: 0, ei: 0 }; });
      return picks;
    }
    var fbest = -1e9;
    run.samples.forEach(function (p) { var v = (p.y - run.ybar) / run.ysd; if (v > fbest) fbest = v; });
    var scored = cs.map(function (c) {
      var pr = gpPredN(run.model, [xOf(c[0]), sOf(c[1])]);
      var diff = pr.mu - fbest - 0.01;
      var z = diff / pr.sd;
      var exr = diff * ncdf(z);           /* 利用项：预测比现在好 */
      var exl = pr.sd * npdf(z);          /* 探索项：不确定性大 */
      return {
        q: c[0], s: c[1],
        mu: run.ybar + pr.mu * run.ysd,
        sd: pr.sd * run.ysd,
        ei: (exr + exl) * run.ysd,
        exr: exr * run.ysd, exl: exl * run.ysd
      };
    });
    scored.sort(function (a, b) { return b.ei - a.ei; });
    for (i = 0; i < scored.length && picks.length < ROUND; i++) {
      var c = scored[i];
      var far = picks.every(function (p) { return Math.hypot(xOf(p.q) - xOf(c.q), sOf(p.s) - sOf(c.s)) >= 0.10; });
      if (far) picks.push(c);
    }
    if (picks.length < ROUND) {          /* 间距过严时按 EI 顺序补齐 */
      for (i = 0; i < scored.length && picks.length < ROUND; i++) {
        if (picks.indexOf(scored[i]) < 0) picks.push(scored[i]);
      }
    }
    run.picks = picks;
    return picks;
  }

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

  /* 执行一轮：用上一轮 EI 选出的 3 个点送模拟器，回写并重拟合。
     同时推进网格/随机对照，保证同一评估次数可直接比较。 */
  function advanceRound() {
    if (state.round >= MAXROUND) return false;
    if (!pendingPicks.length) pendingPicks = eiCandidates(runs.bayes);
    var rmseBefore = proxyRmse(runs.bayes);
    var nBefore = runs.bayes.samples.length;
    state.round++;
    var g = state.round;
    var picks = pendingPicks;
    var pts = picks.map(function (c) { return push(runs.bayes, c.q, c.s, g, c); });
    addRandom(runs.random, g, mulberry32(777 + g * 7919));
    addGrid(runs.grid, g);
    runs.bayes.fitN = -1;
    fitRun(runs.bayes);
    var rmseAfter = proxyRmse(runs.bayes);
    lastRound = {
      g: g, pts: pts, rmseBefore: rmseBefore, rmseAfter: rmseAfter,
      nBefore: nBefore, nAfter: runs.bayes.samples.length
    };
    if (state.round < MAXROUND) {
      pendingPicks = eiCandidates(runs.bayes);
      pendingN = runs.bayes.samples.length;
    } else {
      /* 预算跑满后仍按当前 GP 重算一批「如果还有预算」的候选：
         EI≈0 时正好用来说明停止判据；候选与主画布的 EI 面保持同一模型。 */
      pendingPicks = eiCandidates(runs.bayes);
      pendingN = runs.bayes.samples.length;
    }
    return true;
  }

  /* 6 个初始设计点 + 初始 GP 快照（阶段 02 固定显示这张图） */
  function buildInitialSnapshot() {
    fitRun(runs.bayes);
    var NX = 14, NY = 11, mu = [], sd = [], i, j;
    var mmin = 1e9, mmax = -1e9, smax = 0, ssum = 0, cnt = 0;
    for (j = 0; j < NY; j++) for (i = 0; i < NX; i++) {
      var q = QLO + (QHI - QLO) * i / (NX - 1);
      var s = SLO + (SHI - SLO) * j / (NY - 1);
      var p = predict(runs.bayes, q, s);
      mu.push(p.mu); sd.push(p.sd);
      if (p.mu < mmin) mmin = p.mu;
      if (p.mu > mmax) mmax = p.mu;
      if (p.sd > smax) smax = p.sd;
      ssum += p.sd; cnt++;
    }
    return {
      rmse: proxyRmse(runs.bayes), mu: mu, sd: sd, NX: NX, NY: NY,
      muMin: mmin, muMax: mmax, sdMax: smax, meanSd: ssum / cnt,
      n: runs.bayes.samples.length,
      model: runs.bayes.model, ybar: runs.bayes.ybar, ysd: runs.bayes.ysd
    };
  }

  function resetRuns() {
    runs = { random: freshRun(), grid: freshRun(), bayes: freshRun() };
    SEQ.forEach(function (k) { INIT.forEach(function (p) { push(runs[k], p[0], p[1], 0); }); });
    state.round = 0;
    lastRound = null;
    pendingPicks = [];
    initialSnapshot = buildInitialSnapshot();
    pendingPicks = eiCandidates(runs.bayes);
    pendingN = runs.bayes.samples.length;
  }

  /* 可行性统计（固定，只算一次） */
  var FEAS = (function () {
    var ok = 0, total = 0, i, j;
    for (i = 0; i <= 80; i++) for (j = 0; j <= 60; j++) {
      total++;
      if (feas(QLO + (QHI - QLO) * i / 80, SLO + (SHI - SLO) * j / 60)) ok++;
    }
    var lo = QLO, hi = QHI;
    for (i = 0; i < 40; i++) {
      var mid = (lo + hi) / 2;
      if (feas(mid, SHI)) lo = mid; else hi = mid;
    }
    return { ok: ok, total: total, pct: Math.round(ok / total * 100), qMaxSHI: lo };
  })();

  /* ================= 5. 绘图：响应面 ================= */
  var W = 680, H = 360, PL = 56, PR = 18, PT = 24, PB = 46;
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

  /* EI 面：只在阶段 03 计算，按模型对象缓存 */
  var eiCache = { model: null, grid: null };
  function eiSurface(run) {
    fitRun(run);
    if (!run.model) return null;
    if (eiCache.model === run.model && eiCache.grid) return eiCache.grid;
    var NX = 32, NY = 27, vals = [], max = 0, i, j;
    var fbest = -1e9;
    run.samples.forEach(function (p) { var v = (p.y - run.ybar) / run.ysd; if (v > fbest) fbest = v; });
    for (j = 0; j < NY; j++) for (i = 0; i < NX; i++) {
      var q = QLO + (QHI - QLO) * i / (NX - 1);
      var s = SLO + (SHI - SLO) * j / (NY - 1);
      var ei = 0;
      if (feas(q, s)) {
        var pr = gpPredN(run.model, [xOf(q), sOf(s)]);
        var diff = pr.mu - fbest - 0.01;
        var z = diff / pr.sd;
        ei = (diff * ncdf(z) + pr.sd * npdf(z)) * run.ysd;
      }
      vals.push(ei);
      if (ei > max) max = ei;
    }
    var g = { v: vals, NX: NX, NY: NY, max: max };
    eiCache.model = run.model; eiCache.grid = g;
    return g;
  }

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

    /* ④ GP 后验均值（阶段 02 固定显示初始 6 点模型，其余阶段由开关控制） */
    if (state.showProxy || state.stage === 1) {
      var mp = [], mmin = 1e9, mmax = -1e9;
      fitRun(run);
      var useInitial = state.stage === 1 && initialSnapshot && initialSnapshot.model;
      var pmodel = useInitial ? initialSnapshot.model : run.model;
      var pybar = useInitial ? initialSnapshot.ybar : run.ybar;
      var pysd = useInitial ? initialSnapshot.ysd : run.ysd;
      for (gj = 0; gj < NY; gj++) for (gi = 0; gi < NX; gi++) {
        var qq2 = QLO + (QHI - QLO) * gi / (NX - 1), ss2 = SLO + (SHI - SLO) * gj / (NY - 1);
        var pp;
        if (useInitial && pmodel) {
          var prn = gpPredN(pmodel, [xOf(qq2), sOf(ss2)]);
          pp = pybar + prn.mu * pysd;
        } else {
          pp = predict(run, qq2, ss2).mu;
        }
        mp.push(pp); if (pp < mmin) mmin = pp; if (pp > mmax) mmax = pp;
      }
      LVLS.forEach(function (lv) {
        if (lv < mmin - 2 || lv > mmax + 2) return;
        s += "<path d='" + contourPath(mp, NX, NY, lv, cx, cy) + "' fill='none' stroke='#355c74' stroke-width='1.05' stroke-dasharray='4 3' opacity='0.62'/>";
      });
      s += "<text x='" + sx(PL + PW - 6) + "' y='" + sx(PT + 12) + "' font-size='9' fill='#355c74' text-anchor='end'>GP 均值（虚线" + (useInitial ? ' · 初始 6 点' : '') + "）</text>";
    }

    /* ⑤ EI 面（阶段 03） */
    if (state.stage === 2) {
      var eg = eiSurface(runs.bayes);
      if (eg && eg.max > 0) {
        var ew = PW / (eg.NX - 1), eh = PH / (eg.NY - 1);
        for (j = 0; j < eg.NY - 1; j++) for (i = 0; i < eg.NX - 1; i++) {
          var ev = eg.v[j * eg.NX + i];
          if (ev < eg.max * 0.03) continue;
          var al = 0.06 + 0.48 * Math.pow(ev / eg.max, 0.8);
          s += "<rect x='" + sx(PL + i * ew) + "' y='" + sx(H - PB - (j + 1) * eh) + "' width='" + sx(ew + 0.6) + "' height='" + sx(eh + 0.6) + "' fill='rgba(53,92,116," + al.toFixed(3) + ")'/>";
        }
        s += "<path d='" + contourPath(eg.v, eg.NX, eg.NY, eg.max * 0.55, cx, cy) + "' fill='none' stroke='#355c74' stroke-width='1.1' stroke-dasharray='5 3' opacity='0.85'/>";
        s += "<path d='" + contourPath(eg.v, eg.NX, eg.NY, eg.max * 0.82, cx, cy) + "' fill='none' stroke='#1f3f55' stroke-width='1.3' opacity='0.9'/>";
        s += "<text x='" + sx(PL + 6) + "' y='" + sx(PT + 13) + "' font-size='9.5' font-family='monospace' fill='#2b4d63' stroke='#fbfaf7' stroke-width='3' paint-order='stroke'>EI 面 · 越深越值得模拟</text>";
      }
    }

    /* ⑥ 压力上限边界线 */
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
      s += "<text x='" + sx(px(7.45)) + "' y='" + sx(py(22.3)) + "' font-size='9.5' fill='#83551f' text-anchor='middle' stroke='#fdfbf5' stroke-width='3' paint-order='stroke'>施工压力 &gt; 76 MPa · 不可行</text>";
    }

    /* ⑦ 坐标轴与网格 */
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

    /* ⑧ 采样点：按轮次着色（阶段 02 只看初始 6 点快照） */
    var onlyInitial = state.stage === 1;
    run.samples.forEach(function (p) {
      if (onlyInitial && p.g !== 0) return;
      if (p.g === 0) return;
      s += "<circle cx='" + sx(px(p.q)) + "' cy='" + sx(py(p.s)) + "' r='3.4' fill='" + roundColor(p.g) + "' stroke='#ffffff' stroke-width='0.9'/>";
    });
    run.samples.forEach(function (p) {
      if (onlyInitial && p.g !== 0) return;
      if (p.g !== 0) return;
      s += "<circle cx='" + sx(px(p.q)) + "' cy='" + sx(py(p.s)) + "' r='3.2' fill='#cdd8e2' stroke='#ffffff' stroke-width='0.9'/>";
    });

    /* ⑨ 邻井经验方案 */
    var ep = px(EXP.q), es = py(EXP.s);
    s += "<path d='M" + sx(ep) + " " + sx(es - 5.4) + "L" + sx(ep + 5.4) + " " + sx(es) + "L" + sx(ep) + " " + sx(es + 5.4) + "L" + sx(ep - 5.4) + " " + sx(es) + "Z' fill='none' stroke='#a64b3c' stroke-width='1.5'/>";
    s += "<text x='" + sx(ep - 8) + "' y='" + sx(es + 12) + "' font-size='9.5' fill='#a64b3c' text-anchor='end'>邻井经验方案</text>";

    /* ⑩ 推荐点：星标 + 十字线（阶段 02 用初始 6 点里的最好点） */
    var rec;
    if (onlyInitial) {
      var ini = run.samples.filter(function (p) { return p.g === 0; });
      rec = ini.reduce(function (a, b) { return b.y > a.y ? b : a; }, ini[0]);
    } else {
      rec = bestMeas(run);
    }
    var rx = px(rec.q), ry = py(rec.s);
    s += "<line x1='" + sx(rx) + "' y1='" + sx(ry) + "' x2='" + sx(rx) + "' y2='" + (H - PB) + "' stroke='#a9742c' stroke-width='1' stroke-dasharray='3 3' opacity='0.75'/>";
    s += "<line x1='" + PL + "' y1='" + sx(ry) + "' x2='" + sx(rx) + "' y2='" + sx(ry) + "' stroke='#a9742c' stroke-width='1' stroke-dasharray='3 3' opacity='0.75'/>";
    var star = '', k;
    for (k = 0; k < 10; k++) {
      var ang = -Math.PI / 2 + k * Math.PI / 5, rr = (k % 2 === 0) ? 7.6 : 3.2;
      star += (k ? 'L' : 'M') + sx(rx + rr * Math.cos(ang)) + ' ' + sx(ry + rr * Math.sin(ang));
    }
    s += "<path d='" + star + "Z' fill='#a9742c' stroke='#ffffff' stroke-width='1.2'/>";
    var lx = rx + 8, anchor = 'start';
    if (rx > W - PR - 118) { lx = rx - 8; anchor = 'end'; }
    var recLabel = state.stage === 4 ? '推荐' : state.stage === 1 ? '初始最好' : '当前最好';
    s += "<text x='" + sx(lx) + "' y='" + sx(ry - 16) + "' font-size='9.5' font-family='monospace' fill='#8a5718' stroke='#fdfbf5' stroke-width='3' paint-order='stroke' text-anchor='" + anchor + "'>" + recLabel + " Q=" + f2(rec.q) + " / S=" + f1(rec.s) + "</text>";

    /* ⑪ 阶段 03：Top-3 候选 */
    if (state.stage === 2 && pendingPicks.length) {
      pendingPicks.forEach(function (p, idx) {
        var cx0 = px(p.q), cy0 = py(p.s);
        s += "<circle cx='" + sx(cx0) + "' cy='" + sx(cy0) + "' r='8.4' fill='#a9742c' stroke='#ffffff' stroke-width='1.6'/>";
        s += "<text x='" + sx(cx0) + "' y='" + sx(cy0 + 3.2) + "' font-size='9' font-family='monospace' fill='#ffffff' text-anchor='middle'>" + (idx + 1) + "</text>";
      });
      s += "<text x='" + sx(PL + 6) + "' y='" + sx(H - PB - 8) + "' font-size='9' font-family='monospace' fill='#83551f' stroke='#fbfaf7' stroke-width='3' paint-order='stroke'>Top-3 候选（待评估）</text>";
    }

    /* ⑫ 阶段 04：本轮已回写的 3 个点 */
    if (state.stage === 3 && lastRound) {
      lastRound.pts.forEach(function (p, idx) {
        var cx1 = px(p.q), cy1 = py(p.s);
        s += "<circle cx='" + sx(cx1) + "' cy='" + sx(cy1) + "' r='8.6' fill='none' stroke='#a9742c' stroke-width='1.5' stroke-dasharray='2.5 2'/>";
        s += "<text x='" + sx(cx1 + 10) + "' y='" + sx(cy1 + 15) + "' font-size='9' font-family='monospace' fill='#83551f' stroke='#fdfbf5' stroke-width='3' paint-order='stroke'>本轮 " + (idx + 1) + "</text>";
      });
    }

    el('contour').innerHTML = s;
    var hint = el('c-hint');
    if (hint) {
      if (state.stage === 0) hint.textContent = '可行域 ' + FEAS.pct + '% · 压力上限 ' + PLIM + ' MPa';
      else if (state.stage === 1) hint.textContent = '初始 6 点 · GP 后验均值（蓝虚线）';
      else if (state.stage === 2) hint.textContent = 'EI 面 + Top-3 候选 · 待评估';
      else if (state.stage === 3) hint.textContent = lastRound ? ('第 ' + lastRound.g + ' 轮 · 3 点已回写') : '等待第 1 轮评估';
      else hint.textContent = '推荐 Q=' + f2(rec.q) + ' / S=' + f1(rec.s) + ' · 余量 ' + f1(PLIM - pres(rec.q, rec.s)) + ' MPa';
    }
  }

  /* ================= 6. 绘图：收敛曲线（阶段 05） ================= */
  function drawConv() {
    var Wc = 340, Hc = 85, L = 30, R = 48, T = 8, B = 14;
    var yMin = 1e9, yMax = 100, i;
    SEQ.forEach(function (k) {
      var cv = curveOf(runs[k]);
      if (cv.length && cv[0] < yMin) yMin = cv[0];
    });
    yMin = Math.max(0, Math.floor((yMin - 6) / 10) * 10);
    if (!isFinite(yMin)) yMin = 50;
    function X(n) { return L + n / MAXN * (Wc - L - R); }
    function Y(v) { return (Hc - B) - (v - yMin) / (yMax - yMin) * (Hc - T - B); }
    var s = '';
    for (i = yMin; i <= yMax; i += 10) {
      s += "<line x1='" + L + "' y1='" + sx(Y(i)) + "' x2='" + (Wc - R) + "' y2='" + sx(Y(i)) + "' stroke='#efece1'/>";
      if (i === yMin || i === yMax || Math.abs(i - (yMin + yMax) / 2) < 5) {
        s += "<text x='" + (L - 6) + "' y='" + sx(Y(i) + 3) + "' font-size='7.5' fill='#99a3a4' text-anchor='end' font-family='monospace'>" + i + "</text>";
      }
    }
    for (i = 0; i <= MAXN; i += 10) {
      s += "<line x1='" + sx(X(i)) + "' y1='" + T + "' x2='" + sx(X(i)) + "' y2='" + (Hc - B) + "' stroke='#efe9dd'/>";
      s += "<text x='" + sx(X(i)) + "' y='" + (Hc - B + 12) + "' font-size='7.5' fill='#99a3a4' text-anchor='middle' font-family='monospace'>" + i + "</text>";
    }
    s += "<rect x='" + L + "' y='" + T + "' width='" + sx(X(6) - L) + "' height='" + (Hc - T - B) + "' fill='#f7f5f0'/>";
    s += "<text x='" + sx((L + X(6)) / 2) + "' y='" + (T + 9) + "' font-size='7.5' fill='#99a3a4' text-anchor='middle'>初始 6 点</text>";
    s += "<line x1='" + L + "' y1='" + sx(Y(TRUE_OPT.pi)) + "' x2='" + (Wc - R) + "' y2='" + sx(Y(TRUE_OPT.pi)) + "' stroke='#a9742c' stroke-width='1' stroke-dasharray='5 3' opacity='0.75'/>";
    s += "<text x='" + (Wc - R + 3) + "' y='" + sx(Y(TRUE_OPT.pi) + 3) + "' font-size='8' font-family='monospace' fill='#83551f'>" + f1(TRUE_OPT.pi) + "</text>";
    var col = { random: '#99a3a4', grid: '#a9742c', bayes: '#1d4e50' };
    var wid = { random: 1.4, grid: 1.7, bayes: 2.3 };
    SEQ.forEach(function (k) {
      var cv = curveOf(runs[k]), d = '';
      cv.forEach(function (v, m) {
        var n = m + 1;
        d += (m === 0 ? 'M' : 'L') + sx(X(n)) + ' ' + sx(Y(v));
      });
      s += "<path d='" + d + "' fill='none' stroke='" + col[k] + "' stroke-width='" + wid[k] + "' stroke-linejoin='round'/>";
    });
    var n95 = n95Of(runs.bayes);
    if (n95) {
      s += "<line x1='" + sx(X(n95)) + "' y1='" + T + "' x2='" + sx(X(n95)) + "' y2='" + (Hc - B) + "' stroke='#3d7455' stroke-width='1' stroke-dasharray='2 2' opacity='0.8'/>";
      s += "<text x='" + sx(X(n95)) + "' y='" + (T - 1) + "' font-size='7.5' font-family='monospace' fill='#3d7455' text-anchor='middle'>95%</text>";
    }
    var cn = runs.bayes.samples.length;
    s += "<line x1='" + sx(X(cn)) + "' y1='" + T + "' x2='" + sx(X(cn)) + "' y2='" + (Hc - B) + "' stroke='#1d4e50' stroke-width='1' stroke-dasharray='3 3' opacity='0.5'/>";
    el('conv').innerHTML = s;
  }

  /* ================= 7. 绘图：帕累托前沿 ================= */
  function drawPareto() {
    var run = runs[state.selected];
    var W2 = 340, H2 = 170, L = 36, R = 12, T = 12, B = 28;
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
      s += "<text x='" + sx(X(xv)) + "' y='" + (H2 - B + 12) + "' font-size='7.5' fill='#99a3a4' text-anchor='middle' font-family='monospace'>" + f1(xv) + "</text>";
      s += "<text x='" + (L - 5) + "' y='" + sx(Y(yv) + 3) + "' font-size='7.5' fill='#99a3a4' text-anchor='end' font-family='monospace'>" + Math.round(yv) + "</text>";
    }
    s += "<text x='" + (L - 24) + "' y='" + (T - 4) + "' font-size='8' fill='#6f7a7c'>PI</text>";
    s += "<text x='" + (W2 - R) + "' y='" + (H2 - B + 21) + "' font-size='8' fill='#6f7a7c' text-anchor='end'>单段砂量 / t</text>";
    /* 非支配前缘 */
    var sorted = run.samples.slice().sort(function (a, b) { return sand(a.q, a.s) - sand(b.q, b.s); });
    var front = [], bv = -1e9, d = '';
    sorted.forEach(function (p) {
      if (p.t > bv) { bv = p.t; front.push(p); }
    });
    front.forEach(function (p, k) {
      d += (k ? 'L' : 'M') + sx(X(sand(p.q, p.s))) + ' ' + sx(Y(p.t));
    });
    s += "<path d='" + d + "' fill='none' stroke='#1d4e50' stroke-width='1.5' opacity='0.75'/>";
    run.samples.forEach(function (p) {
      s += "<circle cx='" + sx(X(sand(p.q, p.s))) + "' cy='" + sx(Y(p.t)) + "' r='2.8' fill='#9ccdb9' stroke='#ffffff' stroke-width='0.7'/>";
    });
    front.forEach(function (p) {
      s += "<circle cx='" + sx(X(sand(p.q, p.s))) + "' cy='" + sx(Y(p.t)) + "' r='2.6' fill='#1d4e50'/>";
    });
    /* 经验方案与推荐 */
    var ex = X(sand(EXP.q, EXP.s)), ey = Y(EXP_PI);
    s += "<path d='M" + sx(ex) + " " + sx(ey - 4.4) + "L" + sx(ex + 4.4) + " " + sx(ey) + "L" + sx(ex) + " " + sx(ey + 4.4) + "L" + sx(ex - 4.4) + " " + sx(ey) + "Z' fill='#ffffff' stroke='#a64b3c' stroke-width='1.3'/>";
    s += "<text x='" + sx(ex + 6) + "' y='" + sx(ey + 10) + "' font-size='8' fill='#a64b3c'>经验</text>";
    var rec = bestMeas(run), rx = X(sand(rec.q, rec.s)), ry = Y(rec.t);
    var st = '', k2;
    for (k2 = 0; k2 < 10; k2++) {
      var ang = -Math.PI / 2 + k2 * Math.PI / 5, rr = (k2 % 2 === 0) ? 5.8 : 2.5;
      st += (k2 ? 'L' : 'M') + sx(rx + rr * Math.cos(ang)) + ' ' + sx(ry + rr * Math.sin(ang));
    }
    s += "<path d='" + st + "Z' fill='#a9742c' stroke='#ffffff' stroke-width='1'/>";
    el('pareto').innerHTML = s;
  }

  /* ================= 8. 绘图：敏感性龙卷风图 ================= */
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
    var Wt = 340, Ht = 155, L = 100, R = 14, T = 18, B = 20;
    var cx0 = L + (Wt - L - R) / 2;
    var half = (Wt - L - R) / 2 - 8;
    var s = '';
    s += '<line x1="' + cx0 + '" y1="' + T + '" x2="' + cx0 + '" y2="' + (Ht - B) + '" stroke="#45524d" stroke-width="1"/>';
    s += '<text x="' + cx0 + '" y="' + (Ht - B + 13) + '" text-anchor="middle" font-size="7.5" fill="#98a199">基准 PI ' + base.toFixed(1) + '</text>';
    s += '<text x="' + (Wt - R) + '" y="' + (Ht - B + 13) + '" text-anchor="end" font-size="7.5" fill="#98a199">PI 变化 →</text>';
    var rowH = 20, gap = 7;
    cases.forEach(function (c, i) {
      var y = T + 6 + i * (rowH + gap);
      var w = Math.max(2, Math.abs(c.d) / maxAbs * half);
      var x = c.d >= 0 ? cx0 : cx0 - w;
      s += '<text x="' + (L - 8) + '" y="' + (y + 13) + '" text-anchor="end" font-size="9" fill="#45524d">' + c.label + '</text>';
      s += '<rect x="' + x.toFixed(1) + '" y="' + y + '" width="' + w.toFixed(1) + '" height="' + rowH + '" fill="' + c.col + '" opacity=".82"' + (c.feas ? '' : ' stroke="#9c4235" stroke-width="1.2" stroke-dasharray="3 2"') + '/>';
      var val = (c.d >= 0 ? '+' : '') + c.d.toFixed(1);
      var inside = w > 42;
      var tx, anchor, fill;
      if (c.d >= 0) {
        tx = inside ? x + w - 4 : x + w + 4;
        anchor = inside ? 'end' : 'start';
      } else {
        tx = inside ? x + 4 : x - 4;
        anchor = inside ? 'start' : 'end';
      }
      fill = inside ? '#fbf8f0' : (c.feas ? c.col : '#9c4235');
      s += '<text x="' + tx + '" y="' + (y + 13) + '" text-anchor="' + anchor + '" font-size="8.5" font-family="monospace" fill="' + fill + '">' + val + (c.feas ? '' : ' 超压') + '</text>';
    });
    svg.innerHTML = s;
  }

  /* ================= 9. 阶段面板 ================= */
  function drawMiniMaps() {
    if (!initialSnapshot) return;
    var snap = initialSnapshot, NX = snap.NX, NY = snap.NY;
    function draw(id, vals, lo, hi, kind) {
      var Wm = 156, Hm = 104, pad = 1;
      var cw = (Wm - pad * 2) / NX, ch = (Hm - pad * 2) / NY;
      var s = '', i, j;
      for (j = 0; j < NY; j++) for (i = 0; i < NX; i++) {
        var t = (vals[j * NX + i] - lo) / Math.max(1e-6, hi - lo);
        var q = QLO + (QHI - QLO) * i / (NX - 1);
        var ss = SLO + (SHI - SLO) * j / (NY - 1);
        var fill = feas(q, ss)
          ? (kind === 'mu' ? mix('#f4f1e7', '#1d4e50', t) : mix('#f4f1e7', '#355c74', t))
          : '#e6e0d2';
        s += "<rect x='" + sx(pad + i * cw) + "' y='" + sx(pad + (NY - 1 - j) * ch) + "' width='" + sx(cw + 0.5) + "' height='" + sx(ch + 0.5) + "' fill='" + fill + "'/>";
      }
      runs.bayes.samples.forEach(function (p) {
        if (p.g !== 0) return;
        var xx = pad + xOf(p.q) * (Wm - pad * 2);
        var yy = pad + (1 - sOf(p.s)) * (Hm - pad * 2);
        s += "<circle cx='" + sx(xx) + "' cy='" + sx(yy) + "' r='2.2' fill='#ffffff' stroke='#123a3d' stroke-width='0.8'/>";
      });
      s += "<rect x='" + pad + "' y='" + pad + "' width='" + (Wm - pad * 2) + "' height='" + (Hm - pad * 2) + "' fill='none' stroke='#e3dccd'/>";
      el(id).innerHTML = s;
    }
    draw('gpmu', snap.mu, snap.muMin, snap.muMax, 'mu');
    draw('gpsd', snap.sd, 0, snap.sdMax, 'sd');
    el('g-n').innerHTML = snap.n + '<small>点</small>';
    el('g-rmse').innerHTML = isFinite(snap.rmse) ? f2(snap.rmse) : '—';
    el('g-sd').innerHTML = f2(snap.meanSd);
    el('g-note').innerHTML = 'σ 最大值 <b>' + f2(snap.sdMax) + '</b> 出现在无样本的外推区；EI 会先去那里。米灰 = 压力超限。';
  }

  function drawStageParams() {
    el('p-feas').innerHTML = FEAS.pct + '<small>%</small>';
    el('p-feas-n').innerHTML = FEAS.ok + ' / ' + FEAS.total + ' 个网格点';
    el('p-constraint').innerHTML = '约束线：S=25% 时 Q 超过 <b>' + f2(FEAS.qMaxSHI) + ' m³/min</b> 即超压；初始 6 个设计点全部在可行域内。';
  }

  function drawCand() {
    var tb = el('cand'), ft = el('cand-foot');
    if (!pendingPicks.length) {
      tb.innerHTML = "<tr><td colspan='6' style='color:var(--ink-4)'>等待 GP 拟合后计算 EI</td></tr>";
      ft.innerHTML = '';
      return;
    }
    var maxShare = 0;
    function shareOf(p) {
      var pos = Math.max(0, p.exr);
      return p.exl / Math.max(1e-9, pos + p.exl);
    }
    tb.innerHTML = pendingPicks.map(function (p, idx) {
      var share = shareOf(p);
      if (share > maxShare) maxShare = share;
      var kind = share > 0.55 ? "<span class='db warn'>探索</span>"
        : share < 0.45 ? "<span class='db ok'>利用</span>"
          : "<span class='db plain'>均衡</span>";
      return "<tr><td>" + (idx + 1) + "</td><td class='num'>" + f2(p.q) + "</td><td class='num'>" + f1(p.s) +
        "</td><td class='num'>" + f1(p.mu) + "±" + f1(p.sd) + "</td><td class='num'>" + (p.ei < 0.01 ? '≈0' : f2(p.ei)) +
        "</td><td>" + kind + "</td></tr>";
    }).join('');
    var maxEi = 0;
    pendingPicks.forEach(function (p) { if (p.ei > maxEi) maxEi = p.ei; });
    var noisePi = (state.noise / 100 / 3) * Math.abs(runs.bayes.ybar || 1);
    var stop = maxEi < 0.35 * noisePi;
    var shares = pendingPicks.map(function (p) { return Math.round(shareOf(p) * 100); }).join('% / ') + '%';
    ft.innerHTML = '方差项占「|均值项| + 方差项」的比例：<b>' + shares + '</b>。比例越高，EI 越偏向「还没探过」而不是「预测更好」；' +
      (stop
        ? '<span class="db ok" style="margin-left:4px">EI 已低于噪声 · 可以停</span>'
        : '<span class="db plain" style="margin-left:4px">EI 仍高于噪声 · 继续迭代</span>');
    el('ei-max').innerHTML = maxEi < 0.01 ? '≈0' : f2(maxEi);
    el('ei-stop').textContent = stop ? '低于噪声 · 可停' : '高于噪声 · 继续';
    el('ei-stop').className = 's ' + (stop ? 'ok' : '');
    el('ei-noise').innerHTML = f1(noisePi) + '<small>PI</small>';
    var hint = el('ei-hint');
    hint.textContent = state.round >= MAXROUND ? '预算已满 · 候选仅供复核' : ('第 ' + (state.round + 1) + ' 轮 · 待评估');
    var mode = '候选基于 ' + pendingN + ' 样本模型 · 当前 GP ' + runs.bayes.samples.length + ' 样本';
    if (state.selected !== 'bayes') mode = '左图为 ' + nameOf(state.selected) + ' 对照；EI/候选属贝叶斯流水线';
    el('ei-mode').textContent = mode;
  }

  function drawRound() {
    var tb = el('round');
    var n = runs.bayes.samples.length;
    if (!lastRound) {
      el('rd-hint').textContent = '等待第 1 轮';
      el('rd-n').innerHTML = '0<small> / ' + n + '</small>';
      el('rd-rmse').textContent = '—';
      el('rd-rmse').className = 'v';
      el('rd-rmse-s').textContent = '更新前 → 更新后';
      el('rd-best').textContent = '—';
      el('rd-cur').textContent = f1(bestTrue(runs.bayes));
      el('rd-cur-s').textContent = '初始设计 6 点';
      tb.innerHTML = "<tr><td colspan='6' style='color:var(--ink-4)'>点「运行一轮 +3」或「运行全流程」后，这里显示本轮 3 个点的预测、真实 PI 与 EI</td></tr>";
      el('rd-press').textContent = '本轮尚未回写。';
      el('rd-cmp').innerHTML = '同轮对照（' + nameOf(state.selected) + '）：至今最优 PI <b>' + f1(bestTrue(runs[state.selected])) + '</b> · 贝叶斯 <b>' + f1(bestTrue(runs.bayes)) + '</b>';
      return;
    }
    var lr = lastRound;
    var best = -1e9;
    lr.pts.forEach(function (p) { if (p.t > best) best = p.t; });
    var drop = lr.rmseBefore > 0 ? (lr.rmseBefore - lr.rmseAfter) / lr.rmseBefore * 100 : 0;
    el('rd-hint').textContent = '第 ' + lr.g + ' 轮 · 3 点已回写';
    el('rd-n').innerHTML = lr.g + '<small> / ' + lr.nAfter + '</small>';
    el('rd-rmse').innerHTML = f2(lr.rmseBefore) + ' → ' + f2(lr.rmseAfter);
    el('rd-rmse').className = 'v ' + (lr.rmseAfter <= lr.rmseBefore ? 'ok' : 'warn');
    el('rd-rmse-s').textContent = (drop >= 0 ? '下降 ' : '上升 ') + f1(Math.abs(drop)) + '% · 回写 ' + lr.pts.length + ' 点' + (drop < 0 ? '（边界样本/噪声）' : '');
    el('rd-best').textContent = f1(best);
    var bt = bestTrueSample(runs.bayes);
    el('rd-cur').textContent = f1(bt.t);
    el('rd-cur-s').textContent = '来自第 ' + bt.g + ' 轮 · 共 ' + runs.bayes.samples.length + ' 次评估';
    tb.innerHTML = lr.pts.map(function (p, idx) {
      return "<tr><td>" + (idx + 1) + "</td><td class='num'>" + f2(p.q) + "</td><td class='num'>" + f1(p.s) +
        "</td><td class='num'>" + f1(p.mu) + "±" + f1(p.sd) + "</td><td class='num'><b>" + f1(p.t) +
        "</b></td><td class='num'>" + (p.ei < 0.01 ? '≈0' : f2(p.ei)) + "</td></tr>";
    }).join('');
    var ps = lr.pts.map(function (p) { return f1(pres(p.q, p.s)); });
    var allFeas = lr.pts.every(function (p) { return feas(p.q, p.s); });
    el('rd-press').innerHTML = '施工压力 ' + ps.join(' / ') + ' MPa · ' + (allFeas
      ? '<span class="db ok">全部在 76 MPa 窗口内</span>'
      : '<span class="db bad">出现越限</span>');
    var cmpTxt = state.selected === 'bayes'
      ? '同轮对照：网格 <b>' + f1(bestTrue(runs.grid)) + '</b> · 随机 <b>' + f1(bestTrue(runs.random)) + '</b>（同评估次数）'
      : '左图为 ' + nameOf(state.selected) + ' 对照；贝叶斯本轮至今最优 <b>' + f1(bestTrue(runs.bayes)) + '</b>';
    if (state.round >= MAXROUND) cmpTxt += ' · 30 次预算已满，最后几轮 EI≈0，主要用于同预算对照。';
    el('rd-cmp').innerHTML = cmpTxt;
  }

  function drawDelivery() {
    var run = runs[state.selected];
    var rec = bestMeas(run);
    var pr = predict(run, rec.q, rec.s);
    var dPI = (rec.y / EXP_PI - 1) * 100;
    var dW = (sand(rec.q, rec.s) / EXP_W - 1) * 100;
    var margin = PLIM - pres(rec.q, rec.s);
    var n95 = n95Of(runs.bayes);
    el('dl-hint').textContent = '已评估 ' + runs.bayes.samples.length + '/' + MAXN + (n95 ? (' · 达 95% ' + n95 + ' 次') : '');
    el('card-strat').textContent = nameOf(state.selected);
    el('card-hint').textContent = '第 ' + rec.g + ' 轮命中 · ' + run.samples.length + ' 次评估';
    var pcls = margin >= 0.5 ? 'ok' : margin >= 0 ? 'warn' : 'bad';
    el('card').innerHTML =
      '<div><div class="k">推荐 Q / S</div><div class="v" style="font-size:13px">' + f2(rec.q) + '<small>/' + f1(rec.s) + '</small></div><div class="s">m³/min · %</div></div>' +
      '<div><div class="k">预测 PI（±1.96σ）</div><div class="v ' + (dPI >= 0 ? 'ok' : 'warn') + '">' + f1(pr.mu) + '<small>±' + f1(1.96 * pr.sd) + '</small></div><div class="s">实测 ' + f1(rec.y) + ' · 较经验 ' + (dPI >= 0 ? '+' : '') + Math.round(dPI) + '%</div></div>' +
      '<div><div class="k">施工压力</div><div class="v ' + pcls + '">' + f1(pres(rec.q, rec.s)) + '<small>MPa</small></div><div class="s">距 76 MPa 上限 ' + f1(margin) + ' MPa</div></div>' +
      '<div><div class="k">单段砂量</div><div class="v">' + f1(sand(rec.q, rec.s)) + '<small>t</small></div><div class="s">经验 ' + f1(EXP_W) + ' t · ' + (dW >= 0 ? '+' : '') + f1(dW) + '%</div></div>';
    el('backup').innerHTML = '<b>压力余量备选（≥0.8 MPa）</b>：Q=' + f2(SAFE_OPT.q) + ' / S=' + f1(SAFE_OPT.s) +
      '，PI <b>' + f1(SAFE_OPT.pi) + '</b>，砂量 ' + f1(SAFE_OPT.w) + ' t。';
    el('fb-note').textContent = '回写 ' + (fb.ok + fb.fix) + ' 条' + (fb.fix ? ' · 其中要求补算 ' + fb.fix + ' 条' : '') + ' · 人工确认后进入下一轮复算';
    var cmp = '', cmpCol = { random: '#99a3a4', grid: '#a9742c', bayes: '#1d4e50' };
    SEQ.forEach(function (k) {
      var r = runs[k], b = bestTrue(r), n9 = n95Of(r);
      cmp += '<tr class="' + (state.selected === k ? 'on' : '') + '"><td><i style="display:inline-block;width:8px;height:3px;background:' + cmpCol[k] + ';margin-right:4px;vertical-align:middle"></i>' + nameOf(k) +
        '</td><td class="num">' + f1(b) + '</td><td class="num">' + (n9 ? n9 + ' 次' : '未达') + '</td><td class="num">' + r.rejected + '</td></tr>';
    });
    el('cmp').innerHTML = cmp;
  }

  function updateReadouts() {
    var run = runs[state.selected];
    var bt = bestTrue(run), rec = bestMeas(run);
    var rmse = proxyRmse(run);
    var gap = (TRUE_OPT.pi - bt) / TRUE_OPT.pi * 100;
    var margin = PLIM - pres(rec.q, rec.s);
    var n95 = n95Of(runs.bayes);
    el('st-n').innerHTML = run.samples.length + '<small>/30</small>';
    el('st-best').innerHTML = f1(bt);
    el('st-gap').innerHTML = f1(gap) + '<small>%</small>';
    el('st-rmse').innerHTML = isFinite(rmse) ? f2(rmse) : '—';
    el('r-n').innerHTML = run.samples.length + '<small>次</small>';
    el('r-best').innerHTML = f1(bt);
    el('r-gap').innerHTML = f1(gap) + '<small>%</small>';
    el('r-rmse').innerHTML = isFinite(rmse) ? f2(rmse) + '<small>PI</small>' : '—';
    el('r-margin').innerHTML = f1(margin) + '<small>MPa</small>';
    el('m-badge').textContent = '已拟合 · ' + runs.bayes.samples.length + ' 样本';
    el('m-badge').className = 'db ok';
    el('m-data').textContent = '6 初始 + ' + (state.round ? ('第 ' + state.round + ' 轮 · ') : '') + runs.bayes.samples.length + ' 次评估 · 预算 30 次';
    var brmse = proxyRmse(runs.bayes);
    el('m-summary').innerHTML = '可行域 RMSE <b>' + (isFinite(brmse) ? f2(brmse) : '—') + '</b> PI · 达 95% <b>' + (n95 ? n95 + ' 次' : '未达') + '</b> · 约束违反 <b>0</b> 次';
  }

  function noteText() {
    var run = runs[state.selected];
    var rec = bestMeas(run);
    var s = '';
    if (state.stage === 0) {
      s += '参数空间不是「大」，而是<b>又大又稀疏</b>：Q 3—8 m³/min × S 5—25%，施工压力上限 76 MPa 先砍掉约 <b>' + (100 - FEAS.pct) + '%</b> 的区域；剩下的可行域里，真正最优只占几个格。流水线只在可行域里选点，越限方案一次都不提。';
      s += '　<b>可以试：</b>点「运行全流程」看后面四步怎样用 30 次模拟逼近最优；关掉「可行性边界」开关，对照没有约束时的候选空间。';
    } else if (state.stage === 1) {
      s += '6 个初始点（蓝）只覆盖低排量区，GP 的 μ 面已经能勾出主脊，但 <b>σ 面在高排量区明显抬高</b>——那里没有样本，正是 EI 下一步要去探索的地方。初始代理 RMSE <b>' + f2(initialSnapshot.rmse) + ' PI</b>，平均 σ <b>' + f2(initialSnapshot.meanSd) + '</b>。';
      s += '　<b>可以试：</b>打开「代理预测面」，看主画布上的蓝色虚线均值面与真实等值线在哪一段开始分叉。';
    } else if (state.stage === 2) {
      if (pendingPicks.length) {
        var p0 = pendingPicks[0];
        var maxEi = 0;
        pendingPicks.forEach(function (p) { if (p.ei > maxEi) maxEi = p.ei; });
        var noiseThr = 0.35 * (state.noise / 100 / 3) * Math.abs(runs.bayes.ybar || 1);
        s += 'EI 在「预测更好」和「没探过」之间折中：当前候选 Top-1 是 <b>Q=' + f2(p0.q) + ' / S=' + f1(p0.s) + '</b>，预测 PI <b>' + f1(p0.mu) + '±' + f1(p0.sd) + '</b>，EI <b>' + f2(maxEi) + '</b>。主画布的蓝色越深，表示 EI 越高、越值得下一次模拟。';
        if (maxEi < noiseThr) s += ' 本轮最大 EI 已低于噪声水平，按停止判据不再送模拟器；这 3 个候选只用于复核。';
      }
      s += '　候选池只含压力可行点，所以贝叶斯对约束的无效试探是 <b>0</b> 次（随机采样已被拒 <b>' + runs.random.rejected + '</b> 次、网格 <b>' + runs.grid.rejected + '</b> 次）。';
    } else if (state.stage === 3) {
      if (lastRound) {
        var best = -1e9, inside = 0;
        lastRound.pts.forEach(function (p) {
          if (p.t > best) best = p.t;
          if (Math.abs(p.t - p.mu) <= 1.96 * p.sd) inside++;
        });
        s += '第 <b>' + lastRound.g + '</b> 轮 3 个点已回写：真实 PI <b>' + lastRound.pts.map(function (p) { return f1(p.t); }).join(' / ') + '</b>，代理 RMSE <b>' + f2(lastRound.rmseBefore) + ' → ' + f2(lastRound.rmseAfter) + '</b>。';
        if (inside === lastRound.pts.length) {
          s += '3 个真实值都落在 <b>μ±1.96σ</b> 区间内，说明这一段代理模型可信，下一轮可以更放心地利用。';
        } else if (inside > 0) {
          s += '有 <b>' + (lastRound.pts.length - inside) + ' / 3</b> 个真实值落在 μ±1.96σ 外——代理模型在这些区域偏自信，下一轮要优先补样本。';
        } else {
          s += '3 个真实值全部落在 <b>μ±1.96σ</b> 之外：初始 6 点太稀疏，GP 的方差被低估。这正是贝叶斯优化要「边探索边修正」的原因，回写后 RMSE 已从 ' + f2(lastRound.rmseBefore) + ' 降到 ' + f2(lastRound.rmseAfter) + '。';
        }
      } else {
        s += '本轮还没有评估。点「运行一轮 +3」把阶段 03 的 3 个候选送进模拟器；回写后代理模型会重拟合，再进入下一轮 EI 选点。';
      }
      s += '　<b>可以试：</b>切到「随机采样」或「网格搜索」，左图会显示同预算下另一种取点方式；阶段 04 的对照行会同步更新。';
    } else {
      var nb = f1(bestTrue(runs.bayes)), ng = f1(bestTrue(runs.grid)), nr = f1(bestTrue(runs.random));
      var n95 = n95Of(runs.bayes);
      s += '当前 <b>' + runs.bayes.samples.length + '</b> 次评估下，贝叶斯至今最优 <b>' + nb + '</b>，网格 <b>' + ng + '</b>，随机 <b>' + nr + '</b>（真实响应面口径，去噪）；贝叶斯' + (n95 ? ('在 <b>' + n95 + ' 次</b>达到真实最优的 95%。') : '尚未达到真实最优的 95%。');
      s += '　交付方案 Q=' + f2(rec.q) + ' / S=' + f1(rec.s) + '，预测 PI <b>' + f1(predict(run, rec.q, rec.s).mu) + '</b>，实测 PI <b>' + f1(rec.y) + '</b>（去噪真值 ' + f1(rec.t) + '），比邻井经验方案 <b>' + (rec.y / EXP_PI * 100 - 100 >= 0 ? '+' : '') + Math.round(rec.y / EXP_PI * 100 - 100) + '%</b>，砂量 <b>' + (sand(rec.q, rec.s) / EXP_W * 100 - 100 >= 0 ? '+' : '') + f1(sand(rec.q, rec.s) / EXP_W * 100 - 100) + '%</b>；压力余量 ' + f1(PLIM - pres(rec.q, rec.s)) + ' MPa，贴限方案另配 <b>' + f1(PLIM - SAFE_OPT.p) + ' MPa</b> 余量备选。';
      s += '　以上为<b>示范合成口径</b>：现场要用实测产能重新标定代理模型，并保留人工复核。';
    }
    return s;
  }

  /* ================= 10. 过程日志 / 阶段控制 ================= */
  var TRACE = [];
  function trace(step, html, cls) {
    TRACE.push({ step: step, html: html, cls: cls || '' });
    if (TRACE.length > 8) TRACE.shift();
    var box = el('trace');
    box.innerHTML = TRACE.map(function (t) {
      return '<div><span class="t">' + t.step + '</span><span class="' + t.cls + '">' + t.html + '</span></div>';
    }).join('');
    box.scrollTop = box.scrollHeight;
  }
  function clearTrace() {
    TRACE = [];
    el('trace').innerHTML = '<div><span class="t">—</span><span>等待运行：点「运行全流程」看五段闭环，或点「运行一轮 +3」手动推进。</span></div>';
  }

  var autoTimers = [];
  function stopAuto(label) {
    autoTimers.forEach(function (t) { clearTimeout(t); });
    autoTimers = [];
    clearTimeout(noiseTimer);
    state.running = false;
    var b = el('run-all');
    b.disabled = false;
    b.textContent = label || '▶ 运行全流程';
    refreshRunOne();
  }
  function refreshRunOne() {
    var b = el('run-one');
    if (state.round >= MAXROUND) {
      b.disabled = true;
      b.textContent = '已跑满 30 次';
    } else {
      b.disabled = state.running;
      b.textContent = '运行一轮 +3';
    }
  }
  function updateRunLabel() {
    el('run-all').textContent = '运行中… ' + state.round + '/' + MAXROUND + ' 轮';
  }

  function setStage(i) {
    state.stage = i;
    [].forEach.call(document.querySelectorAll('.dstage'), function (p) {
      p.classList.toggle('on', Number(p.getAttribute('data-stage')) === i);
    });
    [].forEach.call(el('flow').children, function (b, idx) {
      b.classList.toggle('on', idx === i);
      b.classList.toggle('done', idx < i);
      b.setAttribute('aria-selected', idx === i ? 'true' : 'false');
    });
    render();
  }

  function roundTrace() {
    if (!lastRound) return '';
    return '第 ' + lastRound.g + ' 轮 · 3 点回写 · 真实 PI ' + lastRound.pts.map(function (p) { return f1(p.t); }).join(' / ') +
      ' · RMSE <b>' + f2(lastRound.rmseBefore) + ' → ' + f2(lastRound.rmseAfter) + '</b>';
  }
  function maxEiOfPicks() {
    var m = 0;
    pendingPicks.forEach(function (p) { if (p.ei > m) m = p.ei; });
    return m;
  }

  function runAll() {
    stopAuto();
    resetRuns();
    fb = { ok: 0, fix: 0 };
    clearTrace();
    setStage(0);
    state.running = true;
    el('run-all').disabled = true;
    el('run-one').disabled = true;
    el('run-all').textContent = '运行中… 0/' + MAXROUND + ' 轮';
    function later(fn, ms) { autoTimers.push(setTimeout(fn, ms)); }

    later(function () {
      setStage(0);
      trace('01', '读取参数空间 Q 3—8 / S 5—25 · 压力上限 <b>76 MPa</b> · 可行域 <b>' + FEAS.pct + '%</b>，候选池只取可行点');
    }, 80);
    later(function () {
      setStage(1);
      trace('02', '6 个初始设计 → GP 拟合 · 初始 RMSE <b>' + f2(initialSnapshot.rmse) + ' PI</b> · 平均 σ ' + f2(initialSnapshot.meanSd));
    }, 950);
    later(function () {
      setStage(2);
      trace('03', 'EI 面重算 · Top-3 ' + pendingPicks.map(function (p) { return '(' + f2(p.q) + ',' + f1(p.s) + ')'; }).join(' / ') + ' · 最大 EI ' + f2(maxEiOfPicks()));
    }, 1820);
    later(function () {
      advanceRound();
      setStage(3);
      trace('04', roundTrace(), 'ok');
      updateRunLabel();
    }, 2700);

    for (var k = 2; k <= MAXROUND; k++) {
      (function (k) {
        later(function () {
          if (state.round >= MAXROUND) return;
          setStage(2);
          var p0 = pendingPicks[0];
          trace('03', '第 ' + k + ' 轮 EI 选点 · Top-1 (' + f2(p0.q) + ',' + f1(p0.s) + ') · EI ' + f2(p0.ei));
        }, 2700 + (k - 1) * 900);
        later(function () {
          if (state.round >= MAXROUND) return;
          advanceRound();
          setStage(3);
          trace('04', roundTrace(), 'ok');
          updateRunLabel();
        }, 2700 + (k - 1) * 900 + 430);
      })(k);
    }
    var endT = 2700 + (MAXROUND - 1) * 900 + 430 + 850;
    later(function () {
      setStage(4);
      trace('05', '收敛交付 · 贝叶斯 <b>' + f1(bestTrue(runs.bayes)) + '</b> / 网格 ' + f1(bestTrue(runs.grid)) + ' / 随机 ' + f1(bestTrue(runs.random)) +
        ' · 推荐 PI 较经验 <b>' + Math.round(bestTrue(runs.bayes) / EXP_PI * 100 - 100) + '%</b> · 30 次预算已跑满（最后几轮用于同预算对照）', 'ok');
      stopAuto('▶ 重新运行全流程');
    }, endT);
  }

  function runOne() {
    if (state.running || state.round >= MAXROUND) return;
    stopAuto();
    advanceRound();
    setStage(3);
    trace('04', roundTrace(), 'ok');
    refreshRunOne();
  }

  function resetAll() {
    stopAuto();
    resetRuns();
    fb = { ok: 0, fix: 0 };
    clearTrace();
    setStage(0);
    trace('系统', '代理模型已在本页拟合：6 个初始设计 · 初始 RMSE <b>' + f2(initialSnapshot.rmse) + ' PI</b> · 预算 30 次模拟', 'ok');
  }

  /* ================= 11. 渲染 ================= */
  function render() {
    updateReadouts();
    drawContour();
    drawConv();
    drawPareto();
    drawTornado();
    drawMiniMaps();
    drawStageParams();
    drawCand();
    drawRound();
    drawDelivery();
    el('note').innerHTML = noteText();
    /* 供自检脚本读取：算法与流水线状态快照 */
    window.__OPT__ = {
      round: state.round,
      stage: state.stage,
      selected: state.selected,
      n: runs.bayes.samples.length,
      n95: {
        bayes: n95Of(runs.bayes),
        grid: n95Of(runs.grid),
        random: n95Of(runs.random)
      },
      curve: {
        bayes: curveOf(runs.bayes).map(function (v) { return Math.round(v * 100) / 100; }),
        grid: curveOf(runs.grid).map(function (v) { return Math.round(v * 100) / 100; }),
        random: curveOf(runs.random).map(function (v) { return Math.round(v * 100) / 100; })
      },
      candidates: pendingPicks.map(function (p) {
        return { q: Math.round(p.q * 1000) / 1000, s: Math.round(p.s * 10) / 10, mu: Math.round(p.mu * 10) / 10, sd: Math.round(p.sd * 10) / 10, ei: Math.round(p.ei * 100) / 100 };
      }),
      lastRound: lastRound ? {
        g: lastRound.g,
        rmseBefore: Math.round(lastRound.rmseBefore * 100) / 100,
        rmseAfter: Math.round(lastRound.rmseAfter * 100) / 100,
        pts: lastRound.pts.map(function (p) { return { q: Math.round(p.q * 1000) / 1000, s: Math.round(p.s * 10) / 10, mu: Math.round(p.mu * 10) / 10, sd: Math.round(p.sd * 10) / 10, t: Math.round(p.t * 10) / 10, ei: Math.round(p.ei * 100) / 100 }; })
      } : null,
      picked: SEQ.map(function (k) {
        var b = bestMeas(runs[k]);
        return { k: k, q: Math.round(b.q * 1000) / 1000, s: Math.round(b.s * 10) / 10, y: Math.round(b.y * 10) / 10, t: Math.round(b.t * 10) / 10, p: Math.round(pres(b.q, b.s) * 10) / 10, w: Math.round(sand(b.q, b.s) * 100) / 100 };
      }),
      trueOpt: { q: Math.round(TRUE_OPT.q * 1000) / 1000, s: Math.round(TRUE_OPT.s * 100) / 100, pi: Math.round(TRUE_OPT.pi * 10) / 10, p: Math.round(TRUE_OPT.p * 10) / 10, w: Math.round(TRUE_OPT.w * 100) / 100 },
      safeOpt: { q: Math.round(SAFE_OPT.q * 1000) / 1000, s: Math.round(SAFE_OPT.s * 100) / 100, pi: Math.round(SAFE_OPT.pi * 10) / 10, p: Math.round(SAFE_OPT.p * 10) / 10, w: Math.round(SAFE_OPT.w * 100) / 100 },
      expPlan: { q: EXP.q, s: EXP.s, pi: Math.round(EXP_PI * 10) / 10, p: Math.round(EXP_P * 10) / 10, w: Math.round(EXP_W * 100) / 100 },
      rejected: { bayes: runs.bayes.rejected, grid: runs.grid.rejected, random: runs.random.rejected },
      feasible: { ok: FEAS.ok, total: FEAS.total, pct: FEAS.pct },
      noteLen: el('note').textContent.length
    };
  }

  /* ================= 12. 控件 ================= */
  var STRAT = [['random', '随机采样'], ['grid', '网格搜索'], ['bayes', '贝叶斯优化']];
  el('seg-strat').innerHTML = STRAT.map(function (p) {
    return "<button data-k='" + p[0] + "' class='" + (state.selected === p[0] ? 'on' : '') + "'>" + p[1] + "</button>";
  }).join('');
  el('seg-strat').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    state.selected = b.getAttribute('data-k');
    [].forEach.call(el('seg-strat').children, function (x) { x.classList.toggle('on', x === b); });
    render();
    trace('策略', '切换到 <b>' + nameOf(state.selected) + '</b>：左图与交付卡显示该策略；阶段 02—04 的 GP/EI 流水线始终是贝叶斯。');
  });

  el('run-all').addEventListener('click', runAll);
  el('run-one').addEventListener('click', runOne);

  el('reset').addEventListener('click', function () { resetAll(); });

  function tog(id, key) {
    var t = el(id);
    t.addEventListener('click', function () {
      state[key] = !state[key];
      t.classList.toggle('on', state[key]);
      render();
    });
  }
  tog('tog-true', 'showTrue'); tog('tog-proxy', 'showProxy'); tog('tog-feas', 'showFeas');

  var noiseTimer = null;
  el('r-noise').addEventListener('input', function () {
    state.noise = Number(this.value);
    el('o-noise').textContent = f1(state.noise) + ' %';
    clearTimeout(noiseTimer);
    noiseTimer = setTimeout(function () {
      stopAuto();
      resetRuns();
      fb = { ok: 0, fix: 0 };
      clearTrace();
      setStage(0);
      trace('参数', '测量噪声设为 <b>' + f1(state.noise) + '%</b>：整条流水线重置，GP 的噪声项与所有采样点重新计算。');
    }, 140);
  });

  el('flow').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    stopAuto();
    setStage(Number(b.getAttribute('data-s')));
  });

  el('feedback').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    var k = b.getAttribute('data-fb');
    fb[k]++;
    el('fb-note').textContent = '回写 ' + (fb.ok + fb.fix) + ' 条' + (fb.fix ? ' · 其中要求补算 ' + fb.fix + ' 条' : '') + ' · 人工确认后进入下一轮复算';
    trace('反馈', k === 'ok' ? '人工确认：<b>采纳推荐方案</b> · 记录 Q/S/压力余量，下一口井从这次回写开始' : '<b>要求补算</b> · 推荐点附近加 2 个验证点，下一轮优先复核', k === 'ok' ? 'ok' : 'warn');
  });

  /* ================= 13. 启动 ================= */
  resetRuns();
  clearTrace();
  setStage(0);
  trace('系统', '代理模型已在本页拟合：6 个初始设计 · 初始 RMSE <b>' + f2(initialSnapshot.rmse) + ' PI</b> · 预算 30 次模拟', 'ok');
})();
