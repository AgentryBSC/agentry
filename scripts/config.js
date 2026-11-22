/// 部署参数在 scripts/params.js，那里是唯一一份
const { PARAMS, DEPS } = require("./params");

/// 各网络的依赖合约地址
///
/// ⚠️ 主网地址在部署前会被脚本探测校验（symbol / decimals / balanceOf），
///    但你仍应自己核对一遍——填错结算代币地址是不可逆的灾难。
const NETWORKS = {
  56: {
    name: "BSC 主网",
    // SPACE ID Agent ID，ERC-721，不可转让。来源：币安黑客松公告
    agentId: DEPS.agentId,
    // Binance-Peg BSC-USD（USDT），18 位小数
    paymentToken: DEPS.paymentToken,
    explorer: "https://bscscan.com",
  },
  97: {
    name: "BSC 测试网",
    // 测试网没有官方 Agent ID，部署脚本会自动部署 mock 顶替
    agentId: null,
    paymentToken: null,
    explorer: "https://testnet.bscscan.com",
  },
  31337: {
    name: "本地网络",
    agentId: null,
    paymentToken: null,
    explorer: null,
  },
};

// hardhat.config.js 把本地网络的 chainId 设成了 56（FLAP 的 _getGuardian
// 在不支持的链上会 revert），所以本地跑脚本时要靠这个标记区分
function isLocal(hre) {
  return hre.network.name === "hardhat" || hre.network.name === "localhost";
}

module.exports = { PARAMS, NETWORKS, isLocal };
