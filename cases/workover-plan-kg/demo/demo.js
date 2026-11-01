/* =========================================================
   修井日报 → 施工方案 · 可运行示范（AI 作业流 v4）
   ---------------------------------------------------------
   一段日报进来，经过五段：
     01 输入与质控：日报文本 + 7 个结构化字段；
        缺故障/缺落物尺寸/落物外径大于通径 → 降级或退回；
     02 NLP 实体抽取：术语词典最长匹配 + 正则抽数字；
        每个实体保留原文片段、规范值、命中方式与置信度；
     03 图谱检索：故障族硬过滤；7 维分故障加权结构相似度
        + 16 份案例报告的 TF-IDF 余弦 → 合成总分；
        图谱上点亮 故障→工序→工具→历史案例 的命中路径；
     04 方案组装：按 故障×工艺×工具 分组，过工具台账硬约束，
        按 相似度×成功率 排序，输出工序、工具组合、差异与风险；
     05 人工采纳：采纳/修改/驳回写回待审队列；价值按 1200 井次/年
        的现场口径展示，页面只实测解析/检索耗时与留一 Hit@3。
   16 井次案例、报告文本与工具台账均为示范数据，不指向真实井。
   ========================================================= */
(function () {
  'use strict';

  /* =========================================================
     1. 基础实体与案例库
     ========================================================= */
  var CASINGS = [
    { idm: 121.1, label: '5½" 17#', sub: '121.1' },
    { idm: 118.6, label: '5½" 23#', sub: '118.6' },
    { idm: 157.0, label: '7" 29#', sub: '157.0' }
  ];

  var FAULTS = [
    { key: 'fish', name: '井下落物', note: '落物形态与外径决定工具能否进入、咬合', procs: ['kill', 'pull', 'print', 'fish', 'mill', 'wash', 'test'] },
    { key: 'part', name: '管柱断脱', note: '断口是否规则决定捞矛/公锥/母锥是否可用', procs: ['kill', 'pull', 'print', 'fish', 'mill', 'wash', 'test'] },
    { key: 'sand', name: '砂卡出砂', note: '砂埋/砂卡，处理是冲砂与防砂', procs: ['kill', 'pull', 'wash', 'test'] },
    { key: 'water', name: '出水水淹', note: '先找水，再堵水', procs: ['kill', 'pull', 'plug', 'wash', 'test'] },
    { key: 'casing', name: '套管变形', note: '滚压/铣削/补贴恢复通径与完整性', procs: ['kill', 'pull', 'print', 'shape', 'wash', 'test'] }
  ];

  var PROCS = [
    { key: 'kill', name: '压井', seq: 1, tag: '前置', desc: '井控前置：压井液建立液柱压力平衡地层压力，是全部作业的安全条件' },
    { key: 'pull', name: '起原井管柱', seq: 2, desc: '起出原井管柱，暴露鱼顶、砂面或套管变形段' },
    { key: 'print', name: '通井/打印', seq: 3, desc: '通井规通井、打印鱼顶，核实落物形态、外径与深度' },
    { key: 'fish', name: '打捞', seq: 4, desc: '按落物形态与外径选捞筒、捞矛、公锥/母锥等' },
    { key: 'mill', name: '磨铣/套铣', seq: 5, desc: '磨铣大件/卡阻落物，或套铣环空解卡' },
    { key: 'shape', name: '套管整形', seq: 6, desc: '滚压、铣锥或补贴恢复套管通径与完整性' },
    { key: 'plug', name: '找堵水', seq: 7, desc: '生产测井/示踪找水，桥塞或化学堵剂堵水' },
    { key: 'wash', name: '洗井/冲砂', seq: 8, desc: '洗井/冲砂，携出积砂与磨铣碎屑' },
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
  var EFFECT_COLOR = {
    once: { fill: '#e7eee9', stroke: '#a9c6bb', text: '#123a3d' },
    multi: { fill: '#f4e8d4', stroke: '#dcc292', text: '#83551f' },
    second: { fill: '#f5e6e1', stroke: '#d9b3a9', text: '#8f3d2f' }
  };

  /* 16 井次示范案例；report 是“历史作业总结”原文，供 TF-IDF 真实计算 */
  var CASES = [
    { id: 'Y-1042', fault: 'fish', depth: 2100, idm: 121.1, water: 12, sand: 0, form: '管状', size: 73, tool: 'kawa', effect: 'once', days: 4.5, succ: 0.92,
      report: 'Y-1042 井井深 2100 m，套管 5½" 17#（通径 121.1 mm），含水 12%，不出砂。按井控要求压井后起原井管柱并通井打印，鱼顶 2100 m，落物为 φ73 mm 油管本体（管状），判断为井下落物。下卡瓦打捞筒配合震击器捞获，洗井后完井试压合格，一次成功。' },
    { id: 'Y-1010', fault: 'fish', depth: 1900, idm: 121.1, water: 20, sand: 0, form: '杆状', size: 62, tool: 'kawa', effect: 'multi', days: 5.0, succ: 0.88,
      report: 'Y-1010 井井深 1900 m，套管 5½" 17#，含水 20%，不出砂。检泵时发现抽油杆断脱，落物为 φ62 mm 抽油杆（杆状），鱼顶 1780 m。下卡瓦打捞筒配合震击器，两次起下钻捞获；洗井、完井试压合格。' },
    { id: 'Y-1188', fault: 'fish', depth: 2750, idm: 118.6, water: 30, sand: 0, form: '柔索', size: 25, tool: 'yiba', effect: 'multi', days: 6.0, succ: 0.85,
      report: 'Y-1188 井井深 2750 m，套管 5½" 23#，含水 30%，不出砂。测试钢丝绳落井，落物为 φ25 mm 钢丝绳（柔索），鱼顶 2600 m。下一把抓打捞，配合震击器多次起下钻捞出；洗井后试压合格。' },
    { id: 'Y-1231', fault: 'fish', depth: 3200, idm: 157.0, water: 8, sand: 0, form: '大件', size: 110, tool: 'mill', effect: 'second', days: 7.5, succ: 0.78,
      report: 'Y-1231 井井深 3200 m，套管 7" 29#，含水 8%，不出砂。井下落物为大件工具（φ110 mm），鱼顶 3050 m，卡瓦打捞筒无法咬合。下磨鞋磨铣落物顶部，套铣筒套铣解卡，洗井后试压合格，需二次措施。' },
    { id: 'Y-0907', fault: 'fish', depth: 1600, idm: 121.1, water: 5, sand: 0, form: '小件', size: 30, tool: 'magnet', effect: 'once', days: 3.0, succ: 0.95,
      report: 'Y-0907 井井深 1600 m，套管 5½" 17#，含水 5%，不出砂。落井落物为 φ30 mm 钳牙（小件），鱼顶 1500 m。下磁力打捞器一次捞获，洗井后试压合格。' },

    { id: 'Y-1350', fault: 'part', depth: 2800, idm: 118.6, water: 40, sand: 0, form: '管状', size: 73, tool: 'kawa', effect: 'multi', days: 8.0, succ: 0.80,
      report: 'Y-1350 井井深 2800 m，套管 5½" 23#，含水 40%。起原井管柱时发现管柱断脱，落物为 φ73 mm 油管（管状），鱼顶 2500 m，断口不规则。下卡瓦打捞筒配合震击器，多次起下钻捞获；洗井、试压合格。' },
    { id: 'Y-1470', fault: 'part', depth: 3600, idm: 157.0, water: 25, sand: 0, form: '管状', size: 89, tool: 'mao', effect: 'second', days: 12.0, succ: 0.68,
      report: 'Y-1470 井井深 3600 m，套管 7" 29#，含水 25%。管柱断脱，落物为 φ89 mm 油管（管状），鱼顶 3300 m，内孔规则。下捞矛造扣打捞，遇卡后套铣解卡，需二次措施，工期 12 天。' },
    { id: 'Y-1298', fault: 'part', depth: 2200, idm: 121.1, water: 35, sand: 0, form: '杆状', size: 25, tool: 'zhui', effect: 'multi', days: 6.5, succ: 0.75,
      report: 'Y-1298 井井深 2200 m，套管 5½" 17#，含水 35%。抽油杆断脱，落物为 φ25 mm 抽油杆（杆状），鱼顶 2000 m，断口较规则。下公锥造扣打捞，两次起下钻捞获；洗井后试压合格。' },

    { id: 'Y-1033', fault: 'sand', depth: 1200, idm: 121.1, water: 55, sand: 1, tool: 'sandpipe', effect: 'once', days: 3.5, succ: 0.93,
      report: 'Y-1033 井井深 1200 m，套管 5½" 17#，含水 55%，出砂。生产中发现产液下降、电流升高，起管柱遇卡，判断为砂卡出砂，砂面 1180 m。下冲砂管柱正循环冲砂至人工井底，洗井后完井试压合格，一次成功。' },
    { id: 'Y-1290', fault: 'sand', depth: 2200, idm: 118.6, water: 68, sand: 1, tool: 'sandpipe', effect: 'multi', days: 5.5, succ: 0.86,
      report: 'Y-1290 井井深 2200 m，套管 5½" 23#，含水 68%，出砂。井筒积砂埋至 2100 m，起管柱遇卡，判断为砂卡。下冲砂管柱反循环冲砂，多次起下钻清洗，洗井后试压合格。' },
    { id: 'Y-1399', fault: 'sand', depth: 2600, idm: 157.0, water: 72, sand: 1, tool: 'screen', effect: 'second', days: 6.0, succ: 0.81,
      report: 'Y-1399 井井深 2600 m，套管 7" 29#，含水 72%，出砂。砂卡出砂后冲砂至井底，因出砂反复，下防砂筛管完井，试压合格，需二次措施观察出砂。' },

    { id: 'Y-1120', fault: 'water', depth: 1500, idm: 121.1, water: 85, sand: 0, tool: 'plug', effect: 'once', days: 3.0, succ: 0.90,
      report: 'Y-1120 井井深 1500 m，套管 5½" 17#，含水 85%。含水由 60% 上升到 85%，判断为出水水淹。下生产测井找水，确定出水层位后下桥塞封堵，试压合格，含水降至 40%。' },
    { id: 'Y-1265', fault: 'water', depth: 2400, idm: 118.6, water: 92, sand: 0, tool: 'chemical', effect: 'multi', days: 4.0, succ: 0.82,
      report: 'Y-1265 井井深 2400 m，套管 5½" 23#，含水 92%。高含水，出水层与窜槽并存。下生产测井找水后挤注化学堵剂封堵，候凝后试压合格，多次起下钻，需观察含水变化。' },

    { id: 'Y-1310', fault: 'casing', depth: 1800, idm: 121.1, water: 45, sand: 0, tool: 'shaper', effect: 'once', days: 5.0, succ: 0.88,
      report: 'Y-1310 井井深 1800 m，套管 5½" 17#，含水 45%。通井至 1620 m 遇阻，打印显示套管变形（缩径），最小通径 108 mm。下滚压整形器整形，复通井至井底，试压合格，一次成功。' },
    { id: 'Y-1402', fault: 'casing', depth: 2600, idm: 118.6, water: 60, sand: 1, tool: 'millcone', effect: 'second', days: 9.0, succ: 0.72,
      report: 'Y-1402 井井深 2600 m，套管 5½" 23#，含水 60%，出砂。套管变形段有毛刺与凹坑，通井遇阻。下铣锥铣削变形段，洗井后复通井，试压合格，需二次措施。' },
    { id: 'Y-1455', fault: 'casing', depth: 3400, idm: 157.0, water: 20, sand: 0, tool: 'patch', effect: 'multi', days: 11.0, succ: 0.65,
      report: 'Y-1455 井井深 3400 m，套管 7" 29#，含水 20%。套管破损并伴有轻微错断，通井遇阻。下套管补贴覆盖破损段，胀管后通井、试压合格，多次起下钻。' }
  ];

  var EXAMPLE_TEXT = [
    { name: '落物', text: 'XX 井井深 2280 m，人工井底 2680 m，套管 5½" 17#（通径 121.1 mm），含水 18%，未见出砂。作业前按井控要求压井；起出原井管柱后通井，打印显示鱼顶 2280 m，落物为 φ80 mm 油管本体（管状），判断为井下落物。下卡瓦打捞筒带震击器捞获，洗井、完井试压合格。' },
    { name: '断脱', text: 'XX 井井深 2850 m，套管 5½" 23#（通径 118.6 mm），含水 40%。检泵作业起出上部抽油杆后，发现下部管柱断脱，断口不规则；鱼顶 2540 m，落物为 φ73 mm 油管本体（管状）。按井控要求压井，下卡瓦打捞筒配合震击器，两次起下钻捞获，洗井后试压合格。' },
    { name: '砂卡', text: 'XX 井井深 2250 m，5½" 23# 套管，含水 68%。近期产液下降、电流升高，起管柱遇卡，核实砂面 2100 m，判断为砂卡出砂。按井控要求压井后下冲砂管柱反循环冲砂至人工井底，洗井后下筛管防砂，试压合格。' },
    { name: '出水', text: 'XX 井井深 2450 m，套管 5½" 23#，综合含水由 48% 上升到 92%，判断为出水水淹。按井控要求压井后下生产测井找水，确定出水层位后下桥塞封堵，试压合格，含水降至 62%。' },
    { name: '套变', text: 'XX 井井深 1850 m，套管 5½" 17#，含水 45%。通井至 1640 m 遇阻，打印显示套管变形并缩径，最小通径 108 mm。按井控要求压井后下滚压整形器整形，复通井至井底，试压合格。' }
  ];

  /* =========================================================
     2. 小工具
     ========================================================= */
  var el = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
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
      if (Math.abs(CASINGS[i].idm - idm) < 0.05) return CASINGS[i].label + ' / ' + idm.toFixed(1) + ' mm';
    }
    return idm.toFixed(1) + ' mm';
  }
  function fmtDays(x) { return String(Math.round(x * 10) / 10); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
  function pct(x) { return Math.round(x * 100); }
  function catchText(t) {
    if (t.cmin == null) return '—';
    return t.cmax >= 999 ? ('≥' + t.cmin + ' mm') : (t.cmin + '—' + t.cmax + ' mm');
  }
  function isLitterFault(k) { return k === 'fish' || k === 'part'; }

  /* =========================================================
     3. 术语词典（最长匹配 + 同义词归一）
     ========================================================= */
  var ETYPE = {
    fault: { name: '故障现象', cls: 'efault', color: '#a64b3c' },
    well: { name: '井况', cls: 'ewell', color: '#245c5a' },
    tool: { name: '工具', cls: 'etool', color: '#355c74' },
    proc: { name: '工序', cls: 'eproc', color: '#a9742c' },
    cons: { name: '约束 / 风险', cls: 'econs', color: '#6e5a86' }
  };
  var TYPE_ORDER = ['fault', 'well', 'tool', 'proc', 'cons'];

  var LEX = [];
  var LEX_SEEN = {};
  function addLex(type, canon, terms, conf, ref, field) {
    for (var i = 0; i < terms.length; i++) {
      var term = terms[i];
      if (LEX_SEEN[term]) continue;
      LEX_SEEN[term] = 1;
      LEX.push({
        surface: term, type: type, canon: canon, label: canon,
        conf: i === 0 ? conf : Math.max(0.86, conf - 0.04),
        ref: ref || null, field: field || null, method: 'dict'
      });
    }
  }

  /* 故障现象 */
  addLex('fault', '井下落物', ['井下落物', '落物', '落井', '落鱼', '掉入井内', '落入井内'], 0.98, 'fish');
  addLex('fault', '管柱断脱', ['管柱断脱', '抽油杆断脱', '抽油杆断', '油管断脱', '断脱', '断杆', '断管'], 0.98, 'part');
  addLex('fault', '砂卡出砂', ['砂卡出砂', '砂卡', '砂埋', '积砂', '砂堵', '出砂', '含砂'], 0.97, 'sand');
  addLex('fault', '出水水淹', ['出水水淹', '水淹', '含水上升', '见水', '高含水', '出水'], 0.97, 'water');
  addLex('fault', '套管变形', ['套管变形', '套管缩径', '套管破损', '套管错断', '套变', '缩径', '变形'], 0.97, 'casing');

  /* 井况 / 落物形态 */
  addLex('well', '套管', ['套管'], 0.96);
  addLex('well', '通径', ['套管通径', '套管内径', '通径'], 0.96);
  addLex('well', '含水', ['含水率', '含水'], 0.96);
  addLex('well', '人工井底', ['人工井底'], 0.95);
  addLex('well', '鱼顶', ['鱼顶'], 0.95);
  addLex('well', '砂面', ['砂面'], 0.95);
  addLex('well', '不出砂', ['不出砂', '未见出砂', '无出砂'], 0.97);
  addLex('well', '管状', ['油管本体', '油管', '钻杆', '管状'], 0.95, '管状');
  addLex('well', '杆状', ['抽油杆', '杆状'], 0.95, '杆状');
  addLex('well', '柔索', ['钢丝绳', '电缆', '柔索'], 0.95, '柔索');
  addLex('well', '小件', ['钳牙', '螺帽', '螺母', '螺栓', '小件'], 0.94, '小件');
  addLex('well', '大件', ['封隔器', '工具串', '大件'], 0.94, '大件');

  /* 工具 */
  addLex('tool', '卡瓦打捞筒', ['卡瓦打捞筒', '卡瓦捞筒', '打捞筒', '捞筒'], 0.98, 'kawa');
  addLex('tool', '捞矛', ['捞矛', '矛瓦'], 0.96, 'mao');
  addLex('tool', '篮式捞筒', ['篮式打捞筒', '篮式捞筒', '篮式'], 0.96, 'basket');
  addLex('tool', '公锥 / 母锥', ['公母锥', '公锥', '母锥'], 0.96, 'zhui');
  addLex('tool', '一把抓', ['一把抓'], 0.95, 'yiba');
  addLex('tool', '磁力打捞器', ['磁力打捞器', '磁捞器', '强磁打捞器', '强磁'], 0.96, 'magnet');
  addLex('tool', '震击器', ['震击器'], 0.96, 'jar');
  addLex('tool', '安全接头', ['安全接头'], 0.95, 'safety');
  addLex('tool', '磨鞋', ['磨鞋', '铣鞋'], 0.96, 'mill');
  addLex('tool', '套铣筒', ['套铣筒'], 0.96, 'washpipe');
  addLex('tool', '滚压整形器', ['滚压整形器', '整形器', '滚压'], 0.96, 'shaper');
  addLex('tool', '铣锥', ['铣锥'], 0.95, 'millcone');
  addLex('tool', '套管补贴', ['套管补贴', '补贴管', '补贴'], 0.96, 'patch');
  addLex('tool', '生产测井 / 示踪', ['生产测井', '示踪', '产出剖面', '找水'], 0.95, 'logging');
  addLex('tool', '桥塞', ['桥塞'], 0.96, 'plug');
  addLex('tool', '化学堵剂', ['化学堵剂', '堵剂'], 0.95, 'chemical');
  addLex('tool', '冲砂管柱', ['冲砂管柱'], 0.96, 'sandpipe');
  addLex('tool', '筛管', ['防砂筛管', '筛管'], 0.95, 'screen');
  addLex('tool', '通井规', ['通井规'], 0.95, 'tongjing');
  addLex('tool', '打印器', ['打印器'], 0.94, 'dayin');

  /* 工序 */
  addLex('proc', '压井', ['压井液', '压井', '井控', '防喷'], 0.97, 'kill');
  addLex('proc', '起原井管柱', ['起原井管柱', '起出原井', '起管柱', '起钻'], 0.96, 'pull');
  addLex('proc', '通井/打印', ['通井', '打印'], 0.95, 'print');
  addLex('proc', '打捞', ['打捞', '捞获', '捞出'], 0.96, 'fish');
  addLex('proc', '磨铣/套铣', ['磨铣', '套铣', '铣削'], 0.96, 'mill');
  addLex('proc', '套管整形', ['套管整形', '滚压整形', '整形'], 0.94, 'shape');
  addLex('proc', '找堵水', ['找堵水', '堵水', '封堵'], 0.95, 'plug');
  addLex('proc', '洗井/冲砂', ['循环洗井', '洗井', '冲砂'], 0.95, 'wash');
  addLex('proc', '完井试压', ['完井试压', '试压', '交井'], 0.96, 'test');

  /* 约束 / 风险 */
  addLex('cons', '井控要求', ['井控要求', '压井液密度', '防喷器组'], 0.95);
  addLex('cons', '断口不规则', ['断口不规则', '断口规则', '断口较规则'], 0.94);
  addLex('cons', '遇卡 / 遇阻', ['遇卡', '卡钻', '遇阻', '落物卡死'], 0.94);
  addLex('cons', '井漏 / 井喷', ['井漏', '井喷', '井涌'], 0.93);
  addLex('cons', '套管损伤', ['窜槽', '套管破损'], 0.93);
  addLex('cons', '出砂加剧', ['出砂加剧', '出砂反复'], 0.93);
  addLex('cons', '最小通径', ['最小通径'], 0.94);
  addLex('cons', '强制措辞', ['不得', '严禁', '必须'], 0.92);

  var SCAN = LEX.slice().sort(function (a, b) {
    if (b.surface.length !== a.surface.length) return b.surface.length - a.surface.length;
    var pri = { tool: 0, fault: 0, proc: 1, well: 2, cons: 2 };
    return (pri[a.type] || 3) - (pri[b.type] || 3);
  });

  /* =========================================================
     4. 实体抽取：词典最长匹配 + 正则
     ========================================================= */
  var FORMS = ['管状', '杆状', '柔索', '小件', '大件'];
  var RE_REGEX_COUNT = 6;

  function addEntity(out, type, canon, label, surface, start, end, conf, ref, field, value, method, kind) {
    out.push({
      type: type, canon: canon, label: label, surface: surface,
      start: start, end: end, conf: conf, ref: ref || null,
      field: field || null, value: value, method: method || 'regex', kind: kind || null
    });
  }

  function dictEntities(text) {
    var out = [];
    for (var i = 0; i < text.length;) {
      var found = null;
      for (var k = 0; k < SCAN.length; k++) {
        var s = SCAN[k];
        if (text.substr(i, s.surface.length) === s.surface) { found = s; break; }
      }
      if (found) {
        addEntity(out, found.type, found.canon, found.label, found.surface, i, i + found.surface.length,
          found.conf, found.ref, found.field, null, 'dict');
        i += found.surface.length;
      } else {
        i++;
      }
    }
    return out;
  }

  function regexEntities(text, out) {
    var m, re;
    function reAdd(type, canon, label, start, end, conf, ref, field, value, kind) {
      addEntity(out, type, canon, label, text.slice(start, end), start, end, conf, ref, field, value, 'regex', kind);
    }

    /* 井深 / 鱼顶 / 砂面 / 人工井底 */
    re = /(井深|鱼顶|砂面|人工井底)\s*(?:为|在|约)?\s*(\d{3,4}(?:\.\d)?)\s*(?:m|米)/g;
    while ((m = re.exec(text))) {
      var v = Number(m[2]);
      reAdd('well', m[1] + ' ' + m[2] + ' m', m[1] + ' ' + m[2] + ' m', m.index, m.index + m[0].length,
        0.98, null, 'depth', v, m[1]);
    }

    /* 套管规格 5½" 17# / 7" 29# */
    re = /(?:套管\s*)?(5[½]|5-1\/2|5\s*1\/2|7)\s*(?:''|"|英寸)?\s*(17#|23#|29#)/g;
    while ((m = re.exec(text))) {
      var sizeHead = m[1].indexOf('5') === 0 ? '5½"' : '7"';
      var label = sizeHead + ' ' + m[2];
      var idm = null;
      for (var ci = 0; ci < CASINGS.length; ci++) {
        var cs = CASINGS[ci];
        if (cs.label === label) idm = cs.idm;
      }
      if (idm != null) {
        reAdd('well', '套管 ' + label, '套管 ' + label, m.index, m.index + m[0].length, 0.98, null, 'idm', idm, '套管');
      }
    }

    /* 通径数值；与标准套管匹配才写入 idm，否则作为“变形后最小通径”提示 */
    re = /(?:套管通径|套管内径|通径)\s*(?:为|约)?\s*(\d{2,3}(?:\.\d)?)\s*mm/g;
    while ((m = re.exec(text))) {
      var idv = Number(m[1]);
      var near = null;
      for (var cj = 0; cj < CASINGS.length; cj++) {
        if (Math.abs(CASINGS[cj].idm - idv) <= 1) near = CASINGS[cj].idm;
      }
      reAdd('well', '通径 ' + m[1] + ' mm', '通径 ' + m[1] + ' mm', m.index, m.index + m[0].length,
        0.97, null, near != null ? 'idm' : 'idmRaw', idv, '通径');
    }

    /* 含水率；一份日报可能同时有措施前与措施后，字段取最大值 */
    re = /(?:含水率|含水)\s*(?:为|达|由|约)?\s*(\d{1,3})\s*%/g;
    while ((m = re.exec(text))) {
      reAdd('well', '含水 ' + m[1] + '%', '含水 ' + m[1] + '%', m.index, m.index + m[0].length,
        0.97, null, 'water', Number(m[1]), '含水');
    }
    re = /(?:上升到|降至|下降至)\s*(\d{1,3})\s*%/g;
    while ((m = re.exec(text))) {
      reAdd('well', '含水 ' + m[1] + '%', '含水 ' + m[1] + '%', m.index, m.index + m[0].length,
        0.95, null, 'water', Number(m[1]), '含水');
    }

    /* 落物外径 */
    re = /(?:φ|Φ|直径|外径)\s*(\d{1,3})\s*mm/g;
    while ((m = re.exec(text))) {
      reAdd('well', 'φ' + m[1] + ' mm', 'φ' + m[1] + ' mm', m.index, m.index + m[0].length,
        0.96, null, 'size', Number(m[1]), '落物外径');
    }
  }

  function mergeAdjacent(ents) {
    var out = [];
    ents.sort(function (a, b) { return a.start - b.start || b.end - a.end; });
    for (var i = 0; i < ents.length; i++) {
      var e = ents[i], last = out[out.length - 1];
      if (last && last.type === e.type && last.canon === e.canon && e.start - last.end <= 1) {
        last.end = Math.max(last.end, e.end);
        last.surface = last.surface + e.surface;
        last.conf = Math.max(last.conf, e.conf);
      } else {
        out.push(e);
      }
    }
    return out;
  }

  function dropContained(ents) {
    var keep = [];
    for (var i = 0; i < ents.length; i++) {
      var e = ents[i], drop = false;
      for (var j = 0; j < ents.length; j++) {
        var o = ents[j];
        if (i === j || o.type !== e.type) continue;
        if (o.start <= e.start && o.end >= e.end && (o.end - o.start) > (e.end - e.start)) { drop = true; break; }
      }
      if (!drop) keep.push(e);
    }
    return keep;
  }

  function extractEntities(text) {
    var dict = dictEntities(text);
    var all = dict.slice();
    regexEntities(text, all);
    all = dropContained(mergeAdjacent(all));
    all.sort(function (a, b) { return a.start - b.start || b.end - a.end; });
    return all;
  }

  /* 从实体推出结构化字段；人工设定永远可以覆盖 */
  function deriveFields(ents, text) {
    var f = { fault: null, depth: null, markDepth: null, idm: null, water: null, sand: null, form: null, size: null };
    var depthRank = { '井深': 0, '鱼顶': 1, '砂面': 2, '人工井底': 3 };
    var depthBest = 99, waterMax = null, idmVal = null, idmRaw = null, sizeVal = null;
    var fishDepth = null, sandDepth = null, formCandidates = [];
    var sandPos = false, sandNeg = false, faultFirst = null;

    ents.forEach(function (e) {
      if (e.type === 'fault' && !faultFirst) faultFirst = e.ref;
      if (e.field === 'depth') {
        var r = depthRank[e.kind] != null ? depthRank[e.kind] : 9;
        if (r < depthBest) { depthBest = r; f.depth = e.value; }
        if (e.kind === '鱼顶' && fishDepth == null) fishDepth = e.value;
        if (e.kind === '砂面' && sandDepth == null) sandDepth = e.value;
      }
      if (e.field === 'idm' && idmVal == null) idmVal = e.value;
      if (e.field === 'idmRaw' && idmRaw == null) idmRaw = e.value;
      if (e.field === 'water' && e.value != null) waterMax = waterMax == null ? e.value : Math.max(waterMax, e.value);
      if (e.field === 'size' && sizeVal == null) sizeVal = e.value;
      if (e.type === 'well' && FORMS.indexOf(e.ref) >= 0) formCandidates.push({ ref: e.ref, start: e.start });
      if (e.type === 'fault' && e.ref === 'sand') sandPos = true;
      if (e.surface.indexOf('不出砂') >= 0 || e.surface.indexOf('无出砂') >= 0 || e.surface.indexOf('未见出砂') >= 0) sandNeg = true;
      if (e.surface === '出砂' || e.surface === '含砂') sandPos = true;
    });

    var pickedForm = null;
    for (var i = 0; i < formCandidates.length; i++) {
      var pre = text.slice(Math.max(0, formCandidates[i].start - 14), formCandidates[i].start);
      if (/落物|落鱼|鱼顶/.test(pre)) { pickedForm = formCandidates[i].ref; break; }
    }
    if (!pickedForm && formCandidates.length) pickedForm = formCandidates[0].ref;

    f.fault = faultFirst;
    f.idm = idmVal;
    f.water = waterMax;
    f.form = pickedForm;
    f.size = sizeVal;
    f.sand = sandPos ? true : (sandNeg ? false : (faultFirst === 'sand' ? true : null));
    f.markDepth = (faultFirst === 'fish' || faultFirst === 'part') ? fishDepth : (faultFirst === 'sand' ? sandDepth : null);
    return { fields: f, oddIdm: idmRaw };
  }

  function coverageOf(text, ents) {
    var mark = new Array(text.length);
    for (var i = 0; i < text.length; i++) mark[i] = 0;
    ents.forEach(function (e) {
      for (var j = e.start; j < e.end && j < text.length; j++) mark[j] = 1;
    });
    var total = 0, hit = 0;
    for (var k = 0; k < text.length; k++) {
      if (/[\u4e00-\u9fa5A-Za-z0-9]/.test(text.charAt(k))) {
        total++;
        if (mark[k]) hit++;
      }
    }
    return total ? hit / total : 0;
  }

  function parseReport(text) {
    var t0 = (window.performance && performance.now) ? performance.now() : Date.now();
    var ents = extractEntities(text);
    var d = deriveFields(ents, text);
    var cov = coverageOf(text, ents);
    var t1 = (window.performance && performance.now) ? performance.now() : Date.now();
    return {
      text: text, ents: ents, fields: d.fields, oddIdm: d.oddIdm,
      coverage: cov, ms: Math.max(0.1, t1 - t0),
      nDict: ents.filter(function (e) { return e.method === 'dict'; }).length,
      nRegex: ents.filter(function (e) { return e.method === 'regex'; }).length
    };
  }

  /* =========================================================
     5. 文本向量：词典词元 + 汉字二元组 · 真实 TF-IDF 余弦
     ========================================================= */
  function lexTokens(text) {
    var out = [];
    for (var i = 0; i < text.length;) {
      var found = null;
      for (var k = 0; k < SCAN.length; k++) {
        var s = SCAN[k];
        if (text.substr(i, s.surface.length) === s.surface) { found = s; break; }
      }
      if (found) { out.push(found.type + ':' + found.canon); i += found.surface.length; }
      else i++;
    }
    var runs = text.match(/[\u4e00-\u9fa5]{2,}/g) || [];
    for (var r = 0; r < runs.length; r++) {
      var run = runs[r];
      for (var j = 0; j < run.length - 1; j++) out.push(run.substr(j, 2));
    }
    return out;
  }

  function countTokens(tokens) {
    var tf = {};
    tokens.forEach(function (t) { tf[t] = (tf[t] || 0) + 1; });
    return tf;
  }

  var DF = {}, CORPUS_N = CASES.length;
  CASES.forEach(function (c) {
    c._tf = countTokens(lexTokens(c.report));
    Object.keys(c._tf).forEach(function (t) { DF[t] = (DF[t] || 0) + 1; });
  });
  var VOCAB = Object.keys(DF).length;

  function idfOf(t) { return Math.log((1 + CORPUS_N) / (1 + (DF[t] || 0))) + 1; }

  function l2vec(tf) {
    var v = {}, norm = 0;
    Object.keys(tf).forEach(function (t) {
      if (!DF[t]) return;
      var w = (1 + Math.log(tf[t])) * idfOf(t);
      v[t] = w;
      norm += w * w;
    });
    norm = Math.sqrt(norm) || 1;
    Object.keys(v).forEach(function (t) { v[t] = v[t] / norm; });
    return v;
  }

  CASES.forEach(function (c) { c._vec = l2vec(c._tf); });
  CASES.forEach(function (c) { c._qvec = l2vec(countTokens(lexTokens(c.report))); });

  function makeQueryVec(text) { return l2vec(countTokens(lexTokens(text))); }

  function cosine(qv, dv) {
    var sum = 0;
    Object.keys(qv).forEach(function (t) { if (dv[t]) sum += qv[t] * dv[t]; });
    return sum;
  }

  function textDetail(qv, dv) {
    var terms = [], sum = 0;
    Object.keys(qv).forEach(function (t) {
      if (!dv[t]) return;
      var p = qv[t] * dv[t];
      sum += p;
      terms.push({ t: t, q: qv[t], d: dv[t], p: p });
    });
    terms.sort(function (a, b) { return b.p - a.p; });
    return {
      cos: sum, terms: terms.slice(0, 6),
      shared: terms.length, qn: Object.keys(qv).length
    };
  }
  function tokenLabel(t) {
    var i = t.indexOf(':');
    return i >= 0 ? t.slice(i + 1) : t;
  }

  /* =========================================================
     6. 结构相似度（沿用现有分故障加权）＋ 合成
     ========================================================= */
  var FEATURE_KEYS = ['fault', 'depth', 'idm', 'water', 'sand', 'form', 'size'];
  var FEATURE_LABEL = {
    fault: '故障同族', depth: '井深', idm: '套管内径', water: '含水率',
    sand: '出砂', form: '落物形态', size: '落物外径'
  };
  var WEIGHTS = {
    fish: { fault: 0.20, depth: 0.20, idm: 0.10, water: 0.00, sand: 0.00, form: 0.25, size: 0.25 },
    part: { fault: 0.20, depth: 0.20, idm: 0.10, water: 0.00, sand: 0.00, form: 0.20, size: 0.30 },
    sand: { fault: 0.25, depth: 0.20, idm: 0.15, water: 0.10, sand: 0.30, form: 0.00, size: 0.00 },
    water: { fault: 0.25, depth: 0.15, idm: 0.10, water: 0.50, sand: 0.00, form: 0.00, size: 0.00 },
    casing: { fault: 0.35, depth: 0.30, idm: 0.35, water: 0.00, sand: 0.00, form: 0.00, size: 0.00 }
  };
  var DEPTH_RANGE = 2400;

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

  /* =========================================================
     7. 状态、检索与方案
     ========================================================= */
  var STATE_DEFAULT = { fault: 'fish', idm: 121.1, depth: 2100, markDepth: 2100, water: 12, sand: false, form: '管状', size: 73 };
  var state = {
    fault: 'fish', idm: 121.1, depth: 2100, markDepth: 2100, water: 12, sand: false,
    form: '管状', size: 73, text: EXAMPLE_TEXT[0].text, beta: 0.3,
    selPlan: 0, selCase: null, stage: 0
  };
  var model = { q: null, hits: [], plans: [], map: {}, evalr: null, searchMs: 0, blocked: false };
  var LASTP = null;
  var fb = { adopt: 0, modify: 0, reject: 0, pending: [], seq: 0 };

  function query() {
    return {
      fault: state.fault, depth: state.depth, idm: state.idm,
      water: state.water, sand: state.sand ? 1 : 0, form: state.form, size: state.size
    };
  }

  function toolIssue(t, q) {
    if (!t) return '工具不在台账';
    if (t.faults.indexOf(q.fault) < 0) return '不适用于' + faultName(q.fault);
    if (t.aux) return '配套工具，不单独推荐';
    if (t.minId && q.idm < t.minId) return '需通径 ≥' + t.minId + ' mm，当前 ' + q.idm.toFixed(1) + ' mm';
    if (isLitterFault(q.fault) && t.cmin != null) {
      if (q.size < t.cmin || q.size > t.cmax) return '适用落物 ' + catchText(t) + '，当前 ' + q.size + ' mm';
      if (t.forms && t.forms.indexOf(q.form) < 0) return '不适用于' + q.form + '落物';
    }
    return null;
  }
  function issueLabel(s) {
    if (s.indexOf('通径') >= 0) return '通径不足';
    if (s.indexOf('适用落物') >= 0) return '落物尺寸不符';
    if (s.indexOf('落物') >= 0) return '落物形态不符';
    if (s.indexOf('配套') >= 0) return '配套工具';
    if (s.indexOf('不适用于') >= 0) return '工艺不适用';
    return '硬约束排除';
  }
  function shortIssue(s) {
    if (s.indexOf('通径') >= 0) return '通径';
    if (s.indexOf('适用落物') >= 0) return '尺寸';
    if (s.indexOf('落物') >= 0) return '形态';
    if (s.indexOf('配套') >= 0) return '配套';
    if (s.indexOf('不适用于') >= 0) return '工艺';
    return '排除';
  }

  function search(q, text) {
    var t0 = (window.performance && performance.now) ? performance.now() : Date.now();
    var qv = makeQueryVec(text);
    var rows = CASES.filter(function (c) { return c.fault === q.fault; }).map(function (c) {
      var s = similarity(q, c);
      var tx = cosine(qv, c._vec);
      var total = (1 - state.beta) * s.sim + state.beta * tx;
      return { c: c, sim: s.sim, parts: s.parts, text: tx, total: total, issue: toolIssue(toolByKey(c.tool), q) };
    }).sort(function (a, b) { return b.total - a.total; });
    var t1 = (window.performance && performance.now) ? performance.now() : Date.now();
    model.searchMs = Math.max(0.1, t1 - t0);
    return rows;
  }

  function buildPlans(hits, q) {
    var groups = {}, order = [];
    hits.forEach(function (h) {
      if (h.issue) return;
      var t = toolByKey(h.c.tool);
      if (!t) return;
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
        var w = 0.15 + h.total;
        wsum += w;
        simSum += h.total * w;
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

  /* 留一案例检索验证：拿掉自己，同族候选里看工艺是否命中 */
  function evalRetrieval() {
    var out = { n: 0, s1: 0, s3: 0, t1: 0, t3: 0, c1: 0, c3: 0 };
    CASES.forEach(function (c) {
      var others = CASES.filter(function (x) { return x !== c && x.fault === c.fault; });
      if (!others.length) return;
      var rows = others.map(function (o) {
        var s = similarity(c, o);
        var t = cosine(c._qvec, o._vec);
        return { o: o, s: s.sim, t: t, c: (1 - state.beta) * s.sim + state.beta * t };
      });
      var myProc = toolByKey(c.tool).proc;
      function hitAt(key, k) {
        var top = rows.slice().sort(function (a, b) { return b[key] - a[key]; }).slice(0, k);
        return top.some(function (x) { return toolByKey(x.o.tool).proc === myProc; });
      }
      out.n++;
      if (hitAt('s', 1)) out.s1++;
      if (hitAt('s', 3)) out.s3++;
      if (hitAt('t', 1)) out.t1++;
      if (hitAt('t', 3)) out.t3++;
      if (hitAt('c', 1)) out.c1++;
      if (hitAt('c', 3)) out.c3++;
    });
    return out;
  }

  function planChain(fk, tp) {
    var fp = faultProcs(fk), out = [];
    ['kill', 'pull', 'print'].forEach(function (k) {
      if (fp.indexOf(k) >= 0) out.push(k);
    });
    if (tp && fp.indexOf(tp) >= 0 && out.indexOf(tp) < 0) out.push(tp);
    ['wash', 'test'].forEach(function (k) {
      if (fp.indexOf(k) >= 0 && (tp ? out.indexOf(tp) >= 0 : true) && out.indexOf(k) < 0) out.push(k);
    });
    return out;
  }

  function selectedPlan() {
    if (!model.plans.length) return null;
    if (state.selPlan >= 0 && state.selPlan < model.plans.length) return model.plans[state.selPlan];
    return model.plans[0];
  }
  function currentHit() { return state.selCase ? model.map[state.selCase] || null : null; }

  function toolCheckText(t, q) {
    var out = [];
    if (t.od) out.push('外径 ' + t.od + ' ≤ 通径 ' + q.idm.toFixed(1) + ' mm');
    else out.push('无刚性外径，不受通径限制');
    if (t.cmin != null && isLitterFault(q.fault)) {
      out.push('适用落物 ' + catchText(t) + ' / ' + t.forms.join('、') + '，当前 ' + q.form + ' φ' + q.size + ' mm');
    }
    if (t.key === 'zhui') out.push('仅用于规则内孔/外壁');
    if (q.fault === 'part' && (t.key === 'kawa' || t.key === 'mao' || t.key === 'zhui')) out.push('建议配震击器');
    return out.join('；');
  }

  function comboFor(p) {
    var t = toolByKey(p.tool), names = [t.name];
    function put(n) { if (names.indexOf(n) < 0) names.push(n); }
    if (isLitterFault(p.fault)) {
      if (['kawa', 'mao', 'zhui', 'basket', 'yiba', 'magnet'].indexOf(t.key) >= 0) { put('震击器'); put('安全接头'); }
      if (t.key === 'mill') { put('套铣筒'); put('安全接头'); }
      if (t.key === 'washpipe') { put('磨鞋'); put('安全接头'); }
    }
    if (t.key === 'patch') { put('补贴管'); put('胀管器'); }
    if (t.key === 'plug') put('坐封工具');
    if (t.key === 'chemical') put('挤注管柱');
    if (t.key === 'screen') put('冲砂管柱');
    if (t.key === 'sandpipe') put('筛管（按需）');
    return names;
  }

  function stepsFor(p, q) {
    var t = toolByKey(p.tool);
    var chain = planChain(p.fault, p.proc);
    return chain.map(function (k) {
      var name = procName(k), tool = '', text = '';
      if (k === 'kill') {
        tool = '压井液 + 防喷器组';
        text = '按本井压力系数复算压井液密度，建立液柱压力平衡；装井口防喷器并试压，记录套压。';
      } else if (k === 'pull') {
        tool = '修井机 + 原井管柱';
        text = '起出原井管柱，记录鱼顶、砂面或变形段深度；遇卡不得硬提，先循环洗井。';
      } else if (k === 'print') {
        tool = '通井规 / 打印器';
        text = '下通井规通井至鱼顶以上 2 m，打印鱼顶核实落物形态、外径与深度。';
      } else if (k === 'fish') {
        tool = t.name;
        text = '下' + t.name + '，' + t.use + '；配震击器与安全接头，遇卡按上击/下击规程操作，必要时脱手。';
      } else if (k === 'mill') {
        tool = t.name;
        text = '下' + t.name + '处理落物顶部或环空卡阻，每 0.5 m 循环洗井携屑，防止重复堆积。';
      } else if (k === 'shape') {
        tool = t.name;
        text = '对变形段实施' + t.use + '，逐级恢复通径；整形后通井规复验，必要时补下补贴管。';
      } else if (k === 'plug') {
        tool = t.name;
        text = t.key === 'logging'
          ? '先下生产测井/示踪找水，确定出水层位后再选桥塞或化学堵剂。'
          : '确认出水层位后下' + t.name + '，' + t.use + '；封堵后试压并观察含水变化。';
      } else if (k === 'wash') {
        if (t.key === 'screen') {
          tool = '冲砂管柱 + 筛管';
          text = '先正/反循环冲砂至人工井底，再下筛管防砂；洗井至进出口液一致。';
        } else {
          tool = t.name;
          text = '正/反循环冲砂至人工井底，洗井至进出口液一致，携出积砂与磨铣碎屑。';
        }
      } else if (k === 'test') {
        tool = '试压泵 + 井口装置';
        text = '按套管允许压力完井试压，合格后交井；记录试压曲线与稳压时间。';
      }
      return { proc: k, name: name, tool: tool, text: text };
    });
  }

  function risksFor(p, q) {
    var t = toolByKey(p.tool), out = [];
    out.push({ lv: '高', title: '井控前置', text: '压井不到位不得起下钻；压井液密度按本井压力系数复算，全过程记录套压。' });
    if (q.fault === 'part') out.push({ lv: '高', title: '断口规则性未核实', text: '公锥/母锥/捞矛造扣可能失败；先打印鱼顶，备套铣筒与磨鞋。' });
    if (isLitterFault(q.fault) && q.size >= 90) out.push({ lv: '高', title: '落物外径偏大', text: 'φ' + q.size + ' mm 接近或超过捞筒咬合范围，优先磨铣/套铣，避免反复起下钻。' });
    if (isLitterFault(q.fault)) out.push({ lv: '中', title: '鱼顶与落物复核', text: '打印结果可能与日报描述不一致；下工具前复核鱼顶深度、落物外径与形态。' });
    if (q.fault === 'sand') out.push({ lv: '中', title: '砂面与出砂量复核', text: '日报砂面可能已变化；冲砂前复测砂面，控制循环排量与携砂浓度，防止憋泵。' });
    if (q.fault === 'water') out.push({ lv: '中', title: '找水结果复核', text: '生产测井/示踪结果与日报出水层可能不一致；堵水前复核出水层位与窜槽。' });
    if (q.fault === 'casing') out.push({ lv: '中', title: '变形段通径复测', text: '日报最小通径为打印结果；整形/补贴前用通井规复测，防止工具卡阻。' });
    out.push({ lv: '中', title: '工具通过性', text: '下井前用通井规复验；套管变形、结垢或砂桥可能使工具下不到位。' });
    if (t.key === 'yiba' || t.key === 'basket') out.push({ lv: '中', title: '柔索/小件易成团', text: '慢提防抽筒；捞获后先循环洗井再起钻。' });
    if (q.fault === 'sand' && !q.sand) out.push({ lv: '中', title: '出砂证据不足', text: '日报未明确出砂，需与管柱断脱区分；先核实砂面与电流/产液变化。' });
    if (q.fault === 'water' && t.key === 'chemical') out.push({ lv: '高', title: '堵剂误堵风险', text: '必须先找水确认出水层；候凝期间控制压差，防止堵剂窜入非出水层。' });
    if (q.fault === 'casing' && t.key === 'patch') out.push({ lv: '中', title: '补贴后通径缩小', text: '补贴管壁厚使内径减小，后续工具需复核最小通过尺寸。' });
    if (q.fault === 'casing' && t.key === 'shaper') out.push({ lv: '中', title: '整形后需复验', text: '滚压后通井规复验；套管剩余强度按损坏程度评估，必要时补贴。' });
    if (p.succ < 0.8) out.push({ lv: '中', title: '二次措施概率高', text: '历史成功率 ' + p.succ.toFixed(2) + '，按备用工具与工期上浮 30% 备料。' });
    if (q.depth >= 3000) out.push({ lv: '中', title: '深井起下钻周期长', text: '井深 ' + q.depth + ' m，工具需耐温耐压校核，工期按区间上限准备。' });
    if (p.sim < 0.62) out.push({ lv: '中', title: '证据相似度偏低', text: '最高综合相似度 ' + p.sim.toFixed(2) + '，方案要点需专家复核。' });
    return out.slice(0, 5);
  }

  function planDiff(alt, main, q) {
    var at = toolByKey(alt.tool), mt = toolByKey(main.tool), out = [];
    if (alt.proc !== main.proc) {
      out.push('工艺不同：' + procName(alt.proc) + ' vs 主方案 ' + procName(main.proc));
    } else {
      out.push('同工序换工具：' + at.name + ' vs ' + mt.name);
      if (at.cmin != null && mt.cmin != null) out.push('适用落物 ' + catchText(at) + ' vs ' + catchText(mt));
      else out.push('工具外径 ' + (at.od || '—') + ' vs ' + (mt.od || '—') + ' mm');
    }
    out.push('历史成功率 ' + alt.succ.toFixed(2) + ' vs ' + main.succ.toFixed(2));
    out.push('工期 ' + fmtDays(alt.dmin) + (alt.dmin === alt.dmax ? '' : '—' + fmtDays(alt.dmax)) +
      ' 天 vs ' + fmtDays(main.dmin) + (main.dmin === main.dmax ? '' : '—' + fmtDays(main.dmax)) + ' 天');
    out.push('证据 ' + alt.n + ' 井次 vs ' + main.n + ' 井次');
    return out.join('；') + '。';
  }

  function toolHint(t) {
    var map = {
      kawa: '落物外壁规则、能进入捞筒时首选',
      mao: '鱼顶有规则内孔时使用',
      basket: '磨铣碎屑、小件与柔索',
      zhui: '断口规则、可造扣时使用',
      yiba: '钢丝绳、电缆等柔索',
      magnet: '铁磁性小件',
      mill: '大件或捞筒无法咬合',
      washpipe: '环空砂卡 / 水泥卡',
      shaper: '椭圆变形、通径可恢复',
      millcone: '局部凹坑 / 毛刺',
      patch: '变形或破损严重、需恢复完整性',
      logging: '出水层不明，先找水',
      plug: '出水层明确、机械封堵',
      chemical: '窜槽或桥塞不适用的出水',
      sandpipe: '砂埋 / 砂卡，先冲砂',
      screen: '出砂反复，需防砂完井'
    };
    return map[t.key] || t.use;
  }

  /* =========================================================
     8. 图谱与井筒
     ========================================================= */
  var G = { W: 600, H: 380, TOP: 28, BOT: 370, NH: 15, GAP: 2 };
  var COL = {
    fault: { x: 4, w: 88 },
    proc: { x: 120, w: 106 },
    tool: { x: 258, w: 130 },
    case: { x: 418, w: 176 }
  };
  var CUR_CASES = [];

  function nodePos(kind, key) {
    var list = kind === 'fault' ? FAULTS : kind === 'proc' ? PROCS : kind === 'tool' ? TOOLS : CUR_CASES;
    var idx = 0;
    for (var i = 0; i < list.length; i++) {
      var k = kind === 'case' ? list[i].id : list[i].key;
      if (k === key) { idx = i; break; }
    }
    var n = list.length;
    var total = n * G.NH + (n - 1) * G.GAP;
    var y = G.TOP + (G.BOT - G.TOP - total) / 2 + idx * (G.NH + G.GAP);
    var c = COL[kind];
    return { x: c.x, y: y, w: c.w, h: G.NH, cx: c.x + c.w / 2, cy: y + G.NH / 2 };
  }

  function edgeEl(a, b, cls, extra, title) {
    var x1 = a.x + a.w, y1 = a.cy, x2 = b.x, y2 = b.cy, mx = (x1 + x2) / 2;
    return '<path class="gedge ' + cls + '" d="M' + x1.toFixed(1) + ' ' + y1.toFixed(1) +
      ' C' + mx.toFixed(1) + ' ' + y1.toFixed(1) + ' ' + mx.toFixed(1) + ' ' + y2.toFixed(1) +
      ' ' + x2.toFixed(1) + ' ' + y2.toFixed(1) + '"' + (extra || '') + '>' +
      (title ? '<title>' + esc(title) + '</title>' : '') + '</path>';
  }

  function nodeTitle(kind, item) {
    if (kind === 'fault') {
      var n = CASES.filter(function (c) { return c.fault === item.key; }).length;
      return item.name + '：' + item.note + '；同族 ' + n + ' 井次；点击切换';
    }
    if (kind === 'proc') return '工序 ' + item.seq + ' · ' + item.name + '：' + item.desc;
    if (kind === 'tool') {
      var cs = CASES.filter(function (c) { return c.tool === item.key; });
      var spec = item.od ? ('外径 ' + item.od + ' mm，最小通过 ' + item.minId + ' mm') : '流体/无刚性外径';
      var cap = item.cmin != null ? ('；适用落物 ' + catchText(item) + '（' + item.forms.join('、') + '）') : '';
      return item.name + '（' + procName(item.proc) + '）：' + spec + cap + (cs.length ? '；全库 ' + cs.length + ' 井次' : '；示范库暂无案例');
    }
    return item.id + '：' + faultName(item.fault) + ' / ' + toolByKey(item.tool).name + ' / ' + effectName(item.effect) +
      '；成功率 ' + item.succ.toFixed(2) + '，工期 ' + fmtDays(item.days) + ' 天';
  }

  function renderNode(kind, item, cls) {
    var p = nodePos(kind, item.key), st = { fault: { fill: '#f5e6e1', stroke: '#dcc3bd', text: '#a64b3c' },
      proc: { fill: '#f4e8d4', stroke: '#e3d2b0', text: '#83551f' },
      tool: { fill: '#e5ebf0', stroke: '#cdd8e2', text: '#355c74' } }[kind];
    var dashed = (kind === 'proc' && item.tag) ? ' stroke-dasharray="3 2"' : '';
    var fill = cls === 'hot' ? '#ffffff' : st.fill;
    var stroke = cls === 'hot' ? '#123a3d' : cls === 'chain' ? '#6f9e94' : st.stroke;
    var txt = cls === 'hot' ? '#123a3d' : st.text;
    var fs = kind === 'fault' ? 10.2 : 9.4;
    return '<g class="gnode ' + cls + '" data-kind="' + kind + '" data-key="' + esc(item.key) + '" tabindex="0" role="button" aria-label="' + esc(item.name) + '">' +
      '<title>' + esc(nodeTitle(kind, item)) + '</title>' +
      '<rect x="' + p.x.toFixed(1) + '" y="' + p.y.toFixed(1) + '" width="' + p.w + '" height="' + p.h + '" rx="4.5" fill="' + fill + '" stroke="' + stroke + '"' + dashed + '/>' +
      '<text x="' + (p.x + 6).toFixed(1) + '" y="' + (p.cy + 3.3).toFixed(1) + '" font-size="' + fs + '" fill="' + txt + '"' +
      (cls === 'hot' ? ' font-weight="600"' : '') + '>' + esc(item.name) + '</text></g>';
  }

  function renderCaseNode(h, idx) {
    var p = nodePos('case', h.c.id), col = EFFECT_COLOR[h.c.effect];
    var sel = h.c.id === state.selCase;
    var fill = sel ? '#ffffff' : col.fill;
    var stroke = sel ? '#123a3d' : (h.issue ? '#c9a6a0' : col.stroke);
    var dash = h.issue ? ' stroke-dasharray="3 2"' : '';
    var txt = sel ? '#123a3d' : col.text;
    return '<g class="gnode case' + (sel ? ' hot' : '') + '" data-kind="case" data-key="' + esc(h.c.id) + '" tabindex="0" role="button" aria-label="' + esc(h.c.id) + '">' +
      '<title>' + esc(nodeTitle('case', h.c)) + (h.issue ? '；当前井况被硬约束排除：' + esc(h.issue) : '') + '</title>' +
      '<rect x="' + p.x.toFixed(1) + '" y="' + p.y.toFixed(1) + '" width="' + p.w + '" height="' + p.h + '" rx="4.5" fill="' + fill + '" stroke="' + stroke + '"' + dash + '/>' +
      '<text x="' + (p.x + 7).toFixed(1) + '" y="' + (p.cy + 3.2).toFixed(1) + '" font-size="8.8" fill="' + txt + '"' +
      (sel ? ' font-weight="600"' : '') + '>' + pad2(idx + 1) + ' ' + esc(h.c.id) + '  ' + h.total.toFixed(2) + '</text></g>';
  }

  function drawGraph() {
    var hit = currentHit();
    var cf = hit ? hit.c.fault : state.fault;
    var plan = selectedPlan();
    var focusTool = hit ? hit.c.tool : (plan ? plan.tool : null);
    var focusProc = focusTool ? toolByKey(focusTool).proc : null;
    var chain = planChain(cf, focusProc);
    var fp = faultProcs(cf);
    CUR_CASES = model.hits.map(function (h) { return h.c; });
    var s = '';

    [['fault', '① 实体 · 故障现象'], ['proc', '② 工序 · 施工顺序'], ['tool', '③ 工具'], ['case', '④ 历史案例 · 方案路径']].forEach(function (h) {
      var c = COL[h[0]];
      s += '<text x="' + (c.x + 2) + '" y="13" font-size="9" font-family="monospace" fill="#99a3a4" letter-spacing=".6">' + h[1] + '</text>';
    });

    FAULTS.forEach(function (f) {
      if (f.key === cf) {
        faultProcs(f.key).forEach(function (pk) {
          var cls = pk === focusProc ? 'hot' : (chain.indexOf(pk) >= 0 ? 'chain' : 'dim');
          s += edgeEl(nodePos('fault', f.key), nodePos('proc', pk), cls);
        });
      } else {
        s += edgeEl(nodePos('fault', f.key), nodePos('proc', 'kill'), 'dim');
      }
    });

    TOOLS.forEach(function (t) {
      var applicable = t.faults.indexOf(cf) >= 0;
      s += edgeEl(nodePos('proc', t.proc), nodePos('tool', t.key),
        t.key === focusTool ? 'hot' : (applicable ? '' : 'dim'));
    });

    model.hits.forEach(function (h) {
      var t = toolByKey(h.c.tool);
      if (!t) return;
      s += edgeEl(nodePos('tool', t.key), nodePos('case', h.c.id),
        h.c.id === state.selCase ? 'case hot' : (h.issue ? 'case dim' : 'case'),
        '', h.c.id + '：' + t.name + ' → ' + effectName(h.c.effect));
    });

    FAULTS.forEach(function (f) {
      s += renderNode('fault', f, f.key === cf ? 'hot' : 'dim');
    });
    PROCS.forEach(function (p) {
      var cls = p.key === focusProc ? 'hot' : (chain.indexOf(p.key) >= 0 ? 'chain' :
        (fp.indexOf(p.key) >= 0 ? 'alt' : 'dim'));
      s += renderNode('proc', p, cls);
    });
    TOOLS.forEach(function (t) {
      s += renderNode('tool', t, t.key === focusTool ? 'hot' : (t.faults.indexOf(cf) >= 0 ? '' : 'dim'));
    });
    model.hits.forEach(function (h, i) { s += renderCaseNode(h, i); });

    el('graph').innerHTML = s;
  }

  function drawWell() {
    var q = model.q, hit = currentHit(), plan = selectedPlan();
    var t = hit ? toolByKey(hit.c.tool) : (plan ? toolByKey(plan.tool) : null);
    var W = 600, H = 170, base = 26, span = 112, maxD = 3600;
    function Y(d) { return base + Math.min(1, Math.max(0, d / maxD)) * span; }
    var md = state.markDepth != null ? state.markDepth : q.depth;
    var y = Y(md);
    var s = '';

    /* 井筒与地面 */
    s += '<rect x="92" y="26" width="32" height="112" fill="#fffefa" stroke="#e3dccd"/>';
    s += '<rect x="92" y="26" width="4" height="112" fill="#d8cdb8"/>';
    s += '<rect x="120" y="26" width="4" height="112" fill="#d8cdb8"/>';
    s += '<line x1="14" y1="26" x2="232" y2="26" stroke="#b9ae98" stroke-width="1.2"/>';
    for (var gx = 16; gx < 232; gx += 10) {
      s += '<line x1="' + gx + '" y1="26" x2="' + (gx - 5) + '" y2="32" stroke="#ddd3c0" stroke-width=".7"/>';
    }
    s += '<text x="14" y="19" font-size="7.8" fill="#99a3a4" font-family="monospace">地面 0 m</text>';

    /* 深度刻度 */
    [0, 600, 1200, 1800, 2400, 3000, 3600].forEach(function (d) {
      var yy = Y(d);
      s += '<line x1="136" y1="' + yy.toFixed(1) + '" x2="142" y2="' + yy.toFixed(1) + '" stroke="#c9bfa9"/>';
      s += '<text x="146" y="' + (yy + 2.8).toFixed(1) + '" font-size="7.2" font-family="monospace" fill="#99a3a4">' + d + '</text>';
    });

    /* 当前工具管柱 */
    s += '<line x1="108" y1="30" x2="108" y2="' + y.toFixed(1) + '" stroke="#355c74" stroke-width="2" stroke-dasharray="4 2"/>';
    s += '<rect x="101" y="' + (y - 13).toFixed(1) + '" width="14" height="8" rx="1.5" fill="#e5ebf0" stroke="#355c74"/>';
    s += '<text x="' + (t ? 118 : 118) + '" y="' + (y - 8).toFixed(1) + '" font-size="8" fill="#355c74" font-family="monospace">' + esc(t ? t.name : '无可用工具') + '</text>';

    /* 落物/目的层 */
    if (isLitterFault(q.fault)) {
      if (q.form === '柔索') {
        s += '<path d="M104 ' + y + ' q4 -5 8 0 q4 5 8 0" fill="none" stroke="#a64b3c" stroke-width="2"/>';
      } else if (q.form === '小件') {
        s += '<circle cx="108" cy="' + y + '" r="3.2" fill="#a64b3c"/>';
      } else if (q.form === '大件') {
        s += '<rect x="100" y="' + (y - 5) + '" width="16" height="9" rx="1" fill="#f5e6e1" stroke="#a64b3c" stroke-width="1.3"/>';
      } else if (q.form === '杆状') {
        s += '<rect x="106" y="' + (y - 8) + '" width="4" height="16" fill="#a64b3c"/>';
      } else {
        s += '<rect x="103" y="' + (y - 8) + '" width="10" height="16" rx="1" fill="#f5e6e1" stroke="#a64b3c" stroke-width="1.3"/>';
      }
      s += '<text x="128" y="' + (y + 9).toFixed(1) + '" font-size="8" fill="#a64b3c" font-family="monospace">' +
        (q.fault === 'part' ? '断口' : '鱼顶') + ' ' + md + ' m</text>';
    } else if (q.fault === 'sand') {
      for (var d = 0; d < 5; d++) {
        s += '<circle cx="' + (100 + (d * 5) % 16) + '" cy="' + (y - d * 3) + '" r="1.2" fill="#a9742c"/>';
      }
      s += '<text x="128" y="' + (y + 4).toFixed(1) + '" font-size="8" fill="#a9742c" font-family="monospace">砂面 ' + md + ' m</text>';
    } else if (q.fault === 'water') {
      s += '<rect x="94" y="' + (y - 3) + '" width="28" height="7" fill="#dbe8ef" stroke="#5f83a0" stroke-width=".8"/>';
      s += '<text x="128" y="' + (y + 4).toFixed(1) + '" font-size="8" fill="#355c74" font-family="monospace">出水层 ' + md + ' m</text>';
    } else {
      s += '<rect x="96" y="' + (y - 5) + '" width="24" height="10" rx="1" fill="#f4e8d4" stroke="#a9742c" stroke-width=".8"/>';
      s += '<text x="128" y="' + (y + 4).toFixed(1) + '" font-size="8" fill="#83551f" font-family="monospace">变形段 ' + md + ' m</text>';
    }

    /* 右侧数据面板 */
    s += '<line x1="242" y1="10" x2="242" y2="162" stroke="#e3dccd"/>';
    var rows1 = [
      ['井深', q.depth + ' m'],
      ['套管', casingLabel(q.idm)],
      ['含水', q.water + '%'],
      ['出砂', q.sand ? '是' : '否']
    ];
    var rows2 = [
      ['落物', isLitterFault(q.fault) ? q.form + ' φ' + q.size + ' mm' : '不适用'],
      ['处理深度', md + ' m'],
      ['当前工具', t ? t.name : '—'],
      ['工具外径', t && t.od ? t.od + ' mm / 最小通过 ' + t.minId + ' mm' : '—']
    ];
    function panel(x, title, rows) {
      var o = '<text x="' + x + '" y="18" font-size="7.5" font-family="monospace" fill="#99a3a4" letter-spacing=".8">' + title + '</text>';
      rows.forEach(function (r, i) {
        var yy = 34 + i * 21;
        o += '<text x="' + x + '" y="' + yy + '" font-size="7.5" font-family="monospace" fill="#99a3a4">' + r[0] + '</text>';
        o += '<text x="' + x + '" y="' + (yy + 11) + '" font-size="9.3" fill="#3f4a4d">' + esc(r[1]) + '</text>';
      });
      return o;
    }
    s += panel(258, '日报 → 井况', rows1);
    s += panel(416, '落物 → 当前工具', rows2);

    el('well').innerHTML = s;
    el('well-hint').textContent = '井深 ' + q.depth + ' m' +
      (md !== q.depth ? (' · 落物/砂面 ' + md + ' m') : '') + ' · ' + faultName(q.fault) +
      (isLitterFault(q.fault) ? (' · ' + q.form + ' φ' + q.size + ' mm') : '') +
      (t ? (' · ' + t.name) : '');
  }

  /* =========================================================
     9. 渲染：头部、01—05、模型、日志
     ========================================================= */
  function fieldSource(key, val) {
    var pf = LASTP && LASTP.fields ? LASTP.fields[key] : null;
    if (pf == null) return ['src-manual', '人工设定'];
    var eq = typeof val === 'number' && typeof pf === 'number' ? Math.abs(val - pf) < 0.05 : val === pf;
    return eq ? ['src-text', '文本抽取'] : ['src-over', '人工覆盖'];
  }

  function gateInfo() {
    var q = query(), p = LASTP;
    if (!p || p.text.trim().length < 16) return { k: 'bad', name: '退回补充', why: '日报过短，无法抽取故障与井况' };
    if (isLitterFault(q.fault) && q.size >= q.idm) return { k: 'bad', name: '退回核对', why: '落物外径 ' + q.size + ' mm ≥ 套管内径 ' + q.idm.toFixed(1) + ' mm，物理上不成立' };
    if (!p.fields.fault) return { k: 'warn', name: '降级', why: '未识别故障现象，沿用人工设定，检索结果需复核' };
    if (isLitterFault(q.fault) && (!p.fields.form || !p.fields.size)) return { k: 'warn', name: '降级', why: '缺落物形态或外径，工具硬约束不完整' };
    if (p.oddIdm) return { k: 'warn', name: '降级', why: '日报通径 ' + p.oddIdm + ' mm 与套管台账不一致，按变形后最小通径记录' };
    return { k: 'ok', name: '可用', why: '故障、井深与套管可定位' + (isLitterFault(q.fault) ? '，落物形态与外径齐全' : '') + '，进入检索' };
  }

  function renderHeader() {
    var top = model.hits[0];
    el('st-count').textContent = CASES.length;
    el('st-sim').textContent = top ? top.total.toFixed(2) : '—';
    el('st-ent').textContent = LASTP ? LASTP.ents.length : '—';
    var r = model.evalr;
    el('st-hit').innerHTML = r && r.n ? (Math.round(r.c3 / r.n * 100) + '<small>%</small>') : '—';
  }

  function renderStage0(p) {
    el('rpt-count').textContent = state.text.length + ' 字';
    var fe = null;
    p.ents.forEach(function (e) { if (!fe && e.type === 'fault') fe = e; });
    el('q-text').innerHTML = '<b>' + p.ents.length + '</b> 实体 · 故障 <b>' + (fe ? faultName(fe.ref) : '未识别') + '</b>' +
      (fe ? ' ' + fe.conf.toFixed(2) : '') + ' · 覆盖 <b>' + pct(p.coverage) + '%</b> · ' + p.ms.toFixed(1) + ' ms';

    var litter = isLitterFault(state.fault);
    var need = ['fault', 'depth', 'idm', 'water', 'sand'].concat(litter ? ['form', 'size'] : []);
    var got = 0, miss = [];
    var FIELD_LABEL = { fault: '故障', depth: '井深', idm: '套管', water: '含水', sand: '出砂', form: '形态', size: '外径' };
    need.forEach(function (k) { if (p.fields[k] != null) got++; else miss.push(FIELD_LABEL[k]); });
    el('q-fields').innerHTML = '<b>' + got + ' / ' + need.length + '</b> 项' +
      (miss.length ? ('（未提及：' + miss.join('、') + '，按当前设定）') : (litter ? '（含落物 2 项）' : ''));

    el('q-phys').innerHTML = litter
      ? ('落物 φ' + state.size + ' mm ' + (state.size < state.idm ? '<span class="db ok">&lt; 通径 ' + state.idm.toFixed(1) + ' ✓</span>' : '<span class="db bad">≥ 通径 ' + state.idm.toFixed(1) + ' ✗</span>'))
      : '<span class="muted">不涉及落物尺寸</span>';

    var g = gateInfo();
    el('q-gate').innerHTML = '<span class="db ' + g.k + '">' + g.name + '</span> <span class="muted" style="font-size:8.5px">' + esc(g.why) + '</span>';

    var rows = [
      ['故障', faultName(state.fault), 'fault', state.fault],
      ['井深', state.depth + ' m', 'depth', state.depth],
      ['套管', casingLabel(state.idm), 'idm', state.idm],
      ['含水', state.water + '%', 'water', state.water],
      ['出砂', state.sand ? '是' : '否', 'sand', state.sand],
      ['形态', litter ? state.form : '—', 'form', litter ? state.form : null],
      ['外径', litter ? state.size + ' mm' : '—', 'size', litter ? state.size : null]
    ];
    el('fields').innerHTML = rows.map(function (r) {
      var src = (r[2] === 'form' || r[2] === 'size') && !litter ? ['', '—'] : fieldSource(r[2], r[3]);
      return '<div class="frow"><span class="fk">' + r[0] + '</span><span class="fv">' + esc(r[1]) + '</span>' +
        '<span class="fs ' + src[0] + '">' + src[1] + '</span></div>';
    }).join('');

    var rules = [];
    rules.push({ ok: !!p.fields.fault, t: p.fields.fault ? ('故障实体命中：' + faultName(p.fields.fault)) : '未识别故障现象，检索只能用人工设定' });
    rules.push({ ok: !!(p.fields.depth && p.fields.idm && (!litter || (p.fields.form && p.fields.size))),
      t: (p.fields.depth && p.fields.idm ? ('井深与套管可定位：' + p.fields.depth + ' m / ' + p.fields.idm.toFixed(1) + ' mm') : '井深或套管通径缺失，井筒尺度不可核') +
        (litter ? (p.fields.form && p.fields.size ? ('；落物 ' + p.fields.form + ' φ' + p.fields.size + ' mm') : '；落物形态或外径缺失') : '') });
    rules.push({ ok: !(litter && state.size >= state.idm), t: litter ? (state.size < state.idm ? '物理一致性通过：落物小于套管内径' : '物理一致性失败：落物外径大于套管内径') : '不涉及落物尺寸的物理一致性' });
    if (p.oddIdm) rules.push({ warn: true, t: '检测到非标准通径 ' + p.oddIdm + ' mm，按变形后最小通径记录，不覆盖套管规格' });
    el('qc-rules').innerHTML = rules.map(function (r) {
      return '<div class="qrule ' + (r.ok ? '' : (r.warn ? 'warn' : 'bad')) + '"><span class="qi">' +
        (r.ok ? '✓' : (r.warn ? '!' : '×')) + '</span><span>' + esc(r.t) + '</span></div>';
    }).join('');
  }

  function renderHighlight(p) {
    var text = p.text;
    var col = new Array(text.length);
    var ents = p.ents.slice().sort(function (a, b) {
      return (b.end - b.start) - (a.end - a.start) || b.conf - a.conf;
    });
    ents.forEach(function (e) {
      var free = true;
      for (var i = e.start; i < e.end; i++) if (col[i]) { free = false; break; }
      if (!free) return;
      for (var j = e.start; j < e.end; j++) col[j] = e.type;
    });
    var out = '', i = 0;
    while (i < text.length) {
      if (!col[i]) { out += esc(text.charAt(i)); i++; continue; }
      var j = i;
      while (j < text.length && col[j] === col[i]) j++;
      out += '<mark class="' + ETYPE[col[i]].cls + '">' + esc(text.slice(i, j)) + '</mark>';
      i = j;
    }
    el('hl').innerHTML = out || '<span class="muted">没有文本。</span>';

    el('hl-legend').innerHTML = TYPE_ORDER.map(function (k) {
      var n = p.ents.filter(function (e) { return e.type === k; }).length;
      return '<span><i style="background:' + ETYPE[k].color + '33;border-color:' + ETYPE[k].color + '"></i>' + ETYPE[k].name + ' ' + n + '</span>';
    }).join('');
  }

  function renderStage1(p) {
    renderHighlight(p);
    el('ent-hint').textContent = p.ents.length + ' 实体 · 词典 ' + p.nDict + ' / 正则 ' + p.nRegex + ' · 覆盖 ' + pct(p.coverage) + '%';
    var buckets = { left: '', right: '' };
    TYPE_ORDER.forEach(function (type) {
      var es = p.ents.filter(function (e) { return e.type === type; });
      if (!es.length) return;
      var html = '<div class="eg-h"><i style="background:' + ETYPE[type].color + '"></i><b>' + ETYPE[type].name + '</b>' + es.length + '</div>';
      var shown = {};
      es.forEach(function (e) {
        var id = e.type + ':' + e.label;
        if (shown[id]) return;
        shown[id] = 1;
        var src = e.method === 'dict' ? '词' : '正';
        var same = e.surface === e.label;
        html += '<div class="er">' +
          (same
            ? '<span class="es same" title="' + esc(e.label) + '">' + esc(e.label) + '</span>'
            : '<span class="es" title="' + esc(e.surface) + '">' + esc(e.surface) + '</span>' +
              '<span class="ea" title="' + esc(e.label) + '"><b>' + esc(e.label) + '</b></span>') +
          '<span class="em">' + src + '</span><span class="ec">' + pct(e.conf) + '%</span></div>';
      });
      if (type === 'fault' || type === 'well') buckets.left += html;
      else buckets.right += html;
    });
    el('ents').innerHTML = p.ents.length
      ? '<div class="entcol">' + buckets.left + '</div><div class="entcol">' + buckets.right + '</div>'
      : '<p class="empty">未抽取到实体。检查日报里是否写清故障、井深、套管与落物。</p>';
  }

  function renderStage2() {
    var q = query();
    var hit = currentHit();
    if (model.blocked) {
      el('hits').innerHTML = '<tr><td colspan="5" class="empty">质控退回：检索与方案组装未执行。补全故障、井深、套管通径与落物信息后重跑。</td></tr>';
      el('excluded-note').innerHTML = '';
      el('sim').innerHTML = '<p class="empty">输入未通过物理一致性校验，相似度与候选方案不计算——避免用不可能的数据凑出一个「看起来合理」的方案。</p>';
      return;
    }
    el('hits').innerHTML = model.hits.map(function (h, i) {
      var t = toolByKey(h.c.tool);
      var sel = h.c.id === state.selCase;
      return '<tr data-case="' + h.c.id + '" class="' + (sel ? 'sel' : '') + '">' +
        '<td><span class="cid">' + pad2(i + 1) + ' ' + h.c.id + '</span><div class="csub">' + (h.issue ? '<span class="excl">排除 · ' + shortIssue(h.issue) + '</span>' : effectName(h.c.effect)) + '</div></td>' +
        '<td>' + t.name + '<div class="csub">' + procName(t.proc) + ' · 成功率 ' + h.c.succ.toFixed(2) + '</div></td>' +
        '<td class="num">' + h.sim.toFixed(2) + '</td>' +
        '<td class="num">' + h.text.toFixed(2) + '</td>' +
        '<td class="num"><b>' + h.total.toFixed(2) + '</b></td></tr>';
    }).join('') || '<tr><td colspan="5" class="empty">当前故障族没有历史案例。</td></tr>';

    var excluded = model.hits.filter(function (h) { return h.issue; });
    el('excluded-note').innerHTML = excluded.length
      ? ('硬约束排除 ' + excluded.length + ' 条：' + excluded.map(function (h) {
        return h.c.id + '（' + toolByKey(h.c.tool).name + '，' + issueLabel(h.issue) + '）';
      }).join('；'))
      : '';

    if (!hit) {
      el('sim').innerHTML = '<p class="empty">当前没有选中的同族案例。</p>';
      return;
    }
    var parts = hit.parts.map(function (x) {
      return '<div class="fbar' + (x.w === 0 ? ' zero' : '') + '"><span class="lbl">' + FEATURE_LABEL[x.key] + '</span>' +
        '<span class="track"><i style="width:' + (x.v * 100).toFixed(1) + '%"></i></span>' +
        '<span class="val">p ' + x.p.toFixed(2) + ' · w ' + x.w.toFixed(2) + ' · <b>' + x.v.toFixed(2) + '</b></span></div>';
    }).join('');
    var qv = makeQueryVec(state.text);
    var td = textDetail(qv, hit.c._vec);
    var terms = td.terms.map(function (x) {
      return '<span class="tm">' + esc(tokenLabel(x.t)) + '</span><span class="w">' + x.q.toFixed(2) + '</span>' +
        '<span class="w">' + x.d.toFixed(2) + '</span><span class="w"><b>' + x.p.toFixed(3) + '</b></span>';
    }).join('');
    if (!td.terms.length) {
      terms = '<span class="tm muted">无共享词元</span><span class="w">—</span><span class="w">—</span><span class="w">0</span>';
    }
    var t = toolByKey(hit.c.tool);
    var chain = planChain(hit.c.fault, t.proc);
    var path = '<span class="pc hot">' + faultName(hit.c.fault) + '</span><span class="ar">→</span>' +
      '<span class="pc">' + chain.map(procName).join(' / ') + '</span><span class="ar">→</span>' +
      '<span class="pc hot">' + t.name + '</span><span class="ar">→</span><span class="pc hot">' + hit.c.id + '</span>';

    el('sim').innerHTML =
      '<div class="simhead">案例 <b>' + hit.c.id + '</b> · ' + t.name + ' · 综合 <b>' + hit.total.toFixed(3) + '</b>' +
      ' <span class="simnote">结构 ' + hit.sim.toFixed(2) + ' / 文本 ' + hit.text.toFixed(2) + '</span></div>' +
      '<div class="fbar" style="border-bottom:1px solid var(--line);padding-bottom:2px;margin-bottom:1px"><span class="lbl">结构分项</span><span></span><span class="val">p · w · w·p</span></div>' +
      parts +
      '<div class="formula">综合 = (1−' + state.beta.toFixed(2) + ') × 结构 <b>' + hit.sim.toFixed(3) + '</b> + ' +
      state.beta.toFixed(2) + ' × 文本 <b>' + hit.text.toFixed(3) + '</b> = <b>' + hit.total.toFixed(3) + '</b></div>' +
      '<div class="tterms"><span class="th">共享词元</span><span class="th w">查询</span><span class="th w">案例</span><span class="th w">贡献</span>' + terms + '</div>' +
      '<div class="pathline">' + path + '</div>' +
      (model.evalr ? '<div class="formula">留一案例（n=' + model.evalr.n + '）：合成 Hit@1 <b>' + pct(model.evalr.c1 / model.evalr.n) +
        '%</b> / Hit@3 <b>' + pct(model.evalr.c3 / model.evalr.n) + '%</b> · 结构 ' + pct(model.evalr.s1 / model.evalr.n) + '/' + pct(model.evalr.s3 / model.evalr.n) +
        '% · 文本 ' + pct(model.evalr.t1 / model.evalr.n) + '/' + pct(model.evalr.t3 / model.evalr.n) + '%</div>' : '') +
      (hit.issue ? '<div class="excluded" style="margin-top:4px">该案例被硬约束排除：' + esc(hit.issue) + '。它仍作为检索证据，但不进入候选方案。</div>' : '');
  }

  function renderStage3() {
    var q = query(), plan = selectedPlan(), main = model.plans[0];
    if (!plan) {
      el('plan-main').innerHTML = '<p class="empty">' + (model.blocked
        ? '质控退回：01 日报未通过物理一致性校验，04 方案组装未执行。'
        : '当前井况没有工具通过通径 / 落物尺寸硬约束，无法组装方案。请核对套管规格、落物形态与外径。') + '</p>';
      el('alts').innerHTML = '';
      el('risks').innerHTML = '';
      el('plan-hint').textContent = model.blocked ? '质控退回 · 未组装' : '无可用方案';
      return;
    }
    var isMain = !main || plan === main;
    var idx = model.plans.indexOf(plan);
    var t = toolByKey(plan.tool);
    var steps = stepsFor(plan, q);
    var risks = risksFor(plan, q);
    var succ = plan.succMin === plan.succMax ? plan.succ.toFixed(2) : plan.succMin.toFixed(2) + '—' + plan.succMax.toFixed(2);
    var days = plan.dmin === plan.dmax ? fmtDays(plan.dmin) + ' 天' : fmtDays(plan.dmin) + '—' + fmtDays(plan.dmax) + ' 天';

    el('plan-hint').textContent = isMain ? '当前：主方案' : ('当前：备选 ' + pad2(idx + 1) + ' · 与主方案有差异');

    el('plan-main').innerHTML =
      '<div class="plancard">' +
      '<div class="planhead"><span class="rank">' + pad2(idx + 1) + '</span><b>' + t.name + ' · ' + procName(plan.proc) + '</b>' +
      '<span class="db ' + (isMain ? 'ok' : 'warn') + '">' + (isMain ? '主方案' : '备选') + '</span>' +
      '<span class="score">综合 ' + plan.sim.toFixed(2) + ' · 成功率 ' + plan.succ.toFixed(2) + '</span></div>' +
      '<div class="ptags"><span class="db plain">' + faultName(plan.fault) + '</span><span class="db plain">' + procName(plan.proc) + '</span>' +
      '<span class="db ok">硬约束通过</span><span class="db plain">证据 ' + plan.n + ' 井次</span></div>' +
      '<p class="pm">证据：<b>' + plan.cases.map(function (h) { return h.c.id; }).join('、') + '</b> · 历史成功率 ' + succ + ' · 工期 ' + days + '</p>' +
      (isMain ? '' : '<div class="diffbox"><b>与主方案差异：</b>' + esc(planDiff(plan, main, q)) + '</div>') +
      '<ol class="steps">' + steps.map(function (s, i) {
        return '<li><span class="sn">' + (i + 1) + '</span><div class="sb"><b>' + esc(s.name) + '</b>' +
          (s.tool ? '<span class="stool">' + esc(s.tool) + '</span>' : '') +
          '<span class="sd">' + esc(s.text) + '</span></div></li>';
      }).join('') + '</ol>' +
      '<div class="toolcombo"><b>工具组合：</b>' + comboFor(plan).map(esc).join(' + ') + '</div>' +
      '<div class="toolcombo"><b>校核：</b>' + esc(toolCheckText(t, q)) + '</div>' +
      '</div>';

    el('alts').innerHTML = model.plans.map(function (p, i) {
      if (p === plan) return '';
      var pt = toolByKey(p.tool);
      var isPmain = i === 0;
      return '<div class="alt' + (p === plan ? ' sel' : '') + '" data-plan="' + i + '" tabindex="0" role="button">' +
        '<div class="alt-h"><span class="rank">' + pad2(i + 1) + '</span><b>' + pt.name + ' · ' + procName(p.proc) + '</b>' +
        '<span class="db ' + (isPmain ? 'ok' : 'plain') + '">' + (isPmain ? '主方案' : '备选') + '</span>' +
        '<span class="score">综合 ' + p.sim.toFixed(2) + '</span></div>' +
        '<div class="alt-d">' + (isPmain ? '当前主方案；点击切回。' : esc(planDiff(p, main, q))) + '</div>' +
        '<div class="alt-t">选用条件：' + esc(toolHint(pt)) + '；证据 ' + p.n + ' 井次，成功率 ' + p.succ.toFixed(2) + '。</div></div>';
    }).join('') || '<p class="empty">没有其他通过硬约束的候选。</p>';

    var evidenceTools = {};
    model.plans.forEach(function (p) { evidenceTools[p.tool] = 1; });
    var noEv = TOOLS.filter(function (x) {
      return x.faults.indexOf(q.fault) >= 0 && !x.aux && !toolIssue(x, q) && !evidenceTools[x.key];
    });
    if (noEv.length) {
      el('alts').innerHTML += '<div class="alt-d" style="border-top:1px dashed var(--line);padding-top:4px;margin-top:5px">' +
        '另有 <b>' + noEv.map(function (x) { return x.name; }).join('、') + '</b> 通过硬约束，但同故障族没有历史案例，' +
        '无法给出证据排序；需专家评估或补录案例后再进入候选。</div>';
    }

    el('risks').innerHTML = risks.map(function (r) {
      return '<div class="risk"><span class="rl ' + (r.lv === '高' ? 'high' : 'mid') + '">' + r.lv + '</span>' +
        '<span class="rt"><b>' + esc(r.title) + '</b>：' + esc(r.text) + '</span></div>';
    }).join('');
  }

  function renderStage4() {
    var r = model.evalr, top = model.hits[0];
    var live = [
      ['日报解析', (LASTP ? LASTP.ms.toFixed(1) : '—') + ' ms', '词典 + 正则'],
      ['检索耗时', model.searchMs.toFixed(1) + ' ms', '16 份报告 · 本页'],
      ['留一 Hit@3', r && r.n ? (pct(r.c3 / r.n) + '%') : '—', '合成排序'],
      ['Top-1 综合', top ? top.total.toFixed(3) : '—', '结构 + 文本']
    ];
    el('live-stats').innerHTML = live.map(function (x) {
      return '<div><div class="k">' + x[0] + '</div><div class="v">' + x[1] + '</div><div class="s">' + x[2] + '</div></div>';
    }).join('');

    var total = fb.adopt + fb.modify + fb.reject;
    el('fb-note').innerHTML = '本轮回写 <b>' + total + '</b> 条 · 采纳 ' + fb.adopt + ' / 修改 ' + fb.modify + ' / 驳回 ' + fb.reject +
      (total ? (' · 采纳率 <b>' + pct(fb.adopt / total) + '%</b>') : '') + ' · 待审队列不参与本轮检索';

    el('wb').innerHTML = fb.pending.length ? fb.pending.slice(0, 4).map(function (w) {
      var cls = w.kind === 'adopt' ? 'adopt' : w.kind === 'modify' ? 'modify' : 'reject';
      var label = w.kind === 'adopt' ? '采纳' : w.kind === 'modify' ? '修改' : '驳回';
      return '<div class="wr"><span class="wid">' + w.id + '</span><span>' + esc(w.title) + '<br><span style="font-family:var(--mono);font-size:7.5px;color:var(--ink-4)">' +
        esc(w.caseId) + ' · ' + esc(w.note) + '</span></span><span class="wk ' + cls + '">' + label + '</span></div>';
    }).join('') : '<div class="wempty">暂无回写。点上方「采纳 / 修改后采纳 / 驳回」模拟人工确认。</div>';
  }

  function renderModel() {
    var r = model.evalr;
    el('m-kb').innerHTML = CASES.length + ' 井次案例 · ' + CASES.length + ' 份作业总结 · ' + TOOLS.length + ' 件工具台账' +
      (fb.pending.length ? ' · 待审 ' + fb.pending.length : '');
    el('m-nlp').innerHTML = '词典 ' + LEX.length + ' 条 + ' + RE_REGEX_COUNT + ' 组正则 · 最长匹配 + 同义词归一';
    el('m-ret').innerHTML = '7 维分故障加权结构 + TF-IDF 余弦（' + VOCAB + ' 词元）· β = ' + state.beta.toFixed(2);
    el('m-val').innerHTML = r && r.n
      ? ('留一案例 ' + r.n + ' 次 · 工艺 Hit@1 <b>' + pct(r.c1 / r.n) + '%</b> / Hit@3 <b>' + pct(r.c3 / r.n) + '%</b>（结构 ' +
        pct(r.s1 / r.n) + '/' + pct(r.s3 / r.n) + '% · 文本 ' + pct(r.t1 / r.n) + '/' + pct(r.t3 / r.n) + '%）')
      : '—';
  }

  function noteText() {
    var g = gateInfo(), plan = selectedPlan(), hit = currentHit(), top = model.hits[0];
    if (g.k === 'bad') return '日报停在 01：' + g.why + '。流程不会用不合格输入凑方案；补全故障、井深、套管与落物信息后重跑。';
    if (!plan) return '当前故障族有 ' + model.hits.length + ' 条历史案例，但没有工具通过通径 / 落物尺寸硬约束，无法组装候选方案。';
    var s = '日报抽出 <b>' + (LASTP ? LASTP.ents.length : 0) + '</b> 个实体 → 同族 <b>' + model.hits.length +
      '</b> 条案例 → Top-1 <b>' + (top ? top.c.id : '—') + '</b> 综合 <b>' + (top ? top.total.toFixed(2) : '—') +
      '</b>（结构 ' + (top ? top.sim.toFixed(2) : '—') + ' × ' + (1 - state.beta).toFixed(2) + ' + 文本 ' + (top ? top.text.toFixed(2) : '—') + ' × ' + state.beta.toFixed(2) + '）。';
    s += '主方案：<b>' + toolByKey(plan.tool).name + ' · ' + procName(plan.proc) + '</b>，' + stepsFor(plan, query()).length +
      ' 道工序，' + risksFor(plan, query()).length + ' 条风险提醒。';
    if (hit && hit.issue) s += ' 当前选中的 <b>' + hit.c.id + '</b> 被硬约束排除（' + esc(hit.issue) + '），只作证据，不进入方案。';
    if (g.k === 'warn') s += ' <b>质控降级：</b>' + esc(g.why) + '。';
    if (LASTP && LASTP.fields.fault && LASTP.fields.fault !== state.fault) {
      s += ' 人工把故障从「' + faultName(LASTP.fields.fault) + '」改为「' + faultName(state.fault) + '」，检索按人工值执行。';
    }
    return s;
  }

  function renderAll() {
    renderStage0(LASTP);
    renderStage1(LASTP);
    renderStage2();
    renderStage3();
    renderStage4();
    drawGraph();
    drawWell();
    renderHeader();
    renderModel();
    renderGStrip(LASTP);
    var g = gateInfo();
    var note = el('note');
    note.className = 'dnote' + (g.k === 'ok' ? ' ok' : g.k === 'bad' ? ' bad' : '');
    note.innerHTML = noteText();
  }

  function renderGStrip(p) {
    if (!p || !p.ents.length) {
      el('gstrip').innerHTML = '<span class="ec">未抽到实体 · 检查日报文本</span>';
      return;
    }
    var pick = [], seen = {};
    ['fault', 'tool', 'well'].forEach(function (type) {
      p.ents.forEach(function (e) {
        var id = type + ':' + e.label;
        if (e.type === type && pick.length < 4 && !seen[id]) { seen[id] = 1; pick.push(e); }
      });
    });
    el('gstrip').innerHTML = pick.map(function (e) {
      return '<span class="ec">' + esc(e.surface) + ' → <b>' + esc(e.label) + '</b> ' + e.conf.toFixed(2) + '</span>';
    }).join('') + '<span class="ec">全部 ' + p.ents.length + ' 个实体见 02</span>';
  }

  /* =========================================================
     10. 同步与交互
     ========================================================= */
  function sync() {
    model.q = query();
    var g = gateInfo();
    model.blocked = g.k === 'bad';
    if (model.blocked) {
      model.hits = [];
      model.plans = [];
      model.map = {};
      model.searchMs = 0;
      model.evalr = evalRetrieval();
      state.selPlan = -1;
      state.selCase = null;
      renderAll();
      return;
    }
    model.hits = search(model.q, state.text);
    model.plans = buildPlans(model.hits, model.q);
    model.map = {};
    model.hits.forEach(function (h) { model.map[h.c.id] = h; });
    model.evalr = evalRetrieval();

    if (state.selCase && !model.map[state.selCase]) state.selCase = null;
    if (!state.selCase) {
      state.selCase = model.plans.length ? model.plans[0].cases[0].c.id
        : (model.hits.length ? model.hits[0].c.id : null);
    }
    if (state.selPlan >= model.plans.length) state.selPlan = model.plans.length - 1;
    renderAll();
  }

  function onQueryChange() {
    state.selPlan = 0;
    state.selCase = null;
    sync();
  }

  function applyParsed(p) {
    var f = p.fields;
    if (f.fault) state.fault = f.fault;
    if (f.depth != null) state.depth = clamp(Math.round(f.depth), 1000, 3600);
    if (f.markDepth != null) state.markDepth = clamp(Math.round(f.markDepth), 1000, 3600);
    else state.markDepth = state.depth;
    if (f.idm != null) state.idm = f.idm;
    if (f.water != null) state.water = clamp(Math.round(f.water), 0, 100);
    if (f.sand != null) state.sand = !!f.sand;
    if (f.form) state.form = f.form;
    if (f.size != null) state.size = clamp(Math.round(f.size), 10, 140);
  }

  function parseAndApply(log) {
    var p = parseReport(state.text);
    LASTP = p;
    applyParsed(p);
    syncControls();
    onQueryChange();
    if (log) {
      trace('文本', state.text.length + ' 字 → <b>' + p.ents.length + '</b> 实体（词典 ' + p.nDict + ' / 正则 ' + p.nRegex +
        '）· 故障 <b>' + (p.fields.fault ? faultName(p.fields.fault) : '未识别') + '</b> · 覆盖 ' + pct(p.coverage) + '%');
    }
  }

  function syncControls() {
    [].forEach.call(el('seg-fault').children, function (b) {
      var on = b.getAttribute('data-f') === state.fault;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    [].forEach.call(el('seg-id').children, function (b) {
      var on = Math.abs(Number(b.getAttribute('data-v')) - state.idm) < 0.05;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    el('r-depth').value = state.depth;
    el('r-water').value = state.water;
    el('r-size').value = state.size;
    el('r-beta').value = state.beta;
    el('o-depth').textContent = state.depth + ' m';
    el('o-water').textContent = state.water + '%';
    el('o-size').textContent = state.size + ' mm';
    el('o-beta').textContent = state.beta.toFixed(2);
    el('sel-form').value = state.form;

    var litter = isLitterFault(state.fault);
    el('sel-form').disabled = !litter;
    el('r-size').disabled = !litter;
    el('litter-hint').textContent = litter ? '仅落物/断脱类参与相似度' : '当前故障不适用落物尺寸';
    el('litter-hint').classList.toggle('off', !litter);
    el('grp-litter').classList.toggle('off', !litter);

    el('tog-sand').classList.toggle('on', state.sand);
    el('tog-sand').setAttribute('aria-checked', state.sand ? 'true' : 'false');
    el('rpt-count').textContent = state.text.length + ' 字';
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
      if (model.plans[i].cases.some(function (x) { return x.c.id === id; })) { state.selPlan = i; break; }
    }
    renderAll();
  }

  function selectTool(key) {
    var h = null;
    for (var i = 0; i < model.hits.length; i++) if (model.hits[i].c.tool === key) { h = model.hits[i]; break; }
    if (!h) {
      el('note').innerHTML = '示范库暂无「' + esc(toolByKey(key).name) + '」的作业证据；工具台账规格仍可在方案校核里查看。';
      return;
    }
    selectHit(h.c.id);
  }
  function selectProc(key) {
    var h = null;
    for (var i = 0; i < model.hits.length; i++) if (toolByKey(model.hits[i].c.tool).proc === key) { h = model.hits[i]; break; }
    if (!h) {
      el('note').innerHTML = '当前故障族没有「' + esc(procName(key)) + '」的历史案例。';
      return;
    }
    selectHit(h.c.id);
  }

  /* ---------- 过程日志 ---------- */
  var TRACE = [];
  function trace(step, html, cls) {
    TRACE.push({ step: step, html: html, cls: cls || '' });
    if (TRACE.length > 8) TRACE.shift();
    var box = el('trace');
    box.innerHTML = TRACE.map(function (t) {
      return '<div><span class="t">' + t.step + '</span><span class="' + t.cls + '">' + t.html + '</span></div>';
    }).join('');
    box.scrollTop = box.scrollHeight;
  }
  function clearTrace() {
    TRACE = [];
    el('trace').innerHTML = '<div><span class="t">—</span><span>等待运行：在 01 粘贴日报或点示例，再点「运行全流程」。</span></div>';
  }

  /* ---------- 阶段控制 / 全流程 ---------- */
  var STAGE_LABEL = ['01 输入', '02 NLP', '03 检索', '04 方案', '05 闭环'];
  var runTimers = [];
  function cancelRun() {
    runTimers.forEach(function (t) { clearTimeout(t); });
    runTimers = [];
    var btn = el('btn-run');
    if (btn) { btn.disabled = false; btn.textContent = '▶ 运行全流程'; }
  }
  function setStage(i, log) {
    state.stage = i;
    [].forEach.call(document.querySelectorAll('.dstage'), function (p) {
      p.classList.toggle('on', Number(p.getAttribute('data-stage')) === i);
    });
    [].forEach.call(el('flow').children, function (b, idx) {
      b.classList.toggle('on', idx === i);
      b.classList.toggle('done', idx < i);
      b.setAttribute('aria-selected', idx === i ? 'true' : 'false');
    });
    if (log) trace(STAGE_LABEL[i].slice(0, 2), log);
  }

  function runAll() {
    cancelRun();
    renderAll();
    clearTrace();
    var btn = el('btn-run');
    btn.disabled = true;
    btn.textContent = '运行中…';
    var p = LASTP, g = gateInfo(), plan = selectedPlan(), top = model.hits[0], r = model.evalr;
    var fe = null;
    p.ents.forEach(function (e) { if (!fe && e.type === 'fault') fe = e; });
    var steps = [
      ['01', '读取日报 <b>' + state.text.length + ' 字</b> · 质控 <b>' + g.name + '</b> · 抽到 <b>' + p.ents.length + '</b> 个实体 · 故障 <b>' + faultName(state.fault) + '</b>'],
      ['02', '词典 + 正则命中 <b>' + p.ents.length + '</b> 实体（词典 ' + p.nDict + ' / 正则 ' + p.nRegex + '）· 故障 <b>' +
        (fe ? faultName(fe.ref) + ' ' + fe.conf.toFixed(2) : '未识别') + '</b> · 覆盖 ' + pct(p.coverage) + '%'],
      ['03', '同族 <b>' + model.hits.length + '</b> 条 → 结构 ' + (top ? top.sim.toFixed(2) : '—') + ' + 文本 ' + (top ? top.text.toFixed(2) : '—') +
        ' → Top-1 <b>' + (top ? top.c.id + ' ' + top.total.toFixed(2) : '—') + '</b> · 留一 Hit@3 <b>' + (r && r.n ? pct(r.c3 / r.n) : '—') + '%</b>'],
      ['04', plan ? ('主方案 <b>' + toolByKey(plan.tool).name + ' · ' + procName(plan.proc) + '</b> · ' + stepsFor(plan, query()).length +
        ' 道工序 · 证据 ' + plan.n + ' 井次 · 风险 ' + risksFor(plan, query()).length + ' 条') : '没有工具通过硬约束，无法组装方案'],
      ['05', '回写 <b>' + (fb.adopt + fb.modify + fb.reject) + '</b> 条 · 1200 井次/年 · 3 h → 20 min · 复用率 68% · 重复率 下降 35%']
    ];
    [0, 800, 1600, 2400, 3200].forEach(function (delay, i) {
      runTimers.push(setTimeout(function () {
        setStage(i, null);
        trace(steps[i][0], steps[i][1]);
        if (i === steps.length - 1) {
          runTimers.push(setTimeout(function () {
            btn.disabled = false;
            btn.textContent = '▶ 重新运行';
            trace('✓', '流水线完成：从一段日报到一套带证据、工序与风险提示的施工方案。', 'ok');
          }, 700));
        }
      }, delay));
    });
  }

  /* ---------- 静态控件 ---------- */
  el('seg-fault').innerHTML = FAULTS.map(function (f) {
    return '<button type="button" data-f="' + f.key + '" aria-pressed="false" title="' + esc(f.note) + '">' + f.name + '</button>';
  }).join('');
  el('seg-id').innerHTML = CASINGS.map(function (c) {
    return '<button type="button" data-v="' + c.idm + '" aria-pressed="false" title="' + esc(c.label + ' · 通径 ' + c.idm.toFixed(1) + ' mm') + '">' +
      c.label + '<span class="seg-sub">' + c.sub + '</span></button>';
  }).join('');
  el('examples').innerHTML += EXAMPLE_TEXT.map(function (x, i) {
    return '<button type="button" data-ex="' + i + '">' + x.name + '</button>';
  }).join('') + '<button type="button" class="dbtn" id="btn-parse">↻ 解析并重算</button>';

  /* ---------- 事件 ---------- */
  el('seg-fault').addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button') : null;
    if (!b) return;
    cancelRun();
    state.fault = b.getAttribute('data-f');
    state.markDepth = state.depth;
    syncControls();
    onQueryChange();
  });
  el('seg-id').addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button') : null;
    if (!b) return;
    cancelRun();
    state.idm = Number(b.getAttribute('data-v'));
    syncControls();
    onQueryChange();
  });
  el('r-depth').addEventListener('input', function () {
    cancelRun();
    state.depth = Number(el('r-depth').value);
    state.markDepth = state.depth;
    el('o-depth').textContent = state.depth + ' m';
    onQueryChange();
  });
  el('r-water').addEventListener('input', function () {
    cancelRun();
    state.water = Number(el('r-water').value);
    el('o-water').textContent = state.water + '%';
    onQueryChange();
  });
  el('r-size').addEventListener('input', function () {
    cancelRun();
    state.size = Number(el('r-size').value);
    el('o-size').textContent = state.size + ' mm';
    onQueryChange();
  });
  el('sel-form').addEventListener('change', function () {
    cancelRun();
    state.form = el('sel-form').value;
    onQueryChange();
  });
  el('tog-sand').addEventListener('click', function () {
    cancelRun();
    state.sand = !state.sand;
    syncControls();
    onQueryChange();
  });
  el('r-beta').addEventListener('input', function () {
    cancelRun();
    state.beta = Number(el('r-beta').value);
    el('o-beta').textContent = state.beta.toFixed(2);
    onQueryChange();
  });
  el('btn-reset').addEventListener('click', function () {
    cancelRun();
    state.fault = STATE_DEFAULT.fault;
    state.idm = STATE_DEFAULT.idm;
    state.depth = STATE_DEFAULT.depth;
    state.markDepth = STATE_DEFAULT.markDepth;
    state.water = STATE_DEFAULT.water;
    state.sand = STATE_DEFAULT.sand;
    state.form = STATE_DEFAULT.form;
    state.size = STATE_DEFAULT.size;
    state.text = EXAMPLE_TEXT[0].text;
    state.beta = 0.3;
    el('rpt').value = state.text;
    el('r-beta').value = '0.3';
    fb = { adopt: 0, modify: 0, reject: 0, pending: [], seq: 0 };
    [].forEach.call(el('examples').querySelectorAll('[data-ex]'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-ex') === '0');
    });
    setStage(0, false);
    clearTrace();
    parseAndApply(false);
    trace('系统', '已重置：日报回到「落物」示例，参数与回写计数清零。');
  });

  var textTimer = null;
  el('rpt').addEventListener('input', function () {
    cancelRun();
    state.text = el('rpt').value;
    el('rpt-count').textContent = state.text.length + ' 字';
    [].forEach.call(el('examples').querySelectorAll('[data-ex]'), function (b) { b.classList.remove('on'); });
    clearTimeout(textTimer);
    textTimer = setTimeout(function () { parseAndApply(false); }, 320);
  });

  el('examples').addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button') : null;
    if (!b) return;
    if (b.id === 'btn-parse') {
      cancelRun();
      parseAndApply(true);
      return;
    }
    var i = Number(b.getAttribute('data-ex'));
    if (isNaN(i)) return;
    cancelRun();
    state.text = EXAMPLE_TEXT[i].text;
    el('rpt').value = state.text;
    [].forEach.call(el('examples').querySelectorAll('[data-ex]'), function (x) {
      x.classList.toggle('on', x === b);
    });
    parseAndApply(true);
  });

  el('hits').addEventListener('click', function (e) {
    var tr = e.target.closest ? e.target.closest('tr[data-case]') : null;
    if (!tr) return;
    selectHit(tr.getAttribute('data-case'));
  });

  el('alts').addEventListener('click', function (e) {
    var d = e.target.closest ? e.target.closest('[data-plan]') : null;
    if (!d) return;
    selectPlan(Number(d.getAttribute('data-plan')));
  });
  el('alts').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var d = e.target.closest ? e.target.closest('[data-plan]') : null;
    if (!d) return;
    e.preventDefault();
    selectPlan(Number(d.getAttribute('data-plan')));
  });

  el('feedback').addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button[data-fb]') : null;
    if (!b) return;
    var plan = selectedPlan();
    if (!plan) return;
    var kind = b.getAttribute('data-fb');
    var t = toolByKey(plan.tool);
    var note = kind === 'modify' ? el('fb-mod').value : (kind === 'adopt' ? '按方案执行' : '不采用');
    var wbCase = plan.cases[0].c.id;
    fb[kind]++;
    fb.seq++;
    fb.pending.unshift({
      id: 'WB-' + pad2(fb.seq), kind: kind,
      title: wbCase + ' · ' + t.name + ' · ' + procName(plan.proc),
      caseId: wbCase, note: note
    });
    renderStage4();
    renderModel();
    trace('回写', kind === 'adopt'
      ? '人工采纳 <b>' + t.name + '</b> · 进入案例库待审队列（不参与本轮检索）'
      : kind === 'modify'
        ? '人工修改后采纳 · 修正类别 <b>' + esc(note) + '</b> · 进入工具/工序模板修正'
        : '人工驳回 · 进入错题集，下一轮优先复核同类案例', kind === 'adopt' ? 'ok' : kind === 'modify' ? 'warn' : 'bad');
  });

  el('flow').addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button') : null;
    if (!b) return;
    cancelRun();
    setStage(Number(b.getAttribute('data-s')), null);
  });

  el('btn-run').addEventListener('click', runAll);

  /* 图谱节点 */
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
        state.markDepth = state.depth;
        syncControls();
        onQueryChange();
      }
      return;
    }
    if (kind === 'tool') { selectTool(key); return; }
    if (kind === 'proc') { selectProc(key); return; }
    if (kind === 'case') { selectHit(key); }
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

  /* =========================================================
     11. 启动
     ========================================================= */
  el('rpt').value = state.text;
  [].forEach.call(el('examples').querySelectorAll('[data-ex]'), function (b) {
    b.classList.toggle('on', b.getAttribute('data-ex') === '0');
  });
  LASTP = parseReport(state.text);
  applyParsed(LASTP);
  syncControls();
  state.selPlan = 0;
  state.selCase = null;
  sync();
  setStage(0, false);
  clearTrace();
  trace('系统', '已加载 ' + CASES.length + ' 井次案例、' + CASES.length + ' 份作业总结与 ' + TOOLS.length + ' 件工具台账；词典 ' + LEX.length + ' 条。', 'ok');
})();
