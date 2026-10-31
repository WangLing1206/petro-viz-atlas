/* =========================================================
   案例模板 · 复制这个文件开始写你的案例
   ---------------------------------------------------------
   三步接入：
     1. 复制成 <你的案例id>.case.js，改下面标注了 ★ 的地方
     2. 在 index.html 的「案例插件」段落加一行 script
     3. 打开 #/cases 看校验结果，全绿即可

   文件命名建议：<场景id>-<简称>.case.js，例如 d3-mudloss.case.js
   如果案例有可运行示范，再建一个 <同名>.demo.js 放算法，
   由本文件的 tabs.demo.mount 去调用。
   ========================================================= */

(function () {

  /* 常用别名，避免每次写 K.esc */
  var esc = K.esc;

  /* =========================================================
     一、可选：局部插图
     ---------------------------------------------------------
     强烈建议每个案例至少有一张图。直接返回 SVG 字符串即可，
     颜色请用 var(--jade) / var(--clay) / #hex 这类浅色值，
     不要写死深色背景。
     ========================================================= */
  function figExample() {
    return '<svg viewBox="0 0 620 200" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="示意图">' +
      '<rect x="10" y="20" width="180" height="90" rx="8" fill="#e6f1ec" stroke="#2f7d6b" stroke-opacity=".3"/>' +
      '<text x="100" y="72" text-anchor="middle" font-size="13" fill="#2f7d6b">改这里</text>' +
      '</svg>';
  }

  /* =========================================================
     二、注册
     ========================================================= */
  Cases.register({

    /* ★ 必填：全局唯一，kebab-case */
    id: 'your-case-id',

    /* ★ 必填：data.js 里已有的场景 id，例如 w1 / g1 / d3
       如果这个场景还不存在，先去 data.js 对应环节的 scenes 数组里加一条 */
    sceneId: 'w1',

    /* ★ 必填：显示在场景页标题区与控制台 */
    title: '你的案例名称',

    /* 建议填：ready = 可用于教学；draft = 内容未定稿 */
    status: 'draft',

    /* 建议填：改一次内容升一格 */
    version: '0.1.0',
    updated: '2026-10-22',

    /* =======================================================
       三块内容。background / workflow 是对象，demo 是挂载器
       ======================================================= */
    tabs: {

      /* ---------- ① 专业背景 ---------- */
      background: {
        label: '专业背景',       // tab 名称，可省略

        /* 顶部那排「30 秒判断」格子，4 格最好看 */
        judge: [
          { label: '任务类型', value: '这里写任务类型', desc: '一句补充说明' },
          { label: '数据门槛', value: '30—50 口井', desc: '需要什么标注' },
          { label: '收益', value: '2 h → 10 min', desc: '工时或精度上的变化' },
          { label: '难度', value: '中', html: K.dtag('中') }
          /* html 字段会替代 value 渲染，用来放徽标，例如 K.dtag('高') */
        ],

        /* 导语：一段话说清这个场景到底在干什么 */
        lede: '★ 一到两句话，说清这个场景在作业链条里处在什么位置、产出什么。',

        /* 四段式，建议恰好四段，与全站保持一致 */
        sections: [
          {
            no: 1, en: 'PROBLEM', title: '当前做法与问题',
            html: '<p>★ 现在人是怎么做的？慢在哪、不一致在哪、代价是什么。</p>' +
              K.figure(figExample(), 1, '★ 图注：这张图想让读者看出什么。支持 **粗体**。')
          },
          {
            no: 2, en: 'INTERVENTION', title: 'AI 能做什么',
            html: '<p>★ 算法替换的是工序中的哪一步？输入什么、输出什么、人还负责什么。</p>'
          },
          {
            no: 3, en: 'DATA', title: '你需要准备什么',
            html: '<p style="margin-bottom:14px">★ 一句话说明清单怎么用。</p>' +
              K.checklist([
                ['数据类型 A', '规模 / 采样率 / 覆盖范围', '需要的标注'],
                ['数据类型 B', '规模', '需要的标注']
              ])
          },
          {
            no: 4, en: 'DIFFICULTY', title: '技术难度与参考方向',
            html: '<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">' +
              K.dtag('中') + '<span class="small muted">★ 难在哪，为什么是这个档位。</span></div>' +
              K.meter('中') +
              '<p>★ 解释一下为什么难，以及先做什么验证。</p>' +
              '<p style="margin-top:18px"><span class="kicker plain" style="color:var(--ink-4)">可借鉴的通用技术</span></p>' +
              K.refs(['方法一', '方法二'], null)
          }
        ]
      },

      /* ---------- ② 案例流程 ---------- */
      workflow: {
        label: '案例流程',
        title: '★ 案例：某某区块的某某任务',

        /* 开头几段话，说清目标。目标要说成可验收的数字 */
        lead: [
          '★ 这是一个真实项目的场景：有多少样本、要解决什么问题。',
          '★ 目标不是"做一个模型"，而是把某个工时/误差压到多少。'
        ],

        /* 右侧指标格，[标签, 值]，纯数字会自动放大 */
        stats: [
          ['样本井', '42'], ['单井采样点', '8000'],
          ['标志层', '8'], ['目标偏差', '≤0.5 m']
        ],

        /* 流程步骤，3—6 步。role 会渲染成小标签 */
        steps: [
          {
            name: '★ 第一步', role: '工程环节',
            do: '★ 具体做什么，写到"能照着做"的程度。',
            effect: '★ 这一步带来的变化',
            trap: '★ 这一步最容易出的问题'
          },
          {
            name: '★ 第二步', role: '算法核心',
            do: '★ ……', effect: '……', trap: '……'
          },
          {
            name: '★ 第三步', role: '人工确认',
            do: '★ ……', effect: '……', trap: '……'
          }
        ],

        /* 可选：评测方式。这块最容易被忽略，建议一定要写 */
        metrics: {
          title: '怎么算"做对了"',
          html: '<p>★ 说清指标定义。注意点明"准确率 99% 为什么没有意义"这类反直觉的地方。</p>' +
            K.dtable(['指标', '定义', '本例取值'], [
              ['精确率 P', '★ 定义', '0.82'],
              ['召回率 R', '★ 定义', '0.91']
            ])
        },

        /* 可选：失败模式，2—4 条 */
        fails: [
          { name: '★ 失败模式一', why: '★ 为什么会这样，往哪个方向解决。' },
          { name: '★ 失败模式二', why: '★ ……' }
        ]
      },

      /* ---------- ③ 可运行示范（可选） ---------- */
      /* 没有示范就整段删掉，场景页会自动只显示两个 tab */
      demo: {
        label: '可运行示范',

        mount: function (root, ctx) {
          /* ctx.scene  当前场景元数据
             ctx.kase   当前案例定义
             ctx.K      渲染工具箱
             ctx.atlas  全量数据
             把界面画进 root 即可。建议参照 welllog-layer.demo.js 的结构。 */
          root.innerHTML =
            '<div class="demo">' +
            '<div class="demo-head"><div>' +
            '<span class="kicker">INTERACTIVE</span>' +
            '<h3 style="margin-top:8px">★ 示范标题</h3>' +
            '<p>★ 一句话说清这个示范让读者动手验证什么。</p>' +
            '</div></div>' +
            '<div style="padding:24px;color:var(--ink-3)">★ 在这里画你的交互界面。</div>' +
            '</div>';
        },

        unmount: function () {
          /* ★ 如果有 setInterval / addEventListener(window)，在这里清掉 */
        }
      }
    }
  });

})();
