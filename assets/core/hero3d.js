/* =========================================================
   首页 3D 场景 · three.js + glTF 井场模型
   ---------------------------------------------------------
   与「2D 点云」那版不同，这一版是真正的三维渲染：

     模型     assets/models/wellpad.gltf —— 井架、钻台、游车、储罐、
              火炬、泥浆泵房（2724 个三角面，6 种材质），
              由 GLTFLoader 解析后放进场景；游车节点单独做升降动画。
     地层     6 层水平地层块（120×120 m，每层 6 m），可整体淡出。
     井眼     从井口斜穿到目的层的管状曲线，附一个下行的测量脉冲。
     地形     150×150 m 高程网格：等高线地表纹理 + 勘探区块虚线边界与界桩。
     油气分布  多个含油气砂体（气顶 / 油环 / 水层）+ 三口水平井轨迹 + 流体图例。

   四个状态（与 HUD 标签一一对应）：
     ① 井场 SURFACE      地面设备为主，地层实心
     ② 井筒 WELLBORE     地层淡出，井眼轨迹点亮，脉冲下行
     ③ 地形 TERRAIN      回到地表，等高线与勘探区块显形
     ④ 油气分布 PETROLEUM 地下含油气砂体与井网展开

   兼容与降级：
     · 没有 THREE / 没有 WebGL / 模型解析失败 → mount() 返回 false，
       由 fx.js 的 Canvas 2D 版本接手（再不行还有 CSS 3D 兜底）
     · 不请求网络：模型以 JS 内联（window.WELLPAD_GLTF），file:// 可跑
     · 离屏/切后台/暂停 停渲染；prefers-reduced-motion 降低自转与闪烁
   ========================================================= */

