/* =========================================================
   修井作业风险预警 · 可运行示范（2 s / 点，60 min = 1800 点）
   ---------------------------------------------------------
   ① 工序顺序：压井/井控 → 起原井管柱 → 通井/打印 →
      磨铣/打捞 →（卡管柱后插入）停钻/活动管柱 → 震击解卡 →
      循环洗井 → 完井试压
   ② 六通道：悬重 / 扭矩 / 立压 / 套压 / 返出流量 / 池体积
   ③ 主报警来自联合判据（不是三通道 |z| 的最大值）：
      卡管柱前兆 = 扭矩↑ 且 悬重↓
      漏失       = 立压↓ 且 (返出↓ 或 池体积↓)
      井涌/气侵  = 套压↑ 且 (返出↑ 或 池体积↑)
   ④ 跳过边界 24 s 后逐工序热启动 90 s（不检测）+ 末端 30 s 缓冲；灰带与 z 用同一个 σ
   ⑤ 连续/相邻报警合并为 episode；检出、漏报、误报、中位提前量分开统计
   ========================================================= */
(function () {
  'use strict';

  var DUR = 60;                       /* min */
  var DT = 2 / 60;                    /* 2 s / 点 = 0.03333 min */
  var N = Math.round(DUR / DT);       /* 1800 点 */
  var SKIP_PTS = Math.round(0.4 / DT);   /* 跳过工序边界起停泵冲击（24 s） */
  var WARM_PTS = Math.round(1.5 / DT);   /* 90 s 热启动 */
  var BUF_PTS = Math.round(0.5 / DT);    /* 30 s 工序末端缓冲 */
  var MERGE_GAP = 15;                    /* 30 s 内的相邻报警合并 */

  var CH = [
    { key: 'hook',   name: '悬重',   unit: 'kN',   dec: 1, color: '#1d4e50', floor: 0.6 },
    { key: 'tor',    name: '扭矩',   unit: 'kN·m', dec: 2, color: '#a9742c', floor: 0.03 },
    { key: 'spp',    name: '立压',   unit: 'MPa',  dec: 2, color: '#355c74', floor: 0.04 },
    { key: 'casing', name: '套压',   unit: 'MPa',  dec: 2, color: '#6e6a3c', floor: 0.03 },
    { key: 'flow',   name: '返出',   unit: '%',    dec: 1, color: '#3a7d6b', floor: 0.15 },
    { key: 'pit',    name: '池体积', unit: 'm³',   dec: 1, color: '#7a5c8a', floor: 0.08 }
  ];
  var CHK = {};
  CH.forEach(function (c) { CHK[c.key] = c; });

  /* 5 个图面板；最后一个面板叠画返出与池体积（各自量程） */
  var PANELS = [
    { keys: ['hook'],   title: '悬重 / kN' },
    { keys: ['tor'],    title: '扭矩 / kN·m' },
    { keys: ['spp'],    title: '立压（泵压）/ MPa' },
    { keys: ['casing'], title: '套压 / MPa' },
    { keys: ['flow', 'pit'], title: '返出 % / 池体积 m³' }
  ];

  /* 逐工序基准。压井在前；卡管柱发生后进入活动管柱/震击解卡，
     不再按原计划直接“循环洗井”。 */
  var PHASES = [
    { t0: 0,  t1: 8,  name: '压井 / 井控',        sub: '先建立井控，再动管柱',
      base: { hook: 420, tor: 0.40, spp: 6.40, casing: 6.20, flow: 26, pit: 100 },
      sd:   { hook: 3.0, tor: 0.06, spp: 0.15, casing: 0.35, flow: 1.2, pit: 0.40 },
      casingDrift: -4.0 },
    { t0: 8,  t1: 16, name: '起原井管柱',          sub: '起出原井管柱，悬重周期性波动',
      base: { hook: 402, tor: 0.20, spp: 0.50, casing: 2.20, flow: 0.4, pit: 100 },
      sd:   { hook: 9.0, tor: 0.05, spp: 0.12, casing: 0.18, flow: 0.30, pit: 0.25 },
      osc: { amp: 20, period: 1.5 } },
    { t0: 16, t1: 24, name: '通井 / 打印',         sub: '通井、打印鱼顶，低扭矩循环',
      base: { hook: 390, tor: 4.60, spp: 5.00, casing: 1.20, flow: 30, pit: 100 },
      sd:   { hook: 5.0, tor: 0.28, spp: 0.16, casing: 0.12, flow: 1.2, pit: 0.30 } },
    { t0: 24, t1: 30, name: '磨铣 / 打捞',         sub: '磨铣落物并打捞',
      base: { hook: 404, tor: 8.80, spp: 4.70, casing: 1.00, flow: 32, pit: 100 },
      sd:   { hook: 4.5, tor: 0.35, spp: 0.16, casing: 0.10, flow: 1.2, pit: 0.30 } },
    { t0: 30, t1: 36, name: '停钻 / 活动管柱',     sub: '卡管柱后插入：停转、上提下放活动',
      base: { hook: 432, tor: 0.50, spp: 5.40, casing: 1.10, flow: 27, pit: 100 },
      sd:   { hook: 9.0, tor: 0.08, spp: 0.18, casing: 0.10, flow: 1.0, pit: 0.30 } },
    { t0: 36, t1: 42, name: '震击解卡',            sub: '震击器解卡，保持循环',
      base: { hook: 448, tor: 0.30, spp: 5.20, casing: 1.20, flow: 26, pit: 100 },
      sd:   { hook: 14.0, tor: 0.06, spp: 0.20, casing: 0.12, flow: 1.0, pit: 0.30 },
      osc: { amp: 22, period: 0.8 } },
    { t0: 42, t1: 50, name: '循环洗井',            sub: '解卡后循环洗井，恢复正常排量',
      base: { hook: 396, tor: 1.10, spp: 5.60, casing: 0.90, flow: 34, pit: 100 },
      sd:   { hook: 3.5, tor: 0.12, spp: 0.15, casing: 0.08, flow: 1.1, pit: 0.25 } },
    { t0: 50, t1: 60, name: '完井试压',            sub: '完井管柱试压，扭矩≈0',
      base: { hook: 398, tor: 0.20, spp: 7.80, casing: 0.80, flow: 0.3, pit: 100 },
      sd:   { hook: 2.5, tor: 0.05, spp: 0.15, casing: 0.08, flow: 0.30, pit: 0.20 },
      sppRamp: 0.8 }
  ];

  /* 真值事件：前兆起点 + 发生时刻 */
  var EVENTS = [
    { tPre: 26.0, t: 30.0, name: '卡管柱', desc: '扭矩持续上升 + 悬重下降', rule: 'stuck' },
    { tPre: 44.0, t: 48.0, name: '漏失',   desc: '立压下降 + 返出/池体积同降', rule: 'loss' }
  ];

  var LAMBDA = { hook: 0.005, tor: 0.005, spp: 0.004, casing: 0.005, flow: 0.005, pit: 0.005 };
  var LAMBDA_GLOBAL = { hook: 0.003, tor: 0.003, spp: 0.0025, casing: 0.003, flow: 0.003, pit: 0.003 };

  /* ---------- 合成数据 ---------- */
  var rnd = (function () { var a = 7; return function () { a = (a * 16807) % 2147483647; return a / 2147483647; }; })();
  /* 3 个均匀分布求和再减 1.5：标准差 = sqrt(3/12) = 0.5；×2.0 后 sd = 1.0。
     原来的 ×1.4 只有 sd=0.7，和标称不符。 */
  function gauss() { return (rnd() + rnd() + rnd() - 1.5) * 2.0; }

  var DATA = {};
  CH.forEach(function (c) { DATA[c.key] = []; });
  var PHASE_OF = [];

  for (var i = 0; i < N; i++) {
    var t = i * DT;
    var ph = PHASES[0];
    for (var p = 0; p < PHASES.length; p++) if (t >= PHASES[p].t0 && t < PHASES[p].t1) ph = PHASES[p];
    PHASE_OF.push(ph);

    CH.forEach(function (c) {
      var k = c.key;
      var v = ph.base[k];
      if (k === 'casing' && ph.casingDrift) v += ph.casingDrift * (t - ph.t0) / (ph.t1 - ph.t0);
      if (k === 'hook' && ph.osc) v += ph.osc.amp * Math.sin(2 * Math.PI * (t - ph.t0) / ph.osc.period);
      if (k === 'spp' && ph.sppRamp) v += ph.sppRamp * Math.min(1, (t - ph.t0) / 0.8);
      v += gauss() * ph.sd[k];
      /* 起停泵冲击（已知扰动）：只在工序边界 ±0.4 min 内 */
      var edge = Math.min(t - ph.t0, ph.t1 - t);
      if (edge < 0.4) {
        var e = 1 - edge / 0.4;
        if (k === 'spp') v += 0.9 * e;
        if (k === 'flow') v += 5.0 * e;
      }
      DATA[k].push(v);
    });

    /* 异常 1：卡管柱前兆（26 min 起，30 min 卡管柱） */
    if (t >= 26 && t < 30) {
      var f1 = (t - 26) / 4;
      DATA.tor[i] += 4.8 * f1;
      DATA.hook[i] -= 30 * f1;
      DATA.spp[i] += 0.35 * f1;
      DATA.flow[i] -= 2.5 * f1;
    }
    /* 异常 2：漏失（44 min 起前兆，48 min 确认漏失） */
    if (t >= 44 && t < 50) {
      var f2 = Math.min(1, (t - 44) / 4);
      DATA.spp[i] -= 2.4 * f2;
      DATA.flow[i] -= 9.0 * f2;
      DATA.pit[i] -= 7.0 * f2;
      DATA.casing[i] -= 0.25 * f2;
    }
  }

  var state = {
    thr: 2.5,              /* 预警阈值；关注 = thr-0.5，报警 = thr+0.5 且持续 ≥60 s */
    run: 6,                /* 连续 6 点 = 12 s */
    phaseAware: true,
    speed: 1,
    cursor: 0,
    playing: false,
    hover: null
  };
  function gate() { return Math.max(0.5, state.thr - 0.5); }

  /* ---------- 基线 / 残差 / 联合判据 / episode ---------- */
  function medianOf(arr) {
    var a = arr.slice().sort(function (x, y) { return x - y; });
    if (!a.length) return 0;
    var m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }
  function segStats(key, i0, i1) {
    var arr = [];
    for (var i = i0; i < i1; i++) arr.push(DATA[key][i]);
    var med = medianOf(arr);
    var dev = [];
    for (var j = 0; j < arr.length; j++) dev.push(Math.abs(arr[j] - med));
    var mad = medianOf(dev);
    return { med: med, sigma: Math.max(CHK[key].floor, 1.4826 * mad) };
  }

  function ruleEval(z) {
    var out = [];
    if (z.tor >= 1.2 && z.hook <= -1.2) {
      out.push({ key: 'stuck', score: Math.min(z.tor, -z.hook) });
    }
    var retDown = Math.max(-z.flow, -z.pit);
    if (z.spp <= -1.2 && retDown >= 1.2) {
      out.push({ key: 'loss', score: Math.min(-z.spp, retDown) });
    }
    var retUp = Math.max(z.flow, z.pit);
    if (z.casing >= 1.2 && retUp >= 1.2) {
      out.push({ key: 'kick', score: Math.min(z.casing, retUp) });
    }
    return out;
  }

  function analyze() {
    var aware = state.phaseAware;
    var segs = aware
      ? PHASES.map(function (p) { return { t0: p.t0, t1: p.t1 }; })
      : [{ t0: 0, t1: DUR }];
    var out = {
      base: {}, sig: {}, z: {}, risk: [], episodes: [], events: [],
      detected: 0, missed: EVENTS.length, falseCount: 0, leadMedian: null
    };
    CH.forEach(function (c) {
      out.base[c.key] = new Array(N);
      out.sig[c.key] = new Array(N);
      out.z[c.key] = new Array(N);
    });

    CH.forEach(function (c) {
      var k = c.key;
      for (var s = 0; s < segs.length; s++) {
        var i0 = Math.round(segs[s].t0 / DT);
        var i1 = Math.min(N, Math.round(segs[s].t1 / DT));
        /* 跳过边界冲击，再用 90 s 窗口的中位数/MAD 初始化（独立热启动段） */
        var warmStart = Math.min(i1, i0 + SKIP_PTS);
        var warmEnd = Math.min(i1, warmStart + WARM_PTS);
        var st = segStats(k, warmStart, warmEnd);
        var slow = st.med;
        var absdev = 0.7979 * st.sigma;   /* E|e| = 0.7979σ */
        for (var i = i0; i < i1; i++) {
          if (i < warmEnd) {
            out.base[k][i] = st.med;
            out.sig[k][i] = st.sigma;
            out.z[k][i] = 0;
            continue;
          }
          /* 先算 z（用上一步的 slow / σ），再更新 slow 与 absdev */
          var sigma = Math.max(c.floor, absdev / 0.7979);
          var zv = (DATA[k][i] - slow) / sigma;
          if (aware && i >= i1 - BUF_PTS) zv = 0;
          out.base[k][i] = slow;
          out.sig[k][i] = sigma;
          out.z[k][i] = zv;
          var lam = aware ? LAMBDA[k] : LAMBDA_GLOBAL[k];
          slow += lam * (DATA[k][i] - slow);
          absdev += 0.002 * (Math.abs(DATA[k][i] - slow) - absdev);
        }
      }
    });

    var g = gate();
    for (var i2 = 0; i2 < N; i2++) {
      var z = {};
      var maxAbs = 0, maxKey = '';
      for (var c2 = 0; c2 < CH.length; c2++) {
        var kk = CH[c2].key;
        z[kk] = out.z[kk][i2];
        if (Math.abs(z[kk]) > maxAbs) { maxAbs = Math.abs(z[kk]); maxKey = kk; }
      }
      var rules = ruleEval(z);
      var best = null;
      for (var r = 0; r < rules.length; r++) if (!best || rules[r].score > best.score) best = rules[r];
      /* 单通道阈值只作为“关闭工况感知”时的朴素对照；
         开启工况感知时主风险分只来自联合判据，避免噪声尖刺冒充报警。 */
      if (!best && !state.phaseAware && maxAbs >= g + 0.4 && ['hook', 'tor', 'spp', 'flow'].indexOf(maxKey) >= 0) {
        best = { key: 'single', score: maxAbs, chan: maxKey };
      }
      out.risk.push({
        score: best ? best.score : 0,
        rule: best ? best.key : null,
        chan: best && best.chan ? best.chan : null,
        joint: !!(best && best.key !== 'single'),
        rules: rules,
        maxAbs: maxAbs,
        maxKey: maxKey
      });
    }

    /* 连续超门限段：同时记录其中的联合判据起点/峰值/有效时长 */
    var runs = [];
    var i3 = 0;
    while (i3 < N) {
      if (out.risk[i3].score >= g) {
        var s3 = i3, peak = 0, peakI = i3;
        var jStart = -1, jEnd = -1, jPeak = 0, jRule = null, jActive = 0;
        while (i3 < N && out.risk[i3].score >= g) {
          var rr = out.risk[i3];
          if (rr.score > peak) { peak = rr.score; peakI = i3; }
          if (rr.joint) {
            if (jStart < 0) jStart = i3;
            jEnd = i3 + 1;
            jActive += 1;
            if (rr.score > jPeak) { jPeak = rr.score; jRule = rr.rule; }
          }
          i3++;
        }
        runs.push({
          s: s3, e: i3, peak: peak, peakI: peakI,
          rule: out.risk[peakI].rule,
          jStart: jStart >= 0 ? jStart : null,
          jEnd: jEnd >= 0 ? jEnd : null,
          jPeak: jPeak, jRule: jRule, jActive: jActive
        });
      } else i3++;
    }
    /* 相邻/连续报警合并为 episode（间隔 ≤30 s），再执行持续判据 */
    var merged = [];
    runs.forEach(function (r2) {
      var last = merged[merged.length - 1];
      if (last && r2.s - last.e <= MERGE_GAP) {
        last.e = r2.e;
        last.segs += 1;
        last.activePts += (r2.e - r2.s);
        if (r2.peak > last.peak) { last.peak = r2.peak; last.peakI = r2.peakI; last.rule = r2.rule; }
        if (r2.jStart !== null) {
          if (last.jStart === null) last.jStart = r2.jStart;
          last.jEnd = r2.jEnd;
          last.jActive += r2.jActive;
          if (r2.jPeak > last.jPeak) { last.jPeak = r2.jPeak; last.jRule = r2.jRule; }
        }
      } else {
        merged.push({
          s: r2.s, e: r2.e, peak: r2.peak, peakI: r2.peakI, rule: r2.rule,
          jStart: r2.jStart, jEnd: r2.jEnd, jPeak: r2.jPeak, jRule: r2.jRule,
          jActive: r2.jActive, segs: 1, activePts: r2.e - r2.s
        });
      }
    });
    merged.forEach(function (m) {
      if (m.activePts < state.run) return;
      var hasJoint = m.jStart !== null && m.jActive >= state.run;
      /* 单通道只作“关注”：要求更强的持续性，避免噪声碎片变成报警 */
      if (!hasJoint && m.activePts < Math.max(state.run, 30)) return;
      var t0 = (hasJoint ? m.jStart : m.s) * DT;
      var t1 = (hasJoint ? m.jEnd : m.e) * DT;
      var peak = hasJoint ? m.jPeak : m.peak;
      var rule = hasJoint ? m.jRule : m.rule;
      var active = hasJoint ? m.jActive : m.activePts;
      var dur = active * DT * 60;
      var level = 1;
      if (peak >= g + 0.5) level = 2;
      if (peak >= g + 1.0 && dur >= 60) level = 3;
      if (!hasJoint) level = 1;
      out.episodes.push({
        t0: t0, t1: t1, peak: peak, rule: rule,
        joint: hasJoint, segs: m.segs, dur: dur, span: (m.e - m.s) * DT * 60,
        confirmed: hasJoint && level >= 2,
        level: level, event: null, lead: null
      });
    });

    /* 与真值对比：只有联合判据 episode 才计入“检出”；
       报警必须发生在事件之前（留 ≥0.2 min 提前量）。 */
    EVENTS.forEach(function (ev, ei) {
      var hit = null;
      out.episodes.forEach(function (ep) {
        /* 有效检出 = 联合判据达到预警级（≥阈值）且提前 ≥2 min；
           短抖动或迟到报警即使落在事件窗口内也只算误报/待确认。 */
        if (!ep.confirmed) return;
        if (ep.t0 >= ev.tPre - 1.0 && ep.t0 <= ev.t - 0.2 && !hit && (ev.t - ep.t0) >= 2.0) hit = ep;
      });
      if (hit) {
        hit.event = ev;
        hit.eventIndex = ei;
        hit.lead = ev.t - hit.t0;
      }
    });
    out.events = EVENTS.map(function (ev, ei) {
      var hit = out.episodes.filter(function (ep) { return ep.event === ev; })[0] || null;
      return { ev: ev, index: ei, episode: hit, lead: hit ? hit.lead : null };
    });
    out.detected = out.events.filter(function (e) { return !!e.episode; }).length;
    out.missed = EVENTS.length - out.detected;
    out.falseCount = out.episodes.filter(function (ep) { return !ep.event; }).length;
    var leads = out.events.filter(function (e) { return e.lead !== null; }).map(function (e) { return e.lead; });
    if (leads.length) {
      leads.sort(function (a, b) { return a - b; });
      var mm = Math.floor(leads.length / 2);
      out.leadMedian = leads.length % 2 ? leads[mm] : (leads[mm - 1] + leads[mm]) / 2;
    }
    return out;
  }

  /* ---------- 画布 ---------- */
  var cv = document.getElementById('proc');
  var ctx = cv.getContext('2d');
  var A = null;
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
  var RULENAME = { stuck: '卡管柱前兆', loss: '漏失', kick: '井涌/气侵', single: '单通道偏离' };

  function layout() {
    Wc = cv.clientWidth || 760;
    Hc = cv.clientHeight || 600;
    cv.width = Math.round(Wc * DPR);
    cv.height = Math.round(Hc * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    G.L = 54; G.R = 16;
    G.top = 68;
    G.riskY = G.top;
    G.riskH = 54;
    G.rawY = G.riskY + G.riskH + 6;
    G.stripH = 12;
    G.axisH = 18;
    var avail = Hc - G.rawY - G.stripH - G.axisH - 12;
    G.rawH = avail / PANELS.length;
    G.stripY = G.rawY + PANELS.length * G.rawH + 16;
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

  function zColor(v) {
    var a = Math.abs(v);
    if (a < 1) return '#eee9dd';
    if (a < 2) return '#dfe8f2';
    if (a < 2.5) return '#b9cde4';
    if (a < 3) return '#e8d3a8';
    if (a < 4) return '#d9a06a';
    return '#c06a5a';
  }
  function zTextColor(v) {
    var g = gate(), a = Math.abs(v);
    if (a >= g + 1.0) return COLS.bad;
    if (a >= g + 0.5) return COLS.warn;
    if (a >= g) return COLS.info;
    return COLS.ok;
  }

  function drawRisk(Ax, vis) {
    var y0 = G.riskY, h = G.riskH;
    ctx.fillStyle = '#fff';
    ctx.fillRect(G.L, y0, G.plotW, h);
    ctx.strokeStyle = COLS.line2;
    ctx.strokeRect(G.L, y0, G.plotW, h);

    var hi = 4.2;
    for (var i = 0; i < N; i++) if (Ax.risk[i].score > hi) hi = Ax.risk[i].score;
    hi = Math.ceil(hi * 1.1 * 2) / 2;
    var sy = function (v) { return y0 + (1 - v / hi) * (h - 8); };

    /* 报警区间底色 */
    Ax.episodes.forEach(function (ep) {
      if (ep.t0 > vis) return;
      var x0 = G.sx(ep.t0), x1 = G.sx(Math.min(ep.t1, vis));
      ctx.fillStyle = ep.level === 3 ? 'rgba(166,75,60,.09)' : ep.level === 2 ? 'rgba(169,116,44,.09)' : 'rgba(58,110,165,.08)';
      ctx.fillRect(x0, y0 + 2, Math.max(1, x1 - x0), h - 4);
    });

    /* 风险分曲线 */
    var nVis = Math.min(N, Math.floor(vis / DT) + 1);
    var step = Math.max(1, Math.floor(nVis / (G.plotW * 1.2)));
    ctx.beginPath();
    ctx.moveTo(G.sx(0), sy(0));
    for (var i2 = 0; i2 < nVis; i2 += step) ctx.lineTo(G.sx(i2 * DT), sy(Ax.risk[i2].score));
    ctx.lineTo(G.sx(Math.min(vis, DUR)), sy(0));
    ctx.closePath();
    ctx.fillStyle = 'rgba(58,110,165,.10)';
    ctx.fill();
    ctx.beginPath();
    for (var i3 = 0; i3 < nVis; i3 += step) {
      var px = G.sx(i3 * DT), py = sy(Ax.risk[i3].score);
      if (i3 === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = COLS.info;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.lineWidth = 1;

    /* 阈值线：关注 / 预警 / 报警（标签集中在右上角，避免三条线标签重叠） */
    var g = gate();
    [g, g + 0.5, g + 1.0].forEach(function (v, li) {
      var yy = sy(v);
      ctx.strokeStyle = li === 2 ? 'rgba(166,75,60,.75)' : li === 1 ? 'rgba(169,116,44,.75)' : 'rgba(58,110,165,.75)';
      ctx.setLineDash(li === 0 ? [4, 3] : [2, 3]);
      ctx.beginPath(); ctx.moveTo(G.L, yy); ctx.lineTo(Wc - G.R, yy); ctx.stroke();
      ctx.setLineDash([]);
    });

    /* 标题白底，避免虚线穿字 */
    ctx.font = '9.5px ui-monospace, monospace';
    var title = '联合风险分（多判据取最大）';
    var tw = ctx.measureText(title).width + 10;
    ctx.fillStyle = 'rgba(255,254,250,.96)';
    ctx.fillRect(G.L + 2, y0 + 2, tw, 23);
    ctx.fillStyle = COLS.info;
    ctx.textAlign = 'left';
    ctx.fillText(title, G.L + 5, y0 + 11);
    ctx.fillStyle = COLS.ink4;
    ctx.font = '8px ui-monospace, monospace';
    ctx.fillText('单通道 |z| 只在关闭工况感知时作为朴素阈值对照', G.L + 5, y0 + 21);

    var leg = '｜关注 ' + g.toFixed(1) + ' · 预警 ' + (g + 0.5).toFixed(1) + ' · 报警 ' + (g + 1.0).toFixed(1);
    ctx.font = '8px ui-monospace, monospace';
    var lw2 = ctx.measureText(leg).width + 10;
    ctx.fillStyle = 'rgba(255,254,250,.96)';
    ctx.fillRect(G.L + tw + 10, y0 + 2, lw2, 12);
    ctx.fillStyle = COLS.ink3;
    ctx.textAlign = 'left';
    ctx.fillText(leg, G.L + tw + 15, y0 + 10);
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
      var vals = DATA[k], base = A.base[k], sig = A.sig[k];
      var lo = minOf(vals), hi = maxOf(vals);
      var pad = (hi - lo) * pads || 1;
      lo -= pad; hi += pad;
      var sy = function (v) { return y0 + (1 - (v - lo) / (hi - lo)) * h; };
      var nVis = Math.min(N, Math.floor(vis / DT) + 1);
      var step = Math.max(1, Math.floor(nVis / (G.plotW * 1.2)));

      /* 灰带 = 基线 ±2σ（与 z 使用同一个 σ） */
      ctx.beginPath();
      for (var i = 0; i < nVis; i += step) {
        var bx = G.sx(i * DT), by = sy(base[i] + 2 * sig[i]);
        if (i === 0) ctx.moveTo(bx, by); else ctx.lineTo(bx, by);
      }
      for (var j = Math.min(nVis - 1, Math.floor((vis) / DT)); j >= 0; j -= step) {
        ctx.lineTo(G.sx(j * DT), sy(base[j] - 2 * sig[j]));
      }
      ctx.closePath();
      ctx.fillStyle = COLS.band;
      ctx.fill();

      /* 基线中心线 */
      ctx.beginPath();
      for (var i2 = 0; i2 < nVis; i2 += step) {
        var cx = G.sx(i2 * DT), cy = sy(base[i2]);
        if (i2 === 0) ctx.moveTo(cx, cy); else ctx.lineTo(cx, cy);
      }
      ctx.strokeStyle = 'rgba(150,145,130,.85)';
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 0.8;
      ctx.stroke();
      ctx.setLineDash([]);

      /* 实测曲线 */
      ctx.beginPath();
      for (var i3 = 0; i3 < nVis; i3 += step) {
        var px = G.sx(i3 * DT), py = sy(vals[i3]);
        if (i3 === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = c.color;
      ctx.lineWidth = 1.15;
      ctx.stroke();
      ctx.lineWidth = 1;

      /* 量程标签 */
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
      ctx.fillStyle = zColor(A.risk[i].maxAbs);
      ctx.fillRect(x, y, w, G.stripH);
    }
    ctx.strokeStyle = COLS.line2;
    ctx.strokeRect(G.L, y, G.plotW, G.stripH);

    ctx.fillStyle = COLS.ink3;
    ctx.font = '8.5px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText('门限 ' + gate().toFixed(1) + 'σ · 持续 ≥ ' + state.run + ' 点（' + (state.run * 2) + ' s）· 报警 z≥' + (gate() + 1).toFixed(1) + ' 且 ≥60 s', G.L, y - 5);

    /* 1/2/3/4σ 色标：放在热条上方的空白带，避免压在色块上 */
    var lw = 154, lx = Wc - G.R - lw;
    ctx.fillStyle = 'rgba(255,254,250,.96)';
    ctx.fillRect(lx - 4, y - 15, lw + 4, 13);
    ctx.font = '7.5px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = COLS.ink4;
    ctx.fillText('|z|max', lx, y - 6);
    [1, 2, 3, 4].forEach(function (v, i) {
      var xx = lx + 32 + i * 27;
      ctx.fillStyle = zColor(v);
      ctx.fillRect(xx, y - 13, 7, 7);
      ctx.fillStyle = COLS.ink4;
      ctx.fillText(v + 'σ', xx + 9, y - 6);
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
    /* 真值：前兆起点（虚线）+ 发生时刻（实线） */
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

    /* episode 起点竖线（只标起点，不重复标每个短段） */
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

    /* 顶部标签避让：3 条 lane，先放真值，再放 episode 起点 */
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

    var lanes = [[], [], []];
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
      var ly = 11 + lb.lane * 14;
      ctx.fillStyle = 'rgba(255,254,250,.92)';
      var w2 = ctx.measureText(lb.text).width + 8;
      ctx.fillRect(lb.x + 2, ly - 8, w2, 11);
      ctx.fillStyle = lb.color;
      ctx.textAlign = 'left';
      ctx.fillText(lb.text, lb.x + 4, ly);
    });

    /* 提前量 bracket：报警起点 → 真值发生时刻 */
    A.events.forEach(function (evr) {
      if (!evr.episode) return;
      if (evr.episode.t0 > vis) return;
      var xa = G.sx(evr.episode.t0), xe = G.sx(evr.ev.t);
      var yb = 51;
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
    var lines = ['t = ' + h.t.toFixed(2) + ' min'];
    CH.forEach(function (c) {
      lines.push(c.name + ' ' + DATA[c.key][idx].toFixed(c.dec) + ' ' + c.unit + '  z=' + (A.z[c.key][idx] >= 0 ? '+' : '') + A.z[c.key][idx].toFixed(2));
    });
    var rr = A.risk[idx];
    lines.push(rr.score > 0 ? '联合：' + RULENAME[rr.rule] + ' ' + rr.score.toFixed(2) + 'σ' : '联合：未触发');

    var bw = 206, bh = 13 * lines.length + 12;
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
      ctx.fillStyle = li === 0 ? COLS.ink3 : li === lines.length - 1 ? COLS.info : COLS.ink3;
      ctx.fillText(ln, bx + 7, by + 13 + li * 12.5);
    });
  }

  function draw() {
    if (!A) return;
    layout();
    if (!Wc) return;
    ctx.clearRect(0, 0, Wc, Hc);
    var vis = state.cursor;
    drawRisk(A, vis);
    PANELS.forEach(function (p, pi) { drawPanel(p, pi, vis); });
    drawStrip(vis);
    drawTimeAxis();
    drawTruthAndLabels(vis);
    drawCursor();
    drawHover();
  }

  /* ---------- DOM ---------- */
  var el = function (id) { return document.getElementById(id); };
  var READ = {};
  var lastVisibleCount = -1;

  function buildReads() {
    el('zs').innerHTML = CH.map(function (c) {
      return '<div class="r" data-k="' + c.key + '">' +
        '<span class="nm">' + c.name + '<small>' + c.unit + '</small></span>' +
        '<span class="bar"><i></i></span>' +
        '<span class="val">—</span><span class="z">—</span></div>';
    }).join('');
    CH.forEach(function (c) {
      var row = el('zs').querySelector('[data-k="' + c.key + '"]');
      READ[c.key] = { bar: row.querySelector('.bar i'), val: row.querySelector('.val'), z: row.querySelector('.z') };
    });
  }

  function buildRules() {
    el('rules').innerHTML = [
      '<div class="rule" data-rule="stuck"><div class="hd"><b>卡管柱前兆</b><span class="sc">—</span></div>' +
        '<div class="cond"><span class="c" data-c="0">扭矩 z ≥ +1.2</span><span class="c" data-c="1">悬重 z ≤ −1.2</span></div>' +
        '<div class="a">联合得分 = min(z扭矩, −z悬重)</div></div>',
      '<div class="rule" data-rule="loss"><div class="hd"><b>漏失</b><span class="sc">—</span></div>' +
        '<div class="cond"><span class="c" data-c="0">立压 z ≤ −1.2</span><span class="c" data-c="1">返出/池体 z ≤ −1.2</span></div>' +
        '<div class="a">泵压↓ 且 返出↓/池体积↓ 的联合模式</div></div>',
      '<div class="rule" data-rule="kick"><div class="hd"><b>井涌 / 气侵</b><span class="sc">—</span></div>' +
        '<div class="cond"><span class="c" data-c="0">套压 z ≥ +1.2</span><span class="c" data-c="1">返出/池体 z ≥ +1.2</span></div>' +
        '<div class="a">套压↑ 且 返出↑/池体积↑ 的联合模式</div></div>'
    ].join('');
  }

  function updateReads(idx) {
    CH.forEach(function (c) {
      var v = DATA[c.key][idx];
      var z = A.z[c.key][idx];
      var row = READ[c.key];
      row.val.textContent = v.toFixed(c.dec);
      row.z.textContent = (z >= 0 ? '+' : '') + z.toFixed(2);
      row.z.style.color = zTextColor(z);
      row.bar.style.width = Math.min(100, Math.abs(z) / 4 * 100).toFixed(1) + '%';
      row.bar.style.background = zTextColor(z);
    });
  }

  function updateRules(idx) {
    var z = {};
    CH.forEach(function (c) { z[c.key] = A.z[c.key][idx]; });
    var states = {
      stuck: [z.tor >= 1.2, z.hook <= -1.2, Math.min(z.tor, -z.hook)],
      loss: [z.spp <= -1.2, Math.max(-z.flow, -z.pit) >= 1.2, Math.min(-z.spp, Math.max(-z.flow, -z.pit))],
      kick: [z.casing >= 1.2, Math.max(z.flow, z.pit) >= 1.2, Math.min(z.casing, Math.max(z.flow, z.pit))]
    };
    ['stuck', 'loss', 'kick'].forEach(function (k) {
      var row = el('rules').querySelector('[data-rule="' + k + '"]');
      var st = states[k];
      row.querySelector('[data-c="0"]').classList.toggle('on', st[0]);
      row.querySelector('[data-c="1"]').classList.toggle('on', st[1]);
      var sc = row.querySelector('.sc');
      var on = st[0] && st[1];
      sc.textContent = on ? ('得分 ' + st[2].toFixed(2) + 'σ') : '未触发';
      sc.style.color = on ? (st[2] >= gate() + 1 ? COLS.bad : st[2] >= gate() ? COLS.warn : COLS.info) : COLS.ink4;
    });
  }

  function episodeAdvice(ep) {
    if (ep.rule === 'stuck') return '建议：上提下放活动管柱、保持循环，控制扭矩与泵压；必要时震击解卡，严禁硬转。';
    if (ep.rule === 'loss') return '建议：核对返出与池体积，降排量观察，检查泵阀与管柱漏点；按井控程序补充压井液。';
    if (ep.rule === 'kick') return '建议：关井求压，核对套压/立压与池体积增量，按井控程序循环排气。';
    return '单通道偏离尚未形成联合模式：先核对传感器与当前工序，再决定是否处置。';
  }

  function buildAlarms() {
    var vis = A.episodes.filter(function (ep) { return ep.t0 <= state.cursor; });
    lastVisibleCount = vis.length;
    if (!vis.length) {
      el('alarms').innerHTML = '<p class="empty">还没有报警。播放或拖动时间轴到 25 min 之后。</p>';
      return;
    }
    el('alarms').innerHTML = vis.map(function (ep, i) {
      var lvCls = ep.level === 3 ? 'bad' : ep.level === 2 ? 'warn' : 'info';
      var evTxt = ep.event
        ? '对应真值事件 #' + (ep.eventIndex + 1) + '（' + ep.event.name + ' ' + ep.event.t.toFixed(1) + '′），提前 ' + ep.lead.toFixed(1) + ' min。'
        : ep.joint
          ? '未计入有效检出（非目标事件，或提前量不足 2 min / 未到预警级），需人工确认。'
          : '单通道偏离，未形成联合模式（误报/待确认）。';
      return '<div class="alarm lv' + ep.level + '">' +
        '<span class="t">' + ep.t0.toFixed(1) + '′</span>' +
        '<div><b>episode ' + (i + 1) + ' · ' + LV[ep.level] + ' · ' + RULENAME[ep.rule] + '</b>' +
        '<div class="a">' + ep.t0.toFixed(1) + '–' + ep.t1.toFixed(1) + ' min，峰值 z = ' + ep.peak.toFixed(2) +
        '，持续 ' + ep.dur.toFixed(0) + ' s，重复 ' + ep.segs + ' 段（已合并）。' + evTxt + '<br>' + episodeAdvice(ep) + '</div></div>' +
        '<span class="db ' + lvCls + '">' + LV[ep.level] + '</span></div>';
    }).join('');
  }

  function buildPhases() {
    el('phases').innerHTML = PHASES.map(function (p) {
      return '<div class="row"><span class="tm">' + p.t0 + '–' + p.t1 + ' min</span>' +
        '<span><b>' + p.name + '</b><span class="sub"> · ' + p.sub + '</span></span></div>';
    }).join('') +
      '<div class="row"><span class="tm">已知扰动</span><span class="sub">起停泵冲击（边界 ±0.4 min）、活动管柱周期性悬重波动、压井套压计划内下降</span></div>' +
      EVENTS.map(function (ev, i) {
        return '<div class="row"><span class="tm">事件 ' + (i + 1) + '</span><span><b>' + ev.name + '</b><span class="sub"> · ' + ev.tPre.toFixed(1) +
          ' min 前兆 → ' + ev.t.toFixed(1) + ' min 发生（' + ev.desc + '）</span></span></div>';
      }).join('');
  }

  function leadNow() {
    var leads = A.events.filter(function (e) { return e.episode && e.episode.t0 <= state.cursor; })
      .map(function (e) { return e.lead; });
    if (!leads.length) return null;
    leads.sort(function (a, b) { return a - b; });
    var m = Math.floor(leads.length / 2);
    return leads.length % 2 ? leads[m] : (leads[m - 1] + leads[m]) / 2;
  }

  function setCard(id, cls) {
    var n = el(id);
    if (!n) return;
    n.className = 'dstat' + (cls ? ' ' + cls : '');
  }

  function updateStats(idx) {
    var risk = A.risk[idx];
    var g = gate();
    setCard('card-risk', risk.score >= g + 1 ? 'bad' : risk.score >= g + 0.5 ? 'warn' : risk.score >= g ? 'info' : '');
    el('st-risk').textContent = risk.score.toFixed(2);

    var visEps = A.episodes.filter(function (ep) { return ep.t0 <= state.cursor; });
    var visFp = visEps.filter(function (ep) { return !ep.event; });
    el('st-n').textContent = visEps.length;
    el('st-fp').textContent = ' · 误报 ' + visFp.length;
    setCard('card-eps', visFp.length ? 'bad' : '');

    el('st-det').textContent = A.detected + '/' + EVENTS.length;
    el('st-miss').textContent = ' · 漏报 ' + A.missed;
    /* 还没有可见报警时不要用绿色，避免“无报警=好”的误导 */
    setCard('card-det', A.missed ? 'bad' : (A.detected && visEps.length ? 'good' : ''));

    var lead = leadNow();
    el('st-lead').textContent = lead === null ? '—' : lead.toFixed(1);
    setCard('card-lead', lead === null ? '' : 'info');

    /* 右侧图例跟随滑杆，避免和图表里的三级阈值矛盾 */
    el('lg-n').textContent = '正常 <' + g.toFixed(1) + 'σ';
    el('lg-1').textContent = '关注 ≥' + g.toFixed(1) + 'σ';
    el('lg-2').textContent = '预警 ≥' + (g + 0.5).toFixed(1) + 'σ';
    el('lg-3').textContent = '报警 ≥' + (g + 1.0).toFixed(1) + 'σ 且 ≥60 s';

    if (visEps.length !== lastVisibleCount) buildAlarms();

    el('time-hint').textContent = 't = ' + state.cursor.toFixed(1) + ' min · 2 s/点';
    var scr = el('scrub');
    if (document.activeElement !== scr) scr.value = state.cursor.toFixed(1);
    scr.setAttribute('aria-valuetext', state.cursor.toFixed(1) + ' 分钟');
  }

  function dynamic() {
    var idx = Math.max(0, Math.min(N - 1, Math.round(state.cursor / DT)));
    updateReads(idx);
    updateRules(idx);
    updateStats(idx);
    draw();
  }

  function noteText() {
    var base = state.phaseAware
      ? '工序顺序：<b>压井/井控（0–8）→ 起原井管柱（8–16）→ 通井/打印（16–24）→ 磨铣/打捞（24–30）→ 停钻/活动管柱（30–36）→ 震击解卡（36–42）→ 循环洗井（42–50）→ 完井试压（50–60）</b>。卡管柱后没有继续按原计划直接循环，而是插入停钻/活动管柱/震击解卡段。每工序跳过 24 s 边界冲击后，用 90 s 窗口做热启动（不检测），末端 30 s 为切换缓冲；灰带与 z 使用同一个 σ。主报警只来自<b>联合判据</b>：卡管柱 = 扭矩↑ 且 悬重↓；漏失 = 立压↓ 且 返出/池体积↓。检出按「联合判据达到预警级（≥阈值）且提前 ≥2 min」计，单通道 |z| 只在关闭工况感知时作为朴素阈值对照。<br>本参数下：检出 <b>' + A.detected + '/' + EVENTS.length + '</b>，漏报 <b>' + A.missed + '</b>，误报 <b>' + A.falseCount + '</b> 个 episode，中位提前量 <b>' + (A.leadMedian === null ? '—' : A.leadMedian.toFixed(1) + ' min') + '</b>。'
      : '注意：<b>工况感知已关闭</b>——基线不再按工序重启，8/16/24/30/36/42/50 min 的工序切换被当成异常，于是产生 <b>' + A.episodes.length + '</b> 个 episode。但联合判据全场只检出 <b>' + A.detected + '/' + EVENTS.length + '</b>、漏报 <b>' + A.missed + '</b>：报警变多并不等于变好，多出来的都是切换误报，真正的卡管柱前兆与漏失反而被过大的 σ 掩盖。';
    if (state.thr <= 2.0) base += '<br>当前阈值偏低（关注门限 ' + gate().toFixed(1) + 'σ）：关注级会更早出现、提前量略增，但工序边界短抖动也更容易被纳入关注；现场仍需人工确认。';
    if (state.thr >= 3.2) base += '<br>当前阈值偏高（关注门限 ' + gate().toFixed(1) + 'σ）：提前量被压缩；漏失这类缓变异常的单点分数不高，不能只靠抬高阈值来压误报。';
    return base;
  }

  function renderAll(resetCursor) {
    A = analyze();
    if (resetCursor) state.cursor = 0;
    lastVisibleCount = -1;
    buildAlarms();
    dynamic();
    el('note').innerHTML = noteText();
  }

  /* ---------- 控件 ---------- */
  var rThr = el('r-thr'), rRun = el('r-run'), scr = el('scrub');
  rThr.addEventListener('input', function () {
    state.thr = Number(rThr.value);
    el('o-thr').textContent = state.thr.toFixed(1) + ' σ';
    renderAll(false);
  });
  rRun.addEventListener('input', function () {
    state.run = Number(rRun.value);
    el('o-run').textContent = state.run + ' 点 / ' + (state.run * 2) + ' s';
    renderAll(false);
  });

  var chkPhase = el('chk-phase');
  var togPhase = el('tog-phase');
  chkPhase.addEventListener('change', function () {
    state.phaseAware = chkPhase.checked;
    togPhase.classList.toggle('on', state.phaseAware);
    renderAll(false);
  });

  scr.addEventListener('input', function () {
    if (state.playing) pause();
    state.cursor = Number(scr.value);
    dynamic();
  });

  var timer = null;
  function pause() {
    if (timer) { clearInterval(timer); timer = null; }
    state.playing = false;
    el('play').textContent = '▶ 播放作业过程';
    el('play').setAttribute('aria-pressed', 'false');
  }
  function play() {
    if (state.playing) { pause(); return; }
    if (state.cursor >= DUR) state.cursor = 0;
    state.playing = true;
    el('play').textContent = '❚❚ 暂停';
    el('play').setAttribute('aria-pressed', 'true');
    timer = setInterval(function () {
      state.cursor = Math.min(DUR, state.cursor + 0.06 * state.speed);   /* 1× ≈ 30 s 播完 */
      if (state.cursor >= DUR) { state.cursor = DUR; dynamic(); pause(); return; }
      dynamic();
    }, 30);
  }
  el('play').addEventListener('click', play);
  el('reset').addEventListener('click', function () {
    pause();
    state.cursor = 0;
    state.hover = null;
    dynamic();
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

  /* hover 十字线：只重绘画布，不改右栏 DOM */
  cv.addEventListener('mousemove', function (e) {
    var r = cv.getBoundingClientRect();
    var x = e.clientX - r.left, y = e.clientY - r.top;
    if (x < G.L || x > Wc - G.R || y < G.top || y > G.stripY + G.stripH) { state.hover = null; draw(); return; }
    state.hover = { t: Math.max(0, Math.min(DUR, G.tx(x))), x: x, y: y };
    draw();
  });
  cv.addEventListener('mouseleave', function () { state.hover = null; draw(); });

  /* 尺寸变化重绘 */
  function resize() { layout(); draw(); }
  if (window.ResizeObserver) {
    new ResizeObserver(function () { resize(); }).observe(cv);
  }
  window.addEventListener('resize', resize);

  /* 初始化 */
  buildReads();
  buildRules();
  buildPhases();
  renderAll(true);

  window.__demo = {
    state: state,
    analyze: analyze,
    data: DATA,
    getA: function () { return A; },
    renderNow: function () { renderAll(false); },
    setCursor: function (t) { state.cursor = t; dynamic(); }
  };
})();
