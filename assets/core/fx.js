/* =========================================================
   首页动效层 FX · 三维地震解释显示（语义版）
   ---------------------------------------------------------
   画面不是「一堆粒子」，而是一个真实的地震解释场景：
     三片正交切片拼成 chair diagram（inline / crossline / 时间切片），
     切片上画的是**合成地震道**——层位反射、断层错断、目的层亮点，
     都是按同一套地质模型算出来的，所以互相之间对得上。

   四个状态 = 解释工作流的四步，每一步改变的是「显示什么」：
     ① 采集 ACQUISITION     只看原始数据：三片切片 + 扫描线
     ② 解释 INTERPRETATION  层位追踪线 + 断层曲面（落差 ~100 m）显形
     ③ 钻井 DRILLING        井眼轨迹穿过数据体，标出 900/1800/2700 m
     ④ 开发 DEVELOPMENT     俯视时间切片，目的层振幅异常（甜点区）绽放

   技术：三层纹理（各 128×192）在三维空间里做透视贴图（按条带做仿射细分），
   手写透视投影 + Canvas 2D，不依赖 three.js / WebGL，可离线双击运行。

   健壮性：画布自检像素、看门狗重启 rAF、离屏暂停、
   prefers-reduced-motion 只降速、CSS 3D 兜底。
   ========================================================= */

