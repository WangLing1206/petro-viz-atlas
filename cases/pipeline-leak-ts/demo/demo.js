/* =========================================================
   从双站压力到泄漏处置 · 可运行示范（v2 · AI 作业流）
   ---------------------------------------------------------
   这条流水线要回答的不是「压力波形像不像泄漏」，而是：
     现场数据能不能用 → 有没有突变 → 是不是泄漏 → 位置在哪 → 谁来处置
   ① 采集与质控：1 s 原始流 + 10 s 历史库 + 工况台账；
      缺测补点、两站时钟、变送器零漂，质控不过不进模型；
   ② 检测：10 s 库上滑动窗均值差粗筛，报警候选回捞 1 s 原始流，
      用 S² 加权质心把突变时刻估到 0.3 s；
   ③ 特征与分类：8 个物理特征 → 16 维 softmax（8 特征 + 8 平方项），
      1280 例合成事件本页现场训练，留出 20% 验证，标签平滑 + 温度缩放；
   ④ 决策：物理门限（|Δt| ≤ L/v）+ 流量平衡 + 工况记录 + 分类概率，
      三级输出 派车 / 复核 / 抑制；
   ⑤ 闭环：人工确认回写、重训、月度指标。
   口径：120 km 管段、v = 1100 m/s、输量 1600 m³/h（示范固定值）；
   价值表为示范口径，页面上的仿真读数单独标注。
   ========================================================= */
