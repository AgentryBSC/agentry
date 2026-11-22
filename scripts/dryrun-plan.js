/* ==========================================================================
   在本地 hardhat 链上按 deployments/56.plan.json 原样跑一遍部署，
   确认每一步都能成功、地址和计划一致、接线和权限正确。主网上一笔都不发。

   用法：npx hardhat run scripts/dryrun-plan.js
   ========================================================================== */

const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

// Arachnid 确定性部署代理的运行时字节码（与 BSC 上 0x4e59…956C 一致）
const FACTORY_CODE =
  "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

async function main() {
  const plan = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "56.plan.json"), "utf8"));
  await network.provider.send("hardhat_setCode", [plan.factory, FACTORY_CODE]);
  await network.provider.send("hardhat_impersonateAccount", [plan.owner]);
  await network.provider.send("hardhat_setBalance", [plan.owner, "0x56BC75E2D63100000"]);
  const owner = await ethers.getSigner(plan.owner);

  let gasTotal = 0n;
  for (const s of plan.steps) {
    const tx = await owner.sendTransaction({ to: s.to, data: s.data, value: BigInt(s.value) });
    const rc = await tx.wait();
    gasTotal += rc.gasUsed;
    if (s.expect) {
      const code = await ethers.provider.getCode(s.expect);
      if (code === "0x") throw new Error("第 " + s.n + " 步没有在预期地址创建合约：" + s.expect);
    }
    console.log("  ✓ " + s.n + ". " + s.label + "  gas " + rc.gasUsed);
  }

  const c = plan.contracts;
  const market = await ethers.getContractAt("AgentMarket", c.AgentMarket.address);
  const jury = await ethers.getContractAt("AgentJury", c.AgentJury.address);
  const tl = await ethers.getContractAt("TimelockController", c.Timelock.address);
  const eq = (a, b) => a.toLowerCase() === b.toLowerCase();
  const checks = [
    ["market.jury() 指向 Jury", eq(await market.jury(), c.AgentJury.address)],
    ["jury.market() 指向 Market", eq(await jury.market(), c.AgentMarket.address)],
    ["market.owner() 是钱包", eq(await market.owner(), plan.owner)],
    ["jury.owner() 是钱包", eq(await jury.owner(), plan.owner)],
    ["upgrader 是时间锁", eq(await market.upgrader(), c.Timelock.address) && eq(await jury.upgrader(), c.Timelock.address)],
    ["时间锁 48 小时", (await tl.getMinDelay()) === 172800n],
    ["时间锁提议人、执行人是钱包", (await tl.hasRole(await tl.PROPOSER_ROLE(), plan.owner)) && (await tl.hasRole(await tl.EXECUTOR_ROLE(), plan.owner))],
    ["钱包不是时间锁管理员", !(await tl.hasRole(await tl.DEFAULT_ADMIN_ROLE(), plan.owner))],
    ["参数", (await market.minDelivery()) === BigInt(plan.params.minDelivery) && (await market.maxTaskAmount(ethers.ZeroAddress)) === BigInt(plan.params.maxNative)],
    ["MIN_FREE_DELIVERY 1 小时", (await market.MIN_FREE_DELIVERY()) === 3600n],
  ];
  let ok = true;
  for (const [k, v] of checks) { console.log("  " + (v ? "✓" : "✗") + " " + k); ok = ok && v; }
  console.log("\n  " + plan.steps.length + " 笔合计 gas " + gasTotal + "（按 0.1 gwei 约 " + ethers.formatEther(gasTotal * 100000000n) + " BNB）");
  if (!ok) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
