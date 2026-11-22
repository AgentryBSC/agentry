/* 金库收提检查：先读主网真实状态，再在主网分叉上模拟收 BNB 和提取（不发真实交易）
   用法：npx hardhat run scripts/vault-check.js */
const { ethers, network } = require("hardhat");
const RPC = "https://bsc-rpc.publicnode.com";
const VAULT = "0xB5A6a3265139DC7E2B78e594A73BFF5066DC5D55";
const DEPLOYER = "0xdd72179Da386CA618f1DE9eA74C857D68b511A2A";
const GUARDIAN = "0x9e27098dcD8844bcc6287a557E0b4D09C86B8a4b";
const STRANGER = "0x7c70c1CF10D420c8A4a9eF3488617E766b24bDB3"; // anndy.ai，非管理员
const ABI = [
  "function OPERATOR_ROLE() view returns (bytes32)", "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  "function hasRole(bytes32,address) view returns (bool)", "function accountedQuote() view returns (uint256)",
  "function totalReceived() view returns (uint256)", "function totalWithdrawn() view returns (uint256)",
  "function taxToken() view returns (address)", "function vaultQuoteToken() view returns (address)",
  "function withdraw(address,uint256)", "function withdrawAll(address)", "function revokeRole(bytes32,address)",
];
const f = (v) => ethers.formatEther(v) + " BNB";
const ok = (b, s) => console.log((b ? "  ✓ " : "  ✗ ") + s);
async function as(addr) {
  await network.provider.send("hardhat_impersonateAccount", [addr]);
  await network.provider.send("hardhat_setBalance", [addr, "0x" + (10n ** 19n).toString(16)]);
  return ethers.getSigner(addr);
}
async function reverts(p) { try { await (await p).wait(); return false; } catch { return true; } }

async function main() {
  await network.provider.send("hardhat_reset", [{ forking: { jsonRpcUrl: RPC } }]);
  await network.provider.send("evm_mine", []); // 先出一个本地块，之后的查询都在本地块上执行
  const v = new ethers.Contract(VAULT, ABI, ethers.provider);
  const OP = await v.OPERATOR_ROLE(), ADM = await v.DEFAULT_ADMIN_ROLE();
  console.log("\n一、主网当前状态");
  ok((await ethers.provider.getCode(VAULT)).length > 2, "金库合约已部署");
  console.log("     余额 " + f(await ethers.provider.getBalance(VAULT)) + "，已记账 " + f(await v.accountedQuote()) + "，累计收入 " + f(await v.totalReceived()));
  console.log("     计价币 " + await v.vaultQuoteToken() + "（0 地址 = BNB），税收代币 " + await v.taxToken());
  ok(await v.hasRole(ADM, DEPLOYER), "部署钱包是管理员");
  ok(await v.hasRole(OP, DEPLOYER), "部署钱包有提取权（OPERATOR）");
  ok(await v.hasRole(OP, GUARDIAN), "FLAP Guardian 有提取权（规范要求）");
  ok(!(await v.hasRole(OP, STRANGER)), "其他地址没有提取权");

  console.log("\n二、分叉模拟：接收 BNB");
  const payer = await as("0x000000000000000000000000000000000000bEEF"); // 普通地址模拟付款方
  const before = await v.totalReceived();
  const tx = await payer.sendTransaction({ to: VAULT, value: ethers.parseEther("0.5"), gasLimit: 300000 });
  const rc = await tx.wait();
  ok((await v.totalReceived()) - before === ethers.parseEther("0.5"), "转入 0.5 BNB 成功入账（gas " + rc.gasUsed + "）");
  const r2 = await (await payer.sendTransaction({ to: VAULT, value: 0, gasLimit: 300000 })).wait();
  ok(r2.status === 1, "0 值唤醒（FLAP ping）静默成功");

  console.log("\n三、分叉模拟：提取");
  ok(await reverts(v.connect(payer).withdraw(payer.address, 1n)), "非管理员提取被拒绝");
  ok(await reverts(v.connect(await as(DEPLOYER)).revokeRole(OP, GUARDIAN)), "无法撤销 Guardian 权限（规范要求）");
  const dep = await as(DEPLOYER);
  const b0 = await ethers.provider.getBalance(DEPLOYER);
  const r3 = await (await v.connect(dep).withdraw(DEPLOYER, ethers.parseEther("0.2"))).wait();
  const b1 = await ethers.provider.getBalance(DEPLOYER);
  ok(b1 - b0 + r3.gasUsed * r3.gasPrice === ethers.parseEther("0.2"), "部署钱包 withdraw 0.2 BNB 到账");
  const left = await v.accountedQuote();
  await (await v.connect(dep).withdrawAll(DEPLOYER)).wait();
  ok((await ethers.provider.getBalance(VAULT)) === 0n, "withdrawAll 提走剩余 " + f(left) + "，金库清零");
  await (await payer.sendTransaction({ to: VAULT, value: ethers.parseEther("0.1"), gasLimit: 300000 })).wait();
  ok((await v.accountedQuote()) === ethers.parseEther("0.1"), "提空后再收 0.1 BNB 仍正常入账");
  console.log("\n（以上第二、三部分在本地分叉上执行，没有发出任何真实交易）\n");
}
main().catch((e) => { console.error("✗", e.message); process.exitCode = 1; });
