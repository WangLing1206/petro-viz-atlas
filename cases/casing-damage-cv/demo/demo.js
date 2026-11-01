/* =========================================================
   套管完整性智能判读 · 可运行示范（v3 · AI 作业流）
   ---------------------------------------------------------
   套管：5-1/2" 17 lb/ft（OD 139.7 mm、壁厚 7.72 mm、
         名义内径 124.0 mm、API 5CT 通径 121.1 mm）
   仪器：16 臂井径 + 成像展开，0.1 m 一个深度点
   ---------------------------------------------------------
   这条流水线要回答的不是「这段曲线像什么」，而是：
     原始井径 → 能不能用 → 模型看到什么 → 判成什么 → 谁来负责
   ① 采集与质控：16 臂读数先做逐臂中位偏心/臂差校正，
      统计偏心、噪声、缺失臂与有效弧覆盖；不合格段降级；
   ② 特征：沿深度滑 1.2 m 窗，把 16 臂展开成 12×16 patch，
      归一化到名义内径，抽内偏/外扩/椭圆度/中心偏移/弧覆盖；
   ③ 模型：5 类、每类 5 个支持 patch 的小样本原型分类器，
      余弦相似度 + 温度缩放 softmax；留一井验证与混淆矩阵
      在本页实时计算；
   ④ 决策：检测阈值 + 未知拒识 + 同类候选段合并 + 严重度分级
      + 人工复核队列；
   ⑤ 闭环：人工确认/纠正后把 patch 加进支持集，原型实时更新；
      价值按 620 井次/年的案例口径单列，不与本页合成结果混用。
   本页是 2000 m 合成单井；所有模型参数、相似度、概率、
   混淆矩阵都在浏览器里现算，不是写死的概率表。
   ========================================================= */
