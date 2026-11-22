/* ==========================================================================
   主网分叉端到端预演：在 BSC 主网最新状态的分叉上，按 deployments/56.plan.json
   部署全套合约，再用真实的 Agent ID 合约和真实账号把主要流程走一遍。主网上一笔都不发。

   用法：npx hardhat run scripts/fork-e2e.js
   可选环境变量：FORK_RPC（默认 https://bsc-rpc.publicnode.com）
   ========================================================================== */
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const RPC = process.env.FORK_RPC || "https://bsc-rpc.publicnode.com";
const PROVIDER_AGENT = "0xCBcb37B61edbC1E7410A35b93193637C13c5E163"; // agentry.ai：平台服务方
const BUYER_AGENT = "0x7c70c1CF10D420c8A4a9eF3488617E766b24bDB3";   // anndy.ai：测试用户
const STAND_IN_TOKEN = "0xdb005a43e976994c41bf9a3f47f987c989967777"; // 已上线的 FLAP 税收代币，代替还没发行的 Agentry
const TOKEN_HOLDER = "0x34dc6e71b56fA468246b7a8a919dfE8A424325cd";    // 测试水龙头，里面有这个代币
const CLAIM = ethers.parseEther("10000");

let pass = 0, fail = 0;
function check(name, ok) { console.log("  " + (ok ? "✓" : "✗") + " " + name); ok ? pass++ : fail++; }
async function as(addr) {
  await network.provider.send("hardhat_impersonateAccount", [addr]);
  await network.provider.send("hardhat_setBalance", [addr, "0x56BC75E2D63100000"]);
  return ethers.getSigner(addr);
}
async function reverts(p) { try { await (await p).wait?.(); return false; } catch { return true; } }

