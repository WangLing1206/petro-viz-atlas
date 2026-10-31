/* =========================================================
   渲染工具箱 Render Kit
   ---------------------------------------------------------
   把"案例想表达什么"和"页面长什么样"分开：
   案例只调用这里的语义化函数，不写 CSS 类名。
   想改版式只需改本文件与 ui.css，所有案例同步生效。
   ========================================================= */

(function (global) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  /* 允许案例在文本里用极简标记：**粗体** 与 `等宽` */
  function rich(s) {
    var out = esc(s);
    out = out.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    out = out.replace(/`([^`]+)`/g, '<code style="font-family:var(--mono);font-size:.92em;background:var(--paper-2);padding:1px 4px;border-radius:3px">$1</code>');
    return out;
  }

  /* ---------- 标签 ---------- */
  function mtag(keys) {
    var M = (global.ATLAS && global.ATLAS.methods) || {};
    return (keys || []).map(function (k) {
      var m = M[k] || { abbr: k.toUpperCase() };
      return '<span class="mtag" data-m="' + k + '"><b>' + m.abbr + '</b></span>';
    }).join('');
  }

  function dtag(d) {
    return '<span class="dtag" data-d="' + esc(d) + '">难度 ' + esc(d) + '</span>';
  }

  /* ---------- 图 ---------- */
  function figure(svg, no, caption) {
    return '<div class="figure">' + svg + '</div>' +
      (caption ? '<div class="figcap"><b>图 ' + esc(no) + '</b><span>' + rich(caption) + '</span></div>' : '');
  }

  /* ---------- 四段式 ---------- */
  /* 段落类型只用于视觉区隔（PROBLEM / INTERVENTION / DATA / DIFFICULTY），
     不改变内容与顺序；案例作者只要按惯例写 en，样式自动对应。 */
  function secType(en) {
    var e = String(en == null ? '' : en).toUpperCase();
    if (e.indexOf('PROBLEM') >= 0 || e.indexOf('问题') >= 0) return 'problem';
    if (e.indexOf('INTERVENTION') >= 0 || e.indexOf('介入') >= 0) return 'intervention';
    if (e.indexOf('DATA') >= 0 || e.indexOf('数据') >= 0) return 'data';
    if (e.indexOf('DIFFICULTY') >= 0 || e.indexOf('难度') >= 0) return 'difficulty';
    return 'default';
  }

  function sec4(no, en, title, bodyHTML) {
    return '<div class="sec4" data-t="' + secType(en) + '"><div class="sn">' + pad(no) +
      '<span>' + esc(en) + '</span></div>' +
      '<div class="sec4-body"><h3>' + esc(title) + '</h3>' + bodyHTML + '</div></div>';
  }

  /* ---------- 30 秒判断 ---------- */
  function judge(cells) {
    return '<div class="judge">' + cells.map(function (c) {
      return '<div class="jc"><div class="jl">' + esc(c.label) + '</div>' +
        '<div class="jv">' + (c.html || rich(c.value)) + '</div>' +
        (c.desc ? '<div class="jd">' + rich(c.desc) + '</div>' : '') + '</div>';
    }).join('') + '</div>';
  }

  /* ---------- 表格 ---------- */
  function dtable(head, rows) {
    return '<table class="dtable"><thead><tr>' +
      head.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') +
      '</tr></thead><tbody>' + rows.map(function (r) {
        return '<tr>' + r.map(function (c) { return '<td>' + rich(c) + '</td>'; }).join('') + '</tr>';
      }).join('') + '</tbody></table>';
  }

  /* ---------- 数据清单（可勾选） ---------- */
  function checklist(items, title) {
    var head = title || '数据准备清单';
    var rows = items.map(function (d, i) {
      var name = Array.isArray(d) ? d[0] : d;
      var spec = Array.isArray(d) ? d[1] : '';
      var note = Array.isArray(d) ? d[2] : '';
      return '<div class="cl-item" data-cl="' + i + '">' +
        '<span class="cl-box"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6.5"/></svg></span>' +
        '<span><span class="cl-t">' + esc(name) + '</span>' +
        '<span class="cl-s">' + esc(spec) + '</span></span>' +
        '<span class="cl-n">' + esc(note) + '</span></div>';
    }).join('');
    return '<div class="checklist"><div class="cl-head">' +
      '<span>' + esc(head) + ' · ' + items.length + ' 项</span>' +
      '<span class="cl-prog"><span id="cl-txt">0 / ' + items.length + '</span>' +
      '<span class="cl-bar"><i id="cl-fill"></i></span></span></div>' + rows + '</div>';
  }

  /* ---------- 参考方向 ---------- */
  function refs(list, hrefPrefix) {
    return '<div class="refs">' + list.map(function (r) {
      var name = typeof r === 'string' ? r : r.name;
      var href = typeof r === 'string' ? hrefPrefix : (r.href || hrefPrefix);
      var ar = href ? '<span class="ar">↗</span>' : '';
      return href
        ? '<a class="ref" href="' + href + '">' + esc(name) + ar + '</a>'
        : '<span class="ref">' + esc(name) + '</span>';
    }).join('') + '</div>';
  }

  /* ---------- 难度条 ---------- */
  function meter(diff) {
    var lv = diff === '低' ? 1 : diff === '高' ? 3 : 2;
    return '<div class="meter">' + [1, 2, 3].map(function (i) {
      return '<i class="' + (i <= lv ? 'on' : '') + (i === 3 && lv === 3 ? ' hi' : '') + '"></i>';
    }).join('') + '</div>';
  }

  /* ---------- 编号指标格 ---------- */
  function cells(items) {
    return '<div class="case-cells">' + items.map(function (c) {
      var l = Array.isArray(c) ? c[0] : c.label;
      var v = Array.isArray(c) ? c[1] : c.value;
      var raw = Array.isArray(c) ? c[2] : c.html;
      var isNum = !raw && /^[\d.]+$/.test(String(v));
      return '<div><div class="l">' + esc(l) + '</div><div class="v">' +
        (raw ? v : isNum ? '<b>' + esc(v) + '</b>' : esc(v)) + '</div></div>';
    }).join('') + '</div>';
  }

  /* ---------- 流程步骤 ---------- */
  function roleType(role) {
    var r = String(role == null ? '' : role);
    if (r.indexOf('数据') >= 0) return 'data';
    if (r.indexOf('核心') >= 0) return 'core';
    if (r.indexOf('算法') >= 0) return 'algo';
    if (r.indexOf('人工') >= 0 || r.indexOf('业务') >= 0 || r.indexOf('工程') >= 0) return 'human';
    return 'default';
  }

  function pipeline(steps) {
    return '<div class="pipeline">' + steps.map(function (s, i) {
      return '<div class="pstep" data-r="' + roleType(s.role) + '"><div class="pn">' + pad(i + 1) + '</div><div class="pc">' +
        '<h4>' + esc(s.name) + (s.role ? '<span class="role">' + esc(s.role) + '</span>' : '') + '</h4>' +
        '<div class="pdo">' + rich(s.do) + '</div>' +
        (s.effect ? '<div class="peff"><span class="k">预期效果</span><span>' + rich(s.effect) + '</span></div>' : '') +
        (s.trap ? '<div class="peff" style="border-top-color:rgba(176,90,81,.2)"><span class="k" style="color:var(--bad)">常见坑</span><span>' + rich(s.trap) + '</span></div>' : '') +
        '</div></div>';
    }).join('') + '</div>';
  }

  /* ---------- 失败模式 ---------- */
  function fails(items) {
    return '<div class="fails">' + items.map(function (f, i) {
      return '<div class="fail"><div class="fi">FAIL ' + pad(i + 1) + '</div>' +
        '<h5>' + esc(f.name) + '</h5><p>' + rich(f.why) + '</p></div>';
    }).join('') + '</div>';
  }

  /* ---------- 提示条 ---------- */
  function callout(text, kind) {
    return '<div class="callout' + (kind === 'warn' ? ' warn' : '') + '">' +
      '<span class="ci">' + (kind === 'warn' ? '注意' : '说明') + '</span>' +
      '<span>' + rich(text) + '</span></div>';
  }

  /* ---------- 代码块 ---------- */
  function highlight(src) {
    var store = [];
    function stash(html) { store.push(html); return '\u0001' + (store.length - 1) + '\u0002'; }

    var s = String(src);
    // 注释
    s = s.replace(/\/\/[^\n]*/g, function (m) { return stash('<span class="c">' + esc(m) + '</span>'); });
    // 字符串
    s = s.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, function (m) {
      return stash('<span class="s">' + esc(m) + '</span>');
    });
    s = esc(s);
    s = s.replace(/\b(var|let|const|function|return|if|else|for|while|new|this|typeof|true|false|null|undefined)\b/g,
      '<span class="k">$1</span>');
    s = s.replace(/\u0001(\d+)\u0002/g, function (_, i) { return store[+i]; });
    return s;
  }

  function code(src, opts) {
    opts = opts || {};
    return '<div class="code">' +
      '<div class="code-top"><span class="dots"><i></i><i></i><i></i></span>' +
      esc(opts.file || 'snippet.js') + (opts.note ? ' · ' + esc(opts.note) : '') + '</div>' +
      '<pre>' + highlight(src) + '</pre></div>';
  }

  /* ---------- 文件树 ---------- */
  function tree(lines) {
    return '<div class="tree">' + lines.join('<br>') + '</div>';
  }

  global.K = {
    esc: esc, pad: pad, rich: rich,
    mtag: mtag, dtag: dtag,
    figure: figure, sec4: sec4, judge: judge,
    dtable: dtable, checklist: checklist, refs: refs, meter: meter,
    cells: cells, pipeline: pipeline, fails: fails,
    callout: callout, code: code, tree: tree, highlight: highlight
  };
})(window);
