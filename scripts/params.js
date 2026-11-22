/// 部署参数，唯一一份。hardhat 部署（scripts/config.js）和钱包部署（scripts/deploy-baw.js）都读这里。
/// 与 docs/mechanics.md 第 6 节的参数表一致；改这里要同步那张表。
///
/// ⚠️ 部署后 owner 仍可调整，但要经过 48 小时时间锁。

const { ethers } = require("ethers");

const PARAMS = {
  // AgentMarket —— 金额上限按币种分别设置
  maxNative: ethers.parseEther("1"), // 单笔 BNB 任务上限
  maxToken: ethers.parseUnits("600", 18), // 单笔 USDT 任务上限
  claimWindow: 7 * 24 * 3600, // 认领期 7 天
  reviewWindow: 72 * 3600, // 验收期 72 小时
  minDelivery: 1 * 24 * 3600, // 交付时长下限 1 天
  maxDelivery: 7 * 24 * 3600, // 交付时长上限 7 天
  juryFeeBps: 500, // 陪审费 5%

  // AgentJury —— 押金同样按币种分别设置
  votingWindow: 48 * 3600, // 投票窗口 48 小时
  quorum: 3, // 法定票数
  stakeNative: ethers.parseEther("0.002"), // BNB 争议的单票押金
  stakeToken: ethers.parseUnits("1", 18), // USDT 争议的单票押金
};

/// BSC 主网依赖
const DEPS = {
  // SPACE ID Agent ID，ERC-721，不可转让。来源：币安黑客松公告
  agentId: "0x60b9262456de011f7d15a54cdd8c48baaa8b022f",
  // Binance-Peg BSC-USD（USDT），18 位小数
  paymentToken: "0x55d398326f99059fF775485246999027B3197955",
};

module.exports = { PARAMS, DEPS };
