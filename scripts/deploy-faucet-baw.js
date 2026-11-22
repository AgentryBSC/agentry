#!/usr/bin/env node
/* ==========================================================================
   用 Agentic Wallet 部署代币水龙头（AgentryFaucet），不需要私钥

   经 CREATE2 工厂 0x4e59b44847b379578588920cA78FbF26c0B4956C 部署。
   owner 通过构造参数显式给出，不依赖 msg.sender，所以权限不会落到工厂上。
   部署时不需要代币地址，之后用 setToken / setClaimAmount / setClaimRule 配置。

   ⚠️ 本脚本只产出 preview，不执行。由你自己运行
      baw contract-call execute --requestId <id> 确认上链。

   用法
     node scripts/deploy-faucet-baw.js preview [--from <钱包>]   算地址并生成 baw 预览
     node scripts/deploy-faucet-baw.js finish                    上链后核对，写进 deployments/56.json
   ========================================================================== */

"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { ethers } = require("ethers");
const { DEPS } = require("./params");

const CHAIN_ID = 56;
const RPC = process.env.BSC_RPC || "https://bsc-dataseed.bnbchain.org";
const FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "deployments", CHAIN_ID + ".json");
const TMP = path.join(ROOT, "deployments", ".baw");
const PLAN = path.join(TMP, "faucet.plan.json");
const SALT = ethers.id("agentry.mainnet.faucet");

/// v2 的水龙头是「合约交付」服务，构造参数要带服务路由。路由地址取 v4 部署记录（或计划）
function routerAddr() {
  for (const f of [OUT, path.join(ROOT, "deployments", CHAIN_ID + ".plan.json")]) {
    if (!fs.existsSync(f)) continue;
    const c = JSON.parse(fs.readFileSync(f, "utf8")).contracts;
    if (c && c.AgentryServiceRouter) return c.AgentryServiceRouter.address;
  }
  die("找不到服务路由地址，先完成 v4 部署");
}

const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);

function die(msg) {
  console.error("\n✗ " + msg + "\n");
  process.exit(1);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) { out[a.slice(2)] = argv[i + 1]; i++; } else out._.push(a);
  }
  return out;
}

function build(owner, router) {
  const f = path.join(ROOT, "artifacts", "contracts", "faucet", "AgentryFaucet.sol", "AgentryFaucet.json");
  if (!fs.existsSync(f)) die("找不到编译产物，先运行 npx hardhat compile");
  const art = JSON.parse(fs.readFileSync(f, "utf8"));
  const initCode = ethers.concat([art.bytecode, new ethers.Interface(art.abi).encodeDeploy([owner, DEPS.agentId, router])]);
  return {
    address: ethers.getCreate2Address(FACTORY, SALT, ethers.keccak256(initCode)),
    data: ethers.concat([SALT, initCode]),
    abi: art.abi,
  };
}

async function cmdPreview(args) {
  const rec = JSON.parse(fs.readFileSync(OUT, "utf8"));
  const owner = ethers.getAddress(args.from || rec.deployer);
  if ((await provider.getCode(DEPS.agentId)) === "0x") die("Agent ID 合约不在链上：" + DEPS.agentId);

  const router = routerAddr();
  if ((await provider.getCode(router)) === "0x") die("服务路由还不在链上：" + router + "，先完成 v4 部署第 7 步");
  const f = build(owner, router);
  if ((await provider.getCode(f.address)) !== "0x") {
    console.log("水龙头已经在链上了：" + f.address + "，运行 finish 核对");
    return;
  }
  const est = await provider.estimateGas({ from: owner, to: FACTORY, data: f.data });
  const cap = (est * 125n) / 100n;

  fs.mkdirSync(TMP, { recursive: true });
  fs.writeFileSync(PLAN, JSON.stringify({ owner, address: f.address, agentId: DEPS.agentId, router }, null, 2));
  const bawArgs = [
    "contract-call", "preview",
    "--binanceChainId", String(CHAIN_ID),
    "--from", owner,
    "--to", FACTORY,
    "--value", "0",
    "--inputData", f.data,
    "--gasLimit", String(cap), "--json",
  ];
  const argFile = path.join(TMP, "faucet.json");
  fs.writeFileSync(argFile, JSON.stringify(bawArgs));

  console.log("\n部署代币水龙头");
  console.log("  to        " + FACTORY + "（CREATE2 工厂）");
  console.log("  将创建    " + f.address);
  console.log("  owner     " + owner);
  console.log("  Agent ID  " + DEPS.agentId);
  console.log("  服务路由  " + router);
  console.log("  预估gas   " + est + "\n");

  const raw = execFileSync(process.execPath, [path.join(__dirname, "baw-run.mjs"), argFile], { encoding: "utf8" });
  fs.writeFileSync(path.join(TMP, "faucet.preview.json"), raw);
  console.log(raw);
}

