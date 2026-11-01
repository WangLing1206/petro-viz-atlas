/* =========================================================
   抽油机井工况智能诊断 · 可运行示范（v3 · AI 作业流）
   ---------------------------------------------------------
   这条流水线要回答的不是「这张图像什么」，而是：
     现场图 → 能否用 → 模型看到什么 → 判成什么 → 谁来负责
   ① 采集与质控：1 幅/冲次的示功图，先看噪声与量程；
   ② 归一化 + 7 维形态特征：位移、载荷归一，抽有物理含义的量；
   ③ 模型：6 类 softmax 回归（7 特征 + 7 平方项），本页现场训练，
      留出 20% 验证，给出损失曲线与混淆矩阵；
   ④ 决策：概率 + 置信度 + 次优类差距 → 自动派单 / 人工复核 / 转专家；
   ⑤ 闭环：人工确认回写，下一轮重训纳入；价值按全检口径算。
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

  /* 结蜡：摩擦阻力在上冲程抬高载荷、下冲程托住杆柱使载荷降低。 */
  var CLSCOL = { normal: '#123b3a', starved: '#a86a1f', gas: '#2b5570', travel: '#6f6636', fixed: '#7a5a3a', break: '#9c4235' };
  var WAX = { lift: 12, up: 0.10, down: -0.18 };

  var state = { cls: 'normal', noise: 0.15, wax: false, pcoord: null, stage: 0 };
  var lastF = null, lastPts = null, lastPred = null;
  var fb = { ok: 0, bad: 0 };

  /* ---------- 可复现随机数 ---------- */
  var RND = { a: 991 };
  function seedRnd(a) {
    a = Math.floor(a) % 2147483647;
    if (a <= 0) a += 2147483646;
    RND.a = a;
  }
  function rnd() { RND.a = (RND.a * 16807) % 2147483647; return RND.a / 2147483647; }
  function g() { return (rnd() + rnd() + rnd() - 1.5) * 1.2; }

  function ease(s) { return Math.min(1, Math.max(0, s / 0.18)); }

  /* ---------- 生成示功图：位移 0—1（归一化冲程），载荷 kN ---------- */
  function genFault(clsKey, wax, noise, amp, vari) {
    var c = CLASSES.filter(function (x) { return x.key === clsKey; })[0];
    var k = amp || 1;
    var rod = c.rod, liq = c.liquid, lUp = c.leakUp, lDown = c.leakDown, rip0 = c.ripple;
    /* 训练/验证时给每口井加一层「井况差异」：泵径、泵深、阀漏程度、
       结蜡强度都不是一个固定值。没有这层差异，模型会在合成集上虚高。 */
    if (vari) {
      rod *= 0.88 + rnd() * 0.24;
      liq *= 0.82 + rnd() * 0.36;
      lUp *= 0.78 + rnd() * 0.44;
      lDown *= 0.78 + rnd() * 0.44;
      rip0 *= 0.75 + rnd() * 0.50;
    }
    if (wax) { rod += WAX.lift * (vari ? 0.65 + rnd() * 0.70 : 1); }
    var N = 90, up = [], down = [];
    var Fmin = rod, Fmax = rod + liq, span = Math.max(2, Fmax - Fmin);
    var i, s;
    for (i = 0; i < N; i++) {
      s = i / (N - 1);
      var f = Fmin + span * ease(s);
      f += span * lUp * s;
      if (wax) f += span * WAX.up * s;
      if (c.key === 'gas') f += span * 0.05 * Math.sin(s * Math.PI * 6) * s;
      f += span * rip0 * g() * 2 + noise * 5.0 * g();
      up.push({ s: s, f: f * k });
    }
    for (i = N - 1; i >= 0; i--) {
      s = i / (N - 1);
      var f2 = Fmax - span * ease(1 - s);
      f2 += span * lDown * (1 - s);
      if (wax) f2 += span * WAX.down * (1 - s);
      if (c.key === 'gas') f2 += span * 0.05 * Math.sin(s * Math.PI * 5) * (1 - s);
      f2 += span * rip0 * g() * 2 + noise * 5.0 * g();
      down.push({ s: s, f: f2 * k });
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
    var rip = 0, count = 0;
    for (var j = 4; j < n - 4; j++) {
      var avg = 0;
      for (var k2 = j - 4; k2 <= j + 4; k2++) avg += up[k2].f;
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

  var PKEYS = ['rng', 'area', 'upMean', 'downMean', 'slopeUp', 'slopeDown', 'ripple'];
  var PLABEL = { rng: '载荷幅度', area: '环面积', upMean: '上冲程均载', downMean: '下冲程均载', slopeUp: '上冲程斜率', slopeDown: '下冲程斜率', ripple: '载荷波动' };

  var TPL = {};
  CLASSES.forEach(function (c, ci) {
    seedRnd(9000 + ci * 131);
    TPL[c.key] = features(genFault(c.key, false, 0, 1));
  });

  /* =========================================================
     模型：6 类 softmax 回归（7 特征 + 7 平方项）
     - 训练集：每类 100 幅，验证集：每类 20 幅（合成）
     - 现场训练，指标可复现；真实项目换成人工标签即可
     ========================================================= */
  function phi(f) {
    var base = PKEYS.map(function (k) { return f[k]; });
    var quad = PKEYS.map(function (k) { return f[k] * f[k]; });
    return base.concat(quad);
  }
  var DIM = PKEYS.length * 2, NCLS = CLASSES.length, TEMP = 1.12;
  function softmax(z) {
    var mx = Math.max.apply(null, z);
    var ex = z.map(function (v) { return Math.exp(v - mx); });
    var s = ex.reduce(function (a, b) { return a + b; }, 0);
    return ex.map(function (v) { return v / s; });
  }

  var MODEL = (function () {
    var train = [], val = [];
    CLASSES.forEach(function (c, ci) {
      for (var i = 0; i < 120; i++) {
        seedRnd(20261031 + ci * 100003 + i * 7919);
        var noise = 0.04 + rnd() * 0.62;
        var wax = c.key !== 'break' && rnd() < 0.24;
        var amp = 0.84 + rnd() * 0.30;
        var rec = { x: phi(features(genFault(c.key, wax, noise, amp, true))), y: ci };
        if (i < 100) train.push(rec); else val.push(rec);
      }
    });
    var mu = new Array(DIM), sd = new Array(DIM), j, n, k;
    for (j = 0; j < DIM; j++) {
      var s = 0;
      for (n = 0; n < train.length; n++) s += train[n].x[j];
      mu[j] = s / train.length;
      var v = 0;
      for (n = 0; n < train.length; n++) v += Math.pow(train[n].x[j] - mu[j], 2);
      sd[j] = Math.sqrt(v / train.length) || 1;
    }
    function std(x) { return x.map(function (v, j2) { return (v - mu[j2]) / sd[j2]; }); }
    for (n = 0; n < train.length; n++) train[n].x = std(train[n].x);
    for (n = 0; n < val.length; n++) val[n].x = std(val[n].x);

    var W = [], b = new Array(NCLS).fill(0), vW = [], vB = new Array(NCLS).fill(0);
    for (k = 0; k < NCLS; k++) {
      W.push(new Array(DIM).fill(0));
      vW.push(new Array(DIM).fill(0));
    }
    var lr = 0.06, l2 = 0.001, epochs = 320, hist = [], loss = 0;
    for (var ep = 0; ep < epochs; ep++) {
      var gW = [], gB = new Array(NCLS).fill(0);
      for (k = 0; k < NCLS; k++) gW.push(new Array(DIM).fill(0));
      loss = 0;
      for (n = 0; n < train.length; n++) {
        var rec = train[n], z = new Array(NCLS);
        for (k = 0; k < NCLS; k++) {
          var sum = b[k];
          for (j = 0; j < DIM; j++) sum += W[k][j] * rec.x[j];
          z[k] = sum;
        }
        var p = softmax(z);
        loss += -Math.log(Math.max(1e-9, p[rec.y]));
        for (k = 0; k < NCLS; k++) {
          /* 标签平滑：抑制 softmax 的过度自信，让置信度更接近现场可解释的水平 */
          var target = k === rec.y ? 0.975 : 0.025 / (NCLS - 1);
          var dlt = p[k] - target;
          gB[k] += dlt;
          for (j = 0; j < DIM; j++) gW[k][j] += dlt * rec.x[j];
        }
      }
      for (k = 0; k < NCLS; k++) {
        vB[k] = 0.9 * vB[k] - lr * gB[k] / train.length;
        b[k] += vB[k];
        for (j = 0; j < DIM; j++) {
          vW[k][j] = 0.9 * vW[k][j] - lr * (gW[k][j] / train.length + l2 * W[k][j]);
          W[k][j] += vW[k][j];
        }
      }
      if (ep % 10 === 0 || ep === epochs - 1) hist.push(loss / train.length);
    }

    function predictX(x) {
      var z = new Array(NCLS);
      for (var k2 = 0; k2 < NCLS; k2++) {
        var sum = b[k2];
        for (var j2 = 0; j2 < DIM; j2++) sum += W[k2][j2] * x[j2];
        z[k2] = sum;
      }
      var p = softmax(z.map(function (v) { return v / TEMP; }));
      var order = CLASSES.map(function (c, i) { return { key: c.key, name: c.name, p: p[i], i: i }; });
      order.sort(function (a2, b2) { return b2.p - a2.p; });
      return { p: p, order: order, z: z };
    }

    var ok = isFinite(loss);
    var conf = [], rowSum = new Array(NCLS).fill(0), correct = 0, review = 0;
    for (k = 0; k < NCLS; k++) conf.push(new Array(NCLS).fill(0));
    for (n = 0; n < val.length; n++) {
      var pr = predictX(val[n].x);
      var topI = pr.order[0].i;
      conf[val[n].y][topI]++;
      rowSum[val[n].y]++;
      if (topI === val[n].y) correct++;
      if (pr.order[0].p < 0.75) review++;
    }
    return {
      ok: ok, W: W, b: b, mu: mu, sd: sd, hist: hist, conf: conf,
      acc: correct / val.length, reviewRate: review / val.length,
      nTrain: train.length, nVal: val.length
    };
  })();

  function predict(f) {
    if (!MODEL.ok) return predictDist(f);
    var x = phi(f).map(function (v, j) { return (v - MODEL.mu[j]) / MODEL.sd[j]; });
    var r = (function () {
      var z = new Array(NCLS);
      for (var k = 0; k < NCLS; k++) {
        var sum = MODEL.b[k];
        for (var j = 0; j < DIM; j++) sum += MODEL.W[k][j] * x[j];
        z[k] = sum;
      }
      var p = softmax(z.map(function (v) { return v / TEMP; }));
      var order = CLASSES.map(function (c, i) { return { key: c.key, name: c.name, p: p[i], i: i }; });
      order.sort(function (a, b) { return b.p - a.p; });
      return { p: p, order: order, z: z };
    })();
    r.x = x;
    return r;
  }

  /* 训练异常时的回退：模板距离 + softmax（与旧版一致） */
  var RW = { rng: 1.5, area: 1.5, upMean: 1.2, downMean: 1.2, slopeUp: 1.3, slopeDown: 1.3, ripple: 1.0 };
  var RANGE = { rng: 0.18, area: 0.10, upMean: 0.14, downMean: 0.14, slopeUp: 0.22, slopeDown: 0.22, ripple: 0.05 };
  function predictDist(f) {
    var scores = CLASSES.map(function (c) {
      var t = TPL[c.key], d = 0;
      PKEYS.forEach(function (k) {
        var diff = (f[k] - t[k]) / RANGE[k];
        d += RW[k] * diff * diff;
      });
      return { key: c.key, name: c.name, i: CLASSES.indexOf(c), d: d };
    });
    var dmin = Math.min.apply(null, scores.map(function (x) { return x.d; }));
    var exps = scores.map(function (x) { return Math.exp(-(x.d - dmin) / 2.4); });
    var sum = exps.reduce(function (a, b) { return a + b; }, 0);
    scores.forEach(function (x, i) { x.p = exps[i] / sum; });
    scores.sort(function (a, b) { return b.p - a.p; });
    return { p: scores.map(function (x) { return x.p; }), order: scores };
  }

  var el = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  /* ---------- 绘图：示功图 ---------- */
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

    s += '<path d="' + pathOf(genFault(tplKey, false, 0, 1)) + '" fill="none" stroke="#1d4e50" stroke-width="1" stroke-dasharray="4 3" opacity=".5"/>';
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
    var idn = n - 1 - iu;
    var pu = up[iu], pd = down[Math.max(0, Math.min(n - 1, idn))];
    var xx = xs(sN);
    var html = '<line x1="' + xx + '" y1="' + GEO.T + '" x2="' + xx + '" y2="' + (GEO.H - GEO.B) + '" stroke="#b4762a" stroke-width=".8" stroke-dasharray="3 3" opacity=".7"/>' +
      '<circle cx="' + xx + '" cy="' + ys(pu.f) + '" r="2.6" fill="#123b3a"/>' +
      '<circle cx="' + xx + '" cy="' + ys(pd.f) + '" r="2.6" fill="#a86a1f"/>' +
      '<text x="' + Math.min(xx + 6, GEO.W - 108) + '" y="' + (GEO.T + 10) + '" font-size="9" font-family="monospace" fill="#45524d">' +
      'S ' + (sN * STROKE).toFixed(2) + ' m · 上 ' + pu.f.toFixed(1) + ' / 下 ' + pd.f.toFixed(1) + ' kN</text>';
    gEl.innerHTML = html;
  }

  /* ---------- 平行坐标 ---------- */
  function drawPcoord(f) {
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
    rows.forEach(function (r) {
      if (r.now) return;
      var hi = state.pcoord === r.key;
      var d = PKEYS.map(function (k, i) { return (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(k, r.v[k]).toFixed(1); }).join('');
      s += '<path d="' + d + '" fill="none" stroke="' + CLSCOL[r.key] + '" stroke-width="' + (hi ? 3 : 1.3) + '" opacity="' + (hi ? 1 : 0.42) + '" stroke-linejoin="round"/>';
      PKEYS.forEach(function (k, i) {
        s += '<circle cx="' + X(i).toFixed(1) + '" cy="' + Y(k, r.v[k]).toFixed(1) + '" r="' + (hi ? 2.6 : 1.6) + '" fill="' + CLSCOL[r.key] + '" opacity="' + (hi ? 1 : 0.5) + '"/>';
      });
    });
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

  /* ---------- 训练曲线 / 混淆矩阵 / 特征贡献 ---------- */
  function drawCurve() {
    var svg = el('curve');
    if (!svg) return;
    var W = 320, H = 96, L = 26, R = 6, T = 8, B = 16;
    var hist = MODEL.hist;
    var lo = Math.min.apply(null, hist), hi = Math.max.apply(null, hist);
    var pad = (hi - lo) * 0.15 || 0.01;
    lo = Math.max(0, lo - pad); hi += pad;
    function X(i) { return L + i * (W - L - R) / Math.max(1, hist.length - 1); }
    function Y(v) { return T + (1 - (v - lo) / (hi - lo)) * (H - T - B); }
    var s = '';
    [0, 0.5, 1].forEach(function (t) {
      var v = lo + (hi - lo) * t, y = Y(v);
      s += '<line x1="' + L + '" y1="' + y + '" x2="' + (W - R) + '" y2="' + y + '" stroke="#efece1"/>' +
        '<text x="' + (L - 3) + '" y="' + (y + 3) + '" text-anchor="end" font-size="7.5" font-family="monospace" fill="#99a3a4">' + v.toFixed(2) + '</text>';
    });
    var d = hist.map(function (v, i) { return (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1); }).join('');
    s += '<path d="' + d + '" fill="none" stroke="#1d4e50" stroke-width="1.8"/>';
    s += '<text x="' + (W - R) + '" y="' + (H - 2) + '" text-anchor="end" font-size="7.5" font-family="monospace" fill="#99a3a4">' + (MODEL.hist.length * 10 - 10) + ' epochs</text>';
    s += '<text x="' + L + '" y="' + (H - 2) + '" font-size="7.5" font-family="monospace" fill="#99a3a4">0</text>';
    svg.innerHTML = s;
  }

  function drawCM() {
    var KEYS = CLASSES.map(function (c) { return c.key; });
    var cm = '<span class="lb" style="font-size:8px">真实↓ / 预测→</span>' + KEYS.map(function (k) {
      return '<span style="text-align:center;color:var(--ink-4);font-size:8px">' + CLASSES.filter(function (c) { return c.key === k; })[0].name + '</span>';
    }).join('');
    MODEL.conf.forEach(function (r, i) {
      var sum = r.reduce(function (a, b) { return a + b; }, 0) || 1;
      cm += '<span class="lb">' + CLASSES[i].name + '</span>' +
        r.map(function (v) {
          var q = v / sum;
          var a = q > 0.5 ? 0.14 + q * 0.7 : q * 1.1;
          return '<i style="background:rgba(18,59,58,' + a.toFixed(2) + ');display:flex;align-items:center;justify-content:center;color:' + (q > 0.5 ? '#f3eee3' : '#45524d') + ';font-family:var(--mono);font-size:8px" title="' + (q * 100).toFixed(0) + '%">' + (q >= 0.05 ? Math.round(q * 100) : '') + '</i>';
        }).join('');
    });
    el('cm').innerHTML = cm;
  }

  function drawWeights(pr) {
    var top = pr.order[0];
    if (!MODEL.ok || !pr.x) { el('weights').innerHTML = '<p class="dfeed-note">模型回退到模板距离模式，无权重解释。</p>'; return; }
    var idx = CLASSES.findIndex(function (c) { return c.key === top.key; });
    var rows = PKEYS.map(function (k, j) {
      return { k: k, label: PLABEL[k], v: MODEL.W[idx][j] * pr.x[j] };
    });
    rows.sort(function (a, b) { return Math.abs(b.v) - Math.abs(a.v); });
    var max = Math.max.apply(null, rows.map(function (r) { return Math.abs(r.v); })) || 1;
    el('weights').innerHTML = rows.slice(0, 5).map(function (r) {
      var pos = r.v >= 0;
      var w = Math.abs(r.v) / max * 100;
      return '<div class="wrow"><span>' + r.label + '</span><span class="track"><i style="' + (pos ? 'left:0' : 'right:0') + ';width:' + w.toFixed(1) + '%;background:' + (pos ? 'var(--jade)' : 'var(--bad)') + '"></i></span><span class="val">' + (pos ? '+' : '') + r.v.toFixed(2) + '</span></div>';
    }).join('') + '<p class="dfeed-note" style="margin-top:4px">绿 = 把概率推高，红 = 拉低；只列绝对值最大的 5 项。</p>';
  }

  /* ---------- 过程日志 ---------- */
  var TRACE = [];
  function trace(step, html, cls) {
    TRACE.push({ step: step, html: html, cls: cls || '' });
    if (TRACE.length > 7) TRACE.shift();
    var box = el('trace');
    box.innerHTML = TRACE.map(function (t) {
      return '<div><span class="t">' + t.step + '</span><span class="' + t.cls + '">' + t.html + '</span></div>';
    }).join('');
    box.scrollTop = box.scrollHeight;
  }
  function clearTrace() { TRACE = []; el('trace').innerHTML = '<div><span class="t">—</span><span>等待运行：选好工况后点「运行诊断」，或直接点上面的步骤。</span></div>'; }

  /* ---------- 阶段控制 ---------- */
  var STAGE_LABEL = ['01 采集', '02 特征', '03 模型', '04 决策', '05 闭环'];
  var runTimers = [];
  function cancelRun() {
    runTimers.forEach(function (t) { clearTimeout(t); });
    runTimers = [];
    var btn = el('btn-run');
    if (btn) { btn.disabled = false; btn.textContent = '▶ 运行诊断'; }
  }
  function setStage(i, log) {
    state.stage = i;
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
    render();
    clearTrace();
    var btn = el('btn-run');
    btn.disabled = true;
    btn.textContent = '运行中…';
    var pr = lastPred, f = lastF;
    var top = pr.order[0], second = pr.order[1];
    var steps = [
      ['01', '读取 1 幅示功图 · 上/下冲程各 90 点 · 峰值 <b>' + Math.max.apply(null, lastPts.map(function (p) { return p.f; })).toFixed(1) + ' kN</b>'],
      ['02', '归一化 + 7 维特征 · 环面积 <b>' + (f.area * SCALE * STROKE).toFixed(0) + ' kJ</b> · 上均 <b>' + (f.upMean * SCALE).toFixed(1) + ' kN</b>'],
      ['03', 'softmax 分类器推理 · 6 类概率 · 验证准确率 <b>' + (MODEL.acc * 100).toFixed(1) + '%</b>'],
      ['04', '判定 <b>' + top.name + ' ' + (top.p * 100).toFixed(0) + '%</b> · 次优 ' + second.name + ' ' + (second.p * 100).toFixed(0) + '% · ' + (top.p >= 0.75 ? '<span class="ok">自动派单</span>' : '<span class="warn">转人工复核</span>')],
      ['05', '人工确认后回写 · 本轮回写 <b>' + (fb.ok + fb.bad) + '</b> 条 · 单幅推理 &lt; 1 ms']
    ];
    var delays = [0, 850, 1700, 2550, 3400];
    steps.forEach(function (s, i) {
      runTimers.push(setTimeout(function () {
        setStage(i, null);
        trace(s[0], s[1]);
        if (i === steps.length - 1) {
          runTimers.push(setTimeout(function () {
            btn.disabled = false;
            btn.textContent = '▶ 重新运行';
            trace('✓', '流水线完成：从一张图到一条可执行的派单建议。', 'ok');
          }, 700));
        }
      }, delays[i]));
    });
  }

  /* ---------- 渲染 ---------- */
  function renderInput(f, pts) {
    var fmax = Math.max.apply(null, pts.map(function (p) { return p.f; }));
    var fmin = Math.min.apply(null, pts.map(function (p) { return p.f; }));
    var span = Math.max(1, fmax - fmin);
    var snr = state.noise <= 0.001 ? 60 : 20 * Math.log(span / (state.noise * 3 + 0.01)) / Math.LN10;
    el('q-peak').textContent = fmax.toFixed(1) + ' kN';
    el('q-snr').innerHTML = snr.toFixed(0) + ' dB <span class="db ' + (snr >= 35 ? 'ok' : snr >= 25 ? 'warn' : 'bad') + '">' + (snr >= 35 ? '清晰' : snr >= 25 ? '可用' : '偏低') + '</span>';
    var gate = state.noise <= 0.35 && fmax < 105 ? ['ok', '可用 · 进入特征提取'] : state.noise <= 0.5 ? ['warn', '降级 · 建议复采后复核'] : ['bad', '退回重采 · 噪声淹没阀漏信号'];
    el('q-gate').innerHTML = '<span class="db ' + gate[0] + '">' + gate[1] + '</span>';
  }

  function renderFeats(f, topKey) {
    var t = TPL[topKey];
    el('feats').innerHTML = [
      ['载荷幅度 rng', f.rng.toFixed(3), t.rng.toFixed(3)],
      ['环面积 area', f.area.toFixed(4), t.area.toFixed(4)],
      ['上冲程均载', f.upMean.toFixed(3), t.upMean.toFixed(3)],
      ['下冲程均载', f.downMean.toFixed(3), t.downMean.toFixed(3)],
      ['上冲程斜率', f.slopeUp.toFixed(3), t.slopeUp.toFixed(3)],
      ['下冲程斜率', f.slopeDown.toFixed(3), t.slopeDown.toFixed(3)],
      ['载荷波动 ripple', f.ripple.toFixed(4), t.ripple.toFixed(4)]
    ].map(function (r) {
      return '<div style="display:grid;grid-template-columns:1fr 62px 62px;gap:8px;font-size:11px;padding:5px 0;border-bottom:1px solid var(--line)">' +
        '<span style="color:var(--ink-3)">' + r[0] + '</span><span class="mono" style="text-align:right;color:var(--ink)">' + r[1] + '</span>' +
        '<span class="mono" style="text-align:right;color:var(--ink-4)">' + r[2] + '</span></div>';
    }).join('') +
      '<div style="display:grid;grid-template-columns:1fr 62px 62px;gap:8px;font-size:10px;padding-top:5px;color:var(--ink-4)"><span>特征（按 100 kN 归一）</span><span style="text-align:right">实测</span><span style="text-align:right">判定模板</span></div>';
  }

  function renderDecision(pr, f) {
    var top = pr.order[0], second = pr.order[1];
    var margin = top.p - second.p;
    var auto = top.p >= 0.75 && margin >= 0.15 && !state.wax;
    var review = !auto && top.p >= 0.5;
    var mode = auto ? ['ok', '自动派单'] : review ? ['warn', '人工复核'] : ['bad', '转专家'];
    var advice = CLASSES.filter(function (c) { return c.key === top.key; })[0];
    var level = auto ? 'ok' : review ? 'warn' : 'bad';

    el('probs').innerHTML = pr.order.map(function (p, i) {
      return '<div class="dbar" data-k="' + p.key + '" style="padding:4px 0"><span style="width:66px;font-size:11px;color:' + (i === 0 ? 'var(--ink)' : 'var(--ink-3)') + '">' + p.name + '</span>' +
        '<span class="track"><i style="width:' + (p.p * 100).toFixed(1) + '%;background:' + (i === 0 ? 'var(--jade)' : 'var(--line-3)') + '"></i></span>' +
        '<span class="val">' + (p.p * 100).toFixed(0) + '%</span></div>';
    }).join('');
    [].forEach.call(document.querySelectorAll('#probs [data-k]'), function (row) {
      row.addEventListener('mouseenter', function () { state.pcoord = row.getAttribute('data-k'); if (lastF) drawPcoord(lastF); });
      row.addEventListener('mouseleave', function () { state.pcoord = null; if (lastF) drawPcoord(lastF); });
    });

    el('advice').innerHTML =
      '<div style="display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-bottom:7px">' +
      '<span class="db ' + mode[0] + '">' + mode[1] + '</span>' +
      '<span style="font-size:12.5px"><b>' + top.name + '</b>（' + Math.round(top.p * 100) + '%）</span>' +
      '<span class="small muted" style="font-size:10px;color:var(--ink-4)">次优 ' + second.name + ' ' + Math.round(second.p * 100) + '% · 差距 ' + Math.round(margin * 100) + ' pts</span></div>' +
      '<p style="font-size:11.5px;color:var(--ink-2);line-height:1.7">' +
      (auto ? advice.tip : review
        ? '置信度或次优类差距不足，单幅图不足以定论。建议调取同井最近 3—5 个冲程的示功图与载荷差趋势，结合套压、液面与产量核实。' +
          ' 当前模型给的是 <b>' + top.name + '</b>，但人工必须先排除 ' + second.name + '。'
        : '模型拒绝给出高置信度结论。这类样本应转专家，并把人工结论回写为新的训练样本。') + '</p>' +
      '<table class="dtable" style="margin-top:6px"><tbody>' +
      '<tr><td>p ≥ 0.75 且差距 ≥ 15</td><td><span class="db ok">自动派单</span></td></tr>' +
      '<tr><td>0.50 ≤ p &lt; 0.75</td><td><span class="db warn">人工复核</span></td></tr>' +
      '<tr><td>p &lt; 0.50 或叠加结蜡</td><td><span class="db bad">转专家</span></td></tr>' +
      '</tbody></table>' +
      (state.wax ? '<div class="callout warn" style="margin:9px 0 0;padding:9px 11px;font-size:11px"><span class="ci">注意</span><span>结蜡使上冲程载荷抬高、下冲程载荷降低，容易被误判为阀漏。现场要靠 <b>多日载荷差趋势</b> 与洗井/热洗记录区分，不能只看单幅图。</span></div>' : '');
  }

  function render() {
    var ci = CLASSES.findIndex(function (c) { return c.key === state.cls; });
    seedRnd(1000 + ci * 97 + Math.round(state.noise * 100) + (state.wax ? 7 : 0));
    var pts = genFault(state.cls, state.wax, state.noise, 1);
    lastPts = pts;
    var f = features(pts);
    lastF = f;
    var pr = predict(f);
    lastPred = pr;
    var top = pr.order[0];
    var truth = CLASSES[ci];

    drawDyn(pts, top.key);
    el('dyn-hint').textContent = truth.name + (state.wax ? ' + 结蜡干扰' : '') + ' · 噪声 ' + state.noise.toFixed(2);

    el('st-verdict').textContent = top.name;
    el('st-conf').innerHTML = (top.p > 0.995 ? (top.p * 100).toFixed(1) : Math.round(top.p * 100)) + '<small>%</small>';
    el('st-acc').innerHTML = (MODEL.acc * 100).toFixed(1) + '<small>%</small>';
    el('st-review').innerHTML = (MODEL.reviewRate * 100).toFixed(1) + '<small>%</small>';

    renderInput(f, pts);
    renderFeats(f, top.key);
    drawPcoord(f);
    drawCurve();
    drawCM();
    drawWeights(pr);
    renderDecision(pr, f);

    el('m-n').textContent = MODEL.nTrain + ' / ' + MODEL.nVal;
    el('m-acc').innerHTML = (MODEL.acc * 100).toFixed(1) + '%';
    el('m-summary').innerHTML = '准确率 <b>' + (MODEL.acc * 100).toFixed(1) + '%</b> · 复核 <b>' + (MODEL.reviewRate * 100).toFixed(1) + '%</b> · 单幅 &lt; 1 ms';
    el('m-badge').textContent = MODEL.ok ? '已训练' : '回退模板';
    el('m-badge').className = 'db ' + (MODEL.ok ? 'ok' : 'warn');

    el('fb-note').textContent = '回写 ' + (fb.ok + fb.bad) + ' 条' + (fb.bad ? ' · 其中误判 ' + fb.bad + ' 条' : '') + ' · 人工确认后才进入下一轮训练';

    var auto = top.p >= 0.75 && (top.p - pr.order[1].p) >= 0.15 && !state.wax;
    var correct = top.key === state.cls;
    el('note').innerHTML = state.wax
      ? '叠加结蜡后，上冲程载荷抬高、下冲程载荷降低，特征「上/下冲程斜率」同时改变，模型在 <b>正常 / 固定阀漏</b> 之间的概率开始分散。流程此时会把样本送人工，而不是硬给一个结论——这就是「模型 + 规则 + 人」的分工。'
      : (correct
        ? '判定正确（' + Math.round(top.p * 100) + '%）。' + (auto
          ? '置信度和次优类差距都过线，系统可以直接派单；人工只需抽检。'
          : '但置信度/差距没有过线，系统仍会把它送人工复核——<b>判对不等于可以自动执行</b>。')
        : '判定与设定的真实工况不一致：当前图形落到了两类工况之间（复合特征），置信度 ' + Math.round(top.p * 100) + '%。这类井会被标成「低置信度、需人工复核」——把不确定的交给人才是负责任的做法。');

    return { f: f, pr: pr };
  }

  /* ---------- 控件 ---------- */
  el('seg-fault').innerHTML = CLASSES.map(function (c) {
    return '<button data-c="' + c.key + '" class="' + (c.key === state.cls ? 'on' : '') + '">' + c.name + '</button>';
  }).join('');
  el('seg-fault').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    cancelRun();
    state.cls = b.getAttribute('data-c');
    [].forEach.call(el('seg-fault').children, function (x) { x.classList.toggle('on', x === b); });
    render();
    var truth = CLASSES.filter(function (c) { return c.key === state.cls; })[0];
    trace('样本', '切换到真实工况 <b>' + truth.name + '</b> · 噪声 ' + state.noise.toFixed(2) + (state.wax ? ' · 结蜡' : ''));
  });

  var rn = el('r-noise');
  rn.addEventListener('input', function () {
    cancelRun();
    state.noise = Number(rn.value);
    el('o-noise').textContent = state.noise.toFixed(2);
    render();
  });

  var tw = el('tog-wax');
  tw.setAttribute('role', 'switch');
  tw.setAttribute('aria-checked', 'false');
  tw.setAttribute('tabindex', '0');
  function toggleWax() {
    cancelRun();
    state.wax = !state.wax;
    tw.classList.toggle('on', state.wax);
    tw.setAttribute('aria-checked', state.wax ? 'true' : 'false');
    render();
    trace('样本', state.wax ? '叠加结蜡干扰：看上/下冲程斜率如何被带偏。' : '移除结蜡干扰。');
  }
  tw.addEventListener('click', toggleWax);
  tw.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleWax(); } });

  el('btn-run').addEventListener('click', runAll);

  el('btn-reset').addEventListener('click', function () {
    cancelRun();
    state.cls = 'normal'; state.noise = 0.15; state.wax = false; state.pcoord = null;
    rn.value = '0.15'; el('o-noise').textContent = '0.15';
    tw.classList.remove('on'); tw.setAttribute('aria-checked', 'false');
    [].forEach.call(el('seg-fault').children, function (x) { x.classList.toggle('on', x.getAttribute('data-c') === 'normal'); });
    fb = { ok: 0, bad: 0 };
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
    fb[k]++;
    el('fb-note').textContent = '回写 ' + (fb.ok + fb.bad) + ' 条' + (fb.bad ? ' · 其中误判 ' + fb.bad + ' 条' : '') + ' · 人工确认后才进入下一轮训练';
    trace('反馈', k === 'ok' ? '人工确认：<b>诊断正确</b> · 样本进入训练集' : '<b>标为误判</b> · 样本进入错题集，下一轮重训优先看', k === 'ok' ? 'ok' : 'warn');
  });

  var dyn = el('dyn');
  dyn.addEventListener('pointermove', drawHover);
  dyn.addEventListener('pointerleave', function () { var gEl = document.getElementById('dyn-hover'); if (gEl) gEl.innerHTML = ''; });

  /* ---------- 启动 ---------- */
  clearTrace();
  render();
  setStage(0, false);
  trace('系统', '模型已在本页训练：' + MODEL.nTrain + ' 幅训练 / ' + MODEL.nVal + ' 幅验证 · 验证准确率 <b>' + (MODEL.acc * 100).toFixed(1) + '%</b>', 'ok');
})();
