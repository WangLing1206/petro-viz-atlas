/* =========================================================
   套管损伤智能识别 · 可运行示范（v2）
   ---------------------------------------------------------
   套管：5-1/2" 17 lb/ft（OD 139.7 mm、壁厚 7.72 mm、
         名义内径 124.0 mm、API 5CT 通径 121.1 mm）
   仪器：16 臂井径 + 成像展开，0.1 m 一个深度点
   损伤的物理方向：
     挤压   —— 两侧对称内缩（椭圆化），Dmin < 名义内径
     腐蚀   —— 内壁金属损失，局部扇区半径变大（读数 > 名义内径）
     穿孔   —— 0.3—0.5 m 窄段，1—2 支臂向外弹开
     错断   —— 井筒中心横向偏移：一侧变大、对侧变小
   指标同时看内缩、外扩、椭圆度与中心偏移，不再只盯“内缩”。
   ========================================================= */
(function () {
  'use strict';

  var ARMS = 16, NZ = 20000, DEPTH = 2000, DZ = DEPTH / NZ;   // 0.1 m / 点
  var R0 = 62.0;          // 名义内半径 mm
  var WALL = 7.72;        // mm
  var DRIFT = 121.1 / 2;  // 通径半径 mm
  var TH = [];
  for (var i = 0; i < ARMS; i++) TH.push(i * 2 * Math.PI / ARMS);

  var TYPES = [
    { key: 'all', name: '全部' },
    { key: 'corrosion', name: '腐蚀减薄' },
    { key: 'squeeze', name: '挤压变形' },
    { key: 'hole', name: '穿孔' },
    { key: 'shear', name: '错断' }
  ];

  var ZONES = [
    { type: 'corrosion', d0: 300, d1: 342 },
    { type: 'squeeze', d0: 760, d1: 842 },
    { type: 'hole', d0: 1180, d1: 1180.5 },
    { type: 'shear', d0: 1562, d1: 1592 }
  ];

  var state = { type: 'all', sev: 0.55, thr: 2.0, noise: true, cursor: 800, playing: false };

  var rnd = (function () { var a = 20261023; return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; })();

  function gauss() { return (rnd() + rnd() + rnd() + rnd() - 2) * 1.0; }
  function taper(t) { return 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, t))); }
  function edgeTaper(d, d0, d1, e) {
    if (d < d0 || d > d1) return 0;
    return Math.min(taper((d - d0) / e), taper((d1 - d) / e));
  }

  var armBias = [];
  for (var a = 0; a < ARMS; a++) armBias.push((rnd() - 0.5) * 0.30);

  /* ---------- 合成数据：grid[z][arm] = 半径 mm ---------- */
  function synth(sev, noise) {
    var grid = [];
    for (var z = 0; z < NZ; z++) {
      var row = [];
      for (var arm = 0; arm < ARMS; arm++) {
        var r = R0 + armBias[arm];
        if (noise) {
          r += gauss() * 0.12;
          r -= 0.25 * Math.cos(TH[arm] + 0.6);   // 仪器偏心
        }
        row.push(r);
      }
      grid.push(row);
    }

    ZONES.forEach(function (zn) {
      var A;
      if (zn.type === 'corrosion') A = 1.4 + 4.8 * sev;
      else if (zn.type === 'squeeze') A = 1.2 + 8.5 * sev;
      else if (zn.type === 'hole') A = 2.6 + 6.5 * sev;
      else A = 1.4 + 5.5 * sev;

      for (var z = 0; z < NZ; z++) {
        var d = z * DZ;
        if (d < zn.d0 - 0.2 || d > zn.d1 + 0.2) continue;

        if (zn.type === 'hole') {
          var on = edgeTaper(d, zn.d0, zn.d1, 0.08);
          for (var a1 = 0; a1 < ARMS; a1++) {
            if (a1 === 3 || a1 === 4) grid[z][a1] += A * on;
          }
          continue;
        }
        if (zn.type === 'shear') {
          var fs = Math.min(taper((d - zn.d0) / 0.3), taper((zn.d1 - d) / 0.3));
          for (var a2 = 0; a2 < ARMS; a2++) grid[z][a2] += A * fs * Math.cos(TH[a2]);
          continue;
        }
        if (zn.type === 'squeeze') {
          var fq = Math.min(taper((d - zn.d0) / 6), taper((zn.d1 - d) / 6));
          for (var a3 = 0; a3 < ARMS; a3++) {
            var inward = Math.max(0, Math.cos(2 * TH[a3]));
            grid[z][a3] -= A * fq * (0.15 + 0.85 * inward);
          }
          continue;
        }
        // 腐蚀：局部扇区向外（金属损失），沿深度缓慢过渡
        var fc = Math.min(taper((d - zn.d0) / 2), taper((zn.d1 - d) / 2));
        for (var a4 = 0; a4 < ARMS; a4++) {
          var dth = Math.abs(((TH[a4] - Math.PI / 2 + Math.PI) % (2 * Math.PI)) - Math.PI);
          grid[z][a4] += A * fc * Math.exp(-Math.pow(dth / 0.85, 2));
        }
      }
    });
    return grid;
  }

  /* ---------- 特征 ---------- */
  function features(grid) {
    var F = { davg: [], dmin: [], dmax: [], ov: [], devIn: [], devOut: [], off: [] };
    for (var z = 0; z < NZ; z++) {
      var row = grid[z], sum = 0, mn = 1e9, mx = -1e9, cx = 0, cy = 0;
      for (var a = 0; a < ARMS; a++) {
        var r = row[a];
        sum += r; if (r < mn) mn = r; if (r > mx) mx = r;
        cx += r * Math.cos(TH[a]); cy += r * Math.sin(TH[a]);
      }
      var avg = sum / ARMS;
      F.davg.push(avg); F.dmin.push(mn); F.dmax.push(mx);
      F.ov.push((mx - mn) / avg);
      F.devIn.push(Math.max(0, R0 - mn));
      F.devOut.push(Math.max(0, mx - R0));
      F.off.push(Math.hypot(cx / ARMS, cy / ARMS));
    }
    ['davg', 'dmin', 'dmax', 'ov', 'devIn', 'devOut', 'off'].forEach(function (k) {
      var s = F[k], o = [];
      for (var z2 = 0; z2 < NZ; z2++) {
        var lo = Math.max(0, z2 - 2), hi = Math.min(NZ - 1, z2 + 2), acc = 0;
        for (var q = lo; q <= hi; q++) acc += s[q];
        o.push(acc / (hi - lo + 1));
      }
      F[k] = o;
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
        if (e - s + 1 >= MINPTS) segs.push({ z0: s, z1: e });
      } else z2++;
    }

    segs.forEach(function (sg) {
      var width = (sg.z1 - sg.z0 + 1) * DZ;
      var peak = 0, ovs = 0, offs = 0, meanOut = 0, meanIn = 0;
      for (var q = sg.z0; q <= sg.z1; q++) {
        if (M[q] > peak) peak = M[q];
        ovs += F.ov[q]; offs += F.off[q];
      }
      ovs /= (sg.z1 - sg.z0 + 1);
      offs /= (sg.z1 - sg.z0 + 1);

      var devs = [];
      for (var a = 0; a < ARMS; a++) {
        var acc = 0;
        for (var q2 = sg.z0; q2 <= sg.z1; q2++) acc += GRID[q2][a] - R0;
        devs.push(acc / (sg.z1 - sg.z0 + 1));
      }
      var outArms = 0, inArms = 0;
      devs.forEach(function (dv) {
        if (dv > Math.max(0.5, peak * 0.35)) { outArms++; meanOut += dv; }
        if (dv < -Math.max(0.5, peak * 0.35)) { inArms++; meanIn -= dv; }
      });
      meanOut = outArms ? meanOut / outArms : 0;
      meanIn = inArms ? meanIn / inArms : 0;

      var type;
      if (width <= 1.2 && outArms >= 1 && outArms <= 3 && peak >= 1.2) type = 'hole';
      else if (offs >= 1.1 && width <= 45) type = 'shear';
      else if (outArms >= 4 && width >= 1.5 && meanOut >= 0.8) type = 'corrosion';
      else if (inArms >= 3) type = 'squeeze';
      else type = (F.devIn[sg.z0] > F.devOut[sg.z0]) ? 'squeeze' : 'corrosion';

      var grade, metric;
      if (type === 'corrosion' || type === 'hole') {
        var lossPct = peak / WALL * 100;
        grade = lossPct < 20 ? '轻' : lossPct < 50 ? '中' : '重';
        metric = '壁厚损失 ' + lossPct.toFixed(0) + '% · 峰值外扩 ' + peak.toFixed(1) + ' mm';
      } else if (type === 'squeeze') {
        var ovPct = ovs * 100;
        grade = ovPct < 3 ? '轻' : ovPct < 8 ? '中' : '重';
        metric = '椭圆度 ' + ovPct.toFixed(1) + '% · 峰值内缩 ' + peak.toFixed(1) + ' mm';
      } else {
        var offMm = offs * 2;
        grade = offMm < 2 ? '轻' : offMm < 5 ? '中' : '重';
        metric = '中心偏移 ' + offs.toFixed(1) + ' mm · 对侧内缩 ' + peak.toFixed(1) + ' mm';
      }

      sg.type = type; sg.grade = grade; sg.peak = peak; sg.width = width;
      sg.nArms = outArms + inArms; sg.outArms = outArms; sg.inArms = inArms;
      sg.step = offs; sg.ov = ovs; sg.metric = metric;
      sg.d0 = sg.z0 * DZ; sg.d1 = sg.z1 * DZ;
    });
    return segs;
  }

  var GRID = null;

  function score(segs, typeFilter) {
    var truth = ZONES.filter(function (zn) { return typeFilter === 'all' || zn.type === typeFilter; });
    var hit = 0, typeOk = 0;
    truth.forEach(function (zn) {
      var s = segs.filter(function (x) { return x.d0 <= zn.d1 + 1 && x.d1 >= zn.d0 - 1; })[0];
      if (s) { hit++; if (s.type === zn.type) typeOk++; }
    });
    var fp = segs.filter(function (s) {
      return !truth.some(function (zn) { return s.d0 <= zn.d1 + 1 && s.d1 >= zn.d0 - 1; });
    }).length;
    return { recall: truth.length ? hit / truth.length : 1, typeAcc: truth.length ? typeOk / truth.length : 1, fp: fp, truth: truth.length };
  }

  /* ---------- 绘图 ---------- */
  var cv = document.getElementById('log');
  var ctx = cv.getContext('2d');
  var Wc = 0, Hc = 470, DPR = Math.min(2, window.devicePixelRatio || 1);
  var G = {};
  var RMIN = 38, RMAX = 72;

  function layout() {
    Wc = cv.clientWidth || 640;
    cv.width = Math.round(Wc * DPR);
    cv.height = Math.round(Hc * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    G.L = 46; G.T = 16; G.B = 26; G.R = 10;
    var usable = Wc - G.L - G.R;
    G.curveW = Math.round(usable * 0.58);
    G.gap = 12;
    G.imgX = G.L + G.curveW + G.gap;
    G.imgW = Wc - G.R - G.imgX - 40;
    G.sx = function (r) { return G.L + (r - RMIN) / (RMAX - RMIN) * G.curveW; };
    G.sy = function (d) { return G.T + d / DEPTH * (Hc - G.T - G.B); };
    G.dy = function (y) { return (y - G.T) / (Hc - G.T - G.B) * DEPTH; };
  }

  var COL = {
    ink: '#16231f', ink3: '#6c7872', ink4: '#98a199', line: '#ddd4c1',
    jade: '#123b3a', arm: 'rgba(80,100,95,.42)', bad: '#9c4235', warn: '#a86a1f', ok: '#2f6b4f'
  };

  /* 发散色标：内缩→青，外扩→橙/红，名义内径→近白 */
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

  function draw(segs, F) {
    layout();
    ctx.clearRect(0, 0, Wc, Hc);
    ctx.fillStyle = '#fdfbf5';
    ctx.fillRect(G.L, G.T, G.curveW, Hc - G.T - G.B);
    ctx.fillRect(G.imgX, G.T, G.imgW, Hc - G.T - G.B);

    /* 成像展开图：64 列 × 下采样行 */
    var rows = 2400, stepZ = Math.max(1, Math.floor(NZ / rows));
    var off = document.createElement('canvas');
    off.width = 64; off.height = rows;
    var octx = off.getContext('2d');
    var imgd = octx.createImageData(64, rows);
    for (var zi = 0; zi < rows; zi++) {
      var z = Math.min(NZ - 1, zi * stepZ);
      for (var c = 0; c < 64; c++) {
        var ang = c / 64 * 2 * Math.PI;
        var f = ang / (2 * Math.PI) * ARMS, i0 = Math.floor(f) % ARMS, i1 = (i0 + 1) % ARMS, w = f - Math.floor(f);
        var r = GRID[z][i0] * (1 - w) + GRID[z][i1] * w;
        var col = ramp(r - R0);
        var p = (zi * 64 + c) * 4;
        imgd.data[p] = col[0]; imgd.data[p + 1] = col[1]; imgd.data[p + 2] = col[2]; imgd.data[p + 3] = 255;
      }
    }
    octx.putImageData(imgd, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, G.imgX, G.T, G.imgW, Hc - G.T - G.B);
    ctx.imageSmoothingEnabled = true;

    /* 色标 */
    var cbX = G.imgX + G.imgW + 8, cbW = 8;
    for (var yy = 0; yy < 120; yy++) {
      var devv = 8 - yy / 120 * 16;
      var cc = ramp(devv);
      ctx.fillStyle = 'rgb(' + cc.join(',') + ')';
      ctx.fillRect(cbX, G.T + yy, cbW, 1.2);
    }
    ctx.strokeStyle = COL.line; ctx.strokeRect(cbX, G.T, cbW, 120);
    ctx.fillStyle = COL.ink4; ctx.font = '8px ui-monospace,monospace'; ctx.textAlign = 'left';
    ctx.fillText('+8', cbX + cbW + 2, G.T + 8);
    ctx.fillText('0', cbX + cbW + 2, G.T + 62);
    ctx.fillText('-8', cbX + cbW + 2, G.T + 118);
    ctx.fillText('mm', cbX, G.T + 134);

    /* 深度刻度 */
    ctx.font = '9px ui-monospace, monospace';
    ctx.fillStyle = COL.ink4;
    ctx.strokeStyle = '#eee8da';
    ctx.textAlign = 'right';
    for (var d = 0; d <= DEPTH; d += 200) {
      var y = G.sy(d);
      ctx.beginPath(); ctx.moveTo(G.L, y); ctx.lineTo(G.imgX + G.imgW, y); ctx.stroke();
      ctx.fillText(d + ' m', G.L - 5, y + 3);
    }
    /* 半径刻度 */
    ctx.textAlign = 'center';
    for (var rr = RMIN; rr <= RMAX; rr += 5) {
      var xt = G.sx(rr);
      ctx.fillStyle = '#eee8da';
      ctx.beginPath(); ctx.moveTo(xt, G.T); ctx.lineTo(xt, Hc - G.B); ctx.stroke();
      ctx.fillStyle = COL.ink4;
      ctx.fillText(rr.toFixed(0), xt, Hc - G.B + 13);
    }
    ctx.fillText('半径 mm', G.L + G.curveW / 2, Hc - 6);

    /* 检出段 */
    segs.forEach(function (sg) {
      var y0 = G.sy(sg.d0), y1 = G.sy(sg.d1), hh = Math.max(3, y1 - y0);
      ctx.fillStyle = 'rgba(156,66,53,.08)';
      ctx.fillRect(G.L, y0, G.imgX + G.imgW - G.L, hh);
      ctx.strokeStyle = 'rgba(156,66,53,.6)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(G.L, y0); ctx.lineTo(G.imgX + G.imgW, y0);
      ctx.moveTo(G.L, y1); ctx.lineTo(G.imgX + G.imgW, y1);
      ctx.stroke();
      ctx.fillStyle = COL.bad;
      ctx.textAlign = 'left';
      ctx.font = '9px ui-monospace, monospace';
      ctx.fillText(NAME_OF(sg.type) + ' ' + sg.grade + ' · ' + sg.d0.toFixed(1) + '—' + sg.d1.toFixed(1) + ' m', G.L + 4, Math.max(10, y0 - 3));
    });

    /* 16 条曲线（下采样绘制） */
    var stepD = Math.max(1, Math.floor(NZ / 2600));
    ctx.lineWidth = 1;
    for (var a = 0; a < ARMS; a++) {
      ctx.strokeStyle = COL.arm;
      ctx.beginPath();
      for (var z3 = 0; z3 < NZ; z3 += stepD) {
        var x = G.sx(GRID[z3][a]), y2 = G.sy(z3 * DZ);
        if (z3 === 0) ctx.moveTo(x, y2); else ctx.lineTo(x, y2);
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

    /* 通径线（API 5CT） */
    ctx.strokeStyle = 'rgba(168,106,31,.55)';
    ctx.setLineDash([2, 4]);
    ctx.beginPath(); ctx.moveTo(G.sx(DRIFT), G.T); ctx.lineTo(G.sx(DRIFT), Hc - G.B); ctx.stroke();
    ctx.setLineDash([]);

    /* 游标 */
    var cy = G.sy(state.cursor);
    ctx.strokeStyle = COL.warn;
    ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(G.L, cy); ctx.lineTo(G.imgX + G.imgW, cy); ctx.stroke();
    ctx.fillStyle = COL.warn;
    ctx.beginPath(); ctx.moveTo(G.L, cy - 4); ctx.lineTo(G.L + 7, cy); ctx.lineTo(G.L, cy + 4); ctx.closePath(); ctx.fill();
    ctx.lineWidth = 1;
    ctx.textAlign = 'left';
    ctx.fillStyle = COL.warn;
    ctx.font = '9.5px ui-monospace, monospace';
    ctx.fillText(state.cursor.toFixed(0) + ' m', G.L + 10, cy - 4);
  }

  var NAME = { corrosion: '腐蚀减薄', squeeze: '挤压变形', hole: '穿孔', shear: '错断' };
  function NAME_OF(k) { return NAME[k] || k; }

  /* ---------- 截面图 ---------- */
  function drawSect(F) {
    var z = Math.max(0, Math.min(NZ - 1, Math.round(state.cursor / DZ)));
    var k = 1.1;
    var s = '<circle cx="100" cy="100" r="76" fill="#fff" stroke="#ddd4c1"/>';
    s += '<circle cx="100" cy="100" r="' + (R0 * k) + '" fill="none" stroke="#123b3a" stroke-width="1" stroke-dasharray="4 3"/>';
    s += '<circle cx="100" cy="100" r="' + (DRIFT * k) + '" fill="none" stroke="#b4762a" stroke-width=".8" stroke-dasharray="2 4" opacity=".7"/>';
    var pts = [], dp = '';
    for (var a = 0; a < ARMS; a++) {
      var r = GRID[z][a] * k;
      var x = 100 + r * Math.cos(TH[a] - Math.PI / 2), y = 100 + r * Math.sin(TH[a] - Math.PI / 2);
      pts.push([x, y]);
      dp += (a ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
    }
    s += '<path d="' + dp + ' Z" fill="rgba(18,59,58,.06)" stroke="#4f6066" stroke-width="1.2"/>';
    pts.forEach(function (p) { s += '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="2" fill="#6c7872"/>'; });
    var dmin = F.dmin[z], dmax = F.dmax[z], davg = F.davg[z];
    var imin = 0, imax = 0;
    for (var q = 1; q < ARMS; q++) { if (GRID[z][q] < GRID[z][imin]) imin = q; if (GRID[z][q] > GRID[z][imax]) imax = q; }
    function ray(idx, col, label, up) {
      var an = TH[idx] - Math.PI / 2, rr = GRID[z][idx] * k;
      var x2 = 100 + rr * Math.cos(an), y2 = 100 + rr * Math.sin(an);
      return '<line x1="100" y1="100" x2="' + x2.toFixed(1) + '" y2="' + y2.toFixed(1) + '" stroke="' + col + '" stroke-width="1.1"/>' +
        '<text x="' + (100 + (rr + 16) * Math.cos(an)).toFixed(1) + '" y="' + (100 + (rr + 16) * Math.sin(an) + (up ? -1 : 7)).toFixed(1) + '" font-size="8.5" fill="' + col + '" text-anchor="middle" paint-order="stroke" stroke="#fdfbf5" stroke-width="3">' + label + '</text>';
    }
    s += ray(imax, '#a86a1f', 'Dmax ' + (dmax * 2).toFixed(1), true);
    s += ray(imin, '#123b3a', 'Dmin ' + (dmin * 2).toFixed(1), false);
    s += '<text x="100" y="14" font-size="9" fill="#45524d" text-anchor="middle" font-family="monospace">平均内径 ' + (davg * 2).toFixed(1) + ' mm</text>';
    s += '<text x="100" y="188" font-size="9" fill="#6c7872" text-anchor="middle" font-family="monospace">椭圆度 ' + (F.ov[z] * 100).toFixed(1) + '% · 中心偏移 ' + F.off[z].toFixed(1) + ' mm</text>';
    document.getElementById('sect').innerHTML = s;
    document.getElementById('sect-hint').textContent = (z * DZ).toFixed(1) + ' m';
    document.getElementById('cursor-hint').textContent = '深度 ' + state.cursor.toFixed(1) + ' m';
  }

  /* ---------- 小多图：四类损伤的截面指纹 ---------- */
  var SIGCOL = { corrosion: '#a86a1f', squeeze: '#123b3a', hole: '#9c4235', shear: '#2b5570' };
  function drawSignatures() {
    var wrap = document.getElementById('sig');
    if (!wrap) return;
    var html = ZONES.map(function (zn) {
      var z = Math.max(0, Math.min(NZ - 1, Math.round(((zn.d0 + zn.d1) / 2) / DZ)));
      var k = 0.78, cx0 = 60, cy0 = 60, d = '', cx = 0, cy = 0;
      for (var a = 0; a < ARMS; a++) {
        var r = GRID[z][a] * k;
        var x = cx0 + r * Math.cos(TH[a] - Math.PI / 2), y = cy0 + r * Math.sin(TH[a] - Math.PI / 2);
        d += (a ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
        cx += GRID[z][a] * Math.cos(TH[a]); cy += GRID[z][a] * Math.sin(TH[a]);
      }
      cx = cx0 + (cx / ARMS) * k; cy = cy0 + (cy / ARMS) * k;
      var col = SIGCOL[zn.type];
      var seg = ALLSEGS.filter(function (s) { return s.type === zn.type; })[0];
      var grade = seg ? seg.grade : '—';
      var svg = '<svg viewBox="0 0 120 120" role="img" aria-label="' + NAME_OF(zn.type) + '截面">' +
        '<circle cx="60" cy="60" r="' + (R0 * k).toFixed(1) + '" fill="none" stroke="#cbbfa7" stroke-width="1" stroke-dasharray="4 3"/>' +
        '<path d="' + d + ' Z" fill="' + col + '" fill-opacity=".10" stroke="' + col + '" stroke-width="1.5"/>' +
        '<circle cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="2" fill="' + col + '"/>' +
        '<path d="M60 60L' + cx.toFixed(1) + ' ' + cy.toFixed(1) + '" stroke="' + col + '" stroke-width="1" stroke-dasharray="2 2"/>' +
        '<circle cx="60" cy="60" r="1.6" fill="#45524d"/>' +
        '<text x="60" y="116" text-anchor="middle" font-size="8" font-family="monospace" fill="#98a199">' + zn.d0.toFixed(0) + '—' + zn.d1.toFixed(0) + ' m</text>' +
        '</svg>';
      return '<button class="sig' + (state.type === zn.type ? ' on' : '') + '" type="button" data-t="' + zn.type + '" aria-label="' + NAME_OF(zn.type) + '">' +
        svg + '<span class="st">' + NAME_OF(zn.type) + ' · ' + grade + '</span></button>';
    }).join('');
    wrap.innerHTML = html;
    [].forEach.call(wrap.querySelectorAll('[data-t]'), function (b) {
      b.addEventListener('click', function () {
        var t = b.getAttribute('data-t');
        var zn = ZONES.filter(function (x) { return x.type === t; })[0];
        state.type = t;
        state.cursor = (zn.d0 + zn.d1) / 2;
        [].forEach.call(el('seg-type').children, function (x) { x.classList.toggle('on', x.getAttribute('data-t') === t); });
        render();
      });
    });
  }

  /* ---------- 渲染 ---------- */
  var el = function (id) { return document.getElementById(id); };
  var ALLSEGS = [];

  function render() {
    GRID = synth(state.sev, state.noise);
    var F = features(GRID);
    ALLSEGS = detect(F, state.thr).sort(function (a, b) { return b.peak - a.peak; });
    var shown = state.type === 'all' ? ALLSEGS : ALLSEGS.filter(function (s) { return s.type === state.type; });
    var sc = score(shown, state.type);

    draw(shown, F);
    drawSect(F);
    drawSignatures();

    el('st-n').textContent = shown.length;
    el('st-recall').innerHTML = Math.round(sc.recall * 100) + '<small>%</small>';
    el('st-fp').textContent = sc.fp;
    el('st-time').innerHTML = (12 + shown.length * 1.2).toFixed(0) + '<small>min</small>';

    el('hits').innerHTML = shown.length ? shown.map(function (s, i) {
      return '<div class="hit" data-d="' + s.d0.toFixed(1) + '">' +
        '<div><div class="d">' + s.d0.toFixed(1) + '—' + s.d1.toFixed(1) + ' m<span class="db ' + (s.grade === '重' ? 'bad' : s.grade === '中' ? 'warn' : 'ok') + '" style="margin-left:6px">' + NAME_OF(s.type) + ' ' + s.grade + '</span></div>' +
        '<div class="m">' + s.metric + ' · 段长 ' + s.width.toFixed(1) + ' m · 受影响臂 ' + s.nArms + ' 条（外 ' + s.outArms + ' / 内 ' + s.inArms + '）</div></div>' +
        '<div class="r mono" style="font-size:11px;color:var(--ink-3)">#' + (i + 1) + '</div></div>';
    }).join('') : '<p style="font-size:11.5px;color:var(--ink-4);padding:8px 0">当前阈值下没有检出损伤段。</p>';

    [].forEach.call(el('hits').querySelectorAll('[data-d]'), function (n) {
      n.addEventListener('click', function () {
        [].forEach.call(el('hits').querySelectorAll('.hit'), function (h) { h.classList.toggle('sel', h === n); });
        state.cursor = Number(n.getAttribute('data-d')) + Math.min(5, (DEPTH - Number(n.getAttribute('data-d'))) / 2);
        drawSect(F);
        draw(shown, F);
      });
    });

    var maxIn = Math.max.apply(null, F.devIn), maxOut = Math.max.apply(null, F.devOut), maxOff = Math.max.apply(null, F.off);
    el('feats').innerHTML =
      row('套管规格', '5-1/2" 17# · ID 124.0 mm') +
      row('壁厚 / 通径', WALL.toFixed(2) + ' mm / ' + (DRIFT * 2).toFixed(1) + ' mm') +
      row('最大内缩 / 外扩', maxIn.toFixed(1) + ' / ' + maxOut.toFixed(1) + ' mm') +
      row('最大椭圆度 / 中心偏移', (Math.max.apply(null, F.ov) * 100).toFixed(1) + '% / ' + maxOff.toFixed(1) + ' mm') +
      row('检出阈值', state.thr.toFixed(1) + ' mm 等效偏差') +
      row('真值损伤段', sc.truth + ' 段（合成数据）') +
      row('判据', '偏差 ≥ 阈值且持续 ≥ 0.3 m');

    el('note').innerHTML = state.type === 'all'
      ? '四种损伤的物理方向不同：<b>腐蚀</b>让局部扇区的内径<b>变大</b>（金属损失），<b>挤压</b>让两侧对称<b>内缩</b>并抬高椭圆度，<b>穿孔</b>只在 0.3—0.5 m 窄段让 1—2 支臂<b>向外弹开</b>，<b>错断</b>表现为井筒中心横向偏移（一侧变大、对侧变小）。把阈值调到 4 mm 以上，穿孔和轻度腐蚀会漏掉；调到 1 mm 以下，仪器偏心与噪声开始产生假段——这就是人工判读要拿捏的尺度。'
      : '当前只显示 <b>' + NAME_OF(state.type) + '</b> 的检出结果，但数据里仍有其它三类损伤，算法也在同一条曲线上工作。注意「受影响臂数」与「中心偏移」：它们是把局部金属损失、整体变形与错断区分开的关键。';
  }

  function row(k, v) {
    return '<div style="display:flex;justify-content:space-between;gap:10px;font-size:11px;padding:5px 0;border-bottom:1px solid var(--line)">' +
      '<span style="color:var(--ink-3)">' + k + '</span><span class="mono" style="color:var(--ink-2);text-align:right">' + v + '</span></div>';
  }

  /* ---------- 交互 ---------- */
  el('seg-type').innerHTML = TYPES.map(function (t) {
    return '<button data-t="' + t.key + '" class="' + (t.key === 'all' ? 'on' : '') + '">' + t.name + '</button>';
  }).join('');
  el('seg-type').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    state.type = b.getAttribute('data-t');
    [].forEach.call(el('seg-type').children, function (x) { x.classList.toggle('on', x === b); });
    render();
  });

  var rSev = el('r-sev'), rThr = el('r-thr');
  rSev.addEventListener('input', function () {
    state.sev = Number(rSev.value);
    el('o-sev').textContent = state.sev.toFixed(2);
    render();
  });
  rThr.addEventListener('input', function () {
    state.thr = Number(rThr.value);
    el('o-thr').textContent = state.thr.toFixed(1) + ' mm';
    render();
  });

  var togNoise = el('tog-noise');
  togNoise.setAttribute('role', 'switch');
  togNoise.setAttribute('aria-checked', 'true');
  togNoise.setAttribute('tabindex', '0');
  function toggleNoise() {
    state.noise = !state.noise;
    togNoise.classList.toggle('on', state.noise);
    togNoise.setAttribute('aria-checked', state.noise ? 'true' : 'false');
    render();
  }
  togNoise.addEventListener('click', toggleNoise);
  togNoise.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleNoise(); } });

  var reset = el('btn-reset');
  if (reset) reset.addEventListener('click', function () {
    state.type = 'all'; state.sev = 0.55; state.thr = 2.0; state.noise = true; state.cursor = 800;
    rSev.value = '0.55'; el('o-sev').textContent = '0.55';
    rThr.value = '2.0'; el('o-thr').textContent = '2.0 mm';
    togNoise.classList.add('on'); togNoise.setAttribute('aria-checked', 'true');
    [].forEach.call(el('seg-type').children, function (x) { x.classList.toggle('on', x.getAttribute('data-t') === 'all'); });
    render();
  });

  function updateCursor(e) {
    var r = cv.getBoundingClientRect();
    var y = e.clientY - r.top;
    if (y < G.T || y > Hc - G.B) return;
    state.cursor = Math.max(0, Math.min(DEPTH, G.dy(y)));
    drawSect(features(GRID));
    var shown = state.type === 'all' ? ALLSEGS : ALLSEGS.filter(function (s) { return s.type === state.type; });
    draw(shown, features(GRID));
  }
  cv.addEventListener('pointermove', updateCursor);
  cv.addEventListener('pointerdown', updateCursor);

  var playTimer = null;
  el('play').addEventListener('click', function () {
    if (state.playing) {
      state.playing = false;
      clearInterval(playTimer);
      el('play').textContent = '▶ 逐段判读';
      return;
    }
    state.playing = true;
    el('play').textContent = '■ 停止';
    state.cursor = 0;
    var F = features(GRID);
    var shown = state.type === 'all' ? ALLSEGS : ALLSEGS.filter(function (s) { return s.type === state.type; });
    playTimer = setInterval(function () {
      state.cursor += 4;
      if (state.cursor >= DEPTH) {
        state.cursor = DEPTH;
        clearInterval(playTimer);
        state.playing = false;
        el('play').textContent = '▶ 逐段判读';
      }
      drawSect(F);
      draw(shown, F);
    }, 30);
  });

  render();
})();