(function () {
  'use strict';

  /* ---------------- 管网与算法参数 ---------------- */
  var L = 120000;              /* 管段长度 m */
  var VW = 1100;               /* 负压波波速 m/s（含气原油 1000—1200） */
  var Q0 = 1600;               /* 正常输量 m³/h */
  var ATT = 200000;            /* 压力波幅衰减长度 m */
  var SIG = 0.020;             /* 压力噪声基准标准差 MPa */
  var AMPK = 0.078;            /* 每 1% 漏量对应的漏点压力波幅 MPa */
  var XS = [0, L];
  var BASE_P = [6.20, 1.78];
  var DUR = 86400, DT = 10, N = DUR / DT;
  var DT_F = 1, HW = 600;
  var W_C = 6, W_F = 8, PERS_C = 3, PERS_F = 2;
  var DV_THR = 12, DV_GROW = 1.0, OP_WIN = 180;
  var LEAK_T = 13.5 * 3600;
  var PX0 = 64, PXW = 572;
  var nameS = ['首站', '末站'];
  var T_SIM = 3.0;             /* 纵剖面动画：波前走完全程的秒数 */

  /* ---------------- 可复现随机数 ---------------- */
  function mulberry(seed) {
    var a = seed >>> 0;
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
  var RND = mulberry(991);
  function seedRnd(a) { RND = mulberry(a); }
  function rnd() { return RND(); }
  var GR = gaussOf(mulberry(7717));
  function gr() { return GR(); }

  /* 24 h 两站的固定噪声流：粗筛 / 精分析共用，保证同一事件反复分析结果一致 */
  var CN = [[], []], FN = [[], []];
  (function () {
    for (var s = 0; s < 2; s++) {
      var g = gaussOf(mulberry(7919 + s * 104729));
      var c = new Float64Array(N), f = new Float64Array(DUR + 1);
      for (var i = 0; i < N; i++) c[i] = g();
      for (var k = 0; k <= DUR; k++) f[k] = g();
      CN[s] = c; FN[s] = f;
    }
  })();

  /* ---------------- 工况扰动库 ---------------- */
  /* amp0：扰动源处压力波幅；split：上下游反号（节流）；
     pulses：进出站流量差脉冲（m³/h，净积分为 0） */
  var OPSET = {
    valve: [
      { t0: 9 * 3600 + 20 * 60, kind: '调阀', x0: 45000, amp0: -0.28, split: true, dur: 180, rec: 300,
        pulses: [{ amp: 110, dur: 180 }, { amp: -27.5, dur: 720 }] },
      { t0: 16 * 3600 + 40 * 60, kind: '调阀', x0: 45000, amp0: -0.28, split: true, dur: 180, rec: 300,
        pulses: [{ amp: 110, dur: 180 }, { amp: -27.5, dur: 720 }] }
    ],
    pump: [
      { t0: 6 * 3600, kind: '泵切换', x0: 0, amp0: -0.30, split: false, dur: 240, rec: 200,
        pulses: [{ amp: -90, dur: 240 }, { amp: 22.5, dur: 960 }] },
      { t0: 18 * 3600 + 30 * 60, kind: '泵切换', x0: 0, amp0: -0.30, split: false, dur: 240, rec: 200,
        pulses: [{ amp: -90, dur: 240 }, { amp: 22.5, dur: 960 }] }
    ]
  };

  /* 1 s 原始流上的固定缺测段（秒），质检报告与补点逻辑共用 */
  var GAPS1 = [[40272, 40278], [56550, 56558], [76725, 76737]];

  var state = {
    scen: 'leak', pos: 62, leakPct: 2.0, noise: 1.0, thr: 0.045,
    skew: 0.0, aware: true, flowX: true, stage: 0
  };
  var SCENS = [['steady', '稳态运行'], ['valve', '调阀扰动'], ['pump', '启泵扰动'], ['leak', '泄漏']];
  var TR = null;
  var fb = { leak: 0, bad: 0 };
  var FB = [];                 /* 回写样本：{f, y} */

  function buildTruth() {
    var ops = [], leak = null;
    if (state.scen === 'valve') ops = OPSET.valve;
    else if (state.scen === 'pump') ops = OPSET.pump;
    else if (state.scen === 'leak') ops = [OPSET.valve[0]];
    var x = Math.round(L * state.pos / 100);
    if (state.scen === 'leak') {
      leak = { t0: LEAK_T, x0: x, amp0: -AMPK * state.leakPct, split: false, dur: 0, rec: 0 };
    }
    state.pos = x / L * 100;
    return { ops: ops, leak: leak, x: x, q: Q0 * state.leakPct / 100 };
  }

  /* ---------------- 压力模型 ---------------- */
  function drift(s, t) {
    return 0.045 * Math.sin(2 * Math.PI * t / 43200 + s * 1.1)
      + 0.022 * Math.sin(2 * Math.PI * t / 14400 + s * 2.3);
  }
  function wave(s, t, e) {
    var d = Math.abs(XS[s] - e.x0);
    var arr = e.t0 + d / VW;
    var st = 1 / (1 + Math.exp(-(t - arr) / 0.8));
    if (st < 1e-7) return 0;
    var amp = e.amp0 * Math.exp(-d / ATT);
    if (e.split && XS[s] < e.x0) amp = -amp;
    var dec = (e.dur && t > e.t0 + e.dur) ? Math.exp(-(t - e.t0 - e.dur) / e.rec) : 1;
    return amp * st * dec;
  }
  function smooth(s, t) { return BASE_P[s] + drift(s, t); }
  function evSum(s, t) {
    var v = 0, i;
    for (i = 0; i < TR.ops.length; i++) v += wave(s, t, TR.ops[i]);
    if (TR.leak) v += wave(s, t, TR.leak);
    return v;
  }
  function MULT() { return state.noise; }

  var P = [[], []], S1 = null, S2 = null, VFLOW = null, DQV = null;
  function buildSeries() {
    var s, i, t;
    for (s = 0; s < 2; s++) {
      var arr = new Float64Array(N);
      for (i = 0; i < N; i++) {
        t = i * DT;
        arr[i] = smooth(s, t) + evSum(s, t) + SIG * MULT() * CN[s][i];
      }
      P[s] = arr;
    }
    /* 流量平衡：进出站流量差累计（m³） */
    var V = new Float64Array(N), D = new Float64Array(N);
    var g = gaussOf(mulberry(3301));
    var a = Math.exp(-DT / 7200), sv = 1.5, acc = 0, vn = 0;
    for (i = 0; i < N; i++) {
      t = i * DT;
      var q = 0;
      if (TR.leak && t >= TR.leak.t0) q += TR.q * Math.min(1, (t - TR.leak.t0) / 60);
      for (var k = 0; k < TR.ops.length; k++) {
        var o = TR.ops[k];
        for (var j = 0; j < o.pulses.length; j++) {
          var p = o.pulses[j];
          if (t >= o.t0 && t < o.t0 + p.dur) q += p.amp;
        }
      }
      D[i] = q;
      acc += q * DT / 3600;
      vn = a * vn + Math.sqrt(1 - a * a) * sv * g();
      V[i] = acc + vn;
    }
    VFLOW = V; DQV = D;
  }

  /* ---------------- 突变检测：滑动窗均值差 ---------------- */
  function scan(arr, dt, W, pers) {
    var n = arr.length, pre = new Float64Array(n + 1), i;
    for (i = 0; i < n; i++) pre[i + 1] = pre[i] + arr[i];
    var S = new Float64Array(n);
    for (i = 2 * W - 1; i < n; i++) {
      S[i] = (pre[i - W + 1] - pre[i - 2 * W + 1]) / W - (pre[i + 1] - pre[i - W + 1]) / W;
    }
    var cand = [], run = 0;
    for (i = 2 * W - 1; i < n; i++) {
      if (S[i] > state.thr) {
        run++;
        if (run === pers) cand.push({ i: i - pers + 1, t: (i - pers + 1) * dt, iPeak: i, peak: S[i] });
      } else run = 0;
    }
    return { S: S, cand: cand };
  }
  /* S 三角脉冲的峰在「突变时刻 + W」，取峰两侧各 W 个样本做 S² 加权质心：
     对幅度不敏感、对尾部噪声不敏感，两端的系统偏差同向，做差时抵消。 */
  function centroid(Sc, iTrig, W) {
    var i0 = Math.max(2 * W - 1, iTrig - 2 * W), i1 = Math.min(Sc.length - 1, iTrig + 3 * W), i;
    var pk = 0, ip = i0;
    for (i = i0; i <= i1; i++) if (Sc[i] > pk) { pk = Sc[i]; ip = i; }
    var a = Math.max(0, ip - W), b = Math.min(Sc.length - 1, ip + W);
    var num = 0, den = 0;
    for (i = a; i <= b; i++) {
      var w = Sc[i] > 0 ? Sc[i] * Sc[i] : 0;
      num += w * i; den += w;
    }
    return { ic: den > 0 ? num / den : ip, peak: pk };
  }

  /* ---------------- 精分析：1 s 原始数据 ---------------- */
  function inGap(t) {
    for (var i = 0; i < GAPS1.length; i++) if (t >= GAPS1[i][0] && t < GAPS1[i][1]) return true;
    return false;
  }
  function fineWindow(s, t0, n) {
    var Pf = new Float64Array(n), B = new Float64Array(n), mult = MULT(), hold = null;
    for (var k = 0; k < n; k++) {
      var t = t0 + k;
      B[k] = smooth(s, t);
      var v = B[k] + evSum(s, t) + SIG * mult * FN[s][Math.round(t)];
      /* 缺测段保持上一点的值（线性补点的简化） */
      if (s === 0 && inGap(t) && hold !== null) v = hold;
      hold = v;
      Pf[k] = v;
    }
    return { P: Pf, B: B, t0: t0 };
  }
  function fineDetectFrom(w, tRef) {
    var sc = scan(w.P, DT_F, W_F, PERS_F);
    if (!sc.cand.length) return null;
    var target = tRef == null ? sc.cand[0].t : (tRef - w.t0);
    var near = sc.cand.filter(function (c) { return Math.abs(c.t - target) <= 120; });
    if (!near.length) return null;
    var pick = near.reduce(function (a, b) { return Math.abs(b.t - target) < Math.abs(a.t - target) ? b : a; });
    var cen = centroid(sc.S, pick.i, W_F);
    return { t: w.t0 + cen.ic - W_F, amp: cen.peak, P: w.P, B: w.B, t0: w.t0, S: sc.S, nCand: sc.cand.length };
  }

  /* ---------------- 流量平衡判据 ---------------- */
  function flowCheck(t0) {
    var i0 = Math.max(3, Math.floor((t0 - 300) / DT));
    var i1 = Math.min(N - 1, Math.floor((t0 + 3600) / DT));
    var rs = null, sign = 0, i;
    for (i = i0; i <= i1 - 2; i++) {
      var a = DQV[i], b = DQV[i + 1], c = DQV[i + 2];
      if (Math.abs(a) > 15 && Math.abs(b) > 15 && Math.abs(c) > 15 &&
        Math.sign(a) === Math.sign(b) && Math.sign(b) === Math.sign(c)) {
        rs = i; sign = Math.sign(a); break;
      }
    }
    var peakDev = 0, ipk = i0;
    for (i = i0; i <= i1; i++) {
      var d = VFLOW[i] - VFLOW[i0];
      if (Math.abs(d) > Math.abs(peakDev)) { peakDev = d; ipk = i; }
    }
    if (rs === null) {
      return { kind: 'none', t: null, dev: peakDev, net: VFLOW[i1] - VFLOW[i0], slope: 0, rate: DQV[i1], ipk: ipk };
    }
    var lastSame = rs;
    for (i = rs + 1; i <= i1; i++) { if (Math.sign(DQV[i]) === sign) lastSame = i; }
    var persist = (lastSame - rs) * DT >= 600 || Math.abs(VFLOW[i1] - VFLOW[rs]) > DV_THR;
    var aligned = Math.abs(rs * DT - t0) <= 120;
    var net = VFLOW[i1] - VFLOW[rs];
    var slope = net / Math.max(1, (i1 - rs) * DT / 3600);
    var kind = !persist ? 'pulse' : aligned ? 'sustained' : 'delayed';
    return { kind: kind, t: rs * DT, dev: peakDev, net: net, slope: slope, rate: DQV[rs], ipk: ipk };
  }
  function flowAlarmTime() {
    for (var i = 61; i < N; i++) {
      if (VFLOW[i] > DV_THR && (VFLOW[i] - VFLOW[i - 60]) > DV_GROW) return i * DT;
    }
    return null;
  }

  /* =========================================================
     ③ 事件分类器：4 类 softmax（8 特征 + 8 平方项）
     合成事件由「物理模型 + 估计误差」生成，本页现场训练；
     推理用的是真实信号链（SS 扫描 / 质心 / 流量判据）算出的特征。
     ========================================================= */
  var EVCLS = [
    { key: 'leak', name: '真泄漏', short: '泄漏', col: '#a64b3c' },
    { key: 'valve', name: '调阀', short: '调阀', col: '#a9742c' },
    { key: 'pump', name: '启泵', short: '启泵', col: '#355c74' },
    { key: 'noise', name: '噪声', short: '噪声', col: '#8a8f93' }
  ];
  var FKEYS = ['dtN', 'ampN', 'asym', 'dvN', 'slN', 'tauN', 'op', 'two'];
  var FLAB = { dtN: 'Δt 归一', ampN: '压降幅值', asym: '衰减不对称', dvN: '累计失衡', slN: '失衡斜率', tauN: '偏离半衰', op: '工况记录', two: '双端检出' };
  var NCLS = EVCLS.length, DIM = FKEYS.length * 2, NOM = 0.985, L2 = 0.006, EPOCH = 240;

  function phi(f) {
    var base = FKEYS.map(function (k) { return f[k]; });
    var sq = FKEYS.map(function (k) { return f[k] * f[k]; });
    return base.concat(sq);
  }
  function softmax(z) {
    var mx = Math.max.apply(null, z);
    var ex = z.map(function (v) { return Math.exp(v - mx); });
    var s = ex.reduce(function (a, b) { return a + b; }, 0);
    return ex.map(function (v) { return v / s; });
  }
  function forward(W, b, x) {
    var z = new Array(NCLS);
    for (var k = 0; k < NCLS; k++) {
      var s = b[k];
      for (var j = 0; j < DIM; j++) s += W[k][j] * x[j];
      z[k] = s;
    }
    return z;
  }
  function probsOf(z, T) {
    return softmax(z.map(function (v) { return v / T; }));
  }

  /* 特征级合成：同一套物理量 + 估计误差；
     12% 概率丢掉流量两维、10% 概率丢掉工况标签——现场数据缺失是常态，
     训练时就做缺失增强，推理端缺数据才不会变成另一种分布。
     另外刻意留出重叠：小漏量单端、泵切换后流量过冲、阀室长尾、
     变送器漂移造成的持续偏移，都会让 4 类在特征空间里挨在一起。 */
  function synthFeat(cls) {
    var f = { dtN: 0, ampN: 0.06, asym: 0, dvN: 0, slN: 0, tauN: 0.5, op: 0, two: 0 };
    var x, amp0, aU, aD, pct, q, thr = 0.045;
    if (cls === 'leak') {
      x = 0.04 + 0.92 * rnd();
      pct = 0.30 + 4.7 * Math.pow(rnd(), 1.2);
      amp0 = AMPK * pct * (0.8 + 0.4 * rnd());
      aU = amp0 * Math.exp(-x * L / ATT) * (0.85 + 0.3 * rnd());
      aD = amp0 * Math.exp(-(1 - x) * L / ATT) * (0.85 + 0.3 * rnd());
      f.two = (aU > thr * (1 + 0.3 * rnd()) && aD > thr * (1 + 0.3 * rnd())) ? 1 : 0;
      f.dtN = f.two ? (2 * x - 1) + gr() * 0.03 : 0;
      q = Q0 * pct / 100;
      f.dvN = q * (0.40 + 0.60 * rnd()) + gr() * 4;
      f.slN = q * (0.50 + 0.50 * rnd()) + gr() * 4;
      /* 小漏量在 60 min 确认窗里可能只积累了一部分流量差 */
      if (rnd() < 0.12) { f.dvN *= 0.25; f.slN *= 0.25; }
      f.tauN = Math.min(1, 1 - Math.abs(gr()) * 0.08);
      f.op = rnd() < 0.05 ? 1 : 0;
    } else if (cls === 'valve') {
      x = 0.2 + 0.5 * rnd();
      amp0 = 0.12 + 0.22 * rnd();
      aD = amp0 * Math.exp(-(1 - x) * L / ATT);
      aU = rnd() < 0.12 ? amp0 * Math.exp(-x * L / ATT) : 0;
      f.two = (aU > thr && aD > thr) ? 1 : 0;
      if (f.two && rnd() < 0.75) f.two = 0;      /* 上游是压力上升，S 为负，通常不触发 */
      f.dtN = f.two ? gr() * 1.0 : 0;
      f.dvN = gr() * 3; f.slN = gr() * 3;
      if (rnd() < 0.10) { f.dvN = 7 + 7 * rnd(); f.slN = 6 + 6 * rnd(); }  /* 调阀后输量短时偏移 */
      f.tauN = 0.58 + 0.16 * rnd() + gr() * 0.08;
      if (rnd() < 0.15) f.tauN += 0.25;          /* 长尾：阀室下游憋压 */
      f.op = rnd() < 0.88 ? 1 : 0;
    } else if (cls === 'pump') {
      amp0 = 0.18 + 0.22 * rnd();
      aU = amp0 * (0.95 + 0.1 * rnd());
      aD = amp0 * Math.exp(-L / ATT) * (0.85 + 0.3 * rnd());
      f.two = rnd() < 0.92 ? 1 : 0;
      f.dtN = f.two ? -1 + gr() * 0.05 : 0;
      f.dvN = -2 - 4 * rnd() + gr() * 3;
      if (rnd() < 0.12) { f.dvN = 3 + 7 * rnd(); f.slN = 3 + 6 * rnd(); } /* 切换后流量过冲 */
      f.slN = f.slN || gr() * 3;
      f.tauN = 0.52 + 0.18 * rnd() + gr() * 0.08;
      if (rnd() < 0.10) f.tauN += 0.30;
      f.op = rnd() < 0.86 ? 1 : 0;
    } else {
      aU = 0.045 + 0.055 * rnd();
      aD = rnd() < 0.15 ? 0.045 + 0.055 * rnd() : 0;
      f.two = (aU > 0.045 && aD > 0.045) ? 1 : 0;
      f.dtN = f.two ? gr() * 0.8 : 0;
      f.dvN = gr() * 3; f.slN = gr() * 3;
      /* 噪声不都是尖峰：变送器漂移会造成持续偏移 */
      var u = rnd();
      f.tauN = u < 0.6 ? 0.03 + 0.17 * rnd() : u < 0.85 ? 0.45 + 0.3 * rnd() : 0.8 + 0.2 * rnd();
      f.op = rnd() < 0.06 ? 1 : 0;
    }
    f.ampN = Math.max(aU, aD);
    f.asym = (aU + aD) > 0 ? Math.abs(aU - aD) / (aU + aD) : 0;
    if (rnd() < 0.12) { f.dvN = 0; f.slN = 0; }
    if (rnd() < 0.10) f.op = 0;
    return f;
  }

  function eceOf(ps, ys, bins) {
    var B = bins || 10, n = ps.length, sum = 0, bi, i;
    for (bi = 0; bi < B; bi++) {
      var lo = bi / B, hi = (bi + 1) / B, cnt = 0, conf = 0, acc = 0;
      for (i = 0; i < n; i++) {
        var p = ps[i], mx = Math.max.apply(null, p), top = p.indexOf(mx);
        if (mx >= lo && (mx < hi || (bi === B - 1 && mx <= 1))) {
          cnt++; conf += mx; acc += (top === ys[i]) ? 1 : 0;
        }
      }
      if (cnt) sum += cnt / n * Math.abs(conf / cnt - acc / cnt);
    }
    return sum;
  }

  var MODEL = null;
  function trainModel(extra) {
    var train = [], val = [];
    EVCLS.forEach(function (c, ci) {
      for (var i = 0; i < 320; i++) {
        seedRnd(12007 + ci * 100003 + i * 7919);
        var f = synthFeat(c.key);
        var rec = { x: phi(f), y: ci };
        if (i < 256) train.push(rec); else val.push(rec);
      }
    });
    (extra || []).forEach(function (r) {
      for (var q = 0; q < 4; q++) train.push({ x: phi(r.f), y: r.y });
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
    function std(x) { return x.map(function (vv, jj) { return (vv - mu[jj]) / sd[jj]; }); }
    for (n = 0; n < train.length; n++) train[n].x = std(train[n].x);
    for (n = 0; n < val.length; n++) val[n].x = std(val[n].x);

    var W = [], b = new Array(NCLS).fill(0), vW = [], vB = new Array(NCLS).fill(0);
    for (k = 0; k < NCLS; k++) { W.push(new Array(DIM).fill(0)); vW.push(new Array(DIM).fill(0)); }
    var lr = 0.09, hist = [], loss = 0, ep;
    for (ep = 0; ep < EPOCH; ep++) {
      var gW = [], gB = new Array(NCLS).fill(0);
      for (k = 0; k < NCLS; k++) gW.push(new Array(DIM).fill(0));
      loss = 0;
      for (n = 0; n < train.length; n++) {
        var rec = train[n];
        var z = forward(W, b, rec.x);
        var p = softmax(z);
        loss += -Math.log(Math.max(1e-9, p[rec.y]));
        for (k = 0; k < NCLS; k++) {
          /* 标签平滑：不让网络把概率压到 100% */
          var target = k === rec.y ? NOM : (1 - NOM) / (NCLS - 1);
          var dlt = p[k] - target;
          gB[k] += dlt;
          for (j = 0; j < DIM; j++) gW[k][j] += dlt * rec.x[j];
        }
      }
      for (k = 0; k < NCLS; k++) {
        vB[k] = 0.9 * vB[k] - lr * gB[k] / train.length;
        b[k] += vB[k];
        for (j = 0; j < DIM; j++) {
          vW[k][j] = 0.9 * vW[k][j] - lr * (gW[k][j] / train.length + L2 * W[k][j]);
          W[k][j] += vW[k][j];
        }
      }
      if (ep % 10 === 0 || ep === EPOCH - 1) hist.push(loss / train.length);
    }

    /* 验证：混淆矩阵 / 准确率 / 校准 */
    var conf = [], rowSum = new Array(NCLS).fill(0), correct = 0;
    var vp = [], vy = [];
    for (k = 0; k < NCLS; k++) conf.push(new Array(NCLS).fill(0));
    for (n = 0; n < val.length; n++) {
      var p1 = probsOf(forward(W, b, val[n].x), 1);
      var top1 = p1.indexOf(Math.max.apply(null, p1));
      conf[val[n].y][top1]++;
      rowSum[val[n].y]++;
      if (top1 === val[n].y) correct++;
      vp.push(p1); vy.push(val[n].y);
    }
    var ece0 = eceOf(vp, vy);
    /* 温度缩放：只在 [1, 3] 上搜索，只允许软化、不允许把模型锐化到 100%。
       温度在验证集上按 NLL 拟合，属于事后校准，不参与训练。 */
    var bestT = 1, bestN = Infinity, tt;
    for (tt = 1; tt <= 3.0001; tt += 0.02) {
      var nl = 0;
      for (n = 0; n < val.length; n++) {
        var pp = probsOf(forward(W, b, val[n].x), tt);
        nl -= Math.log(Math.max(1e-9, pp[val[n].y]));
      }
      if (nl < bestN) { bestN = nl; bestT = tt; }
    }
    var vpT = [], review = 0;
    for (n = 0; n < val.length; n++) {
      var pq = probsOf(forward(W, b, val[n].x), bestT);
      vpT.push(pq);
      if (Math.max.apply(null, pq) < 0.62) review++;
    }
    var ece1 = eceOf(vpT, vy);

    return {
      ok: isFinite(loss), W: W, b: b, mu: mu, sd: sd, hist: hist, conf: conf, rowSum: rowSum,
      acc: correct / val.length, ece0: ece0, ece1: ece1, T: bestT,
      reviewRate: review / val.length, nTrain: train.length, nVal: val.length,
      valP: vpT, valY: vy
    };
  }
  MODEL = trainModel([]);

  function predict(f) {
    var xr = phi(f);
    var x = xr.map(function (v, j) { return (v - MODEL.mu[j]) / MODEL.sd[j]; });
    var p = probsOf(forward(MODEL.W, MODEL.b, x), MODEL.T);
    var order = EVCLS.map(function (c, i) { return { key: c.key, name: c.name, i: i, p: p[i] }; });
    order.sort(function (a, b) { return b.p - a.p; });
    return { p: p, x: x, order: order };
  }

  /* ---------------- 精分析波形上的「偏离半衰」 ---------------- */
  function winMean(fw, tEv, a, b) {
    var k0 = Math.max(0, Math.round(tEv - fw.t0 + a));
    var k1 = Math.min(fw.P.length - 1, Math.round(tEv - fw.t0 + b));
    if (k1 <= k0) return 0;
    var s = 0, n = 0;
    for (var k = k0; k <= k1; k++) { s += Math.abs(fw.P[k] - fw.B[k]); n++; }
    return n ? s / n : 0;
  }
  function stockTau(fw, tEv) {
    var a1 = winMean(fw, tEv, 40, 70);
    var a2 = winMean(fw, tEv, 360, 400);
    if (a1 < 0.012 || a2 < 1e-4) return 999;
    var kk = Math.min(1, a2 / a1);
    if (kk > 0.94) return 999;
    return Math.min(999, -340 / Math.log(kk));
  }

  /* ---------------- 事件判定 ---------------- */
  function decide(e) {
    var p = e.pr.p, pLeak = p[0], top = e.pr.order[0];
    var phys = !!(e.two && e.valid);
    var flowOK = !!(state.flowX && e.fb && e.fb.kind === 'sustained');
    var opHit = !!(state.aware && e.op);
    var act, why;
    if (pLeak >= 0.62 && phys && flowOK) {
      if (opHit) {
        act = 'review';
        why = '概率 ' + pct(pLeak) + '% 与流量都支持泄漏，但触发时刻落在 ' + e.op.kind + ' 记录窗口内 → 降级复核';
      } else {
        act = 'dispatch';
        why = '分类概率、物理门限、流量平衡三关全过 → 报警 + 派车';
      }
    } else if (pLeak >= 0.40 || flowOK) {
      /* 流量持续失衡本身就是「有物质损失」的独立证据：即使只有单端压力、
         定位不可用，也必须报警（复核），只是不出派车单。 */
      act = 'review';
      if (!phys) why = '缺双端时间差（不能定位），泄漏概率 ' + pct(pLeak) + '%'
        + (flowOK ? '、流量持续失衡 ' + e.fb.net.toFixed(1) + ' m³ → 报警复核、不派车' : ' → 只报警、不派车');
      else if (!flowOK) why = '流量平衡未确认（' + (state.flowX ? '短时脉冲 / 未越判据' : '数据未接入') + '），泄漏概率 ' + pct(pLeak) + '% → 只报警、不派车';
      else why = '泄漏概率 ' + pct(pLeak) + '% 未过 0.62，证据不足以自动派车 → 人工复核';
    } else {
      act = 'suppress';
      why = '判为 ' + top.name + ' ' + pct(top.p) + '%，泄漏概率低于 0.40 → 抑制，记入回写集';
    }
    e.act = act; e.why = why;
    e.physOK = phys; e.flowOK = flowOK; e.opHit = opHit;
  }

  function analyze() {
    buildSeries();
    var sc1 = scan(P[0], DT, W_C, PERS_C), sc2 = scan(P[1], DT, W_C, PERS_C);
    S1 = sc1.S; S2 = sc2.S;
    var cs = [];
    sc1.cand.forEach(function (c) { cs.push({ t: c.t, s: 0, amp: c.peak }); });
    sc2.cand.forEach(function (c) { cs.push({ t: c.t, s: 1, amp: c.peak }); });
    cs.sort(function (a, b) { return a.t - b.t; });

    var evts = [];
    cs.forEach(function (c) {
      var last = evts[evts.length - 1];
      if (last && c.t - last.tC <= 300) {
        last.mem[c.s] = true;
        last.tTrig[c.s] = last.tTrig[c.s] == null ? c.t : Math.min(last.tTrig[c.s], c.t);
        last.peak[c.s] = Math.max(last.peak[c.s], c.amp);
      } else {
        var e = { tC: c.t, mem: [c.s === 0, c.s === 1], tTrig: [null, null], peak: [0, 0], st: [null, null] };
        e.tTrig[c.s] = c.t; e.peak[c.s] = c.amp;
        evts.push(e);
      }
    });
    if (evts.length > 40) evts = evts.slice(0, 40);   /* 极端噪声下限额 */

    evts.forEach(function (e) {
      var t0 = Math.max(0, Math.round(e.tC - HW));
      var n = Math.min(DUR - t0, 2 * HW) + 1;
      e.fine = [null, null];
      for (var s = 0; s < 2; s++) {
        var w = fineWindow(s, t0, n);
        var f = e.mem[s] ? fineDetectFrom(w, e.tC) : null;
        if (f) e.st[s] = { t: f.t, amp: f.amp };
        e.fine[s] = f || w;
      }
      e.two = !!(e.st[0] && e.st[1]);
      if (e.two) {
        e.dtRaw = e.st[0].t - e.st[1].t;
        e.dt = e.dtRaw - state.skew;          /* 两站时钟偏差 */
        e.xRaw = (L + VW * e.dt) / 2;
        e.valid = Math.abs(e.dt) <= L / VW + 5 && e.xRaw > -1 && e.xRaw < L + 1;
        e.x = Math.max(0, Math.min(L, e.xRaw));
        e.amp = Math.max(e.st[0].amp, e.st[1].amp);
      } else {
        e.valid = false;
        e.dt = null;
        e.amp = Math.max(e.st[0] ? e.st[0].amp : 0, e.st[1] ? e.st[1].amp : 0);
      }
      /* 流量与工况两路独立证据 */
      e.fb = flowCheck(e.tC);
      e.op = null;
      for (var k = 0; k < TR.ops.length; k++) {
        if (Math.abs(TR.ops[k].t0 - e.tC) <= OP_WIN) e.op = TR.ops[k];
      }
      /* 波形特征：偏离半衰 */
      var ss = (!e.st[0] || (e.st[1] && e.st[1].amp > e.st[0].amp)) ? 1 : 0;
      var fw = e.fine[ss];
      var tEv = e.st[ss] ? e.st[ss].t : (e.st[0] ? e.st[0].t : e.st[1].t);
      e.tau = fw ? stockTau(fw, tEv) : 999;
      /* 8 维特征 → 分类器 */
      var aU = e.st[0] ? e.st[0].amp : 0, aD = e.st[1] ? e.st[1].amp : 0;
      e.f = {
        dtN: e.two ? e.dt / (L / VW) : 0,
        ampN: Math.max(aU, aD),
        asym: (aU + aD) > 0 ? Math.abs(aU - aD) / (aU + aD) : 0,
        dvN: state.flowX ? e.fb.net : 0,
        slN: state.flowX ? e.fb.slope : 0,
        tauN: Math.min(1, e.tau / 700),
        op: (state.aware && e.op) ? 1 : 0,
        two: e.two ? 1 : 0
      };
      e.pr = predict(e.f);
      decide(e);
      /* 真值（仅用于示范评估） */
      e.nearLeak = !!(TR.leak && Math.abs(e.tC - TR.leak.t0) <= 600);
      e.truth = e.nearLeak ? 'leak' : (e.op ? (e.op.kind === '调阀' ? 'valve' : 'pump') : 'noise');
      var tNear = e.two ? Math.min(e.st[0].t, e.st[1].t) : (e.st[0] ? e.st[0].t : (e.st[1] ? e.st[1].t : e.tC));
      e.tNear = tNear;
      e.tOnset = (e.two && e.valid) ? e.st[0].t - e.x / VW : e.tC;   /* 反推泄漏起始时刻 */
      e.tConf = tNear + W_F + PERS_F + 10;      /* 8 s 窗 + 2 s 持续 + 质心/通信 ≈ 20 s */
      e.tAlarm = e.two ? Math.max(e.st[0].t, e.st[1].t) + 20 : e.tConf;
    });

    var fbAlarm = flowAlarmTime();
    var out = { evts: evts, fbAlarm: fbAlarm, seep: null };
    out.fp = 0; out.sup = 0; out.review = 0; out.dispatch = 0;
    evts.forEach(function (e) {
      if (e.act === 'dispatch') { out.dispatch++; if (!e.nearLeak) out.fp++; }
      else if (e.act === 'review') { out.review++; if (!e.nearLeak) out.fp++; }
      else out.sup++;
    });
    var leakDetected = evts.some(function (e) { return e.nearLeak && e.act !== 'suppress'; });
    if (fbAlarm !== null && TR.leak && !leakDetected && Math.abs(fbAlarm - TR.leak.t0) <= 3600) {
      out.seep = { t: fbAlarm, fp: false }; leakDetected = true;
    }
    if (fbAlarm !== null && !TR.leak) { out.seep = { t: fbAlarm, fp: true }; out.fp++; }
    out.leakDetected = leakDetected;
    out.miss = !!(TR.leak && !leakDetected);

    /* 主事件：优先派车，其次复核，最后任意 */
    var prim = null;
    evts.forEach(function (e) { if (!prim && e.act === 'dispatch') prim = e; });
    if (!prim) evts.forEach(function (e) { if (!prim && e.act === 'review') prim = e; });
    if (!prim && evts.length) prim = evts[0];
    out.prim = prim;
    return out;
  }

  /* ================= 绘制：管线纵剖面 ================= */
  var PT = 96, PHILL = 28;
  function terrY(x) {
    var u = Math.max(0, Math.min(1, (x - PX0) / PXW));
    return PT - PHILL * Math.sin(Math.PI * u);
  }
  function xOfKm(m) { return PX0 + m / L * PXW; }
  var pipeBuilt = false, anim = { pw1: null, pw2: null, fl1: null, fl2: null, lk: null, est: null, band: null };
  function buildPipe() {
    var svg = el('pipe'), pts = [], i, u;
    for (i = 0; i <= 24; i++) { u = i / 24; pts.push([PX0 + u * PXW, terrY(PX0 + u * PXW)]); }
    var dline = pts.map(function (p, j) { return (j ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ');
    var h = [];
    h.push("<rect id='est-band' x='0' y='40' width='0' height='108' fill='rgba(36,92,90,.10)'/>");
    h.push("<path d='" + dline + " L" + (PX0 + PXW) + " 148 L" + PX0 + " 148 Z' fill='#faf7f0' stroke='none'/>");
    h.push("<path d='" + dline + "' fill='none' stroke='#cdd8e2' stroke-width='1'/>");
    h.push("<path d='" + dline + "' fill='none' stroke='#e3dccd' stroke-width='7' stroke-linecap='round'/>");
    h.push("<path d='" + dline + "' fill='none' stroke='#99a3a4' stroke-width='1.4'/>");
    h.push("<path d='M" + PX0 + " 156 L" + (PX0 + PXW) + " 156' stroke='#d3c9b6' stroke-width='1'/>");
    for (i = 0; i <= 6; i++) {
      var km = i * 20, xp = xOfKm(km * 1000);
      h.push("<path d='M" + xp.toFixed(1) + " 152 L" + xp.toFixed(1) + " 160' stroke='#d3c9b6' stroke-width='1'/>");
      h.push("<text x='" + xp.toFixed(1) + "' y='171' font-size='9' font-family='monospace' fill='#99a3a4' text-anchor='middle'>" + km + "</text>");
    }
    h.push("<text x='" + (PX0 - 6) + "' y='171' font-size='9' font-family='monospace' fill='#99a3a4' text-anchor='end'>km</text>");
    h.push("<text id='pipe-t1' x='" + PX0 + "' y='140' font-size='9' font-family='monospace' fill='#4a585c'>—</text>");
    h.push(stationIcon(0));
    h.push(stationIcon(1));
    h.push("<g id='pw1'><path d='M0 -18 C-7 -9 -7 9 0 18' fill='none' stroke='#1d4e50' stroke-width='2.2'/><path d='M10 -18 C3 -9 3 9 10 18' fill='none' stroke='#1d4e50' stroke-width='1.2' opacity='.5'/></g>");
    h.push("<g id='pw2'><path d='M0 -18 C-7 -9 -7 9 0 18' fill='none' stroke='#355c74' stroke-width='2.2'/><path d='M10 -18 C3 -9 3 9 10 18' fill='none' stroke='#355c74' stroke-width='1.2' opacity='.5'/></g>");
    h.push("<circle id='fl1' cx='" + PX0 + "' cy='" + terrY(PX0).toFixed(1) + "' r='8' fill='none' stroke='#1d4e50' stroke-width='1.8' opacity='0'/>");
    h.push("<circle id='fl2' cx='" + (PX0 + PXW) + "' cy='" + terrY(PX0 + PXW).toFixed(1) + "' r='8' fill='none' stroke='#355c74' stroke-width='1.8' opacity='0'/>");
    /* 真实漏点 */
    h.push("<g id='lk'><path d='M0 -4 L-9 -20 L9 -20 Z' fill='#a64b3c'/><circle cx='0' cy='-2' r='3.6' fill='#a64b3c'/>"
      + "<text id='lk-l1' x='-9' y='-26' font-size='9.5' fill='#a64b3c' text-anchor='end' stroke='#ffffff' stroke-width='2.6' paint-order='stroke'>真实 —</text>"
      + "<text id='lk-l2' x='-9' y='-15' font-size='8.5' fill='#83551f' text-anchor='end' stroke='#ffffff' stroke-width='2.4' paint-order='stroke'>—</text></g>");
    /* 算法定位 */
    h.push("<g id='est'><path d='M0 -2 L-9 -13 L0 -24 L9 -13 Z' fill='none' stroke='#245c5a' stroke-width='1.6'/>"
      + "<text id='est-l1' x='9' y='-26' font-size='9.5' fill='#123a3d' text-anchor='start' stroke='#ffffff' stroke-width='2.6' paint-order='stroke'>定位 —</text>"
      + "<text id='est-l2' x='9' y='-15' font-size='8.5' fill='#245c5a' text-anchor='start' stroke='#ffffff' stroke-width='2.4' paint-order='stroke'>—</text></g>");
    svg.innerHTML = h.join('');
    pipeBuilt = true;
    anim.pw1 = el('pw1'); anim.pw2 = el('pw2'); anim.fl1 = el('fl1'); anim.fl2 = el('fl2');
    anim.lk = el('lk'); anim.est = el('est'); anim.band = el('est-band');
  }
  function stationIcon(s) {
    var x = s ? PX0 + PXW : PX0, y = terrY(x), bx = x - (s ? 52 : 8);
    var o = [];
    o.push("<rect x='" + bx + "' y='104' width='60' height='30' rx='6' fill='#ffffff' stroke='#e3dccd'/>");
    o.push("<rect x='" + (bx + 5) + "' y='109' width='4' height='20' rx='2' fill='" + (s ? '#355c74' : '#1d4e50') + "'/>");
    o.push("<text x='" + (bx + 13) + "' y='115' font-size='10' fill='#4a585c'>" + (s ? '末站' : '首站') + "</text>");
    o.push("<text x='" + (bx + 13) + "' y='128' font-size='8.5' font-family='monospace' fill='#99a3a4'>x = " + (s ? '120' : '0') + " km</text>");
    o.push("<path d='M" + x.toFixed(1) + " " + y.toFixed(1) + " L" + x.toFixed(1) + " 104' stroke='#d3c9b6' stroke-width='1' stroke-dasharray='2 2'/>");
    return o.join('');
  }
  function updatePipe(A) {
    if (!pipeBuilt) return;
    var xl = xOfKm(TR.x), yl = terrY(xl);
    anim.lk.style.display = TR.leak ? '' : 'none';
    if (TR.leak) {
      anim.lk.setAttribute('transform', 'translate(' + xl.toFixed(1) + ' ' + yl.toFixed(1) + ')');
      el('lk-l1').textContent = '真实 ' + (TR.x / 1000).toFixed(2);
      el('lk-l2').textContent = TR.q.toFixed(0) + ' m³/h';
    }
    var e = A.prim;
    var show = !!(e && e.two && e.valid && (e.act === 'dispatch' || e.act === 'review'));
    anim.est.style.display = show ? '' : 'none';
    anim.band.style.display = show ? '' : 'none';
    if (show) {
      var xe = xOfKm(e.x);
      anim.est.setAttribute('transform', 'translate(' + xe.toFixed(1) + ' ' + terrY(xe).toFixed(1) + ')');
      el('est-l1').textContent = '定位 ' + (e.x / 1000).toFixed(2);
      var bw = Math.abs(xOfKm(e.x + 1200) - xOfKm(e.x - 1200));
      anim.band.setAttribute('x', (xe - bw / 2).toFixed(1));
      anim.band.setAttribute('width', bw.toFixed(1));
      el('est-l2').textContent = TR.leak
        ? '误差 ' + Math.abs(e.x - TR.x).toFixed(0) + ' m' + (e.act === 'review' ? ' · 待复核' : '')
        : (e.act === 'review' ? '待复核，不派车' : '抑制，不输出');
    }
    var d1 = Math.abs(TR.x - XS[0]), d2 = Math.abs(XS[1] - TR.x);
    el('pipe-t1').textContent = TR.leak
      ? 'v = ' + VW + ' m/s · 首站波到 t + ' + (d1 / VW).toFixed(0) + ' s · 末站 t + ' + (d2 / VW).toFixed(0)
        + ' s · 真值 Δt = ' + ((d1 - d2) / VW).toFixed(1) + ' s'
      : '本场景无泄漏：位置与漏量滑杆不参与计算';
  }

  /* ================= 绘制：24 h 双站压力 ================= */
  var CV = {};
  function ctxOf(id, h) {
    var cv = el(id), w = cv.clientWidth || 640, dpr = Math.min(2, window.devicePixelRatio || 1);
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    }
    var c = cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    CV[id] = { c: c, w: w, h: h };
    return CV[id];
  }
  function niceRange(lo, hi) {
    var pad = (hi - lo) * 0.16 || 0.05;
    lo -= pad; hi += pad;
    if (hi - lo < 0.06) { var m = (hi + lo) / 2; lo = m - 0.03; hi = m + 0.03; }
    return { lo: lo, hi: hi };
  }
  function polyline(c, xf, yf, arr, i0, i1, step) {
    c.beginPath();
    var first = true;
    for (var i = i0; i <= i1; i += step) {
      var px = xf(i), py = yf(arr[i]);
      if (first) { c.moveTo(px, py); first = false; } else c.lineTo(px, py);
    }
    c.stroke();
  }
  function halo(c, txt, x, y, col) {
    c.lineWidth = 2.6; c.strokeStyle = '#ffffff';
    c.strokeText(txt, x, y);
    c.fillStyle = col; c.fillText(txt, x, y);
    c.lineWidth = 1;
  }

  function drawPres(A) {
    var H = 270, g = ctxOf('pres', H), c = g.c, W = g.w;
    var Lp = 54, Rp = 12, T = 12, gap = 8, ph = [64, 64, 56];
    var y0 = [T, T + ph[0] + gap, T + ph[0] + gap + ph[1] + gap];
    var X = function (t) { return Lp + t / DUR * (W - Lp - Rp); };
    var rng = [], s, i;
    for (s = 0; s < 2; s++) {
      var lo = Infinity, hi = -Infinity;
      for (i = 0; i < N; i++) { if (P[s][i] < lo) lo = P[s][i]; if (P[s][i] > hi) hi = P[s][i]; }
      rng.push(niceRange(lo, hi));
    }
    var yf = [function (v) { return y0[0] + (1 - (v - rng[0].lo) / (rng[0].hi - rng[0].lo)) * ph[0]; },
      function (v) { return y0[1] + (1 - (v - rng[1].lo) / (rng[1].hi - rng[1].lo)) * ph[1]; }];
    var smax = state.thr * 2.4;
    for (i = 0; i < N; i++) { if (S1[i] > smax) smax = S1[i]; if (S2[i] > smax) smax = S2[i]; }
    var yc = function (v) { return y0[2] + ph[2] / 2 - v / smax * (ph[2] / 2); };

    var CO = ['#1d4e50', '#355c74'], p;
    for (p = 0; p < 3; p++) {
      c.fillStyle = '#fff'; c.fillRect(Lp, y0[p], W - Lp - Rp, ph[p]);
      c.strokeStyle = '#e3dccd'; c.lineWidth = 1; c.strokeRect(Lp + 0.5, y0[p] + 0.5, W - Lp - Rp - 1, ph[p] - 1);
    }
    c.font = '8.5px ui-monospace, monospace';
    for (p = 0; p < 2; p++) {
      var st = (rng[p].hi - rng[p].lo) / 3;
      c.textAlign = 'right';
      for (var q = 0; q <= 3; q++) {
        var vv = rng[p].lo + q * st, yy = yf[p](vv);
        c.strokeStyle = '#f0ede4';
        c.beginPath(); c.moveTo(Lp, yy); c.lineTo(W - Rp, yy); c.stroke();
        c.fillStyle = '#99a3a4';
        c.fillText(vv.toFixed(2), Lp - 4, yy + 3);
      }
      c.textAlign = 'left';
      halo(c, nameS[p] + (p ? '进站压力 MPa' : '出站压力 MPa'), Lp + 4, y0[p] + 11, CO[p]);
    }
    /* 泄漏区段与工况色带 */
    if (TR.leak) {
      var xl = X(TR.leak.t0);
      c.fillStyle = 'rgba(176,84,74,.09)';
      c.fillRect(xl, y0[0], W - Rp - xl, ph[0] + gap + ph[1]);
      c.strokeStyle = 'rgba(176,84,74,.5)'; c.setLineDash([3, 3]);
      c.beginPath(); c.moveTo(xl, y0[0]); c.lineTo(xl, y0[0] + ph[0] + gap + ph[1]); c.stroke();
      c.setLineDash([]);
      c.textAlign = xl > W - 220 ? 'right' : 'left';
      halo(c, '泄漏起 ' + clockHM(TR.leak.t0), xl > W - 220 ? W - Rp - 2 : xl + 4, y0[0] + 22, '#a64b3c');
      c.textAlign = 'left';
    }
    TR.ops.forEach(function (o) {
      var xo = X(o.t0);
      c.fillStyle = 'rgba(192,118,43,.16)';
      c.fillRect(xo, y0[0], Math.max(2, X(o.t0 + 600) - xo), ph[0] + gap + ph[1]);
      c.textAlign = xo > W - 80 ? 'right' : 'left';
      halo(c, '▲' + o.kind, xo > W - 80 ? xo - 3 : xo + 3, y0[2] - 3, '#a9742c');
      c.textAlign = 'left';
    });
    /* 曲线 */
    var step = Math.max(1, Math.round(N / (W - Lp - Rp)));
    for (s = 0; s < 2; s++) {
      c.strokeStyle = CO[s]; c.lineWidth = 1.1;
      polyline(c, function (ii) { return X(ii * DT); }, yf[s], P[s], 0, N - 1, step);
    }
    /* 主事件竖线 */
    var e = A.prim;
    if (e) {
      var xt = X(e.tC);
      c.strokeStyle = '#4a585c'; c.lineWidth = 1.2;
      c.beginPath(); c.moveTo(xt, y0[0]); c.lineTo(xt, y0[0] + ph[0] + gap + ph[1]); c.stroke();
      c.textAlign = xt > W - 210 ? 'right' : 'left';
      halo(c, (e.act === 'dispatch' ? '派车' : e.act === 'review' ? '复核' : '抑制') + ' @ ' + clockHM(e.tC),
        xt > W - 210 ? xt - 4 : xt + 4, y0[0] + 11, e.act === 'dispatch' ? '#123a3d' : '#6f7a7c');
      c.textAlign = 'left';
    }
    /* S 面板 */
    c.font = '8.5px ui-monospace, monospace';
    c.strokeStyle = '#d3c9b6';
    c.beginPath(); c.moveTo(Lp, yc(0)); c.lineTo(W - Rp, yc(0)); c.stroke();
    c.fillStyle = '#99a3a4'; c.textAlign = 'right';
    c.fillText(smax.toFixed(2), Lp - 4, yc(smax) + 6);
    c.fillText('0', Lp - 4, yc(0) + 3);
    c.textAlign = 'left';
    halo(c, '突变指标 S = 前 60 s 均值 − 后 60 s 均值（首站橙 / 末站蓝）', Lp + 4, y0[2] + 11, '#6f7a7c');
    var cols = Math.max(1, Math.round(W - Lp - Rp));
    for (s = 0; s < 2; s++) {
      var Sx = s === 0 ? S1 : S2;
      c.beginPath(); c.moveTo(Lp, yc(0));
      for (var cx = 0; cx <= cols; cx++) {
        var ta = cx / cols * DUR, tb = (cx + 1) / cols * DUR;
        var a = Math.floor(ta / DT), b = Math.max(a + 1, Math.ceil(tb / DT)), mx = 0;
        for (var k2 = a; k2 < b && k2 < N; k2++) if (Sx[k2] > mx) mx = Sx[k2];
        c.lineTo(Lp + cx / cols * (W - Lp - Rp), yc(mx));
      }
      c.lineTo(W - Rp, yc(0)); c.closePath();
      c.fillStyle = s === 0 ? 'rgba(192,118,43,.22)' : 'rgba(49,99,156,.18)';
      c.fill();
      c.strokeStyle = s === 0 ? '#a9742c' : '#355c74'; c.lineWidth = 1; c.stroke();
    }
    c.strokeStyle = '#a64b3c'; c.setLineDash([4, 3]); c.lineWidth = 1.1;
    c.beginPath(); c.moveTo(Lp, yc(state.thr)); c.lineTo(W - Rp, yc(state.thr)); c.stroke();
    c.setLineDash([]);
    c.textAlign = 'right';
    halo(c, '阈值 ' + state.thr.toFixed(3) + ' MPa', W - Rp - 2, yc(state.thr) - 3, '#a64b3c');
    c.textAlign = 'left';
    /* 事件标记：派车绿 / 复核橙 / 抑制灰 */
    A.evts.forEach(function (ev) {
      var xx = X(ev.tC);
      var col = ev.act === 'dispatch' ? '#245c5a' : ev.act === 'review' ? '#a9742c' : '#b3b8b9';
      c.beginPath();
      c.moveTo(xx, y0[2] + ph[2] - 1);
      c.lineTo(xx - 3.5, y0[2] + ph[2] - 8);
      c.lineTo(xx + 3.5, y0[2] + ph[2] - 8);
      c.closePath(); c.fillStyle = col; c.fill();
    });
    /* 时间轴 */
    c.font = '8.5px ui-monospace, monospace';
    c.textAlign = 'center';
    for (var t = 0; t <= 24; t += 2) {
      var xx2 = X(t * 3600);
      c.strokeStyle = '#d3c9b6';
      c.beginPath(); c.moveTo(xx2, y0[2] + ph[2] + 3); c.lineTo(xx2, y0[2] + ph[2] + 7); c.stroke();
      c.fillStyle = '#99a3a4'; c.fillText(t + '', xx2, y0[2] + ph[2] + 18);
    }
    c.fillText('h', Lp - 22, y0[2] + ph[2] + 18);
    c.textAlign = 'left';
  }

  /* ================= 绘制：Δt 放大 ================= */
  function drawDt(A) {
    var H = 134, g = ctxOf('dt', H), c = g.c, W = g.w;
    var Lp = 40, Rp = 8, T = 14, B = 22, ph = H - T - B;
    var e = A.prim;
    if (!e) {
      c.font = '10.5px ui-sans-serif, sans-serif'; c.fillStyle = '#99a3a4'; c.textAlign = 'center';
      c.fillText('全天没有候选事件，不需要回捞 1 s 原始数据', W / 2, H / 2);
      c.textAlign = 'left';
      return;
    }
    var arrs = [];
    if (e.st[0]) arrs.push(e.st[0].t);
    if (e.st[1]) arrs.push(e.st[1].t);
    var t1 = Math.min.apply(null, arrs), t2 = Math.max.apply(null, arrs);
    var half = Math.max(60, (t2 - t1) * 1.6);
    if (2 * half > 420) half = 210;
    var x0 = Math.max(0, t1 - half), x1 = Math.min(DUR, t2 + half);
    if (x1 - x0 < 50) { x0 = Math.max(0, x0 - 25); x1 = Math.min(DUR, x1 + 25); }
    var X = function (t) { return Lp + (t - x0) / (x1 - x0) * (W - Lp - Rp); };
    var lo = Infinity, hi = -Infinity, s, k;
    for (s = 0; s < 2; s++) {
      var f = e.fine[s];
      if (!f) continue;
      for (k = 0; k < f.P.length; k++) {
        var t = f.t0 + k, v = f.P[k] - f.B[k];
        if (t < x0 - 30 || t > x1 + 30) continue;
        if (v < lo) lo = v; if (v > hi) hi = v;
      }
    }
    if (!isFinite(lo)) { lo = -0.1; hi = 0.1; }
    var pad = (hi - lo) * 0.15 || 0.02; lo -= pad; hi += pad;
    var Y = function (v) { return T + (1 - (v - lo) / (hi - lo)) * ph; };
    c.fillStyle = '#fff'; c.fillRect(Lp, T, W - Lp - Rp, ph);
    c.strokeStyle = '#e3dccd'; c.lineWidth = 1; c.strokeRect(Lp + 0.5, T + 0.5, W - Lp - Rp - 1, ph - 1);
    c.font = '8.5px ui-monospace, monospace';
    c.textAlign = 'right'; c.fillStyle = '#99a3a4';
    c.fillText(hi.toFixed(3), Lp - 4, T + 8);
    c.fillText(lo.toFixed(3), Lp - 4, T + ph - 1);
    c.textAlign = 'left';
    c.strokeStyle = '#e3dccd'; c.setLineDash([3, 3]);
    c.beginPath(); c.moveTo(Lp, Y(0)); c.lineTo(W - Rp, Y(0)); c.stroke();
    c.setLineDash([]);
    var CO = ['#1d4e50', '#355c74'];
    for (s = 0; s < 2; s++) {
      var ff = e.fine[s];
      if (!ff) continue;
      c.strokeStyle = CO[s]; c.lineWidth = 1.15;
      c.beginPath();
      var first = true;
      for (k = 0; k < ff.P.length; k++) {
        var tt = ff.t0 + k;
        if (tt < x0 || tt > x1) continue;
        var yy = Y(ff.P[k] - ff.B[k]);
        if (first) { c.moveTo(X(tt), yy); first = false; } else c.lineTo(X(tt), yy);
      }
      c.stroke();
      c.fillStyle = CO[s];
      halo(c, nameS[s], Lp + 4 + s * 34, T + 11, CO[s]);
    }
    var seq = [];
    if (e.st[0]) seq.push({ s: 0, t: e.st[0].t, a: e.st[0].amp });
    if (e.st[1]) seq.push({ s: 1, t: e.st[1].t, a: e.st[1].amp });
    seq.sort(function (a, b) { return a.t - b.t; });
    seq.forEach(function (q, j) {
      var xx = X(q.t);
      c.strokeStyle = CO[q.s]; c.lineWidth = 1.4;
      c.beginPath(); c.moveTo(xx, T); c.lineTo(xx, T + ph); c.stroke();
      c.fillStyle = CO[q.s];
      var lab = 't' + (q.s + 1) + ' ' + clock(q.t);
      c.textAlign = j === 0 && seq.length === 2 ? 'right' : 'left';
      c.fillText(lab, j === 0 && seq.length === 2 ? xx - 3 : xx + 3, T + ph - 4);
    });
    if (e.two) {
      var xa = X(t1), xb = X(t2);
      c.strokeStyle = '#4a585c'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(xa, T + 5); c.lineTo(xb, T + 5); c.stroke();
      c.fillStyle = '#4a585c'; c.textAlign = 'center';
      c.fillText('Δt = ' + e.dt.toFixed(1) + ' s', Math.min(Math.max((xa + xb) / 2, Lp + 40), W - 46), T - 4);
    } else {
      c.fillStyle = '#a9742c'; c.textAlign = 'center';
      c.fillText('单端检出：没有 t1 / t2，定位不可用', W / 2, T - 4);
    }
    c.fillStyle = '#99a3a4'; c.textAlign = 'left';
    c.fillText('δp = 压力 − 基线（MPa）', Lp + 2, T + ph + 13);
    c.textAlign = 'right';
    c.fillText('窗口 ' + clock(x0) + ' — ' + clock(x1), W - Rp, T + ph + 13);
    c.textAlign = 'left';
  }

  /* ================= 绘制：流量平衡 ================= */
  function drawFlow(A) {
    var H = 158, g = ctxOf('flowbal', H), c = g.c, W = g.w;
    var Lp = 40, Rp = 10, T = 12, B = 20, ph = H - T - B;
    var maxV = DV_THR * 2, minV = 0, qi;
    for (qi = 0; qi < N; qi++) { if (VFLOW[qi] > maxV) maxV = VFLOW[qi]; if (VFLOW[qi] < minV) minV = VFLOW[qi]; }
    var yHi = Math.max(46, maxV * 1.1), yLo = Math.min(-14, minV * 1.1);
    var X = function (t) { return Lp + t / DUR * (W - Lp - Rp); };
    var Y = function (v) { return T + (1 - (v - yLo) / (yHi - yLo)) * ph; };
    c.fillStyle = '#fff'; c.fillRect(Lp, T, W - Lp - Rp, ph);
    c.strokeStyle = '#e3dccd'; c.lineWidth = 1; c.strokeRect(Lp + 0.5, T + 0.5, W - Lp - Rp - 1, ph - 1);
    c.font = '8.5px ui-monospace, monospace';
    c.textAlign = 'right';
    var ticks = [0, yHi * 0.33, yHi * 0.66, yHi].map(function (v) { return v >= 100 ? Math.round(v) : Math.round(v / 5) * 5; });
    ticks.forEach(function (v) {
      c.fillStyle = v === 0 ? '#6f7a7c' : '#99a3a4';
      c.fillText(v + '', Lp - 4, Y(v) + 3);
      if (v !== 0) {
        c.strokeStyle = '#f0ede4';
        c.beginPath(); c.moveTo(Lp, Y(v)); c.lineTo(W - Rp, Y(v)); c.stroke();
      }
    });
    c.textAlign = 'left';
    c.strokeStyle = '#6f7a7c';
    c.beginPath(); c.moveTo(Lp, Y(0)); c.lineTo(W - Rp, Y(0)); c.stroke();
    c.strokeStyle = '#a64b3c'; c.setLineDash([4, 3]);
    c.beginPath(); c.moveTo(Lp, Y(DV_THR)); c.lineTo(W - Rp, Y(DV_THR)); c.stroke();
    c.setLineDash([]);
    halo(c, '持续偏离判据 ' + DV_THR + ' m³', Lp + 4, Y(DV_THR) - 3, '#a64b3c');
    c.strokeStyle = '#123b3a'; c.lineWidth = 1.2;
    polyline(c, function (i) { return X(i * DT); }, function (v) { return Y(Math.max(yLo, Math.min(yHi, v))); },
      VFLOW, 0, N - 1, Math.max(1, Math.round(N / (W - Lp - Rp))));
    var pk = -1e9, ipk = 0;
    for (var i = 0; i < N; i++) if (VFLOW[i] > pk) { pk = VFLOW[i]; ipk = i; }
    c.fillStyle = '#123b3a';
    c.beginPath(); c.arc(X(ipk * DT), Y(Math.max(yLo, Math.min(yHi, pk))), 2.4, 0, Math.PI * 2); c.fill();
    c.font = '8.5px ui-monospace, monospace';
    halo(c, '峰值 ' + pk.toFixed(1) + ' m³', Lp + 4, T + 10, '#123b3a');
    var last = VFLOW[N - 1];
    c.textAlign = 'right';
    halo(c, '末值 ' + last.toFixed(1) + ' m³' + (last > yHi ? ' ↑ 超量程' : ''), W - Rp - 2, T + 10,
      last > DV_THR ? '#a64b3c' : '#6f7a7c');
    c.textAlign = 'left';
    if (A.prim && A.prim.act !== 'suppress') {
      var xf = X(A.prim.tC);
      c.strokeStyle = '#3d8558'; c.setLineDash([3, 3]);
      c.beginPath(); c.moveTo(xf, T); c.lineTo(xf, T + ph); c.stroke();
      c.setLineDash([]);
      c.textAlign = xf > W - 130 ? 'right' : 'left';
      halo(c, '事件 ' + clockHM(A.prim.tC), xf > W - 130 ? xf - 3 : xf + 3, T + ph - 6, '#3d8558');
      c.textAlign = 'left';
    }
    if (A.seep) {
      var xs = X(A.seep.t);
      c.strokeStyle = '#a9742c'; c.setLineDash([2, 3]);
      c.beginPath(); c.moveTo(xs, T); c.lineTo(xs, T + ph); c.stroke();
      c.setLineDash([]);
      halo(c, '流量法 ' + clockHM(A.seep.t), xs + 3, T + 22, '#83551f');
    }
    c.strokeStyle = '#d3c9b6';
    for (var t = 0; t <= 24; t += 4) {
      var xx = X(t * 3600);
      c.beginPath(); c.moveTo(xx, T + ph + 3); c.lineTo(xx, T + ph + 7); c.stroke();
      c.fillStyle = '#99a3a4'; c.textAlign = 'center'; c.fillText(t + '', xx, T + ph + 16);
    }
    c.textAlign = 'left'; c.fillText('h', Lp - 20, T + ph + 16);
  }

  /* ================= 时间格式 ================= */
  function clockHM(t) {
    t = Math.max(0, Math.round(t));
    if (t >= DUR) return '24:00';
    return ('0' + Math.floor(t / 3600) % 24).slice(-2) + ':' + ('0' + Math.floor(t / 60) % 60).slice(-2);
  }
  function clock(t) {
    t = Math.max(0, Math.round(t));
    if (t >= DUR) return '24:00:00';
    return clockHM(t) + ':' + ('0' + Math.floor(t % 60)).slice(-2);
  }
  function clockD(t) {
    t = Math.max(0, t);
    return clockHM(t) + ':' + ('0' + Math.floor(t % 60)).slice(-2) + '.' + Math.floor(t % 1 * 10);
  }
  function el(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (ch) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]; }); }
  function actName(a) { return a === 'dispatch' ? '派车' : a === 'review' ? '复核' : '抑制'; }
  function actCls(a) { return a === 'dispatch' ? 'ok' : a === 'review' ? 'warn' : 'plain'; }
  /* 概率百分比：≥99.5% 保留一位小数，避免把 99.8% 显示成 100% */
  function pct(p) { var v = p * 100; return v >= 99.5 ? v.toFixed(1) : v.toFixed(0); }
  function row(k, v) { return '<div class="vrow"><span class="vk">' + k + '</span><span class="vv">' + v + '</span></div>'; }

  function syncCtrl() {
    var on = state.scen === 'leak';
    ['r-pos', 'r-leak'].forEach(function (id) {
      var r = el(id); if (!r) return;
      r.disabled = !on;
      r.style.opacity = on ? '' : '.4';
    });
  }

  /* ================= 渲染 ================= */
  function render() {
    syncCtrl();
    TR = buildTruth();
    var A = analyze();
    updatePipe(A);
    drawPres(A);
    drawDt(A);
    drawFlow(A);
    paint(A);
    return A;
  }

  function paint(A) {
    var e = A.prim;
    var top = e ? e.pr.order[0] : null;
    var leakP = e ? e.pr.p[0] : 0;
    /* 头部 */
    var missNow = !!(TR.leak && A.miss);
    el('st-verdict').innerHTML = missNow ? '<span class="db bad">漏报</span>'
      : e ? '<span class="db ' + actCls(e.act) + '">' + top.name + '</span>' : '<span class="db plain">无事件</span>';
    el('st-verdict').parentNode.className = 'dstat ' + (missNow ? 'bad'
      : e ? (e.act === 'dispatch' ? 'good' : e.act === 'review' ? 'warn' : '') : '');
    el('st-conf').innerHTML = (missNow || !e) ? '—' : pct(top.p) + '<small>%</small>';
    el('st-conf').parentNode.className = 'dstat ' + (e && !missNow ? (top.p >= 0.62 ? 'good' : 'warn') : '');
    var dly = (e && TR.leak && e.nearLeak) ? Math.max(0, e.tAlarm - TR.leak.t0) : null;
    if (dly == null && A.seep && TR.leak) dly = Math.max(0, A.seep.t - TR.leak.t0);
    el('st-delay').innerHTML = A.miss ? '<span style="color:var(--bad);font-size:11px">漏报</span>' : dly == null ? '—'
      : dly < 120 ? dly.toFixed(0) + '<small>s</small>' : (dly / 60).toFixed(1) + '<small>min</small>';
    var errV = (e && e.two && e.valid && TR.leak && e.nearLeak) ? Math.abs(e.x - TR.x) : null;
    el('st-err').innerHTML = errV == null ? '—' : errV.toFixed(0) + '<small>m</small>';
    el('st-err').parentNode.className = 'dstat ' + (errV == null ? '' : errV <= 60 ? 'good' : errV <= 200 ? 'warn' : 'bad');
    el('time-hint').textContent = 't = 24:00 · 全天';

    /* 01 质控 */
    var snrDb = 20 * Math.log(Math.max(0.05, (e ? Math.max(e.f.ampN, 0.05) : 0.1)) / (SIG * state.noise / Math.sqrt(W_F))) / Math.LN10;
    el('q-his').textContent = String(N);
    el('q-q0').textContent = String(Q0);
    el('q-op').innerHTML = state.aware
      ? (TR.ops.length ? TR.ops.length + ' 条（' + TR.ops.map(function (o) { return clockHM(o.t0) + ' ' + o.kind; }).join(' / ') + '）' : '0 条') +
        ' <span class="db ok">已接入</span>'
      : '<span class="db bad">未接入</span> 工况感知失效';
    el('q-miss').innerHTML = '99.97% <span class="db ok">缺测 3 段 / 26 s 已补点</span>';
    el('q-skew').innerHTML = (state.skew >= 0 ? '+' : '') + state.skew.toFixed(2) + ' s · 偏差 '
      + (VW * state.skew / 2).toFixed(0) + ' m ' + (Math.abs(state.skew) <= 0.2
        ? '<span class="db ok">合格</span>' : Math.abs(state.skew) <= 0.4 ? '<span class="db warn">临界</span>' : '<span class="db bad">超限</span>');
    el('q-drift').innerHTML = (8 + state.noise * 6).toFixed(0) + ' Pa/24h · 差分后 < 0.001 MPa ' + (state.noise <= 2.2 ? '<span class="db ok">合格</span>' : '<span class="db warn">需复核</span>');
    el('q-snr').innerHTML = snrDb.toFixed(0) + ' dB ' + (snrDb >= 18 ? '<span class="db ok">可用</span>' : snrDb >= 10 ? '<span class="db warn">偏低</span>' : '<span class="db bad">不可用</span>');
    var gate = [];
    if (state.noise > 2.4) gate = ['warn', '降级：噪声 ' + state.noise.toFixed(1) + '×，粗筛误触发显著增加'];
    else if (Math.abs(state.skew) > 0.4) gate = ['bad', '超限：时钟差 ' + state.skew.toFixed(2) + ' s，定位系统偏差 ' + Math.abs(VW * state.skew / 2).toFixed(0) + ' m'];
    else gate = ['ok', '可用 · 进入检测与分类'];
    el('q-gate').innerHTML = '<span class="db ' + gate[0] + '">' + gate[1] + '</span>';

    /* 02 检测 */
    el('d-cand').innerHTML = A.evts.length + ' 次' + (A.evts.length ? '（合并后）' : ' · 全天无触发');
    el('d-win').textContent = '±' + (HW / 60).toFixed(0) + ' min · 1 s 原始流';
    el('d-fine').textContent = 'W = ' + W_F + ' s · 持续 ' + PERS_F + ' 点 · S² 质心';
    if (e && e.st[0] && e.st[1]) {
      el('d-t').innerHTML = clockD(e.st[0].t) + ' / ' + clockD(e.st[1].t);
    } else if (e) {
      el('d-t').innerHTML = (e.st[0] ? '首站 ' + clockD(e.st[0].t) : '末站 ' + clockD(e.st[1].t)) + ' <small>另一端未确认</small>';
    } else el('d-t').textContent = '—';
    el('d-res').innerHTML = e && e.two
      ? '1 s 数据 → ±' + (VW * 0.3 / 1000).toFixed(2) + ' km <small>（10 s 库 ±' + (VW * 5 / 1000).toFixed(1) + ' km）</small>'
      : '—';
    el('cands').innerHTML = A.evts.length
      ? A.evts.slice(0, 4).map(function (ev) {
        return '<div class="cand"><span class="t">' + clock(ev.tOnset) + '</span><span class="d">'
          + (ev.st[0] ? '首站' : '') + (ev.st[0] && ev.st[1] ? '+' : '') + (ev.st[1] ? '末站' : '')
          + ' 突变 ' + (Math.max(ev.peak[0], ev.peak[1]) * 1000).toFixed(0) + ' kPa · ' + ev.pr.order[0].name
          + ' ' + pct(ev.pr.p[ev.pr.order[0].i]) + '%</span><span class="x ' + (ev.act === 'dispatch' ? 'ok' : ev.act === 'review' ? 'warn' : '') + '">' + actName(ev.act) + '</span></div>';
      }).join('')
      : '<p class="mini" style="padding:6px 0">全天突变指标未越阈值：没有事件需要分类。</p>';

    /* 03 模型 */
    el('m-n').textContent = MODEL.nTrain + ' / ' + MODEL.nVal;
    el('m-acc').innerHTML = (MODEL.acc * 100).toFixed(1) + '%';
    el('m-ece').innerHTML = (MODEL.ece1 * 100).toFixed(1) + '%';
    el('m-ece-s').textContent = 'T = ' + MODEL.T.toFixed(2) + ' · 偏保守';
    el('m-cover').innerHTML = ((1 - MODEL.reviewRate) * 100).toFixed(1) + '%';
    el('m-summary').innerHTML = '准确率 <b>' + (MODEL.acc * 100).toFixed(1) + '%</b> · ECE <b>'
      + (MODEL.ece1 * 100).toFixed(1) + '%</b> · T <b>' + MODEL.T.toFixed(2) + '</b> · 复核 <b>' + (MODEL.reviewRate * 100).toFixed(1) + '%</b>';
    el('m-badge').textContent = MODEL.ok ? '已训练' : '回退';
    el('m-badge').className = 'db ' + (MODEL.ok ? 'ok' : 'warn');
    el('cls-hint').textContent = e ? clockHM(e.tC) + ' · ' + top.name + ' ' + pct(top.p) + '%' : '无候选事件';
    drawCurve();
    drawCM();
    drawProbs(e);
    drawFeats(e);
    /* 04 决策 */
    drawAdvice(e, A);
    /* 05 闭环 */
    el('l-alarm').innerHTML = A.evts.length ? (A.dispatch + A.review) + ' / ' + A.sup : '—';
    el('l-fp').innerHTML = A.fp + '<small>次</small>';
    el('l-delay').innerHTML = A.miss ? '<span style="color:var(--bad);font-size:11px">漏报</span>'
      : dly == null ? '—' : dly < 120 ? dly.toFixed(0) + '<small>s</small>' : (dly / 60).toFixed(1) + '<small>min</small>';
    el('l-err').innerHTML = errV == null ? '—' : errV.toFixed(0) + '<small>m</small>';
    el('l-fp').className = 'v' + (A.fp ? ' bad' : ' ok');
    el('l-err').className = 'v' + (errV == null ? '' : errV <= 60 ? ' ok' : errV <= 200 ? ' warn' : ' bad');
    el('fb-note').textContent = '回写 ' + (fb.leak + fb.bad) + ' 条' + (fb.bad ? ' · 其中误报 ' + fb.bad + ' 条' : '') + ' · 人工确认后才进入下一轮训练';
    /* 结论 */
    el('note').innerHTML = noteOf(A, e);
  }

  function drawCurve() {
    var svg = el('curve');
    if (!svg) return;
    var W = 320, H = 74, Lp = 26, Rp = 6, T = 8, B = 15;
    var hist = MODEL.hist;
    var lo = Math.min.apply(null, hist), hi = Math.max.apply(null, hist);
    var pad = (hi - lo) * 0.15 || 0.01;
    lo = Math.max(0, lo - pad); hi += pad;
    function X(i) { return Lp + i * (W - Lp - Rp) / Math.max(1, hist.length - 1); }
    function Y(v) { return T + (1 - (v - lo) / (hi - lo)) * (H - T - B); }
    var s = '';
    [0, 0.5, 1].forEach(function (t) {
      var v = lo + (hi - lo) * t, y = Y(v);
      s += '<line x1="' + Lp + '" y1="' + y + '" x2="' + (W - Rp) + '" y2="' + y + '" stroke="#efece1"/>' +
        '<text x="' + (Lp - 3) + '" y="' + (y + 3) + '" text-anchor="end" font-size="7.5" font-family="monospace" fill="#99a3a4">' + v.toFixed(2) + '</text>';
    });
    var d = hist.map(function (v, i) { return (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1); }).join('');
    s += '<path d="' + d + '" fill="none" stroke="#1d4e50" stroke-width="1.7"/>';
    s += '<circle cx="' + X(hist.length - 1).toFixed(1) + '" cy="' + Y(hist[hist.length - 1]).toFixed(1) + '" r="2.2" fill="#1d4e50"/>';
    s += '<text x="' + (W - Rp) + '" y="' + (H - 2) + '" text-anchor="end" font-size="7.5" font-family="monospace" fill="#99a3a4">' + EPOCH + ' 轮</text>';
    s += '<text x="' + Lp + '" y="' + (H - 2) + '" font-size="7.5" font-family="monospace" fill="#99a3a4">0</text>';
    svg.innerHTML = s;
  }

  function drawCM() {
    var names = EVCLS.map(function (c) { return c.name; });
    var h = '<span class="lb" style="font-size:7.5px">真↓/预→</span>' + names.map(function (n) {
      return '<span style="text-align:center;color:var(--ink-4);font-size:7.5px">' + n + '</span>';
    }).join('');
    MODEL.conf.forEach(function (r, i) {
      var sum = r.reduce(function (a, b) { return a + b; }, 0) || 1;
      h += '<span class="lb">' + names[i] + '</span>' + r.map(function (v) {
        var q = v / sum;
        var a = q > 0.5 ? 0.14 + q * 0.7 : q * 1.1;
        return '<i style="background:rgba(18,59,58,' + a.toFixed(2) + ');display:flex;align-items:center;justify-content:center;color:'
          + (q > 0.5 ? '#f3eee3' : '#45524d') + ';font-family:var(--mono);font-size:7.5px" title="' + (q * 100).toFixed(0) + '%">'
          + (q >= 0.04 ? Math.round(q * 100) : '') + '</i>';
      }).join('');
    });
    var cm = el('cm');
    cm.style.gridTemplateColumns = '40px repeat(4, minmax(0,1fr))';
    cm.innerHTML = h;
  }

  function drawProbs(e) {
    var box = el('probs');
    if (!e) {
      box.innerHTML = '<p class="mini" style="padding:4px 0">没有候选事件：分类器不输出概率。降低阈值或调大噪声可以造出候选。</p>';
      return;
    }
    box.innerHTML = EVCLS.map(function (c, i) {
      var p = e.pr.p[i], on = e.pr.order[0].i === i;
      return '<div class="dbar" style="padding:2px 0"><span style="width:52px;font-size:10px;color:' + (on ? 'var(--ink)' : 'var(--ink-3)') + '">' + c.name + '</span>'
        + '<span class="track"><i style="width:' + (p * 100).toFixed(1) + '%;background:' + (on ? c.col : 'var(--line-3)') + '"></i></span>'
        + '<span class="val">' + (p >= 0.995 ? (p * 100).toFixed(1) : (p * 100).toFixed(0)) + '%</span></div>';
    }).join('');
  }

  function drawFeats(e) {
    var box = el('feats');
    if (!e) { box.innerHTML = '<p class="mini" style="padding:4px 0">无事件，无特征。</p>'; return; }
    var f = e.f, xs = e.pr.x, top = e.pr.order[0].i;
    var vals = {
      dtN: e.two ? (e.dt).toFixed(1) + ' s<br><span style="color:var(--ink-4)">' + f.dtN.toFixed(2) + '</span>' : '单端',
      ampN: (f.ampN * 1000).toFixed(0) + ' kPa',
      asym: (f.asym * 100).toFixed(0) + '%',
      dvN: state.flowX ? f.dvN.toFixed(1) + ' m³' : '未接入',
      slN: state.flowX ? f.slN.toFixed(1) + ' m³/h' : '未接入',
      tauN: e.tau >= 990 ? '≥900 s' : e.tau.toFixed(0) + ' s',
      op: f.op ? '命中' : '未命中',
      two: e.two ? '双端' : '单端'
    };
    var contrib = FKEYS.map(function (k, j) { return MODEL.W[top][j] * xs[j]; });
    var mx = Math.max.apply(null, contrib.map(Math.abs)) || 1;
    box.innerHTML = FKEYS.map(function (k, j) {
      var v = contrib[j], w = Math.abs(v) / mx * 50;
      return '<div class="feat"><span class="lb">' + FLAB[k] + '</span><span class="track"><i style="'
        + (v >= 0 ? 'left:50%' : 'left:' + (50 - w).toFixed(1) + '%') + ';width:' + w.toFixed(1) + '%;background:'
        + (v >= 0 ? 'var(--jade)' : 'var(--clay)') + '"></i></span><span class="val">' + vals[k] + '</span></div>';
    }).join('') + '<p class="mini" style="margin-top:3px">右绿 = 推高当前类别，左棕 = 拉低；条长 = 权重 × 标准化特征。</p>';
  }

  function drawAdvice(e, A) {
    var box = el('advice'), hits = el('hits'), logs = el('alarms');
    if (!e) {
      box.innerHTML = '<p class="mini" style="padding:6px 0">没有候选事件：不报警、不派车。这就是稳态运行该有的结果。</p>';
      hits.innerHTML = '<div class="hit"><span class="ic n">—</span><span class="tx"><b>物理门限</b>无 t1 / t2</span></div>'
        + '<div class="hit"><span class="ic n">—</span><span class="tx"><b>流量平衡</b>' + (A.seep ? '累计 ΔV 越过判据（独立报警，不可定位）' : '累计 ΔV 在判据以下波动') + '</span></div>'
        + '<div class="hit"><span class="ic n">—</span><span class="tx"><b>工况记录</b>无事件可对齐</span></div>';
      logs.innerHTML = '<p class="mini" style="padding:6px 0">无事件。</p>';
      return;
    }
    var top = e.pr.order[0], second = e.pr.order[1], leakP = e.pr.p[0];
    var h = [];
    h.push('<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px">'
      + '<span class="db ' + actCls(e.act) + '">' + actName(e.act) + '</span>'
      + '<span style="font-size:11.5px"><b>' + top.name + '</b>（' + pct(top.p) + '%）</span>'
      + '<span class="mini">次优 ' + second.name + ' ' + pct(second.p) + '%</span></div>');
    if (e.two && e.valid) {
      h.push('<div class="vform">x = (L + v·Δt)/2 = (120000 + 1100 × (' + e.dt.toFixed(1) + ')) / 2 = <b>'
        + (e.x / 1000).toFixed(2) + ' km</b>　区间 ' + Math.max(0, (e.x - 1200) / 1000).toFixed(1) + '—'
        + Math.min(120, (e.x + 1200) / 1000).toFixed(1) + ' km（±1% 管长）</div>');
    } else if (e.two) {
      h.push('<div class="vform"><b style="color:var(--bad)">Δt = ' + e.dt.toFixed(1) + ' s 超出物理上限 ±' + (L / VW).toFixed(0)
        + ' s</b>：两端取到的不是同一个波前，定位被拒绝，不派车。</div>');
    } else {
      h.push('<div class="vform">只有' + (e.st[0] ? '首站' : '末站') + '检出突变：构不成 Δt，<b>无法定位</b>。</div>');
    }
    h.push('<p style="font-size:10.5px;color:var(--ink-2);line-height:1.65;margin-top:6px">'
      + (e.act === 'dispatch'
        ? '调度按 <b>' + (e.x / 1000).toFixed(1) + ' km ± 1.2 km</b> 安排巡线，结合阀室与里程桩把范围压到 1 km 内；同时通知站场核查进出站流量差。'
        : e.act === 'review'
          ? '先按「疑似泄漏」拉响并冻结该时段数据，由值班工程师在 30 min 内复核：查工况台账、看流量差趋势、调相邻阀室压力。复核期间不出派车单。'
          : '不报警，事件写入回写集。分类器给出的解释是「' + top.name + '」，与流量、工况两路证据一致。')
      + '</p>');
    box.innerHTML = h.join('');

    /* 判定链 */
    var H = [];
    H.push(cri(e.physOK, '<b>物理门限</b> ' + (e.two
      ? '|Δt| = ' + Math.abs(e.dt).toFixed(1) + ' s' + (e.valid ? ' ≤ ' : ' > ') + (L / VW).toFixed(0) + ' s（L/v）'
      : '缺双端时间差，定位不可用')));
    var fs = e.fb;
    var fok = state.flowX && fs.kind === 'sustained';
    H.push(cri(fok, '<b>流量平衡</b> ' + (state.flowX
      ? (fs.kind === 'sustained' ? '累计 ΔV 净增 ' + fs.net.toFixed(1) + ' m³、斜率 ' + fs.slope.toFixed(1) + ' m³/h（' + clockHM(fs.t) + ' 起）→ 持续偏离'
        : fs.kind === 'pulse' ? 'ΔV 冲高 ' + fs.dev.toFixed(1) + ' m³ 后回落 → 工况脉冲'
          : fs.kind === 'delayed' ? '持续偏离起点 ' + clockHM(fs.t) + ' 与压力事件不对齐（>120 s）'
            : '没有超过 15 m³/h 的持续流量差（' + fs.net.toFixed(1) + ' m³）')
      : '数据未接入，本项不参与判定')));
    H.push(cri(e.opHit, '<b>工况记录</b> ' + (state.aware
      ? (e.op ? clockHM(e.op.t0) + ' ' + e.op.kind + '，距触发 ' + Math.abs(e.op.t0 - e.tC).toFixed(0) + ' s（窗口 ±' + OP_WIN + ' s）'
        : '触发时刻前后 ±' + OP_WIN + ' s 内无调阀 / 启停泵')
      : '未接入，工况感知失效')));
    H.push(cri(leakP >= 0.62, '<b>分类概率</b> 真泄漏 <b>' + pct(leakP) + '%</b> / 次优 '
      + second.name + ' ' + (second.p * 100).toFixed(0) + '%（门槛 0.62）'));
    H.push('<div class="vform" style="margin-top:4px">' + esc(e.why)
      + '　→　<span class="db ' + actCls(e.act) + '">' + actName(e.act) + '</span></div>');
    hits.innerHTML = H.join('');

    /* 事件台账 */
    logs.innerHTML = A.evts.map(function (ev) {
      var o = [];
      if (ev.two) o.push('Δt = ' + ev.dt.toFixed(1) + ' s → ' + (ev.x / 1000).toFixed(2) + ' km'
        + (ev.nearLeak && TR.leak ? '（误差 ' + Math.abs(ev.x - TR.x).toFixed(0) + ' m）' : ''));
      o.push(ev.why);
      return '<div class="ev"><span class="t">' + clock(ev.tOnset) + '</span><div><b>' + actName(ev.act) + ' · '
        + ev.pr.order[0].name + ' ' + pct(ev.pr.order[0].p) + '%</b><div class="d">' + o.join('；') + '</div></div></div>';
    }).join('') + (A.seep ? '<div class="ev"><span class="t">' + clockHM(A.seep.t) + '</span><div><b>流量法独立报警</b>'
      + '<div class="d">负压波未确认，累计 ΔV 越过 ' + DV_THR + ' m³ 且仍在增长 → 只报警、不可定位</div></div></div>' : '')
      + (A.miss ? '<div class="ev"><span class="t">—</span><div><b style="color:var(--bad)">漏报</b>'
        + '<div class="d">实际存在泄漏，但压力与流量两路都没有形成可用报警</div></div></div>' : '');
  }
  function cri(ok, txt) {
    return '<div class="hit"><span class="ic ' + (ok ? 'y' : 'n') + '">' + (ok ? '✓' : '—') + '</span><span class="tx">' + txt + '</span></div>';
  }

  /* ================= 结论文字 ================= */
  function noteOf(A, e) {
    var n = [], x = (TR.x / 1000).toFixed(1);
    if (state.scen === 'steady') {
      n.push('当前是<b>稳态运行</b>：管线只有噪声与缓慢温度漂移，突变指标 S 全天压在 ' + state.thr.toFixed(3)
        + ' MPa 阈值之下，流量差在 ±3 m³ 内波动 → 零候选、零报警。');
      if (state.noise >= 2) n.push('噪声已调到 ' + state.noise.toFixed(1) + '×（σ ≈ ' + (SIG * state.noise).toFixed(2)
        + ' MPa），固定阈值开始被噪声穿越——这就是「阈值订低了把系统关掉」的现场版本。');
      else n.push('把噪声拖到 2×—3×，可以看到固定阈值在噪声里频繁触发：分类器会把它们压回「噪声」，但每一条都要过一遍 8 维特征。');
      return n.join(' ');
    }
    if (state.scen === 'valve') {
      n.push('<b>调阀扰动</b>：45 km 阀室节流，上游首站压力反升 ' + (0.28 * Math.exp(-45000 / ATT)).toFixed(2)
        + ' MPa（S 为负，不触发），下游末站降 ' + (0.28 * Math.exp(-75000 / ATT)).toFixed(2) + ' MPa → 只有单端突变，Δt 构不成。');
      n.push(e && e.act === 'suppress'
        ? '分类器与工况记录一致地判为「调阀 ' + pct(e.pr.p[1]) + '%」，抑制、不计误报；定位本来也不可用。'
        : '当前被判为「' + (e ? e.pr.order[0].name : '—') + '」→ ' + (e ? actName(e.act) : '—') + '；调阀的波形与泄漏很像，靠的是流量脉冲与工况标签。');
      if (!state.aware) n.push('工况记录已断开：只剩波形与流量两路证据，阈值再动一点就会误报——这就是「台账也是数据资产」的意思。');
      return n.join(' ');
    }
    if (state.scen === 'pump') {
      n.push('<b>启泵扰动</b>：首站压力瞬降 0.30 MPa，末站 109 s 后跟着降 ' + (0.30 * Math.exp(-120000 / ATT)).toFixed(2)
        + ' MPa。两端时间差刚好 ≈ L/v，纯几何会算出「漏点在首站 0 km」——教科书级误报。');
      n.push(e ? '当前输出：' + e.pr.order[0].name + ' ' + pct(e.pr.order[0].p) + '% → ' + actName(e.act)
        + '。区分它靠三件事：工况记录、流量差是负向脉冲且 20 min 内回落、压力偏离半衰约 ' + (e.tau >= 990 ? '∞' : e.tau.toFixed(0) + ' s') + '。'
        : '全天没有候选。');
      if (!state.aware && !state.flowX) n.push('工况与流量两路都断开时，这个事件会被当成近端泄漏报出去——误报的来源从来不是算法不够复杂，而是证据不够独立。');
      return n.join(' ');
    }
    /* leak */
    n.push('<b>泄漏</b>：' + clockHM(TR.leak.t0) + ' 在 ' + x + ' km 处漏 ' + TR.q.toFixed(0) + ' m³/h（' + state.leakPct.toFixed(1)
      + '% 输量）。首站波到 t + ' + (TR.x / VW).toFixed(0) + ' s、末站 t + ' + ((L - TR.x) / VW).toFixed(0) + ' s，时间差决定位置。');
    if (!A.leakDetected) {
      var ampL = AMPK * state.leakPct * (state.scen === 'leak' ? 1 : 0);
      n.push('这次泄漏<b>没有形成可用报警</b>：漏点处压力台阶约 ' + (ampL * 1000).toFixed(0) + ' kPa，传到两站衰减到 '
        + (ampL * Math.exp(-TR.x / ATT) * 1000).toFixed(0) + ' / ' + (ampL * Math.exp(-(L - TR.x) / ATT) * 1000).toFixed(0)
        + ' kPa，低于 ' + state.thr.toFixed(3) + ' MPa 阈值；'
        + (A.seep ? '流量平衡法在 ' + clockHM(A.seep.t) + ' 独立报警，但无法定位。'
          : '流量差 ' + TR.q.toFixed(1) + ' m³/h 也没超过 15 m³/h 的确认门限 → 漏报。'));
      if (e) {
        n.push('当天唯一的候选是 ' + clockHM(e.tOnset) + ' 的「' + e.pr.order[0].name + ' ' + pct(e.pr.order[0].p) + '%」，与泄漏无关，被抑制。');
      }
      n.push('把漏量调到 1% 以上、或把阈值拖低到 0.03 附近，负压波才能检出——这就是「检得到」与「误报可承受」之间的取舍。');
      if (Math.abs(state.skew) > 0.3) n.push('另外两站时钟差 ' + state.skew.toFixed(2) + ' s，即使检出也会带来 ' + Math.abs(VW * state.skew / 2).toFixed(0) + ' m 的系统偏差。');
      return n.join(' ');
    }
    if (!e) {
      n.push('压力与流量两路都没有形成事件，但评估口径判定为检出——请检查场景参数。');
      return n.join(' ');
    }
    if (e.act === 'dispatch' || e.act === 'review') {
      var full = Math.max(0, e.tAlarm - TR.leak.t0);
      var locTxt = (e.two && e.valid)
        ? '定位 ' + (e.x / 1000).toFixed(2) + ' km，误差 ' + Math.abs(e.x - TR.x).toFixed(0) + ' m（'
          + (Math.abs(e.x - TR.x) / L * 100).toFixed(3) + '% 管长）'
        : '<b>双端时间差缺失，定位不可用</b>';
      n.push('当前输出：<b>' + actName(e.act) + '</b>，' + locTxt + '；全链路 '
        + (full >= 120 ? (full / 60).toFixed(1) + ' min' : full.toFixed(0) + ' s')
        + '（含波前传播 ' + (e.two ? Math.max(e.st[0].t, e.st[1].t) - TR.leak.t0 : e.tNear - TR.leak.t0).toFixed(0)
        + ' s，确认窗约 20 s）。');
      n.push(e.act === 'dispatch'
        ? '分类器给真泄漏 ' + pct(e.pr.p[0]) + '%，流量差 ' + e.fb.net.toFixed(1) + ' m³ 持续增长，工况记录无冲突——三条证据独立成立，才派车。'
        : '证据链缺一环（' + [!e.physOK ? '双端时间差' : '', !e.flowOK ? '流量确认' : '', e.opHit ? '工况窗口' : '']
          .filter(Boolean).join(' / ') + '），所以只报警、不派车。');
      if (Math.abs(state.skew) > 0.3) n.push('两站时钟差 ' + state.skew.toFixed(2) + ' s 正在把定位推向 '
        + (state.skew > 0 ? '上游' : '下游') + '，误差里约 ' + Math.abs(VW * state.skew / 2).toFixed(0) + ' m 来自对时，不是算法。');
      return n.join(' ');
    }
    n.push('当前判定为「' + e.pr.order[0].name + '」并抑制：泄漏概率只有 ' + pct(e.pr.p[0])
      + '%，流量差净增 ' + e.fb.net.toFixed(1) + ' m³' + (state.flowX ? '' : '（流量数据未接入）')
      + '，工况记录 ' + (e.op ? '命中' : '未命中') + '。');
    return n.join(' ');
  }

  /* ================= 过程日志 ================= */
  var TRACE = [];
  function trace(step, html, cls) {
    TRACE.push({ step: step, html: html, cls: cls || '' });
    if (TRACE.length > 8) TRACE.shift();
    var box = el('trace');
    if (!box) return;
    box.innerHTML = TRACE.map(function (t) {
      return '<div><span class="t">' + t.step + '</span><span class="' + t.cls + '">' + t.html + '</span></div>';
    }).join('');
    box.scrollTop = box.scrollHeight;
  }
  function clearTrace() {
    TRACE = [];
    el('trace').innerHTML = '<div><span class="t">—</span><span>等待运行：选好场景后点「▶ 运行全流程」，或直接点上面的步骤。</span></div>';
  }

  /* ================= 阶段与全流程 ================= */
  var STAGE_LABEL = ['01 采集', '02 检测', '03 分类', '04 决策', '05 闭环'];
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
    var A = render();
    clearTrace();
    var btn = el('btn-run');
    btn.disabled = true;
    btn.textContent = '运行中…';
    var e = A.prim;
    var top = e ? e.pr.order[0] : null;
    var steps = [
      ['01', '读取 2 站 × ' + N + ' 点 10 s 历史库 + 1 s 原始流 · 缺测 3 段已补点 · 时钟偏差 ' + state.skew.toFixed(2) + ' s'],
      ['02', '粗筛 ' + A.evts.length + ' 次候选' + (e ? ' · 精分析 t1/t2 ' + (e.two ? 'Δt = ' + e.dt.toFixed(1) + ' s' : '仅单端') : ' · 全天无触发')],
      ['03', '8 维特征 → softmax 4 类 · ' + (top ? '判为 ' + top.name + ' ' + pct(top.p) + '%' : '无事件') + ' · 验证准确率 ' + (MODEL.acc * 100).toFixed(1) + '%'],
      ['04', e ? '三道门 ' + (e.physOK ? '✓' : '—') + (e.flowOK ? '✓' : '—') + (e.opHit ? '✗' : '✓') + ' · 动作 <b>' + actName(e.act) + '</b>'
        + (e.act !== 'suppress' && e.two && e.valid ? ' · ' + (e.x / 1000).toFixed(2) + ' km ± 1.2 km' : '')
        : '无事件 → 不报警、不派车'],
      ['05', '人工确认回写 ' + (fb.leak + fb.bad) + ' 条 · 月度口径 误报 14→2 次/月 · 定位 180→45 m（示范口径）']
    ];
    var delays = [0, 820, 1640, 2460, 3280];
    steps.forEach(function (s, i) {
      runTimers.push(setTimeout(function () {
        setStage(i, null);
        trace(s[0], s[1]);
        if (i === steps.length - 1) {
          runTimers.push(setTimeout(function () {
            btn.disabled = false;
            btn.textContent = '▶ 重新运行';
            trace('✓', '流水线完成：从两站压力到一条可执行的派车 / 复核结论。', 'ok');
          }, 650));
        }
      }, delays[i]));
    });
  }

  /* ================= 控件 ================= */
  var seg = el('seg-scen');
  seg.innerHTML = SCENS.map(function (s) {
    return '<button data-s="' + s[0] + '"' + (s[0] === state.scen ? ' class="on"' : '') + '>' + s[1] + '</button>';
  }).join('');
  seg.addEventListener('click', function (ev) {
    var b = ev.target.closest('button');
    if (!b) return;
    cancelRun();
    state.scen = b.getAttribute('data-s');
    [].forEach.call(seg.children, function (x) { x.classList.toggle('on', x === b); });
    render();
    trace('场景', '切换为 <b>' + b.textContent + '</b> · 检测、分类、定位、指标同步重算');
  });

  var pending = false;
  function schedule(fn) {
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () { pending = false; fn(); });
  }
  function bindRange(id, key, fmt) {
    var r = el(id);
    r.value = state[key];
    var out = el('o-' + id.slice(2));
    r.addEventListener('input', function () { state[key] = Number(r.value); out.textContent = fmt(state[key]); schedule(render); });
    out.textContent = fmt(state[key]);
  }
  bindRange('r-pos', 'pos', function (v) { return (v / 100 * L / 1000).toFixed(1) + ' km'; });
  bindRange('r-leak', 'leakPct', function (v) { return v.toFixed(1) + ' % / ' + (Q0 * v / 100).toFixed(0) + ' m³/h'; });
  bindRange('r-noise', 'noise', function (v) { return v.toFixed(1) + '×'; });
  bindRange('r-thr', 'thr', function (v) { return v.toFixed(3) + ' MPa'; });
  bindRange('r-skew', 'skew', function (v) { return (v >= 0 ? '+' : '') + v.toFixed(2) + ' s'; });

  function bindTog(id, key) {
    var t = el(id);
    t.classList.toggle('on', state[key]);
    t.setAttribute('role', 'switch');
    t.setAttribute('tabindex', '0');
    t.setAttribute('aria-checked', state[key] ? 'true' : 'false');
    function flip() {
      cancelRun();
      state[key] = !state[key];
      t.classList.toggle('on', state[key]);
      t.setAttribute('aria-checked', state[key] ? 'true' : 'false');
      render();
      trace('输入', (key === 'aware' ? '工况记录' : '流量平衡') + (state[key] ? ' <span class="ok">接入</span>' : ' <span class="bad">断开</span>')
        + ' · 特征与决策同步重算');
    }
    t.addEventListener('click', flip);
    t.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); flip(); } });
  }
  bindTog('tog-aware', 'aware');
  bindTog('tog-flow', 'flowX');

  el('btn-run').addEventListener('click', runAll);
  el('btn-reset').addEventListener('click', function () {
    cancelRun();
    state.scen = 'leak'; state.pos = 62; state.leakPct = 2.0; state.noise = 1.0;
    state.thr = 0.045; state.skew = 0; state.aware = true; state.flowX = true;
    [].forEach.call(seg.children, function (x) { x.classList.toggle('on', x.getAttribute('data-s') === 'leak'); });
    el('r-pos').value = '62'; el('o-pos').textContent = '74.4 km';
    el('r-leak').value = '2'; el('o-leak').textContent = '2.0 % / 32 m³/h';
    el('r-noise').value = '1'; el('o-noise').textContent = '1.0×';
    el('r-thr').value = '0.045'; el('o-thr').textContent = '0.045 MPa';
    el('r-skew').value = '0'; el('o-skew').textContent = '+0.00 s';
    el('tog-aware').classList.add('on'); el('tog-flow').classList.add('on');
    el('tog-aware').setAttribute('aria-checked', 'true'); el('tog-flow').setAttribute('aria-checked', 'true');
    fb = { leak: 0, bad: 0 }; FB = [];
    setStage(0, false);
    clearTrace();
    render();
    trace('系统', '已重置：泄漏 2.0% / 74.4 km · 噪声 1.0×', 'ok');
  });

  el('flow').addEventListener('click', function (ev) {
    var b = ev.target.closest('button');
    if (!b) return;
    cancelRun();
    setStage(Number(b.getAttribute('data-s')), null);
  });

  el('feedback').addEventListener('click', function (ev) {
    var b = ev.target.closest('button');
    if (!b || b.id === 'btn-retrain') return;
    var k = b.getAttribute('data-fb');
    if (!k) return;
    var A = analyze();
    var e = A.prim;
    fb[k]++;
    if (e) {
      FB.push({ f: e.f, y: k === 'leak' ? 0 : (e.pr.order[0].i || 3) });
      trace('反馈', k === 'leak'
        ? '人工确认：<b>确为泄漏</b> · 样本进入训练集（当前事件 ' + clockHM(e.tC) + '）'
        : '<b>标为误报 / 工况</b> · 样本进入错题集，下一轮重训优先看', k === 'leak' ? 'ok' : 'warn');
    } else {
      trace('反馈', '当前没有可回写的事件', 'warn');
    }
    render();
  });

  el('btn-retrain').addEventListener('click', function () {
    cancelRun();
    if (!FB.length) { trace('重训', '还没有回写样本：先确认或标错一条，再重训。', 'warn'); return; }
    MODEL = trainModel(FB);
    var A = analyze();
    paint(A);
    drawDt(A); drawFlow(A); drawPres(A); updatePipe(A);
    trace('重训', '用 <b>' + FB.length + '</b> 条回写样本重训 · 验证准确率 <b>' + (MODEL.acc * 100).toFixed(1)
      + '%</b> · ECE <b>' + (MODEL.ece1 * 100).toFixed(1) + '%</b>', 'ok');
  });

  window.addEventListener('resize', function () {
    clearTimeout(window.__rz);
    window.__rz = setTimeout(render, 180);
  });

  /* ================= 纵剖面动画 ================= */
  var tA = 1.5, tPrev = null;
  function tick(ts) {
    if (tPrev === null) tPrev = ts;
    var dtr = Math.min(0.1, (ts - tPrev) / 1000);
    tPrev = ts;
    tA += dtr;
    if (pipeBuilt && TR) {
      var d1 = Math.abs(TR.x - XS[0]), d2 = Math.abs(XS[1] - TR.x);
      var travelMax = Math.max(d1, d2) / VW;
      var comp = T_SIM / travelMax;
      var period = T_SIM + 1.4;
      var tp = tA % period;
      var tReal = tp < T_SIM ? tp / comp : travelMax;
      var mv = VW * tReal;
      var p1 = xOfKm(Math.max(0, TR.x - mv)), p2 = xOfKm(Math.min(L, TR.x + mv));
      var a1 = mv >= d1, a2 = mv >= d2;
      anim.pw1.setAttribute('transform', 'translate(' + p1.toFixed(1) + ' ' + (terrY(p1)).toFixed(1) + ')');
      anim.pw2.setAttribute('transform', 'translate(' + p2.toFixed(1) + ' ' + (terrY(p2)).toFixed(1) + ') scale(-1 1)');
      anim.pw1.setAttribute('opacity', a1 ? 0.28 : 1);
      anim.pw2.setAttribute('opacity', a2 ? 0.28 : 1);
      var fl1 = tp < T_SIM && tp > T_SIM * (d1 / travelMax) * 0.98 ? 1 : 0;
      var fl2 = tp < T_SIM && tp > T_SIM * (d2 / travelMax) * 0.98 ? 1 : 0;
      anim.fl1.setAttribute('opacity', fl1 ? Math.max(0, 1 - (tp - T_SIM * d1 / travelMax) * 2.2).toFixed(2) : 0);
      anim.fl2.setAttribute('opacity', fl2 ? Math.max(0, 1 - (tp - T_SIM * d2 / travelMax) * 2.2).toFixed(2) : 0);
      el('pipe-hint').textContent = '示意动画 · 时间压缩 ≈ ' + Math.round(1 / comp) + '×';
    }
    requestAnimationFrame(tick);
  }

  /* ================= 调试接口 ================= */
  window.__demo = {
    state: state,
    analyze: analyze,
    model: function () {
      return {
        acc: MODEL.acc, ece0: MODEL.ece0, ece1: MODEL.ece1, T: MODEL.T,
        nTrain: MODEL.nTrain, nVal: MODEL.nVal, reviewRate: MODEL.reviewRate,
        hist: MODEL.hist.slice(), conf: MODEL.conf, valP: MODEL.valP, valY: MODEL.valY
      };
    },
    events: function () {
      var A = analyze();
      return A.evts.map(function (e) {
        return {
          t: e.tC, two: e.two, dt: e.dt, x: e.x, valid: e.valid, act: e.act, truth: e.truth,
          p: e.pr.p.map(function (v) { return Math.round(v * 1000) / 1000; }), f: e.f, tau: e.tau
        };
      });
    },
    result: function () {
      var A = analyze(), e = A.prim;
      return {
        verdict: e ? e.act : 'none', top: e ? e.pr.order[0].key : null,
        probs: e ? e.pr.p.map(function (v) { return Math.round(v * 1000) / 1000; }) : null,
        x: e && e.two && e.valid ? e.x : null, trueX: TR.x,
        err: e && e.two && e.valid && TR.leak ? Math.abs(e.x - TR.x) : null,
        delay: e && TR.leak ? Math.max(e.tAlarm - TR.leak.t0, 0) : null,
        fp: A.fp, sup: A.sup, review: A.review, dispatch: A.dispatch, miss: A.miss, seep: !!A.seep, n: A.evts.length
      };
    },
    set: function (o) {
      for (var k in o) if (o.hasOwnProperty(k)) state[k] = o[k];
      if (o.scen) [].forEach.call(seg.children, function (x) { x.classList.toggle('on', x.getAttribute('data-s') === state.scen); });
      if (o.pos !== undefined) { el('r-pos').value = state.pos; el('o-pos').textContent = (state.pos / 100 * L / 1000).toFixed(1) + ' km'; }
      if (o.leakPct !== undefined) { el('r-leak').value = state.leakPct; el('o-leak').textContent = state.leakPct.toFixed(1) + ' %'; }
      if (o.noise !== undefined) { el('r-noise').value = state.noise; el('o-noise').textContent = state.noise.toFixed(1) + '×'; }
      if (o.thr !== undefined) { el('r-thr').value = state.thr; el('o-thr').textContent = state.thr.toFixed(3) + ' MPa'; }
      if (o.skew !== undefined) { el('r-skew').value = state.skew; el('o-skew').textContent = state.skew.toFixed(2) + ' s'; }
      if (o.aware !== undefined) { el('tog-aware').classList.toggle('on', state.aware); el('tog-aware').setAttribute('aria-checked', state.aware ? 'true' : 'false'); }
      if (o.flowX !== undefined) { el('tog-flow').classList.toggle('on', state.flowX); el('tog-flow').setAttribute('aria-checked', state.flowX ? 'true' : 'false'); }
      return render();
    }
  };

  /* ================= 启动 ================= */
  buildPipe();
  clearTrace();
  render();
  setStage(0, false);
  trace('系统', '模型已在本页训练：' + MODEL.nTrain + ' 训练 / ' + MODEL.nVal + ' 验证 · 准确率 <b>'
    + (MODEL.acc * 100).toFixed(1) + '%</b> · 温度 T = ' + MODEL.T.toFixed(2), 'ok');
  requestAnimationFrame(tick);
})();
