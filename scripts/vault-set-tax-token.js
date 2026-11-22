/* 部署钱包对金库执行一次性的 setTaxToken（私钥只在内部解析，不打印）
   用法：node scripts/vault-set-tax-token.js --key-file <私钥文件> --token <地址> [--yes] */
const fs = require("fs");
const { ethers } = require("ethers");
const VAULT = "0xB5A6a3265139DC7E2B78e594A73BFF5066DC5D55";
const provider = new ethers.JsonRpcProvider("https://bsc-rpc.publicnode.com", 56);
const a = process.argv.slice(2), arg = (k) => { const i = a.indexOf("--" + k); return i < 0 ? undefined : a[i + 1]; };
const die = (m) => { console.error("✗ " + m); process.exit(1); };
(async () => {
  const token = ethers.getAddress(arg("token") || die("需要 --token"));
  let raw; try { raw = fs.readFileSync(arg("key-file"), "utf8"); } catch { die("读不到私钥文件"); }
  const keys = [...new Set((raw.match(/(?:0x)?[0-9a-fA-F]{64}\b/g) || []).map((k) => k.replace(/^0x/, "").toLowerCase()))];
  if (keys.length !== 1) die("私钥文件里应恰好有一个私钥");
  const w = new ethers.Wallet("0x" + keys[0], provider);
  const v = new ethers.Contract(VAULT, ["function taxToken() view returns(address)", "function setTaxToken(address)", "function hasRole(bytes32,address) view returns(bool)"], w);
  const t = new ethers.Contract(token, ["function name() view returns(string)", "function decimals() view returns(uint8)"], provider);
  console.log("签名钱包 " + w.address + "\n金库     " + VAULT + "\n代币     " + token + "（" + await t.name() + "，" + await t.decimals() + " 位）");
  if (!(await v.hasRole(ethers.id("OPERATOR_ROLE"), w.address))) die("签名钱包没有 OPERATOR_ROLE");
  const cur = await v.taxToken();
  if (cur !== ethers.ZeroAddress) { console.log(cur.toLowerCase() === token.toLowerCase() ? "已经设置过，就是这个代币" : "✗ 已设置为其他代币 " + cur); return; }
  const est = await v.setTaxToken.estimateGas(token);
  if (!a.includes("--yes")) { console.log("预估 gas " + est + "，加 --yes 发送"); return; }
  const tx = await v.setTaxToken(token, { gasLimit: (est * 13n) / 10n });
  console.log("交易     " + tx.hash);
  const rc = await tx.wait();
  console.log("状态     " + (rc.status === 1 ? "成功" : "失败") + "，区块 " + rc.blockNumber);
  console.log("核对     taxToken = " + await v.taxToken());
})().catch((e) => die(e.shortMessage || e.message));
