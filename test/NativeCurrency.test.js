const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const {
  USDT, BNB, NATIVE, PARAMS,
  SPEC_URI, SPEC_HASH, INPUT_URI, RESULT_URI, REASON_URI,
  State, Verdict, Side, pay,
  deployAgentry, publishTask, taskAwaitingReview, taskInDispute, castVote, createListing,
} = require("./fixtures");

describe("原生 BNB 计价", function () {
  describe("托管与收付", function () {
    it("发布 BNB 任务会把 BNB 锁进合约", async function () {
      const { market, marketAddr, publisher } = await loadFixture(deployAgentry);

      const taskId = await publishTask(market, publisher, BNB("0.1"), NATIVE);

      expect(await ethers.provider.getBalance(marketAddr)).to.equal(BNB("0.1"));

      const t = await market.getTask(taskId);
      expect(t.currency).to.equal(NATIVE);
      expect(t.amount).to.equal(BNB("0.1"));
      expect(t.state).to.equal(State.Open);
    });

    it("验收后 BNB 到账服务方", async function () {
      const { market, marketAddr, publisher, provider } = await loadFixture(deployAgentry);
      const taskId = await taskAwaitingReview(market, publisher, provider, BNB("0.1"), NATIVE);

      const before = await ethers.provider.getBalance(provider.address);
      await market.connect(publisher).acceptResult(taskId);

      expect((await ethers.provider.getBalance(provider.address)) - before).to.equal(BNB("0.1"));
      expect(await ethers.provider.getBalance(marketAddr)).to.equal(0n);
    });

    it("超时退款退的是 BNB", async function () {
      const { market, publisher, provider, outsider } = await loadFixture(deployAgentry);
      const taskId = await publishTask(market, publisher, BNB("0.1"), NATIVE);
      await market.connect(provider).claimTask(taskId);

      await time.increase(PARAMS.minDelivery + 1);

      const before = await ethers.provider.getBalance(publisher.address);
      await market.connect(outsider).settleDeliveryTimeout(taskId);

      expect((await ethers.provider.getBalance(publisher.address)) - before).to.equal(BNB("0.1"));
    });

    it("从 BNB 挂牌下单", async function () {
      const { market, marketAddr, publisher, provider } = await loadFixture(deployAgentry);
      const listingId = await createListing(market, provider, BNB("0.05"), NATIVE);

      await market.connect(publisher).createOrder(listingId, INPUT_URI, { value: BNB("0.05") });
      const taskId = await market.taskCount();

      expect(await ethers.provider.getBalance(marketAddr)).to.equal(BNB("0.05"));

      const t = await market.getTask(taskId);
      expect(t.currency).to.equal(NATIVE);
      expect(t.state).to.equal(State.Assigned);
    });
  });

  describe("msg.value 校验", function () {
    it("BNB 任务附带金额不符会被拒绝", async function () {
      const { market, publisher } = await loadFixture(deployAgentry);

      await expect(
        market
          .connect(publisher)
          .publishTask(SPEC_URI, SPEC_HASH, INPUT_URI, NATIVE, BNB("0.1"), PARAMS.minDelivery, {
            value: BNB("0.09"),
          })
      ).to.be.revertedWithCustomError(market, "WrongMsgValue");
    });

    it("BNB 任务不附带 BNB 会被拒绝", async function () {
      const { market, publisher } = await loadFixture(deployAgentry);

      await expect(
        market
          .connect(publisher)
          .publishTask(SPEC_URI, SPEC_HASH, INPUT_URI, NATIVE, BNB("0.1"), PARAMS.minDelivery)
      ).to.be.revertedWithCustomError(market, "WrongMsgValue");
    });

    it("ERC-20 任务附带 BNB 会被拒绝", async function () {
      // 否则这笔 BNB 会悄无声息地留在合约里，无人认领
      const { market, publisher, usdtAddr } = await loadFixture(deployAgentry);

      await expect(
        market
          .connect(publisher)
          .publishTask(SPEC_URI, SPEC_HASH, INPUT_URI, usdtAddr, USDT("10"), PARAMS.minDelivery, {
            value: BNB("0.01"),
          })
      ).to.be.revertedWithCustomError(market, "WrongMsgValue");
    });

    it("不支持的币种被拒绝", async function () {
      const { market, publisher, j1 } = await loadFixture(deployAgentry);

      await expect(
        market
          .connect(publisher)
          .publishTask(SPEC_URI, SPEC_HASH, INPUT_URI, j1.address, USDT("10"), PARAMS.minDelivery)
      ).to.be.revertedWithCustomError(market, "UnsupportedCurrency");
    });

    it("两种币的金额上限各自独立", async function () {
      const { market, publisher, usdtAddr } = await loadFixture(deployAgentry);

      expect(await market.maxTaskAmount(NATIVE)).to.equal(PARAMS.maxNative);
      expect(await market.maxTaskAmount(usdtAddr)).to.equal(PARAMS.maxToken);

      // 1.5 BNB 超过了 BNB 的上限，尽管它远低于稳定币那条 50 的线
      await expect(
        market
          .connect(publisher)
          .publishTask(SPEC_URI, SPEC_HASH, INPUT_URI, NATIVE, BNB("1.5"), PARAMS.minDelivery, {
            value: BNB("1.5"),
          })
      ).to.be.revertedWithCustomError(market, "AmountTooLarge");
    });
  });

  describe("BNB 争议", function () {
    it("押金与陪审费都用 BNB，账目守恒", async function () {
      const { market, jury, juryAddr, publisher, provider, j1, j2, j3, outsider } =
        await loadFixture(deployAgentry);
      const { disputeId } = await taskInDispute(
        market, jury, publisher, provider, BNB("0.1"), NATIVE
      );

      const d = await jury.getDispute(disputeId);
      expect(d.currency).to.equal(NATIVE);
      expect(d.stake).to.equal(PARAMS.stakeNative);

      // 2:1 支持服务方，刚好满足法定票数 3
      await castVote(jury, j1, disputeId, Side.Provider);
      await castVote(jury, j2, disputeId, Side.Provider);
      await castVote(jury, j3, disputeId, Side.Publisher);

      // 三份押金都是 BNB
      expect(await ethers.provider.getBalance(juryAddr)).to.equal(BNB("0.06"));

      await time.increase(PARAMS.votingWindow + 1);

      const provBefore = await ethers.provider.getBalance(provider.address);
      await jury.connect(outsider).settle(disputeId);

      // 0.1 的 95% 给服务方
      expect((await ethers.provider.getBalance(provider.address)) - provBefore).to.equal(
        BNB("0.095")
      );

      // 陪审合约持有：3 份押金 0.06 + 陪审费 0.005 = 0.065
      expect(await ethers.provider.getBalance(juryAddr)).to.equal(BNB("0.065"));

      // 奖励池 = 陪审费 0.005 + 少数方押金 0.02 = 0.025，两名多数方平分
      const settled = await jury.getDispute(disputeId);
      expect(settled.verdict).to.equal(Verdict.ForProvider);
      expect(settled.rewardPool).to.equal(BNB("0.025"));

      for (const j of [j1, j2]) {
        const before = await ethers.provider.getBalance(j.address);
        // 由第三方代为触发，避免 gas 干扰余额断言
        await jury.connect(outsider).claimJurorPayout(disputeId, j.address);
        expect((await ethers.provider.getBalance(j.address)) - before).to.equal(BNB("0.0325"));
      }

      await jury.connect(outsider).claimJurorPayout(disputeId, j3.address);

      // 全部领完，一 wei 不剩
      expect(await ethers.provider.getBalance(juryAddr)).to.equal(0n);
    });

    it("未形成多数时 BNB 对半分", async function () {
      const { market, jury, publisher, provider, outsider } = await loadFixture(deployAgentry);
      const { taskId, disputeId } = await taskInDispute(
        market, jury, publisher, provider, BNB("0.1"), NATIVE
      );

      await time.increase(PARAMS.votingWindow + 1);

      const pubBefore = await ethers.provider.getBalance(publisher.address);
      const provBefore = await ethers.provider.getBalance(provider.address);
      await jury.connect(outsider).settle(disputeId);

      expect((await ethers.provider.getBalance(publisher.address)) - pubBefore).to.equal(
        BNB("0.05")
      );
      expect((await ethers.provider.getBalance(provider.address)) - provBefore).to.equal(
        BNB("0.05")
      );
      expect((await market.getTask(taskId)).state).to.equal(State.Split);
    });

    it("投票附带的押金金额不符会被拒绝", async function () {
      const { market, jury, publisher, provider, j1 } = await loadFixture(deployAgentry);
      const { disputeId } = await taskInDispute(
        market, jury, publisher, provider, BNB("0.1"), NATIVE
      );

      await expect(
        jury.connect(j1).vote(disputeId, Side.Provider, { value: BNB("0.01") })
      ).to.be.revertedWithCustomError(jury, "WrongMsgValue");
    });

    it("陪审合约拒收来历不明的 BNB", async function () {
      const { jury, juryAddr, outsider } = await loadFixture(deployAgentry);

      await expect(
        outsider.sendTransaction({ to: juryAddr, value: BNB("1") })
      ).to.be.revertedWithCustomError(jury, "OnlyMarket");
    });
  });

  describe("收款方收不了 BNB 时", function () {
    it("结算不卡死，款项记入待领取", async function () {
      // 这是原生币独有的风险：收款方若是不接收 BNB 的合约，
      // 转账 revert 会让整笔结算回滚，资金永久锁死。
      // _push 对原生币改为失败即记账，保证结算总能走完
      const { market, marketAddr, agentId, publisher } = await loadFixture(deployAgentry);

      const rejector = await (await ethers.getContractFactory("MockRejectingAgent")).deploy();
      const rejectorAddr = await rejector.getAddress();
      await agentId.mint(rejectorAddr);

      const taskId = await publishTask(market, publisher, BNB("0.1"), NATIVE);

      // 合约钱包认领并交付
      const claimData = market.interface.encodeFunctionData("claimTask", [taskId]);
      await rejector.exec(marketAddr, claimData);
      const submitData = market.interface.encodeFunctionData("submitResult", [
        taskId,
        RESULT_URI,
      ]);
      await rejector.exec(marketAddr, submitData);

      // 验收不会 revert
      await market.connect(publisher).acceptResult(taskId);

      // 任务正常走到终态
      expect((await market.getTask(taskId)).state).to.equal(State.Completed);
      // 钱没丢，记在它名下等它来领
      expect(await market.pendingOf(rejectorAddr, NATIVE)).to.equal(BNB("0.1"));
      expect(await ethers.provider.getBalance(marketAddr)).to.equal(BNB("0.1"));
    });

    it("收款方返回超大数据也耗不光结算的 gas", async function () {
      const { market, marketAddr, agentId, publisher } = await loadFixture(deployAgentry);
      const bomb = await (await ethers.getContractFactory("MockReturnBomb")).deploy();
      const bombAddr = await bomb.getAddress();
      await agentId.mint(bombAddr);

      const taskId = await publishTask(market, publisher, BNB("0.1"), NATIVE);
      await bomb.exec(marketAddr, market.interface.encodeFunctionData("claimTask", [taskId]));
      await bomb.exec(marketAddr, market.interface.encodeFunctionData("submitResult", [taskId, RESULT_URI]));

      await market.connect(publisher).acceptResult(taskId, { gasLimit: 400000 });
      expect((await market.getTask(taskId)).state).to.equal(State.Completed);
      expect(await market.pendingOf(bombAddr, NATIVE)).to.equal(BNB("0.1"));
    });

    it("待领取款项只能发给本人", async function () {
      const { market, marketAddr, agentId, publisher, outsider } =
        await loadFixture(deployAgentry);

      const rejector = await (await ethers.getContractFactory("MockRejectingAgent")).deploy();
      const rejectorAddr = await rejector.getAddress();
      await agentId.mint(rejectorAddr);

      const taskId = await publishTask(market, publisher, BNB("0.1"), NATIVE);
      await rejector.exec(marketAddr, market.interface.encodeFunctionData("claimTask", [taskId]));
      await rejector.exec(
        marketAddr,
        market.interface.encodeFunctionData("submitResult", [taskId, RESULT_URI])
      );
      await market.connect(publisher).acceptResult(taskId);

      // 任何人都可以代触发，但钱只会发给 rejector 本人；
      // 而 rejector 收不了 BNB，所以这里仍会失败——款项继续留着等它
      await expect(
        market.connect(outsider).claimPending(rejectorAddr, NATIVE)
      ).to.be.revertedWithCustomError(market, "NativeTransferFailed");

      expect(await market.pendingOf(rejectorAddr, NATIVE)).to.equal(BNB("0.1"));
    });

    it("没有待领取款项时领取会被拒绝", async function () {
      const { market, outsider } = await loadFixture(deployAgentry);

      await expect(
        market.connect(outsider).claimPending(outsider.address, NATIVE)
      ).to.be.revertedWithCustomError(market, "NothingPending");
    });
  });

  describe("两种币共用一本账", function () {
    it("BNB 与稳定币的成交记在同一个信誉计数上", async function () {
      const { market, publisher, provider, usdtAddr } = await loadFixture(deployAgentry);

      const bnbTask = await taskAwaitingReview(market, publisher, provider, BNB("0.1"), NATIVE);
      await market.connect(publisher).acceptResult(bnbTask);

      const usdtTask = await taskAwaitingReview(
        market, publisher, provider, USDT("10"), usdtAddr
      );
      await market.connect(publisher).acceptResult(usdtTask);

      // 分开部署两套实例就会变成两本账，信誉被劈开——这正是不那么做的原因
      expect((await market.reputationOf(provider.address)).completed).to.equal(2n);
      expect((await market.reputationOf(publisher.address)).published).to.equal(2n);
    });

    it("同一批陪审员裁决两种币的争议，信誉累加", async function () {
      const { market, jury, publisher, provider, j1, j2, j3, outsider, usdtAddr } =
        await loadFixture(deployAgentry);

      for (const currency of [NATIVE, usdtAddr]) {
        const amount = currency === NATIVE ? BNB("0.1") : USDT("10");
        const { disputeId } = await taskInDispute(
          market, jury, publisher, provider, amount, currency
        );

        await castVote(jury, j1, disputeId, Side.Provider);
        await castVote(jury, j2, disputeId, Side.Provider);
        await castVote(jury, j3, disputeId, Side.Provider);

        await time.increase(PARAMS.votingWindow + 1);
        await jury.connect(outsider).settle(disputeId);
        await jury.connect(outsider).claimJurorPayout(disputeId, j1.address);
      }

      expect((await jury.jurorRecordOf(j1.address)).majority).to.equal(2n);
    });
  });
});
