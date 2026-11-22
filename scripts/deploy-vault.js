const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;

const { NETWORKS, isLocal } = require("./config");

/// 部署 AgentryServiceVault —— FLAP 税收金库。
///
/// 这个合约与 Agentry 主体是独立的：它服务于第一个服务商要发的代币。
/// 必须在代币发射**之前**部署，因为发射参数里的 "funds recipient wallet"
/// 要填这个合约地址。
///
/// 用法：
///   npx hardhat run scripts/deploy-vault.js --network bscTestnet
///   VAULT_ADMIN=0x... npx hardhat run scripts/deploy-vault.js --network bsc
async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const local = isLocal(hre);
  const cfg = NETWORKS[chainId] ?? { name: `chainId ${chainId}`, explorer: null };

  if (chainId === 56 && !local && process.env.CONFIRM_MAINNET !== "yes") {
    throw new Error("主网部署需要显式确认：CONFIRM_MAINNET=yes ...");
  }

  const signers = await ethers.getSigners();
  if (signers.length === 0) {
    throw new Error("没有可用的部署账户。请在 .env 中配置 PRIVATE_KEY。");
  }
  const [deployer] = signers;
  const admin = process.env.VAULT_ADMIN || deployer.address;

  console.log(`\n网络      ${local ? "本地网络" : cfg.name} (chainId ${chainId})`);
  console.log(`部署账户  ${deployer.address}`);
  console.log(`金库管理  ${admin}${admin === deployer.address ? "（默认为部署账户）" : ""}`);

  if (!ethers.isAddress(admin)) {
    throw new Error(`VAULT_ADMIN 不是合法地址：${admin}`);
  }

  // FLAP 的 VaultBase._getGuardian() 只认 56 / 97 / 4663 三条链，
  // 其他链上构造函数会直接 revert
  if (![56, 97, 4663].includes(chainId)) {
    throw new Error(
      `FLAP Vault 规范不支持 chainId ${chainId}。` +
        "本地测试请确认 hardhat.config.js 已把 chainId 设为 56。"
    );
  }

  const vault = await (await ethers.getContractFactory("AgentryServiceVault")).deploy(admin);
  await vault.waitForDeployment();
  const vaultAddr = await vault.getAddress();

  console.log(`\nAgentryServiceVault  ${vaultAddr}`);

  // ---- 核对规范实现 ----------------------------------------------------
  const quote = await vault.vaultQuoteToken();
  const specVersion = await vault.vaultSpecVersion();
  const operatorRole = await vault.OPERATOR_ROLE();

  console.log(`\n收入币种  ${quote === ethers.ZeroAddress ? "原生 BNB" : quote}`);
  console.log(`规范版本  ${specVersion}`);
  console.log(`描述      ${await vault.description()}`);

  // ---- Guardian 披露 ---------------------------------------------------
  // 这是 FLAP 规范的强制条款，必须让部署者看见
  const GUARDIANS = {
    56: "0x9e27098dcD8844bcc6287a557E0b4D09C86B8a4b",
    97: "0x76Fa8C526f8Bc27ba6958B76DeEf92a0dbE46950",
    4663: "0x0000b48720d3B4ED6BC5031768B07F2b59270000",
  };
  const guardian = GUARDIANS[chainId];
  const guardianHasRole = await vault.hasRole(operatorRole, guardian);

  console.log(`\n⚠️  Guardian 强制条款`);
  console.log(`   FLAP Guardian  ${guardian}`);
  console.log(`   持有提款权限    ${guardianHasRole ? "是" : "否（异常，请检查）"}`);
  console.log(`   该授权不可被任何其他账户撤销，只有 Guardian 自己能放弃。`);
  console.log(`   提交材料里必须写明：你的地址与 FLAP Guardian 都能提走金库 BNB。`);

  if (!guardianHasRole) {
    throw new Error("Guardian 没有拿到 OPERATOR_ROLE，不符合 FLAP 规范");
  }

  // ---- 记录 ------------------------------------------------------------
  if (!local) {
    const dir = path.join(__dirname, "..", "deployments");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${chainId}-vault.json`);
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          chainId,
          network: hre.network.name,
          deployedAt: new Date().toISOString(),
          deployer: deployer.address,
          contracts: {
            AgentryServiceVault: { address: vaultAddr, constructorArgs: [admin] },
          },
          flapGuardian: guardian,
        },
        null,
        2
      ) + "\n"
    );
    console.log(`\n部署记录已写入 deployments/${chainId}-vault.json`);
  }

  console.log(`\n── 后续步骤 ${"─".repeat(46)}`);

  if (local) {
    console.log("本地试跑完成，未写入记录文件。");
    console.log("");
    return;
  }

  console.log(`1. 发射代币时，把 "funds recipient wallet" 填成：`);
  console.log(`     ${vaultAddr}`);
  console.log(`   并把 mktBps 设为非零——税收是按 bps 分成四份的，`);
  console.log(`   金库拿的只是 mktBps 那一份。详见 docs/flap-notes.md 第 5 节。`);
  console.log(`2. 代币发射后回填代币地址（仅能设置一次）：`);
  console.log(`     vault.setTaxToken(<代币地址>)`);
  console.log(`3. 验证源码：`);
  console.log(`     npx hardhat verify --network ${hre.network.name} ${vaultAddr} ${admin}`);
  if (cfg.explorer) {
    console.log(`4. 浏览器：${cfg.explorer}/address/${vaultAddr}`);
  }
  console.log("");
}

main().catch((e) => {
  console.error(`\n✗ 部署失败：${e.message}\n`);
  process.exitCode = 1;
});
