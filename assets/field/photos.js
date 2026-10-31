/* =========================================================
   案例封面注册表（Agnes AI 生成，按案例内容取景）
   ---------------------------------------------------------
   · CASE_COVERS：案例 id → 封面 key，案例库卡片使用；
   · FIELD_PHOTOS：封面元信息（标题、图注、模型、提示词）；
   · 'hero' 是案例库库头图。

   每张图都包含该案例的核心元素（工具矩阵、示功图、甘特图、
   管道走向、测井曲线、井径仪器…），不出现人物。
   图片为 2K 16:9 生成后裁成 1280×720，已本地化，离线可用。
   要换图：python tools/gen-case-covers.py --force
   ========================================================= */

(function (global) {
  'use strict';

  global.CASE_COVERS = {
    "welllog-layer": "welllog-layer",
    "casing-damage-cv": "casing-damage-cv",
    "fishing-tool-kg": "fishing-tool-kg",
    "frac-optimize-opt": "frac-optimize-opt",
    "gaslogging-fluid-ts": "gaslogging-fluid-ts",
    "pipeline-leak-ts": "pipeline-leak-ts",
    "pump-diagnosis-cv": "pump-diagnosis-cv",
    "workover-duration-ts": "workover-duration-ts",
    "workover-plan-kg": "workover-plan-kg",
    "workover-risk-ts": "workover-risk-ts",
  };

  global.FIELD_PHOTOS = {
    "welllog-layer": {
      src: 'assets/field/covers/welllog-layer.jpg?v=20261030t',
      title: "测井曲线智能分层",
      caption: "双屏测井曲线、分层界线与井筒剖面，桌面摊着纸质测井图。",
      focus: '50% 50%',
      credit: 'Agnes Image 2.5 Flash',
      license: 'AI 生成示意图',
      model: "agnes-image-2.5-flash",
      generatedAt: "2026-10-30 20:40:11",
      prompt: "Flat technical-infographic illustration, 16:9 horizontal composition, the diagram itself fills the entire frame edge to edge. Light warm-paper background (#F5EFE2), dark petrol-ink lines (#0E3A3E), brass and amber accents (#B07A2A, #D9B679), one signal-red (#A64B3C) reserved for alarms and damage marks only. Crisp vector look, fine grid lines, high visual density, generous margins, balanced layout. Absolutely no photographs, no monitors, no desks, no rooms, no people, no hands, no shadows. No legible text, no numbers, no letters, no logos, no watermarks. Wireline well-log chart: four vertical track columns of colorful wiggling log curves in teal, brass, ochre and slate, crossed by bold horizontal stratigraphic boundary lines dividing eight stacked layer bands; a slim depth track on the left, a narrow wellbore strip with alternating shaded beds on the right."
    },
    "casing-damage-cv": {
      src: 'assets/field/covers/casing-damage-cv.jpg?v=20261030t',
      title: "套管损伤智能识别",
      caption: "多臂井径仪器与套管成像展开图，损伤段被标出。",
      focus: '50% 50%',
      credit: 'Agnes Image 2.5 Flash',
      license: 'AI 生成示意图',
      model: "agnes-image-2.5-flash",
      generatedAt: "2026-10-30 20:40:38",
      prompt: "Flat technical-infographic illustration, 16:9 horizontal composition, the diagram itself fills the entire frame edge to edge. Light warm-paper background (#F5EFE2), dark petrol-ink lines (#0E3A3E), brass and amber accents (#B07A2A, #D9B679), one signal-red (#A64B3C) reserved for alarms and damage marks only. Crisp vector look, fine grid lines, high visual density, generous margins, balanced layout. Absolutely no photographs, no monitors, no desks, no rooms, no people, no hands, no shadows. No legible text, no numbers, no letters, no logos, no watermarks. Casing-inspection diagram: a circular multi-arm caliper cross-section with sixteen thin measuring arms radiating outward on the left, and a long unwrapped casing-imaging strip on the right built from fine scan lines, with two jagged signal-red bands marking damaged intervals."
    },
    "fishing-tool-kg": {
      src: 'assets/field/covers/fishing-tool-kg.jpg?v=20261030t',
      title: "落物打捞工具智能选型",
      caption: "打捞工具按矩阵排列，旁边是工具匹配表与井身结构图。",
      focus: '50% 50%',
      credit: 'Agnes Image 2.5 Flash',
      license: 'AI 生成示意图',
      model: "agnes-image-2.5-flash",
      generatedAt: "2026-10-30 20:41:03",
      prompt: "Flat technical-infographic illustration, 16:9 horizontal composition, the diagram itself fills the entire frame edge to edge. Light warm-paper background (#F5EFE2), dark petrol-ink lines (#0E3A3E), brass and amber accents (#B07A2A, #D9B679), one signal-red (#A64B3C) reserved for alarms and damage marks only. Crisp vector look, fine grid lines, high visual density, generous margins, balanced layout. Absolutely no photographs, no monitors, no desks, no rooms, no people, no hands, no shadows. No legible text, no numbers, no letters, no logos, no watermarks. Fishing-tool selection matrix: a four-by-three grid of distinct dark steel downhole-tool silhouettes (overshots, taper taps, spears, mills) on paper cards, exactly one card highlighted with a brass frame and a check mark, thin connector lines linking the grid to a small wellbore icon with a stuck fish shape."
    },
    "frac-optimize-opt": {
      src: 'assets/field/covers/frac-optimize-opt.jpg?v=20261030t',
      title: "压裂参数智能优化",
      caption: "参数曲线、Pareto 前沿与窗外的压裂泵车组。",
      focus: '50% 50%',
      credit: 'Agnes Image 2.5 Flash',
      license: 'AI 生成示意图',
      model: "agnes-image-2.5-flash",
      generatedAt: "2026-10-30 20:41:29",
      prompt: "Flat technical-infographic illustration, 16:9 horizontal composition, the diagram itself fills the entire frame edge to edge. Light warm-paper background (#F5EFE2), dark petrol-ink lines (#0E3A3E), brass and amber accents (#B07A2A, #D9B679), one signal-red (#A64B3C) reserved for alarms and damage marks only. Crisp vector look, fine grid lines, high visual density, generous margins, balanced layout. Absolutely no photographs, no monitors, no desks, no rooms, no people, no hands, no shadows. No legible text, no numbers, no letters, no logos, no watermarks. Fracturing-optimization dashboard graphic: three smooth pumping-parameter curves (rate, sand ratio, fluid volume) stacked on the upper half, a Pareto-frontier scatter of dots with one brass star optimum below, and a row of horizontal design-comparison bars along the bottom."
    },
    "gaslogging-fluid-ts": {
      src: 'assets/field/covers/gaslogging-fluid-ts.jpg?v=20261030t',
      title: "气测异常智能解释",
      caption: "气测全烃、组分比值与 Pixler 图版同屏显示。",
      focus: '50% 50%',
      credit: 'Agnes Image 2.5 Flash',
      license: 'AI 生成示意图',
      model: "agnes-image-2.5-flash",
      generatedAt: "2026-10-30 20:41:54",
      prompt: "Flat technical-infographic illustration, 16:9 horizontal composition, the diagram itself fills the entire frame edge to edge. Light warm-paper background (#F5EFE2), dark petrol-ink lines (#0E3A3E), brass and amber accents (#B07A2A, #D9B679), one signal-red (#A64B3C) reserved for alarms and damage marks only. Crisp vector look, fine grid lines, high visual density, generous margins, balanced layout. Absolutely no photographs, no monitors, no desks, no rooms, no people, no hands, no shadows. No legible text, no numbers, no letters, no logos, no watermarks. Mud-gas interpretation plate: a tall total-hydrocarbon spiking curve on the left, a set of vertical component-ratio bars in the middle, and a crossplot panel on the right where two smooth curves intersect inside a triangular fluid-zone envelope."
    },
    "pipeline-leak-ts": {
      src: 'assets/field/covers/pipeline-leak-ts.jpg?v=20261030t',
      title: "管道泄漏智能检测",
      caption: "管道走向图、压力/流量曲线与泄漏报警点。",
      focus: '50% 50%',
      credit: 'Agnes Image 2.5 Flash',
      license: 'AI 生成示意图',
      model: "agnes-image-2.5-flash",
      generatedAt: "2026-10-30 20:38:32",
      prompt: "Flat technical-infographic illustration, 16:9 horizontal composition, the diagram itself fills the entire frame edge to edge. Light warm-paper background (#F5EFE2), dark petrol-ink lines (#0E3A3E), brass and amber accents (#B07A2A, #D9B679), one signal-red (#A64B3C) reserved for alarms and damage marks only. Crisp vector look, fine grid lines, high visual density, generous margins, balanced layout. Absolutely no photographs, no monitors, no desks, no rooms, no people, no hands, no shadows. No legible text, no numbers, no letters, no logos, no watermarks. Pipeline leak-detection graphic: a long horizontal pipeline route line with round valve-station nodes across the upper third, two declining pressure curves beneath it, one glowing signal-red alarm pin dropped exactly where the curves diverge, with faint concentric alert rings."
    },
    "pump-diagnosis-cv": {
      src: 'assets/field/covers/pump-diagnosis-cv.jpg?v=20261030t',
      title: "抽油机井工况诊断",
      caption: "六幅示功图按工况分类，异常井被标出。",
      focus: '50% 50%',
      credit: 'Agnes Image 2.5 Flash',
      license: 'AI 生成示意图',
      model: "agnes-image-2.5-flash",
      generatedAt: "2026-10-30 20:38:10",
      prompt: "Flat technical-infographic illustration, 16:9 horizontal composition, the diagram itself fills the entire frame edge to edge. Light warm-paper background (#F5EFE2), dark petrol-ink lines (#0E3A3E), brass and amber accents (#B07A2A, #D9B679), one signal-red (#A64B3C) reserved for alarms and damage marks only. Crisp vector look, fine grid lines, high visual density, generous margins, balanced layout. Absolutely no photographs, no monitors, no desks, no rooms, no people, no hands, no shadows. No legible text, no numbers, no letters, no logos, no watermarks. Six sucker-rod pump dynamometer cards (closed load-versus-displacement loops) arranged in a two-by-three grid, each loop a different condition color in teal, brass, ochre, slate and red; the bottom-right loop circled by a signal-red dashed ring as the anomaly."
    },
    "workover-duration-ts": {
      src: 'assets/field/covers/workover-duration-ts.jpg?v=20261030t',
      title: "修井周期预测",
      caption: "七道工序的甘特条、P50/P80 区间与蒙特卡洛分布。",
      focus: '50% 50%',
      credit: 'Agnes Image 2.5 Flash',
      license: 'AI 生成示意图',
      model: "agnes-image-2.5-flash",
      generatedAt: "2026-10-30 20:38:59",
      prompt: "Flat technical-infographic illustration, 16:9 horizontal composition, the diagram itself fills the entire frame edge to edge. Light warm-paper background (#F5EFE2), dark petrol-ink lines (#0E3A3E), brass and amber accents (#B07A2A, #D9B679), one signal-red (#A64B3C) reserved for alarms and damage marks only. Crisp vector look, fine grid lines, high visual density, generous margins, balanced layout. Absolutely no photographs, no monitors, no desks, no rooms, no people, no hands, no shadows. No legible text, no numbers, no letters, no logos, no watermarks. Workover-schedule Gantt graphic: seven horizontal progress bars in a left list, each bar carrying a shaded P50-to-P80 duration band with a diamond milestone, and a smooth bell-shaped probability-distribution curve occupying the right third of the frame."
    },
    "workover-plan-kg": {
      src: 'assets/field/covers/workover-plan-kg.jpg?v=20261030t',
      title: "修井作业方案智能推荐",
      caption: "「故障—工艺—工具—效果」知识图谱与井史资料。",
      focus: '50% 50%',
      credit: 'Agnes Image 2.5 Flash',
      license: 'AI 生成示意图',
      model: "agnes-image-2.5-flash",
      generatedAt: "2026-10-30 20:39:23",
      prompt: "Flat technical-infographic illustration, 16:9 horizontal composition, the diagram itself fills the entire frame edge to edge. Light warm-paper background (#F5EFE2), dark petrol-ink lines (#0E3A3E), brass and amber accents (#B07A2A, #D9B679), one signal-red (#A64B3C) reserved for alarms and damage marks only. Crisp vector look, fine grid lines, high visual density, generous margins, balanced layout. Absolutely no photographs, no monitors, no desks, no rooms, no people, no hands, no shadows. No legible text, no numbers, no letters, no logos, no watermarks. Knowledge-graph diagram: four vertical columns of round nodes (symptoms, processes, tools, outcomes) linked by curved edges, one reasoning path from left to right highlighted in glowing brass with enlarged nodes, the rest in muted ink outlines."
    },
    "workover-risk-ts": {
      src: 'assets/field/covers/workover-risk-ts.jpg?v=20261030t',
      title: "修井作业风险预警",
      caption: "立压、套压、排量曲线与阈值报警。",
      focus: '50% 50%',
      credit: 'Agnes Image 2.5 Flash',
      license: 'AI 生成示意图',
      model: "agnes-image-2.5-flash",
      generatedAt: "2026-10-30 20:39:47",
      prompt: "Flat technical-infographic illustration, 16:9 horizontal composition, the diagram itself fills the entire frame edge to edge. Light warm-paper background (#F5EFE2), dark petrol-ink lines (#0E3A3E), brass and amber accents (#B07A2A, #D9B679), one signal-red (#A64B3C) reserved for alarms and damage marks only. Crisp vector look, fine grid lines, high visual density, generous margins, balanced layout. Absolutely no photographs, no monitors, no desks, no rooms, no people, no hands, no shadows. No legible text, no numbers, no letters, no logos, no watermarks. Real-time risk-monitor graphic: three jagged monitoring curves (pressure, pressure, flow rate) running left to right, one curve spiking sharply through a horizontal signal-red threshold line, a bold alarm badge bursting at the crossing point, small gauge dials tucked in the lower corners."
    },
    'hero': {
      src: 'assets/field/hero.jpg?v=20261030p',
      title: '油田智能化调度中心',
      caption: '多块屏幕并列：测井曲线、示功图、管道走向、工具矩阵、修井甘特图。',
      focus: '50% 50%',
      credit: 'Agnes Image 2.5 Flash',
      license: 'AI 生成示意图',
      model: "agnes-image-2.5-flash",
      generatedAt: "2026-10-30 19:29:53",
      prompt: "工业可视化摄影，中国油田现场，低饱和青灰色与黄铜色调，写实质感，16:9 横构图，画面中没有人物、人影、人脸、手或身体部位；屏幕内容只表现抽象曲线、图形、矩阵、甘特条与色块，不要出现可辨认的文字、数字、标识、水印、品牌 logo。油田智能化调度中心的宽幅场景，多块屏幕分别显示测井曲线、示功图、管道走向图、打捞工具矩阵、修井甘特图和压力曲线；深色控制台、键盘与图纸；电影感，无人物，屏幕只有抽象曲线与图形。"
    },
  };

  global.fieldPhoto = function (key) {
    return key && global.FIELD_PHOTOS[key] ? global.FIELD_PHOTOS[key] : null;
  };

  global.fieldPhotoCredit = function (p) {
    if (!p) return '';
    return p.credit + ' · ' + p.license;
  };
})(window);
