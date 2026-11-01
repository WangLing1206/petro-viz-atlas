/* =========================================================
   从六通道到早期报警 · 可运行示范（v2 · AI 作业流）
   ---------------------------------------------------------
   这条流水线要回答的不是「曲线像不像异常」，而是：
     数据能不能用 → 模型看到什么 → 正常应该是什么样 →
     现在偏了多少 → 谁来处置、怎样回写
   ① 采集与工况上下文：六通道 2 s/点 + 8 段工序记录；
      工序边界 ±24 s 的起停泵冲击不评分，窗口必须落在同一工序内；
   ② 工序分段与特征：每工序滑 20 点（40 s）窗，抽 21 维：
      6 残差 + 6 标准差 + 6 斜率 + 3 通道相关；
   ③ 正常工况建模：8 次合成正常作业，5 训练 / 3 校准；
      每个工序只用正常窗口估计 μ/Σ（收缩 λ=0.08），
      马氏距离 D²，阈值取校准集 q99（目标 1% 误报）；
   ④ 异常评分与 episode：D²/阈值 ≥1 连续 ≥10 s 起 episode，
      20 s 内相邻段合并，1.15/1.35 倍分级，统计提前量；
   ⑤ 处置与价值：报警卡片 + 人工确认 / 误报回写 + 重标定；
      38 井次价值表是示范口径，本页仿真读数单独标注。
   本页全部为合成数据：正常作业与本次带事件作业都由同一物理
   基线 + 噪声生成，模型在本页现场训练、校准与推理。
   ========================================================= */
