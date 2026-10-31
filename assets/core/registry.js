/* =========================================================
   案例注册表 Case Registry
   ---------------------------------------------------------
   这是"系统"与"案例"之间唯一的接口。
   案例文件只做一件事：调用 Cases.register({...}) 声明自己。
   外壳不关心案例内部长什么样，只按契约取数据渲染。

   契约参见 assets/cases/_template.case.js
   ========================================================= */

(function (global) {
  'use strict';

  var ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
  var STATUS = ['ready', 'draft'];

  var store = Object.create(null);
  var order = [];
  var problems = [];
  var shadow = Object.create(null);   /* 被同 id 上传案例覆盖掉的内置案例，移除后可以立刻回退 */

  function reg(def) {
    if (!def || typeof def !== 'object') {
      problems.push('register() 收到非对象参数，已忽略');
      return null;
    }
    if (!def.id) {
      problems.push('案例缺少 id 字段，已忽略：' + (def.title || '(无标题)'));
      return null;
    }
    if (store[def.id]) {
      if (!store[def.id].imported && def.imported) shadow[def.id] = store[def.id];
      problems.push('案例 id 重复，后者覆盖前者：' + def.id);
      var i = order.indexOf(def.id);
      if (i >= 0) order.splice(i, 1);
    }
    store[def.id] = def;
    order.push(def.id);
    return def;
  }

  /* 移除本机上传的案例后，把被它覆盖的内置版放回来（同一会话内立即生效） */
  function restorePrevious(id) {
    var prev = shadow[id];
    if (!prev) return false;
    delete shadow[id];
    return !!reg(prev);
  }

  function get(id) { return store[id] || null; }

  /* 运行时移除：上传案例删除后不希望再出现；插件案例的
     「删除（隐藏）」也走这里，是否跨会话由调用方决定 */
  function unregister(id) {
    if (!store[id]) return false;
    delete store[id];
    var i = order.indexOf(id);
    if (i >= 0) order.splice(i, 1);
    return true;
  }

  /* 一个场景可以挂多个案例；导入（上传）的排前面，插件案例按注册顺序兜底 */
  function bySceneAll(sceneId) {
    var imported = [], builtin = [];
    for (var i = 0; i < order.length; i++) {
      var c = store[order[i]];
      if (c.sceneId !== sceneId) continue;
      (c.imported ? imported : builtin).push(c);
    }
    return imported.concat(builtin);
  }

  function byScene(sceneId) {
    var all = bySceneAll(sceneId);
    return all.length ? all[0] : null;
  }

  function list() {
    return order.map(function (id) { return store[id]; });
  }

  /* ---------- 校验：返回结构化结果，供控制台展示 ---------- */
  function validate(c) {
    var out = [];
    function ok(label, detail) { out.push({ level: 'ok', label: label, detail: detail || '' }); }
    function warn(label, detail) { out.push({ level: 'warn', label: label, detail: detail || '' }); }
    function err(label, detail) { out.push({ level: 'error', label: label, detail: detail || '' }); }

    // 1. id 规范
    if (!c.id) err('id 缺失');
    else if (!ID_RE.test(c.id)) err('id 命名不规范', '只允许小写字母、数字与连字符，例如 welllog-layer');
    else ok('id 规范', c.id);

    // 2. 绑定场景
    var A = global.ATLAS;
    var scene = null;
    if (!c.sceneId) err('sceneId 缺失', '必须指向 ATLAS 中的某个场景 id');
    else if (A && A.index && A.index.byId) {
      scene = A.index.byId[c.sceneId];
      if (scene) ok('场景已绑定', scene.name + '（' + c.sceneId + '）');
      else err('sceneId 不存在', '在 data.js 中找不到 ' + c.sceneId);
    } else {
      warn('数据层未就绪', '无法校验 sceneId');
    }

    // 3. 元信息
    if (!c.title) err('title 缺失');
    else ok('标题', c.title);
    if (c.version) ok('版本', c.version); else warn('未声明 version');
    if (c.updated) ok('更新日期', c.updated); else warn('未声明 updated');
    if (STATUS.indexOf(c.status) < 0) warn('status 建议填 ready 或 draft', '当前：' + c.status);

    // 4. 三个 tab
    var t = c.tabs || {};
    if (!t.background) err('缺少 tabs.background', '专业背景 tab 是必需项');
    else {
      var secs = (t.background.sections || []);
      if (secs.length < 2) warn('background.sections 少于 2 段', '建议按四段式写：问题 / 介入点 / 数据 / 难度');
      else ok('background 段落', secs.length + ' 段');
      var badSec = secs.filter(function (s) { return !s.title || !(s.html || s.body); });
      if (badSec.length) err('有段落缺 title 或内容', badSec.map(function (s) { return s.title || '(无题)'; }).join('、'));
    }

    if (!t.workflow) warn('缺少 tabs.workflow', '没有流程 tab，页面只显示两个 tab');
    else {
      var steps = (t.workflow.steps || []);
      if (!steps.length) err('workflow.steps 为空');
      else ok('workflow 步骤', steps.length + ' 步');
    }

    if (!t.demo) {
      warn('没有可运行示范', 'demo 为可选项，但带示范的场景更容易被立项');
    } else if (typeof t.demo.mount !== 'function') {
      err('tabs.demo.mount 不是函数', '应为 mount(root, ctx)');
    } else {
      ok('可运行示范', '已挂载 mount()');
    }

    // 5. 场景声明与案例的一致性
    if (scene) {
      if (scene.demo && !t.demo) warn('场景标记了 demo:true，但案例没有示范', '二者应保持一致');
      if (!scene.demo && t.demo) warn('案例有示范，但场景未标记 demo:true', '列表页不会显示"可运行"徽标');
    }

    // 6. 同场景多案例：现在是受支持的能力，只做信息提示
    var sibs = bySceneAll(c.sceneId).filter(function (x) { return x.id !== c.id; });
    if (sibs.length) ok('同场景还有 ' + sibs.length + ' 个案例', '多案例场景会在页面顶部显示案例切换器：' + sibs.map(function (x) { return x.id; }).join('、'));

    return out;
  }

  function validateAll() {
    var map = {};
    list().forEach(function (c) { map[c.id] = validate(c); });
    return map;
  }

  function stats() {
    var A = global.ATLAS;
    var total = A ? A.allScenes.length : 0;
    var withDemo = 0, ready = 0;
    var covered = {};
    list().forEach(function (c) {
      if (c.status === 'ready') ready++;
      if (c.tabs && c.tabs.demo && typeof c.tabs.demo.mount === 'function') withDemo++;
      covered[c.sceneId] = 1;
    });
    return {
      registered: order.length, ready: ready, withDemo: withDemo,
      totalScenes: total,
      coveredScenes: Object.keys(covered).length
    };
  }

  global.Cases = {
    register: reg,
    restorePrevious: restorePrevious,
    unregister: unregister,
    get: get,
    byScene: byScene,
    bySceneAll: bySceneAll,
    list: list,
    validate: validate,
    validateAll: validateAll,
    stats: stats,
    problems: function () { return problems.slice(); }
  };
})(window);
