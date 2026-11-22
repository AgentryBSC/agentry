const { expect } = require("chai");

const AID = require("../lib/agentry/agentid");
const ABI = require("../lib/agentry/abi");

const ME = "0x7c70c1CF10D420c8A4a9eF3488617E766b24bDB3";
const NOBODY = "0x000000000000000000000000000000000000dEaD";
const ZERO = "0x0000000000000000000000000000000000000000";

/// 假的 Agent ID 合约：只有 anndy 一个名字，记下每次调用
function fakeNft({ fail = false } = {}) {
  const calls = { handleOf: 0, ownerOfHandle: [] };
  return {
    calls,
    async handleOf(addr) {
      calls.handleOf++;
      if (fail) throw new Error("rpc down");
      return addr.toLowerCase() === ME.toLowerCase() ? "anndy" : "";
    },
    async ownerOfHandle(h) {
      calls.ownerOfHandle.push(h);
      return h === "anndy" ? ME : ZERO;
    },
  };
}

describe("Agent ID 名字解析", function () {
  it("ABI 带上了 handleOf 与 ownerOfHandle", function () {
    const sigs = ABI.agentId.join("\n");
    expect(sigs).to.include("function handleOf(address owner) view returns (string)");
    expect(sigs).to.include("function ownerOfHandle(string handle) view returns (address)");
  });

  it("链上 handle 补成 .ai 名字，空串视为没有", function () {
    expect(AID.toName("anndy")).to.equal("anndy.ai");
    expect(AID.toName("Anndy ")).to.equal("anndy.ai");
    expect(AID.toName("")).to.equal(null);
  });

  it("用户输入的名字去掉后缀、转小写", function () {
    expect(AID.toHandle("Anndy.AI")).to.equal("anndy");
    expect(AID.toHandle("anndy")).to.equal("anndy");
  });

  it("区分地址和名字", function () {
    expect(AID.isAddress(ME)).to.equal(true);
    expect(AID.looksLikeName(ME)).to.equal(false);
    expect(AID.looksLikeName("anndy.ai")).to.equal(true);
    expect(AID.looksLikeName("0x1234")).to.equal(false);
  });

  it("展示时名字在前、地址在括号里；没名字只给地址", function () {
    expect(AID.label(ME, "anndy.ai")).to.equal("anndy.ai（" + ME + "）");
    expect(AID.label(NOBODY, null)).to.equal(NOBODY);
  });

  it("地址 → 名字，同一地址只查一次", async function () {
    const nft = fakeNft();
    const r = AID.createResolver(nft);
    const got = await r.namesOf([ME, ME.toLowerCase(), NOBODY]);
    expect(got).to.deep.equal(["anndy.ai", "anndy.ai", null]);
    expect(nft.calls.handleOf).to.equal(2);
  });

  it("零地址和非法地址不发请求，直接返回 null", async function () {
    const nft = fakeNft();
    const r = AID.createResolver(nft);
    expect(await r.nameOf(ZERO)).to.equal(null);
    expect(await r.nameOf("not-an-address")).to.equal(null);
    expect(nft.calls.handleOf).to.equal(0);
  });

  it("查询失败返回 null，且不缓存失败结果", async function () {
    const nft = fakeNft({ fail: true });
    const r = AID.createResolver(nft);
    expect(await r.nameOf(ME)).to.equal(null);
    expect(await r.nameOf(ME)).to.equal(null);
    expect(nft.calls.handleOf).to.equal(2);
  });

  it("名字 → 地址；没人注册返回 null", async function () {
    const nft = fakeNft();
    const r = AID.createResolver(nft);
    expect(await r.addressOf("Anndy.ai")).to.equal(ME);
    expect(await r.addressOf("nobody.ai")).to.equal(null);
    expect(nft.calls.ownerOfHandle).to.deep.equal(["anndy", "nobody"]);
  });
});
