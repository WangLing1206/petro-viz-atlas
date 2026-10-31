/* =========================================================
   落物打捞工具智能选型 · 可运行示范
   ---------------------------------------------------------
   ① 落物描述结构化（形态 / 外径 / 内径 / 长度 / 井斜 / 落底三态 / 材质 / 卡阻）
   ② 工具知识表：外径、内孔、可捞外径或内径区间、最小咬合长度、
      最大井斜、是否需循环、是否需落底、历史成功率、作业动作
   ③ 两级筛选：硬约束真排除（不进入推荐）→ 加权软评分排序
   ④ 井筒剖面 + 工具构造示意 + 解卡/磨铣工序（不参与打捞评分）

   物理一致性约定：
   - 外部套入式工具必须满足：可捞上限 dmax < 工具内孔 < 工具外径
   - 公锥 / 捞矛按落物内径判断；母锥 / 卡瓦筒按落物外径判断
   - 所有通过性按套管内通径校核，单边间隙 ≥ 6 mm
   ========================================================= */
(function () {
  'use strict';

  var FORMS = [
    { key: 'tubular', name: '管状体', desc: '油管 / 钻杆本体', bore: true,  od: 73,  fid: 62, len: 2.4 },
    { key: 'rod',     name: '杆状体', desc: '抽油杆 / 加重杆', bore: false, od: 22,  fid: 0,  len: 2.0 },
    { key: 'cable',   name: '柔索类', desc: '电缆 / 钢丝绳',   bore: false, od: 5,   fid: 0,  len: 3.0 },
    { key: 'solid',   name: '实心小件', desc: '钢球 / 牙轮 / 铁屑', bore: false, od: 12, fid: 0, len: 0.3 },
    { key: 'toolbig', name: '大直径工具', desc: '井下工具 / 扶正器', bore: false, od: 100, fid: 0, len: 1.5 }
  ];

  /* 套管按「规格 + 通径（drift）」描述；通过性一律用通径，不用套管外径 */
  var CASINGS = [
    { key: '55-17', label: '5-1/2" 17#', drift: 121.1 },
    { key: '55-23', label: '5-1/2" 23#', drift: 118.6 },
    { key: '70-29', label: '7" 29#',     drift: 157.0 }
  ];

  var CLEARANCE = 6;   /* 工具外径与套管内通径之间必须预留的单边间隙，mm */

  /* ------------------------------------------------------------------
     工具知识表（11 件打捞工具）
     od      工具外径
     bore    工具内孔（外部套入式工具必须 dmax < bore < od）
     basis   'od' = 按落物外径判断；'id' = 按落物内径判断
     dmin/dmax 可打捞落物外径（或内径）区间
     minLen  最小咬合长度，m；maxLen 工具可容纳的最大落物长度，m
     needBottom 是否必须落底；circ 是否必须循环洗井
     ------------------------------------------------------------------ */
  var TOOLS = [
    { key: 'kawa', name: '卡瓦打捞筒', od: 108, bore: 86, basis: 'od', dmin: 50, dmax: 80,
      sizeLabel: '可捞外径', minLen: 0.3, maxLen: 12, maxIncl: 60, circ: 0, needBottom: 0, succ: 0.88,
      form: { tubular: 1, rod: 0.60, cable: 0.05, solid: 0.05, toolbig: 0.55 },
      op: '下放使鱼顶进入卡瓦筒内孔 0.3 m 以上，上提让卡瓦咬住管壁；先试提确认咬合，再逐步加载，不要用下压代替上提。',
      note: '靠卡瓦咬住管体外壁，适合同心度好的管状落物；外径 108 / 内孔 86 / 可捞 50—80 mm，落物外壁不规则时咬合差。' },

    { key: 'small', name: '小径卡瓦捞筒', od: 89, bore: 68, basis: 'od', dmin: 32, dmax: 62,
      sizeLabel: '可捞外径', minLen: 0.3, maxLen: 12, maxIncl: 55, circ: 0, needBottom: 0, succ: 0.84,
      form: { tubular: 0.90, rod: 0.70, cable: 0.05, solid: 0.05, toolbig: 0.60 },
      op: '下放套住小直径鱼顶 0.3 m 以上，上提使卡瓦咬合；通径小的套管里优先用它，避免大径工具卡在环空。',
      note: '外径 89 / 内孔 68 / 可捞 32—62 mm；用于小直径油管、杆体和工具接头，通径小的套管里比大径卡瓦筒更容易通过。' },

    { key: 'box', name: '母锥', od: 95, bore: 88, basis: 'od', dmin: 60, dmax: 84,
      sizeLabel: '可捞外径', minLen: 0.3, maxLen: 12, maxIncl: 50, circ: 0, needBottom: 0, succ: 0.80,
      form: { tubular: 0.80, rod: 0.50, cable: 0.05, solid: 0.05, toolbig: 0.60 },
      op: '下放使落物外壁进入母锥锥孔，缓慢右旋造扣，造扣后上提；造扣期间不要长时间循环。',
      note: '外径 95 / 喇叭口 88 / 可捞外径 60—84 mm；靠落物外壁造扣，适合外壁规则但内孔不通的落物。' },

    { key: 'pin', name: '公锥', od: 68, bore: null, basis: 'id', dmin: 38, dmax: 62,
      sizeLabel: '可造扣内径', minLen: 0.2, maxLen: 12, maxIncl: 50, circ: 0, needBottom: 0, succ: 0.78,
      form: { tubular: 0.85, rod: 0.45, cable: 0.05, solid: 0.05, toolbig: 0.50 },
      op: '下放使公锥插入落物内孔，加压 5—10 kN 右旋造扣，造扣后上提；落物无内孔时不能用。',
      note: '外径 68 mm；按落物内径 38—62 mm 选型，插入内孔造扣；落物必须有畅通内孔，内径小于 38 mm 或大于 62 mm 都不能用。' },

    { key: 'spear', name: '捞矛', od: 66, bore: null, basis: 'id', dmin: 40, dmax: 62,
      sizeLabel: '可咬内径', minLen: 0.5, maxLen: 12, maxIncl: 55, circ: 0, needBottom: 0, succ: 0.82,
      form: { tubular: 0.90, rod: 0.50, cable: 0.05, solid: 0.05, toolbig: 0.55 },
      op: '下放使捞矛进入落物内孔，上提让滑块涨开咬住内壁；最小咬合长度 0.5 m，短落物咬不住。',
      note: '外径 66 mm；按落物内径 40—62 mm 选型，滑块涨开咬住内壁；最小咬合长度 0.5 m，短落物不适用。' },

    { key: 'sucker', name: '抽油杆打捞筒', od: 55, bore: 32, basis: 'od', dmin: 16, dmax: 26,
      sizeLabel: '可捞杆体', minLen: 0.3, maxLen: 12, maxIncl: 60, circ: 0, needBottom: 0, succ: 0.86,
      form: { tubular: 0.20, rod: 1, cable: 0.05, solid: 0.05, toolbig: 0.05 },
      op: '下放套住杆体 0.3 m 以上，上提使卡瓦咬合；遇大接箍先换大规格或单独处理接箍。',
      note: '外径 55 / 内孔 32 / 可捞杆体 16—26 mm（5/8—1 in）；带大接箍的杆串要换大规格或先处理接箍。' },

    { key: 'basket', name: '篮式捞筒', od: 108, bore: 80, basis: 'od', dmin: 0, dmax: 5,
      sizeLabel: '可捞碎屑', minLen: 0.1, maxLen: 2, maxIncl: 65, circ: 1, needBottom: 0, succ: 0.76,
      form: { tubular: 0.10, rod: 0.20, cable: 0.45, solid: 0.85, toolbig: 0.10 },
      op: '开泵循环，把 0—5 mm 细碎屑随液流带入篮筐；起钻前停泵，避免碎屑回落。',
      note: '外径 108 / 内孔 80 mm；只捞 0—5 mm 细碎屑，靠循环带入，不强制落底；不能循环时基本失效。' },

    { key: 'magnet', name: '磁力打捞器', od: 60, bore: null, basis: 'od', dmin: 2, dmax: 30,
      sizeLabel: '可吸尺寸', minLen: 0.1, maxLen: 0.6, maxIncl: 75, circ: 0, needBottom: 0, succ: 0.90,
      material: 'ferro', sweet: [5, 30],
      form: { tubular: 0.10, rod: 0.20, cable: 0.05, solid: 1, toolbig: 0.05 },
      op: '下放至鱼顶接触吸附，先活动管柱确认吸附牢靠再起钻；非铁磁性落物和长落物都不适用。',
      note: '外径 60 mm；只对铁磁性材料有效，适合 2—30 mm 的短小件；长落物与堆叠铁屑吸附力不足。' },

    { key: 'yiba', name: '一把抓', od: 85, bore: 60, basis: 'od', dmin: 5, dmax: 55,
      sizeLabel: '可捞外径', minLen: 0.2, maxLen: 1.2, maxIncl: 45, circ: 0, needBottom: 1, succ: 0.82,
      form: { tubular: 0.25, rod: 0.50, cable: 0.35, solid: 0.90, toolbig: 0.20 },
      op: '下放至鱼顶，继续下放使抓爪收拢抱紧，然后上提；悬空落物会抓空，必须先确认落底。',
      note: '外径 85 / 内孔 60 / 可捞 5—55 mm；靠落底后收爪抓取，落物悬空或井斜大时抓空概率明显上升。' },

    { key: 'rope', name: '绳类打捞钩', od: 50, bore: null, basis: 'od', dmin: 3, dmax: 45,
      sizeLabel: '可钩挂尺寸', minLen: 0.3, maxLen: 50, maxIncl: 70, circ: 0, needBottom: 0, succ: 0.84,
      form: { tubular: 0.10, rod: 0.35, cable: 1, solid: 0.10, toolbig: 0.05 },
      op: '下放过鱼顶后上提，使钩子钩挂缠绕电缆或钢丝绳；大斜度井电缆贴壁，需要多次活动管柱。',
      note: '外径 50 mm；专捞电缆、钢丝绳，靠钩挂缠绕；井斜大时电缆贴壁，需要多次活动管柱。' },

    { key: 'thin', name: '细钢丝捞钩', od: 36, bore: null, basis: 'od', dmin: 1, dmax: 12,
      sizeLabel: '可钩挂尺寸', minLen: 0.1, maxLen: 50, maxIncl: 55, circ: 0, needBottom: 0, succ: 0.74,
      form: { tubular: 0.10, rod: 0.30, cable: 0.90, solid: 0.10, toolbig: 0.05 },
      op: '缓慢下放，钩住细钢丝后轻提，避免拉断；可配合反循环把细钢丝带出。',
      note: '外径 36 mm；专捞细钢丝、测井电缆和仪器引线，钩尖细、拉力小，遇卡不要硬提。' }
  ];

  /* 工序工具：不参与打捞排序，只按卡阻状态推荐 */
  var PREP = [
    { key: 'wash', name: '套铣筒', od: 108, circ: 1, when: '砂卡 / 水泥卡 / 落物被埋',
      note: '套住落物与套管环空，循环洗出砂桥或水泥环；套铣到位后再下打捞工具。' },
    { key: 'mill', name: '平底磨鞋', od: 105, circ: 1, when: '鱼顶不规则 / 大件无法直接捞 / 落物被埋',
      note: '加压磨铣鱼顶或大件，磨屑随循环带出；磨铣后必须清屑。' },
    { key: 'basket', name: '篮式捞筒 / 反循环', od: 108, circ: 1, when: '磨铣后清屑',
      note: '清除磨铣产生的铁屑，避免二次落物；也可用反循环打捞篮。' }
  ];

  var W = { form: 0.32, size: 0.26, incl: 0.16, succ: 0.16, cond: 0.10 };

  var DEFAULTS = {
    form: 'tubular', casing: 0, od: 73, fishId: 62, len: 2.4, incl: 18,
    bottom: null, circ: true, material: 'ferro', stuck: 'none'
  };

  var state = clone(DEFAULTS);

  /* ---------- 小工具 ---------- */
  function clone(o) {
    var r = {}, k;
    for (k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) r[k] = o[k]; }
    return r;
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function fmt1(v) { return (Math.round(v * 10) / 10).toFixed(1); }
  function el(id) { return document.getElementById(id); }
  function curCasing() { return CASINGS[state.casing]; }
  function FORM_OF(k) {
    var i;
    for (i = 0; i < FORMS.length; i++) if (FORMS[i].key === k) return FORMS[i];
    return FORMS[0];
  }
  function formNames(t) {
    if (t.basis === 'id') return '管状体（需内孔）';
    var a = [];
    FORMS.forEach(function (f) { if ((t.form[f.key] || 0) >= 0.4) a.push(f.name); });
    return a.length ? a.join('、') : '—';
  }
  function fishValue(t, s) { return t.basis === 'id' ? s.fishId : s.od; }

  /* ---------- 尺寸评分：落在区间中段得满分，贴近边界缓降 ---------- */
  function sizeScore(t, s) {
    var v = fishValue(t, s);
    if (t.sweet && v >= t.sweet[0] && v <= t.sweet[1]) return 1;
    var span = t.dmax - t.dmin;
    if (span <= 0) return 1;
    var pos = (v - t.dmin) / span;
    var edge = Math.min(pos, 1 - pos);
    return 0.65 + 0.35 * Math.min(1, edge / 0.3);
  }

  /* ---------- 硬约束 + 软评分 ---------- */
  function evaluate(t, s) {
    var reasons = [];
    var warns = [];
    var limit = s.drift - 2 * CLEARANCE;

    if (t.od > limit) {
      reasons.push('工具外径 ' + t.od + ' mm > 通径 ' + fmt1(s.drift) + ' − 2×6 = ' + fmt1(limit) + ' mm');
    }
    if (s.stuck === 'buried') {
      reasons.push('落物被埋，鱼顶不可达，需先套铣 / 磨铣清障');
    }

    if (t.basis === 'id') {
      if (!s.fishBore) {
        reasons.push('落物无内孔，' + t.name + '无法插入造扣');
      } else if (!s.fishId) {
        reasons.push('未给出落物内径，无法校核' + t.name);
      } else if (s.fishId < t.dmin || s.fishId > t.dmax) {
        reasons.push('落物内径 ' + s.fishId + ' mm 超出' + t.sizeLabel + ' ' + t.dmin + '—' + t.dmax + ' mm');
      }
    } else {
      if (s.od < t.dmin || s.od > t.dmax) {
        reasons.push('落物外径 ' + s.od + ' mm 超出' + t.sizeLabel + ' ' + t.dmin + '—' + t.dmax + ' mm');
      }
    }

    if (t.material === 'ferro' && s.material !== 'ferro') {
      reasons.push('落物为非铁磁性，磁力打捞器无效');
    }
    if (s.incl > t.maxIncl) {
      reasons.push('井斜 ' + s.incl + '° > 工具允许 ' + t.maxIncl + '°');
    }
    if (t.circ && !s.circ) {
      reasons.push('工具需循环洗井，本井不可循环');
    }
    if (t.needBottom && s.bottom === false) {
      reasons.push('工具需落底，落物悬空');
    }
    if (s.len < t.minLen) {
      reasons.push('落物长度 ' + fmt1(s.len) + ' m < 最小咬合长度 ' + fmt1(t.minLen) + ' m');
    }
    if (s.len > t.maxLen) {
      reasons.push('落物长度 ' + fmt1(s.len) + ' m > 工具可容纳 ' + fmt1(t.maxLen) + ' m');
    }

    if (reasons.length) return { out: true, reasons: reasons, why: reasons.join('；') };

    if (t.needBottom && s.bottom === null) {
      warns.push('需落底：状态未知（落底分支可用，悬空分支不可用）');
    }
    if (s.stuck === 'sand') warns.push('砂卡：工具串建议加震击器 + 安全接头');
    if (s.stuck === 'cement') warns.push('水泥卡：工具串建议加震击器 + 安全接头');

    var formScore = t.form[s.form] || 0;
    var size = sizeScore(t, s);

    var inclScore = 1;
    if (s.incl > t.maxIncl - 10) {
      inclScore = 1 - (s.incl - (t.maxIncl - 10)) / 10 * 0.35;
    }
    inclScore = Math.max(0.65, Math.min(1, inclScore));

    var condScore = 1;
    if (t.needBottom && s.bottom === null) condScore -= 0.30;
    if (s.stuck === 'sand' || s.stuck === 'cement') condScore -= 0.06;
    condScore = Math.max(0, condScore);

    var parts = [
      { k: '形态匹配', p: formScore, w: W.form },
      { k: '尺寸隶属', p: size, w: W.size },
      { k: '井斜适应', p: inclScore, w: W.incl },
      { k: '历史成功率', p: t.succ, w: W.succ },
      { k: '工况条件', p: condScore, w: W.cond }
    ];
    var score = parts.reduce(function (a, x) { return a + x.w * x.p; }, 0);
    return { out: false, score: score, parts: parts, warns: warns };
  }

  function rank(s) {
    return TOOLS.map(function (t) {
      var e = evaluate(t, s);
      return { t: t, e: e, score: e.out ? -1 : e.score };
    }).sort(function (a, b) { return b.score - a.score; });
  }
  function bestOf(rows) {
    var i;
    for (i = 0; i < rows.length; i++) if (!rows[i].e.out) return rows[i];
    return null;
  }

  /* ---------- 起下钻：只给整数 / 区间 ---------- */
  function tripText(best) {
    if (!best) return '—';
    if (best.score >= 0.80) return '1 趟（预计）';
    if (best.score >= 0.62) return '1—2 趟';
    return '2—3 趟';
  }

  function sizeMeta(t) {
    var head = '外径 ' + t.od + ' mm · ';
    if (t.bore) head += '内孔 ' + t.bore + ' mm · ';
    else if (t.basis === 'id') head += '无内孔工具（插入落物内孔）· ';
    else head += '无内孔 · ';
    return head + t.sizeLabel + ' ' + t.dmin + '—' + t.dmax + ' mm · 咬合 ≥' + t.minLen + ' m';
  }

  function toolTitle(t) {
    return t.name + '｜' + sizeMeta(t) +
      '｜需落底 ' + (t.needBottom ? '是' : '否') +
      '｜需循环 ' + (t.circ ? '是' : '否') +
      '｜最大井斜 ' + t.maxIncl + '°' +
      '｜历史成功率 ' + Math.round(t.succ * 100) + '%' +
      '｜' + t.note;
  }

  /* =========================================================
     工具构造示意（分工具画，标签不裁切）
     ========================================================= */
  function toolArt(key) {
    var S = '#1d4e50', F = '#e7eee9', R = '#a64b3c';
    var g = '<g transform="translate(105,8) scale(1.04)">';

    function sub(w) {
      return '<rect x="' + (-w / 2) + '" y="0" width="' + w + '" height="14" rx="3" fill="' + F + '" stroke="' + S + '"/>';
    }
    function lbl(txt) {
      return '<text x="0" y="148" font-size="9" fill="#6f7a7c" text-anchor="middle">' + txt + '</text>';
    }

    if (key === 'kawa' || key === 'small' || key === 'sucker') {
      var bw = key === 'kawa' ? 62 : (key === 'small' ? 48 : 34);
      var bh = key === 'kawa' ? 76 : (key === 'small' ? 70 : 80);
      var mw = key === 'kawa' ? 44 : (key === 'small' ? 32 : 20);
      var mh = key === 'kawa' ? 36 : (key === 'small' ? 34 : 44);
      g += sub(bw * 0.58);
      g += '<rect x="' + (-bw / 2) + '" y="14" width="' + bw + '" height="' + bh + '" rx="3" fill="' + F + '" stroke="' + S + '"/>';
      g += '<rect x="' + (-mw / 2) + '" y="' + (bh - mh + 14) + '" width="' + mw + '" height="' + mh + '" fill="#ffffff" stroke="' + S + '" stroke-dasharray="3 2"/>';
      g += '<path d="M' + (-bw / 2) + ' ' + (bh - mh + 22) + ' L' + (-bw / 2 + 14) + ' ' + (bh - mh + 30) + ' L' + (-bw / 2) + ' ' + (bh - mh + 38) + ' Z" fill="' + S + '" opacity=".75"/>';
      g += '<path d="M' + (bw / 2) + ' ' + (bh - mh + 22) + ' L' + (bw / 2 - 14) + ' ' + (bh - mh + 30) + ' L' + (bw / 2) + ' ' + (bh - mh + 38) + ' Z" fill="' + S + '" opacity=".75"/>';
      if (key === 'sucker') g += '<line x1="-8" y1="18" x2="-8" y2="' + (bh + 10) + '" stroke="' + S + '" stroke-width="1.2" stroke-dasharray="3 2"/>';
      g += lbl(key === 'kawa' ? '卡瓦打捞筒 · 咬管体外壁' : (key === 'small' ? '小径卡瓦捞筒 · 32—62' : '抽油杆筒 · 杆体 16—26'));
    } else if (key === 'box') {
      g += sub(44);
      g += '<rect x="-26" y="14" width="52" height="28" rx="3" fill="' + F + '" stroke="' + S + '"/>';
      g += '<path d="M-26 42 L26 42 L40 92 L-40 92 Z" fill="' + F + '" stroke="' + S + '"/>';
      g += '<path d="M-14 48 L14 48 L26 86 L-26 86 Z" fill="none" stroke="' + S + '" stroke-dasharray="3 2"/>';
      g += '<line x1="-24" y1="62" x2="24" y2="62" stroke="' + S + '" stroke-width="1" opacity=".45"/>';
      g += '<line x1="-28" y1="76" x2="28" y2="76" stroke="' + S + '" stroke-width="1" opacity=".45"/>';
      g += lbl('母锥 · 落物外壁造扣');
    } else if (key === 'pin') {
      g += sub(30);
      g += '<rect x="-18" y="14" width="36" height="20" rx="3" fill="' + F + '" stroke="' + S + '"/>';
      g += '<path d="M-18 34 L18 34 L10 96 L-10 96 Z" fill="' + F + '" stroke="' + S + '"/>';
      for (var i = 0; i < 5; i++) {
        var yy = 42 + i * 10;
        var hw = 16 - i * 1.4;
        g += '<line x1="' + (-hw) + '" y1="' + yy + '" x2="' + hw + '" y2="' + yy + '" stroke="' + S + '" stroke-width="1" opacity=".55"/>';
      }
      g += lbl('公锥 · 插入内孔造扣');
    } else if (key === 'spear') {
      g += sub(24);
      g += '<rect x="-7" y="14" width="14" height="72" rx="2" fill="' + F + '" stroke="' + S + '"/>';
      g += '<path d="M-7 38 L-22 50 L-22 82 L-7 68 Z" fill="' + S + '" opacity=".55"/>';
      g += '<path d="M7 38 L22 50 L22 82 L7 68 Z" fill="' + S + '" opacity=".55"/>';
      g += '<line x1="-22" y1="54" x2="-8" y2="44" stroke="#fff" stroke-width="1" opacity=".7"/>';
      g += '<line x1="22" y1="54" x2="8" y2="44" stroke="#fff" stroke-width="1" opacity=".7"/>';
      g += lbl('捞矛 · 滑块咬内壁');
    } else if (key === 'basket') {
      g += sub(34);
      g += '<rect x="-30" y="14" width="60" height="38" rx="3" fill="' + F + '" stroke="' + S + '"/>';
      g += '<rect x="-24" y="52" width="48" height="42" rx="2" fill="#ffffff" stroke="' + S + '" stroke-dasharray="3 2"/>';
      for (var j = 0; j < 6; j++) {
        g += '<circle cx="' + (-10 + (j % 3) * 10) + '" cy="' + (62 + Math.floor(j / 3) * 12) + '" r="1.5" fill="' + S + '" opacity=".5"/>';
      }
      g += lbl('篮式捞筒 · 循环带入');
    } else if (key === 'magnet') {
      g += sub(30);
      g += '<rect x="-20" y="14" width="40" height="64" rx="3" fill="' + F + '" stroke="' + S + '"/>';
      g += '<rect x="-20" y="78" width="40" height="10" fill="' + R + '" stroke="' + R + '"/>';
      g += '<text x="-10" y="86" font-size="7" fill="#fff" text-anchor="middle" font-family="monospace">S</text>';
      g += '<text x="10" y="86" font-size="7" fill="#fff" text-anchor="middle" font-family="monospace">N</text>';
      g += '<path d="M-8 90 C-18 102 -12 110 0 112 M8 90 C18 102 12 110 0 112" fill="none" stroke="' + S + '" stroke-width="1" stroke-dasharray="3 3" opacity=".6"/>';
      g += lbl('磁力打捞器 · 接触吸附');
    } else if (key === 'yiba') {
      g += sub(30);
      g += '<rect x="-22" y="14" width="44" height="46" rx="3" fill="' + F + '" stroke="' + S + '"/>';
      g += '<path d="M-18 60 C-22 88 -10 104 0 106 C10 104 22 88 18 60" fill="none" stroke="' + S + '" stroke-width="2"/>';
      g += '<path d="M-9 60 C-11 82 -4 94 0 96 M9 60 C11 82 4 94 0 96" fill="none" stroke="' + S + '" stroke-width="1.2" opacity=".65"/>';
      g += lbl('一把抓 · 下放收爪');
    } else if (key === 'rope') {
      g += sub(20);
      g += '<rect x="-8" y="14" width="16" height="48" rx="2" fill="' + F + '" stroke="' + S + '"/>';
      g += '<path d="M0 62 C0 88 -24 88 -24 72 C-24 62 -14 58 -6 64" fill="none" stroke="' + S + '" stroke-width="2.2"/>';
      g += '<path d="M-22 72 L-30 68 M-18 82 L-26 86" stroke="' + S + '" stroke-width="1.4"/>';
      g += lbl('绳类打捞钩 · 钩挂缠绕');
    } else if (key === 'thin') {
      g += sub(14);
      g += '<rect x="-4" y="14" width="8" height="50" rx="2" fill="' + F + '" stroke="' + S + '"/>';
      g += '<path d="M0 64 C0 86 -18 86 -18 72 C-18 64 -10 61 -4 66" fill="none" stroke="' + S + '" stroke-width="1.2"/>';
      g += '<path d="M-16 72 L-22 69" stroke="' + S + '" stroke-width="1"/>';
      g += lbl('细钢丝捞钩 · 钩出细钢丝');
    }
    return g + '</g>';
  }

  /* =========================================================
     井筒剖面：通径按毫米比例绘制，落底贴井底，工具与落物咬合
     ========================================================= */
  function drawSchematic(best) {
    var c = curCasing();
    var PX = 0.66;                 /* mm → px */
    var CX = 144, TOP = 62, BOT = 392, CY = 50;
    var vis = state.incl * 0.45;   /* 图示倾角按 0.45 缩小，标注非等比例 */
    var a = vis * Math.PI / 180;
    var half = c.drift * PX / 2;
    var wall = 6;
    var fishW = Math.max(5, state.od * PX);
    var fishH = Math.max(8, Math.min(120, state.len * 10));
    var fishTop = state.bottom === false ? 188 : BOT - fishH;
    var fishBottom = fishTop + fishH;
    var dashed = state.bottom === null;

    var toolTop = 0, toolBottom = 0, toolW = 0;
    if (best) {
      toolW = best.t.od * PX;
      var overlap = best.t.key === 'magnet' ? 2 :
        ((best.t.key === 'rope' || best.t.key === 'thin') ? 8 : 18);
      if (state.bottom === true) toolBottom = Math.min(BOT - 4, fishTop + overlap);
      else if (state.bottom === false) toolBottom = fishTop - 10;
      else toolBottom = Math.min(BOT - 4, fishTop + overlap);  /* 未知道：按落底分支画咬合，鱼顶用虚线标未知 */
      toolTop = Math.max(TOP + 20, toolBottom - 64);
    }

    function rp(x, y) {
      var dx = x - CX, dy = y - CY;
      return {
        x: CX + dx * Math.cos(a) - dy * Math.sin(a) + shiftX,
        y: CY + dx * Math.sin(a) + dy * Math.cos(a)
      };
    }

    /* 大斜度时井底会转到 viewBox 左侧之外：整体右移，保证套管与标签不出框 */
    var sinA = Math.sin(a), cosA = Math.cos(a);
    var xLeftBottom = CX - (half + wall) * cosA - (BOT - CY) * sinA;
    var shiftX = Math.max(0, 8 - xLeftBottom);

    var s = '<g transform="translate(' + shiftX.toFixed(1) + ',0) rotate(' + vis.toFixed(2) + ',' + CX + ',' + CY + ')">';

    /* 套管壁（内径 = 通径） */
    s += '<rect x="' + (CX - half - wall) + '" y="' + TOP + '" width="' + wall + '" height="' + (BOT - TOP) + '" fill="#f0ede4" stroke="#d3c9b6"/>';
    s += '<rect x="' + (CX + half) + '" y="' + TOP + '" width="' + wall + '" height="' + (BOT - TOP) + '" fill="#f0ede4" stroke="#d3c9b6"/>';
    /* 井口 */
    s += '<rect x="' + (CX - half - wall - 8) + '" y="' + (TOP - 12) + '" width="' + (2 * (half + wall) + 16) + '" height="12" rx="3" fill="#e3dccd" stroke="#d3c9b6"/>';
    /* 井底 */
    s += '<rect x="' + (CX - half) + '" y="' + BOT + '" width="' + (2 * half) + '" height="6" fill="#e3dccd" stroke="#d3c9b6"/>';

    /* 落物 */
    s += '<rect x="' + (CX - fishW / 2) + '" y="' + fishTop + '" width="' + fishW + '" height="' + fishH + '" rx="2" fill="#f5e6e1" stroke="#a64b3c" stroke-width="1.4"' + (dashed ? ' stroke-dasharray="4 3"' : '') + '/>';
    if (state.form === 'cable') {
      s += '<path d="M' + (CX - fishW / 2 + 2) + ' ' + (fishTop + 4) + ' q' + (fishW / 2) + ' 6 0 12 q' + (-fishW / 2) + ' 6 0 12" fill="none" stroke="#a64b3c" stroke-width="1" opacity=".7"/>';
    }

    /* 工具与工具串 */
    if (best) s += toolGlyph(best.t, toolTop, toolBottom, toolW);

    s += '</g>';

    /* ---- 文字标签（放在套管外侧，避免压住套管壁） ---- */
    var pFish = rp(CX + half + wall + 6, fishTop + 10);
    var fishAnchor = 'start';
    s += '<text x="' + pFish.x.toFixed(1) + '" y="' + pFish.y.toFixed(1) + '" font-size="9" fill="#a64b3c" text-anchor="' + fishAnchor + '">落物 ' + state.od + ' mm</text>';
    s += '<text x="' + pFish.x.toFixed(1) + '" y="' + (pFish.y + 12).toFixed(1) + '" font-size="8.5" fill="#a64b3c" text-anchor="' + fishAnchor + '">' + fmt1(state.len) + ' m · ' + (state.bottom === true ? '已落底' : (state.bottom === false ? '悬空' : '落底未知')) + '</text>';

    var pWell = rp(CX + half + wall + 8, TOP + 2);
    s += '<text x="' + pWell.x.toFixed(1) + '" y="' + pWell.y.toFixed(1) + '" font-size="8.5" fill="#99a3a4" font-family="monospace">井口</text>';

    var pBot = rp(CX, BOT + 18);
    s += '<text x="' + pBot.x.toFixed(1) + '" y="' + pBot.y.toFixed(1) + '" font-size="8.5" fill="#99a3a4" text-anchor="middle">井底</text>';

    if (state.bottom === false) {
      var pSus = rp(CX, fishBottom + 14);
      s += '<path d="M' + rp(CX - half, fishBottom).x.toFixed(1) + ' ' + rp(CX - half, fishBottom).y.toFixed(1) + ' L' + rp(CX + half, fishBottom).x.toFixed(1) + ' ' + rp(CX + half, fishBottom).y.toFixed(1) + '" stroke="#e3dccd" stroke-dasharray="4 3"/>';
      s += '<text x="' + pSus.x.toFixed(1) + '" y="' + pSus.y.toFixed(1) + '" font-size="8.5" fill="#99a3a4" text-anchor="middle">悬空（未落底）</text>';
    }
    if (state.bottom === null) {
      var pUnk = rp(CX + half + wall + 6, BOT + 20);
      s += '<text x="' + pUnk.x.toFixed(1) + '" y="' + pUnk.y.toFixed(1) + '" font-size="8.5" fill="#9a6b1d" text-anchor="start">虚线示落底位置</text>';
    }

    if (best) {
      var pR = rp(Math.max(CX + toolW / 2 + 8, CX + half + wall + 4), toolTop + 9);
      var pL = rp(Math.min(CX - toolW / 2 - 8, CX - half - wall - 4), toolTop + 9);
      var useR = pR.x < 330;
      var pT = useR ? pR : pL;
      s += '<text x="' + pT.x.toFixed(1) + '" y="' + pT.y.toFixed(1) + '" font-size="9" fill="#1d4e50" text-anchor="' + (useR ? 'start' : 'end') + '">' + best.t.name + '</text>';
      if (state.bottom === true) {
        var contact = best.t.key === 'magnet' ? '已接触' :
          (best.t.key === 'pin' || best.t.key === 'box' ? '已造扣' :
            (best.t.key === 'yiba' ? '已收爪' :
              (best.t.key === 'rope' || best.t.key === 'thin' ? '已钩挂' :
                (best.t.key === 'basket' ? '循环带入' : '已咬合'))));
        s += '<text x="' + pT.x.toFixed(1) + '" y="' + (pT.y + 11).toFixed(1) + '" font-size="8" fill="#6f7a7c" text-anchor="' + (useR ? 'start' : 'end') + '">' + contact + '</text>';
      } else if (state.bottom === null) {
        s += '<text x="' + pT.x.toFixed(1) + '" y="' + (pT.y + 11).toFixed(1) + '" font-size="8" fill="#9a6b1d" text-anchor="' + (useR ? 'start' : 'end') + '">待铅印确认</text>';
      }
    }

    /* ---- 井斜角标：从垂直方向量起，与井身使用同一图示角度 ---- */
    s += '<g transform="translate(10,26)">';
    s += '<line x1="0" y1="0" x2="0" y2="28" stroke="#beb19a" stroke-dasharray="3 2"/>';
    s += '<line x1="0" y1="0" x2="' + (-28 * Math.sin(a)).toFixed(1) + '" y2="' + (28 * Math.cos(a)).toFixed(1) + '" stroke="#1d4e50" stroke-width="1.6"/>';
    if (vis > 1) {
      s += '<path d="M0 14 A14 14 0 0 0 ' + (-14 * Math.sin(a)).toFixed(1) + ' ' + (14 * Math.cos(a)).toFixed(1) + '" fill="none" stroke="#1d4e50" stroke-width="1" opacity=".55"/>';
    }
    s += '<text x="0" y="42" font-size="9" fill="#4a585c" font-family="monospace">井斜 ' + state.incl + '°</text>';
    s += '<text x="0" y="53" font-size="7.5" fill="#99a3a4" font-family="monospace">图示 ' + vis.toFixed(1) + '°</text>';
    s += '<text x="0" y="63" font-size="7.5" fill="#99a3a4" font-family="monospace">非等比例</text>';
    s += '</g>';

    s += '<text x="370" y="16" font-size="7.5" fill="#beb19a" text-anchor="end" font-family="monospace">示意 · 非等比例</text>';

    el('schematic').innerHTML = s;
  }

  function toolGlyph(t, top, bot, w) {
    var cx = 144, h = bot - top, BOT = 392, S = '#1d4e50', s = '';
    s += '<line x1="' + cx + '" y1="62" x2="' + cx + '" y2="' + top + '" stroke="#cbd6d2" stroke-width="3"/>';

    if (t.key === 'kawa' || t.key === 'small' || t.key === 'sucker' || t.key === 'basket') {
      s += '<rect x="' + (cx - w / 2) + '" y="' + top + '" width="' + w + '" height="' + h + '" rx="2" fill="rgba(29,78,80,.12)" stroke="' + S + '" stroke-width="1.2"/>';
      s += '<rect x="' + (cx - w / 2 + 4) + '" y="' + (bot - 20) + '" width="' + (w - 8) + '" height="20" fill="none" stroke="' + S + '" stroke-width="1" stroke-dasharray="3 2"/>';
      s += '<path d="M' + (cx - w / 2 + 3) + ' ' + (bot - 16) + ' L' + (cx - w / 2 + 13) + ' ' + (bot - 11) + ' L' + (cx - w / 2 + 3) + ' ' + (bot - 6) + ' Z" fill="' + S + '" opacity=".8"/>';
      s += '<path d="M' + (cx + w / 2 - 3) + ' ' + (bot - 16) + ' L' + (cx + w / 2 - 13) + ' ' + (bot - 11) + ' L' + (cx + w / 2 - 3) + ' ' + (bot - 6) + ' Z" fill="' + S + '" opacity=".8"/>';
      if (t.key === 'basket') {
        for (var i = 0; i < 6; i++) {
          s += '<circle cx="' + (cx - 10 + (i % 3) * 10) + '" cy="' + (bot - 16 + Math.floor(i / 3) * 7) + '" r="1.2" fill="' + S + '" opacity=".5"/>';
        }
      }
    } else if (t.key === 'box') {
      var tw = w * 0.55;
      s += '<path d="M' + (cx - tw / 2) + ' ' + top + ' L' + (cx + tw / 2) + ' ' + top + ' L' + (cx + w / 2) + ' ' + bot + ' L' + (cx - w / 2) + ' ' + bot + ' Z" fill="rgba(29,78,80,.12)" stroke="' + S + '" stroke-width="1.2"/>';
      s += '<path d="M' + (cx - tw / 2 + 4) + ' ' + (top + 4) + ' L' + (cx + tw / 2 - 4) + ' ' + (top + 4) + ' L' + (cx + w / 2 - 6) + ' ' + (bot - 3) + ' L' + (cx - w / 2 + 6) + ' ' + (bot - 3) + ' Z" fill="none" stroke="' + S + '" stroke-width="1" stroke-dasharray="3 2"/>';
      s += '<line x1="' + (cx - w / 2 + 7) + '" y1="' + (bot - 12) + '" x2="' + (cx + w / 2 - 7) + '" y2="' + (bot - 12) + '" stroke="' + S + '" opacity=".4"/>';
    } else if (t.key === 'pin') {
      s += '<rect x="' + (cx - 9) + '" y="' + top + '" width="18" height="18" rx="2" fill="rgba(29,78,80,.12)" stroke="' + S + '"/>';
      s += '<path d="M' + (cx - 9) + ' ' + (top + 18) + ' L' + (cx + 9) + ' ' + (top + 18) + ' L' + (cx + 5) + ' ' + bot + ' L' + (cx - 5) + ' ' + bot + ' Z" fill="rgba(29,78,80,.12)" stroke="' + S + '"/>';
      for (var j = 0; j < 4; j++) {
        var yy = top + 24 + j * ((bot - top - 24) / 4);
        s += '<line x1="' + (cx - 8 + j * 0.9) + '" y1="' + yy + '" x2="' + (cx + 8 - j * 0.9) + '" y2="' + yy + '" stroke="' + S + '" stroke-width=".8" opacity=".55"/>';
      }
    } else if (t.key === 'spear') {
      s += '<rect x="' + (cx - 5) + '" y="' + top + '" width="10" height="' + (h - 6) + '" rx="2" fill="rgba(29,78,80,.12)" stroke="' + S + '"/>';
      s += '<path d="M' + (cx - 5) + ' ' + (top + 22) + ' L' + (cx - 18) + ' ' + (top + 34) + ' L' + (cx - 18) + ' ' + (bot - 4) + ' L' + (cx - 5) + ' ' + (bot - 16) + ' Z" fill="' + S + '" opacity=".55"/>';
      s += '<path d="M' + (cx + 5) + ' ' + (top + 22) + ' L' + (cx + 18) + ' ' + (top + 34) + ' L' + (cx + 18) + ' ' + (bot - 4) + ' L' + (cx + 5) + ' ' + (bot - 16) + ' Z" fill="' + S + '" opacity=".55"/>';
    } else if (t.key === 'magnet') {
      s += '<rect x="' + (cx - w / 2) + '" y="' + top + '" width="' + w + '" height="' + h + '" rx="3" fill="rgba(29,78,80,.12)" stroke="' + S + '"/>';
      s += '<rect x="' + (cx - w / 2) + '" y="' + (bot - 9) + '" width="' + w + '" height="9" fill="#a64b3c"/>';
      s += '<text x="' + cx + '" y="' + (bot - 2) + '" font-size="6" fill="#fff" text-anchor="middle" font-family="monospace">S</text>';
      if (bot < BOT - 24) {
        s += '<path d="M' + (cx - 8) + ' ' + (bot + 2) + ' C' + (cx - 16) + ' ' + (bot + 12) + ' ' + (cx - 8) + ' ' + (bot + 18) + ' ' + cx + ' ' + (bot + 18) + ' M' + (cx + 8) + ' ' + (bot + 2) + ' C' + (cx + 16) + ' ' + (bot + 12) + ' ' + (cx + 8) + ' ' + (bot + 18) + ' ' + cx + ' ' + (bot + 18) + '" fill="none" stroke="' + S + '" stroke-width="1" stroke-dasharray="2 2" opacity=".6"/>';
      }
    } else if (t.key === 'yiba') {
      s += '<rect x="' + (cx - w / 2) + '" y="' + top + '" width="' + w + '" height="' + (h - 10) + '" rx="2" fill="rgba(29,78,80,.12)" stroke="' + S + '"/>';
      s += '<path d="M' + (cx - w / 2 + 4) + ' ' + (bot - 18) + ' C' + (cx - w / 2 - 2) + ' ' + (bot + 10) + ' ' + (cx - 6) + ' ' + (bot + 14) + ' ' + cx + ' ' + (bot + 12) + '" fill="none" stroke="' + S + '" stroke-width="1.6"/>';
      s += '<path d="M' + (cx + w / 2 - 4) + ' ' + (bot - 18) + ' C' + (cx + w / 2 + 2) + ' ' + (bot + 10) + ' ' + (cx + 6) + ' ' + (bot + 14) + ' ' + cx + ' ' + (bot + 12) + '" fill="none" stroke="' + S + '" stroke-width="1.6"/>';
    } else {
      var bw = t.key === 'thin' ? 5 : 10;
      s += '<rect x="' + (cx - bw / 2) + '" y="' + top + '" width="' + bw + '" height="' + (h - 8) + '" rx="2" fill="rgba(29,78,80,.12)" stroke="' + S + '"/>';
      s += '<path d="M' + cx + ' ' + (bot - 8) + ' C' + cx + ' ' + (bot + 10) + ' ' + (cx - 14) + ' ' + (bot + 8) + ' ' + (cx - 14) + ' ' + (bot - 2) + ' C' + (cx - 14) + ' ' + (bot - 10) + ' ' + (cx - 5) + ' ' + (bot - 12) + ' ' + (cx - 1) + ' ' + (bot - 8) + '" fill="none" stroke="' + S + '" stroke-width="' + (t.key === 'thin' ? 1.1 : 1.8) + '"/>';
      s += '<path d="M' + (cx - 12) + ' ' + (bot - 2) + ' L' + (cx - 18) + ' ' + (bot - 6) + '" stroke="' + S + '" stroke-width="1"/>';
    }
    return s;
  }

  /* =========================================================
     渲染
     ========================================================= */
  function render() {
    var c = curCasing();
    var f = FORM_OF(state.form);
    var s = {
      form: state.form, casing: c, drift: c.drift, od: state.od, fishId: state.fishId,
      fishBore: f.bore, len: state.len, incl: state.incl, bottom: state.bottom,
      circ: state.circ, material: state.material, stuck: state.stuck
    };

    var rows = rank(s);
    var usable = rows.filter(function (r) { return !r.e.out; });
    var best = usable[0] || null;
    var hardCount = rows.length - usable.length;

    var branchA = null, branchB = null;
    if (state.bottom === null) {
      var sa = clone(s); sa.bottom = true;
      var sb = clone(s); sb.bottom = false;
      branchA = bestOf(rank(sa));
      branchB = bestOf(rank(sb));
    }

    el('st-tool').textContent = best ? (best.t.name + (state.bottom === null && best.t.needBottom ? '（条件）' : '')) : (state.stuck === 'buried' ? '需先套铣/磨铣' : '无可用工具');
    el('st-score').textContent = best ? best.score.toFixed(2) : '—';
    el('st-trip').textContent = tripText(best);
    el('st-excl').innerHTML = hardCount + ' <small>/ ' + TOOLS.length + ' 件</small>';
    el('sch-hint').textContent = state.od + ' mm × ' + fmt1(state.len) + ' m · 通径 ' + fmt1(c.drift) + ' mm';
    el('art-hint').textContent = best ? best.t.name : '—';
    el('art-note').textContent = best ? best.t.note :
      '当前没有通过硬约束的打捞工具。系统不会为了给出答案而推荐物理不可行的工具，应先走套铣/磨铣工序清障。';
    el('toolart').innerHTML = best ? toolArt(best.t.key) : '';

    /* 排序列表：不可用标红并列出全部原因，可用行 title 带完整规格与备注 */
    var rankNo = 0;
    el('rank').innerHTML = rows.map(function (r) {
      var t = r.t, e = r.e, head;
      if (e.out) {
        return '<div class="rankrow out" title="不可用：' + e.why + '｜' + toolTitle(t) + '">' +
          '<div class="l1"><span class="mono" style="font-size:9.5px;color:var(--ink-4)">—</span>' +
          '<span class="nm">' + t.name + '</span><span class="sc">不可用</span></div>' +
          '<div class="meta">' + sizeMeta(t) + '</div>' +
          '<div class="why">不可用：' + e.why + '</div></div>';
      }
      rankNo++;
      var badge = rankNo === 1
        ? (state.bottom === null && t.needBottom ? ' <span class="db warn">条件首选</span>' : ' <span class="db ok">首选</span>')
        : '';
      head = '<div class="l1"><span class="mono" style="font-size:9.5px;color:var(--ink-4)">' + rankNo + '</span>' +
        '<span class="nm">' + t.name + badge + '</span>' +
        '<span class="sc">' + e.score.toFixed(2) + '</span></div>' +
        '<div class="dbar" style="margin-top:3px"><span class="track"><i style="width:' + (e.score * 100).toFixed(0) + '%"></i></span>' +
        '<span class="val">' + Math.round(e.score * 100) + '%</span></div>' +
        '<div class="meta">' + sizeMeta(t) + '</div>';
      if (e.warns.length) head += '<div class="warnline">' + e.warns.join('；') + '</div>';
      return '<div class="rankrow" title="' + toolTitle(t) + '">' + head + '</div>';
    }).join('');

    /* 分项得分 */
    if (best) {
      var clearance = '工具外径 ' + best.t.od + ' mm ≤ 通径 ' + fmt1(c.drift) + ' − 2×6 = ' + fmt1(c.drift - 12) + ' mm';
      var catchTxt = best.t.basis === 'id'
        ? '落物内径 ' + state.fishId + ' mm 在' + best.t.sizeLabel + ' ' + best.t.dmin + '—' + best.t.dmax + ' mm 内'
        : '落物外径 ' + state.od + ' mm 在' + best.t.sizeLabel + ' ' + best.t.dmin + '—' + best.t.dmax + ' mm 内';
      var lenTxt = '落物长度 ' + fmt1(state.len) + ' m ≥ 最小咬合长度 ' + fmt1(best.t.minLen) + ' m';
      el('parts').innerHTML = best.e.parts.map(function (x) {
        return '<div class="dbar" style="padding:4px 0"><span style="width:64px;font-size:10.5px">' + x.k + '</span>' +
          '<span class="track"><i style="width:' + (x.p * 100).toFixed(0) + '%"></i></span>' +
          '<span class="val">' + (x.w * x.p).toFixed(3) + ' / ' + x.w.toFixed(2) + '</span></div>';
      }).join('') +
        '<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--ink-3);border-top:1px solid var(--line);margin-top:6px;padding-top:6px">' +
        '<span>历史成功率（该工具）</span><span class="mono">' + (best.t.succ * 100).toFixed(0) + '%</span></div>' +
        '<div style="font-size:10px;color:var(--ink-3);line-height:1.65;margin-top:5px">' +
        clearance + '<br>' + catchTxt + '<br>' + lenTxt + '</div>';
    } else {
      el('parts').innerHTML = '<div style="font-size:11px;color:var(--ink-3);line-height:1.65">没有可用工具，无法分项评分。' +
        '硬约束已经把所有物理不可行的选项排除，危险推荐率保持 0%。</div>';
    }

    renderOrders(best, usable, branchA, branchB);
    renderPrep(best);
    renderTable(best);
    renderNote(rows, usable, best, branchA, branchB);
    drawSchematic(best);
  }

  /* ---------- 作业顺序 ---------- */
  function renderOrders(best, usable, branchA, branchB) {
    var o = [];
    var stuck = state.stuck;
    var limit = curCasing().drift - 2 * CLEARANCE;
    var washWarn = PREP[0].od > limit
      ? ' <b>套铣筒 108 mm 超过本井上限 ' + fmt1(limit) + ' mm，需换小一级。</b>' : '';
    var basketWarn = PREP[2].od > limit
      ? ' <b>篮式筒 108 mm 超过本井上限 ' + fmt1(limit) + ' mm，需换小一级或改用反循环。</b>' : '';
    var circWarn = state.circ ? '' : ' <b>本井不可循环</b>，套铣/磨铣/篮式清屑工序不可用，需先恢复循环或改用机械清障。';

    if (state.bottom === null) {
      o.push('<b>先打印（铅印）确认鱼顶</b>：落物是否落底、鱼顶是否规则、是否被砂埋。不要用通井规探底代替打印。');
      o.push('<b>分支 A · 若已落底</b>：' + (branchA
        ? '首选 <b>' + branchA.t.name + '</b>（' + branchA.score.toFixed(2) + '）；' + branchA.t.op
        : '无工具通过硬约束，先评估套铣/磨铣。'));
      if (branchB && branchA && branchB.t.key === branchA.t.key) {
        o.push('<b>分支 B · 若悬空</b>：首选同为 <b>' + branchB.t.name + '</b>（' + branchB.score.toFixed(2) + '）；动作同上，但需落底的工具全部不可用。');
      } else {
        o.push('<b>分支 B · 若悬空</b>：' + (branchB
          ? '首选 <b>' + branchB.t.name + '</b>（' + branchB.score.toFixed(2) + '）；' + branchB.t.op + ' 需落底的工具在这一分支全部不可用。'
          : '没有工具通过硬约束，需先打印鱼顶并评估套铣/磨铣。'));
      }
    }

    if (best && state.bottom !== null) {
      o.push('<b>本趟</b>：' + best.t.op);
    }
    if (best && (stuck === 'sand' || stuck === 'cement')) {
      o.push('<b>工具串</b>：' + best.t.name + ' + 震击器 + 安全接头。' +
        (stuck === 'sand' ? '砂卡时遇卡可震击解卡，安全接头保证能丢手退出。' : '水泥卡时先套铣/磨铣解除水泥环，再带震击器与安全接头下打捞工具。'));
    }

    if (usable[1]) {
      o.push('备选：<b>' + usable[1].t.name + '</b>（匹配度 ' + usable[1].score.toFixed(2) + '）。若首选抓空或咬合失败，第二趟直接换它，避免临时找工具。');
    }

    if (!best) {
      o.push('<b>无直接打捞工具</b>：先走工序——' +
        (stuck === 'buried' ? '套铣筒清障 → ' : '') +
        '平底磨鞋磨铣 → 篮式捞筒 / 反循环清屑 → 再评估打捞。不要带着卡瓦类工具硬下。' +
        (stuck === 'buried' ? ' 清障后下打捞工具时，工具串再加震击器 + 安全接头。' : '') + washWarn + basketWarn + circWarn);
    } else if (state.od >= 88) {
      o.push('落物外径 ' + state.od + ' mm 偏大：若首选失败，不要反复下卡瓦类工具，转<b>平底磨鞋 + 篮式捞筒/反循环</b>磨铣清屑后再捞。');
    }

    if (stuck === 'sand' || stuck === 'cement') {
      o.push('<b>解卡前置</b>：' + (stuck === 'sand' ? '砂卡先用套铣筒清洗砂桥' : '水泥卡先用套铣筒/平底磨鞋处理水泥环') + '，套铣到位后再下打捞工具；不要用打捞工具直接硬提。' + (best ? washWarn : '') + (best ? circWarn : ''));
    }

    el('orders').innerHTML = o.map(function (x) { return '<div>' + x + '</div>'; }).join('');
  }

  /* ---------- 解卡 / 磨铣工序面板 ---------- */
  function renderPrep(best) {
    var stuck = state.stuck;
    var c = curCasing();
    var limit = c.drift - 2 * CLEARANCE;
    var washFit = PREP[0].od <= limit;
    var seq;
    if (stuck === 'buried') {
      seq = '<b>落物被埋</b>：鱼顶不可达，直接打捞工具已全部被硬约束排除。顺序：<b>套铣筒 → 平底磨鞋 → 篮式捞筒 / 反循环 → 打捞工具</b>；清障后下打捞工具时，工具串再加<b>震击器 + 安全接头</b>。';
    } else if (stuck === 'sand') {
      seq = '<b>砂卡</b>：先下<b>套铣筒</b>清洗砂桥，再下打捞工具；工具串加<b>震击器 + 安全接头</b>。平底磨鞋只在鱼顶不规则时使用。';
    } else if (stuck === 'cement') {
      seq = '<b>水泥卡</b>：套铣筒磨铣水泥环，必要时用平底磨鞋修整鱼顶，篮式捞筒/反循环清屑后再捞。';
    } else if (!best) {
      seq = '<b>无直接打捞工具</b>：改走磨铣工序——<b>平底磨鞋 + 篮式捞筒 / 反循环</b>清屑，再评估打捞。';
    } else {
      seq = '<b>当前未卡阻</b>：打捞工具可直接接触鱼顶，不需要套铣/磨铣。若后续出现砂卡、水泥卡或落物被埋，再启用下列工序。';
    }
    if (!washFit && stuck !== 'none') {
      seq += ' <b>注意</b>：套铣筒外径 108 mm 超过本井工具外径上限 ' + fmt1(limit) + ' mm，需换小一级套铣筒。';
    }
    var prepBad = PREP.some(function (p) {
      return (p.circ && !state.circ) || p.od > limit;
    });
    if (prepBad && (stuck !== 'none' || !best)) {
      seq += ' <b>注意</b>：标「不可用」的工序工具不满足通径或循环条件，不能下；先恢复循环或换小一级工具。';
    }
    if (!best && stuck === 'none') {
      seq += ' 本井工具外径上限 ' + fmt1(limit) + ' mm，选工序工具时同样要校核通径。';
    }

    var rows = PREP.map(function (p) {
      var pass = p.od <= limit;
      var circOk = !p.circ || state.circ;
      var bad = [];
      if (!pass) bad.push('外径超过本井上限 ' + fmt1(limit) + ' mm，需换小一级');
      if (!circOk) bad.push('需循环，本井不可循环');
      var status = '待用', cls = 'plain';
      if (bad.length) { status = '不可用'; cls = 'bad'; }
      else if (stuck === 'buried') { status = '适用'; cls = 'ok'; }
      else if (stuck === 'sand' || stuck === 'cement') {
        if (p.key === 'wash') { status = '先做'; cls = 'ok'; }
        else if (p.key === 'mill') { status = '视情况'; cls = 'warn'; }
        else { status = '随后清屑'; cls = 'plain'; }
      } else if (!best) {
        if (p.key === 'wash') { status = '视情况'; cls = 'warn'; }
        else { status = '推荐'; cls = 'ok'; }
      }
      var fitTxt = bad.length ? ' · ' + bad.join('；') : '';
      return '<div class="prep-row"><div class="pn">' + p.name + '</div>' +
        '<div class="pd">' + p.note + '<br><em>外径 ' + p.od + ' mm · ' + p.when + ' · 需循环 ' + (p.circ ? '是' : '否') + fitTxt + '</em></div>' +
        '<div><span class="db ' + cls + '">' + status + '</span></div></div>';
    }).join('');

    el('prep').innerHTML = '<div class="prep-seq">' + seq + '</div>' + rows;
  }

  /* ---------- 工具尺寸表 ---------- */
  function renderTable(best) {
    var head = '<div class="tblwrap"><table class="ttbl"><colgroup>' +
      '<col style="width:12%"><col style="width:6%"><col style="width:15%"><col style="width:13%">' +
      '<col style="width:6%"><col style="width:6%"><col style="width:7%"><col style="width:7%"><col style="width:28%">' +
      '</colgroup><thead><tr><th>工具</th><th>外径</th><th>内孔 / 可捞区间</th><th>适用形态</th>' +
      '<th>落底</th><th>循环</th><th>最大井斜</th><th>成功率</th><th>备注</th></tr></thead><tbody>';

    var body = TOOLS.map(function (t) {
      var cid = (t.bore ? t.bore : '—') + ' / ' + (t.basis === 'id' ? '内径 ' : '') + t.dmin + '—' + t.dmax;
      var isBest = best && best.t.key === t.key;
      return '<tr' + (isBest ? ' class="best"' : '') + ' title="' + t.note + '">' +
        '<td class="tn">' + t.name + '</td>' +
        '<td class="num">' + t.od + '</td>' +
        '<td class="cid">' + cid + '</td>' +
        '<td>' + formNames(t) + '</td>' +
        '<td class="num">' + (t.needBottom ? '是' : '否') + '</td>' +
        '<td class="num">' + (t.circ ? '是' : '否') + '</td>' +
        '<td class="num">' + t.maxIncl + '°</td>' +
        '<td class="num">' + Math.round(t.succ * 100) + '%</td>' +
        '<td class="note">' + t.note + '</td></tr>';
    }).join('');

    var cap = '<div class="tblcap"><b>读表约定</b>：外部套入式工具必须满足「可捞上限 dmax &lt; 工具内孔 &lt; 工具外径」，' +
      '否则落物进不去或工具进不了套管；<b>公锥 / 捞矛</b>按落物内径选型，<b>母锥 / 卡瓦筒</b>按落物外径选型。' +
      '套铣筒与平底磨鞋是解卡/磨铣工序工具，不进入打捞排序。</div>';

    el('tooltable').innerHTML = head + body + '</tbody></table></div>' + cap;
  }

  /* ---------- 教学说明 ---------- */
  function renderNote(rows, usable, best, branchA, branchB) {
    var f = FORM_OF(state.form), c = curCasing();
    var txt = '当前落物：<b>' + f.name + '</b>（' + f.desc + '），外径 ' + state.od + ' mm' +
      (f.bore ? (state.fishId > 0 ? '、内径 ' + state.fishId + ' mm' : '、内径未给出') : '、无内孔') +
      '、长 ' + fmt1(state.len) + ' m；套管 <b>' + c.label + '</b>（通径 ' + fmt1(c.drift) + ' mm，工具外径上限 ' + fmt1(c.drift - 12) + ' mm）；' +
      '井斜 ' + state.incl + '°；' +
      (state.bottom === true ? '<b>已落底</b>' : (state.bottom === false ? '<b>悬空</b>' : '落底状态<b>未知</b>（默认给两分支）')) +
      '；' + (state.circ ? '可循环洗井' : '不可循环') + '；' + (state.material === 'ferro' ? '铁磁性' : '非铁磁性') +
      '；卡阻状态：' + (state.stuck === 'none' ? '未卡阻' : (state.stuck === 'sand' ? '砂卡' : (state.stuck === 'cement' ? '水泥卡' : '落物被埋'))) + '。';

    txt += ' 硬约束排除了 <b>' + (rows.length - usable.length) + '</b> 件，剩余 <b>' + usable.length + '</b> 件参与评分。';
    if (best) {
      txt += ' 首选 <b>' + best.t.name + '</b>，匹配度 <b>' + best.score.toFixed(2) + '</b>，预计起下钻 <b>' + tripText(best) + '</b>。';
      txt += state.bottom === null
        ? ' 进入排序的工具全部通过外径/通径、可捞区间、材质、井斜、循环、咬合长度六类硬约束；落底未知时，需落底工具只作条件推荐（悬空分支不可用）。<b>危险推荐率 0%</b>。'
        : ' 进入排序的工具全部通过外径/通径、可捞区间、材质、井斜、循环、落底、咬合长度七类硬约束，<b>危险推荐率 0%</b>。';
    } else {
      txt += ' 当前没有通过硬约束的打捞工具——<b>危险推荐率 0%</b>，系统不会为了给答案而推荐物理不可行项。';
    }
    if (state.bottom === null) {
      txt += ' 落底分支：' + (branchA ? '<b>' + branchA.t.name + '</b>（' + branchA.score.toFixed(2) + '）' : '无') +
        '；悬空分支：' + (branchB ? '<b>' + branchB.t.name + '</b>（' + branchB.score.toFixed(2) + '）' : '无可用工具') + '。';
    }

    var tip;
    if (state.stuck === 'buried') {
      tip = ' 落物被埋时鱼顶不可达，所有直接打捞工具都被排除，应先套铣/磨铣清障——这是“先清障、后打捞”的硬顺序。';
    } else if (state.casing === 1) {
      tip = ' 5-1/2" 23# 的通径只有 118.6 mm，按单边 6 mm 间隙工具外径上限 106.6 mm；外径 108 mm 的卡瓦打捞筒与篮式捞筒已被排除——校核必须用通径，不能用套管外径。';
    } else if (state.od >= 100) {
      tip = ' 落物外径 ≥100 mm 已超过卡瓦筒/母锥的可捞上限，直接打捞不可行，只能先磨铣/套铣；这正是“大件先磨后捞”的现场逻辑。';
    } else if (state.form === 'cable' && state.incl >= 60) {
      tip = ' 大斜度井里电缆贴壁，绳类打捞钩的钩挂窗口很窄；细钢丝捞钩允许井斜只有 55°，在 60° 以上井里已被硬约束排除。';
    } else if (state.bottom === null) {
      tip = ' 落底状态默认“未知”：需落底的一把抓只给条件推荐，先铅印打印鱼顶，再按落底/悬空两个分支选工具。';
    } else {
      tip = ' 试试把套管切到 5-1/2" 23#：工具外径上限降到 106.6 mm，108 mm 的卡瓦筒会立刻被排除；再把落物外径拖到 110 mm，所有卡瓦类工具都会失效，只剩磨铣/套铣工序。';
    }
    el('note').innerHTML = txt + tip;
  }

  /* =========================================================
     控件
     ========================================================= */
  function setSeg(id, attr, val) {
    var box = el(id);
    if (!box) return;
    [].forEach.call(box.children, function (b) {
      b.classList.toggle('on', b.getAttribute(attr) === String(val));
    });
  }

  function syncControls() {
    var c = curCasing();
    var f = FORM_OF(state.form);
    var maxOd = Math.max(1, Math.floor(c.drift - 1));

    if (state.od > maxOd) state.od = maxOd;
    if (state.od < 1) state.od = 1;
    var idMax = Math.max(0, state.od - 6);
    if (!f.bore) state.fishId = 0;
    if (state.fishId > idMax) state.fishId = idMax;
    if (state.fishId < 0) state.fishId = 0;

    el('r-od').max = maxOd;
    el('r-od').value = state.od;
    el('o-od').textContent = state.od + ' mm';

    el('r-fid').max = Math.max(1, idMax);
    el('r-fid').value = state.fishId;
    el('r-fid').disabled = !f.bore;
    el('o-fid').textContent = f.bore ? (state.fishId > 0 ? (state.fishId + ' mm') : '未给出') : '无内孔';

    el('r-len').value = state.len;
    el('o-len').textContent = fmt1(state.len) + ' m';
    el('r-incl').value = state.incl;
    el('o-incl').textContent = state.incl + '°';

    el('casing-hint').textContent = '通径 ' + fmt1(c.drift) + ' mm · 工具外径 ≤ ' + fmt1(c.drift - 12) + ' mm（单边 6 mm）';

    setSeg('seg-form', 'data-f', state.form);
    setSeg('seg-casing', 'data-v', state.casing);
    setSeg('seg-bottom', 'data-b', state.bottom === null ? 'u' : (state.bottom ? '1' : '0'));
    setSeg('seg-mat', 'data-m', state.material);
    setSeg('seg-stuck', 'data-s', state.stuck);
    el('tog-circ').classList.toggle('on', state.circ);
  }

  function applyForm(k) {
    var f = FORM_OF(k);
    var maxOd = Math.max(1, Math.floor(curCasing().drift - 1));
    state.form = k;
    state.od = clamp(f.od, 1, maxOd);
    state.len = clamp(f.len, 0.1, 12);
    state.fishId = f.bore ? clamp(f.fid, 0, Math.max(0, state.od - 6)) : 0;
    syncControls();
    render();
  }

  function init() {
    el('seg-form').innerHTML = FORMS.map(function (f) {
      return '<button type="button" data-f="' + f.key + '" title="' + f.desc + '">' + f.name + '</button>';
    }).join('');

    el('seg-casing').innerHTML = CASINGS.map(function (c, i) {
      return '<button type="button" data-v="' + i + '" title="' + c.label.replace(/"/g, '&quot;') + ' 通径 ' + fmt1(c.drift) + ' mm">' + c.label + '</button>';
    }).join('');

    el('seg-form').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      applyForm(b.getAttribute('data-f'));
    });

    el('seg-casing').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      state.casing = Number(b.getAttribute('data-v'));
      syncControls();
      render();
    });

    el('seg-bottom').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      var v = b.getAttribute('data-b');
      state.bottom = v === '1' ? true : (v === '0' ? false : null);
      syncControls();
      render();
    });

    el('seg-mat').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      state.material = b.getAttribute('data-m');
      syncControls();
      render();
    });

    el('seg-stuck').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      state.stuck = b.getAttribute('data-s');
      syncControls();
      render();
    });

    el('tog-circ').addEventListener('click', function () {
      state.circ = !state.circ;
      syncControls();
      render();
    });

    function bindSlider(id, key, isFloat) {
      var r = el(id);
      r.addEventListener('input', function () {
        state[key] = isFloat ? Number(r.value) : Math.round(Number(r.value));
        syncControls();
        render();
      });
    }
    bindSlider('r-od', 'od', false);
    bindSlider('r-fid', 'fishId', false);
    bindSlider('r-len', 'len', true);
    bindSlider('r-incl', 'incl', false);

    el('btn-reset').addEventListener('click', function () {
      state = clone(DEFAULTS);
      syncControls();
      render();
    });

    syncControls();
    render();
  }

  init();
})();
