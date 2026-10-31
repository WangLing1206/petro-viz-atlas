/* =========================================================
   井场 3D 模型生成器（开发期工具）
   ---------------------------------------------------------
   node tools/build-model.mjs

   输出：
     assets/models/wellpad.gltf      标准 glTF 2.0（内嵌 base64 缓冲）
     assets/models/wellpad.glb       二进制 glTF（实际加载）
     assets/models/wellpad.glb.js    同一份 GLB 的 base64（file:// 用）

   几何由两个原语拼出（单位：米，原点在井口正下方地面，y 向上）：
     beam(a, b, w, h)          两点之间的梁
     cylinder(a, b, r, seg)    两点之间的圆柱

   结构（对应一台陆地钻机）：
     场地 / 混凝土基础
     桁架式底座（4 根格构柱 + 交叉撑）→ 钻台面（工字梁 + 栏杆 + 斜梯）
     井架：7 层格构（主腿逐层收口、横撑、X 斜撑、剪刀撑）
           二层台、天车台、滑轮组、天车罩、笼式梯子、4 根绷绳
     钻台设备：转盘、绞车、司钻房、猫道与管排、立根排放
     井口：四闸板防喷器组 + 节流管汇 + 泥浆返出管线
     地面设备：储罐 ×2、泥浆泵房、火炬（发光）、地面管排
     游车 + 顶驱：单独节点，做升降动画
   ========================================================= */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT_DIR = path.join(ROOT, 'assets', 'models');

/* ---------- 向量 ---------- */
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const addv = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const nrm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/* ---------- 累加器 ---------- */
function newGroup() { return { pos: [], nor: [], idx: [] }; }
function pushTri(g, p, n) {
  const base = g.pos.length / 3;
  g.pos.push(p[0][0], p[0][1], p[0][2], p[1][0], p[1][1], p[1][2], p[2][0], p[2][1], p[2][2]);
  g.nor.push(n[0], n[1], n[2], n[0], n[1], n[2], n[0], n[1], n[2]);
  g.idx.push(base, base + 1, base + 2);
}
function pushQuad(g, a, b, c, d) {
  const n = nrm(cross(sub(b, a), sub(d, a)));
  pushTri(g, [a, b, c], n);
  pushTri(g, [a, c, d], n);
}

/* 梁：a→b，截面 w × h */
function beam(g, a, b, w, h) {
  const dir = nrm(sub(b, a));
  const up = Math.abs(dir[1]) > 0.95 ? [0, 0, 1] : [0, 1, 0];
  const right = nrm(cross(dir, up));
  const realUp = nrm(cross(right, dir));
  const hx = mul(right, w / 2), hy = mul(realUp, h / 2);
  const c = [
    addv(addv(a, mul(hx, -1)), mul(hy, -1)),
    addv(addv(a, mul(hx, 1)), mul(hy, -1)),
    addv(addv(b, mul(hx, 1)), mul(hy, -1)),
    addv(addv(b, mul(hx, -1)), mul(hy, -1)),
    addv(addv(a, mul(hx, -1)), mul(hy, 1)),
    addv(addv(a, mul(hx, 1)), mul(hy, 1)),
    addv(addv(b, mul(hx, 1)), mul(hy, 1)),
    addv(addv(b, mul(hx, -1)), mul(hy, 1))
  ];
  pushQuad(g, c[0], c[3], c[2], c[1]);
  pushQuad(g, c[4], c[5], c[6], c[7]);
  pushQuad(g, c[0], c[1], c[5], c[4]);
  pushQuad(g, c[2], c[3], c[7], c[6]);
  pushQuad(g, c[1], c[2], c[6], c[5]);
  pushQuad(g, c[3], c[0], c[4], c[7]);
}
/* 轴对齐盒子（中心 + 尺寸） */
function box(g, cx, cy, cz, sx, sy, sz) {
  const x0 = cx - sx / 2, x1 = cx + sx / 2;
  const y0 = cy - sy / 2, y1 = cy + sy / 2;
  const z0 = cz - sz / 2, z1 = cz + sz / 2;
  beam(g, [x0, y0, z0], [x1, y0, z0], sz, sy);
  beam(g, [x0, y1, z0], [x1, y1, z0], sz, sy);
  beam(g, [x1, y0, z0], [x1, y0, z1], sz, sy);
  beam(g, [x0, y0, z0], [x0, y0, z1], sz, sy);
}
/* 圆柱：a→b，半径 r */
function cylinder(g, a, b, r, seg = 10, capA = true, capB = true) {
  const dir = nrm(sub(b, a));
  const up = Math.abs(dir[1]) > 0.95 ? [0, 0, 1] : [0, 1, 0];
  const u = nrm(cross(dir, up));
  const v = nrm(cross(dir, u));
  const ring = (c) => {
    const out = [];
    for (let i = 0; i < seg; i++) {
      const th = i / seg * Math.PI * 2;
      out.push(addv(c, addv(mul(u, Math.cos(th) * r), mul(v, Math.sin(th) * r))));
    }
    return out;
  };
  const ra = ring(a), rb = ring(b);
  for (let i = 0; i < seg; i++) {
    const j = (i + 1) % seg;
    let base = g.pos.length / 3;
    const n1 = nrm(sub(ra[i], a)), n2 = nrm(sub(ra[j], a));
    g.pos.push(ra[i][0], ra[i][1], ra[i][2], ra[j][0], ra[j][1], ra[j][2], rb[j][0], rb[j][1], rb[j][2]);
    g.nor.push(n1[0], n1[1], n1[2], n2[0], n2[1], n2[2], n2[0], n2[1], n2[2]);
    g.idx.push(base, base + 1, base + 2);
    base = g.pos.length / 3;
    g.pos.push(ra[i][0], ra[i][1], ra[i][2], rb[j][0], rb[j][1], rb[j][2], rb[i][0], rb[i][1], rb[i][2]);
    g.nor.push(n1[0], n1[1], n1[2], n2[0], n2[1], n2[2], n1[0], n1[1], n1[2]);
    g.idx.push(base, base + 1, base + 2);
  }
  if (capA) for (let i = 1; i < seg - 1; i++) pushTri(g, [ra[0], ra[i + 1], ra[i]], mul(dir, -1));
  if (capB) for (let i = 1; i < seg - 1; i++) pushTri(g, [rb[0], rb[i], rb[i + 1]], dir);
}

