const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;

const { PARAMS, NETWORKS, isLocal } = require("./config");

const line = (s = "") => console.log(s);
const h1 = (s) => line(`\n── ${s} ${"─".repeat(Math.max(0, 54 - s.length))}`);

async function main() {
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  const local = isLocal(hre);
  const cfg = NETWORKS[chainId] ?? { name: `chainId ${chainId}`, explorer: null };

  h1("环境");
  line(`网络      ${local ? "本地网络" : cfg.name} (chainId ${chainId})`);

  // ---- 主网二次确认 ----------------------------------------------------
  // 这两个合约会托管用户资金，且 setJury 是一次性写入，部错无法挽回。
  // 这道闸放在取账户之前，确保它永远是最先触发的那个错误
  if (chainId === 56 && !local && process.env.CONFIRM_MAINNET !== "yes") {
    throw new Error(
      "主网部署需要显式确认。确认参数无误后执行：\n" +
        "  CONFIRM_MAINNET=yes npm run deploy:mainnet"
    );
  }

  const signers = await ethers.getSigners();
  if (signers.length === 0) {
    throw new Error("没有可用的部署账户。请在 .env 中配置 PRIVATE_KEY。");
  }
  const [deployer] = signers;
  const balance = await ethers.provider.getBalance(deployer.address);

  line(`部署账户  ${deployer.address}`);
  line(`余额      ${ethers.formatEther(balance)} BNB`);

  if (!local && balance < ethers.parseEther("0.03")) {
    throw new Error("余额不足 0.03 BNB，部署可能中途失败。请先充值。");
  }

  // ---- 依赖合约 --------------------------------------------------------
  h1("依赖合约");

  // 本地网络的 chainId 被设成了 56（见 hardhat.config.js），不能照着
  // 主网配置去拿真实地址——那些合约在本地链上并不存在
  let agentIdAddr = local ? null : cfg.agentId;
  let paymentTokenAddr = local ? null : cfg.paymentToken;

  if (!agentIdAddr || !paymentTokenAddr) {
    line("本网络没有官方 Agent ID / USDT，部署 mock 顶替");

    const mockId = await (await ethers.getContractFactory("MockAgentId")).deploy();
    await mockId.waitForDeployment();
    agentIdAddr = await mockId.getAddress();
    line(`  MockAgentId   ${agentIdAddr}`);

    const mockUsdt = await (await ethers.getContractFactory("MockERC20")).deploy(
      "Mock BSC-USD",
      "USDT"
    );
    await mockUsdt.waitForDeployment();
    paymentTokenAddr = await mockUsdt.getAddress();
    line(`  MockERC20     ${paymentTokenAddr}`);
  } else {
    // 探测真实依赖。地址填错是不可逆的，宁可在部署前就炸掉
    const token = await ethers.getContractAt("MockERC20", paymentTokenAddr);
    const symbol = await token.symbol();
    const decimals = await token.decimals();
    line(`结算代币  ${paymentTokenAddr}  ${symbol} / ${decimals} 位小数`);

    if (Number(decimals) !== 18) {
      throw new Error(
        `结算代币是 ${decimals} 位小数，但参数表按 18 位小数配置。` +
          "请确认地址正确，或同步调整 scripts/config.js 的金额参数。"
      );
    }

    const agentIdNft = await ethers.getContractAt("MockAgentId", agentIdAddr);
    const held = await agentIdNft.balanceOf(deployer.address);
    line(`Agent ID  ${agentIdAddr}  部署账户持有 ${held} 枚`);

    if (held === 0n) {
      line("  ⚠️ 部署账户没有 Agent ID，部署后无法自己走通主流程");
    }
  }

  // ---- 参数 ------------------------------------------------------------
  h1("部署参数");
  line(`支持币种      原生 BNB 与上面那个 ERC-20，共用同一套合约与信誉账`);
  line(`单笔上限      ${ethers.formatEther(PARAMS.maxNative)} BNB / ${ethers.formatUnits(PARAMS.maxToken, 18)} USDT`);
  line(`认领期        ${PARAMS.claimWindow / 3600} 小时`);
  line(`验收期        ${PARAMS.reviewWindow / 3600} 小时`);
  line(`交付时长      ${PARAMS.minDelivery / 3600} ~ ${PARAMS.maxDelivery / 3600} 小时`);
  line(`陪审费率      ${PARAMS.juryFeeBps / 100}%`);
  line(`投票窗口      ${PARAMS.votingWindow / 3600} 小时`);
  line(`法定票数      ${PARAMS.quorum}`);
  line(`陪审押金      ${ethers.formatEther(PARAMS.stakeNative)} BNB / ${ethers.formatUnits(PARAMS.stakeToken, 18)} USDT`);

  // ---- AgentMarket -----------------------------------------------------
  h1("部署 AgentMarket");

  const marketArgs = [
    agentIdAddr,
    paymentTokenAddr,
    deployer.address,
    PARAMS.maxNative,
    PARAMS.maxToken,
    PARAMS.claimWindow,
    PARAMS.reviewWindow,
    PARAMS.minDelivery,
    PARAMS.maxDelivery,
    PARAMS.juryFeeBps,
  ];

  const market = await (await ethers.getContractFactory("AgentMarket")).deploy(...marketArgs);
  await market.waitForDeployment();
  const marketAddr = await market.getAddress();
  line(`AgentMarket   ${marketAddr}`);

  // ---- AgentJury -------------------------------------------------------
  h1("部署 AgentJury");

  const juryArgs = [
    agentIdAddr,
    paymentTokenAddr,
    marketAddr,
    deployer.address,
    PARAMS.votingWindow,
    PARAMS.quorum,
    PARAMS.stakeNative,
    PARAMS.stakeToken,
  ];

  const jury = await (await ethers.getContractFactory("AgentJury")).deploy(...juryArgs);
  await jury.waitForDeployment();
  const juryAddr = await jury.getAddress();
  line(`AgentJury     ${juryAddr}`);

  // ---- 接线 ------------------------------------------------------------
  h1("接线");

  // ⚠️ setJury 是一次性写入，设置后永久锁定。填错只能整个重部署
  const current = await market.jury();
  if (current !== ethers.ZeroAddress) {
    throw new Error(`AgentMarket 的 jury 已被设为 ${current}，无法更改`);
  }

  const tx = await market.setJury(juryAddr);
  await tx.wait();
  line(`market.setJury(${juryAddr})`);

  // 双向核对。接错了整套仲裁就是废的，必须当场验证
  const wiredJury = await market.jury();
  const wiredMarket = await jury.market();

  if (wiredJury !== juryAddr) {
    throw new Error(`接线错误：market.jury() = ${wiredJury}，期望 ${juryAddr}`);
  }
  if (wiredMarket !== marketAddr) {
    throw new Error(`接线错误：jury.market() = ${wiredMarket}，期望 ${marketAddr}`);
  }
  line("双向核对通过");

  // ---- 记录 ------------------------------------------------------------
  const record = {
    chainId,
    network: local ? "local" : hre.network.name,
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    contracts: {
      AgentMarket: { address: marketAddr, constructorArgs: marketArgs.map(String) },
      AgentJury: { address: juryAddr, constructorArgs: juryArgs.map(String) },
    },
    dependencies: {
      agentId: agentIdAddr,
      paymentToken: paymentTokenAddr,
      mocked: local || !cfg.agentId,
    },
  };

  if (!local) {
    const dir = path.join(__dirname, "..", "deployments");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${chainId}.json`);
    fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
    line(`\n部署记录已写入 deployments/${chainId}.json`);
  }

  // ---- 后续步骤 --------------------------------------------------------
  h1("后续步骤");

  if (local) {
    line("本地部署完成，未写入记录文件。");
  } else {
    line(`1. 等待几个区块确认后验证源码：`);
    line(`     npx hardhat run scripts/verify.js --network ${hre.network.name}`);
    line(`2. 在浏览器核对：`);
    line(`     ${cfg.explorer}/address/${marketAddr}`);
    line(`     ${cfg.explorer}/address/${juryAddr}`);
    line(`3. 提交材料里需要披露的 owner 权限见 docs/mechanics.md 第 10 节`);
  }

  line();
}

main().catch((e) => {
  console.error(`\n✗ 部署失败：${e.message}\n`);
  process.exitCode = 1;
});