(function () {
  'use strict';

  /* ---------------- 基本参数 ---------------- */
  var DUR = 60;                       /* min */
  var DT = 2 / 60;                    /* 2 s / 点 */
  var N = Math.round(DUR / DT);       /* 1800 点 */
  var SKIP_PTS = Math.round(0.4 / DT);/* 工序边界 ±24 s 不评分 */
  var WIN = 20;                       /* 40 s 窗口 */
  var MIN_RUN = 5;                    /* 连续 5 点 = 10 s 才起 episode */
  var MERGE_GAP = 10;                 /* 20 s 内相邻报警合并 */
  var LEVEL2 = 1.15;                  /* 预警 = 阈值 ×1.15 */
  var LEVEL3 = 1.35;                  /* 报警 = 阈值 ×1.35 且持续 ≥60 s */
  var LAMBDA = 0.08;                  /* 协方差收缩系数 */
  var RIDGE = 1e-5;

  var CH = [
    { key: 'hook',   name: '悬重',   unit: 'kN',   dec: 1, color: '#1d4e50' },
    { key: 'tor',    name: '扭矩',   unit: 'kN·m', dec: 2, color: '#a9742c' },
    { key: 'spp',    name: '立压',   unit: 'MPa',  dec: 2, color: '#355c74' },
    { key: 'casing', name: '套压',   unit: 'MPa',  dec: 2, color: '#6e6a3c' },
    { key: 'flow',   name: '返出',   unit: '%',    dec: 1, color: '#3a7d6b' },
    { key: 'pit',    name: '池体积', unit: 'm³',   dec: 1, color: '#7a5c8a' }
  ];
  var CHK = {};
  CH.forEach(function (c) { CHK[c.key] = c; });

  var PANELS = [
    { keys: ['hook'],   title: '悬重 / kN' },
    { keys: ['tor'],    title: '扭矩 / kN·m' },
    { keys: ['spp'],    title: '立压（泵压）/ MPa' },
    { keys: ['casing'], title: '套压 / MPa' },
    { keys: ['flow', 'pit'], title: '返出 % / 池体积 m³' }
  ];

  var CORR_PAIRS = [
    { key: 'ht', a: 'hook', b: 'tor',    label: '悬重–扭矩' },
    { key: 'sf', a: 'spp',  b: 'flow',   label: '立压–返出' },
    { key: 'cp', a: 'casing', b: 'pit',  label: '套压–池体积' }
  ];

  /* 逐工序基准。卡管柱后插入停钻/活动管柱、震击解卡，
     不再按原计划直接循环洗井。 */
  var PHASES = [
    { t0: 0,  t1: 8,  name: '压井 / 井控',      short: '压井',   sub: '先建立井控，再动管柱',
      base: { hook: 420, tor: 0.40, spp: 6.40, casing: 6.20, flow: 26, pit: 100 },
      sd:   { hook: 3.0, tor: 0.06, spp: 0.15, casing: 0.35, flow: 1.2, pit: 0.40 },
      casingDrift: -4.0 },
    { t0: 8,  t1: 16, name: '起原井管柱',        short: '起管柱', sub: '起出原井管柱，悬重周期性波动',
      base: { hook: 402, tor: 0.20, spp: 0.50, casing: 2.20, flow: 0.4, pit: 100 },
      sd:   { hook: 9.0, tor: 0.05, spp: 0.12, casing: 0.18, flow: 0.30, pit: 0.25 },
      osc: { amp: 20, period: 1.5 } },
    { t0: 16, t1: 24, name: '通井 / 打印',       short: '通井',   sub: '通井、打印鱼顶，低扭矩循环',
      base: { hook: 390, tor: 4.60, spp: 5.00, casing: 1.20, flow: 30, pit: 100 },
      sd:   { hook: 5.0, tor: 0.28, spp: 0.16, casing: 0.12, flow: 1.2, pit: 0.30 } },
    { t0: 24, t1: 30, name: '磨铣 / 打捞',       short: '磨铣',   sub: '磨铣落物并打捞',
      base: { hook: 404, tor: 8.80, spp: 4.70, casing: 1.00, flow: 32, pit: 100 },
      sd:   { hook: 4.5, tor: 0.35, spp: 0.16, casing: 0.10, flow: 1.2, pit: 0.30 } },
    { t0: 30, t1: 36, name: '停钻 / 活动管柱',   short: '活动',   sub: '卡管柱后插入：停转、上提下放活动',
      base: { hook: 432, tor: 0.50, spp: 5.40, casing: 1.10, flow: 27, pit: 100 },
      sd:   { hook: 9.0, tor: 0.08, spp: 0.18, casing: 0.10, flow: 1.0, pit: 0.30 } },
    { t0: 36, t1: 42, name: '震击解卡',          short: '震击',   sub: '震击器解卡，保持循环',
      base: { hook: 448, tor: 0.30, spp: 5.20, casing: 1.20, flow: 26, pit: 100 },
      sd:   { hook: 14.0, tor: 0.06, spp: 0.20, casing: 0.12, flow: 1.0, pit: 0.30 },
      osc: { amp: 22, period: 0.8 } },
    { t0: 42, t1: 50, name: '循环洗井',          short: '循环',   sub: '解卡后循环洗井，恢复正常排量',
      base: { hook: 396, tor: 1.10, spp: 5.60, casing: 0.90, flow: 34, pit: 100 },
      sd:   { hook: 3.5, tor: 0.12, spp: 0.15, casing: 0.08, flow: 1.1, pit: 0.25 } },
    { t0: 50, t1: 60, name: '完井试压',          short: '试压',   sub: '完井管柱试压，扭矩≈0',
      base: { hook: 398, tor: 0.20, spp: 7.80, casing: 0.80, flow: 0.3, pit: 100 },
      sd:   { hook: 2.5, tor: 0.05, spp: 0.15, casing: 0.08, flow: 0.30, pit: 0.20 },
      sppRamp: 0.8 }
  ];

  /* 真值事件：前兆起点 + 发生时刻。前兆窗 4.5 min，给提前量留出空间。 */
  var EVENTS = [
    { tPre: 25.5, t: 30.0, name: '卡管柱', desc: '扭矩持续上升 + 悬重下降', rule: 'stuck' },
    { tPre: 43.5, t: 48.0, name: '漏失',   desc: '立压下降 + 返出/池体积同降', rule: 'loss' }
  ];

  /* 跨井/跨次的正常波动：训练集里有，模型才不会把「这口井本来
     就偏高」当成异常。幅度按通道量级给，扭矩 5% 已经能覆盖换泵/换工具。 */
  var JIT = { hook: 0.012, tor: 0.05, spp: 0.02, casing: 0.03, flow: 0.035, pit: 0.003 };

  var DIM = CH.length * 3 + CORR_PAIRS.length;  /* 21 */

  var FEATURES = [];
  CH.forEach(function (c) { FEATURES.push({ key: 'res_' + c.key, label: '残差·' + c.name, kind: 'res', ch: c.key }); });
  CH.forEach(function (c) { FEATURES.push({ key: 'std_' + c.key, label: '标准差·' + c.name, kind: 'std', ch: c.key }); });
  CH.forEach(function (c) { FEATURES.push({ key: 'slope_' + c.key, label: '斜率·' + c.name, kind: 'slope', ch: c.key }); });
  CORR_PAIRS.forEach(function (p) { FEATURES.push({ key: 'corr_' + p.key, label: '相关·' + p.label, kind: 'corr', pair: p }); });

  /* ---------------- 可复现随机数 ---------------- */
  function mulberry32(a) {
    a = a >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gaussOf(r) {
    return function () {
      var u = 0, v = 0;
      while (!u) u = r();
      while (!v) v = r();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
  }

  /* ---------------- 合成一次作业 ---------------- */
  function makeRun(seed, opts) {
    var r = mulberry32(seed), g = gaussOf(r);
    var data = {};
    CH.forEach(function (c) { data[c.key] = new Float64Array(N); });
    var phaseOf = new Int8Array(N);
    var runOff = {}, phaseOff = [];
    CH.forEach(function (c) { runOff[c.key] = opts.jitter ? g() * JIT[c.key] : 0; });
    PHASES.forEach(function () {
      var o = {};
      CH.forEach(function (c) { o[c.key] = opts.jitter ? g() * JIT[c.key] * 0.5 : 0; });
      phaseOff.push(o);
    });

    for (var i = 0; i < N; i++) {
      var t = i * DT;
      var p = 0;
      for (var q = 0; q < PHASES.length; q++) {
        if (t >= PHASES[q].t0 && t < PHASES[q].t1) { p = q; break; }
      }
      phaseOf[i] = p;
      var ph = PHASES[p];

      for (var ci = 0; ci < CH.length; ci++) {
        var c = CH[ci], k = c.key;
        var v = ph.base[k] * (1 + runOff[k] + phaseOff[p][k]);
        if (k === 'casing' && ph.casingDrift) v += ph.casingDrift * (t - ph.t0) / (ph.t1 - ph.t0);
        if (k === 'hook' && ph.osc) v += ph.osc.amp * Math.sin(2 * Math.PI * (t - ph.t0) / ph.osc.period);
        if (k === 'spp' && ph.sppRamp) v += ph.sppRamp * Math.min(1, (t - ph.t0) / 0.8);
        v += g() * ph.sd[k] * (1 + 0.08 * runOff[k]);

        /* 起停泵冲击（已知扰动）：只在工序边界 ±0.4 min 内。
           边界 ±24 s 不评分，所以这些尖峰不会进模型。 */
        var edge = Math.min(t - ph.t0, ph.t1 - t);
        if (edge < 0.4) {
          var e = 1 - edge / 0.4;
          if (k === 'spp') v += 0.9 * e;
          if (k === 'flow') v += 5.0 * e;
        }
        data[k][i] = v;
      }

      if (opts.events) {
        /* 异常 1：卡管柱前兆（25.5 min 起，30 min 卡管柱） */
        if (t >= 25.5 && t < 30) {
          var f1 = (t - 25.5) / 4.5;
          data.tor[i] += 4.8 * f1;
          data.hook[i] -= 30 * f1;
          data.spp[i] += 0.35 * f1;
          data.flow[i] -= 2.5 * f1;
        }
        /* 异常 2：漏失（43.5 min 起前兆，48 min 确认漏失） */
        if (t >= 43.5 && t < 50) {
          var f2 = Math.min(1, (t - 43.5) / 4.5);
          data.spp[i] -= 2.4 * f2;
          data.flow[i] -= 9.0 * f2;
          data.pit[i] -= 7.0 * f2;
          data.casing[i] -= 0.25 * f2;
        }
      }
    }
    return { data: data, phaseOf: phaseOf };
  }

  /* ---------------- 窗口统计 ---------------- */
  function rawStats(data, i0, i1) {
    var n = i1 - i0;
    var sx = n * (n - 1) / 2;
    var sxx = (n - 1) * n * (2 * n - 1) / 6;
    var mean = {}, std = {}, slope = {}, corr = {};

    for (var ci = 0; ci < CH.length; ci++) {
      var k = CH[ci].key;
      var s = 0, s2 = 0, sxy = 0;
      for (var j = 0; j < n; j++) {
        var v = data[k][i0 + j];
        s += v; s2 += v * v; sxy += j * v;
      }
      var m = s / n;
      mean[k] = m;
      std[k] = Math.sqrt(Math.max(0, s2 / n - m * m));
      slope[k] = (n * sxy - sx * s) / Math.max(1e-9, n * sxx - sx * sx) / DT;
    }

    for (var pi = 0; pi < CORR_PAIRS.length; pi++) {
      var p = CORR_PAIRS[pi];
      var sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
      for (var j2 = 0; j2 < n; j2++) {
        var va = data[p.a][i0 + j2], vb = data[p.b][i0 + j2];
        sa += va; sb += vb; saa += va * va; sbb += vb * vb; sab += va * vb;
      }
      var ma = sa / n, mb = sb / n;
      var va2 = saa / n - ma * ma, vb2 = sbb / n - mb * mb;
      var cov = sab / n - ma * mb;
      corr[p.key] = (va2 > 1e-12 && vb2 > 1e-12) ? cov / Math.sqrt(va2 * vb2) : 0;
    }
    return { mean: mean, std: std, slope: slope, corr: corr };
  }

  function collectWindows(run, p) {
    var ph = PHASES[p];
    var i0 = Math.round(ph.t0 / DT);
    var i1 = Math.min(N, Math.round(ph.t1 / DT));
    var s0 = i0 + SKIP_PTS;
    var s1 = i1 - SKIP_PTS - WIN;       /* 最大起始点（含） */
    var out = [];
    for (var s = s0; s <= s1; s++) out.push(rawStats(run.data, s, s + WIN));
    return out;
  }

  function featVec(raw, baseMean) {
    var f = [];
    for (var i = 0; i < CH.length; i++) f.push(raw.mean[CH[i].key] - baseMean[CH[i].key]);
    for (var j = 0; j < CH.length; j++) f.push(raw.std[CH[j].key]);
    for (var k = 0; k < CH.length; k++) f.push(raw.slope[CH[k].key]);
    for (var p = 0; p < CORR_PAIRS.length; p++) f.push(raw.corr[CORR_PAIRS[p].key]);
    return f;
  }

  function baseMeanOf(raws) {
    var b = {};
    CH.forEach(function (c) { b[c.key] = 0; });
    raws.forEach(function (r) { CH.forEach(function (c) { b[c.key] += r.mean[c.key]; }); });
    CH.forEach(function (c) { b[c.key] /= Math.max(1, raws.length); });
    return b;
  }
  function ptSdOf(raws) {
    var s = {};
    CH.forEach(function (c) { s[c.key] = 0; });
    raws.forEach(function (r) { CH.forEach(function (c) { s[c.key] += r.std[c.key] * r.std[c.key]; }); });
    CH.forEach(function (c) { s[c.key] = Math.sqrt(s[c.key] / Math.max(1, raws.length)); });
    return s;
  }

  function medianOf(arr) {
    if (!arr.length) return null;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }
  function quantile(arr, q) {
    if (!arr.length) return 0;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var pos = (a.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return a[lo] + (a[hi] - a[lo]) * (pos - lo);
  }

  /* ---------------- 协方差 / 逆矩阵 / 马氏距离 ---------------- */
  function covOf(Z) {
    var n = Z.length, d = Z[0].length, i, j, r;
    var C = [];
    for (i = 0; i < d; i++) C.push(new Array(d).fill(0));
    for (r = 0; r < n; r++) {
      var z = Z[r];
      for (i = 0; i < d; i++) {
        var zi = z[i];
        for (j = i; j < d; j++) C[i][j] += zi * z[j];
      }
    }
    for (i = 0; i < d; i++) {
      for (j = i; j < d; j++) {
        var v = C[i][j] / Math.max(1, n - 1);
        C[i][j] = v; C[j][i] = v;
      }
    }
    /* 收缩：非对角乘 (1-λ)，对角加极小岭项，保证 21×21 可逆 */
    for (i = 0; i < d; i++) {
      for (j = 0; j < d; j++) if (i !== j) C[i][j] *= (1 - LAMBDA);
      C[i][i] += RIDGE;
    }
    return C;
  }

  function invMat(A) {
    var n = A.length, i, j, r, col;
    var M = A.map(function (row, ri) {
      var out = row.slice();
      for (var q = 0; q < n; q++) out.push(ri === q ? 1 : 0);
      return out;
    });
    for (col = 0; col < n; col++) {
      var piv = col;
      for (r = col + 1; r < n; r++) {
        if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
      }
      if (Math.abs(M[piv][col]) < 1e-12) M[piv][col] = 1e-12;
      if (piv !== col) { var tmp = M[piv]; M[piv] = M[col]; M[col] = tmp; }
      var pv = M[col][col];
      for (j = 0; j < 2 * n; j++) M[col][j] /= pv;
      for (r = 0; r < n; r++) {
        if (r === col) continue;
        var f = M[r][col];
        if (!f) continue;
        for (j = 0; j < 2 * n; j++) M[r][j] -= f * M[col][j];
      }
    }
    return M.map(function (row) { return row.slice(n); });
  }

  function d2Of(f, group) {
    var z = new Array(DIM), invz = new Array(DIM), i, j;
    for (j = 0; j < DIM; j++) z[j] = (f[j] - group.mu[j]) / group.sd[j];
    for (i = 0; i < DIM; i++) {
      var s = 0;
      for (j = 0; j < DIM; j++) s += group.inv[i][j] * z[j];
      invz[i] = s;
    }
    var d2 = 0;
    var contrib = new Array(DIM);
    for (j = 0; j < DIM; j++) {
      d2 += z[j] * invz[j];
      contrib[j] = z[j] * invz[j];
    }
    return { d2: Math.max(0, d2), z: z, invz: invz, contrib: contrib };
  }

  /* ---------------- 正常模型：逐工序 / 全局 ---------------- */
  function buildGroup(trainRaw, calRaw, extraRaw) {
    var allRaw = trainRaw.concat(extraRaw || []);
    var baseMean = baseMeanOf(allRaw);
    var ptSd = ptSdOf(allRaw);
    var feats = allRaw.map(function (r) { return featVec(r, baseMean); });
    var mu = new Array(DIM), sd = new Array(DIM), j, n;

    for (j = 0; j < DIM; j++) {
      var s = 0;
      for (n = 0; n < feats.length; n++) s += feats[n][j];
      mu[j] = s / Math.max(1, feats.length);
      var v = 0;
      for (n = 0; n < feats.length; n++) v += Math.pow(feats[n][j] - mu[j], 2);
      sd[j] = Math.max(1e-4, Math.sqrt(v / Math.max(1, feats.length)));
    }

    var Z = feats.map(function (f) {
      return f.map(function (v, j2) { return (v - mu[j2]) / sd[j2]; });
    });
    var inv = invMat(covOf(Z));

    var group = {
      baseMean: baseMean, ptSd: ptSd, mu: mu, sd: sd, inv: inv,
      thr: 0, calD2: [], calFPR: 0, normalNorm: [],
      nTrain: allRaw.length, nCal: calRaw.length
    };
    group.calD2 = calRaw.map(function (r) { return d2Of(featVec(r, baseMean), group).d2; });
    group.thr = quantile(group.calD2, 0.99);
    if (!(group.thr > 1e-6)) group.thr = 1;
    group.calFPR = group.calD2.filter(function (v) { return v > group.thr; }).length / Math.max(1, group.calD2.length);
    group.normalNorm = group.calD2.map(function (v) { return v / group.thr; });
    return group;
  }

  function buildNaive() {
    var allRaw = [], calRaw = [], r, p;
    for (r = 0; r < 8; r++) for (p = 0; p < PHASES.length; p++) allRaw = allRaw.concat(RAW_CACHE[r][p]);
    for (r = 5; r < 8; r++) for (p = 0; p < PHASES.length; p++) calRaw = calRaw.concat(RAW_CACHE[r][p]);

    var baseMean = baseMeanOf(allRaw);
    var sigma = ptSdOf(allRaw);
    var calNorm = calRaw.map(function (raw) {
      var mx = 0;
      CH.forEach(function (c) {
        var z = Math.abs((raw.mean[c.key] - baseMean[c.key]) / Math.max(1e-4, sigma[c.key]));
        if (z > mx) mx = z;
      });
      return mx / 3;
    });
    var fpr = calNorm.filter(function (v) { return v > 1; }).length / Math.max(1, calNorm.length);
    var group = {
      baseMean: baseMean, ptSd: sigma, thr: 3,
      calFPR: fpr, normalNorm: calNorm,
      nTrain: allRaw.length, nCal: calRaw.length
    };
    return {
      kind: 'naive',
      groups: [group],
      groupOf: function () { return group; },
      nTrain: allRaw.length, nCal: calRaw.length,
      normalNorm: calNorm, fpr: fpr,
      normalMedian: medianOf(calNorm),
      thrMin: 3, thrMax: 3
    };
  }

  function buildModels(extraByPhase) {
    var awareGroups = PHASES.map(function (_, p) {
      var train = [], cal = [], r;
      for (r = 0; r < 5; r++) train = train.concat(RAW_CACHE[r][p]);
      for (r = 5; r < 8; r++) cal = cal.concat(RAW_CACHE[r][p]);
      var extra = (extraByPhase && extraByPhase[p]) ? extraByPhase[p] : [];
      return buildGroup(train, cal, extra);
    });

    var aware = {
      kind: 'aware',
      groups: awareGroups,
      groupOf: function (p2) { return awareGroups[p2]; }
    };

    [aware].forEach(function (m) {
      var normalNorm = [], nTrain = 0, nCal = 0;
      m.groups.forEach(function (g) {
        normalNorm = normalNorm.concat(g.normalNorm);
        nTrain += g.nTrain; nCal += g.nCal;
      });
      m.nTrain = nTrain; m.nCal = nCal;
      m.normalNorm = normalNorm;
      m.fpr = normalNorm.filter(function (v) { return v > 1; }).length / Math.max(1, normalNorm.length);
      m.normalMedian = medianOf(normalNorm);
      var thrs = m.groups.map(function (g) { return g.thr; });
      m.thrMin = Math.min.apply(null, thrs);
      m.thrMax = Math.max.apply(null, thrs);
    });

    return { aware: aware, naive: buildNaive() };
  }

  /* ---------------- 生成训练集与本次作业 ---------------- */
  var TRAIN_RUNS = [];
  for (var tri = 0; tri < 8; tri++) TRAIN_RUNS.push(makeRun(9100 + tri * 137, { events: false, jitter: true }));
  var RAW_CACHE = TRAIN_RUNS.map(function (run) {
    return PHASES.map(function (_, p) { return collectWindows(run, p); });
  });

  var DISPLAY = makeRun(20261031, { events: true, jitter: true });
  var PHASE_OF = DISPLAY.phaseOf;
  var DISP_RAW = PHASES.map(function (_, p) { return collectWindows(DISPLAY, p); });

  var MODELS = buildModels(null);

  var state = {
    phaseAware: true,
    speed: 1,
    cursor: 0,
    playing: false,
    hover: null,
    stage: 0,
    autoStage: true,
    toured: false
  };
  var A = null;
  var FB = { ok: 0, bad: 0 };
  var FB_EXTRA = [];          /* 待重标定的回写窗口：{phase, raw} */
  var FB_APPLIED = [];        /* 已进入模型训练的回写窗口 */
  var loggedEpCount = 0;
  var tourTimers = [];

  function extraByPhase() {
    var out = PHASES.map(function () { return []; });
    FB_APPLIED.concat(FB_EXTRA).forEach(function (x) { if (out[x.phase]) out[x.phase].push(x.raw); });
    return out;
  }

  /* ---------------- 评分 / episode ---------------- */
  function scoreAt(j, model) {
    var p = PHASE_OF[j];
    var ph = PHASES[p];
    var i0 = Math.round(ph.t0 / DT);
    var i1 = Math.min(N, Math.round(ph.t1 / DT));
    var group = model.groupOf(p);

    if (j < i0 + SKIP_PTS + WIN - 1 || j >= i1 - SKIP_PTS) {
      return { valid: false, d2: 0, norm: 0, thr: group.thr, contrib: null, chanZ: null, maxKey: null, z: null, raw: null, f: null, group: group, phase: p };
    }
    var raw = rawStats(DISPLAY.data, j - WIN + 1, j + 1);

    if (model.kind === 'naive') {
      var chanZ = {}, maxAbs = 0, maxKey = '';
      CH.forEach(function (c) {
        var z = (DISPLAY.data[c.key][j] - group.baseMean[c.key]) / Math.max(1e-4, group.ptSd[c.key]);
        chanZ[c.key] = z;
        if (Math.abs(z) > maxAbs) { maxAbs = Math.abs(z); maxKey = c.key; }
      });
      return {
        valid: true, d2: maxAbs, norm: maxAbs / group.thr, thr: group.thr,
        contrib: null, chanZ: chanZ, maxKey: maxKey, z: null,
        raw: raw, f: null, group: group, phase: p
      };
    }

    var f = featVec(raw, group.baseMean);
    var d = d2Of(f, group);
    return {
      valid: true, d2: d.d2, norm: d.d2 / group.thr, thr: group.thr,
      contrib: d.contrib, chanZ: null, maxKey: null, z: d.z, raw: raw, f: f, group: group, phase: p
    };
  }

  function findEpisodes(scores) {
    var idx = [], j;
    for (j = 0; j < N; j++) if (scores[j].valid && scores[j].norm >= 1) idx.push(j);
    var groups = [];
    idx.forEach(function (jj) {
      var last = groups[groups.length - 1];
      if (last && jj - last.end <= MERGE_GAP + 1) {
        if (jj - last.end > 1) last.segments++;
        last.end = jj; last.count++;
      } else {
        groups.push({ start: jj, end: jj, count: 1, segments: 1 });
      }
    });

    var eps = [];
    groups.forEach(function (g) {
      if (g.count < MIN_RUN) return;
      var peakI = g.start, peakNorm = 0;
      for (var k = g.start; k <= g.end; k++) {
        if (scores[k].norm > peakNorm) { peakNorm = scores[k].norm; peakI = k; }
      }
      var activeSec = g.count * DT * 60;
      var spanSec = (g.end - g.start + 1) * DT * 60;
      var level = 1;
      if (peakNorm >= LEVEL3 && activeSec >= 60) level = 3;
      else if (peakNorm >= LEVEL2) level = 2;

      var peak = scores[peakI];
      var res = {};
      CH.forEach(function (c) { res[c.key] = peak.raw.mean[c.key] - peak.group.baseMean[c.key]; });
      eps.push({
        t0: g.start * DT, t1: (g.end + 1) * DT,
        i0: g.start, i1: g.end, peakI: peakI,
        peakNorm: peakNorm, peakD2: peak.d2, dur: activeSec, span: spanSec,
        level: level, segments: g.segments, res: res, peak: peak,
        maxKey: peak.maxKey || null,
        event: null, eventIndex: -1, lead: null, pattern: 'multi'
      });
    });
    return eps;
  }

  function matchEvents(eps) {
    EVENTS.forEach(function (ev, ei) {
      var cand = eps.filter(function (ep) {
        return !ep.event && ep.level >= 2 &&
          ep.t0 >= ev.tPre && ep.t0 <= ev.t - 0.3 &&
          (ev.t - ep.t0) >= 0.5;
      });
      cand.sort(function (a, b) { return a.t0 - b.t0; });
      if (cand.length) {
        var ep = cand[0];
        ep.event = ev; ep.eventIndex = ei; ep.lead = ev.t - ep.t0;
      }
    });
    eps.forEach(function (ep) { ep.pattern = patternOf(ep); });
  }

  function patternOf(ep) {
    var g = ep.peak.group;
    var z = {};
    CH.forEach(function (c) {
      z[c.key] = (ep.peak.raw.mean[c.key] - g.baseMean[c.key]) / Math.max(1e-4, g.ptSd[c.key]);
    });
    var sStuck = Math.max(0, z.tor) + Math.max(0, -z.hook);
    var sLoss = Math.max(0, -z.spp) + Math.max(0, -z.flow) + Math.max(0, -z.pit);
    var sKick = Math.max(0, z.casing) + Math.max(0, z.flow) + Math.max(0, z.pit);
    var mx = Math.max(sStuck, sLoss, sKick);
    if (mx < 1.5) return 'multi';
    if (mx === sStuck) return 'stuck';
    if (mx === sLoss) return 'loss';
    return 'kick';
  }

  function analyze() {
    var model = state.phaseAware ? MODELS.aware : MODELS.naive;
    var scores = new Array(N);
    var lastValidArr = new Array(N);
    var lastValid = -1, j;

    for (j = 0; j < N; j++) {
      var s = scoreAt(j, model);
      scores[j] = s;
      if (s.valid) lastValid = j;
      lastValidArr[j] = lastValid;
    }

    var episodes = findEpisodes(scores);
    matchEvents(episodes);

    var abnormal = [];
    EVENTS.forEach(function (ev) {
      var a = Math.max(0, Math.round((ev.tPre - 0.5) / DT));
      var b = Math.min(N - 1, Math.round((ev.t + 0.5) / DT));
      for (var k = a; k <= b; k++) if (scores[k].valid) abnormal.push(scores[k].norm);
    });

    var events = EVENTS.map(function (ev, ei) {
      var hit = episodes.filter(function (ep) { return ep.event === ev; })[0] || null;
      return { ev: ev, index: ei, episode: hit, lead: hit ? hit.lead : null };
    });
    var detected = events.filter(function (e) { return !!e.episode; }).length;
    var leads = events.filter(function (e) { return e.lead !== null; }).map(function (e) { return e.lead; });

    var bandMean = {}, bandSd = {};
    CH.forEach(function (c) {
      bandMean[c.key] = new Float64Array(N);
      bandSd[c.key] = new Float64Array(N);
    });
    for (j = 0; j < N; j++) {
      var g = model.groupOf(PHASE_OF[j]);
      for (var ci = 0; ci < CH.length; ci++) {
        var kk = CH[ci].key;
        bandMean[kk][j] = g.baseMean[kk];
        bandSd[kk][j] = g.ptSd[kk];
      }
    }

    return {
      model: model, scores: scores, lastValidArr: lastValidArr,
      episodes: episodes, events: events,
      detected: detected, missed: EVENTS.length - detected,
      falseCount: episodes.filter(function (ep) { return !ep.event; }).length,
      leadMedian: leads.length ? medianOf(leads) : null,
      normalNorm: model.normalNorm, abnormalNorm: abnormal,
      abnormalMedian: medianOf(abnormal),
      bandMean: bandMean, bandSd: bandSd
    };
  }

  /* ---------------- 画布 ---------------- */
  var cv = document.getElementById('proc');
  var ctx = cv.getContext('2d');
  var Wc = 0, Hc = 600;
  var DPR = Math.min(2, window.devicePixelRatio || 1);
  var G = {};
  var COLS = {
    ink3: '#6f7a7c', ink4: '#99a3a4', line: '#eee9dd', line2: '#d3c9b6',
    bad: '#a64b3c', warn: '#a9742c', ok: '#3d7455', info: '#3a6ea5',
    band: 'rgba(196,200,192,.34)'
  };
  var LV = { 1: '关注', 2: '预警', 3: '报警' };
  var LVCOL = { 1: '#3a6ea5', 2: '#a9742c', 3: '#a64b3c' };
  var RULENAME = { stuck: '疑似卡管柱前兆', loss: '疑似漏失', kick: '疑似井涌/气侵', multi: '多通道偏离' };

  function layout() {
    Wc = cv.clientWidth || 760;
    Hc = cv.clientHeight || 600;
    cv.width = Math.round(Wc * DPR);
    cv.height = Math.round(Hc * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

    G.L = 54; G.R = 16;
    G.top = 60;
    G.riskY = G.top;
    G.riskH = 52;
    G.phaseY = G.riskY + G.riskH + 6;
    G.phaseH = 26;
    G.rawY = G.phaseY + G.phaseH + 6;
    G.stripH = 12;
    G.axisH = 18;
    var avail = Hc - G.rawY - G.stripH - G.axisH - 18;
    G.rawH = avail / PANELS.length;
    G.stripY = G.rawY + PANELS.length * G.rawH + 10;
    G.plotW = Wc - G.L - G.R;
    G.sx = function (t) { return G.L + Math.max(0, Math.min(1, t / DUR)) * G.plotW; };
    G.tx = function (x) { return (x - G.L) / G.plotW * DUR; };
  }

  function maxOf(arr) {
    var m = -Infinity;
    for (var i = 0; i < arr.length; i++) if (arr[i] > m) m = arr[i];
    return m;
  }
  function minOf(arr) {
    var m = Infinity;
    for (var i = 0; i < arr.length; i++) if (arr[i] < m) m = arr[i];
    return m;
  }

  function normColor(v) {
    if (v >= LEVEL3) return '#a64b3c';
    if (v >= LEVEL2) return '#a9742c';
    if (v >= 1) return '#3a6ea5';
    if (v >= 0.7) return '#b9cde4';
    if (v >= 0.4) return '#dfe8f2';
    return '#eee9dd';
  }
  function normTextColor(v) {
    if (v >= LEVEL3) return COLS.bad;
    if (v >= LEVEL2) return COLS.warn;
    if (v >= 1) return COLS.info;
    return COLS.ok;
  }

  function drawRisk(Ax, vis) {
    var y0 = G.riskY, h = G.riskH;
    ctx.fillStyle = '#fff';
    ctx.fillRect(G.L, y0, G.plotW, h);
    ctx.strokeStyle = COLS.line2;
    ctx.strokeRect(G.L, y0, G.plotW, h);

    var hi = 2.2;
    for (var i = 0; i < N; i++) {
      if (Ax.scores[i].valid) {
        var vv = Math.min(8, Ax.scores[i].norm);
        if (vv > hi) hi = vv;
      }
    }
    hi = Math.min(8, Math.ceil(hi * 1.1 * 2) / 2);
    var sy = function (v) { return y0 + (1 - Math.min(hi, v) / hi) * (h - 8); };

    /* 报警区间底色 */
    Ax.episodes.forEach(function (ep) {
      if (ep.t0 > vis) return;
      var x0 = G.sx(ep.t0), x1 = G.sx(Math.min(ep.t1, vis));
      ctx.fillStyle = ep.level === 3 ? 'rgba(166,75,60,.09)' : ep.level === 2 ? 'rgba(169,116,44,.09)' : 'rgba(58,110,165,.08)';
      ctx.fillRect(x0, y0 + 2, Math.max(1, x1 - x0), h - 4);
    });

    /* 全时段底图：淡色，提示这是一条完整的 60 min 作业 */
    var fullStep = Math.max(1, Math.floor(N / (G.plotW * 1.2)));
    ctx.beginPath();
    for (var fi = 0; fi < N; fi += fullStep) {
      var fx = G.sx(fi * DT), fy = sy(Ax.scores[fi].valid ? Ax.scores[fi].norm : 0);
      if (fi === 0) ctx.moveTo(fx, fy); else ctx.lineTo(fx, fy);
    }
    ctx.strokeStyle = 'rgba(58,110,165,.16)';
    ctx.lineWidth = 1;
    ctx.stroke();

    /* 已播放部分：实色 */
    var nVis = Math.min(N, Math.floor(vis / DT) + 1);
    var step = Math.max(1, Math.floor(nVis / (G.plotW * 1.2)));
    ctx.beginPath();
    ctx.moveTo(G.sx(0), sy(0));
    for (var i2 = 0; i2 < nVis; i2 += step) ctx.lineTo(G.sx(i2 * DT), sy(Ax.scores[i2].valid ? Ax.scores[i2].norm : 0));
    ctx.lineTo(G.sx(Math.min(vis, DUR)), sy(0));
    ctx.closePath();
    ctx.fillStyle = 'rgba(58,110,165,.10)';
    ctx.fill();

    ctx.beginPath();
    for (var i3 = 0; i3 < nVis; i3 += step) {
      var px = G.sx(i3 * DT), py = sy(Ax.scores[i3].valid ? Ax.scores[i3].norm : 0);
      if (i3 === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = COLS.info;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.lineWidth = 1;

    /* 阈值与分级线 */
    [1, LEVEL2, LEVEL3].forEach(function (v, li) {
      var yy = sy(v);
      ctx.strokeStyle = li === 2 ? 'rgba(166,75,60,.75)' : li === 1 ? 'rgba(169,116,44,.75)' : 'rgba(58,110,165,.75)';
      ctx.setLineDash(li === 0 ? [4, 3] : [2, 3]);
      ctx.beginPath(); ctx.moveTo(G.L, yy); ctx.lineTo(Wc - G.R, yy); ctx.stroke();
      ctx.setLineDash([]);
    });

    ctx.font = '9.5px ui-monospace, monospace';
    var aware = Ax.model.kind === 'aware';
    var title = aware ? '马氏距离 D² / 该工序阈值' : '单通道 max|z| / 3σ 对照';
    var tw = ctx.measureText(title).width + 10;
    ctx.fillStyle = 'rgba(255,254,250,.96)';
    ctx.fillRect(G.L + 2, y0 + 2, tw, 23);
    ctx.fillStyle = COLS.info;
    ctx.textAlign = 'left';
    ctx.fillText(title, G.L + 5, y0 + 11);
    ctx.fillStyle = COLS.ink4;
    ctx.font = '8px ui-monospace, monospace';
    ctx.fillText(aware ? '1.0 = 该工序正常校准集 q99 · 显示上限 8×' : '1.0 = 固定 3σ · 未按工序校准 · 显示上限 8×', G.L + 5, y0 + 21);

    var leg = '｜关注 1.00 · 预警 1.15 · 报警 1.35';
    ctx.font = '8px ui-monospace, monospace';
    var lw2 = ctx.measureText(leg).width + 10;
    ctx.fillStyle = 'rgba(255,254,250,.96)';
    ctx.fillRect(G.L + tw + 10, y0 + 2, lw2, 12);
    ctx.fillStyle = COLS.ink3;
    ctx.textAlign = 'left';
    ctx.fillText(leg, G.L + tw + 15, y0 + 10);
  }

  function drawPhaseBand(vis) {
    var y = G.phaseY, h = G.phaseH;
    var curP = PHASES[Math.max(0, Math.min(PHASES.length - 1, phaseIndexAt(state.cursor)))];
    ctx.fillStyle = '#fff';
    ctx.fillRect(G.L, y, G.plotW, h);
    ctx.strokeStyle = COLS.line2;
    ctx.strokeRect(G.L, y, G.plotW, h);

    PHASES.forEach(function (p, pi) {
      var x0 = G.sx(p.t0), x1 = G.sx(p.t1), w = x1 - x0;
      var on = p === curP;
      ctx.fillStyle = on ? 'rgba(36,92,90,.15)' : (pi % 2 ? 'rgba(169,116,44,.045)' : 'rgba(36,92,90,.045)');
      ctx.fillRect(x0, y, w, h);
      ctx.strokeStyle = 'rgba(211,201,182,.9)';
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0, y + h); ctx.stroke();

      ctx.fillStyle = on ? '#123a3d' : COLS.ink3;
      ctx.font = (w < 54 ? '7.5px' : '8.5px') + ' ui-monospace, monospace';
      ctx.textAlign = 'center';
      var label = w < 54 ? p.short : p.name;
      ctx.fillText(label, (x0 + x1) / 2, y + h / 2 + 3);
    });

    /* 工序边界 ±24 s：斜线带，表示不评分 */
    PHASES.forEach(function (p, pi) {
      if (pi === 0) return;
      var xa = G.sx(p.t0 - 0.4), xb = G.sx(p.t0 + 0.4);
      ctx.save();
      ctx.beginPath(); ctx.rect(xa, y, Math.max(1, xb - xa), h); ctx.clip();
      ctx.strokeStyle = 'rgba(150,145,130,.55)';
      ctx.lineWidth = 0.8;
      for (var xx = xa - h; xx < xb + h; xx += 4) {
        ctx.beginPath(); ctx.moveTo(xx, y + h); ctx.lineTo(xx + h, y); ctx.stroke();
      }
      ctx.restore();
      ctx.strokeStyle = 'rgba(150,145,130,.5)';
      ctx.beginPath(); ctx.moveTo(xa, y); ctx.lineTo(xa, y + h); ctx.moveTo(xb, y); ctx.lineTo(xb, y + h); ctx.stroke();
    });

    ctx.textAlign = 'left';
    ctx.fillStyle = COLS.ink4;
    ctx.font = '7.5px ui-monospace, monospace';
  }

  function drawPanel(panel, pi, vis) {
    var y0 = G.rawY + pi * G.rawH;
    var h = G.rawH - 5;
    ctx.fillStyle = '#fff';
    ctx.fillRect(G.L, y0, G.plotW, h);
    ctx.strokeStyle = COLS.line;
    ctx.strokeRect(G.L, y0, G.plotW, h);

    var pads = 0.16;
    panel.keys.forEach(function (k, ki) {
      var c = CHK[k];
      var vals = DISPLAY.data[k];
      var lo = minOf(vals), hi = maxOf(vals);
      var pad = (hi - lo) * pads || 1;
      lo -= pad; hi += pad;
      var sy = function (v) { return y0 + (1 - (v - lo) / (hi - lo)) * h; };
      var nVis = Math.min(N, Math.floor(vis / DT) + 1);
      var step = Math.max(1, Math.floor(N / (G.plotW * 1.2)));
      var stepP = Math.max(1, Math.floor(nVis / (G.plotW * 1.2)));

      /* 灰带 = 当前模型认为的正常范围（均值 ±2σ）。
         工况感知开启时逐工序变化；关闭时是一条全局带。 */
      ctx.beginPath();
      for (var i = 0; i < N; i += step) {
        var bx = G.sx(i * DT), by = sy(A.bandMean[k][i] + 2 * A.bandSd[k][i]);
        if (i === 0) ctx.moveTo(bx, by); else ctx.lineTo(bx, by);
      }
      for (var j = N - 1; j >= 0; j -= step) {
        ctx.lineTo(G.sx(j * DT), sy(A.bandMean[k][j] - 2 * A.bandSd[k][j]));
      }
      ctx.closePath();
      ctx.fillStyle = COLS.band;
      ctx.fill();

      /* 基线中心线（全时段） */
      ctx.beginPath();
      for (var i2 = 0; i2 < N; i2 += step) {
        var cx = G.sx(i2 * DT), cy = sy(A.bandMean[k][i2]);
        if (i2 === 0) ctx.moveTo(cx, cy); else ctx.lineTo(cx, cy);
      }
      ctx.strokeStyle = 'rgba(150,145,130,.55)';
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 0.8;
      ctx.stroke();
      ctx.setLineDash([]);

      /* 全时段底图：淡色 */
      ctx.beginPath();
      for (var i3 = 0; i3 < N; i3 += step) {
        var px0 = G.sx(i3 * DT), py0 = sy(vals[i3]);
        if (i3 === 0) ctx.moveTo(px0, py0); else ctx.lineTo(px0, py0);
      }
      ctx.strokeStyle = c.color;
      ctx.globalAlpha = 0.18;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.globalAlpha = 1;

      /* 已播放部分：实色 */
      ctx.beginPath();
      for (var i4 = 0; i4 < nVis; i4 += stepP) {
        var px = G.sx(i4 * DT), py = sy(vals[i4]);
        if (i4 === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = c.color;
      ctx.lineWidth = 1.15;
      ctx.stroke();
      ctx.lineWidth = 1;

      ctx.font = '8.5px ui-monospace, monospace';
      ctx.fillStyle = COLS.ink4;
      if (ki === 0) {
        ctx.textAlign = 'right';
        ctx.fillText(hi.toFixed(1), G.L - 4, y0 + 9);
        ctx.fillText(lo.toFixed(1), G.L - 4, y0 + h - 2);
      } else {
        ctx.textAlign = 'left';
        ctx.fillText(hi.toFixed(1), Wc - G.R + 4, y0 + 9);
        ctx.fillText(lo.toFixed(1), Wc - G.R + 4, y0 + h - 2);
      }
    });

    ctx.font = '9.5px ui-monospace, monospace';
    ctx.textAlign = 'left';
    var tx = G.L + 4;
    panel.keys.forEach(function (k, ki) {
      var c = CHK[k];
      ctx.fillStyle = c.color;
      ctx.fillText((ki ? ' / ' : '') + c.name + ' ' + c.unit, tx, y0 + 10);
      tx += ctx.measureText((ki ? ' / ' : '') + c.name + ' ' + c.unit).width;
    });
  }

  function drawStrip(vis) {
    var y = G.stripY;
    var nVis = Math.min(N, Math.floor(vis / DT) + 1);
    var step = Math.max(1, Math.floor(N / G.plotW));
    for (var i = 0; i < nVis; i += step) {
      var x = G.sx(i * DT);
      var w = Math.max(1, step * G.plotW / N);
      ctx.fillStyle = A.scores[i].valid ? normColor(A.scores[i].norm) : '#f1ede3';
      ctx.fillRect(x, y, w, G.stripH);
    }
    ctx.strokeStyle = COLS.line2;
    ctx.strokeRect(G.L, y, G.plotW, G.stripH);

    ctx.fillStyle = COLS.ink3;
    ctx.font = '8.5px ui-monospace, monospace';
    ctx.textAlign = 'left';
    var awareStrip = A.model.kind === 'aware';
    ctx.fillText((awareStrip ? 'D²/阈值' : 'max|z|/3σ') + ' 热条 · 1.0 = ' + (awareStrip ? '该工序 q99' : '固定 3σ') + ' · 连续 ≥' + MIN_RUN + ' 点（' + (MIN_RUN * 2) + ' s）起 episode', G.L, y - 5);

    var lw = 170, lx = Wc - G.R - lw;
    ctx.fillStyle = 'rgba(255,254,250,.96)';
    ctx.fillRect(lx - 4, y - 15, lw + 4, 13);
    ctx.font = '7.5px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = COLS.ink4;
    ctx.fillText(awareStrip ? 'D²/阈值' : 'max|z|/3σ', lx, y - 6);
    [0.5, 1, LEVEL2, LEVEL3].forEach(function (v, i) {
      var xx = lx + 40 + i * 30;
      ctx.fillStyle = normColor(v);
      ctx.fillRect(xx, y - 13, 7, 7);
      ctx.fillStyle = COLS.ink4;
      ctx.fillText(v.toFixed(v === 0.5 ? 1 : 2), xx + 9, y - 6);
    });
  }

  function drawTimeAxis() {
    ctx.font = '8.5px ui-monospace, monospace';
    ctx.fillStyle = COLS.ink4;
    ctx.textAlign = 'center';
    for (var t = 0; t <= DUR; t += 5) {
      var x = G.sx(t);
      ctx.strokeStyle = '#d3c9b6';
      ctx.beginPath(); ctx.moveTo(x, G.stripY + G.stripH); ctx.lineTo(x, G.stripY + G.stripH + (t % 10 === 0 ? 5 : 3)); ctx.stroke();
      if (t % 10 === 0) ctx.fillText(t + '', x, G.stripY + G.stripH + 16);
    }
    ctx.textAlign = 'left';
    ctx.fillStyle = COLS.ink4;
    ctx.fillText('min', G.L - 30, G.stripY + G.stripH + 15);
  }

  function drawTruthAndLabels(vis) {
    EVENTS.forEach(function (ev) {
      if (ev.tPre <= vis + 0.001) {
        var xp = G.sx(ev.tPre);
        ctx.strokeStyle = 'rgba(169,116,44,.65)';
        ctx.setLineDash([3, 4]);
        ctx.beginPath(); ctx.moveTo(xp, G.top); ctx.lineTo(xp, G.stripY + G.stripH); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(169,116,44,.07)';
        ctx.fillRect(xp, G.riskY, G.sx(Math.min(ev.t, vis)) - xp, G.stripY + G.stripH - G.riskY);
      }
      if (ev.t <= vis + 0.001) {
        var xe = G.sx(ev.t);
        ctx.strokeStyle = 'rgba(166,75,60,.8)';
        ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(xe, G.top); ctx.lineTo(xe, G.stripY + G.stripH); ctx.stroke();
        ctx.lineWidth = 1;
      }
    });

    A.episodes.forEach(function (ep) {
      if (ep.t0 > vis) return;
      var xe = G.sx(ep.t0);
      ctx.strokeStyle = LVCOL[ep.level];
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath(); ctx.moveTo(xe, G.top); ctx.lineTo(xe, G.stripY + G.stripH); ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    });

    var labels = [];
    EVENTS.forEach(function (ev) {
      if (ev.tPre <= vis + 0.001) labels.push({ x: G.sx(ev.tPre), text: '前兆 ' + ev.tPre.toFixed(1) + '′', color: '#83551f' });
      if (ev.t <= vis + 0.001) labels.push({ x: G.sx(ev.t), text: ev.name + ' ' + ev.t.toFixed(1) + '′', color: '#a64b3c' });
    });
    A.episodes.forEach(function (ep, ei) {
      if (ep.t0 > vis) return;
      labels.push({ x: G.sx(ep.t0), text: 'E' + (ei + 1) + ' ' + LV[ep.level] + ' ' + ep.t0.toFixed(1) + '′', color: LVCOL[ep.level] });
    });
    labels.sort(function (a, b) { return a.x - b.x; });

    var lanes = [[], [], [], []];
    ctx.font = '8.5px ui-monospace, monospace';
    labels.forEach(function (lb) {
      var w = ctx.measureText(lb.text).width + 12;
      var lane = 0;
      for (; lane < lanes.length; lane++) {
        var free = true;
        for (var q = 0; q < lanes[lane].length; q++) {
          var r = lanes[lane][q];
          if (!(lb.x + w < r[0] || lb.x > r[1])) { free = false; break; }
        }
        if (free) break;
      }
      if (lane >= lanes.length) lane = lanes.length - 1;
      lanes[lane].push([lb.x - 2, lb.x + w]);
      lb.lane = lane;
    });

    labels.forEach(function (lb) {
      var ly = 9 + lb.lane * 13;
      ctx.fillStyle = 'rgba(255,254,250,.92)';
      var w2 = ctx.measureText(lb.text).width + 8;
      ctx.fillRect(lb.x + 2, ly - 8, w2, 11);
      ctx.fillStyle = lb.color;
      ctx.textAlign = 'left';
      ctx.fillText(lb.text, lb.x + 4, ly);
    });

    A.events.forEach(function (evr) {
      if (!evr.episode) return;
      if (evr.episode.t0 > vis) return;
      var xa = G.sx(evr.episode.t0), xe = G.sx(evr.ev.t);
      var yb = 54;
      ctx.strokeStyle = 'rgba(58,110,165,.8)';
      ctx.beginPath();
      ctx.moveTo(xa, yb); ctx.lineTo(xe, yb);
      ctx.moveTo(xa, yb - 3); ctx.lineTo(xa, yb + 3);
      ctx.moveTo(xe, yb - 3); ctx.lineTo(xe, yb + 3);
      ctx.stroke();
      ctx.fillStyle = COLS.info;
      ctx.font = '8.5px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('提前 ' + evr.lead.toFixed(1) + ' min', (xa + xe) / 2, yb - 3);
    });
  }

  function drawCursor() {
    var x = G.sx(state.cursor);
    ctx.strokeStyle = '#1c2529';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, G.top); ctx.lineTo(x, G.stripY + G.stripH); ctx.stroke();
    ctx.fillStyle = '#1c2529';
    ctx.beginPath(); ctx.moveTo(x - 3, G.top); ctx.lineTo(x + 3, G.top); ctx.lineTo(x, G.top - 5); ctx.closePath(); ctx.fill();
  }

  function drawHover() {
    if (!state.hover) return;
    var h = state.hover;
    var x = G.sx(h.t);
    ctx.strokeStyle = 'rgba(28,37,41,.55)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, G.top); ctx.lineTo(x, G.stripY + G.stripH); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(G.L, h.y); ctx.lineTo(Wc - G.R, h.y); ctx.stroke();
    ctx.setLineDash([]);

    var idx = Math.max(0, Math.min(N - 1, Math.round(h.t / DT)));
    var sc = A.scores[idx];
    var lines = ['t = ' + h.t.toFixed(2) + ' min · ' + PHASES[PHASE_OF[idx]].name];
    CH.forEach(function (c) {
      lines.push(c.name + ' ' + DISPLAY.data[c.key][idx].toFixed(c.dec) + ' ' + c.unit);
    });
    if (sc.valid) {
      if (A.model.kind === 'aware') {
        lines.push('D² = ' + sc.d2.toFixed(1) + ' · D²/阈值 = ' + sc.norm.toFixed(2) + '×');
        var top = topContrib(sc.contrib);
        lines.push('最大贡献：' + top.label + ' ' + (top.v >= 0 ? '+' : '') + top.v.toFixed(2));
      } else {
        lines.push('max|z| = ' + sc.d2.toFixed(2) + 'σ · /3σ = ' + sc.norm.toFixed(2) + '×');
        var tc = CHK[sc.maxKey];
        lines.push('最大偏离：' + (tc ? tc.name : '—') + ' ' + (sc.chanZ[sc.maxKey] >= 0 ? '+' : '') + sc.chanZ[sc.maxKey].toFixed(2) + 'σ');
      }
    } else {
      lines.push('边界 ±24 s：不评分');
    }

    var bw = 236, bh = 13 * lines.length + 12;
    var bx = x + 12, by = h.y - bh / 2;
    if (bx + bw > Wc - 4) bx = x - bw - 12;
    if (bx < G.L + 2) bx = G.L + 2;
    if (by < G.top + 2) by = G.top + 2;
    if (by + bh > G.stripY - 4) by = G.stripY - bh - 4;
    ctx.fillStyle = 'rgba(255,254,250,.97)';
    ctx.fillRect(bx, by, bw, bh);
    ctx.strokeStyle = 'rgba(120,115,100,.55)';
    ctx.strokeRect(bx, by, bw, bh);
    ctx.font = '9px ui-monospace, monospace';
    ctx.textAlign = 'left';
    lines.forEach(function (ln, li) {
      ctx.fillStyle = li === 0 ? COLS.ink3 : (li === lines.length - 1 ? COLS.info : COLS.ink3);
      ctx.fillText(ln, bx + 7, by + 13 + li * 12.5);
    });
  }

  function phaseIndexAt(t) {
    for (var p = 0; p < PHASES.length; p++) if (t >= PHASES[p].t0 && t < PHASES[p].t1) return p;
    return PHASES.length - 1;
  }

  function draw() {
    if (!A) return;
    layout();
    if (!Wc) return;
    ctx.clearRect(0, 0, Wc, Hc);
    var vis = state.cursor;
    drawRisk(A, vis);
    drawPhaseBand(vis);
    PANELS.forEach(function (p, pi) { drawPanel(p, pi, vis); });
    drawStrip(vis);
    drawTimeAxis();
    drawTruthAndLabels(vis);
    drawCursor();
    drawHover();
  }

  /* ---------------- DOM 工具 ---------------- */
  var el = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch];
    });
  }
  function fmt(n) { return Math.round(n).toLocaleString('en-US'); }

  function topContrib(contrib) {
    if (!contrib) return { label: '—', v: 0 };
    var bi = 0;
    for (var j = 1; j < contrib.length; j++) if (Math.abs(contrib[j]) > Math.abs(contrib[bi])) bi = j;
    return { label: FEATURES[bi].label, v: contrib[bi], index: bi };
  }

  /* ---------------- 过程日志 ---------------- */
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
    el('trace').innerHTML = '<div><span class="t">—</span><span>等待运行：点「▶ 运行全流程」，或直接点上面的阶段。</span></div>';
  }
  function initTrace() {
    var m = MODELS.aware;
    trace('系统', '正常模型已在本页训练：8 次合成正常作业 · 逐工序 21 维 μ/Σ（收缩 λ=' + LAMBDA.toFixed(2) + '）· 阈值 q99', 'ok');
    trace('校准', '正常校准窗口 ' + fmt(m.nCal) + ' 个 · 校准 FPR <b>' + (m.fpr * 100).toFixed(1) + '%</b> · 目标 1%');
  }

  /* ---------------- 阶段控制 ---------------- */
  var STAGE_LABEL = ['01 采集', '02 特征', '03 模型', '04 episode', '05 闭环'];
  function cancelTour() {
    tourTimers.forEach(function (t) { clearTimeout(t); });
    tourTimers = [];
  }
  function setStage(i, log) {
    state.stage = i;
    [].forEach.call(document.querySelectorAll('.dstage'), function (p) {
      p.classList.toggle('on', Number(p.getAttribute('data-stage')) === i);
    });
    var flow = el('flow');
    if (flow) {
      [].forEach.call(flow.children, function (b, idx) {
        b.classList.toggle('on', idx === i);
        b.classList.toggle('done', idx < i);
        b.setAttribute('aria-selected', idx === i ? 'true' : 'false');
      });
    }
    if (log) trace(STAGE_LABEL[i].slice(0, 2), log);
  }

  /* ---------------- 读数 / 特征 / 决策 ---------------- */
  function buildReads() {
    var h = '<div class="rh"><span>通道</span><span style="text-align:right">实测</span><span style="text-align:right">正常基线</span><span style="text-align:right">残差</span></div>';
    h += CH.map(function (c) {
      return '<div class="r" data-k="' + c.key + '">' +
        '<span class="nm">' + c.name + '<small>' + c.unit + '</small></span>' +
        '<span class="val">—</span><span class="base">—</span><span class="res">—</span></div>';
    }).join('');
    el('reads').innerHTML = h;
  }

  function updateReads(idx) {
    var p = PHASE_OF[idx];
    var g = A.model.groupOf(p);
    CH.forEach(function (c) {
      var row = el('reads').querySelector('[data-k="' + c.key + '"]');
      if (!row) return;
      var v = DISPLAY.data[c.key][idx];
      var b = g.baseMean[c.key];
      var r = v - b;
      row.querySelector('.val').textContent = v.toFixed(c.dec);
      row.querySelector('.base').textContent = b.toFixed(c.dec);
      var re = row.querySelector('.res');
      re.textContent = (r >= 0 ? '+' : '') + r.toFixed(c.dec);
      re.className = 'res' + (Math.abs(r) < 1e-9 ? '' : (r > 0 ? ' pos' : ' neg'));
    });

    var ph = PHASES[p];
    var t = idx * DT;
    var prog = Math.max(0, Math.min(1, (t - ph.t0) / (ph.t1 - ph.t0)));
    el('q-phase').innerHTML = '<b>' + ph.name + '</b> · ' + ph.t0 + '–' + ph.t1 + ' min';
    el('q-progress').textContent = (prog * 100).toFixed(0) + '% · t = ' + t.toFixed(1) + ' min';

    var sc = A.scores[idx];
    el('q-skip').innerHTML = sc.valid
      ? '<span class="db ok">评分中</span> 窗口完整落在本工序'
      : '<span class="db warn">边界跳过</span> 起停泵冲击 ±24 s';
    var gateTxt = A.model.kind === 'aware' ? '可用 · 进入 21 维特征' : '可用 · 进入单通道对照';
    el('q-gate').innerHTML = '1800 点 · 6 通道 · 缺测 0 · ' + (sc.valid
      ? '<span class="db ok">' + gateTxt + '</span>'
      : '<span class="db plain">边界不评分</span>');
  }

  function buildFeatureTable() {
    var h = '<span class="h">通道</span><span class="h">窗口均值</span><span class="h">残差</span><span class="h">标准差</span><span class="h">斜率/min</span>';
    h += CH.map(function (c) {
      return '<span class="ch">' + c.name + '</span>' +
        '<span class="v" data-f="mean" data-k="' + c.key + '">—</span>' +
        '<span class="v res" data-f="res" data-k="' + c.key + '">—</span>' +
        '<span class="v" data-f="std" data-k="' + c.key + '">—</span>' +
        '<span class="v" data-f="slope" data-k="' + c.key + '">—</span>';
    }).join('');
    el('ftab').innerHTML = h;

    el('corr').innerHTML = CORR_PAIRS.map(function (p) {
      return '<div class="cr" data-c="' + p.key + '"><span>' + p.label + '</span>' +
        '<span class="track"><i></i></span><span class="v">—</span></div>';
    }).join('');
  }

  function updateFeatures(idx) {
    var cur = A.scores[idx];
    var disp = cur.valid ? cur : (A.lastValidArr[idx] >= 0 ? A.scores[A.lastValidArr[idx]] : null);
    if (!disp) {
      el('f-phase').textContent = '—';
      el('f-count').textContent = '—';
      return;
    }
    var raw = disp.raw, g = disp.group;
    var ph = PHASES[disp.phase];
    el('f-phase').innerHTML = '<b>' + ph.name + '</b> · ' + ph.t0 + '–' + ph.t1 + ' min';
    el('f-count').textContent = (DISP_RAW[disp.phase] ? DISP_RAW[disp.phase].length : 0) + ' 个有效窗口' +
      (cur.valid ? '' : ' · 显示最近有效窗口 ' + (A.lastValidArr[idx] * DT).toFixed(1) + ' min');

    CH.forEach(function (c) {
      var k = c.key;
      var m = raw.mean[k];
      var res = m - g.baseMean[k];
      var sd = raw.std[k];
      var sl = raw.slope[k];
      var q = function (f) { return el('ftab').querySelector('[data-f="' + f + '"][data-k="' + k + '"]'); };
      q('mean').textContent = m.toFixed(c.dec);
      q('res').textContent = (res >= 0 ? '+' : '') + res.toFixed(c.dec);
      q('std').textContent = sd.toFixed(c.dec);
      q('slope').textContent = (sl >= 0 ? '+' : '') + sl.toFixed(2);
    });

    CORR_PAIRS.forEach(function (p) {
      var row = el('corr').querySelector('[data-c="' + p.key + '"]');
      if (!row) return;
      var v = raw.corr[p.key];
      var aware = A.model.kind === 'aware';
      var z = 0;
      if (aware) {
        var fi = FEATURES.map(function (f) { return f.key; }).indexOf('corr_' + p.key);
        z = (v - g.mu[fi]) / g.sd[fi];
      } else {
        z = v;
      }
      var w = Math.min(50, Math.abs(z) / (aware ? 3 : 1) * 50);
      var bar = row.querySelector('.track i');
      bar.style.left = (v >= 0 ? '50%' : (50 - w) + '%');
      bar.style.width = w + '%';
      bar.style.background = Math.abs(z) >= (aware ? 2 : 0.6) ? 'var(--bad)' : Math.abs(z) >= (aware ? 1 : 0.3) ? 'var(--clay)' : 'var(--jade)';
      row.querySelector('.v').textContent = v.toFixed(2) + (aware ? ' / ' + (z >= 0 ? '+' : '') + z.toFixed(1) : '');
    });
  }

  function updateDecision(idx) {
    var cur = A.scores[idx];
    var disp = cur.valid ? cur : (A.lastValidArr[idx] >= 0 ? A.scores[A.lastValidArr[idx]] : null);
    var aware = A.model.kind === 'aware';

    if (disp) {
      if (!cur.valid) el('s-d2now').textContent = '最近有效窗口';
      el('d2-now').textContent = aware ? disp.d2.toFixed(1) : disp.d2.toFixed(2) + 'σ';
      el('d2-norm').textContent = disp.norm.toFixed(2) + '×';
      var lv = disp.norm >= LEVEL3 ? 3 : disp.norm >= LEVEL2 ? 2 : disp.norm >= 1 ? 1 : 0;
      var lvName = lv ? LV[lv] : '正常';
      el('d2-level').innerHTML = '<span class="db ' + (lv === 3 ? 'bad' : lv === 2 ? 'warn' : lv === 1 ? 'info' : 'ok') + '">' + lvName + '</span>';
      if (aware) {
        var top = topContrib(disp.contrib);
        el('d2-top').textContent = top.label + ' ' + (top.v >= 0 ? '+' : '') + top.v.toFixed(1);
      } else {
        var tc = CHK[disp.maxKey];
        el('d2-top').textContent = (tc ? tc.name : '—') + ' ' + (disp.chanZ[disp.maxKey] >= 0 ? '+' : '') + disp.chanZ[disp.maxKey].toFixed(1) + 'σ';
      }
    } else {
      el('d2-now').textContent = '—';
      el('d2-norm').textContent = '—';
      el('d2-level').innerHTML = '<span class="db plain">边界</span>';
      el('d2-top').textContent = '—';
    }

    var curLv = disp ? (disp.norm >= LEVEL3 ? 3 : disp.norm >= LEVEL2 ? 2 : disp.norm >= 1 ? 1 : 0) : 0;
    var ruleRows = aware ? [
      { lv: 1, name: '关注', cond: 'D² / 阈值 ≥ 1.00', desc: '连续 ≥10 s 起 episode；推送信息，不响铃。' },
      { lv: 2, name: '预警', cond: '峰值 ≥ 1.15×', desc: '提示司钻核对当前工序与传感器；准备处置。' },
      { lv: 3, name: '报警', cond: '峰值 ≥ 1.35× 且持续 ≥60 s', desc: '停泵/降排量检查，按井控程序处置。' }
    ] : [
      { lv: 1, name: '关注', cond: 'max|z| ≥ 3.0σ', desc: '单通道偏离固定阈值，连续 ≥10 s 起 episode。' },
      { lv: 2, name: '预警', cond: 'max|z| ≥ 3.45σ', desc: '全局阈值没有工序上下文，先核对当前工序。' },
      { lv: 3, name: '报警', cond: 'max|z| ≥ 4.05σ 且持续 ≥60 s', desc: '正常工况本身就会越阈；报警多不等于检出好。' }
    ];
    el('rules').innerHTML = ruleRows.map(function (r) {
      return '<div class="rule' + (curLv === r.lv ? ' on' : '') + '"><div class="hd"><b>' + r.name + '</b><span class="sc">' + r.cond + '</span></div>' +
        '<div class="a">' + r.desc + '</div></div>';
    }).join('');

    var vis = A.episodes.filter(function (ep) { return ep.t0 <= state.cursor; });
    el('ep-hint').textContent = '连续/相邻已合并 · 只标起点 · 当前 ' + vis.length + ' 个';
    if (!vis.length) {
      el('alarms').innerHTML = '<p class="empty">还没有报警。播放或拖动时间轴到 25 min 之后。</p>';
      return;
    }
    var shown = vis.slice(0, 8);
    var aware = A.model.kind === 'aware';
    el('alarms').innerHTML = shown.map(function (ep, i) {
      var lvCls = ep.level === 3 ? 'bad' : ep.level === 2 ? 'warn' : 'info';
      var evTxt;
      if (ep.event) {
        evTxt = '对应真值 #' + (ep.eventIndex + 1) + '（' + ep.event.name + ' ' + ep.event.t.toFixed(1) + '′），提前 <b>' + ep.lead.toFixed(1) + ' min</b>。';
      } else {
        evTxt = '未匹配真值事件：可能是工况/传感器扰动，需人工确认；标为误报后回写正常校准集。';
      }
      var patName = aware ? RULENAME[ep.pattern] : ('单通道偏离 · ' + (ep.maxKey ? CHK[ep.maxKey].name : '—'));
      var peakTxt = aware ? 'D²=' + ep.peakD2.toFixed(1) : 'max|z|=' + ep.peakD2.toFixed(2) + 'σ';
      return '<div class="alarm lv' + ep.level + '">' +
        '<span class="t">' + ep.t0.toFixed(1) + '′</span>' +
        '<div><b>E' + (i + 1) + ' · ' + LV[ep.level] + ' · ' + patName + '</b>' +
        '<div class="a">' + ep.t0.toFixed(1) + '–' + ep.t1.toFixed(1) + ' min · 峰值 ' + ep.peakNorm.toFixed(2) +
        '×（' + peakTxt + '）· 有效 ' + ep.dur.toFixed(0) + ' s · 合并 ' + ep.segments + ' 段。<br>' +
        evTxt + '<br>' + episodeAdvice(ep) + '</div></div>' +
        '<span class="db ' + lvCls + '">' + LV[ep.level] + '</span></div>';
    }).join('') + (vis.length > 8 ? '<p class="empty">还有 ' + (vis.length - 8) + ' 个 episode，未展开。</p>' : '');
  }

  function episodeAdvice(ep) {
    if (A.model.kind === 'naive') return '建议：先核对传感器与当前工序；全局 3σ 没有工序上下文，正常工况本身就可能越阈，不要直接按事故处置。';
    if (ep.pattern === 'stuck') return '建议：上提下放活动管柱、保持循环，控制扭矩与泵压；必要时震击解卡，严禁硬转。';
    if (ep.pattern === 'loss') return '建议：核对返出与池体积，降排量观察，检查泵阀与管柱漏点；按井控程序补充压井液。';
    if (ep.pattern === 'kick') return '建议：关井求压，核对套压/立压与池体积增量，按井控程序循环排气。';
    return '建议：先核对传感器与当前工序，再决定是否处置；不要仅凭异常分判断事故类型。';
  }

  function updateStats(idx) {
    var sc = A.scores[idx];
    var shown = sc.valid ? sc : (A.lastValidArr[idx] >= 0 ? A.scores[A.lastValidArr[idx]] : null);
    if (shown) {
      el('st-score').textContent = shown.norm.toFixed(2) + '×';
      var sub = (A.model.kind === 'aware' ? 'D² ' + shown.d2.toFixed(1) : 'max|z| ' + shown.d2.toFixed(2) + 'σ');
      el('st-score-sub').textContent = (sc.valid ? '' : '最近 · ') + sub;
      var cls = shown.norm >= LEVEL3 ? 'bad' : shown.norm >= LEVEL2 ? 'warn' : shown.norm >= 1 ? 'info' : '';
      el('card-score').className = 'dstat' + (cls ? ' ' + cls : '');
    } else {
      el('st-score').textContent = '—';
      el('st-score-sub').textContent = '边界跳过';
      el('card-score').className = 'dstat';
    }

    var visEps = A.episodes.filter(function (ep) { return ep.t0 <= state.cursor; });
    var visFp = visEps.filter(function (ep) { return !ep.event; });
    el('st-n').textContent = visEps.length;
    el('st-fp').textContent = ' · 误报 ' + visFp.length;
    el('card-eps').className = 'dstat' + (visFp.length ? ' bad' : '');

    el('st-det').textContent = A.detected + '/' + EVENTS.length;
    el('st-miss').textContent = ' · 漏报 ' + A.missed;
    el('card-det').className = 'dstat' + (A.missed ? ' bad' : (A.detected && visEps.length ? ' good' : ''));

    var leads = A.events.filter(function (e) { return e.episode && e.episode.t0 <= state.cursor; })
      .map(function (e) { return e.lead; });
    var lead = leads.length ? medianOf(leads) : null;
    el('st-lead').textContent = lead === null ? '—' : lead.toFixed(1);
    el('card-lead').className = 'dstat' + (lead === null ? '' : ' info');

    el('time-hint').textContent = 't = ' + state.cursor.toFixed(1) + ' min · 2 s/点';
    var scr = el('scrub');
    if (document.activeElement !== scr) scr.value = state.cursor.toFixed(1);
    scr.setAttribute('aria-valuetext', state.cursor.toFixed(1) + ' 分钟');
  }

  /* ---------------- 模型面板 / 直方图 / 贡献 ---------------- */
  function drawHist(Ax) {
    var svg = el('hist');
    if (!svg) return;
    var W = 320, H = 100, L = 28, R = 6, T = 8, B = 18;
    var vals = Ax.normalNorm.concat(Ax.abnormalNorm);
    var hi = 2.2;
    if (vals.length) hi = Math.max(hi, Math.min(8, quantile(vals, 0.995) * 1.08));
    var bins = 22;
    var hn = new Array(bins).fill(0), ha = new Array(bins).fill(0);
    function binOf(v) {
      var q = Math.floor(Math.max(0, Math.min(1, v / hi)) * bins);
      return Math.min(bins - 1, q);
    }
    Ax.normalNorm.forEach(function (v) { hn[binOf(v)]++; });
    Ax.abnormalNorm.forEach(function (v) { ha[binOf(v)]++; });
    /* 两条分布按各自组内占比画：正常窗口远多于异常窗口，
       直接按计数画会把异常分布压成看不见的小条。 */
    var hnTotal = Math.max(1, Ax.normalNorm.length);
    var haTotal = Math.max(1, Ax.abnormalNorm.length);
    var hnP = hn.map(function (v) { return v / hnTotal; });
    var haP = ha.map(function (v) { return v / haTotal; });
    var maxC = Math.max.apply(null, hnP.concat(haP)) || 1;
    var bw = (W - L - R) / bins;

    function X(v) { return L + Math.min(1, v / hi) * (W - L - R); }
    function Y(c) { return H - B - c / maxC * (H - T - B); }

    var s = '';
    [0, 0.5, 1].forEach(function (f) {
      var y = T + (H - T - B) * f;
      s += '<line x1="' + L + '" y1="' + y + '" x2="' + (W - R) + '" y2="' + y + '" stroke="#efece1"/>';
    });
    for (var i = 0; i < bins; i++) {
      var x = L + i * bw;
      var h1 = H - B - Y(hnP[i]);
      if (hn[i]) s += '<rect x="' + (x + 0.4).toFixed(1) + '" y="' + Y(hnP[i]).toFixed(1) + '" width="' + (bw / 2 - 0.6).toFixed(1) + '" height="' + h1.toFixed(1) + '" fill="rgba(36,92,90,.55)"/>';
      var h2 = H - B - Y(haP[i]);
      if (ha[i]) s += '<rect x="' + (x + bw / 2 + 0.2).toFixed(1) + '" y="' + Y(haP[i]).toFixed(1) + '" width="' + (bw / 2 - 0.6).toFixed(1) + '" height="' + h2.toFixed(1) + '" fill="rgba(166,75,60,.62)"/>';
    }
    s += '<line x1="' + X(1).toFixed(1) + '" y1="' + T + '" x2="' + X(1).toFixed(1) + '" y2="' + (H - B) + '" stroke="#a64b3c" stroke-width="1.1" stroke-dasharray="4 3"/>';
    s += '<text x="' + (X(1) + 3).toFixed(1) + '" y="' + (T + 8) + '" font-size="7.5" font-family="monospace" fill="#a64b3c">' + (Ax.model.kind === 'aware' ? 'q99' : '3σ') + '</text>';
    s += '<text x="' + L + '" y="' + (H - 7) + '" font-size="7.5" font-family="monospace" fill="#99a3a4">0</text>';
    s += '<text x="' + X(1).toFixed(1) + '" y="' + (H - 7) + '" font-size="7.5" font-family="monospace" fill="#99a3a4" text-anchor="middle">1.0</text>';
    s += '<text x="' + (W - R) + '" y="' + (H - 7) + '" font-size="7.5" font-family="monospace" fill="#99a3a4" text-anchor="end">' + hi.toFixed(1) + '</text>';
    s += '<text x="' + L + '" y="' + (H - 1) + '" font-size="7" font-family="monospace" fill="#99a3a4">绿 = 正常校准 · 红 = 本页异常窗口 · 组内占比 · 越右越异常</text>';
    s += '<g id="hist-now" style="display:none"><path d="M0 -5 L-3.5 1 L3.5 1 Z" fill="#245c5a"/><text x="4" y="3" font-size="7.5" font-family="monospace" fill="#123a3d">当前</text></g>';
    svg.innerHTML = s;
  }

  function updateHistMarker(idx) {
    var g = document.getElementById('hist-now');
    if (!g) return;
    var sc = A.scores[idx];
    if (!sc.valid) { g.style.display = 'none'; return; }
    var vals = A.normalNorm.concat(A.abnormalNorm);
    var hi = 2.2;
    if (vals.length) hi = Math.max(hi, Math.min(8, quantile(vals, 0.995) * 1.08));
    var x = 28 + Math.min(1, sc.norm / hi) * (320 - 28 - 6);
    g.style.display = '';
    g.setAttribute('transform', 'translate(' + x.toFixed(1) + ',94)');
  }

  function buildThrGrid() {
    var curP = phaseIndexAt(state.cursor);
    var model = A.model;
    if (model.kind === 'aware') {
      el('thrgrid').style.gridTemplateColumns = 'repeat(4,minmax(0,1fr))';
      el('thrgrid').innerHTML = PHASES.map(function (p, i) {
        return '<div class="ti' + (i === curP ? ' on' : '') + '" title="' + esc(p.name) + '"><div class="nm">' + esc(p.short) + '</div><div class="vv">' + model.groups[i].thr.toFixed(1) + '</div></div>';
      }).join('');
    } else {
      el('thrgrid').style.gridTemplateColumns = 'repeat(2,minmax(0,1fr))';
      el('thrgrid').innerHTML = '<div class="ti on"><div class="nm">全局阈值</div><div class="vv">3.0σ</div></div>' +
        '<div class="ti"><div class="nm">8 个工序共用</div><div class="vv">' + (model.fpr * 100).toFixed(0) + '% 越阈</div></div>';
    }
  }

  function updateContrib(idx) {
    var cur = A.scores[idx];
    var disp = cur.valid ? cur : (A.lastValidArr[idx] >= 0 ? A.scores[A.lastValidArr[idx]] : null);
    if (!disp) {
      el('contrib').innerHTML = '<p class="empty">当前在工序边界，窗口不评分；拖动到工序内部查看贡献。</p>';
      return;
    }

    if (A.model.kind === 'naive') {
      var rows = CH.map(function (c) { return { label: c.name, v: disp.chanZ[c.key] }; });
      rows.sort(function (a, b) { return Math.abs(b.v) - Math.abs(a.v); });
      var mx = Math.abs(rows[0].v) || 1;
      el('contrib').innerHTML = rows.map(function (r) {
        var w = Math.abs(r.v) / mx * 50;
        var col = r.v >= 0 ? 'var(--bad)' : 'var(--info)';
        return '<div class="cr"><span class="lb">' + esc(r.label) + '</span>' +
          '<span class="track"><i style="' + (r.v >= 0 ? 'left:50%' : 'left:' + (50 - w).toFixed(1) + '%') + ';width:' + w.toFixed(1) + '%;background:' + col + '"></i></span>' +
          '<span class="v">' + (r.v >= 0 ? '+' : '') + r.v.toFixed(2) + 'σ</span></div>';
      }).join('') + '<div class="sum">max|z| = ' + disp.d2.toFixed(2) + 'σ · 阈值 3.0σ</div>';
      return;
    }

    var frows = FEATURES.map(function (f, j) { return { f: f, v: disp.contrib[j] }; });
    frows.sort(function (a, b) { return Math.abs(b.v) - Math.abs(a.v); });
    var maxAbs = Math.abs(frows[0].v) || 1;
    var html = frows.slice(0, 5).map(function (r) {
      var w = Math.abs(r.v) / maxAbs * 50;
      var col = r.v >= 0 ? 'var(--bad)' : 'var(--info)';
      return '<div class="cr"><span class="lb">' + esc(r.f.label) + '</span>' +
        '<span class="track"><i style="' + (r.v >= 0 ? 'left:50%' : 'left:' + (50 - w).toFixed(1) + '%') + ';width:' + w.toFixed(1) + '%;background:' + col + '"></i></span>' +
        '<span class="v">' + (r.v >= 0 ? '+' : '') + r.v.toFixed(1) + '</span></div>';
    }).join('');
    var sum = disp.contrib.reduce(function (a, b) { return a + b; }, 0);
    el('contrib').innerHTML = html + '<div class="sum">Σ 贡献 = D² = ' + sum.toFixed(1) + '</div>';
  }

  function updateModelPanel() {
    var model = A.model;
    var aware = model.kind === 'aware';
    var idx = Math.max(0, Math.min(N - 1, Math.round(state.cursor / DT)));
    var p = PHASE_OF[idx];
    var g = model.groupOf(p);

    if (aware) {
      el('stage2-lede').innerHTML = '每个工序内滑 20 点（40 s）窗，步长 1 点。每个窗口抽 <b>6 残差 + 6 标准差 + 6 斜率 + 3 通道相关</b>：残差看相对本工序正常基线偏了多少，标准差看波动，斜率看趋势，相关看通道是否一起动。';
      el('stage3-lede').innerHTML = '8 次合成正常作业，5 训练 / 3 校准；逐工序只用正常窗口估计 21 维特征的 μ/Σ（收缩 λ=0.08），算马氏距离 D²；阈值取校准集 q99（目标 1% 误报），分级线 1.15/1.35 倍。';
      el('stage4-lede').innerHTML = '报警不是单点越阈：D²/阈值 ≥1 连续 ≥10 s 才起 episode；20 s 内的相邻段合并；峰值 ≥1.15× 记预警，≥1.35× 且持续 ≥60 s 记报警。提前量 = 真值事件时刻 − episode 起点。';
    } else {
      el('stage2-lede').innerHTML = '对照模式仍展示 20 点窗口特征，但报警只用当前点的<b>单通道 max|z|</b>，不使用这 21 维特征。这样能看到「有特征、但没有工况分段和联合模型」会差在哪。';
      el('stage3-lede').innerHTML = '对照：8 个工序共用一个全局基线与 σ，阈值固定 3σ。全局基线是各工序的平均，正常工况本身就会远离它；这不是校准后的模型。';
      el('stage4-lede').innerHTML = '对照模式的报警是单通道 max|z| ≥3σ 连续 ≥10 s；没有多变量联合，也没有按工序校准。相邻段仍按 20 s 合并，分级线是 3σ 的 1.15 / 1.35 倍。';
    }

    el('procsteps').innerHTML = aware
      ? '<span>① 正常段窗口</span><span>→ ② 5 训练 / 3 校准</span><span>→ ③ 逐工序 μ/Σ（收缩）</span><span>→ ④ q99 校准</span>'
      : '<span>① 全局基线</span><span>→ ② 全局 σ</span><span>→ ③ 固定 3σ</span><span>→ ④ 不按工序校准</span>';

    el('k-dim').textContent = aware ? '特征维数' : '通道数';
    el('k-lambda').textContent = aware ? '收缩系数 λ' : '全局基线';
    el('k-thr').textContent = aware ? '当前工序阈值 q99' : '固定阈值';
        el('k-score').textContent = aware ? '当前 D² / 阈值' : '当前 max|z| / 3σ';
    el('k-d2now').textContent = aware ? '当前 D²' : '当前 max|z|';
    el('k-d2norm').textContent = aware ? 'D² / 阈值' : 'max|z| / 3σ';
    el('s-d2now').textContent = aware ? '马氏距离' : '单通道最大偏离';
    el('s-d2norm').textContent = aware ? '1.0 = 该工序 q99' : '1.0 = 固定 3σ';
    el('k-lfpr').textContent = aware ? '校准 FPR' : '正常越阈率';
    el('hist-hint').textContent = aware
      ? '正常校准 vs 本页异常窗口 · x = D²/阈值'
      : '正常校准 vs 本页异常窗口 · x = max|z| / 3σ';
    el('contrib-title').textContent = aware ? '当前窗口的通道贡献' : '当前点的单通道偏离';
    el('contrib-hint').textContent = aware ? 'z_j × (Σ⁻¹z)_j · 相加 = D²' : 'max|z| / 3σ · 取绝对值最大';
    
    el('m-n').textContent = fmt(model.nTrain) + ' / ' + fmt(model.nCal);
    el('m-dim').textContent = aware ? DIM : CH.length;
    el('m-lambda').textContent = aware ? LAMBDA.toFixed(2) : '全局';
    el('m-thr').textContent = aware ? g.thr.toFixed(1) : '3.0σ';
    el('m-fpr').innerHTML = '<span style="color:' + (model.fpr <= 0.015 ? 'var(--ok)' : 'var(--bad)') + '">' + (model.fpr * 100).toFixed(1) + '%</span>';
    el('m-normal').textContent = model.normalMedian === null ? '—' : model.normalMedian.toFixed(2) + '×';
    el('m-abnormal').textContent = A.abnormalMedian === null ? '—' : A.abnormalMedian.toFixed(2) + '×';
    el('m-thrrange').textContent = aware ? model.thrMin.toFixed(1) + '–' + model.thrMax.toFixed(1) : '全局 3σ';

    el('m-badge').textContent = aware ? '逐工序 8 模型' : '全局 3σ 对照';
    el('m-badge').className = 'db ' + (aware ? 'ok' : 'warn');
    el('m-summary').innerHTML = aware
      ? '校准 FPR <b>' + (model.fpr * 100).toFixed(1) + '%</b> · 本页检出 <b>' + A.detected + '/' + EVENTS.length +
        '</b> · 误报 <b>' + A.falseCount + '</b> · 中位提前 <b>' + (A.leadMedian === null ? '—' : A.leadMedian.toFixed(1) + ' min') + '</b>'
      : '固定 3σ · 正常窗口越阈 <b>' + (model.fpr * 100).toFixed(1) + '%</b> · 本页检出 <b>' + A.detected + '/' + EVENTS.length +
        '</b> · 误报 <b>' + A.falseCount + '</b>';

    el('hist').setAttribute('aria-label', aware ? '正常与异常窗口的马氏距离得分分布' : '正常与异常窗口的单通道最大偏离分布');
    drawHist(A);
    buildThrGrid();
  }

  function latestVisibleEpisode() {
    var vis = A.episodes.filter(function (ep) { return ep.t0 <= state.cursor; });
    return vis.length ? vis[vis.length - 1] : null;
  }

  function updateLoopCard() {
    var box = el('loop-card');
    if (!box) return;
    var ep = latestVisibleEpisode();
    if (!ep) {
      box.innerHTML = '<div class="top"><span class="rank">最新报警</span><span class="db plain">等待</span></div>' +
        '<p>播放到 25 min 之后，这里会出现「疑似什么 + 建议动作」的报警卡片。</p>';
      return;
    }
    var lvCls = ep.level === 3 ? 'bad' : ep.level === 2 ? 'warn' : 'info';
    var pat = A.model.kind === 'aware' ? RULENAME[ep.pattern] : ('单通道偏离 · ' + (ep.maxKey ? CHK[ep.maxKey].name : '—'));
    var evTxt = ep.event
      ? '对应真值 #' + (ep.eventIndex + 1) + '（' + ep.event.name + ' ' + ep.event.t.toFixed(1) + '′）· 提前 ' + ep.lead.toFixed(1) + ' min'
      : '未匹配真值 · 需人工确认';
    box.innerHTML = '<div class="top"><span class="rank">最新报警 · ' + ep.t0.toFixed(1) + '′</span><span class="db ' + lvCls + '">' + LV[ep.level] + '</span></div>' +
      '<h4>' + pat + '</h4>' +
      '<p>峰值 ' + ep.peakNorm.toFixed(2) + '× · 有效 ' + ep.dur.toFixed(0) + ' s · ' + evTxt + '</p>' +
      '<p><b>建议动作：</b>' + episodeAdvice(ep) + '</p>';
  }

  function updateLoop() {
    el('l-det').textContent = A.detected + '/' + EVENTS.length;
    el('l-fp').textContent = A.falseCount;
    el('l-lead').textContent = A.leadMedian === null ? '—' : A.leadMedian.toFixed(1) + ' min';
    el('l-fpr').textContent = (A.model.fpr * 100).toFixed(1) + '%';
    el('l-fp').className = 'v' + (A.falseCount ? ' bad' : ' ok');
    el('l-det').className = 'v' + (A.missed ? ' bad' : ' ok');
    var n = FB.ok + FB.bad;
    el('fb-note').textContent = '回写 ' + n + ' 条' + (FB.bad ? ' · 其中误报 ' + FB.bad + ' 条' : '') +
      (FB_EXTRA.length ? ' · 待重标定 ' + FB_EXTRA.length + ' 窗' : (FB_APPLIED.length ? ' · 已重标定 ' + FB_APPLIED.length + ' 窗' : '')) +
      ' · 人工确认后才进入下一轮训练';
    updateLoopCard();
  }

  function noteText() {
    var m = A.model;
    var leadTxt = A.leadMedian === null ? '—' : A.leadMedian.toFixed(1) + ' min';
    var base;
    if (state.phaseAware) {
      base = '逐工序正常模型：8 个工序各自估计 21 维窗口特征的 μ/Σ（收缩 λ=' + LAMBDA.toFixed(2) +
        '），阈值取校准集 q99（校准 FPR <b>' + (m.fpr * 100).toFixed(1) + '%</b>）。本页 60 min 作业：检出 <b>' +
        A.detected + '/' + EVENTS.length + '</b>，误报 <b>' + A.falseCount + '</b> 个 episode，中位提前 <b>' + leadTxt +
        '</b>。报警由 D²/阈值连续 ≥' + MIN_RUN + ' 点（' + (MIN_RUN * 2) + ' s）触发，' + (MERGE_GAP * 2) + ' s 内相邻段合并；单点尖刺不会直接报警。';
    } else {
      base = '注意：<b>工况感知已关闭</b>——退回全局单通道 3σ 对照：基线是 8 个工序的平均，起管柱时立压接近 0、磨铣时扭矩天然高、试压时立压又高，这些正常工况本身就远离全局基线。本页出现 <b>' +
        A.episodes.length + '</b> 个 episode、误报 <b>' + A.falseCount + '</b>，检出 <b>' + A.detected + '/' + EVENTS.length +
        '</b>；正常窗口越阈率 <b>' + (m.fpr * 100).toFixed(1) + '%</b>。报警变多不等于变好：多出来的多是工况切换和工序差异，真正的前兆反而可能被淹没。';
    }
    if (!state.phaseAware) {
      base += '<br>这正是「工况感知」要解决的事：正常模型必须知道当前工序，否则它会把「磨铣时扭矩本来就高」当成异常，也会把「起管柱时立压接近 0」当成异常。';
    } else {
      base += '<br>工序顺序：<b>压井/井控（0–8）→ 起原井管柱（8–16）→ 通井/打印（16–24）→ 磨铣/打捞（24–30）→ 停钻/活动管柱（30–36）→ 震击解卡（36–42）→ 循环洗井（42–50）→ 完井试压（50–60）</b>。卡管柱后没有继续按原计划直接循环，而是插入停钻/活动管柱/震击解卡段。';
    }
    if (A.missed) base += '<br>当前有 <b>' + A.missed + '</b> 起事件没有在前兆窗口内形成预警级 episode；这正是需要人工复核和下一轮校准的边界。';
    return base;
  }

  function dynamic() {
    if (!A) return;
    var idx = Math.max(0, Math.min(N - 1, Math.round(state.cursor / DT)));
    updateReads(idx);
    updateFeatures(idx);
    updateDecision(idx);
    updateStats(idx);
    updateContrib(idx);
    updateHistMarker(idx);
    updateLoop();
    draw();

    /* 播放时按新出现的 episode 写日志；自动模式下切到 04 */
    var vis = A.episodes.filter(function (ep) { return ep.t0 <= state.cursor; });
    if (vis.length > loggedEpCount) {
      for (var i = loggedEpCount; i < vis.length; i++) {
        var ep = vis[i];
        trace('报警', 'E' + (i + 1) + ' · ' + LV[ep.level] + ' · ' + ep.t0.toFixed(1) + '′ · 峰值 ' + ep.peakNorm.toFixed(2) + '× · ' +
          (ep.event ? '提前 ' + ep.lead.toFixed(1) + ' min' : '未匹配真值'), ep.event ? 'ok' : 'warn');
      }
      loggedEpCount = vis.length;
      if (state.autoStage) setStage(3, null);
    }
    if (state.cursor >= DUR - 0.001 && state.playing) {
      pause();
      if (state.autoStage) setStage(4, null);
    }
  }

  function renderAll(resetCursor) {
    A = analyze();
    if (resetCursor) state.cursor = 0;
    loggedEpCount = A.episodes.filter(function (ep) { return ep.t0 <= state.cursor; }).length;
    updateModelPanel();
    dynamic();
    el('note').innerHTML = noteText();
  }

  /* ---------------- 控件 ---------------- */
  var rScrub = el('scrub');
  rScrub.addEventListener('input', function () {
    if (state.playing) pause();
    state.autoStage = false;
    state.cursor = Number(rScrub.value);
    dynamic();
  });

  var chkPhase = el('chk-phase');
  var togPhase = el('tog-phase');
  chkPhase.addEventListener('change', function () {
    state.phaseAware = chkPhase.checked;
    togPhase.classList.toggle('on', state.phaseAware);
    renderAll(false);
    trace('模型', state.phaseAware
      ? '工况感知开启：逐工序 μ/Σ + 边界跳过 · 阈值 q99 · 本页误报 ' + A.falseCount
      : '工况感知关闭：全局 μ/Σ · 本页 episode ' + A.episodes.length + ' · 误报 ' + A.falseCount + ' · 检出 ' + A.detected + '/2',
      state.phaseAware ? 'ok' : 'warn');
  });

  var timer = null;
  function pause() {
    if (timer) { clearInterval(timer); timer = null; }
    state.playing = false;
    cancelTour();
    el('play').textContent = '▶ 运行全流程';
    el('play').setAttribute('aria-pressed', 'false');
  }
  function startTour() {
    clearTrace();
    var steps = [
      ['01', '接入 1800 点 × 6 通道 · 工序记录 8 段 · 边界 ±24 s 不评分'],
      ['02', '滑窗 20 点/40 s · 21 维特征：残差 / 标准差 / 斜率 / 通道相关'],
      ['03', '正常段 8 次作业 · 逐工序 μ/Σ（收缩 λ=' + LAMBDA.toFixed(2) + '）· q99 阈值校准'],
      ['04', 'D²/阈值 ≥1 连续 10 s 起 episode · 20 s 内相邻合并 · 三级分级'],
      ['05', '报警卡片 → 人工确认 / 误报回写 → 下一轮重标定']
    ];
    steps.forEach(function (s, i) {
      tourTimers.push(setTimeout(function () {
        if (!state.playing) return;
        setStage(i, null);
        trace(s[0], s[1]);
      }, i * 800));
    });
    tourTimers.push(setTimeout(function () {
      if (state.playing && state.autoStage) {
        setStage(0, null);
        trace('回放', '时间轴继续 · 报警出现时自动切到 04', 'ok');
      }
    }, 4200));
  }
  function play() {
    if (state.playing) { pause(); return; }
    if (state.cursor >= DUR) {
      state.cursor = 0;
      loggedEpCount = 0;
    }
    state.playing = true;
    el('play').textContent = '❚❚ 暂停';
    el('play').setAttribute('aria-pressed', 'true');
    if (state.cursor === 0 && !state.toured && state.autoStage) { state.toured = true; startTour(); }
    timer = setInterval(function () {
      state.cursor = Math.min(DUR, state.cursor + 0.06 * state.speed);
      dynamic();
    }, 30);
  }
  el('play').addEventListener('click', play);
  el('reset').addEventListener('click', function () {
    pause();
    state.cursor = 0;
    state.hover = null;
    state.autoStage = true;
    state.toured = false;
    state.phaseAware = true;
    state.speed = 1;
    chkPhase.checked = true;
    togPhase.classList.add('on');
    [].forEach.call(el('spd').querySelectorAll('button'), function (b) {
      var on = b.getAttribute('data-spd') === '1';
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    FB = { ok: 0, bad: 0 };
    FB_EXTRA = [];
    FB_APPLIED = [];
    MODELS = buildModels(null);
    renderAll(true);
    setStage(0, false);
    clearTrace();
    initTrace();
  });

  var spd = el('spd');
  spd.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button[data-spd]') : null;
    if (!b) return;
    state.speed = Number(b.getAttribute('data-spd'));
    [].forEach.call(spd.querySelectorAll('button'), function (x) {
      var on = x === b;
      x.classList.toggle('on', on);
      x.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  });

  el('flow').addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button[data-s]') : null;
    if (!b) return;
    cancelTour();
    state.autoStage = false;
    setStage(Number(b.getAttribute('data-s')), null);
  });

  el('feedback').addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button[data-fb]') : null;
    if (!b) return;
    var k = b.getAttribute('data-fb');
    FB[k]++;
    var idx = Math.max(0, Math.min(N - 1, Math.round(state.cursor / DT)));
    var sc = A.scores[idx];
    var ep = latestVisibleEpisode();
    var epName = ep ? ('E' + (A.episodes.indexOf(ep) + 1) + '（' + ep.t0.toFixed(1) + '′）') : '';
    if (k === 'bad' && ep && ep.peak && ep.peak.valid) {
      FB_EXTRA.push({ phase: ep.peak.phase, raw: ep.peak.raw });
      trace('反馈', '标为误报 · ' + epName + ' 的峰值窗口已回写正常校准集 · 待重标定', 'warn');
    } else if (k === 'bad' && sc.valid) {
      FB_EXTRA.push({ phase: sc.phase, raw: sc.raw });
      trace('反馈', '标为误报 · 当前窗口（' + (idx * DT).toFixed(1) + '′）已回写正常校准集 · 待重标定', 'warn');
    } else {
      trace('反馈', k === 'ok'
        ? ('人工确认：' + (epName || '当前') + ' 报警正确 · 进入事件台账')
        : ('标为误报 · ' + (epName || '当前不在可评分窗口') + '，只计数'), k === 'ok' ? 'ok' : 'warn');
    }
    updateLoop();
  });

  el('btn-recal').addEventListener('click', function () {
    if (!FB_EXTRA.length) {
      trace('反馈', '还没有误报窗口可回写；先点「✗ 标为误报」', 'warn');
      return;
    }
    var nAdd = FB_EXTRA.length;
    FB_APPLIED = FB_APPLIED.concat(FB_EXTRA);
    FB_EXTRA = [];
    MODELS = buildModels(extraByPhase());
    renderAll(false);
    trace('重标定', '用 ' + nAdd + ' 个回写窗口重估 μ/Σ 与 q99 · 本页误报 ' + A.falseCount + ' · 检出 ' + A.detected + '/2', 'ok');
  });

  /* hover 十字线：只重绘画布，不改右栏 DOM */
  cv.addEventListener('mousemove', function (e) {
    var r = cv.getBoundingClientRect();
    var x = e.clientX - r.left, y = e.clientY - r.top;
    if (x < G.L || x > Wc - G.R || y < G.top || y > G.stripY + G.stripH) { state.hover = null; draw(); return; }
    state.hover = { t: Math.max(0, Math.min(DUR, G.tx(x))), x: x, y: y };
    draw();
  });
  cv.addEventListener('mouseleave', function () { state.hover = null; draw(); });

  function resize() { layout(); draw(); }
  if (window.ResizeObserver) {
    new ResizeObserver(function () { resize(); }).observe(cv);
  }
  window.addEventListener('resize', resize);

  /* ---------------- 初始化 ---------------- */
  buildReads();
  buildFeatureTable();
  clearTrace();
  initTrace();
  state.cursor = 1.2;
  renderAll(false);
  setStage(0, false);

  window.__demo = {
    state: state,
    analyze: analyze,
    data: DISPLAY.data,
    models: function () { return MODELS; },
    getA: function () { return A; },
    setCursor: function (t) { state.cursor = t; dynamic(); },
    setPhaseAware: function (v) { state.phaseAware = !!v; chkPhase.checked = state.phaseAware; togPhase.classList.toggle('on', state.phaseAware); renderAll(false); },
    metrics: function () {
      return {
        aware: state.phaseAware,
        detected: A.detected, missed: A.missed, falseCount: A.falseCount,
        leadMedian: A.leadMedian, episodes: A.episodes.length,
        fpr: A.model.fpr, nTrain: A.model.nTrain, nCal: A.model.nCal,
        abnormalMedian: A.abnormalMedian, normalMedian: A.model.normalMedian,
        thrMin: A.model.thrMin, thrMax: A.model.thrMax,
        eps: A.episodes.map(function (e) {
          return { t0: +e.t0.toFixed(2), t1: +e.t1.toFixed(2), level: e.level, peak: +e.peakNorm.toFixed(2), pattern: e.pattern, event: e.event ? e.event.name : null, lead: e.lead };
        })
      };
    }
  };
})();