/* ---------- 材质 ---------- */
const MATS = [
  { name: 'concrete', pbr: { baseColorFactor: [0.34, 0.37, 0.38, 1], metallicFactor: 0.0, roughnessFactor: 0.92 } },
  { name: 'steel', pbr: { baseColorFactor: [0.40, 0.45, 0.47, 1], metallicFactor: 0.85, roughnessFactor: 0.36 } },
  { name: 'paint', pbr: { baseColorFactor: [0.06, 0.30, 0.25, 1], metallicFactor: 0.45, roughnessFactor: 0.5 } },
  { name: 'amber', pbr: { baseColorFactor: [0.62, 0.36, 0.12, 1], metallicFactor: 0.4, roughnessFactor: 0.48 } },
  { name: 'tank', pbr: { baseColorFactor: [0.52, 0.51, 0.47, 1], metallicFactor: 0.35, roughnessFactor: 0.45 } },
  { name: 'flare', pbr: { baseColorFactor: [0.9, 0.42, 0.16, 1], metallicFactor: 0.2, roughnessFactor: 0.5, emissiveFactor: [1.0, 0.45, 0.12] } }
];
const groups = MATS.map(() => newGroup());
const mi = (name) => MATS.findIndex((m) => m.name === name);
const CON = groups[mi('concrete')], STEEL = groups[mi('steel')], PAINT = groups[mi('paint')];
const AMBER = groups[mi('amber')], TANK = groups[mi('tank')], FLARE = groups[mi('flare')];

/* =========================================================
   1. 场地与基础
   ========================================================= */
box(CON, 0, 0.35, 0, 46, 0.7, 32);
box(CON, 0, 0.8, 0, 24, 0.5, 20);

/* =========================================================
   2. 桁架式底座 + 钻台
   ========================================================= */
const FLOOR_Y = 7.2;
const LEG = 4.4;                          /* 底座半宽 */

