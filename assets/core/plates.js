/* =========================================================
   案例图版 Case Plates · v2
   ---------------------------------------------------------
   每张封面都按该案例自己的数据结构画出来：示功图族、甘特、
   帕累托前沿、井径展开、负压波定位……统一纸色 / 墨线 / 黄铜。
   16:9，480×270 坐标，内联 SVG，离线可用。
   window.Plate.of(caseId) -> '<svg …>'
   ========================================================= */
(function (global) {
  'use strict';

  var C = {
    paper: '#f8f3e8',
    grid: 'rgba(27,42,38,.07)',
    ink: '#16231f',
    ink2: '#4c5a54',
    ink3: '#8a948c',
    jade: '#123b3a',
    brass: '#a86a1f',
    brassL: '#c99243',
    bad: '#983e31',
    line: 'rgba(27,42,38,.24)'
  };
  var MONO = "'JetBrains Mono','Cascadia Mono',Consolas,monospace";
  var SANS = "'Inter','Segoe UI','Microsoft YaHei UI','PingFang SC',sans-serif";

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function frame(inner, label, unit) {
    var grid = '';
    for (var x = 40; x < 480; x += 40) grid += '<path d="M' + x + ' 0v270" stroke="' + C.grid + '"/>';
    for (var y = 30; y < 270; y += 30) grid += '<path d="M0 ' + y + 'h480" stroke="' + C.grid + '"/>';
    return '<svg viewBox="0 0 480 270" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="' + esc(label) + '">' +
      '<rect width="480" height="270" fill="' + C.paper + '"/>' + grid +
      '<path d="M14 30V14h16M450 14h16v16M14 240v16h16M450 256h16v-16" fill="none" stroke="' + C.ink3 + '" stroke-width="1.1" opacity=".65"/>' +
      inner +
      '<text x="16" y="262" font-family="' + MONO + '" font-size="10" fill="' + C.ink3 + '" letter-spacing=".8">' + esc(label) + '</text>' +
      '<text x="464" y="262" text-anchor="end" font-family="' + MONO + '" font-size="10" fill="' + C.ink3 + '" letter-spacing=".8">' + esc(unit || '') + '</text>' +
      '</svg>';
  }

  function axis(x1, y1, x2, y2, xt, yt) {
    var s = '<path d="M' + x1 + ' ' + y1 + 'V' + y2 + 'H' + x2 + '" fill="none" stroke="' + C.ink + '" stroke-width="1.1" opacity=".8"/>';
    for (var i = 1; i <= 4; i++) {
      var yy = y2 - (y2 - y1) * i / 5;
      s += '<path d="M' + (x1 - 3) + ' ' + yy + 'h3" stroke="' + C.line + '"/>';
    }
    for (var j = 1; j <= 5; j++) {
      var xx = x1 + (x2 - x1) * j / 6;
      s += '<path d="M' + xx + ' ' + y2 + 'v3" stroke="' + C.line + '"/>';
    }
    if (xt) s += '<text x="' + ((x1 + x2) / 2) + '" y="' + (y2 + 13) + '" text-anchor="middle" font-family="' + SANS + '" font-size="11.5" fill="' + C.ink3 + '">' + esc(xt) + '</text>';
    if (yt) s += '<text x="' + (x1 - 6) + '" y="' + ((y1 + y2) / 2) + '" text-anchor="middle" font-family="' + SANS + '" font-size="11.5" fill="' + C.ink3 + '" transform="rotate(-90 ' + (x1 - 6) + ' ' + ((y1 + y2) / 2) + ')">' + esc(yt) + '</text>';
    return s;
  }

  function pathFrom(pts) {
    return pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join('');
  }

  /* ---------------- 01 测井分层 ---------------- */
  function welllog() {
    var tracks = [
      { x: 34, w: 128, name: 'GR', color: C.jade },
      { x: 176, w: 128, name: 'RT', color: C.brass },
      { x: 318, w: 128, name: 'DEN', color: C.ink2 }
    ];
    var s = '';
    tracks.forEach(function (t, ti) {
      s += '<rect x="' + t.x + '" y="34" width="' + t.w + '" height="196" fill="none" stroke="' + C.line + '"/>';
      s += '<text x="' + (t.x + 2) + '" y="29" font-family="' + MONO + '" font-size="11.5" fill="' + C.ink3 + '">' + t.name + '</text>';
      var pts = [];
      for (var i = 0; i <= 100; i++) {
        var yy = 34 + i / 100 * 196;
        var v = Math.sin(i * .11 + ti * 2.1) * .5 + Math.sin(i * .043 + ti) * .38 + Math.sin(i * .31 + ti * 1.7) * .12;
        var x = t.x + 8 + (v + 1) / 2 * (t.w - 16);
        pts.push([x, yy]);
      }
      s += '<path d="' + pathFrom(pts) + '" fill="none" stroke="' + t.color + '" stroke-width="1.3" opacity=".95"/>';
    });
    var layers = [78, 120, 166, 200];
    layers.forEach(function (y, i) {
      s += '<path d="M28 ' + y + 'H452" stroke="' + C.brass + '" stroke-width="1" stroke-dasharray="4 4" opacity=".85"/>';
      s += '<rect x="456" y="' + (y - 8) + '" width="18" height="14" fill="' + C.paper + '" stroke="' + C.line + '"/>';
      s += '<text x="465" y="' + (y + 3) + '" text-anchor="middle" font-family="' + MONO + '" font-size="10.5" fill="' + C.ink2 + '">' + (i + 1) + '</text>';
    });
    s += '<text x="34" y="242" font-family="' + MONO + '" font-size="10.5" fill="' + C.ink3 + '">0 m</text>' +
      '<text x="162" y="242" text-anchor="end" font-family="' + MONO + '" font-size="10.5" fill="' + C.ink3 + '">3000 m</text>';
    return frame(s, '测井曲线 · 智能分层', '8 界面 / 42 井');
  }

  /* ---------------- 02 修井方案（知识图谱） ---------------- */
  function planKG() {
    var nodes = [
      [214, 132, 24, '井况', C.jade],
      [120, 70, 16, '落物', C.ink2],
      [310, 66, 16, '套管', C.ink2],
      [112, 196, 16, '压力', C.ink2],
      [312, 198, 16, '产量', C.ink2],
      [214, 48, 13, '井史', C.brass],
      [214, 218, 13, '工具', C.brass]
    ];
    var edges = [[0, 1], [0, 2], [0, 3], [0, 4], [5, 0], [0, 6], [1, 3], [2, 4]];
    var s = '';
    edges.forEach(function (e) {
      var a = nodes[e[0]], b = nodes[e[1]];
      s += '<path d="M' + a[0] + ' ' + a[1] + 'L' + b[0] + ' ' + b[1] + '" stroke="' + C.line + '" stroke-width="1"/>';
    });
    nodes.forEach(function (n) {
      s += '<circle cx="' + n[0] + '" cy="' + n[1] + '" r="' + n[2] + '" fill="' + C.paper + '" stroke="' + n[4] + '" stroke-width="1.4"/>';
      s += '<text x="' + n[0] + '" y="' + (n[1] + 4) + '" text-anchor="middle" font-family="' + SANS + '" font-size="11.5" fill="' + n[4] + '">' + n[3] + '</text>';
    });
    s += '<rect x="350" y="104" width="112" height="78" fill="' + C.paper + '" stroke="' + C.line + '"/>' +
      '<text x="358" y="120" font-family="' + MONO + '" font-size="9.5" fill="' + C.ink3 + '">TOP MATCH</text>' +
      '<text x="358" y="137" font-family="' + SANS + '" font-size="12.5" fill="' + C.ink + '">磨铣 + 套铣</text>' +
      '<text x="358" y="152" font-family="' + SANS + '" font-size="11.5" fill="' + C.ink2 + '">套管内落物</text>' +
      '<text x="358" y="169" font-family="' + MONO + '" font-size="10" fill="' + C.brass + '">0.87 · 12 例</text>';
    return frame(s, '知识图谱 · 方案检索', '1200 井次');
  }

  /* ---------------- 03 修井周期（甘特） ---------------- */
  function gantt() {
    var rows = ['搬安', '起原井', '打捞', '通井', '下新管', '试压', '交井'];
    var s = '';
    rows.forEach(function (r, i) {
      var y = 48 + i * 25;
      s += '<text x="46" y="' + (y + 8) + '" text-anchor="end" font-family="' + SANS + '" font-size="11.5" fill="' + C.ink2 + '">' + r + '</text>';
    });
    var bars = [[0, 24], [20, 30], [44, 28], [58, 20], [70, 26], [88, 7], [94, 5]];
    bars.forEach(function (b, i) {
      var y = 42 + i * 25;
      s += '<rect x="' + (54 + b[0] * 4) + '" y="' + y + '" width="' + (b[1] * 4) + '" height="12" fill="' + (i === 2 ? C.brass : C.jade) + '" opacity=".92"/>';
    });
    s += axis(54, 218, 432, 218, '工期 (天)', '');
    s += '<rect x="54" y="230" width="230" height="6" fill="' + C.jade + '" opacity=".16"/>' +
      '<rect x="100" y="230" width="186" height="6" fill="' + C.jade + '" opacity=".3"/>' +
      '<rect x="148" y="230" width="138" height="6" fill="' + C.brass + '"/>' +
      '<text x="54" y="250" font-family="' + MONO + '" font-size="9.5" fill="' + C.ink3 + '">P10 6.2d</text>' +
      '<text x="286" y="250" text-anchor="middle" font-family="' + MONO + '" font-size="9.5" fill="' + C.ink3 + '">P50 9.4d</text>' +
      '<text x="432" y="250" text-anchor="end" font-family="' + MONO + '" font-size="9.5" fill="' + C.ink3 + '">P90 14.8d</text>';
    return frame(s, '修井甘特 · 七道工序', 'P50 / P80 / 蒙特卡洛');
  }

  /* ---------------- 04 打捞工具矩阵 ---------------- */
  function tools() {
    var s = '';
    var names = ['卡瓦筒', '强磁', '公锥', '母锥', '磨鞋', '震击器', '套铣筒', '一把抓'];
    for (var i = 0; i < 8; i++) {
      var cx = 72 + (i % 4) * 100, cy = 78 + Math.floor(i / 4) * 96;
      var hi = i === 1;
      s += '<rect x="' + (cx - 38) + '" y="' + (cy - 30) + '" width="76" height="62" fill="' + (hi ? 'rgba(168,106,31,.09)' : 'none') + '" stroke="' + (hi ? C.brass : C.line) + '"' + (hi ? ' stroke-width="1.4"' : '') + '/>';
      s += '<g stroke="' + (hi ? C.brass : C.ink2) + '" stroke-width="1.4" fill="none">' +
        '<path d="M' + (cx - 4) + ' ' + (cy - 20) + 'v9M' + (cx + 4) + ' ' + (cy - 20) + 'v9"/>' +
        '<rect x="' + (cx - 8) + '" y="' + (cy - 11) + '" width="16" height="22" rx="2"/>' +
        '<path d="M' + (cx - 11) + ' ' + (cy + 10) + 'h22M' + (cx - 9) + ' ' + (cy + 15) + 'h18"/>' +
        '</g>';
      s += '<text x="' + cx + '" y="' + (cy + 26) + '" text-anchor="middle" font-family="' + SANS + '" font-size="10.5" fill="' + (hi ? C.brass : C.ink3) + '">' + names[i] + '</text>';
      if (hi) s += '<circle cx="' + (cx + 29) + '" cy="' + (cy - 24) + '" r="2.6" fill="' + C.brass + '"/>';
    }
    return frame(s, '打捞工具 · 落物匹配', '8 类工具 / 93% 一次成功');
  }

  /* ---------------- 05 压裂优化（帕累托） ---------------- */
  function pareto() {
    var s = axis(52, 48, 452, 222, '排量 (m³/min)', '净现值');
    var pts = [];
    for (var i = 0; i < 40; i++) {
      var t = i / 39;
      var x = 68 + t * 360 + Math.sin(i * 2.7) * 13;
      var y = 206 - Math.pow(t, .72) * 148 + Math.cos(i * 1.9) * 11;
      pts.push([x, y, i % 8 === 0]);
    }
    pts.forEach(function (p) {
      s += '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="' + (p[2] ? 3 : 2) + '" fill="' + (p[2] ? C.brass : C.jade) + '" opacity="' + (p[2] ? .95 : .45) + '"/>';
    });
    var front = [[72, 204], [118, 186], [168, 164], [226, 140], [288, 116], [354, 94], [420, 80]];
    s += '<path d="' + pathFrom(front) + '" fill="none" stroke="' + C.brass + '" stroke-width="1.4" stroke-dasharray="4 3"/>';
    s += '<circle cx="354" cy="94" r="4.5" fill="none" stroke="' + C.brass + '" stroke-width="1.4"/>';
    s += '<text x="354" y="82" text-anchor="middle" font-family="' + MONO + '" font-size="9.5" fill="' + C.brass + '">#27 推荐</text>';
    s += '<text x="72" y="62" font-family="' + SANS + '" font-size="10.5" fill="' + C.ink3 + '">每个点 = 一次候选设计</text>';
    return frame(s, '压裂优化 · 代理模型 + 贝叶斯', '+22% NPV / 19 次迭代');
  }

  /* ---------------- 06 气测（色谱 + 全烃） ---------------- */
  function gas() {
    var s = '';
    var comps = [['C1', 96, .92], ['C2', 58, .6], ['C3', 36, .42], ['iC4', 22, .28], ['nC4', 25, .31], ['C5', 12, .18]];
    comps.forEach(function (c, i) {
      var x = 52 + i * 42;
      var h = c[1];
      s += '<rect x="' + x + '" y="' + (232 - h) + '" width="26" height="' + h + '" fill="' + (i < 2 ? C.brass : C.jade) + '" opacity=".88"/>';
      s += '<text x="' + (x + 13) + '" y="244" text-anchor="middle" font-family="' + MONO + '" font-size="10" fill="' + C.ink2 + '">' + c[0] + '</text>';
      s += '<text x="' + (x + 13) + '" y="' + (232 - h - 4) + '" text-anchor="middle" font-family="' + MONO + '" font-size="9" fill="' + C.ink3 + '">' + c[1] + '</text>';
    });
    var pts = [];
    for (var i = 0; i <= 70; i++) {
      var t = i / 70;
      var yy = 140 - Math.exp(-Math.pow((t - .4) / .09, 2)) * 48 - Math.exp(-Math.pow((t - .68) / .06, 2)) * 18 + Math.sin(i * .7) * 1.6;
      pts.push([306 + t * 148, yy]);
    }
    s += '<path d="' + pathFrom(pts) + '" fill="none" stroke="' + C.ink + '" stroke-width="1.5"/>';
    s += '<path d="M306 186H454" stroke="' + C.line + '" stroke-dasharray="3 3"/>';
    s += '<text x="306" y="58" font-family="' + MONO + '" font-size="9.5" fill="' + C.ink3 + '">TOTAL GAS</text>';
    s += '<text x="306" y="80" font-family="' + MONO + '" font-size="22.5" fill="' + C.ink + '">2.84<tspan font-size="11.5" fill="' + C.ink3 + '"> %</tspan></text>';
    s += '<rect x="300" y="44" width="160" height="158" fill="none" stroke="' + C.line + '"/>';
    s += '<text x="306" y="206" font-family="' + SANS + '" font-size="10.5" fill="' + C.ink3 + '">C1/C3 = 8.4 · 气层</text>';
    return frame(s, '气测录井 · 组分比值', 'C1/C3 = 8.4 / 气层');
  }

  /* ---------------- 07 管道泄漏（负压波） ---------------- */
  function leak() {
    var s = '';
    s += '<path d="M44 74H436" stroke="' + C.ink + '" stroke-width="6" opacity=".14"/>';
    s += '<path d="M44 74H436" stroke="' + C.ink + '" stroke-width="1.5"/>';
    s += '<path d="M44 68v12M436 68v12" stroke="' + C.ink + '" stroke-width="1.8"/>';
    s += '<circle cx="292" cy="74" r="3.4" fill="' + C.bad + '"/>' +
      '<path d="M292 68c-6-6-11-8-11-14M292 68c6-6 11-8 11-14" fill="none" stroke="' + C.bad + '" stroke-width=".9" opacity=".7"/>';
    s += '<text x="292" y="46" text-anchor="middle" font-family="' + SANS + '" font-size="10.5" fill="' + C.bad + '">泄漏点</text>';
    s += '<text x="44" y="90" text-anchor="middle" font-family="' + MONO + '" font-size="9.5" fill="' + C.ink3 + '">A 站</text>' +
      '<text x="436" y="90" text-anchor="middle" font-family="' + MONO + '" font-size="9.5" fill="' + C.ink3 + '">B 站</text>';
    function trace(dir) {
      var pts = [];
      for (var i = 0; i <= 70; i++) {
        var t = i / 70;
        var base = 132 + Math.sin(i * .32) * 1.8;
        var hit = t > .82 ? (t - .82) * dir * 110 : 0;
        pts.push([46 + t * 388, base + hit]);
      }
      return pts;
    }
    s += '<path d="' + pathFrom(trace(-1)) + '" fill="none" stroke="' + C.jade + '" stroke-width="1.4"/>';
    s += '<path d="' + pathFrom(trace(1)) + '" fill="none" stroke="' + C.brass + '" stroke-width="1.4"/>';
    s += '<path d="M46 170H434" stroke="' + C.line + '" stroke-dasharray="3 3"/>';
    s += '<text x="46" y="186" font-family="' + MONO + '" font-size="9.5" fill="' + C.ink3 + '">P_A — P_B</text>';
    s += '<rect x="272" y="196" width="164" height="52" fill="' + C.paper + '" stroke="' + C.line + '"/>';
    s += '<text x="282" y="212" font-family="' + MONO + '" font-size="9.5" fill="' + C.ink3 + '">LOCATE</text>';
    s += '<text x="282" y="227" font-family="' + MONO + '" font-size="11.5" fill="' + C.ink + '">x = (L + v·Δt) / 2</text>';
    s += '<text x="282" y="241" font-family="' + MONO + '" font-size="9.5" fill="' + C.brass + '">= 8.42 km · ±60 m</text>';
    return frame(s, '管道泄漏 · 负压波 + 流量平衡', '检测 60—140 s');
  }

  /* ---------------- 08 示功图族 ---------------- */
  function dyn() {
    var labels = ['正常', '供液不足', '气锁', '游动阀漏', '固定阀漏', '断脱'];
    var s = '';
    for (var i = 0; i < 6; i++) {
      var bx = 34 + (i % 3) * 144, by = 40 + Math.floor(i / 3) * 100;
      var w = 130, h = 84;
      s += '<rect x="' + bx + '" y="' + by + '" width="' + w + '" height="' + h + '" fill="none" stroke="' + C.line + '"/>';
      var pts = [];
      var n = 64;
      for (var k = 0; k < n; k++) {
        var t = k / (n - 1);
        var ang = t * Math.PI * 2 - Math.PI * .5;
        var x = bx + w / 2 + Math.cos(ang) * 42;
        var y = by + h / 2 + Math.sin(ang) * 24;
        if (i === 1) { x = bx + 8 + t * (w - 16); y = by + 12 + Math.sin(t * Math.PI) * 54; }
        if (i === 2) { x = bx + 8 + t * (w - 16); y = by + 20 + Math.sin(t * Math.PI * 2) * 28; }
        if (i === 5) { x = bx + w / 2 + Math.sin(t * Math.PI) * 38; y = by + 16 + t * (h - 30); }
        pts.push([x, y]);
      }
      var col = i === 0 ? C.jade : i === 5 ? C.bad : C.brass;
      s += '<path d="' + pathFrom(pts) + '" fill="none" stroke="' + col + '" stroke-width="1.4"/>';
      s += '<text x="' + (bx + 4) + '" y="' + (by + 11) + '" font-family="' + SANS + '" font-size="10.5" fill="' + C.ink2 + '">' + labels[i] + '</text>';
    }
    return frame(s, '示功图 · 六类工况', '8,800 井 · 准确率 94%');
  }

  /* ---------------- 09 套管损伤 ---------------- */
  function casing() {
    var cx = 126, cy = 128, r = 66;
    var s = '';
    s += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + C.ink + '" stroke-width="2.2"/>';
    s += '<ellipse cx="' + cx + '" cy="' + cy + '" rx="' + r + '" ry="' + (r * .9) + '" fill="none" stroke="' + C.brass + '" stroke-width="1.3" stroke-dasharray="4 3"/>';
    [[0, 1], [1, 0], [0, -1], [-1, 0]].forEach(function (d, i) {
      var len = i === 0 ? r - 10 : i === 2 ? r + 10 : r - 2;
      s += '<path d="M' + cx + ' ' + cy + 'L' + (cx + d[0] * len) + ' ' + (cy + d[1] * len) + '" stroke="' + C.jade + '" stroke-width="1.1" opacity=".6"/>';
    });
    s += '<circle cx="' + cx + '" cy="' + cy + '" r="3.4" fill="' + C.jade + '"/>';
    s += '<text x="' + cx + '" y="' + (cy + r + 18) + '" text-anchor="middle" font-family="' + MONO + '" font-size="9.5" fill="' + C.ink2 + '">椭圆度 8.6%</text>';
    s += '<text x="' + cx + '" y="' + (cy + r + 30) + '" text-anchor="middle" font-family="' + MONO + '" font-size="9.5" fill="' + C.ink2 + '">内径 115.2 mm</text>';
    var x0 = 226, y0 = 44, w = 220, h = 160;
    s += '<rect x="' + x0 + '" y="' + y0 + '" width="' + w + '" height="' + h + '" fill="' + C.paper + '" stroke="' + C.line + '"/>';
    for (var i = 0; i <= 5; i++) s += '<path d="M' + (x0 + i * w / 5) + ' ' + y0 + 'v' + h + '" stroke="' + C.grid + '"/>';
    for (var j = 0; j <= 4; j++) s += '<path d="M' + x0 + ' ' + (y0 + j * h / 4) + 'h' + w + '" stroke="' + C.grid + '"/>';
    var bands = [[0, .18, '挤压'], [.26, .4, '腐蚀'], [.5, .62, '穿孔'], [.7, .86, '结垢']];
    bands.forEach(function (b, i) {
      s += '<rect x="' + x0 + '" y="' + (y0 + b[0] * h) + '" width="' + w + '" height="' + ((b[1] - b[0]) * h) + '" fill="' + (i === 2 ? 'rgba(152,62,49,.16)' : 'rgba(18,59,58,.13)') + '"/>';
      s += '<text x="' + (x0 + w - 5) + '" y="' + (y0 + b[0] * h + 12) + '" text-anchor="end" font-family="' + SANS + '" font-size="10" fill="' + C.ink2 + '">' + b[2] + '</text>';
    });
    s += '<text x="' + x0 + '" y="' + (y0 - 6) + '" font-family="' + MONO + '" font-size="9.5" fill="' + C.ink3 + '">UNWRAP 0—360°</text>';
    return frame(s, '套管损伤 · 多臂井径 + 成像', '16 臂 / 500—2000 点每米');
  }

  /* ---------------- 10 风险预警 ---------------- */
  function risk() {
    var s = axis(54, 48, 448, 222, '作业时间 (h)', '扭矩');
    var upper = [], lower = [], mid = [];
    for (var i = 0; i <= 90; i++) {
      var t = i / 90;
      var base = 138 + Math.sin(t * 5.2) * 5 + Math.sin(t * 13) * 1.6;
      var dev = t > .64 ? (t - .64) * 150 : 0;
      var y = base - dev;
      mid.push([54 + t * 394, y]);
      upper.push([54 + t * 394, base - 26]);
      lower.push([54 + t * 394, base + 26]);
    }
    s += '<path d="' + pathFrom(upper) + 'L' + pathFrom(lower.slice().reverse()).replace(/^M/, 'L') + 'Z" fill="rgba(18,59,58,.09)"/>';
    s += '<path d="' + pathFrom(mid) + '" fill="none" stroke="' + C.jade + '" stroke-width="1.5"/>';
    s += '<path d="M54 88H448" stroke="' + C.bad + '" stroke-width="1" stroke-dasharray="5 4"/>';
    s += '<text x="446" y="82" text-anchor="end" font-family="' + MONO + '" font-size="9.5" fill="' + C.bad + '">预警阈值</text>';
    var idx = Math.round(.72 * 90);
    s += '<circle cx="' + mid[idx][0] + '" cy="' + mid[idx][1] + '" r="4.5" fill="none" stroke="' + C.bad + '" stroke-width="1.5"/>';
    s += '<circle cx="' + mid[idx][0] + '" cy="' + mid[idx][1] + '" r="1.6" fill="' + C.bad + '"/>';
    s += '<text x="' + (mid[idx][0] - 8) + '" y="' + (mid[idx][1] - 12) + '" text-anchor="end" font-family="' + SANS + '" font-size="10.5" fill="' + C.bad + '">扭矩 +38%</text>';
    s += '<text x="66" y="68" font-family="' + SANS + '" font-size="10.5" fill="' + C.ink3 + '">±2σ 基线包络</text>';
    return frame(s, '修井风险 · 多变量基线', '7.3 min 提前量 / 1.3 次每班');
  }

  var DRAW = {
    'welllog-layer': welllog,
    'workover-plan-kg': planKG,
    'workover-duration-ts': gantt,
    'fishing-tool-kg': tools,
    'frac-optimize-opt': pareto,
    'gaslogging-fluid-ts': gas,
    'pipeline-leak-ts': leak,
    'pump-diagnosis-cv': dyn,
    'casing-damage-cv': casing,
    'workover-risk-ts': risk
  };

  function fallback() {
    var s = axis(56, 48, 446, 222, '输入', '输出');
    var pts = [];
    for (var i = 0; i <= 50; i++) {
      var t = i / 50;
      pts.push([56 + t * 390, 196 - Math.pow(t, .8) * 124 + Math.sin(i) * 4]);
    }
    s += '<path d="' + pathFrom(pts) + '" fill="none" stroke="' + C.jade + '" stroke-width="1.5"/>';
    return frame(s, '案例图版', '');
  }

  function of(id) {
    var fn = DRAW[id] || fallback;
    try { return fn(); } catch (e) { return fallback(); }
  }

  global.Plate = { of: of, colors: C };
})(window);
