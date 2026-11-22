/* ==========================================================================
   把 Agentry Skill 放上网站

   Skill 就是几份 Markdown，不一定要放代码仓库。放在网站上，
   用户对自己的 Agent 说一句「读一下 https://你的域名/skills/agentry/SKILL.md」就能用。

   这个脚本做三件事：
     1. skills/agentry/**      → design/skills/agentry/**   （网站上逐个文件可读）
     2. 生成 design/skills/agentry/index.json                （文件清单，Agent 一次拿全）
     3. 打包 design/skills/agentry.zip                       （给想手动装的人下载）

   **只改 skills/agentry 里的源文件，改完跑 `npm run publish:skill`。**
   不要直接改 design/skills 下的副本，下次同步会被覆盖。
   ========================================================================== */

"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "skills", "agentry");
const SITE = path.join(ROOT, "design", "skills");
const DEST = path.join(SITE, "agentry");

function walk(dir, base) {
  let out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = base ? base + "/" + name : name;
    if (fs.statSync(full).isDirectory()) out = out.concat(walk(full, rel));
    else out.push(rel);
  }
  return out;
}

// 1. 清掉旧副本再拷，源里删掉的文件网站上也跟着消失
fs.rmSync(DEST, { recursive: true, force: true });
const files = walk(SRC, "").sort();
for (const rel of files) {
  const to = path.join(DEST, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(path.join(SRC, rel), to);
}

// 2. 文件清单。从 SKILL.md 的 frontmatter 里读出名字和版本
const head = fs.readFileSync(path.join(SRC, "SKILL.md"), "utf8");
const pick = (key) => {
  const m = head.match(new RegExp("^\\s*" + key + ":\\s*'?([^'\\n]+)'?", "m"));
  return m ? m[1].trim() : null;
};
const index = {
  name: pick("name") || "agentry",
  version: pick("version"),
  entry: "SKILL.md",
  files: files,
  note: "先读 SKILL.md。references/ 下的文件按 SKILL.md 里的路由按需读取，相对路径以 SKILL.md 所在目录为准。",
};
fs.writeFileSync(path.join(DEST, "index.json"), JSON.stringify(index, null, 2) + "\n");

// 3. 打包。Windows 10 以上和 macOS 自带的 tar 都能写 zip；没有就跳过，不影响逐个文件访问
const zip = path.join(SITE, "agentry.zip");
fs.rmSync(zip, { force: true });
// 要 bsdtar 才能写 zip。Windows 上 PATH 里排在前面的可能是 Git 带的 GNU tar，
// 它不认 -a，所以先试系统自带的那个
const tars = process.platform === "win32"
  ? [path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe"), "tar"]
  : ["tar"];
let zipped = false;
for (const bin of tars) {
  try {
    execFileSync(bin, ["-a", "-c", "-f", zip, "-C", SITE, "agentry"], { stdio: "ignore" });
    zipped = fs.existsSync(zip) && fs.statSync(zip).size > 0;
    if (zipped) break;
  } catch (e) { /* 换下一个 */ }
}
console.log(zipped
  ? "  ✓ 打包 design/skills/agentry.zip"
  : "  - 没有能写 zip 的 tar，跳过压缩包（逐个文件仍然可以访问）");

console.log("  ✓ 同步了 " + files.length + " 个文件到 design/skills/agentry/");
console.log("    " + files.join("\n    "));