/* 四角格构柱：竖向分段 + 两道横撑 + 外立面双向斜撑 */
[[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([sx, sz]) => {
  const x = sx * LEG, z = sz * LEG;
  for (let s = 0; s < 3; s++) {
    const ya = 1.0 + (FLOOR_Y - 1.0) * s / 3;
    const yb = 1.0 + (FLOOR_Y - 1.0) * (s + 1) / 3;
    beam(PAINT, [x, ya, z], [x, yb, z], 0.34, 0.34);
  }
  for (let s = 1; s <= 2; s++) {
    const y = 1.0 + (FLOOR_Y - 1.0) * s / 2;
    beam(STEEL, [x, y, z], [x - sx * LEG, y, z], 0.12, 0.12);
    beam(STEEL, [x, y, z], [x, y, z - sz * LEG], 0.12, 0.12);
  }
  beam(STEEL, [x, 1.0, z], [x - sx * LEG, FLOOR_Y, z], 0.10, 0.10);
  beam(STEEL, [x, FLOOR_Y, z], [x - sx * LEG, 1.0, z], 0.10, 0.10);
  beam(STEEL, [x, 1.0, z], [x, FLOOR_Y, z - sz * LEG], 0.10, 0.10);
});

/* 钻台面：四周边梁 + 内梁网格 + 台面板 */
beam(STEEL, [-5.0, FLOOR_Y, -5.0], [5.0, FLOOR_Y, -5.0], 0.4, 0.5);
beam(STEEL, [-5.0, FLOOR_Y, 5.0], [5.0, FLOOR_Y, 5.0], 0.4, 0.5);
beam(STEEL, [-5.0, FLOOR_Y, -5.0], [-5.0, FLOOR_Y, 5.0], 0.4, 0.5);
beam(STEEL, [5.0, FLOOR_Y, -5.0], [5.0, FLOOR_Y, 5.0], 0.4, 0.5);
for (let i = -1; i <= 1; i++) {
  beam(STEEL, [-5.0, FLOOR_Y - 0.12, i * 2.5], [5.0, FLOOR_Y - 0.12, i * 2.5], 0.26, 0.34);
  beam(STEEL, [i * 2.5, FLOOR_Y - 0.12, -5.0], [i * 2.5, FLOOR_Y - 0.12, 5.0], 0.26, 0.34);
}
box(STEEL, 0, FLOOR_Y + 0.26, 0, 9.6, 0.1, 9.6);
/* 台面边缘挡脚板 */
[[0, -4.85, 9.8, 0.12], [0, 4.85, 9.8, 0.12]].forEach(([x, z, sx, sz]) => {
  box(AMBER, x, FLOOR_Y + 0.42, z, sx, 0.22, sz);
});
[[-4.85, 0], [4.85, 0]].forEach(([x, z]) => {
  box(AMBER, x, FLOOR_Y + 0.42, z, 0.12, 0.22, 9.8);
});

/* 栏杆（三面，-z 侧留上下梯子） */
function railing(g, x0, z0, x1, z1, y) {
  const n = 6;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    beam(g, [x0 + (x1 - x0) * t, y + 0.1, z0 + (z1 - z0) * t], [x0 + (x1 - x0) * t, y + 1.15, z0 + (z1 - z0) * t], 0.08, 0.08);
  }
  beam(g, [x0, y + 1.1, z0], [x1, y + 1.1, z1], 0.07, 0.07);
  beam(g, [x0, y + 0.62, z0], [x1, y + 0.62, z1], 0.05, 0.05);
}
railing(AMBER, -4.8, -4.8, 4.8, -4.8, FLOOR_Y + 0.35);
railing(AMBER, -4.8, -4.8, -4.8, 4.8, FLOOR_Y + 0.35);
railing(AMBER, 4.8, -4.8, 4.8, 4.8, FLOOR_Y + 0.35);

/* 上下钻台的斜梯（-z 侧） */
for (let i = 0; i < 10; i++) {
  const y = 1.0 + (FLOOR_Y - 1.0) * (i + 0.5) / 10;
  box(STEEL, 1.7, y, -5.3 - (10 - i) * 0.46, 1.0, 0.07, 0.42);
}
beam(PAINT, [1.05, 1.0, -10.0], [1.05, FLOOR_Y + 0.3, -5.0], 0.08, 0.16);
beam(PAINT, [2.35, 1.0, -10.0], [2.35, FLOOR_Y + 0.3, -5.0], 0.08, 0.16);

/* =========================================================
   3. 井架：7 层格构
   ========================================================= */
const D_BASE_Y = FLOOR_Y + 0.35;
const D_TOP_Y = 36;
const PANELS = 7;
const S_BOT = 3.6, S_TOP = 1.65;

