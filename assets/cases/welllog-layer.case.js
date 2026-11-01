/* =========================================================
   案例 · 从测井曲线到层界（测井智能分层 AI 作业流）
   ---------------------------------------------------------
   这是一个「案例插件」的完整示例：
   · 只依赖 Cases 注册表与 K 工具箱，不引用任何外壳内部变量
   · 三块内容（background / workflow / demo）都是可替换的
   · 示范由 assets/cases/welllog-layer.demo.js 以模块方式挂载：
     01 曲线质控 → 02 滑窗特征 → 03 边界概率 → 04 DP 分段 → 05 人工闭环
   ========================================================= */

(function () {

  var esc = K.esc;

  /* =========================================================
     插图：用 JS 生成，避免手写几百行 path
     ========================================================= */

  /* 一条带噪声的阶梯曲线，模拟测井响应 */
  function grPolyline(xL, xW, yT, yH, layers, seed) {
    var rnd = seed || 1;
    function r() { rnd = (rnd * 9301 + 49297) % 233280; return rnd / 233280; }
    var pts = [];
    var n = 260;
    for (var i = 0; i <= n; i++) {
      var t = i / n;
      var y = yT + t * yH;
      var v = layers[0].v;
      for (var j = 0; j < layers.length; j++) {
        if (t >= layers[j].from) v = layers[j].v;
      }
      var local = (r() - 0.5) * 0.055;
      pts.push((xL + (v + local) * xW).toFixed(1) + ',' + y.toFixed(1));
    }
    return pts.join(' ');
  }

  function figManual() {
    var xL = 118, xW = 210, yT = 30, yH = 230;
    var D0 = 1000, D1 = 1030;
    function Y(d) { return yT + (d - D0) / (D1 - D0) * yH; }

    var layers = [
      { from: 0, v: 0.52 },
      { from: 4 / 30, v: 0.20 },
      { from: 11 / 30, v: 0.66 },
      { from: 16 / 30, v: 0.36 },
      { from: 19 / 30, v: 0.62 },
      { from: 27 / 30, v: 0.18 },
      { from: 27.8 / 30, v: 0.50 }
    ];

    var s = '';
    s += '<svg viewBox="0 0 620 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="人工卡层误差示意（1000—1030 m，按深度比例）">';

    for (var d = D0; d <= D1; d += 5) {
      var y = Y(d);
      s += '<line x1="96" y1="' + y + '" x2="' + (xL + xW + 6) + '" y2="' + y + '" stroke="#e9e4d8" stroke-width="1" stroke-dasharray="2 4"/>';
      s += '<text x="88" y="' + (y + 3.5) + '" text-anchor="end" font-size="9" font-family="monospace" fill="#9ba3a9">' + d + '</text>';
    }

    var truth = [1004.0, 1011.0, 1016.0, 1019.0, 1027.0, 1027.8];
    truth.forEach(function (d) {
      var y = Y(d);
      s += '<line x1="' + xL + '" y1="' + y + '" x2="' + (xL + xW + 26) + '" y2="' + y + '" stroke="#2f7d6b" stroke-width="1.3" stroke-dasharray="5 3"/>';
    });

    s += '<polyline points="' + grPolyline(xL, xW, yT, yH, layers, 7) + '" fill="none" stroke="#31393d" stroke-width="1.3" stroke-linejoin="round"/>';
    s += '<line x1="' + (xL + xW + 2) + '" y1="' + yT + '" x2="' + (xL + xW + 2) + '" y2="' + (yT + yH) + '" stroke="#c9c2b0" stroke-width="1"/>';

    /* 人工界面：1004 偏到 1005.2（+1.2 m）；薄层只卡了顶界 1027.0 */
    var manual = [1005.2, 1011.4, 1016.0, 1019.0, 1027.0];
    manual.forEach(function (d) {
      var y = Y(d);
      s += '<line x1="' + (xL - 12) + '" y1="' + y + '" x2="' + (xL + xW + 16) + '" y2="' + y + '" stroke="#b26a39" stroke-width="1.5"/>';
      s += '<circle cx="' + (xL - 12) + '" cy="' + y + '" r="2.4" fill="#b26a39"/>';
    });

    var ty0 = Y(1027.0), ty1 = Y(1027.8);
    s += '<rect x="' + xL + '" y="' + ty0 + '" width="' + (xW + 4) + '" height="' + Math.max(2, ty1 - ty0) + '" fill="#f2d98a" opacity=".55" rx="2"/>';
    s += '<line x1="' + (xL + xW + 30) + '" y1="' + ((ty0 + ty1) / 2) + '" x2="' + (xL + xW + 52) + '" y2="' + ((ty0 + ty1) / 2) + '" stroke="#b26a39" stroke-width="1"/>';
    s += '<text x="' + (xL + xW + 56) + '" y="' + ((ty0 + ty1) / 2 + 3.5) + '" font-size="9.5" fill="#b26a39">0.8 m 薄层 · 只卡顶界</text>';

    s += '<text x="' + (xL + xW + 28) + '" y="' + (Y(1011) - 7) + '" font-size="9.5" fill="#2f7d6b">真实界面</text>';
    s += '<text x="' + (xL - 14) + '" y="' + (Y(1005.2) - 9) + '" font-size="9.5" fill="#b26a39" text-anchor="end">人工卡层</text>';

    var by1 = Y(1004.0), by2 = Y(1005.2);
    s += '<line x1="' + (xL + xW - 20) + '" y1="' + by1 + '" x2="' + (xL + xW - 20) + '" y2="' + by2 + '" stroke="#b26a39" stroke-width="1"/>';
    s += '<line x1="' + (xL + xW - 24) + '" y1="' + by1 + '" x2="' + (xL + xW - 16) + '" y2="' + by1 + '" stroke="#b26a39" stroke-width="1"/>';
    s += '<line x1="' + (xL + xW - 24) + '" y1="' + by2 + '" x2="' + (xL + xW - 16) + '" y2="' + by2 + '" stroke="#b26a39" stroke-width="1"/>';
    s += '<text x="' + (xL + xW + 28) + '" y="' + ((by1 + by2) / 2 + 3.5) + '" font-size="9.5" fill="#b26a39">偏移 1.2 m</text>';

    s += '<text x="' + xL + '" y="16" font-size="9.5" font-family="monospace" fill="#9ba3a9" letter-spacing="1">GR (API)</text>';
    s += '<text x="' + (xL + xW + 2) + '" y="' + (yT + yH + 18) + '" text-anchor="end" font-size="9.5" font-family="monospace" fill="#9ba3a9">深度 / m（1000—1030，按比例）</text>';
    s += '</svg>';
    return s;
  }

  function figAI() {
    var steps = [
      ['01 采集质控', 'GR / SP / RT · 0.125 m', '#e6f1ec', '#2f7d6b'],
      ['02 滑窗特征', 'Δμ · 方差比 · 斜率/相干', '#e7eef9', '#41699b'],
      ['03 边界概率', '逻辑回归 · 现场训练', '#efe9f4', '#7e5a8d'],
      ['04 DP 分段', 'β 惩罚 · 最小层厚 0.75 m', '#f8ecdf', '#b26a39'],
      ['05 人工确认', '复核 · 修正 · 回写', '#f1f1dd', '#767a2e']
    ];
    var s = '<svg viewBox="0 0 620 136" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="测井分层五段 AI 作业流">';
    var w = 108, gap = 17, x = 8, y = 24;
    steps.forEach(function (st, i) {
      s += '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="72" rx="8" fill="' + st[2] + '" stroke="' + st[3] + '" stroke-opacity=".28"/>';
      s += '<rect x="' + x + '" y="' + y + '" width="3" height="72" rx="1.5" fill="' + st[3] + '"/>';
      s += '<text x="' + (x + 12) + '" y="' + (y + 22) + '" font-size="11" font-weight="600" fill="#242b2e">' + st[0] + '</text>';
      st[1].split(' · ').forEach(function (line, k) {
        s += '<text x="' + (x + 12) + '" y="' + (y + 41 + k * 13) + '" font-size="8.3" fill="#5d666d">' + line + '</text>';
      });
      if (i < steps.length - 1) {
        s += '<path d="M' + (x + w + 3) + ' ' + (y + 36) + 'h9m-3.5-3.4 3.6 3.4-3.6 3.4" stroke="#c9c2b0" stroke-width="1.2" fill="none" stroke-linecap="round"/>';
      }
      x += w + gap;
    });
    s += '<text x="8" y="14" font-size="9.5" font-family="monospace" fill="#9ba3a9" letter-spacing="1">ALGORITHM · 01—04</text>';
    s += '<text x="' + (8 + w * 4 + gap * 4) + '" y="14" font-size="9.5" font-family="monospace" fill="#b26a39" letter-spacing="1">HUMAN · 05</text>';
    s += '<line x1="8" y1="112" x2="' + (8 + w * 4 + gap * 3) + '" y2="112" stroke="#2f7d6b" stroke-width="1.4"/>';
    s += '<text x="' + (8 + (w * 4 + gap * 3) / 2) + '" y="126" text-anchor="middle" font-size="9.3" fill="#2f7d6b">算法把上千米曲线压缩成几十个候选界面</text>';
    s += '<line x1="' + (8 + w * 4 + gap * 4) + '" y1="112" x2="' + (8 + w * 5 + gap * 4) + '" y2="112" stroke="#b26a39" stroke-width="1.4"/>';
    s += '<text x="' + (8 + w * 4 + gap * 4 + w / 2) + '" y="126" text-anchor="middle" font-size="9.3" fill="#b26a39">人负责地质合理性</text>';
    s += '</svg>';
    return s;
  }

  function figTolerance() {
    var s = '<svg viewBox="0 0 620 186" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="容差匹配示意">';
    var cols = [
      { x: 8, tag: 'TP · 命中', color: '#2f7d6b', bg: '#e6f1ec', det: 0.62, truth: 0.60, note: '落在 ±0.5 m 内' },
      { x: 214, tag: 'FP · 多检', color: '#b26a39', bg: '#f8ecdf', det: 0.30, truth: 0.68, note: '容差内没有真界面' },
      { x: 420, tag: 'FN · 漏检', color: '#b05a51', bg: '#f5e6e1', det: null, truth: 0.44, note: '真界面没被检出' }
    ];
    cols.forEach(function (c) {
      var w = 192, yT = 34, yH = 108;
      s += '<rect x="' + c.x + '" y="10" width="' + w + '" height="' + (yH + 42) + '" rx="9" fill="#fdfcf9" stroke="#e9e4d8"/>';
      s += '<text x="' + (c.x + 12) + '" y="26" font-size="9.5" font-family="monospace" fill="' + c.color + '" letter-spacing=".8">' + c.tag + '</text>';

      var ax = c.x + 26, aw = w - 52;
      s += '<line x1="' + ax + '" y1="' + yT + '" x2="' + ax + '" y2="' + (yT + yH) + '" stroke="#ddd7c8"/>';
      s += '<line x1="' + (ax + aw) + '" y1="' + yT + '" x2="' + (ax + aw) + '" y2="' + (yT + yH) + '" stroke="#ddd7c8"/>';

      var ty = yT + c.truth * yH;
      s += '<rect x="' + ax + '" y="' + (ty - 11) + '" width="' + aw + '" height="22" fill="' + c.bg + '"/>';
      s += '<line x1="' + ax + '" y1="' + ty + '" x2="' + (ax + aw) + '" y2="' + ty + '" stroke="#2f7d6b" stroke-width="1.2" stroke-dasharray="4 3"/>';
      s += '<text x="' + (ax + aw + 4) + '" y="' + (ty + 3.5) + '" font-size="8" font-family="monospace" fill="#2f7d6b">真</text>';

      if (c.det !== null) {
        var dy = yT + c.det * yH;
        s += '<line x1="' + ax + '" y1="' + dy + '" x2="' + (ax + aw) + '" y2="' + dy + '" stroke="' + c.color + '" stroke-width="2"/>';
        s += '<circle cx="' + ax + '" cy="' + dy + '" r="3" fill="' + c.color + '"/>';
        s += '<text x="' + (ax + aw + 4) + '" y="' + (dy + 3.5) + '" font-size="8" font-family="monospace" fill="' + c.color + '">测</text>';
        if (c.det !== c.truth) {
          s += '<line x1="' + (ax + 14) + '" y1="' + ty + '" x2="' + (ax + 14) + '" y2="' + dy + '" stroke="#c9c2b0" stroke-width="1" stroke-dasharray="2 2"/>';
        }
      }
      s += '<text x="' + (c.x + 12) + '" y="' + (yT + yH + 26) + '" font-size="9.5" fill="#79828a">' + c.note + '</text>';
    });
    s += '</svg>';
    return s;
  }

  /* =========================================================
     注册
     ========================================================= */
  Cases.register({
    id: 'welllog-layer',
    sceneId: 'w1',
    title: '从测井曲线到层界：智能分层五段作业流',
    status: 'ready',
    version: '2.0.0',
    updated: '2026-11-01',

    tabs: {

      /* ---------- ① 专业背景 ---------- */
      background: {
        label: '专业背景',

        judge: [
          { label: '任务类型', value: '序列分割 / 边界检测', desc: '输出界面位置 + 概率 + 复核建议；不是逐点岩性分类，也不是端到端黑箱', html: '<span style="color:var(--c-ts)">序列分割</span>' },
          { label: '数据门槛', value: '30—50 口井', desc: 'GR / SP / RT 0.125 m 采样 + 人工分层表；没有分层表只能做无监督，不能验收' },
          { label: '可见收益', value: '25 min → 8 min', desc: '单井 1000—1030 m 评价段；界面误差 1.2 → 0.4 m、0.8 m 薄层漏卡 3 → 0（示范口径）', html: '<b style="color:var(--jade-d);font-family:var(--mono)">25min → 8min</b>' },
          { label: '难度', value: '中', desc: '标签粒度不一致、薄层与渐变过渡带是主要障碍；不是换个更大的网络就能解决', html: K.dtag('中') }
        ],

        lede: '测井曲线是井筒内连续测量的岩石物理响应。卡层是把一条连续曲线切成地质单元的第一步——后面的储层解释、射孔选段、压裂分段，都以这套界面为底图。现场一段 1000—1030 m 的评价段，人工要花约 25 min，界面平均偏差 1.2 m，0.8 m 薄层还容易只卡顶界、漏掉底界。本案例把这条工序拆成五段可运行的作业流：曲线质控 → 滑窗特征 → 边界概率模型 → 动态规划分段 → 人工确认与回写，让解释员从「从头卡」变成「复核候选」。',

        sections: [
          {
            no: 1, en: 'PROBLEM', title: '当前做法与问题',
            html: '<p>一口井常规三四条曲线、上千米井段。解释员要对照邻井逐段卡层，单井 2—4 小时；即使只看 30 m 评价段，也要 25 min 左右。<b>薄互层段界线模糊</b>，不同人卡的位置能差 0.5—1.2 m，而这 1 m 直接决定射孔段和压裂分段的位置。</p>' +
              '<p>更麻烦的是「对错」本身没有唯一答案：同一口井，两位解释员交上来的层数可能相差两层。这决定了后面所有的评测方式——<b>不能用逐点准确率，只能用「界面是否落在容差内」</b>。本页的容差固定为 ±0.5 m，与现场验收口径一致。</p>' +
              K.figure(figManual(), 1, '同一段 1000—1030 m 曲线的典型误差：界面系统性偏移 1.2 m（上）、0.8 m 薄层只卡了顶界、底界漏卡（下）。纵轴按 30 m 深度比例绘制，偏移与厚度可以直接对照刻度读。')
          },
          {
            no: 2, en: 'INTERVENTION', title: '五段 AI 作业流：从曲线到层界',
            html: '<p>这里不做端到端黑箱，而是把解释员脑子里的判断拆成五段可复算的作业流。每一段都有明确的输入、输出和失败边界，后一段只吃前一段的结果：</p>' +
              '<p><b>01 曲线采集与质控</b>——读入 GR / SP / RT，统一到 0.125 m 采样，检查井段、量程、噪声和缺失段。GR 是分层主曲线，SP 与 RT 做旁证；噪声超过阈值或缺失跨界的井退回重采，不拿坏数据训练。</p>' +
              '<p><b>02 滑窗特征</b>——在 GR 曲线上每个深度点左右各取 5 个采样点，算 <b>均值差、方差比、斜率差、相干性、跳变</b> 5 个量，全部除以稳健噪声 σ。除以 σ 是为了让不同噪声水平的井能放在同一个模型里比较；这一步不做任何「地质判断」。</p>' +
              '<p><b>03 边界概率模型</b>——用 16 口合成井的窗口样本训练 <b>逻辑回归</b>（5 维特征 + 偏置），另 4 口井整井留出做验证。标签平滑 0.08 抑制过置信，温度缩放在验证集上拟合；输出是每个深度点的边界概率，不是写死的模板。</p>' +
              '<p><b>04 动态规划分段</b>——把「哪些点当界面」变成全局最优化：每个点要么付 <b>−log p</b>（当界面），要么付 <b>−log(1−p)</b>（不当界面），每多一个界面再付 <b>β</b>；同时强制相邻界面至少隔 0.75 m。β 由扫描选拐点，避免过分割和欠分割。</p>' +
              '<p><b>05 人工确认与价值</b>——解释员在候选界面上做确认 / 修正 / 标误判，结果回写样本库，下一轮重训纳入。价值按 25 → 8 min、1.2 → 0.4 m、薄层 3 → 0、解释一致性 76% → 93% 的<b>示范口径</b>核算，不混用本页合成验证指标。</p>' +
              '<p>注意这里替换的是<b>工序中的一步</b>，不是整个岗位。算法负责把上千米曲线压缩成几十个候选界面，解释员仍然负责地质合理性判断——既有提速，也保留了责任边界。</p>' +
              K.figure(figAI(), 2, '五段作业流与页面上的 01—05 一一对应。真正决定效果的不是网络有多深，而是 02 的特征是否可解释、03 的概率是否校准、04 的最小层厚与 β 是否合理；05 则决定模型会不会随新井退化。')
          },
          {
            no: 3, en: 'DATA', title: '你需要准备什么',
            html: '<p style="margin-bottom:14px">立项前先对着这张清单打勾。<b>勾不满不代表不能做</b>，但每一项空缺都会在后期变成返工。清单可点击，勾选状态只在本页有效。</p>' +
              K.checklist([
                ['常规测井曲线', 'GR / SP / RT，0.125 m 采样，单井 5000—20000 点', '30—50 口井的人工分层表'],
                ['人工分层表', '同一套地层方案，界面深度精确到 0.125 m', '训练与验收的分母'],
                ['邻井分层与岩性', '同区块 20 口以上', '作为层序一致性约束'],
                ['曲线质量记录', '缺失段、高噪声段、仪器型号与刻度', '决定哪些井能进训练'],
                ['历史解释成果', '已有解释报告与试油/投产结论', '用于交叉验证']
              ]) +
              '<p style="margin-top:18px"><span class="kicker plain" style="color:var(--ink-4)">可参考的公开数据集</span></p>' +
              K.refs(['FORCE 2020 岩性竞赛数据（井曲线 + 岩性标签）', 'Kansas Geological Survey 公开测井库'], null)
          },
          {
            no: 4, en: 'DIFFICULTY', title: '技术难度与参考方向',
            html: '<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:2px">' +
              K.dtag('中') + '<span class="small muted">单井数据易得、任务定义清晰；难点在标签粒度不一致、薄层漏检与曲线缺失。</span></div>' +
              K.meter('中') +
              '<p>难度按三档标注：<b>低</b> = 数据现成、任务边界清晰、错了代价小；<b>中</b> = 需要一个月量级的标注与清洗，效果依赖特征与后处理规则；<b>高</b> = 标签稀缺或安全约束硬，通常要先做小范围可行性验证再立项。</p>' +
              '<p>本案例的三个具体难点：<b>① 标签粒度</b>——不同解释员的层数定义不一致，必须先规范化；<b>② 薄层</b>——0.8 m 层在 ±0.5 m 容差下只允许一个采样点的误差，最小层厚与 β 必须一起调；<b>③ 缺失与噪声</b>——GR 缺失段不能靠补零糊弄，模型要显式知道哪一段不可信。</p>' +
              '<p style="margin-top:18px"><span class="kicker plain" style="color:var(--ink-4)">可借鉴的通用技术</span></p>' +
              K.refs(['变点检测', '逻辑回归 / 校准', '动态规划分段', '地质规则后处理'], null) +
              '<p style="margin-top:18px" class="small muted">交叉环节：<a href="#/stage/mudlog" style="color:var(--jade-d);font-weight:600">录井</a> · <a href="#/stage/geophys" style="color:var(--jade-d);font-weight:600">物探</a></p>'
          }
        ]
      },

      /* ---------- ② 案例流程 ---------- */
      workflow: {
        label: '案例流程',
        title: '案例：A 区块 42 口井的自动卡层',
        lead: [
          'A 区块有 42 口开发井，常规曲线齐全，解释组按油田统一分层方案手工卡出 8 个标志层界面。目标不是「做出一个模型」，而是**把单井 1000—1030 m 评价段的卡层工时从 25 min 压到 8 min（含复核）**，同时把界面平均误差从 1.2 m 压到 0.4 m。',
          '下面五步与示范页的 01—05 一一对应。注意第 01 步和第 05 步：它们不涉及模型，却决定了最终能不能用。'
        ],
        stats: [
          ['样本井', '42', true], ['单井评价段', '30 m', true],
          ['标志层', '8', true], ['界面目标误差', '≤0.5 m'],
          ['人工卡层', '25 min / 段'], ['辅助后', '8 min / 段']
        ],
        steps: [
          {
            name: '01 曲线采集与质控', role: '工程环节',
            do: '把 42 口井的 GR / SP / RT 统一到 0.125 m 采样，深度归位，标出缺失段与高噪声段；噪声超过阈值或缺失跨界的井退回重采，不进入训练。',
            effect: '进入模型的每一口井都能对齐、可追溯',
            trap: '样本量看着很大，实际独立样本只有几十口井'
          },
          {
            name: '02 滑窗特征', role: '数据 / 特征',
            do: '在 GR 曲线上每个深度点左右各取 5 个采样点，算均值差、方差比、斜率差、相干性、跳变 5 维特征；全部除以稳健噪声 σ，让不同噪声水平的井可比。',
            effect: '模型只吃 5 个数，每一维都能在现场找到物理解释',
            trap: '窗口太宽会跨过薄层，太窄会被噪声主导；本示范固定 ±0.625 m'
          },
          {
            name: '03 边界概率模型', role: '算法核心',
            do: '用 16 口合成井的窗口样本训练逻辑回归（标签平滑 0.08），4 口井整井留出验证；温度缩放校准概率，输出每个深度点的边界概率。',
            effect: '把「像不像界面」变成可校准的 p，而不是硬阈值',
            trap: '按样本随机划分会造成同井信息泄漏，指标虚高'
          },
          {
            name: '04 动态规划分段', role: '效果关键',
            do: '以 −log p / −log(1−p) 为逐点代价，β 为每多一个界面的惩罚，最小层厚 0.75 m 硬约束，求全局最优分段；β 由扫描选拐点。',
            effect: '把局部概率变成满足层序与厚度约束的界面序列',
            trap: 'β 太小过分割，β 太大合并真实薄层'
          },
          {
            name: '05 人工确认与价值', role: '闭环',
            do: '解释员在候选界面上做确认 / 修正 / 标误判，结果回写样本库；下一轮重训纳入。价值按 25 → 8 min、1.2 → 0.4 m、薄层 3 → 0、一致性 76% → 93% 的示范口径核算。',
            effect: '每口新井都在提升下一口井的效果',
            trap: '没有回流机制，模型三个月后就过期'
          }
        ],
        metrics: {
          title: '怎么算「分对了」：合成验证 vs 现场口径',
          html: '<p>分层不是逐点分类，而是<b>界面匹配</b>问题：一个界面只要落在真实界面 ±0.5 m 容差内就算命中。这决定了指标的计算方式，也解释了为什么「准确率 99%」在这里毫无意义——界面点只占全井段的千分之一，全判成「不是界面」也有 99.9%。</p>' +
            K.figure(figTolerance(), 3, '按容差匹配后统计 TP / FP / FN，再算精确率与召回率。**漏检（FN）比误检（FP）代价更高**：漏掉一个界面意味着人工要重新扫一遍整段曲线，而多一个候选界面只需点一下删除。') +
            K.dtable(['指标', '定义', '合成验证集（本页可复现）', '现场口径（示范）'], [
              ['边界召回 R', '真实界面里找回了多少', '0.83（验证井 87/105）', '0.91'],
              ['边界精确 P', '给出的候选里有多少是对的', '0.75（验证井 87/116）', '0.82'],
              ['F1', '2PR / (P + R)', '0.79', '0.86'],
              ['默认合成井', '9 个真实界面，β=0.70', '9/9 命中 · F1=1.00 · MAE=0.11 m', '—'],
              ['界面平均误差', '命中界面的绝对深度误差均值', '0.11 m（合成真值）', '0.40 m（人工 1.2 m）'],
              ['0.8 m 薄层漏卡', '厚度 <1 m 的层是否独立切出', '0 处（默认井两界均切出）', '3 → 0 处'],
              ['单井卡层耗时', '1000—1030 m 评价段，含复核', '—（本页推理 <1 s）', '25 min → 8 min'],
              ['解释一致性', '两位解释员复核一致的比例', '—（合成标签唯一）', '76% → 93%']
            ]) +
            '<p style="font-size:11.5px;color:var(--ink-3)">两列的统计对象不同：<b>合成验证集</b>是 20 口合成井中的 4 口整井留出集（按井划分，无同井泄漏），只用来证明 03/04 的代码路径在真实计算；<b>现场口径</b>是 A 区块 42 口井的示范假设，不是本页模型在 42 口井上的实测收益。默认合成井 seed=20261022、10 层、σ=8 API、β=0.70 可复现 9/9、F1=1.00、MAE=0.11 m；验证井 82.9% 的边界召回才是模型泛化的参考。改噪声、层数、β 或种子，01—04 会同步重算，指标也会变。</p>'
        },
        fails: [
          { name: '薄层漏检', why: '厚度小于最小层厚（本示范 0.75 m）的层在惩罚项下会被合并。解决方向是分层建模：先粗分大层，再在小层内单独检测薄层，或降低最小层厚并接受更多误检。' },
          { name: '渐变过渡带', why: '岩性渐变时曲线没有突变点，窗口均值差和跳变都不高，模型倾向把过渡带整体归入一侧。可用斜率特征、软分割概率或人工复核处理。' },
          { name: '曲线缺失段', why: 'GR 在井段内缺失时，插值点会“看起来正常”，模型并不知道这一段不可信。应先做缺失标记，让模型显式知道哪一段不可用；跨界缺失的井直接退回。' },
          { name: '层序冲突', why: 'DP 只保证界面单调和最小层厚，不保证与区域地层方案一致。算法可能给出与邻井矛盾的层序，必须加层序约束或人工审核规则。' }
        ]
      },

      /* ---------- ③ 可运行示范 ---------- */
      demo: {
        label: '可运行示范',
        intro: '一条 1000—1030 m 合成井走完五段：改噪声/层数/β/种子，01 质控 → 02 特征 → 03 训练与概率 → 04 DP 分段 → 05 人工对比同步重算；可点阶段轨、跑全流程、做确认回写。',
        height: 1700,
        mount: function (root, ctx) {
          if (typeof window.WelllogLayerDemo !== 'function') {
            root.innerHTML = '<div class="callout warn"><span class="ci">缺失</span>' +
              '<span>示范脚本未加载：请确认 index.html 中 <b>assets/cases/welllog-layer.demo.js</b> 已在 shell.js 之前引入。</span></div>';
            return;
          }
          window.WelllogLayerDemo(root, ctx);
        },
        unmount: function () {
          if (window.WelllogLayerDemoCleanup) window.WelllogLayerDemoCleanup();
        }
      }
    }
  });

})();
