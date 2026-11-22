/* ==========================================================================
   把 lib/ 下的共享模块同步到静态站

   lib/spec、lib/agentry/abi、lib/agentry/agentid 都是 UMD，浏览器能直接用。
   但静态站只服务 design/ 目录，取不到 lib/。所以需要这一步。
   部署记录 deployments/56.json 也一起转成 design/lib/deployment.js，
   页面直接读合约地址，不用再手抄。

   **不要在两处各维护一份，会漂。**改只改 lib/，然后跑这个脚本。
   ========================================================================== */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

const FILES = [
  ["lib/spec/index.js", "design/lib/spec.js"],
  ["lib/spec/capabilities.json", "design/lib/capabilities.json"],
  ["lib/agentry/abi.js", "design/lib/abi.js"],
  ["lib/agentry/agentid.js", "design/lib/agentid.js"],
  ["lib/agentry/inline.js", "design/lib/inline.js"],
];

const HEADER =
  "/* 自动生成，请勿直接修改。\n" +
  "   源文件见上方路径，改完跑 `npm run sync:web` 重新生成。 */\n";

let changed = 0;

for (const [from, to] of FILES) {
  const src = fs.readFileSync(path.join(ROOT, from), "utf8");
  const body = to.endsWith(".json")
    ? src
    : HEADER.replace("源文件见上方路径", "源文件 " + from) + src;

  const dest = path.join(ROOT, to);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const existing = fs.existsSync(dest) ? fs.readFileSync(dest, "utf8") : null;
  if (existing !== body) {
    fs.writeFileSync(dest, body);
    changed++;
    console.log("  ✓ " + from + " → " + to);
  } else {
    console.log("  = " + to + "（无变化）");
  }
}

// 能力分类表 → 能力标识到中文名的映射，页面上显示中文名用
{
  const caps = JSON.parse(fs.readFileSync(path.join(ROOT, "lib/spec/capabilities.json"), "utf8")).capabilities || [];
  const map = {};
  caps.forEach((c) => { map[c.id] = c.title; });
  const body = HEADER.replace("源文件见上方路径", "源文件 lib/spec/capabilities.json") +
    "window.AgentryCapabilities = " + JSON.stringify(map, null, 2) + ";\n";
  const dest = path.join(ROOT, "design", "lib", "capabilities.js");
  const existing = fs.existsSync(dest) ? fs.readFileSync(dest, "utf8") : null;
  if (existing !== body) { fs.writeFileSync(dest, body); changed++; console.log("  ✓ lib/spec/capabilities.json → design/lib/capabilities.js"); }
  else console.log("  = design/lib/capabilities.js（无变化）");
}

// 部署记录 → 浏览器可直接 <script> 引入的全局变量。只放页面需要的字段
const depFile = path.join(ROOT, "deployments", "56.json");
if (fs.existsSync(depFile)) {
  const d = JSON.parse(fs.readFileSync(depFile, "utf8"));
  const pub = {
    chainId: d.chainId,
    deployedAt: d.deployedAt,
    market: d.contracts.AgentMarket.address,
    jury: d.contracts.AgentJury.address,
    vault: d.contracts.AgentryServiceVault ? d.contracts.AgentryServiceVault.address : null,
    agentId: d.dependencies.agentId,
    paymentToken: d.dependencies.paymentToken,
  };
  const body = HEADER.replace("源文件见上方路径", "源文件 deployments/56.json") +
    "window.AgentryDeployment = " + JSON.stringify(pub, null, 2) + ";\n";
  const dest = path.join(ROOT, "design", "lib", "deployment.js");
  const existing = fs.existsSync(dest) ? fs.readFileSync(dest, "utf8") : null;
  if (existing !== body) { fs.writeFileSync(dest, body); changed++; console.log("  ✓ deployments/56.json → design/lib/deployment.js"); }
  else console.log("  = design/lib/deployment.js（无变化）");
}

console.log(changed ? "\n同步了 " + changed + " 个文件。" : "\n已是最新。");
