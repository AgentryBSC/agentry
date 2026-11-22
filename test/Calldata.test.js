const { expect } = require("chai");
const { ethers } = require("hardhat");

const CD = require("../lib/agentry/calldata");
const ABI = require("../lib/agentry/abi");

const MARKET = "0x1111111111111111111111111111111111111111";
const JURY = "0x2222222222222222222222222222222222222222";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const FROM = "0x3333333333333333333333333333333333333333";
const SPEC_HASH = ethers.keccak256(ethers.toUtf8Bytes("spec"));

const marketIface = new ethers.Interface(ABI.market);
const juryIface = new ethers.Interface(ABI.jury);
const erc20Iface = new ethers.Interface(ABI.erc20);

/// 把 calldata 解回来，确认编码的确实是我们想要的东西
function decode(iface, data) {
  return iface.parseTransaction({ data });
}

describe("交易构造器", function () {
  /* ================================================================== */
  describe("原生币与 ERC-20 的差别被吸收掉了", function () {
    it("BNB 计价是一步，value 带上金额", function () {
      const p = CD.buildPublishTask({
        market: MARKET,
        specURI: "ipfs://spec",
        specHash: SPEC_HASH,
        inputURI: "ipfs://input",
        currency: CD.NATIVE,
        amount: ethers.parseEther("0.1"),
        deliveryDuration: 86400,
      });

      expect(p.steps).to.have.length(1);
      expect(p.steps[0].value).to.equal(ethers.parseEther("0.1").toString());
      expect(p.steps[0].to.toLowerCase()).to.equal(MARKET);
    });

    it("USDT 计价是两步，先 approve 再调用，value 必须为 0", function () {
      const p = CD.buildPublishTask({
        market: MARKET,
        specURI: "ipfs://spec",
        specHash: SPEC_HASH,
        inputURI: "ipfs://input",
        currency: USDT,
        amount: ethers.parseUnits("10", 18),
        deliveryDuration: 86400,
      });

      expect(p.steps).to.have.length(2);

      // 第一步打到代币合约
      expect(p.steps[0].to.toLowerCase()).to.equal(USDT.toLowerCase());
      expect(p.steps[0].value).to.equal("0");

      // 第二步打到市场合约，同样不带 BNB
      expect(p.steps[1].to.toLowerCase()).to.equal(MARKET);
      expect(p.steps[1].value).to.equal("0");
    });

    it("approve 的额度精确等于本次金额，不是无限额", function () {
      // 「不得索取无限额授权」是红线。这条测试就是守它的
      const amount = ethers.parseUnits("10", 18);
      const p = CD.buildPublishTask({
        market: MARKET,
        specURI: "ipfs://s",
        specHash: SPEC_HASH,
        inputURI: "ipfs://i",
        currency: USDT,
        amount: amount,
        deliveryDuration: 86400,
      });

      const parsed = decode(erc20Iface, p.steps[0].data);
      expect(parsed.name).to.equal("approve");
      expect(parsed.args[0].toLowerCase()).to.equal(MARKET);
      expect(parsed.args[1]).to.equal(amount);
      expect(parsed.args[1]).to.not.equal(ethers.MaxUint256);
    });

    it("下单同样按币种分流", function () {
      const bnb = CD.buildCreateOrder({
        market: MARKET, listingId: 7, inputURI: "ipfs://i",
        currency: CD.NATIVE, price: ethers.parseEther("0.05"),
      });
      const usdt = CD.buildCreateOrder({
        market: MARKET, listingId: 7, inputURI: "ipfs://i",
        currency: USDT, price: ethers.parseUnits("10", 18),
      });

      expect(bnb.steps).to.have.length(1);
      expect(usdt.steps).to.have.length(2);
    });
  });

  /* ================================================================== */
  describe("编码正确性", function () {
    it("publishTask 的参数原样进了 calldata", function () {
      const p = CD.buildPublishTask({
        market: MARKET,
        specURI: "ipfs://thespec",
        specHash: SPEC_HASH,
        inputURI: "ipfs://theinput",
        currency: CD.NATIVE,
        amount: ethers.parseEther("0.1"),
        deliveryDuration: 172800,
      });

      const parsed = decode(marketIface, p.steps[0].data);
      expect(parsed.name).to.equal("publishTask");
      expect(parsed.args[0]).to.equal("ipfs://thespec");
      expect(parsed.args[1]).to.equal(SPEC_HASH);
      expect(parsed.args[2]).to.equal("ipfs://theinput");
      expect(parsed.args[3]).to.equal(CD.NATIVE);
      expect(parsed.args[4]).to.equal(ethers.parseEther("0.1"));
      expect(parsed.args[5]).to.equal(172800n);
    });

    it("投票方向编码正确", function () {
      const forProvider = CD.buildVote({
        jury: JURY, disputeId: 3, side: "provider",
        currency: CD.NATIVE, stake: ethers.parseEther("0.02"),
      });
      const forPublisher = CD.buildVote({
        jury: JURY, disputeId: 3, side: "publisher",
        currency: CD.NATIVE, stake: ethers.parseEther("0.02"),
      });

      expect(decode(juryIface, forProvider.steps[0].data).args[1]).to.equal(1n);
      expect(decode(juryIface, forPublisher.steps[0].data).args[1]).to.equal(2n);
    });

    it("投票押金按币种附带", function () {
      const stake = ethers.parseEther("0.02");
      const p = CD.buildVote({
        jury: JURY, disputeId: 1, side: "provider",
        currency: CD.NATIVE, stake: stake,
      });
      expect(p.steps[0].value).to.equal(stake.toString());
    });

    it("简单调用不带 value", function () {
      for (const p of [
        CD.buildClaimTask(MARKET, 1),
        CD.buildAcceptResult(MARKET, 1),
        CD.buildCancelTask(MARKET, 1),
        CD.buildSubmitResult(MARKET, 1, "ipfs://r"),
      ]) {
        expect(p.steps[0].value).to.equal("0");
      }
    });
  });

  /* ================================================================== */
  describe("参数校验", function () {
    it("非法合约地址被拒绝", function () {
      expect(() => CD.buildClaimTask("0xnotanaddress", 1)).to.throw();
    });

    it("specHash 为零被拒绝", function () {
      expect(() =>
        CD.buildPublishTask({
          market: MARKET, specURI: "x", specHash: ethers.ZeroHash, inputURI: "y",
          currency: CD.NATIVE, amount: 1n, deliveryDuration: 86400,
        })
      ).to.throw("specHash");
    });

    it("金额为零被拒绝", function () {
      expect(() =>
        CD.buildPublishTask({
          market: MARKET, specURI: "x", specHash: SPEC_HASH, inputURI: "y",
          currency: CD.NATIVE, amount: 0n, deliveryDuration: 86400,
        })
      ).to.throw("amount");
    });

    it("空交付物被拒绝", function () {
      expect(() => CD.buildSubmitResult(MARKET, 1, "")).to.throw("resultURI");
    });

    it("投票方向写错被拒绝", function () {
      expect(() =>
        CD.buildVote({ jury: JURY, disputeId: 1, side: "maybe", currency: CD.NATIVE, stake: 1n })
      ).to.throw("side");
    });
  });

  /* ================================================================== */
  describe("只能产出数据，不能执行", function () {
    it("构造器不暴露任何签名或广播能力", function () {
      // 这是结构性的红线保障：把执行能力从代码里拿掉，
      // 比在提示词里写一句「记得让用户确认」可靠得多
      const forbidden = ["sign", "send", "broadcast", "execute", "privatekey", "wallet"];
      for (const key of Object.keys(CD)) {
        const lower = key.toLowerCase();
        for (const f of forbidden) {
          expect(lower.includes(f), key + " 不该存在").to.equal(false);
        }
      }
    });

    it("产出的步骤只是纯数据", function () {
      const p = CD.buildClaimTask(MARKET, 1);
      const s = p.steps[0];
      expect(Object.keys(s).sort()).to.deep.equal(["data", "summary", "to", "value"]);
      for (const v of Object.values(s)) {
        expect(typeof v).to.equal("string");
      }
    });
  });

  /* ================================================================== */
  describe("交给 baw 的命令", function () {
    it("产出的是 preview 而不是 execute", function () {
      // execute 必须等用户看过 parsedTx 与 risks 之后才发起。
      // 我们永远只给到 preview 这一步
      const p = CD.buildClaimTask(MARKET, 1);
      const cmds = CD.toBawCommands(p, FROM, 56);

      expect(cmds).to.have.length(1);
      expect(cmds[0].command).to.include("contract-call preview");
      expect(cmds[0].command).to.not.include("execute");
    });

    it("命令里带齐了 baw 要的参数", function () {
      const p = CD.buildPublishTask({
        market: MARKET, specURI: "ipfs://s", specHash: SPEC_HASH, inputURI: "ipfs://i",
        currency: CD.NATIVE, amount: ethers.parseEther("0.1"), deliveryDuration: 86400,
      });
      const cmd = CD.toBawCommands(p, FROM, 56)[0].command;

      expect(cmd).to.include("--binanceChainId 56");
      expect(cmd).to.include("--from " + FROM);
      expect(cmd).to.include("--to " + ethers.getAddress(MARKET));
      expect(cmd).to.include("--json");
    });

    it("value 是十进制整数字符串 —— baw 拒绝带小数的值", function () {
      const p = CD.buildVote({
        jury: JURY, disputeId: 1, side: "provider",
        currency: CD.NATIVE, stake: ethers.parseEther("0.02"),
      });
      const cmd = CD.toBawCommands(p, FROM, 56)[0].command;

      expect(cmd).to.include("--value 20000000000000000");
      expect(cmd).to.not.include("0.02");
    });

    it("两步计划产出两条命令", function () {
      const p = CD.buildCreateOrder({
        market: MARKET, listingId: 1, inputURI: "ipfs://i",
        currency: USDT, price: ethers.parseUnits("10", 18),
      });
      const cmds = CD.toBawCommands(p, FROM, 56);

      expect(cmds).to.have.length(2);
      expect(cmds[0].summary).to.include("授权");
      expect(cmds[1].summary).to.include("下单");
    });
  });

  /* ================================================================== */
  describe("风险提示跟着交易走", function () {
    it("拒收会提醒 5% 的陪审费", function () {
      expect(CD.buildRejectResult(MARKET, 1, "ipfs://r").note).to.include("5%");
    });

    it("投票会提醒押金可能被没收", function () {
      const p = CD.buildVote({
        jury: JURY, disputeId: 1, side: "provider",
        currency: CD.NATIVE, stake: 1n,
      });
      expect(p.note).to.include("没收");
    });

    it("验收会提醒不可撤销", function () {
      expect(CD.buildAcceptResult(MARKET, 1).note).to.include("不可撤销");
    });

    it("ERC-20 路径会说明需要两笔确认", function () {
      const p = CD.buildCreateOrder({
        market: MARKET, listingId: 1, inputURI: "i",
        currency: USDT, price: 100n,
      });
      expect(p.note).to.include("两笔");
    });

    it("免费挂牌会说明不走托管、不审核第三方合约", function () {
      const p = CD.buildCreateFreeListing({
        market: MARKET, target: USDT, specURI: "ipfs://spec", specHash: SPEC_HASH,
      });
      expect(p.note).to.include("不走托管");
      expect(p.note).to.include("不审核");
    });
  });

  /* ================================================================== */
  describe("免费挂牌", function () {
    it("编码的是 createFreeListing，参数原样进了 calldata，不带 value", function () {
      const p = CD.buildCreateFreeListing({
        market: MARKET, target: USDT.toLowerCase(), specURI: "ipfs://spec", specHash: SPEC_HASH,
      });
      expect(p.steps).to.have.length(1);
      expect(p.steps[0].value).to.equal("0");
      expect(p.steps[0].to.toLowerCase()).to.equal(MARKET);
      const tx = decode(marketIface, p.steps[0].data);
      expect(tx.name).to.equal("createFreeListing");
      expect(tx.args[0]).to.equal(USDT);          // 地址被规整成校验和格式
      expect(tx.args[1]).to.equal("ipfs://spec");
      expect(tx.args[2]).to.equal(SPEC_HASH);
    });

    it("target 为零地址被拒绝 —— 合约里会 revert，提前拦下", function () {
      expect(() =>
        CD.buildCreateFreeListing({
          market: MARKET, target: ethers.ZeroAddress, specURI: "x", specHash: SPEC_HASH,
        })
      ).to.throw("target");
    });

    it("target 不是地址被拒绝", function () {
      expect(() =>
        CD.buildCreateFreeListing({ market: MARKET, target: "0xabc", specURI: "x", specHash: SPEC_HASH })
      ).to.throw("target");
    });

    it("specHash 为零或 specURI 为空被拒绝", function () {
      expect(() =>
        CD.buildCreateFreeListing({ market: MARKET, target: USDT, specURI: "x", specHash: ethers.ZeroHash })
      ).to.throw("specHash");
      expect(() =>
        CD.buildCreateFreeListing({ market: MARKET, target: USDT, specURI: "", specHash: SPEC_HASH })
      ).to.throw("specURI");
    });
  });
});