async function main() {
  await network.provider.send("hardhat_reset", [{ forking: { jsonRpcUrl: RPC } }]);
  console.log("分叉区块 " + (await ethers.provider.getBlockNumber()));

  const plan = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "56.plan.json"), "utf8"));
  const owner = await as(plan.owner);
  console.log("\n1. 按计划部署（部署钱包 " + plan.owner + "）");
  for (const s of plan.steps) {
    await (await owner.sendTransaction({ to: s.to, data: s.data, value: BigInt(s.value) })).wait();
    if (s.expect) check(s.n + ". " + s.label, (await ethers.provider.getCode(s.expect)) !== "0x");
    else console.log("  ✓ " + s.n + ". " + s.label);
  }
  const c = plan.contracts;
  const market = await ethers.getContractAt("AgentMarket", c.AgentMarket.address);
  const router = await ethers.getContractAt("AgentryServiceRouter", c.AgentryServiceRouter.address);
  check("市场用的是真实 Agent ID 合约", (await market.agentId()).toLowerCase() === plan.dependencies.agentId.toLowerCase());

  console.log("\n2. 金库：部署钱包作管理员，收税、提款");
  const vault = await (await ethers.getContractFactory("AgentryServiceVault", owner)).deploy(plan.owner);
  const vaultAddr = await vault.getAddress();
  const stranger = (await ethers.getSigners())[5];
  await (await stranger.sendTransaction({ to: vaultAddr, value: ethers.parseEther("0.5") })).wait();
  check("收到 0.5 BNB 并入账", (await vault.stats())[0] === ethers.parseEther("0.5"));
  check("其他地址不能提款", await reverts(vault.connect(stranger).withdrawAll(stranger.address)));
  const before = await ethers.provider.getBalance(plan.owner);
  await (await vault.connect(owner).withdraw(plan.owner, ethers.parseEther("0.2"))).wait();
  check("部署钱包能提款", (await ethers.provider.getBalance(plan.owner)) > before);
  check("提款后可用余额 0.3", (await vault.stats())[0] === ethers.parseEther("0.3"));
  await (await vault.connect(owner).setTaxToken(STAND_IN_TOKEN)).wait();
  check("setTaxToken 只能一次", await reverts(vault.connect(owner).setTaxToken(STAND_IN_TOKEN)));

  console.log("\n3. 平台服务方 agentry.ai 注册");
  const prov = await as(PROVIDER_AGENT);
  const buyer = await as(BUYER_AGENT);
  check("agentry.ai 持有 Agent ID", await market.isAgent(PROVIDER_AGENT));
  check("anndy.ai 持有 Agent ID", await market.isAgent(BUYER_AGENT));
  await (await market.connect(prov).register("data:application/json,{}")).wait();
  check("注册后计入服务商", (await market.providerCount()) === 1n);

  console.log("\n4. 水龙头：owner 是 agentry.ai，经路由挂牌，用户领取");
  const faucet = await (await ethers.getContractFactory("AgentryFaucet", owner)).deploy(PROVIDER_AGENT, plan.dependencies.agentId, c.AgentryServiceRouter.address);
  const fAddr = await faucet.getAddress();
  await (await faucet.connect(prov).setToken(STAND_IN_TOKEN)).wait();
  await (await faucet.connect(prov).setClaimAmount(CLAIM)).wait();
  const token = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", STAND_IN_TOKEN);
  const holder = await as(TOKEN_HOLDER);
  await (await token.connect(holder).transfer(fAddr, CLAIM * 3n)).wait();
  check("水龙头到账代币", (await token.balanceOf(fAddr)) > 0n);
  const hash = ethers.id("faucet spec");
  await (await router.connect(prov).createServiceListing(fAddr, "data:application/json,{}", hash)).wait();
  const lid = await market.listingCount();
  await (await faucet.connect(prov).setListing(lid)).wait();
  const [okBefore] = await router.canUse(lid, BUYER_AGENT, "0x");
  check("预检：anndy.ai 可以领", okBefore);
  const b0 = await token.balanceOf(BUYER_AGENT);
  await (await router.connect(buyer).use(lid, "0x")).wait();
  check("anndy.ai 领到代币", (await token.balanceOf(BUYER_AGENT)) > b0);
  check("第二次领取被拒绝", await reverts(router.connect(buyer).use(lid, "0x")));
  const [okAfter, why] = await router.canUse(lid, BUYER_AGENT, "0x");
  check("预检给出原因：" + why, !okAfter);
  check("服务方不能领自己的服务", await reverts(router.connect(prov).use(lid, "0x")));
  const [uses, users] = await market.serviceStatsOf(lid);
  check("市场统计：使用 1 次、1 人", uses === 1n && users === 1n);
  check("全站参与者 2 人", (await market.participantCount()) === 2n);

  console.log("\n5. 付费挂牌：BNB 下单、交付、验收");
  await (await market.connect(prov).createListing(ethers.parseEther("0.01"), ethers.ZeroAddress, 86400, "data:application/json,{}", hash)).wait();
  const paid = await market.listingCount();
  await (await market.connect(buyer).createOrder(paid, "data:text/plain,hi", { value: ethers.parseEther("0.01") })).wait();
  const tid = await market.taskCount();
  await (await market.connect(prov).submitResult(tid, "data:text/plain,done")).wait();
  const p0 = await ethers.provider.getBalance(PROVIDER_AGENT);
  await (await market.connect(buyer).acceptResult(tid)).wait();
  check("服务方收到 0.01 BNB", (await ethers.provider.getBalance(PROVIDER_AGENT)) - p0 === ethers.parseEther("0.01"));
  check("服务方完成数 1", (await market.reputationOf(PROVIDER_AGENT)).completed === 1n);
  await (await market.connect(buyer).review(tid, 5, "data:text/plain,good")).wait();
  check("评价写入", (await market.statsOf(PROVIDER_AGENT))[0] === 1n);

  console.log("\n6. 平台权限");
  await (await market.connect(owner).delist(lid)).wait();
  check("下架后不能再使用", await reverts(router.connect(buyer).use(lid, "0x")));
  check("下架后服务方不能自行重新上架", await reverts(market.connect(prov).updateListing(lid, 0, 0, true)));
  check("owner 不能直接升级", await reverts(market.connect(owner).upgradeToAndCall(c.AgentMarket.implementation, "0x")));

  console.log("\n结果：" + pass + " 项通过，" + fail + " 项失败");
  if (fail) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
