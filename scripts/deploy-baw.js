#!/usr/bin/env node
/* ==========================================================================
   用 Agentic Wallet 部署到 BSC 主网（不需要私钥）

   baw 的 contract-call 只能调用已有合约（--to 必填），不能直接发创建合约的交易。
   所以通过 BSC 上公共的 CREATE2 工厂部署：
     0x4e59b44847b379578588920cA78FbF26c0B4956C（Arachnid 确定性部署代理，无 owner、无状态）
   调用它时 calldata = 32 字节 salt + 合约 initcode，它在算好的地址上把合约创建出来。
   合约地址只由 工厂 + salt + initcode 决定，部署前就能算出来。

   v3 起市场与陪审是可升级的（UUPS 代理）：
     · TimelockController（48 小时延迟，提议人和执行人都是你的钱包）持有升级权
     · 实现合约只写死 Agent ID 与结算代币地址
     · 代理部署时在构造里调用 initialize，owner 显式写成你的钱包
   所有权限都通过参数显式给出，没有用 msg.sender，所以经工厂部署不会把权限给到工厂。
   服务金库（AgentryServiceVault）不变，沿用 deployments/56.json 里的地址。
   v4：重新部署市场与陪审（不走升级），新增服务路由 AgentryServiceRouter（「合约交付」的唯一入口）。
    正式环境：全部合约（包括时间锁）用 agentry.mainnet.* 的新 salt，不复用测试环境的任何地址。

   ⚠️ 本脚本只产出 preview，不执行。每一笔都由你自己运行
      baw contract-call execute --requestId <id> 确认上链。

   用法
     node scripts/deploy-baw.js plan    --from <钱包地址>   算地址、探测依赖、写计划
     node scripts/deploy-baw.js preview <步骤号>            为某一步生成 baw 预览
     node scripts/deploy-baw.js status                      查看每一步是否已上链
     node scripts/deploy-baw.js finish                      全部上链后核对并写 deployments/56.json
   ========================================================================== */

"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { ethers } = require("ethers");

const CHAIN_ID = 56;
const RPC = process.env.BSC_RPC || "https://bsc-dataseed.bnbchain.org";
const FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
const ROOT = path.join(__dirname, "..");
const PLAN = path.join(ROOT, "deployments", CHAIN_ID + ".plan.json");
const OUT = path.join(ROOT, "deployments", CHAIN_ID + ".json");
const TMP = path.join(ROOT, "deployments", ".baw");

// 参数和依赖地址只有一份，在 scripts/params.js
const { PARAMS, DEPS } = require("./params");

const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);

function die(msg) {
  console.error("\n✗ " + msg + "\n");
  process.exit(1);
}

function artifact(rel, name) {
  // rel 以 @ 开头的是依赖包里的合约（代理、时间锁），产物在 artifacts/@openzeppelin/...
  const f = rel.startsWith("@") ? path.join(ROOT, "artifacts", rel, name + ".json") : path.join(ROOT, "artifacts", "contracts", rel, name + ".json");
  if (!fs.existsSync(f)) die("找不到编译产物 " + f + "，先运行 npx hardhat compile");
  return JSON.parse(fs.readFileSync(f, "utf8"));
}

// 正式环境：全部合约（包括时间锁）用一套新的 salt，不复用测试环境的任何地址
const salt = (label) => ethers.id("agentry.mainnet." + label);
const TIMELOCK_DELAY = 48 * 3600;