describe("评价交易", function () {
  const iface = new ethers.Interface(ABI.market);
  it("buildReview 编码 review(taskId, rating, uri)，附上不可修改的提醒", function () {
    const p = CD.buildReview(MARKET, 7, 4, "data:application/json;base64,e30=");
    expect(p.steps).to.have.length(1);
    expect(p.note).to.include("不能修改");
    const d = iface.decodeFunctionData("review", p.steps[0].data);
    expect(d[0]).to.equal(7n);
    expect(d[1]).to.equal(4n);
    expect(d[2]).to.equal("data:application/json;base64,e30=");
  });
  it("星级不在 1 到 5、正文为空都直接拒绝", function () {
    expect(() => CD.buildReview(MARKET, 1, 0, "x")).to.throw("1 到 5");
    expect(() => CD.buildReview(MARKET, 1, 6, "x")).to.throw("1 到 5");
    expect(() => CD.buildReview(MARKET, 1, 2.5, "x")).to.throw("1 到 5");
    expect(() => CD.buildReview(MARKET, 1, 5, "")).to.throw("不能为空");
  });
  it("buildReply 编码 reply(taskId, uri)", function () {
    const p = CD.buildReply(MARKET, 3, "data:application/json;base64,e30=");
    const d = iface.decodeFunctionData("reply", p.steps[0].data);
    expect(d[0]).to.equal(3n);
    expect(() => CD.buildReply(MARKET, 3, "")).to.throw("不能为空");
  });
});
