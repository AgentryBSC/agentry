#!/usr/bin/env node
/* ==========================================================================
   用 Agentic Wallet 重新部署服务金库（AgentryServiceVault），不需要私钥

   金库不可升级，介绍文字写死在合约里，改文字只能部署新金库。
   和市场合约一样经 CREATE2 工厂部署：
     0x4e59b44847b379578588920cA78FbF26c0B4956C
   管理员通过构造参数显式给出，不依赖 msg.sender，所以权限不会落到工厂上。

   ⚠️ 本脚本只产出 preview，不执行。由你自己运行
      baw contract-call execute --requestId <id> 确认上链。

   用法
     node scripts/deploy-vault-baw.js preview [--from <钱包>]   算地址并生成 baw 预览
     node scripts/deploy-vault-baw.js finish                    上链后核对，写进 deployments/56.json
   ========================================================================== */

"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { ethers } = require("ethers");

const CHAIN_ID = 56;
const RPC = process.env.BSC_RPC || "https://bsc-dataseed.bnbchain.org";
const FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
const GUARDIAN = "0x9e27098dcD8844bcc6287a557E0b4D09C86B8a4b";
const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "deployments", CHAIN_ID + ".json");
const TMP = path.join(ROOT, "deployments", ".baw");
const PLAN = path.join(TMP, "vault.plan.json");
const SALT = ethers.id("agentry.mainnet.vault");

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

function build(admin) {
  const f = path.join(ROOT, "artifacts", "contracts", "vault", "AgentryServiceVault.sol", "AgentryServiceVault.json");
  if (!fs.existsSync(f)) die("找不到编译产物，先运行 npx hardhat compile");
  const art = JSON.parse(fs.readFileSync(f, "utf8"));
  const initCode = ethers.concat([art.bytecode, new ethers.Interface(art.abi).encodeDeploy([admin])]);
  return {
    address: ethers.getCreate2Address(FACTORY, SALT, ethers.keccak256(initCode)),
    data: ethers.concat([SALT, initCode]),
    abi: art.abi,
  };
}

async function cmdPreview(args) {
  const rec = JSON.parse(fs.readFileSync(OUT, "utf8"));
  const admin = ethers.getAddress(args.from || rec.deployer);
  const old = rec.contracts.AgentryServiceVault;

  // 旧金库必须是空的、没绑代币，换掉才没有损失
  if (old) {
    const ov = new ethers.Contract(old.address, [
      "function taxToken() view returns (address)",
      "function totalReceived() view returns (uint256)"], provider);
    const [tt, recv, bal] = await Promise.all([ov.taxToken(), ov.totalReceived(), provider.getBalance(old.address)]);
    if (tt !== ethers.ZeroAddress || recv > 0n || bal > 0n) {
      die("旧金库 " + old.address + " 已绑定代币或有资金，不能直接替换");
    }
  }

  const v = build(admin);
  if ((await provider.getCode(v.address)) !== "0x") {
    console.log("新金库已经在链上了：" + v.address + "，运行 finish 核对");
    return;
  }

  // 本地先模拟一遍：构造不 revert，且介绍文字是新的
  const est = await provider.estimateGas({ from: admin, to: FACTORY, data: v.data });
  const cap = (est * 125n) / 100n;

  fs.mkdirSync(TMP, { recursive: true });
  fs.writeFileSync(PLAN, JSON.stringify({ admin, address: v.address, old: old && old.address }, null, 2));
  const bawArgs = [
    "contract-call", "preview",
    "--binanceChainId", String(CHAIN_ID),
    "--from", admin,
    "--to", FACTORY,
    "--value", "0",
    "--inputData", v.data,
    "--gasLimit", String(cap), "--json",
  ];
  const argFile = path.join(TMP, "vault.json");
  fs.writeFileSync(argFile, JSON.stringify(bawArgs));

  console.log("\n重新部署服务金库");
  console.log("  to      " + FACTORY + "（CREATE2 工厂）");
  console.log("  将创建  " + v.address);
  console.log("  管理员  " + admin);
  console.log("  旧金库  " + (old ? old.address + "（停用，不再使用）" : "无"));
  console.log("  预估gas " + est + "\n");

  const raw = execFileSync(process.execPath, [path.join(__dirname, "baw-run.mjs"), argFile], { encoding: "utf8" });
  fs.writeFileSync(path.join(TMP, "vault.preview.json"), raw);
  console.log(raw);
}

