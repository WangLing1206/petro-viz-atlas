/* =========================================================
   气测异常智能解释 · 可运行示范
   ---------------------------------------------------------
   ① 合成 3000—4200 m 气测资料：全烃 + C1—C5 组分 + 钻时，
      埋入 气层 / 油层 / 薄油层 / 水层 四个显示段，
      叠加背景气漂移、接单根窄峰与仪器噪声
   ② 基线校正：滑动分位数（可切 滑动均值 / 不校正）
   ③ 异常段检测：峰高判据 k·σ（σ 用 MAD 估计）+ 持续长度判据
   ④ 段内组分比（峰区加权中位数）→ Pixler 双对数图版判别
   ⑤ 与合成真值对照：层段命中率、误报段数
   纯前端、不联网、不依赖第三方库。
   ========================================================= */
(function () {
  'use strict';

  var el = function (id) { return document.getElementById(id); };

  /* ---------------- 1. 合成数据 ---------------- */
  var NZ = 480, D0 = 3000, DZ = 2.5, DEPTH = NZ * DZ;   /* 2.5 m 一点 */
  var NOISE_AMP = 0.10;

  function mkRnd(seed) {
    var a = seed;
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  var R = mkRnd(20261023), NOISE = [], SPR = [], i0;
  for (i0 = 0; i0 < NZ; i0++) NOISE.push((R() + R() + R() - 1.5) * 1.3);
  for (i0 = 0; i0 < NZ; i0++) SPR.push(R());

  function norm(v) {
    var s = 0, i;
    for (i = 0; i < v.length; i++) s += v[i];
    return v.map(function (x) { return x / s; });
  }

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
    { key: 'normal', name: '正常钻进', bgA: 0.30, bgB: 0.42, spikeA: 0.62, spikeN: 14, gain: 1.00 },
    { key: 'heavy', name: '加重钻井液', bgA: 0.20, bgB: 0.30, spikeA: 0.40, spikeN: 14, gain: 0.62 },
    { key: 'conn', name: '接单根频繁', bgA: 0.40, bgB: 0.55, spikeA: 0.75, spikeN: 11, gain: 1.00 }
  ];
  function modeOf(k) { for (var i = 0; i < MODES.length; i++) if (MODES[i].key === k) return MODES[i]; return MODES[0]; }

  var BASEM = [
    { key: 'quantile', name: '滑动分位数' },
    { key: 'mean', name: '滑动均值' },
    { key: 'none', name: '不校正' }
  ];

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

  /* ---------------- 2. 统计小工具 ---------------- */
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
  function wmed(V, k) {   /* 加权中位数 */
    if (!V.length) return 0;
    var s = V.slice().sort(function (x, y) { return x[k] - y[k]; });
    var tot = 0, half = 0, i;
    for (i = 0; i < s.length; i++) tot += s[i].w;
    for (i = 0; i < s.length; i++) { half += s[i].w; if (half >= tot * 0.5) return s[i][k]; }
    return s[s.length - 1][k];
  }

  /* ---------------- 3. 基线校正 ---------------- */
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

  /* ---------------- 4. Pixler 图版分区（log10 空间） ---------------- */
  var PX = { xmin: 1.5, xmax: 300, ymin: 1.5, ymax: 1000 };
  var L = 42, R = 326, T = 18, B = 250;          /* 图版绘图区（全局唯一，drawPixler 内使用） */
  var lx0 = Math.log10(PX.xmin), lx1 = Math.log10(PX.xmax);
  var ly0 = Math.log10(PX.ymin), ly1 = Math.log10(PX.ymax);
  function lxPix(l) { return L + (l - lx0) / (lx1 - lx0) * (R - L); }
  function lyPix(l) { return B - (l - ly0) / (ly1 - ly0) * (B - T); }
  function xPix(v) { return lxPix(Math.log10(Math.max(PX.xmin, Math.min(PX.xmax, v)))); }
  function yPix(v) { return lyPix(Math.log10(Math.max(PX.ymin, Math.min(PX.ymax, v)))); }
  /* 简化 Pixler 分区：横轴 C1/C2、纵轴 C1/C3 两个比值同时参与。
     真实 Pixler 图版是多边形分区，这里用三段折线近似，并在页面上标明。 */
  var PXB = { oilY: 1.20, oilX: 1.05, wetX: 1.85, gasTop: 2.35, gasX: 1.45, oilTop: 2.00 };
  function classify(r12, r13) {
    var x = Math.log10(Math.max(1e-6, r12)), y = Math.log10(Math.max(1e-6, r13));
    if (x < lx0 || x > lx1 || y < ly0 || y > ly1) return 'none';
    if (x >= PXB.wetX || (x >= PXB.gasX && y >= PXB.gasTop)) return 'water';
    if (y <= PXB.oilY || (x <= PXB.oilX && y <= PXB.oilTop)) return 'oil';
    return 'gas';
  }
  var CONCL = {
    gas: { name: '气层', line: '#123b3a', fill: 'rgba(18,59,58,.10)', badge: 'ok' },
    oil: { name: '油层', line: '#a86a1f', fill: 'rgba(168,106,31,.12)', badge: 'warn' },
    water: { name: '水层', line: '#2b5570', fill: 'rgba(43,85,112,.11)', badge: 'plain' },
    bg: { name: '背景气', line: '#6f6636', fill: 'rgba(111,102,54,.10)', badge: 'plain' },
    none: { name: '待复核', line: '#98a199', fill: 'rgba(152,161,153,.14)', badge: 'bad' }
  };

  /* ---------------- 5. 检测与判别 ---------------- */
  function analyze(D, opt) {
    var base = baselineOf(D.total, opt.win, opt.q, opt.method);
    var corr = D.total.map(function (v, i) { return Math.max(0, v - base[i]); });
    /* σ 用高通残差估计（与基线窗口/分位数解耦）：
       取每点与前后各 2 点中位数之差，再做 MAD。改基线参数不会把
       “噪声尺度”一起改掉，阈值才可比较。 */
    var hp = [];
    for (var ih = 0; ih < NZ; ih++) {
      var win = D.total.slice(Math.max(0, ih - 2), Math.min(NZ, ih + 3));
      hp.push(D.total[ih] - quant(win, 0.5));
    }
    var sd = Math.max(0.05, mad(hp));
    var thr = Math.max(0.10, opt.k * sd);

    /* 背景气组成：全烃最低 30% 点的组分/全烃比值中位数（从数据里估，不用真值） */
    var idx = D.total.map(function (v, i) { return i; }).sort(function (a, b) { return D.total[a] - D.total[b]; });
    var lowN = Math.max(8, Math.round(NZ * 0.3));
    var bf = [0, 1, 2, 3, 4].map(function (j) {
      var a = idx.slice(0, lowN).map(function (i) { return D.comp[j][i] / Math.max(1e-6, D.total[i]); }).sort(function (x, y) { return x - y; });
      return a[Math.floor(a.length / 2)];
    });

    /* 峰高 + 持续长度双判据 */
    var runs = [], i = 0;
    while (i < NZ) {
      if (corr[i] > thr) {
        var s = i, peak = 0;
        while (i < NZ && corr[i] > thr) { if (corr[i] > peak) peak = corr[i]; i++; }
        runs.push({ s: s, e: i - 1, peak: peak, n: i - s });
      } else i++;
    }
    var segs = [];
    runs.filter(function (r) { return r.n >= opt.minLen; }).forEach(function (r) {
      var last = segs[segs.length - 1];
      if (last && r.s - last.e - 1 <= 1) { last.e = r.e; last.peak = Math.max(last.peak, r.peak); }
      else segs.push({ s: r.s, e: r.e, peak: r.peak });
    });

    /* 组分比：峰区（校正值 ≥ 峰值一半）加权中位数 */
    segs.forEach(function (sg) {
      var sum = [0, 0, 0, 0, 0], V = [];
      for (var i2 = sg.s; i2 <= sg.e; i2++) {
        var w = corr[i2];
        if (w <= 0) continue;
        var cc = [];
        for (var j = 0; j < 5; j++) cc.push(Math.max(0, D.comp[j][i2] - bf[j] * base[i2]));
        sum = sum.map(function (v, j) { return v + w * cc[j]; });
        if (corr[i2] >= 0.5 * sg.peak && cc[1] > 0.002 && cc[2] > 0.0004) {
          V.push({ w: w, a: cc[0] / cc[1], b: cc[0] / cc[2] });
        }
      }
      sg.d0 = D0 + sg.s * DZ;
      sg.d1 = D0 + (sg.e + 1) * DZ;
      sg.len = sg.d1 - sg.d0;
      sg.ratio12 = wmed(V, 'a') || Math.max(1.5, sum[0] / Math.max(1e-6, sum[1]));
      sg.ratio13 = wmed(V, 'b') || Math.max(1.5, sum[0] / Math.max(1e-6, sum[2]));
      sg.c1 = sum[0] / Math.max(1e-6, (sg.e - sg.s + 1));
      sg.concl = classify(sg.ratio12, sg.ratio13);
      /* 绝对幅度门限：背景气本身也落在气区，不能只靠比值。
         峰值 < 0.45%，或峰值很小且比值像背景气时，判“背景气/无显示”。 */
      if (sg.peak < 0.45) sg.concl = 'bg';
      else if (sg.peak < 0.85 && sg.ratio12 > 18 && sg.ratio12 < 60 && sg.ratio13 > 80 && sg.ratio13 < 320) sg.concl = 'bg';
      /* 绝对幅度门限：背景气（贫气）本身也落在气区，不能只靠比值。
         峰值 < 0.45% 且比值像背景气时判“背景气/无显示”。 */
      if (sg.peak < 0.45) sg.concl = 'bg';
      else if (sg.peak < 0.85 && sg.ratio12 > 18 && sg.ratio12 < 60 && sg.ratio13 > 80 && sg.ratio13 < 320) sg.concl = 'bg';
      /* 置信度：到分区中心的对数距离 + 幅度因子 */
      var x = Math.log10(Math.max(1e-6, sg.ratio12));
      var cxc, hw;
      if (sg.concl === 'oil') { cxc = (lx0 + PXB.oilX) / 2; hw = Math.max(0.05, (PXB.oilX - lx0) / 2); }
      else if (sg.concl === 'gas') { cxc = (PXB.oilX + PXB.wetX) / 2; hw = Math.max(0.05, (PXB.wetX - PXB.oilX) / 2); }
      else if (sg.concl === 'water') { cxc = (PXB.wetX + lx1) / 2; hw = Math.max(0.05, (lx1 - PXB.wetX) / 2); }
      else { cxc = 1.4; hw = 0.4; }
      var dd = Math.min(1, Math.abs(x - cxc) / hw);
      var ampF = Math.max(0.75, Math.min(1, sg.peak / 1.2));
      sg.conf = (sg.concl === 'none' || sg.concl === 'bg') ? 0.45 : Math.max(0.52, Math.min(0.97, (0.62 + 0.36 * (1 - dd)) * ampF));
    });
    return { base: base, corr: corr, sd: sd, thr: thr, segs: segs, bf: bf };
  }

  function score(segs) {
    var matched = 0, conclOk = 0, missed = [];
    LAYERS.forEach(function (z) {
      var best = null, bestOv = 0;
      segs.forEach(function (s) {
        var ov = Math.max(0, Math.min(s.d1, z.d1) - Math.max(s.d0, z.d0));
        if (ov > bestOv) { bestOv = ov; best = s; }
      });
      /* 必须覆盖该层 30% 以上，且不能是一个“包住整口井”的巨段 */
      var ok = best && bestOv >= 0.3 * (z.d1 - z.d0) && best.len <= 2.5 * (z.d1 - z.d0);
      if (ok) {
        matched++;
        var want = z.key === 'thin' ? 'oil' : z.key;
        if (best.concl === want) conclOk++;
      } else missed.push(z);
    });
    var fp = segs.filter(function (s) {
      if (s.concl === 'bg') return false;
      return !LAYERS.some(function (z) {
        var ov = Math.max(0, Math.min(s.d1, z.d1) - Math.max(s.d0, z.d0));
        return ov >= 0.3 * (z.d1 - z.d0) && s.len <= 2.5 * (z.d1 - z.d0);
      });
    });
    var bg = segs.filter(function (s) { return s.concl === 'bg'; }).length;
    return { matched: matched, conclOk: conclOk, missed: missed, fp: fp, bg: bg };
  }

  /* ---------------- 6. 状态与控件 ---------------- */
  var state = { mode: 'normal', method: 'quantile', k: 3, minLen: 3, win: 40, q: 0.20, spikes: true, comp: true, sel: 0 };

  el('seg-mode').innerHTML = MODES.map(function (m) {
    return '<button data-c="ts" data-m="' + m.key + '" class="' + (m.key === state.mode ? 'on' : '') + '">' + m.name + '</button>';
  }).join('');
  el('seg-base').innerHTML = BASEM.map(function (m) {
    return '<button data-m="' + m.key + '" class="' + (m.key === state.method ? 'on' : '') + '">' + m.name + '</button>';
  }).join('');
  el('seg-mode').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    state.mode = b.getAttribute('data-m');
    [].forEach.call(el('seg-mode').children, function (x) { x.classList.toggle('on', x === b); });
    render();
  });
  el('seg-base').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    state.method = b.getAttribute('data-m');
    [].forEach.call(el('seg-base').children, function (x) { x.classList.toggle('on', x === b); });
    render();
  });
  var rK = el('r-k'), rLen = el('r-len'), rWin = el('r-win'), rQ = el('r-q');
  rK.addEventListener('input', function () { state.k = Number(rK.value); el('o-k').textContent = state.k.toFixed(1) + ' σ'; render(); });
  rLen.addEventListener('input', function () { state.minLen = Number(rLen.value); el('o-len').textContent = state.minLen + ' 点'; render(); });
  rWin.addEventListener('input', function () { state.win = Number(rWin.value); el('o-win').textContent = state.win + ' 点'; render(); });
  rQ.addEventListener('input', function () { state.q = Number(rQ.value) / 100; el('o-q').textContent = rQ.value + '%'; render(); });
  var togSpk = el('tog-spk'), togComp = el('tog-comp');
  [togSpk, togComp].forEach(function (t) { t.setAttribute('role', 'switch'); t.setAttribute('aria-checked', 'true'); t.setAttribute('tabindex', '0'); });
  function flip(t) { var on = t.classList.toggle('on'); t.setAttribute('aria-checked', on ? 'true' : 'false'); return on; }
  togSpk.addEventListener('click', function () { state.spikes = flip(togSpk); render(); });
  togComp.addEventListener('click', function () { state.comp = flip(togComp); render(); });
  [togSpk, togComp].forEach(function (t) {
    t.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); t.click(); } });
  });

  /* 基线方法不用的滑杆置灰，避免“拖了没反应” */
  function syncCtrl() {
    rQ.disabled = state.method !== 'quantile';
    rWin.disabled = state.method === 'none';
    rQ.style.opacity = state.method !== 'quantile' ? '.4' : '';
    rWin.style.opacity = state.method === 'none' ? '.4' : '';
  }

  var reset = el('btn-reset');
  if (reset) reset.addEventListener('click', function () {
    state.mode = 'normal'; state.method = 'quantile'; state.k = 3; state.minLen = 3;
    state.win = 40; state.q = 0.20; state.spikes = true; state.comp = true; state.sel = 0;
    rK.value = '3'; el('o-k').textContent = '3.0 σ';
    rLen.value = '3'; el('o-len').textContent = '3 点';
    rWin.value = '40'; el('o-win').textContent = '40 点';
    rQ.value = '20'; el('o-q').textContent = '20%';
    togSpk.classList.add('on'); togComp.classList.add('on');
    togSpk.setAttribute('aria-checked', 'true'); togComp.setAttribute('aria-checked', 'true');
    [].forEach.call(el('seg-mode').children, function (x) { x.classList.toggle('on', x.getAttribute('data-m') === 'normal'); });
    [].forEach.call(el('seg-base').children, function (x) { x.classList.toggle('on', x.getAttribute('data-m') === 'quantile'); });
    render();
  });

  /* ---------------- 7. 绘制：主曲线图 ---------------- */
  var cv = el('log'), ctx = cv.getContext('2d');
  var cmpCv = el('cmp'), cctx = cmpCv.getContext('2d');
  var DPR = Math.min(2, window.devicePixelRatio || 1), Hc = 470, Hc2 = 300;
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
    G.sy3 = function (d) { return G.T + (d - D0) / DEPTH * G.plotH; };
    G.dy = function (y) { return D0 + (y - G.T) / G.plotH * DEPTH; };
    G.sx1 = function (v) { return G.x1 + Math.min(1, Math.max(0, v / G.maxT)) * G.w1; };
    G.sx2 = function (v) {
      var l = Math.log10(Math.max(0.003, v));
      return G.x2 + Math.min(1, Math.max(0, (l - G.lg0) / (G.lg1 - G.lg0))) * G.w2;
    };
    G.sx3 = function (v) { return G.x3 + Math.min(1, Math.max(0, (v - 2.5) / 8.5)) * G.w3; };
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

    /* 组分轨对数网格 */
    ctx.strokeStyle = '#f0ede4';
    ctx.lineWidth = 1;
    [0.01, 0.1, 1].forEach(function (v) {
      var x = G.sx2(v);
      ctx.beginPath(); ctx.moveTo(x, G.T); ctx.lineTo(x, G.T + G.plotH); ctx.stroke();
      ctx.fillStyle = '#cdd8e2';
      ctx.textAlign = 'center';
      ctx.font = '8.5px ui-monospace, monospace';
      ctx.fillText(v < 1 ? String(v) : String(v), x, Hc - G.B + 12);
    });
    /* 钻时轴刻度 */
    [5, 8, 11].forEach(function (v) {
      var x = G.sx3(v);
      ctx.strokeStyle = '#efe9dd';
      ctx.beginPath(); ctx.moveTo(x, G.T); ctx.lineTo(x, G.T + G.plotH); ctx.stroke();
      ctx.fillStyle = '#cdd8e2';
      ctx.textAlign = 'center';
      ctx.font = '8.5px ui-monospace, monospace';
      ctx.fillText(String(v), x, Hc - G.B + 12);
    });
    /* 全烃轴刻度 */
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
    /* 深度刻度 */
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
    ctx.fillText('深度 m', 4, G.T + 2);

    /* 检出异常段底纹 */
    segs.forEach(function (sg, k) {
      var cn = CONCL[sg.concl];
      var y0 = G.sy(sg.d0), y1 = G.sy(sg.d1), hh = Math.max(3, y1 - y0);
      ctx.fillStyle = cn.fill;
      ctx.fillRect(G.L, y0, G.W - G.L - G.R, hh);
      ctx.strokeStyle = cn.line;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(G.L, y0); ctx.lineTo(G.W - G.R, y0);
      ctx.moveTo(G.L, y1); ctx.lineTo(G.W - G.R, y1);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = '9px ui-monospace, monospace';
      ctx.textAlign = 'left';
      var ly = y0 - 3 > G.T + 8 ? y0 - 3 : y0 + 10;
      var ltxt = '#' + (k + 1) + ' ' + cn.name + ' ' + sg.d0.toFixed(0) + '—' + sg.d1.toFixed(0) + ' m';
      ctx.fillStyle = 'rgba(255,255,255,.86)';
      ctx.fillRect(G.L + 1, ly - 9, ctx.measureText(ltxt).width + 7, 12);
      ctx.fillStyle = cn.line;
      ctx.fillText(ltxt, G.L + 3, ly);
    });

    /* 合成真值层段（未检出的用红框标出） */
    sc.missed.forEach(function (z) {
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
    var nComp = state.comp ? 5 : 1;
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

    /* 实测全烃 + 基线 */
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
    var j = Math.max(0, Math.min(NZ - 1, Math.round((state.cursor - D0) / DZ)));
    el('hint').textContent = '深度 ' + state.cursor.toFixed(0) + ' m · 全烃 ' + D.total[j].toFixed(2) + '% · C1 ' +
      D.comp[0][j].toFixed(3) + ' · C2 ' + D.comp[1][j].toFixed(3) + ' · C3 ' + D.comp[2][j].toFixed(3) + ' · 钻时 ' + D.rop[j].toFixed(1);
  }

  /* ---------------- 8. 绘制：校正前后对比 ---------------- */
  function drawCmp(D, A, segs, sc) {
    var W = cmpCv.clientWidth || 640;
    cmpCv.width = Math.round(W * DPR); cmpCv.height = Math.round(Hc2 * DPR);
    cctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    cctx.clearRect(0, 0, W, Hc2);
    var l = 48, r = 10, t = 18, b = 26, gap = 18;
    var pw = (W - l - r - gap) / 2;
    var xa = l, xb = l + pw + gap;
    var ph = Hc2 - t - b;
    var sy = function (d) { return t + (d - D0) / DEPTH * ph; };
    var maxRaw = Math.max.apply(null, D.total) * 1.06;
    var maxCorr = Math.max(0.6, Math.max.apply(null, A.corr) * 1.12);
    var axa = function (v) { return xa + Math.min(1, v / maxRaw) * pw; };
    var axb = function (v) { return xb + Math.min(1, v / maxCorr) * pw; };

    cctx.fillStyle = '#fff';
    cctx.fillRect(xa, t, pw, ph);
    cctx.fillRect(xb, t, pw, ph);
    cctx.font = '9px ui-monospace, monospace';
    cctx.fillStyle = '#99a3a4';
    cctx.textAlign = 'left';
    cctx.fillText('实测全烃 + 估计基线', xa + 2, t - 5);
    cctx.fillText('校正后 + 阈值与检出', xb + 2, t - 5);

    /* 深度网格 */
    cctx.textAlign = 'right';
    for (var d = D0; d <= D0 + DEPTH; d += 200) {
      var y = sy(d);
      cctx.strokeStyle = '#efece3';
      cctx.beginPath();
      cctx.moveTo(xa, y); cctx.lineTo(xa + pw, y);
      cctx.moveTo(xb, y); cctx.lineTo(xb + pw, y);
      cctx.stroke();
      cctx.fillStyle = '#6f7a7c';
      cctx.font = '9px ui-monospace, monospace';
      cctx.fillText(d + '', xa - 5, y + 3);
    }
    /* 检出段底纹 + 真值未检出红框 */
    segs.forEach(function (sg) {
      var y0 = sy(sg.d0), y1 = sy(sg.d1), hh = Math.max(2, y1 - y0);
      cctx.fillStyle = CONCL[sg.concl].fill;
      cctx.fillRect(xa, y0, pw, hh);
      cctx.fillRect(xb, y0, pw, hh);
      cctx.strokeStyle = CONCL[sg.concl].line;
      cctx.setLineDash([3, 3]);
      cctx.beginPath();
      cctx.moveTo(xa, y0); cctx.lineTo(xa + pw, y0);
      cctx.moveTo(xb, y0); cctx.lineTo(xb + pw, y0);
      cctx.stroke();
      cctx.setLineDash([]);
    });
    sc.missed.forEach(function (z) {
      var y0 = sy(z.d0), y1 = sy(z.d1);
      cctx.strokeStyle = 'rgba(176,84,74,.8)';
      cctx.setLineDash([3, 3]);
      cctx.beginPath();
      cctx.moveTo(xa, y0); cctx.lineTo(xa + pw, y0);
      cctx.moveTo(xb, y0); cctx.lineTo(xb + pw, y0);
      cctx.stroke();
      cctx.setLineDash([]);
      cctx.fillStyle = '#a64b3c';
      cctx.font = '8.5px ui-monospace, monospace';
      cctx.textAlign = 'left';
      cctx.fillText(z.name + ' 未检出', xa + 3, y1 + 9);
      cctx.fillText(z.name + ' 未检出', xb + 3, y1 + 9);
    });

    /* 面板 A：实测（灰）+ 基线（橙虚线） */
    cctx.strokeStyle = '#a9742c';
    cctx.setLineDash([4, 3]);
    cctx.lineWidth = 1.2;
    cctx.beginPath();
    for (var i = 0; i < NZ; i++) {
      var x1 = axa(A.base[i]), y1 = sy(D0 + i * DZ);
      if (i === 0) cctx.moveTo(x1, y1); else cctx.lineTo(x1, y1);
    }
    cctx.stroke();
    cctx.setLineDash([]);
    cctx.strokeStyle = '#99a3a4';
    cctx.lineWidth = 1.2;
    cctx.beginPath();
    for (var i2 = 0; i2 < NZ; i2++) {
      var x2 = axa(D.total[i2]), y2 = sy(D0 + i2 * DZ);
      if (i2 === 0) cctx.moveTo(x2, y2); else cctx.lineTo(x2, y2);
    }
    cctx.stroke();

    /* 面板 B：校正后（绿）+ 阈值竖线 + 检出段实心块 */
    var xt = axb(A.thr);
    cctx.strokeStyle = '#a64b3c';
    cctx.setLineDash([4, 3]);
    cctx.beginPath(); cctx.moveTo(xt, t); cctx.lineTo(xt, t + ph); cctx.stroke();
    cctx.setLineDash([]);
    cctx.fillStyle = '#a64b3c';
    cctx.font = '8.5px ui-monospace, monospace';
    cctx.textAlign = 'left';
    cctx.fillText('阈值 ' + A.thr.toFixed(2) + '%', Math.min(xt + 3, xb + pw - 62), t + ph - 6);

    segs.forEach(function (sg) {
      var y0 = sy(sg.d0), y1 = sy(sg.d1), hh = Math.max(2, y1 - y0);
      cctx.fillStyle = CONCL[sg.concl].line;
      cctx.globalAlpha = 0.5;
      cctx.fillRect(xb, y0, Math.min(pw, axb(sg.peak) - xb), hh);
      cctx.globalAlpha = 1;
    });
    cctx.strokeStyle = '#123b3a';
    cctx.lineWidth = 1.4;
    cctx.beginPath();
    for (var i3 = 0; i3 < NZ; i3++) {
      var x3 = axb(A.corr[i3]), y3 = sy(D0 + i3 * DZ);
      if (i3 === 0) cctx.moveTo(x3, y3); else cctx.lineTo(x3, y3);
    }
    cctx.stroke();

    cctx.fillStyle = '#99a3a4';
    cctx.font = '8.5px ui-monospace, monospace';
    cctx.textAlign = 'center';
    cctx.fillText('全烃 %', xa + pw / 2, Hc2 - 8);
    cctx.fillText('校正后 %', xb + pw / 2, Hc2 - 8);
    cctx.textAlign = 'left';
    cctx.fillStyle = '#99a3a4';
    cctx.fillText('深度 m', 4, t + 2);
  }

  /* ---------------- 9. 绘制：Pixler 图版 ---------------- */
  function drawPixler(segs) {
    var s = '';
    /* 分区多边形：三段折线近似（简化 Pixler） */
    var bands = [
      { key: 'oil', fill: '#f6ead2', stroke: '#e5d2ae', name: '油区' },
      { key: 'gas', fill: '#e4ece7', stroke: '#c6d8ce', name: '气区' },
      { key: 'water', fill: '#e3eaf0', stroke: '#c9d6e0', name: '水区' }
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
    /* 网格与刻度 */
    var xt = [2, 5, 10, 20, 50, 100, 300], yt = [2, 5, 10, 20, 50, 100, 300, 1000];
    xt.forEach(function (v) {
      var p = xPix(v);
      s += "<line x1='" + p.toFixed(1) + "' y1='" + T + "' x2='" + p.toFixed(1) + "' y2='" + B + "' stroke='#e3dccd' stroke-width='0.7' stroke-dasharray='2 3'/>";
      s += "<text x='" + p.toFixed(1) + "' y='" + (B + 12) + "' font-size='9' font-family='monospace' fill='#99a3a4' text-anchor='middle'>" + v + "</text>";
    });
    yt.forEach(function (v) {
      var p = yPix(v);
      s += "<line x1='" + L + "' y1='" + p.toFixed(1) + "' x2='" + R + "' y2='" + p.toFixed(1) + "' stroke='#e3dccd' stroke-width='0.7' stroke-dasharray='2 3'/>";
      s += "<text x='" + (L - 5) + "' y='" + (p + 3).toFixed(1) + "' font-size='9' font-family='monospace' fill='#99a3a4' text-anchor='end'>" + v + "</text>";
    });
    /* 区名（不再写死 15/50，标明是简化分区） */
    s += "<text x='" + lxPix(0.55).toFixed(1) + "' y='" + lyPix(1.55).toFixed(1) + "' font-size='11' font-weight='600' fill='#8a5718' text-anchor='middle'>油区</text>";
    s += "<text x='" + lxPix(0.55).toFixed(1) + "' y='" + (lyPix(1.55) + 13).toFixed(1) + "' font-size='8' fill='#8a5718' text-anchor='middle'>湿 · C1/C3 低</text>";
    s += "<text x='" + lxPix(1.25).toFixed(1) + "' y='" + lyPix(2.65).toFixed(1) + "' font-size='11' font-weight='600' fill='#123b3a' text-anchor='middle'>气区</text>";
    s += "<text x='" + lxPix(1.25).toFixed(1) + "' y='" + (lyPix(2.65) + 13).toFixed(1) + "' font-size='8' fill='#123b3a' text-anchor='middle'>干 · 两个比值居中</text>";
    s += "<text x='" + lxPix(2.18).toFixed(1) + "' y='" + lyPix(1.55).toFixed(1) + "' font-size='11' font-weight='600' fill='#2b5570' text-anchor='middle'>水区</text>";
    s += "<text x='" + lxPix(2.18).toFixed(1) + "' y='" + (lyPix(1.55) + 13).toFixed(1) + "' font-size='8' fill='#2b5570' text-anchor='middle'>C1/C2 高</text>";
    s += "<text x='" + L + "' y='11' font-size='9' fill='#6f7a7c'>纵轴 C1/C3 ↑（对数）</text>";
    s += "<text x='" + R + "' y='" + (B + 27) + "' font-size='9' fill='#6f7a7c' text-anchor='end'>横轴 C1/C2 →（对数）</text>";
    s += "<text x='" + (L + 4) + "' y='" + (B - 18) + "' font-size='8.5' fill='#98a199'>简化 Pixler 分区：两个比值同时参与，仅用于教学</text>";

    /* 落点 */
    segs.forEach(function (sg, k) {
      var cn = CONCL[sg.concl];
      var px = xPix(sg.ratio12), py = yPix(sg.ratio13);
      if (k === state.sel) {
        s += "<circle cx='" + px.toFixed(1) + "' cy='" + py.toFixed(1) + "' r='10' fill='none' stroke='" + cn.line + "' stroke-width='1' stroke-dasharray='3 3'/>";
      }
      s += "<circle cx='" + px.toFixed(1) + "' cy='" + py.toFixed(1) + "' r='" + (k === state.sel ? 6 : 4.6) + "' fill='#ffffff' stroke='" + cn.line + "' stroke-width='" + (k === state.sel ? 2.6 : 2) + "'/>";
      s += "<text x='" + (px + 9).toFixed(1) + "' y='" + (py - 5).toFixed(1) + "' font-size='9' font-family='monospace' fill='#4a585c'>#" + (k + 1) + "</text>";
    });
    el('pixler').innerHTML = s;
  }

  /* ---------------- 10. 结论表 / 统计 / 说明 ---------------- */
  function renderTable(segs) {
    el('hits').innerHTML = segs.length ? segs.map(function (sg, k) {
      var cn = CONCL[sg.concl];
      return "<tr class='segrow" + (k === state.sel ? ' sel' : '') + "' data-i='" + k + "'>" +
        '<td>' + sg.d0.toFixed(0) + '—' + sg.d1.toFixed(0) +
        "<div class='mono' style='font-size:9.5px;color:var(--ink-4)'>段长 " + sg.len.toFixed(1) + ' m</div></td>' +
        "<td class='num'>" + sg.peak.toFixed(2) + '</td>' +
        "<td class='num'>" + sg.ratio12.toFixed(1) + '</td>' +
        "<td class='num'>" + sg.ratio13.toFixed(1) + '</td>' +
        "<td><span class='db " + cn.badge + "'>" + cn.name + '</span>' +
        "<div class='mono' style='font-size:9.5px;color:var(--ink-4)'>置信 " + (sg.conf * 100).toFixed(0) + '%</div></td></tr>';
    }).join('') : "<tr><td colspan='5' style='color:var(--ink-4)'>当前参数下没有检出异常段——阈值调得太高，或者基线把显示减掉了。</td></tr>";
    [].forEach.call(el('hits').querySelectorAll('[data-i]'), function (tr) {
      tr.addEventListener('click', function () {
        state.sel = Number(tr.getAttribute('data-i'));
        render();
      });
    });
  }

  function row(k, v) {
    return "<div class='mrow'><span class='k'>" + k + "</span><span class='v'>" + v + "</span></div>";
  }

  function renderList(D, A, sc) {
    var methodName = BASEM.filter(function (m) { return m.key === state.method; })[0].name;
    el('clist').innerHTML =
      row('基线方法', methodName + (state.method === 'quantile' ? '（' + state.win + ' 点 · ' + Math.round(state.q * 100) + '%）' : state.method === 'mean' ? '（' + state.win + ' 点）' : '')) +
      row('噪声 σ（高通 MAD）', A.sd.toFixed(3) + ' %') +
      row('峰高阈值', state.k.toFixed(1) + 'σ = ' + A.thr.toFixed(2) + ' %') +
      row('最小持续长度', state.minLen + ' 点 = ' + (state.minLen * DZ).toFixed(1) + ' m') +
      row('背景气 C1/C2（估）', (1 / Math.max(1e-6, A.bf[1])).toFixed(1)) +
      row('合成真值层段', sc.matched + ' / ' + LAYERS.length + ' 段命中') +
      row('结论与真值一致', sc.conclOk + ' / ' + LAYERS.length + ' 段') +
      row('背景气段（已单列）', sc.bg + ' 段') +
      row('图版落点分布', ['gas', 'oil', 'water', 'none'].filter(function (k2) {
        return A.segs.some(function (s) { return s.concl === k2; });
      }).map(function (k2) {
        var n = A.segs.filter(function (s) { return s.concl === k2; }).length;
        return CONCL[k2].name + '×' + n;
      }).join(' · ') || '—');
  }

  function segOf(segs, z) {
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (s.d0 <= z.d1 + 12 && s.d1 >= z.d0 - 12) return s;
    }
    return null;
  }

  function renderNote(D, A, segs, sc) {
    var methodName = BASEM.filter(function (m) { return m.key === state.method; })[0].name;
    var hd = '当前设置 <b>' + modeOf(state.mode).name + '</b> · 基线 <b>' + methodName + '</b>' +
      (state.method === 'quantile' ? '（窗口 ' + state.win + ' 点 ≈ ' + (state.win * DZ).toFixed(0) + ' m · ' + Math.round(state.q * 100) + '% 分位）'
        : state.method === 'mean' ? '（窗口 ' + state.win + ' 点 ≈ ' + (state.win * DZ).toFixed(0) + ' m）' : '（不做校正）') +
      ' · 峰高阈值 <b>' + state.k.toFixed(1) + 'σ</b>（σ ≈ ' + A.sd.toFixed(3) + '%，阈值 ≈ ' + A.thr.toFixed(2) + '%）· 最小持续 <b>' + state.minLen + ' 点</b>。';
    var body;
    if (!segs.length) {
      body = '算法在这段曲线上 <b>一段异常都没检出来</b>——阈值已经高到把油气显示也一起滤掉了。';
    } else {
      body = '算法检出 <b>' + segs.length + ' 段</b>：' + segs.map(function (sg, k) {
        return '#' + (k + 1) + ' <b>' + sg.d0.toFixed(0) + '—' + sg.d1.toFixed(0) + ' m</b>（校正后峰值 ' + sg.peak.toFixed(2) +
          '%，C1/C2 = ' + sg.ratio12.toFixed(1) + '、C1/C3 = ' + sg.ratio13.toFixed(1) + ' → <b>' + CONCL[sg.concl].name + '</b>，置信 ' + (sg.conf * 100).toFixed(0) + '%）';
      }).join('；') + '。';
    }
    var hint;
    if (sc.missed.length) {
      hint = '对照合成真值，<b>' + sc.missed.map(function (z) { return z.name + '（' + z.d0 + '—' + z.d1 + ' m，幅度 ' + (z.amp * modeOf(state.mode).gain).toFixed(2) + '%）'; }).join('、') +
        '</b> 没有被检出：它比同一套参数下的阈值还低，或者干脆被基线一起减掉了。把「峰高阈值」调到 2σ 左右、或把「基线窗口」改小（如 20 点）再试一次。';
    } else if (sc.fp.length) {
      hint = '另外有 <b>' + sc.fp.length + ' 段</b>与合成真值对不上，多半是接单根窄峰或背景气抬升造成的假异常。把「最小持续」提到 3 点以上、或把阈值抬到 3σ，假异常会成片消失。';
    } else {
      hint = '四个合成显示段全部被检出、也没有误报段。可以再试三件事：把「基线方法」换成<b>滑动均值</b>——窄峰会把基线抬起来，显示段被削平、误报增多；把工况换成<b>加重钻井液</b>——弱显示整体变小，薄油层会消失；把「分位数」拉到 40%——基线抬高、弱显示被减掉。';
    }
    /* 基线方法对照：同一套参数用滑动分位数基线跑一遍，给出可比的数字 */
    if (state.method !== 'quantile') {
      var ref = analyze(D, { win: state.win, q: 0.2, k: state.k, minLen: state.minLen, method: 'quantile' });
      var thin = segOf(segs, LAYERS[2]), thinRef = segOf(ref.segs, LAYERS[2]);
      var oil = segOf(segs, LAYERS[1]), oilRef = segOf(ref.segs, LAYERS[1]);
      var cmp = [];
      if (thin && thinRef) cmp.push('薄油层的 C1/C2 <b>' + thin.ratio12.toFixed(1) + '</b>（分位数基线时 ' + thinRef.ratio12.toFixed(1) + '）');
      if (oil && oilRef) cmp.push('油层峰值 <b>' + oil.peak.toFixed(2) + '%</b>（分位数基线时 ' + oilRef.peak.toFixed(2) + '%）');
      hint += ' 注意' + methodName + '的问题：' +
        (state.method === 'mean'
          ? '滑动均值会被窄峰抬起来，显示段被削平、组分比失真（比值可能掉出图版量程而被判「待复核」），同时噪声尺度被压小、阈值形同虚设，误报段增多。'
          : '不校正时背景气（贫气）直接进了组分比，弱层的比值被往「干」的方向拉，落点整体向气区漂，离分区边界近的段会因此换结论。') +
        (cmp.length ? '对照来看：' + cmp.join('、') + '。' : '');
    }
    el('note').innerHTML = hd + body + ' ' + hint +
      ' 点结论表任意一行，Pixler 图版上对应的落点会放大；把鼠标放到曲线上，可以读该深度的全烃与组分值。';
  }

  /* ---------------- 11. 主渲染 ---------------- */
  var LAST = null, LASTSC = null, D = null, A = null;

  function render() {
    syncCtrl();
    D = synth(state.mode, state.spikes);
    A = analyze(D, { win: state.win, q: state.q, k: state.k, minLen: state.minLen, method: state.method });
    var segs = A.segs, sc = score(segs);
    if (state.sel >= segs.length) state.sel = 0;

    drawLog(D, A, segs, sc);
    drawCmp(D, A, segs, sc);
    drawPixler(segs);
    renderTable(segs);
    renderList(D, A, sc);

    el('st-n').textContent = segs.length;
    el('st-recall').innerHTML = sc.matched + '/' + LAYERS.length + ' · ' + sc.conclOk + '/' + LAYERS.length;
    el('st-fp').textContent = sc.fp.length;
    el('st-time').innerHTML = (5 + segs.length * 1.6).toFixed(0) + '<small>min</small>';

    renderNote(D, A, segs, sc);
    LAST = {
      segs: segs.map(function (s) {
        return { d0: Math.round(s.d0), d1: Math.round(s.d1), peak: Number(s.peak.toFixed(2)), r12: Number(s.ratio12.toFixed(1)), r13: Number(s.ratio13.toFixed(1)), concl: s.concl, conf: Number(s.conf.toFixed(2)) };
      }),
      concl: segs.map(function (s) { return s.concl; }).join(','),
      sd: Number(A.sd.toFixed(3)), thr: Number(A.thr.toFixed(3)),
      matched: sc.matched, truth: LAYERS.length, fp: sc.fp.length, missed: sc.missed.map(function (z) { return z.name; }).join(','),
      segCount: segs.length, mode: state.mode, method: state.method, k: state.k, minLen: state.minLen, win: state.win, q: state.q
    };
    LASTSC = sc;
    window.__GASLOG__ = LAST;
    el('st-n').title = '异常段数';
  }

  state.cursor = 3400;
  cv.addEventListener('mousemove', function (e) {
    var r = cv.getBoundingClientRect();
    var y = e.clientY - r.top;
    if (y < G.T || y > G.T + G.plotH) return;
    state.cursor = Math.max(D0, Math.min(D0 + DEPTH, G.dy(y)));
    if (LAST) drawLog(D, A, A.segs, LASTSC);
  });

  var rt = null;
  window.addEventListener('resize', function () {
    clearTimeout(rt);
    rt = setTimeout(function () { if (LAST) render(); }, 160);
  });

  render();
})();
