/* =========================================================
   气测异常解释 · 从全烃曲线到流体性质（AI 作业流示范）
   ---------------------------------------------------------
   ① 采集与质控：3000—4200 m 合成气测资料（全烃 + C1—C5 + 钻时），
      叠加背景气漂移、接单根窄峰与仪器噪声；检查迟到时间、
      脱气器效率、背景漂移与窄尖峰。
   ② 基线校正：滑动分位数（可切滑动均值 / 不校正），
      实测减基线得校正曲线；峰高 k·σ + 持续长度双判据分段。
   ③ 特征与样本：每个候选段取窗口，算 8 维特征
      （峰基比、C1/C2、C1/C3、湿度比、平衡比、字符比、
        持续长度、上升斜率）；合成 18 口井 × 40 窗口 = 720 个
      气 / 油 / 水 / 干层四类训练样本。
   ④ 模型：在本页现场训练 softmax 回归（标准化 + 标签平滑 +
      L2 + 温度缩放），留出校准集与测试集，输出损失曲线、
      混淆矩阵、测试指标、当前段四类概率与特征贡献。
   ⑤ 决策与闭环：段聚合 + Pixler 图版物理交叉验证 +
      置信度分级 + 人工解释回写；价值指标按示范口径。
   纯前端、不联网、不依赖第三方库。
   ========================================================= */
