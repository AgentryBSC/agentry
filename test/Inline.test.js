const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const Inline = require("../lib/agentry/inline");
const Spec = require("../lib/spec");
const CD = require("../lib/agentry/calldata");
const { deployAgentry, USDT, PARAMS } = require("./fixtures");

/// 一份中等体量的真实规格：中文、嵌套 schema、多条验收标准
function spec() {
  return {
    version: 1,
    capability: "contract.audit.owner-privileges",
    title: "BSC 合约 owner 权限审查",
    summary: "列出目标合约全部特权函数并评级风险，标出能动用户资金的那几条",
    input: {
      type: "object",
      required: ["address", "chainId"],
      properties: {
        address: { type: "string", format: "address" },
        chainId: { type: "integer", enum: [56] },
      },
    },
    output: {
      type: "object",
      required: ["privilegedFunctions", "riskLevel"],
      properties: {
        privilegedFunctions: { type: "array", minItems: 1, items: { type: "object" } },
        riskLevel: { type: "string", enum: ["low", "medium", "high"] },
      },
    },
    acceptanceCriteria: [
      "列出所有带访问控制修饰符的函数",
      "每个函数标注能否影响用户资产",
      "给出整体风险等级与理由",
    ],
  };
}

const h = (d) => Spec.hash(d, ethers.keccak256, ethers.toUtf8Bytes);

describe("规格直接写进链上（data: URI）", function () {
  it("编码再解码，内容和 specHash 都不变", function () {
    const doc = spec();
    const enc = Inline.encode(doc, Spec.canonicalize);
    expect(enc.uri.startsWith(Inline.PREFIX)).to.equal(true);
    expect(enc.fits).to.equal(true);
    const back = Inline.decode(enc.uri);
    expect(back).to.deep.equal(doc);
    expect(h(back)).to.equal(h(doc));
  });

  it("编码的是规范化 JSON：字段顺序不同，URI 也相同", function () {
    const a = spec();
    const b = Object.fromEntries(Object.entries(spec()).reverse());
    expect(Inline.encode(a, Spec.canonicalize).uri).to.equal(Inline.encode(b, Spec.canonicalize).uri);
  });

  it("也能解不带 base64 的 data URI", function () {
    const uri = "data:application/json," + encodeURIComponent(JSON.stringify({ a: "中文" }));
    expect(Inline.decode(uri)).to.deep.equal({ a: "中文" });
  });

  it("普通 URI 和坏数据返回 null", function () {
    expect(Inline.isInline("ipfs://bafk")).to.equal(false);
    expect(Inline.decode("ipfs://bafk")).to.equal(null);
    expect(Inline.decode(Inline.PREFIX + "!!!not-json")).to.equal(null);
  });

  it("超过上限时 fits 为假", function () {
    const big = spec();
    big.summary = "长".repeat(5000);
    const enc = Inline.encode(big, Spec.canonicalize);
    expect(enc.size).to.be.greaterThan(Inline.INLINE_MAX);
    expect(enc.fits).to.equal(false);
  });

  it("上限以内的规格，生成的 baw preview 命令不超过 Windows 命令行上限", function () {
    // 用刚好贴着上限的规格，看最坏情况
    const doc = spec();
    let enc = Inline.encode(doc, Spec.canonicalize);
    while (enc.size < Inline.INLINE_MAX - 200) {
      doc.acceptanceCriteria.push("补充一条验收标准，用来把体积撑到接近上限");
      if (doc.acceptanceCriteria.length > 60) doc.acceptanceCriteria = doc.acceptanceCriteria.slice(0, 3);
      doc.summary += "长";
      enc = Inline.encode(doc, Spec.canonicalize);
    }
    const plan = CD.buildCreateListing({
      market: "0x1111111111111111111111111111111111111111",
      price: 1n, currency: ethers.ZeroAddress, deliveryDuration: 86400,
      specURI: enc.uri, specHash: h(doc),
    });
    const [cmd] = CD.toBawCommands(plan, "0x3333333333333333333333333333333333333333", 56);
    expect(cmd.command.length).to.be.lessThan(32767);
  });

  it("合约原样存下 data URI，读回来复算哈希一致", async function () {
    const { market, provider } = await loadFixture(deployAgentry);
    const doc = spec();
    const enc = Inline.encode(doc, Spec.canonicalize);
    await market.connect(provider).createListing(
      USDT("10"), await market.paymentToken(), PARAMS.minDelivery, enc.uri, h(doc));
    const id = await market.listingCount();
    const l = await market.getListing(id);
    expect(l.specURI).to.equal(enc.uri);
    expect(h(Inline.decode(l.specURI))).to.equal(l.specHash);
  });
});