function cornersAt(y) {
  const t = (y - D_BASE_Y) / (D_TOP_Y - D_BASE_Y);
  const s = S_BOT + (S_TOP - S_BOT) * t;
  return [[-s, y, -s], [s, y, -s], [s, y, s], [-s, y, s]];
}

for (let p = 0; p < PANELS; p++) {
  const ya = D_BASE_Y + (D_TOP_Y - D_BASE_Y) * p / PANELS;
  const yb = D_BASE_Y + (D_TOP_Y - D_BASE_Y) * (p + 1) / PANELS;
  const ca = cornersAt(ya), cb = cornersAt(yb);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    beam(PAINT, ca[i], cb[i], 0.34, 0.34);          /* 主腿 */
    beam(STEEL, cb[i], cb[j], 0.16, 0.16);          /* 横撑 */
    if (!(p === 0 && i === 1)) {                    /* 底层正面留 V-door 门洞 */
      beam(STEEL, ca[i], cb[j], 0.13, 0.13);
      beam(STEEL, ca[j], cb[i], 0.13, 0.13);
    } else {
      beam(STEEL, ca[j], cb[i], 0.13, 0.13);
    }
  }
  if (p === 2 || p === 4) {                          /* 每两层的水平剪刀撑 */
    beam(STEEL, cb[0], cb[2], 0.09, 0.09);
    beam(STEEL, cb[1], cb[3], 0.09, 0.09);
  }
}

/* 二层台（monkey board） */
const MB_Y = D_BASE_Y + (D_TOP_Y - D_BASE_Y) * 0.56;
const mbS = S_BOT + (S_TOP - S_BOT) * ((MB_Y - D_BASE_Y) / (D_TOP_Y - D_BASE_Y)) + 1.3;
box(STEEL, 0, MB_Y, -mbS + 0.55, 2 * mbS, 0.1, 1.4);
railing(AMBER, -mbS + 0.4, -mbS + 1.15, mbS - 0.4, -mbS + 1.15, MB_Y);
beam(AMBER, [-mbS + 0.4, MB_Y, -mbS + 1.15], [-mbS + 0.4, MB_Y - 1.0, -mbS - 0.1], 0.07, 0.07);
beam(AMBER, [mbS - 0.4, MB_Y, -mbS + 1.15], [mbS - 0.4, MB_Y - 1.0, -mbS - 0.1], 0.07, 0.07);

