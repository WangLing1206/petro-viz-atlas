/* =========================================================
   管理后台 Admin
   ---------------------------------------------------------
   路由：#/admin          登录（未登录时）
         #/admin/cases    案例：改标题 / 场景 / 技术标签 / 版本，删除
         #/admin/methods  技术：增删改 AI 技术类别
         #/admin/scenes   场景：增删改场景（绑定环节 / 技术标签 / 难度）
   账号：存在 localStorage[atlas.admin.v1]，首次自动创建
         admin / admin123（登录后可在页面上改密码）。
   场景与技术的增删改走 data.js 的 A.saveMethod / A.deleteMethod /
   A.saveScene / A.deleteScene，写入 localStorage 后全站立即生效。
   注意：这是纯静态演示站，密码仅做形式鉴权，不是安全边界。
   ========================================================= */

(function (global) {
  'use strict';

  var KEY = 'atlas.admin.v1';
  var SESS = 'atlas.admin.session';
  var ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

  /* djb2 —— 形式鉴权用，不追求密码学强度 */
  function hash(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }

  function account() {
    var r = null;
    try { r = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { }
    if (!r || !r.user || !r.hash) {
      r = { user: 'admin', hash: hash('admin123') };
      try { localStorage.setItem(KEY, JSON.stringify(r)); } catch (e) { }
    }
    return r;
  }

  function loggedIn() { return global.sessionStorage.getItem(SESS) === '1'; }

  function refresh() { global.dispatchEvent(new Event('hashchange')); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* =========================================================
     登录页
     ========================================================= */
  function loginHTML(msg) {
    return '<main class="wrap" style="max-width:460px;padding-top:70px">' +
      '<div class="adm-card">' +
      '<div class="eyebrow">ADMIN SIGN IN</div><h2 style="margin:8px 0 4px">管理员登录</h2>' +
      '<p class="small muted">登录后可管理案例、技术类别与场景。默认账号 <b>admin</b>，默认密码 <b>admin123</b>，登录后请尽快修改。</p>' +
      (msg ? '<div class="callout warn" style="margin:12px 0"><span class="ci">!</span><span>' + esc(msg) + '</span></div>' : '') +
      '<label class="imp-f"><span>账号</span><input type="text" id="adm-user" autocomplete="username"></label>' +
      '<label class="imp-f"><span>密码</span><input type="password" id="adm-pass" autocomplete="current-password"></label>' +
      '<div style="display:flex;gap:8px;margin-top:16px">' +
      '<button class="btn primary" id="adm-login">登录</button>' +
      '<a class="btn ghost" href="#/">返回站点</a></div>' +
      '<p class="small muted" style="margin-top:14px">本站为纯静态演示，账号只做操作门槛，不是安全边界。</p>' +
      '</div></main>';
  }

  function doLogin() {
    var u = document.getElementById('adm-user');
    var p = document.getElementById('adm-pass');
    var acc = account();
    if (u.value.trim() !== acc.user || hash(p.value) !== acc.hash) {
      alert('账号或密码不对。默认 admin / admin123。');
      return;
    }
    global.sessionStorage.setItem(SESS, '1');
    global.location.hash = '#/admin/cases';
    refresh();
  }

  function bindLogin() {
    var b = document.getElementById('adm-login');
    if (!b) return;
    b.addEventListener('click', doLogin);
    document.getElementById('adm-pass').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') doLogin();
    });
  }

  /* =========================================================
     页面骨架
     ========================================================= */
  var TABS = [
    ['', '概览'], ['cases', '案例管理'], ['methods', '技术管理'], ['scenes', '场景管理']
  ];

  function shellHTML(cur, inner) {
    var tabs = TABS.map(function (t) {
      var href = '#/admin' + (t[0] ? '/' + t[0] : '');
      return '<button class="chip' + (cur === t[0] ? ' on' : '') + '" data-adm-tab="' + t[0] + '">' + t[1] + '</button>';
    }).join('');
    return '<main class="wrap">' +
      '<div class="page-head"><div class="ph-top"><div>' +
      '<div class="ph-idx">ADMIN CONSOLE</div><h1>管理后台</h1>' +
      '<p class="blurb">增删改案例、技术类别与场景。所有改动保存在本机浏览器并立即生效；内置数据不动，刷新后由覆盖层自动恢复。</p>' +
      '</div><div class="ph-stat"><div><div class="n">' + global.Cases.list().length + '</div><div class="l">案例</div></div>' +
      '<div><div class="n">' + Object.keys(global.ATLAS.methods).length + '</div><div class="l">技术</div></div>' +
      '<div><div class="n">' + global.ATLAS.allScenes.length + '</div><div class="l">场景</div></div></div></div></div>' +
      '<div class="adm-bar"><div class="filters" style="border:0;padding:0">' + tabs + '</div>' +
      '<span class="mono" id="adm-msg"></span>' +
      '<span style="flex:1"></span>' +
      '<button class="btn sm" id="adm-pass-btn">改密码</button>' +
      '<button class="btn sm ghost" id="adm-logout">退出登录</button></div>' +
      inner + '</main>';
  }

  /* 页面内操作反馈（不用 alert：不阻塞，且能在无头环境正常工作） */
  function admMsg(text, isErr) {
    var el = document.getElementById('adm-msg');
    if (!el) return;
    el.textContent = text;
    el.style.color = isErr ? 'var(--bad)' : 'var(--jade-d)';
  }

  function chipBox(id, keys, on) {
    var M = global.ATLAS.methods;
    on = on || [];
    return '<div class="imp-methods" id="' + id + '">' +
      Object.keys(M).map(function (k) {
        var act = on.indexOf(k) >= 0;
        return '<label class="imp-mchip' + (act ? ' on' : '') + '" data-mkey="' + k + '">' +
          '<input type="checkbox" value="' + k + '"' + (act ? ' checked' : '') + '>' +
          '<b>' + esc(M[k].abbr) + '</b>' + esc(M[k].name) + '</label>';
      }).join('') + '</div>';
  }

  function stageOptions(sel) {
    return global.ATLAS.stages.map(function (st) {
      return '<option value="' + esc(st.id) + '"' + (st.id === sel ? ' selected' : '') + '>' +
        esc(st.idx + ' ' + st.name) + '</option>';
    }).join('');
  }

  /* =========================================================
     概览
     ========================================================= */
  function overviewHTML() {
    var s = global.Cases.stats();
    var A = global.ATLAS;
    return '<div class="adm-grid">' +
      '<div class="adm-card"><h4>案例接入</h4>' +
      '<p class="small muted">' + s.registered + ' 个案例，覆盖 ' + s.coveredScenes + ' / ' + s.totalScenes + ' 个场景；其中 ' + s.withDemo + ' 个带可运行示范。</p>' +
      '<a class="btn sm" href="#/cases">打开案例库 →</a></div>' +
      '<div class="adm-card"><h4>技术类别</h4>' +
      '<p class="small muted">当前 ' + Object.keys(A.methods).length + ' 类：' +
      Object.keys(A.methods).map(function (k) { return esc(A.methods[k].name); }).join('、') + '。</p>' +
      '<p class="small muted">删除某类技术前，需要先把它从所有场景上摘掉。</p></div>' +
      '<div class="adm-card"><h4>安全提示</h4>' +
      '<p class="small muted">账号与所有数据都只存在本机浏览器；清浏览器数据会同时清掉案例存档与管理员改动。</p></div>' +
      '</div>';
  }

  /* =========================================================
     案例管理
     ========================================================= */
  function casesHTML() {
    var A = global.ATLAS;
    var rows = global.Cases.list().map(function (c) {
      var sc = A.index.byScene[c.sceneId];
      var mChips = (c.methods || []).map(function (k) {
        var m = A.methods[k];
        return m ? '<span class="mtag sm" data-m="' + (m.colorKey || k) + '"><b>' + esc(m.abbr) + '</b>' + esc(m.name) + '</span>' : '';
      }).join('') || '<span class="dim-mark">继承场景</span>';
      return '<tr><td class="id">' + esc(c.id) + '</td>' +
        '<td><div class="nm">' + esc(c.title || '（无标题）') + '</div>' +
        '<div class="sc">' + (sc ? esc(sc.stageName) + ' / ' + esc(sc.name) : '⚠ 场景未匹配') +
        (c.imported ? ' <span class="badge-local">本地导入</span>' : '') + '</div></td>' +
        '<td>' + mChips + '</td>' +
        '<td class="sc">' + esc(c.version || '—') + '</td>' +
        '<td>' +
        '<a href="#" class="link-remove" data-adm-edit-case="' + esc(c.id) + '">编辑</a> ' +
        '<a href="#" class="link-remove" data-adm-del-case="' + esc(c.id) + '">删除</a>' +
        '</td></tr>';
    }).join('');

    return '<div class="adm-note">' +
      '<b>编辑</b>只对本机上传的案例生效（可改标题、场景、技术标签、版本）；插件案例的内容在磁盘文件里，请改源文件。' +
      '同一个场景可以挂多个案例。</div>' +
      '<div class="matrix-wrap" style="box-shadow:var(--sh-1)">' +
      '<table class="sys-table"><thead><tr>' +
      '<th>案例 id</th><th>标题 / 场景</th><th>技术标签</th><th>版本</th><th>操作</th>' +
      '</tr></thead><tbody>' + (rows || '<tr><td colspan="5" class="empty">还没有案例</td></tr>') + '</tbody></table></div>';
  }

  function editCaseHTML(id) {
    var c = global.Cases.get(id);
    if (!c) return '';
    if (!c.imported) {
      return '<div class="adm-edit"><div class="callout warn"><span class="ci">!</span><span>「' + esc(id) +
        '」是插件案例（assets/cases/*.case.js），内容在磁盘文件里，只能删除或改源文件，无法在线编辑。</span></div></div>';
    }
    var A = global.ATLAS;
    return '<div class="adm-edit" data-editing="' + esc(id) + '">' +
      '<h4>编辑案例：' + esc(id) + '</h4>' +
      '<div class="adm-form">' +
      '<label class="imp-f"><span>标题</span><input type="text" id="adm-c-title" value="' + esc(c.title || '') + '" maxlength="40"></label>' +
      '<label class="imp-f"><span>所属场景</span><select id="adm-c-scene">' +
      sceneOptionsFor(c.sceneId) + '</select></label>' +
      '<div class="imp-f"><span>技术标签</span>' + chipBox('adm-c-methods', Object.keys(A.methods), c.methods || []) + '</div>' +
      '<div class="adm-f2">' +
      '<label class="imp-f"><span>版本</span><input type="text" id="adm-c-ver" value="' + esc(c.version || '') + '" maxlength="16"></label>' +
      '<label class="imp-f"><span>更新日期</span><input type="date" id="adm-c-date" value="' + esc(c.updated || '') + '"></label>' +
      '</div></div>' +
      '<div style="display:flex;gap:8px;margin-top:12px">' +
      '<button class="btn primary sm" id="adm-c-save">保存修改</button>' +
      '<button class="btn sm ghost" id="adm-c-cancel">取消</button></div>' +
      '</div>';
  }

  function sceneOptionsFor(sel) {
    return global.ATLAS.stages.map(function (st) {
      return '<optgroup label="' + esc(st.name) + '">' + st.scenes.map(function (sc) {
        return '<option value="' + esc(sc.id) + '"' + (sc.id === sel ? ' selected' : '') + '>' + esc(sc.name) + '</option>';
      }).join('') + '</optgroup>';
    }).join('');
  }

  /* =========================================================
     技术管理
     ========================================================= */
  function methodsHTML(editKey) {
    var A = global.ATLAS;
    var editing = editKey ? A.methods[editKey] : null;
    var rows = Object.keys(A.methods).map(function (k) {
      var m = A.methods[k];
      var used = A.allScenes.filter(function (s) { return s.methods.indexOf(k) >= 0; }).length;
      var builtin = !A.colors || A.colors[k] === k;
      return '<tr><td class="id">' + esc(k) + '</td>' +
        '<td class="nm">' + esc(m.abbr) + '</td>' +
        '<td>' + esc(m.name) + (builtin ? ' <span class="dim-mark">内置</span>' : ' <span class="badge-local">自定义</span>') + '</td>' +
        '<td class="sc">' + esc(m.signal || '—') + '</td>' +
        '<td>' + used + ' 个场景</td>' +
        '<td><a href="#" class="link-remove" data-adm-edit-m="' + esc(k) + '">编辑</a> ' +
        '<a href="#" class="link-remove" data-adm-del-m="' + esc(k) + '">删除</a></td></tr>';
    }).join('');

    return '<div class="adm-edit">' +
      '<h4>' + (editing ? '编辑技术：' + esc(editKey) : '新增技术类别') + '</h4>' +
      '<div class="adm-form">' +
      '<label class="imp-f"><span>key（小写英文）<i>*</i></span>' +
      '<input type="text" id="adm-m-key" ' + (editing ? 'value="' + esc(editKey) + '" readonly' : 'placeholder="agent"') + ' maxlength="12">' +
      '<em>用于配色与场景标签，建好后不可改</em></label>' +
      '<div class="adm-f2">' +
      '<label class="imp-f"><span>缩写 <i>*</i></span><input type="text" id="adm-m-abbr" value="' + esc(editing ? editing.abbr : '') + '" placeholder="AG" maxlength="6"></label>' +
      '<label class="imp-f"><span>名称 <i>*</i></span><input type="text" id="adm-m-name" value="' + esc(editing ? editing.name : '') + '" placeholder="智能体" maxlength="20"></label>' +
      '</div>' +
      '<label class="imp-f"><span>一句话说明</span><input type="text" id="adm-m-desc" value="' + esc(editing ? editing.desc : '') + '" maxlength="120"></label>' +
      '<label class="imp-f"><span>擅长信号</span><input type="text" id="adm-m-signal" value="' + esc(editing ? editing.signal : '') + '" placeholder="预测 / 分段 / 异常" maxlength="24"></label>' +
      '</div>' +
      '<div style="display:flex;gap:8px;margin-top:12px">' +
      '<button class="btn primary sm" id="adm-m-save">' + (editing ? '保存修改' : '添加技术') + '</button>' +
      (editing ? '<button class="btn sm ghost" id="adm-m-cancel">取消编辑</button>' : '') +
      '</div></div>' +

      '<div class="matrix-wrap" style="box-shadow:var(--sh-1);margin-top:16px">' +
      '<table class="sys-table"><thead><tr>' +
      '<th>key</th><th>缩写</th><th>名称</th><th>擅长信号</th><th>使用量</th><th>操作</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  /* =========================================================
     场景管理
     ========================================================= */
  function scenesHTML(editId) {
    var A = global.ATLAS;
    var editing = editId ? A.index.byScene[editId] : null;
    var rows = A.allScenes.map(function (sc) {
      var n = global.Cases.bySceneAll(sc.id).length;
      return '<tr><td class="id">' + esc(sc.id) + '</td>' +
        '<td><div class="nm">' + esc(sc.name) + (sc.__user ? ' <span class="badge-local">自定义</span>' : '') + '</div>' +
        '<div class="sc">' + esc(sc.stageName) + '</div></td>' +
        '<td class="sc">' + esc(sc.methods.join(' / ')) + '</td>' +
        '<td>' + esc(sc.diff) + '</td>' +
        '<td>' + (n ? '<span class="ok-mark">' + n + ' 个案例</span>' : '<span class="dim-mark">未接入</span>') + '</td>' +
        '<td><a href="#" class="link-remove" data-adm-edit-s="' + esc(sc.id) + '">编辑</a> ' +
        '<a href="#" class="link-remove" data-adm-del-s="' + esc(sc.id) + '">删除</a></td></tr>';
    }).join('');

    var diffSel = function (cur) {
      return ['低', '中', '高'].map(function (d) {
        return '<option value="' + d + '"' + (d === (cur || '中') ? ' selected' : '') + '>' + d + '</option>';
      }).join('');
    };

    return '<div class="adm-edit">' +
      '<h4>' + (editing ? '编辑场景：' + esc(editing.id) : '新增场景') + '</h4>' +
      '<div class="adm-form">' +
      '<div class="adm-f2">' +
      '<label class="imp-f"><span>场景 id <i>*</i></span>' +
      '<input type="text" id="adm-s-id" ' + (editing ? 'value="' + esc(editing.id) + '" readonly' : 'placeholder="w9"') + ' maxlength="8"></label>' +
      '<label class="imp-f"><span>场景名称 <i>*</i></span>' +
      '<input type="text" id="adm-s-name" value="' + esc(editing ? editing.name : '') + '" maxlength="30"></label>' +
      '</div>' +
      '<div class="adm-f3">' +
      '<label class="imp-f"><span>所属环节</span><select id="adm-s-stage">' +
      stageOptions(editing ? editing.stageId : '') + '</select></label>' +
      '<label class="imp-f"><span>难度</span><select id="adm-s-diff">' + diffSel(editing && editing.diff) + '</select></label>' +
      '<label class="imp-f"><span>状态</span><select id="adm-s-status">' +
      '<option value="full"' + (!editing || editing.status === 'full' ? ' selected' : '') + '>详解</option>' +
      '<option value="ext"' + (editing && editing.status === 'ext' ? ' selected' : '') + '>待扩展</option></select></label>' +
      '</div>' +
      '<div class="imp-f"><span>技术类别 <i>*</i></span>' +
      chipBox('adm-s-methods', Object.keys(A.methods), editing ? editing.methods : []) + '</div>' +
      '<label class="imp-f"><span>场景介绍（一句话）</span><input type="text" id="adm-s-intro" value="' + esc(editing ? editing.intro : '') + '" maxlength="120"></label>' +
      '<label class="imp-f"><span>AI 介入点</span><input type="text" id="adm-s-point" value="' + esc(editing ? editing.point : '') + '" maxlength="120"></label>' +
      '<label class="imp-f"><span>业务问题描述</span><input type="text" id="adm-s-problem" value="' + esc(editing ? editing.problem : '') + '" maxlength="120"></label>' +
      '<label class="imp-f"><span>难度原因</span><input type="text" id="adm-s-why" value="' + esc(editing ? editing.diffWhy : '') + '" maxlength="120"></label>' +
      '</div>' +
      '<div style="display:flex;gap:8px;margin-top:12px">' +
      '<button class="btn primary sm" id="adm-s-save">' + (editing ? '保存修改' : '添加场景') + '</button>' +
      (editing ? '<button class="btn sm ghost" id="adm-s-cancel">取消编辑</button>' : '') +
      '</div></div>' +

      '<div class="matrix-wrap" style="box-shadow:var(--sh-1);margin-top:16px">' +
      '<table class="sys-table"><thead><tr>' +
      '<th>id</th><th>场景</th><th>技术</th><th>难度</th><th>案例</th><th>操作</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  /* =========================================================
     路由与事件
     ========================================================= */
  function route(p, q) {
    if (!loggedIn()) return loginHTML();
    var sub = p[1] || '';
    var editId = q.edit || '';
    var inner;
    if (sub === 'cases') inner = (editId ? editCaseHTML(editId) : '') + casesHTML();
    else if (sub === 'methods') inner = methodsHTML(editId);
    else if (sub === 'scenes') inner = scenesHTML(editId);
    else inner = overviewHTML();
    return shellHTML(sub, inner);
  }

  function chipVals(id) {
    var box = document.getElementById(id);
    if (!box) return [];
    return [].slice.call(box.querySelectorAll('input:checked')).map(function (i) { return i.value; });
  }
  function bindChips(id) {
    var box = document.getElementById(id);
    if (!box) return;
    box.addEventListener('change', function (e) {
      var lab = e.target.closest('.imp-mchip');
      if (lab) lab.classList.toggle('on', e.target.checked);
    });
  }
  /* 在页面上挂一个委托点击监听；sel 里自己判断目标 */
  function bindCheck(root, sel) {
    root.addEventListener('click', sel);
  }
  function val(id) {
    var el = document.getElementById(id);
    return el ? el.value.trim() : '';
  }

  function bind(root) {
    if (!loggedIn()) { bindLogin(); return; }

    /* 顶栏 */
    [].forEach.call(root.querySelectorAll('[data-adm-tab]'), function (b) {
      b.addEventListener('click', function () {
        global.location.hash = '#/admin' + (b.dataset.admTab ? '/' + b.dataset.admTab : '');
      });
    });
    var lo = document.getElementById('adm-logout');
    if (lo) lo.addEventListener('click', function () {
      global.sessionStorage.removeItem(SESS);
      global.location.hash = '#/';
      refresh();
    });
    var pb = document.getElementById('adm-pass-btn');
    if (pb) pb.addEventListener('click', function () {
      var p = prompt('输入新密码（至少 6 位）：');
      if (p == null) return;
      if (p.length < 6) { alert('密码太短'); return; }
      var acc = account();
      acc.hash = hash(p);
      try { localStorage.setItem(KEY, JSON.stringify(acc)); alert('密码已更新'); }
      catch (e) { alert('保存失败：' + e.message); }
    });

    /* 案例编辑 */
    bindCheck(root, function (e) {
      var t = e.target.closest('[data-adm-edit-case]');
      if (t) { e.preventDefault(); global.location.hash = '#/admin/cases?edit=' + t.dataset.admEditCase; }
    });
    bindCheck(root, function (e) {
      var t = e.target.closest('[data-adm-del-case]');
      if (!t) return;
      e.preventDefault();
      global.CaseImport.remove(t.dataset.admDelCase);
      refresh();
    });
    bindCheck(root, function (e) {
      if (e.target.id !== 'adm-c-save' && e.target.id !== 'adm-c-cancel') return;
      e.preventDefault();
      if (e.target.id === 'adm-c-cancel') { global.location.hash = '#/admin/cases'; return; }
      var r = global.CaseImport.updateMeta(root.querySelector('.adm-edit').dataset.editing, {
        title: val('adm-c-title'),
        sceneId: val('adm-c-scene'),
        methods: chipVals('adm-c-methods'),
        version: val('adm-c-ver'),
        updated: val('adm-c-date')
      });
      admMsg(r.ok ? '已保存，站点已同步更新。' : ('保存失败：' + r.error), !r.ok);
      if (r.ok) { global.location.hash = '#/admin/cases'; refresh(); }
    });
    bindChips('adm-c-methods');

    /* 技术管理 */
    bindCheck(root, function (e) {
      var t = e.target.closest('[data-adm-edit-m]');
      if (t) { e.preventDefault(); global.location.hash = '#/admin/methods?edit=' + t.dataset.admEditM; }
    });
    bindCheck(root, function (e) {
      var t = e.target.closest('[data-adm-del-m]');
      if (!t) return;
      e.preventDefault();
      if (!confirm('删除技术类别「' + t.dataset.admDelM + '」？')) return;
      var r = global.ATLAS.deleteMethod(t.dataset.admDelM);
      if (!r.ok) admMsg(r.error, true); else admMsg('技术类别已删除。');
      refresh();
    });
    bindCheck(root, function (e) {
      if (e.target.id !== 'adm-m-save' && e.target.id !== 'adm-m-cancel') return;
      e.preventDefault();
      if (e.target.id === 'adm-m-cancel') { global.location.hash = '#/admin/methods'; return; }
      var r = global.ATLAS.saveMethod({
        key: val('adm-m-key'),
        abbr: val('adm-m-abbr'),
        name: val('adm-m-name'),
        desc: val('adm-m-desc'),
        signal: val('adm-m-signal')
      });
      if (!r.ok) { admMsg(r.error, true); return; }
      global.location.hash = '#/admin/methods';
      refresh();
    });

    /* 场景管理 */
    bindCheck(root, function (e) {
      var t = e.target.closest('[data-adm-edit-s]');
      if (t) { e.preventDefault(); global.location.hash = '#/admin/scenes?edit=' + t.dataset.admEditS; }
    });
    bindCheck(root, function (e) {
      var t = e.target.closest('[data-adm-del-s]');
      if (!t) return;
      e.preventDefault();
      if (!confirm('删除场景「' + t.dataset.admDelS + '」？关联的环节列表会同步移除。')) return;
      var r = global.ATLAS.deleteScene(t.dataset.admDelS);
      if (!r.ok) admMsg(r.error, true); else admMsg('场景已删除。');
      refresh();
    });
    bindCheck(root, function (e) {
      if (e.target.id !== 'adm-s-save' && e.target.id !== 'adm-s-cancel') return;
      e.preventDefault();
      if (e.target.id === 'adm-s-cancel') { global.location.hash = '#/admin/scenes'; return; }
      var r = global.ATLAS.saveScene({
        id: val('adm-s-id'),
        name: val('adm-s-name'),
        stageId: val('adm-s-stage'),
        methods: chipVals('adm-s-methods'),
        diff: val('adm-s-diff'),
        status: val('adm-s-status'),
        intro: val('adm-s-intro'),
        point: val('adm-s-point'),
        problem: val('adm-s-problem'),
        diffWhy: val('adm-s-why')
      });
      if (!r.ok) { admMsg(r.error, true); return; }
      global.location.hash = '#/admin/scenes';
      refresh();
    });
    bindChips('adm-s-methods');
  }

  global.Admin = {
    loggedIn: loggedIn,
    route: route,
    bind: bind
  };
})(window);