(function (global) {
  'use strict';

  var state = null;
  function reduced() {
    try { return global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch (e) { return false; }
  }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function smoothstep(a, b, v) {
    var t = clamp((v - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  }
  function gauss(d2, s2) { return Math.exp(-d2 / s2); }

  /* =========================================================
     一、地质模型（所有切片共用，保证互相「对得上」）
     ========================================================= */
  var HORIZONS = [
    { y: 0.14, amp: 0.012, f: 2.2, ph: 0.4, r: 0.85, name: 'T0' },
    { y: 0.25, amp: 0.020, f: 1.7, ph: 1.9, r: 0.95, name: 'T1' },
    { y: 0.37, amp: 0.014, f: 2.6, ph: 3.1, r: 1.00, name: 'T1b' },
    { y: 0.56, amp: 0.026, f: 1.4, ph: 0.8, r: 1.35, name: 'T2' },   /* 目的层 */
    { y: 0.71, amp: 0.018, f: 2.0, ph: 2.4, r: 0.90, name: 'T3' },
    { y: 0.86, amp: 0.010, f: 2.8, ph: 1.2, r: 0.80, name: 'T4' }
  ];
  var RES = HORIZONS[3];
  var FAULT = { off: 0.030, dip: 0.05 };          /* 断距 0.030 ≈ 100 m */
  function faultX(z) { return 0.06 + 0.20 * Math.sin(z * 1.25); }
  function horizonY(k, x, z) {
    var h = HORIZONS[k];
    return h.y + h.amp * (Math.sin(x * h.f + h.ph) + 0.55 * Math.cos(z * h.f * 0.85 + h.ph));
  }
  var HOT = { x: 0.52, z: -0.24 };                /* 甜点区平面位置 */
  function wellAt(t) {
    /* 斜井：从地表 HOT 附近钻到目的层，带一点方位漂移 */
    return {
      x: -0.30 + (HOT.x + 0.30) * Math.pow(t, 0.9),
      y: t * (RES.y + 0.02),
      z: 0.42 + (HOT.z - 0.42) * Math.pow(t, 0.9)
    };
  }

  /* 合成地震道：ricker 子波叠在各层位上，断层处整体错断，甜点区振幅增强 */
  function seismicAt(x, y, z) {
    var shift = x > faultX(z) ? FAULT.off : 0;
    var a = 0, k, d;
    for (k = 0; k < HORIZONS.length; k++) {
      var hy = horizonY(k, x, z) + shift;
      d = (y - hy) / 0.013;
      /* 横向调幅：同一层位在不同位置强弱不同（真实剖面的样子） */
      var lat = 0.55 + 0.45 * Math.sin(x * 4.1 + z * 3.2 + k * 1.7);
      a += HORIZONS[k].r * lat * (1 - 2 * d * d) * Math.exp(-d * d);
    }
    /* 两条层间薄反射 */
    [0.205, 0.455, 0.635].forEach(function (yy, ii) {
      var d2 = (y - (yy + shift + 0.01 * Math.sin(x * 6 + z * 5 + ii))) / 0.007;
      a += 0.42 * (1 - 2 * d2 * d2) * Math.exp(-d2 * d2);
    });
    /* 目的层亮点：甜点区附近振幅显著增强（横向成团） */
    var dh = (x - HOT.x) * (x - HOT.x) + (z - HOT.z) * (z - HOT.z);
    a += 1.15 * Math.exp(-dh / 0.075) * Math.exp(-Math.pow((y - RES.y) / 0.030, 2));
    /* 断层附近的绕射/破碎带：振幅变杂 */
    var fd = Math.abs(x - faultX(z));
    a += 0.20 * Math.exp(-fd * fd / 0.0009) * Math.sin(y * 260 + z * 9);
    return a;
  }

  /* 地震色标：负振幅→青玉，零→近黑，正振幅→琥珀/奶白（variable density） */
  var SPEC = (function () {
    var out = [];
    for (var i = 0; i < 128; i++) {
      var v = i / 127 * 2 - 1;                    /* -1..1 */
      var r, g, b;
      if (v >= 0) {
        var t = Math.pow(v, 0.72);
        r = Math.round(16 + t * 240);
        g = Math.round(34 + t * 176);
        b = Math.round(30 + t * 96);
      } else {
        var t2 = Math.pow(-v, 0.78);
        r = Math.round(16 + t2 * 74);
        g = Math.round(34 + t2 * 186);
        b = Math.round(30 + t2 * 156);
      }
      out.push([r, g, b]);
    }
    return out;
  })();
  function specColor(v) {
    var i = Math.round((clamp(v, -1, 1) + 1) / 2 * 127);
    return SPEC[i];
  }

  /* =========================================================
     二、纹理：把模型采样成三张地震切片
     ========================================================= */
  var TW = 132, TH = 196;
  var seed = 20261027;
  function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }

  var TEX_CACHE = {};
  function makePanel(kind) {
    if (TEX_CACHE[kind]) return TEX_CACHE[kind];
    var cv = global.document.createElement('canvas');
    cv.width = TW; cv.height = TH;
    var c = cv.getContext('2d');
    var img = c.createImageData(TW, TH);
    var d = img.data;
    for (var j = 0; j < TH; j++) {
      var v = j / (TH - 1);
      for (var i = 0; i < TW; i++) {
        var u = i / (TW - 1);
        var x, y, z;
        if (kind === 'inline') { x = -0.30; z = u * 2 - 1; y = v; }
        else if (kind === 'cross') { x = u * 2 - 1; z = 0.30; y = v; }
        else { x = u * 2 - 1; z = v * 2 - 1; y = RES.y; }
        var a = seismicAt(x, y, z);
        a *= 0.78;
        a += (rnd() - 0.5) * 0.10;                /* 采集噪声 */
        var col = specColor(a);
        var p = (j * TW + i) * 4;
        d[p] = col[0]; d[p + 1] = col[1]; d[p + 2] = col[2]; d[p + 3] = 255;
      }
    }
    c.putImageData(img, 0, 0);
    /* 时间切片加一点淡出边缘，贴地时不像一块硬纸板 */
    if (kind === 'time') {
      var g = c.createRadialGradient(TW / 2, TH / 2, TW * 0.25, TW / 2, TH / 2, TW * 0.72);
      g.addColorStop(0, 'rgba(4,16,15,0)');
      g.addColorStop(1, 'rgba(4,16,15,0.55)');
      c.fillStyle = g;
      c.fillRect(0, 0, TW, TH);
    }
    TEX_CACHE[kind] = cv;
    return cv;
  }

  /* =========================================================
     三、四个状态：机位 + 显示权重 + 文案
     ========================================================= */
  var STATES = [
    {
      key: 'acq', no: '01', name: '采集', en: 'ACQUISITION',
      desc: '三片正交切片切进数据体：inline、crossline、时间切片，读到的是原始振幅。',
      pose: { yaw: -0.62, pitch: -0.34, dist: 4.30, ty: 0.01 },
      mix: { panel: 1.0, time: 0.26, hor: 0.0, fault: 0.0, well: 0.10, blob: 0.0 },
      hot: 0.0
    },
    {
      key: 'int', no: '02', name: '解释', en: 'INTERPRETATION',
      desc: '沿切片追层位、拾断层：六条反射层被串起来，断距约 100 m 的断面被勾出。',
      pose: { yaw: -1.16, pitch: -0.30, dist: 4.30, ty: 0.02 },
      mix: { panel: 0.96, time: 0.30, hor: 1.0, fault: 1.0, well: 0.20, blob: 0.10 },
      hot: 0.0
    },
    {
      key: 'drill', no: '03', name: '钻井', en: 'DRILLING',
      desc: '井眼从地表斜穿到目的层：井深 900 / 1800 / 2700 m 三个测点标在轨迹上。',
      pose: { yaw: -0.10, pitch: -0.16, dist: 4.15, ty: -0.14 },
      mix: { panel: 0.58, time: 0.34, hor: 0.45, fault: 0.40, well: 1.0, blob: 0.25 },
      hot: 0.0
    },
    {
      key: 'dev', no: '04', name: '开发', en: 'DEVELOPMENT',
      desc: '俯视目的层时间切片：振幅异常成团出现，那就是甜点区，布井与分段从这里排。',
      pose: { yaw: 0.22, pitch: -0.72, dist: 3.95, ty: -0.03 },
      mix: { panel: 0.32, time: 1.0, hor: 0.55, fault: 0.25, well: 0.55, blob: 1.0 },
      hot: 1.0
    }
  ];
  var DWELL = 7.2;

  /* =========================================================
     四、场景
     ========================================================= */
  function hero(canvas, opts) {
    destroy();
    if (!canvas || !canvas.getContext) return;
    var stageEl = canvas.parentElement;
    function mark(cls) { if (stageEl) stageEl.classList.add(cls); }

    var ctx = canvas.getContext('2d');
    if (!ctx) { mark('fx-err'); return; }

    opts = opts || {};
    var calm = reduced();
    var speed = calm ? 0.25 : 1;

    var W = 0, H = 0, DPR = 1;
    var cam = { yaw: -0.62, pitch: -0.34, dist: 6.6, ty: 0.01, fov: 900 };
    var mix = { panel: 0, time: 0, hor: 0, fault: 0, well: 0, blob: 0 };
    var st = { idx: 0, t: 0 };
    var clock = 0, intro = 0;
    var paused = false, visible = true, running = false, raf = null, last = 0;
    var frames = 0, lastWatch = 0;
    var drag = { on: false, x: 0, y: 0, yaw: 0, pitch: 0 };

    /* 三张切片纹理 */
    var texInline = makePanel('inline');
    var texCross = makePanel('cross');
    var texTime = makePanel('time');

    /* 面板几何：u,v ∈ [0,1] → 世界坐标 */
    function panelPoint(kind, u, v) {
      if (kind === 'inline') return { x: -0.30, y: v, z: u * 2 - 1 };
      if (kind === 'cross') return { x: u * 2 - 1, y: v, z: 0.30 };
      return { x: u * 2 - 1, y: RES.y, z: v * 2 - 1 };
    }
    var PANELS = [
      { kind: 'inline', tex: texInline, w: TW, h: TH },
      { kind: 'cross', tex: texCross, w: TW, h: TH },
      { kind: 'time', tex: texTime, w: TW, h: TH }
    ];

    var CAM_CY = 0.44;
    function resize() {
      var r = canvas.getBoundingClientRect();
      DPR = Math.min(1.5, global.devicePixelRatio || 1);
      W = Math.max(320, Math.round(r.width));
      H = Math.max(320, Math.round(r.height));
      canvas.width = Math.round(W * DPR);
      canvas.height = Math.round(H * DPR);
      cam.fov = Math.min(W, H) * (W < 640 ? 1.75 : 1.24);
    }

    function project(x, y, z, pose) {
      var cy = Math.cos(pose.yaw), syw = Math.sin(pose.yaw);
      var cp = Math.cos(pose.pitch), sp = Math.sin(pose.pitch);
      var X = x * cy - z * syw;
      var Z = x * syw + z * cy;
      var Y = (y - CAM_CY) * cp - Z * sp + pose.ty;
      var Z2 = (y - CAM_CY) * sp + Z * cp;
      var zc = Z2 + pose.dist;
      if (zc < 0.35) return null;
      var s = cam.fov / zc;
      var cx = W > 900 ? W * 0.62 : W * 0.5;
      var cyy = W > 640 ? H * 0.48 : H * 0.35;
      return { x: cx + X * s, y: cyy + Y * s, s: s, z: zc };
    }

    /* 透视贴图：把一张纹理按 16 条横带做仿射细分，拼成透视正确的四边形 */
    function drawPanel(kind, tex, alpha, pose) {
      if (alpha < 0.02) return;
      var BANDS = 18;
      ctx.save();
      ctx.globalAlpha = alpha;
      for (var b = 0; b < BANDS; b++) {
        var v0 = b / BANDS, v1 = (b + 1) / BANDS;
        var p00 = panelPoint(kind, 0, v0), p10 = panelPoint(kind, 1, v0), p01 = panelPoint(kind, 0, v1);
        var A = project(p00.x, p00.y, p00.z, pose);
        var B = project(p10.x, p10.y, p10.z, pose);
        var C = project(p01.x, p01.y, p01.z, pose);
        if (!A || !B || !C) continue;
        var ax = (B.x - A.x) * DPR, ay = (B.y - A.y) * DPR;
        var cx2 = (C.x - A.x) / (v1 - v0) * DPR, cy2 = (C.y - A.y) / (v1 - v0) * DPR;
        ctx.setTransform(ax, ay, cx2, cy2, A.x * DPR, A.y * DPR);
        ctx.drawImage(tex, 0, tex.height * v0, tex.width, tex.height * (v1 - v0), 0, 0, 1, v1 - v0);
      }
      ctx.restore();
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    }

    /* 切片边框与角标：让切片读起来是「一张图」而不是一团色块 */
    function panelFrame(kind, alpha, pose) {
      if (alpha < 0.05) return;
      var pts = [
        panelPoint(kind, 0, 0), panelPoint(kind, 1, 0),
        panelPoint(kind, 1, 1), panelPoint(kind, 0, 1)
      ].map(function (p) { return project(p.x, p.y, p.z, pose); });
      if (pts.some(function (p) { return !p; })) return;
      ctx.strokeStyle = 'rgba(150, 232, 208, ' + (0.34 * alpha).toFixed(3) + ')';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (var i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
      ctx.stroke();
    }

    /* 切片标注：像工作站上的 INLINE / CROSSLINE 行号 */
    function panelLabel(kind, text, alpha, pose) {
      if (alpha < 0.12) return;
      var p = panelPoint(kind, 0, 0);
      var pp = project(p.x, p.y, p.z, pose);
      if (!pp) return;
      ctx.font = '9px ui-monospace, Consolas, monospace';
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(180, 240, 220, ' + (0.55 * alpha).toFixed(3) + ')';
      ctx.fillText(text, pp.x + 6, pp.y - 6);
    }

    /* 层位追踪：在垂直切片上沿着层位画亮线（解释成果，直接压在切片上） */
    function drawHorizonTraces(pose) {
      if (mix.hor < 0.05) return;
      var kinds = ['inline', 'cross'];
      kinds.forEach(function (kind) {
        for (var k = 0; k < HORIZONS.length; k++) {
          var isRes = k === 3;
          ctx.strokeStyle = isRes
            ? 'rgba(255, 206, 138, ' + (0.95 * mix.hor).toFixed(3) + ')'
            : 'rgba(126, 232, 206, ' + (0.34 * mix.hor).toFixed(3) + ')';
          ctx.lineWidth = isRes ? 1.9 : 1.1;
          ctx.beginPath();
          var started = false;
          for (var j = 0; j <= 26; j++) {
            var u = j / 26;
            var pw = panelPoint(kind, u, 0);
            var yy = horizonY(k, pw.x, pw.z);
            var pp = project(pw.x, yy, pw.z, pose);
            if (!pp) { started = false; continue; }
            if (!started) { ctx.moveTo(pp.x, pp.y); started = true; } else ctx.lineTo(pp.x, pp.y);
          }
          ctx.stroke();
        }
      });
    }

    /* 断层：一站立面 + 断续线，落差用两条错开的层位提示 */
    function drawFault(pose) {
      if (mix.fault < 0.05) return;
      var a = mix.fault;
      /* 断面网格 */
      ctx.strokeStyle = 'rgba(236, 150, 120, ' + (0.34 * a).toFixed(3) + ')';
      ctx.lineWidth = 1;
      for (var j = 0; j <= 4; j++) {
        var y = j / 4;
        ctx.beginPath();
        var started = false;
        for (var i = 0; i <= 14; i++) {
          var z = i / 14 * 2 - 1;
          var pp = project(faultX(z), y, z, pose);
          if (!pp) { started = false; continue; }
          if (!started) { ctx.moveTo(pp.x, pp.y); started = true; } else ctx.lineTo(pp.x, pp.y);
        }
        ctx.stroke();
      }
      for (var v2 = 0; v2 <= 4; v2++) {
        var z2 = v2 / 4 * 2 - 1;
        ctx.beginPath();
        var on = false;
        for (var y2 = 0; y2 <= 10; y2++) {
          var q = project(faultX(z2), y2 / 10, z2, pose);
          if (!q) { on = false; continue; }
          if (!on) { ctx.moveTo(q.x, q.y); on = true; } else ctx.lineTo(q.x, q.y);
        }
        ctx.stroke();
      }
      /* 标注 */
      var lab = project(faultX(-0.55), 0.10, -0.55, pose);
      if (lab) {
        ctx.font = '9px ui-monospace, Consolas, monospace';
        ctx.textAlign = 'left';
        ctx.fillStyle = 'rgba(250, 176, 148, ' + (0.9 * a).toFixed(3) + ')';
        ctx.fillText('断层 F1 · 断距 ≈100 m', lab.x + 8, lab.y - 6);
      }
    }

    /* 井眼轨迹 + 井深刻度 + 靶点 */
    function drawWell(pose) {
      if (mix.well < 0.05) return;
      var a = mix.well;
      ctx.strokeStyle = 'rgba(190, 250, 226, ' + (0.5 + 0.45 * a).toFixed(3) + ')';
      ctx.lineWidth = 1.2 + 1.1 * a;
      ctx.beginPath();
      var started = false;
      for (var i = 0; i <= 60; i++) {
        var p = wellAt(i / 60);
        var pp = project(p.x, p.y, p.z, pose);
        if (!pp) { started = false; continue; }
        if (!started) { ctx.moveTo(pp.x, pp.y); started = true; } else ctx.lineTo(pp.x, pp.y);
      }
      ctx.stroke();

      /* 井口 + 三个测点 */
      var head = wellAt(0);
      var hp = project(head.x, 0, head.z, pose);
      if (hp) {
        ctx.fillStyle = 'rgba(200, 250, 232, 0.95)';
        ctx.beginPath();
        ctx.moveTo(hp.x, hp.y - 24); ctx.lineTo(hp.x + 4.5, hp.y - 18);
        ctx.lineTo(hp.x, hp.y - 12); ctx.lineTo(hp.x - 4.5, hp.y - 18);
        ctx.closePath(); ctx.fill();
        ctx.font = '9px ui-monospace, Consolas, monospace';
        ctx.textAlign = 'left';
        ctx.fillStyle = 'rgba(214, 250, 236, ' + (0.45 + 0.45 * a).toFixed(3) + ')';
        ctx.fillText('WELL A-12', hp.x + 9, hp.y - 18);
      }
      if (a > 0.5) {
        ctx.font = '8.5px ui-monospace, Consolas, monospace';
        [0.25, 0.5, 0.75].forEach(function (t) {
          var p = wellAt(t);
          var pp = project(p.x, p.y, p.z, pose);
          if (!pp) return;
          ctx.fillStyle = 'rgba(200, 250, 232, 0.9)';
          ctx.beginPath(); ctx.arc(pp.x, pp.y, 2, 0, 6.2832); ctx.fill();
          ctx.fillStyle = 'rgba(200, 250, 232, 0.55)';
          ctx.fillText(Math.round(t * 3600) + ' m', pp.x + 7, pp.y + 3);
        });
      }
      /* 靶点：井眼与目的层的交点 */
      var lp = wellAt(1);
      var lpp = project(lp.x, lp.y, lp.z, pose);
      if (lpp && a > 0.4) {
        ctx.strokeStyle = 'rgba(255, 226, 170, ' + (0.8 * a).toFixed(3) + ')';
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.arc(lpp.x, lpp.y, 9 + 2 * Math.sin(clock * 2 * speed), 0, 6.2832); ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    /* 目的层异常体：椭球辉光 + 虚线轮廓 + 标注（只在开发态明显） */
    function drawBlob(pose) {
      if (mix.blob < 0.05) return;
      var a = mix.blob;
      var c = project(HOT.x, RES.y, HOT.z, pose);
      if (!c) return;
      var r = (46 + 8 * Math.sin(clock * 1.5 * speed)) * (0.6 + 0.4 * a);
      var g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, r);
      g.addColorStop(0, 'rgba(255, 214, 150, ' + (0.42 * a).toFixed(3) + ')');
      g.addColorStop(0.45, 'rgba(240, 168, 92, ' + (0.16 * a).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(240, 168, 92, 0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, 6.2832); ctx.fill();

      ctx.strokeStyle = 'rgba(255, 214, 150, ' + (0.7 * a).toFixed(3) + ')';
      ctx.setLineDash([4, 4]);
      ctx.lineDashOffset = -clock * 10 * speed;
      ctx.beginPath();
      ctx.ellipse(c.x, c.y, r * 0.8, r * 0.48, -0.3, 0, 6.2832);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = '9px ui-monospace, Consolas, monospace';
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(255, 226, 176, ' + (0.9 * a).toFixed(3) + ')';
      ctx.fillText('甜点区 · 振幅异常', c.x + r * 0.55, c.y - r * 0.3);
    }

    function poseTarget() {
      var p = STATES[st.idx].pose;
      return {
        yaw: p.yaw + drag.yaw,
        pitch: clamp(p.pitch + drag.pitch, -1.0, -0.02),
        dist: p.dist + (drag.on ? 0 : Math.sin(clock * 0.25) * 0.06),
        ty: p.ty
      };
    }

    var lastState = -1;
    function drawFrame(dt) {
      var tgt = poseTarget();
      var k = 1 - Math.pow(0.0015, dt * speed);
      cam.yaw += (tgt.yaw - cam.yaw) * k;
      cam.pitch += (tgt.pitch - cam.pitch) * k;
      cam.dist += (tgt.dist - cam.dist) * k;
      cam.ty += (tgt.ty - cam.ty) * k;

      var m = STATES[st.idx].mix;
      ['panel', 'time', 'hor', 'fault', 'well', 'blob'].forEach(function (key) {
        mix[key] += (m[key] - mix[key]) * k;
      });
      intro = Math.min(1, intro + dt * 0.8);

      if (st.idx !== lastState) {
        lastState = st.idx;
        if (opts.onState) opts.onState(st.idx, STATES[st.idx]);
      }

      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.clearRect(0, 0, W, H);

      /* 背景：深青底 + 随状态偏暖 */
      var bg = ctx.createRadialGradient(W * 0.60, H * 0.42, 0, W * 0.60, H * 0.42, Math.max(W, H) * 0.75);
      bg.addColorStop(0, 'rgba(18, 82, 72, ' + (0.20 + 0.16 * mix.time).toFixed(3) + ')');
      bg.addColorStop(0.5, 'rgba(8, 34, 32, 0.30)');
      bg.addColorStop(1, 'rgba(3, 14, 14, 0)');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);

      /* 数据体棱线（很淡，只给空间感） */
      var E = [[-1, 0, -1], [1, 0, -1], [1, 0, 1], [-1, 0, 1], [-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1]];
      var EDGES = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
      ctx.strokeStyle = 'rgba(126, 214, 194, 0.16)';
      ctx.lineWidth = 1;
      for (var e = 0; e < EDGES.length; e++) {
        var A0 = E[EDGES[e][0]], A1 = E[EDGES[e][1]];
        var pa = project(A0[0], A0[1], A0[2], cam), pb = project(A1[0], A1[1], A1[2], cam);
        if (!pa || !pb) continue;
        ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
      }

      /* 三片切片：按景深从远到近画 */
      var list = PANELS.map(function (p) {
        var cpt = panelPoint(p.kind, 0.5, 0.5);
        var pr = project(cpt.x, cpt.y, cpt.z, cam);
        return { p: p, d: pr ? pr.z : 99 };
      }).sort(function (a, b) { return b.d - a.d; });

      list.forEach(function (item) {
        var kind = item.p.kind;
        var alpha = (kind === 'time' ? mix.time : mix.panel) * (0.30 + 0.70 * intro);
        if (alpha < 0.03) return;
        drawPanel(kind, item.p.tex, alpha, cam);
        panelFrame(kind, alpha, cam);
        panelLabel(kind, kind === 'inline' ? 'INLINE 1240' : kind === 'cross' ? 'CROSSLINE 880' : 'T2 SLICE · 2.4 s', alpha, cam);
      });

      /* 底面网格：给数据体一个「地板」，切片才不飘 */
      ctx.strokeStyle = 'rgba(126, 214, 194, 0.10)';
      ctx.lineWidth = 1;
      for (var fg = 0; fg <= 2; fg++) {
        var fu = fg / 2 * 2 - 1;
        var f1 = project(fu, 1, -1, cam), f2 = project(fu, 1, 1, cam);
        var f3 = project(-1, 1, fu, cam), f4 = project(1, 1, fu, cam);
        if (f1 && f2) { ctx.beginPath(); ctx.moveTo(f1.x, f1.y); ctx.lineTo(f2.x, f2.y); ctx.stroke(); }
        if (f3 && f4) { ctx.beginPath(); ctx.moveTo(f3.x, f3.y); ctx.lineTo(f4.x, f4.y); ctx.stroke(); }
      }

      /* 解释成果叠加：层位线 → 断面 → 井 → 甜点区 */
      drawHorizonTraces(cam);
      drawFault(cam);
      drawBlob(cam);
      drawWell(cam);

      /* 深度标尺（贴数据体左后棱） */
      var pTop = project(-1, 0, -1, cam), pBot = project(-1, 1, -1, cam);
      if (pTop && pBot) {
        var rx = Math.min(pTop.x, pBot.x) - 24;
        ctx.strokeStyle = 'rgba(150, 236, 210, 0.24)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(rx, pTop.y); ctx.lineTo(rx, pBot.y); ctx.stroke();
        ctx.font = '9px ui-monospace, Consolas, monospace';
        ctx.textAlign = 'right';
        [0, 0.33, 0.66, 1].forEach(function (f) {
          var yy = pTop.y + (pBot.y - pTop.y) * f;
          ctx.beginPath(); ctx.moveTo(rx - 4, yy); ctx.lineTo(rx, yy); ctx.stroke();
          ctx.fillStyle = 'rgba(150, 214, 198, 0.4)';
          ctx.fillText(Math.round(f * 3600) + ' m', rx - 7, yy + 3);
        });
      }

      /* 取景框 + 读数 */
      var mg = 18, LL = 15;
      ctx.strokeStyle = 'rgba(150, 214, 198, 0.2)';
      [[mg, mg, 1, 1], [W - mg, mg, -1, 1], [mg, H - mg, 1, -1], [W - mg, H - mg, -1, -1]].forEach(function (c2) {
        ctx.beginPath();
        ctx.moveTo(c2[0] + LL * c2[2], c2[1]);
        ctx.lineTo(c2[0], c2[1]);
        ctx.lineTo(c2[0], c2[1] + LL * c2[3]);
        ctx.stroke();
      });
      ctx.font = '9px ui-monospace, Consolas, monospace';
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(150, 214, 198, 0.45)';
      ctx.fillText('STATE ' + STATES[st.idx].no + ' · ' + STATES[st.idx].en, W - 26, H - 44);
      ctx.fillText('INLINE x=' + (-0.30).toFixed(2) + '  CROSSLINE z=0.30  T2=' + RES.y.toFixed(2), W - 26, H - 29);
      ctx.fillText('SYNTHETIC SECTION · 6 HORIZONS · 1 FAULT', W - 26, H - 15);

      /* 采集态的扫描线：语义是「正在采集/扫描」 */
      if (!calm && mix.hor < 0.5) {
        var sy = H * ((clock * 0.13) % 1);
        var sg = ctx.createLinearGradient(0, sy - 50, 0, sy + 50);
        sg.addColorStop(0, 'rgba(126, 232, 206, 0)');
        sg.addColorStop(0.5, 'rgba(126, 232, 206, 0.07)');
        sg.addColorStop(1, 'rgba(126, 232, 206, 0)');
        ctx.fillStyle = sg;
        ctx.fillRect(0, sy - 50, W, 100);
      }
    }

    function step(now) {
      if (!running) return;
      var dt = Math.min(50, now - last || 16) / 1000;
      last = now;
      clock += dt * speed;
      frames++;
      if (!paused) {
        st.t += dt * speed;
        if (st.t >= DWELL) { st.idx = (st.idx + 1) % STATES.length; st.t = 0; }
        if (opts.onProgress) opts.onProgress(clamp(st.t / DWELL, 0, 1));
      }
      drawFrame(dt);
      if (now - lastWatch > 1000) {
        if (frames < 2) { stop(); start(); }
        frames = 0; lastWatch = now;
      }
      raf = global.requestAnimationFrame(step);
    }
    function start() {
      if (running || paused) return;
      running = true; last = 0; frames = 0;
      lastWatch = (global.performance && performance.now()) || Date.now();
      raf = global.requestAnimationFrame(step);
    }
    function stop() {
      running = false;
      if (raf && global.cancelAnimationFrame) global.cancelAnimationFrame(raf);
      raf = null;
    }

    function onDown(ev) {
      drag.on = true; drag.x = ev.clientX; drag.y = ev.clientY;
      drag.yaw = 0; drag.pitch = 0;
      try { canvas.setPointerCapture(ev.pointerId); } catch (e) { }
      canvas.classList.add('grabbing');
    }
    function onMove(ev) {
      if (!drag.on) return;
      var dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      drag.x = ev.clientX; drag.y = ev.clientY;
      drag.yaw += dx * 0.006;
      drag.pitch = clamp(drag.pitch + dy * 0.004, -0.5, 0.35);
    }
    function onUp() {
      if (!drag.on) return;
      drag.on = false; drag.yaw = 0; drag.pitch = 0;
      canvas.classList.remove('grabbing');
    }
    function onVis() { if (global.document.hidden) stop(); else if (visible) start(); }

    resize();
    intro = 0;
    drawFrame(0.016);
    try {
      var probe = ctx.getImageData(Math.round(canvas.width / 2), Math.round(canvas.height / 2), 1, 1).data;
      mark(probe[3] > 4 ? 'fx-on' : 'fx-err');
    } catch (e) { mark('fx-on'); }
    if (opts.onState) opts.onState(0, STATES[0]);
    start();

    var io = null;
    if (global.IntersectionObserver) {
      io = new global.IntersectionObserver(function (es) {
        var en = es[0];
        if (!en) return;
        visible = en.isIntersecting || en.intersectionRatio > 0;
        if (visible && !global.document.hidden) start(); else stop();
      }, { threshold: 0.01 });
      try { io.observe(canvas); } catch (e) { }
    }
    global.document.addEventListener('visibilitychange', onVis);
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('pointerleave', onUp);
    var onResize = function () { resize(); drawFrame(0.016); };
    global.addEventListener('resize', onResize);
    var ro = null;
    if (global.ResizeObserver) {
      ro = new global.ResizeObserver(onResize);
      try { ro.observe(canvas); } catch (e) { }
    }

    var cur = { idx: 0, t: 0 };
    state = {
      pause: function () { paused = true; stop(); },
      resume: function () { paused = false; start(); },
      go: function (i) { st.idx = (i + STATES.length) % STATES.length; st.t = 0; if (opts.onState) opts.onState(st.idx, STATES[st.idx]); if (opts.onProgress) opts.onProgress(0); },
      next: function () { st.idx = (st.idx + 1) % STATES.length; st.t = 0; },
      running: function () { return running; },
      destroy: function () {
        stop();
        global.document.removeEventListener('visibilitychange', onVis);
        canvas.removeEventListener('pointerdown', onDown);
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerup', onUp);
        canvas.removeEventListener('pointercancel', onUp);
        canvas.removeEventListener('pointerleave', onUp);
        global.removeEventListener('resize', onResize);
        if (ro) { try { ro.disconnect(); } catch (e) { } }
        if (io) { try { io.disconnect(); } catch (e) { } }
      }
    };
  }

  function destroy() { if (state) { try { state.destroy(); } catch (e) { } state = null; } }

  function reveal(root) {
    root = root || global.document;
    var nodes = root.querySelectorAll('[data-rv]');
    if (!nodes.length) return;
    if (!global.IntersectionObserver || reduced()) {
      [].forEach.call(nodes, function (n) { n.classList.add('rv-in'); });
      return;
    }
    var io = new global.IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('rv-in'); io.unobserve(e.target); }
      });
    }, { threshold: 0.06, rootMargin: '0px 0px -6% 0px' });
    [].forEach.call(nodes, function (n) { io.observe(n); });
    global.setTimeout(function () {
      [].forEach.call(nodes, function (n) {
        var r = n.getBoundingClientRect();
        if (r.top < global.innerHeight && r.bottom > 0) n.classList.add('rv-in');
      });
    }, 1200);
  }

  global.FX = {
    hero: hero, destroy: destroy, reveal: reveal,
    go: function (i) { if (state && state.go) state.go(i); },
    pause: function () { if (state && state.pause) state.pause(); },
    resume: function () { if (state && state.resume) state.resume(); },
    running: function () { return !!(state && state.running && state.running()); },
    states: STATES
  };
})(window);
