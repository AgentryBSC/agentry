#!/usr/bin/env node
/* ==========================================================================
   用私钥文件直接执行部署计划（deployments/56.plan.json），不经过 baw

   计划由 node scripts/deploy-baw.js plan --from <私钥对应的地址> 生成，
   和 baw 路线是同一份计划、同一批 CREATE2 地址。已经在链上的步骤自动跳过，中断后可以重跑。

   私钥的处理：
     · 只从 --key-file 指定的文件里读，脚本内部解析，不打印、不写入任何文件、不放进环境变量
     · 文件里必须恰好有一个 64 位十六进制私钥，且对应地址必须等于计划里的 owner
     · 主网执行前需要 --yes，否则只打印要发的交易

   用法
     node scripts/deploy-direct.js --key-file <私钥文件>           只看要发哪些交易
     node scripts/deploy-direct.js --key-file <私钥文件> --yes     逐笔发送
   全部完成后运行：node scripts/deploy-baw.js finish
   ========================================================================== */

"use strict";

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const CHAIN_ID = 56;
const RPC = process.env.BSC_RPC || "https://bsc-dataseed.bnbchain.org";
const PLAN = path.join(__dirname, "..", "deployments", CHAIN_ID + ".plan.json");

function die(msg) {
  console.error("\n✗ " + msg + "\n");
  process.exit(1);
}

function arg(name) {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}

/// 从文件里取出唯一的私钥，返回钱包。私钥本身不离开这个函数
function loadWallet(file, provider) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch (e) { die("读不到私钥文件：" + file); }
  const found = [...new Set((raw.match(/(?:0x)?[0-9a-fA-F]{64}\b/g) || []).map((k) => k.replace(/^0x/, "").toLowerCase()))];
  if (found.length !== 1) die("私钥文件里应恰好有一个 64 位十六进制私钥，实际找到 " + found.length + " 个");
  return new ethers.Wallet("0x" + found[0], provider);
}

async function isDone(provider, plan, s) {
  if (s.expect) return (await provider.getCode(s.expect)) !== "0x";
  if ((await provider.getCode(s.to)) === "0x") return false;
  if (s.wire === "router") {
    const m = new ethers.Contract(s.to, ["function serviceRouter() view returns (address)"], provider);
    return (await m.serviceRouter()).toLowerCase() === plan.contracts.AgentryServiceRouter.address.toLowerCase();
  }
  const m = new ethers.Contract(s.to, ["function jury() view returns (address)"], provider);
  return (await m.jury()).toLowerCase() === plan.contracts.AgentJury.address.toLowerCase();
}

async function main() {
  const keyFile = arg("key-file");
  if (!keyFile || keyFile === true) die("需要 --key-file <私钥文件>");
  if (!fs.existsSync(PLAN)) die("还没有部署计划，先运行 node scripts/deploy-baw.js plan --from <地址>");
  const plan = JSON.parse(fs.readFileSync(PLAN, "utf8"));

  const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);
  const wallet = loadWallet(keyFile, provider);
  if (wallet.address.toLowerCase() !== plan.owner.toLowerCase()) {
    die("私钥对应 " + wallet.address + "，但计划的 owner 是 " + plan.owner + "。用这个地址重新生成计划");
  }

  const bal = await provider.getBalance(wallet.address);
  const fee = await provider.getFeeData();
  console.log("\n钱包    " + wallet.address);
  console.log("余额    " + ethers.formatEther(bal) + " BNB");
  console.log("gas 价  " + ethers.formatUnits(fee.gasPrice, "gwei") + " gwei\n");

  const todo = [];
  for (const s of plan.steps) {
    const done = await isDone(provider, plan, s);
    console.log("  " + s.n + ". " + s.label + (done ? "  ✓ 已完成" : ""));
    if (!done) todo.push(s);
  }
  if (todo.length === 0) { console.log("\n全部步骤已完成。运行 node scripts/deploy-baw.js finish 核对\n"); return; }

  if (arg("yes") !== true) {
    console.log("\n将发送 " + todo.length + " 笔交易。确认后加 --yes 执行\n");
    return;
  }

  for (const s of todo) {
    // 每一步依赖前一步，按顺序发，等确认后再发下一笔
    const tx = { to: s.to, data: s.data, value: BigInt(s.value) };
    const est = await wallet.estimateGas(tx);
    const sent = await wallet.sendTransaction({ ...tx, gasLimit: (est * 125n) / 100n });
    console.log("\n  " + s.n + ". " + s.label + "\n     交易 " + sent.hash);
    const rc = await sent.wait();
    if (rc.status !== 1) die("第 " + s.n + " 步失败：" + sent.hash);
    if (s.expect && (await provider.getCode(s.expect)) === "0x") die("第 " + s.n + " 步没有在预期地址创建合约：" + s.expect);
    console.log("     ✓ 区块 " + rc.blockNumber + "，gas " + rc.gasUsed);
  }
  console.log("\n全部发送完成。运行 node scripts/deploy-baw.js finish 核对并写部署记录\n");
}

main().catch((e) => die(e.shortMessage || e.message || String(e)));
