/* =========================================================
   落物打捞工具智能选型 · AI 作业流示范（v2）
   ---------------------------------------------------------
   这条流水线回答的不是「哪种工具分数最高」，而是：
     一段现场描述 → 能不能用 → 哪些工具物理可行 → 可行候选谁更可能成功
     → 这一趟带什么、备什么、先做什么 → 现场结果怎样回到模型
   ① 落物描述结构化：文本 → 10 个字段 + 质控；
   ② 工具知识图谱与硬约束：8 道门真排除，排除项不进入模型；
   ③ 学习排序：640 例合成历史记录（512 训练 / 128 验证），
      6 维特征逻辑回归 + 标准化 + 标签平滑 + 温度缩放；
   ④ 方案组装：主工具 + 备选 + 解卡/磨铣工序 + 风险；
   ⑤ 反馈与价值：选用成功/失败回写，成功率平滑更新，追加样本重训。
   合成数据与现场口径在页面上分开标注，不混用。
   ========================================================= */
(function () {
  'use strict';

  /* =========================================================
     1. 领域知识
     ========================================================= */
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

  /* 工具知识表（11 件打捞工具）。basis='od' 按落物外径判断，'id' 按落物内径判断 */
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
    { key: 'basketp', name: '篮式捞筒 / 反循环', od: 108, circ: 1, when: '磨铣后清屑',
      note: '清除磨铣产生的铁屑，避免二次落物；也可用反循环打捞篮。' }
  ];

  var FEATS = [
    { key: 'size', label: '尺寸匹配', hint: '落物外径/内径落在工具可捞区间中的位置' },
    { key: 'reach', label: '可达性', hint: '井斜余量、落底未知与卡阻对工具到达鱼顶的影响' },
    { key: 'mat', label: '材质匹配', hint: '磁力工具对铁磁性落物有优势，机械工具对材质不敏感' },
    { key: 'len', label: '咬合长度', hint: '落物长度相对最小咬合长度与最大容纳长度' },
    { key: 'succ', label: '历史成功率', hint: '工具知识表 / 在线回写得到的成功率' },
    { key: 'comp', label: '工序复杂度', hint: '是否需循环、落底、震击与造扣；越简单越高' }
  ];

  var PRIOR_N = 12;
  var SUCC = {};
  TOOLS.forEach(function (t) { SUCC[t.key] = t.succ; });

  var DEFAULTS = {
    form: 'tubular', casing: 0, od: 73, fishId: 62, len: 2.4, incl: 18,
    bottom: null, circ: true, material: 'ferro', stuck: 'none'
  };

  function freshSrc() {
    return { form: false, casing: false, od: false, fishId: false, len: false, incl: false, bottom: false, material: false, stuck: false, circ: false };
  }

  var state = clone(DEFAULTS);
  state.src = freshSrc();
  state.focus = null;
  state.stage = 0;

  var FB = { ok: 0, bad: 0, byTool: {} };
  var ONLINE_ROWS = [];
  var TRACE = [];
  var RUN_TIMERS = [];
  var RENDER_TIMER = null;
  var MODEL = null;
  var LAST = null;

  /* =========================================================
     2. 小工具
     ========================================================= */
  function clone(o) {
    var r = {}, k;
    for (k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) r[k] = o[k]; }
    return r;
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function fmt1(v) { return (Math.round(v * 10) / 10).toFixed(1); }
  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
    });
  }
  function curCasing() { return CASINGS[state.casing]; }
  function FORM_OF(k) {
    var i;
    for (i = 0; i < FORMS.length; i++) if (FORMS[i].key === k) return FORMS[i];
    return FORMS[0];
  }
  function stuckName(k) {
    return k === 'none' ? '未卡阻' : (k === 'sand' ? '砂卡' : (k === 'cement' ? '水泥卡' : '被埋'));
  }
  function formNames(t) {
    if (t.basis === 'id') return '管状体（需内孔）';
    var a = [];
    FORMS.forEach(function (f) { if ((t.form[f.key] || 0) >= 0.4) a.push(f.name); });
    return a.length ? a.join('、') : '—';
  }
  function fishValue(t, s) { return t.basis === 'id' ? s.fishId : s.od; }
  function succNow(t) { return SUCC[t.key]; }

  /* ---------- 可复现随机数 ---------- */
  var RND = { a: 20261031 };
  function seedRnd(a) {
    a = Math.floor(a) % 2147483647;
    if (a <= 0) a += 2147483646;
    RND.a = a;
  }
  function rnd() { RND.a = (RND.a * 16807) % 2147483647; return RND.a / 2147483647; }
  function gauss() {
    var u = 1 - rnd(), v = 1 - rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /* =========================================================
     3. 特征与硬约束
     ========================================================= */
  function sizeScore(t, s) {
    var v = fishValue(t, s);
    if (t.sweet && v >= t.sweet[0] && v <= t.sweet[1]) return 1;
    var span = t.dmax - t.dmin;
    if (span <= 0) return 1;
    var pos = (v - t.dmin) / span;
    var edge = Math.min(pos, 1 - pos);
    return 0.65 + 0.35 * Math.min(1, edge / 0.3);
  }

  function inclScoreOf(t, s) {
    var v = 1;
    if (s.incl > t.maxIncl - 10) v = 1 - (s.incl - (t.maxIncl - 10)) / 10 * 0.35;
    return clamp(v, 0.65, 1);
  }

  function lenScoreOf(t, s) {
    var span = Math.max(0.25, t.minLen);
    var margin = (s.len - t.minLen) / span;
    var v = 0.55 + 0.45 * clamp(margin, 0, 1);
    if (t.maxLen < 12 && s.len > 0.7 * t.maxLen) {
      v -= 0.15 * clamp((s.len - 0.7 * t.maxLen) / (0.3 * t.maxLen), 0, 1);
    }
    return clamp(v, 0.2, 1);
  }

  function matScoreOf(t, s) {
    /* 机械工具对材质中性；磁力工具只有在铁磁性落物上才拿满分 */
    if (t.material === 'ferro') return s.material === 'ferro' ? 1 : 0.2;
    return 0.82;
  }

  function reachScoreOf(t, s) {
    var head = clamp(1 - s.incl / Math.max(1, t.maxIncl), 0, 1);
    var v = 0.45 + 0.55 * head;
    if (s.bottom === null) v *= t.needBottom ? 0.55 : 0.90;
    if (s.stuck !== 'none') v *= 0.92;
    return clamp(v, 0.1, 1);
  }

  function compScoreOf(t, s) {
    var c = 1;
    if (t.circ) c -= 0.28;
    if (t.needBottom) c -= 0.22;
    if (s.stuck === 'sand' || s.stuck === 'cement') c -= 0.25;
    if (s.bottom === null) c -= 0.12;
    if (t.basis === 'id') c -= 0.08;
    return clamp(c, 0.1, 1);
  }

  function featureVec(t, s) {
    return [sizeScore(t, s), reachScoreOf(t, s), matScoreOf(t, s), lenScoreOf(t, s), succNow(t), compScoreOf(t, s)];
  }

  /* 返回 {out, gates, reasons, warns, x}
     gates 按固定顺序记录每一道门的判定，供 02 阶段做漏斗 */
  function evaluate(t, s) {
    var gates = [];
    function gate(key, label, ok, detail) {
      gates.push({ key: key, label: label, ok: ok, detail: detail });
    }
    var limit = s.drift - 2 * CLEARANCE;

    gate('reach', '鱼顶可达', s.stuck !== 'buried',
      s.stuck === 'buried' ? '落物被埋，鱼顶不可达' : '鱼顶可达（' + stuckName(s.stuck) + '）');

    gate('drift', '通径 / 单边间隙', t.od <= limit,
      '工具外径 ' + t.od + ' mm ' + (t.od <= limit ? '≤' : '>') + ' 通径 ' + fmt1(s.drift) + ' − 2×6 = ' + fmt1(limit) + ' mm');

    if (t.basis === 'id') {
      var idOk = !!s.fishBore && s.fishId > 0 && s.fishId >= t.dmin && s.fishId <= t.dmax;
      gate('size', '可捞区间', idOk,
        !s.fishBore ? '落物无内孔，' + t.name + '无法插入造扣'
          : (!s.fishId ? '未给出落物内径，无法校核' + t.name
            : '落物内径 ' + s.fishId + ' mm ' + (idOk ? '在' : '超出') + t.sizeLabel + ' ' + t.dmin + '—' + t.dmax + ' mm'));
    } else {
      var odOk = s.od >= t.dmin && s.od <= t.dmax;
      gate('size', '可捞区间', odOk,
        '落物外径 ' + s.od + ' mm ' + (odOk ? '在' : '超出') + t.sizeLabel + ' ' + t.dmin + '—' + t.dmax + ' mm');
    }

    var matOk = !(t.material === 'ferro' && s.material !== 'ferro');
    gate('material', '材质', matOk,
      t.material === 'ferro' ? '磁力工具需铁磁性，落物为' + (s.material === 'ferro' ? '铁磁性' : '非铁磁性') : '机械工具，材质不敏感');

    var inclOk = s.incl <= t.maxIncl;
    gate('incl', '井斜', inclOk,
      '井斜 ' + s.incl + '° ' + (inclOk ? '≤' : '>') + ' 工具允许 ' + t.maxIncl + '°');

    var circOk = !t.circ || s.circ;
    gate('circ', '循环', circOk,
      t.circ ? '工具需循环，本井' + (s.circ ? '可循环' : '不可循环') : '不需要循环');

    var botOk = !(t.needBottom && s.bottom === false);
    gate('bottom', '落底', botOk,
      t.needBottom ? ('工具需落底，落物' + (s.bottom === true ? '已落底' : (s.bottom === false ? '悬空' : '落底未知'))) : '不要求落底');

    var lenOk = s.len >= t.minLen && s.len <= t.maxLen;
    gate('length', '咬合长度', lenOk,
      '落物 ' + fmt1(s.len) + ' m，工具要求 ≥' + fmt1(t.minLen) + ' / ≤' + fmt1(t.maxLen) + ' m');

    var out = gates.some(function (g) { return !g.ok; });
    var reasons = gates.filter(function (g) { return !g.ok; }).map(function (g) { return g.detail; });

    if (out) return { out: true, gates: gates, reasons: reasons, why: reasons.join('；'), warns: [] };

    var warns = [];
    if (t.needBottom && s.bottom === null) warns.push('需落底：状态未知（落底分支可用，悬空分支不可用）');
    if (s.stuck === 'sand') warns.push('砂卡：工具串建议加震击器 + 安全接头');
    if (s.stuck === 'cement') warns.push('水泥卡：工具串建议加震击器 + 安全接头');
    if (t.od > limit - 2) warns.push('工具外径余量仅 ' + fmt1(limit - t.od) + ' mm');
    if (s.incl > t.maxIncl - 10) warns.push('井斜接近工具上限 ' + t.maxIncl + '°');

    return { out: false, gates: gates, reasons: [], why: '', warns: warns, x: featureVec(t, s) };
  }

  /* 旧规则基线：形态 0.45 + 尺寸 0.35 + 历史成功率 0.20（只用于验证集对比） */
  function baseScore(t, s) {
    return 0.45 * (t.form[s.form] || 0) + 0.35 * sizeScore(t, s) + 0.20 * succNow(t);
  }

  /* =========================================================
     4. 合成 640 例历史记录（透明标注）
     ========================================================= */
  var TOOL_BIAS = {
    kawa: 0.05, small: 0.02, box: -0.03, pin: -0.05, spear: 0.03,
    sucker: 0.04, basket: -0.02, magnet: 0.06, yiba: -0.04, rope: 0.01, thin: -0.06
  };

  function trueProb(t, x) {
    var eta = 1.28
      + 3.00 * (x[0] - 0.86)
      + 2.60 * (x[1] - 0.80)
      + 1.20 * (x[2] - 0.84)
      + 5.00 * (x[3] - 0.86)
      + 3.40 * (x[4] - 0.81)
      + 3.20 * (x[5] - 0.78)
      + (TOOL_BIAS[t.key] || 0) * 0.3
      + gauss() * 0.10;
    return 1 / (1 + Math.exp(-eta));
  }

  function pickForm() {
    var r = rnd();
    if (r < 0.40) return 'tubular';
    if (r < 0.60) return 'rod';
    if (r < 0.75) return 'cable';
    if (r < 0.90) return 'solid';
    return 'toolbig';
  }

  function pickCasing() {
    var r = rnd();
    return r < 0.45 ? 0 : (r < 0.80 ? 1 : 2);
  }

  function genCase() {
    var attempt, tt, fitCasings, casingIdx, c, forms, form, f, lo, hi, od, fishId, len, lmin, lmax;
    var incl, br, bottom, material, sr, stuck, circ, s, eT, cands;

    for (attempt = 0; attempt < 160; attempt++) {
      /* 先抽一件「这条历史记录里用过的工具」，再围绕它的适用条件造落物。
         这样每条记录至少有一个真正匹配的候选，避免大量「怎么选都差」的伪样本。 */
      tt = TOOLS[Math.floor(rnd() * TOOLS.length)];

      fitCasings = [];
      CASINGS.forEach(function (cc, i) { if (tt.od <= cc.drift - 2 * CLEARANCE) fitCasings.push(i); });
      if (!fitCasings.length) continue;
      casingIdx = fitCasings[Math.floor(rnd() * fitCasings.length)];
      c = CASINGS[casingIdx];

      forms = FORMS.filter(function (ff) { return (tt.form[ff.key] || 0) >= 0.5; });
      if (!forms.length) continue;
      form = forms[Math.floor(rnd() * forms.length)].key;
      f = FORM_OF(form);

      if (tt.basis === 'od') {
        lo = tt.dmin; hi = tt.dmax;
        if (form === 'tubular') { lo = Math.max(lo, 50); hi = Math.min(hi, 84); }
        if (form === 'rod') { lo = Math.max(lo, 16); hi = Math.min(hi, 30); }
        if (form === 'cable') { lo = Math.max(lo, 1); hi = Math.min(hi, 10); }
        if (form === 'solid') { lo = Math.max(lo, 2); hi = Math.min(hi, 30); }
        if (form === 'toolbig') { lo = Math.max(lo, 80); hi = Math.min(hi, 120); }
        if (lo > hi) continue;
        od = lo + (hi - lo) * (0.30 + rnd() * 0.40);
      } else {
        od = 60 + rnd() * 35;
      }
      od = Math.round(clamp(od, 1, c.drift - 1));

      fishId = 0;
      if (f.bore) {
        if (tt.basis === 'id') fishId = Math.round(tt.dmin + (tt.dmax - tt.dmin) * (0.25 + rnd() * 0.50));
        else fishId = Math.round(od * (0.76 + rnd() * 0.12));
        fishId = clamp(fishId, 1, Math.max(1, od - 6));
      }

      lmin = tt.minLen * 2.0;
      lmax = tt.maxLen * 0.92;
      if (lmax < lmin) { lmin = tt.minLen * 1.05; lmax = tt.maxLen; }
      len = lmin + rnd() * (lmax - lmin);
      if (form === 'tubular') len = clamp(len, 0.6, 8);
      else if (form === 'rod') len = clamp(len, 0.5, 7);
      else if (form === 'cable') len = clamp(len, 1, 10);
      else if (form === 'solid') len = clamp(len, 0.1, 0.7);
      else len = clamp(len, 0.4, 4);
      len = Math.round(len * 10) / 10;

      incl = Math.round(tt.maxIncl * (0.10 + rnd() * 0.80));
      br = rnd();
      bottom = tt.needBottom ? true : (br < 0.68 ? true : (br < 0.92 ? false : null));
      material = tt.material === 'ferro' ? 'ferro' : (rnd() < 0.85 ? 'ferro' : 'non');
      circ = tt.circ ? true : rnd() < 0.86;
      sr = rnd();
      stuck = sr < 0.70 ? 'none' : (sr < 0.85 ? 'sand' : (sr < 0.95 ? 'cement' : 'none'));

      s = {
        form: form, casing: casingIdx, drift: c.drift, od: od, fishBore: f.bore, fishId: fishId,
        len: len, incl: incl, bottom: bottom, circ: circ, material: material, stuck: stuck
      };
      eT = evaluate(tt, s);
      if (eT.out) continue;

      cands = [];
      TOOLS.forEach(function (t) {
        var e = evaluate(t, s);
        if (e.out) return;
        var pT = trueProb(t, e.x);
        var y = rnd() < pT ? 1 : 0;
        cands.push({ toolKey: t.key, x: e.x, pTrue: pT, y: y, base: baseScore(t, s) });
      });
      if (cands.length >= 1) return { s: s, cands: cands };
    }
    return null;
  }

  function buildDataset() {
    seedRnd(20261031);
    var cases = [], c;
    while (cases.length < 640) {
      c = genCase();
      if (c) { c.id = cases.length; cases.push(c); }
    }
    /* 固定种子洗牌，保证每次打开页面的训练/验证划分一致 */
    for (var i = cases.length - 1; i > 0; i--) {
      var j = Math.floor(rnd() * (i + 1));
      var tmp = cases[i]; cases[i] = cases[j]; cases[j] = tmp;
    }
    var train = cases.slice(0, 512), val = cases.slice(512);
    var rows = [];
    train.forEach(function (cc) {
      cc.cands.forEach(function (cand) {
        rows.push({ x: cand.x, y: cand.y, pTrue: cand.pTrue, base: cand.base, caseId: cc.id, toolKey: cand.toolKey });
      });
    });
    return { cases: cases, train: train, val: val, rows: rows };
  }

  /* =========================================================
     5. 逻辑回归训练、温度缩放、验证指标
     ========================================================= */
  function sigmoid(z) {
    if (z >= 0) { var e = Math.exp(-z); return 1 / (1 + e); }
    var e2 = Math.exp(z);
    return e2 / (1 + e2);
  }

  function standardizeRows(rows, mu, sd) {
    return rows.map(function (r) {
      return { y: r.y, z: r.x.map(function (v, j) { return (v - mu[j]) / sd[j]; }) };
    });
  }

  function trainModel(baseRows, onlineRows, opts) {
    opts = opts || {};
    var epochs = opts.epochs || 420;
    var lr = opts.lr || 0.14;
    var l2 = opts.l2 || 0.0015;
    var eps = 0.03;
    var dim = FEATS.length;
    var all = baseRows.concat(onlineRows || []);
    var n = all.length;
    var j, k, r;

    /* 标准化参数只用基础训练集估计，验证/在线样本复用，避免泄漏 */
    var mu = new Array(dim), sd = new Array(dim);
    for (j = 0; j < dim; j++) {
      var sum = 0;
      for (k = 0; k < baseRows.length; k++) sum += baseRows[k].x[j];
      mu[j] = sum / baseRows.length;
      var v = 0;
      for (k = 0; k < baseRows.length; k++) v += Math.pow(baseRows[k].x[j] - mu[j], 2);
      sd[j] = Math.sqrt(v / baseRows.length) || 1;
    }

    var Z = all.map(function (row) {
      return { y: row.y, z: row.x.map(function (val, jj) { return (val - mu[jj]) / sd[jj]; }) };
    });

    var meanY = 0;
    for (k = 0; k < n; k++) meanY += Z[k].y;
    meanY = meanY / n;
    var w = new Array(dim).fill(0);
    var velocity = new Array(dim).fill(0);
    var b = Math.log(Math.max(1e-4, meanY) / Math.max(1e-4, 1 - meanY));
    var hist = [], loss = 0;

    for (var ep = 0; ep < epochs; ep++) {
      var gW = new Array(dim).fill(0), gB = 0;
      loss = 0;
      for (k = 0; k < n; k++) {
        var z = b;
        for (j = 0; j < dim; j++) z += w[j] * Z[k].z[j];
        var p = sigmoid(z);
        var target = Z[k].y ? 1 - eps : eps;
        loss += -(target * Math.log(Math.max(1e-9, p)) + (1 - target) * Math.log(Math.max(1e-9, 1 - p)));
        var d = p - target;
        gB += d;
        for (j = 0; j < dim; j++) gW[j] += d * Z[k].z[j];
      }
      for (j = 0; j < dim; j++) {
        velocity[j] = 0.9 * velocity[j] - lr * (gW[j] / n + l2 * w[j]);
        w[j] += velocity[j];
      }
      b -= lr * gB / n;
      if (ep % 10 === 0) hist.push(loss / n);
    }
    hist.push(loss / n);

    var model = { w: w, b: b, mu: mu, sd: sd, hist: hist, epochs: epochs, T: 1, nTrain: baseRows.length, nOnline: (onlineRows || []).length, deltaW: null };
    model.T = fitTemp(model);
    model.metrics = evalModel(model);
    return model;
  }

  function logitOf(x, model) {
    var z = model.b;
    for (var j = 0; j < FEATS.length; j++) z += model.w[j] * (x[j] - model.mu[j]) / model.sd[j];
    return z;
  }

  function predictP(x, model) {
    model = model || MODEL;
    return sigmoid(logitOf(x, model) / (model.T || 1));
  }

  function fitTemp(model) {
    var bestT = 1, bestNLL = Infinity;
    for (var T = 0.55; T <= 2.55; T += 0.02) {
      var nll = 0;
      for (var i = 0; i < VAL_CASES.length; i++) {
        for (var j = 0; j < VAL_CASES[i].cands.length; j++) {
          var cand = VAL_CASES[i].cands[j];
          var p = clamp(sigmoid(logitOf(cand.x, model) / T), 1e-6, 1 - 1e-6);
          nll += -(cand.y * Math.log(p) + (1 - cand.y) * Math.log(1 - p));
        }
      }
      if (nll < bestNLL) { bestNLL = nll; bestT = T; }
    }
    return bestT;
  }

  function evalModel(model) {
    var n = 0, correct = 0, brier = 0, top1 = 0, baseTop1 = 0;
    var ndcgSum = 0, ndcgN = 0, lowConf = 0, predSum = 0, ySum = 0;
    var conf = [[0, 0], [0, 0]];
    var caseCount = VAL_CASES.length;

    VAL_CASES.forEach(function (cc) {
      var scored = cc.cands.map(function (cand) {
        var p = predictP(cand.x, model);
        var pred = p >= 0.5 ? 1 : 0;
        conf[cand.y][pred]++;
        if (pred === cand.y) correct++;
        brier += Math.pow(p - cand.y, 2);
        if (p >= 0.45 && p < 0.62) lowConf++;
        predSum += p; ySum += cand.y;
        n++;
        return { cand: cand, p: p };
      });

      scored.sort(function (a, b) { return b.p - a.p; });
      if (scored.length && scored[0].cand.y === 1) top1++;

      var byBase = cc.cands.slice().sort(function (a, b) { return b.base - a.base; });
      if (byBase.length && byBase[0].y === 1) baseTop1++;

      var dcg = 0, idcg = 0;
      for (var i = 0; i < Math.min(3, scored.length); i++) dcg += scored[i].cand.y / Math.log2(i + 2);
      var ideal = cc.cands.map(function (c) { return c.y; }).sort(function (a, b) { return b - a; });
      for (var j = 0; j < Math.min(3, ideal.length); j++) idcg += ideal[j] / Math.log2(j + 2);
      if (idcg > 0) { ndcgSum += dcg / idcg; ndcgN++; }
    });

    return {
      n: n, correct: correct, acc: correct / Math.max(1, n), brier: brier / Math.max(1, n),
      top1: top1 / Math.max(1, caseCount), baseTop1: baseTop1 / Math.max(1, caseCount),
      ndcg: ndcgSum / Math.max(1, ndcgN), lowConf: lowConf,
      meanP: predSum / Math.max(1, n), meanY: ySum / Math.max(1, n),
      conf: conf, nTrainRows: BASE_ROWS.length,
      nValRows: n, nValCases: caseCount, nTrainCases: DATASET.train.length
    };
  }

  /* =========================================================
     6. 数据集与初始模型
     ========================================================= */
  var DATASET = buildDataset();
  var TRAIN_CASES = DATASET.train;
  var VAL_CASES = DATASET.val;
  var BASE_ROWS = DATASET.rows;
  MODEL = trainModel(BASE_ROWS, [], { epochs: 420 });

  /* =========================================================
     7. 当前状态 → 候选、排序、分支
     ========================================================= */
  function stateObject() {
    var c = curCasing(), f = FORM_OF(state.form);
    return {
      form: state.form, casing: state.casing, drift: c.drift, od: state.od,
      fishBore: f.bore, fishId: state.fishId, len: state.len, incl: state.incl,
      bottom: state.bottom, circ: state.circ, material: state.material, stuck: state.stuck
    };
  }

  function scoreRows(s) {
    var rows = TOOLS.map(function (t, i) {
      var e = evaluate(t, s);
      var p = e.out ? null : predictP(e.x);
      return { t: t, e: e, p: p, idx: i };
    });
    var usable = rows.filter(function (r) { return !r.e.out; }).sort(function (a, b) { return b.p - a.p; });
    usable.forEach(function (r, i) { r.rank = i + 1; });
    return { rows: rows, usable: usable, best: usable[0] || null, alt: usable[1] || null };
  }

  function bestFor(s) {
    var arr = TOOLS.map(function (t) { return { t: t, e: evaluate(t, s) }; })
      .filter(function (r) { return !r.e.out; });
    arr.forEach(function (r) { r.p = predictP(r.e.x); });
    arr.sort(function (a, b) { return b.p - a.p; });
    return arr[0] || null;
  }

  function compute() {
    var s = stateObject();
    var sc = scoreRows(s);
    var branches = null;
    if (state.bottom === null) {
      var sa = clone(s); sa.bottom = true;
      var sb = clone(s); sb.bottom = false;
      branches = { a: bestFor(sa), b: bestFor(sb) };
    }
    LAST = { s: s, rows: sc.rows, usable: sc.usable, best: sc.best, alt: sc.alt, branches: branches, c: curCasing(), f: FORM_OF(state.form) };
    return LAST;
  }

  function tripText(best) {
    if (!best) return '—';
    if (best.p >= 0.82) return '1 趟（预计）';
    if (best.p >= 0.65) return '1—2 趟';
    return '2—3 趟';
  }

  function specLine(t) {
    return '外径 ' + t.od + ' mm · ' + (t.bore ? '内孔 ' + t.bore + ' mm' : '无内孔') + ' · ' +
      t.sizeLabel + ' ' + t.dmin + '—' + t.dmax + ' mm · 咬合 ≥' + t.minLen + ' m / 容纳 ≤' + t.maxLen + ' m · ' +
      '最大井斜 ' + t.maxIncl + '° · 需循环 ' + (t.circ ? '是' : '否') + ' · 需落底 ' + (t.needBottom ? '是' : '否') +
      ' · 历史成功率 ' + Math.round(succNow(t) * 100) + '%';
  }

  function contribs(row) {
    if (!row || row.e.out) return [];
    var z = row.e.x.map(function (v, j) { return (v - MODEL.mu[j]) / MODEL.sd[j]; });
    return FEATS.map(function (f, j) {
      return { key: f.key, label: f.label, w: MODEL.w[j], z: z[j], v: MODEL.w[j] * z[j] };
    });
  }

  /* =========================================================
     8. 描述解析
     ========================================================= */
  function parseDescription(text) {
    var t = String(text || '').replace(/[，,]/g, '，').replace(/[；;]/g, '；').replace(/[：:]/g, '：');
    var f = {}, m;

    if (/5\s*[-–—]?\s*1\s*\/\s*2/.test(t)) f.casing = /23\s*#/.test(t) ? 1 : 0;
    else if (/(?:^|\s)7\s*(?:"|”|in|英寸|#)/i.test(t)) f.casing = 2;

    if (/电缆|钢丝绳|钢丝|柔索/.test(t)) f.form = 'cable';
    else if (/抽油杆|杆体|加重杆/.test(t)) f.form = 'rod';
    else if (/钢球|牙轮|铁屑|碎屑|小件/.test(t)) f.form = 'solid';
    else if (/扶正器|井下工具|工具串|钻头|大直径/.test(t)) f.form = 'toolbig';
    else if (/油管|钻杆|套管|管状|管体/.test(t)) f.form = 'tubular';

    if ((m = /(?:外径|直径)\s*[:：]?\s*(\d+(?:\.\d+)?)/.exec(t)) || (m = /[∅Φφ]\s*(\d+(?:\.\d+)?)/.exec(t))) f.od = Number(m[1]);
    else if ((m = /(\d+(?:\.\d+)?)\s*(?:mm|毫米)\s*(?:的)?\s*(?:油管|抽油杆|电缆|钢球|工具|落物)/.exec(t))) f.od = Number(m[1]);

    if ((m = /内径\s*[:：]?\s*(\d+(?:\.\d+)?)/.exec(t)) || (m = /\bID\s*[:：]?\s*(\d+(?:\.\d+)?)/i.exec(t))) f.fishId = Number(m[1]);

    if ((m = /(?:长度|长约|长为|长)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(mm|毫米|m|米)/.exec(t))) {
      f.len = Number(m[1]) * ((/mm|毫米/.test(m[2])) ? 0.001 : 1);
    }

    if ((m = /井斜\s*[:：]?\s*(\d+(?:\.\d+)?)/.exec(t)) || (m = /(\d+(?:\.\d+)?)\s*°/.exec(t))) f.incl = Number(m[1]);

    if (/落底(?:状态)?\s*[:：]?\s*(?:未知|不明)|未确认落底|是否落底未知|落底情况不明/.test(t)) f.bottom = null;
    else if (/未落底|悬空|没有落底/.test(t)) f.bottom = false;
    else if (/已落底|落在井底|落底/.test(t)) f.bottom = true;

    if (/非铁磁|非磁性|无磁性|不锈钢|铝|铜/.test(t)) f.material = 'non';
    else if (/铁磁|磁性|碳钢|钢|铁/.test(t)) f.material = 'ferro';

    if (/未卡阻|无卡阻|不卡|没有卡阻/.test(t)) f.stuck = 'none';
    else if (/被埋|埋住|砂埋|埋没/.test(t)) f.stuck = 'buried';
    else if (/水泥卡|水泥环|水泥/.test(t)) f.stuck = 'cement';
    else if (/砂卡|出砂|砂桥/.test(t)) f.stuck = 'sand';

    if (/不可循环|不能循环|无法循环|无循环|不循环/.test(t)) f.circ = false;
    else if (/可循环|能循环|循环洗井|正循环|反循环|循环/.test(t)) f.circ = true;

    return { fields: f, count: Object.keys(f).length };
  }

  function applyParsed(res, silent) {
    var f = res.fields;
    state.src = freshSrc();
    if (Object.prototype.hasOwnProperty.call(f, 'casing')) { state.casing = f.casing; state.src.casing = true; }
    if (Object.prototype.hasOwnProperty.call(f, 'form')) { state.form = f.form; state.src.form = true; }
    if (Object.prototype.hasOwnProperty.call(f, 'od')) { state.od = Math.round(f.od); state.src.od = true; }
    if (Object.prototype.hasOwnProperty.call(f, 'fishId')) { state.fishId = Math.round(f.fishId); state.src.fishId = true; }
    if (Object.prototype.hasOwnProperty.call(f, 'len')) { state.len = Math.round(f.len * 10) / 10; state.src.len = true; }
    if (Object.prototype.hasOwnProperty.call(f, 'incl')) { state.incl = Math.round(f.incl); state.src.incl = true; }
    if (Object.prototype.hasOwnProperty.call(f, 'bottom')) { state.bottom = f.bottom; state.src.bottom = true; }
    if (Object.prototype.hasOwnProperty.call(f, 'material')) { state.material = f.material; state.src.material = true; }
    if (Object.prototype.hasOwnProperty.call(f, 'stuck')) { state.stuck = f.stuck; state.src.stuck = true; }
    if (Object.prototype.hasOwnProperty.call(f, 'circ')) { state.circ = f.circ; state.src.circ = true; }

    syncControls();
    renderAll();
    el('parse-note').textContent = '识别 ' + res.count + ' / 10 字段' + (res.count < 10 ? ' · 其余沿用当前值' : ' · 全部字段来自描述');
    if (!silent) {
      trace('01', '解析现场描述：识别 <b>' + res.count + '/10</b> 字段 · 形态 <b>' + FORM_OF(state.form).name +
        '</b> · 外径 <b>' + state.od + ' mm</b> · 落底 <b>' + (state.bottom === true ? '已落底' : (state.bottom === false ? '悬空' : '未知')) + '</b>',
        res.count >= 7 ? 'ok' : 'warn');
    }
  }

  /* =========================================================
     9. 工具构造示意 / 井筒剖面（沿用原实现，按学习排序结果调整）
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

  function drawSchematic(best) {
    var c = curCasing();
    var PX = 0.66;
    var CX = 144, TOP = 62, BOT = 392, CY = 50;
    var vis = state.incl * 0.45;
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
      else toolBottom = Math.min(BOT - 4, fishTop + overlap);
      toolTop = Math.max(TOP + 20, toolBottom - 64);
    }

    function rp(x, y) {
      var dx = x - CX, dy = y - CY;
      return {
        x: CX + dx * Math.cos(a) - dy * Math.sin(a) + shiftX,
        y: CY + dx * Math.sin(a) + dy * Math.cos(a)
      };
    }

    var sinA = Math.sin(a), cosA = Math.cos(a);
    var xLeftBottom = CX - (half + wall) * cosA - (BOT - CY) * sinA;
    var shiftX = Math.max(0, 8 - xLeftBottom);

    var s = '<g transform="translate(' + shiftX.toFixed(1) + ',0) rotate(' + vis.toFixed(2) + ',' + CX + ',' + CY + ')">';
    s += '<rect x="' + (CX - half - wall) + '" y="' + TOP + '" width="' + wall + '" height="' + (BOT - TOP) + '" fill="#f0ede4" stroke="#d3c9b6"/>';
    s += '<rect x="' + (CX + half) + '" y="' + TOP + '" width="' + wall + '" height="' + (BOT - TOP) + '" fill="#f0ede4" stroke="#d3c9b6"/>';
    s += '<rect x="' + (CX - half - wall - 8) + '" y="' + (TOP - 12) + '" width="' + (2 * (half + wall) + 16) + '" height="12" rx="3" fill="#e3dccd" stroke="#d3c9b6"/>';
    s += '<rect x="' + (CX - half) + '" y="' + BOT + '" width="' + (2 * half) + '" height="6" fill="#e3dccd" stroke="#d3c9b6"/>';

    s += '<rect x="' + (CX - fishW / 2) + '" y="' + fishTop + '" width="' + fishW + '" height="' + fishH + '" rx="2" fill="#f5e6e1" stroke="#a64b3c" stroke-width="1.4"' + (dashed ? ' stroke-dasharray="4 3"' : '') + '/>';
    if (state.form === 'cable') {
      s += '<path d="M' + (CX - fishW / 2 + 2) + ' ' + (fishTop + 4) + ' q' + (fishW / 2) + ' 6 0 12 q' + (-fishW / 2) + ' 6 0 12" fill="none" stroke="#a64b3c" stroke-width="1" opacity=".7"/>';
    }

    if (best) s += toolGlyph(best.t, toolTop, toolBottom, toolW);
    s += '</g>';

    var pFish = rp(CX + half + wall + 6, fishTop + 10);
    s += '<text x="' + pFish.x.toFixed(1) + '" y="' + pFish.y.toFixed(1) + '" font-size="9" fill="#a64b3c" text-anchor="start">落物 ' + state.od + ' mm</text>';
    s += '<text x="' + pFish.x.toFixed(1) + '" y="' + (pFish.y + 12).toFixed(1) + '" font-size="8.5" fill="#a64b3c" text-anchor="start">' + fmt1(state.len) + ' m · ' + (state.bottom === true ? '已落底' : (state.bottom === false ? '悬空' : '落底未知')) + '</text>';

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
    } else {
      var pNone = rp(CX, TOP + 30);
      s += '<text x="' + pNone.x.toFixed(1) + '" y="' + pNone.y.toFixed(1) + '" font-size="9" fill="#a64b3c" text-anchor="middle">0 件可行工具</text>';
      s += '<text x="' + pNone.x.toFixed(1) + '" y="' + (pNone.y + 12).toFixed(1) + '" font-size="8" fill="#a64b3c" text-anchor="middle">先走套铣 / 磨铣工序</text>';
    }

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
     10. 各阶段渲染
     ========================================================= */
  function renderAll() {
    var L = compute();
    renderHeader(L);
    renderMatrix(L);
    drawSchematic(L.best);
    renderToolArt(L);
    renderStage0(L);
    renderStage1(L);
    renderStage2(L);
    renderStage3(L);
    renderStage4(L);
    renderModelBox();
    renderNote(L);
  }

  function renderHeader(L) {
    el('st-tool').textContent = L.best
      ? (L.best.t.name + (state.bottom === null && L.best.t.needBottom ? '（条件）' : ''))
      : (state.stuck === 'buried' ? '需先清障' : '无可行工具');
    el('st-prob').innerHTML = L.best ? (L.best.p * 100).toFixed(0) + '<small>%</small>' : '—';
    el('st-top1').innerHTML = (MODEL.metrics.top1 * 100).toFixed(1) + '<small>%</small>';
    el('st-excl').innerHTML = (TOOLS.length - L.usable.length) + ' <small>/ ' + TOOLS.length + ' 件</small>';
  }

  function renderToolArt(L) {
    var row = state.focus ? findRow(L, state.focus) : L.best;
    var t = row ? row.t : null;
    el('art-hint').textContent = t ? t.name : '—';
    el('toolart').innerHTML = t ? toolArt(t.key) : '';
    if (!t) {
      el('art-note').textContent = '当前没有通过硬约束的打捞工具。系统不会为了给出答案而显示物理不可行的工具，应先走套铣/磨铣工序清障。';
    } else {
      el('art-note').textContent = t.note + (row.e.out ? '（当前硬约束下不可用）' : '（当前 p=' + (row.p * 100).toFixed(1) + '%）');
    }
  }

  function findRow(L, key) {
    for (var i = 0; i < L.rows.length; i++) if (L.rows[i].t.key === key) return L.rows[i];
    return null;
  }

  function renderMatrix(L) {
    var order = L.rows.slice().sort(function (a, b) {
      if (a.e.out !== b.e.out) return a.e.out ? 1 : -1;
      if (!a.e.out) return b.p - a.p;
      return a.idx - b.idx;
    });
    var head = '<table class="mx"><colgroup><col style="width:18px"><col style="width:96px"><col style="width:30px"><col style="width:74px">' +
      '<col style="width:36px"><col style="width:36px"><col style="width:36px"><col style="width:36px"><col style="width:36px">' +
      '<col style="width:38px"><col style="width:34px"><col style="width:52px"></colgroup><thead><tr>' +
      '<th>#</th><th>工具</th><th>外径</th><th>可捞区间</th>' +
      FORMS.map(function (f) {
        return '<th class="cf' + (f.key === state.form ? ' cur' : '') + '" data-form="' + f.key + '" title="点击按「' + f.name + '」重算">' + f.name.replace('体', '').replace('类', '').replace('小件', '').replace('大直径工具', '大件') + '</th>';
      }).join('') +
      '<th>历史</th><th>p</th><th>状态</th></tr></thead><tbody>';

    var body = order.map(function (r) {
      var t = r.t, e = r.e;
      var cls = 'toolrow' + (L.best && L.best.t.key === t.key ? ' best' : '') + (state.focus === t.key ? ' focus' : '');
      var rank = e.out ? '—' : r.rank;
      var range = (t.basis === 'id' ? '内径 ' : '外径 ') + t.dmin + '—' + t.dmax;
      var cells = FORMS.map(function (f) {
        var aff = t.form[f.key] || 0;
        var txt = f.key === state.form ? String(Math.round(aff * 100)) : (aff >= 0.4 ? String(Math.round(aff * 100)) : '');
        var alpha = 0.05 + aff * 0.72;
        var bg = e.out ? 'rgba(153,163,164,.08)' : 'rgba(36,92,90,' + alpha.toFixed(2) + ')';
        var fg = !e.out && aff > 0.55 ? '#fff' : 'var(--ink-4)';
        return '<td class="cell' + (f.key === state.form ? ' cur' : '') + '" title="' + esc(t.name + ' × ' + f.name + '：形态适用度 ' + Math.round(aff * 100) + '%' + (e.out ? '（当前不可用：' + e.why + '）' : '')) + '">' +
          '<i style="background:' + bg + ';color:' + fg + '">' + (e.out ? '×' : txt) + '</i></td>';
      }).join('');
      var st;
      if (e.out) st = '<span class="st no">排除</span>';
      else if (L.best && L.best.t.key === t.key) st = '<span class="st ok">首选</span>';
      else if (L.alt && L.alt.t.key === t.key) st = '<span class="st ok">备选</span>';
      else if (state.bottom === null && t.needBottom) st = '<span class="st cond">条件</span>';
      else st = '<span class="st">可用</span>';
      var hist = Math.round(succNow(t) * 100) + '%' + (FB.byTool[t.key] ? ' *' : '');
      return '<tr class="' + cls + '" data-tool="' + t.key + '" title="' + esc(t.name + '｜' + specLine(t) + (e.out ? '｜不可用：' + e.why : '')) + '">' +
        '<td class="num" style="text-align:center">' + rank + '</td>' +
        '<td class="tn">' + t.name + '</td>' +
        '<td class="num">' + t.od + '</td>' +
        '<td class="num">' + range + '</td>' +
        cells +
        '<td class="num">' + hist + '</td>' +
        '<td class="num">' + (e.out ? '—' : (r.p * 100).toFixed(0) + '%') + '</td>' +
        '<td>' + st + '</td></tr>';
    }).join('');

    el('rank').innerHTML = head + body + '</tbody></table>';
    el('rank-hint').textContent = L.usable.length + ' 件可用 / ' + (TOOLS.length - L.usable.length) + ' 件排除 · 按学习排序 p 排列';

    var focusRow = state.focus ? findRow(L, state.focus) : L.best;
    if (!focusRow) {
      el('tool-detail').innerHTML = '<b>当前没有可行工具。</b> 硬约束已排除全部直接打捞工具；请先走套铣/磨铣工序。';
      return;
    }
    var tt = focusRow.t, ee = focusRow.e;
    var html = '<b>' + tt.name + '</b>' + (state.focus ? '（点击选中）' : '（默认首选）') +
      ' · <span class="mono">' + specLine(tt) + '</span><br>' + esc(tt.note);
    if (ee.out) {
      html += '<br><span class="why">不可用：' + esc(ee.why) + '</span>';
    } else {
      var cs = contribs(focusRow).slice().sort(function (a, b) { return Math.abs(b.v) - Math.abs(a.v); });
      html += '<br><span class="ok">当前 p=' + (focusRow.p * 100).toFixed(1) + '%</span> · 贡献前三：' +
        cs.slice(0, 3).map(function (c) { return c.label + ' ' + (c.v >= 0 ? '+' : '') + c.v.toFixed(2); }).join(' · ');
    }
    el('tool-detail').innerHTML = html;
  }

  function renderStage0(L) {
    var f = L.f;
    var rows = [
      ['形态', f.name + '（' + f.desc + '）', 'form'],
      ['外径', state.od + ' mm', 'od'],
      ['内径', f.bore ? (state.fishId > 0 ? state.fishId + ' mm' : '未给出') : '无内孔（形态推定）', 'fishId'],
      ['长度', fmt1(state.len) + ' m', 'len'],
      ['井斜', state.incl + '°', 'incl'],
      ['落底', state.bottom === true ? '已落底' : (state.bottom === false ? '悬空' : '未知'), 'bottom'],
      ['材质', state.material === 'ferro' ? '铁磁性' : '非铁磁性', 'material'],
      ['卡阻', stuckName(state.stuck), 'stuck'],
      ['循环', state.circ ? '可循环洗井' : '不可循环', 'circ'],
      ['套管', L.c.label + ' · 通径 ' + fmt1(L.c.drift) + ' mm', 'casing']
    ];
    el('fields').innerHTML = rows.map(function (r) {
      var parsed = state.src[r[2]];
      var srcTxt = parsed ? '解析' : '手工/沿用';
      var srcCls = parsed ? 'parsed' : 'manual';
      if (r[2] === 'fishId' && !f.bore) { srcTxt = '形态推定'; srcCls = 'manual'; }
      return '<div class="fieldrow"><span class="fk">' + r[0] + '</span><span class="fv"><b>' + esc(r[1]) + '</b></span>' +
        '<span class="fs ' + srcCls + '">' + srcTxt + '</span></div>';
    }).join('');

    var issues = [];
    if (state.bottom === null) issues.push(['warn', '落底未知：需先铅印确认鱼顶，方案保留落底 / 悬空两分支']);
    if (f.bore && state.fishId <= 0) issues.push(['bad', '内径未给出：公锥 / 捞矛无法校核，会被硬约束排除']);
    if (state.stuck === 'buried') issues.push(['bad', '落物被埋：鱼顶不可达，直接打捞全部排除']);
    if (state.stuck === 'sand' || state.stuck === 'cement') issues.push(['warn', '卡阻：工具串加震击器 + 安全接头，先套铣 / 磨铣再捞']);
    if (state.od > L.c.drift - 12) issues.push(['warn', '落物外径 ' + state.od + ' mm 已超过工具外径上限 ' + fmt1(L.c.drift - 12) + ' mm：直接打捞候选可能为 0']);
    if (!state.circ) issues.push(['warn', '不可循环：篮式捞筒 / 套铣 / 磨铣工序不可用']);
    if (state.material !== 'ferro') issues.push(['warn', '非铁磁性：磁力打捞器全部排除']);
    if (!issues.length) issues.push(['ok', '字段完整，可进入约束推理']);
    el('quality').innerHTML = '<b>质控：</b>' + issues.map(function (x) {
      return '<span class="' + (x[0] === 'ok' ? '' : x[0]) + '">' + x[1] + '</span>';
    }).join('；') + '。';
  }

  function gateValue(key, L) {
    var c = L.c, f = L.f;
    if (key === 'reach') return '卡阻：' + stuckName(state.stuck);
    if (key === 'drift') return '工具外径 ≤ 通径 ' + fmt1(c.drift) + ' − 12 = ' + fmt1(c.drift - 12) + ' mm';
    if (key === 'size') return '落物外径 ' + state.od + ' mm' + (f.bore ? ' · 内径 ' + (state.fishId || '未给出') + ' mm' : '');
    if (key === 'material') return '落物：' + (state.material === 'ferro' ? '铁磁性' : '非铁磁性');
    if (key === 'incl') return '井斜 ' + state.incl + '°';
    if (key === 'circ') return '本井' + (state.circ ? '可循环' : '不可循环');
    if (key === 'bottom') return '落底：' + (state.bottom === true ? '已落底' : (state.bottom === false ? '悬空' : '未知'));
    return '落物长度 ' + fmt1(state.len) + ' m';
  }

  function renderStage1(L) {
    var gates = [
      { key: 'reach', label: '鱼顶可达' },
      { key: 'drift', label: '通径 / 单边间隙' },
      { key: 'size', label: '可捞区间' },
      { key: 'material', label: '材质' },
      { key: 'incl', label: '井斜' },
      { key: 'circ', label: '循环' },
      { key: 'bottom', label: '落底' },
      { key: 'length', label: '咬合长度' }
    ];
    var alive = TOOLS.slice();
    var html = '';
    gates.forEach(function (g, i) {
      var before = alive.length;
      alive = alive.filter(function (t) {
        var row = findRow(L, t.key);
        var gate = null;
        for (var k = 0; k < row.e.gates.length; k++) if (row.e.gates[k].key === g.key) gate = row.e.gates[k];
        return gate && gate.ok;
      });
      var cut = before - alive.length;
      var pct = alive.length / TOOLS.length * 100;
      html += '<div class="gaterow">' +
        '<span class="gi">' + (i + 1) + '</span>' +
        '<span class="gt"><b>' + g.label + '</b><em>' + esc(gateValue(g.key, L)) + '</em></span>' +
        '<span class="gv ' + (cut ? 'no' : 'ok') + '">' + alive.length + ' / ' + TOOLS.length + (cut ? ' · −' + cut : '') + '</span>' +
        '<span class="gbar"><i class="' + (cut ? 'no' : '') + '" style="width:' + pct.toFixed(1) + '%"></i></span>' +
        '</div>';
    });
    el('gates').innerHTML = html;

    var ex = L.rows.filter(function (r) { return r.e.out; });
    if (!ex.length) {
      el('excluded').innerHTML = '<div class="plain-note">本轮没有工具被硬约束排除；' + L.usable.length + ' 件工具进入学习排序。</div>';
    } else {
      el('excluded').innerHTML = ex.map(function (r) {
        return '<div class="exrow"><span class="en">' + r.t.name + '</span><span class="er">' + esc(r.e.why) + '</span></div>';
      }).join('');
    }
  }

  function renderStage2(L) {
    var m = MODEL.metrics;
    el('m-n').textContent = m.nTrainCases + ' / ' + m.nValCases + ' 例';
    el('m-acc').textContent = (m.acc * 100).toFixed(1) + '%';
    el('m-top1').textContent = (m.top1 * 100).toFixed(1) + '%';
    el('m-ndcg').textContent = m.ndcg.toFixed(3);
    drawCurve();
    drawCM();
    drawWeights();
    drawProbs(L);
    drawParts(L);
  }

  function drawCurve() {
    var svg = el('curve');
    if (!svg) return;
    var W = 320, H = 78, L = 28, R = 6, T = 6, B = 14;
    var hist = MODEL.hist;
    var lo = Math.min.apply(null, hist), hi = Math.max.apply(null, hist);
    var pad = (hi - lo) * 0.16 || 0.01;
    lo = Math.max(0, lo - pad); hi += pad;
    function X(i) { return L + i * (W - L - R) / Math.max(1, hist.length - 1); }
    function Y(v) { return T + (1 - (v - lo) / (hi - lo)) * (H - T - B); }
    var s = '';
    [0, 0.5, 1].forEach(function (t) {
      var v = lo + (hi - lo) * t, y = Y(v);
      s += '<line x1="' + L + '" y1="' + y + '" x2="' + (W - R) + '" y2="' + y + '" stroke="#efece1"/>' +
        '<text x="' + (L - 3) + '" y="' + (y + 3) + '" text-anchor="end" font-size="7.5" font-family="monospace" fill="#99a3a4">' + v.toFixed(2) + '</text>';
    });
    var d = hist.map(function (v, i) { return (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1); }).join('');
    s += '<path d="' + d + '" fill="none" stroke="#1d4e50" stroke-width="1.8"/>';
    s += '<text x="' + (W - R) + '" y="' + (H - 2) + '" text-anchor="end" font-size="7.5" font-family="monospace" fill="#99a3a4">' + MODEL.epochs + ' 轮</text>';
    s += '<text x="' + L + '" y="' + (H - 2) + '" font-size="7.5" font-family="monospace" fill="#99a3a4">0</text>';
    svg.innerHTML = s;
  }

  function drawCM() {
    var conf = MODEL.metrics.conf;
    var total = conf[0][0] + conf[0][1] + conf[1][0] + conf[1][1] || 1;
    function cell(count, good, label) {
      var q = count / total;
      var bg = good ? 'rgba(36,92,90,' + (0.12 + q * 0.68).toFixed(2) + ')' : 'rgba(166,75,60,' + (0.10 + q * 0.55).toFixed(2) + ')';
      var fg = q > 0.18 ? '#fff' : 'var(--ink-3)';
      return '<i style="background:' + bg + ';color:' + fg + '" title="' + label + ' ' + count + ' 行（' + (q * 100).toFixed(1) + '%）">' + count + '</i>';
    }
    el('cm').innerHTML =
      '<span class="lb">实际↓ / 预测→</span><span class="lb" style="text-align:center">成功</span><span class="lb" style="text-align:center">失败</span>' +
      '<span class="lb">成功</span>' + cell(conf[1][1], true, '真阳性') + cell(conf[1][0], false, '假阴性') +
      '<span class="lb">失败</span>' + cell(conf[0][1], false, '假阳性') + cell(conf[0][0], true, '真阴性');
    el('cm-note').innerHTML = 'Brier <b>' + MODEL.metrics.brier.toFixed(3) + '</b> · 温度 T <b>' + MODEL.T.toFixed(2) +
      '</b> · 预测均值 ' + (MODEL.metrics.meanP * 100).toFixed(1) + '% vs 实际 ' + (MODEL.metrics.meanY * 100).toFixed(1) +
      '% · 低置信 ' + MODEL.metrics.lowConf + ' 行<br>主要错误：实际失败被判成功 <b>' + conf[0][1] +
      '</b> 行（假阳性），所以方案必须保留备选与人工复核，不能把 p 当现场结论。';
  }

  function drawWeights() {
    var rows = FEATS.map(function (f, j) { return { label: f.label, v: MODEL.w[j], hint: f.hint }; });
    rows.sort(function (a, b) { return Math.abs(b.v) - Math.abs(a.v); });
    var max = Math.max.apply(null, rows.map(function (r) { return Math.abs(r.v); })) || 1;
    el('weights').innerHTML = '<div class="wgrid">' + rows.map(function (r) {
      var pos = r.v >= 0;
      var w = Math.abs(r.v) / max * 100;
      return '<div class="wcell" title="' + esc(r.hint) + '"><span class="lb">' + r.label + '</span><span class="track"><i style="' +
        (pos ? 'left:0' : 'right:0') + ';width:' + w.toFixed(1) + '%;background:' + (pos ? 'var(--jade)' : 'var(--bad)') + '"></i></span>' +
        '<span class="val">' + (pos ? '+' : '') + r.v.toFixed(2) + '</span></div>';
    }).join('') + '</div><p class="plain-note" style="margin-top:3px">标准化后权重；绿 = 推高成功概率，红 = 拉低。硬约束已先行过滤，权重不能把被排除的工具拉回候选。</p>';
  }

  function drawProbs(L) {
    if (!L.usable.length) {
      el('probs').innerHTML = '<p class="plain-note">0 件候选：学习排序没有输入，硬约束已经把直接打捞全部排除。</p>';
      return;
    }
    el('probs').innerHTML = L.usable.slice(0, 3).map(function (r, i) {
      return '<div class="dbar" style="padding:2.5px 0"><span style="width:74px;font-size:10px;color:' + (i === 0 ? 'var(--ink)' : 'var(--ink-3)') + '">' + r.t.name + '</span>' +
        '<span class="track"><i style="width:' + (r.p * 100).toFixed(1) + '%;background:' + (i === 0 ? 'var(--jade)' : 'var(--line-3)') + '"></i></span>' +
        '<span class="val">' + (r.p * 100).toFixed(0) + '%</span></div>';
    }).join('');
  }

  function drawParts(L) {
    if (!L.best) {
      el('parts').innerHTML = '<p class="plain-note">没有可用候选，无法计算特征贡献。</p>';
      return;
    }
    var cs = contribs(L.best).slice().sort(function (a, b) { return Math.abs(b.v) - Math.abs(a.v); });
    var max = Math.max.apply(null, cs.map(function (c) { return Math.abs(c.v); })) || 1;
    var sum = cs.reduce(function (a, c) { return a + c.v; }, 0) + MODEL.b;
    el('parts').innerHTML = '<div class="wgrid">' + cs.map(function (c) {
      var pos = c.v >= 0;
      var w = Math.abs(c.v) / max * 100;
      return '<div class="wcell" title="w=' + c.w.toFixed(3) + '，标准化特征 z=' + c.z.toFixed(2) + '"><span class="lb">' + c.label + '</span>' +
        '<span class="track"><i style="' + (pos ? 'left:0' : 'right:0') + ';width:' + w.toFixed(1) + '%;background:' + (pos ? 'var(--jade)' : 'var(--bad)') + '"></i></span>' +
        '<span class="val">' + (pos ? '+' : '') + c.v.toFixed(2) + '</span></div>';
    }).join('') + '</div><div class="cmnote">logit = b + Σw·z = ' + sum.toFixed(2) + ' → p = ' + (L.best.p * 100).toFixed(1) + '%（温度 T=' + MODEL.T.toFixed(2) + '）</div>';
  }

  function renderStage3(L) {
    renderPlan(L);
    renderRisks(L);
    renderOrders(L);
    renderPrep(L);
  }

  function planWhy(row, L) {
    var t = row.t, s = L.s;
    var cs = contribs(row).slice().sort(function (a, b) { return Math.abs(b.v) - Math.abs(a.v); });
    var top = cs.slice(0, 2).map(function (c) { return c.label + '（' + (c.v >= 0 ? '+' : '') + c.v.toFixed(2) + '）'; }).join('、');
    var sizeTxt = t.basis === 'id'
      ? '落物内径 ' + s.fishId + ' mm 在 ' + t.dmin + '—' + t.dmax + ' mm 内'
      : '落物外径 ' + s.od + ' mm 在 ' + t.dmin + '—' + t.dmax + ' mm 内';
    var lenTxt = '长度 ' + fmt1(s.len) + ' m ' + (s.len >= t.minLen ? '≥' : '<') + ' 最小咬合 ' + fmt1(t.minLen) + ' m';
    var reachTxt = s.bottom === null && t.needBottom ? '落底未知，按条件推荐，需先铅印' : ('井斜 ' + s.incl + '° 在允许 ' + t.maxIncl + '° 内');
    var comp = compScoreOf(t, s);
    var compTxt = '工序复杂度' + (comp >= 0.8 ? '低' : (comp >= 0.55 ? '中' : '高'));
    return '模型给它的成功概率 <b>' + (row.p * 100).toFixed(1) + '%</b>；' + sizeTxt + '，' + lenTxt + '，' + reachTxt +
      '，历史成功率 <b>' + Math.round(succNow(t) * 100) + '%</b>，' + compTxt + '。贡献最大的两项：' + top + '。';
  }

  function renderPlan(L) {
    var html;
    if (L.best) {
      html = '<div class="plan"><div class="plan-h"><span class="db ok">主工具</span><b>' + L.best.t.name + '</b>' +
        '<span class="mono">p ' + (L.best.p * 100).toFixed(1) + '%</span></div>' +
        '<div class="plan-spec">' + esc(specLine(L.best.t)) + '</div>' +
        '<div class="plan-why">' + planWhy(L.best, L) + '</div></div>';
      if (L.alt) {
        html += '<div class="plan alt"><div class="plan-h"><span class="db plain">备选</span><b>' + L.alt.t.name + '</b>' +
          '<span class="mono">p ' + (L.alt.p * 100).toFixed(1) + '%</span></div>' +
          '<div class="plan-spec">' + esc(specLine(L.alt.t)) + '</div>' +
          '<div class="plan-why">首选抓空或咬合失败时第二趟直接换它；差距 ' + ((L.best.p - L.alt.p) * 100).toFixed(1) + ' pts。' +
          (L.best.p - L.alt.p < 0.08 ? ' <b>差距较小，必须保留人工复核。</b>' : '') + '</div></div>';
      } else {
        html += '<div class="plan alt"><div class="plan-h"><span class="db warn">备选</span><b>无第二候选</b></div>' +
          '<div class="plan-why">硬约束后只剩一件工具。若首选失败，不要临时找同规格替代，转套铣/磨铣或人工评估。</div></div>';
      }
    } else {
      html = '<div class="plan" style="border-color:var(--bad)"><div class="plan-h"><span class="db bad">0 候选</span><b>直接打捞不可行</b></div>' +
        '<div class="plan-why">当前落物/井况下没有任何打捞工具通过硬约束。系统不会为了给出答案而推荐物理不可行项；方案转为<b>套铣 / 磨铣 / 清屑</b>工序，清障后重新解析落物。</div></div>';
    }
    el('plan-main').innerHTML = html;
  }

  function renderRisks(L) {
    var risks = [];
    if (L.best) {
      if (L.best.p < 0.65) risks.push(['bad', '首选 p=' + (L.best.p * 100).toFixed(0) + '% < 65%：先人工复核，不要直接下工具']);
      if (L.alt && L.best.p - L.alt.p < 0.08) risks.push(['warn', '首选与备选差距仅 ' + ((L.best.p - L.alt.p) * 100).toFixed(1) + ' pts：按并列处理，先打印/复核']);
      if (state.bottom === null) risks.push(['warn', '落底未知：先铅印确认鱼顶，按落底/悬空两分支准备工具']);
      if (state.stuck === 'sand' || state.stuck === 'cement') risks.push(['warn', '卡阻：工具串加震击器 + 安全接头；' + (state.stuck === 'sand' ? '先用套铣筒清洗砂桥' : '先套铣/磨铣水泥环') + '，不要硬提']);
      if (state.material !== 'ferro') risks.push(['warn', '非铁磁性：磁力打捞器已全部排除，不能靠吸附']);
      if (!state.circ) risks.push(['warn', '不可循环：篮式捞筒/套铣/磨铣不可用，需先恢复循环']);
    } else {
      risks.push(['bad', '0 件可行工具：鱼顶可能不可达或尺寸/井斜/循环条件不满足，先清障']);
    }
    if (state.stuck === 'buried') risks.push(['bad', '落物被埋：鱼顶不可达，直接打捞全部排除']);
    if (state.od > L.c.drift - 14) risks.push(['warn', '落物外径接近通径上限，工具外径余量很小，下入前复核通径']);
    if (!risks.length) risks.push(['ok', '硬约束全部通过；按主工具 + 备选执行，首趟后按实际咬合情况调整']);

    el('risks').innerHTML = risks.map(function (r) {
      return '<div class="riskline"><span class="' + (r[0] === 'ok' ? 'ok' : r[0]) + '">●</span> ' + r[1] + '</div>';
    }).join('');
  }

  function renderOrders(L) {
    var o = [];
    var stuck = state.stuck;
    var limit = L.c.drift - 2 * CLEARANCE;
    var washWarn = PREP[0].od > limit ? ' <b>套铣筒 108 mm 超过本井上限 ' + fmt1(limit) + ' mm，需换小一级。</b>' : '';
    var basketWarn = PREP[2].od > limit ? ' <b>篮式筒 108 mm 超过本井上限 ' + fmt1(limit) + ' mm，需换小一级或改用反循环。</b>' : '';
    var circWarn = state.circ ? '' : ' <b>本井不可循环</b>，套铣/磨铣/篮式清屑工序不可用，需先恢复循环或改用机械清障。';

    if (state.bottom === null) {
      o.push('<b>先打印（铅印）确认鱼顶</b>：落物是否落底、鱼顶是否规则、是否被砂埋。不要用通井规探底代替打印。');
      o.push('<b>分支 A · 若已落底</b>：' + (L.branches.a
        ? '首选 <b>' + L.branches.a.t.name + '</b>（p ' + (L.branches.a.p * 100).toFixed(0) + '%）；' + L.branches.a.t.op
        : '无工具通过硬约束，先评估套铣/磨铣。'));
      if (L.branches.b && L.branches.a && L.branches.b.t.key === L.branches.a.t.key) {
        o.push('<b>分支 B · 若悬空</b>：首选同为 <b>' + L.branches.b.t.name + '</b>（p ' + (L.branches.b.p * 100).toFixed(0) + '%）；动作同上，但需落底的工具全部不可用。');
      } else {
        o.push('<b>分支 B · 若悬空</b>：' + (L.branches.b
          ? '首选 <b>' + L.branches.b.t.name + '</b>（p ' + (L.branches.b.p * 100).toFixed(0) + '%）；' + L.branches.b.t.op + ' 需落底的工具在这一分支全部不可用。'
          : '没有工具通过硬约束，需先打印鱼顶并评估套铣/磨铣。'));
      }
    }

    if (L.best && state.bottom !== null) o.push('<b>本趟</b>：' + L.best.t.op);
    if (L.best && (stuck === 'sand' || stuck === 'cement')) {
      o.push('<b>工具串</b>：' + L.best.t.name + ' + 震击器 + 安全接头。' +
        (stuck === 'sand' ? '砂卡时遇卡可震击解卡，安全接头保证能丢手退出。' : '水泥卡时先套铣/磨铣解除水泥环，再带震击器与安全接头下打捞工具。'));
    }
    if (L.alt) {
      o.push('备选：<b>' + L.alt.t.name + '</b>（p ' + (L.alt.p * 100).toFixed(0) + '%）。若首选抓空或咬合失败，第二趟直接换它，避免临时找工具。');
    }
    if (!L.best) {
      o.push('<b>无直接打捞工具</b>：先走工序——' + (stuck === 'buried' ? '套铣筒清障 → ' : '') +
        '平底磨鞋磨铣 → 篮式捞筒 / 反循环清屑 → 再评估打捞。不要带着卡瓦类工具硬下。' + washWarn + basketWarn + circWarn);
    } else if (state.od >= 88) {
      o.push('落物外径 ' + state.od + ' mm 偏大：若首选失败，不要反复下卡瓦类工具，转<b>平底磨鞋 + 篮式捞筒/反循环</b>磨铣清屑后再捞。');
    }
    if (stuck === 'sand' || stuck === 'cement') {
      o.push('<b>解卡前置</b>：' + (stuck === 'sand' ? '砂卡先用套铣筒清洗砂桥' : '水泥卡先用套铣筒/平底磨鞋处理水泥环') + '，套铣到位后再下打捞工具；不要用打捞工具直接硬提。' + (L.best ? washWarn : ''));
    }
    if (L.best && L.best.p < 0.65) {
      o.push('<b>低置信</b>：p=' + (L.best.p * 100).toFixed(0) + '%，先人工复核或打印确认；不要把模型概率当作现场结论。');
    }
    el('orders').innerHTML = o.map(function (x) { return '<div>' + x + '</div>'; }).join('');
  }

  function renderPrep(L) {
    var stuck = state.stuck;
    var limit = L.c.drift - 2 * CLEARANCE;
    var washFit = PREP[0].od <= limit;
    var seq;
    if (stuck === 'buried') {
      seq = '<b>落物被埋</b>：鱼顶不可达，直接打捞工具已全部被硬约束排除。顺序：<b>套铣筒 → 平底磨鞋 → 篮式捞筒 / 反循环 → 打捞工具</b>；清障后下打捞工具时，工具串再加<b>震击器 + 安全接头</b>。';
    } else if (stuck === 'sand') {
      seq = '<b>砂卡</b>：先下<b>套铣筒</b>清洗砂桥，再下打捞工具；工具串加<b>震击器 + 安全接头</b>。平底磨鞋只在鱼顶不规则时使用。';
    } else if (stuck === 'cement') {
      seq = '<b>水泥卡</b>：套铣筒磨铣水泥环，必要时用平底磨鞋修整鱼顶，篮式捞筒/反循环清屑后再捞。';
    } else if (!L.best) {
      seq = '<b>无直接打捞工具</b>：改走磨铣工序——<b>平底磨鞋 + 篮式捞筒 / 反循环</b>清屑，再评估打捞。';
    } else {
      seq = '<b>当前未卡阻</b>：打捞工具可直接接触鱼顶，不需要套铣/磨铣。若后续出现砂卡、水泥卡或落物被埋，再启用下列工序。';
    }
    if (!washFit && stuck !== 'none') {
      seq += ' <b>注意</b>：套铣筒外径 108 mm 超过本井工具外径上限 ' + fmt1(limit) + ' mm，需换小一级套铣筒。';
    }
    if (!L.best && stuck === 'none') seq += ' 本井工具外径上限 ' + fmt1(limit) + ' mm，选工序工具时同样要校核通径。';

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
      } else if (!L.best) {
        if (p.key === 'wash') { status = '视情况'; cls = 'warn'; }
        else { status = '推荐'; cls = 'ok'; }
      }
      var fitTxt = bad.length ? ' · ' + bad.join('；') : '';
      return '<div class="prep-row"><div class="pn">' + p.name + '</div>' +
        '<div class="pd">' + p.note + '<em>外径 ' + p.od + ' mm · ' + p.when + ' · 需循环 ' + (p.circ ? '是' : '否') + fitTxt + '</em></div>' +
        '<div><span class="db ' + cls + '">' + status + '</span></div></div>';
    }).join('');
    el('prep').innerHTML = '<div class="plain-note" style="margin-bottom:5px">' + seq + '</div>' + rows;
  }

  function renderStage4(L) {
    var m = MODEL.metrics;
    el('fb-note').textContent = '回写 ' + (FB.ok + FB.bad) + ' 条' + (FB.ok + FB.bad ? ' · 成功 ' + FB.ok + ' / 失败 ' + FB.bad : '') + ' · 人工确认后才进入下一轮训练';
    el('fb-log').innerHTML = L.best
      ? '本轮首选 <b>' + L.best.t.name + '</b>（p ' + (L.best.p * 100).toFixed(1) + '%）· 点击按钮把实际结果写回；回写会更新成功率并追加样本重训。'
      : '本轮没有可回写的首选工具；先走套铣/磨铣工序。';

    var btns = el('feedback').querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) btns[i].disabled = !L.best;

    var keys = Object.keys(FB.byTool);
    if (!keys.length) {
      el('online').innerHTML = '<p class="plain-note">尚无回写。点击「选用成功 / 选用失败」后：该工具成功率按贝叶斯平滑更新，样本追加进训练集并重训，权重与排序同步刷新。</p>' +
        '<p class="plain-note" style="margin-top:3px">本页合成验证集：学习排序首选 <b>' + (m.top1 * 100).toFixed(1) + '%</b> · NDCG@3 <b>' + m.ndcg.toFixed(3) + '</b> · 验证准确率 <b>' + (m.acc * 100).toFixed(1) + '%</b>。</p>';
      return;
    }

    var html = keys.map(function (k) {
      var b = FB.byTool[k];
      var t = null;
      TOOLS.forEach(function (x) { if (x.key === k) t = x; });
      var now = SUCC[k];
      var d = (now - b.prev) * 100;
      return '<div class="online-row"><span class="on">' + (t ? t.name : k) + '</span><span class="ov">n=' + b.n + '</span>' +
        '<span class="od">' + Math.round(b.prev * 100) + '% → <b>' + Math.round(now * 100) + '%</b>' +
        (Math.abs(d) < 0.05 ? '（持平）' : '（' + (d > 0 ? '+' : '') + d.toFixed(1) + ' pt）') + '</span></div>';
    }).join('');

    var deltaTxt = '—';
    if (MODEL.deltaW) {
      var bi = 0, bv = 0;
      for (var j = 0; j < MODEL.deltaW.length; j++) {
        if (Math.abs(MODEL.deltaW[j]) > Math.abs(bv)) { bv = MODEL.deltaW[j]; bi = j; }
      }
      deltaTxt = FEATS[bi].label + ' ' + (bv >= 0 ? '+' : '') + bv.toFixed(3);
    }
    html += '<div class="cmnote" style="margin-top:4px">重训：追加 <b>' + MODEL.nOnline + '</b> 行 · 本轮验证首选 <b>' + (m.top1 * 100).toFixed(1) +
      '%</b> · 最大权重变化 <b>' + deltaTxt + '</b> · 温度 T ' + MODEL.T.toFixed(2) + '</div>';
    html += '<div class="cmnote">本页合成验证集：学习排序首选 <b>' + (m.top1 * 100).toFixed(1) + '%</b> · NDCG@3 <b>' + m.ndcg.toFixed(3) + '</b> · 验证准确率 <b>' + (m.acc * 100).toFixed(1) + '%</b>。</div>';
    el('online').innerHTML = html;
  }

  function renderModelBox() {
    var m = MODEL.metrics;
    el('m-summary').innerHTML = '准确率 <b>' + (m.acc * 100).toFixed(1) + '%</b> · 首选 <b>' + (m.top1 * 100).toFixed(1) +
      '%</b> · NDCG@3 <b>' + m.ndcg.toFixed(3) + '</b> · T <b>' + MODEL.T.toFixed(2) + '</b>';
    el('m-badge').textContent = MODEL.nOnline ? '在线更新 ' + MODEL.nOnline : '已训练';
    el('m-badge').className = 'db ' + (MODEL.nOnline ? 'warn' : 'ok');
  }

  function renderNote(L) {
    var f = L.f, c = L.c;
    var txt = '当前落物：<b>' + f.name + '</b>（' + f.desc + '），外径 ' + state.od + ' mm' +
      (f.bore ? (state.fishId > 0 ? '、内径 ' + state.fishId + ' mm' : '、内径未给出') : '、无内孔') +
      '、长 ' + fmt1(state.len) + ' m；套管 <b>' + c.label + '</b>（通径 ' + fmt1(c.drift) + ' mm，工具外径上限 ' + fmt1(c.drift - 12) + ' mm）；' +
      '井斜 ' + state.incl + '°；' + (state.bottom === true ? '<b>已落底</b>' : (state.bottom === false ? '<b>悬空</b>' : '落底状态<b>未知</b>（保留两分支）')) +
      '；' + (state.circ ? '可循环洗井' : '不可循环') + '；' + (state.material === 'ferro' ? '铁磁性' : '非铁磁性') + '；卡阻：' + stuckName(state.stuck) + '。';

    txt += ' 硬约束排除 <b>' + (TOOLS.length - L.usable.length) + '</b> 件，<b>' + L.usable.length + '</b> 件进入学习排序。';
    if (L.best) {
      txt += ' 首选 <b>' + L.best.t.name + '</b>，成功概率 <b>' + (L.best.p * 100).toFixed(1) + '%</b>，预计起下钻 <b>' + tripText(L.best) + '</b>。';
      txt += ' 模型在合成验证集上的首选成功率 <b>' + (MODEL.metrics.top1 * 100).toFixed(1) + '%</b>，NDCG@3 <b>' + MODEL.metrics.ndcg.toFixed(3) + '</b>。';
    } else {
      txt += ' 当前没有通过硬约束的打捞工具——<b>危险推荐率 0%</b>，系统不会为了给答案而推荐物理不可行项。';
    }
    if (state.bottom === null && L.branches) {
      txt += ' 落底分支：' + (L.branches.a ? '<b>' + L.branches.a.t.name + '</b>（' + (L.branches.a.p * 100).toFixed(0) + '%）' : '无') +
        '；悬空分支：' + (L.branches.b ? '<b>' + L.branches.b.t.name + '</b>（' + (L.branches.b.p * 100).toFixed(0) + '%）' : '无可用工具') + '。';
    }

    var tip;
    if (state.stuck === 'buried') {
      tip = ' 落物被埋时鱼顶不可达，所有直接打捞工具都被排除——这是“先清障、后打捞”的硬顺序。';
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
     11. 过程日志 / 阶段 / 运行全流程
     ========================================================= */
  var STAGE_LABEL = ['01 描述', '02 约束', '03 排序', '04 方案', '05 闭环'];

  function trace(step, html, cls) {
    TRACE.push({ step: step, html: html, cls: cls || '' });
    if (TRACE.length > 9) TRACE.shift();
    var box = el('trace');
    box.innerHTML = TRACE.map(function (t) {
      return '<div><span class="t">' + t.step + '</span><span class="' + t.cls + '">' + t.html + '</span></div>';
    }).join('');
    box.scrollTop = box.scrollHeight;
  }
  function clearTrace() {
    TRACE = [];
    el('trace').innerHTML = '<div><span class="t">—</span><span>等待运行：点「▶ 运行全流程」依次看五段，或直接点上方阶段按钮。</span></div>';
  }

  function setStage(i) {
    state.stage = i;
    var panels = document.querySelectorAll('.dstage');
    for (var p = 0; p < panels.length; p++) panels[p].classList.toggle('on', Number(panels[p].getAttribute('data-stage')) === i);
    var btns = el('flow').children;
    for (var b = 0; b < btns.length; b++) {
      btns[b].classList.toggle('on', b === i);
      btns[b].classList.toggle('done', b < i);
      btns[b].setAttribute('aria-selected', b === i ? 'true' : 'false');
    }
  }

  function cancelRun() {
    RUN_TIMERS.forEach(function (t) { clearTimeout(t); });
    RUN_TIMERS = [];
    var btn = el('btn-run');
    if (btn) { btn.disabled = false; btn.textContent = '▶ 运行全流程'; }
  }

  function runAll() {
    cancelRun();
    renderAll();
    clearTrace();
    var btn = el('btn-run');
    btn.disabled = true;
    btn.textContent = '运行中…';
    var L = LAST, m = MODEL.metrics;
    var gcut = TOOLS.length - L.usable.length;
    var top = L.best;
    var srcCount = 0;
    Object.keys(state.src).forEach(function (k2) { if (state.src[k2]) srcCount++; });
    var steps = [
      ['01', '读取落物描述 · 已解析 <b>' + srcCount + '/10</b> 字段 · 形态 <b>' + L.f.name + '</b> · 外径 <b>' + state.od + ' mm</b> · 落底 <b>' +
        (state.bottom === true ? '已落底' : (state.bottom === false ? '悬空' : '未知')) + '</b>', ''],
      ['02', '硬约束 8 道门：11 件 → <b>' + L.usable.length + ' 件</b>候选 · 排除 <b>' + gcut + '</b> 件 · 危险推荐率 <b>0%</b>', gcut ? 'warn' : 'ok'],
      ['03', '逻辑回归：640 例（512/128）· 验证准确率 <b>' + (m.acc * 100).toFixed(1) + '%</b> · 首选 <b>' + (m.top1 * 100).toFixed(1) +
        '%</b> · NDCG@3 <b>' + m.ndcg.toFixed(3) + '</b> · T ' + MODEL.T.toFixed(2), 'ok'],
      ['04', top ? ('方案：主 <b>' + top.t.name + '</b> p=' + (top.p * 100).toFixed(0) + '% · 备 <b>' + (L.alt ? L.alt.t.name : '无') + '</b> · 工序 ' +
        (state.stuck === 'none' ? '直接打捞' : '先解卡') + (state.bottom === null ? ' · 先打印确认' : ''))
        : '方案：0 候选 → 套铣 / 磨铣 / 清屑，再评估打捞', top ? '' : 'bad'],
      ['05', '价值：选型 <b>2 h → 10 min</b> · 一次成功率 <b>71% → 89%</b>（示范口径）· 当前回写 <b>' + (FB.ok + FB.bad) + '</b> 条', 'ok']
    ];
    var delays = [0, 800, 1600, 2400, 3200];
    steps.forEach(function (s, i) {
      RUN_TIMERS.push(setTimeout(function () {
        setStage(i);
        trace(s[0], s[1], s[2]);
        if (i === steps.length - 1) {
          RUN_TIMERS.push(setTimeout(function () {
            btn.disabled = false;
            btn.textContent = '▶ 重新运行';
            trace('✓', '流水线完成：从一段落物描述到主工具 + 备选 + 工序 + 回写通道。', 'ok');
          }, 700));
        }
      }, delays[i]));
    });
  }

  /* =========================================================
     12. 控件
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
    if (state.incl < 0) state.incl = 0;
    if (state.incl > 70) state.incl = 70;
    if (state.len < 0.1) state.len = 0.1;
    if (state.len > 12) state.len = 12;

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
    state.src.form = false; state.src.od = false; state.src.fishId = false; state.src.len = false;
    syncControls();
    renderAll();
  }

  function markManual(keys) {
    keys.forEach(function (k) { state.src[k] = false; });
  }

  function refreshAndLog(label, html, cls) {
    renderAll();
    trace(label, html, cls);
  }

  function init() {
    var f = FORM_OF(state.form);

    el('seg-form').innerHTML = FORMS.map(function (x) {
      return '<button type="button" data-f="' + x.key + '" title="' + x.desc + '">' + x.name + '</button>';
    }).join('');
    el('seg-casing').innerHTML = CASINGS.map(function (c, i) {
      return '<button type="button" data-v="' + i + '" title="' + c.label + ' 通径 ' + fmt1(c.drift) + ' mm">' + c.label + '</button>';
    }).join('');

    el('seg-form').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      cancelRun();
      applyForm(b.getAttribute('data-f'));
      trace('参数', '切换落物形态：<b>' + FORM_OF(state.form).name + '</b> · 外径 ' + state.od + ' mm · 长度 ' + fmt1(state.len) + ' m');
    });

    el('seg-casing').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      cancelRun();
      state.casing = Number(b.getAttribute('data-v'));
      markManual(['casing', 'od', 'fishId']);
      syncControls();
      refreshAndLog('参数', '切换套管：<b>' + curCasing().label + '</b> · 通径 ' + fmt1(curCasing().drift) + ' mm · 工具外径上限 ' + fmt1(curCasing().drift - 12) + ' mm');
    });

    el('seg-bottom').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      cancelRun();
      var v = b.getAttribute('data-b');
      state.bottom = v === '1' ? true : (v === '0' ? false : null);
      markManual(['bottom']);
      syncControls();
      refreshAndLog('参数', '切换落底状态：<b>' + (state.bottom === true ? '已落底' : (state.bottom === false ? '悬空' : '未知')) + '</b>');
    });

    el('seg-mat').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      cancelRun();
      state.material = b.getAttribute('data-m');
      markManual(['material']);
      syncControls();
      refreshAndLog('参数', '切换材质：<b>' + (state.material === 'ferro' ? '铁磁性' : '非铁磁性') + '</b>');
    });

    el('seg-stuck').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      cancelRun();
      state.stuck = b.getAttribute('data-s');
      markManual(['stuck']);
      syncControls();
      refreshAndLog('参数', '切换卡阻状态：<b>' + stuckName(state.stuck) + '</b>');
    });

    el('tog-circ').addEventListener('click', function () {
      cancelRun();
      state.circ = !state.circ;
      markManual(['circ']);
      syncControls();
      refreshAndLog('参数', state.circ ? '本井可循环洗井' : '本井不可循环');
    });

    function bindSlider(id, key, isFloat) {
      var timer = null;
      el(id).addEventListener('input', function () {
        cancelRun();
        state[key] = isFloat ? Number(el(id).value) : Math.round(Number(el(id).value));
        markManual([key]);
        syncControls();
        if (RENDER_TIMER) cancelAnimationFrame(RENDER_TIMER);
        RENDER_TIMER = requestAnimationFrame(function () { RENDER_TIMER = null; renderAll(); });
        if (timer) clearTimeout(timer);
        timer = setTimeout(function () {
          trace('参数', '调整 <b>' + ({ od: '落物外径', fishId: '落物内径', len: '长度', incl: '井斜' }[key] || key) + '</b> → ' +
            (key === 'len' ? fmt1(state.len) + ' m' : (key === 'incl' ? state.incl + '°' : state[key] + ' mm')) +
            ' · 重新过约束与排序');
        }, 420);
      });
    }
    bindSlider('r-od', 'od', false);
    bindSlider('r-fid', 'fishId', false);
    bindSlider('r-len', 'len', true);
    bindSlider('r-incl', 'incl', false);

    el('btn-parse').addEventListener('click', function () {
      cancelRun();
      var res = parseDescription(el('desc-text').value);
      if (res.count === 0) {
        el('parse-note').textContent = '没有识别到可用字段：请补充形态、外径、长度、井斜或落底信息。';
        trace('01', '解析失败：描述里没有识别到形态 / 尺寸 / 井斜 / 落底字段。', 'bad');
        return;
      }
      applyParsed(res, false);
    });

    el('btn-run').addEventListener('click', runAll);

    el('btn-reset').addEventListener('click', function () {
      cancelRun();
      state = clone(DEFAULTS);
      state.src = freshSrc();
      state.focus = null;
      state.stage = 0;
      FB = { ok: 0, bad: 0, byTool: {} };
      ONLINE_ROWS = [];
      TOOLS.forEach(function (t) { SUCC[t.key] = t.succ; });
      MODEL = trainModel(BASE_ROWS, [], { epochs: 420 });
      var defaultText = '5-1/2" 17# 套管，井斜 18°，起油管时发现 2 根 ∅73 mm 油管断脱，内径 62 mm，长约 2.4 m，落底状态未知，铁磁性，未卡阻，可循环洗井。';
      el('desc-text').value = defaultText;
      applyParsed(parseDescription(defaultText), true);
      syncControls();
      renderAll();
      setStage(0);
      clearTrace();
      trace('系统', '已重置：模型重新用 640 例合成记录训练 · 回写清空 · 描述恢复默认样本。', 'ok');
    });

    el('flow').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      cancelRun();
      setStage(Number(b.getAttribute('data-s')));
    });

    el('feedback').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b || b.disabled) return;
      var k = b.getAttribute('data-fb');
      if (!LAST || !LAST.best) {
        trace('反馈', '当前没有首选工具，无法回写；先走工序。', 'warn');
        return;
      }
      var t = LAST.best.t;
      if (!FB.byTool[t.key]) FB.byTool[t.key] = { n: 0, k: 0, prev: SUCC[t.key] };
      FB.byTool[t.key].n++;
      if (k === 'ok') { FB.ok++; FB.byTool[t.key].k++; } else { FB.bad++; }

      var priorN = PRIOR_N, priorSucc = t.succ, fb = FB.byTool[t.key];
      SUCC[t.key] = (priorSucc * priorN + fb.k) / (priorN + fb.n);

      var prevW = MODEL.w.slice();
      ONLINE_ROWS.push({ x: LAST.best.e.x, y: k === 'ok' ? 1 : 0, toolKey: t.key });
      MODEL = trainModel(BASE_ROWS, ONLINE_ROWS, { epochs: 420 });
      MODEL.deltaW = MODEL.w.map(function (v, j) { return v - prevW[j]; });

      renderAll();
      trace('反馈', '回写 <b>' + t.name + '</b>：' + (k === 'ok' ? '<span class="ok">选用成功</span>' : '<span class="bad">选用失败</span>') +
        ' · 成功率 ' + Math.round(fb.prev * 100) + '% → <b>' + Math.round(SUCC[t.key] * 100) + '%</b> · 追加 ' + MODEL.nOnline + ' 行重训', k === 'ok' ? 'ok' : 'warn');
    });

    el('rank').addEventListener('click', function (e) {
      var th = e.target.closest('th[data-form]');
      if (th) {
        cancelRun();
        applyForm(th.getAttribute('data-form'));
        trace('矩阵', '按形态列重算：<b>' + FORM_OF(state.form).name + '</b>');
        return;
      }
      var tr = e.target.closest('tr[data-tool]');
      if (!tr) return;
      state.focus = tr.getAttribute('data-tool');
      renderAll();
      var row = findRow(LAST, state.focus);
      trace('矩阵', '查看 <b>' + row.t.name + '</b> · ' + (row.e.out ? '<span class="bad">不可用：' + esc(row.e.why) + '</span>' : 'p=' + (row.p * 100).toFixed(1) + '%'));
    });

    /* 初始：自动解析默认描述，字段来源标成「解析」 */
    var defaultText = el('desc-text').value;
    applyParsed(parseDescription(defaultText), true);
    syncControls();
    renderAll();
    setStage(0);
    clearTrace();
    trace('系统', '模型已在本页训练：640 例合成记录（512 训练 / 128 验证）· 验证首选 <b>' + (MODEL.metrics.top1 * 100).toFixed(1) +
      '%</b> · NDCG@3 <b>' + MODEL.metrics.ndcg.toFixed(3) + '</b>', 'ok');
    trace('01', '默认样本已解析：10/10 字段 · 落底未知 → 后续保留落底/悬空两分支', 'ok');
  }

  /* 调试探针：不参与页面渲染，便于开发期核对训练结果 */
  window.__FISH = {
    model: function () { return MODEL; },
    data: function () { return DATASET; },
    val: function () { return VAL_CASES; },
    base: function () { return BASE_ROWS; },
    tools: function () { return TOOLS; },
    last: function () { return LAST; },
    train: function (epochs, lr) { return trainModel(BASE_ROWS, [], { epochs: epochs || 420, lr: lr || 0.14 }); },
    retrain: function (rows) { MODEL = trainModel(BASE_ROWS, rows || []); renderAll(); }
  };

  init();
})();
