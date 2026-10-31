/* =========================================================
   管道泄漏智能检测 · 可运行示范
   ---------------------------------------------------------
   ① 合成 24 h 双站压力：10 s 历史库（瞬时值快照）+ 1 s 原始数据流，
      含稳态漂移、噪声、工况扰动（调阀 / 泵切换）与可选泄漏事件；
   ② 滑动窗均值差突变检测：粗筛（10 s，固定阈值）→ 报警后回捞
      1 s 原始数据做精分析，用 S 脉冲质心估突变时刻 t1 / t2；
   ③ 定位 x = (L + v·Δt) / 2，Δt = t1 − t2；
   ④ 交叉验证：流量平衡累计偏离 + 工况操作记录 → 误报抑制；
   ⑤ 评估：定位误差（m / % 管长）、检测延迟、误报与漏报。
   ========================================================= */
(function () {
  'use strict';

  /* ---------------- 管网与算法参数 ---------------- */
  var L = 120000;            /* 管道长度 m */
  var VW = 1100;             /* 负压波波速 m/s（含气原油 1000—1200） */
  var Q0 = 1600;             /* 正常输量 m³/h */
  var ATT = 200000;          /* 压力波幅衰减长度 m */
  var SIG = 0.020;           /* 压力噪声基准标准差 MPa */
  var AMPK = 0.078;          /* 漏量每 1% 输量对应的漏点压力波幅 MPa */
  var XS = [0, L];           /* 两站里程：0 = 首站（泵站），L = 末站 */
  var BASE_P = [6.20, 1.78]; /* 首站出站压力 / 末站进站压力 MPa */
  var DUR = 86400, DT = 10, N = DUR / DT;   /* 历史库 10 s × 8640 点 */
  var DT_F = 1, HW = 600;                   /* 精分析 1 s，半窗 600 s */
  var W_C = 6, W_F = 8, PERS_C = 3, PERS_F = 2;
  var DV_THR = 12, DV_GROW = 1.0, OP_WIN = 180;
  var LEAK_T = 13.5 * 3600;
  var PX0 = 64, PXW = 572;                  /* 示意图上 0—L 的像素范围 */
  var nameS = ['首站', '末站'];

  /* ---------------- 固定种子的噪声流 ---------------- */
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
  /* amp0：扰动源处压力波幅（负 = 降，正 = 升）；split：上下游符号相反（节流）
     pulses：进出站流量差脉冲（m³/h，含恢复段，净积分为 0） */
  var OPSET = {
    valve: [
      { t0: 9 * 3600 + 20 * 60, kind: '调阀', x0: 45000, amp0: -0.28, split: true, dur: 180, rec: 420,
        pulses: [{ amp: 110, dur: 180 }, { amp: -27.5, dur: 720 }] },
      { t0: 16 * 3600 + 40 * 60, kind: '调阀', x0: 45000, amp0: -0.28, split: true, dur: 180, rec: 420,
        pulses: [{ amp: 110, dur: 180 }, { amp: -27.5, dur: 720 }] }
    ],
    pump: [
      { t0: 6 * 3600, kind: '泵切换', x0: 0, amp0: -0.30, split: false, dur: 240, rec: 540,
        pulses: [{ amp: -90, dur: 240 }, { amp: 22.5, dur: 960 }] },
      { t0: 18 * 3600 + 30 * 60, kind: '泵切换', x0: 0, amp0: -0.30, split: false, dur: 240, rec: 540,
        pulses: [{ amp: -90, dur: 240 }, { amp: 22.5, dur: 960 }] }
    ]
  };

  var state = {
    scen: 'leak', pos: 62, leakPct: 2.0, noise: 1.0, thr: 0.045,
    aware: true, flowX: true, cursor: DUR, playing: false
  };
  var SCENS = [['steady', '稳态运行'], ['valve', '调阀扰动'], ['pump', '启泵扰动'], ['leak', '泄漏']];
  var TR = null;     /* 真值 */

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
  var MULT = function () { return state.noise; };

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
    /* 流量平衡：进出站流量差累计（m³），含泄漏持续项与工况脉冲项 */
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
        if (run === pers) cand.push({ i: i - pers + 1, t: (i - pers + 1) * dt, iPeak: i });
      } else run = 0;
    }
    return { S: S, cand: cand };
  }
  /* 用 S 脉冲质心估突变时刻：S 三角脉冲的峰值出现在「突变时刻 + W」，
     取峰值两侧各 W 个样本的固定对称窗、以 S² 加权求质心——
     对幅度不敏感、对尾部噪声不敏感，两端的系统偏差相同，做差时抵消 */
  function centroid(Sc, iTrig, W) {
    /* 只在触发点附近找峰：粗筛可能把 7 min 前的噪声峰带进来，
       原来的全局搜索会取错峰，导致 Δt 跨量级、定位跑到管外。 */
    var i0 = Math.max(2 * W - 1, iTrig - 2 * W), i1 = Math.min(Sc.length - 1, iTrig + 3 * W), i;
    var pk = 0, ip = i0;
    for (i = i0; i <= i1; i++) if (Sc[i] > pk) { pk = Sc[i]; ip = i; }
    var a = Math.max(0, ip - W), b = Math.min(Sc.length - 1, ip + W);
    var num = 0, den = 0;
    for (i = a; i <= b; i++) {
      var w = Sc[i] > 0 ? Sc[i] * Sc[i] : 0;
      num += w * i; den += w;
    }
    return { ic: den > 0 ? num / den : ip, peak: pk, iEnd: b };
  }

  /* ---------------- 精分析：1 s 原始数据 ---------------- */
  function fineWindow(s, t0, n) {
    var Pf = new Float64Array(n), B = new Float64Array(n), mult = MULT();
    for (var k = 0; k < n; k++) {
      var t = t0 + k * DT_F;
      B[k] = smooth(s, t);
      Pf[k] = B[k] + evSum(s, t) + SIG * mult * FN[s][Math.round(t)];
    }
    return { P: Pf, B: B, t0: t0 };
  }
  function fineDetectFrom(w, tRef) {
    var sc = scan(w.P, DT_F, W_F, PERS_F);
    if (!sc.cand.length) return null;
    /* 只接受离粗筛触发 ±120 s 的候选；取最近的，不取第一个 */
    var target = tRef == null ? sc.cand[0].t : (tRef - w.t0);
    var near = sc.cand.filter(function (c) { return Math.abs(c.t - target) <= 120; });
    if (!near.length) return null;
    var pick = near.reduce(function (a, b) { return Math.abs(b.t - target) < Math.abs(a.t - target) ? b : a; });
    var cen = centroid(sc.S, pick.i, W_F);
    return {
      t: w.t0 + cen.ic - W_F, amp: cen.peak, dec: w.t0 + cen.iEnd + 5,
      P: w.P, B: w.B, t0: w.t0, tTrig: pick.t, S: sc.S, cand: sc.cand
    };
  }
  function fineDetect(s, tC) {
    var t0 = Math.max(0, Math.round(tC - HW));
    var n = Math.min(DUR - t0, 2 * HW) + 1;
    return fineDetectFrom(fineWindow(s, t0, n), tC);
  }

  /* ---------------- 流量平衡判据 ---------------- */
  /* 确认窗 = 触发时刻前 10 min 到后 60 min：
     越判据且近 10 min 仍在增长 = 持续偏离；流量差斜率仍 > 3 m³/h = 小漏量的持续增长；
     冲高后回到起点（斜率≈0）= 工况脉冲，不能作为泄漏证据 */
  function flowCheck(t0) {
    /* 用瞬时进出站流量差（m³/h）判“持续泄漏”，不再用未来 60 min 的累计量
       去给过去的事件背书。判据：|ΔQ| > 15 m³/h 连续 3 点，且同号持续
       ≥ 10 min（或累计 |ΔV| > 12 m³）；起始时刻必须与压力事件对齐 ±120 s。 */
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
      return { kind: 'none', t: null, V: VFLOW[i1], dev: peakDev, net: VFLOW[i1] - VFLOW[i0], slope: 0, peak: VFLOW[ipk], ipk: ipk, rate: DQV[i1] };
    }
    var lastSame = rs;
    for (i = rs + 1; i <= i1; i++) { if (Math.sign(DQV[i]) === sign) lastSame = i; }
    var persist = (lastSame - rs) * DT >= 600 || Math.abs(VFLOW[i1] - VFLOW[rs]) > DV_THR;
    var aligned = Math.abs(rs * DT - t0) <= 120;
    var net = VFLOW[i1] - VFLOW[rs];
    var slope = net / Math.max(1, (i1 - rs) * DT / 3600);
    var kind = !persist ? 'pulse' : aligned ? 'sustained' : 'delayed';
    return { kind: kind, t: rs * DT, V: VFLOW[rs], dev: peakDev, net: net, slope: slope, peak: VFLOW[ipk], ipk: ipk, rate: DQV[rs] };
  }
  function flowAlarmTime() {
    for (var i = 61; i < N; i++) {
      if (VFLOW[i] > DV_THR && (VFLOW[i] - VFLOW[i - 60]) > DV_GROW) return i * DT;
    }
    return null;
  }

  /* ---------------- 事件判定 ---------------- */
  function analyze() {
    buildSeries();
    var sc1 = scan(P[0], DT, W_C, PERS_C), sc2 = scan(P[1], DT, W_C, PERS_C);
    S1 = sc1.S; S2 = sc2.S;
    var cs = [];
    sc1.cand.forEach(function (c) { cs.push({ t: c.t, s: 0 }); });
    sc2.cand.forEach(function (c) { cs.push({ t: c.t, s: 1 }); });
    cs.sort(function (a, b) { return a.t - b.t; });
    var evts = [];
    cs.forEach(function (c) {
      var last = evts[evts.length - 1];
      if (last && c.t - last.tC <= 300) {
        last.tC = Math.min(last.tC, c.t);
        last.mem[c.s] = true;
        last.tTrig[c.s] = c.t;
      } else {
        var e = { tC: c.t, mem: [c.s === 0, c.s === 1], tTrig: [null, null], st: [null, null] };
        e.tTrig[c.s] = c.t;
        evts.push(e);
      }
    });
    var fbAlarm = flowAlarmTime();
    var out = { evts: evts, fbAlarm: fbAlarm, fb: null };
    evts.forEach(function (e) {
      var finer = null;
      var t0 = Math.max(0, Math.round(e.tC - HW)), n = Math.min(DUR - t0, 2 * HW) + 1;
      for (var s = 0; s < 2; s++) {
        var w = fineWindow(s, t0, n);        /* 两侧都生成：未检出的一侧也留波形用于显示 */
        if (e.mem[s]) {
          var f = fineDetectFrom(w, e.tC);
          if (f) { e.st[s] = { t: f.t, amp: f.amp, dec: f.dec }; finer = finer || []; finer[s] = f; }
        }
        if (!finer || !finer[s]) { finer = finer || []; finer[s] = w; }
      }
      e.fine = finer;
      var fs = flowCheck(e.tC);
      e.fb = fs;
      var op = null;
      for (var k = 0; k < TR.ops.length; k++) {
        if (Math.abs(TR.ops[k].t0 - e.tC) <= OP_WIN) op = TR.ops[k];
      }
      e.op = op;
      var two = !!(e.st[0] && e.st[1]);
      e.two = two;
      if (two) {
        e.dt = e.st[0].t - e.st[1].t;
        var x = (L + VW * e.dt) / 2;
        e.dtMax = L / VW;
        e.valid = Math.abs(e.dt) <= e.dtMax + 5 && x >= -1 && x <= L + 1;
        e.xRaw = x;
        e.x = Math.max(0, Math.min(L, x));
        e.amp = Math.max(e.st[0].amp, e.st[1].amp);
      } else {
        e.valid = false;
      }
      if (!e.st[0] && !e.st[1]) { e.v = 'noise'; e.why = '粗筛触发但精分析未确认（低于 1 s 数据的突变量）'; return; }
      if (two && !e.valid) {
        e.v = 'invalid';
        e.why = 'Δt = ' + e.dt.toFixed(0) + ' s 超出物理上限 ±' + e.dtMax.toFixed(0) + ' s（|Δt| ≤ L/v），定位被拒绝';
        e.nearLeak = false;
        e.alarm = false;
        e.tAlarm = e.tC;
        return;
      }
      var flowOK = (fs.kind === 'sustained');
      if (state.aware && op) {
        e.v = 'op';
        e.why = '工况操作记录命中：' + clockHM(op.t0) + ' ' + op.kind + '（±' + (OP_WIN / 60) + ' min 窗口）';
      } else if (state.flowX && !flowOK) {
        e.v = 'op';
        e.why = '流量平衡未确认：' + (fs.kind === 'pulse'
          ? '瞬时流量差 ' + (fs.rate || 0).toFixed(0) + ' m³/h 冲高后回零（工况脉冲）'
          : fs.kind === 'delayed'
            ? '持续流量偏离的起点 ' + clockHM(fs.t) + ' 与压力事件不对齐（>120 s），不判泄漏'
            : '没有超过 15 m³/h 的持续流量差');
      } else if (two) {
        e.v = state.flowX ? 'leak' : 'leak-u';
        e.why = state.flowX
          ? '双端负压波 + 持续流量差' + (fs.rate ? '（ΔQ ≈ ' + fs.rate.toFixed(0) + ' m³/h，' + clockHM(fs.t) + ' 起）' : '')
          : '双端负压波触发，但未启用流量平衡交叉验证';
      } else {
        e.v = state.flowX ? 'single' : 'single-u';
        e.why = '仅' + nameS[e.st[0] ? 0 : 1] + '检测到突变，单端报警：Δt 不可用，无法定位'
          + (state.flowX ? '；流量平衡' + (fs.kind === 'sustained' ? '持续偏离（ΔQ ≈ ' + (fs.rate || 0).toFixed(0) + ' m³/h）' : '未确认')
            : '（未启用流量平衡交叉验证）');
      }
      e.nearLeak = !!(TR.leak && (Math.abs(e.tC - TR.leak.t0) <= 600 || (two && Math.abs(e.x - TR.x) <= 3000)));
      e.tAlarm = Math.max(e.st[0] ? e.st[0].dec : 0, e.st[1] ? e.st[1].dec : 0) || e.tC;
    });
    /* 汇总 */
    var leakDetected = false;
    out.fp = 0; out.sup = 0;
    evts.forEach(function (e) {
      e.alarm = (e.v === 'leak' || e.v === 'single' || e.v === 'leak-u' || e.v === 'single-u');
      if (e.alarm && e.nearLeak) leakDetected = true;
      if (e.alarm && !e.nearLeak) out.fp++;
      if (e.v === 'op' || e.v === 'noise' || e.v === 'invalid') out.sup++;
    });
    out.seep = null;
    if (fbAlarm !== null && !leakDetected && !TR.leak) {
      out.seep = { t: fbAlarm, fp: true }; out.fp++;
    } else if (fbAlarm !== null && !leakDetected && TR.leak) {
      /* 只有流量报警与真实泄漏时间接近时才算检出 */
      if (Math.abs(fbAlarm - TR.leak.t0) <= 3600) { out.seep = { t: fbAlarm, fp: false }; leakDetected = true; }
    }
    out.leakDetected = leakDetected;
    out.fp = 0; out.sup = 0;
    evts.forEach(function (e) {
      if (e.alarm && !TR.leak) out.fp++;
      if (e.v === 'op' || e.v === 'noise') out.sup++;
    });
    if (out.seep && out.seep.fp) out.fp++;
    out.miss = !!(TR.leak && !leakDetected);
    /* 主事件（用于读数） */
    var prim = null;
    evts.forEach(function (e) { if (!prim && e.alarm) prim = e; });
    if (!prim && evts.length) prim = evts[0];
    out.prim = prim;
    return out;
  }

  /* ================= 绘制：管线纵剖面 ================= */
  var PT = 96, PHILL = 28;                       /* 地形基准线与中间隆起高度 */
  function terrY(x) {
    var u = Math.max(0, Math.min(1, (x - PX0) / PXW));
    return PT - PHILL * Math.sin(Math.PI * u);
  }
  function xOfKm(m) { return PX0 + m / L * PXW; }
  var pipeBuilt = false, anim = { pw1: null, pw2: null, fl1: null, fl2: null, lk: null };
  function buildPipe() {
    var svg = el('pipe'), pts = [], i, u;
    for (i = 0; i <= 24; i++) { u = i / 24; pts.push([PX0 + u * PXW, terrY(PX0 + u * PXW)]); }
    var dline = pts.map(function (p, j) { return (j ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ');
    var h = [];
    h.push("<path d='" + dline + " L" + (PX0 + PXW) + " 148 L" + PX0 + " 148 Z' fill='#faf7f0' stroke='none'/>");
    h.push("<path d='" + dline + "' fill='none' stroke='#cdd8e2' stroke-width='1'/>");
    h.push("<path d='" + dline + "' fill='none' stroke='#e3dccd' stroke-width='7' stroke-linecap='round'/>");
    h.push("<path d='" + dline + "' fill='none' stroke='#99a3a4' stroke-width='1.4'/>");
    /* 里程标尺 */
    h.push("<path d='M" + PX0 + " 156 L" + (PX0 + PXW) + " 156' stroke='#d3c9b6' stroke-width='1'/>");
    for (i = 0; i <= 6; i++) {
      var km = i * 20, xp = xOfKm(km * 1000);
      h.push("<path d='M" + xp.toFixed(1) + " 152 L" + xp.toFixed(1) + " 160' stroke='#d3c9b6' stroke-width='1'/>");
      h.push("<text x='" + xp.toFixed(1) + "' y='171' font-size='9' font-family='monospace' fill='#99a3a4' text-anchor='middle'>" + km + "</text>");
    }
    h.push("<text x='" + (PX0 - 6) + "' y='171' font-size='9' font-family='monospace' fill='#99a3a4' text-anchor='end'>km</text>");
    h.push("<text id='pipe-t1' x='" + PX0 + "' y='140' font-size='9' font-family='monospace' fill='#4a585c'>—</text>");
    /* 站场 */
    h.push(stationIcon(0));
    h.push(stationIcon(1));
    /* 波前（动画） */
    h.push("<g id='pw1'><path d='M0 -18 C-7 -9 -7 9 0 18' fill='none' stroke='#1d4e50' stroke-width='2.2'/><path d='M10 -18 C3 -9 3 9 10 18' fill='none' stroke='#1d4e50' stroke-width='1.2' opacity='.5'/></g>");
    h.push("<g id='pw2'><path d='M0 -18 C-7 -9 -7 9 0 18' fill='none' stroke='#355c74' stroke-width='2.2'/><path d='M10 -18 C3 -9 3 9 10 18' fill='none' stroke='#355c74' stroke-width='1.2' opacity='.5'/></g>");
    h.push("<circle id='fl1' cx='" + PX0 + "' cy='" + terrY(PX0).toFixed(1) + "' r='8' fill='none' stroke='#1d4e50' stroke-width='1.8' opacity='0'/>");
    h.push("<circle id='fl2' cx='" + (PX0 + PXW) + "' cy='" + terrY(PX0 + PXW).toFixed(1) + "' r='8' fill='none' stroke='#355c74' stroke-width='1.8' opacity='0'/>");
    /* 泄漏点 */
    h.push("<g id='lk'><path d='M0 -4 L-10 -21 L10 -21 Z' fill='#a64b3c'/><circle cx='0' cy='-2' r='3.6' fill='#a64b3c'/>"
      + "<path d='M-1 0 L-1 -8' stroke='#a64b3c' stroke-width='2'/>"
      + "<text id='lk-l1' x='0' y='-32' font-size='10' fill='#a64b3c' text-anchor='middle' stroke='#ffffff' stroke-width='2.6' paint-order='stroke'>泄漏点 —</text>"
      + "<text id='lk-l2' x='0' y='-22' font-size='9' fill='#83551f' text-anchor='middle' stroke='#ffffff' stroke-width='2.4' paint-order='stroke'>—</text></g>");
    svg.innerHTML = h.join('');
    pipeBuilt = true;
    anim.pw1 = el('pw1'); anim.pw2 = el('pw2'); anim.fl1 = el('fl1'); anim.fl2 = el('fl2'); anim.lk = el('lk');
  }
  function stationIcon(s) {
    var x = s ? PX0 + PXW : PX0, y = terrY(x), bx = x - (s ? 52 : 8);
    var o = [];
    o.push("<rect x='" + bx + "' y='104' width='60' height='30' rx='6' fill='#ffffff' stroke='#e3dccd'/>");
    o.push("<rect x='" + (bx + 5) + "' y='109' width='4' height='20' rx='2' fill='" + (s ? '#355c74' : '#1d4e50') + "'/>");
    o.push("<text x='" + (bx + 13) + "' y='115' font-size='10' fill='#4a585c'>" + (s ? '末站' : '首站') + "</text>");
    o.push("<text id='st-lbl" + s + "' x='" + (bx + 13) + "' y='128' font-size='8.5' font-family='monospace' fill='#99a3a4'>x = " + (s ? '120' : '0') + " km</text>");
    o.push("<path d='M" + x.toFixed(1) + " " + y.toFixed(1) + " L" + x.toFixed(1) + " 104' stroke='#d3c9b6' stroke-width='1' stroke-dasharray='2 2'/>");
    return o.join('');
  }
  function updatePipe() {
    if (!pipeBuilt) return;
    var xl = xOfKm(TR.x), yl = terrY(xl);
    anim.lk.style.display = TR.leak ? '' : 'none';
    if (TR.leak) {
      anim.lk.setAttribute('transform', 'translate(' + xl.toFixed(1) + ' ' + (yl).toFixed(1) + ')');
      el('lk-l1').textContent = '泄漏点 ' + (TR.x / 1000).toFixed(1) + ' km';
      el('lk-l2').textContent = TR.q.toFixed(0) + ' m³/h';
    }
    var d1 = Math.abs(TR.x - XS[0]), d2 = Math.abs(XS[1] - TR.x);
    el('pipe-t1').textContent = TR.leak
      ? 'v = ' + VW + ' m/s · 首站波到 t + ' + (d1 / VW).toFixed(0) + ' s · 末站波到 t + ' + (d2 / VW).toFixed(0) + ' s · Δt = ' + ((d1 - d2) / VW).toFixed(1) + ' s'
      : '当前场景没有泄漏：位置与漏量控件不参与计算';
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
  /* 带白色描边的文字标签：压在曲线/色带上也可读 */
  function halo(c, txt, x, y, col) {
    c.lineWidth = 2.6; c.strokeStyle = '#ffffff';
    c.strokeText(txt, x, y);
    c.fillStyle = col; c.fillText(txt, x, y);
    c.lineWidth = 1;
  }

  function drawPres(A) {
    var g = ctxOf('pres', 288), c = g.c, W = g.w;
    var Lp = 54, Rp = 12, T = 14, ph = [80, 80, 58], gap = 10;
    var y0 = [T, T + ph[0] + gap, T + ph[0] + gap + ph[1] + gap];
    var X = function (t) { return Lp + t / DUR * (W - Lp - Rp); };
    var cur = state.cursor;
    var iCur = Math.max(1, Math.min(N - 1, Math.round(cur / DT)));
    var rng = [];
    for (var s = 0; s < 2; s++) {
      var lo = Infinity, hi = -Infinity;
      for (var i = 0; i <= iCur; i++) { if (P[s][i] < lo) lo = P[s][i]; if (P[s][i] > hi) hi = P[s][i]; }
      rng.push(niceRange(lo, hi));
    }
    var yf = [function (v) { return y0[0] + (1 - (v - rng[0].lo) / (rng[0].hi - rng[0].lo)) * ph[0]; },
      function (v) { return y0[1] + (1 - (v - rng[1].lo) / (rng[1].hi - rng[1].lo)) * ph[1]; }];
    var smax = state.thr * 2.6;
    for (var i2 = 0; i2 < iCur; i2++) { if (S1[i2] > smax) smax = S1[i2]; if (S2[i2] > smax) smax = S2[i2]; }
    var yc = function (v) { return y0[2] + ph[2] / 2 - v / smax * (ph[2] / 2); };

    /* 面板底与网格 */
    var CO = ['#1d4e50', '#355c74'];
    for (var p = 0; p < 3; p++) {
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
    /* 事件色带 */
    if (TR.leak && TR.leak.t0 <= cur) {
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
      if (o.t0 > cur) return;
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
      polyline(c, function (i) { return X(i * DT); }, yf[s], P[s], 0, iCur, step);
    }
    /* 突变时刻竖线 */
    if (A.prim) {
      var xt = X(A.prim.tC);
      if (A.prim.tC <= cur) {
        c.strokeStyle = '#4a585c'; c.lineWidth = 1.4;
        c.beginPath(); c.moveTo(xt, y0[0]); c.lineTo(xt, y0[0] + ph[0] + gap + ph[1]); c.stroke();
        c.textAlign = xt > W - 190 ? 'right' : 'left';
        halo(c, '突变 t1/t2 @ ' + clockHM(A.prim.tC), xt > W - 190 ? xt - 4 : xt + 4, y0[0] + 11, '#4a585c');
        c.textAlign = 'left';
      }
      for (s = 0; s < 2; s++) {
        var ste = A.prim.st[s];
        if (!ste || ste.t > cur) continue;
        var xs = X(ste.t);
        c.fillStyle = CO[s];
        c.beginPath(); c.arc(xs, yf[s](P[s][Math.min(N - 1, Math.round(ste.t / DT))]), 3, 0, Math.PI * 2); c.fill();
        c.fillStyle = '#fff';
        c.beginPath(); c.arc(xs, yf[s](P[s][Math.min(N - 1, Math.round(ste.t / DT))]), 1.2, 0, Math.PI * 2); c.fill();
      }
    }
    /* 突变指标面板 */
    c.font = '8.5px ui-monospace, monospace';
    c.strokeStyle = '#d3c9b6';
    c.beginPath(); c.moveTo(Lp, yc(0)); c.lineTo(W - Rp, yc(0)); c.stroke();
    c.fillStyle = '#99a3a4'; c.textAlign = 'right';
    c.fillText(smax.toFixed(2), Lp - 4, yc(smax) + 6);
    c.fillText('0', Lp - 4, yc(0) + 3);
    c.textAlign = 'left';
    c.fillStyle = '#6f7a7c';
    c.fillText('突变指标 S = 前 60 s 均值 − 后 60 s 均值', Lp + 4, y0[2] + 11);
    var cols = Math.max(1, Math.round(W - Lp - Rp));
    for (s = 0; s < 2; s++) {
      var Sx = s === 0 ? S1 : S2;
      c.beginPath(); c.moveTo(Lp, yc(0));
      for (var cx = 0; cx <= cols; cx++) {
        var ta = cx / cols * DUR, tb = (cx + 1) / cols * DUR;
        var a = Math.floor(ta / DT), b = Math.max(a + 1, Math.ceil(tb / DT)), mx = 0;
        for (var k2 = a; k2 < b && k2 <= iCur; k2++) if (Sx[k2] > mx) mx = Sx[k2];
        c.lineTo(Lp + cx / cols * (W - Lp - Rp), yc(mx));
      }
      c.lineTo(W - Rp, yc(0)); c.closePath();
      c.fillStyle = s === 0 ? 'rgba(192,118,43,.22)' : 'rgba(49,99,156,.18)';
      c.fill();
      c.strokeStyle = CO[s] === '#1d4e50' ? '#a9742c' : '#355c74'; c.lineWidth = 1; c.stroke();
    }
    c.strokeStyle = '#a64b3c'; c.setLineDash([4, 3]); c.lineWidth = 1.2;
    c.beginPath(); c.moveTo(Lp, yc(state.thr)); c.lineTo(W - Rp, yc(state.thr)); c.stroke();
    c.setLineDash([]);
    c.fillStyle = '#a64b3c'; c.textAlign = 'right';
    halo(c, '阈值 ' + state.thr.toFixed(3) + ' MPa', W - Rp - 2, yc(state.thr) - 3, '#a64b3c');
    c.textAlign = 'left';
    /* 时间轴与游标 */
    c.font = '8.5px ui-monospace, monospace';
    c.textAlign = 'center';
    for (var t = 0; t <= 24; t += 2) {
      var xx = X(t * 3600);
      c.strokeStyle = '#d3c9b6';
      c.beginPath(); c.moveTo(xx, y0[2] + ph[2] + 3); c.lineTo(xx, y0[2] + ph[2] + 7); c.stroke();
      c.fillStyle = '#99a3a4'; c.fillText(t + '', xx, y0[2] + ph[2] + 18);
    }
    c.fillText('h', Lp - 22, y0[2] + ph[2] + 18);
    c.textAlign = 'left';
    if (cur < DUR) {
      c.strokeStyle = '#1c2529'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(X(cur), y0[0]); c.lineTo(X(cur), y0[2] + ph[2]); c.stroke();
      c.fillStyle = '#1c2529';
      c.fillText(clockHM(cur), X(cur) + 3, y0[2] + ph[2] + 18);
    }
  }

  /* ================= 绘制：Δt 放大 ================= */
  function drawDt(A) {
    var g = ctxOf('dt', 142), c = g.c, W = g.w, H = g.h;
    var Lp = 40, Rp = 8, T = 16, B = 22;
    var ph = H - T - B;
    var e = A.prim, f = e && e.fine;
    var pend = !!(e && e.tC > state.cursor);
    if (pend) { e = null; f = null; }
    if (!f || (!e.st[0] && !e.st[1])) {
      c.font = '10.5px ui-sans-serif, sans-serif'; c.fillStyle = '#99a3a4'; c.textAlign = 'center';
      c.fillText(pend ? '时间轴尚未播放到事件（' + clock(A.prim.tC) + '）'
        : e ? '精分析未确认突变（粗筛触发已抑制）' : '当前没有需要精分析的事件', W / 2, H / 2);
      c.textAlign = 'left';
      return;
    }
    var arrs = [];
    if (e.st[0]) arrs.push(e.st[0].t);
    if (e.st[1]) arrs.push(e.st[1].t);
    var t1 = Math.min.apply(null, arrs), t2 = Math.max.apply(null, arrs);
    var half = Math.max(60, (t2 - t1) * 1.6);
    if (2 * half > 400) half = Math.min(200, (DUR - (t2 - t1)) / 2);
    var x0 = Math.max(0, t1 - half), x1 = Math.min(DUR, t2 + half);
    if (x1 - x0 < 40) { x0 = Math.max(0, x0 - 20); x1 = Math.min(DUR, x1 + 20); }
    var X = function (t) { return Lp + (t - x0) / (x1 - x0) * (W - Lp - Rp); };
    var lo = Infinity, hi = -Infinity;
    for (var s = 0; s < 2; s++) {
      if (!f[s]) continue;
      for (var k = 0; k < f[s].P.length; k++) {
        var t = f[s].t0 + k, v = f[s].P[k] - f[s].B[k];
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
      if (!f[s]) continue;
      c.strokeStyle = CO[s]; c.lineWidth = 1.2;
      c.beginPath();
      for (k = 0; k < f[s].P.length; k++) {
        var tt = f[s].t0 + k;
        if (tt < x0 || tt > x1) continue;
        var yy = Y(f[s].P[k] - f[s].B[k]);
        if (k === 0) c.moveTo(X(tt), yy); else c.lineTo(X(tt), yy);
      }
      c.stroke();
      var pt = e.fine[s] ? e.fine[s].P : null;
      c.fillStyle = CO[s];
      c.fillText(nameS[s], Lp + 4 + s * 34, T + 11);
    }
    /* t1 / t2 竖线与 Δt 标注 */
    var seq = [];
    if (e.st[0]) seq.push({ s: 0, t: e.st[0].t });
    if (e.st[1]) seq.push({ s: 1, t: e.st[1].t });
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
      c.fillText('Δt = ' + e.dt.toFixed(1) + ' s', Math.min(Math.max((xa + xb) / 2, Lp + 34), W - 40), T - 5);
    }
    c.fillStyle = '#99a3a4'; c.textAlign = 'left';
    c.fillText('δp = 压力 − 基线（MPa）', Lp + 2, T + ph + 13);
    c.textAlign = 'right';
    c.fillText('窗口 ' + clock(x0) + ' — ' + clock(x1), W - Rp, T + ph + 13);
    c.textAlign = 'left';
  }

  /* ================= 绘制：流量平衡 ================= */
  function drawFlow(A) {
    var g = ctxOf('flow', 172), c = g.c, W = g.w, H = g.h;
    var Lp = 40, Rp = 10, T = 14, B = 22, ph = H - T - B;
    var cur0 = state.cursor, iC0 = Math.max(1, Math.min(N - 1, Math.round(cur0 / DT)));
    var maxV = DV_THR * 2, minV = 0;
    for (var qi = 0; qi <= iC0; qi++) { if (VFLOW[qi] > maxV) maxV = VFLOW[qi]; if (VFLOW[qi] < minV) minV = VFLOW[qi]; }
    var yHi = Math.max(46, maxV * 1.1), yLo = Math.min(-14, minV * 1.1);
    var X = function (t) { return Lp + t / DUR * (W - Lp - Rp); };
    var Y = function (v) { return T + (1 - (v - yLo) / (yHi - yLo)) * ph; };
    var cur = state.cursor, iCur = Math.max(1, Math.min(N - 1, Math.round(cur / DT)));
    c.fillStyle = '#fff'; c.fillRect(Lp, T, W - Lp - Rp, ph);
    c.strokeStyle = '#e3dccd'; c.lineWidth = 1; c.strokeRect(Lp + 0.5, T + 0.5, W - Lp - Rp - 1, ph - 1);
    c.font = '8.5px ui-monospace, monospace';
    c.textAlign = 'right'; c.fillStyle = '#99a3a4';
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
    c.fillStyle = '#a64b3c';
    halo(c, '持续偏离判据 ' + DV_THR + ' m³', Lp + 4, Y(DV_THR) - 3, '#a64b3c');
    /* ΔV 曲线 */
    c.strokeStyle = '#123b3a'; c.lineWidth = 1.2;
    polyline(c, function (i) { return X(i * DT); }, function (v) { return Y(Math.max(yLo, Math.min(yHi, v))); },
      VFLOW, 0, iCur, Math.max(1, Math.round(N / (W - Lp - Rp))));
    /* 峰值 / 末值标注 */
    var pk = -1e9, ipk = 0;
    for (var i = 0; i <= iCur; i++) if (VFLOW[i] > pk) { pk = VFLOW[i]; ipk = i; }
    c.fillStyle = '#123b3a';
    c.beginPath(); c.arc(X(ipk * DT), Y(Math.max(yLo, Math.min(yHi, pk))), 2.4, 0, Math.PI * 2); c.fill();
    c.font = '8.5px ui-monospace, monospace';
    halo(c, '峰值 ' + pk.toFixed(1) + ' m³', Lp + 4, T + 10, '#123b3a');
    var last = VFLOW[iCur];
    c.textAlign = 'right';
    halo(c, '末值 ' + last.toFixed(1) + ' m³' + (last > yHi ? ' ↑ 超出量程' : ''), W - Rp - 2, T + 10,
      last > DV_THR ? '#a64b3c' : '#6f7a7c');
    c.textAlign = 'left';
    if (A.fbAlarm !== null && A.fbAlarm <= cur) {
      var xf = X(A.fbAlarm);
      c.strokeStyle = '#3d8558'; c.setLineDash([3, 3]);
      c.beginPath(); c.moveTo(xf, T); c.lineTo(xf, T + ph); c.stroke();
      c.setLineDash([]);
      c.textAlign = xf > W - 120 ? 'right' : 'left';
      halo(c, '流量平衡报警 ' + clockHM(A.fbAlarm), xf > W - 120 ? xf - 3 : xf + 3, T + 10, '#3d8558');
      c.textAlign = 'left';
    }
    c.strokeStyle = '#d3c9b6';
    for (var t = 0; t <= 24; t += 4) {
      var xx = X(t * 3600);
      c.beginPath(); c.moveTo(xx, T + ph + 3); c.lineTo(xx, T + ph + 7); c.stroke();
      c.fillStyle = '#99a3a4'; c.textAlign = 'center'; c.fillText(t + '', xx, T + ph + 17);
    }
    c.textAlign = 'left'; c.fillText('h', Lp - 20, T + ph + 17);
    if (cur < DUR) {
      c.strokeStyle = '#1c2529';
      c.beginPath(); c.moveTo(X(cur), T); c.lineTo(X(cur), T + ph); c.stroke();
    }
  }

  /* ================= DOM 输出 ================= */
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
  var VNAME = {
    leak: ['真泄漏', 'ok'], 'leak-u': ['泄漏（未交叉验证）', 'warn'], single: ['单端报警 · 无法定位', 'warn'],
    'single-u': ['单端报警 · 未验证', 'warn'], op: ['工况扰动 · 已抑制', 'plain'], noise: ['粗筛触发 · 已抑制', 'plain'], invalid: ['定位被物理门限拒绝', 'bad']
  };

  function syncCtrl() {
    var on = state.scen === 'leak';
    ['r-pos', 'r-leak'].forEach(function (id) {
      var r = el(id); if (!r) return;
      r.disabled = !on;
      r.style.opacity = on ? '' : '.4';
    });
  }

  function render() {
    syncCtrl();
    TR = buildTruth();
    var A = analyze();
    updatePipe();
    drawPres(A);
    drawDt(A);
    drawFlow(A);
    var eVis = updateDom(A);
    updNote(A, eVis);
    return A;
  }

  function updateDom(A) {
    /* 与时间轴游标一致：只显示已经「播放到」的事件 */
    var vis = A.evts.filter(function (x) { return x.tC <= state.cursor; });
    var visSeep = (A.seep && A.seep.t <= state.cursor) ? A.seep : null;
    var e = null;
    vis.forEach(function (x) { if (!e && x.alarm) e = x; });
    if (!e && vis.length) e = vis[0];
    var vfp = vis.filter(function (x) { return x.alarm && !x.nearLeak; }).length + (visSeep && visSeep.fp ? 1 : 0);
    var vsup = vis.filter(function (x) { return x.v === 'op' || x.v === 'noise' || x.v === 'invalid'; }).length;
    var hasAlarm = !!(e && e.alarm), td = TR.leak ? TR.leak.t0 : 0;
    var loc = '—', err = '—', delay = '—';
    if (e && e.two && e.alarm) loc = (e.x / 1000).toFixed(2) + '<small>km</small>';
    if (e && e.two && e.alarm && TR.leak) {
      var dd = Math.abs(e.x - TR.x), pp = dd / L * 100;
      err = dd.toFixed(0) + '<small>m / ' + pp.toFixed(2) + '%</small>';
    }
    if (hasAlarm && TR.leak) {
      var dly = e.tAlarm - td;
      delay = dly < 0 ? '<small>早于泄漏 · 因果校验未通过</small>'
        : dly >= 120 ? (dly / 60).toFixed(1) + '<small>min</small>' : dly.toFixed(0) + '<small>s</small>';
    }
    if (visSeep) delay = ((visSeep.t - td) / 60).toFixed(0) + '<small>min</small>';
    el('st-loc').innerHTML = loc;
    el('st-err').innerHTML = err;
    el('st-delay').innerHTML = delay;
    el('st-fp').textContent = vfp;
    el('st-fp').parentNode.className = 'dstat' + (vfp ? ' bad' : '');
    el('time-hint').textContent = 't = ' + clockHM(state.cursor) + ' · ' + (state.cursor >= DUR ? '全天' : '播放中');
    el('alarms-hint').textContent = A.evts.length
      ? ('共 ' + A.evts.length + ' 次触发' + (vis.length < A.evts.length ? ' · 已显示 ' + vis.length : ''))
      : '无触发';

    /* 判定与定位 */
    var h = [];
    var seepMain = !!(visSeep && !(e && e.alarm));
    var vn = seepMain ? ['疑似小流量渗漏 · 无法定位', 'warn']
      : (e ? VNAME[e.v] : (A.evts.length && !vis.length ? ['等待事件（播放中）', 'plain'] : ['无事件', 'plain']));
    h.push('<div class="vrow"><span class="vk">判定</span><span class="vv"><span class="db ' + vn[1] + '">' + vn[0] + '</span></span></div>');
    if (!e && !seepMain && A.evts.length && !vis.length) {
      h.push('<div class="vform">时间轴还没播放到第一个候选事件（' + clock(A.evts[0].tC) + '）</div>');
    } else if (seepMain) {
      h.push('<div class="vform">泄漏时刻 + ' + ((visSeep.t - td) / 60).toFixed(0) + ' min 才报警：负压波未检出'
        + '（两端压力突变都低于 ' + state.thr.toFixed(3) + ' MPa 阈值），只有流量平衡法给出持续偏离</div>');
      h.push(row('检测延迟', ((visSeep.t - td) / 60).toFixed(0) + ' <small>min（报警 ' + clockHM(visSeep.t) + '）</small>'));
      h.push(row('定位结果', '— <small>无 t1 / t2，不能定位</small>'));
    } else if (e && e.v === 'invalid') {
      h.push('<div class="vform"><b style="color:var(--bad)">' + e.why + '</b><br>Δt 超出 L/v 允许范围，说明两端取到的不是同一个波前；本次输出被拒绝，计入误报而不是强行给一个定位。</div>');
    } else if (e && e.two) {
      h.push('<div class="vform">Δt = t1 − t2 = ' + clockD(e.st[0].t) + ' − ' + clockD(e.st[1].t)
        + ' = ' + e.dt.toFixed(1) + ' s<br>x = (L + v·Δt) / 2 = (120000 + 1100 × ' + e.dt.toFixed(1) + ') / 2 = '
        + (e.x / 1000).toFixed(2) + ' km' + (e.alarm ? '' : '（已抑制，不输出）') + '</div>');
    } else if (e) {
      h.push('<div class="vform">单端突变：只有' + (e.st[0] ? '首站' : (e.st[1] ? '末站' : '无站'))
        + '检出，构不成 Δt，定位不可用</div>');
    }
    if (e && !seepMain) {
      h.push(row('粗筛触发时刻', clock(e.tC) + ' <small>（阈值 ' + state.thr.toFixed(3) + ' MPa）</small>'));
      if (e.two) {
        h.push(row('t1 / t2（精分析）', (TR.leak
          ? (e.st[0].t - td).toFixed(1) + ' / ' + (e.st[1].t - td).toFixed(1) + ' s（泄漏后）'
          : clockD(e.st[0].t) + ' / ' + clockD(e.st[1].t))));
        h.push(row('粗筛 Δt', (Math.round(e.dt / 10) * 10) + ' <small>s（10 s 量化 → ±' + (VW * 5 / 1000).toFixed(1) + ' km）</small>'));
        h.push(row('定位结果（算法输出）', (e.x / 1000).toFixed(2) + ' <small>km</small>'));
        if (TR.leak) {
          var e2 = Math.abs(e.x - TR.x), p2 = e2 / L * 100;
          h.push('<div class="vrow"><span class="vk">实际位置 / 误差</span><span class="vv '
            + (e.alarm ? (p2 <= 1 ? 'ok' : 'bad') : '') + '">' + (TR.x / 1000).toFixed(2) + ' km <small>/</small> '
            + e2.toFixed(0) + ' m <small>占管长 ' + p2.toFixed(2) + '%</small></span></div>');
          if (e.alarm) {
            h.push('<div class="dbar" style="margin:2px 0 4px"><span class="track"><i style="width:'
              + Math.min(100, p2).toFixed(0) + '%"></i></span><span class="val">' + p2.toFixed(2) + '% / 1%</span></div>');
          }
        }
      }
      if (hasAlarm && TR.leak) {
        h.push(row('检测延迟', ((e.tAlarm - td) >= 120 ? ((e.tAlarm - td) / 60).toFixed(1) + ' min'
          : (e.tAlarm - td).toFixed(0) + ' s') + ' <small>（报警 ' + clock(e.tAlarm) + '）</small>'));
      }
      if (visSeep) {
        h.push('<div class="vform">泄漏时刻 + ' + ((visSeep.t - td) / 60).toFixed(0) + ' min 才报警：负压波未检出，只能靠流量平衡</div>');
      }
    }
    h.push(row('误报 / 抑制 / 漏报', vfp + ' / ' + vsup + ' / ' + ((A.miss && state.cursor >= DUR) ? '1' : '0') + ' <small>次</small>'));
    if (e && e.why) h.push('<p style="font-size:10.5px;color:var(--ink-3);line-height:1.6;margin-top:6px">' + e.why + '</p>');
    if (visSeep) h.push('<p style="font-size:10.5px;color:var(--ink-3);line-height:1.6;margin-top:4px">流量平衡法独立报警：'
      + clockHM(visSeep.t) + ' 累计流量差越过 ' + DV_THR + ' m³ 且仍在增长，负压波未检出 → 报警但不可定位。</p>');
    el('verdict').innerHTML = h.join('');
    el('vd-hint').textContent = e && e.two ? (e.alarm ? 'x = (L + v·Δt) / 2' : '负压波定位（未采用）') : '—';

    /* 交叉验证判据 */
    var hits = [];
    if (seepMain) {
      hits.push(cri(false, '<b>双端负压波</b>两端突变都未越过 ' + state.thr.toFixed(3) + ' MPa 阈值（小漏量的压力波幅被噪声淹没）'));
      hits.push(cri(true, '<b>流量平衡</b>' + clockHM(visSeep.t) + ' 累计流量差越过判据 ' + DV_THR + ' m³ 且仍在增长 → 持续偏离'));
      hits.push(cri(false, '<b>工况操作记录</b>期间无调阀 / 启停泵记录，但缺少时间差证据 → 只能报警、不能定位'));
    } else if (e) {
      var two = e.two, fs = e.fb;
      hits.push(cri(two, '<b>双端负压波</b>' + (two
        ? '首站 ' + clock(e.st[0].t) + '、末站 ' + clock(e.st[1].t) + '，Δt = ' + e.dt.toFixed(1)
          + ' s（物理上限 ±' + (L / VW).toFixed(0) + ' s 之内）'
        : '只有' + (e.st[0] ? '首站' : '末站') + '检出突变，另一端低于 ' + state.thr.toFixed(3) + ' MPa → 时间差定位不可用')));
      var fok = (fs.kind === 'sustained' || fs.kind === 'growing');
      hits.push(cri(state.flowX && fok, '<b>流量平衡</b>' + (state.flowX
        ? '累计流量差 ΔV 峰值 ' + fs.dev.toFixed(1) + ' m³、70 min 净增 ' + fs.net.toFixed(1) + ' m³（斜率 '
          + fs.slope.toFixed(1) + ' m³/h）→ '
          + (fs.kind === 'sustained' ? '越过判据 ' + DV_THR + ' m³（' + clockHM(fs.t) + '）'
            : fs.kind === 'growing' ? '持续增长（小漏量，未越判据）'
              : fs.kind === 'pulse' ? '短时脉冲后回落' : '无明显偏离')
        : '未启用（本项不参与判定）')));
      hits.push(cri(!(state.aware && e.op), '<b>工况操作记录</b>' + (e.op
        ? clockHM(e.op.t0) + ' ' + e.op.kind + '，距触发时刻 ' + Math.abs(e.op.t0 - e.tC).toFixed(0) + ' s（窗口 ±' + OP_WIN + ' s）'
        : '触发时刻前后 ±' + OP_WIN + ' s 内无调阀 / 启停泵记录')));
    } else {
      var pend = !!(A.evts.length && !vis.length);
      hits.push(cri(false, '<b>双端负压波</b>' + (pend ? '时间轴尚未播放到第一个候选事件（' + clock(A.evts[0].tC) + '）'
        : '全天突变指标未越过 ' + state.thr.toFixed(3) + ' MPa 阈值')));
      hits.push(cri(!!visSeep, '<b>流量平衡</b>' + (visSeep ? '累计 ΔV 越过判据 ' + DV_THR + ' m³ 且仍在增长'
        : '累计流量差在判据以下波动（已播放段峰值 ' + peakV().toFixed(1) + ' m³）')));
      hits.push(cri(false, '<b>工况操作记录</b>' + (TR.ops.length && !pend ? '本场景的调阀 / 泵切换均未产生压力突变' : '本场景无调阀 / 启停泵记录')));
    }
    el('hits').innerHTML = hits.join('');

    /* 检测日志 */
    var logs = vis.slice(0, 6);
    el('alarms').innerHTML = logs.map(function (ev) {
      var v = VNAME[ev.v], d = [];
      if (ev.two) {
        d.push('Δt = ' + ev.dt.toFixed(1) + ' s → ' + (ev.x / 1000).toFixed(2) + ' km'
          + (ev.alarm && TR.leak ? '（实际 ' + (TR.x / 1000).toFixed(2) + ' km，误差 ' + Math.abs(ev.x - TR.x).toFixed(0) + ' m）' : ''));
      }
      d.push(ev.why);
      return '<div class="ev"><span class="t">' + clock(ev.tC) + '</span><div><b>' + v[0] + '</b>'
        + '<div class="d">' + d.join('；') + '</div></div></div>';
    }).join('') + (visSeep ? '<div class="ev"><span class="t">' + clockHM(visSeep.t) + '</span><div><b>疑似小流量渗漏</b>'
      + '<div class="d">负压波未检出；流量平衡法报警（累计 ΔV 越过 ' + DV_THR + ' m³ 且仍在增长），无法定位</div></div></div>' : '')
      + (!vis.length && !visSeep ? '<p style="font-size:11px;color:var(--ink-4);padding:8px 0">'
        + (A.evts.length ? '时间轴尚未播放到第一个候选事件（' + clock(A.evts[0].tC) + '）。' : '全天无触发。') + '</p>' : '');
    if (A.miss && state.cursor >= DUR) el('alarms').innerHTML += '<div class="ev"><span class="t">—</span><div><b style="color:var(--bad)">漏报</b>'
      + '<div class="d">实际存在泄漏，但负压波与流量平衡都没报警</div></div></div>';
    return e;
  }
  function peakV() {
    var iCur = Math.max(1, Math.min(N - 1, Math.round(state.cursor / DT))), pk = 0;
    for (var i = 0; i <= iCur; i++) if (Math.abs(VFLOW[i]) > Math.abs(pk)) pk = VFLOW[i];
    return pk;
  }
  function row(k, v) { return '<div class="vrow"><span class="vk">' + k + '</span><span class="vv">' + v + '</span></div>'; }
  function cri(ok, txt) {
    return '<div class="hit"><span class="ic ' + (ok ? 'y' : 'n') + '">' + (ok ? '✓' : '—') + '</span><span class="tx">' + txt + '</span></div>';
  }

  /* ================= 说明文字 ================= */
  function updNote(A, eV) {
    var n = [];
    var e = eV === undefined ? A.prim : eV, x = (TR.x / 1000).toFixed(1);
    if (state.scen === 'steady') {
      n.push('当前是<b>稳态运行</b>：管线只有噪声与缓慢温度漂移，突变指标 S 全天压在 ' + state.thr.toFixed(3)
        + ' MPa 阈值之下，流量差累计在 ±5 m³ 内波动 → 零报警、零误报，这是误报抑制的下限要求。');
      if (state.noise >= 2) n.push('噪声已调到 ' + state.noise.toFixed(1) + '×（σ ≈ ' + (SIG * state.noise).toFixed(2)
        + ' MPa），固定阈值正被噪声频繁穿越——把阈值往上拖，误报退下去，但小漏量也会跟着看不见。');
      else n.push('把噪声拖到 2×—3×，可以看到<b>固定阈值</b>在噪声里开始误报：这是现场最典型的困境——阈值要么迟钝、要么吵。');
    } else if (state.scen === 'valve') {
      n.push('<b>调阀扰动</b>：节流发生在 45 km 阀室。上游首站压力反而<b>升</b> ' + (0.28 * Math.exp(-45000 / ATT)).toFixed(2)
        + ' MPa（检测器只看压降，所以首站不动），下游末站压力降 ' + (0.28 * Math.exp(-75000 / ATT)).toFixed(2)
        + ' MPa → 只有末站单端触发，Δt 构不成，定位不可用。');
      n.push(state.aware
        ? '工况记录命中 → 判为<b>工况扰动</b>，抑制报警（抑制 ' + A.sup + ' 次、误报 0）。把「工况感知」关掉看看：'
          + (state.flowX ? '流量平衡这一层仍然拦得住它（ΔV 峰值 5.5 m³ 后回落）。' : '两层都没了，调阀立刻变成「泄漏」。')
        : '工况感知已关闭。' + (state.flowX
          ? '流量平衡这一层仍然拦得住它（ΔV 峰值 5.5 m³ 后回落）→ 判为工况扰动，不计误报。'
          : '工况感知与流量平衡都关了 → 调阀直接报成「泄漏」，误报 +' + A.fp + '、抑制 ' + A.sup + '。'));
      if (!state.flowX) n.push('流量平衡已关闭，现在只剩工况记录一道防线——现场至少要保留两路独立判据，单靠任何一路都会出事。');
    } else if (state.scen === 'pump') {
      n.push('<b>泵切换</b>：首站压力瞬间掉 0.30 MPa，末站 109 s 后跟着掉 ' + (0.30 * Math.exp(-120000 / ATT)).toFixed(2)
        + ' MPa —— 两端的突变时间差刚好 ≈ L/v，算法会算出「漏点在首站附近 0 km 处」，这就是教科书级的误报。');
      n.push(state.aware ? '工况记录命中让判定归位（抑制 ' + A.sup + ' 次）；即使关掉工况感知，流量平衡里 ΔV 是<b>负向</b>短时偏离、随后回复，也判为工况扰动。'
        + '两个开关都关掉，它就会以「真泄漏」报出去。' : '工况感知已关闭，现在靠流量平衡拦：ΔV 负向偏离后回了头，判为扰动。');
    } else {
      n.push('<b>泄漏场景</b>：' + clockHM(TR.leak.t0) + ' 在 ' + x + ' km 处漏 ' + TR.q.toFixed(0)
        + ' m³/h（' + state.leakPct.toFixed(1) + '% 输量）。首站波到 t + ' + (TR.x / VW).toFixed(0) + ' s、末站波到 t + '
        + ((L - TR.x) / VW).toFixed(0) + ' s，两端时间差决定定位。');
      var showE = e;
      if (!showE && state.cursor >= TR.leak.t0 + 300) {
        A.evts.forEach(function (ev) { if (!showE && ev.alarm) showE = ev; });
      }
      if (!showE && TR.leak && state.cursor < TR.leak.t0) {
        n.push('时间轴播放到 ' + clockHM(state.cursor) + '，还没到泄漏时刻（' + clockHM(TR.leak.t0)
          + '）——继续播放，就能看到两站先后出现压力突变、Δt 定出位置。');
      } else if (showE && showE.two && showE.alarm) {
        n.push('当前算法输出：定位 ' + (showE.x / 1000).toFixed(2) + ' km，误差 ' + Math.abs(showE.x - TR.x).toFixed(0)
          + ' m（' + (Math.abs(showE.x - TR.x) / L * 100).toFixed(2) + '% 管长），检测延迟 '
          + ((showE.tAlarm - TR.leak.t0) >= 120 ? ((showE.tAlarm - TR.leak.t0) / 60).toFixed(1) + ' min' : (showE.tAlarm - TR.leak.t0).toFixed(0) + ' s')
          + '；09:20 的调阀被工况记录拦下，不计误报。');
      } else if (showE && showE.alarm) {
        n.push('当前算法输出：<b>单端报警</b>——只有' + (showE.st[0] ? '首站' : '末站') + '检出突变，另一端压力波幅压不进 '
          + state.thr.toFixed(3) + ' MPa 阈值，Δt 构不成，<b>只能报警、不能定位</b>。把漏量调大或把阈值拖低，两端都检到时才给得出位置。');
      } else if (A.seep) {
        n.push('当前算法输出：<b>负压波没检出来</b>（漏量太小，两端压力突变都低于 ' + state.thr.toFixed(3)
          + ' MPa 阈值），只有流量平衡法报警，延迟 ' + ((A.seep.t - TR.leak.t0) / 60).toFixed(0) + ' min，且<b>无法定位</b>。');
        n.push('把漏量调到 1% 以上或把阈值拖到 0.03 以下，负压波就能检出——这就是「检得到」与「定得准」之间的取舍。');
      } else {
        n.push('当前算法输出：全天无报警（漏量低于阈值且关闭了流量平衡交叉验证 → 漏报）。把漏量调大，或打开流量平衡交叉验证。');
      }
      n.push('拖动「泄漏位置」看定位结果跟着走：位置越靠近某一端，这一侧波到越早、Δt 越大，而远端的波幅经 '
        + (ATT / 1000) + ' km 衰减长度衰减后可能压不进阈值——所以近端泄漏常常只能单端报警。');
    }
    el('note').innerHTML = n.join(' ');
  }

  /* ================= 控制件 ================= */
  var seg = el('seg-scen');
  seg.innerHTML = SCENS.map(function (s) {
    return '<button data-s="' + s[0] + '"' + (s[0] === state.scen ? ' class="on"' : '') + '>' + s[1] + '</button>';
  }).join('');
  seg.addEventListener('click', function (ev) {
    var b = ev.target.closest('button');
    if (!b) return;
    state.scen = b.getAttribute('data-s');
    [].forEach.call(seg.children, function (x) { x.classList.toggle('on', x === b); });
    render();
  });
  function bindRange(id, key, fmt) {
    var r = el(id);
    r.value = state[key];
    var out = el('o-' + id.slice(2));
    var upd = function () {
      state[key] = Number(r.value);
      out.textContent = fmt(state[key]);
      render();
    };
    r.addEventListener('input', upd);
    out.textContent = fmt(state[key]);
  }
  bindRange('r-pos', 'pos', function (v) { return (v / 100 * L / 1000).toFixed(1) + ' km'; });
  bindRange('r-leak', 'leakPct', function (v) { return v.toFixed(1) + ' % / ' + (Q0 * v / 100).toFixed(0) + ' m³/h'; });
  bindRange('r-noise', 'noise', function (v) { return v.toFixed(1) + '×'; });
  bindRange('r-thr', 'thr', function (v) { return v.toFixed(3) + ' MPa'; });
  function bindTog(id, key) {
    var t = el(id);
    t.classList.toggle('on', state[key]);
    t.addEventListener('click', function () {
      state[key] = !state[key];
      t.classList.toggle('on', state[key]);
      render();
    });
  }
  bindTog('tog-aware', 'aware');
  bindTog('tog-flow', 'flowX');
  var reset = el('btn-reset');
  if (reset) reset.addEventListener('click', function () {
    state.scen = 'leak'; state.pos = 62; state.leakPct = 2.0; state.noise = 1.0; state.thr = 0.045;
    state.aware = true; state.flowX = true; state.cursor = DUR; state.playing = false;
    [].forEach.call(seg.children, function (x) { x.classList.toggle('on', x.getAttribute('data-s') === 'leak'); });
    el('r-pos').value = '62'; el('o-pos').textContent = '74.4 km';
    el('r-leak').value = '2'; el('o-leak').textContent = '2.0 % / 32 m³/h';
    el('r-noise').value = '1'; el('o-noise').textContent = '1.0×';
    el('r-thr').value = '0.045'; el('o-thr').textContent = '0.045 MPa';
    el('tog-aware').classList.add('on'); el('tog-flow').classList.add('on');
    render();
  });
  var rz = null;
  window.addEventListener('resize', function () { clearTimeout(rz); rz = setTimeout(function () { render(); }, 180); });
  var timer = null;
  el('play').addEventListener('click', function () {
    if (state.playing) {
      clearInterval(timer); state.playing = false; el('play').textContent = '▶ 播放 24 h'; return;
    }
    state.playing = true;
    el('play').textContent = '■ 暂停';
    if (state.cursor >= DUR) state.cursor = 0;
    timer = setInterval(function () {
      state.cursor = Math.min(DUR, state.cursor + DUR / 240);
      render();
      if (state.cursor >= DUR) {
        clearInterval(timer); state.playing = false; el('play').textContent = '▶ 播放 24 h';
      }
    }, 33);
  });

  /* ================= 示意图动画 ================= */
  var tA = 1.5, tPrev = null;   /* 从 1.5 s 起播：首屏即可看到两个波前在管线上分开 */
  function tick(ts) {
    if (tPrev === null) tPrev = ts;
    var dtr = Math.min(0.1, (ts - tPrev) / 1000);
    tPrev = ts;
    tA += dtr;
    if (pipeBuilt && TR) {
      var d1 = Math.abs(TR.x - XS[0]), d2 = Math.abs(XS[1] - TR.x);
      var travelMax = Math.max(d1, d2) / VW;
      var T_SIM = 3.0, comp = T_SIM / travelMax;
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
      el('pipe-hint').textContent = '示意动画 · 时间压缩 ≈ ' + (1 / comp).toFixed(0) + '×';
    }
    requestAnimationFrame(tick);
  }

  window.__demo = {
    state: state,
    analyze: analyze,
    series: function () { return { P: P, S1: S1, S2: S2, V: VFLOW }; },
    fineAt: function (s, tC) { return fineDetect(s, tC); },
    fineDbg: function (s, tC) {
      var t0 = Math.max(0, Math.round(tC - HW)), n = Math.min(DUR - t0, 2 * HW) + 1;
      var w = fineWindow(s, t0, n), sc = scan(w.P, DT_F, W_F, PERS_F);
      var mx = 0, im = 0, i;
      for (i = 0; i < sc.S.length; i++) if (sc.S[i] > mx) { mx = sc.S[i]; im = i; }
      return { maxS: mx, iMax: im, tMax: t0 + im, cand: sc.cand.map(function (c) { return c.t; }), t0: t0 };
    },
    truth: function () { return TR; },
    tick: tick,
    set: function (o) {
      for (var k in o) if (o.hasOwnProperty(k)) state[k] = o[k];
      if (o.scen) [].forEach.call(seg.children, function (x) { x.classList.toggle('on', x.getAttribute('data-s') === state.scen); });
      if (o.pos !== undefined) el('r-pos').value = state.pos, el('o-pos').textContent = (state.pos / 100 * L / 1000).toFixed(1) + ' km';
      if (o.leakPct !== undefined) el('r-leak').value = state.leakPct, el('o-leak').textContent = state.leakPct.toFixed(1) + ' %';
      if (o.noise !== undefined) el('r-noise').value = state.noise;
      if (o.thr !== undefined) el('r-thr').value = state.thr;
      if (o.aware !== undefined) el('tog-aware').classList.toggle('on', state.aware);
      if (o.flowX !== undefined) el('tog-flow').classList.toggle('on', state.flowX);
      return render();
    },
    result: function () {
      var A = analyze(), e = A.prim;
      return {
        verdict: e ? e.v : 'none', text: (e ? VNAME[e.v][0] : '无事件'),
        x: e && e.two && e.alarm ? e.x : null, trueX: TR.x,
        err: e && e.two && e.alarm ? Math.abs(e.x - TR.x) : null,
        delay: e && e.alarm && TR.leak ? e.tAlarm - TR.leak.t0 : (A.seep ? A.seep.t - TR.leak.t0 : null),
        dt: e && e.two ? e.dt : null, fp: A.fp, sup: A.sup, miss: A.miss,
        evts: A.evts.map(function (v) { return v.v; }), seep: !!A.seep
      };
    }
  };

  buildPipe();
  render();
  requestAnimationFrame(tick);
})();