async function cmdFinish() {
  if (!fs.existsSync(PLAN)) die("先运行 preview");
  const plan = JSON.parse(fs.readFileSync(PLAN, "utf8"));
  if ((await provider.getCode(plan.address)) === "0x") die("新金库还不在链上：" + plan.address);
  const v = new ethers.Contract(plan.address, build(plan.admin).abi, provider);
  const OP = await v.OPERATOR_ROLE();
  const schema = await v.vaultUISchema();
  const checks = [
    ["管理员是你的钱包", await v.hasRole(await v.DEFAULT_ADMIN_ROLE(), plan.admin)],
    ["你的钱包有提款权限", await v.hasRole(OP, plan.admin)],
    ["FLAP Guardian 有提款权限（规范要求）", await v.hasRole(OP, GUARDIAN)],
    ["工厂没有任何权限", !(await v.hasRole(await v.DEFAULT_ADMIN_ROLE(), FACTORY)) && !(await v.hasRole(OP, FACTORY))],
    ["收入币种是 BNB", (await v.vaultQuoteToken()) === ethers.ZeroAddress],
    ["介绍文字是新的", schema.description.startsWith("Funds the Agentry platform")],
  ];
  let ok = true;
  for (const [k, r] of checks) { console.log("  " + (r ? "✓" : "✗") + " " + k); ok = ok && r; }
  if (!ok) die("核对没通过，不改部署记录");

  const rec = JSON.parse(fs.readFileSync(OUT, "utf8"));
  const prev = rec.contracts.AgentryServiceVault;
  if (prev && prev.address.toLowerCase() !== plan.address.toLowerCase()) {
    rec.retiredVaults = [...(rec.retiredVaults || []), { address: prev.address, retiredAt: new Date().toISOString() }];
  }
  rec.contracts.AgentryServiceVault = { address: plan.address, constructorArgs: [plan.admin], salt: SALT };
  fs.writeFileSync(OUT, JSON.stringify(rec, null, 2) + "\n");
  console.log("\n  介绍  " + schema.description);
  console.log("\n部署记录已更新 deployments/56.json，再跑 node scripts/sync-web.js 同步网站\n");
}

/// 用私钥文件直接部署，管理员就是签名钱包本身（私钥只在内部解析，不打印、不落盘）
async function cmdDirect(args) {
  if (!args["key-file"]) die("需要 --key-file <私钥文件>");
  let raw;
  try { raw = fs.readFileSync(args["key-file"], "utf8"); } catch (e) { die("读不到私钥文件"); }
  const keys = [...new Set((raw.match(/(?:0x)?[0-9a-fA-F]{64}\b/g) || []).map((k) => k.replace(/^0x/, "").toLowerCase()))];
  if (keys.length !== 1) die("私钥文件里应恰好有一个私钥");
  const wallet = new ethers.Wallet("0x" + keys[0], provider);
  const admin = wallet.address;
  const v = build(admin);
  fs.mkdirSync(TMP, { recursive: true });
  fs.writeFileSync(PLAN, JSON.stringify({ admin, address: v.address }, null, 2));
  console.log("\n部署服务金库（私钥直接签名）");
  console.log("  管理员  " + admin);
  console.log("  将创建  " + v.address);
  if ((await provider.getCode(v.address)) !== "0x") { console.log("\n已经在链上，运行 finish 核对\n"); return; }
  const est = await wallet.estimateGas({ to: FACTORY, data: v.data });
  if (!("yes" in args)) { console.log("  预估gas " + est + "\n\n加 --yes 发送\n"); return; }
  const tx = await wallet.sendTransaction({ to: FACTORY, data: v.data, gasLimit: (est * 125n) / 100n });
  console.log("  交易    " + tx.hash);
  const rc = await tx.wait();
  if (rc.status !== 1 || (await provider.getCode(v.address)) === "0x") die("部署失败：" + tx.hash);
  console.log("  ✓ 区块 " + rc.blockNumber + "，gas " + rc.gasUsed + "\n");
}

const COMMANDS = { preview: cmdPreview, direct: cmdDirect, finish: cmdFinish };
const args = parseArgs(process.argv.slice(2));
const fn = COMMANDS[args._[0]];
if (!fn) { console.log("用法：node scripts/deploy-vault-baw.js preview [--from <地址>] | direct --key-file <私钥文件> [--yes] | finish"); process.exit(1); }
fn(args).catch((e) => die(e.shortMessage || e.message || String(e)));
