/* ==========================================================================
   打包要上线的网站文件到 dist-site/，并给 CSS、JS 地址加上内容指纹

   为什么要加指纹：Cloudflare 把 CSS/JS 的浏览器缓存改成了 4 小时，
   页面 HTML 只缓存 5 分钟。改版后浏览器会拿新 HTML 配旧样式，排版就乱了。
   地址带上 ?v=<内容哈希>，文件一改地址就变，浏览器必须重新取。

   用法：node scripts/build-site.js   → 生成 dist-site/，再整体传到服务器
   ========================================================================== */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SRC = path.join(__dirname, "..", "design");
const OUT = path.join(__dirname, "..", "dist-site");

// 上线的文件和目录。备份（_old.html、_pre-* 等）和不再使用的 card3d.js 不带
const INCLUDE = [
  "index.html", "404.html", "privacy.html", "terms.html", "developers.html",
  "app.css", "app.js", "chain.js", "pages.css", "field.js", "story.js", "motion.js",
  "agent-id-card.png", "share.png", "logo.svg", "favicon.svg", "apple-touch-icon.png",
  "market", "tasks", "guide", "lib", "skills",
];

fs.rmSync(OUT, { recursive: true, force: true });
for (const name of INCLUDE) {
  fs.cpSync(path.join(SRC, name), path.join(OUT, name), { recursive: true });
}

// 所有 HTML 里引用的本地 .css / .js 加指纹
const hashOf = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 10);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".html")) out.push(p);
  }
  return out;
}

let stamped = 0;
for (const html of walk(OUT)) {
  const dir = path.dirname(html);
  let s = fs.readFileSync(html, "utf8");
  s = s.replace(/(\s(?:href|src)=")([^"?#:]+\.(?:css|js))(")/g, (m, a, ref, b) => {
    const file = ref.startsWith("/") ? path.join(OUT, ref) : path.join(dir, ref);
    if (!fs.existsSync(file)) return m;
    stamped++;
    return a + ref + "?v=" + hashOf(file) + b;
  });
  fs.writeFileSync(html, s);
}
console.log("已打包到 dist-site/，加指纹的引用 " + stamped + " 处");
