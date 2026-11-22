// 在当前进程里跑 baw，参数从 JSON 文件读。
//
// 为什么要这样绕：部署 AgentMarket 的 calldata 有 4 万多个十六进制字符，
// 超过 Windows 单条命令行 32767 字符的上限，直接 `baw ... --inputData 0x…` 会被系统截断。
// baw 本身是 Node 写的，入口只做 `program.parse()`，读的就是 process.argv，
// 所以把参数塞进 process.argv 再 import 入口，效果和在终端里敲命令完全一样。
//
// 这里只用来跑 `contract-call preview`。execute 由用户自己在终端里敲。
//
// 用法：node scripts/baw-run.mjs <参数文件.json>

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { pathToFileURL } from "url";

const file = process.argv[2];
if (!file) {
  console.error("用法：node scripts/baw-run.mjs <参数文件.json>");
  process.exit(2);
}
const args = JSON.parse(fs.readFileSync(file, "utf8"));
if (!Array.isArray(args) || !args.includes("contract-call") || !args.includes("preview")) {
  console.error("只允许跑 contract-call preview");
  process.exit(2);
}
if (args.includes("execute")) {
  console.error("不代替用户执行。请自己在终端里运行 baw contract-call execute。");
  process.exit(2);
}

const root = execSync("npm root -g", { encoding: "utf8" }).trim();
const entry = path.join(root, "@binance", "agentic-wallet", "dist", "index.js");
if (!fs.existsSync(entry)) {
  console.error("找不到 baw：" + entry);
  process.exit(2);
}

process.argv = [process.argv[0], entry, ...args];
await import(pathToFileURL(entry).href);
