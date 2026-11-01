/* =========================================================
   案例 · 测井曲线智能分层（AI 作业流示范）
   ---------------------------------------------------------
   一条 1000—1030 m 的合成井走完五段：
     01 曲线采集与质控（GR / SP / RT，采样率、噪声、缺失）
     02 滑窗特征（均值差、方差比、斜率差、相干性、跳变）
     03 边界概率模型（16 井训练 / 4 井按井验证的逻辑回归，
        标签平滑 + 温度缩放，输出每个深度点的边界概率）
     04 动态规划分段（用边界概率做代价，β 惩罚 + 最小层厚 0.5 m）
     05 人工确认与价值（仿真人工卡层对比、确认 / 修正回写）
   纯前端、无依赖；对外暴露 window.WelllogLayerDemo(root, ctx)
   ========================================================= */

(function () {
  'use strict';

  /* ---------- 常量 ---------- */
  var N = 240;            // 30 m / 0.125 m
  var STEP = 0.125;       // m / 点
  var TOP = 1000;         // 井段顶深 m
  var MINSEG = 6;         // 最小层厚 0.75 m = 6 点
  var TOL = 4;            // 界面匹配容差 ±0.5 m
  var WIN = 5;            // 滑窗半宽 5 点 = 0.625 m
  var GRMAX = 150;        // GR 轴上限，API
  var TRAIN_WELLS = 16;   // 合成训练井数
  var VAL_WELLS = 4;      // 按井留出的验证井数
  var CORPUS = TRAIN_WELLS + VAL_WELLS;

  var C = {
    curve: '#2f3a3f',
    grid: '#eeeae0',
    gridSoft: '#f4f1e9',
    text: '#79828a',
    textDim: '#9ba3a9',
    truth: '#3f6b6a',
    det: '#a9742c',
    ai: '#1d4e50',
    manual: '#b26a39',
    prob: '#5a6b78',
    thin: '#f0e0c8',
    miss: '#b05a51'
  };

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

  var FEATS = [
    { key: 'md', name: '均值差 Δμ/σ', short: '均值差' },
    { key: 'vr', name: '方差比 |log|', short: '方差比' },
    { key: 'sl', name: '斜率差 Δk/σ', short: '斜率差' },
    { key: 'co', name: '相干性 1−|r|', short: '相干性' },
    { key: 'jp', name: '跳变 |Δx|/σ', short: '跳变' }
  ];

  /* ---------- 随机数 ---------- */
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function probClamp(p) { return clamp(p, 0.005, 0.995); }
  function pText(p) { return (probClamp(p) * 100).toFixed(1) + '%'; }
  function pNum(p) { return probClamp(p).toFixed(2); }
  function meanOf(arr, a, b) {
    var s = 0;
    for (var i = a; i < b; i++) s += arr[i];
    return s / Math.max(1, b - a);
  }

  /* =========================================================
     合成井：GR / SP / RT 三曲线 + 真实层界面
     ========================================================= */
  function makeWell(seed, nLayers, noise, withMissing) {
    var rnd = mulberry32(seed);
    function gauss() {
      var u = 0, v = 0;
      while (u === 0) u = rnd();
      while (v === 0) v = rnd();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }

    /* 层厚：每层至少 1 m（8 点），再按权重分配余量 */
    var th = new Array(nLayers);
    for (var i = 0; i < nLayers; i++) th[i] = 8;
    var remaining = N - 8 * nLayers;
    var w = [];
    for (i = 0; i < nLayers; i++) w.push(0.7 + rnd() * 1.8);
    var wsum = w.reduce(function (a, b) { return a + b; }, 0);
    for (i = 0; i < nLayers; i++) {
      var add = i === nLayers - 1 ? remaining : Math.round(remaining * w[i] / wsum);
      add = Math.max(0, Math.min(add, remaining));
      th[i] += add;
      remaining -= add;
    }
    th[nLayers - 1] += N - th.reduce(function (a, b) { return a + b; }, 0);

    /* 埋一层 0.75—0.875 m 的薄层：从邻层借厚度，层数不变 */
    var thinIdx = -1;
    if (nLayers >= 7) {
      thinIdx = 1 + Math.floor(rnd() * (nLayers - 2));
      var guard = 0;
      while (th[thinIdx] < 14 && guard++ < nLayers) thinIdx = 1 + (thinIdx % (nLayers - 2));
      var thin = 6 + Math.floor(rnd() * 2);
      var move = th[thinIdx] - thin;
      if (move > 0) {
        th[thinIdx] = thin;
        if (th[thinIdx - 1] >= th[thinIdx + 1]) th[thinIdx - 1] += move;
        else th[thinIdx + 1] += move;
      } else {
        thinIdx = -1;
      }
    }

    /* 层起点 / 界面 */
    var start = [0], acc = 0;
    for (i = 0; i < nLayers; i++) {
      acc += th[i];
      if (i < nLayers - 1) start.push(acc);
    }
    var cut = start.slice(1);

    /* 层物性：GR / SP / RT / 粗糙度 / 层内趋势 */
    var gr = [], sp = [], rt = [], rough = [], trend = [], spTrend = [], rtTrend = [];
    var prev = 55 + rnd() * 45;
    for (i = 0; i < nLayers; i++) {
      var v = 22 + rnd() * 108;
      if (Math.abs(v - prev) < 28) v = prev + (v > prev ? 1 : -1) * (28 + rnd() * 18);
      v = clamp(v, 20, 136);
      gr.push(v); prev = v;
      sp.push(8 - (v - 60) * 0.55 + (rnd() - 0.5) * 12);
      rt.push(clamp(1.4 + 72 * Math.exp(-(v - 38) / 46) * (0.55 + rnd() * 0.9), 1.2, 110));
      rough.push(0.75 + rnd() * 0.55);
      trend.push((rnd() - 0.5) * 16);
      spTrend.push((rnd() - 0.5) * 8);
      rtTrend.push((rnd() - 0.5) * 0.6);
    }
    /* 薄层给足对比度，保证它是“薄”，不是“弱” */
    if (thinIdx > 0 && thinIdx < nLayers - 1) {
      if (Math.abs(gr[thinIdx] - gr[thinIdx - 1]) < 36) {
        gr[thinIdx] = gr[thinIdx - 1] + (gr[thinIdx] > gr[thinIdx - 1] ? 1 : -1) * (36 + rnd() * 12);
      }
      if (Math.abs(gr[thinIdx] - gr[thinIdx + 1]) < 36) {
        gr[thinIdx] = gr[thinIdx + 1] + (gr[thinIdx] > gr[thinIdx + 1] ? 1 : -1) * (36 + rnd() * 12);
      }
      gr[thinIdx] = clamp(gr[thinIdx], 15, 140);
      sp[thinIdx] = 8 - (gr[thinIdx] - 60) * 0.55;
    }

    var baseGr = new Float64Array(N), baseSp = new Float64Array(N), baseRt = new Float64Array(N);
    var li = 0;
    for (i = 0; i < N; i++) {
      while (li < nLayers - 1 && i >= start[li + 1]) li++;
      var a = start[li], b = li === nLayers - 1 ? N : start[li + 1];
      var t = (i - a) / Math.max(1, b - a);
      baseGr[i] = gr[li] + trend[li] * (t - 0.5);
      baseSp[i] = sp[li] + spTrend[li] * (t - 0.5);
      baseRt[i] = rt[li] * (1 + rtTrend[li] * (t - 0.5));
    }
    /* 仪器响应：3 点核平滑，形成约 2 个采样点的过渡带 */
    function smooth(src) {
      var out = new Float64Array(N);
      for (var k = 0; k < N; k++) {
        var s = 0, ws = 0;
        for (var q = -1; q <= 1; q++) {
          var idx = k + q;
          if (idx >= 0 && idx < N) { var ww = 2 - Math.abs(q); s += src[idx] * ww; ws += ww; }
        }
        out[k] = s / ws;
      }
      return out;
    }
    baseGr = smooth(baseGr); baseSp = smooth(baseSp); baseRt = smooth(baseRt);

    var x = new Float64Array(N), spArr = new Float64Array(N), rtArr = new Float64Array(N);
    li = 0;
    for (i = 0; i < N; i++) {
      while (li < nLayers - 1 && i >= start[li + 1]) li++;
      x[i] = baseGr[i] + gauss() * noise * rough[li];
      spArr[i] = baseSp[i] + gauss() * (noise * 0.35 + 0.4);
      rtArr[i] = Math.max(0.5, baseRt[i] * Math.exp(gauss() * noise / 140));
    }

    /* 缺失段：在厚层里挖 3 个 GR 点，再线性插值；位置远离界面 */
    var missing = [];
    if (withMissing) {
      var cand = [];
      for (i = 10; i < N - 10; i++) {
        var near = false;
        for (var q2 = 0; q2 < cut.length; q2++) if (Math.abs(cut[q2] - i) <= 6) near = true;
        if (!near) cand.push(i);
      }
      var mm = Math.min(3, cand.length);
      for (i = 0; i < mm; i++) {
        var pick = cand[Math.floor(rnd() * cand.length)];
        if (missing.indexOf(pick) >= 0) { i--; continue; }
        missing.push(pick);
      }
      missing.sort(function (a2, b2) { return a2 - b2; });
      missing.forEach(function (idx) {
        x[idx] = (x[idx - 1] + x[idx + 1]) / 2;
      });
    }

    return {
      x: x, sp: spArr, rt: rtArr, cut: cut, th: th.slice(),
      grVal: gr, spVal: sp, rtVal: rt, missing: missing, thinIdx: thinIdx, start: start
    };
  }

  /* ---------- 稳健噪声估计 ---------- */
  function sigmaHat(x) {
    var d = [], i;
    for (i = 1; i < x.length; i++) d.push(Math.abs(x[i] - x[i - 1]));
    d.sort(function (a, b) { return a - b; });
    var med = d[Math.floor(d.length / 2)];
    return Math.max(0.8, med / 0.6745 / Math.SQRT2);
  }

  /* ---------- 滑窗特征 ---------- */
  function pearson(a, b) {
    var n = a.length, ma = 0, mb = 0, i;
    for (i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    var sa = 0, sb = 0, sab = 0;
    for (i = 0; i < n; i++) {
      var da = a[i] - ma, db = b[i] - mb;
      sa += da * da; sb += db * db; sab += da * db;
    }
    if (sa < 1e-9 || sb < 1e-9) return 0;
    return sab / Math.sqrt(sa * sb);
  }
  function slopeOf(a) {
    var n = a.length, sx = 0, sy = 0, sxx = 0, sxy = 0, i;
    for (i = 0; i < n; i++) { sx += i; sy += a[i]; sxx += i * i; sxy += i * a[i]; }
    return (n * sxy - sx * sy) / Math.max(1e-9, n * sxx - sx * sx);
  }
  function featuresAt(x, i, sig) {
    var L = [], R = [], q;
    for (q = WIN; q >= 1; q--) L.push(x[i - q]);
    for (q = 0; q < WIN; q++) R.push(x[i + q]);
    var mL = L.reduce(function (a, b) { return a + b; }, 0) / WIN;
    var mR = R.reduce(function (a, b) { return a + b; }, 0) / WIN;
    var vL = 0, vR = 0;
    for (q = 0; q < WIN; q++) { vL += (L[q] - mL) * (L[q] - mL); vR += (R[q] - mR) * (R[q] - mR); }
    vL /= WIN; vR /= WIN;
    var cor = pearson(L, R);
    return [
      Math.min(8, Math.abs(mR - mL) / sig),
      Math.min(3, Math.abs(Math.log((vR + 1e-6) / (vL + 1e-6)))),
      Math.min(6, Math.abs(slopeOf(R) - slopeOf(L)) / sig),
      isFinite(cor) ? 1 - Math.abs(cor) : 1,
      Math.min(6, Math.abs(x[i] - x[i - 1]) / sig)
    ];
  }

  /* =========================================================
     合成多井：16 口训练 / 4 口按井验证
     ========================================================= */
  function buildCorpus() {
    var wells = [];
    for (var i = 0; i < CORPUS; i++) {
      var rnd = mulberry32(90001 + i * 7919);
      var layers = 6 + Math.floor(rnd() * 8);
      var noise = 4 + rnd() * 12;
      wells.push(makeWell(700001 + i * 104729, layers, noise, false));
    }
    return wells;
  }

  function trainModel(wells) {
    var train = [], val = [], wi, i, j;
    for (wi = 0; wi < wells.length; wi++) {
      var w = wells[wi], sig = sigmaHat(w.x);
      for (i = WIN; i < N - WIN; i++) {
        var y = 0;
        for (j = 0; j < w.cut.length; j++) if (Math.abs(w.cut[j] - i) <= 1) { y = 1; break; }
        var rec = { x: featuresAt(w.x, i, sig), y: y };
        if (wi < TRAIN_WELLS) train.push(rec); else val.push(rec);
      }
    }

    var DIM = FEATS.length;
    var mu = new Array(DIM).fill(0), sd = new Array(DIM).fill(0);
    train.forEach(function (r) { r.x.forEach(function (v, k) { mu[k] += v; }); });
    for (j = 0; j < DIM; j++) mu[j] /= train.length;
    train.forEach(function (r) { r.x.forEach(function (v, k) { sd[k] += (v - mu[k]) * (v - mu[k]); }); });
    for (j = 0; j < DIM; j++) sd[j] = Math.sqrt(sd[j] / train.length) || 1;
    function std(x) { return x.map(function (v, k) { return (v - mu[k]) / sd[k]; }); }
    train.forEach(function (r) { r.x = std(r.x); });
    val.forEach(function (r) { r.x = std(r.x); });

    function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }
    var W = new Array(DIM).fill(0), b = 0;
    var mW = new Array(DIM).fill(0), vW = new Array(DIM).fill(0), mb = 0, vb = 0;
    var epochs = 260, lr = 0.06, l2 = 0.0008, eps = 0.08, pw = 2.6;
    var hist = [], valHist = [], best = { loss: 1e9, W: W.slice(), b: 0, ep: 0 };

    function forward(x) {
      var z = b;
      for (var k = 0; k < DIM; k++) z += W[k] * x[k];
      return z;
    }
    function bce(dataset, weighted) {
      var s = 0;
      dataset.forEach(function (r) {
        var p = sigmoid(forward(r.x));
        var target = r.y * (1 - eps) + eps / 2;
        if (weighted) {
          var wgt = r.y ? pw : 1;
          s += -wgt * (r.y ? Math.log(Math.max(1e-9, p)) : Math.log(Math.max(1e-9, 1 - p)));
        } else {
          s += -(r.y ? Math.log(Math.max(1e-9, p)) : Math.log(Math.max(1e-9, 1 - p)));
        }
      });
      return s / Math.max(1, dataset.length);
    }

    for (var ep = 0; ep < epochs; ep++) {
      var gW = new Array(DIM).fill(0), gb = 0;
      train.forEach(function (r) {
        var p = sigmoid(forward(r.x));
        var target = r.y * (1 - eps) + eps / 2;
        var wgt = r.y ? pw : 1;
        var d = wgt * (p - target);
        gb += d;
        for (var k = 0; k < DIM; k++) gW[k] += d * r.x[k];
      });
      var t = ep + 1, n = train.length;
      mb = 0.9 * mb + 0.1 * gb / n;
      vb = 0.999 * vb + 0.001 * (gb / n) * (gb / n);
      var mhb = mb / (1 - Math.pow(0.9, t)), vhb = vb / (1 - Math.pow(0.999, t));
      b -= lr * mhb / (Math.sqrt(vhb) + 1e-8);
      for (j = 0; j < DIM; j++) {
        mW[j] = 0.9 * mW[j] + 0.1 * gW[j] / n;
        vW[j] = 0.999 * vW[j] + 0.001 * (gW[j] / n) * (gW[j] / n);
        var mh = mW[j] / (1 - Math.pow(0.9, t)), vh = vW[j] / (1 - Math.pow(0.999, t));
        W[j] -= lr * (mh / (Math.sqrt(vh) + 1e-8) + l2 * W[j]);
      }
      if (ep % 10 === 0 || ep === epochs - 1) {
        hist.push(bce(train, true));
        valHist.push(bce(val, true));
      }
      var vLoss = bce(val, false);
      if (vLoss < best.loss) { best.loss = vLoss; best.W = W.slice(); best.b = b; best.ep = ep; }
    }

    W = best.W.slice(); b = best.b;

    /* 温度缩放：在验证集上选使 NLL 最小的 T，抑制过置信 */
    var zVal = val.map(function (r) { return forward(r.x); });
    var bestT = 1, bestNLL = 1e9;
    for (var T = 0.35; T <= 2.501; T += 0.05) {
      var nll = 0;
      val.forEach(function (r, k) {
        var p = sigmoid(zVal[k] / T);
        nll += -(r.y ? Math.log(Math.max(1e-9, p)) : Math.log(Math.max(1e-9, 1 - p)));
      });
      nll /= Math.max(1, val.length);
      if (nll < bestNLL) { bestNLL = nll; bestT = T; }
    }

    var tp = 0, fp = 0, tn = 0, fn = 0;
    var conf = [[0, 0], [0, 0]];
    var pos = [], neg = [], brier = 0;
    val.forEach(function (r, k) {
      var p = sigmoid(zVal[k] / bestT);
      var pred = p >= 0.5 ? 1 : 0;
      conf[r.y][pred]++;
      if (r.y === 1 && pred === 1) tp++;
      else if (r.y === 1 && pred === 0) fn++;
      else if (r.y === 0 && pred === 1) fp++;
      else tn++;
      if (r.y === 1) pos.push(p); else neg.push(p);
      brier += (p - r.y) * (p - r.y);
    });
    var aucSum = 0, pairs = 0;
    pos.forEach(function (pp) {
      neg.forEach(function (nn) {
        pairs++;
        if (pp > nn) aucSum += 1; else if (pp === nn) aucSum += 0.5;
      });
    });
    var acc = (tp + tn) / Math.max(1, val.length);
    var prec = (tp + fp) ? tp / (tp + fp) : 0;
    var rec = (tp + fn) ? tp / (tp + fn) : 0;
    var spec = (tn + fp) ? tn / (tn + fp) : 0;
    var f1 = (prec + rec) ? 2 * prec * rec / (prec + rec) : 0;

    function predict(f) {
      var xs = f.map(function (v, k) { return (v - mu[k]) / sd[k]; });
      var z = b;
      for (var k2 = 0; k2 < DIM; k2++) z += W[k2] * xs[k2];
      return probClamp(sigmoid(z / bestT));
    }

    return {
      W: W, b: b, mu: mu, sd: sd, T: bestT, hist: hist, valHist: valHist,
      bestEpoch: best.ep, acc: acc, prec: prec, rec: rec, spec: spec, f1: f1,
      auc: pairs ? aucSum / pairs : 0, brier: brier / Math.max(1, val.length),
      tp: tp, fp: fp, tn: tn, fn: fn, conf: conf,
      nTrain: train.length, nVal: val.length, predict: predict
    };
  }

  /* =========================================================
     动态规划分段：代价 = 边界 −log p + 非边界 −log(1−p) + β×界面数
     ========================================================= */
  function dpSegment(p, beta) {
    var n = p.length, i, s, t;
    var nllB = new Float64Array(n), nllN = new Float64Array(n);
    for (i = 0; i < n; i++) {
      nllB[i] = -Math.log(Math.max(1e-9, p[i]));
      nllN[i] = -Math.log(Math.max(1e-9, 1 - p[i]));
    }
    var prefN = new Float64Array(n + 1);
    for (i = 0; i < n; i++) prefN[i + 1] = prefN[i] + nllN[i];

    var D = new Float64Array(n + 1), prev = new Int32Array(n + 1);
    for (i = 0; i <= n; i++) { D[i] = Infinity; prev[i] = -1; }
    D[0] = 0;
    for (t = 1; t <= n; t++) {
      if (t >= MINSEG) {
        var c0 = prefN[t];
        if (c0 < D[t]) { D[t] = c0; prev[t] = 0; }
      }
      for (s = MINSEG; s <= t - MINSEG; s++) {
        if (!isFinite(D[s])) continue;
        var c = D[s] + nllB[s] + beta + (prefN[t] - prefN[s + 1]);
        if (c < D[t]) { D[t] = c; prev[t] = s; }
      }
    }
    var bounds = [], cur = n;
    while (cur > 0) {
      var pp = prev[cur];
      if (pp <= 0) break;
      bounds.push(pp); cur = pp;
    }
    bounds.reverse();

    var set = {};
    bounds.forEach(function (b) { set[b] = 1; });
    var bCost = 0, nCost = 0;
    for (i = 0; i < n; i++) {
      if (set[i]) bCost += nllB[i]; else nCost += nllN[i];
    }
    return {
      bounds: bounds, total: D[n], bCost: bCost, nCost: nCost,
      betaCost: beta * bounds.length, nllB: nllB, nllN: nllN
    };
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
    var p = det.length ? tp / det.length : 0;
    var r = tru.length ? tp / tru.length : 0;
    var f1 = (p + r) ? 2 * p * r / (p + r) : 0;
    var f2 = (4 * p + r) ? 5 * p * r / (4 * p + r) : 0;
    return {
      tp: tp, fp: fp, fn: fn, p: p, r: r, f1: f1, f2: f2,
      mae: tp ? errSum * STEP / tp : 0, matchedTrue: used
    };
  }

  /* ---------- 仿真人工卡层 ---------- */
  function manualPicks(well, seed) {
    var rnd = mulberry32(seed + 97);
    var picks = [];
    well.cut.forEach(function (c, i) {
      /* 薄层底界系统性漏卡：人工只卡顶界 */
      if (well.thinIdx > 0 && i === well.thinIdx) return;
      var mag = 0.85 + rnd() * 0.55;
      var sign = rnd() < 0.5 ? -1 : 1;
      var pts = clamp(Math.round(mag / STEP) * sign, -10, 10);
      picks.push({ idx: clamp(c + pts, 0, N - 1), off: pts * STEP });
    });
    return picks;
  }

  function thinLayer(well) {
    var edges = [0].concat(well.cut).concat([N]);
    for (var i = 1; i < edges.length - 1; i++) {
      var thick = (edges[i + 1] - edges[i]) * STEP;
      if (thick < 1.0) return { a: edges[i], b: edges[i + 1], thick: thick };
    }
    return null;
  }
  function thinDetected(det, L) {
    if (!L) return false;
    var ai = -1, j;
    for (var i = 0; i < det.length; i++) if (Math.abs(det[i] - L.a) <= TOL) { ai = i; break; }
    if (ai < 0) return false;
    for (j = 0; j < det.length; j++) if (j !== ai && Math.abs(det[j] - L.b) <= TOL) return true;
    return false;
  }

  /* ---------- 特征分离度 ---------- */
  function featureStats(well) {
    var sig = sigmaHat(well.x);
    var B = [], Nn = [];
    for (var i = WIN; i < N - WIN; i++) {
      var isB = false;
      for (var j = 0; j < well.cut.length; j++) if (Math.abs(well.cut[j] - i) <= 1) { isB = true; break; }
      (isB ? B : Nn).push(featuresAt(well.x, i, sig));
    }
    return FEATS.map(function (ft, k) {
      var bm = B.reduce(function (a, f) { return a + f[k]; }, 0) / Math.max(1, B.length);
      var nm = Nn.reduce(function (a, f) { return a + f[k]; }, 0) / Math.max(1, Nn.length);
      var bv = B.reduce(function (a, f) { return a + (f[k] - bm) * (f[k] - bm); }, 0) / Math.max(1, B.length);
      var nv = Nn.reduce(function (a, f) { return a + (f[k] - nm) * (f[k] - nm); }, 0) / Math.max(1, Nn.length);
      return { key: ft.key, name: ft.name, b: bm, n: nm, d: (bm - nm) / Math.sqrt((bv + nv) / 2 + 1e-6) };
    });
  }

  /* =========================================================
     样式：全部限定在 #wld，避免污染主站
     ========================================================= */
  var CSS = '' +
    '#wld{font-family:var(--sans);font-size:12.5px;line-height:1.65;color:var(--ink);background:var(--paper);padding:14px 16px 16px;border-radius:12px}' +
    '#wld *{box-sizing:border-box}' +
    '#wld h3{font-size:17px;line-height:1.3;margin:0;color:var(--ink);letter-spacing:-.01em}' +
    '#wld p{margin:0;color:var(--ink-2)}' +
    '#wld .wld-head{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px;align-items:start;margin-bottom:10px}' +
    '#wld .wld-kick{font-family:var(--mono);font-size:8.5px;letter-spacing:.15em;color:var(--jade-d);display:inline-flex;align-items:center;gap:6px;margin-bottom:5px;text-transform:uppercase}' +
    '#wld .wld-kick::before{content:"";width:14px;height:1.5px;background:currentColor;opacity:.5}' +
    '#wld .wld-lead{font-size:11.5px;color:var(--ink-3);line-height:1.7;margin-top:4px;max-width:76ch}' +
    '#wld .wld-stats{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;padding-top:2px}' +
    '#wld .wld-stat{border:1px solid var(--line);background:var(--card);border-radius:7px;padding:4px 9px;min-width:74px}' +
    '#wld .wld-stat .k{font-family:var(--mono);font-size:7.5px;letter-spacing:.09em;color:var(--ink-4);white-space:nowrap}' +
    '#wld .wld-stat .v{font-family:var(--mono);font-size:13px;color:var(--ink);line-height:1.35;white-space:nowrap}' +
    '#wld .wld-stat .v small{font-size:8px;color:var(--ink-4);font-family:var(--sans);margin-left:1px}' +
    '#wld .wld-stat.good .v{color:var(--ok)}#wld .wld-stat.warn .v{color:var(--warn)}#wld .wld-stat.bad .v{color:var(--bad)}' +
    '#wld .wld-ctl{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:7px 10px;border:1px solid var(--line);border-radius:9px;background:var(--card-soft);margin-bottom:10px}' +
    '#wld .wld-ctl label{font-family:var(--mono);font-size:8.5px;letter-spacing:.04em;color:var(--ink-3);white-space:nowrap}' +
    '#wld .wld-ctl .grp{display:flex;align-items:center;gap:7px}' +
    '#wld .wld-ctl .sp{flex:1}' +
    '#wld input[type=range]{-webkit-appearance:none;appearance:none;width:104px;height:3px;border-radius:2px;background:var(--line-2);outline:none;cursor:pointer;padding:0;margin:0}' +
    '#wld input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:13px;height:13px;border-radius:50%;background:var(--jade);border:2px solid #fff;box-shadow:0 0 0 1px var(--jade)}' +
    '#wld input[type=range]::-moz-range-thumb{width:12px;height:12px;border-radius:50%;background:var(--jade);border:2px solid #fff}' +
    '#wld .wld-rval{font-family:var(--mono);font-size:11px;color:var(--jade-d);font-weight:600;min-width:34px;text-align:right}' +
    '#wld .wld-num{width:82px;font-family:var(--mono);font-size:10px;padding:3px 5px;border:1px solid var(--line-2);border-radius:5px;background:var(--card);color:var(--ink-2)}' +
    '#wld .wld-btn{display:inline-flex;align-items:center;gap:5px;font-size:11px;padding:4px 10px;border:1px solid var(--line-2);border-radius:100px;background:var(--card);color:var(--ink-2);cursor:pointer;white-space:nowrap;font-family:var(--sans)}' +
    '#wld .wld-btn:hover{border-color:var(--line-3);color:var(--ink)}' +
    '#wld .wld-btn.pri{background:var(--jade);border-color:var(--jade);color:#fff;font-weight:600}' +
    '#wld .wld-btn.pri:hover{background:var(--jade-d);border-color:var(--jade-d)}' +
    '#wld .wld-btn:disabled{opacity:.45;cursor:not-allowed}' +
    '#wld .wld-tog{display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-size:10.5px;color:var(--ink-2);user-select:none;min-height:24px}' +
    '#wld .wld-tog i{width:26px;height:14px;border-radius:8px;background:var(--line-2);position:relative;transition:background .16s;flex-shrink:0}' +
    '#wld .wld-tog i::after{content:"";position:absolute;left:2px;top:2px;width:10px;height:10px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.18);transition:transform .16s}' +
    '#wld .wld-tog.on i{background:rgba(29,78,80,.45)}' +
    '#wld .wld-tog.on i::after{transform:translateX(12px);background:var(--jade-d)}' +
    '#wld .wld-flow{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));border:1px solid var(--line);border-radius:9px;background:var(--card);overflow:hidden;margin-bottom:10px}' +
    '#wld .wld-flow button{position:relative;border:0;border-right:1px solid var(--line);background:transparent;text-align:left;padding:7px 9px 8px;cursor:pointer;font-family:var(--sans);min-width:0;appearance:none}' +
    '#wld .wld-flow button:last-child{border-right:0}' +
    '#wld .wld-flow button .n{font-family:var(--mono);font-size:7.5px;letter-spacing:.12em;color:var(--ink-4);display:flex;align-items:center;gap:5px;text-transform:uppercase}' +
    '#wld .wld-flow button .n i{width:14px;height:14px;border-radius:50%;border:1px solid var(--line-2);display:inline-flex;align-items:center;justify-content:center;font-style:normal;font-size:7.5px;color:var(--ink-4);background:var(--card-soft);flex-shrink:0}' +
    '#wld .wld-flow button b{display:block;font-size:10.5px;font-weight:600;color:var(--ink-2);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '#wld .wld-flow button span{display:block;font-size:8.5px;color:var(--ink-4);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '#wld .wld-flow button:hover b{color:var(--ink)}' +
    '#wld .wld-flow button.on{background:linear-gradient(180deg,var(--jade-l),rgba(231,238,233,.3))}' +
    '#wld .wld-flow button.on b{color:var(--jade-d)}' +
    '#wld .wld-flow button.on .n i{border-color:var(--jade);background:var(--jade);color:#fff}' +
    '#wld .wld-flow button.done .n i{background:var(--ok);border-color:var(--ok);color:#fff}' +
    '#wld .wld-flow button.on::after{content:"";position:absolute;left:0;right:0;bottom:0;height:2px;background:var(--jade)}' +
    '#wld .wld-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,344px);gap:10px;align-items:start}' +
    '#wld .wld-col{display:flex;flex-direction:column;gap:10px;min-width:0}' +
    '#wld .wld-fig{border:1px solid var(--line);border-radius:9px;background:var(--card);padding:9px 10px 7px;min-width:0}' +
    '#wld .wld-fig-h{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-family:var(--mono);font-size:8px;letter-spacing:.08em;color:var(--ink-4);margin-bottom:6px;text-transform:uppercase}' +
    '#wld .wld-fig-h b{color:var(--ink-3);font-weight:500;letter-spacing:0;text-transform:none;font-family:var(--sans);font-size:10.5px}' +
    '#wld .wld-fig svg{display:block;width:100%;height:auto}' +
    '#wld .wld-legend{display:flex;gap:10px;flex-wrap:wrap;border-top:1px solid var(--line);margin-top:6px;padding-top:5px;font-size:9px;color:var(--ink-4)}' +
    '#wld .wld-legend span{display:flex;align-items:center;gap:4px}' +
    '#wld .wld-legend i{width:12px;height:3px;border-radius:2px;display:block;flex-shrink:0}' +
    '#wld .wld-legend i.dash{height:0;border-top:1.5px dashed var(--jade);background:none!important}' +
    '#wld .wld-readout{margin-top:5px;padding:4px 7px;border:1px solid var(--line-2);border-radius:5px;background:var(--card-soft);font-family:var(--mono);font-size:9px;color:var(--ink-2);min-height:23px;line-height:1.5}' +
    '#wld .wld-metrics{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:1px;background:var(--line);border:1px solid var(--line);border-radius:8px;overflow:hidden}' +
    '#wld .wld-metric{background:var(--card);padding:5px 7px;min-width:0}' +
    '#wld .wld-metric .l{font-family:var(--mono);font-size:7.5px;letter-spacing:.06em;color:var(--ink-4);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '#wld .wld-metric .v{font-family:var(--mono);font-size:15px;line-height:1.3;color:var(--ink)}' +
    '#wld .wld-metric .v small{font-size:8px;color:var(--ink-4);font-family:var(--sans);margin-left:1px}' +
    '#wld .wld-metric.good .v{color:var(--ok)}#wld .wld-metric.warn .v{color:var(--warn)}#wld .wld-metric.bad .v{color:var(--bad)}' +
    '#wld .wld-scans{display:grid;grid-template-columns:1fr 1fr;gap:8px}' +
    '#wld .wld-scan-cap{text-align:center;font-family:var(--mono);font-size:8px;color:var(--ink-4);margin-top:1px}' +
    '#wld .wld-stage{display:none}' +
    '#wld .wld-stage.on{display:block}' +
    '#wld .wld-lede{font-size:10.8px;color:var(--ink-3);line-height:1.65;margin:2px 0 7px}' +
    '#wld .wld-lede b{color:var(--ink)}' +
    '#wld .wld-vgrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;background:var(--line);border:1px solid var(--line);border-radius:8px;overflow:hidden;margin-bottom:7px}' +
    '#wld .wld-vgrid > div{background:var(--card);padding:5px 7px;min-width:0}' +
    '#wld .wld-vgrid .k{font-family:var(--mono);font-size:7.5px;letter-spacing:.06em;color:var(--ink-4);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '#wld .wld-vgrid .v{font-family:var(--mono);font-size:13px;line-height:1.3;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '#wld .wld-vgrid .v.ok{color:var(--ok)}#wld .wld-vgrid .v.warn{color:var(--warn)}#wld .wld-vgrid .v.bad{color:var(--bad)}' +
    '#wld .wld-vgrid .s{font-size:8.5px;color:var(--ink-4);line-height:1.4;margin-top:1px}' +
    '#wld .wld-qrow{display:flex;justify-content:space-between;gap:7px;font-size:9.8px;padding:3px 0;border-bottom:1px dashed var(--line)}' +
    '#wld .wld-qrow:last-child{border-bottom:0}' +
    '#wld .wld-qrow .k{color:var(--ink-4);font-family:var(--mono);font-size:7.8px;letter-spacing:.03em;white-space:nowrap}' +
    '#wld .wld-qrow .v{color:var(--ink-2);text-align:right;line-height:1.45;min-width:0}' +
    '#wld .wld-db{display:inline-flex;align-items:center;gap:4px;font-family:var(--mono);font-size:8px;letter-spacing:.04em;padding:1px 6px;border-radius:4px;border:1px solid;white-space:nowrap}' +
    '#wld .wld-db.ok{color:var(--ok);border-color:rgba(61,133,88,.28);background:var(--ok-bg)}' +
    '#wld .wld-db.warn{color:var(--warn);border-color:rgba(168,121,27,.28);background:var(--warn-bg)}' +
    '#wld .wld-db.bad{color:var(--bad);border-color:rgba(176,84,74,.28);background:var(--bad-bg)}' +
    '#wld .wld-db.plain{color:var(--ink-3);border-color:var(--line-2);background:var(--card-soft)}' +
    '#wld .wld-db::before{content:"";width:3px;height:3px;border-radius:50%;background:currentColor}' +
    '#wld .wld-cm{display:grid;grid-template-columns:52px repeat(2,minmax(0,1fr));gap:2px 3px;font-family:var(--mono);font-size:8px;align-items:center}' +
    '#wld .wld-cm .lb{text-align:right;color:var(--ink-4);white-space:nowrap;overflow:hidden;font-size:7px}' +
    '#wld .wld-cm i{display:flex;align-items:center;justify-content:center;height:15px;border-radius:2px;font-style:normal}' +
    '#wld .wld-cm .hd{text-align:center;color:var(--ink-4);font-size:7px}' +
    '#wld .wld-wrow{display:grid;grid-template-columns:64px minmax(0,1fr) 38px;gap:5px;align-items:center;font-size:9.2px;color:var(--ink-3);padding:1.5px 0}' +
    '#wld .wld-wrow .track{height:5px;border-radius:3px;background:var(--paper-3);position:relative;overflow:hidden}' +
    '#wld .wld-wrow .track i{position:absolute;top:0;bottom:0;border-radius:3px}' +
    '#wld .wld-wrow .val{font-family:var(--mono);font-size:8.5px;text-align:right;color:var(--ink-2)}' +
    '#wld .wld-blist{max-height:130px;overflow:auto;border-top:1px solid var(--line);margin-top:5px}' +
    '#wld .wld-brow{display:grid;grid-template-columns:58px minmax(0,1fr) 40px 44px;gap:5px;align-items:center;font-size:8.8px;padding:2px 0;border-bottom:1px dashed var(--line)}' +
    '#wld .wld-brow:last-child{border-bottom:0}' +
    '#wld .wld-brow .t{font-family:var(--mono);color:var(--ink-2)}' +
    '#wld .wld-brow .track{height:4px;border-radius:2px;background:var(--paper-3);overflow:hidden}' +
    '#wld .wld-brow .track i{display:block;height:100%;background:var(--jade);border-radius:2px}' +
    '#wld .wld-brow .p{font-family:var(--mono);text-align:right;color:var(--ink-2)}' +
    '#wld .wld-brow .db{font-family:var(--mono);font-size:7.5px;text-align:right;white-space:nowrap}' +
    '#wld .wld-mini-table{width:100%;border-collapse:collapse;font-size:9px;margin:4px 0 6px}' +
    '#wld .wld-mini-table th{font-family:var(--mono);font-size:7.5px;letter-spacing:.04em;color:var(--ink-4);text-align:left;padding:3px 3px 3px 0;border-bottom:1px solid var(--line-2);font-weight:400}' +
    '#wld .wld-mini-table td{padding:3px 3px 3px 0;border-bottom:1px solid var(--line);color:var(--ink-2)}' +
    '#wld .wld-mini-table tr:last-child td{border-bottom:0}' +
    '#wld .wld-mini-table td:first-child{color:var(--ink-4);font-family:var(--mono);font-size:7.8px;white-space:nowrap}' +
    '#wld .wld-feed{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:2px}' +
    '#wld .wld-feed .wld-btn{padding:3px 8px;font-size:9.5px}' +
    '#wld .wld-feed-note{font-size:8.8px;color:var(--ink-4);line-height:1.5;margin-top:3px}' +
    '#wld .wld-model{border:1px solid var(--line);border-radius:9px;background:var(--card);padding:7px 10px 6px}' +
    '#wld .wld-model-h{display:flex;align-items:center;justify-content:space-between;gap:7px;font-size:10.5px;color:var(--ink-3);margin-bottom:3px}' +
    '#wld .wld-model-h b{font-size:10.5px}' +
    '#wld .wld-mrow{display:grid;grid-template-columns:48px minmax(0,1fr);gap:7px;padding:3px 0;border-bottom:1px dashed var(--line);font-size:9.3px;line-height:1.5}' +
    '#wld .wld-mrow:last-child{border-bottom:0}' +
    '#wld .wld-mrow .k{font-family:var(--mono);font-size:7px;letter-spacing:.04em;color:var(--ink-4);padding-top:2px}' +
    '#wld .wld-mrow .v{color:var(--ink-2);min-width:0;overflow-wrap:anywhere}' +
    '#wld .wld-trace{border-left:2px solid var(--jade);background:var(--card-soft);border-radius:0 6px 6px 0;padding:5px 7px;font-family:var(--mono);font-size:8.2px;line-height:1.7;color:var(--ink-3);max-height:118px;overflow:auto}' +
    '#wld .wld-trace div{display:flex;gap:5px}' +
    '#wld .wld-trace .t{color:var(--ink-4);flex-shrink:0}' +
    '#wld .wld-trace b{color:var(--jade-d);font-weight:600}' +
    '#wld .wld-trace .ok{color:var(--ok)}#wld .wld-trace .warn{color:var(--warn)}#wld .wld-trace .bad{color:var(--bad)}' +
    '#wld .wld-tablewrap{margin-top:10px;border:1px solid var(--line);border-radius:9px;background:var(--card);padding:7px 9px 5px;overflow:auto}' +
    '#wld .wld-table{width:100%;border-collapse:collapse;font-size:9.5px;min-width:640px}' +
    '#wld .wld-table th{font-family:var(--mono);font-size:7.5px;letter-spacing:.04em;color:var(--ink-4);font-weight:400;text-align:left;padding:4px 6px 4px 0;border-bottom:1px solid var(--line-2);white-space:nowrap}' +
    '#wld .wld-table td{padding:4px 6px 4px 0;border-bottom:1px solid var(--line);color:var(--ink-2);white-space:nowrap}' +
    '#wld .wld-table tr:last-child td{border-bottom:0}' +
    '#wld .wld-table td.ok{color:var(--ok);font-weight:600}' +
    '#wld .wld-table td.extra{color:var(--warn)}' +
    '#wld .wld-table td.miss{color:var(--bad)}' +
    '#wld .wld-table .swatch{display:inline-block;width:7px;height:7px;border-radius:2px;margin-right:3px;vertical-align:-1px}' +
    '#wld .wld-note{font-size:10.5px;color:var(--ink-3);line-height:1.65;padding:7px 10px;border-left:2.5px solid var(--clay);background:linear-gradient(90deg,rgba(192,118,43,.07),transparent 76%);border-radius:0 4px 4px 0;margin-top:10px}' +
    '#wld .wld-note b{color:var(--ink)}' +
    '@media (max-width:1000px){' +
    '#wld .wld-grid{grid-template-columns:minmax(0,1fr)}' +
    '#wld .wld-metrics{grid-template-columns:repeat(3,minmax(0,1fr))}' +
    '#wld .wld-flow{grid-template-columns:repeat(2,minmax(0,1fr))}' +
    '#wld .wld-flow button{border-bottom:1px solid var(--line)}' +
    '}' +
    '@media (max-width:620px){' +
    '#wld .wld-head{grid-template-columns:minmax(0,1fr)}' +
    '#wld .wld-stats{justify-content:flex-start}' +
    '#wld .wld-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}' +
    '#wld .wld-scans{grid-template-columns:minmax(0,1fr)}' +
    '}';

  /* =========================================================
     主渲染
     ========================================================= */
  function WelllogLayerDemo(root) {
    var state = {
      seed: 20261022, layers: 10, noise: 8, beta: 0.7,
      showTrue: true, stage: 0
    };

    var corpus = buildCorpus();
    var model = trainModel(corpus);

    var well, sig, pArr, det, sc, betaScan = [], manual = [], thin = null, featStat = [];
    var rafId = 0, timerId = 0, runTimers = [];
    var fb = { ok: 0, fix: 0, bad: 0 };
    var TRACE = [];

    root.innerHTML = '<style>' + CSS + '</style>' +
      '<div id="wld">' +
      '<div class="wld-head">' +
      '<div><span class="wld-kick">WELL LOG · 曲线 → 质控 → 特征 → 概率 → 分段 → 闭环</span>' +
      '<h3>从测井曲线到层界：一条可复算的卡层流水线</h3>' +
      '<p class="wld-lead">同一口 1000—1030 m 合成井走完五段：01 先看 GR/SP/RT 能不能用，02 把窗口压成 5 维特征，03 在本页用 16 口合成井训练逻辑回归并输出边界概率，04 用概率做带 β 惩罚和最小层厚约束的动态规划，05 与仿真人工卡层对比并回写。改噪声、层数、β 或种子，五段同步重算。</p></div>' +
      '<div class="wld-stats">' +
      '<div class="wld-stat"><div class="k">判定</div><div class="v" id="wld-st-count">—</div></div>' +
      '<div class="wld-stat good"><div class="k">置信度</div><div class="v" id="wld-st-conf">—</div></div>' +
      '<div class="wld-stat"><div class="k">验证准确率</div><div class="v" id="wld-st-acc">—</div></div>' +
      '<div class="wld-stat warn"><div class="k">复核比例</div><div class="v" id="wld-st-review">—</div></div>' +
      '</div></div>' +

      '<div class="wld-ctl">' +
      '<div class="grp"><label for="wld-noise">噪声 σ</label><input type="range" id="wld-noise" min="2" max="24" step="1" value="8"><span class="wld-rval" id="wld-v-noise">8</span></div>' +
      '<div class="grp"><label for="wld-layers">真实层数</label><input type="range" id="wld-layers" min="5" max="14" step="1" value="10"><span class="wld-rval" id="wld-v-layers">10</span></div>' +
      '<div class="grp"><label for="wld-beta">惩罚 β</label><input type="range" id="wld-beta" min="0.1" max="3" step="0.05" value="0.7"><span class="wld-rval" id="wld-v-beta">0.70</span></div>' +
      '<label class="wld-tog on" for="wld-true"><input type="checkbox" id="wld-true" checked style="position:absolute;width:1px;height:1px;opacity:0"><i></i>真实界面</label>' +
      '<div class="grp"><label for="wld-seed">种子</label><input id="wld-seed" class="wld-num" type="number" min="1" step="1" value="20261022"><button type="button" class="wld-btn" data-act="copy">复制</button></div>' +
      '<span class="sp"></span>' +
      '<button class="wld-btn pri" type="button" data-act="run">▶ 运行全流程</button>' +
      '<button class="wld-btn" type="button" data-act="reset">重置</button>' +
      '<button class="wld-btn" type="button" data-act="new">换一口井 ↻</button>' +
      '</div>' +

      '<div class="wld-flow" id="wld-flow" role="tablist" aria-label="测井分层作业流">' +
      '<button type="button" class="on" data-s="0" role="tab" aria-selected="true"><span class="n"><i>01</i>INPUT</span><b>曲线采集与质控</b><span>GR / SP / RT · 缺失</span></button>' +
      '<button type="button" data-s="1" role="tab" aria-selected="false"><span class="n"><i>02</i>FEATURE</span><b>滑窗特征</b><span>均值差 · 方差比 · 斜率</span></button>' +
      '<button type="button" data-s="2" role="tab" aria-selected="false"><span class="n"><i>03</i>MODEL</span><b>边界概率模型</b><span>逻辑回归 · 温度校准</span></button>' +
      '<button type="button" data-s="3" role="tab" aria-selected="false"><span class="n"><i>04</i>DECISION</span><b>动态规划分段</b><span>β 惩罚 · 最小层厚</span></button>' +
      '<button type="button" data-s="4" role="tab" aria-selected="false"><span class="n"><i>05</i>LOOP</span><b>人工确认与价值</b><span>对比 · 回写 · 重训</span></button>' +
      '</div>' +

      '<div class="wld-grid">' +
      '<div class="wld-col">' +
      '<div class="wld-fig">' +
      '<div class="wld-fig-h"><b>主画布 · GR 曲线、边界概率与三层对比</b><span id="wld-hint">—</span></div>' +
      '<svg id="wld-log" viewBox="0 0 720 560" role="img" aria-label="GR 曲线、边界概率与真值 / 人工 / AI 界面"></svg>' +
      '<div class="wld-legend">' +
      '<span><i style="background:#2f3a3f"></i>GR 曲线</span>' +
      '<span><i style="background:#1d4e50"></i>AI 界面（DP）</span>' +
      '<span><i style="background:#b26a39"></i>人工仿真界面</span>' +
      '<span><i class="dash"></i>真实界面</span>' +
      '<span><i style="background:#5a6b78"></i>边界概率 p</span>' +
      '<span><i style="background:#f0e0c8;height:7px;width:10px;border-radius:2px"></i>0.8 m 薄层</span>' +
      '</div>' +
      '<div class="wld-readout" id="wld-readout">在曲线上移动或点选查看读数（深度 / GR / 边界概率 / AI 层段）</div>' +
      '</div>' +

      '<div class="wld-metrics" id="wld-metrics"></div>' +

      '<div class="wld-fig">' +
      '<div class="wld-fig-h"><b>β 扫描 · F1 与界面数</b><span id="wld-scan-note">—</span></div>' +
      '<div class="wld-scans">' +
      '<div><svg id="wld-scan1" viewBox="0 0 180 112"></svg><div class="wld-scan-cap">F1 vs β（0—1）</div></div>' +
      '<div><svg id="wld-scan2" viewBox="0 0 180 112"></svg><div class="wld-scan-cap">界面数 vs β（虚线 = 真实）</div></div>' +
      '</div>' +
      '</div>' +
      '</div>' +

      '<div class="wld-col">' +

      /* 01 */
      '<div class="wld-fig wld-stage on" data-stage="0">' +
      '<div class="wld-fig-h"><b>01 · 曲线采集与质量控制</b><span>先确认能不能进模型</span></div>' +
      '<p class="wld-lede">现场先看<b>井段、采样率、噪声和缺失</b>。GR 是分层主曲线，SP 与 RT 做旁证；缺失点先标记再插值，噪声过大时整段降级，不把坏数据喂给 02。</p>' +
      '<div class="wld-vgrid">' +
      '<div><div class="k">井段</div><div class="v">1000—1030 m</div><div class="s">单井评价段</div></div>' +
      '<div><div class="k">采样</div><div class="v">0.125 m</div><div class="s">240 点 / 30 m</div></div>' +
      '<div><div class="k">噪声 σ</div><div class="v" id="wld-q-noise">—</div><div class="s">设定值 / 稳健估计</div></div>' +
      '<div><div class="k">缺失</div><div class="v" id="wld-q-miss">—</div><div class="s">GR 插值点</div></div>' +
      '</div>' +
      '<svg id="wld-mini" viewBox="0 0 300 132" role="img" aria-label="GR / SP / RT 三曲线缩略图"></svg>' +
      '<div class="wld-qrow"><span class="k">曲线范围</span><span class="v" id="wld-q-range">—</span></div>' +
      '<div class="wld-qrow"><span class="k">GR 界面信噪比</span><span class="v" id="wld-q-snr">—</span></div>' +
      '<div class="wld-qrow"><span class="k">质控判定</span><span class="v" id="wld-q-gate">—</span></div>' +
      '<div class="wld-qrow"><span class="k">进入下一段</span><span class="v" id="wld-q-next">—</span></div>' +
      '</div>' +

      /* 02 */
      '<div class="wld-fig wld-stage" data-stage="1">' +
      '<div class="wld-fig-h"><b>02 · 滑窗特征：模型看到什么</b><span>每点两侧各 5 个采样点</span></div>' +
      '<p class="wld-lede">在 GR 曲线上，每个深度点左右各取 5 个采样点，算 <b>均值差 Δμ/σ、方差比、斜率差、相干性、跳变</b>。除以稳健噪声 σ 是为了让不同噪声水平的井可以放在同一个模型里比较；这一步不做任何“地质判断”。</p>' +
      '<svg id="wld-winsvg" viewBox="0 0 300 104" role="img" aria-label="滑窗特征示意"></svg>' +
      '<div id="wld-featstat"></div>' +
      '<div class="wld-qrow" style="margin-top:4px"><span class="k">样本</span><span class="v" id="wld-f-n">—</span></div>' +
      '<div class="wld-qrow"><span class="k">边界窗占比</span><span class="v" id="wld-f-rate">—</span></div>' +
      '</div>' +

      /* 03 */
      '<div class="wld-fig wld-stage" data-stage="2">' +
      '<div class="wld-fig-h"><b>03 · 边界概率模型 · 本页现场训练</b><span>合成 20 井 · 按井留出</span></div>' +
      '<p class="wld-lede">用 <b>16 口合成井</b>的窗口样本训练逻辑回归（5 维特征 + 偏置），另 <b>4 口井</b>整井留出做验证。标签平滑 0.08 抑制过置信，温度缩放在验证集上拟合；输出是每个深度点的边界概率，不是写死的模板。</p>' +
      '<div class="wld-vgrid">' +
      '<div><div class="k">训练 / 验证</div><div class="v" id="wld-m-n">—</div><div class="s">按井划分，无同井泄漏</div></div>' +
      '<div><div class="k">验证准确率</div><div class="v ok" id="wld-m-acc">—</div><div class="s">阈值 0.5</div></div>' +
      '<div><div class="k">边界召回</div><div class="v" id="wld-m-rec">—</div><div class="s">真界面窗被找回的比例</div></div>' +
      '<div><div class="k">特异度</div><div class="v" id="wld-m-spec">—</div><div class="s">非边界窗不被误报</div></div>' +
      '</div>' +
      '<div class="wld-qrow"><span class="k">校准 / 排序</span><span class="v" id="wld-m-cal">—</span></div>' +
      '<div class="wld-fig-h" style="margin:2px 0 3px"><b>训练 / 验证损失</b><span>交叉熵 · 每 10 轮</span></div>' +
      '<svg id="wld-curve" viewBox="0 0 320 96" role="img" aria-label="训练与验证损失曲线"></svg>' +
      '<div class="wld-fig-h" style="margin:6px 0 3px"><b>验证集混淆矩阵</b><span>行 = 真实 · 列 = 预测</span></div>' +
      '<div class="wld-cm" id="wld-cm"></div>' +
      '<div class="wld-fig-h" style="margin:7px 0 3px"><b>当前井边界概率 track</b><span id="wld-p-note">—</span></div>' +
      '<svg id="wld-ptrack" viewBox="0 0 300 190" role="img" aria-label="当前井边界概率 track"></svg>' +
      '<div class="wld-fig-h" style="margin:6px 0 2px"><b>模型权重</b><span>标准化特征上的系数</span></div>' +
      '<div id="wld-weights"></div>' +
      '<div class="wld-feed-note">本井只做推理，不参与训练；改噪声/层数会改变右侧概率 track 和 04 的分段，但不会改动训练集指标。</div>' +
      '</div>' +

      /* 04 */
      '<div class="wld-fig wld-stage" data-stage="3">' +
      '<div class="wld-fig-h"><b>04 · 动态规划分段</b><span>概率 + β 惩罚 + 层厚约束</span></div>' +
      '<p class="wld-lede">把“哪些点当界面”变成一个全局最优化：每个点要么付 <b>−log p</b>（当界面），要么付 <b>−log(1−p)</b>（不当界面），每多一个界面再付 <b>β</b>。同时强制相邻界面至少隔 <b>0.75 m</b>，所以不会在薄层里切出不可能的层。</p>' +
      '<div class="wld-vgrid">' +
      '<div><div class="k">输出界面</div><div class="v" id="wld-dp-n">—</div><div class="s">DP 最优解</div></div>' +
      '<div><div class="k">最优总代价</div><div class="v" id="wld-dp-cost">—</div><div class="s">越小越好</div></div>' +
      '<div><div class="k">β</div><div class="v" id="wld-dp-beta">—</div><div class="s">每多一个界面的代价</div></div>' +
      '<div><div class="k">最小层厚</div><div class="v">0.75 m</div><div class="s">6 个采样点</div></div>' +
      '</div>' +
      '<div class="wld-qrow"><span class="k">层序约束</span><span class="v">界面单调递增 · 不交叉 · 最小层厚 0.75 m</span></div>' +
      '<div class="wld-qrow"><span class="k">边界项 −Σlog p</span><span class="v" id="wld-dp-b">—</span></div>' +
      '<div class="wld-qrow"><span class="k">非边界项 −Σlog(1−p)</span><span class="v" id="wld-dp-nb">—</span></div>' +
      '<div class="wld-qrow"><span class="k">惩罚项 β×界面数</span><span class="v" id="wld-dp-pen">—</span></div>' +
      '<div class="wld-qrow"><span class="k">动作分流</span><span class="v" id="wld-dp-act">—</span></div>' +
      '<div class="wld-fig-h" style="margin:6px 0 2px"><b>候选界面与置信度</b><span>p ≥ 0.75 自动 · 0.50—0.75 复核 · &lt;0.50 重点复核</span></div>' +
      '<div class="wld-blist" id="wld-blist"></div>' +
      '<div class="wld-feed-note">β 太小 → 噪声点被当界面（过分割）；β 太大 → 真实薄层被合并（欠分割）。看左下方 β 扫描找拐点。</div>' +
      '</div>' +

      /* 05 */
      '<div class="wld-fig wld-stage" data-stage="4">' +
      '<div class="wld-fig-h"><b>05 · 人工确认与价值</b><span>示范口径 · 单井 1000—1030 m</span></div>' +
      '<p class="wld-lede">AI 不替代解释员签字，它把“从头卡”变成“复核候选”。下面四组是<b>示范口径</b>（同一评价段、同一套流程），用来对齐价值讨论；本页右侧同时给出<b>本井仿真人工 vs AI</b> 的可复算对比。</p>' +
      '<div class="wld-vgrid">' +
      '<div><div class="k">单井卡层耗时</div><div class="v ok">25 → 8 min</div><div class="s">人工 → 辅助后（含复核）</div></div>' +
      '<div><div class="k">界面平均误差</div><div class="v ok">1.2 → 0.4 m</div><div class="s">人工 → AI 辅助（现场口径）</div></div>' +
      '<div><div class="k">0.8 m 薄层漏卡</div><div class="v ok">3 → 0 处</div><div class="s">示范井组统计</div></div>' +
      '<div><div class="k">解释一致性</div><div class="v ok">76% → 93%</div><div class="s">两位解释员复核一致</div></div>' +
      '</div>' +
      '<div class="wld-fig-h" style="margin:2px 0 2px"><b>本井对比</b><span>合成真值已知 · 只用于核对口径</span></div>' +
      '<table class="wld-mini-table" id="wld-cmp"></table>' +
      '<div class="wld-feed" id="wld-feed">' +
      '<button class="wld-btn" type="button" data-fb="ok">✓ 确认分层正确</button>' +
      '<button class="wld-btn" type="button" data-fb="fix">✎ 修正 1 处界面</button>' +
      '<button class="wld-btn" type="button" data-fb="bad">✗ 标为误判</button>' +
      '</div>' +
      '<div class="wld-feed-note" id="wld-fb-note">回写 0 条 · 人工确认后才进入下一轮重训</div>' +
      '<div class="wld-feed-note" style="margin-top:4px">四组价值是示范口径，不是本页模型在 42 口井上的实测收益；合成井的 AI 偏差通常远小于现场 0.4 m。人工仿真按 0.85—1.4 m 系统性偏移 + 薄层底界漏卡生成，命中按严格 ±0.5 m 容差，0/9 是仿真口径，不代表现场人工全错。</div>' +
      '</div>' +

      '<div class="wld-model">' +
      '<div class="wld-model-h"><b>模型档案</b><span class="wld-db ok" id="wld-mbadge">已训练</span></div>' +
      '<div class="wld-mrow"><span class="k">任务</span><span class="v">深度序列边界检测 + 约束分段；不是逐点岩性分类</span></div>' +
      '<div class="wld-mrow"><span class="k">数据</span><span class="v" id="wld-md-data">—</span></div>' +
      '<div class="wld-mrow"><span class="k">模型</span><span class="v">逻辑回归 · 5 维滑窗特征 + 温度缩放</span></div>' +
      '<div class="wld-mrow"><span class="k">验证</span><span class="v" id="wld-md-val">—</span></div>' +
      '<div class="wld-mrow"><span class="k">边界</span><span class="v">p &lt; 0.50 的界面前端标重点复核；&lt;0.75 m 薄层、强噪声与缺失段不强行下结论</span></div>' +
      '</div>' +

      '<div class="wld-fig" style="padding-top:7px">' +
      '<div class="wld-fig-h"><b>过程日志</b><span>每一步都可追溯</span></div>' +
      '<div class="wld-trace" id="wld-trace"></div>' +
      '</div>' +

      '</div></div>' +

      '<div class="wld-tablewrap"><table class="wld-table" id="wld-table"></table></div>' +
      '<p class="wld-note" id="wld-note"></p>' +
      '</div>';

    var q = function (sel) { return root.querySelector(sel); };
    var svg = q('#wld-log'), miniSvg = q('#wld-mini'), winSvg = q('#wld-winsvg');
    var pSvg = q('#wld-ptrack'), curveSvg = q('#wld-curve'), cmEl = q('#wld-cm');
    var scan1 = q('#wld-scan1'), scan2 = q('#wld-scan2');
    var metricsEl = q('#wld-metrics'), tableEl = q('#wld-table');
    var readout = q('#wld-readout'), traceEl = q('#wld-trace');
    var seedInput = q('#wld-seed'), flowEl = q('#wld-flow');

    /* ------- 几何 ------- */
    var W = 720, H = 560, padL = 62, padT = 22, padB = 28;
    var grW = 350, pX = 440, pW = 120;
    function X(v) { return padL + clamp(v, 0, GRMAX) / GRMAX * grW; }
    function Y(i) { return padT + i / (N - 1) * (H - padT - padB); }
    function PX(p) { return pX + probClamp(p) * pW; }

    /* ------- 重算 ------- */
    function recomputeWell() {
      well = makeWell(state.seed, state.layers, state.noise, true);
      sig = sigmaHat(well.x);
      pArr = new Float64Array(N);
      for (var i = 0; i < N; i++) {
        var ii = clamp(i, WIN, N - WIN - 1);
        pArr[i] = model.predict(featuresAt(well.x, ii, sig));
      }
      det = dpSegment(pArr, state.beta).bounds;
      sc = score(det, well.cut);
      thin = thinLayer(well);
      manual = manualPicks(well, state.seed);
      featStat = featureStats(well);
      buildBetaScan();
    }
    function recomputeDP() {
      det = dpSegment(pArr, state.beta).bounds;
      sc = score(det, well.cut);
    }

    function buildBetaScan() {
      betaScan = [];
      for (var k = 0.1; k <= 3.001; k += 0.1) {
        var dp = dpSegment(pArr, k);
        var s = score(dp.bounds, well.cut);
        betaScan.push({ k: k, f1: s.f1, count: dp.bounds.length, total: dp.total });
      }
    }

    /* ------- 主画布 ------- */
    function drawTrack() {
      if (!well) return;
      var s = '';
      s += '<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="#ffffff"/>';

      /* 深度网格 */
      for (var d = 0; d <= 30; d += 5) {
        var yy = padT + d / 30 * (H - padT - padB);
        s += '<line x1="' + padL + '" y1="' + yy + '" x2="' + (pX + pW) + '" y2="' + yy + '" stroke="' + C.grid + '"/>';
        s += '<text x="' + (padL - 8) + '" y="' + (yy + 3.4) + '" fill="' + C.textDim + '" font-size="8.5" font-family="monospace" text-anchor="end">' + (TOP + d) + '</text>';
      }
      [0, 50, 100, 150].forEach(function (v) {
        var xx = X(v);
        s += '<line x1="' + xx + '" y1="' + padT + '" x2="' + xx + '" y2="' + (H - padB) + '" stroke="' + C.gridSoft + '"/>';
        s += '<text x="' + xx + '" y="' + (H - padB + 13) + '" fill="' + C.textDim + '" font-size="8.5" font-family="monospace" text-anchor="middle">' + v + '</text>';
      });
      s += '<text x="' + (padL + grW) + '" y="' + (H - padB + 13) + '" fill="' + C.textDim + '" font-size="8" font-family="monospace" text-anchor="end">API</text>';
      s += '<text x="' + padL + '" y="' + (padT - 8) + '" fill="' + C.text + '" font-size="8.5" font-family="monospace">GR (API)</text>';
      s += '<text x="' + pX + '" y="' + (padT - 8) + '" fill="' + C.prob + '" font-size="8.5" font-family="monospace">边界概率 p</text>';
      s += '<text x="6" y="' + (padT - 8) + '" fill="' + C.text + '" font-size="8.5" font-family="monospace">深度(m)</text>';

      /* AI 层段底色 + 左侧岩性色条 */
      var starts = [0].concat(det).concat([N]);
      for (var i = 0; i < starts.length - 1; i++) {
        var a = starts[i], b = starts[i + 1];
        var m = meanOf(well.x, a, b), li = lithOf(m);
        var y0 = Y(a), y1 = Y(b - 1) + (Y(1) - Y(0));
        s += '<rect x="' + padL + '" y="' + y0.toFixed(1) + '" width="' + grW + '" height="' + Math.max(1, y1 - y0).toFixed(1) + '" fill="' + li.color + '" opacity="0.09"/>';
        s += '<rect x="' + (padL - 5) + '" y="' + y0.toFixed(1) + '" width="3" height="' + Math.max(1, y1 - y0).toFixed(1) + '" rx="1.5" fill="' + li.color + '" opacity="0.75"/>';
      }

      /* 薄层高亮 */
      var thinOK = thin ? thinDetected(det, thin) : false;
      if (thin) {
        var ty0 = Y(thin.a), ty1 = Y(thin.b - 1) + (Y(1) - Y(0));
        s += '<rect x="' + padL + '" y="' + ty0.toFixed(1) + '" width="' + grW + '" height="' + Math.max(2, ty1 - ty0).toFixed(1) + '" fill="' + (thinOK ? '#dcebe2' : C.thin) + '" opacity=".55"/>';
      }

      /* 真实界面 */
      if (state.showTrue) {
        var prevTruthY = -999;
        well.cut.forEach(function (c) {
          var yy = Y(c);
          s += '<line x1="' + padL + '" y1="' + yy + '" x2="' + (pX + pW) + '" y2="' + yy + '" stroke="' + C.truth + '" stroke-width="1" stroke-dasharray="4 5" opacity="0.6"/>';
          if (yy - prevTruthY >= 7.5) {
            s += '<text x="' + (padL + 3) + '" y="' + (yy - 2.5) + '" fill="' + C.truth + '" font-size="7.5" font-family="monospace" opacity="0.85">真 ' + (TOP + c * STEP).toFixed(2) + '</text>';
            prevTruthY = yy;
          }
        });
      }

      /* 人工仿真界面 */
      manual.forEach(function (m) {
        var yy = Y(m.idx);
        s += '<line x1="' + (padL - 8) + '" y1="' + yy + '" x2="' + (pX + pW + 7) + '" y2="' + yy + '" stroke="' + C.manual + '" stroke-width="1.1" opacity="0.8"/>';
        s += '<circle cx="' + (padL - 8) + '" cy="' + yy + '" r="1.8" fill="' + C.manual + '"/>';
      });

      /* GR 曲线 */
      var path = '';
      for (var k = 0; k < N; k++) path += (k ? 'L' : 'M') + X(well.x[k]).toFixed(1) + ' ' + Y(k).toFixed(1);
      s += '<path d="' + path + '" fill="none" stroke="' + C.curve + '" stroke-width="1.1" stroke-linejoin="round"/>';

      /* 缺失点标记 */
      well.missing.forEach(function (idx) {
        s += '<circle cx="' + X(well.x[idx]).toFixed(1) + '" cy="' + Y(idx).toFixed(1) + '" r="2.1" fill="#fff" stroke="' + C.miss + '" stroke-width="1"/>';
      });

      /* AI 界面 */
      var prevAiY = -999;
      det.forEach(function (c) {
        var yy = Y(c);
        s += '<line x1="' + padL + '" y1="' + yy + '" x2="' + (pX + pW + 3) + '" y2="' + yy + '" stroke="' + C.ai + '" stroke-width="1.25"/>';
        s += '<path d="M' + (pX + pW + 3) + ' ' + yy + ' l5 -2.8 l0 5.6 z" fill="' + C.ai + '"/>';
        var nearThin = thin && (Math.abs(c - thin.a) <= TOL || Math.abs(c - thin.b) <= TOL);
        if (!nearThin && yy - prevAiY >= 7.5) {
          s += '<text x="' + (pX + pW + 11) + '" y="' + (yy + 2.8) + '" fill="' + C.ai + '" font-size="7.8" font-family="monospace">' + (TOP + c * STEP).toFixed(2) + '</text>';
          prevAiY = yy;
        }
      });
      if (thin) {
        var midThinY = (Y(thin.a) + Y(thin.b)) / 2;
        s += '<line x1="' + (pX + pW + 3) + '" y1="' + midThinY.toFixed(1) + '" x2="' + (pX + pW + 8) + '" y2="' + midThinY.toFixed(1) + '" stroke="' + (thinOK ? C.truth : C.det) + '" stroke-width="1"/>';
        s += '<text x="' + (pX + pW + 12) + '" y="' + (midThinY + 2.8).toFixed(1) + '" fill="' + (thinOK ? C.truth : C.det) + '" font-size="7.8" font-family="monospace">' + thin.thick.toFixed(2) + 'm 薄层 · ' + (thinOK ? '已切出' : '未切出') + '</text>';
      }

      /* 概率 track */
      s += '<rect x="' + pX + '" y="' + padT + '" width="' + pW + '" height="' + (H - padT - padB) + '" fill="#fbfaf5" stroke="' + C.grid + '"/>';
      [0, 0.5, 1].forEach(function (v) {
        var xx = PX(v);
        s += '<line x1="' + xx + '" y1="' + padT + '" x2="' + xx + '" y2="' + (H - padB) + '" stroke="' + C.grid + '" stroke-dasharray="' + (v === 0.5 ? '3 3' : '0') + '"/>';
        s += '<text x="' + xx + '" y="' + (H - padB + 12) + '" fill="' + C.textDim + '" font-size="7.3" font-family="monospace" text-anchor="middle">' + v + '</text>';
      });
      var pPath = '';
      for (var pi = 0; pi < N; pi++) pPath += (pi ? 'L' : 'M') + PX(pArr[pi]).toFixed(1) + ' ' + Y(pi).toFixed(1);
      s += '<path d="' + pPath + '" fill="none" stroke="' + C.prob + '" stroke-width="1.15" opacity="0.9"/>';
      det.forEach(function (c) {
        s += '<circle cx="' + PX(pArr[c]).toFixed(1) + '" cy="' + Y(c).toFixed(1) + '" r="2.4" fill="' + C.ai + '" stroke="#fff" stroke-width="0.8"/>';
      });

      s += '<line id="wld-xh" x1="' + padL + '" y1="0" x2="' + (pX + pW) + '" y2="0" stroke="#b9c0c5" stroke-dasharray="3 3" style="display:none"/>';
      s += '<rect id="wld-hit" x="' + padL + '" y="' + padT + '" width="' + (pX + pW - padL) + '" height="' + (H - padT - padB) + '" fill="transparent" style="cursor:crosshair;touch-action:pan-y"/>';

      svg.innerHTML = s;

      var hit = svg.querySelector('#wld-hit'), xh = svg.querySelector('#wld-xh');
      function readAt(clientY) {
        var r = svg.getBoundingClientRect();
        var sy = (clientY - r.top) / r.height * H;
        var idx = Math.round((sy - padT) / (H - padT - padB) * (N - 1));
        if (idx < 0 || idx >= N) { xh.style.display = 'none'; return; }
        var yy = Y(idx);
        xh.setAttribute('y1', yy); xh.setAttribute('y2', yy);
        xh.style.display = '';
        var starts2 = [0].concat(det).concat([N]), li2 = 0;
        for (var q2 = 0; q2 < starts2.length - 1; q2++) if (idx >= starts2[q2] && idx < starts2[q2 + 1]) li2 = q2;
        var lito = lithOf(meanOf(well.x, starts2[li2], starts2[li2 + 1]));
        var topD = TOP + starts2[li2] * STEP, botD = TOP + starts2[li2 + 1] * STEP;
        var raw = well.x[idx];
        var rawTxt = raw.toFixed(0) + (raw < 0 || raw > GRMAX ? '（轴上截断）' : '');
        readout.textContent = '深度 ' + (TOP + idx * STEP).toFixed(2) + ' m · GR ' + rawTxt + ' API · p=' + pNum(pArr[idx]) +
          ' · AI 层 ' + topD.toFixed(2) + '—' + botD.toFixed(2) + ' m · ' + lito.name;
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
        '<div class="wld-metric ' + cls + '"><div class="l">F1</div><div class="v">' + fmt(sc.f1, 1) + '</div></div>' +
        '<div class="wld-metric ' + cls + '"><div class="l">F2 · 召回优先</div><div class="v">' + fmt(sc.f2, 1) + '</div></div>' +
        '<div class="wld-metric"><div class="l">召回 R</div><div class="v">' + fmt(sc.r, 1) + '<small>' + sc.tp + '/' + well.cut.length + '</small></div></div>' +
        '<div class="wld-metric"><div class="l">精确 P</div><div class="v">' + fmt(sc.p, 1) + '<small>' + sc.tp + '/' + Math.max(1, det.length) + '</small></div></div>' +
        '<div class="wld-metric"><div class="l">界面误差</div><div class="v">' + (sc.tp ? sc.mae.toFixed(2) : '—') + '<small>m</small></div></div>' +
        '<div class="wld-metric"><div class="l">FP / FN</div><div class="v">' + sc.fp + ' / ' + sc.fn + '</div></div>';
    }

    function drawHeader() {
      var meanP = 0;
      det.forEach(function (b) { meanP += pArr[b]; });
      meanP = det.length ? meanP / det.length : 0;
      var review = det.filter(function (b) { return pArr[b] < 0.75; }).length;
      q('#wld-st-count').textContent = det.length + ' 界面';
      q('#wld-st-conf').textContent = det.length ? pText(meanP) : '—';
      q('#wld-st-acc').innerHTML = (model.acc * 100).toFixed(1) + '<small>%</small>';
      q('#wld-st-review').textContent = det.length ? (review / det.length * 100).toFixed(0) + '%' : '—';
      q('#wld-hint').textContent = '真实 ' + (well.cut.length + 1) + ' 层 / ' + well.cut.length + ' 界面 · 噪声 σ=' + state.noise + ' API · β=' + state.beta.toFixed(2);
    }

    /* ------- β 扫描 ------- */
    function drawOneScan(el, key, yMin, yMax, current, best, markerLabel) {
      var w = 180, h = 112, L = 24, R = 7, T = 10, B = 18;
      function fx(k) { return L + (k - 0.1) / 2.9 * (w - L - R); }
      function fy(v) { return T + (1 - (v - yMin) / Math.max(1e-6, yMax - yMin)) * (h - T - B); }
      var s = '';
      [0, 0.5, 1].forEach(function (t) {
        var v = yMin + (yMax - yMin) * t, yy = fy(v);
        s += '<line x1="' + L + '" y1="' + yy + '" x2="' + (w - R) + '" y2="' + yy + '" stroke="#efece1"/>';
        s += '<text x="' + (L - 3) + '" y="' + (yy + 2.5) + '" text-anchor="end" font-size="6.5" font-family="monospace" fill="#99a3a4">' + (key === 'f1' ? v.toFixed(1) : Math.round(v)) + '</text>';
      });
      var pts = betaScan.map(function (d) { return fx(d.k).toFixed(1) + ',' + fy(d[key]).toFixed(1); }).join(' ');
      s += '<polyline points="' + pts + '" fill="none" stroke="' + C.truth + '" stroke-width="1.5" opacity="0.9"/>';
      if (key === 'count') {
        var trueN = well.cut.length;
        s += '<line x1="' + L + '" y1="' + fy(trueN) + '" x2="' + (w - R) + '" y2="' + fy(trueN) + '" stroke="' + C.manual + '" stroke-width="1" stroke-dasharray="3 3"/>';
      }
      var b = betaScan.reduce(function (a, c) { return c[key] > a[key] ? c : a; }, betaScan[0]);
      s += '<circle cx="' + fx(b.k) + '" cy="' + fy(b[key]) + '" r="2.3" fill="' + C.truth + '"/>';
      s += '<line x1="' + fx(current) + '" y1="' + T + '" x2="' + fx(current) + '" y2="' + (h - B) + '" stroke="' + C.det + '" stroke-width="1" stroke-dasharray="3 3"/>';
      var curVal = key === 'f1' ? sc.f1 : det.length;
      s += '<circle cx="' + fx(current) + '" cy="' + fy(curVal) + '" r="2.8" fill="' + C.det + '"/>';
      s += '<text x="' + L + '" y="' + (h - 2.5) + '" font-size="6.5" font-family="monospace" fill="#99a3a4">β 0.1</text>';
      s += '<text x="' + (w - R) + '" y="' + (h - 2.5) + '" font-size="6.5" font-family="monospace" fill="#99a3a4" text-anchor="end">3.0</text>';
      if (markerLabel) s += '<text x="' + Math.min(fx(current) + 4, w - 4) + '" y="' + (T + 7) + '" font-size="6.5" font-family="monospace" fill="' + C.det + '">当前</text>';
      el.innerHTML = s;
    }
    function drawScan() {
      var maxCount = Math.max(well.cut.length + 2, betaScan.reduce(function (a, c) { return Math.max(a, c.count); }, 0) + 1);
      drawOneScan(scan1, 'f1', 0, 1, state.beta, null, true);
      drawOneScan(scan2, 'count', 0, maxCount, state.beta, null, true);
      var best = betaScan.reduce(function (a, c) { return c.f1 > a.f1 ? c : a; }, betaScan[0]);
      q('#wld-scan-note').textContent = '当前 β=' + state.beta.toFixed(2) + ' · F1=' + sc.f1.toFixed(2) + ' · 峰值 β=' + best.k.toFixed(1) + '（F1=' + best.f1.toFixed(2) + '）';
    }

    /* ------- 分层表 ------- */
    function drawTable() {
      var starts = [0].concat(det).concat([N]);
      var rows = '';
      for (var i = 0; i < starts.length - 1; i++) {
        var a = starts[i], b = starts[i + 1];
        var mm = meanOf(well.x, a, b), li = lithOf(mm);
        var top = TOP + a * STEP, bot = TOP + b * STEP;
        var judge = '—', cls = '', dev = '—';
        if (i === 0) { judge = '井段顶'; }
        else {
          var bestD = 1e9, matched = false;
          well.cut.forEach(function (c, ci) {
            var d = Math.abs(c - a);
            if (d < bestD) bestD = d;
            if (sc.matchedTrue[ci] && d <= TOL) matched = true;
          });
          judge = matched ? '✓ 命中' : '✗ 多余界面';
          cls = matched ? 'ok' : 'extra';
          dev = (bestD * STEP).toFixed(2);
        }
        rows += '<tr><td>' + (i + 1) + '</td>' +
          '<td>' + top.toFixed(2) + '</td><td>' + bot.toFixed(2) + '</td><td>' + (bot - top).toFixed(2) + '</td>' +
          '<td>' + mm.toFixed(0) + '</td>' +
          '<td class="lith"><span class="swatch" style="background:' + li.color + '"></span>' + li.name + '</td>' +
          '<td>' + dev + '</td><td class="' + cls + '">' + judge + '</td></tr>';
      }
      var missed = [];
      well.cut.forEach(function (c, ci) { if (!sc.matchedTrue[ci]) missed.push(c); });
      if (missed.length) {
        rows += '<tr><td colspan="8" style="padding-top:8px;color:var(--bad);font-family:var(--sans);font-size:9px;letter-spacing:.03em">漏检界面（FN）· 真实界面 ±0.5 m 内没有检出</td></tr>';
        missed.forEach(function (c) {
          rows += '<tr><td>—</td><td>' + (TOP + c * STEP).toFixed(2) + '</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td class="miss">✗ 漏检界面</td></tr>';
        });
      }
      tableEl.innerHTML = '<thead><tr><th>层</th><th>顶深 (m)</th><th>底深 (m)</th><th>厚度 (m)</th><th>平均 GR</th><th>岩性（GR 推测）</th><th>最近真值偏差 (m)</th><th>判定</th></tr></thead><tbody>' + rows + '</tbody>';
    }

    /* ------- 01 三曲线缩略图 ------- */
    function drawMini() {
      var Wm = 300, Hm = 132, top = 20, bot = 108, x0 = 26, tw = 82, gap = 12;
      var tracks = [
        { arr: well.x, label: 'GR', color: C.curve, unit: 'API', log: false },
        { arr: well.sp, label: 'SP', color: '#41699b', unit: 'mV', log: false },
        { arr: well.rt, label: 'RT', color: '#7e5a8d', unit: 'Ω·m', log: true }
      ];
      var s = '';
      tracks.forEach(function (tr, ti) {
        var x1 = x0 + ti * (tw + gap);
        var vals = [], k;
        for (k = 0; k < N; k++) vals.push(tr.log ? Math.log10(Math.max(0.1, tr.arr[k])) : tr.arr[k]);
        var mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals);
        var pad = (mx - mn) * 0.08 || 1;
        mn -= pad; mx += pad;
        function xx(v) { return x1 + (v - mn) / (mx - mn) * tw; }
        function yy(k2) { return top + k2 / (N - 1) * (bot - top); }
        s += '<rect x="' + x1 + '" y="' + top + '" width="' + tw + '" height="' + (bot - top) + '" fill="#fdfcf9" stroke="#e9e4d8"/>';
        [0, 10, 20, 30].forEach(function (d) {
          var y = top + d / 30 * (bot - top);
          s += '<line x1="' + x1 + '" y1="' + y + '" x2="' + (x1 + tw) + '" y2="' + y + '" stroke="#f2efe6"/>';
        });
        var path = '';
        for (k = 0; k < N; k++) path += (k ? 'L' : 'M') + xx(vals[k]).toFixed(1) + ' ' + yy(k).toFixed(1);
        s += '<path d="' + path + '" fill="none" stroke="' + tr.color + '" stroke-width="1"/>';
        if (ti === 0) {
          well.missing.forEach(function (idx) {
            s += '<circle cx="' + xx(vals[idx]).toFixed(1) + '" cy="' + yy(idx).toFixed(1) + '" r="1.8" fill="#fff" stroke="' + C.miss + '" stroke-width="1"/>';
          });
        }
        s += '<text x="' + (x1 + 3) + '" y="' + (top - 5) + '" font-size="8" font-family="monospace" fill="' + C.text + '">' + tr.label + '</text>';
        s += '<text x="' + (x1 + tw) + '" y="' + (bot + 12) + '" text-anchor="end" font-size="7" font-family="monospace" fill="' + C.textDim + '">' +
          (tr.log ? Math.pow(10, mn).toFixed(1) + '—' + Math.pow(10, mx).toFixed(1) : mn.toFixed(0) + '—' + mx.toFixed(0)) + ' ' + tr.unit + '</text>';
      });
      [0, 10, 20, 30].forEach(function (d) {
        var y = top + d / 30 * (bot - top);
        s += '<text x="' + (x0 - 3) + '" y="' + (y + 2.5) + '" text-anchor="end" font-size="6.5" font-family="monospace" fill="' + C.textDim + '">' + (TOP + d) + '</text>';
      });
      s += '<text x="' + (Wm - 2) + '" y="' + (Hm - 2) + '" text-anchor="end" font-size="6.5" font-family="monospace" fill="' + C.textDim + '">纵轴 1000—1030 m · 采样 0.125 m</text>';
      miniSvg.innerHTML = s;
    }

    /* ------- 02 滑窗示意 + 特征分离度 ------- */
    function drawWin() {
      if (!det.length) { winSvg.innerHTML = ''; return; }
      var b = det.reduce(function (a, c) { return pArr[c] > pArr[a] ? c : a; }, det[0]);
      var lo = Math.max(WIN, b - 14), hi = Math.min(N - 1, b + 14);
      var Ww = 300, Hw = 104, L = 24, R = 10, T = 10, B = 22;
      var vals = [], k;
      for (k = lo; k <= hi; k++) vals.push(well.x[k]);
      var mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals);
      var pad = (mx - mn) * 0.08 || 1; mn -= pad; mx += pad;
      function xx(idx) { return L + (idx - lo) / Math.max(1, hi - lo) * (Ww - L - R); }
      function yy(v) { return T + (1 - (v - mn) / (mx - mn)) * (Hw - T - B); }
      var s = '<rect x="' + L + '" y="' + T + '" width="' + (Ww - L - R) + '" height="' + (Hw - T - B) + '" fill="#fdfcf9" stroke="#e9e4d8"/>';
      var lx0 = xx(Math.max(lo, b - WIN)), lx1 = xx(Math.max(lo, b - 1));
      var rx0 = xx(b), rx1 = xx(Math.min(hi, b + WIN - 1));
      s += '<rect x="' + lx0 + '" y="' + T + '" width="' + Math.max(1, lx1 - lx0) + '" height="' + (Hw - T - B) + '" fill="#41699b" opacity=".10"/>';
      s += '<rect x="' + rx0 + '" y="' + T + '" width="' + Math.max(1, rx1 - rx0) + '" height="' + (Hw - T - B) + '" fill="#1d4e50" opacity=".12"/>';
      var path = '';
      for (k = lo; k <= hi; k++) path += (k > lo ? 'L' : 'M') + xx(k).toFixed(1) + ' ' + yy(well.x[k]).toFixed(1);
      s += '<path d="' + path + '" fill="none" stroke="' + C.curve + '" stroke-width="1.2"/>';
      s += '<line x1="' + xx(b) + '" y1="' + T + '" x2="' + xx(b) + '" y2="' + (Hw - B) + '" stroke="' + C.ai + '" stroke-width="1" stroke-dasharray="3 3"/>';
      var mL = meanOf(well.x, Math.max(0, b - WIN), b), mR = meanOf(well.x, b, Math.min(N, b + WIN));
      s += '<line x1="' + lx0 + '" y1="' + yy(mL) + '" x2="' + lx1 + '" y2="' + yy(mL) + '" stroke="#41699b" stroke-width="1.2"/>';
      s += '<line x1="' + rx0 + '" y1="' + yy(mR) + '" x2="' + rx1 + '" y2="' + yy(mR) + '" stroke="#1d4e50" stroke-width="1.2"/>';
      s += '<text x="' + (L + 2) + '" y="' + (Hw - 6) + '" font-size="7" font-family="monospace" fill="#41699b">左窗 μ=' + mL.toFixed(0) + '</text>';
      s += '<text x="' + (Ww - R) + '" y="' + (Hw - 6) + '" text-anchor="end" font-size="7" font-family="monospace" fill="#1d4e50">右窗 μ=' + mR.toFixed(0) + '</text>';
      s += '<text x="' + xx(b) + '" y="' + (Hw - 6) + '" text-anchor="middle" font-size="7" font-family="monospace" fill="' + C.det + '">Δμ=' + (mR - mL).toFixed(0) + ' API</text>';
      s += '<text x="' + (Ww - R) + '" y="' + (T + 8) + '" text-anchor="end" font-size="7" font-family="monospace" fill="' + C.textDim + '">候选 ' + (TOP + b * STEP).toFixed(2) + ' m</text>';
      winSvg.innerHTML = s;

      q('#wld-featstat').innerHTML = '<div class="wld-qrow"><span class="k">特征</span><span class="v">边界窗均值 / 非边界窗均值 / 分离度 d</span></div>' +
        featStat.map(function (f) {
          return '<div class="wld-qrow"><span class="k">' + f.name + '</span><span class="v">' +
            f.b.toFixed(2) + ' / ' + f.n.toFixed(2) + ' / <b>' + f.d.toFixed(2) + '</b></span></div>';
        }).join('');
      q('#wld-f-n').textContent = (N - 2 * WIN) + ' 个窗口（本井）';
      var bCount = 0;
      for (var ii = WIN; ii < N - WIN; ii++) {
        for (var jj = 0; jj < well.cut.length; jj++) if (Math.abs(well.cut[jj] - ii) <= 1) { bCount++; break; }
      }
      q('#wld-f-rate').textContent = (bCount / (N - 2 * WIN) * 100).toFixed(1) + '%（' + bCount + ' / ' + (N - 2 * WIN) + '）';
    }

    /* ------- 03 曲线 / 混淆矩阵 / 概率 track / 权重 ------- */
    function drawCurve() {
      var w = 320, h = 96, L = 26, R = 6, T = 8, B = 16;
      var all = model.hist.concat(model.valHist);
      var lo = Math.min.apply(null, all), hi = Math.max.apply(null, all);
      var pad = (hi - lo) * 0.15 || 0.01; lo = Math.max(0, lo - pad); hi += pad;
      function fx(i) { return L + i * (w - L - R) / Math.max(1, model.hist.length - 1); }
      function fy(v) { return T + (1 - (v - lo) / (hi - lo)) * (h - T - B); }
      var s = '';
      [0, 0.5, 1].forEach(function (t) {
        var v = lo + (hi - lo) * t, y = fy(v);
        s += '<line x1="' + L + '" y1="' + y + '" x2="' + (w - R) + '" y2="' + y + '" stroke="#efece1"/>';
        s += '<text x="' + (L - 3) + '" y="' + (y + 2.5) + '" text-anchor="end" font-size="6.5" font-family="monospace" fill="#99a3a4">' + v.toFixed(2) + '</text>';
      });
      var d1 = model.hist.map(function (v, i) { return (i ? 'L' : 'M') + fx(i).toFixed(1) + ' ' + fy(v).toFixed(1); }).join('');
      var d2 = model.valHist.map(function (v, i) { return (i ? 'L' : 'M') + fx(i).toFixed(1) + ' ' + fy(v).toFixed(1); }).join('');
      s += '<path d="' + d1 + '" fill="none" stroke="' + C.truth + '" stroke-width="1.6"/>';
      s += '<path d="' + d2 + '" fill="none" stroke="' + C.manual + '" stroke-width="1.1" stroke-dasharray="3 2"/>';
      s += '<text x="' + (w - R) + '" y="' + (T + 7) + '" text-anchor="end" font-size="6.5" font-family="monospace" fill="' + C.truth + '">训练</text>';
      s += '<text x="' + (w - R - 26) + '" y="' + (T + 7) + '" text-anchor="end" font-size="6.5" font-family="monospace" fill="' + C.manual + '">验证</text>';
      s += '<text x="' + L + '" y="' + (h - 2.5) + '" font-size="6.5" font-family="monospace" fill="#99a3a4">0</text>';
      s += '<text x="' + (w - R) + '" y="' + (h - 2.5) + '" text-anchor="end" font-size="6.5" font-family="monospace" fill="#99a3a4">260 轮 · best ' + model.bestEpoch + '</text>';
      curveSvg.innerHTML = s;
    }

    function drawCM() {
      var names = ['非边界', '边界'];
      var conf = model.conf;
      var cm = '<span class="lb">真实↓ 预测→</span><span class="hd">' + names[0] + '</span><span class="hd">' + names[1] + '</span>';
      conf.forEach(function (row, i) {
        var sum = row[0] + row[1] || 1;
        cm += '<span class="lb">' + names[i] + '</span>' + row.map(function (v) {
          var qv = v / sum;
          var a = qv > 0.5 ? 0.16 + qv * 0.66 : qv * 1.05;
          return '<i title="' + v + ' 个 · 行占比 ' + (qv * 100).toFixed(0) + '%" style="background:rgba(29,78,80,' + a.toFixed(2) + ');color:' + (qv > 0.5 ? '#f3eee3' : '#45524d') + '">' + v + ' · ' + Math.round(qv * 100) + '%</i>';
        }).join('');
      });
      cmEl.innerHTML = cm;
    }

    function drawPTrack() {
      var w = 300, h = 190, L = 42, R = 12, T = 18, B = 18;
      function xx(p) { return L + probClamp(p) * (w - L - R); }
      function yy(i) { return T + i / (N - 1) * (h - T - B); }
      var s = '';
      [0, 0.5, 1].forEach(function (p) {
        s += '<line x1="' + xx(p) + '" y1="' + T + '" x2="' + xx(p) + '" y2="' + (h - B) + '" stroke="#efece1" stroke-dasharray="' + (p === 0.5 ? '3 3' : '0') + '"/>';
        s += '<text x="' + xx(p) + '" y="' + (T - 5) + '" text-anchor="middle" font-size="7" font-family="monospace" fill="#99a3a4">' + p + '</text>';
      });
      [0, 10, 20, 30].forEach(function (d) {
        var y = T + d / 30 * (h - T - B);
        s += '<text x="' + (L - 4) + '" y="' + (y + 2.5) + '" text-anchor="end" font-size="6.5" font-family="monospace" fill="#99a3a4">' + (TOP + d) + '</text>';
      });
      var path = '';
      for (var i = 0; i < N; i++) path += (i ? 'L' : 'M') + xx(pArr[i]).toFixed(1) + ' ' + yy(i).toFixed(1);
      s += '<path d="' + path + '" fill="none" stroke="' + C.prob + '" stroke-width="1.4"/>';
      well.cut.forEach(function (c) {
        s += '<line x1="' + L + '" y1="' + yy(c) + '" x2="' + (w - R) + '" y2="' + yy(c) + '" stroke="' + C.truth + '" stroke-width="0.8" stroke-dasharray="3 3" opacity="0.45"/>';
      });
      det.forEach(function (b) {
        s += '<circle cx="' + xx(pArr[b]).toFixed(1) + '" cy="' + yy(b).toFixed(1) + '" r="2.6" fill="' + C.ai + '" stroke="#fff" stroke-width="0.8"/>';
      });
      s += '<text x="' + L + '" y="' + (h - 3) + '" font-size="6.5" font-family="monospace" fill="#99a3a4">0</text>';
      s += '<text x="' + (w - R) + '" y="' + (h - 3) + '" text-anchor="end" font-size="6.5" font-family="monospace" fill="#99a3a4">1</text>';
      pSvg.innerHTML = s;
    }

    function drawWeights() {
      var max = Math.max.apply(null, model.W.map(function (v) { return Math.abs(v); })) || 1;
      q('#wld-weights').innerHTML = FEATS.map(function (f, j) {
        var v = model.W[j], pos = v >= 0;
        var wd = Math.abs(v) / max * 100;
        return '<div class="wld-wrow"><span>' + f.short + '</span><span class="track"><i style="' + (pos ? 'left:0' : 'right:0') + ';width:' + wd.toFixed(1) + '%;background:' + (pos ? 'var(--jade)' : 'var(--bad)') + '"></i></span><span class="val">' + (pos ? '+' : '') + v.toFixed(2) + '</span></div>';
      }).join('') + '<div class="wld-feed-note">权重作用在标准化特征上；负号 = 该特征单独偏高时反而抑制边界判定。</div>';
    }

    function drawStage03() {
      q('#wld-m-n').textContent = model.nTrain + ' / ' + model.nVal;
      q('#wld-m-acc').innerHTML = (model.acc * 100).toFixed(1) + '%';
      q('#wld-m-rec').innerHTML = (model.rec * 100).toFixed(1) + '%';
      q('#wld-m-spec').innerHTML = (model.spec * 100).toFixed(1) + '%';
      q('#wld-m-cal').textContent = 'T=' + model.T.toFixed(2) + ' · Brier ' + model.brier.toFixed(3) + ' · AUC ' + model.auc.toFixed(2) + ' · 概率显示截断 0.5%—99.5%';
      var meanP = 0;
      well.cut.forEach(function (c) { meanP += pArr[c]; });
      meanP /= Math.max(1, well.cut.length);
      q('#wld-p-note').textContent = '真界面处平均 p=' + pText(meanP);
      drawCurve(); drawCM(); drawPTrack(); drawWeights();
    }

    /* ------- 04 ------- */
    function drawStage04() {
      var dp = dpSegment(pArr, state.beta);
      q('#wld-dp-n').textContent = det.length + ' 个';
      q('#wld-dp-cost').textContent = dp.total.toFixed(1);
      q('#wld-dp-beta').textContent = state.beta.toFixed(2);
      q('#wld-dp-b').textContent = dp.bCost.toFixed(1);
      q('#wld-dp-nb').textContent = dp.nCost.toFixed(1);
      q('#wld-dp-pen').textContent = dp.betaCost.toFixed(1) + '（' + det.length + '×β）';
      var auto = 0, review = 0, focus = 0;
      det.forEach(function (b) {
        if (pArr[b] >= 0.75) auto++; else if (pArr[b] >= 0.5) review++; else focus++;
      });
      q('#wld-dp-act').innerHTML = '<span class="wld-db ok">自动 ' + auto + '</span> <span class="wld-db warn">复核 ' + review + '</span> <span class="wld-db bad">重点 ' + focus + '</span>';
      q('#wld-blist').innerHTML = det.length ? det.map(function (b) {
        var p = pArr[b];
        var tag = p >= 0.75 ? '<span class="db ok" style="color:var(--ok)">自动</span>' : p >= 0.5 ? '<span class="db warn" style="color:var(--warn)">复核</span>' : '<span class="db bad" style="color:var(--bad)">重点</span>';
        return '<div class="wld-brow"><span class="t">' + (TOP + b * STEP).toFixed(2) + ' m</span><span class="track"><i style="width:' + (probClamp(p) * 100).toFixed(1) + '%"></i></span><span class="p">' + pNum(p) + '</span>' + tag + '</div>';
      }).join('') : '<div class="wld-feed-note">当前 β 下没有切出界面；降低 β 或检查 02/03。</div>';
    }

    /* ------- 05 ------- */
    function manualSummary() {
      var err = 0;
      manual.forEach(function (m) {
        var best = 1e9;
        well.cut.forEach(function (c) { best = Math.min(best, Math.abs(c - m.idx)); });
        err += best * STEP;
      });
      var mae = manual.length ? err / manual.length : 0;
      var hit = manual.filter(function (m) {
        return well.cut.some(function (c) { return Math.abs(c - m.idx) <= TOL; });
      }).length;
      var thinMiss = thin ? !thinDetected(manual.map(function (m) { return m.idx; }), thin) : false;
      return { count: manual.length, mae: mae, hit: hit, thinMiss: thinMiss };
    }

    function drawStage05() {
      var ms = manualSummary();
      var aiThin = thin ? thinDetected(det, thin) : false;
      q('#wld-cmp').innerHTML =
        '<thead><tr><th>指标</th><th>人工仿真</th><th>AI（本页）</th></tr></thead><tbody>' +
        '<tr><td>界面数</td><td>' + ms.count + '</td><td>' + det.length + '</td></tr>' +
        '<tr><td>命中真值 ±0.5m</td><td>' + ms.hit + ' / ' + well.cut.length + '</td><td>' + sc.tp + ' / ' + well.cut.length + '</td></tr>' +
        '<tr><td>平均偏离</td><td>' + ms.mae.toFixed(2) + ' m</td><td>' + (sc.tp ? sc.mae.toFixed(2) : '—') + ' m</td></tr>' +
        '<tr><td>0.8m 薄层</td><td>' + (thin ? (ms.thinMiss ? '漏 1 界' : '已卡出') : '本井无') + '</td><td>' + (thin ? (aiThin ? '已切出' : '漏 1 界') : '本井无') + '</td></tr>' +
        '</tbody>';
      q('#wld-fb-note').textContent = '回写 ' + (fb.ok + fb.fix + fb.bad) + ' 条' + (fb.bad ? ' · 其中误判 ' + fb.bad + ' 条' : '') + ' · 人工确认后才进入下一轮重训';
    }

    /* ------- 模型档案 / 说明 ------- */
    function drawModel() {
      q('#wld-md-data').textContent = '20 口合成井（16 训练 / 4 按井验证）· 单井 240 点 @0.125 m · 本井不参与训练';
      q('#wld-md-val').innerHTML = '准确率 <b>' + (model.acc * 100).toFixed(1) + '%</b> · 边界召回 <b>' + (model.rec * 100).toFixed(1) +
        '%</b> · 特异度 <b>' + (model.spec * 100).toFixed(1) + '%</b> · AUC <b>' + model.auc.toFixed(2) + '</b> · T=' + model.T.toFixed(2) + ' · Brier <b>' + model.brier.toFixed(3) + '</b>';
      q('#wld-mbadge').textContent = '已训练';
      q('#wld-mbadge').className = 'wld-db ok';
    }

    function drawNote() {
      var msg;
      if (!det.length) {
        msg = '当前 β 下没有切出任何界面：β 过大或曲线过于平缓。先降低 β，或回到 01 检查噪声与缺失。';
      } else if (sc.f2 >= 0.85 && sc.r >= 0.85) {
        msg = '本井界面基本对齐：真实 ' + well.cut.length + ' 个界面，AI 命中 <b>' + sc.tp + '</b> 个，平均偏差 <b>' + (sc.tp ? sc.mae.toFixed(2) : '—') + ' m</b>。' +
          (thin ? (thinDetected(det, thin) ? ' 0.75—0.88 m 薄层的两个界面都被独立切出。' : ' 薄层仍有一个界面被合并，需在 04 降 β 或人工补卡。') : '') +
          ' 这是合成真值下的结果，现场口径（1.2 → 0.4 m）见 05。';
      } else if (det.length > well.cut.length + 1) {
        msg = '当前<b>过分割</b>：切出 ' + det.length + ' 个界面，真实只有 ' + well.cut.length + ' 个。β 偏小，噪声波动被当成了界面；看左下 β 扫描的界面数曲线。';
      } else if (det.length < well.cut.length - 1) {
        msg = '当前<b>欠分割</b>：只切出 ' + det.length + ' 个界面，真实有 ' + well.cut.length + ' 个。β 偏大、噪声过高或层间对比太弱，相邻层被合并。';
      } else {
        msg = '层数接近但位置有偏差：AI 给出 ' + det.length + ' 个界面，命中 ' + sc.tp + ' 个。优先看漏检（' + sc.fn + '）与低置信界面，再决定是调 β 还是交人工。';
      }
      if (state.noise >= 18) msg += ' 当前噪声 σ=' + state.noise + ' API，01 应判为降级/退回；此时模型概率变钝是预期行为，不要靠调 β 掩盖。';
      q('#wld-note').innerHTML = msg;
    }

    /* ------- 01 面板 ------- */
    function drawStage01() {
      q('#wld-q-noise').textContent = state.noise + ' / ' + sig.toFixed(1);
      q('#wld-q-miss').textContent = well.missing.length + ' 点';
      var grMin = Math.min.apply(null, Array.prototype.slice.call(well.x));
      var grMax = Math.max.apply(null, Array.prototype.slice.call(well.x));
      var spMin = Math.min.apply(null, Array.prototype.slice.call(well.sp));
      var spMax = Math.max.apply(null, Array.prototype.slice.call(well.sp));
      var rtMin = Math.min.apply(null, Array.prototype.slice.call(well.rt));
      var rtMax = Math.max.apply(null, Array.prototype.slice.call(well.rt));
      q('#wld-q-range').textContent = 'GR ' + grMin.toFixed(0) + '—' + grMax.toFixed(0) + ' API · SP ' + spMin.toFixed(0) + '—' + spMax.toFixed(0) + ' mV · RT ' + rtMin.toFixed(1) + '—' + rtMax.toFixed(1) + ' Ω·m';
      var contrasts = [];
      well.cut.forEach(function (c) {
        var a = Math.max(0, c - 8), b = Math.min(N, c + 8);
        contrasts.push(Math.abs(meanOf(well.x, c, b) - meanOf(well.x, a, c)));
      });
      contrasts.sort(function (a, b) { return a - b; });
      var contrast = contrasts.length ? contrasts[Math.floor(contrasts.length / 2)] : (grMax - grMin);
      var snr = 20 * Math.log(contrast / Math.max(0.1, sig)) / Math.LN10;
      q('#wld-q-snr').innerHTML = snr.toFixed(0) + ' dB <span class="wld-db ' + (snr >= 12 ? 'ok' : snr >= 8 ? 'warn' : 'bad') + '">' + (snr >= 12 ? '可用' : snr >= 8 ? '偏低' : '差') + '</span>';
      var gate = state.noise <= 14 && well.missing.length <= 5 ? ['ok', '可用 · 进入 02'] : state.noise <= 20 ? ['warn', '降级 · 建议复采后复核'] : ['bad', '退回重采 · 噪声淹没薄层响应'];
      q('#wld-q-gate').innerHTML = '<span class="wld-db ' + gate[0] + '">' + gate[1] + '</span>';
      q('#wld-q-next').textContent = gate[0] === 'bad' ? '演示仍继续，现场应退回' : '0.125 m 采样 · 240 点 · 三曲线对齐';
      drawMini();
    }

    /* ------- 过程日志 ------- */
    function trace(step, html, cls) {
      TRACE.push({ step: step, html: html, cls: cls || '' });
      if (TRACE.length > 8) TRACE.shift();
      traceEl.innerHTML = TRACE.map(function (t) {
        return '<div><span class="t">' + t.step + '</span><span class="' + t.cls + '">' + t.html + '</span></div>';
      }).join('');
      traceEl.scrollTop = traceEl.scrollHeight;
    }
    function clearTrace() {
      TRACE = [];
      traceEl.innerHTML = '<div><span class="t">—</span><span>等待运行：点「运行全流程」，或直接点上面的阶段。</span></div>';
    }

    /* ------- 阶段 ------- */
    var STAGE_LABEL = ['01 采集', '02 特征', '03 模型', '04 分段', '05 闭环'];
    function cancelRun() {
      runTimers.forEach(function (t) { clearTimeout(t); });
      runTimers = [];
      var btn = q('[data-act="run"]');
      if (btn) { btn.disabled = false; btn.textContent = '▶ 运行全流程'; }
    }
    function setStage(i, log) {
      state.stage = i;
      [].forEach.call(root.querySelectorAll('.wld-stage'), function (p) {
        p.classList.toggle('on', Number(p.getAttribute('data-stage')) === i);
      });
      [].forEach.call(flowEl.children, function (b, idx) {
        b.classList.toggle('on', idx === i);
        b.classList.toggle('done', idx < i);
        b.setAttribute('aria-selected', idx === i ? 'true' : 'false');
      });
      if (log) trace(STAGE_LABEL[i].slice(0, 2), log);
    }

    function runAll() {
      cancelRun();
      clearTrace();
      var btn = q('[data-act="run"]');
      btn.disabled = true;
      btn.textContent = '运行中…';
      var meanBoundaryFeat = 0, meanNonFeat = 0, nb = 0, nn = 0;
      for (var fi = WIN; fi < N - WIN; fi++) {
        var f0 = featuresAt(well.x, fi, sig);
        var isB = false;
        for (var fj = 0; fj < well.cut.length; fj++) if (Math.abs(well.cut[fj] - fi) <= 1) { isB = true; break; }
        if (isB) { meanBoundaryFeat += f0[0]; nb++; } else { meanNonFeat += f0[0]; nn++; }
      }
      meanBoundaryFeat = nb ? meanBoundaryFeat / nb : 0;
      meanNonFeat = nn ? meanNonFeat / nn : 0;
      var ms = manualSummary();
      var steps = [
        ['01', '读取 1000—1030 m · 240 点 @0.125 m · GR/SP/RT · σ=' + state.noise + ' API · 缺失 <b>' + well.missing.length + '</b> 点已插值'],
        ['02', '滑窗 ±' + WIN + ' 点 → 5 维特征 · 边界窗 Δμ/σ 均值 <b>' + meanBoundaryFeat.toFixed(2) + '</b> · 非边界窗 <b>' + meanNonFeat.toFixed(2) + '</b>'],
        ['03', '逻辑回归 16 井训练 / 4 井验证 · 准确率 <b>' + (model.acc * 100).toFixed(1) + '%</b> · 边界召回 <b>' + (model.rec * 100).toFixed(1) + '%</b> · T=' + model.T.toFixed(2)],
        ['04', 'DP 最优分段 · β=' + state.beta.toFixed(2) + ' · 最小层厚 0.75 m · 输出 <b>' + det.length + '</b> 个界面 · 总代价 <b>' + dpSegment(pArr, state.beta).total.toFixed(1) + '</b>'],
        ['05', '人工仿真 ' + ms.count + ' 界面 / 平均偏离 <b>' + ms.mae.toFixed(2) + ' m</b> · AI 命中 <b>' + sc.tp + '/' + well.cut.length + '</b> · 复核 ' + det.filter(function (b) { return pArr[b] < 0.75; }).length + ' 个']
      ];
      var delays = [0, 850, 1700, 2550, 3400];
      steps.forEach(function (st, i) {
        runTimers.push(setTimeout(function () {
          setStage(i, null);
          trace(st[0], st[1]);
          if (i === steps.length - 1) {
            runTimers.push(setTimeout(function () {
              btn.disabled = false;
              btn.textContent = '▶ 重新运行';
              trace('✓', '流程完成：曲线 → 特征 → 边界概率 → DP 分段 → 人工确认，全部可复算。', 'ok');
            }, 700));
          }
        }, delays[i]));
      });
    }

    /* ------- 总绘制 ------- */
    function paint() {
      drawTrack(); drawMetrics(); drawHeader(); drawScan(); drawTable();
      drawStage01(); drawWin(); drawStage03(); drawStage04(); drawStage05();
      drawModel(); drawNote();
    }

    /* ------- 控件 ------- */
    function scheduleRecompute() {
      if (timerId) clearTimeout(timerId);
      timerId = setTimeout(function () {
        timerId = 0;
        recomputeWell(); paint();
      }, 70);
    }
    function scheduleDP() {
      if (rafId) return;
      rafId = requestAnimationFrame(function () {
        rafId = 0;
        recomputeDP(); paint();
      });
    }

    q('#wld-noise').addEventListener('input', function () {
      cancelRun();
      state.noise = +this.value;
      q('#wld-v-noise').textContent = this.value;
      scheduleRecompute();
    });
    q('#wld-layers').addEventListener('input', function () {
      cancelRun();
      state.layers = +this.value;
      q('#wld-v-layers').textContent = this.value;
      scheduleRecompute();
    });
    q('#wld-beta').addEventListener('input', function () {
      cancelRun();
      state.beta = +this.value;
      q('#wld-v-beta').textContent = (+this.value).toFixed(2);
      scheduleDP();
    });
    var trueBox = q('#wld-true');
    trueBox.addEventListener('change', function () {
      state.showTrue = trueBox.checked;
      trueBox.closest('label').classList.toggle('on', state.showTrue);
      drawTrack();
    });
    seedInput.addEventListener('change', function () {
      var v = parseInt(seedInput.value, 10);
      if (!isFinite(v) || v < 1) { seedInput.value = state.seed; return; }
      cancelRun();
      state.seed = v;
      seedInput.value = v;
      recomputeWell(); paint();
      trace('种子', '换到种子 <b>' + v + '</b> · 重算 01→04');
    });
    q('[data-act="new"]').addEventListener('click', function () {
      cancelRun();
      state.seed = Math.floor(Math.random() * 1e9);
      seedInput.value = state.seed;
      recomputeWell(); paint();
      trace('新井', '新建合成井 · 种子 <b>' + state.seed + '</b>');
    });
    q('[data-act="copy"]').addEventListener('click', function () {
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
    q('[data-act="reset"]').addEventListener('click', function () {
      cancelRun();
      state.seed = 20261022; state.layers = 10; state.noise = 8; state.beta = 0.7; state.showTrue = true;
      seedInput.value = state.seed;
      q('#wld-noise').value = '8'; q('#wld-v-noise').textContent = '8';
      q('#wld-layers').value = '10'; q('#wld-v-layers').textContent = '10';
      q('#wld-beta').value = '0.7'; q('#wld-v-beta').textContent = '0.70';
      trueBox.checked = true; trueBox.closest('label').classList.add('on');
      fb = { ok: 0, fix: 0, bad: 0 };
      recomputeWell(); paint(); setStage(0, false); clearTrace();
      trace('重置', '恢复默认井与参数 · 模型仍为本次页面训练结果', 'ok');
    });
    q('[data-act="run"]').addEventListener('click', runAll);
    flowEl.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      cancelRun();
      setStage(Number(b.getAttribute('data-s')), null);
    });
    q('#wld-feed').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      var k = b.getAttribute('data-fb');
      fb[k]++;
      drawStage05();
      var msg = k === 'ok' ? '人工确认：<b>分层正确</b> · 本井样本进入训练集'
        : k === 'fix' ? '人工修正：<b>1 处界面</b> · 进入错题集，下一轮重训优先看'
          : '<b>标为误判</b> · 本井进入错题集';
      trace('反馈', msg, k === 'ok' ? 'ok' : 'warn');
    });

    window.WelllogLayerDemoCleanup = function () {
      if (timerId) { clearTimeout(timerId); timerId = 0; }
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      runTimers.forEach(function (t) { clearTimeout(t); });
      runTimers = [];
    };

    /* ------- 初始化 ------- */
    recomputeWell();
    paint();
    setStage(0, false);
    clearTrace();
    trace('系统', '模型已在本页训练：16 口合成井 / 4 口按井验证 · 验证准确率 <b>' + (model.acc * 100).toFixed(1) +
      '%</b> · 边界召回 <b>' + (model.rec * 100).toFixed(1) + '%</b> · T=' + model.T.toFixed(2), 'ok');
  }

  window.WelllogLayerDemo = WelllogLayerDemo;

  /* 兼容 CaseDemoHost 的 module 模式：有 module/exports 时导出 mount。
     站点插件仍可直接调用 window.WelllogLayerDemo(root, ctx)。 */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      mount: function (root, api) {
        WelllogLayerDemo(root, api);
        return {
          unmount: function () {
            if (window.WelllogLayerDemoCleanup) window.WelllogLayerDemoCleanup();
          }
        };
      }
    };
  }
})();
