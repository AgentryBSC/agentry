/* ==========================================================================
   在 BscScan 上验证（开源）全部合约的源码

   读 deployments/<chainId>.json，逐个提交源码与构造参数：
     · 市场、陪审：实现合约 + ERC1967 代理（代理的构造参数从部署计划里还原）
     · 服务路由、时间锁、金库、水龙头：直接验证
   验证完成后，BscScan 会把代理识别为代理，在合约页面显示「Read/Write as Proxy」。

   需要 Etherscan V2 API Key（在 etherscan.io 注册，一个 Key 通用于 BscScan 等所有链），
   写进项目根目录的 .env：BSCSCAN_API_KEY=你的Key（.env 已在 .gitignore 里）

   用法：npx hardhat run scripts/verify.js --network bsc
   验证常因浏览器还没索引到新合约而失败，可以直接重跑，已验证的会跳过。
   ========================================================================== */
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;

const ROOT = path.join(__dirname, "..");

/// 从部署计划里取出代理部署那一步的 initcode，解出 ERC1967Proxy 的构造参数 (implementation, data)
function proxyArgs(plan, proxyAddress) {
  const step = plan.steps.find((s) => s.expect && s.expect.toLowerCase() === proxyAddress.toLowerCase());
  if (!step) throw new Error("部署计划里找不到代理 " + proxyAddress);
  const art = require(path.join(ROOT, "artifacts/@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol/ERC1967Proxy.json"));
  const initCode = "0x" + step.data.slice(2 + 64); // 去掉 32 字节 salt
  if (!initCode.toLowerCase().startsWith(art.bytecode.toLowerCase())) throw new Error("代理字节码与当前编译产物不一致");
  const encoded = "0x" + initCode.slice(art.bytecode.length);
  const [impl, data] = ethers.AbiCoder.defaultAbiCoder().decode(["address", "bytes"], encoded);
  return [impl, data];
}

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const rec = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments", chainId + ".json"), "utf8"));
  const plan = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments", chainId + ".plan.json"), "utf8"));
  if (!process.env.BSCSCAN_API_KEY) throw new Error("缺少 BSCSCAN_API_KEY：请在 .env 里填入 Etherscan V2 API Key");
  const c = rec.contracts;
  const owner = rec.deployer;

  const jobs = [
    ["AgentMarket 实现", c.AgentMarket.implementation, c.AgentMarket.implementationArgs, "contracts/AgentMarket.sol:AgentMarket"],
    ["AgentMarket 代理", c.AgentMarket.address, proxyArgs(plan, c.AgentMarket.address), "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy"],
    ["AgentJury 实现", c.AgentJury.implementation, c.AgentJury.implementationArgs, "contracts/AgentJury.sol:AgentJury"],
    ["AgentJury 代理", c.AgentJury.address, proxyArgs(plan, c.AgentJury.address), "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy"],
    ["服务路由", c.AgentryServiceRouter.address, c.AgentryServiceRouter.constructorArgs, "contracts/service/AgentryServiceRouter.sol:AgentryServiceRouter"],
    ["升级时间锁", c.Timelock.address, [c.Timelock.delay, [owner], [owner], ethers.ZeroAddress], "@openzeppelin/contracts/governance/TimelockController.sol:TimelockController"],
  ];
  if (c.AgentryServiceVault) jobs.push(["金库", c.AgentryServiceVault.address, c.AgentryServiceVault.constructorArgs, "contracts/vault/AgentryServiceVault.sol:AgentryServiceVault"]);
  if (c.AgentryFaucet) jobs.push(["水龙头", c.AgentryFaucet.address, c.AgentryFaucet.constructorArgs, "contracts/faucet/AgentryFaucet.sol:AgentryFaucet"]);

  // ONLY=金库,水龙头 只验证指定的几个（可多开并行跑）
  if (process.env.ONLY) {
    const only = process.env.ONLY.split(",");
    jobs.splice(0, jobs.length, ...jobs.filter((j) => only.includes(j[0])));
  }
  console.log("\n在 BscScan 上验证源码（" + jobs.length + " 个合约）\n");
  let failed = 0;
  for (const [name, address, args, contract] of jobs) {
    process.stdout.write("  " + name.padEnd(14, "　") + address + " ... ");
    try {
      await hre.run("verify:verify", { address, constructorArguments: args, contract });
      console.log("✓");
    } catch (e) {
      const msg = e.message || String(e);
      if (/already verified/i.test(msg)) console.log("已验证过");
      else { console.log("✗ " + msg.split("\n")[0]); failed++; }
    }
  }

  console.log("");
  for (const [name, address] of jobs) console.log("  " + name.padEnd(14, "　") + "https://bscscan.com/address/" + address + "#code");
  if (failed) {
    console.log("\n有 " + failed + " 个没验证成功。新部署的合约浏览器可能还没索引到，等几分钟重跑即可。\n");
    process.exitCode = 1;
  } else {
    console.log("\n全部完成。\n");
  }
}

main().catch((e) => {
  console.error("\n✗ " + e.message + "\n");
  process.exitCode = 1;
});