function create2(label, art, args) {
  const iface = new ethers.Interface(art.abi);
  const initCode = ethers.concat([art.bytecode, iface.encodeDeploy(args)]);
  const s = salt(label);
  return {
    address: ethers.getCreate2Address(FACTORY, s, ethers.keccak256(initCode)),
    data: ethers.concat([s, initCode]),
    args: args.map(String),
  };
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[a.slice(2)] = true;
      else { out[a.slice(2)] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

const fmtP = () => [
  ["单笔上限", ethers.formatEther(PARAMS.maxNative) + " BNB / " + ethers.formatUnits(PARAMS.maxToken, 18) + " USDT"],
  ["认领期", PARAMS.claimWindow / 3600 + " 小时"],
  ["验收期", PARAMS.reviewWindow / 3600 + " 小时"],
  ["交付时长", PARAMS.minDelivery / 3600 + " ~ " + PARAMS.maxDelivery / 3600 + " 小时"],
  ["陪审费率", PARAMS.juryFeeBps / 100 + "%"],
  ["投票窗口", PARAMS.votingWindow / 3600 + " 小时"],
  ["法定票数", String(PARAMS.quorum)],
  ["陪审押金", ethers.formatEther(PARAMS.stakeNative) + " BNB / " + ethers.formatUnits(PARAMS.stakeToken, 18) + " USDT"],
];

/* ---------- plan ---------- */

async function cmdPlan(args) {
  const from = args.from;
  if (!from || !ethers.isAddress(from)) die("需要 --from <你的 Agentic Wallet 地址>");
  const owner = ethers.getAddress(from);

  if ((await provider.getCode(FACTORY)) === "0x") die("BSC 上找不到 CREATE2 工厂 " + FACTORY);

  // 依赖探测：地址填错不可逆
  const erc20 = new ethers.Contract(DEPS.paymentToken, [
    "function symbol() view returns (string)", "function decimals() view returns (uint8)"], provider);
  const [sym, dec] = await Promise.all([erc20.symbol(), erc20.decimals()]);
  if (Number(dec) !== 18) die("结算代币是 " + dec + " 位小数，参数表按 18 位配置");
  const aid = new ethers.Contract(DEPS.agentId, [
    "function name() view returns (string)",
    "function balanceOf(address) view returns (uint256)",
    "function handleOf(address) view returns (string)"], provider);
  const [aidName, held, handle] = await Promise.all([aid.name(), aid.balanceOf(owner), aid.handleOf(owner)]);

  const bal = await provider.getBalance(owner);

  const MA = artifact("AgentMarket.sol", "AgentMarket");
  const JA = artifact("AgentJury.sol", "AgentJury");
  const PA = artifact("@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol", "ERC1967Proxy");
  const marketIface = new ethers.Interface(MA.abi);
  const juryIface = new ethers.Interface(JA.abi);

  const timelock = create2("timelock", artifact("@openzeppelin/contracts/governance/TimelockController.sol", "TimelockController"), [
    TIMELOCK_DELAY, [owner], [owner], ethers.ZeroAddress,
  ]);
  const marketImpl = create2("market.impl", MA, [DEPS.agentId, DEPS.paymentToken]);
  const market = create2("market.proxy", PA, [marketImpl.address, marketIface.encodeFunctionData("initialize", [
    owner, timelock.address,
    PARAMS.maxNative, PARAMS.maxToken,
    PARAMS.claimWindow, PARAMS.reviewWindow,
    PARAMS.minDelivery, PARAMS.maxDelivery,
    PARAMS.juryFeeBps,
  ])]);
  const juryImpl = create2("jury.impl", JA, [DEPS.agentId, DEPS.paymentToken, market.address]);
  const jury = create2("jury.proxy", PA, [juryImpl.address, juryIface.encodeFunctionData("initialize", [
    owner, timelock.address,
    PARAMS.votingWindow, PARAMS.quorum,
    PARAMS.stakeNative, PARAMS.stakeToken,
  ])]);

  const RA = artifact("service/AgentryServiceRouter.sol", "AgentryServiceRouter");
  const router = create2("router", RA, [market.address, DEPS.agentId]);

  // 金库单独部署（scripts/deploy-vault-baw.js）。只沿用管理员就是本次部署钱包的金库，
  // 测试环境的金库（管理员是别的地址）不会被带进正式部署记录
  const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : null;
  let vaultPrev = prev && prev.contracts && prev.contracts.AgentryServiceVault;
  if (vaultPrev && ((await provider.getCode(vaultPrev.address)) === "0x" ||
      String(vaultPrev.constructorArgs && vaultPrev.constructorArgs[0]).toLowerCase() !== owner.toLowerCase())) vaultPrev = undefined;

  const steps = [
    { n: 1, label: "部署升级时间锁 TimelockController（48 小时）", to: FACTORY, value: "0", data: timelock.data, expect: timelock.address },
    { n: 2, label: "部署 AgentMarket 实现合约", to: FACTORY, value: "0", data: marketImpl.data, expect: marketImpl.address },
    { n: 3, label: "部署 AgentMarket 代理并初始化", to: FACTORY, value: "0", data: market.data, expect: market.address },
    { n: 4, label: "部署 AgentJury 实现合约", to: FACTORY, value: "0", data: juryImpl.data, expect: juryImpl.address },
    { n: 5, label: "部署 AgentJury 代理并初始化", to: FACTORY, value: "0", data: jury.data, expect: jury.address },
    { n: 6, label: "接线 market.setJury（一次性写入，之后永久锁定）", to: market.address, value: "0", wire: "jury",
      data: marketIface.encodeFunctionData("setJury", [jury.address]) },
    { n: 7, label: "部署服务路由 AgentryServiceRouter", to: FACTORY, value: "0", data: router.data, expect: router.address },
    { n: 8, label: "接线 market.setServiceRouter", to: market.address, value: "0", wire: "router",
      data: new ethers.Interface(["function setServiceRouter(address)"]).encodeFunctionData("setServiceRouter", [router.address]) },
  ];

  for (const s of steps) {
    if (s.expect && (await provider.getCode(s.expect)) !== "0x") s.alreadyDeployed = true;
  }

  const plan = {
    chainId: CHAIN_ID, factory: FACTORY, owner, createdAt: new Date().toISOString(),
    params: Object.fromEntries(Object.entries(PARAMS).map(([k, v]) => [k, String(v)])),
    dependencies: DEPS,
    contracts: {
      AgentMarket: { address: market.address, proxy: true, implementation: marketImpl.address, implementationArgs: marketImpl.args },
      AgentJury: { address: jury.address, proxy: true, implementation: juryImpl.address, implementationArgs: juryImpl.args },
      AgentryServiceRouter: { address: router.address, constructorArgs: router.args },
      Timelock: { address: timelock.address, delay: TIMELOCK_DELAY, constructorArgs: [String(TIMELOCK_DELAY), "[" + owner + "]", "[" + owner + "]", ethers.ZeroAddress] },
      ...(vaultPrev ? { AgentryServiceVault: vaultPrev } : {}),
    },
    steps,
  };
  fs.mkdirSync(path.dirname(PLAN), { recursive: true });
  fs.writeFileSync(PLAN, JSON.stringify(plan, null, 2) + "\n");

  console.log("\n部署计划（BSC 主网）");
  console.log("  钱包        " + owner + (handle ? "（" + handle + ".ai）" : ""));
  console.log("  余额        " + ethers.formatEther(bal) + " BNB");
  console.log("  Agent ID    " + aidName + "，钱包持有 " + held + " 枚");
  console.log("  结算代币    " + sym + " " + DEPS.paymentToken);
  console.log("\n参数");
  for (const [k, v] of fmtP()) console.log("  " + k.padEnd(8, "　") + v);
  console.log("\n部署后的地址（现在就能算出来）");
  console.log("  AgentMarket（代理）  " + market.address);
  console.log("  AgentJury（代理）    " + jury.address);
  console.log("  服务路由             " + router.address);
  console.log("  升级时间锁           " + timelock.address + ((await provider.getCode(timelock.address)) !== "0x" ? "（已在链上，沿用）" : "（新部署）"));
  console.log("  AgentryServiceVault  " + (vaultPrev ? vaultPrev.address + "（沿用）" : "（不在本计划内，用 deploy-vault-baw.js 单独部署）"));
  console.log("\n步骤");
  for (const s of steps) console.log("  " + s.n + ". " + s.label + (s.alreadyDeployed ? "  ✓ 已在链上" : ""));
  console.log("\n计划已写入 deployments/56.plan.json。逐步运行：node scripts/deploy-baw.js preview 1\n");
  if (held === 0n) console.log("⚠️  钱包没有 Agent ID，部署后自己没法走市场流程\n");
}

/* ---------- preview ---------- */

function loadPlan() {
  if (!fs.existsSync(PLAN)) die("还没有部署计划，先运行 plan");
  return JSON.parse(fs.readFileSync(PLAN, "utf8"));
}

async function cmdPreview(args) {
  const plan = loadPlan();
  const n = Number(args._[1]);
  const step = plan.steps.find((s) => s.n === n);
  if (!step) die("没有第 " + args._[1] + " 步（1 到 " + plan.steps.length + "）");

  if (step.expect && (await provider.getCode(step.expect)) !== "0x") {
    console.log("第 " + n + " 步已经在链上了：" + step.expect);
    return;
  }
  // 每一步依赖前面的合约已在链上，否则模拟必然失败
  for (const prev of plan.steps.filter((s) => s.n < n && s.expect)) {
    if ((await provider.getCode(prev.expect)) === "0x") die("先完成第 " + prev.n + " 步：" + prev.label);
  }
  // 接线之前两个代理必须都在链上
  if (step.wire === "router") {
    const m = new ethers.Contract(plan.contracts.AgentMarket.address, ["function serviceRouter() view returns (address)"], provider);
    if ((await m.serviceRouter()).toLowerCase() === plan.contracts.AgentryServiceRouter.address.toLowerCase()) { console.log("第 " + n + " 步已经完成"); return; }
  }
  if (step.wire === "jury") {
    for (const a of [plan.contracts.AgentMarket.address, plan.contracts.AgentJury.address]) {
      if ((await provider.getCode(a)) === "0x") die("先完成第 1、2 步，" + a + " 还不在链上");
    }
    const m = new ethers.Contract(plan.contracts.AgentMarket.address, ["function jury() view returns (address)"], provider);
    const cur = await m.jury();
    if (cur !== ethers.ZeroAddress) {
      if (cur.toLowerCase() === plan.contracts.AgentJury.address.toLowerCase()) { console.log("第 " + n + " 步已经完成"); return; }
      die("market.jury() 已经被设成 " + cur + "，无法更改");
    }
  }

  const bawArgs = [
    "contract-call", "preview",
    "--binanceChainId", String(CHAIN_ID),
    "--from", plan.owner,
    "--to", step.to,
    "--value", step.value,
    "--inputData", step.data,
  ];
  // baw 默认的模拟 gas 上限不够部署大合约（AgentMarket 约 513 万 gas），先估算再给 25% 余量
  const est = await provider.estimateGas({ from: plan.owner, to: step.to, data: step.data, value: BigInt(step.value) });
  const cap = (est * 125n) / 100n;
  bawArgs.push("--gasLimit", String(cap > 15000000n ? 15000000n : cap), "--json");
  fs.mkdirSync(TMP, { recursive: true });
  const argFile = path.join(TMP, "step" + n + ".json");
  fs.writeFileSync(argFile, JSON.stringify(bawArgs));

  console.log("\n第 " + n + " 步：" + step.label);
  console.log("  to     " + step.to + (step.to === FACTORY ? "（CREATE2 工厂）" : ""));
  if (step.expect) console.log("  将创建 " + step.expect);
  console.log("  数据   " + (step.data.length - 2) / 2 + " 字节\n");

  const raw = execFileSync(process.execPath, [path.join(__dirname, "baw-run.mjs"), argFile], { encoding: "utf8" });
  fs.writeFileSync(path.join(TMP, "step" + n + ".preview.json"), raw);
  console.log(raw);
}

/* ---------- status / finish ---------- */

async function cmdStatus() {
  const plan = loadPlan();
  const m = new ethers.Contract(plan.contracts.AgentMarket.address, ["function jury() view returns (address)"], provider);
  for (const s of plan.steps) {
    let done;
    if (s.expect) done = (await provider.getCode(s.expect)) !== "0x";
    else if ((await provider.getCode(s.to)) === "0x") done = false;
    else if (s.wire === "router") done = (await new ethers.Contract(s.to, ["function serviceRouter() view returns (address)"], provider).serviceRouter())
      .toLowerCase() === plan.contracts.AgentryServiceRouter.address.toLowerCase();
    else done = (await m.jury()).toLowerCase() === plan.contracts.AgentJury.address.toLowerCase();
    console.log("  " + s.n + ". " + s.label.padEnd(40) + (done ? "✓ 已上链" : "· 未完成"));
  }
}

async function cmdFinish() {
  const plan = loadPlan();
  const c = plan.contracts;
  for (const [k, v] of Object.entries(c)) {
    if ((await provider.getCode(v.address)) === "0x") die(k + " 还不在链上：" + v.address);
  }
  const market = new ethers.Contract(c.AgentMarket.address, [
    "function jury() view returns (address)", "function owner() view returns (address)",
    "function agentId() view returns (address)", "function upgrader() view returns (address)",
    "function minDelivery() view returns (uint32)", "function serviceRouter() view returns (address)"], provider);
  const rt = new ethers.Contract(c.AgentryServiceRouter.address, [
    "function market() view returns (address)", "function agentId() view returns (address)"], provider);
  const jury = new ethers.Contract(c.AgentJury.address, [
    "function market() view returns (address)", "function owner() view returns (address)",
    "function upgrader() view returns (address)"], provider);
  const tl = new ethers.Contract(c.Timelock.address, [
    "function getMinDelay() view returns (uint256)", "function hasRole(bytes32,address) view returns (bool)",
    "function PROPOSER_ROLE() view returns (bytes32)", "function EXECUTOR_ROLE() view returns (bytes32)",
    "function DEFAULT_ADMIN_ROLE() view returns (bytes32)"], provider);
  const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  const implOf = async (a) => ethers.getAddress("0x" + (await provider.getStorage(a, IMPL_SLOT)).slice(26));
  const vault = c.AgentryServiceVault && new ethers.Contract(c.AgentryServiceVault.address, [
    "function hasRole(bytes32,address) view returns (bool)",
    "function DEFAULT_ADMIN_ROLE() view returns (bytes32)"], provider);

  const eq = (a, b) => a.toLowerCase() === b.toLowerCase();
  const checks = [
    ["market.jury() 指向 Jury", eq(await market.jury(), c.AgentJury.address)],
    ["jury.market() 指向 Market", eq(await jury.market(), c.AgentMarket.address)],
    ["market.owner() 是你的钱包", eq(await market.owner(), plan.owner)],
    ["jury.owner() 是你的钱包", eq(await jury.owner(), plan.owner)],
    ["market.agentId() 是官方 Agent ID", eq(await market.agentId(), plan.dependencies.agentId)],
    // 金库沿用，管理员是金库部署时登记的地址，不一定是这次部署的钱包
    ...(vault ? [["vault 管理员是登记的管理员", await vault.hasRole(await vault.DEFAULT_ADMIN_ROLE(), c.AgentryServiceVault.constructorArgs[0])]] : []),
    ["market 代理指向实现合约", eq(await implOf(c.AgentMarket.address), c.AgentMarket.implementation)],
    ["jury 代理指向实现合约", eq(await implOf(c.AgentJury.address), c.AgentJury.implementation)],
    ["market.upgrader() 是时间锁", eq(await market.upgrader(), c.Timelock.address)],
    ["jury.upgrader() 是时间锁", eq(await jury.upgrader(), c.Timelock.address)],
    ["时间锁延迟 48 小时", (await tl.getMinDelay()) === BigInt(TIMELOCK_DELAY)],
    ["时间锁提议人是你的钱包", await tl.hasRole(await tl.PROPOSER_ROLE(), plan.owner)],
    ["时间锁执行人是你的钱包", await tl.hasRole(await tl.EXECUTOR_ROLE(), plan.owner)],
    ["时间锁没有外部管理员", !(await tl.hasRole(await tl.DEFAULT_ADMIN_ROLE(), plan.owner))],
    ["参数已初始化", (await market.minDelivery()) === BigInt(plan.params.minDelivery)],
    ["market.serviceRouter() 指向服务路由", eq(await market.serviceRouter(), c.AgentryServiceRouter.address)],
    ["服务路由指向 Market", eq(await rt.market(), c.AgentMarket.address)],
    ["服务路由用的是官方 Agent ID", eq(await rt.agentId(), plan.dependencies.agentId)],
  ];
  let ok = true;
  for (const [k, v] of checks) { console.log("  " + (v ? "✓" : "✗") + " " + k); ok = ok && v; }
  if (!ok) die("核对没通过，不写部署记录");

  // 旧版本的记录留档
  if (fs.existsSync(OUT)) {
    const old = JSON.parse(fs.readFileSync(OUT, "utf8"));
    if (old.contracts.AgentMarket.address.toLowerCase() !== c.AgentMarket.address.toLowerCase()) {
      let tag = old.contracts.AgentryServiceRouter ? "v4" : old.contracts.Timelock ? "v3" : "v2";
      // 同名留档已存在（比如 v4 之后又部署过 v4.1）就往后加后缀，不覆盖
      while (fs.existsSync(path.join(ROOT, "deployments", CHAIN_ID + "." + tag + "-retired.json"))) tag += "x";
      fs.writeFileSync(path.join(ROOT, "deployments", CHAIN_ID + "." + tag + "-retired.json"), JSON.stringify(old, null, 2) + "\n");
      console.log("  旧部署记录已存为 deployments/" + CHAIN_ID + "." + tag + "-retired.json");
    }
  }

  const record = {
    chainId: CHAIN_ID, network: "bsc", deployedAt: new Date().toISOString(),
    deployer: plan.owner, factory: plan.factory,
    contracts: c,
    dependencies: { ...plan.dependencies, mocked: false },
    params: plan.params,
  };
  fs.writeFileSync(OUT, JSON.stringify(record, null, 2) + "\n");
  console.log("\n部署记录已写入 deployments/56.json，agentry CLI 会自动读取它\n");
}

const COMMANDS = { plan: cmdPlan, preview: cmdPreview, status: cmdStatus, finish: cmdFinish };

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const fn = COMMANDS[args._[0]];
  if (!fn) {
    console.log("用法：node scripts/deploy-baw.js plan --from <地址> | preview <步骤> | status | finish");
    process.exit(args._[0] ? 1 : 0);
  }
  fn(args).catch((e) => die(e.shortMessage || e.message || String(e)));
}

module.exports = { create2, salt, FACTORY };
