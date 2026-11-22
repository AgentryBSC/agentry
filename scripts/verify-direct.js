/* 直接调 Etherscan V2 接口提交验证并轮询结果，打印具体失败原因。
   用法：npx hardhat run scripts/verify-direct.js --network bsc   （ONLY=金库,水龙头 可筛选） */
const fs = require("fs"), path = require("path"), hre = require("hardhat");
const { ethers } = hre;
const ROOT = path.join(__dirname, "..");
const KEY = process.env.BSCSCAN_API_KEY;
const API = "https://api.etherscan.io/v2/api?chainid=56";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function buildInfoFor(fqn) {
  const [src, name] = fqn.split(":");
  const bi = await hre.artifacts.getBuildInfo(fqn);
  return { input: bi.input, version: "v" + bi.solcLongVersion, src, name };
}
async function isVerified(a) {
  const r = await (await fetch(`${API}&module=contract&action=getsourcecode&address=${a}&apikey=${KEY}`)).json();
  return !!(r.result && r.result[0] && r.result[0].ContractName);
}

async function main() {
  const rec = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments/56.json"), "utf8"));
  const c = rec.contracts, owner = rec.deployer;
  const coder = ethers.AbiCoder.defaultAbiCoder();
  let jobs = [
    ["升级时间锁", c.Timelock.address, coder.encode(["uint256", "address[]", "address[]", "address"], [c.Timelock.delay, [owner], [owner], ethers.ZeroAddress]), "@openzeppelin/contracts/governance/TimelockController.sol:TimelockController"],
  ];
  const enc = async (fqn, args) => (await ethers.getContractFactory(fqn)).interface.encodeDeploy(args).slice(2);
  if (c.AgentryServiceVault) jobs.push(["金库", c.AgentryServiceVault.address, "0x" + await enc("contracts/vault/AgentryServiceVault.sol:AgentryServiceVault", c.AgentryServiceVault.constructorArgs), "contracts/vault/AgentryServiceVault.sol:AgentryServiceVault"]);
  if (c.AgentryFaucet) jobs.push(["水龙头", c.AgentryFaucet.address, "0x" + await enc("contracts/faucet/AgentryFaucet.sol:AgentryFaucet", c.AgentryFaucet.constructorArgs), "contracts/faucet/AgentryFaucet.sol:AgentryFaucet"]);
  if (process.env.ONLY) jobs = jobs.filter((j) => process.env.ONLY.split(",").includes(j[0]));

  const pending = [];
  for (const [n, addr, args, fqn] of jobs) {
    if (await isVerified(addr)) { console.log(n, "已验证过"); continue; }
    const { input, version, src, name } = await buildInfoFor(fqn);
    const body = new URLSearchParams({
      module: "contract", action: "verifysourcecode", apikey: KEY, contractaddress: addr,
      sourceCode: JSON.stringify(input), codeformat: "solidity-standard-json-input",
      contractname: src + ":" + name, compilerversion: version, constructorArguements: args.slice(2),
    });
    const r = await (await fetch(API, { method: "POST", body })).json();
    console.log(n, "提交:", r.status === "1" ? "ok guid " + r.result : "失败 " + r.result);
    if (r.status === "1") pending.push([n, r.result]);
    await sleep(1500);
  }
  // 免费 Key 限速 3 次/秒：串行轮询，每次请求间隔 1 秒，遇到限速就重试
  for (let t = 0; t < 90 && pending.length; t++) {
    await sleep(4000);
    for (let i = pending.length - 1; i >= 0; i--) {
      const [n, guid] = pending[i];
      await sleep(1000);
      const r = await (await fetch(`${API}&module=contract&action=checkverifystatus&guid=${guid}&apikey=${KEY}`)).json();
      if (t % 6 === 0) console.log("  ", n, r.result);
      if (/pending|rate limit/i.test(r.result)) continue;
      console.log(n, r.status === "1" ? "✓ " + r.result : "✗ " + r.result);
      pending.splice(i, 1);
    }
  }
  for (const [n] of pending) console.log(n, "仍在排队");
}
main().catch((e) => { console.error("✗", e.message); process.exitCode = 1; });