async function cmdFinish() {
  if (!fs.existsSync(PLAN)) die("先运行 preview");
  const plan = JSON.parse(fs.readFileSync(PLAN, "utf8"));
  if ((await provider.getCode(plan.address)) === "0x") die("水龙头还不在链上：" + plan.address);
  const c = new ethers.Contract(plan.address, build(plan.owner, plan.router).abi, provider);
  const eq = (a, b) => a.toLowerCase() === b.toLowerCase();
  const checks = [
    ["owner 是你的钱包", eq(await c.owner(), plan.owner)],
    ["没有待接收的新 owner", (await c.pendingOwner()) === ethers.ZeroAddress],
    ["Agent ID 是官方合约", eq(await c.agentId(), plan.agentId)],
    ["默认每个 Agent ID 只领一次", (await c.maxClaims()) === 1n && (await c.cooldown()) === 0n],
    ["代币还没设置", (await c.token()) === ethers.ZeroAddress],
    ["服务路由是 v4 路由", eq(await c.router(), plan.router)],
    ["声明的服务方是你的钱包", eq(await c.agentryProvider(), plan.owner)],
  ];
  let ok = true;
  for (const [k, r] of checks) { console.log("  " + (r ? "✓" : "✗") + " " + k); ok = ok && r; }
  if (!ok) die("核对没通过，不改部署记录");

  const rec = JSON.parse(fs.readFileSync(OUT, "utf8"));
  rec.contracts.AgentryFaucet = { address: plan.address, constructorArgs: [plan.owner, plan.agentId, plan.router], salt: SALT };
  fs.writeFileSync(OUT, JSON.stringify(rec, null, 2) + "\n");
  console.log("\n部署记录已更新 deployments/56.json\n");
}

/// 用私钥文件直接部署（见 scripts/deploy-direct.js 的私钥处理约定：只在内部解析，不打印）
/// --owner 是水龙头的 owner，也是它声明的服务方：必须是持有 Agent ID、要去挂牌的那个地址
async function cmdDirect(args) {
  if (!args.owner || !ethers.isAddress(args.owner)) die("需要 --owner <水龙头 owner，即挂牌的服务方地址>");
  if (!args["key-file"]) die("需要 --key-file <私钥文件>");
  const owner = ethers.getAddress(args.owner);
  let raw;
  try { raw = fs.readFileSync(args["key-file"], "utf8"); } catch (e) { die("读不到私钥文件"); }
  const keys = [...new Set((raw.match(/(?:0x)?[0-9a-fA-F]{64}\b/g) || []).map((k) => k.replace(/^0x/, "").toLowerCase()))];
  if (keys.length !== 1) die("私钥文件里应恰好有一个私钥");
  const wallet = new ethers.Wallet("0x" + keys[0], provider);

  const router = routerAddr();
  if ((await provider.getCode(router)) === "0x") die("服务路由还不在链上：" + router);
  const fz = build(owner, router);
  fs.mkdirSync(TMP, { recursive: true });
  fs.writeFileSync(PLAN, JSON.stringify({ owner, address: fz.address, agentId: DEPS.agentId, router }, null, 2));
  console.log("\n部署代币水龙头（私钥直接签名）");
  console.log("  签名钱包  " + wallet.address);
  console.log("  将创建    " + fz.address);
  console.log("  owner     " + owner);
  console.log("  服务路由  " + router);
  if ((await provider.getCode(fz.address)) !== "0x") { console.log("\n已经在链上，运行 finish 核对\n"); return; }
  const est = await wallet.estimateGas({ to: FACTORY, data: fz.data });
  const tx = await wallet.sendTransaction({ to: FACTORY, data: fz.data, gasLimit: (est * 125n) / 100n });
  console.log("  交易      " + tx.hash);
  const rc = await tx.wait();
  if (rc.status !== 1 || (await provider.getCode(fz.address)) === "0x") die("部署失败：" + tx.hash);
  console.log("  ✓ 区块 " + rc.blockNumber + "，gas " + rc.gasUsed + "\n");
}

const COMMANDS = { preview: cmdPreview, direct: cmdDirect, finish: cmdFinish };
const args = parseArgs(process.argv.slice(2));
const fn = COMMANDS[args._[0]];
if (!fn) { console.log("用法：node scripts/deploy-faucet-baw.js preview [--from <地址>] | finish"); process.exit(1); }
fn(args).catch((e) => die(e.shortMessage || e.message || String(e)));
