/* =========================================================
   修井作业方案智能推荐 · 可运行示范
   ---------------------------------------------------------
   1) 16 井次历史修井案例库（故障 / 井深 / 套管通径 / 含水 /
      出砂 / 落物形态 / 落物外径 / 工艺 / 工具 / 效果 / 工期）
   2) 故障作为硬过滤；权重按故障分表，分类特征相等给分，
      数值特征按隶属度给分；含水、出砂只在相关故障上占权重
   3) 候选方案按 (故障, 工艺, 工具) 分组，先过工具台账
      「外径 / 最小可通过内径 / 适用落物尺寸」硬约束
   4) 知识图谱：故障 → 候选工艺（按施工顺序）→ 工具 → 效果分布
   运行在沙箱 iframe 里，不依赖主站、不联网。
   ========================================================= */
(function () {
  'use strict';

  /* ---------- 1. 实体 ---------- */
  var CASINGS = [
    { idm: 121.1, label: '5½" 17#', sub: '121.1' },
    { idm: 118.6, label: '5½" 23#', sub: '118.6' },
    { idm: 157.0, label: '7" 29#', sub: '157.0' }
  ];

  /* 故障 = 现象/原因层，不混入作业名 */
  var FAULTS = [
    { key: 'fish', name: '井下落物', note: '落物形态与外径决定工具能否进入、咬合', procs: ['kill', 'pull', 'print', 'fish', 'mill', 'wash', 'test'] },
    { key: 'part', name: '管柱断脱', note: '断口是否规则决定捞矛/公母锥是否可用', procs: ['kill', 'pull', 'print', 'fish', 'mill', 'wash', 'test'] },
    { key: 'sand', name: '砂卡出砂', note: '砂埋/砂卡，处理是冲砂与防砂', procs: ['kill', 'pull', 'wash', 'test'] },
    { key: 'water', name: '出水水淹', note: '先找水，再堵水', procs: ['kill', 'pull', 'plug', 'wash', 'test'] },
    { key: 'casing', name: '套管变形', note: '滚压/铣削/补贴恢复通径', procs: ['kill', 'pull', 'print', 'shape', 'wash', 'test'] }
  ];

  /* 工艺 = 作业动作层。压井是全局前置安全条件；洗井是善后，不是出水/砂卡的处理工艺 */
  var PROCS = [
    { key: 'kill', name: '压井', seq: 1, tag: '前置', desc: '井控前置：压井液建立液柱压力平衡地层压力，是全部作业的安全条件' },
    { key: 'pull', name: '起原井管柱', seq: 2, desc: '起出原井管柱，暴露鱼顶或套管变形段' },
    { key: 'print', name: '通井/打印', seq: 3, desc: '通井规通井、打印鱼顶，核实落物形态、外径与深度' },
    { key: 'fish', name: '打捞', seq: 4, desc: '按落物形态与外径选捞筒、捞矛、公母锥等' },
    { key: 'mill', name: '磨铣/套铣', seq: 5, desc: '磨铣大件/卡阻落物，或套铣环空解卡' },
    { key: 'shape', name: '套管整形', seq: 6, desc: '滚压、铣锥或补贴恢复套管通径与完整性' },
    { key: 'plug', name: '找堵水', seq: 7, desc: '生产测井/示踪找水，桥塞或化学堵剂堵水' },
    { key: 'wash', name: '洗井', seq: 8, desc: '洗井/冲砂，携出积砂与磨铣碎屑' },
    { key: 'test', name: '完井试压', seq: 9, tag: '收尾', desc: '完井试压合格后交井' }
  ];

  /* 工具台账：外径 / 最小可通过内径 / 适用落物尺寸与形态 */
  var TOOLS = [
    { key: 'kawa', name: '卡瓦打捞筒', proc: 'fish', faults: ['fish', 'part'], od: 108, minId: 112, cmin: 48, cmax: 95, forms: ['管状', '杆状'], use: '卡瓦咬合落物外壁，捞取管状/杆状落物' },
    { key: 'mao', name: '捞矛', proc: 'fish', faults: ['fish', 'part'], od: 95, minId: 100, cmin: 60, cmax: 95, forms: ['管状'], use: '进入落物内孔，矛瓦张紧后提拉' },
    { key: 'basket', name: '篮式捞筒', proc: 'fish', faults: ['fish', 'part'], od: 105, minId: 109, cmin: 15, cmax: 60, forms: ['小件', '柔索'], use: '回收磨铣碎屑、小件与柔索' },
    { key: 'zhui', name: '公锥 / 母锥', proc: 'fish', faults: ['fish', 'part'], od: 100, minId: 104, cmin: 25, cmax: 105, forms: ['管状', '杆状'], use: '仅用于规则内孔（公锥）或规则外壁（母锥）造扣' },
    { key: 'yiba', name: '一把抓', proc: 'fish', faults: ['fish', 'part'], od: 98, minId: 102, cmin: 10, cmax: 45, forms: ['柔索', '小件'], use: '抓取钢丝绳、电缆等柔索及小件' },
    { key: 'magnet', name: '磁力打捞器', proc: 'fish', faults: ['fish', 'part'], od: 90, minId: 95, cmin: 5, cmax: 40, forms: ['小件'], use: '打捞钳牙、螺帽等铁磁性小件' },
    { key: 'jar', name: '震击器', proc: 'fish', faults: ['fish', 'part'], od: 95, minId: 100, cmin: 25, cmax: 105, forms: ['管状', '杆状'], aux: true, use: '配合捞筒/捞矛解卡，上击或下击' },
    { key: 'safety', name: '安全接头', proc: 'fish', faults: ['fish', 'part'], od: 100, minId: 105, aux: true, use: '打捞/磨铣管柱配套，遇卡可脱手' },
    { key: 'mill', name: '磨鞋', proc: 'mill', faults: ['fish', 'part'], od: 112, minId: 116, cmin: 60, cmax: 999, forms: ['大件', '管状', '杆状'], use: '磨铣大件、卡阻落物或落物顶部' },
    { key: 'washpipe', name: '套铣筒', proc: 'mill', faults: ['fish', 'part'], od: 116, minId: 120, cmin: 60, cmax: 130, forms: ['大件', '管状'], use: '套铣环空砂卡/水泥卡，套住落物解卡' },
    { key: 'shaper', name: '滚压整形器', proc: 'shape', faults: ['casing'], od: 108, minId: 112, use: '滚压修复套管椭圆变形' },
    { key: 'millcone', name: '铣锥', proc: 'shape', faults: ['casing'], od: 110, minId: 114, use: '铣削套管局部凹坑/毛刺，恢复通径' },
    { key: 'patch', name: '套管补贴', proc: 'shape', faults: ['casing'], od: 104, minId: 108, use: '补贴管覆盖变形/破损段，恢复完整性' },
    { key: 'logging', name: '生产测井 / 示踪', proc: 'plug', faults: ['water'], od: 43, minId: 50, use: '找水：产出剖面与示踪剂确定出水层' },
    { key: 'plug', name: '桥塞', proc: 'plug', faults: ['water'], od: 100, minId: 104, use: '机械封堵出水层' },
    { key: 'chemical', name: '化学堵剂', proc: 'plug', faults: ['water'], od: 0, minId: 0, use: '挤注堵剂封堵出水层/窜槽' },
    { key: 'sandpipe', name: '冲砂管柱', proc: 'wash', faults: ['sand'], od: 73, minId: 78, use: '正/反循环冲砂，携出井筒积砂' },
    { key: 'screen', name: '筛管', proc: 'wash', faults: ['sand'], od: 102, minId: 106, use: '防砂：挡砂筛管完井，控制出砂' }
  ];

  var EFFECTS = [
    { key: 'once', name: '一次成功' },
    { key: 'multi', name: '多次起下钻' },
    { key: 'second', name: '需二次措施' }
  ];

  /* ---------- 2. 历史案例库（示范 16 井次） ---------- */
  var CASES = [
    /* 井下落物 5 井次 */
    { id: 'Y-1042', fault: 'fish', depth: 2100, idm: 121.1, water: 12, sand: 0, form: '管状', size: 73, tool: 'kawa', effect: 'once', days: 4.5, succ: 0.92 },
    { id: 'Y-1010', fault: 'fish', depth: 1900, idm: 121.1, water: 20, sand: 0, form: '杆状', size: 62, tool: 'kawa', effect: 'multi', days: 5.0, succ: 0.88 },
    { id: 'Y-1188', fault: 'fish', depth: 2750, idm: 118.6, water: 30, sand: 0, form: '柔索', size: 25, tool: 'yiba', effect: 'multi', days: 6.0, succ: 0.85 },
    { id: 'Y-1231', fault: 'fish', depth: 3200, idm: 157.0, water: 8, sand: 0, form: '大件', size: 110, tool: 'mill', effect: 'second', days: 7.5, succ: 0.78 },
    { id: 'Y-0907', fault: 'fish', depth: 1600, idm: 121.1, water: 5, sand: 0, form: '小件', size: 30, tool: 'magnet', effect: 'once', days: 3.0, succ: 0.95 },
    /* 管柱断脱 3 井次 */
    { id: 'Y-1350', fault: 'part', depth: 2800, idm: 118.6, water: 40, sand: 0, form: '管状', size: 73, tool: 'kawa', effect: 'multi', days: 8.0, succ: 0.80 },
    { id: 'Y-1470', fault: 'part', depth: 3600, idm: 157.0, water: 25, sand: 0, form: '管状', size: 89, tool: 'mao', effect: 'second', days: 12.0, succ: 0.68 },
    { id: 'Y-1298', fault: 'part', depth: 2200, idm: 121.1, water: 35, sand: 0, form: '杆状', size: 25, tool: 'zhui', effect: 'multi', days: 6.5, succ: 0.75 },
    /* 砂卡出砂 3 井次 */
    { id: 'Y-1033', fault: 'sand', depth: 1200, idm: 121.1, water: 55, sand: 1, tool: 'sandpipe', effect: 'once', days: 3.5, succ: 0.93 },
    { id: 'Y-1290', fault: 'sand', depth: 2200, idm: 118.6, water: 68, sand: 1, tool: 'sandpipe', effect: 'multi', days: 5.5, succ: 0.86 },
    { id: 'Y-1399', fault: 'sand', depth: 2600, idm: 157.0, water: 72, sand: 1, tool: 'screen', effect: 'second', days: 6.0, succ: 0.81 },
    /* 出水水淹 2 井次 */
    { id: 'Y-1120', fault: 'water', depth: 1500, idm: 121.1, water: 85, sand: 0, tool: 'plug', effect: 'once', days: 3.0, succ: 0.90 },
    { id: 'Y-1265', fault: 'water', depth: 2400, idm: 118.6, water: 92, sand: 0, tool: 'chemical', effect: 'multi', days: 4.0, succ: 0.82 },
    /* 套管变形 3 井次 */
    { id: 'Y-1310', fault: 'casing', depth: 1800, idm: 121.1, water: 45, sand: 0, tool: 'shaper', effect: 'once', days: 5.0, succ: 0.88 },
    { id: 'Y-1402', fault: 'casing', depth: 2600, idm: 118.6, water: 60, sand: 1, tool: 'millcone', effect: 'second', days: 9.0, succ: 0.72 },
    { id: 'Y-1455', fault: 'casing', depth: 3400, idm: 157.0, water: 20, sand: 0, tool: 'patch', effect: 'multi', days: 11.0, succ: 0.65 }
  ];

  /* ---------- 3. 分故障权重（每行之和 = 1.00） ---------- */
  var FEATURE_KEYS = ['fault', 'depth', 'idm', 'water', 'sand', 'form', 'size'];
  var FEATURE_LABEL = {
    fault: '故障同族', depth: '井深', idm: '套管内径', water: '含水率',
    sand: '出砂', form: '落物形态', size: '落物外径'
  };
  var WEIGHTS = {
    /* 打捞：含水/出砂基本无判别力；落物形态与外径是硬信息 */
    fish: { fault: 0.20, depth: 0.20, idm: 0.10, water: 0.00, sand: 0.00, form: 0.25, size: 0.25 },
    /* 断脱：外径决定捞筒/捞矛能否咬合，权重更高 */
    part: { fault: 0.20, depth: 0.20, idm: 0.10, water: 0.00, sand: 0.00, form: 0.20, size: 0.30 },
    /* 砂卡：出砂是主特征 */
    sand: { fault: 0.25, depth: 0.20, idm: 0.15, water: 0.10, sand: 0.30, form: 0.00, size: 0.00 },
    /* 出水：含水是主特征 */
    water: { fault: 0.25, depth: 0.15, idm: 0.10, water: 0.50, sand: 0.00, form: 0.00, size: 0.00 },
    /* 套管变形：通径与变形深度为主，含水/出砂不参与 */
    casing: { fault: 0.35, depth: 0.30, idm: 0.35, water: 0.00, sand: 0.00, form: 0.00, size: 0.00 }
  };
  var DEPTH_RANGE = 2400;

  var STATE_DEFAULT = { fault: 'fish', idm: 121.1, depth: 2400, water: 30, sand: false, form: '管状', size: 73 };
  var state = { fault: 'fish', idm: 121.1, depth: 2400, water: 30, sand: false, form: '管状', size: 73, selPlan: 0, selCase: null };
  var model = { q: null, hits: [], plans: [], map: {} };

  /* ---------- 4. 小工具 ---------- */
  function byKey(list, key) {
    for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i];
    return null;
  }
  function toolByKey(k) { return byKey(TOOLS, k); }
  function faultByKey(k) { return byKey(FAULTS, k); }
  function procByKey(k) { return byKey(PROCS, k); }
  function effectName(k) { var e = byKey(EFFECTS, k); return e ? e.name : k; }
  function faultName(k) { var f = faultByKey(k); return f ? f.name : k; }
  function procName(k) { var p = procByKey(k); return p ? p.name : k; }
  function faultProcs(k) { var f = faultByKey(k); return f ? f.procs : []; }
  function casingLabel(idm) {
    for (var i = 0; i < CASINGS.length; i++) {
      if (Math.abs(CASINGS[i].idm - idm) < 0.05) return CASINGS[i].label + '，通径 ' + idm.toFixed(1) + ' mm';
    }
    return idm.toFixed(1) + ' mm';
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmtDays(x) { return String(Math.round(x * 10) / 10); }
  function catchText(t) {
    if (t.cmin == null) return '—';
    return t.cmax >= 999 ? ('≥' + t.cmin + ' mm') : (t.cmin + '—' + t.cmax + ' mm');
  }

  /* ---------- 5. 相似度（故障硬过滤 + 分故障权重） ---------- */
  function formSim(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    if ((a === '管状' && b === '杆状') || (a === '杆状' && b === '管状')) return 0.5;
    if ((a === '小件' && b === '柔索') || (a === '柔索' && b === '小件')) return 0.4;
    return 0;
  }
  function sizeSim(a, b) {
    if (a == null || b == null) return 0;
    return 1 - Math.min(1, Math.abs(a - b) / 60);
  }

  function similarity(q, c) {
    var p = {
      fault: q.fault === c.fault ? 1 : 0,
      depth: 1 - Math.min(1, Math.abs(q.depth - c.depth) / DEPTH_RANGE),
      idm: Math.abs(q.idm - c.idm) < 0.05 ? 1 : 0,
      water: 1 - Math.min(1, Math.abs(q.water - c.water) / 100),
      sand: q.sand === c.sand ? 1 : 0,
      form: formSim(q.form, c.form),
      size: sizeSim(q.size, c.size)
    };
    var w = WEIGHTS[q.fault] || WEIGHTS.fish;
    var sum = 0, parts = [];
    FEATURE_KEYS.forEach(function (k) {
      parts.push({ key: k, p: p[k], w: w[k], v: w[k] * p[k] });
      sum += w[k] * p[k];
    });
    return { sim: sum, parts: parts };
  }

  /* 故障族硬过滤：候选与历史表都不跨故障 */
  function search(q) {
    return CASES.filter(function (c) { return c.fault === q.fault; }).map(function (c) {
      var r = similarity(q, c);
      return { c: c, sim: r.sim, parts: r.parts };
    }).sort(function (a, b) { return b.sim - a.sim; });
  }

  /* 工具台账硬约束：通径 → 落物尺寸 → 落物形态 */
  function toolIssue(t, q) {
    if (!t) return '工具不在台账';
    if (t.faults.indexOf(q.fault) < 0) return '不适用于' + faultName(q.fault);
    if (t.aux) return '配套工具，不单独推荐';
    if (t.minId && q.idm < t.minId) return '需通径 ≥' + t.minId + ' mm，当前 ' + q.idm.toFixed(1) + ' mm';
    if ((q.fault === 'fish' || q.fault === 'part') && t.cmin != null) {
      if (q.size < t.cmin || q.size > t.cmax) return '适用落物 ' + catchText(t) + '，当前 ' + q.size + ' mm';
      if (t.forms && t.forms.indexOf(q.form) < 0) return '不适用于' + q.form + '落物';
    }
    return null;
  }

  /* ---------- 6. 候选方案：按 (故障, 工艺, 工具) 分组 ---------- */
  function buildPlans(hits, q) {
    var groups = {}, order = [];
    hits.forEach(function (h) {
      var t = toolByKey(h.c.tool);
      if (!t || toolIssue(t, q)) return;
      var k = h.c.fault + '|' + t.proc + '|' + t.key;
      if (!groups[k]) {
        groups[k] = { key: k, fault: h.c.fault, proc: t.proc, tool: t.key, cases: [] };
        order.push(k);
      }
      groups[k].cases.push(h);
    });
    var plans = order.map(function (k) {
      var g = groups[k], wsum = 0, simSum = 0, succSum = 0, days = [], succs = [];
      g.cases.forEach(function (h) {
        var w = 0.15 + h.sim;
        wsum += w;
        simSum += h.sim * w;
        succSum += h.c.succ * w;
        days.push(h.c.days);
        succs.push(h.c.succ);
      });
      var p = {
        fault: g.fault, proc: g.proc, tool: g.tool, cases: g.cases,
        n: g.cases.length,
        sim: simSum / wsum,
        succ: succSum / wsum,
        succMin: Math.min.apply(null, succs),
        succMax: Math.max.apply(null, succs),
        dmin: Math.min.apply(null, days),
        dmax: Math.max.apply(null, days)
      };
      p.score = p.sim * p.succ;
      return p;
    });
    plans.sort(function (a, b) { return b.score - a.score; });
    return plans.slice(0, 3);
  }

  /* ---------- 7. 图谱布局 ---------- */
  var COL = [
    { kind: 'fault', x: 6, w: 92, items: FAULTS },
    { kind: 'proc', x: 132, w: 112, items: PROCS },
    { kind: 'tool', x: 278, w: 142, items: TOOLS },
    { kind: 'effect', x: 464, w: 100, items: EFFECTS }
  ];
  var COL_BY_KIND = {};
  COL.forEach(function (c) { COL_BY_KIND[c.kind] = c; });
  var NH = 21, GAP = 3, TOP = 44, BOT = 484;
  var EFFECT_ITEMS = EFFECTS;   /* 当前故障族实际出现过的效果 */
  var CUR_FAULT = null;

  function nodePos(kind, key) {
    var col = COL_BY_KIND[kind];
    var list = kind === 'effect' ? EFFECT_ITEMS : col.items, idx = 0;
    for (var i = 0; i < list.length; i++) if (list[i].key === key) idx = i;
    var n = list.length;
    var total = n * NH + (n - 1) * GAP;
    var y = TOP + (BOT - TOP - total) / 2 + idx * (NH + GAP);
    return { x: col.x, y: y, w: col.w, h: NH, cx: col.x + col.w / 2, cy: y + NH / 2 };
  }

  var NODE_STYLE = {
    fault: { fill: '#f5e6e1', stroke: '#dcc3bd', text: '#a64b3c' },
    proc: { fill: '#f4e8d4', stroke: '#e3d2b0', text: '#83551f' },
    tool: { fill: '#e5ebf0', stroke: '#cdd8e2', text: '#355c74' },
    effect: { fill: '#e7eee9', stroke: '#c8dbd2', text: '#123a3d' }
  };

  function planChain(fk, tp) {
    var fp = faultProcs(fk), out = [];
    ['kill', 'pull', 'print'].forEach(function (k) {
      if (fp.indexOf(k) >= 0) out.push(k);
    });
    if (tp && fp.indexOf(tp) >= 0 && out.indexOf(tp) < 0) out.push(tp);
    ['wash', 'test'].forEach(function (k) {
      if (fp.indexOf(k) >= 0 && out.indexOf(k) < 0) out.push(k);
    });
    return out;
  }

  function toolCases(key) {
    return CASES.filter(function (c) { return c.tool === key; });
  }

  function toolTitle(t) {
    var cs = toolCases(t.key);
    var avg = 0;
    if (cs.length) {
      cs.forEach(function (c) { avg += c.succ; });
      avg = avg / cs.length;
    }
    var spec = t.od ? ('外径 ' + t.od + ' mm，最小可通过内径 ' + t.minId + ' mm') : '流体/无刚性外径';
    var cap = t.cmin != null ? ('；适用落物 ' + catchText(t) + '（' + t.forms.join('、') + '）') : '';
    var hist = cs.length ? ('；全库 ' + cs.length + ' 井次，平均成功率 ' + avg.toFixed(2)) : '；示范库暂无案例';
    return t.name + '（' + procName(t.proc) + '）：' + spec + cap + hist +
      (cs.length ? '；点击定位最相似案例' : '');
  }

  function faultTitle(f) {
    var n = CASES.filter(function (c) { return c.fault === f.key; }).length;
    return f.name + '：' + f.note + '；同族 ' + n + ' 井次；点击切换故障';
  }
  function procTitle(p) {
    return '工序 ' + p.seq + ' · ' + p.name + '：' + p.desc; 
  }
  function effectTitle(e) {
    var n = CASES.filter(function (c) { return c.effect === e.key && (!CUR_FAULT || c.fault === CUR_FAULT); }).length;
    return e.name + '：当前故障族 ' + n + ' 井次；点击定位案例';
  }

  function edgeEl(a, b, cls, extra, title) {
    var x1 = a.x + a.w, y1 = a.cy, x2 = b.x, y2 = b.cy, mx = (x1 + x2) / 2;
    return '<path class="gedge ' + cls + '" d="M' + x1.toFixed(1) + ' ' + y1.toFixed(1) +
      ' C' + mx.toFixed(1) + ' ' + y1.toFixed(1) + ' ' + mx.toFixed(1) + ' ' + y2.toFixed(1) +
      ' ' + x2.toFixed(1) + ' ' + y2.toFixed(1) + '"' + (extra || '') + '>' +
      (title ? '<title>' + esc(title) + '</title>' : '') + '</path>';
  }

  function renderNode(kind, item, cls) {
    var p = nodePos(kind, item.key), st = NODE_STYLE[kind];
    var title = kind === 'fault' ? faultTitle(item) : kind === 'proc' ? procTitle(item) :
      kind === 'tool' ? toolTitle(item) : effectTitle(item);
    var dashed = (kind === 'proc' && item.tag) ? ' stroke-dasharray="3 2"' : '';
    var fill = cls === 'hot' ? '#ffffff' : st.fill;
    var stroke = cls === 'hot' ? '#123a3d' : cls === 'chain' ? '#6f9e94' : st.stroke;
    var txt = cls === 'hot' ? '#123a3d' : st.text;
    return '<g class="gnode ' + cls + '" data-kind="' + kind + '" data-key="' + esc(item.key) + '" tabindex="0" role="button" aria-label="' + esc(item.name) + '">' +
      '<title>' + esc(title) + '</title>' +
      '<rect x="' + p.x.toFixed(1) + '" y="' + p.y.toFixed(1) + '" width="' + p.w + '" height="' + p.h + '" rx="5" fill="' + fill + '" stroke="' + stroke + '"' + dashed + '/>' +
      '<text x="' + p.cx.toFixed(1) + '" y="' + (p.cy + 3.6).toFixed(1) + '" font-size="10.5" text-anchor="middle" fill="' + txt + '"' +
      (cls === 'hot' ? ' font-weight="600"' : '') + '>' + esc(item.name) + '</text></g>';
  }

  function drawGraph() {
    var hit = currentHit();
    var cf = hit ? hit.c.fault : state.fault;
    var selTool = hit ? hit.c.tool : null;
    var selEffect = hit ? hit.c.effect : null;
    var t = selTool ? toolByKey(selTool) : null;
    var toolProc = t ? t.proc : null;
    var chain = planChain(cf, toolProc);
    var faultSet = faultProcs(cf);
    CUR_FAULT = cf;
    EFFECT_ITEMS = EFFECTS.filter(function (e) {
      return CASES.some(function (c) { return c.fault === cf && c.effect === e.key; });
    });
    var s = '';

    [['fault', '① 故障现象'], ['proc', '② 候选工艺 · 施工顺序'], ['tool', '③ 工具'], ['effect', '④ 历史效果分布']].forEach(function (h) {
      var col = COL_BY_KIND[h[0]];
      s += '<text x="' + (col.x + 2) + '" y="16" font-size="10" font-family="monospace" fill="#99a3a4" letter-spacing="0.8">' + h[1] + '</text>';
    });

    /* 故障 → 候选工艺：当前故障画完整候选集，其余故障只保留到「压井」的弱连接 */
    FAULTS.forEach(function (f) {
      if (f.key === cf) {
        faultProcs(f.key).forEach(function (pk) {
          var cls = pk === toolProc ? 'hot' : (chain.indexOf(pk) >= 0 ? 'chain' : 'alt');
          s += edgeEl(nodePos('fault', f.key), nodePos('proc', pk), cls);
        });
      } else {
        s += edgeEl(nodePos('fault', f.key), nodePos('proc', 'kill'), 'dim');
      }
    });

    /* 工艺 → 工具：非本故障工具弱化 */
    TOOLS.forEach(function (x) {
      var applicable = x.faults.indexOf(cf) >= 0;
      s += edgeEl(nodePos('proc', x.proc), nodePos('tool', x.key),
        x.key === selTool ? 'hot' : (applicable ? '' : 'dim'));
    });

    /* 工具 → 效果：按历史案例画分布，不画唯一确定性边 */
    TOOLS.forEach(function (x) {
      var applicable = x.faults.indexOf(cf) >= 0;
      var counts = { once: 0, multi: 0, second: 0 };
      CASES.forEach(function (c) { if (c.tool === x.key && c.fault === cf) counts[c.effect]++; });
      EFFECT_ITEMS.forEach(function (e) {
        var n = counts[e.key];
        if (!n) return;
        var on = x.key === selTool && e.key === selEffect;
        var strong = x.key === selTool;
        var cls = on ? 'dist on' : strong ? 'dist strong' : (applicable ? 'dist' : 'dist dim');
        var width = on ? 2.2 : strong ? 1.5 : (applicable ? 0.9 : 0.6);
        var op = on ? 0.95 : strong ? 0.55 : (applicable ? 0.22 : 0.08);
        s += edgeEl(nodePos('tool', x.key), nodePos('effect', e.key), cls,
          ' style="stroke-width:' + width + ';opacity:' + op + '"',
          x.name + ' → ' + e.name + '：' + n + ' 井次');
        if (strong) {
          var a = nodePos('tool', x.key), b = nodePos('effect', e.key);
          var lx = (a.x + a.w) + (b.x - a.x - a.w) * 0.55;
          var ly = a.cy + (b.cy - a.cy) * 0.55 - 2;
          s += '<text x="' + lx.toFixed(1) + '" y="' + ly.toFixed(1) + '" font-size="10" text-anchor="middle" fill="' + (on ? '#123a3d' : '#6f9e94') + '">' + n + '</text>';
        }
      });
    });

    COL.forEach(function (col) {
      var items = col.kind === 'effect' ? EFFECT_ITEMS : col.items;
      items.forEach(function (it) {
        var cls = '';
        if (col.kind === 'fault') cls = it.key === cf ? 'hot' : '';
        else if (col.kind === 'proc') {
          cls = it.key === toolProc ? 'hot' : (chain.indexOf(it.key) >= 0 ? 'chain' :
            (faultSet.indexOf(it.key) >= 0 ? 'alt' : 'dim'));
        }
        else if (col.kind === 'tool') {
          cls = it.key === selTool ? 'hot' : (it.faults.indexOf(cf) >= 0 ? '' : 'dim');
        }
        else if (col.kind === 'effect') cls = it.key === selEffect ? 'hot' : '';
        s += renderNode(col.kind, it, cls);
      });
    });

    el('graph').innerHTML = s;
  }

  /* ---------- 8. 查询与选中态 ---------- */
  function query() {
    return {
      fault: state.fault, depth: state.depth, idm: state.idm,
      water: state.water, sand: state.sand ? 1 : 0, form: state.form, size: state.size
    };
  }

  function currentHit() { return state.selCase ? model.map[state.selCase] || null : null; }
  function selectedPlan() { return state.selPlan >= 0 && state.selPlan < model.plans.length ? model.plans[state.selPlan] : null; }

  function sync() {
    model.q = query();
    model.hits = search(model.q);
    model.plans = buildPlans(model.hits, model.q);
    model.map = {};
    model.hits.forEach(function (h) { model.map[h.c.id] = h; });

    if (!model.plans.length) {
      state.selPlan = -1;
      state.selCase = null;
    } else {
      if (state.selPlan < 0 || state.selPlan >= model.plans.length) state.selPlan = 0;
      if (!state.selCase || !model.map[state.selCase]) state.selCase = model.plans[state.selPlan].cases[0].c.id;
    }
    renderAll();
  }

  function onQueryChange() {
    state.selPlan = 0;
    state.selCase = null;
    sync();
  }

  function selectPlan(i) {
    var p = model.plans[i];
    if (!p) return;
    state.selPlan = i;
    state.selCase = p.cases[0].c.id;
    renderAll();
  }

  function selectHit(id) {
    var h = model.map[id];
    if (!h) return;
    state.selCase = id;
    state.selPlan = -1;
    for (var i = 0; i < model.plans.length; i++) {
      if (model.plans[i].fault === h.c.fault && model.plans[i].tool === h.c.tool) { state.selPlan = i; break; }
    }
    renderAll();
  }

  function noteMsg(msg) { el('note').innerHTML = msg; }

  function selectTool(key) {
    var h = null;
    for (var i = 0; i < model.hits.length; i++) if (model.hits[i].c.tool === key) { h = model.hits[i]; break; }
    if (!h) { noteMsg('示范库暂无「' + toolByKey(key).name + '」的作业证据；右下方工具台账仍可查它的外径与适用落物尺寸。'); return; }
    selectHit(h.c.id);
  }
  function selectProc(key) {
    var h = null;
    for (var i = 0; i < model.hits.length; i++) if (toolByKey(model.hits[i].c.tool).proc === key) { h = model.hits[i]; break; }
    if (!h) { noteMsg('当前故障族没有「' + procName(key) + '」的历史案例。'); return; }
    selectHit(h.c.id);
  }
  function selectEffect(key) {
    var h = null;
    for (var i = 0; i < model.hits.length; i++) if (model.hits[i].c.effect === key) { h = model.hits[i]; break; }
    if (!h) { noteMsg('当前故障族没有「' + effectName(key) + '」的历史案例。'); return; }
    selectHit(h.c.id);
  }

  /* ---------- 9. 渲染 ---------- */
  var el = function (id) { return document.getElementById(id); };

  function daysHtml(p) {
    var d = p.dmin === p.dmax ? fmtDays(p.dmin) + ' 天' : fmtDays(p.dmin) + '—' + fmtDays(p.dmax) + ' 天';
    return d + '<small>n=' + p.n + '</small>';
  }

  function renderPlans() {
    if (!model.plans.length) {
      el('plans').innerHTML = '<p class="empty">当前井况下没有工具通过通径 / 落物尺寸硬约束。请核对套管规格、落物形态与外径。</p>';
      return;
    }
    el('plans').innerHTML = model.plans.map(function (p, i) {
      var t = toolByKey(p.tool);
      var succ = p.succMin === p.succMax ? p.succ.toFixed(2) : p.succMin.toFixed(2) + '—' + p.succMax.toFixed(2);
      var days = p.dmin === p.dmax ? fmtDays(p.dmin) + ' 天' : fmtDays(p.dmin) + '—' + fmtDays(p.dmax) + ' 天';
      return '<div class="dcard plan' + (i === state.selPlan ? ' sel' : '') + '" data-plan="' + i + '" tabindex="0" role="button" aria-pressed="' + (i === state.selPlan) + '">' +
        '<div class="top"><h4><span class="rank">0' + (i + 1) + '</span>' + t.name + '</h4>' +
        '<span class="db score">综合 ' + p.score.toFixed(2) + '</span></div>' +
        '<div class="tags"><span class="db plain">' + faultName(p.fault) + '</span><span class="db plain">' + procName(p.proc) + '</span><span class="db ok">硬约束通过</span></div>' +
        '<div class="dbar" style="margin-top:6px"><span style="width:52px">组内相似</span><span class="track"><i style="width:' + (p.sim * 100).toFixed(0) + '%"></i></span><span class="val">' + p.sim.toFixed(2) + '</span></div>' +
        '<div class="dbar" style="margin-top:3px"><span style="width:52px">成功率</span><span class="track"><i class="clay" style="width:' + (p.succ * 100).toFixed(0) + '%"></i></span><span class="val">' + p.succ.toFixed(2) + '</span></div>' +
        '<p class="pmeta">证据 <b>' + p.n + '</b> 井次：' + p.cases.map(function (h) { return h.c.id; }).join('、') + '</p>' +
        '<p class="pmeta">历史成功率 ' + succ + ' · 历史工期区间 ' + days + '（n=' + p.n + '）</p>' +
        '<p class="pmeta check">' + esc(toolCheckText(t, model.q)) + '</p>' +
        '</div>';
    }).join('');

    [].forEach.call(el('plans').querySelectorAll('[data-plan]'), function (b) {
      b.addEventListener('click', function () { selectPlan(Number(b.getAttribute('data-plan'))); });
      b.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectPlan(Number(b.getAttribute('data-plan'))); }
      });
    });
  }

  function toolCheckText(t, q) {
    var out = [];
    if (t.od) out.push('工具外径 ' + t.od + ' mm ≤ 套管通径 ' + q.idm.toFixed(1) + ' mm ✓');
    else out.push('流体/无刚性外径，不受通径限制 ✓');
    if (t.cmin != null && (q.fault === 'fish' || q.fault === 'part')) {
      out.push('适用落物 ' + catchText(t) + ' / ' + t.forms.join('、') + '，当前 ' + q.form + ' φ' + q.size + ' mm ✓');
    }
    if (t.key === 'zhui') out.push('公锥/母锥仅用于规则内孔/外壁');
    if (q.fault === 'part' && (t.key === 'kawa' || t.key === 'mao' || t.key === 'zhui')) out.push('建议配震击器');
    return out.join('；');
  }

  function issueLabel(s) {
    if (s.indexOf('通径') >= 0) return '通径不足';
    if (s.indexOf('适用落物') >= 0) return '落物尺寸不符';
    if (s.indexOf('落物') >= 0) return '落物形态不符';
    if (s.indexOf('配套') >= 0) return '配套工具';
    if (s.indexOf('不适用于') >= 0) return '工艺不适用';
    return '硬约束排除';
  }

  function renderCases() {
    var list = [], excluded = [];
    model.hits.forEach(function (h) {
      var t = toolByKey(h.c.tool), issue = toolIssue(t, model.q);
      if (issue) excluded.push({ h: h, t: t, issue: issue });
      else list.push(h);
    });
    el('cases-hint').textContent = 'n = ' + list.length + (excluded.length ? ' / ' + model.hits.length : '') + ' · 已过硬约束';
    el('cases').innerHTML = list.length ? list.map(function (h) {
      var f = faultByKey(h.c.fault), t = toolByKey(h.c.tool);
      var cls = h.c.succ < 0.8 ? 'bad' : h.c.succ < 0.88 ? 'warn' : 'ok';
      return '<tr class="caserow' + (h.c.id === state.selCase ? ' sel' : '') + '" data-case="' + h.c.id + '" tabindex="0">' +
        '<td>' + h.c.id + '<div class="mono csub">' + t.name + '</div></td>' +
        '<td>' + f.name + '</td>' +
        '<td class="num">' + h.sim.toFixed(2) + '</td>' +
        '<td class="num">' + fmtDays(h.c.days) + '</td>' +
        '<td class="num"><span class="db ' + cls + '">' + h.c.succ.toFixed(2) + '</span></td>' +
        '</tr>';
    }).join('') : '<tr><td colspan="5" class="empty">没有通过硬约束的同族作业。</td></tr>';

    el('excluded-note').innerHTML = excluded.length ? ('硬约束排除 ' + excluded.length + ' 条：' +
      excluded.map(function (x) { return x.h.c.id + '（' + x.t.name + '，' + issueLabel(x.issue) + '）'; }).join('；')) : '';

    [].forEach.call(el('cases').querySelectorAll('[data-case]'), function (r) {
      r.addEventListener('click', function () { selectHit(r.getAttribute('data-case')); });
      r.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectHit(r.getAttribute('data-case')); }
      });
    });
  }

  function renderBars(hit) {
    if (!hit) {
      el('bars').innerHTML = '<p class="empty">当前没有选中的同族作业。</p>';
      el('simsum').innerHTML = '';
      return;
    }
    var rows = hit.parts.map(function (p) {
      var wp = p.w * p.p;
      return '<div class="fbar' + (p.w === 0 ? ' zero' : '') + '">' +
        '<span class="lbl">' + FEATURE_LABEL[p.key] + '</span>' +
        '<span class="track"><i style="width:' + (wp * 100).toFixed(1) + '%"></i></span>' +
        '<span class="val">p ' + p.p.toFixed(2) + ' · w ' + p.w.toFixed(2) + ' · <b>' + wp.toFixed(2) + '</b></span></div>';
    }).join('');
    el('bars').innerHTML = '<div class="simhead">历史作业 <b>' + hit.c.id + '</b> · 相似度 <b>' + hit.sim.toFixed(3) + '</b> <span class="simnote">（条长 = 加权贡献 w·p）</span></div>' +
      '<div class="fbar fhead"><span class="lbl">特征</span><span></span><span class="val">p · w · w·p</span></div>' + rows;
    el('simsum').innerHTML = '<span>Σw = <b>1.00</b></span><span>Σw·p = <b>' + hit.sim.toFixed(2) + '</b></span><span>权重按故障分表</span>';
  }

  function renderWeights() {
    var head = '<tr><th>故障</th><th>同族</th><th>井深</th><th>内径</th><th>含水</th><th>出砂</th><th>形态</th><th>外径</th><th>Σ</th></tr>';
    var rows = FAULTS.map(function (f) {
      var w = WEIGHTS[f.key], sum = 0;
      var cells = FEATURE_KEYS.map(function (k) {
        sum += w[k];
        return '<td class="num">' + (w[k] ? w[k].toFixed(2) : '0') + '</td>';
      }).join('');
      return '<tr class="' + (f.key === state.fault ? 'on' : '') + '"><td>' + f.name + '</td>' + cells + '<td class="num">' + sum.toFixed(2) + '</td></tr>';
    }).join('');
    el('wtable').innerHTML = '<table class="wtable"><thead>' + head + '</thead><tbody>' + rows + '</tbody></table>';
  }

  function shortIssue(s) {
    if (s.indexOf('通径') >= 0) return '通径';
    if (s.indexOf('适用落物') >= 0) return '尺寸';
    if (s.indexOf('落物') >= 0) return '形态';
    if (s.indexOf('配套') >= 0) return '配套';
    if (s.indexOf('不适用于') >= 0) return '工艺';
    return '排除';
  }

  function renderLedger() {
    var list = TOOLS.filter(function (t) { return t.faults.indexOf(state.fault) >= 0; });
    var okN = 0;
    list.forEach(function (t) { if (!toolIssue(t, model.q)) okN++; });
    el('ledger-hint').textContent = '可用 ' + okN + ' / 共 ' + list.length + ' 件';
    var hit = currentHit();
    var rows = list.slice().sort(function (a, b) {
      var ia = toolIssue(a, model.q) ? 1 : 0, ib = toolIssue(b, model.q) ? 1 : 0;
      if (ia !== ib) return ia - ib;
      return a.name.localeCompare(b.name, 'zh');
    }).map(function (t) {
      var issue = toolIssue(t, model.q);
      var status = issue ? '<span class="db bad" title="' + esc(issue) + '">' + shortIssue(issue) + '</span>' : '<span class="db ok">✓</span>';
      return '<tr class="' + (hit && hit.c.tool === t.key ? 'sel' : '') + '" data-tool="' + t.key + '" tabindex="0">' +
        '<td><b>' + t.name + '</b><div class="lsub">' + procName(t.proc) + (t.aux ? ' · 配套' : '') + '</div></td>' +
        '<td class="num">' + (t.od ? t.od : '—') + '</td>' +
        '<td class="num">' + (t.minId ? t.minId : '—') + '</td>' +
        '<td>' + catchText(t) + (t.forms ? '<div class="lsub">' + t.forms.join(' / ') + '</div>' : '') + '</td>' +
        '<td class="num">' + status + '</td></tr>';
    }).join('');
    el('ledger').innerHTML = '<table class="ltable"><thead><tr><th>工具 / 工艺</th><th class="num" title="工具外径">外径</th><th class="num" title="最小可通过内径">最小通过</th><th>适用落物尺寸</th><th class="num">判定</th></tr></thead><tbody>' + rows + '</tbody></table>';

    [].forEach.call(el('ledger').querySelectorAll('[data-tool]'), function (r) {
      r.addEventListener('click', function () { selectTool(r.getAttribute('data-tool')); });
      r.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectTool(r.getAttribute('data-tool')); }
      });
    });
  }

  function fmtFeatures(c) {
    var out = [faultName(c.fault), '井深 ' + c.depth + ' m', casingLabel(c.idm), '含水 ' + c.water + '%', c.sand ? '出砂' : '不出砂'];
    if (c.form) out.push(c.form + ' φ' + c.size + ' mm');
    return out.join(' / ');
  }

  function noteText() {
    var p = selectedPlan(), hit = currentHit(), s;
    if (p && (!hit || hit.c.id === p.cases[0].c.id)) {
      var t = toolByKey(p.tool);
      s = '方案 <b>' + (state.selPlan + 1) + '</b>（' + faultName(p.fault) + ' · ' + procName(p.proc) + ' · ' + t.name +
        '）：排序分 = 同族相似度 <b>' + p.sim.toFixed(2) + '</b> × 历史成功率 <b>' + p.succ.toFixed(2) + '</b> = <b>' + p.score.toFixed(2) +
        '</b>。按施工顺序为 <b>' + planChain(p.fault, p.proc).map(procName).join(' → ') +
        '</b>——压井/井控是前置安全条件，不作为出水、砂卡的「处理工艺」参与排序。';
    } else if (hit) {
      var tt = toolByKey(hit.c.tool), issue = toolIssue(tt, model.q);
      s = '历史作业 <b>' + hit.c.id + '</b>：' + esc(fmtFeatures(hit.c)) + ' → ' + procName(tt.proc) + ' · ' + tt.name + '，' +
        effectName(hit.c.effect) + '，' + fmtDays(hit.c.days) + ' 天，成功率 ' + hit.c.succ.toFixed(2) +
        '。相似度 <b>' + hit.sim.toFixed(3) + '</b> = Σ w·p。';
      if (issue) s += ' <b>该工具在当前井况下被硬约束排除</b>（' + esc(issue) + '），因此没有进入候选方案。';
    } else {
      s = model.hits.length
        ? ('同族有 ' + model.hits.length + ' 条历史作业，但没有工具通过当前套管通径 / 落物尺寸硬约束，无法组装候选方案。')
        : '当前故障族在示范库中没有历史案例，无法给出同族候选。';
    }
    if (state.fault === 'sand' && !state.sand) {
      s += ' 注意：当前未勾选「出砂」，而库内砂卡案例均为出砂井，出砂维度 p=0；工艺仍按砂卡处理，但现场应先核实是否确为砂卡而非管柱断脱。';
    }
    if ((state.fault === 'fish' || state.fault === 'part') && state.size >= 90) {
      s += ' 当前落物外径 ' + state.size + ' mm 已超出多数捞筒/捞矛的咬合范围，硬约束只保留磨铣/套铣类工具。';
    }
    return s;
  }

  function renderAll() {
    var hit = currentHit();
    el('st-sim').innerHTML = model.hits.length ? model.hits[0].sim.toFixed(2) : '—';
    el('st-days').innerHTML = model.plans.length ? daysHtml(model.plans[0]) : '—';
    renderPlans();
    renderCases();
    renderBars(hit);
    renderWeights();
    renderLedger();
    drawGraph();
    el('note').innerHTML = noteText();
    el('sim-hint').textContent = hit ? ('当前选中：' + hit.c.id + ' · ' + faultName(hit.c.fault)) : '当前未选中作业';
  }

  /* ---------- 10. 控件 ---------- */
  function syncControls() {
    [].forEach.call(el('seg-fault').children, function (b) {
      var on = b.getAttribute('data-f') === state.fault;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    [].forEach.call(el('seg-id').children, function (b) {
      var on = Number(b.getAttribute('data-v')) === state.idm;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    var rDepth = el('r-depth'), rWater = el('r-water'), rSize = el('r-size');
    rDepth.value = state.depth;
    rWater.value = state.water;
    rSize.value = state.size;
    el('o-depth').textContent = state.depth + ' m';
    el('o-water').textContent = state.water + '%';
    el('o-size').textContent = state.size + ' mm';
    el('sel-form').value = state.form;

    var litter = state.fault === 'fish' || state.fault === 'part';
    el('sel-form').disabled = !litter;
    rSize.disabled = !litter;
    el('litter-hint').textContent = litter ? '仅落物/断脱类参与相似度' : '当前故障不适用落物尺寸';
    el('litter-hint').classList.toggle('off', !litter);
    el('grp-litter').classList.toggle('off', !litter);

    var tog = el('tog-sand');
    tog.classList.toggle('on', state.sand);
    tog.setAttribute('aria-checked', state.sand ? 'true' : 'false');
  }

  el('seg-fault').innerHTML = FAULTS.map(function (f) {
    return '<button type="button" data-f="' + f.key + '" aria-pressed="false" title="' + esc(f.note) + '">' + f.name + '</button>';
  }).join('');

  el('seg-id').innerHTML = CASINGS.map(function (c) {
    return '<button type="button" data-v="' + c.idm + '" aria-pressed="false" title="' + esc(c.label + ' · 通径 ' + c.idm.toFixed(1) + ' mm') + '">' +
      c.label + '<span class="seg-sub">' + c.sub + '</span></button>';
  }).join('');

  el('seg-fault').addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button') : null;
    if (!b) return;
    state.fault = b.getAttribute('data-f');
    syncControls();
    onQueryChange();
  });

  el('seg-id').addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button') : null;
    if (!b) return;
    state.idm = Number(b.getAttribute('data-v'));
    syncControls();
    onQueryChange();
  });

  el('r-depth').addEventListener('input', function () {
    state.depth = Number(el('r-depth').value);
    el('o-depth').textContent = state.depth + ' m';
    onQueryChange();
  });
  el('r-water').addEventListener('input', function () {
    state.water = Number(el('r-water').value);
    el('o-water').textContent = state.water + '%';
    onQueryChange();
  });
  el('r-size').addEventListener('input', function () {
    state.size = Number(el('r-size').value);
    el('o-size').textContent = state.size + ' mm';
    onQueryChange();
  });
  el('sel-form').addEventListener('change', function () {
    state.form = el('sel-form').value;
    onQueryChange();
  });
  el('tog-sand').addEventListener('click', function () {
    state.sand = !state.sand;
    syncControls();
    onQueryChange();
  });
  el('btn-reset').addEventListener('click', function () {
    state.fault = STATE_DEFAULT.fault;
    state.idm = STATE_DEFAULT.idm;
    state.depth = STATE_DEFAULT.depth;
    state.water = STATE_DEFAULT.water;
    state.sand = STATE_DEFAULT.sand;
    state.form = STATE_DEFAULT.form;
    state.size = STATE_DEFAULT.size;
    syncControls();
    onQueryChange();
  });

  /* 图谱节点：悬停冒泡提示在 <title>，点击/回车定位案例 */
  function nodeFromEvent(target) {
    var n = target;
    while (n && n !== el('graph')) {
      if (n.getAttribute && n.getAttribute('data-kind')) return n;
      n = n.parentNode;
    }
    return null;
  }
  function handleNode(g) {
    var kind = g.getAttribute('data-kind'), key = g.getAttribute('data-key');
    if (kind === 'fault') {
      if (state.fault !== key) {
        state.fault = key;
        syncControls();
        onQueryChange();
      }
      return;
    }
    if (kind === 'tool') { selectTool(key); return; }
    if (kind === 'proc') { selectProc(key); return; }
    if (kind === 'effect') { selectEffect(key); }
  }
  el('graph').addEventListener('click', function (e) {
    var g = nodeFromEvent(e.target);
    if (g) handleNode(g);
  });
  el('graph').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    var g = nodeFromEvent(e.target);
    if (g) { e.preventDefault(); handleNode(g); }
  });

  /* ---------- 11. 启动 ---------- */
  el('st-count').textContent = CASES.length;
  syncControls();
  sync();
})();