/* 天车台 + 滑轮组 + 天车罩 */
const crownS = S_TOP + 0.6;
box(STEEL, 0, D_TOP_Y, 0, 2 * crownS, 0.26, 2 * crownS);
[[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([sx, sz]) => {
  beam(STEEL, [sx * crownS, D_TOP_Y - 0.9, sz * crownS], [sx * crownS, D_TOP_Y, sz * crownS], 0.18, 0.18);
});
railing(AMBER, -crownS, -crownS, crownS, -crownS, D_TOP_Y);
railing(AMBER, crownS, -crownS, crownS, crownS, D_TOP_Y);
for (let i = 0; i < 4; i++) {
  const x = -0.9 + i * 0.6;
  cylinder(STEEL, [x, D_TOP_Y + 0.8, -0.42], [x, D_TOP_Y + 0.8, 0.42], 0.5, 12);
}
box(PAINT, 0, D_TOP_Y + 1.7, 0, 3.2, 1.4, 2.3);

/* 笼式梯子（-z 面，钻台→天车台，带护笼） */
{
  const zB = -(S_BOT) - 0.34, zT = -(S_TOP) - 0.34;
  beam(STEEL, [-0.4, D_BASE_Y, zB], [-0.4, D_TOP_Y, zT], 0.06, 0.06);
  beam(STEEL, [0.4, D_BASE_Y, zB], [0.4, D_TOP_Y, zT], 0.06, 0.06);
  for (let i = 1; i < 28; i++) {
    const t = i / 28;
    const y = D_BASE_Y + (D_TOP_Y - D_BASE_Y) * t;
    const z = zB + (zT - zB) * t;
    beam(STEEL, [-0.4, y, z], [0.4, y, z], 0.045, 0.045);
  }
  for (let i = 1; i <= 7; i++) {
    const t = i / 8;
    const y = D_BASE_Y + (D_TOP_Y - D_BASE_Y) * t;
    const z = zB + (zT - zB) * t;
    beam(STEEL, [-0.6, y, z], [-0.6, y, z - 0.6], 0.045, 0.045);
    beam(STEEL, [0.6, y, z], [0.6, y, z - 0.6], 0.045, 0.045);
    beam(STEEL, [-0.6, y, z - 0.6], [0.6, y, z - 0.6], 0.045, 0.045);
  }
}

/* 井架工作灯：二层台、天车台与中段的四只小灯 */
[[0, D_TOP_Y + 0.9, 0], [0, MB_Y + 1.2, 0], [0, D_BASE_Y + 8, 0], [0, D_BASE_Y + 14, 0]].forEach(([x, y, z]) => {
  box(FLARE, x, y, z, 0.35, 0.22, 0.35);
});

/* 立根（井架内侧排放的钻杆） */
[[-1.0, -0.5], [-1.0, 0.5], [1.0, -0.5], [1.0, 0.5]].forEach(([x, z]) => {
  for (let i = 0; i < 3; i++) {
    cylinder(STEEL, [x + i * 0.17, FLOOR_Y + 0.45, z], [x + i * 0.17, MB_Y - 0.45, z], 0.075, 6);
  }
});

/* =========================================================
   4. 钻台设备
   ========================================================= */
/* 转盘 */
cylinder(STEEL, [0, FLOOR_Y + 0.34, 0], [0, FLOOR_Y + 0.9, 0], 1.6, 22);
cylinder(PAINT, [0, FLOOR_Y + 0.9, 0], [0, FLOOR_Y + 1.05, 0], 1.28, 22);
box(AMBER, 0, FLOOR_Y + 1.08, 0, 1.6, 0.06, 0.16);
/* 绞车 */
box(STEEL, -6.6, FLOOR_Y + 0.8, 3.4, 4.4, 1.6, 2.4);
cylinder(STEEL, [-7.1, FLOOR_Y + 1.9, 3.4], [-5.2, FLOOR_Y + 1.9, 3.4], 0.72, 12);
box(PAINT, -7.4, FLOOR_Y + 0.75, 1.5, 1.3, 1.4, 1.5);
/* 司钻房 */
box(PAINT, 5.8, FLOOR_Y + 1.15, 2.8, 3.1, 2.3, 2.7);
box(STEEL, 5.8, FLOOR_Y + 2.38, 2.8, 3.4, 0.14, 3.0);
box(AMBER, 5.8, FLOOR_Y + 1.65, 1.42, 2.5, 0.5, 0.06);
/* 猫道与管排（-z 侧） */
box(STEEL, 0, 1.2, -8.6, 3.0, 0.14, 10.5);
[[-1.15, -11.0], [1.15, -11.0], [-1.15, -4.4], [1.15, -4.4]].forEach(([x, z]) => {
  beam(STEEL, [x, 1.15, z], [x, 4.0, z], 0.14, 0.14);
});
for (let i = 0; i < 5; i++) {
  cylinder(STEEL, [-1.4, 1.3 + i * 0.15, -13.0], [-1.4, 1.3 + i * 0.15, -4.8], 0.08, 6);
  cylinder(STEEL, [1.4, 1.3 + i * 0.15, -13.0], [1.4, 1.3 + i * 0.15, -4.8], 0.08, 6);
}

/* =========================================================
   5. 井口：防喷器组 + 返出管线 + 节流管汇
   ========================================================= */
cylinder(AMBER, [0, 5.35, 0], [0, 6.55, 0], 1.02, 16);
cylinder(STEEL, [0, 4.2, 0], [0, 5.3, 0], 0.92, 16);
cylinder(AMBER, [0, 3.15, 0], [0, 4.15, 0], 1.12, 16);
cylinder(STEEL, [0, 2.35, 0], [0, 3.1, 0], 0.82, 16);
[[1, -0.62], [-1, -0.62]].forEach(([sx, sz]) => {
  cylinder(STEEL, [sx * 1.0, 4.9, sz * 1.0], [sx * 2.2, 4.9, sz * 1.0], 0.11, 8);
});
/* 泥浆返出：立管 → 鹅颈 → 回流管 → 泥浆罐 */
cylinder(STEEL, [0.9, 6.85, 0], [0.9, 6.85, -3.4], 0.25, 10);
cylinder(STEEL, [0.9, 6.85, -3.4], [0.9, 3.4, -6.4], 0.25, 10);
cylinder(STEEL, [0.9, 3.4, -6.4], [8.0, 3.4, -6.4], 0.25, 10);
/* 节流管汇 */
box(STEEL, 3.4, FLOOR_Y + 0.42, -6.8, 1.5, 0.45, 0.8);
cylinder(STEEL, [2.6, FLOOR_Y + 0.42, -6.8], [3.1, FLOOR_Y + 0.42, -6.8], 0.13, 8);

/* =========================================================
   6. 地面设备
   ========================================================= */
cylinder(TANK, [15, 0.7, 7], [15, 8.8, 7], 3.2, 22);
cylinder(STEEL, [15, 8.8, 7], [15, 9.2, 7], 3.3, 22);
cylinder(TANK, [15, 0.7, -4.5], [15, 7.4, -4.5], 2.7, 22);
cylinder(STEEL, [15, 7.4, -4.5], [15, 7.8, -4.5], 2.8, 22);
cylinder(STEEL, [11.4, 1.05, 7], [13.6, 1.05, 7], 0.27, 8);
cylinder(STEEL, [11.4, 1.05, -4.5], [13.6, 1.05, -4.5], 0.27, 8);
cylinder(STEEL, [15, 1.05, 3.2], [15, 1.05, -1.0], 0.23, 8);
/* 泥浆泵房 */
box(PAINT, -15, 2.7, 8, 6.6, 3.4, 5.4);
box(STEEL, -15, 4.5, 8, 7.0, 0.2, 5.8);
for (let i = 0; i < 3; i++) {
  cylinder(STEEL, [-18.2 + i * 1.15, 0.8, 5.4], [-18.2 + i * 1.15, 0.8, 4.4], 0.3, 8);
}
/* 火炬（带塔架） */
cylinder(STEEL, [-18.5, 0.7, -10], [-18.5, 27, -10], 0.5, 12);
cylinder(FLARE, [-18.5, 27, -10], [-18.5, 29.4, -10], 0.46, 12);
[[-19.8, -11.3], [-17.2, -11.3], [-19.8, -8.7], [-17.2, -8.7]].forEach(([x, z], i) => {
  const top = i < 2 ? 19 : 13;
  beam(STEEL, [x, 0.7, z], [-18.5 + (x + 18.5) * 0.22, top, -10 + (z + 10) * 0.22], 0.08, 0.08);
});
/* 地面管排 */
for (let i = 0; i < 4; i++) {
  cylinder(STEEL, [-10.5, 0.95 + i * 0.22, 11.5], [-3.0, 0.95 + i * 0.22, 11.5], 0.11, 8);
}

/* =========================================================
   7. 游车 + 顶驱（单独节点，做升降动画）
   ========================================================= */
const tbGroups = MATS.map(() => newGroup());
const TBS = tbGroups[mi('steel')], TBP = tbGroups[mi('paint')], TBA = tbGroups[mi('amber')];

box(TBS, 0, 0, 0, 1.9, 1.9, 1.5);
[[-0.95, -0.75], [0.95, -0.75], [0.95, 0.75], [-0.95, 0.75]].forEach(([x, z]) => {
  beam(TBS, [x, -0.95, z], [x, 0.95, z], 0.15, 0.15);
});
for (let i = 0; i < 3; i++) {
  cylinder(TBA, [-0.6 + i * 0.6, 0.2, -0.45], [-0.6 + i * 0.6, 0.2, 0.45], 0.3, 12);
}
/* 顶驱挂在游车下方 */
box(TBP, 0, -1.95, 0, 1.2, 1.6, 1.0);
cylinder(TBS, [0, -2.75, 0], [0, -3.7, 0], 0.17, 10);
box(TBA, 0, -2.15, 0.56, 0.5, 0.7, 0.2);

/* =========================================================
   8. 打包 glTF / GLB
   ========================================================= */
const viewArr = [], bufferViews = [], accessors = [];
let byteOffset = 0;
const pad4 = (n) => (n + 3) & ~3;

function addAccessor(arr, type, compType, count) {
  const buf = Buffer.alloc(arr.length * 4);
  for (let i = 0; i < arr.length; i++) {
    if (compType === 5125) buf.writeUInt32LE(arr[i], i * 4); else buf.writeFloatLE(arr[i], i * 4);
  }
  viewArr.push(buf);
  bufferViews.push({ buffer: 0, byteOffset, byteLength: buf.length, target: compType === 5125 ? 34963 : 34962 });
  accessors.push({ bufferView: bufferViews.length - 1, componentType: compType, count, type });
  byteOffset += pad4(buf.length);
  return accessors.length - 1;
}
function buildPrims(list) {
  const prims = [];
  list.forEach((g, i) => {
    if (!g.pos.length) return;
    const posA = addAccessor(g.pos, 'VEC3', 5126, g.pos.length / 3);
    const norA = addAccessor(g.nor, 'VEC3', 5126, g.nor.length / 3);
    const idxA = addAccessor(g.idx, 'SCALAR', 5125, g.idx.length);
    prims.push({ attributes: { POSITION: posA, NORMAL: norA }, indices: idxA, material: i });
  });
  return prims;
}
const padPrims = buildPrims(groups);
const tbPrims = buildPrims(tbGroups);

const bin = Buffer.concat(viewArr.map((b) => {
  const pad = pad4(b.length) - b.length;
  return pad ? Buffer.concat([b, Buffer.alloc(pad)]) : b;
}));

const gltf = {
  asset: { version: '2.0', generator: 'oil-map build-model' },
  scene: 0,
  scenes: [{ name: 'wellpad', nodes: [0, 1] }],
  nodes: [
    { name: 'wellpad', mesh: 0 },
    { name: 'travelingBlock', mesh: 1, translation: [0, 30, 0] }
  ],
  meshes: [
    { name: 'wellpad', primitives: padPrims },
    { name: 'travelingBlock', primitives: tbPrims }
  ],
  materials: MATS.map((m) => ({ name: m.name, pbrMetallicRoughness: m.pbr })),
  accessors, bufferViews,
  buffers: [{ byteLength: bin.length, uri: 'data:application/octet-stream;base64,' + bin.toString('base64') }]
};

fs.mkdirSync(OUT_DIR, { recursive: true });
const json = JSON.stringify(gltf);
fs.writeFileSync(path.join(OUT_DIR, 'wellpad.gltf'), json);

const glbJson = JSON.parse(json);
glbJson.buffers = [{ byteLength: bin.length }];
let jsonBuf = Buffer.from(JSON.stringify(glbJson), 'utf8');
const jp = (4 - (jsonBuf.length % 4)) % 4;
if (jp) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(jp, 0x20)]);
const bp = (4 - (bin.length % 4)) % 4;
const binPadded = bp ? Buffer.concat([bin, Buffer.alloc(bp, 0)]) : bin;
const total = 12 + 8 + jsonBuf.length + 8 + binPadded.length;
const glb = Buffer.alloc(total);
let off = 0;
glb.writeUInt32LE(0x46546C67, off); off += 4;
glb.writeUInt32LE(2, off); off += 4;
glb.writeUInt32LE(total, off); off += 4;
glb.writeUInt32LE(jsonBuf.length, off); off += 4;
glb.writeUInt32LE(0x4E4F534A, off); off += 4;
jsonBuf.copy(glb, off); off += jsonBuf.length;
glb.writeUInt32LE(binPadded.length, off); off += 4;
glb.writeUInt32LE(0x004E4942, off); off += 4;
binPadded.copy(glb, off);
fs.writeFileSync(path.join(OUT_DIR, 'wellpad.glb'), glb);
fs.writeFileSync(path.join(OUT_DIR, 'wellpad.glb.js'),
  '/* 自动生成：node tools/build-model.mjs —— 与 wellpad.glb 同一个模型。\n' +
  '   file:// 下不能 XHR 读本地文件，所以把 GLB 以 base64 内联；\n' +
  '   hero3d.js 解码成 ArrayBuffer 再交给 GLTFLoader.parse()。 */\n' +
  'window.WELLPAD_GLB = "' + glb.toString('base64') + '";\n');

const tris = padPrims.concat(tbPrims).reduce((a, p) => a + accessors[p.indices].count / 3, 0);
console.log('wellpad.gltf  ' + (json.length / 1024).toFixed(1) + ' KB');
console.log('wellpad.glb   ' + (glb.length / 1024).toFixed(1) + ' KB');
console.log('三角面数 ' + tris.toFixed(0) + ' · 井架 ' + D_TOP_Y + ' m · 钻台 ' + FLOOR_Y + ' m · 二层台 ' + MB_Y.toFixed(1) + ' m');
