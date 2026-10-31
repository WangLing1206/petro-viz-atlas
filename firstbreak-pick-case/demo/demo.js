/* =========================================================
   STA/LTA 初至拾取示范脚本（整页模式，运行在沙箱 iframe 里）
   ---------------------------------------------------------
   合成一道地震记录，逐点计算短长时窗能量比，
   第一个冲过阈值的峰即拾取的初至。
   ========================================================= */
(function () {
  "use strict";

  /* ---------- 0. 参数与数据 ---------- */
  var N = 360;                 /* 采样点数 */
  var FS = 2;                  /* 采样率 ms */
  var T0 = 150;                /* 真实初至位置（采样点） */
  var STA = 8, LTA = 60;       /* 短/长时窗（采样点） */

  /* 固定种子的噪声实现：滑杆只改幅度，波形本身不抖 */
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  var rnd = mulberry32(20261022);
  var noiseBase = new Float64Array(N);
  for (var i = 0; i < N; i++) {
    /* 两列均匀分布取平均近似高斯 */
    noiseBase[i] = (rnd() + rnd() - 1);
  }

  /* 信号：初至后一串指数衰减振动 */
  var signal = new Float64Array(N);
  for (var j = T0; j < N; j++) {
    var dt = j - T0;
    signal[j] = Math.exp(-dt / 55) * Math.sin(dt / 18 * Math.PI * 2) * 1.6;
  }

  var traceSvg = document.getElementById("trace");
  var ratioSvg = document.getElementById("ratio");
  var noiseIn = document.getElementById("noise");
  var thIn = document.getElementById("th");
  var outNoise = document.getElementById("out-noise");
  var outTh = document.getElementById("out-th");
  var note = document.getElementById("note");

  var W = 720, H1 = 210, H2 = 120;
  var L = 40, R = 12, T = 12, B = 22;
  var x = function (i) { return L + i / (N - 1) * (W - L - R); };

  /* ---------- 1. STA/LTA ---------- */
  function energyRatio(trace) {
    var ratio = new Float64Array(N);
    for (var i = 0; i < N; i++) {
      if (i < STA + LTA) { ratio[i] = 1; continue; }
      var se = 0, le = 0, k;
      for (k = i - STA + 1; k <= i; k++) se += trace[k] * trace[k];
      for (k = i - LTA - STA + 1; k <= i - STA; k++) le += trace[k] * trace[k];
      ratio[i] = (se / STA) / (le / LTA + 1e-9);
    }
    return ratio;
  }

  function pick(ratio, th) {
    for (var i = STA + LTA; i < N; i++) {
      if (ratio[i] > th) return i;
    }
    return -1;   /* 全程未触发 = 漏拾取 */
  }

  /* ---------- 2. 绘图 ---------- */
  function grid(s, H, marks, fmt) {
    marks.forEach(function (v) {
      var y = T + (1 - (v - marks[0]) / (marks[marks.length - 1] - marks[0])) * (H - T - B);
      s += '<line x1="' + L + '" y1="' + y + '" x2="' + (W - R) + '" y2="' + y +
        '" stroke="#efece1" stroke-width="1"/>';
      s += '<text x="' + (L - 6) + '" y="' + (y + 3) + '" font-size="9" fill="#9ba3a9" ' +
        'text-anchor="end" font-family="monospace">' + (fmt ? fmt(v) : v) + '</text>';
    });
    return s;
  }

  function yOf(v, lo, hi, H) {
    return T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  }

  function pathOf(arr, lo, hi, H) {
    var d = "";
    for (var k = 0; k < N; k++) {
      d += (k ? "L" : "M") + x(k).toFixed(1) + " " + yOf(arr[k], lo, hi, H).toFixed(1);
    }
    return d;
  }

  function draw() {
    var nl = Number(noiseIn.value);
    var th = Number(thIn.value);
    outNoise.textContent = nl.toFixed(1);
    outTh.textContent = th.toFixed(1);

    /* 合成本次波形 */
    var trace = new Float64Array(N);
    var peak = 0;
    for (var i = 0; i < N; i++) {
      trace[i] = signal[i] + noiseBase[i] * nl;
      var a = Math.abs(trace[i]);
      if (a > peak) peak = a;
    }

    var ratio = energyRatio(trace);
    var pk = pick(ratio, th);

    var lo = -Math.ceil(peak * 1.15), hi = Math.ceil(peak * 1.15);
    var yA = function (v) { return yOf(v, lo, hi, H1); };

    /* --- 波形图 --- */
    var s = '<rect x="' + x(T0) + '" y="' + T + '" width="' + (x(N - 1) - x(T0)) +
      '" height="' + (H1 - T - B) + '" fill="#f4f9f6"/>';
    s = grid(s, H1, [-1, 0, 1].map(function (f) { return f * Math.max(0.5, hi); }),
      function (v) { return v.toFixed(1); });
    s += '<line x1="' + L + '" y1="' + yA(0) + '" x2="' + (W - R) + '" y2="' + yA(0) +
      '" stroke="#d8d2c4" stroke-width="1"/>';

    /* 真实初至（绿虚线） */
    s += '<line x1="' + x(T0) + '" y1="' + T + '" x2="' + x(T0) + '" y2="' + (H1 - B) +
      '" stroke="#2f7d6b" stroke-width="1.1" stroke-dasharray="5 3" opacity=".8"/>';
    s += '<text x="' + (x(T0) + 4) + '" y="' + (T + 10) + '" font-size="9.5" fill="#2f7d6b" font-family="monospace">真实初至</text>';

    /* 波形 */
    s += '<path d="' + pathOf(trace, lo, hi, H1) +
      '" fill="none" stroke="#242b2e" stroke-width="1.1" stroke-linejoin="round"/>';

    /* 拾取线（陶土色实线） */
    if (pk >= 0) {
      s += '<line x1="' + x(pk) + '" y1="' + T + '" x2="' + x(pk) + '" y2="' + (H1 - B) +
        '" stroke="#b26a39" stroke-width="1.4"/>';
      s += '<text x="' + (x(pk) + 4) + '" y="' + (H1 - B - 6) + '" font-size="9.5" fill="#b26a39" font-family="monospace">拾取</text>';
    } else {
      s += '<text x="' + (L + 8) + '" y="' + (T + 12) + '" font-size="10.5" fill="#b26a39" font-weight="bold">全程未触发 —— 漏拾取</text>';
    }
    s += '<text x="' + (W - R) + '" y="' + (H1 - 6) + '" font-size="9" fill="#9ba3a9" text-anchor="end" font-family="monospace">时间 ' + (N * FS) + ' ms →</text>';
    traceSvg.innerHTML = s;

    /* --- 能量比图 --- */
    var rHi = 10;
    var yR = function (v) { return yOf(Math.min(v, rHi), 0, rHi, H2); };
    var s2 = "";
    [0, 5, 10].forEach(function (v) {
      s2 += '<line x1="' + L + '" y1="' + yR(v) + '" x2="' + (W - R) + '" y2="' + yR(v) +
        '" stroke="#efece1" stroke-width="1"/>';
      s2 += '<text x="' + (L - 6) + '" y="' + (yR(v) + 3) + '" font-size="9" fill="#9ba3a9" text-anchor="end" font-family="monospace">' + v + '</text>';
    });
    /* 阈值线 */
    s2 += '<line x1="' + L + '" y1="' + yR(th) + '" x2="' + (W - R) + '" y2="' + yR(th) +
      '" stroke="#b26a39" stroke-width="1" stroke-dasharray="4 3" opacity=".75"/>';
    s2 += '<text x="' + (W - R) + '" y="' + (yR(th) - 3) + '" font-size="9" fill="#b26a39" text-anchor="end" font-family="monospace">阈值 ' + th.toFixed(1) + '</text>';
    /* 比值曲线（超过 rHi 截断显示） */
    var d2 = "";
    for (var k2 = 0; k2 < N; k2++) {
      d2 += (k2 ? "L" : "M") + x(k2).toFixed(1) + " " + yR(ratio[k2]).toFixed(1);
    }
    s2 += '<path d="' + d2 + '" fill="none" stroke="#41699b" stroke-width="1.2" stroke-linejoin="round"/>';
    if (pk >= 0) {
      s2 += '<circle cx="' + x(pk) + '" cy="' + yR(ratio[pk]) + '" r="3" fill="#b26a39"/>';
    }
    ratioSvg.innerHTML = s2;

    /* --- 读数与判定 --- */
    var el = function (id) { return document.getElementById(id); };
    el("ro-pick").textContent = pk >= 0 ? (pk * FS) + " ms" : "未触发";
    el("ro-true").textContent = (T0 * FS) + " ms";
    var errEl = el("ro-err"), vEl = el("ro-verdict");
    if (pk < 0) {
      errEl.textContent = "—"; errEl.className = "bad";
      vEl.textContent = "漏拾取"; vEl.className = "bad";
      note.innerHTML = "能量比始终没碰到阈值：噪声太低而信号也弱（或阈值过高），算法宁可不放也不能乱放——" +
        "这种道要交给<b>人工复核</b>或换成逐点分类模型。";
    } else {
      var err = pk - T0;
      errEl.textContent = (err > 0 ? "+" : "") + (err * FS) + " ms";
      errEl.className = Math.abs(err) <= 2 ? "ok" : "bad";
      if (err < -2) {
        vEl.textContent = "假拾取"; vEl.className = "bad";
        note.innerHTML = "拾取点比真实初至<b>提前</b>了：噪声尖峰先触发了阈值。实际项目中用" +
          "<b>相邻道一致性约束</b>把这种离群道拉回来，或适当调高阈值。";
      } else if (err > 2) {
        vEl.textContent = "滞后"; vEl.className = "bad";
        note.innerHTML = "拾取点落在真实初至<b>之后</b>：阈值偏高或 STA 窗错过了第一个尖峰，" +
          "滞后拾取会让静校正量偏大。";
      } else {
        vEl.textContent = "命中"; vEl.className = "ok";
        note.innerHTML = "误差 ≤ 2 个采样点（4 ms），算命中。试着把噪声拖到 <b>2.0 以上</b>，" +
          "观察假拾取怎么出现；再把阈值拖到 <b>6 以上</b>，看弱信号道怎么漏拾。" +
          "这正是流程里第 3、4 步（一致性约束 + 低置信度人工复核）存在的理由。";
      }
    }
  }

  noiseIn.addEventListener("input", draw);
  thIn.addEventListener("input", draw);
  draw();
})();
