/* =========================================================
   案例 01 · 测井曲线智能分层
   ---------------------------------------------------------
   这是一个"案例插件"的完整示例：
   · 只依赖 Cases 注册表与 K 工具箱，不引用任何外壳内部变量
   · 三块内容（background / workflow / demo）都是可替换的
   · 删掉这个文件 + index.html 里对应的一行 script，系统照常运行，
     只是 w1 场景会回到"待接入"状态
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
      // 找到当前所在层
      var acc = 0, v = layers[0].v;
      for (var j = 0; j < layers.length; j++) {
        if (t >= layers[j].from) v = layers[j].v;
      }
      // 层内缓变 + 噪声
      var local = (r() - 0.5) * 0.055;
      pts.push((xL + (v + local) * xW).toFixed(1) + ',' + y.toFixed(1));
    }
    return pts.join(' ');
  }

  function figManual() {
    var xL = 118, xW = 210, yT = 30, yH = 230;
    var D0 = 1000, D1 = 1030;
    function Y(d) { return yT + (d - D0) / (D1 - D0) * yH; }

    // 层：from = (深度-1000)/30；v = GR 在 0—1 轴上的相对位置
    var layers = [
      { from: 0, v: 0.52 },            // 1000—1004
      { from: 4 / 30, v: 0.20 },       // 1004—1011
      { from: 11 / 30, v: 0.66 },      // 1011—1016
      { from: 16 / 30, v: 0.36 },      // 1016—1019
      { from: 19 / 30, v: 0.62 },      // 1019—1027
      { from: 27 / 30, v: 0.18 },      // 1027—1027.8 薄层
      { from: 27.8 / 30, v: 0.50 }     // 1027.8—1030
    ];

    var s = '';
    s += '<svg viewBox="0 0 620 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="人工卡层误差示意（1000—1030 m，按深度比例）">';

    // 深度刻度：每 5 m，1000—1030 m
    for (var d = D0; d <= D1; d += 5) {
      var y = Y(d);
      s += '<line x1="96" y1="' + y + '" x2="' + (xL + xW + 6) + '" y2="' + y + '" stroke="#e9e4d8" stroke-width="1" stroke-dasharray="2 4"/>';
      s += '<text x="88" y="' + (y + 3.5) + '" text-anchor="end" font-size="9" font-family="monospace" fill="#9ba3a9">' + d + '</text>';
    }

    // 真实界面（含薄层底界）
    var truth = [1004.0, 1011.0, 1016.0, 1019.0, 1027.0, 1027.8];
    truth.forEach(function (d) {
      var y = Y(d);
      s += '<line x1="' + xL + '" y1="' + y + '" x2="' + (xL + xW + 26) + '" y2="' + y + '" stroke="#2f7d6b" stroke-width="1.3" stroke-dasharray="5 3"/>';
    });

    // 曲线：薄层 0.8 m 有独立低 GR 响应
    s += '<polyline points="' + grPolyline(xL, xW, yT, yH, layers, 7) + '" fill="none" stroke="#31393d" stroke-width="1.3" stroke-linejoin="round"/>';
    s += '<line x1="' + (xL + xW + 2) + '" y1="' + yT + '" x2="' + (xL + xW + 2) + '" y2="' + (yT + yH) + '" stroke="#c9c2b0" stroke-width="1"/>';

    // 人工界面：1004 偏到 1005.2（+1.2 m）；薄层只卡了顶界 1027.0
    var manual = [1005.2, 1011.4, 1016.0, 1019.0, 1027.0];
    manual.forEach(function (d) {
      var y = Y(d);
      s += '<line x1="' + (xL - 12) + '" y1="' + y + '" x2="' + (xL + xW + 16) + '" y2="' + y + '" stroke="#b26a39" stroke-width="1.5"/>';
      s += '<circle cx="' + (xL - 12) + '" cy="' + y + '" r="2.4" fill="#b26a39"/>';
    });

    // 薄层（0.8 m）：真实存在，人工只卡顶界、底界漏卡
    var ty0 = Y(1027.0), ty1 = Y(1027.8);
    s += '<rect x="' + xL + '" y="' + ty0 + '" width="' + (xW + 4) + '" height="' + Math.max(2, ty1 - ty0) + '" fill="#f2d98a" opacity=".55" rx="2"/>';
    s += '<line x1="' + (xL + xW + 30) + '" y1="' + ((ty0 + ty1) / 2) + '" x2="' + (xL + xW + 52) + '" y2="' + ((ty0 + ty1) / 2) + '" stroke="#b26a39" stroke-width="1"/>';
    s += '<text x="' + (xL + xW + 56) + '" y="' + ((ty0 + ty1) / 2 + 3.5) + '" font-size="9.5" fill="#b26a39">0.8 m 薄层 · 只卡顶界</text>';

    // 标注
    s += '<text x="' + (xL + xW + 28) + '" y="' + (Y(1011) - 7) + '" font-size="9.5" fill="#2f7d6b">真实界面</text>';
    s += '<text x="' + (xL - 14) + '" y="' + (Y(1005.2) - 9) + '" font-size="9.5" fill="#b26a39" text-anchor="end">人工卡层</text>';

    // 偏差标注：1004 → 1005.2 = 1.2 m，按 30 m 轴的真实比例
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
      ['原始曲线', '多井 GR / SP / RT', '#e6f1ec', '#2f7d6b'],
      ['滑窗特征', '均值差 · 方差比 · 斜率', '#e7eef9', '#41699b'],
      ['最优分段', '动态规划 + 惩罚项', '#efe9f4', '#7e5a8d'],
      ['规则后处理', '最小层厚 · 层序一致', '#f8ecdf', '#b26a39'],
      ['候选界面', '人工只做确认', '#f1f1dd', '#767a2e']
    ];
    var s = '<svg viewBox="0 0 620 132" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="AI 介入点流程">';
    var w = 108, gap = 17, x = 8, y = 26;
    steps.forEach(function (st, i) {
      s += '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="72" rx="8" fill="' + st[2] + '" stroke="' + st[3] + '" stroke-opacity=".28"/>';
      s += '<rect x="' + x + '" y="' + y + '" width="3" height="72" rx="1.5" fill="' + st[3] + '"/>';
      s += '<text x="' + (x + 13) + '" y="' + (y + 23) + '" font-size="11.5" font-weight="600" fill="#242b2e">' + st[0] + '</text>';
      st[1].split(' · ').forEach(function (line, k) {
        s += '<text x="' + (x + 13) + '" y="' + (y + 43 + k * 14) + '" font-size="9" fill="#5d666d">' + line + '</text>';
      });
      s += '<text x="' + (x + w - 11) + '" y="' + (y + 66) + '" text-anchor="end" font-size="8.5" font-family="monospace" fill="' + st[3] + '">0' + (i + 1) + '</text>';
      if (i < steps.length - 1) {
        s += '<path d="M' + (x + w + 3) + ' ' + (y + 36) + 'h9m-3.5-3.4 3.6 3.4-3.6 3.4" stroke="#c9c2b0" stroke-width="1.2" fill="none" stroke-linecap="round"/>';
      }
      x += w + gap;
    });
    // 人工边界说明
    s += '<text x="8" y="16" font-size="9.5" font-family="monospace" fill="#9ba3a9" letter-spacing="1">ALGORITHM</text>';
    s += '<text x="' + (8 + w * 4 + gap * 4) + '" y="16" font-size="9.5" font-family="monospace" fill="#b26a39" letter-spacing="1">HUMAN CORE</text>';
    s += '<line x1="8" y1="112" x2="' + (8 + w * 4 + gap * 3) + '" y2="112" stroke="#2f7d6b" stroke-width="1.4"/>';
    s += '<text x="' + (8 + (w * 4 + gap * 3) / 2) + '" y="126" text-anchor="middle" font-size="9.5" fill="#2f7d6b">算法负责把上千米曲线压缩成几十个候选</text>';
    s += '<line x1="' + (8 + w * 4 + gap * 4) + '" y1="112" x2="' + (8 + w * 5 + gap * 4) + '" y2="112" stroke="#b26a39" stroke-width="1.4"/>';
    s += '<text x="' + (8 + w * 4 + gap * 4 + w / 2) + '" y="126" text-anchor="middle" font-size="9.5" fill="#b26a39">人负责地质合理性</text>';
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

      // 曲线轴
      var ax = c.x + 26, aw = w - 52;
      s += '<line x1="' + ax + '" y1="' + yT + '" x2="' + ax + '" y2="' + (yT + yH) + '" stroke="#ddd7c8"/>';
      s += '<line x1="' + (ax + aw) + '" y1="' + yT + '" x2="' + (ax + aw) + '" y2="' + (yT + yH) + '" stroke="#ddd7c8"/>';

      // 容差带
      var ty = yT + c.truth * yH;
      s += '<rect x="' + ax + '" y="' + (ty - 11) + '" width="' + aw + '" height="22" fill="' + c.bg + '"/>';
      s += '<line x1="' + ax + '" y1="' + ty + '" x2="' + (ax + aw) + '" y2="' + ty + '" stroke="#2f7d6b" stroke-width="1.2" stroke-dasharray="4 3"/>';
      s += '<text x="' + (ax + aw + 4) + '" y="' + (ty + 3.5) + '" font-size="8" font-family="monospace" fill="#2f7d6b">真</text>';

      // 检测线
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
    title: '测井曲线智能分层',
    status: 'ready',
    version: '1.0.0',
    updated: '2026-10-22',

    tabs: {

      /* ---------- ① 专业背景 ---------- */
      background: {
        label: '专业背景',

        judge: [
          { label: '任务类型', value: '序列分割 / 变点检测', desc: '不是逐点分类，而是找"位置"', html: '<span style="color:var(--c-ts)">序列分割</span>' },
          { label: '数据门槛', value: '30—50 口井', desc: '需要人工分层表作标签' },
          { label: '收益', value: '3.5 h → 15 min', desc: '单井卡层工时（仅复核）', html: '<b style="color:var(--jade-d);font-family:var(--mono)">3.5h → 15min</b>' },
          { label: '难度', value: '中', desc: '标签粒度不一致是主要障碍', html: K.dtag('中') }
        ],

        lede: '测井曲线是井筒内连续测量的岩石物理响应。分层（卡层）是把一条连续曲线切成地质单元的第一步 —— 后面的储层解释、射孔选段、压裂分段，全都以这套界面为底图。所以它错一点，下游全都要返工。',

        sections: [
          {
            no: 1, en: 'PROBLEM', title: '当前做法与问题',
            html: '<p>一口井常规三四条曲线、上千米井段。解释员要对照邻井逐段卡层，单井 2—4 小时。<b>薄互层段界线模糊</b>，不同人卡的位置能差 0.5—1 m，而这 1 m 直接决定射孔段和压裂分段的位置。</p>' +
              '<p>更麻烦的是「对错」本身就没有唯一答案：同一口井，两位解释员交上来的层数可能相差两层。这决定了后面所有的评测方式 —— <b>不能用"逐点准确率"，只能用"界面是否落在容差内"</b>。</p>' +
              K.figure(figManual(), 1, '同一段 1000—1030 m 曲线的典型误差：界面系统性偏移 1.2 m（上）、0.8 m 薄层只卡了顶界、底界漏卡（下）。纵轴按 30 m 深度比例绘制，偏移与厚度可以直接对照刻度读，不再把 1.2 m 画成 12 m。')
          },
          {
            no: 2, en: 'INTERVENTION', title: 'AI 能做什么',
            html: '<p>把分层建模成<b>曲线序列上的变点检测</b>：先算滑窗统计特征（均值差、方差比、斜率），再用最优分段或 1D 分割网络给出候选界面，最后用地质规则过滤。</p>' +
              '<p style="font-size:11.5px;color:var(--ink-3)">本页的可运行示范只覆盖其中的<b>最优分段（DP + β 惩罚）+ 最小层厚 1 m 约束</b>这一子集；滑窗特征、1D U-Net 与层序 / 邻井规则后处理不在示范中，因此示范的指标只代表这一子集的上限，不能直接当作完整流程的验收值。</p>' +
              '<p>注意这里替换的是<b>工序中的一步</b>，不是整个岗位。算法负责把上千米曲线压缩成几十个候选界面，解释员仍然负责地质合理性判断 —— 既有提速，也保留了责任边界。</p>' +
              K.figure(figAI(), 2, '从原始曲线到分层表的五步。真正决定效果的不是网络有多深，而是第 4 步的规则：**最小层厚**与**邻井层序一致性**能把大量"数学上成立、地质上荒谬"的界面直接过滤掉。')
          },
          {
            no: 3, en: 'DATA', title: '你需要准备什么',
            html: '<p style="margin-bottom:14px">立项前先对着这张清单打勾。<b>勾不满不代表不能做</b>，但每一项空缺都会在后期变成返工。清单可点击，勾选状态只在本页有效。</p>' +
              K.checklist([
                ['常规测井曲线', 'GR / SP / RT / DEN，0.125 m 采样，单井 5000—20000 点', '30—50 口井的人工分层表'],
                ['邻井分层与岩性', '同区块 20 口以上', '作为一致性约束'],
                ['地质分层方案', '油田统一的分层标准', '定义层序与命名'],
                ['井位与构造图', '区块级', '判断层序是否可信'],
                ['历史解释成果', '已有解释报告', '用于交叉验证']
              ]) +
              '<p style="margin-top:18px"><span class="kicker plain" style="color:var(--ink-4)">可参考的公开数据集</span></p>' +
              K.refs(['FORCE 2020 岩性竞赛数据（井曲线 + 岩性标签）', 'Kansas Geological Survey 公开测井库'], null)
          },
          {
            no: 4, en: 'DIFFICULTY', title: '技术难度与参考方向',
            html: '<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:2px">' +
              K.dtag('中') + '<span class="small muted">单井数据易得、任务定义清晰；难点在标签粒度不一致与薄层漏检。</span></div>' +
              K.meter('中') +
              '<p>难度按三档标注：<b>低</b> = 数据现成、任务边界清晰、错了代价小；<b>中</b> = 需要一个月量级的标注与清洗，效果依赖后处理规则；<b>高</b> = 标签稀缺或安全约束硬，通常要先做小范围可行性验证再立项。</p>' +
              '<p style="margin-top:18px"><span class="kicker plain" style="color:var(--ink-4)">可借鉴的通用技术</span></p>' +
              K.refs(['变点检测', '序列分割', '1D 卷积网络', '地质规则后处理'], null) +
              '<p style="margin-top:18px" class="small muted">交叉环节：<a href="#/stage/mudlog" style="color:var(--jade-d);font-weight:600">录井</a> · <a href="#/stage/geophys" style="color:var(--jade-d);font-weight:600">物探</a></p>'
          }
        ]
      },

      /* ---------- ② 案例流程 ---------- */
      workflow: {
        label: '案例流程',
        title: '案例：A 区块 42 口井的自动卡层',
        lead: [
          'A 区块有 42 口开发井，常规曲线齐全，解释组按油田统一分层方案手工卡出 8 个标志层界面。目标不是"做出一个模型"，而是**把单井卡层工时从 3.5 小时压到 15 分钟（仅复核）**，同时把界面偏差控制在 0.5 m 以内。',
          '下面五步是这个案例的真实流程。注意第 2 步和第 4 步：它们不涉及任何模型，却决定了最终能不能用。'
        ],
        stats: [
          ['样本井', '42', true], ['单井采样点', '8000', true],
          ['标志层', '8', true], ['界面目标偏差', '≤0.5 m'],
          ['人工工时', '3.5 h / 井'], ['辅助后工时', '15 min / 井']
        ],
        steps: [
          {
            name: '数据准备与对齐', role: '工程环节',
            do: '把 42 口井的曲线统一到 0.125 m 采样，深度归位，并按**井**划分训练 / 验证集（不能按样本随机划分，否则同井信息泄漏）。',
            effect: '同一口井的曲线只出现在一个集合里',
            trap: '样本量看着很大，实际独立样本只有几十口井'
          },
          {
            name: '标签规范化', role: '工程环节',
            do: '把不同解释员的层号映射到同一套地层方案，界面深度取中位数，层数不一致的井标注置信度。',
            effect: '标签从"每人一套"变成"一套 + 置信度"',
            trap: '层数定义不统一会让模型学成"平均解释员"'
          },
          {
            name: '候选界面生成', role: '算法核心',
            do: '滑窗统计特征（均值差、方差比、斜率）+ 变点检测，或用 1D U-Net 做序列分割，输出界面概率。',
            effect: '召回优先：宁可多给候选，也不漏真界面',
            trap: '直接追求高精度会把薄层全部滤掉'
          },
          {
            name: '规则后处理', role: '效果关键',
            do: '最小层厚 1 m、层序与邻井一致、界面不得穿过明显曲线趋势，逐条过滤不合理候选。',
            effect: '把"数学界面"变成"地质界面"',
            trap: '规则过严会连带删掉真实的薄互层'
          },
          {
            name: '人工确认与回流', role: '闭环',
            do: '解释员在候选界面上做增删改，修正结果自动回到训练集，形成闭环。',
            effect: '每口新井都在提升下一口井的效果',
            trap: '没有回流机制，模型三个月后就过期'
          }
        ],
        metrics: {
          title: '怎么算"分对了"',
          html: '<p>分层不是逐点分类，而是<b>界面匹配</b>问题：一个界面只要落在真实界面 ±0.5 m 容差内就算命中。这决定了指标的计算方式，也解释了为什么"准确率 99%"在这里毫无意义 —— 界面点只占全井段的千分之一，全判成"不是界面"也有 99.9%。</p>' +
            K.figure(figTolerance(), 3, '按容差匹配后统计 TP / FP / FN，再算精确率与召回率。**漏检（FN）比误检（FP）代价更高**：漏掉一个界面意味着人工要重新扫一遍整段曲线，而多一个候选界面只需点一下删除。') +
            K.dtable(['指标', '定义', '现场 42 井', '本示范单井'], [
              ['精确率 P', 'TP / (TP + FP)，给出的候选里有多少是对的', '0.82', '1.00'],
              ['召回率 R', 'TP / (TP + FN)，真实界面里找回了多少', '0.91', '0.89（8/9）'],
              ['F1', '2PR / (P + R)', '0.86', '0.94'],
              ['F2（β=2，召回优先）', '5PR / (4P + R)，漏检权重是误检的 4 倍', '—', '0.91'],
              ['平均偏差', '命中界面的绝对深度误差均值（m）', '0.34 m', '0.11 m']
            ]) +
            '<p style="font-size:11.5px;color:var(--ink-3)">两列的统计对象不同：<b>现场 42 井</b>是完整流程（滑窗特征 + 最优分段 + 1D U-Net + 层序规则 + 人工回流）在 A 区块的验收值；<b>本示范单井</b>只跑「DP 最优分段 + 最小层厚 1 m」子集，且是层数少、噪声可控的合成井，因此指标偏高。示范默认井（seed 20261022）可复现 P=1.00、R=0.89、F1=0.94、MAE=0.11 m，另有 1 处 &lt;1 m 薄层界面按设计漏检。示范默认真实 10 层 / 9 个界面，与现场 42 井的 8 个标志层不是同一套数据，只用于核对指标口径。</p>'
        },
        fails: [
          { name: '薄层漏检', why: '厚度小于最小层厚（本例 1 m）的层在惩罚项下会被合并。解决方向是分层建模：先粗分大层，再在小层内单独检测薄层。' },
          { name: '渐变过渡带', why: '岩性渐变时曲线没有突变点，算法倾向把过渡带整体归入一侧。可用斜率特征或软分割概率代替硬界面。' },
          { name: '曲线缺失段', why: '某条曲线在井段内缺失时，多通道模型会被"补零"误导。应先做缺失标记，让模型显式知道哪一通道不可用。' },
          { name: '层序冲突', why: '算法可能给出与区域地层方案矛盾的层序（如标志层倒置）。必须加层序约束或人工审核规则。' }
        ]
      },

      /* ---------- ③ 可运行示范 ---------- */
      demo: {
        label: '可运行示范',
        mount: function (root, ctx) {
          if (typeof window.WelllogLayerDemo !== 'function') {
            root.innerHTML = '<div class="callout warn"><span class="ci">缺失</span>' +
              '<span>示范脚本未加载：请确认 index.html 中 <b>assets/cases/welllog-layer.demo.js</b> 在 shell.js 之前引入。</span></div>';
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