(function () {
  'use strict';

  var ARMS = 16, NZ = 20000, DEPTH = 2000, DZ = DEPTH / NZ;
  var R0 = 62.0;            // 名义内半径 mm
  var WALL = 7.72;          // 壁厚 mm
  var DRIFT = 121.1 / 2;    // 通径半径 mm
  var PATCH_WIN = 1.2;      // 滑窗长度 m
  var PATCH_BINS = 12;      // 窗内深度分箱
  var EPS = 0.02;            // 概率平滑，避免 100%
  var TH = [];
  for (var i = 0; i < ARMS; i++) TH.push(i * Math.PI * 2 / ARMS);

  var CLASSES = [
    { key: 'normal', name: '正常', short: '正常', tip: '井径接近名义内径，弧覆盖完整。' },
    { key: 'corrosion', name: '腐蚀减薄', short: '腐蚀', tip: '局部扇区金属损失：少数连续臂外扩，中心偏移小。' },
    { key: 'squeeze', name: '挤压变形', short: '挤压', tip: '两侧对称内缩：椭圆度上升，中心偏移通常不大。' },
    { key: 'hole', name: '穿孔', short: '穿孔', tip: '0.3—0.6 m 窄段、1—2 支臂突然外弹，深度方向很尖。' },
    { key: 'shear', name: '错断', short: '错断', tip: '井筒中心横向偏移：一侧内径变大、对侧变小。' }
  ];
  var CKEYS = CLASSES.map(function (c) { return c.key; });
  var NAME = {};
  CLASSES.forEach(function (c) { NAME[c.key] = c.name; });
  var CLSCOL = {
    normal: '#6c7872', corrosion: '#a86a1f', squeeze: '#123b3a',
    hole: '#9c4235', shear: '#2b5570'
  };
  var TIPS = {
    normal: '正常但置信度不足，不能自动排除；人工看一眼原始曲线最稳妥。',
    corrosion: '按壁厚损失率分级（<20 / 20—50 / >50%）；结合成像灰度确认损失扇区。',
    squeeze: '按椭圆度分级（<3 / 3—8 / >8%）；先核对通径，判断工具能否通过。',
    hole: '窄段穿孔优先复测与堵漏/换管；按壁厚损失率分级。',
    shear: '按中心偏移分级（<2 / 2—5 / >5 mm）；错断段必须安排修井。'
  };

  /* 主井：4 个已知损伤段 + 2 个接箍/结垢类干扰 + 1 段缺失臂 */
  var ZONES = [
    { type: 'corrosion', d0: 300, d1: 342 },
    { type: 'corrosion', d0: 640, d1: 654, mild: true },
    { type: 'squeeze', d0: 760, d1: 842 },
    { type: 'hole', d0: 1180, d1: 1180.6 },
    { type: 'shear', d0: 1562, d1: 1592 }
  ];
  var SIG_ZONES = ZONES.filter(function (z) { return !z.mild; });
  var MISS_ARM = 10;        // 0 起的第 11 臂
  var MISS_D0 = 1562, MISS_D1 = 1596;   // 缺臂恰好压在错断段上：模型再自信也要降级复核

  var state = {
    type: 'all', sev: 0.55, thr: 2.0, noise: true,
    cursor: 1180, stage: 0, mode: 'seg', sel: null, freeDepth: 1180
  };
  var fb = { ok: 0, fix: 0 };

  /* ---------- 可复现随机数 ---------- */
  function mkRnd(seed) {
    var a = Math.floor(Math.abs(seed)) % 2147483647;
    if (a <= 0) a += 2147483646;
    return function () { a = (a * 16807) % 2147483647; return a / 2147483647; };
  }
  function gauss(rnd) {
    var s = 0;
    for (var q = 0; q < 4; q++) s += rnd();
    return (s - 2) / 0.577350269;
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function taper(t) { return 0.5 - 0.5 * Math.cos(Math.PI * clamp(t, 0, 1)); }
  function angDiff(a, b) {
    var d = Math.abs(a - b) % (Math.PI * 2);
    return Math.min(d, Math.PI * 2 - d);
  }
  function norm(v) {
    var s = 0;
    for (var j = 0; j < v.length; j++) s += v[j] * v[j];
    return Math.sqrt(s) || 1;
  }
  function dot(a, b) {
    var s = 0;
    for (var j = 0; j < a.length; j++) s += a[j] * b[j];
    return s;
  }

  /* ---------- 合成：统一施加损伤形态 ---------- */
  function applyZone(grid, dz, zn) {
    var nz = grid.length, d0 = zn.d0, d1 = zn.d1;
    var edge = zn.edge || Math.max(0.2, (d1 - d0) * 0.25);
    for (var z = 0; z < nz; z++) {
      var d = z * dz;
      if (d < d0 || d > d1) continue;
      var f = Math.min(taper((d - d0) / edge), taper((d1 - d) / edge));
      if (f <= 0) continue;
      for (var a = 0; a < ARMS; a++) {
        if (zn.type === 'corrosion') {
          grid[z][a] += zn.amp * f * Math.exp(-Math.pow(angDiff(TH[a], zn.angle) / zn.sigma, 2));
        } else if (zn.type === 'squeeze') {
          var inw = 0.15 + 0.85 * Math.max(0, Math.cos(2 * (TH[a] - zn.angle)));
          grid[z][a] -= zn.amp * f * inw;
        } else if (zn.type === 'hole') {
          if (zn.arms.indexOf(a) >= 0) grid[z][a] += zn.amp * f;
        } else if (zn.type === 'shear') {
          grid[z][a] += zn.amp * f * Math.cos(TH[a] - zn.angle);
        } else if (zn.type === 'coupling') {
          grid[z][a] -= zn.amp * f;
        } else if (zn.type === 'scale') {
          grid[z][a] += zn.amp * f * Math.exp(-Math.pow(angDiff(TH[a], zn.angle) / zn.sigma, 2));
        }
      }
    }
  }

  function genMain(sev, noiseOn) {
    var rnd = mkRnd(20261031 + Math.round(sev * 1000) + (noiseOn ? 7 : 0));
    var ecc = noiseOn ? 0.55 : 0;
    var noise = noiseOn ? 0.18 : 0.035;
    var armBias = [], phase = rnd() * Math.PI * 2;
    for (var a = 0; a < ARMS; a++) armBias.push((rnd() - 0.5) * 0.6);
    var grid = [];
    for (var z = 0; z < NZ; z++) {
      var row = [];
      for (var b = 0; b < ARMS; b++) {
        row.push(R0 + armBias[b] + ecc * Math.cos(TH[b] - phase) + noise * gauss(rnd));
      }
      grid.push(row);
    }
    var A = {
      corrosion: 1.4 + 4.8 * sev,
      squeeze: 1.2 + 8.5 * sev,
      hole: 2.6 + 6.5 * sev,
      shear: 1.4 + 5.5 * sev
    };
    [
      { type: 'corrosion', d0: 300, d1: 342, angle: Math.PI / 2, sigma: 0.85, amp: A.corrosion, edge: 2.0 },
      /* 轻度腐蚀：默认 Δ=2.0 时低于阈值，用来演示「阈值漏检」与自由查询复核 */
      { type: 'corrosion', d0: 640, d1: 654, angle: Math.PI / 2, sigma: 0.85, amp: A.corrosion * 0.45, edge: 2.0 },
      { type: 'squeeze', d0: 760, d1: 842, angle: 0, amp: A.squeeze, edge: 6.0 },
      { type: 'hole', d0: 1180, d1: 1180.6, angle: Math.PI / 2, arms: [3, 4], amp: A.hole, edge: 0.08 },
      { type: 'shear', d0: 1562, d1: 1592, angle: 0, amp: A.shear, edge: 0.3 },
      /* 接箍与结垢是现场最常见的两类假候选：默认阈值下不出现，往下拖才会冒出来 */
      { type: 'coupling', d0: 499.8, d1: 500.3, amp: 1.5, edge: 0.08 },
      { type: 'scale', d0: 1099.7, d1: 1100.2, angle: Math.PI / 4, sigma: 0.8, amp: 1.1, edge: 0.05 }
    ].forEach(function (zn) { applyZone(grid, DZ, zn); });
    var m0 = Math.round(MISS_D0 / DZ), m1 = Math.round(MISS_D1 / DZ);
    for (var zi = m0; zi < m1; zi++) grid[zi][MISS_ARM] = NaN;
    return { grid: grid, armBias: armBias, phase: phase, ecc: ecc, noise: noise };
  }

  /* 支持井：5 口短井，每口都带 5 类已知 patch；用于 5-shot 支持集与留一井验证 */
  function genBankWell(cfg) {
    var nz = 200, dz = DZ;
    var rnd = mkRnd(cfg.seed);
    var armBias = [], phase = rnd() * Math.PI * 2;
    for (var a = 0; a < ARMS; a++) armBias.push((rnd() - 0.5) * 0.8);
    var grid = [];
    for (var z = 0; z < nz; z++) {
      var row = [];
      for (var b = 0; b < ARMS; b++) {
        row.push(R0 + armBias[b] + cfg.ecc * Math.cos(TH[b] - phase) + cfg.noise * gauss(rnd));
      }
      grid.push(row);
    }
    var cw = 4.0;
    var cz = {
      type: 'corrosion', d0: cw, d1: cw + 1.6 + rnd() * 1.0,
      angle: rnd() * Math.PI * 2, sigma: 0.6 + rnd() * 0.45,
      amp: (1.4 + 4.8 * 0.5) * cfg.amp * (0.9 + rnd() * 0.2) * (cfg.mildCorrosion ? 0.5 : 1)
    };
    cz.edge = Math.min(0.9, (cz.d1 - cz.d0) / 3);
    var sq = {
      type: 'squeeze', d0: 7.6, d1: 7.6 + 1.6 + rnd() * 1.2,
      angle: rnd() * Math.PI * 2,
      amp: (1.2 + 8.5 * 0.5) * cfg.amp * (0.9 + rnd() * 0.2)
    };
    sq.edge = 0.7;
    var hw = cfg.holeWide ? (0.55 + rnd() * 0.15) : (0.3 + rnd() * 0.25);
    var hAng = rnd() * Math.PI * 2;
    var hi = Math.floor(hAng / (Math.PI * 2) * ARMS) % ARMS;
    var hArms = [hi];
    if (rnd() < 0.6) hArms.push((hi + 1) % ARMS);
    var hl = {
      type: 'hole', d0: 12.6, d1: 12.6 + hw, angle: hAng, arms: hArms,
      amp: (2.6 + 6.5 * 0.5) * cfg.amp * (0.9 + rnd() * 0.2)
    };
    hl.edge = 0.08;
    var sh = {
      type: 'shear', d0: 15.5, d1: 15.5 + 0.8 + rnd() * 0.8,
      angle: rnd() * Math.PI * 2,
      amp: (1.4 + 5.5 * 0.5) * cfg.amp * (0.9 + rnd() * 0.2)
    };
    sh.edge = 0.4;
    [cz, sq, hl, sh].forEach(function (zn) { applyZone(grid, dz, zn); });
    return {
      id: cfg.id,
      grid: grid,
      centers: {
        normal: 1.5,
        corrosion: (cz.d0 + cz.d1) / 2,
        squeeze: (sq.d0 + sq.d1) / 2,
        hole: (hl.d0 + hl.d1) / 2,
        shear: (sh.d0 + sh.d1) / 2
      }
    };
  }

  /* ---------- 质控：逐臂中位偏移（臂差 + 偏心）校正 ---------- */
  function qcCorrect(grid) {
    var nz = grid.length, off = [], a, z;
    for (a = 0; a < ARMS; a++) {
      var vals = [];
      for (z = 0; z < nz; z++) {
        var row = grid[z], v = row[a];
        if (!isFinite(v)) continue;
        var s = 0, n = 0;
        for (var q = 0; q < ARMS; q++) {
          if (isFinite(row[q])) { s += row[q]; n++; }
        }
        if (n) vals.push(v - s / n);
      }
      vals.sort(function (x, y) { return x - y; });
      off.push(vals.length ? vals[Math.floor(vals.length / 2)] : 0);
    }
    var corr = [], missing = 0, total = 0, missArms = {};
    for (z = 0; z < nz; z++) {
      var row2 = [];
      for (a = 0; a < ARMS; a++) {
        total++;
        var v2 = grid[z][a];
        if (isFinite(v2)) {
          row2.push(v2 - off[a]);
        } else {
          row2.push(NaN);
          missing++;
          if (!missArms[a]) missArms[a] = [z, z];
          else missArms[a][1] = z;
        }
      }
      corr.push(row2);
    }
    /* 逐深度算残差 RMS，再取中位数：4 个损伤段只占 2% 深度，
       用全井 RMS 会被损伤本身的 5—10 mm 偏差抬高，误判成噪声大。 */
    var rmsList = [];
    for (z = 0; z < nz; z += 5) {
      var rr = corr[z], s2 = 0, n2 = 0;
      for (a = 0; a < ARMS; a++) {
        if (isFinite(rr[a])) { s2 += rr[a]; n2++; }
      }
      if (n2 < 8) continue;
      var m = s2 / n2, ss = 0;
      for (a = 0; a < ARMS; a++) {
        if (isFinite(rr[a])) ss += (rr[a] - m) * (rr[a] - m);
      }
      rmsList.push(Math.sqrt(ss / n2));
    }
    rmsList.sort(function (x, y) { return x - y; });
    var noiseRms = rmsList.length ? rmsList[Math.floor(rmsList.length / 2)] : 0;
    var eccAmp = (Math.max.apply(null, off) - Math.min.apply(null, off)) / 2;
    return {
      corr: corr, off: off, eccAmp: eccAmp, noiseRms: noiseRms,
      coverage: 1 - missing / Math.max(1, total),
      missingCells: missing, missArms: missArms,
      missingDepthFrac: missing / Math.max(1, nz * ARMS)
    };
  }

  /* ---------- 特征：缺失臂先按相邻臂插值，再算统计量 ---------- */
  function fillRow(row) {
    var out = row.slice(), valid = 0, a;
    for (a = 0; a < ARMS; a++) if (isFinite(row[a])) valid++;
    if (valid === 0) {
      for (a = 0; a < ARMS; a++) out[a] = R0;
      return { row: out, valid: 0 };
    }
    if (valid === ARMS) return { row: out, valid: 1 };
    for (a = 0; a < ARMS; a++) {
      if (isFinite(out[a])) continue;
      var l = 1, r = 1;
      while (l < ARMS && !isFinite(row[(a - l + ARMS) % ARMS])) l++;
      while (r < ARMS && !isFinite(row[(a + r) % ARMS])) r++;
      var lv = row[(a - l + ARMS) % ARMS];
      var rv = row[(a + r) % ARMS];
      out[a] = (lv * r + rv * l) / (l + r);
    }
    return { row: out, valid: valid / ARMS };
  }

  function smooth(arr, rad) {
    var out = [], n = arr.length;
    for (var z = 0; z < n; z++) {
      var lo = Math.max(0, z - rad), hi = Math.min(n - 1, z + rad), acc = 0;
      for (var q = lo; q <= hi; q++) acc += arr[q];
      out.push(acc / (hi - lo + 1));
    }
    return out;
  }

  function features(corr) {
    var nz = corr.length;
    var F = { davg: [], dmin: [], dmax: [], ov: [], devIn: [], devOut: [], off: [], valid: [] };
    for (var z = 0; z < nz; z++) {
      var fr = fillRow(corr[z]), row = fr.row;
      var sum = 0, mn = 1e9, mx = -1e9, cx = 0, cy = 0;
      for (var a = 0; a < ARMS; a++) {
        var r = row[a];
        sum += r;
        if (r < mn) mn = r;
        if (r > mx) mx = r;
        cx += r * Math.cos(TH[a]);
        cy += r * Math.sin(TH[a]);
      }
      var avg = sum / ARMS;
      F.davg.push(avg); F.dmin.push(mn); F.dmax.push(mx);
      F.ov.push((mx - mn) / avg);
      F.devIn.push(Math.max(0, R0 - mn));
      F.devOut.push(Math.max(0, mx - R0));
      F.off.push(Math.hypot(cx / ARMS, cy / ARMS));
      F.valid.push(fr.valid);
    }
    ['davg', 'dmin', 'dmax', 'ov', 'devIn', 'devOut', 'off'].forEach(function (k) {
      F[k] = smooth(F[k], 2);
    });
    return F;
  }

  function metricAt(F, z) {
    var ovalEq = Math.max(0, F.ov[z] - 0.012) * R0 / 2;
    return Math.max(F.devIn[z], F.devOut[z], ovalEq, F.off[z]);
  }

  function detect(F, thr) {
    var M = new Array(NZ);
    for (var z = 0; z < NZ; z++) M[z] = metricAt(F, z);
    var segs = [], z2 = 0, MINPTS = Math.max(3, Math.round(0.3 / DZ));
    while (z2 < NZ) {
      if (M[z2] > thr) {
        var s = z2;
        while (z2 < NZ && M[z2] > thr) z2++;
        var e = z2 - 1;
        if (e - s + 1 >= MINPTS) segs.push({ z0: s, z1: e, d0: s * DZ, d1: e * DZ, width: (e - s + 1) * DZ, peak: 0 });
      } else z2++;
    }
    segs.forEach(function (sg) {
      for (var q = sg.z0; q <= sg.z1; q++) if (M[q] > sg.peak) sg.peak = M[q];
    });
    return segs;
  }

  /* ---------- Patch：12 个深度箱 × 16 臂 ---------- */
  function fillDevRow(row) {
    var out = row.slice(), cnt = 0, a;
    for (a = 0; a < ARMS; a++) if (isFinite(row[a])) cnt++;
    if (cnt === 0) {
      for (a = 0; a < ARMS; a++) out[a] = 0;
      return { row: out, valid: 0 };
    }
    if (cnt === ARMS) return { row: out, valid: 1 };
    for (a = 0; a < ARMS; a++) {
      if (isFinite(out[a])) continue;
      var l = 1, r = 1;
      while (l < ARMS && !isFinite(row[(a - l + ARMS) % ARMS])) l++;
      while (r < ARMS && !isFinite(row[(a + r) % ARMS])) r++;
      var lv = row[(a - l + ARMS) % ARMS];
      var rv = row[(a + r) % ARMS];
      out[a] = (lv * r + rv * l) / (l + r);
    }
    return { row: out, valid: cnt / ARMS };
  }

  function patchAt(corr, center) {
    var nz = corr.length, half = PATCH_WIN / 2;
    var zStart = (center - half) / DZ, zEnd = (center + half) / DZ;
    var devs = [], validCells = 0;
    for (var b = 0; b < PATCH_BINS; b++) {
      var za = zStart + (zEnd - zStart) * b / PATCH_BINS;
      var zb = zStart + (zEnd - zStart) * (b + 1) / PATCH_BINS;
      var i0 = Math.max(0, Math.floor(za));
      var i1 = Math.min(nz - 1, Math.max(i0, Math.ceil(zb) - 1));
      var row = [];
      for (var a = 0; a < ARMS; a++) {
        var s = 0, n = 0;
        for (var z = i0; z <= i1; z++) {
          var v = corr[z][a];
          if (isFinite(v)) { s += v - R0; n++; }
        }
        row.push(n ? s / n : NaN);
        validCells += n ? 1 : 0;
      }
      devs.push(row);
    }
    for (var b2 = 0; b2 < PATCH_BINS; b2++) {
      var fr = fillDevRow(devs[b2]);
      devs[b2] = fr.row;
    }
    var armMean = [], armMin = [], armMax = [];
    for (var a2 = 0; a2 < ARMS; a2++) {
      var sum = 0, mn = 1e9, mx = -1e9;
      for (var b3 = 0; b3 < PATCH_BINS; b3++) {
        var d = devs[b3][a2];
        sum += d;
        if (d < mn) mn = d;
        if (d > mx) mx = d;
      }
      armMean.push(sum / PATCH_BINS);
      armMin.push(mn);
      armMax.push(mx);
    }
    var minCell = 0, maxCell = 0, minArm = 1e9, maxArm = -1e9;
    for (var b4 = 0; b4 < PATCH_BINS; b4++) {
      for (var a3 = 0; a3 < ARMS; a3++) {
        var v2 = devs[b4][a3];
        if (v2 < minCell) minCell = v2;
        if (v2 > maxCell) maxCell = v2;
      }
    }
    var cx = 0, cy = 0;
    for (var a4 = 0; a4 < ARMS; a4++) {
      if (armMean[a4] < minArm) minArm = armMean[a4];
      if (armMean[a4] > maxArm) maxArm = armMean[a4];
      cx += (R0 + armMean[a4]) * Math.cos(TH[a4]);
      cy += (R0 + armMean[a4]) * Math.sin(TH[a4]);
    }
    var inMax = Math.max(0, -minCell), outMax = Math.max(0, maxCell);
    var peak = Math.max(inMax, outMax);
    var oval = (maxArm - minArm) / R0;
    var off = Math.hypot(cx / ARMS, cy / ARMS);
    var arcIn = 0, arcOut = 0;
    for (var a5 = 0; a5 < ARMS; a5++) {
      if (armMean[a5] < -0.5) arcIn++;
      if (armMean[a5] > 0.5) arcOut++;
    }
    var th = Math.max(0.6, peak * 0.35), wb = 0;
    for (var b5 = 0; b5 < PATCH_BINS; b5++) {
      var hit = false;
      for (var a6 = 0; a6 < ARMS; a6++) {
        if (Math.abs(devs[b5][a6]) > th) { hit = true; break; }
      }
      if (hit) wb++;
    }
    var width = Math.max(0.1, wb * (PATCH_WIN / PATCH_BINS));
    return {
      dev: devs, center: center, win: PATCH_WIN, bins: PATCH_BINS,
      armMean: armMean, armMin: armMin, armMax: armMax,
      inMax: inMax, outMax: outMax, peak: peak, oval: oval, off: off,
      arcIn: arcIn / ARMS, arcOut: arcOut / ARMS,
      width: width, sharp: peak / Math.max(0.15, width),
      validFrac: validCells / (PATCH_BINS * ARMS)
    };
  }

  /* 向量对旋转不变：先把 16 臂的均值偏差/深度差排序，再拼摘要特征。
     现场损伤相对仪器臂号的方位是随机的，不排序会让「错断」类原型
     在求均值时互相抵消——这不是模型该学的差异。 */
  var VLEN = ARMS * 2 + 8;
  function toVec(p) {
    var v = new Array(VLEN), a;
    var sorted = p.armMean.slice().sort(function (x, y) { return x - y; });
    var ranges = p.armMax.map(function (x, i) { return x - p.armMin[i]; }).sort(function (x, y) { return x - y; });
    for (a = 0; a < ARMS; a++) v[a] = clamp(sorted[a] / 3, -2, 2);
    for (a = 0; a < ARMS; a++) v[ARMS + a] = clamp(ranges[a] / 6, 0, 2);
    v[32] = clamp(p.inMax / 6, 0, 2);
    v[33] = clamp(p.outMax / 6, 0, 2);
    v[34] = clamp(p.oval / 0.05, 0, 2);
    v[35] = clamp(p.off / 2.5, 0, 2);
    v[36] = p.arcIn;
    v[37] = p.arcOut;
    v[38] = clamp(p.sharp / 25, 0, 2);
    v[39] = 1;                       // 背景维：正常 patch 的偏差接近 0，靠它形成稳定方向
    var n = norm(v);
    return v.map(function (x) { return x / n; });
  }

  function meanPatch(list) {
    var bins = list[0].dev.length, out = [];
    for (var b = 0; b < bins; b++) {
      var row = [];
      for (var a = 0; a < ARMS; a++) {
        var s = 0, n = 0;
        for (var q = 0; q < list.length; q++) {
          var v = list[q].dev[b][a];
          if (isFinite(v)) { s += v; n++; }
        }
        row.push(n ? s / n : 0);
      }
      out.push(row);
    }
    return { dev: out, center: list[0].center, bins: bins, validFrac: 1 };
  }

  function protoOf(list) {
    var sum = new Array(VLEN).fill(0);
    list.forEach(function (s) {
      for (var j = 0; j < VLEN; j++) sum[j] += s.vec[j];
    });
    var mean = sum.map(function (x) { return x / list.length; });
    var n = norm(mean);
    return {
      vec: mean.map(function (x) { return x / n; }),
      n: list.length,
      patch: meanPatch(list.map(function (s) { return s.patch; }))
    };
  }

  /* 支持井：W4 偏低幅度、W5 穿孔偏宽，用来暴露真实边界 */
  var BANK_CFG = [
    { id: 'W1', seed: 1101, amp: 1.05, noise: 0.13, ecc: 0.42 },
    { id: 'W2', seed: 2203, amp: 0.88, noise: 0.18, ecc: 0.60 },
    { id: 'W3', seed: 3307, amp: 1.16, noise: 0.10, ecc: 0.30 },
    { id: 'W4', seed: 4409, amp: 0.45, noise: 0.20, ecc: 0.55, mildCorrosion: true },
    { id: 'W5', seed: 5503, amp: 0.95, noise: 0.15, ecc: 0.40, holeWide: true }
  ];
  var BANK = BANK_CFG.map(function (cfg) {
    var well = genBankWell(cfg);
    var qc = qcCorrect(well.grid);
    var patches = {};
    CKEYS.forEach(function (k) { patches[k] = patchAt(qc.corr, well.centers[k]); });
    return { id: cfg.id, qc: qc, patches: patches };
  });

  var SUP0 = {};
  CKEYS.forEach(function (k) {
    SUP0[k] = BANK.map(function (w) {
      return { well: w.id, patch: w.patches[k], vec: toVec(w.patches[k]) };
    });
  });
  function cloneSup(src) {
    var o = {};
    CKEYS.forEach(function (k) {
      o[k] = src[k].map(function (s) { return { well: s.well, patch: s.patch, vec: s.vec }; });
    });
    return o;
  }
  var SUP = cloneSup(SUP0);
  var PROTOS = null;

  function rebuildProtos() {
    PROTOS = {};
    CKEYS.forEach(function (k) { PROTOS[k] = protoOf(SUP[k]); });
  }
  rebuildProtos();

  function softmaxT(sims, T) {
    var mx = Math.max.apply(null, sims);
    var ex = sims.map(function (s) { return Math.exp((s - mx) / T); });
    var sum = ex.reduce(function (a, b) { return a + b; }, 0);
    return ex.map(function (v) { return v / sum; });
  }
  function calibrated(sims) {
    var q = softmaxT(sims, TEMP);
    var K = q.length;
    return q.map(function (v) { return (1 - EPS) * v + EPS / K; });
  }

  function predictFromVec(v) {
    var sims = CKEYS.map(function (k) { return dot(v, PROTOS[k].vec); });
    var p = calibrated(sims);
    var order = CLASSES.map(function (c, i) {
      return { key: c.key, name: c.name, i: i, sim: sims[i], p: p[i] };
    });
    order.sort(function (a, b) { return b.p - a.p; });
    return { v: v, sims: sims, p: p, order: order, top: order[0], second: order[1], margin: order[0].p - order[1].p };
  }
  function predictPatch(p) { return predictFromVec(toVec(p)); }

  /* 留一井验证：5 口支持井轮流留出，每类用其余 4 个 patch 建原型 */
  function validateBank() {
    var conf = [], correct = 0, n = 0, logits = [];
    for (var i = 0; i < CLASSES.length; i++) conf.push(new Array(CLASSES.length).fill(0));
    for (var w = 0; w < BANK.length; w++) {
      var foldProtos = {};
      CKEYS.forEach(function (k) {
        var subset = SUP0[k].filter(function (s) { return s.well !== BANK[w].id; });
        foldProtos[k] = protoOf(subset);
      });
      for (var ci = 0; ci < CLASSES.length; ci++) {
        var key = CLASSES[ci].key;
        var v = toVec(BANK[w].patches[key]);
        var sims = CKEYS.map(function (k) { return dot(v, foldProtos[k].vec); });
        var top = 0;
        for (var q = 1; q < sims.length; q++) if (sims[q] > sims[top]) top = q;
        conf[ci][top]++;
        if (top === ci) correct++;
        logits.push({ sims: sims, y: ci });
        n++;
      }
    }
    /* 温度缩放：在验证 logits 上网格搜索负对数似然。
       下限 0.10：合成验证集太干净时 NLL 会把 T 压到 0.05，
       概率全部贴到 98%，失去「低置信度」这一层信息。 */
    var bestT = 0.12, bestNll = 1e9;
    for (var T = 0.10; T <= 0.6001; T += 0.005) {
      var nll = 0;
      logits.forEach(function (o) {
        var p = softmaxT(o.sims, T);
        nll += -Math.log(Math.max(1e-7, p[o.y]));
      });
      if (nll < bestNll) { bestNll = nll; bestT = T; }
    }
    bestT = Math.round(bestT * 1000) / 1000;
    var covered = 0, coveredOk = 0;
    logits.forEach(function (o) {
      var q = softmaxT(o.sims, bestT);
      var p = q.map(function (v) { return (1 - EPS) * v + EPS / q.length; });
      var top = 0;
      for (var j = 1; j < p.length; j++) if (p[j] > p[top]) top = j;
      if (p[top] >= 0.75) { covered++; if (top === o.y) coveredOk++; }
    });
    return {
      conf: conf, acc: correct / n, n: n, T: bestT, nll: bestNll / n,
      coverage: covered / n, coverageAcc: covered ? coveredOk / covered : 0
    };
  }

  var VAL = validateBank();
  var TEMP = VAL.T;
  var DATA = null, LAST = null;

  /* ---------- 流水线：候选 → 分类 → 合并 → 分级 → 分流 ---------- */
  function gradeOf(p, type) {
    if (type === 'corrosion' || type === 'hole') {
      var loss = p.outMax / WALL * 100;
      var g = loss < 20 ? '轻' : loss < 50 ? '中' : '重';
      return { grade: g, rank: g === '轻' ? 1 : g === '中' ? 2 : 3, metric: '壁厚损失 ' + loss.toFixed(0) + '% · 峰值外扩 ' + p.outMax.toFixed(1) + ' mm' };
    }
    if (type === 'squeeze') {
      var ov = p.oval * 100;
      var g2 = ov < 3 ? '轻' : ov < 8 ? '中' : '重';
      return { grade: g2, rank: g2 === '轻' ? 1 : g2 === '中' ? 2 : 3, metric: '椭圆度 ' + ov.toFixed(1) + '% · 峰值内缩 ' + p.inMax.toFixed(1) + ' mm' };
    }
    if (type === 'shear') {
      var off = p.off;
      var g3 = off < 2 ? '轻' : off < 5 ? '中' : '重';
      return { grade: g3, rank: g3 === '轻' ? 1 : g3 === '中' ? 2 : 3, metric: '中心偏移 ' + off.toFixed(1) + ' mm · 峰值内缩 ' + p.inMax.toFixed(1) + ' mm' };
    }
    return { grade: '—', rank: 0, metric: '' };
  }

  function decideSeg(seg) {
    var p = seg.pr.order[0].p;
    var margin = p - seg.pr.order[1].p;
    var qcOK = seg.patch.validFrac >= 0.975;
    var reasons = [];
    if (!qcOK) reasons.push('弧覆盖 ' + (seg.patch.validFrac * 100).toFixed(1) + '%（缺臂段插值）');
    if (seg.pr.order[0].key === 'normal') {
      return { k: 'review', label: '未定型复核', db: 'warn', reason: 'top 正常但 p=' + Math.round(p * 100) + '% < 85%，不能自动排除' };
    }
    if (p >= 0.75 && margin >= 0.12 && qcOK) {
      return { k: 'auto', label: '自动交付', db: 'ok', reason: 'p≥0.75 且次优差≥12 pts' };
    }
    if (p < 0.55 || margin < 0.08) {
      return { k: 'unknown', label: '拒识转专家', db: 'bad', reason: 'p<0.55 或次优差<8 pts' + (reasons.length ? ' · ' + reasons.join(' · ') : '') };
    }
    return { k: 'review', label: '人工复核', db: 'warn', reason: 'p=' + Math.round(p * 100) + '% · 差距 ' + Math.round(margin * 100) + ' pts' + (reasons.length ? ' · ' + reasons.join(' · ') : '') };
  }

  function evalSegs(segs, truth) {
    var hit = 0, typeOk = 0;
    truth.forEach(function (zn) {
      var m = segs.filter(function (s) { return s.d0 <= zn.d1 + 1 && s.d1 >= zn.d0 - 1; });
      if (m.length) {
        hit++;
        if (m.some(function (s) { return s.type === zn.type; })) typeOk++;
      }
    });
    var fp = segs.filter(function (s) {
      return !ZONES.some(function (zn) { return s.d0 <= zn.d1 + 1 && s.d1 >= zn.d0 - 1; });
    }).length;
    return { truth: truth.length, hit: hit, typeOk: typeOk, fp: fp };
  }

  function computePipeline(d) {
    var raw = detect(d.F, state.thr);
    var cands = raw.map(function (sg) {
      var center = (sg.d0 + sg.d1) / 2;
      var patch = patchAt(d.corr, center);
      var pr = predictPatch(patch);
      return { d0: sg.d0, d1: sg.d1, center: center, width: sg.width, patch: patch, pr: pr, rawSeg: sg };
    });
    var dismissed = 0, kept = [];
    cands.forEach(function (c) {
      /* 正常类高置信才自动排除；正常但 p<0.85 的候选留着进复核队列 */
      if (c.pr.order[0].key === 'normal' && c.pr.order[0].p >= 0.85) dismissed++;
      else kept.push(c);
    });
    kept.sort(function (a, b) { return a.d0 - b.d0; });
    var groups = [];
    kept.forEach(function (c) {
      var last = groups[groups.length - 1];
      var lastKey = last ? last.parts[last.parts.length - 1].pr.order[0].key : null;
      if (last && (c.d0 - last.d1) <= 3.0 && lastKey === c.pr.order[0].key) {
        last.d1 = c.d1;
        last.parts.push(c);
      } else {
        groups.push({ d0: c.d0, d1: c.d1, parts: [c] });
      }
    });
    var final = [];
    groups.forEach(function (g) {
      var center = (g.d0 + g.d1) / 2;
      var patch = patchAt(d.corr, center);
      var pr = predictPatch(patch);
      if (pr.order[0].key === 'normal' && pr.order[0].p >= 0.85) { dismissed++; return; }
      var type = pr.order[0].key;
      var gr = gradeOf(patch, type);
      var seg = {
        id: 'S' + (final.length + 1), d0: g.d0, d1: g.d1, center: center,
        width: g.d1 - g.d0, patch: patch, pr: pr, type: type, typeName: NAME[type],
        grade: gr.grade, rank: gr.rank, metric: gr.metric, parts: g.parts
      };
      seg.action = decideSeg(seg);
      seg.sevScore = seg.rank * 100 + pr.order[0].p * 10 + patch.peak;
      final.push(seg);
    });
    final.forEach(function (s, idx) { s.id = 'S' + (idx + 1); });
    var view = state.type === 'all' ? final.slice() : final.filter(function (s) { return s.type === state.type; });
    var ranked = view.slice().sort(function (a, b) { return b.sevScore - a.sevScore; });
    var truth = ZONES.filter(function (zn) { return state.type === 'all' || zn.type === state.type; });
    var stat = evalSegs(view, truth);
    var counts = { auto: 0, review: 0, unknown: 0 };
    view.forEach(function (s) { counts[s.action.k]++; });
    var mildZone = ZONES.filter(function (z) { return z.mild; })[0];
    var mildSeg = final.filter(function (s) { return s.d0 <= mildZone.d1 + 1 && s.d1 >= mildZone.d0 - 1; })[0];
    var mildPr = null;
    if (!mildSeg) {
      mildPr = predictPatch(patchAt(d.corr, (mildZone.d0 + mildZone.d1) / 2));
    }
    return {
      raw: raw, cands: cands, final: final, view: view, ranked: ranked,
      dismissed: dismissed, stat: stat, counts: counts, truth: truth,
      mild: { zone: mildZone, seg: mildSeg || null, pr: mildPr }
    };
  }

  function ensureData() {
    var key = state.sev.toFixed(2) + '|' + (state.noise ? '1' : '0');
    if (DATA && DATA.key === key) return DATA;
    var well = genMain(state.sev, state.noise);
    var qc = qcCorrect(well.grid);
    var F = features(qc.corr);
    DATA = { key: key, well: well, qc: qc, corr: qc.corr, F: F, img: null };
    return DATA;
  }

  function ensureSelection(P) {
    var viewIds = P.view.map(function (s) { return s.id; });
    if (state.mode === 'seg') {
      if (viewIds.indexOf(state.sel) < 0) {
        if (P.ranked.length) {
          state.sel = P.ranked[0].id;
          state.cursor = P.ranked[0].center;
        } else {
          state.mode = 'free';
          state.freeDepth = state.cursor;
        }
      }
    }
  }

  function currentQuery(P, d) {
    if (state.mode === 'free') {
      var fp = patchAt(d.corr, state.freeDepth);
      return {
        kind: 'free', center: state.freeDepth, patch: fp, pr: predictPatch(fp),
        label: '自由查询 ' + state.freeDepth.toFixed(1) + ' m'
      };
    }
    var seg = P.view.filter(function (s) { return s.id === state.sel; })[0];
    if (!seg) {
      seg = P.ranked[0];
    }
    if (!seg) {
      state.mode = 'free';
      return currentQuery(P, d);
    }
    state.sel = seg.id;
    return { kind: 'seg', seg: seg, center: seg.center, patch: seg.patch, pr: seg.pr, label: '候选段 ' + seg.id };
  }

  var el = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function pct(v) { return Math.round(v * 100) + '<small>%</small>'; }

  /* ---------- 主画布 ---------- */
  var cv = document.getElementById('log');
  var ctx = cv.getContext('2d');
  var Hc = 430, Wc = 0, DPR = Math.min(2, window.devicePixelRatio || 1);
  var G = {};
  var COL = {
    ink: '#16231f', ink3: '#6c7872', ink4: '#98a199', line: '#ddd4c1',
    jade: '#123b3a', arm: 'rgba(80,100,95,.40)', bad: '#9c4235',
    warn: '#a86a1f', ok: '#2f6b4f'
  };

  function layout() {
    Wc = cv.clientWidth || 680;
    cv.width = Math.round(Wc * DPR);
    cv.height = Math.round(Hc * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    G.L = 50; G.T = 16; G.B = 26; G.R = 10;
    var usable = Wc - G.L - G.R;
    G.curveW = Math.round(usable * 0.56);
    G.gap = 14;
    G.imgX = G.L + G.curveW + G.gap;
    G.imgW = Math.max(80, Wc - G.R - G.imgX - 42);
    G.sx = function (r) { return G.L + (r - 38) / 34 * G.curveW; };
    G.sy = function (dep) { return G.T + dep / DEPTH * (Hc - G.T - G.B); };
    G.dy = function (y) { return (y - G.T) / (Hc - G.T - G.B) * DEPTH; };
  }

  function ramp(dev) {
    var t = Math.max(-1, Math.min(1, dev / 8));
    var w = [251, 248, 240];
    if (t < 0) {
      var u = -t;
      return [Math.round(w[0] + (18 - w[0]) * u), Math.round(w[1] + (59 - w[1]) * u), Math.round(w[2] + (58 - w[2]) * u)];
    }
    var v = t;
    return [Math.round(w[0] + (156 - w[0]) * v), Math.round(w[1] + (66 - w[1]) * v), Math.round(w[2] + (53 - w[2]) * v)];
  }

  function imagingCanvas(d) {
    if (d.img) return d.img;
    var rows = 2200, cols = 64, stepZ = Math.max(1, Math.floor(NZ / rows));
    var off = document.createElement('canvas');
    off.width = cols; off.height = rows;
    var octx = off.getContext('2d');
    var imgd = octx.createImageData(cols, rows);
    for (var zi = 0; zi < rows; zi++) {
      var z = Math.min(NZ - 1, zi * stepZ);
      var row = fillRow(d.corr[z]).row;
      for (var c = 0; c < cols; c++) {
        var ang = c / cols * Math.PI * 2;
        var f = ang / (Math.PI * 2) * ARMS, i0 = Math.floor(f) % ARMS, i1 = (i0 + 1) % ARMS, w = f - Math.floor(f);
        var r = row[i0] * (1 - w) + row[i1] * w;
        var col = ramp(r - R0);
        var p = (zi * cols + c) * 4;
        imgd.data[p] = col[0]; imgd.data[p + 1] = col[1]; imgd.data[p + 2] = col[2]; imgd.data[p + 3] = 255;
      }
    }
    octx.putImageData(imgd, 0, 0);
    d.img = off;
    return off;
  }

  function draw(view, F, q) {
    layout();
    ctx.clearRect(0, 0, Wc, Hc);
    ctx.fillStyle = '#fdfbf5';
    ctx.fillRect(G.L, G.T, G.curveW, Hc - G.T - G.B);
    ctx.fillRect(G.imgX, G.T, G.imgW, Hc - G.T - G.B);

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(imagingCanvas(DATA), G.imgX, G.T, G.imgW, Hc - G.T - G.B);
    ctx.imageSmoothingEnabled = true;

    /* 色标 */
    var cbX = G.imgX + G.imgW + 8, cbW = 8;
    for (var yy = 0; yy < 120; yy++) {
      var cc = ramp(8 - yy / 120 * 16);
      ctx.fillStyle = 'rgb(' + cc.join(',') + ')';
      ctx.fillRect(cbX, G.T + yy, cbW, 1.2);
    }
    ctx.strokeStyle = COL.line; ctx.strokeRect(cbX, G.T, cbW, 120);
    ctx.fillStyle = COL.ink4; ctx.font = '8px ui-monospace,monospace'; ctx.textAlign = 'left';
    ctx.fillText('+8', cbX + cbW + 2, G.T + 8);
    ctx.fillText('0', cbX + cbW + 2, G.T + 62);
    ctx.fillText('-8', cbX + cbW + 2, G.T + 118);
    ctx.fillText('mm', cbX, G.T + 134);

    /* 深度 / 半径网格 */
    ctx.font = '9px ui-monospace, monospace';
    ctx.fillStyle = COL.ink4;
    ctx.strokeStyle = '#eee8da';
    ctx.textAlign = 'right';
    for (var d = 0; d <= DEPTH; d += 200) {
      var y = G.sy(d);
      ctx.beginPath(); ctx.moveTo(G.L, y); ctx.lineTo(G.imgX + G.imgW, y); ctx.stroke();
      ctx.fillText(d + ' m', G.L - 5, y + 3);
    }
    ctx.textAlign = 'center';
    for (var rr = 40; rr <= 70; rr += 5) {
      var xt = G.sx(rr);
      ctx.fillStyle = '#eee8da';
      ctx.beginPath(); ctx.moveTo(xt, G.T); ctx.lineTo(xt, Hc - G.B); ctx.stroke();
      ctx.fillStyle = COL.ink4;
      ctx.fillText(rr.toFixed(0), xt, Hc - G.B + 13);
    }
    ctx.fillText('半径 mm', G.L + G.curveW / 2, Hc - 6);

    /* 缺失臂区段 */
    Object.keys(DATA.qc.missArms).forEach(function (k) {
      var iv = DATA.qc.missArms[k];
      var d0 = iv[0] * DZ, d1 = iv[1] * DZ;
      var y0 = G.sy(d0), y1 = G.sy(d1);
      ctx.fillStyle = 'rgba(108,120,114,.12)';
      ctx.fillRect(G.L, y0, G.imgX + G.imgW - G.L, Math.max(2, y1 - y0));
      ctx.strokeStyle = 'rgba(108,120,114,.5)';
      ctx.setLineDash([2, 2]);
      ctx.beginPath(); ctx.moveTo(G.L, y0); ctx.lineTo(G.imgX + G.imgW, y0); ctx.moveTo(G.L, y1); ctx.lineTo(G.imgX + G.imgW, y1); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = COL.ink3;
      ctx.textAlign = 'left';
      ctx.font = '8px ui-monospace,monospace';
      ctx.fillText('臂 ' + (Number(k) + 1) + ' 缺失 ' + d0.toFixed(0) + '—' + d1.toFixed(0) + ' m', G.imgX + 4, Math.max(G.T + 9, y0 + 9));
    });

    /* 检出候选段 */
    view.forEach(function (sg) {
      var y0 = G.sy(sg.d0), y1 = G.sy(sg.d1), hh = Math.max(4, y1 - y0);
      ctx.save();
      ctx.globalAlpha = 0.10;
      ctx.fillStyle = CLSCOL[sg.type];
      ctx.fillRect(G.L, y0, G.imgX + G.imgW - G.L, hh);
      ctx.restore();
      ctx.strokeStyle = CLSCOL[sg.type];
      ctx.globalAlpha = 0.55;
      ctx.beginPath();
      ctx.moveTo(G.L, y0); ctx.lineTo(G.imgX + G.imgW, y0);
      ctx.moveTo(G.L, y1); ctx.lineTo(G.imgX + G.imgW, y1);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = CLSCOL[sg.type];
      ctx.textAlign = 'left';
      ctx.font = '9px ui-monospace, monospace';
      var lab = sg.typeName + ' ' + sg.grade + ' · ' + Math.round(sg.pr.order[0].p * 100) + '%';
      if (sg.action.k !== 'auto') lab += ' · ' + (sg.action.k === 'unknown' ? '拒识' : '复核');
      var labY = sg.patch.validFrac < 0.975 ? Math.min(Hc - G.B - 3, y1 + 11) : Math.max(G.T + 9, y0 - 3);
      ctx.fillText(lab, G.L + 4, labY);
    });

    /* 16 条曲线（跳过缺失臂的 NaN） */
    var stepD = Math.max(1, Math.floor(NZ / 2600));
    ctx.lineWidth = 1;
    for (var a = 0; a < ARMS; a++) {
      ctx.strokeStyle = COL.arm;
      ctx.beginPath();
      var started = false;
      for (var z3 = 0; z3 < NZ; z3 += stepD) {
        var rv = DATA.corr[z3][a];
        if (!isFinite(rv)) { started = false; continue; }
        var x = G.sx(rv), y2 = G.sy(z3 * DZ);
        if (!started) { ctx.moveTo(x, y2); started = true; } else ctx.lineTo(x, y2);
      }
      ctx.stroke();
    }
    /* 名义内径 */
    ctx.strokeStyle = COL.jade;
    ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(G.sx(R0), G.T); ctx.lineTo(G.sx(R0), Hc - G.B); ctx.stroke();
    ctx.setLineDash([]);
    /* 平均内径 */
    ctx.strokeStyle = COL.jade;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    for (var z4 = 0; z4 < NZ; z4 += stepD) {
      var x2 = G.sx(F.davg[z4]), y3 = G.sy(z4 * DZ);
      if (z4 === 0) ctx.moveTo(x2, y3); else ctx.lineTo(x2, y3);
    }
    ctx.stroke();
    ctx.lineWidth = 1;
    /* 通径线 */
    ctx.strokeStyle = 'rgba(168,106,31,.55)';
    ctx.setLineDash([2, 4]);
    ctx.beginPath(); ctx.moveTo(G.sx(DRIFT), G.T); ctx.lineTo(G.sx(DRIFT), Hc - G.B); ctx.stroke();
    ctx.setLineDash([]);

    /* 当前查询窗口：选中段或自由深度 */
    var qc0 = q.kind === 'seg' ? q.seg.center : q.center;
    var wy0 = G.sy(qc0 - PATCH_WIN / 2), wy1 = G.sy(qc0 + PATCH_WIN / 2);
    ctx.strokeStyle = COL.warn;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(G.L + 1, wy0, G.imgX + G.imgW - G.L - 2, Math.max(3, wy1 - wy0));
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
    ctx.fillStyle = COL.warn;
    ctx.textAlign = 'left';
    ctx.font = '8.5px ui-monospace,monospace';
    ctx.fillText('patch 1.2 m', G.L + 4, Math.min(Hc - G.B - 3, wy1 + 10));

    /* 游标 */
    var cy = G.sy(state.cursor);
    ctx.strokeStyle = COL.warn;
    ctx.lineWidth = 1.3;
    ctx.beginPath(); ctx.moveTo(G.L, cy); ctx.lineTo(G.imgX + G.imgW, cy); ctx.stroke();
    ctx.fillStyle = COL.warn;
    ctx.beginPath(); ctx.moveTo(G.L, cy - 4); ctx.lineTo(G.L + 7, cy); ctx.lineTo(G.L, cy + 4); ctx.closePath(); ctx.fill();
    ctx.lineWidth = 1;
    ctx.textAlign = 'left';
    ctx.font = '9.5px ui-monospace, monospace';
    ctx.fillText(state.cursor.toFixed(0) + ' m', G.L + 10, Math.max(G.T + 10, cy - 4));
  }

  /* ---------- 井筒截面 ---------- */
  function drawSect(d) {
    var z = clamp(Math.round(state.cursor / DZ), 0, NZ - 1);
    var row = fillRow(d.corr[z]).row;
    var k = 1.08;
    var s = '<circle cx="100" cy="100" r="76" fill="#fff" stroke="#ddd4c1"/>';
    s += '<circle cx="100" cy="100" r="' + (R0 * k).toFixed(1) + '" fill="none" stroke="#123b3a" stroke-width="1" stroke-dasharray="4 3"/>';
    s += '<circle cx="100" cy="100" r="' + (DRIFT * k).toFixed(1) + '" fill="none" stroke="#b4762a" stroke-width=".8" stroke-dasharray="2 4" opacity=".7"/>';
    var cx = 0, cy = 0, dp = '';
    for (var a = 0; a < ARMS; a++) {
      var r = row[a] * k;
      var x = 100 + r * Math.cos(TH[a] - Math.PI / 2);
      var y = 100 + r * Math.sin(TH[a] - Math.PI / 2);
      dp += (a ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
      cx += row[a] * Math.cos(TH[a]);
      cy += row[a] * Math.sin(TH[a]);
    }
    s += '<path d="' + dp + ' Z" fill="rgba(18,59,58,.06)" stroke="#4f6066" stroke-width="1.2"/>';
    for (var a2 = 0; a2 < ARMS; a2++) {
      var rr = row[a2] * k;
      s += '<circle cx="' + (100 + rr * Math.cos(TH[a2] - Math.PI / 2)).toFixed(1) + '" cy="' + (100 + rr * Math.sin(TH[a2] - Math.PI / 2)).toFixed(1) + '" r="1.8" fill="#6c7872"/>';
    }
    var ocx = 100 + cx / ARMS * k, ocy = 100 + cy / ARMS * k;
    s += '<path d="M100 100L' + ocx.toFixed(1) + ' ' + ocy.toFixed(1) + '" stroke="#a86a1f" stroke-width="1" stroke-dasharray="2 2"/>';
    s += '<circle cx="' + ocx.toFixed(1) + '" cy="' + ocy.toFixed(1) + '" r="2.2" fill="#a86a1f"/>';
    var p = patchAt(d.corr, state.cursor);
    var pr = predictPatch(p);
    var miss = !isFinite(d.corr[z][MISS_ARM]);
    s += '<text x="100" y="13" font-size="9" fill="#45524d" text-anchor="middle" font-family="monospace">平均内径 ' + (p.armMean.reduce(function (x, y) { return x + y; }, 0) / ARMS * 2 + R0 * 2).toFixed(1) + ' mm</text>';
    s += '<text x="100" y="185" font-size="8.5" fill="#6c7872" text-anchor="middle" font-family="monospace">椭圆度 ' + (p.oval * 100).toFixed(1) + '% · 中心偏移 ' + p.off.toFixed(1) + ' mm</text>';
    s += '<text x="100" y="196" font-size="8.5" fill="' + CLSCOL[pr.top.key] + '" text-anchor="middle" font-family="monospace">原型判读 ' + pr.top.name + ' ' + Math.round(pr.top.p * 100) + '%' + (miss ? ' · 缺臂插值' : '') + '</text>';
    el('sect').innerHTML = s;
    el('sect-hint').textContent = (z * DZ).toFixed(1) + ' m';
    el('cursor-hint').textContent = '深度 ' + state.cursor.toFixed(1) + ' m · 查询 ' + (LAST && LAST.q ? LAST.q.center.toFixed(1) : '—') + ' m';
  }

  /* ---------- 四类损伤指纹卡 ---------- */
  function drawSignatures(P) {
    var wrap = el('sig');
    if (!wrap) return;
    var html = SIG_ZONES.map(function (zn) {
      var z = clamp(Math.round(((zn.d0 + zn.d1) / 2) / DZ), 0, NZ - 1);
      var row = fillRow(DATA.corr[z]).row;
      var k = 0.78, cx0 = 60, cy0 = 60, dp = '', cx = 0, cy = 0;
      for (var a = 0; a < ARMS; a++) {
        var r = row[a] * k;
        var x = cx0 + r * Math.cos(TH[a] - Math.PI / 2);
        var y = cy0 + r * Math.sin(TH[a] - Math.PI / 2);
        dp += (a ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
        cx += row[a] * Math.cos(TH[a]);
        cy += row[a] * Math.sin(TH[a]);
      }
      cx = cx0 + (cx / ARMS) * k; cy = cy0 + (cy / ARMS) * k;
      var col = CLSCOL[zn.type];
      var seg = P.final.filter(function (s) { return s.d0 <= zn.d1 + 1 && s.d1 >= zn.d0 - 1; })[0];
      var grade, prob;
      if (seg) {
        prob = Math.round(seg.pr.order[0].p * 100) + '%';
        grade = seg.type === zn.type ? seg.grade : '误判为' + seg.typeName;
      } else {
        prob = '—';
        grade = '未检出';
      }
      var svg = '<svg viewBox="0 0 120 120" role="img" aria-label="' + NAME[zn.type] + '截面">' +
        '<circle cx="60" cy="60" r="' + (R0 * k).toFixed(1) + '" fill="none" stroke="#cbbfa7" stroke-width="1" stroke-dasharray="4 3"/>' +
        '<path d="' + dp + ' Z" fill="' + col + '" fill-opacity=".10" stroke="' + col + '" stroke-width="1.5"/>' +
        '<circle cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="2" fill="' + col + '"/>' +
        '<path d="M60 60L' + cx.toFixed(1) + ' ' + cy.toFixed(1) + '" stroke="' + col + '" stroke-width="1" stroke-dasharray="2 2"/>' +
        '<circle cx="60" cy="60" r="1.6" fill="#45524d"/>' +
        '<text x="60" y="116" text-anchor="middle" font-size="8" font-family="monospace" fill="#98a199">' + zn.d0.toFixed(0) + '—' + zn.d1.toFixed(0) + ' m</text>' +
        '</svg>';
      return '<button class="sig' + (state.type === zn.type ? ' on' : '') + '" type="button" data-t="' + zn.type + '">' +
        svg + '<span class="st">' + NAME[zn.type] + ' · ' + grade + ' · ' + prob + '</span></button>';
    }).join('');
    wrap.innerHTML = html;
    [].forEach.call(wrap.querySelectorAll('[data-t]'), function (b) {
      b.addEventListener('click', function () {
        var t = b.getAttribute('data-t');
        var zn = ZONES.filter(function (x) { return x.type === t && !x.mild; })[0];
        var seg = P.final.filter(function (s) { return s.d0 <= zn.d1 + 1 && s.d1 >= zn.d0 - 1; })[0];
        state.type = seg && seg.type === t ? t : 'all';
        [].forEach.call(el('seg-type').children, function (x) { x.classList.toggle('on', x.getAttribute('data-t') === state.type); });
        if (seg) { state.mode = 'seg'; state.sel = seg.id; state.cursor = seg.center; }
        else { state.mode = 'free'; state.freeDepth = (zn.d0 + zn.d1) / 2; state.cursor = state.freeDepth; }
        render();
      });
    });
  }

  /* ---------- 质控图 ---------- */
  function drawQC(d) {
    var cvq = el('qc');
    if (!cvq) return;
    var W = 640, H = 150, L = 52, R = 10, T = 10, B = 22;
    cvq.width = W; cvq.height = H;
    var c = cvq.getContext('2d');
    c.clearRect(0, 0, W, H);
    c.fillStyle = '#fdfbf5'; c.fillRect(L, T, W - L - R, H - T - B);
    var cols = 480, rows = ARMS;
    var cw = (W - L - R) / cols, ch = (H - T - B) / rows;
    for (var a = 0; a < rows; a++) {
      for (var x = 0; x < cols; x++) {
        var z = Math.min(NZ - 1, Math.round(x / cols * (NZ - 1)));
        var ok = isFinite(d.well.grid[z][a]);
        c.fillStyle = ok ? '#e7eee9' : '#a64b3c';
        c.fillRect(L + x * cw, T + a * ch, cw + 0.3, ch + 0.3);
      }
    }
    c.strokeStyle = '#ddd4c1';
    c.strokeRect(L, T, W - L - R, H - T - B);
    c.fillStyle = '#98a199';
    c.font = '8.5px ui-monospace,monospace';
    c.textAlign = 'right';
    for (var a2 = 0; a2 < ARMS; a2 += 3) {
      c.fillText('臂 ' + (a2 + 1), L - 4, T + a2 * ch + ch + 1);
    }
    c.textAlign = 'center';
    for (var dkm = 0; dkm <= DEPTH; dkm += 500) {
      var xx = L + dkm / DEPTH * (W - L - R);
      c.fillText(dkm + ' m', xx, H - 6);
    }
    c.textAlign = 'left';
    c.fillStyle = '#6c7872';
    c.fillText('每行 = 一支臂 · 红 = 读数缺失（NaN）· 灰带 = 进入特征前插值', L + 4, H - 6);
  }

  /* ---------- patch 绘制 ---------- */
  function drawThumb(canvas, patch) {
    if (!canvas || !patch) return;
    var bins = patch.dev.length, cw = 5, ch = 4;
    canvas.width = bins * cw; canvas.height = ARMS * ch;
    var c = canvas.getContext('2d');
    for (var b = 0; b < bins; b++) {
      for (var a = 0; a < ARMS; a++) {
        var v = patch.dev[b][a];
        var col = ramp(isFinite(v) ? v : 0);
        c.fillStyle = isFinite(v) ? 'rgb(' + col.join(',') + ')' : '#d8d2c4';
        c.fillRect(b * cw, a * ch, cw - 0.4, ch - 0.4);
      }
    }
  }

  function drawPatchBig(canvas, patch) {
    if (!canvas || !patch) return;
    var W = 640, H = 200, L = 38, R = 12, T = 12, B = 30;
    canvas.width = W; canvas.height = H;
    var c = canvas.getContext('2d');
    c.clearRect(0, 0, W, H);
    c.fillStyle = '#fdfbf5'; c.fillRect(L, T, W - L - R, H - T - B);
    var cw = (W - L - R) / patch.bins, ch = (H - T - B) / ARMS;
    for (var b = 0; b < patch.bins; b++) {
      for (var a = 0; a < ARMS; a++) {
        var v = patch.dev[b][a];
        var col = ramp(isFinite(v) ? v : 0);
        c.fillStyle = isFinite(v) ? 'rgb(' + col.join(',') + ')' : '#d8d2c4';
        c.fillRect(L + b * cw, T + a * ch, cw - 0.5, ch - 0.5);
      }
    }
    c.strokeStyle = '#ddd4c1';
    c.strokeRect(L, T, W - L - R, H - T - B);
    c.fillStyle = '#98a199';
    c.font = '9px ui-monospace,monospace';
    c.textAlign = 'right';
    [0, 4, 8, 12].forEach(function (a2) {
      c.fillText((a2 * 22.5).toFixed(0) + '°', L - 4, T + (a2 + 0.7) * ch);
    });
    c.textAlign = 'center';
    [0, 0.5, 1].forEach(function (t) {
      var d = patch.center - PATCH_WIN / 2 + PATCH_WIN * t;
      c.fillText(d.toFixed(1) + ' m', L + (W - L - R) * t, H - 8);
    });
    c.textAlign = 'left';
    c.fillStyle = '#6c7872';
    c.fillText('16 臂 × 12 深度箱 · 颜色 = r/R0 − 1（青内缩 / 橙外扩）', L + 2, T + 10);
  }

  /* ---------- 混淆矩阵 / 校准 ---------- */
  function drawCM() {
    var box = el('cm');
    if (!box) return;
    var html = '<span class="lb">真实↓/预测→</span>' + CLASSES.map(function (c) {
      return '<span style="text-align:center;color:var(--ink-4);font-size:8px">' + c.short + '</span>';
    }).join('');
    VAL.conf.forEach(function (r, i) {
      var sum = r.reduce(function (a, b) { return a + b; }, 0) || 1;
      html += '<span class="lb">' + CLASSES[i].short + '</span>' + r.map(function (v) {
        var q = v / sum;
        var a = q > 0.5 ? 0.12 + q * 0.75 : q * 1.05;
        return '<i style="background:rgba(18,59,58,' + a.toFixed(2) + ');display:flex;align-items:center;justify-content:center;color:' + (q > 0.5 ? '#f3eee3' : '#45524d') + ';font-family:var(--mono);font-size:8px" title="' + (q * 100).toFixed(0) + '%">' + v + '</i>';
      }).join('');
    });
    box.innerHTML = html;
  }

  /* ---------- 各阶段面板 ---------- */
  function gateOf(qc) {
    var arms = Object.keys(qc.missArms).length;
    if (qc.noiseRms > 0.5 || qc.coverage < 0.9) return ['bad', '退回重采 · 噪声/弧覆盖超限'];
    if (arms > 0 || qc.noiseRms > 0.30 || qc.eccAmp > 0.50) return ['warn', '可用 · 缺臂/偏心段降级'];
    return ['ok', '可用 · 进入特征提取'];
  }

  function renderStage0(d) {
    var qc = d.qc, gate = gateOf(qc);
    var arms = Object.keys(qc.missArms).map(function (k) {
      var iv = qc.missArms[k];
      return '臂 ' + (Number(k) + 1) + ' · ' + (iv[0] * DZ).toFixed(0) + '—' + (iv[1] * DZ).toFixed(0) + ' m';
    }).join('；') || '无';
    el('q-ecc').innerHTML = qc.eccAmp.toFixed(2) + ' mm <span class="s">逐臂中位扣除</span>';
    el('q-noise').innerHTML = qc.noiseRms.toFixed(2) + ' mm <span class="s">校正后残差 RMS</span>';
    el('q-miss').innerHTML = arms + ' <span class="s">有效弧覆盖 ' + (qc.coverage * 100).toFixed(1) + '%</span>';
    el('q-gate').innerHTML = '<span class="db ' + gate[0] + '">' + gate[1] + '</span>';
    drawQC(d);
  }

  function renderStage1(q) {
    var p = q.patch;
    drawPatchBig(el('featpatch'), p);
    var rows = [
      ['内偏 dIn', p.inMax.toFixed(1) + ' mm', 'R0 − min(r)，挤压/错断的内缩证据'],
      ['外扩 dOut', p.outMax.toFixed(1) + ' mm', 'max(r) − R0，腐蚀/穿孔的金属损失证据'],
      ['椭圆度 E', (p.oval * 100).toFixed(1) + '%', '(max − min)/R0，挤压变形的核心量'],
      ['中心偏移 e', p.off.toFixed(1) + ' mm', '16 臂矢量合成中心相对井轴，错断的核心量'],
      ['内弧覆盖', (p.arcIn * 100).toFixed(0) + '%', '平均内缩 > 0.5 mm 的臂数 / 16'],
      ['外弧覆盖', (p.arcOut * 100).toFixed(0) + '%', '平均外扩 > 0.5 mm 的臂数 / 16'],
      ['有效弧覆盖', (p.validFrac * 100).toFixed(1) + '%', 'patch 内可读 cell / 192，缺臂段降权'],
      ['深度形态', p.width.toFixed(1) + ' m · 尖锐度 ' + p.sharp.toFixed(0), '窄而尖偏穿孔；宽而缓偏腐蚀']
    ];
    el('feats').innerHTML = rows.map(function (r) {
      return '<div class="qrow"><span class="k">' + r[0] + '</span><span class="v">' + r[1] + ' <span class="s">' + r[2] + '</span></span></div>';
    }).join('');
  }

  function renderStage2(q, P) {
    el('m-acc').innerHTML = (VAL.acc * 100).toFixed(1) + '%';
    el('m-temp').textContent = 'T ' + VAL.T.toFixed(2);
    el('m-n').textContent = '5×5 / ' + VAL.n;
    el('m-cov').innerHTML = (VAL.coverage * 100).toFixed(0) + '%';

    var topKey = q.pr.order[0].key;
    var sup = SUP[topKey] || [];
    el('sup-hint').textContent = sup.length + ' 段 · ' + NAME[topKey];
    el('support-row').innerHTML = sup.slice(0, 5).map(function (s, idx) {
      return '<div class="pitem"><canvas class="pthumb" data-sup="' + idx + '"></canvas><span>' + esc(s.well) + '</span></div>';
    }).join('') + (sup.length > 5 ? '<div class="pitem pmore">+' + (sup.length - 5) + '</div>' : '');
    [].forEach.call(el('support-row').querySelectorAll('[data-sup]'), function (cnv) {
      drawThumb(cnv, sup[Number(cnv.getAttribute('data-sup'))].patch);
    });

    el('proto-row').innerHTML = CLASSES.map(function (c) {
      return '<div class="pitem"><canvas class="pthumb" data-proto="' + c.key + '"></canvas><span style="color:' + CLSCOL[c.key] + '">' + c.short + ' ' + PROTOS[c.key].n + '</span></div>';
    }).join('');
    [].forEach.call(el('proto-row').querySelectorAll('[data-proto]'), function (cnv) {
      drawThumb(cnv, PROTOS[cnv.getAttribute('data-proto')].patch);
    });

    el('query-hint').textContent = q.kind === 'seg' ? ('候选段 ' + q.seg.id + ' · ' + q.seg.d0.toFixed(1) + '—' + q.seg.d1.toFixed(1) + ' m') : ('自由滑窗 · ' + q.center.toFixed(1) + ' m');
    drawThumb(el('qpatch'), q.patch);

    el('sims').innerHTML = CLASSES.map(function (c) {
      var idx = CKEYS.indexOf(c.key);
      var sim = q.pr.sims[idx], prob = q.pr.p[idx];
      var w = Math.max(0, Math.min(1, (sim + 0.2) / 1.2)) * 100;
      return '<div class="simrow"><span style="color:' + (q.pr.order[0].key === c.key ? 'var(--ink)' : 'var(--ink-3)') + '">' + c.short + '</span>' +
        '<span class="track"><i style="width:' + w.toFixed(1) + '%;background:' + CLSCOL[c.key] + '"></i></span>' +
        '<span class="mono" style="text-align:right;color:var(--ink-3)">' + sim.toFixed(2) + '</span>' +
        '<span class="mono" style="text-align:right;color:' + (q.pr.order[0].key === c.key ? 'var(--ink)' : 'var(--ink-4)') + '">' + Math.round(prob * 100) + '%</span></div>';
    }).join('');

    drawCM();
  }

  function renderStage3(q, P) {
    var pr = q.pr;
    el('probs').innerHTML = CLASSES.map(function (c) {
      var idx = CKEYS.indexOf(c.key);
      var top = pr.order[0].key === c.key;
      return '<div class="dbar" style="padding:2px 0"><span style="width:58px;font-size:10.5px;color:' + (top ? 'var(--ink)' : 'var(--ink-3)') + '">' + c.name + '</span>' +
        '<span class="track"><i style="width:' + (pr.p[idx] * 100).toFixed(1) + '%;background:' + (top ? CLSCOL[c.key] : 'var(--line-3)') + '"></i></span>' +
        '<span class="val">' + Math.round(pr.p[idx] * 100) + '%</span></div>';
    }).join('');

    var top = pr.order[0], second = pr.order[1];
    var card;
    if (q.kind === 'free') {
      var hit = P.final.filter(function (s) { return q.center >= s.d0 - 0.5 && q.center <= s.d1 + 0.5; })[0];
      if (hit) {
        card = { db: hit.action.db, label: hit.action.label, name: hit.typeName, text: '该深度落在候选段 ' + hit.id + ' 内，按候选段的决策执行。' + TIPS[hit.type] };
      } else if (top.key === 'normal') {
        card = { db: 'plain', label: '不进入清单', name: '正常', text: '自由滑窗落在正常井段：原型判为正常，规则也没有把它列为候选。鼠标点可疑深度可以随时用模型复核。' };
      } else {
        card = { db: 'warn', label: '阈值可能漏检', name: top.name, text: '模型判为 <b>' + top.name + '</b>（' + Math.round(top.p * 100) + '%），但检测阈值 Δ 没把该深度列为候选。先检查原始井径与成像；若确为损伤，说明阈值偏高，应下调或按类型分设门限。' };
      }
    } else {
      var s = q.seg;
      card = { db: s.action.db, label: s.action.label, name: s.typeName, text: TIPS[s.type] };
      if (s.action.k === 'auto') card.text = '证据：' + s.metric + '；置信度与次优差过线，进入自动清单，人工抽检即可。';
      else if (s.action.k === 'review') card.text = '置信度或次优差距不足，不能直接交付。调取同深度成像灰度与相邻 2 个 patch，重点排除 <b>' + second.name + '</b>。' + TIPS[s.type];
      else card.text = '原型拒绝给出高置信度结论（p&lt;0.55 或次优差&lt;8 pts）。转专家，并把人工结论回写为下一轮支持样本。';
    }

    var qcBad = q.patch.validFrac < 0.975 ? '<div class="callout warn"><span class="ci">质控</span><span>该 patch 有效弧覆盖 ' + (q.patch.validFrac * 100).toFixed(1) + '%，缺臂 cell 已用相邻臂插值；模型置信度按降级处理，不能直接自动交付。</span></div>' : '';

    el('advice').innerHTML =
      '<div style="display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-bottom:5px">' +
      '<span class="db ' + card.db + '">' + card.label + '</span>' +
      '<span style="font-size:12.5px"><b>' + card.name + '</b>（' + Math.round(top.p * 100) + '%）</span>' +
      '<span class="mono" style="font-size:9px;color:var(--ink-4)">次优 ' + second.name + ' ' + Math.round(second.p * 100) + '% · 差距 ' + Math.round((top.p - second.p) * 100) + ' pts</span></div>' +
      '<p style="font-size:10.5px;color:var(--ink-2);line-height:1.6">' + card.text + '</p>' +
      qcBad;

    var queue = P.view.filter(function (s) { return s.action.k !== 'auto'; });
    el('queue-hint').innerHTML = queue.length + ' 段 · ' + (P.view.length ? Math.round(queue.length / P.view.length * 100) : 0) + '%';
    el('queue').innerHTML = queue.length ? queue.slice(0, 6).map(function (s) {
      var detail = s.typeName + (s.grade && s.grade !== '—' ? ' ' + s.grade : '') + (s.metric ? ' · ' + s.metric : '') + ' · p=' + Math.round(s.pr.order[0].p * 100) + '%';
      return '<div class="hit" data-qid="' + s.id + '"><div><div class="d">' + s.d0.toFixed(1) + '—' + s.d1.toFixed(1) + ' m' +
        '<span class="db ' + s.action.db + '" style="margin-left:6px">' + s.action.label + '</span></div>' +
        '<div class="m">' + detail + '</div></div>' +
        '<div class="r mono" style="font-size:10px;color:var(--ink-4)">' + s.id + '</div></div>';
    }).join('') : '<p style="font-size:11.5px;color:var(--ink-4);padding:8px 0">当前阈值与筛选下没有待复核段。</p>';
    [].forEach.call(el('queue').querySelectorAll('[data-qid]'), function (n) {
      n.addEventListener('click', function () {
        state.mode = 'seg'; state.sel = n.getAttribute('data-qid');
        var seg = P.final.filter(function (s) { return s.id === state.sel; })[0];
        if (seg) state.cursor = seg.center;
        render();
      });
    });

    var mild = P.mild;
    var mildTxt;
    if (mild.seg) {
      mildTxt = '已入候选 ' + mild.seg.id + ' · ' + mild.seg.typeName + ' ' + Math.round(mild.seg.pr.order[0].p * 100) + '%';
    } else {
      mildTxt = 'Δ 未入候选 · 自由查询原型 ' + (mild.pr ? mild.pr.order[0].name + ' ' + Math.round(mild.pr.order[0].p * 100) + '%' : '—');
    }
    el('flowstat').innerHTML =
      '<div class="qrow"><span class="k">原始候选 → 同类合并</span><span class="v">' + P.raw.length + ' → ' + P.final.length + ' 段 <span class="s">间隔≤3 m</span></span></div>' +
      '<div class="qrow"><span class="k">原型正常 · 自动排除</span><span class="v">' + P.dismissed + ' 段</span></div>' +
      '<div class="qrow"><span class="k">自动 / 复核 / 拒识</span><span class="v">' + P.counts.auto + ' / ' + P.counts.review + ' / ' + P.counts.unknown + ' 段</span></div>' +
      '<div class="qrow"><span class="k">轻度腐蚀 ' + mild.zone.d0 + '—' + mild.zone.d1 + ' m</span><span class="v">' + mildTxt + '</span></div>';
  }

  function renderStage4(q, P) {
    var stat = P.stat;
    var review = P.view.filter(function (s) { return s.action.k !== 'auto'; }).length;
    el('live-stats').innerHTML =
      '<div><div class="k">本页召回</div><div class="v ' + (stat.hit === stat.truth ? 'ok' : 'warn') + '">' + stat.hit + ' / ' + stat.truth + '</div><div class="s">合成单井 ' + stat.truth + ' 段真值</div></div>' +
      '<div><div class="k">本页误报</div><div class="v ' + (stat.fp === 0 ? 'ok' : 'warn') + '">' + stat.fp + ' 段</div><div class="s">不落在真值段 ±1 m</div></div>' +
      '<div><div class="k">复核队列</div><div class="v">' + review + ' 段</div><div class="s">当前筛选下</div></div>' +
      '<div><div class="k">类型一致</div><div class="v">' + stat.typeOk + ' / ' + stat.truth + '</div><div class="s">位置命中且类型正确</div></div>';
    var totalSup = CKEYS.reduce(function (a, k) { return a + SUP[k].length; }, 0);
    el('fb-note').innerHTML = '支持集 ' + totalSup + ' 段 · 回写 ' + (fb.ok + fb.fix) + ' 条' + (fb.fix ? '（纠正 ' + fb.fix + '）' : '') + ' · 人工确认后才进入下一轮验证';
  }

  function renderModel(q, P) {
    var totalSup = CKEYS.reduce(function (a, k) { return a + SUP[k].length; }, 0);
    el('m-sup').textContent = totalSup + ' 段' + (totalSup > 25 ? '（含 ' + (totalSup - 25) + ' 条回写）' : '');
    el('m-summary').innerHTML = '留一井 <b>' + (VAL.acc * 100).toFixed(1) + '%</b> · 覆盖率 <b>' + (VAL.coverage * 100).toFixed(0) + '%</b> · T=' + VAL.T.toFixed(2);
    el('m-badge').textContent = '已建原型';
    el('m-badge').className = 'db ok';
  }

  function renderHeader(P, q) {
    var top = q.pr.order[0];
    el('st-verdict').textContent = top.key === 'normal' ? '正常' : top.name;
    el('st-conf').innerHTML = pct(top.p);
    el('st-acc').innerHTML = (VAL.acc * 100).toFixed(1) + '<small>%</small>';
    var rev = P.view.filter(function (s) { return s.action.k !== 'auto'; }).length;
    el('st-review').innerHTML = P.view.length ? Math.round(rev / P.view.length * 100) + '<small>%</small>' : '0<small>%</small>';
  }

  function renderNote(q, P) {
    var top = q.pr.order[0], note;
    if (q.kind === 'seg') {
      var s = q.seg;
      if (s.type === 'normal') {
        note = '候选段 ' + s.id + ' 的 top 类是 <b>正常</b>，但只有 ' + Math.round(top.p * 100) + '%（<85%），系统不敢直接把它排除，于是放进<b>复核队列</b>。低阈值时，接箍/结垢这类干扰最容易以这种「未定型」形态出现。';
      } else if (s.action.k === 'auto') {
        note = '候选段 ' + s.id + '（' + s.d0.toFixed(1) + '—' + s.d1.toFixed(1) + ' m）被原型判为 <b>' + s.typeName + '</b> ' + s.grade + '，p=' + Math.round(top.p * 100) + '%，进入自动清单。注意：<b>自动交付不等于免检</b>——现场仍按抽检比例复核，并把确认结果回写支持集。';
      } else if (s.action.k === 'review') {
        note = '候选段 ' + s.id + ' 的 top 类与次优类差距不足（' + Math.round(s.pr.order[0].p * 100) + '% vs ' + Math.round(s.pr.order[1].p * 100) + '%），所以没有直接进自动清单，而是进了<b>人工复核队列</b>。复核时先看同深度成像灰度，再看相邻 patch 是否连续。';
      } else {
        note = '候选段 ' + s.id + ' 被<b>拒识</b>：p=' + Math.round(top.p * 100) + '%，模型不愿意为它背书。这类段转专家，并把人工结论回写——它比一个勉强及格的自动结论更有价值。';
      }
    } else {
      var hit = P.final.filter(function (s) { return q.center >= s.d0 - 0.5 && q.center <= s.d1 + 0.5; })[0];
      if (hit) {
        note = '鼠标所在的 ' + q.center.toFixed(1) + ' m 落在候选段 ' + hit.id + ' 内，模型与规则一致。拖动检测阈值 Δ 可以看这条边界怎样移动。';
      } else if (top.key === 'normal') {
        note = '鼠标所在的 ' + q.center.toFixed(1) + ' m 不在候选清单里，原型也判为<b>正常</b>。这就是「规则先筛、模型再看」的分工：正常段不占用解释员注意力。';
      } else {
        note = '这里出现了一个<b>失败边界</b>：模型判为 ' + top.name + '（' + Math.round(top.p * 100) + '%），但检测阈值没有把它列为候选。阈值过高会漏检，过低会把接箍/结垢都放进来——这正是需要人工调参和回写的地方。';
      }
    }
    if (state.type !== 'all') note += ' 当前只显示 <b>' + NAME[state.type] + '</b>，统计口径随筛选切换。';
    el('note').innerHTML = note;
  }

  function render() {
    var d = ensureData();
    var P = computePipeline(d);
    ensureSelection(P);
    var q = currentQuery(P, d);
    if (q.kind === 'seg' && q.seg) state.cursor = q.seg.center;
    LAST = { d: d, P: P, q: q };
    renderHeader(P, q);
    draw(P.view, d.F, q);
    drawSect(d);
    drawSignatures(P);
    drawQC(d);
    renderStage0(d);
    renderStage1(q);
    renderStage2(q, P);
    renderStage3(q, P);
    renderStage4(q, P);
    renderModel(q, P);
    renderNote(q, P);
  }

  /* ---------- 过程日志 ---------- */
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
    el('trace').innerHTML = '<div><span class="t">—</span><span>等待运行：选好损伤类型/阈值后点「运行全流程」，或直接点上面的步骤。</span></div>';
  }

  /* ---------- 阶段控制 / 全流程 ---------- */
  var STAGE_LABEL = ['01 采集', '02 特征', '03 模型', '04 决策', '05 闭环'];
  var runTimers = [];
  function cancelRun() {
    runTimers.forEach(function (t) { clearTimeout(t); });
    runTimers = [];
    var btn = el('btn-run');
    if (btn) { btn.disabled = false; btn.textContent = '▶ 运行全流程'; }
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
    var P = LAST.P, q = LAST.q, d = LAST.d;
    var qc = d.qc, gate = gateOf(qc);
    var top = q.pr.order[0], second = q.pr.order[1];
    var p = q.patch;
    var review = P.view.filter(function (s) { return s.action.k !== 'auto'; }).length;
    var totalSup = CKEYS.reduce(function (a, k) { return a + SUP[k].length; }, 0);
    var steps = [
      ['01', '读取 <b>' + NZ + '</b> 深度点 × 16 臂 · 偏心 ' + qc.eccAmp.toFixed(2) + ' mm · 噪声 ' + qc.noiseRms.toFixed(2) + ' mm · 缺失臂 ' + Object.keys(qc.missArms).length + ' 支 · 质控 <b>' + gate[1] + '</b>'],
      ['02', '滑窗 ' + PATCH_WIN.toFixed(1) + ' m → <b>' + PATCH_BINS + '×16 patch</b> · 内偏 ' + p.inMax.toFixed(1) + ' / 外扩 ' + p.outMax.toFixed(1) + ' / 椭圆 ' + (p.oval * 100).toFixed(1) + '% / 中心偏移 ' + p.off.toFixed(1) + ' mm'],
      ['03', (SUP[top.key] ? SUP[top.key].length : 5) + '-shot 原型 · 余弦 <b>' + top.sim.toFixed(2) + '</b> · p=<b>' + Math.round(top.p * 100) + '%</b> · 留一井验证 <b>' + (VAL.acc * 100).toFixed(1) + '%</b> · T=' + VAL.T.toFixed(2)],
      ['04', '候选 <b>' + P.raw.length + '</b> 段 → 原型排除 ' + P.dismissed + ' → 合并 <b>' + P.final.length + '</b> 段 · 自动 ' + P.counts.auto + ' / 复核 ' + P.counts.review + ' / 拒识 ' + P.counts.unknown],
      ['05', '案例口径 620 井次/年 · 45→12 min/井 · 召回 78→96% · 误报 2.8→1.2 段/井 · 支持集 <b>' + totalSup + '</b> 段 · 回写 ' + (fb.ok + fb.fix) + ' 条']
    ];
    [0, 800, 1600, 2400, 3200].forEach(function (delay, i) {
      runTimers.push(setTimeout(function () {
        setStage(i, null);
        trace(steps[i][0], steps[i][1]);
        if (i === steps.length - 1) {
          runTimers.push(setTimeout(function () {
            btn.disabled = false;
            btn.textContent = '▶ 重新运行';
            trace('✓', '流水线完成：从 16 臂井径到一张带置信度和复核队列的清单。', 'ok');
          }, 700));
        }
      }, delay));
    });
  }

  /* ---------- 交互 ---------- */
  el('seg-type').innerHTML = [{ key: 'all', name: '全部' }].concat(CLASSES.filter(function (c) { return c.key !== 'normal'; })).map(function (t) {
    return '<button data-t="' + t.key + '" class="' + (t.key === 'all' ? 'on' : '') + '">' + (t.key === 'all' ? '全部' : t.name) + '</button>';
  }).join('');
  el('seg-type').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    cancelRun();
    state.type = b.getAttribute('data-t');
    [].forEach.call(el('seg-type').children, function (x) { x.classList.toggle('on', x === b); });
    render();
  });

  var rSev = el('r-sev'), rThr = el('r-thr');
  rSev.addEventListener('input', function () {
    cancelRun();
    state.sev = Number(rSev.value);
    el('o-sev').textContent = state.sev.toFixed(2);
    DATA = null;
    render();
  });
  rThr.addEventListener('input', function () {
    cancelRun();
    state.thr = Number(rThr.value);
    el('o-thr').textContent = state.thr.toFixed(1) + ' mm';
    render();
  });

  var togNoise = el('tog-noise');
  togNoise.setAttribute('role', 'switch');
  togNoise.setAttribute('aria-checked', 'true');
  togNoise.setAttribute('tabindex', '0');
  function toggleNoise() {
    cancelRun();
    state.noise = !state.noise;
    togNoise.classList.toggle('on', state.noise);
    togNoise.setAttribute('aria-checked', state.noise ? 'true' : 'false');
    DATA = null;
    render();
  }
  togNoise.addEventListener('click', toggleNoise);
  togNoise.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleNoise(); } });

  el('btn-run').addEventListener('click', runAll);
  el('btn-reset').addEventListener('click', function () {
    cancelRun();
    state.type = 'all'; state.sev = 0.55; state.thr = 2.0; state.noise = true;
    state.cursor = 1180; state.mode = 'seg'; state.sel = null; state.freeDepth = 1180;
    rSev.value = '0.55'; el('o-sev').textContent = '0.55';
    rThr.value = '2.0'; el('o-thr').textContent = '2.0 mm';
    togNoise.classList.add('on'); togNoise.setAttribute('aria-checked', 'true');
    [].forEach.call(el('seg-type').children, function (x) { x.classList.toggle('on', x.getAttribute('data-t') === 'all'); });
    SUP = cloneSup(SUP0);
    rebuildProtos();
    fb = { ok: 0, fix: 0 };
    DATA = null;
    setStage(0, false);
    clearTrace();
    render();
    trace('系统', '已重置：数据回到 0.55 严重度 / 2.0 mm 阈值，支持集回到 5 口井 × 5 类。');
  });

  el('flow').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    cancelRun();
    setStage(Number(b.getAttribute('data-s')), null);
  });

  el('feedback').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    var q = LAST && LAST.q;
    if (!q) return;
    var k = b.getAttribute('data-fb');
    var cls = k === 'ok' ? q.pr.order[0].key : el('fb-class').value;
    if (!q.patch) return;
    var entry = { well: 'F' + (fb.ok + fb.fix + 1), patch: q.patch, vec: toVec(q.patch) };
    SUP[cls].push(entry);
    rebuildProtos();
    if (k === 'ok') fb.ok++; else fb.fix++;
    render();
    trace('回写', k === 'ok'
      ? '人工确认 <b>' + NAME[cls] + '</b> · 支持集 ' + NAME[cls] + ' ' + SUP[cls].length + ' 段 · 原型已实时更新'
      : '人工纠正为 <b>' + NAME[cls] + '</b> · 支持集 ' + SUP[cls].length + ' 段 · 下一轮留一井验证会优先看这类', k === 'ok' ? 'ok' : 'warn');
  });

  /* 鼠标移动只看截面；点击才把该深度作为模型查询 */
  function depthFromEvent(e) {
    var r = cv.getBoundingClientRect();
    var y = e.clientY - r.top;
    if (y < G.T || y > Hc - G.B) return null;
    return clamp(G.dy(y), 0, DEPTH);
  }
  var hoverRaf = null;
  cv.addEventListener('pointermove', function (e) {
    var dep = depthFromEvent(e);
    if (dep === null || !LAST) return;
    state.cursor = dep;
    if (hoverRaf) return;
    hoverRaf = requestAnimationFrame(function () {
      hoverRaf = null;
      if (!LAST) return;
      draw(LAST.P.view, LAST.d.F, LAST.q);
      drawSect(LAST.d);
      el('cursor-hint').textContent = '深度 ' + state.cursor.toFixed(1) + ' m · 查询 ' + LAST.q.center.toFixed(1) + ' m';
    });
  });
  cv.addEventListener('pointerdown', function (e) {
    var dep = depthFromEvent(e);
    if (dep === null) return;
    state.cursor = dep;
    var best = null, bd = 12;
    LAST.P.view.forEach(function (s) {
      var dd = Math.abs(s.center - dep);
      if (dd < bd) { bd = dd; best = s; }
    });
    if (best) {
      state.mode = 'seg'; state.sel = best.id; state.cursor = best.center;
    } else {
      state.mode = 'free'; state.freeDepth = dep;
    }
    render();
  });

  /* ---------- 启动 ---------- */
  el('fb-class').innerHTML = CLASSES.map(function (c) {
    return '<option value="' + c.key + '">' + c.name + '</option>';
  }).join('');
  clearTrace();
  render();
  setStage(0, false);
  trace('系统', '模型已在本页建立：5 类 × 5 支持 patch · 留一井验证 <b>' + (VAL.acc * 100).toFixed(1) + '%</b> · 温度 T=' + VAL.T.toFixed(2), 'ok');
})();
