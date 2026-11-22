require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
const BSCSCAN_API_KEY = process.env.BSCSCAN_API_KEY || "";

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    compilers: [{
      version: "0.8.24",
      settings: {
        optimizer: { enabled: true, runs: 200 },
        // BSC 对 PUSH0 的支持取决于分叉版本，固定 paris 以规避部署期意外
        evmVersion: "paris",
      },
    }],
    // AgentMarket 加上 UUPS 升级逻辑后超过 24KB 部署上限，单独按体积优化（runs 低 = 字节码小，单次调用 gas 略高）
    overrides: {
      "contracts/AgentMarket.sol": {
        version: "0.8.24",
        settings: { optimizer: { enabled: true, runs: 1 }, viaIR: true, evmVersion: "paris" },
      },
    },
  },
  networks: {
    // 本地网络伪装成 BSC 主网：FLAP 的 VaultBase._getGuardian() 在不支持的
    // chainId 上会 revert，默认的 31337 会让金库构造函数直接失败
    hardhat: {
      chainId: 56,
    },
    bscTestnet: {
      url: process.env.BSC_TESTNET_RPC || "https://data-seed-prebsc-1-s1.binance.org:8545",
      chainId: 97,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
    bsc: {
      url: process.env.BSC_RPC || "https://bsc-dataseed.binance.org",
      chainId: 56,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
  },
  etherscan: {
    // Etherscan V2：一个 Key 通用于所有链（BscScan 的旧 V1 Key 已停用）
    apiKey: BSCSCAN_API_KEY,
  },
  sourcify: { enabled: false },
};
