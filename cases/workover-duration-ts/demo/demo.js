/* =========================================================
   修井周期预测 · 可运行示范（v4 · AI 作业流）
   ---------------------------------------------------------
   这条流水线回答的不是「这口井大概几天」，而是：
     历史工单 → 能不能用 → 模型看到什么 → 区间多准 → 怎么承诺
   ① 工单采集与质控：1450 井次 × 7 道工序，剔除异常/缺段/截断；
   ② 特征：井深、故障 one-hot、复杂度、工序数、打捞/套管/磨铣/压井；
   ③ 模型：7 道工序 × P10/P50/P90 = 21 组线性分位数回归，
      标准化 + pinball loss + 梯度下降，本页现场训练，留出 20% 验证；
   ④ 合成：工序分位 → 对数正态 + 共同因子相关 → 2000 次抽样相加；
   ⑤ 决策：计划工期滑杆 → 按期概率 / P80 承诺 / 人工回写。
   统计口径：工单与指标均为合成示范，价值数字（MAPE、兑现率、
   计划编制时间）是 1450 井次的示范口径，不是本页仿真读数。
   ========================================================= */
(function () {
  'use strict';

  /* ---------------- 业务常量 ---------------- */
  var FAULTS = [
    { key: 'fish', name: '落物打捞', f: 1.00, millP: 0.55 },
    { key: 'casing', name: '套管整形', f: 1.25, millP: 0.88 },
    { key: 'water', name: '找堵水', f: 0.85, millP: 0.20 },
    { key: 'sand', name: '冲砂防砂', f: 0.90, millP: 0.30 },
    { key: 'part', name: '管柱断脱', f: 1.35, millP: 0.50 }
  ];

  /* 工序：a=固定耗时(天)，b=每千米井深增加(天/km)，s=对数正态形状参数，
     w=复杂度对这道工序的影响权重（打捞/磨铣为 1.0） */
  var PROCS = [
    { name: '起原井管柱', a: 0.35, b: 0.55, s: 0.20, w: 0.45 },
    { name: '洗井 / 循环', a: 0.20, b: 0.12, s: 0.28, w: 0.12 },
    { name: '打捞 / 磨铣', a: 1.10, b: 0.90, s: 0.55, w: 1.00 },
    { name: '通井', a: 0.35, b: 0.30, s: 0.30, w: 0.35 },
    { name: '下泵 / 下管柱', a: 0.45, b: 0.45, s: 0.22, w: 0.45 },
    { name: '试压', a: 0.20, b: 0.03, s: 0.35, w: 0.12 },
    { name: '交井 / 收尾', a: 0.25, b: 0.02, s: 0.40, w: 0.12 }
  ];

  var QS = [0.1, 0.5, 0.9];
  var D = 9;
  var EP = 200, LR = 0.12, L2 = 0.002;
  var MC_N = 2000, LOAD = 0.6;
  var ZP = 1.2815515655;
  var SEED_TICKET = 20261031, SEED_DEFECT = 777, SEED_SPLIT = 4242, SEED_MC = 101581;
  var RAW_N = 1450, N_BAD = 47, N_MISS = 51, N_TRUNC = 30;

  var DEFAULTS = { fault: 'fish', depth: 2400, mill: true, kill: true, plan: 10 };
  var state = {
    fault: DEFAULTS.fault, depth: DEFAULTS.depth, mill: DEFAULTS.mill,
    kill: DEFAULTS.kill, plan: DEFAULTS.plan
  };
  var fb = { adopt: 0, adjust: 0 };
  var LAST = null;

  /* ---------------- 随机数 ---------------- */
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function makeGauss(rnd) {
    var spare = null;
    return function () {
      if (spare != null) { var v0 = spare; spare = null; return v0; }
      var u = 0, v = 0;
      while (u === 0) u = rnd();
      while (v === 0) v = rnd();
      var m = Math.sqrt(-2 * Math.log(u));
      spare = m * Math.sin(2 * Math.PI * v);
      return m * Math.cos(2 * Math.PI * v);
    };
  }
  function faultOf(k) {
    for (var i = 0; i < FAULTS.length; i++) if (FAULTS[i].key === k) return FAULTS[i];
    return FAULTS[0];
  }

  /* =========================================================
     01 工单采集与质控
     - 1450 井次，按 7 道标准工序生成耗时；
     - 47 条异常（耗时为负/顺序错）、51 条缺工序、30 条截断；
     - 质控后 1322 条进入训练/验证。
     ========================================================= */
  function buildData() {
    var rnd = mulberry32(SEED_TICKET), gauss = makeGauss(rnd);
    var tickets = [], i, p;
    for (i = 0; i < RAW_N; i++) {
      var fault = FAULTS[Math.floor(rnd() * FAULTS.length)];
      var depth = 1200 + Math.floor(rnd() * 49) * 50;
      var mill = rnd() < fault.millP;
      var kill = rnd() < 0.62;
      var comp = fault.f * (mill ? 1.18 : 1) * (kill ? 1.06 : 1);
      var km = depth / 1000;
      var u = gauss();
      var durs = [];
      for (p = 0; p < PROCS.length; p++) {
        var pr = PROCS[p];
        var m = (pr.a + pr.b * km) * (1 + (comp - 1) * pr.w);
        var z = 0.6 * u + 0.8 * gauss();
        durs.push(m * Math.exp(pr.s * z));
      }
      tickets.push({
        depth: depth, fault: fault, mill: mill, kill: kill,
        compOp: (mill ? 0.6 : 0) + (kill ? 0.4 : 0),
        nproc: 7 + (mill ? 1 : 0) + (kill ? 1 : 0),
        durs: durs
      });
    }

    /* 质控缺陷：固定条数、固定随机顺序，保证每次打开页面一致 */
    var order = [];
    for (i = 0; i < tickets.length; i++) order.push(i);
    var sr = mulberry32(SEED_DEFECT);
    for (i = order.length - 1; i > 0; i--) {
      var j = Math.floor(sr() * (i + 1));
      var tmp = order[i]; order[i] = order[j]; order[j] = tmp;
    }
    var defect = {};
    for (i = 0; i < N_BAD; i++) defect[order[i]] = 'bad';
    for (i = N_BAD; i < N_BAD + N_MISS; i++) defect[order[i]] = 'miss';
    for (i = N_BAD + N_MISS; i < N_BAD + N_MISS + N_TRUNC; i++) defect[order[i]] = 'trunc';

    var qc = { raw: RAW_N, bad: 0, miss: 0, trunc: 0, ok: 0 };
    var usable = [];
    for (i = 0; i < tickets.length; i++) {
      var t = tickets[i], d = defect[i];
      if (d === 'bad') {
        qc.bad++; t.defect = 'bad';
        t.durs[2] = -0.3;                    /* 负耗时：不可能进模型 */
        continue;
      }
      if (d === 'miss') {
        qc.miss++; t.defect = 'miss';
        t.durs[2] = NaN;                     /* 7 道缺 1 */
        continue;
      }
      if (d === 'trunc') {
        qc.trunc++; t.defect = 'trunc';
        var sum = 0;
        for (p = 0; p < t.durs.length; p++) sum += t.durs[p];
        var k = 2.6 / sum;
        for (p = 0; p < t.durs.length; p++) t.durs[p] *= k;  /* 系统在 2.6 天截断 */
        continue;
      }
      qc.ok++; usable.push(t);
    }
    return { tickets: tickets, usable: usable, qc: qc };
  }

  /* =========================================================
     02 特征：模型只吃这 9 个数
     ========================================================= */
  function feats(t) {
    return [
      t.depth / 1000,
      t.fault.key === 'fish' ? 1 : 0,
      t.fault.key === 'casing' ? 1 : 0,
      t.fault.key === 'water' ? 1 : 0,
      t.fault.key === 'sand' ? 1 : 0,
      t.compOp,
      t.nproc,
      t.mill ? 1 : 0,
      t.kill ? 1 : 0
    ];
  }

  /* =========================================================
     03 分位数回归：21 组线性模型，pinball loss 现场训练
     ========================================================= */
  function dot(m, x) {
    var s = m.b;
    for (var j = 0; j < D; j++) s += m.w[j] * x[j];
    return s;
  }

  function predictFromX(x, models) {
    var out = [];
    for (var p = 0; p < 7; p++) {
      var a = Math.exp(dot(models[p * 3], x));
      var b = Math.exp(dot(models[p * 3 + 1], x));
      var c = Math.exp(dot(models[p * 3 + 2], x));
      var arr = [a, b, c].sort(function (u, v) { return u - v; });
      out.push({ p10: arr[0], p50: arr[1], p90: arr[2] });
    }
    return out;
  }

  function valLoss(X, set, models) {
    var total = 0;
    for (var n = 0; n < X.length; n++) {
      var x = X[n];
      for (var mi = 0; mi < models.length; mi++) {
        var m = models[mi];
        var e = Math.log(set[n].durs[m.p]) - dot(m, x);
        total += e > 0 ? m.tau * e : (m.tau - 1) * e;
      }
    }
    return total / X.length / models.length;
  }

  function trainModel(data) {
    var usable = data.usable, i, j, p, qi, mi, n, ep;
    var idx = [];
    for (i = 0; i < usable.length; i++) idx.push(i);
    var sr = mulberry32(SEED_SPLIT);
    for (i = idx.length - 1; i > 0; i--) {
      var jj = Math.floor(sr() * (i + 1));
      var tmp = idx[i]; idx[i] = idx[jj]; idx[jj] = tmp;
    }
    var nVal = Math.round(usable.length * 0.2);
    var nTrain = usable.length - nVal;
    var trainSet = [], valSet = [];
    for (i = 0; i < nTrain; i++) trainSet.push(usable[idx[i]]);
    for (i = nTrain; i < usable.length; i++) valSet.push(usable[idx[i]]);

    /* 特征标准化（只用训练集统计量） */
    var mu = new Array(D), sd = new Array(D);
    for (j = 0; j < D; j++) { mu[j] = 0; sd[j] = 0; }
    for (i = 0; i < trainSet.length; i++) {
      var xr = feats(trainSet[i]);
      for (j = 0; j < D; j++) mu[j] += xr[j];
    }
    for (j = 0; j < D; j++) mu[j] /= trainSet.length;
    for (i = 0; i < trainSet.length; i++) {
      xr = feats(trainSet[i]);
      for (j = 0; j < D; j++) sd[j] += Math.pow(xr[j] - mu[j], 2);
    }
    for (j = 0; j < D; j++) sd[j] = Math.sqrt(sd[j] / trainSet.length) || 1;
    function sx(t) {
      var raw = feats(t), z = new Array(D);
      for (var k = 0; k < D; k++) z[k] = (raw[k] - mu[k]) / sd[k];
      return z;
    }
    var Xtr = [], Xval = [];
    for (i = 0; i < trainSet.length; i++) Xtr.push(sx(trainSet[i]));
    for (i = 0; i < valSet.length; i++) Xval.push(sx(valSet[i]));

    /* 21 组模型：7 道工序 × 3 个分位 */
    var models = [];
    for (p = 0; p < 7; p++) {
      for (qi = 0; qi < 3; qi++) {
        models.push({
          p: p, tau: QS[qi],
          w: new Array(D).fill(0), vw: new Array(D).fill(0),
          b: 0, vb: 0, gw: new Array(D).fill(0), gb: 0, loss: 0
        });
      }
    }

    var hist = [], vhist = [];
    for (ep = 0; ep < EP; ep++) {
      for (mi = 0; mi < models.length; mi++) {
        var mm = models[mi];
        mm.gw.fill(0); mm.gb = 0; mm.loss = 0;
      }
      for (n = 0; n < Xtr.length; n++) {
        var x = Xtr[n];
        for (mi = 0; mi < models.length; mi++) {
          mm = models[mi];
          var y = Math.log(trainSet[n].durs[mm.p]);
          var pred = mm.b;
          for (j = 0; j < D; j++) pred += mm.w[j] * x[j];
          var e = y - pred;
          /* pinball loss 的次梯度：低估时 -tau，高估时 +(1-tau) */
          var g = e > 0 ? -mm.tau : (1 - mm.tau);
          mm.gb += g;
          for (j = 0; j < D; j++) mm.gw[j] += g * x[j];
          mm.loss += e > 0 ? mm.tau * e : (mm.tau - 1) * e;
        }
      }
      for (mi = 0; mi < models.length; mi++) {
        mm = models[mi];
        mm.vb = 0.9 * mm.vb - LR * mm.gb / Xtr.length;
        mm.b += mm.vb;
        for (j = 0; j < D; j++) {
          mm.vw[j] = 0.9 * mm.vw[j] - LR * (mm.gw[j] / Xtr.length + L2 * mm.w[j]);
          mm.w[j] += mm.vw[j];
        }
      }
      if (ep % 4 === 0 || ep === EP - 1) {
        var tl = 0;
        for (mi = 0; mi < models.length; mi++) tl += models[mi].loss;
        hist.push(tl / Xtr.length / models.length);
        vhist.push(valLoss(Xval, valSet, models));
      }
    }

    /* 验证：覆盖率、P50 误差、校准桶、分位交叉 */
    var cover = 0, tot = 0, c10 = 0, c90 = 0, cross = 0;
    var absErr = [], cal = [];
    for (n = 0; n < Xval.length; n++) {
      var xv = Xval[n], tv = valSet[n];
      var pr = predictFromX(xv, models);
      for (p = 0; p < 7; p++) {
        var raw10 = Math.exp(dot(models[p * 3], xv));
        var raw50 = Math.exp(dot(models[p * 3 + 1], xv));
        var raw90 = Math.exp(dot(models[p * 3 + 2], xv));
        if (!(raw10 <= raw50 && raw50 <= raw90)) cross++;
        var a = pr[p].p10, b50 = pr[p].p50, c = pr[p].p90;
        var act = tv.durs[p];
        tot++;
        if (act >= a && act <= c) cover++;
        if (act <= a) c10++;
        if (act <= c) c90++;
        absErr.push(Math.abs(b50 - act));
        cal.push({ pred: b50, act: act });
      }
    }
    absErr.sort(function (u, v) { return u - v; });
    var medAE = absErr[Math.floor(absErr.length / 2)];

    cal.sort(function (u, v) { return u.pred - v.pred; });
    var calib = [];
    for (var bi = 0; bi < 5; bi++) {
      var seg = cal.slice(Math.floor(bi * cal.length / 5), Math.floor((bi + 1) * cal.length / 5));
      var ps = [], as = [];
      for (i = 0; i < seg.length; i++) { ps.push(seg[i].pred); as.push(seg[i].act); }
      ps.sort(function (u, v) { return u - v; });
      as.sort(function (u, v) { return u - v; });
      calib.push({
        pred: ps[Math.floor(ps.length / 2)],
        act: as[Math.floor(as.length / 2)]
      });
    }

    /* 总工期 P50 误差：每口验证井抽 120 次，与真实总工期比 */
    var totalAE = [];
    for (n = 0; n < Xval.length; n++) {
      var pt = predictFromX(Xval[n], models);
      var tt = simulateTotals(pt, 120, false).slice().sort(function (u, v) { return u - v; });
      var medT = q(tt, 0.5);
      var actT = 0;
      for (p = 0; p < 7; p++) actT += valSet[n].durs[p];
      totalAE.push(Math.abs(medT - actT));
    }
    totalAE.sort(function (u, v) { return u - v; });

    return {
      mu: mu, sd: sd, models: models, hist: hist, vhist: vhist,
      nTrain: nTrain, nVal: nVal,
      coverage: cover / tot, cover10: c10 / tot, cover90: c90 / tot,
      cross: cross, medAE: medAE,
      totalMedAE: totalAE[Math.floor(totalAE.length / 2)],
      calib: calib
    };
  }

  /* =========================================================
     04 蒙特卡洛：预生成相关正态，固定随机流（common random numbers）
     ========================================================= */
  function buildMC() {
    var Z = [], Z0 = [], i, p;
    var r1 = mulberry32(SEED_MC), g1 = makeGauss(r1);
    var r0 = mulberry32(SEED_MC + 1), g0 = makeGauss(r0);
    for (i = 0; i < MC_N; i++) {
      var z0 = g1(), row = [];
      for (p = 0; p < 7; p++) row.push(LOAD * z0 + Math.sqrt(1 - LOAD * LOAD) * g1());
      Z.push(row);
      var row0 = [];
      for (p = 0; p < 7; p++) row0.push(g0());
      Z0.push(row0);
    }
    return { Z: Z, Z0: Z0 };
  }

  function sigmaOf(d) {
    var s = Math.log(d.p90 / d.p10) / (2 * ZP);
    return (!isFinite(s) || s <= 0) ? 0.2 : s;
  }

  function simulateTotals(preds, n, indep) {
    var Z = indep ? MC.Z0 : MC.Z;
    var out = new Array(n);
    for (var i = 0; i < n; i++) {
      var sum = 0;
      for (var p = 0; p < 7; p++) {
        sum += preds[p].p50 * Math.exp(sigmaOf(preds[p]) * Z[i][p]);
      }
      out[i] = sum;
    }
    return out;
  }

  function simulate(preds, n) {
    var totals = new Array(n), per = [], p, i;
    for (p = 0; p < 7; p++) per.push(new Array(n));
    for (i = 0; i < n; i++) {
      var sum = 0;
      for (p = 0; p < 7; p++) {
        var v = preds[p].p50 * Math.exp(sigmaOf(preds[p]) * MC.Z[i][p]);
        per[p][i] = v;
        sum += v;
      }
      totals[i] = sum;
    }
    var cum = [], run = new Array(n);
    for (i = 0; i < n; i++) run[i] = 0;
    for (p = 0; p < 7; p++) {
      for (i = 0; i < n; i++) run[i] += per[p][i];
      cum.push(run.slice());
    }
    return { totals: totals, per: per, cum: cum };
  }

  /* ---------------- 统计小工具 ---------------- */
  function q(sorted, p) {
    var i = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
    return sorted[i];
  }
  function meanOf(a) {
    var s = 0;
    for (var i = 0; i < a.length; i++) s += a[i];
    return s / a.length;
  }
  function statsOf(totals, plan) {
    var sorted = totals.slice().sort(function (a, b) { return a - b; });
    var n = sorted.length, i, ok = 0;
    for (i = 0; i < n; i++) { if (sorted[i] <= plan) ok++; else break; }
    return {
      sorted: sorted,
      p10: q(sorted, 0.1), p50: q(sorted, 0.5), p70: q(sorted, 0.7),
      p80: q(sorted, 0.8), p90: q(sorted, 0.9),
      mean: meanOf(totals), prob: ok / n
    };
  }
  function inCdf(sorted, v) {
    if (v < sorted[0]) return 0;
    if (v >= sorted[sorted.length - 1]) return 1;
    var lo = 0, hi = sorted.length - 1;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (sorted[mid] <= v) lo = mid + 1; else hi = mid;
    }
    return lo / sorted.length;
  }
  function sharesOf(res) {
    var rawT = res.totals, n = rawT.length, meanT = meanOf(rawT);
    var varT = 0, i, p;
    for (i = 0; i < n; i++) varT += Math.pow(rawT[i] - meanT, 2);
    varT /= n;
    var shares = [];
    for (p = 0; p < 7; p++) {
      var arr = res.per[p], ma = meanOf(arr), cov = 0;
      for (i = 0; i < n; i++) cov += (arr[i] - ma) * (rawT[i] - meanT);
      shares.push(cov / n / varT);
    }
    return shares;
  }
  function corrOf(a, b) {
    var n = a.length, ma = 0, mb = 0, i;
    for (i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    var ca = 0, va = 0, vb = 0;
    for (i = 0; i < n; i++) {
      var da = a[i] - ma, db = b[i] - mb;
      ca += da * db; va += da * da; vb += db * db;
    }
    return ca / Math.sqrt(va * vb);
  }

  /* ---------------- 初始化数据与模型 ---------------- */
  var DATA = buildData();
  var MC = buildMC();
  var MODEL = trainModel(DATA);

  /* =========================================================
     绘图
     ========================================================= */
  var el = function (id) { return document.getElementById(id); };
  var C = { jade: '#1d4e50', jadeL: '#c8dbd2', clay: '#a9742c', clayL: '#f0e0c8', bad: '#a64b3c', ink3: '#6f7a7c', ink4: '#99a3a4', line: '#efece1' };

  function drawGantt(res, stats, keyIdx) {
    var W = 680, H = 210, L = 92, R = 150, T = 22, B = 30;
    var rowH = (H - T - B) / PROCS.length;
    var tmax = Math.ceil(stats.p90 * 1.05 / 2) * 2;
    if (tmax < stats.p90 * 1.02) tmax += 2;
    function x(t) { return L + t / tmax * (W - L - R); }
    var s = '', i, t;
    for (t = 0; t <= tmax + 1e-9; t += 2) {
      s += '<line x1="' + x(t).toFixed(1) + '" y1="' + T + '" x2="' + x(t).toFixed(1) + '" y2="' + (H - B) + '" stroke="' + C.line + '"/>' +
        '<text x="' + x(t).toFixed(1) + '" y="' + (T - 8) + '" font-size="9" fill="' + C.ink4 + '" text-anchor="middle" font-family="monospace">' + t + '</text>';
    }
    var prev50 = 0;
    for (i = 0; i < PROCS.length; i++) {
      var arr = res.cum[i].slice().sort(function (a, b) { return a - b; });
      var c10 = q(arr, 0.1), c50 = q(arr, 0.5), c90 = q(arr, 0.9);
      var y = T + i * rowH + rowH / 2;
      var isKey = i === keyIdx;
      s += '<text x="' + (L - 8) + '" y="' + (y + 3.5) + '" font-size="10" text-anchor="end" fill="' + (isKey ? C.clay : '#4a585c') + '">' + PROCS[i].name + '</text>';
      s += '<rect x="' + x(c10).toFixed(1) + '" y="' + (y - 8) + '" width="' + Math.max(1.5, x(c90) - x(c10)).toFixed(1) + '" height="16" rx="4" fill="' + (isKey ? C.clayL : C.jadeL) + '"/>';
      s += '<rect x="' + x(prev50).toFixed(1) + '" y="' + (y - 5) + '" width="' + Math.max(1.5, x(c50) - x(prev50)).toFixed(1) + '" height="10" rx="3" fill="' + (isKey ? C.clay : C.jade) + '"/>';
      s += '<text x="' + (W - R + 8) + '" y="' + (y + 3.2) + '" font-size="8.5" font-family="monospace" fill="' + C.ink3 + '">完成 ' + c10.toFixed(1) + '—' + c90.toFixed(1) + ' 天</text>';
      prev50 = c50;
    }
    var xp50 = x(stats.p50), xp90 = x(stats.p90);
    s += '<line x1="' + xp50.toFixed(1) + '" y1="' + (T - 2) + '" x2="' + xp50.toFixed(1) + '" y2="' + (H - B + 4) + '" stroke="' + C.jade + '" stroke-width="1.4"/>';
    s += '<line x1="' + xp90.toFixed(1) + '" y1="' + (T - 2) + '" x2="' + xp90.toFixed(1) + '" y2="' + (H - B + 4) + '" stroke="' + C.clay + '" stroke-width="1.4" stroke-dasharray="4 3"/>';
    var l50 = '总 P50 ' + stats.p50.toFixed(1) + ' 天', l90 = '总 P90 ' + stats.p90.toFixed(1) + ' 天';
    if (Math.abs(xp90 - xp50) < 80) {
      s += '<text x="' + (xp50 - 4).toFixed(1) + '" y="' + (H - 9) + '" font-size="9" font-family="monospace" fill="' + C.jade + '" text-anchor="end">' + l50 + '</text>';
      s += '<text x="' + (xp90 + 4).toFixed(1) + '" y="' + (H - 9) + '" font-size="9" font-family="monospace" fill="' + C.clay + '" text-anchor="start">' + l90 + '</text>';
    } else {
      s += '<text x="' + xp50.toFixed(1) + '" y="' + (H - 9) + '" font-size="9" font-family="monospace" fill="' + C.jade + '" text-anchor="middle">' + l50 + '</text>';
      s += '<text x="' + xp90.toFixed(1) + '" y="' + (H - 9) + '" font-size="9" font-family="monospace" fill="' + C.clay + '" text-anchor="middle">' + l90 + '</text>';
    }
    el('gantt').innerHTML = s;
  }

  function niceStep(v) {
    var cand = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000];
    for (var i = 0; i < cand.length; i++) if (v / cand[i] <= 5.5) return cand[i];
    return 2000;
  }

  function drawHist(sorted, stats) {
    var W = 680, H = 165, L = 46, R = 16, T = 14, B = 34;
    var lo = Math.floor(sorted[0] * 2) / 2, hi = Math.ceil(sorted[sorted.length - 1] * 2) / 2;
    var bins = 30, bw = (hi - lo) / bins, counts = new Array(bins).fill(0);
    var i, t;
    for (i = 0; i < sorted.length; i++) {
      var b = Math.min(bins - 1, Math.floor((sorted[i] - lo) / bw));
      counts[b]++;
    }
    var cmax = Math.max.apply(null, counts);
    var ystep = niceStep(cmax);
    var ytop = Math.ceil(cmax / ystep) * ystep;
    function x(v) { return L + (v - lo) / (hi - lo) * (W - L - R); }
    function yb(c) { return H - B - c / ytop * (H - T - B); }
    var s = '';
    s += '<text x="6" y="11" font-size="8.5" fill="' + C.ink4 + '" font-family="monospace">频数</text>';
    for (var c = 0; c <= ytop + 1e-9; c += ystep) {
      var yy = yb(c);
      s += '<line x1="' + L + '" y1="' + yy.toFixed(1) + '" x2="' + (W - R) + '" y2="' + yy.toFixed(1) + '" stroke="' + C.line + '"/>';
      s += '<text x="' + (L - 6) + '" y="' + (yy + 3).toFixed(1) + '" font-size="8.5" fill="' + C.ink4 + '" text-anchor="end" font-family="monospace">' + c + '</text>';
    }
    s += '<line x1="' + L + '" y1="' + T + '" x2="' + L + '" y2="' + (H - B) + '" stroke="#d3c9b6"/>';
    for (i = 0; i < bins; i++) {
      var v0 = lo + i * bw, v1 = v0 + bw;
      var col;
      if (v1 <= state.plan) col = '#c8dbd2';
      else if (v0 >= state.plan) col = 'rgba(176,84,74,.55)';
      else col = '#e6d3ae';
      s += '<rect x="' + x(v0).toFixed(1) + '" y="' + yb(counts[i]).toFixed(1) + '" width="' + Math.max(1, x(v1) - x(v0) - 1).toFixed(1) + '" height="' + (H - B - yb(counts[i])).toFixed(1) + '" fill="' + col + '"/>';
    }
    s += '<line x1="' + L + '" y1="' + (H - B) + '" x2="' + (W - R) + '" y2="' + (H - B) + '" stroke="#d3c9b6"/>';
    var span = hi - lo;
    var stepX = span > 20 ? 5 : span > 10 ? 2 : 1;
    for (t = Math.ceil(lo); t <= hi; t += stepX) {
      s += '<text x="' + x(t).toFixed(1) + '" y="' + (H - B + 13) + '" font-size="9" fill="' + C.ink4 + '" text-anchor="middle" font-family="monospace">' + t + '</text>';
    }
    s += '<text x="' + ((L + W - R) / 2).toFixed(1) + '" y="' + (H - 7) + '" font-size="9" fill="' + C.ink4 + '" text-anchor="middle">总工期 / 天</text>';

    function vline(v, col, label, dash, ly, anchor, xo) {
      var xx = xo != null ? xo : x(v);
      return '<line x1="' + xx.toFixed(1) + '" y1="' + T + '" x2="' + xx.toFixed(1) + '" y2="' + (H - B) + '" stroke="' + col + '" stroke-width="1.3"' + (dash ? ' stroke-dasharray="4 3"' : '') + '/>' +
        '<text x="' + (xx + (anchor === 'end' ? -4 : 4)).toFixed(1) + '" y="' + ly + '" font-size="9" fill="' + col + '" font-family="monospace" text-anchor="' + (anchor || 'start') + '">' + label + '</text>';
    }
    s += vline(stats.p10, C.jade, 'P10 ' + stats.p10.toFixed(1), true, T + 12);
    s += vline(stats.p90, C.clay, 'P90 ' + stats.p90.toFixed(1), true, T + 12);
    var lowOut = state.plan < lo, highOut = state.plan > hi;
    var closeP50 = !lowOut && !highOut && Math.abs(state.plan - stats.p50) <= 0.6;
    if (closeP50) {
      s += '<line x1="' + x(stats.p50).toFixed(1) + '" y1="' + T + '" x2="' + x(stats.p50).toFixed(1) + '" y2="' + (H - B) + '" stroke="' + C.jade + '" stroke-width="1.4"/>';
      s += '<line x1="' + x(state.plan).toFixed(1) + '" y1="' + T + '" x2="' + x(state.plan).toFixed(1) + '" y2="' + (H - B) + '" stroke="' + C.bad + '" stroke-width="1.3" stroke-dasharray="4 3" opacity=".55"/>';
      s += '<text x="' + (x(stats.p50) + 4).toFixed(1) + '" y="' + (T + 24) + '" font-size="9" fill="' + C.bad + '" font-family="monospace">P50 ' + stats.p50.toFixed(1) + ' ≈ 计划 ' + state.plan + ' 天</text>';
    } else {
      s += vline(stats.p50, C.jade, 'P50 ' + stats.p50.toFixed(1), false, T + 24);
      if (lowOut) s += vline(state.plan, C.bad, '计划 ' + state.plan + ' 天 · 低于全部样本', false, T + 36, 'start', L);
      else if (highOut) s += vline(state.plan, C.bad, '计划 ' + state.plan + ' 天 · 高于全部样本', false, T + 36, 'end', W - R);
      else s += vline(state.plan, C.bad, '计划 ' + state.plan + ' 天', false, T + 36);
    }
    el('hist').innerHTML = s;
  }

  function drawCdf(sorted, stats) {
    var W = 680, H = 108, L = 38, R = 14, T = 10, B = 22;
    var min = sorted[0], max = sorted[sorted.length - 1];
    function x(v) { return L + (v - min) / Math.max(0.01, max - min) * (W - L - R); }
    function y(p) { return T + (1 - p) * (H - T - B); }
    var s = '', i, t;
    [0, 0.25, 0.5, 0.75, 1].forEach(function (p) {
      s += '<line x1="' + L + '" y1="' + y(p) + '" x2="' + (W - R) + '" y2="' + y(p) + '" stroke="#eee8da"/>';
      s += '<text x="' + (L - 5) + '" y="' + (y(p) + 3) + '" text-anchor="end" font-size="8" font-family="monospace" fill="#98a199">' + Math.round(p * 100) + '%</text>';
    });
    for (t = 0; t <= 4; t++) {
      var vv = min + (max - min) * t / 4;
      s += '<line x1="' + x(vv) + '" y1="' + (H - B) + '" x2="' + x(vv) + '" y2="' + (H - B + 4) + '" stroke="#cbbfa7"/>';
      s += '<text x="' + x(vv) + '" y="' + (H - B + 13) + '" text-anchor="middle" font-size="8" font-family="monospace" fill="#98a199">' + vv.toFixed(0) + '</text>';
    }
    var d = '', area = 'M' + x(min) + ' ' + y(0);
    for (i = 0; i <= 160; i++) {
      var v = min + (max - min) * i / 160;
      var p = inCdf(sorted, v);
      d += (i ? 'L' : 'M') + x(v).toFixed(1) + ' ' + y(p).toFixed(1);
      area += 'L' + x(v).toFixed(1) + ' ' + y(p).toFixed(1);
    }
    area += 'L' + x(max) + ' ' + y(0) + 'Z';
    s += '<path d="' + area + '" fill="rgba(18,59,58,.08)"/>';
    s += '<path d="' + d + '" fill="none" stroke="#123b3a" stroke-width="1.8"/>';
    [[stats.p50, 'P50'], [stats.p90, 'P90']].forEach(function (m) {
      s += '<line x1="' + x(m[0]) + '" y1="' + T + '" x2="' + x(m[0]) + '" y2="' + (H - B) + '" stroke="#b4762a" stroke-width=".8" stroke-dasharray="3 3" opacity=".55"/>';
      s += '<text x="' + x(m[0]) + '" y="' + (H - B - 3) + '" text-anchor="middle" font-size="8" fill="#8a5718" font-family="monospace">' + m[1] + '</text>';
    });
    var px = x(Math.max(min, Math.min(max, state.plan)));
    var pp = inCdf(sorted, state.plan);
    s += '<line x1="' + px + '" y1="' + T + '" x2="' + px + '" y2="' + (H - B) + '" stroke="#9c4235" stroke-width="1.2" stroke-dasharray="4 3"/>';
    s += '<circle cx="' + px + '" cy="' + y(pp) + '" r="3.4" fill="#fbf8f0" stroke="#9c4235" stroke-width="1.8"/>';
    s += '<text x="' + Math.min(px + 6, W - R - 92) + '" y="' + Math.max(T + 10, y(pp) - 7) + '" font-size="9" fill="#9c4235">计划 ' + state.plan + ' 天 · ' + Math.round(pp * 100) + '%</text>';
    el('cdf').innerHTML = s;
  }

  function drawLoss() {
    var svg = el('curve');
    if (!svg) return;
    var W = 320, H = 54, L = 26, R = 30, T = 5, B = 11;
    var hist = MODEL.hist, vhist = MODEL.vhist;
    var all = hist.concat(vhist);
    var lo = Math.min.apply(null, all), hi = Math.max.apply(null, all);
    var pad = (hi - lo) * 0.15 || 0.005;
    lo = Math.max(0, lo - pad); hi += pad;
    function X(i) { return L + i * (W - L - R) / Math.max(1, hist.length - 1); }
    function Y(v) { return T + (1 - (v - lo) / (hi - lo)) * (H - T - B); }
    var s = '';
    [0, 0.5, 1].forEach(function (t) {
      var v = lo + (hi - lo) * t, yy = Y(v);
      s += '<line x1="' + L + '" y1="' + yy + '" x2="' + (W - R) + '" y2="' + yy + '" stroke="#efece1"/>' +
        '<text x="' + (L - 3) + '" y="' + (yy + 3) + '" text-anchor="end" font-size="7" font-family="monospace" fill="#99a3a4">' + v.toFixed(3) + '</text>';
    });
    function path(arr) {
      return arr.map(function (v, i) { return (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1); }).join('');
    }
    s += '<path d="' + path(hist) + '" fill="none" stroke="#1d4e50" stroke-width="1.6"/>';
    s += '<path d="' + path(vhist) + '" fill="none" stroke="#a9742c" stroke-width="1.3" stroke-dasharray="3 2"/>';
    var y1 = Y(hist[hist.length - 1]), y2 = Y(vhist[vhist.length - 1]);
    if (Math.abs(y1 - y2) < 8) { y1 -= 4; y2 += 6; }
    s += '<text x="' + (W - R + 3) + '" y="' + (y1 + 2.5) + '" font-size="7" fill="#1d4e50">训练</text>';
    s += '<text x="' + (W - R + 3) + '" y="' + (y2 + 2.5) + '" font-size="7" fill="#a9742c">验证</text>';
    s += '<text x="' + L + '" y="' + (H - 1) + '" font-size="7" font-family="monospace" fill="#99a3a4">0</text>';
    s += '<text x="' + (W - R) + '" y="' + (H - 1) + '" text-anchor="end" font-size="7" font-family="monospace" fill="#99a3a4">' + EP + ' 轮</text>';
    svg.innerHTML = s;
  }

  function drawCalib() {
    var svg = el('calib');
    if (!svg) return;
    var W = 320, H = 78, L = 28, R = 8, T = 6, B = 16;
    var maxV = 0;
    MODEL.calib.forEach(function (d) { maxV = Math.max(maxV, d.pred, d.act); });
    maxV = Math.max(1, Math.ceil(maxV * 1.12 * 2) / 2);
    function X(v) { return L + v / maxV * (W - L - R); }
    function Y(v) { return T + (1 - v / maxV) * (H - T - B); }
    var s = '', i;
    for (i = 1; i <= 3; i++) {
      var gv = maxV * i / 4;
      s += '<line x1="' + X(gv) + '" y1="' + T + '" x2="' + X(gv) + '" y2="' + (H - B) + '" stroke="#f0ede4"/>';
      s += '<line x1="' + L + '" y1="' + Y(gv) + '" x2="' + (W - R) + '" y2="' + Y(gv) + '" stroke="#f0ede4"/>';
    }
    s += '<line x1="' + L + '" y1="' + (H - B) + '" x2="' + (W - R) + '" y2="' + (H - B) + '" stroke="#d3c9b6"/>';
    s += '<line x1="' + L + '" y1="' + T + '" x2="' + L + '" y2="' + (H - B) + '" stroke="#d3c9b6"/>';
    s += '<line x1="' + X(0) + '" y1="' + Y(0) + '" x2="' + X(maxV) + '" y2="' + Y(maxV) + '" stroke="#b4762a" stroke-width="1" stroke-dasharray="4 3" opacity=".7"/>';
    var pts = MODEL.calib.map(function (d) { return X(d.pred).toFixed(1) + ',' + Y(d.act).toFixed(1); });
    s += '<path d="M' + pts.join('L') + '" fill="none" stroke="#1d4e50" stroke-width="1.2" opacity=".55"/>';
    MODEL.calib.forEach(function (d) {
      s += '<circle cx="' + X(d.pred).toFixed(1) + '" cy="' + Y(d.act).toFixed(1) + '" r="2.6" fill="#fbf8f0" stroke="#1d4e50" stroke-width="1.5"/>';
    });
    s += '<text x="' + (L + 2) + '" y="' + (T + 7) + '" font-size="7" fill="#8a5718">实际 ↑</text>';
    s += '<text x="' + (W - R) + '" y="' + (T + 7) + '" text-anchor="end" font-size="7" fill="#8a5718">预测 →</text>';
    s += '<text x="' + L + '" y="' + (H - 3) + '" font-size="7" font-family="monospace" fill="#99a3a4">0</text>';
    s += '<text x="' + (W - R) + '" y="' + (H - 3) + '" text-anchor="end" font-size="7" font-family="monospace" fill="#99a3a4">' + maxV.toFixed(1) + ' 天</text>';
    svg.innerHTML = s;
  }

  function drawContrib(groups) {
    var max = 0;
    groups.forEach(function (g) { max = Math.max(max, Math.abs(g.c)); });
    if (max < 1e-6) max = 1;
    el('contrib').innerHTML = groups.map(function (g) {
      var w = Math.abs(g.c) / max * 50;
      var style = g.c >= 0
        ? 'left:50%;width:' + w.toFixed(1) + '%;background:var(--jade)'
        : 'right:50%;width:' + w.toFixed(1) + '%;background:var(--bad)';
      return '<div class="grpbar"><span>' + g.label + '</span><span class="track"><i style="' + style + '"></i></span><span class="val">×' + Math.exp(g.c).toFixed(2) + '</span></div>';
    }).join('') + '<p class="mini" style="margin-top:2px">×1.00 = 训练集均值井；&gt;1 拉长、&lt;1 缩短。共线作业特征会分摊权重。</p>';
  }

  /* =========================================================
     当前工单 → 预测 → 合成 → 页面
     ========================================================= */
  function currentJob() {
    var f = faultOf(state.fault);
    return {
      depth: state.depth, fault: f, mill: state.mill, kill: state.kill,
      compOp: (state.mill ? 0.6 : 0) + (state.kill ? 0.4 : 0),
      nproc: 7 + (state.mill ? 1 : 0) + (state.kill ? 1 : 0)
    };
  }

  function standardizeJob(job) {
    var raw = feats(job), z = new Array(D);
    for (var j = 0; j < D; j++) z[j] = (raw[j] - MODEL.mu[j]) / MODEL.sd[j];
    return z;
  }

  function setBar(id, z) {
    var b = el(id);
    if (!b) return;
    var w = Math.min(50, Math.abs(z) / 2.5 * 50);
    b.style.width = w.toFixed(1) + '%';
    if (z >= 0) { b.style.left = '50%'; b.style.right = 'auto'; }
    else { b.style.right = '50%'; b.style.left = 'auto'; }
    b.style.background = z >= 0 ? 'var(--jade)' : 'var(--bad)';
  }

  function render() {
    var job = currentJob();
    var x = standardizeJob(job);
    var preds = predictFromX(x, MODEL.models);
    var res = simulate(preds, MC_N);
    var stats = statsOf(res.totals, state.plan);
    var indepStats = statsOf(simulateTotals(preds, MC_N, true), state.plan);
    var shares = sharesOf(res);
    var keyIdx = 0, i, j;
    for (i = 1; i < 7; i++) if (shares[i] > shares[keyIdx]) keyIdx = i;
    var corrSum = 0, corrN = 0;
    for (i = 0; i < 7; i++) for (j = i + 1; j < 7; j++) { corrSum += corrOf(res.per[i], res.per[j]); corrN++; }
    var corrAvg = corrSum / corrN;
    var pct = stats.prob >= 1 ? 100 : Math.min(99, Math.round(stats.prob * 100));

    /* 头部 */
    el('st-p50').innerHTML = stats.p50.toFixed(1) + '<small>天</small>';
    el('st-p90').innerHTML = stats.p90.toFixed(1) + '<small>天</small>';
    el('st-prob').innerHTML = pct + '<small>%</small>';
    el('st-w').innerHTML = (stats.p90 - stats.p10).toFixed(1) + '<small>天</small>';
    el('mc-hint').textContent = '2000 次 · 共同因子 0.60 / 平均相关 ' + corrAvg.toFixed(2) + ' · 均值 ' + stats.mean.toFixed(1) + ' 天';

    /* 左列主画布 */
    drawGantt(res, stats, keyIdx);
    drawHist(stats.sorted, stats);
    drawCdf(stats.sorted, stats);

    /* 01 采集与质控 */
    el('q-bad').textContent = DATA.qc.bad;
    el('q-miss').textContent = DATA.qc.miss;
    el('q-trunc').textContent = DATA.qc.trunc;
    el('q-ok').textContent = DATA.qc.ok;
    el('q-rate').textContent = (DATA.qc.ok / DATA.qc.raw * 100).toFixed(1) + '%';
    el('q-split').textContent = MODEL.nTrain + ' / ' + MODEL.nVal;
    el('q-cur').innerHTML = job.depth + ' m · ' + job.fault.name + ' · ' + (job.mill ? '磨铣' : '不磨铣') + (job.kill ? '+压井' : '') + ' · ' + job.nproc + ' 道工序';
    el('q-gate').innerHTML = '<span class="db ok">可用 · 进入特征</span>';

    /* 02 特征 */
    var raw = feats(job);
    el('fv-depth').textContent = raw[0].toFixed(2) + ' km (z ' + (x[0] >= 0 ? '+' : '') + x[0].toFixed(2) + ')';
    setBar('fb-depth', x[0]);
    el('f-onehot').innerHTML = FAULTS.map(function (f) {
      var on = job.fault.key === f.key;
      return '<span class="chip' + (on ? ' on' : '') + '">' + f.name + ' ' + (on ? 1 : 0) + '</span>';
    }).join('');
    el('fv-comp').textContent = raw[5].toFixed(2) + ' (z ' + (x[5] >= 0 ? '+' : '') + x[5].toFixed(2) + ')';
    setBar('fb-comp', x[5]);
    el('fv-nproc').textContent = raw[6] + ' 道 (z ' + (x[6] >= 0 ? '+' : '') + x[6].toFixed(2) + ')';
    setBar('fb-nproc', x[6]);
    el('fv-fish').textContent = raw[1] + ' (z ' + (x[1] >= 0 ? '+' : '') + x[1].toFixed(2) + ')';
    setBar('fb-fish', x[1]);
    el('fv-casing').textContent = raw[2] + ' (z ' + (x[2] >= 0 ? '+' : '') + x[2].toFixed(2) + ')';
    setBar('fb-casing', x[2]);
    el('fv-mill').textContent = raw[7] + ' (z ' + (x[7] >= 0 ? '+' : '') + x[7].toFixed(2) + ')';
    setBar('fb-mill', x[7]);
    el('fv-kill').textContent = raw[8] + ' (z ' + (x[8] >= 0 ? '+' : '') + x[8].toFixed(2) + ')';
    setBar('fb-kill', x[8]);

    /* 03 模型指标 + 当前贡献 */
    el('m-n').textContent = MODEL.nTrain + ' / ' + MODEL.nVal;
    el('m-cov').innerHTML = (MODEL.coverage * 100).toFixed(1) + '%';
    el('m-ae').innerHTML = MODEL.medAE.toFixed(2) + ' 天';
    el('m-cross').textContent = MODEL.cross + ' 条';
    el('m-summary').innerHTML = '覆盖 <b>' + (MODEL.coverage * 100).toFixed(1) + '%</b> · P50 误差 <b>' + MODEL.medAE.toFixed(2) + ' 天</b> · 总工期误差 ' + MODEL.totalMedAE.toFixed(1) + ' 天';
    var mP50 = MODEL.models[keyIdx * 3 + 1];
    var gDepth = mP50.w[0] * x[0];
    var gFault = mP50.w[1] * x[1] + mP50.w[2] * x[2] + mP50.w[3] * x[3] + mP50.w[4] * x[4];
    var gOp = mP50.w[5] * x[5] + mP50.w[6] * x[6] + mP50.w[7] * x[7] + mP50.w[8] * x[8];
    drawContrib([
      { label: '井深', c: gDepth },
      { label: '故障类型', c: gFault },
      { label: '作业复杂度', c: gOp }
    ]);

    /* 04 工序分位与合成参数 */
    el('s-corr').textContent = corrAvg.toFixed(2);
    el('s-indep').textContent = '−' + Math.max(0, (stats.p90 - stats.p10) - (indepStats.p90 - indepStats.p10)).toFixed(1) + ' 天';
    var rows = '';
    for (i = 0; i < 7; i++) {
      var d = preds[i], isKey = i === keyIdx;
      rows += '<tr' + (isKey ? ' class="keep"' : '') + '><td>' + PROCS[i].name + (isKey ? ' <span class="db warn">方差 ' + Math.round(shares[i] * 100) + '%</span>' : '') + '</td>' +
        '<td class="num">' + d.p10.toFixed(1) + '</td><td class="num">' + d.p50.toFixed(1) + '</td><td class="num">' + d.p90.toFixed(1) + '</td>' +
        '<td class="num">' + (d.p90 - d.p10).toFixed(1) + '</td></tr>';
    }
    rows += '<tr><td><b>合计</b></td><td class="num">' + stats.p10.toFixed(1) + '</td><td class="num">' + stats.p50.toFixed(1) +
      '</td><td class="num">' + stats.p90.toFixed(1) + '</td><td class="num">' + (stats.p90 - stats.p10).toFixed(1) + '</td></tr>';
    el('proc').innerHTML = rows;
    el('key-hint').innerHTML = '总工期方差 <b>' + Math.round(shares[keyIdx] * 100) + '%</b> 来自 <b>' + PROCS[keyIdx].name + '</b>（P10—P90 宽 ' +
      (preds[keyIdx].p90 - preds[keyIdx].p10).toFixed(1) + ' 天）；压缩它的区间比把每道工序都估准更有效。';

    /* 05 计划决策 */
    el('p-plan').textContent = state.plan + ' 天';
    el('p-prob').innerHTML = pct + '%';
    el('p-p80').textContent = stats.p80.toFixed(1) + ' 天';
    el('p-key').textContent = PROCS[keyIdx].name;
    var marks = [
      { k: '当前计划', v: state.plan },
      { k: 'P50', v: stats.p50 },
      { k: 'P80', v: stats.p80 },
      { k: 'P90', v: stats.p90 }
    ];
    el('plantab').innerHTML = marks.map(function (m) {
      var pr = inCdf(stats.sorted, m.v);
      return '<tr><td class="k2">' + m.k + '</td><td class="num">' + m.v.toFixed(1) + ' 天</td><td class="num"><b>' + Math.round(pr * 100) + '%</b></td></tr>';
    }).join('');

    /* 结论 */
    var gain1 = (inCdf(stats.sorted, state.plan + 1) - inCdf(stats.sorted, state.plan)) * 100;
    var planMsg;
    if (state.plan < stats.p10) {
      planMsg = '计划 <b>' + state.plan + ' 天</b> 低于 P10（' + stats.p10.toFixed(1) + ' 天），几乎必然超期。';
    } else if (state.plan < stats.p50) {
      planMsg = '计划 <b>' + state.plan + ' 天</b> 低于 P50（' + stats.p50.toFixed(1) + ' 天），按期概率不到一半；每增加 1 天约 +' + gain1.toFixed(1) + ' 个百分点。';
    } else if (state.plan <= stats.p90) {
      planMsg = '计划处于 P50—P90 之间：每增加 1 天约 +' + gain1.toFixed(1) + ' 个百分点；P80 = <b>' + stats.p80.toFixed(1) + ' 天</b> 覆盖约 80%。';
    } else {
      planMsg = '计划 <b>' + state.plan + ' 天</b> 高于 P90（' + stats.p90.toFixed(1) + ' 天），余量偏宽，可回收到 P80 = <b>' + stats.p80.toFixed(1) + ' 天</b>。';
    }
    el('note').innerHTML = '总工期的方差 <b>' + Math.round(shares[keyIdx] * 100) + '%</b> 来自 <b>' + PROCS[keyIdx].name + '</b>（P10—P90 宽 ' +
      (preds[keyIdx].p90 - preds[keyIdx].p10).toFixed(1) + ' 天）。' + planMsg +
      ' <span style="color:var(--ink-4)">1450 井次与价值数字为示范口径，不是本页仿真读数。</span>';

    LAST = {
      job: job, x: x, preds: preds, res: res, stats: stats, indepStats: indepStats,
      shares: shares, keyIdx: keyIdx, corrAvg: corrAvg, pct: pct
    };
    return LAST;
  }

  /* =========================================================
     过程日志 / 阶段轨
     ========================================================= */
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
    el('trace').innerHTML = '<div><span class="t">—</span><span>等待运行：调井况后点「运行全流程」，或直接点上面的阶段。</span></div>';
  }

  var STAGE_LABEL = ['01 采集', '02 特征', '03 模型', '04 合成', '05 决策'];
  var runTimers = [];
  function cancelRun() {
    runTimers.forEach(function (t) { clearTimeout(t); });
    runTimers = [];
    var btn = el('btn-run');
    if (btn) { btn.disabled = false; btn.textContent = '▶ 运行全流程'; }
  }
  function setStage(i, log) {
    [].forEach.call(document.querySelectorAll('.dstage'), function (p) {
      p.classList.toggle('on', Number(p.getAttribute('data-stage')) === i);
    });
    [].forEach.call(el('flow').children, function (b, idx) {
      b.classList.toggle('on', idx === i);
      b.classList.toggle('done', idx < i);
      b.setAttribute('aria-selected', idx === i ? 'true' : 'false');
    });
    if (log) trace(STAGE_LABEL[i].slice(0, 2), log);
  }

  function runAll() {
    cancelRun();
    var L = render();
    clearTrace();
    var btn = el('btn-run');
    btn.disabled = true;
    btn.textContent = '运行中…';
    var key = PROCS[L.keyIdx].name;
    var kp = L.preds[L.keyIdx];
    var steps = [
      ['01', '读取 <b>1450</b> 井次工单 · 质控剔除 <b>128</b> 条（异常 47 / 缺工序 51 / 截断 30）· 可用 <b>1322</b> 条'],
      ['02', '当前工单 → <b>9</b> 维特征 · 井深 <b>' + (L.job.depth / 1000).toFixed(2) + ' km</b> · 故障 <b>' + L.job.fault.name + '</b> · 复杂度 <b>' + L.job.compOp.toFixed(2) + '</b> · 工序数 <b>' + L.job.nproc + '</b>'],
      ['03', '21 组分位数回归推理 · ' + key + ' P10/P50/P90 = <b>' + kp.p10.toFixed(1) + ' / ' + kp.p50.toFixed(1) + ' / ' + kp.p90.toFixed(1) + ' 天</b> · 验证覆盖 <b>' + (MODEL.coverage * 100).toFixed(1) + '%</b>'],
      ['04', '2000 次 MC 合成 · P50 <b>' + L.stats.p50.toFixed(1) + ' 天</b> · P90 <b>' + L.stats.p90.toFixed(1) + ' 天</b> · 计划 ' + state.plan + ' 天按期 <b>' + L.pct + '%</b>'],
      ['05', '计划 <b>' + state.plan + ' 天</b> · P80 <b>' + L.stats.p80.toFixed(1) + ' 天</b> · 建议按 P80 承诺；人工确认后回写台账']
    ];
    var delays = [0, 800, 1600, 2400, 3200];
    steps.forEach(function (s, i) {
      runTimers.push(setTimeout(function () {
        setStage(i, null);
        trace(s[0], s[1]);
        if (i === steps.length - 1) {
          runTimers.push(setTimeout(function () {
            btn.disabled = false;
            btn.textContent = '▶ 重新运行';
            trace('✓', '流水线完成：从 1450 井次历史工单到一条可承诺的工期。', 'ok');
          }, 700));
        }
      }, delays[i]));
    });
  }

  /* =========================================================
     控件
     ========================================================= */
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

  function syncPlan() {
    el('r-plan').value = state.plan;
    el('o-plan').textContent = state.plan + ' 天';
  }

  function updateFbNote() {
    var n = fb.adopt + fb.adjust;
    el('fb-note').textContent = '回写 ' + n + ' 条' + (n ? ' · 采纳 ' + fb.adopt + ' / 人工改期 ' + fb.adjust : '') + ' · 人工确认后才进入下一轮训练';
  }

  el('seg-fault').innerHTML = FAULTS.map(function (f) {
    var on = f.key === state.fault;
    return '<button type="button" data-f="' + f.key + '" class="' + (on ? 'on' : '') + '" aria-pressed="' + (on ? 'true' : 'false') + '" aria-label="故障类型：' + f.name + '">' + f.name + '</button>';
  }).join('');

  el('seg-fault').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    cancelRun();
    state.fault = b.getAttribute('data-f');
    syncControls();
    var L = render();
    trace('工单', '故障类型 → <b>' + L.job.fault.name + '</b> · 9 维特征重算 · P50 <b>' + L.stats.p50.toFixed(1) + ' 天</b>');
  });

  el('r-depth').addEventListener('input', function () {
    cancelRun();
    state.depth = Number(el('r-depth').value);
    el('o-depth').textContent = state.depth + ' m';
    render();
  });
  el('r-depth').addEventListener('change', function () {
    var L = LAST;
    trace('工单', '井深 → <b>' + state.depth + ' m</b> · 分位与 MC 重算 · P50 <b>' + L.stats.p50.toFixed(1) + ' 天</b>');
  });

  el('r-plan').addEventListener('input', function () {
    cancelRun();
    state.plan = Number(el('r-plan').value);
    el('o-plan').textContent = state.plan + ' 天';
    render();
  });
  el('r-plan').addEventListener('change', function () {
    var L = LAST;
    trace('计划', '计划工期 → <b>' + state.plan + ' 天</b> · 按期概率 <b>' + L.pct + '%</b>');
  });

  [['tog-mill', 'mill'], ['tog-kill', 'kill']].forEach(function (p) {
    var t = el(p[0]);
    t.addEventListener('click', function () {
      cancelRun();
      state[p[1]] = !state[p[1]];
      syncControls();
      var L = render();
      trace('工单', (p[1] === 'mill' ? '磨铣' : '压井') + ' → <b>' + (state[p[1]] ? '是' : '否') + '</b> · 复杂度 <b>' + L.job.compOp.toFixed(2) + '</b> · P50 <b>' + L.stats.p50.toFixed(1) + ' 天</b>');
    });
  });

  el('btn-run').addEventListener('click', runAll);

  el('btn-reset').addEventListener('click', function () {
    cancelRun();
    state.fault = DEFAULTS.fault;
    state.depth = DEFAULTS.depth;
    state.mill = DEFAULTS.mill;
    state.kill = DEFAULTS.kill;
    state.plan = DEFAULTS.plan;
    fb = { adopt: 0, adjust: 0 };
    syncControls();
    updateFbNote();
    setStage(0, false);
    clearTrace();
    render();
  });

  el('flow').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    cancelRun();
    setStage(Number(b.getAttribute('data-s')), null);
  });

  el('feedback').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    var k = b.getAttribute('data-fb');
    if (k === 'adopt') {
      var p80 = Math.round(LAST.stats.p80 * 2) / 2;
      state.plan = Math.max(3, Math.min(20, p80));
      syncPlan();
      render();
      fb.adopt++;
      trace('回写', '采纳 P80 承诺 <b>' + state.plan + ' 天</b> · 覆盖约 80% 抽样 · 已回写台账', 'ok');
    } else {
      state.plan = Math.min(20, state.plan + 1);
      syncPlan();
      render();
      fb.adjust++;
      trace('回写', '人工上调计划至 <b>' + state.plan + ' 天</b> · 调整原因进入下一轮复盘', 'warn');
    }
    updateFbNote();
  });

  /* ---------------- 启动 ---------------- */
  drawLoss();
  drawCalib();
  syncControls();
  updateFbNote();
  clearTrace();
  render();
  setStage(0, false);
  trace('系统', '模型已在本页训练：<b>' + MODEL.nTrain + '</b> 训练 / <b>' + MODEL.nVal + '</b> 验证 · 21 组模型 · P10—P90 覆盖 <b>' + (MODEL.coverage * 100).toFixed(1) + '%</b>', 'ok');

  /* 供开发期自检读取 */
  window.__WO = {
    MODEL: MODEL, DATA: DATA, state: state,
    get last() { return LAST; }
  };
})();