(function (global) {
  'use strict';

  var S = null;

  function reduced() {
    try { return global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch (e) { return false; }
  }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smoothstep(a, b, v) {
    var t = clamp((v - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  }

  /* ---------- 地表高程（地形网格与地表纹理共用） ---------- */
  function terrainH(x, z) {
    var r = Math.sqrt(x * x + z * z);
    var flat = smoothstep(30, 64, r);
    var h =
      13.0 * Math.exp(-((x - 46) * (x - 46) + (z + 42) * (z + 42)) / 820) +
      8.5 * Math.exp(-((x + 52) * (x + 52) + (z - 34) * (z - 34)) / 700) +
      5.5 * Math.exp(-((x + 12) * (x + 12) + (z + 60) * (z + 60)) / 520) +
      3.4 * Math.sin(x * 0.052 + 1.2) * Math.cos(z * 0.046 - 0.6) +
      1.8 * Math.sin(x * 0.11 - z * 0.07 + 2.4) +
      1.1;
    return flat * h;
  }

  /* ---------- 地表纹理：高程配色 + 等高线 + 坡面阴影 ---------- */
  function terrainTex() {
    var N = 512, SIZE = 150;
    var H = new Float32Array(N * N);
    var i, j, x, z;
    for (j = 0; j < N; j++) {
      z = -SIZE / 2 + SIZE * j / (N - 1);
      for (i = 0; i < N; i++) {
        x = -SIZE / 2 + SIZE * i / (N - 1);
        H[j * N + i] = terrainH(x, z);
      }
    }
    function ramp(h) {
      var stops = [
        [0, [18, 27, 28]],
        [3, [30, 40, 38]],
        [8, [52, 60, 52]],
        [12, [86, 84, 62]],
        [16, [132, 116, 82]],
        [20, [190, 160, 112]]
      ];
      for (var k = 1; k < stops.length; k++) {
        if (h <= stops[k][0] || k === stops.length - 1) {
          var a = stops[k - 1], b = stops[k];
          var t = clamp((h - a[0]) / (b[0] - a[0]), 0, 1);
          return [
            lerp(a[1][0], b[1][0], t),
            lerp(a[1][1], b[1][1], t),
            lerp(a[1][2], b[1][2], t)
          ];
        }
      }
      return stops[stops.length - 1][1];
    }
    var cv = global.document.createElement('canvas');
    cv.width = cv.height = N;
    var c = cv.getContext('2d');
    var img = c.createImageData(N, N);
    var d = img.data;
    for (j = 0; j < N; j++) {
      for (i = 0; i < N; i++) {
        var idx = j * N + i;
        var h = H[idx];
        var hR = H[j * N + Math.min(N - 1, i + 1)];
        var hD = H[Math.min(N - 1, j + 1) * N + i];
        var col = ramp(h);
        var shade = clamp(0.78 + (h - hR) * 2.0 + (h - hD) * 1.25, 0.42, 1.32);
        var r = col[0] * shade, g = col[1] * shade, b = col[2] * shade;
        /* 每 3.5 m 一条等高线，每第 5 条加亮 */
        var lv = Math.floor(h / 3.5);
        if (lv !== Math.floor(hR / 3.5) || lv !== Math.floor(hD / 3.5)) {
          var cm = (lv % 5 === 0) ? 0.7 : 0.45;
          r = lerp(r, 214, cm); g = lerp(g, 193, cm); b = lerp(b, 158, cm);
        }
        var p = idx * 4;
        d[p] = clamp(r, 0, 255); d[p + 1] = clamp(g, 0, 255); d[p + 2] = clamp(b, 0, 255); d[p + 3] = 255;
      }
    }
    c.putImageData(img, 0, 0);
    return cv;
  }

  /* ---------- 状态 ---------- */
  var STATES = [
    {
      key: 'surface', no: '01', name: '井场', en: 'WELL PAD',
      desc: '地面这一层是能看见的：井架、游车、储罐、火炬，井口下面才是作业对象。',
      pos: [64, 28, 76], target: [9, 16, 2],
      strata: 1.0, well: 0.18, terrain: 0.0, oil: 0.0, pad: 1.0
    },
    {
      key: 'wellbore', no: '02', name: '井筒', en: 'WELLBORE',
      desc: '地层剖开：井眼从井口斜穿下去，管柱、水泥环、随钻数据都挂在这条线上。',
      pos: [50, 10, 64], target: [10, -6, 3],
      strata: 0.20, well: 1.0, terrain: 0.0, oil: 0.0, pad: 0.55
    },
    {
      key: 'terrain', no: '03', name: '地形', en: 'TERRAIN',
      desc: '回到地表：等高线、沟谷和勘探区块边界，井场只是这片地形上的一个点。',
      pos: [84, 44, 92], target: [2, 1, 2],
      strata: 0.03, well: 0.10, terrain: 1.0, oil: 0.0, pad: 0.95
    },
    {
      key: 'petroleum', no: '04', name: '油气分布', en: 'PETROLEUM',
      desc: '地下不是均匀的一层油：多个含油气砂体沿构造分布，气顶、油环、水层各占一段。',
      pos: [48, 42, 72], target: [4, -24, 6],
      strata: 0.05, well: 0.45, terrain: 0.0, oil: 1.0, pad: 0.1
    }
  ];
  var DWELL = 7.6;

  /* ---------- 建场 ---------- */
  function mount(stageEl, opts) {
    destroy();
    if (!stageEl || !global.THREE) return false;
    var THREE = global.THREE;

    /* 先探测 WebGL，失败就交给 2D 版本 */
    var preview = null;
    try {
      preview = global.document.createElement('canvas');
      if (!(preview.getContext('webgl') || preview.getContext('experimental-webgl'))) return false;
    } catch (e) { return false; }

    opts = opts || {};
    var calm = reduced();
    var speed = calm ? 0.35 : 1;

    var canvas = global.document.createElement('canvas');
    canvas.className = 'stage-canvas stage-canvas-3d';
    canvas.setAttribute('aria-hidden', 'true');
    var veil = stageEl.querySelector('.stage-veil');
    if (veil) stageEl.insertBefore(canvas, veil); else stageEl.appendChild(canvas);

    var renderer, scene, camera, raf = null, running = false, paused = false, visible = true;
    var clock = new THREE.Clock();
    var t = 0, st = { idx: 0, timer: 0 }, frames = 0, lastWatch = 0;
    var orbit = 0, drag = { on: false, x: 0, y: 0, yaw: 0, pitch: 0 };
    var W = 1, H = 1;

    try {
      renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    } catch (e) { return false; }
    if (!renderer || !renderer.getContext()) return false;

    renderer.setPixelRatio(Math.min(1.8, global.devicePixelRatio || 1));
    renderer.setClearColor(0x071417, 1);
    if (THREE.sRGBEncoding !== undefined) renderer.outputEncoding = THREE.sRGBEncoding;
    if (THREE.ACESFilmicToneMapping !== undefined) {
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.05;
    }
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x071417);
    scene.fog = new THREE.FogExp2(0x071417, 0.0042);

    camera = new THREE.PerspectiveCamera(38, 1, 0.5, 900);

    /* 灯光：主光偏暖（油田的黄昏），补光是青玉色边光 */
    scene.add(new THREE.HemisphereLight(0x335e5a, 0x090f0e, 0.12));
    var key = new THREE.DirectionalLight(0xffcf94, 1.05);
    key.position.set(48, 82, 38);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -90;
    key.shadow.camera.right = 90;
    key.shadow.camera.top = 90;
    key.shadow.camera.bottom = -90;
    key.shadow.camera.near = 20;
    key.shadow.camera.far = 320;
    key.shadow.bias = -0.0007;
    scene.add(key);
    var rim = new THREE.DirectionalLight(0x8ea9ad, 1.55);
    rim.position.set(-66, 26, -86);
    scene.add(rim);
    var fill = new THREE.DirectionalLight(0xa9cfe0, 0.55);
    fill.position.set(-40, 26, 70);
    scene.add(fill);
    var flareLight = new THREE.PointLight(0xff9a4d, 3.4, 110, 2);
    flareLight.position.set(-16, 27, -9);
    scene.add(flareLight);
    var headLight = new THREE.PointLight(0xffb87a, 1.4, 34, 2);
    headLight.position.set(0, 5, 0);
    scene.add(headLight);
    var crownLight = new THREE.PointLight(0xff5544, 0.9, 18, 2);
    crownLight.position.set(0, 31.4, 0);
    scene.add(crownLight);
    var crownBulb = new THREE.Mesh(new THREE.SphereGeometry(0.42, 10, 10),
      new THREE.MeshBasicMaterial({ color: 0xff6a55 }));
    crownBulb.position.set(0, 31.2, 0);
    scene.add(crownBulb);
    var resLight = new THREE.PointLight(0xffcf8a, 1.8, 80, 2);
    resLight.position.set(12, -30, 7);
    scene.add(resLight);

    /* 程序化颗粒贴图（混凝土 / 地面用） */
    function grainTex(base, spread, rep) {
      var cv = global.document.createElement('canvas');
      cv.width = cv.height = 128;
      var c = cv.getContext('2d');
      c.fillStyle = base;
      c.fillRect(0, 0, 128, 128);
      for (var i = 0; i < 5200; i++) {
        var v = Math.round((Math.random() - 0.5) * spread);
        var g = Math.max(0, Math.min(255, 120 + v));
        c.fillStyle = 'rgba(' + g + ',' + g + ',' + g + ',' + (0.05 + Math.random() * 0.22) + ')';
        var x = Math.random() * 128, y = Math.random() * 128;
        c.fillRect(x, y, 1 + Math.random() * 2, 1 + Math.random() * 2);
      }
      var tx = new THREE.CanvasTexture(cv);
      tx.wrapS = tx.wrapT = THREE.RepeatWrapping;
      tx.repeat.set(rep, rep);
      if (THREE.sRGBEncoding !== undefined) tx.encoding = THREE.sRGBEncoding;
      return tx;
    }
    var gravel = grainTex('#3a3f40', 40, 10);

    /* 圆形柔光点：点云和粒子都用它 */
    function softDot() {
      var cv = global.document.createElement('canvas');
      cv.width = cv.height = 64;
      var c = cv.getContext('2d');
      var g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.32, 'rgba(255,255,255,0.62)');
      g.addColorStop(0.72, 'rgba(255,255,255,0.12)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, 64, 64);
      var tx = new THREE.CanvasTexture(cv);
      tx.minFilter = THREE.LinearFilter;
      tx.generateMipmaps = false;
      return tx;
    }
    var dotTex = softDot();

    /* ---------- 画布文本标注（贴在三维空间里的 Sprite） ---------- */
    function makeLabel(main, sub, tone, pix) {
      var font1 = '600 30px "PingFang SC","Microsoft YaHei",system-ui,sans-serif';
      var font2 = '500 17px ui-monospace,Consolas,"Courier New",monospace';
      var probe = global.document.createElement('canvas').getContext('2d');
      probe.font = font1;
      var w1 = probe.measureText(main).width;
      probe.font = font2;
      var w2 = sub ? probe.measureText(sub).width : 0;
      var padX = 20, bar = 5;
      var cw = Math.ceil(Math.max(w1, w2) + padX * 2 + bar + 4);
      var ch = sub ? 100 : 70;
      var cv = global.document.createElement('canvas');
      cv.width = cw; cv.height = ch;
      var c = cv.getContext('2d');
      var r = 9;
      c.beginPath();
      c.moveTo(r, 0); c.lineTo(cw - r, 0); c.quadraticCurveTo(cw, 0, cw, r);
      c.lineTo(cw, ch - r); c.quadraticCurveTo(cw, ch, cw - r, ch);
      c.lineTo(r, ch); c.quadraticCurveTo(0, ch, 0, ch - r);
      c.lineTo(0, r); c.quadraticCurveTo(0, 0, r, 0);
      c.closePath();
      c.fillStyle = 'rgba(7,20,23,0.66)';
      c.fill();
      c.strokeStyle = 'rgba(255,255,255,0.14)';
      c.lineWidth = 1;
      c.stroke();
      c.fillStyle = tone;
      c.fillRect(0, 22, 3, ch - 44);
      c.textBaseline = 'middle';
      c.font = font1;
      c.fillStyle = '#f6ecd8';
      c.fillText(main, bar + padX - 3, sub ? ch * 0.34 : ch * 0.5);
      if (sub) {
        c.font = font2;
        c.fillStyle = 'rgba(243,230,204,0.58)';
        c.fillText(sub, bar + padX - 3, ch * 0.68);
      }
      var tx = new THREE.CanvasTexture(cv);
      tx.minFilter = THREE.LinearFilter;
      tx.magFilter = THREE.LinearFilter;
      tx.generateMipmaps = false;
      if (THREE.sRGBEncoding !== undefined) tx.encoding = THREE.sRGBEncoding;
      var mat = new THREE.SpriteMaterial({
        map: tx, transparent: true, opacity: 0,
        depthTest: false, depthWrite: false, fog: false
      });
      var sp = new THREE.Sprite(mat);
      sp.scale.set(cw * pix, ch * pix, 1);
      sp.renderOrder = 40;
      return sp;
    }

    /* 标注 + 引线：返回两个材质，统一在 frame() 里控制透明度 */
    function makeAnno(main, sub, tone, pix, pos, anchor, lineColor) {
      var sp = makeLabel(main, sub, tone, pix);
      sp.position.set(pos[0], pos[1], pos[2]);
      scene.add(sp);
      var lineMat = null;
      if (anchor) {
        lineMat = new THREE.LineDashedMaterial({
          color: lineColor || 0xd9c49b, transparent: true, opacity: 0,
          dashSize: 1.2, gapSize: 0.9,
          depthTest: false, depthWrite: false
        });
        var a0 = new THREE.Vector3(anchor[0], anchor[1], anchor[2]);
        var a1 = new THREE.Vector3(pos[0], pos[1], pos[2]);
        a1.lerp(a0, 0.2);
        var line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a0, a1]), lineMat);
        line.computeLineDistances();
        line.renderOrder = 39;
        scene.add(line);
      }
      return { mat: sp.material, lineMat: lineMat };
    }


    /* 地面 + 网格（很淡，只为交代尺度） */
    var grid = new THREE.GridHelper(78, 16, 0x6b5f48, 0x25231d);
    grid.material.transparent = true;
    grid.material.opacity = 0.14;
    grid.position.y = 0.02;
    scene.add(grid);

    /* ---------- 地层块 ---------- */
    var STRATA_COLORS = [0x081416, 0x0a1819, 0x0b1a1a, 0x111714, 0x14100b, 0x0b0b09];
    var strataGroup = new THREE.Group();
    var strataMats = [];
    var strataSeamMats = [];
    for (var i = 0; i < 6; i++) {
      var mat = new THREE.MeshStandardMaterial({
        color: STRATA_COLORS[i], roughness: 0.98, metalness: 0.0,
        map: (i === 0 ? gravel : null),
        transparent: true, opacity: 1
      });
      strataMats.push(mat);
      var geo = new THREE.BoxGeometry(78 - i * 1.0, 6, 78 - i * 1.0);
      var box = new THREE.Mesh(geo, mat);
      box.position.y = -3 - i * 6;
      box.receiveShadow = true;
      strataGroup.add(box);
      var eg2 = new THREE.EdgesGeometry(geo, 1);
      var seamMat = new THREE.LineBasicMaterial({
        color: 0xb9935a, transparent: true, opacity: 0.18
      });
      strataSeamMats.push(seamMat);
      var seam = new THREE.LineSegments(eg2, seamMat);
      seam.position.copy(box.position);
      strataGroup.add(seam);
    }
    scene.add(strataGroup);

    /* ---------- 井场模型 ---------- */
    var padGroup = new THREE.Group();
    padGroup.position.x = 7;
    scene.add(padGroup);
    var traveling = null, tbBase = 30;
    var modelOK = false;

    function buildFallbackPad() {
      /* 模型解析不了时的极简替换：一个塔架 + 两个罐子，保证还有三维体量 */
      var steel = new THREE.MeshStandardMaterial({ color: 0x9aa6ab, metalness: 0.8, roughness: 0.4 });
      for (var k = 0; k < 4; k++) {
        var ang = k / 4 * Math.PI * 2;
        var leg = new THREE.Mesh(new THREE.BoxGeometry(0.6, 26, 0.6), steel);
        leg.position.set(Math.cos(ang) * 2.6, 13, Math.sin(ang) * 2.6);
        leg.castShadow = true;
        padGroup.add(leg);
      }
      var tank = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 7, 16),
        new THREE.MeshStandardMaterial({ color: 0xcfcbc0, metalness: 0.4, roughness: 0.5 }));
      tank.position.set(12, 3.5, 6);
      tank.castShadow = true;
      padGroup.add(tank);
    }

    /* base64 GLB → ArrayBuffer（file:// 下不能用 XHR 读模型文件） */
    function b64ToBuf(b64) {
      var bin = global.atob(b64);
      var len = bin.length;
      var bytes = new Uint8Array(len);
      for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
      return bytes.buffer;
    }

    function useModel(glbB64) {
      if (!global.THREE.GLTFLoader) { buildFallbackPad(); return; }
      try {
        var loader = new THREE.GLTFLoader();
        loader.parse(b64ToBuf(glbB64), '', function (gltf) {
          var root = gltf.scene || gltf.scenes[0];
          root.traverse(function (o) {
            if (o.isMesh) {
              o.castShadow = true;
              o.receiveShadow = true;
              if (o.material) {
                var m = o.material;
                m.color.multiplyScalar(0.62);
                m.roughness = 0.82;
                m.metalness = Math.min(0.35, m.metalness || 0);
                if (m.name === 'flare') m.emissiveIntensity = 1.8;
                if (m.name === 'concrete') {
                  m.map = gravel;
                  m.color.setHex(0x6c7375);
                  m.roughness = 0.95;
                }
                if (m.name === 'tank') {
                  m.map = gravel;
                  m.color.setHex(0x9a958a);
                }
                /* 边线：让箱体几何读成「结构」，而不是一块塑料 */
                var eg = new THREE.EdgesGeometry(o.geometry, 24);
                var lineCol = m.name === 'amber' ? 0xd9a35e : m.name === 'paint' ? 0xd9c49b : 0xc9a35e;
                var ls = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({
                  color: lineCol, transparent: true, opacity: 0.34
                }));
                o.add(ls);
              }
            }
            if (o.name === 'travelingBlock') { traveling = o; tbBase = o.position.y; }
          });
          padGroup.add(root);
          modelOK = true;
        }, function (err) {
          buildFallbackPad();
        });
      } catch (e) {
        buildFallbackPad();
      }
    }

    if (global.WELLPAD_GLB) useModel(global.WELLPAD_GLB);
    else buildFallbackPad();

    /* ---------- 井眼 + 目的层 ---------- */
    var curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 7.0, 0),
      new THREE.Vector3(0.2, 2.0, 0.2),
      new THREE.Vector3(1.0, -3, 1.0),
      new THREE.Vector3(3.4, -10, 2.4),
      new THREE.Vector3(7.0, -17, 4.4),
      new THREE.Vector3(10.4, -24, 6.2),
      new THREE.Vector3(12, -30, 7)
    ]);
    var wellMat = new THREE.MeshStandardMaterial({
      color: 0xd9c49b, emissive: 0x7a5c2e, emissiveIntensity: 0.8,
      roughness: 0.35, metalness: 0.5, transparent: true, opacity: 0.3
    });
    /* 套管（外层）+ 管柱（内层发光）+ 三只套管鞋，和地面设备保持同一细节层级 */
    var casingMat = new THREE.MeshStandardMaterial({
      color: 0x2b3336, metalness: 0.75, roughness: 0.45,
      transparent: true, opacity: 0.85
    });
    var casing = new THREE.Mesh(new THREE.TubeGeometry(curve, 160, 0.85, 10, false), casingMat);
    scene.add(casing);
    var wellMesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 160, 0.5, 8, false), wellMat);
    scene.add(wellMesh);
    var shoeMat = new THREE.MeshStandardMaterial({
      color: 0xa9742c, emissive: 0x6e4a1b, emissiveIntensity: 0.35,
      metalness: 0.6, roughness: 0.4
    });
    [0.16, 0.42, 0.68].forEach(function (t) {
      var p = curve.getPointAt(t);
      var ring = new THREE.Mesh(new THREE.TorusGeometry(0.95, 0.13, 8, 24), shoeMat);
      ring.position.copy(p);
      ring.rotation.x = Math.PI / 2;
      scene.add(ring);
    });

    /* 游车到转盘之间的钻具（随游车升降伸缩） */
    var drillGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 26, 0), new THREE.Vector3(0, 8.4, 0)
    ]);
    var drillLine = new THREE.Line(drillGeo, new THREE.LineBasicMaterial({
      color: 0xd8cbb2, transparent: true, opacity: 0.55
    }));
    scene.add(drillLine);

    var pulseMat = new THREE.MeshBasicMaterial({ color: 0xf0d9ae, transparent: true, opacity: 0.9 });
    var pulse = new THREE.Mesh(new THREE.SphereGeometry(1.1, 12, 12), pulseMat);
    scene.add(pulse);

    /* ---------- 地形：高程网格 + 等高线 + 勘探区块 ---------- */
    var terTex = new THREE.CanvasTexture(terrainTex());
    if (THREE.sRGBEncoding !== undefined) terTex.encoding = THREE.sRGBEncoding;
    terTex.anisotropy = 8;
    var terMat = new THREE.MeshStandardMaterial({
      map: terTex, roughness: 0.95, metalness: 0.0,
      transparent: true, opacity: 0, depthWrite: true
    });
    var terGeo = new THREE.PlaneGeometry(150, 150, 96, 96);
    terGeo.rotateX(-Math.PI / 2);
    var tPos = terGeo.attributes.position;
    for (var ti = 0; ti < tPos.count; ti++) {
      var tx = tPos.getX(ti), tz = tPos.getZ(ti);
      tPos.setY(ti, terrainH(tx, tz) - 0.04);
    }
    tPos.needsUpdate = true;
    terGeo.computeVertexNormals();
    var terrainMesh = new THREE.Mesh(terGeo, terMat);
    terrainMesh.receiveShadow = true;
    scene.add(terrainMesh);

    var terFx = new THREE.Group();
    scene.add(terFx);
    var surveyMat = new THREE.LineDashedMaterial({
      color: 0xd9a35e, transparent: true, opacity: 0,
      dashSize: 2.2, gapSize: 1.5, depthWrite: false
    });
    var surveyPts = [];
    var surveyCorners = [[-36, -44], [52, -44], [52, 36], [-36, 36]];
    for (var si = 0; si < 4; si++) {
      var sc0 = surveyCorners[si], sc1 = surveyCorners[(si + 1) % 4];
      for (var sj = 0; sj <= 40; sj++) {
        var sut = sj / 40;
        var sx = lerp(sc0[0], sc1[0], sut);
        var sz = lerp(sc0[1], sc1[1], sut);
        surveyPts.push(new THREE.Vector3(sx, terrainH(sx, sz) + 0.6, sz));
      }
    }
    var survey = new THREE.Line(new THREE.BufferGeometry().setFromPoints(surveyPts), surveyMat);
    survey.computeLineDistances();
    terFx.add(survey);

    /* 测线：区块内的二维地震测线，贴着地形起伏 */
    var surveyGridMat = new THREE.LineDashedMaterial({
      color: 0xb9935a, transparent: true, opacity: 0,
      dashSize: 1.6, gapSize: 1.4, depthWrite: false
    });
    function addSurveyLine(x0, z0, x1, z1) {
      var pts = [];
      for (var n = 0; n <= 50; n++) {
        var u = n / 50;
        var x = lerp(x0, x1, u), z = lerp(z0, z1, u);
        pts.push(new THREE.Vector3(x, terrainH(x, z) + 0.32, z));
      }
      var ln = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), surveyGridMat);
      ln.computeLineDistances();
      terFx.add(ln);
    }
    addSurveyLine(-34, -28, 50, -28);
    addSurveyLine(-34, 0, 50, 0);
    addSurveyLine(-34, 28, 50, 28);
    addSurveyLine(-18, -42, -18, 34);
    addSurveyLine(24, -42, 24, 34);

    var stakeMat = new THREE.MeshBasicMaterial({ color: 0xd9a35e, transparent: true, opacity: 0, depthWrite: false });
    var stakeGlowMat = new THREE.MeshBasicMaterial({
      color: 0xffd8a3, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending
    });
    var stakeGeo = new THREE.CylinderGeometry(0.1, 0.14, 3.6, 6);
    var stakeTipGeo = new THREE.SphereGeometry(0.4, 8, 6);
    surveyCorners.forEach(function (sc) {
      var gy = terrainH(sc[0], sc[1]);
      var pole = new THREE.Mesh(stakeGeo, stakeMat);
      pole.position.set(sc[0], gy + 1.8, sc[1]);
      terFx.add(pole);
      var tip = new THREE.Mesh(stakeTipGeo, stakeGlowMat);
      tip.position.set(sc[0], gy + 3.75, sc[1]);
      terFx.add(tip);
    });

    var annoTerrain = makeAnno('勘探区块 A', '86 km² · 地表高程 +12 ~ +38 m',
      '#ffd8a3', 0.050, [46, 16, -10], [44, terrainH(44, -10) + 1.1, -10], 0xd9a35e);

    /* ---------- 油气分布：含油气砂体 + 气顶/油环/水层 + 井网 ---------- */
    var oilGroup = new THREE.Group();
    scene.add(oilGroup);

    var OIL_FIELDS = [
      { x: 12, y: -30, z: 7, rx: 7.5, ry: 1.3, rz: 5.5, gas: 0.58, tag: 'A-12H' },
      { x: 38, y: -19, z: 10, rx: 6.5, ry: 1.1, rz: 4.8, gas: 0.45, tag: 'A-13H' },
      { x: 26, y: -31, z: -22, rx: 5.5, ry: 0.9, rz: 4.2, gas: 0, tag: 'A-14H' }
    ];
    var oilFillMat = new THREE.MeshBasicMaterial({ color: 0xd9974a, transparent: true, opacity: 0, depthWrite: false });
    var gasFillMat = new THREE.MeshBasicMaterial({ color: 0xb4563a, transparent: true, opacity: 0, depthWrite: false });
    var waterFillMat = new THREE.MeshBasicMaterial({ color: 0x3f8f86, transparent: true, opacity: 0, depthWrite: false });
    var oilRimMat = new THREE.LineBasicMaterial({ color: 0xd9a35e, transparent: true, opacity: 0, depthWrite: false });
    var gasRimMat = new THREE.LineBasicMaterial({ color: 0xb4563a, transparent: true, opacity: 0, depthWrite: false });
    var waterRimMat = new THREE.LineBasicMaterial({ color: 0x3f8f86, transparent: true, opacity: 0, depthWrite: false });
    var oilGlowMat = new THREE.SpriteMaterial({
      map: dotTex, color: 0xd9a35e, transparent: true, opacity: 0,
      depthWrite: false, blending: THREE.AdditiveBlending, fog: false
    });
    var landMat = new THREE.MeshBasicMaterial({ color: 0xf0dcc0, transparent: true, opacity: 0, depthWrite: false });
    var oilSphere = new THREE.SphereGeometry(1, 40, 24);

    /* 油藏顶面的柔光填充：从中心向边缘淡出，读成一片油水界面 */
    function softPool() {
      var cv = global.document.createElement('canvas');
      cv.width = cv.height = 128;
      var c = cv.getContext('2d');
      var g = c.createRadialGradient(64, 64, 3, 64, 64, 64);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.6, 'rgba(255,255,255,0.92)');
      g.addColorStop(0.88, 'rgba(255,255,255,0.62)');
      g.addColorStop(0.97, 'rgba(255,255,255,0.15)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, 128, 128);
      var tx = new THREE.CanvasTexture(cv);
      tx.minFilter = THREE.LinearFilter;
      tx.generateMipmaps = false;
      return tx;
    }
    var poolGeo = new THREE.CircleGeometry(1, 64);
    var poolTex = softPool();
    var oilTopMat = new THREE.MeshBasicMaterial({
      map: poolTex, color: 0xd98b3d, transparent: true, opacity: 0,
      depthWrite: false, side: THREE.DoubleSide
    });
    var gasTopMat = new THREE.MeshBasicMaterial({
      map: poolTex, color: 0xb44a30, transparent: true, opacity: 0,
      depthWrite: false, side: THREE.DoubleSide
    });

    function rimEllipse(rx, rz, y, mat, parent) {
      var pts = [];
      for (var q = 0; q <= 96; q++) {
        var a = q / 96 * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a) * rx, y, Math.sin(a) * rz));
      }
      var l = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), mat);
      parent.add(l);
      return l;
    }

    OIL_FIELDS.forEach(function (f) {
      var fg = new THREE.Group();
      fg.position.set(f.x, f.y, f.z);
      oilGroup.add(fg);

      var water = new THREE.Mesh(oilSphere, waterFillMat);
      water.scale.set(f.rx * 1.05, f.ry * 0.42, f.rz * 1.05);
      water.position.y = -f.ry * 0.95;
      fg.add(water);
      rimEllipse(f.rx * 1.08, f.rz * 1.08, -f.ry * 0.95, waterRimMat, fg);

      var oil = new THREE.Mesh(oilSphere, oilFillMat);
      oil.scale.set(f.rx, f.ry, f.rz);
      fg.add(oil);
      var oilTop = new THREE.Mesh(poolGeo, oilTopMat);
      oilTop.rotation.x = -Math.PI / 2;
      oilTop.scale.set(f.rx, f.rz, 1);
      oilTop.position.y = 0.04;
      fg.add(oilTop);
      rimEllipse(f.rx, f.rz, 0.02, oilRimMat, fg);

      if (f.gas > 0) {
        var gas = new THREE.Mesh(oilSphere, gasFillMat);
        gas.scale.set(f.rx * f.gas, f.ry * 0.5, f.rz * f.gas);
        gas.position.y = f.ry * 0.82;
        fg.add(gas);
        var gasTop = new THREE.Mesh(poolGeo, gasTopMat);
        gasTop.rotation.x = -Math.PI / 2;
        gasTop.scale.set(f.rx * f.gas * 0.98, f.rz * f.gas * 0.98, 1);
        gasTop.position.y = f.ry * 0.82 + 0.03;
        fg.add(gasTop);
        rimEllipse(f.rx * f.gas, f.rz * f.gas, f.ry * 0.82, gasRimMat, fg);
      }

      var glow = new THREE.Sprite(oilGlowMat);
      glow.scale.set(f.rx * 2.6, f.rx * 1.15, 1);
      glow.position.y = f.ry * 0.25;
      fg.add(glow);

      var land = new THREE.Mesh(new THREE.SphereGeometry(0.42, 12, 8), landMat);
      land.position.y = f.ry * 1.45;
      fg.add(land);
    });

    /* 另外两口水平井：从井场分别偏向不同的含油砂体 */
    var wellMat2 = new THREE.MeshStandardMaterial({
      color: 0xd9c49b, emissive: 0x7a5c2e, emissiveIntensity: 0.9,
      roughness: 0.4, metalness: 0.4, transparent: true, opacity: 0
    });
    var extraCurves = [
      new THREE.CatmullRomCurve3([
        new THREE.Vector3(0.3, 7, 0.4),
        new THREE.Vector3(2.0, 0, 1.0),
        new THREE.Vector3(8, -6, 3),
        new THREE.Vector3(18, -13, 6),
        new THREE.Vector3(30, -17, 8),
        new THREE.Vector3(38, -19, 10)
      ]),
      new THREE.CatmullRomCurve3([
        new THREE.Vector3(0.6, 7, -0.3),
        new THREE.Vector3(2.0, 1, -1.5),
        new THREE.Vector3(5, -7, -6),
        new THREE.Vector3(12, -16, -12),
        new THREE.Vector3(20, -24, -18),
        new THREE.Vector3(26, -31, -22)
      ])
    ];
    var extraPulses = [];
    extraCurves.forEach(function (ec) {
      var tube = new THREE.Mesh(new THREE.TubeGeometry(ec, 120, 0.24, 6, false), wellMat2);
      oilGroup.add(tube);
      var pm = new THREE.MeshBasicMaterial({ color: 0xf0d9ae, transparent: true, opacity: 0, depthWrite: false });
      var ps = new THREE.Mesh(new THREE.SphereGeometry(0.55, 10, 8), pm);
      oilGroup.add(ps);
      extraPulses.push({ curve: ec, mesh: ps, mat: pm, off: Math.random() });
    });

    /* 流体图例：气顶 / 油环 / 水层 */
    function makeLegend() {
      var cv = global.document.createElement('canvas');
      cv.width = 360; cv.height = 240;
      var c = cv.getContext('2d');
      var rd = 12;
      c.beginPath();
      c.moveTo(rd, 0); c.lineTo(cv.width - rd, 0); c.quadraticCurveTo(cv.width, 0, cv.width, rd);
      c.lineTo(cv.width, cv.height - rd); c.quadraticCurveTo(cv.width, cv.height, cv.width - rd, cv.height);
      c.lineTo(rd, cv.height); c.quadraticCurveTo(0, cv.height, 0, cv.height - rd);
      c.lineTo(0, rd); c.quadraticCurveTo(0, 0, rd, 0);
      c.closePath();
      c.fillStyle = 'rgba(7,20,23,0.72)';
      c.fill();
      c.strokeStyle = 'rgba(205,184,150,0.28)';
      c.lineWidth = 1;
      c.stroke();
      c.textBaseline = 'middle';
      c.font = '600 15px ui-monospace,Consolas,"Courier New",monospace';
      c.fillStyle = 'rgba(217,196,155,.72)';
      c.fillText('FLUID CONTACT', 24, 28);
      c.strokeStyle = 'rgba(205,184,150,.20)';
      c.beginPath(); c.moveTo(24, 44); c.lineTo(336, 44); c.stroke();
      function row(y, color, zh, en) {
        c.fillStyle = color;
        c.beginPath(); c.arc(34, y, 8, 0, 6.2832); c.fill();
        c.font = '600 21px "PingFang SC","Microsoft YaHei",sans-serif';
        c.fillStyle = '#f2e6cf';
        c.fillText(zh, 54, y + 1);
        c.font = '500 14px ui-monospace,Consolas,"Courier New",monospace';
        c.fillStyle = 'rgba(240,234,219,.52)';
        c.fillText(en, 118, y + 1);
      }
      row(82, '#b4563a', '气顶', 'GAS CAP');
      row(126, '#d9a35e', '油环', 'OIL RIM');
      row(170, '#3f8f86', '水层', 'WATER');
      c.font = '500 13px ui-monospace,Consolas,"Courier New",monospace';
      c.fillStyle = 'rgba(240,234,219,.42)';
      c.fillText('T2 · 3 个含油砂体 · 井距 320 m', 24, 213);
      var tx = new THREE.CanvasTexture(cv);
      tx.minFilter = THREE.LinearFilter;
      tx.magFilter = THREE.LinearFilter;
      tx.generateMipmaps = false;
      if (THREE.sRGBEncoding !== undefined) tx.encoding = THREE.sRGBEncoding;
      var mat = new THREE.SpriteMaterial({
        map: tx, transparent: true, opacity: 0,
        depthTest: false, depthWrite: false, fog: false
      });
      var sp = new THREE.Sprite(mat);
      sp.scale.set(360 * 0.026, 240 * 0.026, 1);
      sp.renderOrder = 41;
      return sp;
    }
    var legend = makeLegend();
    legend.position.set(38, 16, 22);
    scene.add(legend);

    var annoOil = makeAnno('含油气砂体', '气顶 / 油环 / 水层 · 埋深 −2,100 ~ −3,300 m',
      '#ffd8a3', 0.022, [30, -4, 18], null, 0xd9a35e);

    /* ---------- 相机姿态 ---------- */
    function spherical(pos, target) {
      var dx = pos[0] - target[0], dy = pos[1] - target[1], dz = pos[2] - target[2];
      var r = Math.sqrt(dx * dx + dy * dy + dz * dz);
      return { r: r, theta: Math.atan2(dx, dz), phi: Math.acos(clamp(dy / r, -1, 1)) };
    }
    var poses = STATES.map(function (s) { return spherical(s.pos, s.target); });
    var camTarget = new THREE.Vector3(STATES[0].target[0], STATES[0].target[1], STATES[0].target[2]);
    var lookAt = new THREE.Vector3();
    var camSph = { r: poses[0].r, theta: poses[0].theta, phi: poses[0].phi };
    var goalTarget = camTarget.clone();
    var goalSph = { r: camSph.r, theta: camSph.theta, phi: camSph.phi };
    var mix = { strata: 1, well: 0.18, terrain: 0, oil: 0, pad: 1 };

    function applyState(instant) {
      var s = STATES[st.idx];
      goalTarget.set(s.target[0], s.target[1], s.target[2]);
      var sp = poses[st.idx];
      goalSph.r = sp.r; goalSph.theta = sp.theta; goalSph.phi = sp.phi;
      if (instant) {
        camTarget.copy(goalTarget);
        camSph.r = goalSph.r; camSph.theta = goalSph.theta; camSph.phi = goalSph.phi;
        mix.strata = s.strata; mix.well = s.well; mix.terrain = s.terrain; mix.oil = s.oil; mix.pad = s.pad;
      }
    }

    function resize() {
      var r = canvas.getBoundingClientRect();
      W = Math.max(320, r.width); H = Math.max(320, r.height);
      renderer.setSize(W, H, false);
      camera.aspect = W / H;
      /* 窄屏把视野放大一点，保证井场完整 */
      camera.fov = W < 640 ? 52 : 38;
      camera.updateProjectionMatrix();
    }

    function frame(dt) {
      t += dt * speed;
      if (!paused) {
        st.timer += dt * speed;
        if (st.timer >= DWELL) {
          st.idx = (st.idx + 1) % STATES.length;
          st.timer = 0;
          if (opts.onState) opts.onState(st.idx, STATES[st.idx]);
        }
        if (opts.onProgress) opts.onProgress(clamp(st.timer / DWELL, 0, 1));
      }
      var s = STATES[st.idx];
      var k = 1 - Math.pow(0.0016, dt);
      mix.strata = lerp(mix.strata, s.strata, k);
      mix.well = lerp(mix.well, s.well, k);
      mix.terrain = lerp(mix.terrain, s.terrain, k);
      mix.oil = lerp(mix.oil, s.oil, k);
      mix.pad = lerp(mix.pad, s.pad, k);
      if (!paused) orbit += dt * 0.045 * speed;
      camTarget.lerp(goalTarget, k);
      camSph.r = lerp(camSph.r, goalSph.r, k);
      camSph.theta = lerp(camSph.theta, goalSph.theta + orbit + drag.yaw, k);
      camSph.phi = clamp(lerp(camSph.phi, goalSph.phi + drag.pitch, k), 0.12, Math.PI - 0.12);
      var sp = Math.sin(camSph.phi), cp = Math.cos(camSph.phi);
      /* 窄屏：拉远并把取景中心抬高，让井场落在标题上方的空白里 */
      var narrow = W < 640;
      var rr = camSph.r * (narrow ? 1.75 : 1);
      lookAt.copy(camTarget);
      if (narrow) {
        lookAt.y -= 7;
        /* 油气分布整体偏右，窄屏把取景中心往右挪，避免砂体被裁掉 */
        if (s.key === 'petroleum') { lookAt.x += 16; lookAt.z += 2; }
      }
      camera.position.set(
        lookAt.x + rr * sp * Math.sin(camSph.theta),
        lookAt.y + rr * cp,
        lookAt.z + rr * sp * Math.cos(camSph.theta)
      );
      camera.lookAt(lookAt);

      /* 材质随状态过渡 */
      strataMats.forEach(function (m) {
        m.opacity = mix.strata;
        m.transparent = mix.strata < 0.985;
        m.depthWrite = mix.strata > 0.9;
      });
      strataSeamMats.forEach(function (m) {
        m.opacity = 0.18 * (1 - 0.92 * mix.oil);
      });
      grid.material.opacity = 0.14 * (1 - 0.92 * mix.oil);
      casingMat.opacity = 0.85 * (1 - 0.9 * mix.oil);
      wellMat.opacity = 0.18 + 0.82 * mix.well;
      wellMat.emissiveIntensity = 0.35 + 1.15 * mix.well + 0.12 * Math.sin(t * 1.1);

      /* 地形：走进地表状态时淡入 */
      var terrainOn = mix.terrain;
      var oilOn = mix.oil;
      var labelOn = W < 900 ? 0 : 1;
      terrainMesh.visible = terrainOn > 0.01;
      terFx.visible = terrainOn > 0.01;
      oilGroup.visible = oilOn > 0.01;
      terMat.opacity = terrainOn * 0.96;
      terMat.depthWrite = terrainOn > 0.9;
      surveyMat.opacity = 0.70 * terrainOn;
      surveyGridMat.opacity = 0.32 * terrainOn;
      stakeMat.opacity = 0.90 * terrainOn;
      stakeGlowMat.opacity = 0.95 * terrainOn;
      annoTerrain.mat.opacity = 0.92 * terrainOn * labelOn;
      annoTerrain.lineMat.opacity = 0.40 * terrainOn * labelOn;

      /* 油气分布：气顶、油环、水层与井网一起浮现 */
      oilFillMat.opacity = 0.14 * oilOn;
      gasFillMat.opacity = 0.18 * oilOn;
      waterFillMat.opacity = 0.10 * oilOn;
      oilTopMat.opacity = 0.82 * oilOn;
      gasTopMat.opacity = 0.88 * oilOn;
      oilRimMat.opacity = 0.55 * oilOn;
      gasRimMat.opacity = 0.50 * oilOn;
      waterRimMat.opacity = 0.35 * oilOn;
      landMat.opacity = 0.85 * oilOn;
      wellMat2.opacity = 0.65 * oilOn;
      wellMat2.emissiveIntensity = 0.4 + 0.9 * oilOn;
      legend.material.opacity = 0.92 * oilOn * labelOn;
      annoOil.mat.opacity = 0.92 * oilOn * labelOn;
      if (annoOil.lineMat) annoOil.lineMat.opacity = 0.40 * oilOn * labelOn;
      extraPulses.forEach(function (p) {
        p.mat.opacity = 0.70 * oilOn;
      });

      padGroup.traverse(function (o) {
        if (!o.material) return;
        if (o.isMesh) {
          if (o.material.transparent !== (mix.pad < 0.99)) {
            o.material.transparent = mix.pad < 0.99;
            o.material.needsUpdate = true;
          }
          o.material.opacity = (0.22 + 0.78 * mix.pad) * (1 - 0.95 * mix.oil);
        } else if (o.isLine || o.isLineSegments) {
          /* 结构边线不随父网格的材质透明度走，单独淡出 */
          o.material.transparent = true;
          o.material.opacity = 0.34 * (1 - 0.95 * mix.oil);
        }
      });

      /* 动起来的部分：游车升降、测量脉冲、储层呼吸、火炬闪烁 */
      if (traveling) traveling.position.y = tbBase + 6.5 * Math.sin(t * 0.85);
      var blockY = traveling ? traveling.position.y : tbBase;
      drillGeo.setFromPoints([
        new THREE.Vector3(0, blockY - 3.7, 0),
        new THREE.Vector3(0, 8.4, 0)
      ]);
      var pt = (t * 0.10) % 1;
      var pp = curve.getPointAt(pt);
      pulse.position.copy(pp);
      pulse.scale.setScalar(0.8 + 0.22 * Math.sin(t * 2.2));
      pulseMat.opacity = 0.35 + 0.55 * mix.well * (0.6 + 0.4 * Math.sin(t * 1.8));

      /* 油气分布：光晕呼吸 + 井筒里的测量脉冲 */
      oilGlowMat.opacity = (0.025 + 0.015 * Math.sin(t * 1.2)) * oilOn;
      extraPulses.forEach(function (p, pi) {
        var qt = (t * 0.055 + p.off) % 1;
        var qp = p.curve.getPointAt(qt);
        p.mesh.position.copy(qp);
        p.mesh.scale.setScalar(0.8 + 0.18 * Math.sin(t * 2.2 + pi));
      });

      /* 修改意见⑤：火炬由高频闪烁改为缓慢呼吸，亮暗幅度收小 */
      flareLight.intensity = calm ? 1.8 : 2.0 + 0.18 * Math.sin(t * 1.6) + 0.10 * Math.sin(t * 3.7);

      renderer.render(scene, camera);
    }

    function loop() {
      if (!running) return;
      var dt = Math.min(0.05, clock.getDelta());
      frames++;
      frame(dt);
      var now = (global.performance && performance.now()) || Date.now();
      if (now - lastWatch > 1000) {
        if (frames < 2) { stop(); start(); }     /* 看门狗：渲染循环被吞就重启 */
        frames = 0; lastWatch = now;
      }
      raf = global.requestAnimationFrame(loop);
    }
    function start() {
      if (running || paused) return;
      running = true; frames = 0;
      lastWatch = (global.performance && performance.now()) || Date.now();
      clock.getDelta();
      raf = global.requestAnimationFrame(loop);
    }
    function stop() {
      running = false;
      if (raf && global.cancelAnimationFrame) global.cancelAnimationFrame(raf);
      raf = null;
    }

    /* 拖拽 = 绕目标点转 */
    function onDown(ev) {
      drag.on = true; drag.x = ev.clientX; drag.y = ev.clientY;
      try { canvas.setPointerCapture(ev.pointerId); } catch (e) { }
      canvas.classList.add('grabbing');
    }
    function onMove(ev) {
      if (!drag.on) return;
      var dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      drag.x = ev.clientX; drag.y = ev.clientY;
      drag.yaw += dx * 0.005;
      drag.pitch = clamp(drag.pitch - dy * 0.004, -0.9, 0.9);
    }
    function onUp() { drag.on = false; canvas.classList.remove('grabbing'); }
    function onVis() { if (global.document.hidden) stop(); else if (visible) start(); }

    resize();
    applyState(true);
    frame(0.016);
    stageEl.classList.add('has3d');
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
    global.addEventListener('resize', resize);
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('pointerleave', onUp);

    if (opts.onState) opts.onState(0, STATES[0]);

    S = {
      go: function (i) {
        st.idx = (i + STATES.length) % STATES.length; st.timer = 0;
        applyState(false);
        if (opts.onState) opts.onState(st.idx, STATES[st.idx]);
        if (opts.onProgress) opts.onProgress(0);
      },
      pause: function () { paused = true; stop(); },
      resume: function () { paused = false; start(); },
      running: function () { return running; },
      modelOK: function () { return modelOK; },
      destroy: function () {
        stop();
        global.document.removeEventListener('visibilitychange', onVis);
        global.removeEventListener('resize', resize);
        canvas.removeEventListener('pointerdown', onDown);
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerup', onUp);
        canvas.removeEventListener('pointercancel', onUp);
        canvas.removeEventListener('pointerleave', onUp);
        if (io) { try { io.disconnect(); } catch (e) { } }
        try { renderer.dispose(); } catch (e) { }
        try { canvas.remove(); } catch (e) { }
        if (stageEl) stageEl.classList.remove('has3d');
      }
    };
    return true;
  }

  function destroy() { if (S) { try { S.destroy(); } catch (e) { } S = null; } }

  global.FX3D = {
    mount: mount,
    destroy: destroy,
    go: function (i) { if (S) S.go(i); },
    pause: function () { if (S) S.pause(); },
    resume: function () { if (S) S.resume(); },
    running: function () { return !!(S && S.running()); },
    modelOK: function () { return !!(S && S.modelOK()); },
    states: STATES
  };
})(window);
