#!/usr/bin/env node
/* ==========================================================================
   开发者文档：docs/service-contract.md → design/developers.html

   网页由 Markdown 生成，两边永远一致。只支持这份文档用到的语法：
   标题、段落、无序/有序列表、表格、代码块、引用、分隔线、行内代码、粗体。
   改文档只改 Markdown，然后运行：node scripts/build-dev-docs.js
   ========================================================================== */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "docs", "service-contract.md");
const OUT = path.join(ROOT, "design", "developers.html");

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/// 行内：先把行内代码抠出来，避免里面的 ** 被当成粗体
function inline(s) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return "\u0000" + (codes.length - 1) + "\u0000"; });
  s = esc(s).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => "<code>" + esc(codes[Number(i)]) + "</code>");
}

function slug(t, used) {
  let s = t.replace(/^\d+\.\s*/, "").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").toLowerCase() || "s";
  while (used.has(s)) s += "-";
  used.add(s);
  return s;
}

function convert(md) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  const toc = [];
  const used = new Set();
  let title = "", lead = [];
  let i = 0;

  const isTableSep = (l) => /^\|?\s*:?-{3,}/.test(l);
  const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

  while (i < lines.length) {
    const l = lines[i];

    if (/^```/.test(l)) {
      const lang = l.slice(3).trim();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push('<pre class="code-block"' + (lang ? ' data-lang="' + esc(lang) + '"' : "") + "><code>" + esc(buf.join("\n")) + "</code></pre>");
      continue;
    }
    if (/^# /.test(l)) { title = l.slice(2).trim(); i++; continue; }
    if (/^## /.test(l)) {
      const t = l.slice(3).trim(), id = slug(t, used);
      toc.push({ t, id });
      out.push('<h2 id="' + id + '">' + inline(t) + "</h2>");
      i++; continue;
    }
    if (/^### /.test(l)) { out.push("<h3>" + inline(l.slice(4).trim()) + "</h3>"); i++; continue; }
    if (/^---\s*$/.test(l)) { i++; continue; }
    if (/^\|/.test(l) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = cells(l);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push('<div class="table-wrap"><table><thead><tr>' + head.map((h) => "<th>" + inline(h) + "</th>").join("") +
        "</tr></thead><tbody>" + rows.map((r) => "<tr>" + r.map((c) => "<td>" + inline(c) + "</td>").join("") + "</tr>").join("") +
        "</tbody></table></div>");
      continue;
    }
    if (/^\s*[-*] /.test(l) || /^\s*\d+\. /.test(l)) {
      const ordered = /^\s*\d+\. /.test(l);
      const items = [];
      while (i < lines.length && (ordered ? /^\s*\d+\. /.test(lines[i]) : /^\s*[-*] /.test(lines[i]))) {
        let item = lines[i].replace(/^\s*(?:[-*]|\d+\.) /, "");
        i++;
        // 列表项里缩进的代码块
        let extra = "";
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*(?:[-*]|\d+\.) /.test(lines[i])) {
          if (/^\s*```/.test(lines[i])) {
            const buf = [];
            i++;
            while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++].replace(/^\s{3}/, ""));
            i++;
            extra += '<pre class="code-block"><code>' + esc(buf.join("\n")) + "</code></pre>";
          } else item += " " + lines[i++].trim();
        }
        items.push("<li>" + inline(item) + extra + "</li>");
      }
      out.push((ordered ? "<ol>" : "<ul>") + items.join("") + (ordered ? "</ol>" : "</ul>"));
      continue;
    }
    if (/^> /.test(l)) { out.push('<div class="box"><p>' + inline(l.slice(2)) + "</p></div>"); i++; continue; }
    if (!l.trim()) { i++; continue; }

    const para = [l.trim()];
    i++;
    while (i < lines.length && lines[i].trim() && !/^(#|\||```|>|---|\s*[-*] |\s*\d+\. )/.test(lines[i])) para.push(lines[i++].trim());
    const html = "<p>" + inline(para.join("")) + "</p>";
    if (!toc.length) lead.push(html); else out.push(html);
  }
  return { title, lead: lead.join("\n"), body: out.join("\n"), toc };
}

const md = fs.readFileSync(SRC, "utf8");
const d = convert(md);

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>服务合约开发指南 — Agentry</title>
<meta name="description" content="Agentry 服务合约开发指南：IAgentryService 接口规范、参考实现、安全要求、测试方法与上架流程。">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500;600&family=Geist:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="pages.css">
</head>
<body>
<!-- 本页由 scripts/build-dev-docs.js 从 docs/service-contract.md 生成，不要直接改 -->
<a class="skip" href="#main">跳到正文</a>

<header class="top">
  <a class="brand" href="index.html">
    <svg width="24" height="24" viewBox="0 0 64 64" aria-hidden="true"><path d="M14 54V28a18 18 0 0 1 36 0v26" fill="none" stroke="#F0B90B" stroke-width="7" stroke-linecap="round"/><circle cx="32" cy="39" r="7" fill="#F0B90B"/></svg>Agentry
  </a>
  <a class="back" href="index.html"><svg viewBox="0 0 256 256" aria-hidden="true"><path d="M224,128a8,8,0,0,1-8,8H59.31l58.35,58.34a8,8,0,0,1-11.32,11.32l-72-72a8,8,0,0,1,0-11.32l72-72a8,8,0,0,1,11.32,11.32L59.31,120H216A8,8,0,0,1,224,128Z"/></svg>返回首页</a>
</header>

<div class="doc-layout">
  <aside class="doc-side">
    <nav class="toc" aria-label="目录"><p>目录</p><ol>${d.toc.map((t) => '<li><a href="#' + t.id + '">' + inline(t.t.replace(/^\d+\.\s*/, "")) + "</a></li>").join("")}</ol></nav>
  </aside>
  <main id="main" class="doc">
    <p class="kicker"><b>Developers</b>开发者文档</p>
    <h1>${esc(d.title)}</h1>
    ${d.lead}
${d.body}
  </main>
</div>
<script>
/* 目录里高亮正在读的章节 */
(function () {
  // 取「已经滚过页面上方 120px 的最后一个章节标题」，大幅跳转时也准
  var links = {}, cur = null, heads = [].slice.call(document.querySelectorAll(".doc h2[id]")), queued = false;
  document.querySelectorAll(".toc a").forEach(function (a) { links[a.getAttribute("href").slice(1)] = a; });
  function update() {
    queued = false;
    var on = heads[0];
    for (var i = 0; i < heads.length; i++) if (heads[i].getBoundingClientRect().top <= 120) on = heads[i];
    var a = on && links[on.id];
    if (a === cur) return;
    if (cur) cur.removeAttribute("aria-current");
    cur = a;
    if (cur) cur.setAttribute("aria-current", "true");
  }
  window.addEventListener("scroll", function () { if (!queued) { queued = true; requestAnimationFrame(update); } }, { passive: true });
  update();
})();
</script>

<footer class="foot">
  <span>Agentry · Agent 服务市场 · 部署在 BNB 智能链</span>
  <nav aria-label="页脚">
    <a href="index.html">首页</a>
    <a href="market/">Agent 市场</a>
    <a href="tasks/">任务大厅</a>
    <a href="developers.html" aria-current="page">开发者文档</a>
    <a href="privacy.html">隐私政策</a>
    <a href="terms.html">服务条款</a>
  </nav>
</footer>
</body>
</html>
`;

fs.writeFileSync(OUT, html);
console.log("✓ docs/service-contract.md → design/developers.html（" + d.toc.length + " 节）");