(function () {
  'use strict';

  var el = function (id) { return document.getElementById(id); };

  /* ---------------- 0. 小工具 ---------------- */
  function mkRnd(seed) {
    var a = seed;
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function norm(v) {
    var s = 0, i;
    for (i = 0; i < v.length; i++) s += v[i];
    return v.map(function (x) { return x / s; });
  }
  function quant(v, q) {
    var s = v.slice().sort(function (a, b) { return a - b; });
    if (!s.length) return 0;
    var p = (s.length - 1) * q, i = Math.floor(p);
    return i + 1 < s.length ? s[i] + (s[i + 1] - s[i]) * (p - i) : s[i];
  }
  function mad(v) {
    var med = quant(v, 0.5);
    var a = v.map(function (x) { return Math.abs(x - med); }).sort(function (x, y) { return x - y; });
    return Math.max(0.015, 1.4826 * a[Math.floor(a.length / 2)]);
  }
  function wmed(V, k) {
    if (!V.length) return 0;
    var s = V.slice().sort(function (x, y) { return x[k] - y[k]; });
    var tot = 0, half = 0, i;
    for (i = 0; i < s.length; i++) tot += s[i].w;
    for (i = 0; i < s.length; i++) { half += s[i].w; if (half >= tot * 0.5) return s[i][k]; }
    return s[s.length - 1][k];
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function pct(v, d) { return (v * 100).toFixed(d === undefined ? 0 : d) + '%'; }
  /* softmax 在分布外样本上会浮点饱和到 0/1；显示截断，避免出现 100.0% */
  function pctS(v) {
    if (v >= 0.9995) return '99.9%+';
    if (v <= 0.0005) return '<0.1%';
    return (v * 100).toFixed(1) + '%';
  }

  /* ---------------- 1. 合成单井气测资料 ---------------- */
  var NZ = 480, D0 = 3000, DZ = 2.5, DEPTH = NZ * DZ;   /* 2.5 m 一点 */
  var NOISE_AMP = 0.10;

  var R = mkRnd(20261023), NOISE = [], SPR = [], i0;
  for (i0 = 0; i0 < NZ; i0++) NOISE.push((R() + R() + R() - 1.5) * 1.3);
  for (i0 = 0; i0 < NZ; i0++) SPR.push(R());

  var BG_REL = [100, 3.0, 0.75, 0.24, 0.08];   /* 背景气（贫气）组成 */
  var BG_FRAC = norm(BG_REL);

  var LAYERS = [
    { key: 'gas', name: '气层', d0: 3280, d1: 3325, amp: 4.6, shape: 'sharp', rel: [100, 4, 1.3, 0.4, 0.12] },
    { key: 'oil', name: '油层', d0: 3560, d1: 3665, amp: 2.8, shape: 'flat', rel: [100, 17, 11, 6, 3] },
    { key: 'thin', name: '薄油层', d0: 3740, d1: 3770, amp: 0.65, shape: 'thin', rel: [100, 12, 7, 3.5, 1.6] },
    { key: 'water', name: '水层', d0: 3895, d1: 3975, amp: 1.05, shape: 'tail', rel: [100, 0.85, 0.32, 0.11, 0.04] }
  ];
  LAYERS.forEach(function (z) { z.frac = norm(z.rel); });

  var MODES = [
    { key: 'normal', name: '正常钻进', bgA: 0.30, bgB: 0.42, spikeA: 0.62, spikeN: 14, gain: 1.00, lag: 38 },
    { key: 'heavy', name: '加重钻井液', bgA: 0.20, bgB: 0.30, spikeA: 0.40, spikeN: 14, gain: 0.62, lag: 42 },
    { key: 'conn', name: '接单根频繁', bgA: 0.40, bgB: 0.55, spikeA: 0.75, spikeN: 11, gain: 1.00, lag: 35 }
  ];
  function modeOf(k) {
    for (var i = 0; i < MODES.length; i++) if (MODES[i].key === k) return MODES[i];
    return MODES[0];
  }

  var BASEM = [
    { key: 'quantile', name: '滑动分位数' },
    { key: 'mean', name: '滑动均值' },
    { key: 'none', name: '不校正' }
  ];
  function baseName(k) {
    for (var i = 0; i < BASEM.length; i++) if (BASEM[i].key === k) return BASEM[i].name;
    return BASEM[0].name;
  }

  function shapeOf(z, d) {
    var c = (z.d0 + z.d1) / 2, hw = (z.d1 - z.d0) / 2, t = (d - c) / hw;
    if (z.shape === 'tail') {
      if (t < -1) return 0;
      return t < 0 ? Math.pow(Math.cos(t * Math.PI / 2), 0.8) : Math.exp(-t * 2.1);
    }
    if (t <= -1 || t >= 1) return 0;
    if (z.shape === 'flat') return 1 - Math.pow(t, 4);
    if (z.shape === 'sharp') return Math.exp(-Math.pow(t * 2.6, 2));
    return Math.exp(-Math.pow(t * 2.2, 2));
  }

  function synth(modeKey, spikesOn) {
    var M = modeOf(modeKey);
    var total = [], bgArr = [], showArr = [], rop = [], comp = [[], [], [], [], []];
    for (var i = 0; i < NZ; i++) {
      var d = D0 + i * DZ, t = i / (NZ - 1);
      var b = M.bgA + M.bgB * Math.pow(t, 1.6) + 0.045 * Math.sin(t * 8.2 + 0.7);
      var show = 0, amt = [0, 0, 0, 0, 0];
      LAYERS.forEach(function (z, k) {
        var sh = shapeOf(z, d);
        if (sh > 0) { var a = z.amp * M.gain * sh; show += a; amt[k] = a; }
      });
      var lf = [0, 0, 0, 0, 0];
      if (show > 0) for (var j = 0; j < 5; j++) {
        var s = 0;
        LAYERS.forEach(function (z, k) { s += amt[k] * z.frac[j]; });
        lf[j] = s / show;
      }
      var spike = 0;
      if (spikesOn && i > 3 && i % M.spikeN === 1) spike = M.spikeA * (0.7 + 0.6 * SPR[i]);
      if (spikesOn && i > 3 && i % M.spikeN === 2) spike = Math.max(spike, M.spikeA * 0.5 * (0.7 + 0.6 * SPR[i]));
      var tv = b + show + spike + NOISE_AMP * NOISE[i];
      var wDry = b + spike;
      for (var j2 = 0; j2 < 5; j2++) {
        var f = show > 0 ? (wDry * BG_FRAC[j2] + show * lf[j2]) / (wDry + show) : BG_FRAC[j2];
        comp[j2].push(tv * f);
      }
      total.push(tv); bgArr.push(b); showArr.push(show);
      var r = 8.3 + 0.9 * NOISE[i];
      LAYERS.forEach(function (z) { r -= 3.6 * shapeOf(z, d) * (z.key === 'water' ? 0.5 : 1); });
      rop.push(Math.max(2.5, Math.min(11, r)));
    }
    return { total: total, bg: bgArr, show: showArr, rop: rop, comp: comp };
  }

  /* ---------------- 2. 四类窗口样本与 softmax 模型 ---------------- */
  var CLS = [
    { key: 'gas', name: '气层', short: '气', color: '#123b3a', fill: 'rgba(18,59,58,.10)', badge: 'ok' },
    { key: 'oil', name: '油层', short: '油', color: '#a86a1f', fill: 'rgba(168,106,31,.12)', badge: 'warn' },
    { key: 'water', name: '水层', short: '水', color: '#2b5570', fill: 'rgba(43,85,112,.11)', badge: 'plain' },
    { key: 'dry', name: '干层', short: '干', color: '#7a7260', fill: 'rgba(122,114,96,.12)', badge: 'plain' }
  ];
  var NCLS = 4, DIM = 8;
  var FKEYS = ['pbr', 'r12', 'r13', 'wh', 'bh', 'ch', 'dur', 'slope'];
  var FLABEL = {
    pbr: '峰基比', r12: 'C1/C2', r13: 'C1/C3', wh: '湿度比 Wh',
    bh: '平衡比 Bh', ch: '字符比 Ch', dur: '持续长度', slope: '上升斜率'
  };

  var MR = mkRnd(20261031);
  function mlogu(a, b) { return Math.exp(Math.log(a) + MR() * (Math.log(b) - Math.log(a))); }

  var SPEC = {
    gas: { pbr: [2.2, 12], r12: [12, 80], r13: [30, 300], wh: [1, 18], bh: [15, 220], ch: [0.1, 0.9], dur: [3, 16], slope: [0.2, 1.5] },
    oil: { pbr: [1.7, 7], r12: [2.5, 24], r13: [4, 75], wh: [8, 52], bh: [2, 26], ch: [0.25, 2.0], dur: [8, 45], slope: [0.03, 0.35] },
    water: { pbr: [1.3, 4.4], r12: [28, 240], r13: [70, 750], wh: [0.25, 8], bh: [70, 650], ch: [0.08, 1.0], dur: [5, 32], slope: [0.02, 0.2] },
    dry: { pbr: [1.0, 2.1], r12: [14, 110], r13: [45, 480], wh: [0.8, 15], bh: [16, 250], ch: [0.08, 1.1], dur: [1, 30], slope: [0.003, 0.1] }
  };
  var MKEYS = CLS.map(function (c) { return c.key; });

  function genRaw(k) {
    var s = SPEC[k];
    return {
      pbr: mlogu(s.pbr[0], s.pbr[1]), r12: mlogu(s.r12[0], s.r12[1]),
      r13: mlogu(s.r13[0], s.r13[1]), wh: mlogu(s.wh[0], s.wh[1]),
      bh: mlogu(s.bh[0], s.bh[1]), ch: mlogu(s.ch[0], s.ch[1]),
      dur: mlogu(s.dur[0], s.dur[1]), slope: mlogu(s.slope[0], s.slope[1])
    };
  }
  function blendRaw(a, b) {
    var A = genRaw(a), B = genRaw(b), f = 0.35 + MR() * 0.3, o = {};
    for (var k in A) o[k] = Math.exp(Math.log(A[k]) * (1 - f) + Math.log(B[k]) * f);
    return o;
  }
  function featVec(raw) {
    return [
      Math.log10(Math.max(1.001, raw.pbr)),
      Math.log10(Math.max(1.001, raw.r12)),
      Math.log10(Math.max(1.001, raw.r13)),
      Math.log10(1 + raw.wh),
      Math.log10(1 + raw.bh),
      Math.log10(1 + raw.ch),
      Math.log10(1 + raw.dur),
      Math.log10(1 + raw.slope * 100)
    ];
  }
  function softmax(z) {
    var mx = Math.max.apply(null, z);
    var ex = z.map(function (v) { return Math.exp(v - mx); });
    var s = ex.reduce(function (a, b) { return a + b; }, 0);
    return ex.map(function (v) { return v / s; });
  }

  var MODEL = (function () {
    /* 18 口井 × 每类 10 窗口；按井分层：8 训练 / 1 校准 / 1 测试 */
    var data = [], w, ci, j;
    for (w = 0; w < 18; w++) {
      for (ci = 0; ci < NCLS; ci++) {
        for (j = 0; j < 10; j++) {
          var raw, u = MR();
          if (u < 0.07) raw = blendRaw(MKEYS[ci], MKEYS[(ci + 1) % 4]);
          else if (u < 0.13) raw = blendRaw(MKEYS[ci], MKEYS[(ci + 2) % 4]);
          else raw = genRaw(MKEYS[ci]);
          /* 井间差异：同一类在不同井上的比值与幅度有系统偏移 */
          var wf = 0.85 + MR() * 0.30;
          raw.r12 *= wf;
          raw.r13 *= wf * (0.9 + MR() * 0.2);
          raw.pbr *= 0.9 + MR() * 0.2;
          data.push({ x: featVec(raw), y: ci, well: w, idx: j });
        }
      }
    }
    var train = [], cal = [], test = [];
    data.forEach(function (r) {
      if (r.idx < 8) train.push(r);
      else if (r.idx === 8) cal.push(r);
      else test.push(r);
    });

    var mu = [], sd = [], n = train.length, k2;
    for (j = 0; j < DIM; j++) {
      var s = 0, nn;
      for (nn = 0; nn < n; nn++) s += train[nn].x[j];
      mu[j] = s / n;
      var v = 0;
      for (nn = 0; nn < n; nn++) v += Math.pow(train[nn].x[j] - mu[j], 2);
      sd[j] = Math.sqrt(v / n) || 1;
    }
    function std(x) { return x.map(function (v, jj) { return (v - mu[jj]) / sd[jj]; }); }
    train.forEach(function (r) { r.x = std(r.x); });
    cal.forEach(function (r) { r.x = std(r.x); });
    test.forEach(function (r) { r.x = std(r.x); });

    var W = [], b = [], vW = [], vB = [], k;
    for (k = 0; k < NCLS; k++) {
      W.push(new Array(DIM).fill(0)); vW.push(new Array(DIM).fill(0));
      b.push(0); vB.push(0);
    }
    function logits(x) {
      return W.map(function (wk, kk) {
        var ss = b[kk];
        for (var jj = 0; jj < DIM; jj++) ss += wk[jj] * x[jj];
        return ss;
      });
    }
    function nll(rows, T) {
      var L = 0;
      rows.forEach(function (r) {
        var z = logits(r.x).map(function (v) { return v / T; });
        var p = softmax(z);
        L += -Math.log(Math.max(1e-9, p[r.y]));
      });
      return L / rows.length;
    }

    var LS = 0.012, LR = 0.05, L2 = 0.0006, EPOCHS = 420, HIST = [];
    for (var ep = 0; ep < EPOCHS; ep++) {
      var gW = [], gB = [], lost = 0;
      for (k = 0; k < NCLS; k++) { gW.push(new Array(DIM).fill(0)); gB.push(0); }
      train.forEach(function (r) {
        var z = logits(r.x), p = softmax(z);
        lost += -Math.log(Math.max(1e-9, p[r.y]));
        for (var kk = 0; kk < NCLS; kk++) {
          var target = kk === r.y ? 1 - LS : LS / (NCLS - 1);
          var d = p[kk] - target;
          gB[kk] += d;
          for (var jj = 0; jj < DIM; jj++) gW[kk][jj] += d * r.x[jj];
        }
      });
      for (k = 0; k < NCLS; k++) {
        vB[k] = 0.9 * vB[k] - LR * gB[k] / train.length;
        b[k] += vB[k];
        for (j = 0; j < DIM; j++) {
          vW[k][j] = 0.9 * vW[k][j] - LR * (gW[k][j] / train.length + L2 * W[k][j]);
          W[k][j] += vW[k][j];
        }
      }
      if (ep % 10 === 0 || ep === EPOCHS - 1) {
        HIST.push({ ep: ep, train: lost / train.length, val: nll(cal, 1) });
      }
    }

    /* 温度缩放：在校准集上网格搜索 T，最小化 NLL */
    var bestT = 1, bestN = 1e9, ti, T;
    for (ti = 0; ti <= 50; ti++) {
      T = 0.5 + ti * 0.05;
      var vv = nll(cal, T);
      if (vv < bestN) { bestN = vv; bestT = T; }
    }

    var conf = [], correct = 0, review = 0, confSum = 0, nllSum = 0, kk2;
    for (kk2 = 0; kk2 < NCLS; kk2++) conf.push(new Array(NCLS).fill(0));
    test.forEach(function (r) {
      var p = softmax(logits(r.x).map(function (v) { return v / bestT; }));
      var top = p.indexOf(Math.max.apply(null, p));
      conf[r.y][top]++;
      if (top === r.y) correct++;
      if (p[top] < 0.72) review++;
      confSum += p[top];
      nllSum += -Math.log(Math.max(1e-9, p[r.y]));
    });
    var f1s = [];
    for (k = 0; k < NCLS; k++) {
      var tp = conf[k][k], fp = 0, fn = 0, i2;
      for (i2 = 0; i2 < NCLS; i2++) if (i2 !== k) { fp += conf[i2][k]; fn += conf[k][i2]; }
      var pr = tp / Math.max(1, tp + fp), rc = tp / Math.max(1, tp + fn);
      f1s.push(2 * pr * rc / Math.max(1e-9, pr + rc));
    }
    var macroF1 = f1s.reduce(function (a, b2) { return a + b2; }, 0) / NCLS;
    var ok = isFinite(bestN) && isFinite(macroF1);
    return {
      ok: ok, W: W, b: b, mu: mu, sd: sd, hist: HIST, T: bestT,
      conf: conf, acc: correct / test.length, macroF1: macroF1,
      reviewRate: review / test.length, meanConf: confSum / test.length,
      nll: nllSum / test.length, nTrain: train.length, nCal: cal.length, nTest: test.length
    };
  })();

  function predictModel(raw) {
    var f = featVec(raw), j;
    var x = f.map(function (v, jj) { return (v - MODEL.mu[jj]) / MODEL.sd[jj]; });
    var z = MODEL.W.map(function (wk, k) {
      var s = MODEL.b[k];
      for (j = 0; j < DIM; j++) s += wk[j] * x[j];
      return s;
    });
    var p = softmax(z.map(function (v) { return v / MODEL.T; }));
    var order = CLS.map(function (c, i) { return { key: c.key, name: c.name, p: p[i], i: i }; });
    order.sort(function (a, b) { return b.p - a.p; });
    return { p: p, order: order, x: x, f: f, z: z };
  }

  /* ---------------- 3. Pixler 图版（简化分区，教学用） ---------------- */
  var PX = { xmin: 1.5, xmax: 300, ymin: 1.5, ymax: 1000 };
  var L = 42, R = 326, T = 18, B = 250;
  var lx0 = Math.log10(PX.xmin), lx1 = Math.log10(PX.xmax);
  var ly0 = Math.log10(PX.ymin), ly1 = Math.log10(PX.ymax);
  function lxPix(l) { return L + (l - lx0) / (lx1 - lx0) * (R - L); }
  function lyPix(l) { return B - (l - ly0) / (ly1 - ly0) * (B - T); }
  function xPix(v) { return lxPix(Math.log10(clamp(v, PX.xmin, PX.xmax))); }
  function yPix(v) { return lyPix(Math.log10(clamp(v, PX.ymin, PX.ymax))); }
  var PXB = { oilY: 1.20, oilX: 1.05, wetX: 1.85, gasTop: 2.35, gasX: 1.45, oilTop: 2.00 };
  function classifyRatio(r12, r13) {
    var x = Math.log10(Math.max(1e-6, r12)), y = Math.log10(Math.max(1e-6, r13));
    if (x < lx0 || x > lx1 || y < ly0 || y > ly1) return 'none';
    if (x >= PXB.wetX || (x >= PXB.gasX && y >= PXB.gasTop)) return 'water';
    if (y <= PXB.oilY || (x <= PXB.oilX && y <= PXB.oilTop)) return 'oil';
    return 'gas';
  }
  function pixlerClass(sg) {
    if (sg.peak < 0.45) return 'dry';
    if (sg.peak < 0.85 && sg.ratio12 > 18 && sg.ratio12 < 60 && sg.ratio13 > 80 && sg.ratio13 < 320) return 'dry';
    return classifyRatio(sg.ratio12, sg.ratio13);
  }
  function pixName(k) {
    if (k === 'dry') return '干层（低幅）';
    if (k === 'none') return '图版外';
    if (k === 'gas') return '气区';
    if (k === 'oil') return '油区';
    if (k === 'water') return '水区';
    return '—';
  }

  /* ---------------- 4. 基线校正 + 分段 + 段特征 ---------------- */
  function baselineOf(arr, win, q, method) {
    var out = [], hw = Math.floor(win / 2), i, k;
    for (i = 0; i < arr.length; i++) {
      if (method === 'none') { out.push(0); continue; }
      var lo = Math.max(0, i - hw), hi = Math.min(arr.length - 1, i + hw);
      if (method === 'mean') {
        var s = 0;
        for (k = lo; k <= hi; k++) s += arr[k];
        out.push(s / (hi - lo + 1));
      } else out.push(quant(arr.slice(lo, hi + 1), q));
    }
    return out;
  }

  function computeSeg(s, e, corr, base, ref, bf, comp, opt) {
    var peak = 0, ip = s, i, j;
    for (i = s; i <= e; i++) if (corr[i] > peak) { peak = corr[i]; ip = i; }
    var sum = [0, 0, 0, 0, 0], V = [];
    for (i = s; i <= e; i++) {
      var w = corr[i];
      if (w <= 0) continue;
      var cc = [];
      for (j = 0; j < 5; j++) cc.push(Math.max(0, comp[j][i] - bf[j] * base[i]));
      for (j = 0; j < 5; j++) sum[j] += w * cc[j];
      if (corr[i] >= 0.5 * peak && cc[1] > 0.002 && cc[2] > 0.0004) {
        V.push({ w: w, a: cc[0] / cc[1], b: cc[0] / cc[2] });
      }
    }
    var c1 = Math.max(1e-6, sum[0]), c2 = Math.max(1e-9, sum[1]);
    var c3 = Math.max(1e-9, sum[2]), c4 = Math.max(1e-9, sum[3]), c5 = Math.max(1e-9, sum[4]);
    var ratio12 = wmed(V, 'a') || Math.max(1.5, c1 / c2);
    var ratio13 = wmed(V, 'b') || Math.max(1.5, c1 / c3);
    var baseRef = opt.method === 'none' ? ref : base;
    var pbr = (baseRef[ip] + peak) / Math.max(0.05, baseRef[ip]);
    var n = e - s + 1;
    var raw = {
      pbr: pbr, r12: ratio12, r13: ratio13,
      wh: 100 * (c2 + c3 + c4 + c5) / c1,
      bh: (c1 + c2) / (c3 + c4 + c5),
      ch: (c4 + c5) / c3,
      dur: n,
      slope: peak / Math.max(1, ip - s + 1)
    };
    return {
      s: s, e: e, n: n, d0: D0 + s * DZ, d1: D0 + (e + 1) * DZ, len: n * DZ,
      peak: peak, peakIdx: ip, ratio12: ratio12, ratio13: ratio13,
      c1: c1, c2: c2, c3: c3, c4: c4, c5: c5,
      wh: raw.wh, bh: raw.bh, ch: raw.ch, pbr: raw.pbr, slope: raw.slope, raw: raw
    };
  }

  function tierOf(sg) {
    var p = sg.p, m = sg.margin, pix = sg.pix, key = sg.clsKey;
    if (key === 'dry' && p >= 0.60 && pix === 'dry') return { key: 'dry', name: '非显示', badge: 'plain', auto: true };
    if (pix === 'none') return { key: 'review', name: '图版外·复核', badge: 'warn', auto: false };
    if (pix !== key) return { key: 'review', name: '证据冲突·复核', badge: 'warn', auto: false };
    if (p >= 0.72 && m >= 0.15) return { key: 'auto', name: '自动解释', badge: 'ok', auto: true };
    if (p >= 0.45) return { key: 'review', name: '人工复核', badge: 'warn', auto: false };
    return { key: 'expert', name: '转专家', badge: 'bad', auto: false };
  }

  function classifySeg(sg) {
    var clf = predictModel(sg.raw);
    sg.clf = clf;
    sg.clsIdx = clf.order[0].i;
    sg.clsKey = CLS[sg.clsIdx].key;
    sg.p = clf.order[0].p;
    sg.second = clf.order[1];
    sg.margin = clf.order[0].p - clf.order[1].p;
    sg.pix = pixlerClass(sg);
    sg.tier = tierOf(sg);
    return sg;
  }

  function analyze(WD, opt) {
    var base = baselineOf(WD.total, opt.win, opt.q, opt.method);
    var ref = baselineOf(WD.total, 40, 0.20, 'quantile');
    var corr = WD.total.map(function (v, i) { return Math.max(0, v - base[i]); });

    /* 噪声用高通残差估计，与基线窗口/分位数解耦，换参数后阈值仍可比 */
    var hp = [], ih;
    for (ih = 0; ih < NZ; ih++) {
      var win = WD.total.slice(Math.max(0, ih - 2), Math.min(NZ, ih + 3));
      hp.push(WD.total[ih] - quant(win, 0.5));
    }
    var sd = Math.max(0.05, mad(hp));
    var thr = Math.max(0.10, opt.k * sd);

    /* 背景气组成从数据里估：全烃最低 30% 点的组分/全烃比值中位数 */
    var idx = WD.total.map(function (v, i) { return i; }).sort(function (a, b) { return WD.total[a] - WD.total[b]; });
    var lowN = Math.max(8, Math.round(NZ * 0.3));
    var bf = [0, 1, 2, 3, 4].map(function (j) {
      var a = idx.slice(0, lowN).map(function (i) { return WD.comp[j][i] / Math.max(1e-6, WD.total[i]); }).sort(function (x, y) { return x - y; });
      return a[Math.floor(a.length / 2)];
    });

    /* 峰高判据 → 连续段 */
    var runs = [], i = 0;
    while (i < NZ) {
      if (corr[i] > thr) {
        var s = i, peak = 0;
        while (i < NZ && corr[i] > thr) { if (corr[i] > peak) peak = corr[i]; i++; }
        runs.push({ s: s, e: i - 1, peak: peak, n: i - s });
      } else i++;
    }
    /* 持续长度判据 + 合并间隔 ≤1 点的邻近段 */
    var cands = [];
    runs.filter(function (r) { return r.n >= opt.minLen; }).forEach(function (r) {
      var last = cands[cands.length - 1];
      if (last && r.s - last.e - 1 <= 1) { last.e = r.e; }
      else cands.push({ s: r.s, e: r.e, members: 1 });
      if (last && r.s - last.e - 1 <= 1) last.members++;
    });
    cands = cands.map(function (c) {
      return classifySeg(computeSeg(c.s, c.e, corr, base, ref, bf, WD.comp, opt));
    });

    /* 段聚合：相邻候选段若模型判为同一类且间隔 ≤2 点，合成一个显示段 */
    var groups = [];
    cands.forEach(function (sg) {
      var last = groups[groups.length - 1];
      if (last && sg.s - last.e - 1 <= 2 && sg.clsIdx === last.clsIdx) {
        last.e = sg.e; last.members++;
      } else {
        groups.push({ s: sg.s, e: sg.e, clsIdx: sg.clsIdx, members: 1 });
      }
    });
    var segs = groups.map(function (g) {
      var sg = computeSeg(g.s, g.e, corr, base, ref, bf, WD.comp, opt);
      sg.members = g.members;
      return classifySeg(sg);
    });

    return {
      base: base, ref: ref, corr: corr, hp: hp, sd: sd, thr: thr, bf: bf,
      runs: runs, cands: cands, segs: segs
    };
  }

  /* ---------------- 5. 与合成真值对照（用于页面说明） ---------------- */
  function score(segs) {
    var matched = 0, conclOk = 0, missed = [];
    LAYERS.forEach(function (z) {
      var best = null, bestOv = 0;
      segs.forEach(function (s) {
        var ov = Math.max(0, Math.min(s.d1, z.d1) - Math.max(s.d0, z.d0));
        if (ov > bestOv) { bestOv = ov; best = s; }
      });
      var ok = best && bestOv >= 0.3 * (z.d1 - z.d0) && best.len <= 2.5 * (z.d1 - z.d0);
      if (ok) {
        matched++;
        if (best.clsKey === (z.key === 'thin' ? 'oil' : z.key)) conclOk++;
      } else missed.push(z);
    });
    var fp = segs.filter(function (s) {
      if (s.clsKey === 'dry') return false;
      return !LAYERS.some(function (z) {
        var ov = Math.max(0, Math.min(s.d1, z.d1) - Math.max(s.d0, z.d0));
        return ov >= 0.3 * (z.d1 - z.d0) && s.len <= 2.5 * (z.d1 - z.d0);
      });
    });
    return { matched: matched, conclOk: conclOk, missed: missed, fp: fp, total: LAYERS.length };
  }

  /* ---------------- 6. 状态与控件 ---------------- */
  var state = {
    mode: 'normal', method: 'quantile', k: 3, minLen: 3, win: 40, q: 0.20,
    spikes: true, comp: true, sel: 0, cursor: 3400, stage: 0
  };
  var WD = null, A = null, SEGS = [], SC = null, LAST = null;
  var fb = { ok: 0, bad: 0 };

  el('seg-mode').innerHTML = MODES.map(function (m) {
    return '<button type="button" data-m="' + m.key + '" class="' + (m.key === state.mode ? 'on' : '') + '">' + m.name + '</button>';
  }).join('');
  el('seg-base').innerHTML = BASEM.map(function (m) {
    return '<button type="button" data-m="' + m.key + '" class="' + (m.key === state.method ? 'on' : '') + '">' + m.name + '</button>';
  }).join('');

  function cancelRun() {
    runTimers.forEach(function (t) { clearTimeout(t); });
    runTimers = [];
    var btn = el('btn-run');
    if (btn) { btn.disabled = false; btn.innerHTML = '▶ 运行全流程'; }
  }

  el('seg-mode').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    cancelRun();
    state.mode = b.getAttribute('data-m');
    [].forEach.call(el('seg-mode').children, function (x) { x.classList.toggle('on', x === b); });
    render();
    trace('工况', '切换为 <b>' + modeOf(state.mode).name + '</b> · 脱气效率 ' + Math.round(modeOf(state.mode).gain * 100) + '% · 迟到时间 ' + modeOf(state.mode).lag + ' min');
  });
  el('seg-base').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    cancelRun();
    state.method = b.getAttribute('data-m');
    [].forEach.call(el('seg-base').children, function (x) { x.classList.toggle('on', x === b); });
    render();
    trace('基线', '方法切到 <b>' + baseName(state.method) + '</b> · 02 校正结果与 04 概率同步重算', 'warn');
  });

  var rK = el('r-k'), rLen = el('r-len'), rWin = el('r-win'), rQ = el('r-q');
  rK.addEventListener('input', function () { cancelRun(); state.k = Number(rK.value); el('o-k').textContent = state.k.toFixed(1) + ' σ'; render(); });
  rLen.addEventListener('input', function () { cancelRun(); state.minLen = Number(rLen.value); el('o-len').textContent = state.minLen + ' 点'; render(); });
  rWin.addEventListener('input', function () { cancelRun(); state.win = Number(rWin.value); el('o-win').textContent = state.win + ' 点'; render(); });
  rQ.addEventListener('input', function () { cancelRun(); state.q = Number(rQ.value) / 100; el('o-q').textContent = rQ.value + '%'; render(); });
  rK.addEventListener('change', function () { trace('参数', '峰高阈值 k = <b>' + state.k.toFixed(1) + 'σ</b> · 检出段与四类概率已重算'); });
  rLen.addEventListener('change', function () { trace('参数', '最小持续 = <b>' + state.minLen + ' 点</b> · 窄尖峰剔除与分段已重算'); });
  rWin.addEventListener('change', function () { trace('参数', '基线窗口 = <b>' + state.win + ' 点</b> · 02 基线已更新'); });
  rQ.addEventListener('change', function () { trace('参数', '分位数 q = <b>' + Math.round(state.q * 100) + '%</b> · 基线水平已更新'); });

  var togSpk = el('tog-spk');
  togSpk.setAttribute('role', 'switch');
  togSpk.setAttribute('aria-checked', togSpk.classList.contains('on') ? 'true' : 'false');
  togSpk.setAttribute('tabindex', '0');
  function flip(t) {
    var on = t.classList.toggle('on');
    t.setAttribute('aria-checked', on ? 'true' : 'false');
    return on;
  }
  togSpk.addEventListener('click', function () { cancelRun(); state.spikes = flip(togSpk); render(); trace('输入', state.spikes ? '叠加接单根窄峰（周期约 14 点）' : '移除接单根窄峰，看长度判据少筛掉多少'); });
  togSpk.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togSpk.click(); } });

  function syncCtrl() {
    rQ.disabled = state.method !== 'quantile';
    rWin.disabled = state.method === 'none';
    rQ.style.opacity = state.method !== 'quantile' ? '.4' : '';
    rWin.style.opacity = state.method === 'none' ? '.4' : '';
  }

  el('btn-reset').addEventListener('click', function () {
    cancelRun();
    state.mode = 'normal'; state.method = 'quantile'; state.k = 3; state.minLen = 3;
    state.win = 40; state.q = 0.20; state.spikes = true; state.sel = 0;
    rK.value = '3'; el('o-k').textContent = '3.0 σ';
    rLen.value = '3'; el('o-len').textContent = '3 点';
    rWin.value = '40'; el('o-win').textContent = '40 点';
    rQ.value = '20'; el('o-q').textContent = '20%';
    togSpk.classList.add('on');
    togSpk.setAttribute('aria-checked', 'true');
    [].forEach.call(el('seg-mode').children, function (x) { x.classList.toggle('on', x.getAttribute('data-m') === 'normal'); });
    [].forEach.call(el('seg-base').children, function (x) { x.classList.toggle('on', x.getAttribute('data-m') === 'quantile'); });
    fb = { ok: 0, bad: 0 };
    setStage(0);
    clearTrace();
    render();
    trace('系统', '参数已重置 · 基线 滑动分位数 40 点 · k = 3.0σ · 最小持续 3 点');
  });

  /* ---------------- 7. 绘制：主曲线 ---------------- */
  var cv = el('log'), ctx = cv.getContext('2d');
  var DPR = Math.min(2, window.devicePixelRatio || 1), Hc = 380;
  var G = {};

  function layoutLog(maxT) {
    var W = cv.clientWidth || 640;
    cv.width = Math.round(W * DPR); cv.height = Math.round(Hc * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    G.L = 48; G.R = 10; G.T = 18; G.B = 30; G.W = W; G.maxT = maxT;
    var gap = 10, usable = W - G.L - G.R - 2 * gap;
    G.w1 = usable * 0.50; G.w2 = usable * 0.29; G.w3 = usable * 0.21;
    G.x1 = G.L; G.x2 = G.L + G.w1 + gap; G.x3 = G.x2 + G.w2 + gap;
    G.plotH = Hc - G.T - G.B;
    G.lg0 = Math.log10(0.003); G.lg1 = Math.log10(8);
    G.sy = function (d) { return G.T + (d - D0) / DEPTH * G.plotH; };
    G.dy = function (y) { return D0 + (y - G.T) / G.plotH * DEPTH; };
    G.sx1 = function (v) { return G.x1 + clamp(v / G.maxT, 0, 1) * G.w1; };
    G.sx2 = function (v) {
      var l = Math.log10(Math.max(0.003, v));
      return G.x2 + clamp((l - G.lg0) / (G.lg1 - G.lg0), 0, 1) * G.w2;
    };
    G.sx3 = function (v) { return G.x3 + clamp((v - 2.5) / 8.5, 0, 1) * G.w3; };
  }

  function drawLog(D, A, segs, sc) {
    var maxT = Math.max.apply(null, D.total) * 1.06;
    layoutLog(maxT);
    ctx.clearRect(0, 0, G.W, Hc);
    ctx.fillStyle = '#fff';
    ctx.fillRect(G.L, G.T, G.W - G.L - G.R, G.plotH);

    /* 轨道标题 */
    ctx.font = '9px ui-monospace, monospace';
    ctx.fillStyle = '#99a3a4';
    ctx.textAlign = 'left';
    ctx.fillText('全烃 %', G.x1 + 2, G.T - 5);
    ctx.fillText('C1—C5 %（对数）', G.x2 + 2, G.T - 5);
    ctx.fillText('钻时 min/m', G.x3 + 2, G.T - 5);

    /* 网格 */
    ctx.strokeStyle = '#f0ede4';
    ctx.lineWidth = 1;
    [0.01, 0.1, 1].forEach(function (v) {
      var x = G.sx2(v);
      ctx.beginPath(); ctx.moveTo(x, G.T); ctx.lineTo(x, G.T + G.plotH); ctx.stroke();
      ctx.fillStyle = '#cdd8e2';
      ctx.textAlign = 'center';
      ctx.font = '8.5px ui-monospace, monospace';
      ctx.fillText(String(v), x, Hc - G.B + 12);
    });
    [5, 8, 11].forEach(function (v) {
      var x = G.sx3(v);
      ctx.strokeStyle = '#efe9dd';
      ctx.beginPath(); ctx.moveTo(x, G.T); ctx.lineTo(x, G.T + G.plotH); ctx.stroke();
      ctx.fillStyle = '#cdd8e2';
      ctx.textAlign = 'center';
      ctx.font = '8.5px ui-monospace, monospace';
      ctx.fillText(String(v), x, Hc - G.B + 12);
    });
    ctx.textAlign = 'center';
    for (var v2 = 0; v2 <= Math.floor(maxT); v2 += 1) {
      var x1 = G.sx1(v2);
      ctx.fillStyle = '#cdd8e2';
      ctx.fillText(String(v2), x1, Hc - G.B + 12);
      if (v2 > 0) {
        ctx.strokeStyle = '#f7f5ef';
        ctx.beginPath(); ctx.moveTo(x1, G.T); ctx.lineTo(x1, G.T + G.plotH); ctx.stroke();
      }
    }
    ctx.textAlign = 'right';
    for (var d = D0; d <= D0 + DEPTH; d += 200) {
      var y = G.sy(d);
      ctx.strokeStyle = '#efece3';
      ctx.beginPath(); ctx.moveTo(G.L, y); ctx.lineTo(G.W - G.R, y); ctx.stroke();
      ctx.fillStyle = '#6f7a7c';
      ctx.font = '9px ui-monospace, monospace';
      ctx.fillText(d + '', G.L - 5, y + 3);
    }
    ctx.fillStyle = '#99a3a4';
    ctx.font = '8.5px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText('深度 m', 4, G.T - 5);

    /* 检出段底纹：颜色 = 模型四类判定 */
    segs.forEach(function (sg, k) {
      var cn = CLS[sg.clsIdx];
      var y0 = G.sy(sg.d0), y1 = G.sy(sg.d1), hh = Math.max(3, y1 - y0);
      ctx.fillStyle = cn.fill;
      ctx.fillRect(G.L, y0, G.W - G.L - G.R, hh);
      ctx.strokeStyle = cn.color;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(G.L, y0); ctx.lineTo(G.W - G.R, y0);
      ctx.moveTo(G.L, y1); ctx.lineTo(G.W - G.R, y1);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = '9px ui-monospace, monospace';
      ctx.textAlign = 'left';
      var ly = y0 - 3 > G.T + 8 ? y0 - 3 : y0 + 10;
      var ltxt = '#' + (k + 1) + ' ' + cn.name + ' ' + sg.d0.toFixed(0) + '—' + sg.d1.toFixed(0) + ' m · ' + pctS(sg.p);
      var labelX = G.L + (k % 2 ? 3 : 132);
      ctx.fillStyle = 'rgba(255,255,255,.86)';
      ctx.fillRect(labelX + 1, ly - 9, ctx.measureText(ltxt).width + 7, 12);
      ctx.fillStyle = cn.color;
      ctx.fillText(ltxt, labelX + 3, ly);

      /* 05 决策：需要人工/专家的段加红框 */
      if (state.stage === 4 && (sg.tier.key === 'review' || sg.tier.key === 'expert')) {
        ctx.strokeStyle = 'rgba(166,75,60,.85)';
        ctx.setLineDash([3, 2]);
        ctx.lineWidth = 1.2;
        ctx.strokeRect(G.L + 1.5, y0 + 0.5, G.W - G.L - G.R - 3, Math.max(3, hh - 1));
        ctx.setLineDash([]);
        ctx.lineWidth = 1;
        ctx.fillStyle = '#a64b3c';
        ctx.font = '8.5px ui-monospace, monospace';
        ctx.textAlign = 'right';
        ctx.fillText(sg.tier.name, G.W - G.R - 3, ly);
      }
    });

    /* 当前选中段：03 阶段画窗口方括号 */
    if (state.stage === 2 && segs[state.sel]) {
      var ss = segs[state.sel];
      var sy0 = G.sy(ss.d0), sy1 = G.sy(ss.d1);
      ctx.strokeStyle = 'rgba(28,37,41,.65)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(G.L - 5, sy0); ctx.lineTo(G.L + 2, sy0);
      ctx.moveTo(G.L - 5, sy1); ctx.lineTo(G.L + 2, sy1);
      ctx.moveTo(G.L - 3, sy0); ctx.lineTo(G.L - 3, sy1);
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    /* 合成真值层段（未检出的用红框标出） */
    if (sc) sc.missed.forEach(function (z) {
      var y0 = G.sy(z.d0), y1 = G.sy(z.d1);
      ctx.strokeStyle = 'rgba(176,84,74,.75)';
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(G.L, y0); ctx.lineTo(G.W - G.R, y0);
      ctx.moveTo(G.L, y1); ctx.lineTo(G.W - G.R, y1);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 1;
      ctx.fillStyle = '#a64b3c';
      ctx.font = '9px ui-monospace, monospace';
      ctx.textAlign = 'right';
      ctx.fillText('真值 ' + z.name + ' 未检出', G.W - G.R - 3, y0 - 3 > G.T + 8 ? y0 - 3 : y0 + 10);
    });

    /* 组分曲线 */
    var cols = ['#123b3a', '#2b5570', '#7a5a3a', '#6f6636', '#8a6f8f'];
    var nComp = 5;
    for (var c = 0; c < nComp; c++) {
      ctx.strokeStyle = cols[c];
      ctx.lineWidth = c === 0 ? 1.5 : 1;
      ctx.globalAlpha = c === 0 ? 1 : 0.9;
      ctx.beginPath();
      for (var i = 0; i < NZ; i++) {
        var x = G.sx2(D.comp[c][i]), y = G.sy(D0 + i * DZ);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    /* 钻时 */
    ctx.strokeStyle = '#99a3a4';
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    for (var i2 = 0; i2 < NZ; i2++) {
      var xx = G.sx3(D.rop[i2]), yy = G.sy(D0 + i2 * DZ);
      if (i2 === 0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy);
    }
    ctx.stroke();

    /* 背景基线（橙虚线） */
    ctx.strokeStyle = '#a86a1f';
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (var i3 = 0; i3 < NZ; i3++) {
      var bx = G.sx1(A.base[i3]), by = G.sy(D0 + i3 * DZ);
      if (i3 === 0) ctx.moveTo(bx, by); else ctx.lineTo(bx, by);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    /* 实测全烃 */
    ctx.strokeStyle = '#16231f';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (var i4 = 0; i4 < NZ; i4++) {
      var tx = G.sx1(D.total[i4]), ty = G.sy(D0 + i4 * DZ);
      if (i4 === 0) ctx.moveTo(tx, ty); else ctx.lineTo(tx, ty);
    }
    ctx.stroke();

    /* 深度游标 */
    var cy = G.sy(state.cursor);
    ctx.strokeStyle = 'rgba(28,37,41,.45)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(G.L, cy); ctx.lineTo(G.W - G.R, cy); ctx.stroke();
    var j = clamp(Math.round((state.cursor - D0) / DZ), 0, NZ - 1);
    el('hint').textContent = '深度 ' + state.cursor.toFixed(0) + ' m · 全烃 ' + D.total[j].toFixed(2) + '% · C1 ' +
      D.comp[0][j].toFixed(3) + ' · C2 ' + D.comp[1][j].toFixed(3) + ' · C3 ' + D.comp[2][j].toFixed(3) + ' · 钻时 ' + D.rop[j].toFixed(1);
  }

  /* ---------------- 8. 绘制：02 阶段的小型校正前后图 ---------------- */
  function drawMiniCmp(D, A, segs) {
    var svg = el('minicmp');
    if (!svg) return;
    var W = 320, H = 150, t = 17, b = 133;
    var xa = 27, xb = 174, pw = 122, gap = 25;
    var sy = function (d) { return t + (d - D0) / DEPTH * (b - t); };
    var maxRaw = Math.max(0.8, Math.max.apply(null, D.total) * 1.08);
    var maxCorr = Math.max(0.8, Math.max.apply(null, A.corr) * 1.12);
    var axa = function (v) { return xa + clamp(v / maxRaw, 0, 1) * pw; };
    var axb = function (v) { return xb + clamp(v / maxCorr, 0, 1) * pw; };
    var s = '';
    s += '<rect x="' + xa + '" y="' + t + '" width="' + pw + '" height="' + (b - t) + '" fill="#fff" stroke="#e3dccd"/>';
    s += '<rect x="' + xb + '" y="' + t + '" width="' + pw + '" height="' + (b - t) + '" fill="#fff" stroke="#e3dccd"/>';
    s += '<text x="' + xa + '" y="' + (t - 5) + '" font-size="8.5" fill="#99a3a4">实测 + 基线</text>';
    s += '<text x="' + xb + '" y="' + (t - 5) + '" font-size="8.5" fill="#99a3a4">校正后 + 阈值</text>';
    [3000, 3400, 3800, 4200].forEach(function (d) {
      var y = sy(d);
      s += '<line x1="' + xa + '" y1="' + y.toFixed(1) + '" x2="' + (xb + pw) + '" y2="' + y.toFixed(1) + '" stroke="#f0ede4"/>';
      s += '<text x="' + (xa - 4) + '" y="' + (y + 2.5).toFixed(1) + '" font-size="7.5" font-family="monospace" fill="#99a3a4" text-anchor="end">' + d + '</text>';
    });
    segs.forEach(function (sg) {
      var y0 = sy(sg.d0), y1 = sy(sg.d1), hh = Math.max(1.5, y1 - y0);
      s += '<rect x="' + xa + '" y="' + y0.toFixed(1) + '" width="' + pw + '" height="' + hh.toFixed(1) + '" fill="' + CLS[sg.clsIdx].fill + '"/>';
      s += '<rect x="' + xb + '" y="' + y0.toFixed(1) + '" width="' + pw + '" height="' + hh.toFixed(1) + '" fill="' + CLS[sg.clsIdx].fill + '"/>';
    });
    /* 实测 + 基线 */
    s += '<path d="' + D.total.map(function (v, i) { return (i ? 'L' : 'M') + axa(v).toFixed(1) + ' ' + sy(D0 + i * DZ).toFixed(1); }).join('') + '" fill="none" stroke="#99a3a4" stroke-width="1"/>';
    s += '<path d="' + A.base.map(function (v, i) { return (i ? 'L' : 'M') + axa(v).toFixed(1) + ' ' + sy(D0 + i * DZ).toFixed(1); }).join('') + '" fill="none" stroke="#a9742c" stroke-width="1" stroke-dasharray="3 2"/>';
    /* 校正后 + 阈值 */
    var xt = axb(A.thr);
    s += '<line x1="' + xt.toFixed(1) + '" y1="' + t + '" x2="' + xt.toFixed(1) + '" y2="' + b + '" stroke="#a64b3c" stroke-width="1" stroke-dasharray="3 2"/>';
    s += '<path d="' + A.corr.map(function (v, i) { return (i ? 'L' : 'M') + axb(v).toFixed(1) + ' ' + sy(D0 + i * DZ).toFixed(1); }).join('') + '" fill="none" stroke="#1d4e50" stroke-width="1.2"/>';
    s += '<text x="' + (xb + pw) + '" y="' + (b + 10) + '" font-size="7.5" font-family="monospace" fill="#99a3a4" text-anchor="end">阈值 ' + A.thr.toFixed(2) + '%</text>';
    svg.innerHTML = s;
  }

  /* ---------------- 9. 绘制：Pixler 图版 ---------------- */
  function drawPixler(segs) {
    var s = '';
    var bands = [
      { key: 'oil', fill: '#f6ead2', stroke: '#e5d2ae' },
      { key: 'gas', fill: '#e4ece7', stroke: '#c6d8ce' },
      { key: 'water', fill: '#e3eaf0', stroke: '#c9d6e0' }
    ];
    var yTop = ly1 - 0.12, yBot = ly0;
    var verts = {
      oil: [[lx0, yBot], [PXB.wetX, yBot], [PXB.wetX, PXB.oilY], [PXB.oilX, PXB.oilY], [PXB.oilX, PXB.oilTop], [lx0, PXB.oilTop]],
      gas: [[PXB.oilX, PXB.oilY], [PXB.wetX, PXB.oilY], [PXB.wetX, PXB.gasTop], [PXB.gasX, PXB.gasTop], [PXB.gasX, yTop], [PXB.oilX, yTop]],
      water: [[PXB.wetX, yBot], [lx1, yBot], [lx1, yTop], [PXB.gasX, yTop], [PXB.gasX, PXB.gasTop], [PXB.wetX, PXB.gasTop]]
    };
    bands.forEach(function (b) {
      var pts = verts[b.key].map(function (p) { return lxPix(p[0]).toFixed(1) + ',' + lyPix(p[1]).toFixed(1); }).join(' ');
      s += "<polygon points='" + pts + "' fill='" + b.fill + "' stroke='" + b.stroke + "' stroke-width='1'/>";
    });
    var xt = [2, 5, 10, 20, 50, 100, 300], yt = [2, 5, 10, 20, 50, 100, 300, 1000];
    xt.forEach(function (v) {
      var p = xPix(v);
      s += "<line x1='" + p.toFixed(1) + "' y1='" + T + "' x2='" + p.toFixed(1) + "' y2='" + B + "' stroke='#e3dccd' stroke-width='0.7' stroke-dasharray='2 3'/>";
      s += "<text x='" + p.toFixed(1) + "' y='" + (B + 12) + "' font-size='10.5' font-family='monospace' fill='#99a3a4' text-anchor='middle'>" + v + "</text>";
    });
    yt.forEach(function (v) {
      var p = yPix(v);
      s += "<line x1='" + L + "' y1='" + p.toFixed(1) + "' x2='" + R + "' y2='" + p.toFixed(1) + "' stroke='#e3dccd' stroke-width='0.7' stroke-dasharray='2 3'/>";
      s += "<text x='" + (L - 5) + "' y='" + (p + 3).toFixed(1) + "' font-size='10.5' font-family='monospace' fill='#99a3a4' text-anchor='end'>" + v + "</text>";
    });
    s += "<text x='" + lxPix(0.55).toFixed(1) + "' y='" + lyPix(1.55).toFixed(1) + "' font-size='13' font-weight='600' fill='#8a5718' text-anchor='middle'>油区</text>";
    s += "<text x='" + lxPix(0.55).toFixed(1) + "' y='" + (lyPix(1.55) + 13).toFixed(1) + "' font-size='9.3' fill='#8a5718' text-anchor='middle'>湿 · C1/C3 低</text>";
    s += "<text x='" + lxPix(1.25).toFixed(1) + "' y='" + lyPix(2.65).toFixed(1) + "' font-size='13' font-weight='600' fill='#123b3a' text-anchor='middle'>气区</text>";
    s += "<text x='" + lxPix(1.25).toFixed(1) + "' y='" + (lyPix(2.65) + 13).toFixed(1) + "' font-size='9.3' fill='#123b3a' text-anchor='middle'>干 · 两个比值居中</text>";
    s += "<text x='" + lxPix(2.18).toFixed(1) + "' y='" + lyPix(1.55).toFixed(1) + "' font-size='13' font-weight='600' fill='#2b5570' text-anchor='middle'>水区</text>";
    s += "<text x='" + lxPix(2.18).toFixed(1) + "' y='" + (lyPix(1.55) + 13).toFixed(1) + "' font-size='9.3' fill='#2b5570' text-anchor='middle'>C1/C2 高</text>";
    s += "<text x='" + R + "' y='11' font-size='10.5' fill='#6f7a7c' text-anchor='end'>纵轴 C1/C3 ↑（对数）</text>";
    s += "<text x='" + R + "' y='" + (B + 27) + "' font-size='10.5' fill='#6f7a7c' text-anchor='end'>横轴 C1/C2 →（对数）</text>";
    s += "<text x='" + (L + 4) + "' y='" + (B - 18) + "' font-size='9.5' fill='#98a199'>简化 Pixler 分区：两个比值同时参与，仅用于教学</text>";

    segs.forEach(function (sg, k) {
      var cn = CLS[sg.clsIdx];
      var px = xPix(sg.ratio12), py = yPix(sg.ratio13);
      var conflict = sg.pix !== 'none' && sg.pix !== sg.clsKey;
      if (k === state.sel) {
        s += "<circle cx='" + px.toFixed(1) + "' cy='" + py.toFixed(1) + "' r='10' fill='none' stroke='" + cn.color + "' stroke-width='1' stroke-dasharray='3 3'/>";
      }
      if (conflict) {
        s += "<circle cx='" + px.toFixed(1) + "' cy='" + py.toFixed(1) + "' r='" + (k === state.sel ? 8 : 7) + "' fill='none' stroke='#a64b3c' stroke-width='1.4' stroke-dasharray='2 2'/>";
      }
      s += "<circle cx='" + px.toFixed(1) + "' cy='" + py.toFixed(1) + "' r='" + (k === state.sel ? 6 : 4.6) + "' fill='#ffffff' stroke='" + cn.color + "' stroke-width='" + (k === state.sel ? 2.6 : 2) + "'/>";
      s += "<text x='" + (px + 9).toFixed(1) + "' y='" + (py - 5).toFixed(1) + "' font-size='10.5' font-family='monospace' fill='#4a585c'>#" + (k + 1) + "</text>";
    });
    el('pixler').innerHTML = s;
  }

  /* ---------------- 10. 绘制：损失曲线 / 混淆矩阵 / 概率 / 特征贡献 ---------------- */
  function drawCurve() {
    var svg = el('curve');
    if (!svg) return;
    var W = 320, H = 68, Lx = 26, Rx = 8, Tt = 8, Bb = 16;
    var hist = MODEL.hist;
    var lo = Math.min.apply(null, hist.map(function (h) { return Math.min(h.train, h.val); }));
    var hi = Math.max.apply(null, hist.map(function (h) { return Math.max(h.train, h.val); }));
    var pad = (hi - lo) * 0.12 || 0.01;
    lo = Math.max(0, lo - pad); hi += pad;
    function X(i) { return Lx + i * (W - Lx - Rx) / Math.max(1, hist.length - 1); }
    function Y(v) { return Tt + (1 - (v - lo) / (hi - lo)) * (H - Tt - Bb); }
    var s = '';
    [0, 0.5, 1].forEach(function (tt) {
      var v = lo + (hi - lo) * tt, y = Y(v);
      s += '<line x1="' + Lx + '" y1="' + y.toFixed(1) + '" x2="' + (W - Rx) + '" y2="' + y.toFixed(1) + '" stroke="#efece1"/>';
      s += '<text x="' + (Lx - 3) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="end" font-size="7.5" font-family="monospace" fill="#99a3a4">' + v.toFixed(2) + '</text>';
    });
    s += '<path d="' + hist.map(function (h, i) { return (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(h.val).toFixed(1); }).join('') + '" fill="none" stroke="#a9742c" stroke-width="1.2" stroke-dasharray="4 2"/>';
    s += '<path d="' + hist.map(function (h, i) { return (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(h.train).toFixed(1); }).join('') + '" fill="none" stroke="#1d4e50" stroke-width="1.8"/>';
    s += '<text x="' + (W - Rx) + '" y="' + (H - 2) + '" text-anchor="end" font-size="7.5" font-family="monospace" fill="#99a3a4">' + (hist[hist.length - 1].ep) + ' epochs</text>';
    s += '<text x="' + Lx + '" y="' + (H - 2) + '" font-size="7.5" font-family="monospace" fill="#99a3a4">0</text>';
    s += '<text x="' + (W - Rx - 2) + '" y="' + (Tt + 7) + '" text-anchor="end" font-size="7.5" fill="#1d4e50">训练</text>';
    s += '<text x="' + (W - Rx - 30) + '" y="' + (Tt + 7) + '" text-anchor="end" font-size="7.5" fill="#a9742c">校准</text>';
    svg.innerHTML = s;
  }

  function drawCM() {
    var conf = MODEL.conf;
    var s = '<span class="lb" style="font-size:7px">真↓预→</span>' + CLS.map(function (c) {
      return '<span style="text-align:center;color:var(--ink-4);font-size:8px" title="' + c.name + '">' + c.short + '</span>';
    }).join('');
    conf.forEach(function (row, i) {
      var sum = row.reduce(function (a, b) { return a + b; }, 0) || 1;
      s += '<span class="lb" title="' + CLS[i].name + '">' + CLS[i].short + '</span>';
      row.forEach(function (v, j) {
        var q = v / sum;
        var a = q > 0.5 ? 0.14 + q * 0.7 : q * 1.1;
        var txt = q >= 0.05 ? Math.round(q * 100) : '';
        s += '<i style="background:rgba(18,59,58,' + a.toFixed(2) + ');color:' + (q > 0.5 ? '#f3eee3' : '#45524d') + '" title="真实 ' + CLS[i].name + ' / 预测 ' + CLS[j].name + '：' + v + ' 个">' + txt + '</i>';
      });
    });
    el('cm').innerHTML = s;
  }

  function drawProbs(sg) {
    if (!sg) {
      el('probs').innerHTML = '<p class="dfeed-note">当前参数下没有检出异常段，无法输出四类概率。把峰高阈值降到 2σ 左右、或把基线窗口改小再试。</p>';
      return;
    }
    var p = sg.clf.p;
    el('probs').innerHTML = CLS.map(function (c, i) {
      var top = i === sg.clsIdx;
      return '<div class="dbar" style="padding:0.5px 0"><span style="width:40px;font-size:10.5px;color:' + (top ? 'var(--ink)' : 'var(--ink-3)') + '">' + c.name + '</span>' +
        '<span class="track"><i style="width:' + (p[i] * 100).toFixed(1) + '%;background:' + (top ? 'var(--jade)' : 'var(--line-3)') + '"></i></span>' +
        '<span class="val">' + pctS(p[i]) + '</span></div>';
    }).join('');
  }

  function drawWeights(sg) {
    if (!sg) { el('weights').innerHTML = '<p class="dfeed-note">无当前段，无法解释特征贡献。</p>'; return; }
    if (!MODEL.ok) { el('weights').innerHTML = '<p class="dfeed-note">模型训练异常，已停用权重解释。</p>'; return; }
    var c = sg.clsIdx, j, k;
    var meanW = FKEYS.map(function (_, jj) {
      var s = 0;
      for (k = 0; k < NCLS; k++) s += MODEL.W[k][jj];
      return s / NCLS;
    });
    var rows = FKEYS.map(function (key, jj) {
      return { key: key, label: FLABEL[key], v: (MODEL.W[c][jj] - meanW[jj]) * sg.clf.x[jj] };
    });
    rows.sort(function (a, b) { return Math.abs(b.v) - Math.abs(a.v); });
    var max = Math.max.apply(null, rows.map(function (r) { return Math.abs(r.v); })) || 1;
    el('weights').innerHTML = rows.slice(0, 3).map(function (r) {
      var pos = r.v >= 0;
      var w = Math.abs(r.v) / max * 100;
      return '<div class="wrow"><span>' + r.label + '</span><span class="track"><i style="' + (pos ? 'left:0' : 'right:0') + ';width:' + w.toFixed(1) + '%;background:' + (pos ? 'var(--jade)' : 'var(--bad)') + '"></i></span><span class="val">' + (pos ? '+' : '') + r.v.toFixed(2) + '</span></div>';
    }).join('') + '<p class="dfeed-note" style="margin-top:2px">绿 = 推高当前类，红 = 拉低；列绝对值最大的 3 项。</p>';
  }

  /* ---------------- 11. 表格 / 阶段面板 ---------------- */
  function renderTable(segs) {
    var box = el('hits');
    if (!segs.length) {
      box.innerHTML = "<tr><td colspan='4' style='color:var(--ink-4)'>当前参数下没有检出异常段——阈值太高，或基线把显示减掉了。</td></tr>";
      return;
    }
    box.innerHTML = segs.map(function (sg, k) {
      var cn = CLS[sg.clsIdx];
      var conflict = sg.pix !== 'none' && sg.pix !== sg.clsKey;
      return "<tr class='segrow" + (k === state.sel ? ' sel' : '') + "' data-i='" + k + "'>" +
        '<td>' + sg.d0.toFixed(0) + '—' + sg.d1.toFixed(0) +
        "<span class='mono' style='font-size:9px;color:var(--ink-4)'> · " + sg.len.toFixed(0) + ' m</span></td>' +
        "<td class='num'>" + sg.peak.toFixed(2) + '</td>' +
        "<td><span class='db " + cn.badge + "'>" + cn.name + '</span>' +
        " <span class='mono' style='font-size:9px;color:var(--ink-4)'>" + pctS(sg.p) + '</span></td>' +
        '<td>' + (conflict ? "<span class='db bad'>冲突</span>" : pixName(sg.pix)) +
        " <span class='mono' style='font-size:9px;color:var(--ink-4)'>· " + sg.tier.name + '</span></td></tr>';
    }).join('');
    [].forEach.call(box.querySelectorAll('[data-i]'), function (tr) {
      tr.addEventListener('click', function () {
        state.sel = Number(tr.getAttribute('data-i'));
        render();
        var sg = SEGS[state.sel];
        if (sg) trace('选择', '选中 <b>#' + (state.sel + 1) + ' ' + sg.d0.toFixed(0) + '—' + sg.d1.toFixed(0) + ' m</b> · 模型 ' + CLS[sg.clsIdx].name + ' ' + pctS(sg.p));
      });
    });
  }

  function renderStage1() {
    var M = modeOf(state.mode);
    el('q-n').textContent = NZ;
    el('q-lag').textContent = M.lag + ' min · 排量 32 L/s 折算';
    el('q-eff').textContent = Math.round(M.gain * 100) + '%' + (M.gain < 0.7 ? ' · 幅度需归一' : '');
    var q0 = quant(WD.total.slice(0, 40), 0.2), q1 = quant(WD.total.slice(NZ - 40), 0.2);
    el('q-drift').textContent = (q1 - q0).toFixed(2) + ' % / 全井段 · ' + ((q1 - q0) / DEPTH * 100).toFixed(2) + ' %/100m';
    /* 窄尖峰：高通残差 > 4σ 且持续 ≤2 点 */
    var spikes = 0, inRun = false, runLen = 0, i;
    for (i = 0; i < NZ; i++) {
      var hit = A.hp[i] > 4 * A.sd;
      if (hit) { if (!inRun) { inRun = true; runLen = 0; } runLen++; }
      else if (inRun) { if (runLen <= 2) spikes++; inRun = false; runLen = 0; }
    }
    if (inRun && runLen <= 2) spikes++;
    el('q-spike').textContent = spikes + ' 个（长度 ≤2 点）' + (state.spikes ? '' : ' · 当前已关闭');
    var peakCorr = 0;
    for (i = 0; i < NZ; i++) peakCorr = Math.max(peakCorr, WD.total[i] - A.ref[i]);
    el('q-snr').innerHTML = 'σ ' + A.sd.toFixed(2) + '% · 峰值/σ <b>' + (peakCorr / A.sd).toFixed(0) + '</b>';
    var gate = M.gain < 0.7
      ? ['warn', '降级 · 脱气效率 ' + Math.round(M.gain * 100) + '%，幅度归一后使用']
      : A.sd > 0.25 ? ['bad', '退回 · 噪声 σ 偏大'] : ['ok', '可用 · 进入基线校正'];
    el('q-gate').innerHTML = '<span class="db ' + gate[0] + '">' + gate[1] + '</span>';
  }

  function renderStage2() {
    var method = baseName(state.method);
    var param = state.method === 'quantile' ? ' · ' + state.win + ' 点 · ' + Math.round(state.q * 100) + '%'
      : state.method === 'mean' ? ' · ' + state.win + ' 点' : '';
    el('b-method').textContent = method + param;
    if (state.method === 'none') {
      el('b-level').textContent = '0（未减背景）';
    } else {
      var bmin = Math.min.apply(null, A.base), bmax = Math.max.apply(null, A.base);
      el('b-level').textContent = bmin.toFixed(2) + '—' + bmax.toFixed(2) + ' %';
    }
    var c0 = quant(A.corr.slice(0, 48), 0.2), c1 = quant(A.corr.slice(NZ - 48), 0.2);
    el('b-drift').textContent = ((c1 - c0) / DEPTH * 100).toFixed(2) + ' %/100m';
    el('b-thr').innerHTML = 'σ ' + A.sd.toFixed(2) + '% · ' + state.k.toFixed(1) + 'σ = <b>' + A.thr.toFixed(2) + '%</b>';
    el('b-runs').innerHTML = A.runs.length + ' 段 → <b>' + A.cands.length + '</b> 候选段';
    drawMiniCmp(WD, A, SEGS);
  }

  function renderStage3() {
    el('s-n').textContent = '720';
    el('s-split').innerHTML = '576 / 72 / 72';
    el('clsdist').innerHTML = CLS.map(function (c) {
      return '<div class="cbar"><span class="nm">' + c.name + '</span><span class="track"><i style="width:100%;background:' + c.color + ';opacity:.7"></i></span><span class="val">180</span></div>';
    }).join('');
    var sg = SEGS[state.sel];
    if (!sg) {
      el('feats').innerHTML = '<p class="dfeed-note">没有选中段。先调低阈值或换回分位数基线，让曲线检出异常。</p>';
      return;
    }
    var raw = sg.raw;
    var z = sg.clf.x;
    var vals = {
      pbr: raw.pbr.toFixed(1),
      r12: raw.r12.toFixed(1),
      r13: raw.r13.toFixed(1),
      wh: raw.wh.toFixed(1) + '%',
      bh: raw.bh.toFixed(1),
      ch: raw.ch.toFixed(2),
      dur: raw.dur + ' 点',
      slope: raw.slope.toFixed(2) + '%'
    };
    el('feats').innerHTML = FKEYS.map(function (key, j) {
      return '<div class="frow"><span class="n">' + FLABEL[key] + '</span><span class="v">' + vals[key] + '</span><span class="z">' + (z[j] >= 0 ? '+' : '') + z[j].toFixed(1) + '</span></div>';
    }).join('');
  }

  function renderStage4() {
    el('m-n').innerHTML = '<span style="font-size:11px">' + MODEL.nTrain + '/' + MODEL.nCal + '/' + MODEL.nTest + '</span>';
    el('m-acc').textContent = (MODEL.acc * 100).toFixed(1) + '%';
    el('m-f1').textContent = MODEL.macroF1.toFixed(3);
    el('m-temp').textContent = MODEL.T.toFixed(2);
    drawCurve();
    drawCM();
    drawProbs(SEGS[state.sel]);
    drawWeights(SEGS[state.sel]);
    el('calnote').innerHTML = '校准：平均置信度 <b>' + (MODEL.meanConf * 100).toFixed(1) + '%</b> / 准确率 <b>' +
      (MODEL.acc * 100).toFixed(1) + '%</b> · 复核 p &lt; 0.72<br>主要混淆：气→水、干→气 · 显示截断 0.1%—99.9%';
  }

  function renderStage5() {
    var sg = SEGS[state.sel];
    if (!sg) {
      el('d-model').textContent = '—';
      el('d-pix').textContent = '—';
      el('d-agree').textContent = '—';
      el('d-tier').textContent = '—';
      el('advice').innerHTML = '当前参数没有检出段，无法给出解释结论。';
    } else {
      var cn = CLS[sg.clsIdx];
      el('d-model').innerHTML = '<span style="color:' + cn.color + ';font-weight:650">' + cn.name + ' ' + pctS(sg.p) + '</span>';
      el('d-pix').innerHTML = pixName(sg.pix);
      var agree = sg.pix === sg.clsKey;
      el('d-agree').innerHTML = agree ? '<span class="db ok">一致</span>'
        : sg.pix === 'none' ? '<span class="db warn">图版外</span>' : '<span class="db bad">冲突</span>';
      el('d-tier').innerHTML = '<span class="db ' + sg.tier.badge + '">' + sg.tier.name + '</span>';
      var action = sg.tier.key === 'auto'
        ? '一致且过线：写入解释报告，人工只做抽检。'
        : sg.tier.key === 'dry'
          ? '低幅背景，不建产。'
          : sg.tier.key === 'review'
            ? '证据不足或模型/图版冲突：转人工复核，解释员看本段曲线、邻井与试油记录后再定。'
            : '模型拒绝给出高置信度结论：转专家，并把人工结论回写为训练样本。';
      el('advice').innerHTML = '<b>#' + (state.sel + 1) + ' ' + sg.d0.toFixed(0) + '—' + sg.d1.toFixed(0) +
        ' m</b> · 模型 <b>' + cn.name + ' ' + pctS(sg.p) + '</b>（次优 ' + sg.second.name + ' ' +
        pctS(sg.second.p) + '，差距 ' + Math.round(sg.margin * 100) + ' pts）· 图版 <b>' +
        pixName(sg.pix) + '</b>。' + action;
    }
    el('agg').innerHTML = '阈值以上 <b>' + A.runs.length + '</b> 个连续段 → 长度判据后 <b>' + A.cands.length +
      '</b> 个候选段 → 同类相邻段聚合为 <b>' + SEGS.length + '</b> 个显示段。';
    var nAuto = 0, nReview = 0, nExpert = 0, nDry = 0;
    SEGS.forEach(function (s) {
      if (s.tier.key === 'auto') nAuto++;
      else if (s.tier.key === 'review') nReview++;
      else if (s.tier.key === 'expert') nExpert++;
      else nDry++;
    });
    el('tiers').innerHTML =
      '<div class="tierrow"><span class="k">自动解释</span><span><b>' + nAuto + '</b> 段 <span class="db ok">写入报告</span></span></div>' +
      '<div class="tierrow"><span class="k">人工复核</span><span><b>' + nReview + '</b> 段 <span class="db warn">解释员确认</span></span></div>' +
      '<div class="tierrow"><span class="k">转专家</span><span><b>' + nExpert + '</b> 段 <span class="db bad">低置信度</span></span></div>' +
      '<div class="tierrow"><span class="k">非显示（干层）</span><span><b>' + nDry + '</b> 段 <span class="db plain">不建产</span></span></div>';
    el('fb-note').textContent = '回写 ' + (fb.ok + fb.bad) + ' 条' + (fb.bad ? ' · 其中误判 ' + fb.bad + ' 条' : '') + ' · 人工确认后才进入下一轮训练';
  }

  /* ---------------- 12. 过程日志 / 阶段 ---------------- */
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
    el('trace').innerHTML = '<div><span class="t">—</span><span>等待运行：点「▶ 运行全流程」，或直接点上面的 01—05 阶段。</span></div>';
  }

  var STAGE_HINTS = [
    '<b>01 采集</b>：黑色 = 实测全烃，橙虚线 = 估计背景基线；中间轨为 C1—C5，右侧灰轨为钻时。窄尖峰先被长度判据挡在门外。',
    '<b>02 基线</b>：校正值 = 实测 − 滑动分位数基线；底纹为检出段。把右列的方法切成滑动均值或不校正，看基线怎样把显示削平或把背景气带进比值。',
    '<b>03 特征</b>：每个候选段取一个窗口，算 8 维特征；当前选中段用左侧方括号标出。模型只看这些数，不看曲线形状。',
    '<b>04 模型</b>：底纹颜色 = softmax 四类判定，标签里的百分比是该类概率；当前段的四类概率与特征贡献在右列。',
    '<b>05 决策</b>：红虚线框 = 需人工复核或转专家的段；与 Pixler 图版冲突的段即使模型概率高也会被拦下。'
  ];
  var STAGE_LABEL = ['01 采集', '02 基线', '03 特征', '04 模型', '05 决策'];

  function redrawLog() {
    if (LAST) drawLog(WD, A, SEGS, SC);
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
    el('stagehint').innerHTML = STAGE_HINTS[i];
    redrawLog();
  }

  el('flow').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    cancelRun();
    setStage(Number(b.getAttribute('data-s')));
  });

  var runTimers = [];
  function runAll() {
    cancelRun();
    render();
    clearTrace();
    var btn = el('btn-run');
    btn.disabled = true;
    btn.innerHTML = '运行中…';
    var L = LAST;
    var sg = SEGS[state.sel];
    var topName = sg ? CLS[sg.clsIdx].name : '无段';
    var topP = sg ? pctS(sg.p) : '—';
    var steps = [
      ['01', '读取 ' + NZ + ' 点 · 全烃/C1—C5/钻时 · 噪声 σ <b>' + A.sd.toFixed(2) + '%</b> · 窄尖峰 <b>' + L.qc.spikes + '</b> 个'],
      ['02', '基线 <b>' + baseName(state.method) + '</b>' + (state.method === 'quantile' ? '（' + state.win + ' 点 · ' + Math.round(state.q * 100) + '%）' : state.method === 'mean' ? '（' + state.win + ' 点）' : '') + ' · 阈值 <b>' + A.thr.toFixed(2) + '%</b> · 连续段 ' + A.runs.length + ' → 候选 ' + A.cands.length],
      ['03', '窗口特征 8 维 · 当前段 <b>' + (sg ? '#' + (state.sel + 1) : '—') + '</b> · 合成样本 <b>720</b>（18 井 × 40 窗口）'],
      ['04', 'softmax 推理 · <b>' + topName + ' ' + topP + '</b> · 测试准确率 <b>' + (MODEL.acc * 100).toFixed(1) + '%</b> · T = ' + MODEL.T.toFixed(2)],
      ['05', '段聚合 ' + A.runs.length + ' → <b>' + SEGS.length + '</b> 段 · Pixler ' + (sg ? (sg.pix === sg.clsKey ? '一致' : sg.pix === 'none' ? '图版外' : '冲突') : '—') + ' · 处理级别 <b>' + (sg ? sg.tier.name : '—') + '</b> · 回写 ' + (fb.ok + fb.bad)]
    ];
    var delays = [0, 820, 1640, 2460, 3280];
    steps.forEach(function (s, i) {
      runTimers.push(setTimeout(function () {
        setStage(i);
        trace(s[0], s[1]);
        if (i === steps.length - 1) {
          runTimers.push(setTimeout(function () {
            btn.disabled = false;
            btn.innerHTML = '▶ 重新运行';
            trace('✓', '流水线完成：从一段原始曲线到可复核的流体性质结论。', 'ok');
          }, 700));
        }
      }, delays[i]));
    });
  }
  el('btn-run').addEventListener('click', runAll);

  el('feedback').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    var k = b.getAttribute('data-fb');
    fb[k]++;
    var sg = SEGS[state.sel];
    var what = sg ? ('#' + (state.sel + 1) + ' ' + CLS[sg.clsIdx].name) : '当前结论';
    trace('反馈', k === 'ok' ? '人工确认：<b>' + what + ' 解释正确</b> · 样本进入训练集' : '<b>标为误判</b> · ' + what + ' 进入错题集，下一轮重训优先看', k === 'ok' ? 'ok' : 'warn');
    renderStage5();
  });

  /* ---------------- 13. 渲染主流程 ---------------- */
  function renderNote(segs, sc) {
    var hd = '<b>' + modeOf(state.mode).name + '</b> · 基线 <b>' + baseName(state.method) + '</b>' +
      (state.method === 'quantile' ? '（' + state.win + ' 点 · ' + Math.round(state.q * 100) + '%）'
        : state.method === 'mean' ? '（' + state.win + ' 点）' : '') +
      ' · 阈值 <b>' + state.k.toFixed(1) + 'σ ≈ ' + A.thr.toFixed(2) + '%</b> · 最小持续 <b>' + state.minLen + ' 点</b>。';
    var body;
    if (!segs.length) {
      body = '五段流程在这段曲线上 <b>一段异常都没检出来</b>——阈值已经高到把油气显示也一起滤掉了。';
    } else {
      body = '检出 <b>' + segs.length + ' 段</b>：' + segs.map(function (sg, k) {
        return '#' + (k + 1) + ' <b>' + sg.d0.toFixed(0) + '—' + sg.d1.toFixed(0) + ' m</b>（' + CLS[sg.clsIdx].name + ' ' +
          pctS(sg.p) + '，图版 ' + pixName(sg.pix) + '，' + sg.tier.name + '）';
      }).join('；') + '。';
    }
    var truth = '对照合成真值：<b>' + sc.matched + '/' + sc.total + '</b> 命中、<b>' + sc.conclOk + '/' + sc.total + '</b> 结论一致';
    if (sc.missed.length) truth += '；未检出 ' + sc.missed.map(function (z) { return z.name; }).join('、');
    if (sc.fp.length) truth += '；非显示误报 ' + sc.fp.length + ' 段';
    truth += '。';
    var hint;
    if (sc.missed.length) {
      hint = '把阈值降到 2σ 左右或把基线窗口改到 20 点，再看漏检层是否回来。';
    } else if (sc.fp.length) {
      hint = '多出的段多是接单根窄峰或背景气抬升；把最小持续提到 4 点以上会成片消失。';
    } else {
      hint = '再试：基线换滑动均值（窄峰抬高基线）、换不校正（背景气进比值）、或切加重钻井液（弱显示变小）；02 的校正与 04 的概率会同步重算。';
    }
    el('note').innerHTML = hd + ' ' + body + ' ' + truth + ' ' + hint + ' 点结论表切段；曲线悬停读值。';
  }

  function render() {
    syncCtrl();
    WD = synth(state.mode, state.spikes);
    A = analyze(WD, { win: state.win, q: state.q, k: state.k, minLen: state.minLen, method: state.method });
    SEGS = A.segs;
    if (state.sel >= SEGS.length) state.sel = 0;
    SC = score(SEGS);

    drawLog(WD, A, SEGS, SC);
    drawPixler(SEGS);
    renderTable(SEGS);
    renderStage1();
    renderStage2();
    renderStage3();
    renderStage4();
    renderStage5();

    var sel = SEGS[state.sel];
    el('st-verdict').textContent = sel ? CLS[sel.clsIdx].name : '—';
    el('st-conf').innerHTML = sel ? pctS(sel.p) : '—';
    el('st-acc').innerHTML = (MODEL.acc * 100).toFixed(1) + '<small>%</small>';
    var nReview = SEGS.filter(function (s) { return s.tier.key === 'review' || s.tier.key === 'expert'; }).length;
    el('st-review').innerHTML = SEGS.length ? Math.round(nReview / SEGS.length * 100) + '<small>%</small>' : '—';
    el('st-review').title = '需人工复核或转专家的段占比';

    el('m-summary').innerHTML = '测试准确率 <b>' + (MODEL.acc * 100).toFixed(1) + '%</b> · 宏 F1 <b>' +
      MODEL.macroF1.toFixed(3) + '</b> · 低置信度 <b>' + (MODEL.reviewRate * 100).toFixed(1) + '%</b>';
    el('m-badge').textContent = MODEL.ok ? '已训练' : '训练异常';
    el('m-badge').className = 'db ' + (MODEL.ok ? 'ok' : 'bad');

    renderNote(SEGS, SC);
    setStage(state.stage);

    var q0 = quant(WD.total.slice(0, 40), 0.2), q1 = quant(WD.total.slice(NZ - 40), 0.2);
    var spikes = 0, inRun = false, runLen = 0, i;
    for (i = 0; i < NZ; i++) {
      var hit = A.hp[i] > 4 * A.sd;
      if (hit) { if (!inRun) { inRun = true; runLen = 0; } runLen++; }
      else if (inRun) { if (runLen <= 2) spikes++; inRun = false; runLen = 0; }
    }
    if (inRun && runLen <= 2) spikes++;

    LAST = {
      segs: SEGS.map(function (s) {
        return {
          d0: Math.round(s.d0), d1: Math.round(s.d1), peak: Number(s.peak.toFixed(2)),
          model: CLS[s.clsIdx].key, p: Number(s.p.toFixed(3)), margin: Number(s.margin.toFixed(3)),
          pix: s.pix, tier: s.tier.key, r12: Number(s.ratio12.toFixed(1)), r13: Number(s.ratio13.toFixed(1))
        };
      }),
      segCount: SEGS.length, cands: A.cands.length, runs: A.runs.length,
      sd: Number(A.sd.toFixed(3)), thr: Number(A.thr.toFixed(3)),
      matched: SC.matched, conclOk: SC.conclOk, truth: SC.total,
      missed: SC.missed.map(function (z) { return z.name; }).join(','), fp: SC.fp.length,
      mode: state.mode, method: state.method, k: state.k, minLen: state.minLen, win: state.win, q: state.q,
      modelAcc: Number(MODEL.acc.toFixed(4)), modelF1: Number(MODEL.macroF1.toFixed(4)),
      modelT: Number(MODEL.T.toFixed(2)), reviewRate: Number(MODEL.reviewRate.toFixed(4)),
      qc: { lag: modeOf(state.mode).lag, eff: modeOf(state.mode).gain, drift: Number(((q1 - q0) / DEPTH * 100).toFixed(2)), spikes: spikes }
    };
    window.__GASLOG__ = LAST;
  }

  /* 鼠标读深度 */
  cv.addEventListener('mousemove', function (e) {
    var r = cv.getBoundingClientRect();
    var y = e.clientY - r.top;
    if (y < G.T || y > G.T + G.plotH) return;
    state.cursor = clamp(G.dy(y), D0, D0 + DEPTH);
    if (LAST) drawLog(WD, A, SEGS, SC);
  });

  var rt = null;
  window.addEventListener('resize', function () {
    clearTimeout(rt);
    rt = setTimeout(function () { if (LAST) render(); }, 160);
  });

  /* ---------------- 14. 启动 ---------------- */
  clearTrace();
  render();
  setStage(0);
  trace('系统', '模型已在本页训练：' + MODEL.nTrain + ' 训练 / ' + MODEL.nCal + ' 校准 / ' + MODEL.nTest +
    ' 测试 · 准确率 <b>' + (MODEL.acc * 100).toFixed(1) + '%</b> · 宏 F1 <b>' + MODEL.macroF1.toFixed(3) +
    '</b> · T = ' + MODEL.T.toFixed(2), 'ok');
})();
