/* =========================================================
   案例包导入 Case Import（v2：多文件 / 文件夹）
   ---------------------------------------------------------
   一个「案例包」= 一个文件夹，最少一个清单，其余随便：

     my-case/
       case.json          必需。元信息 + 专业背景 + 案例流程
       demo/index.html    可选。示范页（整页放进沙箱 iframe）
       demo/demo.css      可选。示范页样式
       demo/demo.js       可选。示范页脚本；没有 html 时它就是
                                「模块模式」的挂载脚本
       demo/*.png|svg|json… 可选。示范用到的素材，自动转 data URL

   流程：下载模板 → 改内容 → 把整个文件夹拖进弹窗 → 校验 → 添加。
   添加后案例存进 localStorage 并注册进 Cases，全站立即可见。
   ========================================================= */

(function (global) {
  'use strict';

  var esc = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  };

  var KEY = 'atlas.casepack.v2';
  var KEY_V1 = 'atlas.casepack.v1';
  var KEY_BLOCKED = 'atlas.case.blocked.v1';
  var ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
  var MAX_TOTAL = 6 * 1024 * 1024;
  var WARN_TOTAL = 1.6 * 1024 * 1024;

  var TEXT_EXT = ['json', 'js', 'mjs', 'css', 'html', 'htm', 'svg', 'txt', 'csv', 'tsv', 'md', 'xml', 'yaml', 'yml', 'geojson'];
  var MIME = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    svg: 'image/svg+xml', ico: 'image/x-icon', mp3: 'audio/mpeg', wav: 'audio/wav',
    mp4: 'video/mp4', webm: 'video/webm', woff: 'font/woff', woff2: 'font/woff2',
    ttf: 'font/ttf', otf: 'font/otf', json: 'application/json', csv: 'text/csv', pdf: 'application/pdf'
  };

  var saved = [];
  var memFallback = null;

  var S = {
    pkg: null,        /* 清单对象 */
    manifest: null,   /* 清单文件 */
    files: [],        /* 除清单外的示范文件 */
    raw: [],          /* 全部文件（含清单） */
    loading: false,
    el: null,
    pv: null,         /* 预览弹窗 */
    pvHandle: null
  };

  /* ---------------------------------------------------------
     0. 小工具
     --------------------------------------------------------- */
  function extOf(name) {
    var m = /\.([a-z0-9]+)$/i.exec(String(name).split('?')[0]);
    return m ? m[1].toLowerCase() : '';
  }
  function isTextName(n) { return TEXT_EXT.indexOf(extOf(n)) >= 0; }
  function isHtml(n) { var e = extOf(n); return e === 'html' || e === 'htm'; }
  function isJs(n) { var e = extOf(n); return e === 'js' || e === 'mjs'; }
  function isCss(n) { return extOf(n) === 'css'; }
  function baseOf(n) { return String(n).split('/').pop(); }
  function kb(n) { return Math.max(1, Math.round(n / 1024)); }

  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }

  /* 以 _ 开头的键是模板里的说明，导入时忽略 */
  function clean(obj) {
    if (Array.isArray(obj)) return obj.map(clean);
    if (!obj || typeof obj !== 'object') return obj;
    var out = {};
    Object.keys(obj).forEach(function (k) {
      if (k.charAt(0) === '_') return;
      out[k] = clean(obj[k]);
    });
    return out;
  }

  /* ---------------------------------------------------------
     1. 存储
     --------------------------------------------------------- */
  function readStore(key) {
    try {
      var raw = JSON.parse(global.localStorage.getItem(key) || '[]');
      return Array.isArray(raw) ? raw : [];
    } catch (e) {
      return (key === KEY && memFallback) || [];
    }
  }

  function writeStore(list) {
    memFallback = list;
    try {
      global.localStorage.setItem(KEY, JSON.stringify(list));
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ---------------------------------------------------------
     2. 读文件
     --------------------------------------------------------- */
  function readOne(file) {
    return new Promise(function (resolve, reject) {
      var name = file.webkitRelativePath || file.name;
      var text = isTextName(name);
      var fr = new FileReader();
      fr.onload = function () {
        resolve({
          name: name,
          size: file.size,
          mime: file.type || MIME[extOf(name)] || (text ? 'text/plain' : 'application/octet-stream'),
          enc: text ? 'text' : 'dataurl',
          data: String(fr.result)
        });
      };
      fr.onerror = function () { reject(new Error('读取失败：' + name)); };
      if (text) fr.readAsText(file, 'utf-8');
      else fr.readAsDataURL(file);
    });
  }

  /* 整个文件夹上传时，路径里会带上顶层目录名，去掉它 */
  function stripRoot(files) {
    if (files.length < 2) return files;
    var segs = files.map(function (f) { return f.name.split('/'); });
    if (!segs.every(function (s) { return s.length > 1; })) return files;
    var root = segs[0][0];
    if (!segs.every(function (s) { return s[0] === root; })) return files;
    files.forEach(function (f) { f.name = f.name.slice(root.length + 1); });
    return files;
  }

  function pickManifest(files) {
    var jsons = files.filter(function (f) { return extOf(f.name) === 'json' && f.enc === 'text'; });
    var named = jsons.filter(function (f) { return /(^|\/)(case|[a-z0-9._-]+\.case)\.json$/i.test(f.name); });
    return named[0] || jsons[0] || null;
  }

  function roleOf(f) {
    if (S.manifest && f.name === S.manifest.name) return { k: 'manifest', t: '清单' };
    if (isHtml(f.name)) return { k: 'page', t: '示范页' };
    if (isCss(f.name)) return { k: 'css', t: '样式' };
    if (isJs(f.name)) return { k: 'js', t: '脚本' };
    if (extOf(f.name) === 'json') return { k: 'data', t: '数据' };
    return { k: 'asset', t: '素材' };
  }

  function demoCfg(pkg) {
    return (pkg && ((pkg.tabs && pkg.tabs.demo) || pkg.demo)) || {};
  }

  /* ---------------------------------------------------------
     2.5 隐藏名单：被"删除"的插件案例，刷新后仍保持隐藏
     --------------------------------------------------------- */
  function readBlocklist() {
    try {
      var r = JSON.parse(global.localStorage.getItem(KEY_BLOCKED) || '[]');
      return Array.isArray(r) ? r : [];
    } catch (e) { return []; }
  }
  function writeBlocklist(list) {
    try { global.localStorage.setItem(KEY_BLOCKED, JSON.stringify(list)); } catch (e) { }
  }
  function applyBlocklist() {
    readBlocklist().forEach(function (id) {
      /* 名单只对插件案例生效；同 id 的上传案例不受影响 */
      var c = global.Cases.get(id);
      if (c && !c.imported) global.Cases.unregister(id);
    });
  }

  /* ---------------------------------------------------------
     3. 案例定义
     --------------------------------------------------------- */
  function toCase(rec) {
    var pkg = clean(rec.pkg) || {};
    var meta = rec.meta || {};
    var t = pkg.tabs || {};
    var files = rec.files || [];
    var cfg = demoCfg(pkg);
    var tabs = {};

    if (t.background) {
      var b = t.background;
      tabs.background = {
        label: b.label || '专业背景',
        judge: Array.isArray(b.judge) && b.judge.length ? b.judge : null,
        lede: b.lede || '',
        sections: (b.sections || []).map(function (s, i) {
          return {
            no: s.no || (i + 1),
            en: s.en || '',
            title: s.title || '未命名段落',
            html: s.html || s.body || ''
          };
        })
      };
    }

    if (t.workflow) {
      var w = t.workflow;
      tabs.workflow = {
        label: w.label || '案例流程',
        title: w.title || '案例流程',
        lead: w.lead || [],
        stats: w.stats || null,
        steps: (w.steps || []).map(function (s) {
          return {
            name: s.name || '未命名步骤',
            role: s.role || '',
            do: s.do || '',
            effect: s.effect || '',
            trap: s.trap || ''
          };
        }),
        metrics: w.metrics || null,
        fails: w.fails || null
      };
    }

    /* --- 示范：三种来源 --- */
    var mode = files.length ? global.CaseDemoHost.resolveMode({ files: files, demo: cfg }) : 'none';
    var handle = null;

    if (cfg.builtin && mode === 'none') {
      var src = global.Cases.get(cfg.builtin);
      if (src && src.tabs && src.tabs.demo && typeof src.tabs.demo.mount === 'function') {
        tabs.demo = {
          label: cfg.label || src.tabs.demo.label || '可运行示范',
          intro: cfg.intro || '',
          mode: 'builtin',
          mount: src.tabs.demo.mount,
          unmount: src.tabs.demo.unmount
        };
      }
    } else if (mode === 'page' || mode === 'module') {
      tabs.demo = {
        label: cfg.label || '可运行示范',
        intro: cfg.intro || '',
        mode: mode,
        mount: function (root, ctx) {
          handle = global.CaseDemoHost.create(root, {
            files: files,
            demo: cfg,
            meta: rec.meta
          }, ctx);
        },
        unmount: function () {
          if (handle) { try { handle.destroy(); } catch (e) { } handle = null; }
        }
      };
    }

    return {
      id: meta.id,
      sceneId: meta.sceneId,
      title: meta.title,
      methods: (meta.methods && meta.methods.length)
        ? meta.methods.slice()
        : ((sceneOf(meta.sceneId) || {}).methods || []).slice(),
      version: meta.version || '1.0.0',
      updated: meta.updated || today(),
      status: 'ready',
      imported: true,
      packFiles: files.length,
      tabs: tabs
    };
  }

  /* ---------------------------------------------------------
     4. 校验
     --------------------------------------------------------- */
  function sceneOf(id) {
    return (global.ATLAS && global.ATLAS.index.byScene[id]) || null;
  }

  function checkAll(pkg, meta, files) {
    var out = [];
    function ok(m, h) { out.push({ level: 'ok', msg: m, hint: h || '' }); }
    function warn(m, h) { out.push({ level: 'warn', msg: m, hint: h || '' }); }
    function err(m, h) { out.push({ level: 'error', msg: m, hint: h || '' }); }

    files = files || [];

    if (!pkg) {
      err('还没有案例包', '把整个案例文件夹拖进左边，或点「选择文件夹」；最快的方式是先下载模板');
      return out;
    }

    pkg = clean(pkg);
    var t = pkg.tabs || {};
    var cfg = demoCfg(pkg);

    /* 1 id */
    var occupiedCase = meta.id ? global.Cases.get(meta.id) : null;
    if (!meta.id) err('案例 id 没填', '建议「环节-关键词」，例如 welllog-layer');
    else if (!ID_RE.test(meta.id)) err('案例 id 格式不合法：' + meta.id, '只能小写字母、数字、连字符，不能有空格或下划线');
    else if (occupiedCase && occupiedCase.imported) err('案例 id 已被占用：' + meta.id, '换一个 id；若是之前上传的旧版本，先在案例库里移除');
    else if (occupiedCase) warn('与内置案例同 id：' + meta.id, '允许上传覆盖：本机这份会成为该场景的首选展示，内置版仍在磁盘上、不显示；移除后自动回退');
    else ok('id 可用：' + meta.id);

    /* 2 场景 */
    var sc = meta.sceneId ? sceneOf(meta.sceneId) : null;
    if (!meta.sceneId) err('没有选择所属场景', '下拉框里按环节分组，选场景即等于选定分类');
    else if (!sc) err('场景不存在：' + meta.sceneId, '场景 id 必须来自 assets/data.js');
    else {
      ok('绑定场景：' + sc.stageName + ' / ' + sc.name,
        '分类自动继承：' + sc.stageName + ' · ' + (sc.methods || []).join(' / '));
      var occupied = global.Cases.byScene(sc.id);
      if (occupied && occupied.id !== meta.id) {
        warn('该场景已有案例：' + occupied.id, '上传后会覆盖它的显示（旧案例仍留在案例库里）');
      }
    }

    /* 2.5 技术标签 */
    var mm = meta.methods || [];
    var badM = mm.filter(function (k) { return !(global.ATLAS.methods && global.ATLAS.methods[k]); });
    if (badM.length) err('技术标签不存在：' + badM.join('、'),
      '取值以场景标签与「方法 × 环节」矩阵为准；需要新类别请先让管理员在管理后台添加');
    else if (!mm.length) ok('技术标签：继承场景', '会沿用所选场景自带的方法标签参与检索');
    else ok('技术标签：' + mm.join(' / '), '案例库与场景页会按它展示');

    /* 3 名称 */
    if (!meta.title) err('案例名称没填', '会显示在场景页标题与案例库列表里');
    else if (meta.title.length > 40) warn('案例名称偏长（' + meta.title.length + ' 字）', '建议 6–20 字，页面标题不折行');
    else ok('名称：' + meta.title);

    /* 4 专业背景 */
    if (!t.background) {
      err('缺少 tabs.background', '专业背景是必填块，没有它场景页不会出现 tab');
    } else {
      var secs = t.background.sections || [];
      if (!secs.length) err('background.sections 为空', '至少要有一段；建议四段式');
      else {
        var bad = [];
        secs.forEach(function (s, i) {
          if (!s || !s.title) bad.push('sections[' + i + '] 缺 title');
          else if (!s.html && !s.body) bad.push('sections[' + i + '] 缺 html');
        });
        if (bad.length) err('段落字段不全', bad.join('；'));
        else ok('专业背景：' + secs.length + ' 段');
        if (secs.length < 4) warn('只有 ' + secs.length + ' 段', '建议四段：当前做法与问题 / AI 能做什么 / 需要准备什么 / 难度与参考');
      }
      var j = t.background.judge;
      if (j && j.length && j.length !== 4) warn('judge 有 ' + j.length + ' 项', '"30 秒判断"按四列排版，建议正好 4 项');
    }

    /* 5 流程 */
    if (!t.workflow) {
      warn('没有 tabs.workflow', '页面会少"案例流程"这个 tab，可以后补');
    } else {
      var steps = t.workflow.steps || [];
      if (!steps.length) err('workflow.steps 为空', '至少写一步；每步需要 name，可选 do / effect / trap');
      else {
        var badStep = steps.filter(function (s) { return !s || !s.name; });
        if (badStep.length) err('有步骤缺 name', '检查 steps 数组第 ' + (steps.indexOf(badStep[0]) + 1) + ' 项');
        else ok('案例流程：' + steps.length + ' 步');
      }
    }

    /* 6 示范 */
    var mode = files.length ? global.CaseDemoHost.resolveMode({ files: files, demo: cfg }) : 'none';
    var jsFile = files.filter(function (f) { return isJs(f.name); })[0] || null;
    var cssFiles = files.filter(function (f) { return isCss(f.name); });
    var htmlFile = files.filter(function (f) { return isHtml(f.name); })[0] || null;

    if (mode === 'page') {
      ok('示范：整页模式（沙箱）', htmlFile.name + ' 会在隔离的 iframe 里运行，写多复杂都不会影响主站');
      if (htmlFile.size < 60) warn('示范页内容过短', 'index.html 看起来是空壳，检查是不是存错文件');
      /* 引用完整性：src / href / url() 指向的本地文件在不在 */
      var missing = [];
      var scanRefs = function (text, from) {
        var re = /(?:src|href)\s*=\s*["']([^"'#]+)["']|url\(\s*["']?([^"')]+)["']?\s*\)/gi, m;
        while ((m = re.exec(text))) {
          var ref = m[1] || m[2] || '';
          if (!ref || /^(data:|https?:|mailto:|tel:|#|\/\/)/i.test(ref)) continue;
          if (!/[.][a-z0-9]{2,5}$/i.test(ref)) continue;
          if (!global.CaseDemoHost.findFile(files, ref)) missing.push(from + ' → ' + ref);
        }
      };
      scanRefs(htmlFile.data, 'index.html');
      cssFiles.forEach(function (f) { scanRefs(f.data, f.name); });
      if (missing.length) {
        warn('有 ' + missing.length + ' 处引用的文件不在包里', missing.slice(0, 4).join('；') + (missing.length > 4 ? ' …' : ''));
      } else if (htmlFile) {
        ok('示范页内引用的文件都能找到');
      }
    } else if (mode === 'module') {
      if (!jsFile) {
        err('没有可运行的示范脚本', '模块模式需要 demo.js；或者放一个 index.html 走整页模式');
      } else {
        try {
          new Function(jsFile.data);   /* 只做语法检查，不执行 */
          ok('示范脚本语法通过：' + jsFile.name);
        } catch (e) {
          err('示范脚本有语法错误：' + jsFile.name, e.message);
        }
        if (!/\bmount\b/.test(jsFile.data) && !/__CASE_MOUNT__/.test(jsFile.data)) {
          warn('脚本里没看到 mount 相关代码', '需要导出 mount(root, api)：module.exports={mount} 或 window.__CASE_MOUNT__=function(root,api){}');
        }
        ok('示范：模块模式（Shadow DOM）', '样式自动隔离，可以直接用 var(--jade) 这类站点配色令牌');
      }
    } else if (cfg.builtin) {
      var src = global.Cases.get(cfg.builtin);
      if (!src || !src.tabs.demo || typeof src.tabs.demo.mount !== 'function') {
        err('demo.builtin 指向的示范不存在：' + cfg.builtin, '改成一个已注册案例的 id，或删掉整个 demo 块');
      } else {
        ok('复用内置示范：' + cfg.builtin, '不推荐：包里已经有文件时，会优先用包里的示范');
      }
    } else {
      warn('这个案例没有可运行示范', '想加示范就在包里放 demo/index.html 或 demo/demo.js；已经有文件但没被识别，检查 demo 字段');
    }

    /* 7 样式文件粗检 */
    cssFiles.forEach(function (f) {
      var open = (f.data.match(/{/g) || []).length, close = (f.data.match(/}/g) || []).length;
      if (open !== close) warn('样式大括号不配对：' + f.name, '{ 有 ' + open + ' 个，} 有 ' + close + ' 个，可能少了一个 }');
    });

    /* 8 文件清单与体积 */
    var total = files.reduce(function (a, f) { return a + f.size; }, 0) + ((S.manifest && S.manifest.size) || 0);
    if (!files.length) {
      if (!cfg.builtin) warn('包里只有清单，没有示范文件', '这是允许的（只有讲解没有示范），但带示范的场景更容易被立项');
      else ok('只有清单 + 复用内置示范');
    } else {
      ok('文件清单：' + (files.length + 1) + ' 个，共 ' + kb(total) + ' KB',
        files.map(function (f) { return f.name; }).slice(0, 6).join('、') + (files.length > 6 ? ' …' : ''));
      if (total > MAX_TOTAL) err('包太大：' + kb(total) + ' KB', '上限 6 MB；图片先压缩，视频请放外部链接');
      else if (total > WARN_TOTAL) warn('包偏大（' + kb(total) + ' KB）', '会占用浏览器本地存储，建议压到 1.5 MB 以内');
    }

    /* 9 安全 */
    var all = JSON.stringify(pkg);
    if (/<script/i.test(all)) err('清单内容里出现 <script> 标签', '清单只放文字；脚本请放进单独的 .js 文件');
    if (all.length > 200000) warn('清单偏大（' + Math.round(all.length / 1024) + ' KB）', '长图建议改成精简的 SVG 路径');

    return out;
  }

  function summarize(list) {
    var e = 0, w = 0;
    list.forEach(function (x) { if (x.level === 'error') e++; else if (x.level === 'warn') w++; });
    return { errors: e, warns: w, oks: list.length - e - w };
  }

  /* ---------------------------------------------------------
     5. 模板（清单 + 示范页 + 脚本 + 样式）
     --------------------------------------------------------- */
  function templateManifest() {
    return {
      _readme: '这是案例包清单模板。以 _ 开头的字段是说明文字，导入时会被忽略，可以删掉。',
      _files: '同目录下可以放 demo/index.html、demo/demo.css、demo/demo.js 以及任意图片素材。上传时把整个文件夹拖进弹窗即可。',
      _usage: '1) 改 id / sceneId / title；2) 填 tabs.background 与 tabs.workflow；3) 示范页放 demo/index.html（整页模式），或只放 demo/demo.js（模块模式）；4) 在网站「＋ 添加案例」里拖入整个文件夹。',
      id: 'your-case-id',
      sceneId: 'w1',
      methods: ['ts'],
      _methods: '可选项：这个案例涉及哪些 AI 技术。数组，取值见场景标签与「方法 × 环节」矩阵（如 cv / ts / nlp / opt / kg）。不填或留空则自动继承所选场景的技术标签。',
      title: '你的案例名称',
      version: '1.0.0',
      updated: today(),
      tabs: {
        _note: 'background 必填，workflow 建议填，demo 可选（没有示范就整块删掉）。',
        background: {
          label: '专业背景',
          lede: '一段 100–200 字的导语：这个环节在干什么、为什么值得用算法做。',
          judge: [
            { label: '数据形态', value: '曲线 / 图像', desc: '原始数据长什么样' },
            { label: '标注成本', value: '高', desc: '谁来标、标多久' },
            { label: '可见收益', value: '快', desc: '从哪一步开始省人力' },
            { label: '难度', value: '中', desc: '卡点是什么' }
          ],
          sections: [
            { no: 1, en: 'PROBLEM', title: '当前做法与问题', html: '<p>现在由谁、用什么方法做，一天能做多少，误差多大。</p>' },
            { no: 2, en: 'INTERVENTION', title: 'AI 能做什么', html: '<p>算法替代其中哪一步，输出什么，人还需要做什么。</p>' },
            { no: 3, en: 'DATA', title: '需要准备什么', html: '<p>需要哪些数据、多少量、怎么标注。</p>' },
            { no: 4, en: 'DIFFICULTY', title: '难度与参考方向', html: '<p>难点在哪，可以先从哪条技术路线试。</p>' }
          ]
        },
        workflow: {
          label: '案例流程',
          title: '一个可复用的落地流程',
          lead: ['第一段：这个流程解决什么问题、适用条件是什么。', '第二段：整体思路。'],
          stats: [['样本量', '42 口井'], ['周期', '3 周']],
          steps: [
            { name: '数据整理', role: '数据', do: '把原始数据统一格式、深度对齐、剔除异常段。', effect: '得到可直接进模型的样本集。', trap: '深度基准不统一会让下游全部错位。' },
            { name: '标注与切分', role: '标注', do: '按层段标注，留出独立验证集。', effect: '有可复现的评测口径。' }
          ],
          metrics: { title: '怎么算"做对了"', html: '<p>写清指标定义与容差，例如"界面误差 ≤ 0.5 m 记为命中"。</p>' },
          fails: [
            { name: '过分割', why: '噪声波动被当成界面，层数虚高。' },
            { name: '薄层漏检', why: '最小层厚规则把有价值的薄层合并掉了。' }
          ]
        },
        demo: {
          _note: 'mode: auto 会自动判断：有 html 走整页模式，只有 js 走模块模式，都没有就看 builtin。',
          mode: 'auto',
          html: 'demo/index.html',
          js: 'demo/demo.js',
          label: '可运行示范',
          intro: '拖这个滑杆，看阈值怎么影响分层结果。',
          height: 560
        }
      }
    };
  }

  var TPL_HTML = [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>示范：阈值法划分储层</title>',
    '<link rel="stylesheet" href="demo.css">',
    '</head>',
    '<body>',
    '<div class="panel">',
    '  <h1>阈值法划分储层</h1>',
    '  <p class="lead">这个文件是案例包自带的示范页样板。它是完整的 HTML，图表、Canvas、WebGL、第三方库都可以放，',
    '  运行在隔离的 iframe 里，不会影响主站样式。</p>',
    '',
    '  <div class="ctl">',
    '    <label for="th">伽马阈值 <output id="out">75</output> API</label>',
    '    <input type="range" id="th" min="30" max="120" value="75" step="1">',
    '  </div>',
    '',
    '  <svg id="log" viewBox="0 0 660 230" role="img" aria-label="随阈值变化的储层划分"></svg>',
    '',
    '  <p class="note" id="note"></p>',
    '</div>',
    '<script src="demo.js"></scr' + 'ipt>',
    '</body>',
    '</html>'
  ].join('\n');

  var TPL_CSS = [
    '/* 示范页样式。运行在 iframe 里，可以随便写，不会影响主站。 */',
    ':root{--ink:#242b2e;--ink-2:#4d565b;--ink-3:#79828a;--line:#e9e4d8;--jade:#2f7d6b;--paper:#fbfaf6}',
    '*{box-sizing:border-box}',
    'body{margin:0;padding:18px 20px 24px;background:var(--paper);color:var(--ink);',
    '  font-family:"Inter","PingFang SC","Microsoft YaHei",system-ui,sans-serif;font-size:13px;line-height:1.7}',
    '.panel{max-width:760px}',
    'h1{font-size:19px;margin:0 0 6px;letter-spacing:-.01em}',
    '.lead{margin:0 0 16px;color:var(--ink-2);font-size:12.5px;line-height:1.75}',
    '.ctl{display:flex;align-items:center;gap:14px;margin-bottom:12px;flex-wrap:wrap}',
    '.ctl label{font-size:12px;color:var(--ink-2);display:flex;align-items:center;gap:6px}',
    '.ctl output{font-family:ui-monospace,monospace;font-size:13px;color:var(--jade);font-weight:600}',
    '.ctl input[type=range]{flex:1;min-width:220px;accent-color:var(--jade);height:18px}',
    '#log{width:100%;height:auto;border:1px solid var(--line);border-radius:8px;background:#fff}',
    '.note{margin-top:10px;font-size:12px;color:var(--ink-3)}',
    '.note b{color:var(--ink)}'
  ].join('\n');

  var TPL_JS = [
    '/* =========================================================',
    '   示范脚本模板（整页模式）',
    '   ---------------------------------------------------------',
    '   这份文件由 index.html 通过 <script src="demo.js"> 引入，',
    '   运行在沙箱 iframe 里，可以自由操作 document。',
    '',
    '   包里其它素材可以直接用相对路径引用：',
    '     <img src="core.png">   → 由宿主自动替换成 data URL',
    '     var url = window.caseAsset("core.png");',
    '   ========================================================= */',
    '',
    '(function () {',
    '  "use strict";',
    '',
    '  /* 1. 造一条假的伽马曲线：三段不同基线 + 噪声 */',
    '  var N = 240, curve = [];',
    '  var segs = [[60, 9], [92, 7], [48, 11]];',
    '  for (var i = 0; i < N; i++) {',
    '    var s = segs[Math.min(2, Math.floor(i / (N / 3)))];',
    '    var rnd = (Math.sin(i * 12.9898) * 43758.5453) % 1;',
    '    curve.push(Math.max(12, Math.min(140, s[0] + (rnd - 0.5) * s[1] * 3.2)));',
    '  }',
    '',
    '  var svg = document.getElementById("log");',
    '  var range = document.getElementById("th");',
    '  var out = document.getElementById("out");',
    '  var note = document.getElementById("note");',
    '',
    '  var W = 660, H = 230, L = 42, R = 14, T = 14, B = 26;',
    '  var x = function (i) { return L + i / (N - 1) * (W - L - R); };',
    '  var y = function (v) { return T + (1 - (v - 10) / 130) * (H - T - B); };',
    '',
    '  function draw() {',
    '    var th = Number(range.value);',
    '    out.textContent = th;',
    '',
    '    var s = "";',
    '    /* 网格与坐标 */',
    '    [30, 60, 90, 120].forEach(function (v) {',
    '      s += \'<line x1="\' + L + \'" y1="\' + y(v) + \'" x2="\' + (W - R) + \'" y2="\' + y(v) +',
    '           \'" stroke="#efece1" stroke-width="1"/>\';',
    '      s += \'<text x="\' + (L - 8) + \'" y="\' + (y(v) + 3) + \'" font-size="9" fill="#9ba3a9" \' +',
    '           \'text-anchor="end" font-family="monospace">\' + v + \'</text>\';',
    '    });',
    '',
    '    /* 阈值线 */',
    '    s += \'<line x1="\' + L + \'" y1="\' + y(th) + \'" x2="\' + (W - R) + \'" y2="\' + y(th) +',
    '         \'" stroke="#b26a39" stroke-width="1.2" stroke-dasharray="4 3"/>\';',
    '',
    '    /* 低于阈值的连续段 → 储层，填底色 */',
    '    var i = 0, runs = 0;',
    '    while (i < N) {',
    '      if (curve[i] < th) {',
    '        var j = i;',
    '        while (j < N && curve[j] < th) j++;',
    '        if (j - i >= 3) {',
    '          runs++;',
    '          s += \'<rect x="\' + x(i) + \'" y="\' + T + \'" width="\' + (x(j - 1) - x(i)) +',
    '               \'" height="\' + (H - T - B) + \'" fill="#e6f1ec" opacity=".85"/>\';',
    '        }',
    '        i = j;',
    '      } else i++;',
    '    }',
    '',
    '    /* 曲线 */',
    '    var d = "";',
    '    for (var k = 0; k < N; k++) d += (k ? "L" : "M") + x(k).toFixed(1) + " " + y(curve[k]).toFixed(1);',
    '    s += \'<path d="\' + d + \'" fill="none" stroke="#2f7d6b" stroke-width="1.4" stroke-linejoin="round"/>\';',
    '',
    '    s += \'<text x="\' + (L + 2) + \'" y="\' + (H - 8) + \'" font-size="9.5" fill="#9ba3a9" \' +',
    '         \'font-family="monospace">0 m</text>\';',
    '    s += \'<text x="\' + (W - R) + \'" y="\' + (H - 8) + \'" font-size="9.5" fill="#9ba3a9" \' +',
    '         \'text-anchor="end" font-family="monospace">深度 30 m</text>\';',
    '',
    '    svg.innerHTML = s;',
    '    note.innerHTML = "当前阈值 <b>" + th + " API</b>，低于阈值的连续井段被划为储层，共 <b>" + runs +',
    '      " 段</b>。把阈值拖低会并入更多泥质段，拖高会切碎有效储层——这正是人工卡层最费时的地方。";',
    '  }',
    '',
    '  range.addEventListener("input", draw);',
    '  draw();',
    '})();'
  ].join('\n');

  var TPL_README = [
    '案例包模板',
    '==========',
    '',
    '目录结构：',
    '',
    '  my-case/',
    '    case.json          清单：元信息 + 专业背景 + 案例流程（必需）',
    '    demo/index.html    示范页（整页模式，可选）',
    '    demo/demo.css      示范页样式（可选）',
    '    demo/demo.js       示范页脚本；没有 html 时它就是模块模式的挂载脚本（可选）',
    '    任意素材            图片 / JSON 数据 / 字体，放进来即可被引用',
    '',
    '怎么用：',
    '',
    '  1. 解压这个包，用编辑器改 case.json 里的 id / sceneId / title 和两块正文。',
    '  2. 打开网站首页右上角「＋ 添加案例」，把 my-case 整个文件夹拖进弹窗。',
    '  3. 右侧会逐项校验，红色错误改完再提交。',
    '',
    '示范的两种写法：',
    '',
    '  A. 整页模式 —— 有 demo/index.html',
    '     想怎么画就怎么画，运行在沙箱 iframe 里，样式不会污染主站。',
    '     <link href="demo.css"> 与 <script src="demo.js"> 会被自动内联，',
    '     图片等素材的 src 会被自动替换成 data URL。',
    '',
    '  B. 模块模式 —— 只有 demo/demo.js',
    '     脚本会被执行，并用 Shadow DOM 隔离样式。需要导出 mount：',
    '',
    '       module.exports = {',
    '         mount: function (root, api) {',
    '           // root: 你的容器；api.asset("x.png") 取素材，api.scene 取场景元数据',
    '         },',
    '         unmount: function () { /* 清定时器、事件监听 */ }',
    '       };',
    '',
    '     或者 window.__CASE_MOUNT__ = function (root, api) { ... };',
    '',
    '  都没有的话，可以在 case.json 里写 tabs.demo.builtin = "welllog-layer"',
    '  复用系统已有的示范。',
    '',
    '注意：案例存在浏览器 localStorage 里，换电脑/换浏览器要重新上传。',
    '要永久发布给所有人看，请用开发者方式：把文件放进 assets/cases/ 并在 index.html 引一行 script。',
    ''
  ].join('\n');

  /* ---- 极简 zip（store，无压缩），让模板可以一次下载 ---- */
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function makeZip(entries) {
    var enc = new TextEncoder();
    var now = new Date();
    var dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2)) & 0xFFFF;
    var dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;

    var locals = [], centrals = [], offset = 0;

    entries.forEach(function (e) {
      var nameBytes = enc.encode(e.name);
      var data = e.binary || enc.encode(e.text || '');
      var crc = crc32(data);

      var lh = new Uint8Array(30 + nameBytes.length);
      var dv = new DataView(lh.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 0x0800, true);
      dv.setUint16(8, 0, true);
      dv.setUint16(10, dosTime, true);
      dv.setUint16(12, dosDate, true);
      dv.setUint32(14, crc, true);
      dv.setUint32(18, data.length, true);
      dv.setUint32(22, data.length, true);
      dv.setUint16(26, nameBytes.length, true);
      dv.setUint16(28, 0, true);
      lh.set(nameBytes, 30);

      var ch = new Uint8Array(46 + nameBytes.length);
      var cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, dosTime, true);
      cv.setUint16(14, dosDate, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      ch.set(nameBytes, 46);

      locals.push(lh, data);
      centrals.push(ch);
      offset += lh.length + data.length;
    });

    var cdSize = centrals.reduce(function (a, c) { return a + c.length; }, 0);
    var eocd = new Uint8Array(22);
    var ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);

    var all = locals.concat(centrals, [eocd]);
    var total = all.reduce(function (a, c) { return a + c.length; }, 0);
    var out = new Uint8Array(total), pos = 0;
    all.forEach(function (c) { out.set(c, pos); pos += c.length; });
    return new Blob([out], { type: 'application/zip' });
  }

  /* ---------------------------------------------------------
     6. 弹窗
     --------------------------------------------------------- */
  function sceneOptions(selected) {
    var A = global.ATLAS;
    var html = '<option value="">— 选择场景 —</option>';
    A.stages.forEach(function (st) {
      html += '<optgroup label="' + esc((st.idx < 10 ? '0' : '') + st.idx + ' ' + st.name) + '">';
      st.scenes.forEach(function (sc) {
        var used = global.Cases.bySceneAll(sc.id).length;
        html += '<option value="' + esc(sc.id) + '"' + (sc.id === selected ? ' selected' : '') + '>' +
          esc(sc.name) + (used ? '（已有 ' + used + ' 个案例）' : '') + '</option>';
      });
      html += '</optgroup>';
    });
    return html;
  }

  /* ---- 涉及的 AI 技术：复选芯片组 ---- */
  function methodChecks(selected) {
    var M = global.ATLAS.methods;
    selected = selected || [];
    return Object.keys(M).map(function (k) {
      var on = selected.indexOf(k) >= 0;
      return '<label class="imp-mchip' + (on ? ' on' : '') + '" data-mkey="' + k + '">' +
        '<input type="checkbox" value="' + k + '"' + (on ? ' checked' : '') + '>' +
        '<b>' + esc(M[k].abbr) + '</b>' + esc(M[k].name) + '</label>';
    }).join('');
  }

  function checkedMethods() {
    var box = q('#imp-methods');
    if (!box) return [];
    return [].slice.call(box.querySelectorAll('input:checked')).map(function (i) { return i.value; });
  }

  /* 勾选默认值：清单里声明了 methods 用清单的；否则继承所选场景的标签 */
  function paintMethods() {
    var box = q('#imp-methods');
    if (!box) return;
    var pkgM = (S.pkg && clean(S.pkg).methods) || [];
    var sel = pkgM.length ? pkgM : (function () {
      var sc = sceneOf(q('#imp-scene').value);
      return sc ? (sc.methods || []) : [];
    })();
    box.innerHTML = methodChecks(sel);
  }

  function build() {
    var el = document.createElement('div');
    el.className = 'mdl';
    el.id = 'import-modal';
    el.hidden = true;
    el.innerHTML =
      '<div class="mdl-bg" data-close></div>' +
      '<div class="mdl-p" role="dialog" aria-modal="true" aria-labelledby="imp-title">' +

      '<div class="mdl-h">' +
      '<div><div class="eyebrow">ADD CASE PACKAGE</div><h3 id="imp-title">添加一个新案例</h3></div>' +
      '<button class="mdl-x" data-close aria-label="关闭">✕</button>' +
      '</div>' +

      '<div class="mdl-b">' +
      '<ol class="imp-flow">' +
      '<li><b>01</b><span>下载模板，改内容与示范</span></li>' +
      '<li><b>02</b><span>拖入整个案例文件夹</span></li>' +
      '<li><b>03</b><span>校验通过后添加</span></li>' +
      '</ol>' +

      '<div class="imp-grid">' +
      '<div class="imp-l">' +

      '<div class="imp-drop" id="imp-drop">' +
      '<input type="file" id="imp-file" multiple hidden>' +
      '<input type="file" id="imp-dir" webkitdirectory directory multiple hidden>' +
      '<span class="imp-ic">↑</span>' +
      '<b>拖入案例文件夹，或点击选择</b>' +
      '<span class="imp-sub">清单 case.json + 示范页 + 脚本 + 素材，上限 6 MB。推荐把整个文件夹<b>直接拖进虚线框</b>；若点按钮弹出的仍是文件选择框（浏览器不支持选文件夹），可点「选择文件」后 Ctrl+A 全选包内文件</span>' +
      '<span class="imp-choose">' +
      '<button class="btn sm" id="imp-pick-files" type="button">选择文件</button>' +
      '<button class="btn sm ghost" id="imp-pick-dir" type="button">选择文件夹</button>' +
      '</span>' +
      '</div>' +

      '<div class="imp-pack" id="imp-pack" hidden>' +
      '<div class="imp-pack-h">' +
      '<span id="imp-pack-sum">0 个文件</span>' +
      '<span class="imp-mode" id="imp-mode">—</span>' +
      '<span style="flex:1"></span>' +
      '<button class="imp-try" id="imp-try" type="button">▶ 试跑示范</button>' +
      '<button class="imp-fx" id="imp-clear" title="清空">✕</button>' +
      '</div>' +
      '<div class="imp-list" id="imp-list"></div>' +
      '</div>' +

      '<div class="imp-tpl">' +
      '<button class="btn sm" id="imp-dl">↓ 下载案例包模板</button>' +
      '<button class="btn sm ghost" id="imp-dl-json">仅清单模板</button>' +
      '<a class="btn sm ghost" href="#/guide" data-close>字段说明 →</a>' +
      '</div>' +

      '<div class="imp-form">' +
      '<label class="imp-f"><span>案例名称 <i>*</i></span>' +
      '<input type="text" id="imp-title-in" placeholder="例如：测井曲线智能分层" maxlength="40"></label>' +
      '<label class="imp-f"><span>案例 id <i>*</i></span>' +
      '<input type="text" id="imp-id" placeholder="welllog-layer" maxlength="40">' +
      '<em>小写字母、数字、连字符，全站唯一</em></label>' +
      '<label class="imp-f"><span>所属场景 <i>*</i></span>' +
      '<select id="imp-scene">' + sceneOptions('') + '</select>' +
      '<em>分类（环节 + 方法）由场景自动带出</em></label>' +
      '<div class="imp-f"><span>涉及的 AI 技术</span>' +
      '<div class="imp-methods" id="imp-methods"></div>' +
      '<em>可多选；不勾选则自动继承所选场景的技术标签</em></div>' +
      '<div class="imp-f2">' +
      '<label class="imp-f"><span>版本</span><input type="text" id="imp-ver" placeholder="1.0.0" maxlength="16"></label>' +
      '<label class="imp-f"><span>更新日期</span><input type="date" id="imp-date"></label>' +
      '</div>' +
      '</div>' +

      '</div>' +

      '<div class="imp-r">' +
      '<div class="imp-rh"><span>校验结果</span><span class="mono" id="imp-count">未开始</span></div>' +
      '<div class="imp-res" id="imp-res">' +
      '<div class="imp-empty">把案例文件夹拖进来后，这里会逐项显示检查结果。<br>只有 0 项错误才能添加。</div>' +
      '</div>' +
      '</div>' +

      '</div>' +
      '</div>' +

      '<div class="mdl-f">' +
      '<span class="imp-tip" id="imp-tip">表单里的名称 / 场景会覆盖清单里的同名字段。</span>' +
      '<span style="flex:1"></span>' +
      '<button class="btn" data-close>取消</button>' +
      '<button class="btn primary" id="imp-ok">校验并添加</button>' +
      '</div>' +

      '</div>';

    document.body.appendChild(el);
    return el;
  }

  function q(id) { return S.el.querySelector(id); }

  function paintResults(list) {
    var res = q('#imp-res'), cnt = q('#imp-count');
    if (!list.length) {
      res.innerHTML = '<div class="imp-empty">把案例文件夹拖进来后，这里会逐项显示检查结果。<br>只有 0 项错误才能添加。</div>';
      cnt.textContent = '未开始';
      cnt.className = 'mono';
      return;
    }
    var sum = summarize(list);
    res.innerHTML = list.map(function (x) {
      var icon = x.level === 'ok' ? '✓' : x.level === 'warn' ? '!' : '✕';
      return '<div class="imp-item" data-lv="' + x.level + '">' +
        '<span class="imp-i">' + icon + '</span>' +
        '<div><div class="imp-m">' + esc(x.msg) + '</div>' +
        (x.hint ? '<div class="imp-h">' + esc(x.hint) + '</div>' : '') + '</div></div>';
    }).join('');
    cnt.textContent = sum.errors ? sum.errors + ' 项错误' : sum.warns ? sum.warns + ' 项警告' : '全部通过';
    cnt.className = 'mono ' + (sum.errors ? 'is-err' : sum.warns ? 'is-warn' : 'is-ok');
  }

  function tip(msg, kind) {
    var el = q('#imp-tip');
    el.textContent = msg;
    el.className = 'imp-tip' + (kind ? ' ' + kind : '');
  }

  function metaNow() {
    return {
      id: q('#imp-id').value.trim(),
      title: q('#imp-title-in').value.trim(),
      sceneId: q('#imp-scene').value,
      methods: checkedMethods(),
      version: q('#imp-ver').value.trim(),
      updated: q('#imp-date').value
    };
  }

  function preview() {
    if (!S.pkg) { paintResults([]); return; }
    paintResults(checkAll(S.pkg, metaNow(), S.files));
  }

  function suggestId(sceneId) {
    var base = (sceneId || 'case') + '-case';
    var id = base, n = 2;
    while (global.Cases.get(id)) { id = base + '-' + n; n++; }
    return id;
  }

  /* ---- 文件列表 ---- */
  function paintFiles() {
    var box = q('#imp-pack'), list = q('#imp-list');
    if (!S.raw.length) { box.hidden = true; return; }
    box.hidden = false;

    var total = S.raw.reduce(function (a, f) { return a + f.size; }, 0);
    q('#imp-pack-sum').textContent = S.raw.length + ' 个文件 · ' + kb(total) + ' KB';

    var mode = S.files.length ? global.CaseDemoHost.resolveMode({ files: S.files, demo: demoCfg(S.pkg) }) : 'none';
    var cfg = demoCfg(S.pkg);
    if (mode === 'none' && cfg.builtin) mode = 'builtin';
    var label = { page: '整页模式', module: '模块模式', builtin: '复用内置示范', none: '无示范' }[mode] || '无示范';
    var mEl = q('#imp-mode');
    mEl.textContent = label;
    mEl.dataset.mode = mode;

    q('#imp-try').disabled = (mode === 'none' || mode === 'builtin');

    list.innerHTML = S.raw.map(function (f, i) {
      var r = roleOf(f);
      return '<div class="imp-row" data-role="' + r.k + '">' +
        '<span class="imp-role">' + r.t + '</span>' +
        '<span class="imp-name" title="' + esc(f.name) + '">' + esc(f.name) + '</span>' +
        '<span class="imp-size">' + kb(f.size) + ' KB</span>' +
        '<button class="imp-fx" data-del="' + i + '" title="移除">✕</button>' +
        '</div>';
    }).join('');
  }

  /* ---- 载入一组文件 ---- */
  function loadFiles(fileList) {
    var files = [].slice.call(fileList || []).filter(function (f) { return f && f.name && f.name !== '.DS_Store'; });
    if (!files.length) return;

    if (S.loading) return;
    S.loading = true;
    tip('正在读取 ' + files.length + ' 个文件…', '');

    Promise.all(files.map(readOne)).then(function (arrs) {
      S.loading = false;
      stripRoot(arrs);
      adopt(arrs);
    }).catch(function (e) {
      S.loading = false;
      paintResults([{ level: 'error', msg: '读取文件失败', hint: e.message }]);
      tip('读取失败，换一个文件夹再试', 'is-err');
    });
  }

  function adopt(arrs) {
    S.raw = arrs;
    var mf = pickManifest(arrs);
    S.manifest = mf;
    S.files = arrs.filter(function (f) { return f !== mf; });

    if (!mf) {
      S.pkg = null;
      paintFiles();
      paintResults([{
        level: 'error',
        msg: '没有找到 case.json 清单',
        hint: '案例包里必须有一个 .json 清单（建议叫 case.json）。点「↓ 下载案例包模板」拿一份现成的。'
      }]);
      tip('缺少清单文件', 'is-err');
      return;
    }

    var pkg;
    try {
      pkg = JSON.parse(mf.data);
    } catch (e) {
      S.pkg = null;
      paintFiles();
      paintResults([{
        level: 'error',
        msg: '清单不是合法 JSON：' + e.message,
        hint: '常见原因：多了一个逗号、用了中文引号、注释没删干净。'
      }]);
      tip('清单解析失败', 'is-err');
      return;
    }
    if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
      S.pkg = null;
      paintFiles();
      paintResults([{ level: 'error', msg: '清单最外层应该是一个对象 { ... }', hint: '检查文件开头结尾的 { }' }]);
      return;
    }

    S.pkg = pkg;

    /* 清单里的默认值填进表单（不覆盖用户已填） */
    if (pkg.title && !q('#imp-title-in').value) q('#imp-title-in').value = pkg.title;
    if (pkg.version && !q('#imp-ver').value) q('#imp-ver').value = pkg.version;
    if (pkg.updated && !q('#imp-date').value) q('#imp-date').value = pkg.updated;
    if (pkg.sceneId && !q('#imp-scene').value) {
      q('#imp-scene').value = pkg.sceneId;
      if (q('#imp-scene').value !== pkg.sceneId) {
        tip('清单里的 sceneId「' + pkg.sceneId + '」在地图里不存在，请手动选一个', 'is-err');
      }
    }
    if (!q('#imp-id').value) q('#imp-id').value = pkg.id || suggestId(q('#imp-scene').value);
    if (!q('#imp-date').value) q('#imp-date').value = today();
    paintMethods();   /* 清单声明了 methods 就按清单勾选，否则按场景 */

    paintFiles();
    tip('已载入，右侧是当前校验结果', 'is-ok');
    preview();
  }

  function fail(msg, hint) {
    paintResults([{ level: 'error', msg: msg, hint: hint || '' }]);
    tip('文件有问题，按右侧提示处理后重新上传', 'is-err');
  }

  /* ---- 模板下载 ---- */
  function download(name, blob) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }

  function downloadTemplate() {
    try {
      var zip = makeZip([
        { name: 'my-case/README.txt', text: TPL_README },
        { name: 'my-case/case.json', text: JSON.stringify(templateManifest(), null, 2) },
        { name: 'my-case/demo/index.html', text: TPL_HTML },
        { name: 'my-case/demo/demo.css', text: TPL_CSS },
        { name: 'my-case/demo/demo.js', text: TPL_JS }
      ]);
      download('案例包模板.zip', zip);
      tip('模板已下载：解压后改内容，再把 my-case 文件夹整个拖回这里', 'is-ok');
    } catch (e) {
      tip('打包失败：' + e.message, 'is-err');
    }
  }

  function downloadManifest() {
    download('my-case.json', new Blob([JSON.stringify(templateManifest(), null, 2)], { type: 'application/json;charset=utf-8' }));
    tip('清单模板已下载（只有文字内容，示范请另外打包）', 'is-ok');
  }

  /* ---- 试跑示范 ---- */
  function openPreview() {
    if (!S.pkg) { tip('请先载入案例包', 'is-err'); return; }
    var mode = global.CaseDemoHost.resolveMode({ files: S.files, demo: demoCfg(S.pkg) });
    if (mode === 'none') { tip('这个包没有可运行的示范', 'is-err'); return; }

    if (!S.pv) {
      S.pv = document.createElement('div');
      S.pv.className = 'mdl';
      S.pv.id = 'import-preview';
      S.pv.hidden = true;
      S.pv.innerHTML =
        '<div class="mdl-bg" data-pv-close></div>' +
        '<div class="mdl-p" role="dialog" aria-modal="true">' +
        '<div class="mdl-h"><div><div class="eyebrow">SANDBOX PREVIEW</div>' +
        '<h3>示范预览</h3></div><button class="mdl-x" data-pv-close aria-label="关闭预览">✕</button></div>' +
        '<div class="mdl-b pv-body" id="imp-pv-body"></div>' +
        '<div class="mdl-f"><span class="imp-tip">这是沙箱内的真实运行效果，与添加后完全一致。</span>' +
        '<span style="flex:1"></span><button class="btn" data-pv-close>关闭预览</button></div>' +
        '</div>';
      document.body.appendChild(S.pv);
      S.pv.addEventListener('click', function (e) {
        if (e.target.closest('[data-pv-close]')) closePreview();
      });
    }

    var body = S.pv.querySelector('#imp-pv-body');
    if (S.pvHandle) { try { S.pvHandle.destroy(); } catch (e) { } }
    S.pvHandle = global.CaseDemoHost.create(body, {
      files: S.files, demo: demoCfg(S.pkg), meta: metaNow()
    }, {});
    S.pv.hidden = false;
    document.documentElement.classList.add('mdl-open');
  }

  function closePreview() {
    if (S.pv) S.pv.hidden = true;
    if (S.pvHandle) { try { S.pvHandle.destroy(); } catch (e) { } S.pvHandle = null; }
    document.documentElement.classList.remove('mdl-open');
  }

  /* ---- 提交 ---- */
  function commit() {
    var meta = metaNow();
    var list = checkAll(S.pkg, meta, S.files);
    paintResults(list);
    var sum = summarize(list);

    if (!S.pkg) { tip('请先拖入案例文件夹', 'is-err'); return; }
    if (sum.errors) { tip(sum.errors + ' 项不符合要求，按右侧红色提示修改后再添加', 'is-err'); return; }

    saved = saved.filter(function (r) { return r.meta && r.meta.id !== meta.id; });
    var rec = { v: 2, pkg: S.pkg, meta: meta, files: S.files, savedAt: new Date().toISOString() };
    saved.push(rec);
    /* 同 id 的插件案例若曾被隐藏，重新上传时解除隐藏 */
    var bl = readBlocklist();
    if (bl.indexOf(meta.id) >= 0) writeBlocklist(bl.filter(function (x) { return x !== meta.id; }));

    var stored = writeStore(saved);
    global.Cases.register(toCase(rec));

    close();
    toast('已添加「' + meta.title + '」' + (stored ? '' : '（仅本次有效）'),
      stored ? '正在打开场景页…' : '内容太大，浏览器没能保存，刷新后会丢失');

    var target = '#/scene/' + meta.sceneId;
    setTimeout(function () {
      if (global.location.hash === target) global.dispatchEvent(new Event('hashchange'));
      else global.location.hash = target;
    }, 620);
  }

  function bind() {
    S.el.addEventListener('click', function (e) {
      if (e.target.closest('[data-close]')) { close(); }
    });

    var drop = q('#imp-drop'), fileIn = q('#imp-file'), dirIn = q('#imp-dir');

    /* 有些环境（国产浏览器兼容模式等）解析 innerHTML 时会丢非标准属性，
       或压根不支持 webkitdirectory —— 弹出的仍是普通文件框。这里补一次属性，
       并准备三级降级策略。 */
    try {
      dirIn.setAttribute('webkitdirectory', '');
      dirIn.setAttribute('directory', '');
    } catch (e) { }

    var HAS_DIR_ATTR = (function () {
      var t = document.createElement('input');
      t.type = 'file';
      return 'webkitdirectory' in t;
    })();
    var HAS_FSA = typeof global.showDirectoryPicker === 'function';

    /* 选文件夹三级策略：
       ① webkitdirectory 属性（Chrome / Edge / Firefox）
       ② showDirectoryPicker() 文件夹句柄 API（Chromium 86+）
       ③ 都没有 → 明确提示替代方式 */
    function pickDir() {
      if (HAS_DIR_ATTR) { dirIn.click(); return; }
      if (HAS_FSA) { pickDirFSA(); return; }
      tip('当前浏览器不支持「选择文件夹」按钮。三个替代办法：' +
        '① 把整个文件夹直接拖进虚线框（推荐）；' +
        '② 点「选择文件」，在弹出的对话框里进入案例文件夹后 Ctrl+A 全选所有文件；' +
        '③ 改用 Chrome 或 Edge 浏览器。', 'is-err');
    }

    /* 文件夹句柄 API：递归读出目录下所有 File，并补上相对路径 */
    function pickDirFSA() {
      var p;
      try { p = global.showDirectoryPicker(); } catch (e) { p = null; }
      if (!p || !p.then) { tip('浏览器拒绝了文件夹访问，请改用拖拽方式', 'is-err'); return; }
      p.then(function (root) {
        var out = [];
        tip('正在读取文件夹「' + root.name + '」…', '');
        walkDirHandle(root, root.name + '/', out).then(function () {
          if (!out.length) { tip('这个文件夹里没有文件', 'is-err'); return; }
          loadFiles(out);
        }).catch(function (e) {
          tip('读取文件夹失败：' + ((e && e.message) || e), 'is-err');
        });
      }).catch(function () { /* 用户取消，不打扰 */ });
    }

    function walkDirHandle(dir, prefix, out) {
      var iter = dir.values();
      function step() {
        return iter.next().then(function (r) {
          if (r.done) return null;
          var h = r.value;
          if (h.kind === 'file') {
            return h.getFile().then(function (f) {
              try {
                Object.defineProperty(f, 'webkitRelativePath', { value: prefix + f.name, configurable: true });
              } catch (e) { }
              out.push(f);
            }).then(step);
          }
          if (h.kind === 'directory') return walkDirHandle(h, prefix + h.name + '/', out).then(step);
          return step();
        });
      }
      return step();
    }

    /* 关键：两个输入框就放在虚线框内部，程序化 .click() 触发的合成 click 事件
       会冒泡回虚线框监听器，导致文件框 + 文件夹框连环弹出。
       双保险：① 输入框层面拦截冒泡；② 虚线框只响应真实用户点击。 */
    fileIn.addEventListener('click', function (e) { e.stopPropagation(); });
    dirIn.addEventListener('click', function (e) { e.stopPropagation(); });
    drop.addEventListener('click', function (e) {
      if (!e.isTrusted) return;
      if (e.target.closest('.btn')) return;
      if (e.target.closest('input')) return;
      fileIn.click();
    });
    q('#imp-pick-files').addEventListener('click', function (e) { e.stopPropagation(); fileIn.click(); });
    q('#imp-pick-dir').addEventListener('click', function (e) { e.stopPropagation(); pickDir(); });

    fileIn.addEventListener('change', function () { loadFiles(fileIn.files); fileIn.value = ''; });
    dirIn.addEventListener('change', function () { loadFiles(dirIn.files); dirIn.value = ''; });

    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('on'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('on'); });
    });
    drop.addEventListener('drop', function (e) {
      var dt = e.dataTransfer;
      if (!dt) return;
      /* 支持拖入文件夹：递归收集 */
      var items = dt.items ? [].slice.call(dt.items) : [];
      var entries = items.map(function (it) {
        return it.webkitGetAsEntry ? it.webkitGetAsEntry() : null;
      }).filter(Boolean);

      if (!entries.length) { loadFiles(dt.files); return; }

      tip('正在读取拖入的文件夹…', '');
      var collected = [];
      var pending = 0;

      function walk(entry, path) {
        if (entry.isFile) {
          pending++;
          entry.file(function (f) {
            try { Object.defineProperty(f, 'webkitRelativePath', { value: path + f.name, configurable: true }); } catch (e) { }
            collected.push(f);
            if (--pending === 0) loadFiles(collected);
          }, function () { if (--pending === 0) loadFiles(collected); });
        } else if (entry.isDirectory) {
          pending++;
          var reader = entry.createReader();
          var all = [];
          (function readMore() {
            reader.readEntries(function (batch) {
              if (!batch.length) {
                pending--;
                all.forEach(function (en) { walk(en, path + entry.name + '/'); });
                if (pending === 0) loadFiles(collected);
                return;
              }
              all = all.concat([].slice.call(batch));
              readMore();
            }, function () { pending--; if (pending === 0) loadFiles(collected); });
          })();
        }
      }

      entries.forEach(function (en) { walk(en, ''); });
    });

    q('#imp-dl').addEventListener('click', downloadTemplate);
    q('#imp-dl-json').addEventListener('click', downloadManifest);
    q('#imp-try').addEventListener('click', openPreview);
    q('#imp-ok').addEventListener('click', commit);

    q('#imp-clear').addEventListener('click', function () {
      S.pkg = null; S.manifest = null; S.files = []; S.raw = [];
      paintFiles();
      paintResults([]);
      tip('已清空，可以重新拖入', '');
    });

    q('#imp-list').addEventListener('click', function (e) {
      var b = e.target.closest('[data-del]');
      if (!b) return;
      var i = Number(b.getAttribute('data-del'));
      var f = S.raw[i];
      if (!f) return;
      S.raw.splice(i, 1);
      if (f === S.manifest) {
        S.manifest = null; S.pkg = null;
        S.files = S.raw.slice();
        tip('清单被移除了，需要重新拖入 case.json', 'is-err');
      } else {
        S.files = S.raw.filter(function (x) { return x !== S.manifest; });
      }
      paintFiles();
      preview();
    });

    ['#imp-title-in', '#imp-id', '#imp-scene', '#imp-ver', '#imp-date'].forEach(function (sel) {
      var el = q(sel);
      el.addEventListener('input', preview);
      el.addEventListener('change', function () {
        if (sel === '#imp-scene') {
          var idEl = q('#imp-id');
          if (!idEl.value || /-case(-\d+)?$/.test(idEl.value)) idEl.value = suggestId(el.value);
          paintMethods();   /* 换场景后按新场景重置技术勾选 */
        }
        preview();
      });
    });

    /* 技术芯片：勾选状态同步到样式并刷新校验 */
    q('#imp-methods').addEventListener('change', function (e) {
      var lab = e.target.closest('.imp-mchip');
      if (lab) lab.classList.toggle('on', e.target.checked);
      preview();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (S.pv && !S.pv.hidden) { closePreview(); return; }
      if (!S.el.hidden) close();
    });
  }

  function reset(opts) {
    S.pkg = null; S.manifest = null; S.files = []; S.raw = [];
    q('#imp-file').value = '';
    q('#imp-dir').value = '';
    q('#imp-pack').hidden = true;
    q('#imp-title-in').value = '';
    q('#imp-id').value = '';
    q('#imp-ver').value = '';
    q('#imp-date').value = today();
    q('#imp-scene').innerHTML = sceneOptions((opts && opts.sceneId) || '');
    q('#imp-scene').value = (opts && opts.sceneId) || '';
    if (opts && opts.sceneId) q('#imp-id').value = suggestId(opts.sceneId);
    paintMethods();
    paintResults([]);
    tip('表单里的名称 / 场景会覆盖清单里的同名字段。', '');
  }

  function open(opts) {
    if (!S.el) { S.el = build(); bind(); }
    reset(opts || {});
    S.el.hidden = false;
    document.documentElement.classList.add('mdl-open');
    setTimeout(function () { q('#imp-title-in').focus(); }, 60);
  }

  function close() {
    if (!S.el) return;
    closePreview();
    S.el.hidden = true;
    document.documentElement.classList.remove('mdl-open');
  }

  /* ---------------------------------------------------------
     7. 提示条
     --------------------------------------------------------- */
  var toastTimer = null;
  function toast(title, sub) {
    var el = document.getElementById('imp-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'imp-toast';
      el.className = 'toast';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      document.body.appendChild(el);
    }
    el.innerHTML = '<span class="toast-ic">✓</span><div><b>' + esc(title) + '</b>' +
      (sub ? '<span>' + esc(sub) + '</span>' : '') + '</div>';
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('on'); }, 3000);
  }

  /* ---------------------------------------------------------
     8. 对外接口
     --------------------------------------------------------- */
  function loadSaved() {
    /* v2 */
    saved = readStore(KEY).filter(function (r) { return r && r.pkg && r.meta && r.meta.id; });
    /* v1：只有清单没有文件，按原样升级 */
    readStore(KEY_V1).forEach(function (r) {
      if (!r || !r.pkg || !r.meta || !r.meta.id) return;
      if (saved.some(function (x) { return x.meta.id === r.meta.id; })) return;
      saved.push({ v: 1, pkg: r.pkg, meta: r.meta, files: [], savedAt: r.savedAt });
    });

    /* 内置插件案例也可以被本机上传的同 id 案例覆盖：
       上传的这份 imported=true，bySceneAll 会把它排到前面；移除后自动回退到内置版 */
    saved.forEach(function (r) {
      var cur = global.Cases.get(r.meta.id);
      if (cur && cur.imported) return;
      global.Cases.register(toCase(r));
    });
    /* 最后应用隐藏名单：被删除的插件案例不再出现 */
    applyBlocklist();
  }

  /* 删除案例：上传案例 = 移除本地存储；插件案例 = 记入隐藏名单。
     两者都在本次会话内立即注销并触发页面重渲染，不刷新。 */
  function remove(id) {
    var c = global.Cases.get(id);
    if (!c) return false;
    var isImported = !!c.imported;
    var msg = isImported
      ? '从本机移除案例「' + (c.title || id) + '」？\n将删除浏览器里保存的这份案例包，磁盘上的文件不受影响。'
      : '删除插件案例「' + (c.title || id) + '」？\n它的 .js 文件仍留在磁盘上，但会立即从站点消失，刷新后也保持隐藏；\n在案例库的「已隐藏」区可以随时恢复。';
    if (!global.confirm(msg)) return false;

    if (isImported) {
      saved = saved.filter(function (r) { return r.meta.id !== id; });
      writeStore(saved);
    } else {
      var bl = readBlocklist();
      if (bl.indexOf(id) < 0) { bl.push(id); writeBlocklist(bl); }
    }
    global.Cases.unregister(id);
    if (isImported && global.Cases.restorePrevious) {
      try { global.Cases.restorePrevious(id); } catch (e) { }
    }
    toast('已删除「' + (c.title || id) + '」', isImported ? '已回退到内置版本（若有）' : '页面已同步更新');
    global.dispatchEvent(new Event('hashchange'));
    return true;
  }

  /* 恢复被隐藏的插件案例：移出名单后刷新，让插件脚本重新注册 */
  function restore(id) {
    var bl = readBlocklist().filter(function (x) { return x !== id; });
    writeBlocklist(bl);
    global.location.reload();
    return true;
  }

  /* 管理后台编辑案例元信息：只支持本机上传的案例（插件案例的内容在磁盘文件里）。
     patch = { title, sceneId, methods, version, updated }，全部可选。 */
  function updateMeta(id, patch) {
    var rec = saved.filter(function (r) { return r.meta.id === id; })[0];
    if (!rec) return { ok: false, error: '不是本机上传的案例，无法在线编辑（插件案例请改源文件）' };
    var p = patch || {};
    if (p.title != null) rec.meta.title = String(p.title).slice(0, 40);
    if (p.version != null) rec.meta.version = String(p.version).slice(0, 16);
    if (p.updated != null) rec.meta.updated = String(p.updated).slice(0, 10);
    if (p.sceneId != null) {
      if (!sceneOf(p.sceneId)) return { ok: false, error: '目标场景不存在：' + p.sceneId };
      rec.meta.sceneId = p.sceneId;
    }
    if (p.methods != null) {
      if (!Array.isArray(p.methods)) return { ok: false, error: 'methods 应为数组' };
      rec.meta.methods = p.methods.filter(function (k) {
        return global.ATLAS.methods && global.ATLAS.methods[k];
      });
    }
    if (!writeStore(saved)) return { ok: false, error: '浏览器存储失败' };
    global.Cases.unregister(id);
    global.Cases.register(toCase(rec));
    return { ok: true };
  }

  function exported() {
    return saved.map(function (r) {
      return { id: r.meta.id, title: r.meta.title, sceneId: r.meta.sceneId, files: (r.files || []).length, savedAt: r.savedAt };
    });
  }

  global.CaseImport = {
    open: open,
    close: close,
    loadSaved: loadSaved,
    remove: remove,
    restore: restore,
    updateMeta: updateMeta,
    blockedList: readBlocklist,
    list: exported,
    template: templateManifest,
    check: function (pkg, meta) { return checkAll(pkg, meta, S.files); },
    makeZip: makeZip,
    templates: { manifest: TPL_README, html: TPL_HTML, css: TPL_CSS, js: TPL_JS }
  };

  /* 事件委托：任何带 data-import 的按钮都能唤起弹窗 */
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-import]');
    if (!btn) return;
    e.preventDefault();
    open({ sceneId: btn.getAttribute('data-scene') || '' });
  });

  /* 指南页/其它地方的"下载模板"按钮 */
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-dl-template]');
    if (!btn) return;
    e.preventDefault();
    if (!S.el) { S.el = build(); bind(); }
    downloadTemplate();
  });

  /* 案例库里的"移除/删除案例"（上传案例与插件案例共用） */
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-remove-case]');
    if (!btn) return;
    e.preventDefault();
    remove(btn.getAttribute('data-remove-case'));
  });

  /* 案例库"已隐藏"区里的"恢复" */
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-restore-case]');
    if (!btn) return;
    e.preventDefault();
    restore(btn.getAttribute('data-restore-case'));
  });

  /* 启动即恢复：必须在 shell.js 渲染之前完成 */
  if (global.Cases) {
    try { loadSaved(); } catch (e) { /* 存储损坏时静默跳过，不影响站点启动 */ }
  }

})(window);
