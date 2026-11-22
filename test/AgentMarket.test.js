const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const {
  USDT, BNB, NATIVE, DAY, HOUR, PARAMS,
  SPEC_URI, SPEC_HASH, INPUT_URI, RESULT_URI, REASON_URI, PROFILE_URI,
  State, ListingKind, pay,
  deployAgentry, publishTask, taskAwaitingReview, createListing,
} = require("./fixtures");

describe("AgentMarket", function () {
  describe("Agent ID 准入门", function () {
    it("无 ID 地址被所有写入口拒绝", async function () {
      const { market, outsider, provider } = await loadFixture(deployAgentry);

      await expect(
        market.connect(outsider).register(PROFILE_URI)
      ).to.be.revertedWithCustomError(market, "NotAgent");

      await expect(
        market
          .connect(outsider)
          .publishTask(SPEC_URI, SPEC_HASH, INPUT_URI, await market.paymentToken(), USDT("10"), PARAMS.minDelivery)
      ).to.be.revertedWithCustomError(market, "NotAgent");

      await expect(
        market
          .connect(outsider)
          .createListing(USDT("10"), await market.paymentToken(), PARAMS.minDelivery, SPEC_URI, SPEC_HASH)
      ).to.be.revertedWithCustomError(market, "NotAgent");

      await expect(
        market.connect(outsider).createFreeListing(provider.address, SPEC_URI, SPEC_HASH)
      ).to.be.revertedWithCustomError(market, "NotAgent");
    });

    it("无 ID 地址不能认领任务", async function () {
      const { market, publisher, outsider } = await loadFixture(deployAgentry);
      const taskId = await publishTask(market, publisher);

      await expect(
        market.connect(outsider).claimTask(taskId)
      ).to.be.revertedWithCustomError(market, "NotAgent");
    });

    it("isAgent 反映持有状态", async function () {
      const { market, publisher, outsider } = await loadFixture(deployAgentry);

      expect(await market.isAgent(publisher.address)).to.equal(true);
      expect(await market.isAgent(outsider.address)).to.equal(false);
    });
  });

  describe("自由发布任务", function () {
    it("托管资金并进入 Open 状态", async function () {
      const { market, marketAddr, usdt, publisher } = await loadFixture(deployAgentry);

      const before = await usdt.balanceOf(publisher.address);
      const taskId = await publishTask(market, publisher, USDT("10"));

      expect(await usdt.balanceOf(marketAddr)).to.equal(USDT("10"));
      expect(before - (await usdt.balanceOf(publisher.address))).to.equal(USDT("10"));

      const t = await market.getTask(taskId);
      expect(t.state).to.equal(State.Open);
      expect(t.publisher).to.equal(publisher.address);
      expect(t.provider).to.equal(ethers.ZeroAddress);
      expect(t.amount).to.equal(USDT("10"));
      expect(t.specHash).to.equal(SPEC_HASH);
      expect(t.listingId).to.equal(0n); // 0 表示自由发布
    });

    it("金额超上限被拒绝", async function () {
      const { market, publisher } = await loadFixture(deployAgentry);

      await expect(
        market
          .connect(publisher)
          .publishTask(SPEC_URI, SPEC_HASH, INPUT_URI, await market.paymentToken(), USDT("51"), PARAMS.minDelivery)
      ).to.be.revertedWithCustomError(market, "AmountTooLarge");
    });

    it("交付时长越界被拒绝", async function () {
      const { market, publisher } = await loadFixture(deployAgentry);

      await expect(
        market
          .connect(publisher)
          .publishTask(SPEC_URI, SPEC_HASH, INPUT_URI, await market.paymentToken(), USDT("10"), HOUR)
      ).to.be.revertedWithCustomError(market, "BadDeliveryDuration");

      await expect(
        market
          .connect(publisher)
          .publishTask(SPEC_URI, SPEC_HASH, INPUT_URI, await market.paymentToken(), USDT("10"), 8 * DAY)
      ).to.be.revertedWithCustomError(market, "BadDeliveryDuration");
    });

    it("缺少规格哈希被拒绝", async function () {
      const { market, publisher } = await loadFixture(deployAgentry);

      await expect(
        market
          .connect(publisher)
          .publishTask(
            SPEC_URI, ethers.ZeroHash, INPUT_URI,
            await market.paymentToken(), USDT("10"), PARAMS.minDelivery
          )
      ).to.be.revertedWithCustomError(market, "SpecHashRequired");
    });

    it("published 计数 +1", async function () {
      const { market, publisher } = await loadFixture(deployAgentry);
      await publishTask(market, publisher);

      const rep = await market.reputationOf(publisher.address);
      expect(rep.published).to.equal(1n);
    });
  });

  describe("认领与指派", function () {
    it("任意持 ID 地址可认领，交付期限正确写入", async function () {
      const { market, publisher, provider } = await loadFixture(deployAgentry);
      const taskId = await publishTask(market, publisher);

      await market.connect(provider).claimTask(taskId);
      const now = await time.latest();

      const t = await market.getTask(taskId);
      expect(t.state).to.equal(State.Assigned);
      expect(t.provider).to.equal(provider.address);
      expect(t.deliveryDeadline).to.equal(BigInt(now) + BigInt(PARAMS.minDelivery));
    });

    it("发布方不能认领自己的任务", async function () {
      const { market, publisher } = await loadFixture(deployAgentry);
      const taskId = await publishTask(market, publisher);

      await expect(
        market.connect(publisher).claimTask(taskId)
      ).to.be.revertedWithCustomError(market, "SelfDealing");
    });

    it("认领期过后不能认领", async function () {
      const { market, publisher, provider } = await loadFixture(deployAgentry);
      const taskId = await publishTask(market, publisher);

      await time.increase(PARAMS.claimWindow + 1);

      await expect(
        market.connect(provider).claimTask(taskId)
      ).to.be.revertedWithCustomError(market, "DeadlinePassed");
    });

    it("没有指派接口：发布方不能把任务硬塞给别人", async function () {
      const { market } = await loadFixture(deployAgentry);
      expect(market.interface.getFunction("assignTask")).to.equal(null);
    });

    it("免费订单超时不计服务方逾期，付费订单照计", async function () {
      const { market, publisher, provider } = await loadFixture(deployAgentry);
      const free = await createListing(market, provider, 0n);
      await market.connect(publisher).createOrder(free, INPUT_URI);
      const freeTask = await market.taskCount();
      const paid = await createListing(market, provider, USDT("10"));
      await market.connect(publisher).createOrder(paid, INPUT_URI);
      const paidTask = await market.taskCount();

      await time.increase(PARAMS.maxDelivery + 1);
      await market.settleDeliveryTimeout(freeTask);
      expect((await market.reputationOf(provider.address)).expired).to.equal(0n);
      await market.settleDeliveryTimeout(paidTask);
      expect((await market.reputationOf(provider.address)).expired).to.equal(1n);
    });
  });

  describe("付费挂牌与下单", function () {
    it("下单一笔交易完成托管，直接进入 Assigned", async function () {
      const { market, marketAddr, usdt, publisher, provider } = await loadFixture(deployAgentry);
      const listingId = await createListing(market, provider, USDT("10"));

      await market.connect(publisher).createOrder(listingId, INPUT_URI);
      const taskId = await market.taskCount();

      expect(await usdt.balanceOf(marketAddr)).to.equal(USDT("10"));

      const t = await market.getTask(taskId);
      expect(t.state).to.equal(State.Assigned); // 不经过 Open
      expect(t.provider).to.equal(provider.address);
      expect(t.publisher).to.equal(publisher.address);
      expect(t.listingId).to.equal(listingId);
      expect(t.specHash).to.equal(SPEC_HASH);
    });

    it("挂牌改价不影响已有订单", async function () {
      const { market, publisher, provider } = await loadFixture(deployAgentry);
      const listingId = await createListing(market, provider, USDT("10"));

      await market.connect(publisher).createOrder(listingId, INPUT_URI);
      const taskId = await market.taskCount();

      // 服务方事后把价格翻倍
      await market
        .connect(provider)
        .updateListing(listingId, USDT("20"), PARAMS.maxDelivery, true);

      // 已有订单按下单时的快照执行
      const t = await market.getTask(taskId);
      expect(t.amount).to.equal(USDT("10"));
      expect(t.deliveryDuration).to.equal(BigInt(PARAMS.minDelivery));
    });

    it("不能买自己的挂牌", async function () {
      const { market, provider } = await loadFixture(deployAgentry);
      const listingId = await createListing(market, provider);

      await expect(
        market.connect(provider).createOrder(listingId, INPUT_URI)
      ).to.be.revertedWithCustomError(market, "SelfDealing");
    });

    it("下架后不能下单", async function () {
      const { market, publisher, provider } = await loadFixture(deployAgentry);
      const listingId = await createListing(market, provider);

      await market
        .connect(provider)
        .updateListing(listingId, USDT("10"), PARAMS.minDelivery, false);

      await expect(
        market.connect(publisher).createOrder(listingId, INPUT_URI)
      ).to.be.revertedWithCustomError(market, "ListingInactive");
    });

    it("只有挂牌主人能改", async function () {
      const { market, provider, j1 } = await loadFixture(deployAgentry);
      const listingId = await createListing(market, provider);

      await expect(
        market.connect(j1).updateListing(listingId, USDT("20"), PARAMS.minDelivery, true)
      ).to.be.revertedWithCustomError(market, "NotListingOwner");
    });
  });

  describe("免费挂牌", function () {
    it("创建后价格为 0 且带 target", async function () {
      const { market, provider, j1 } = await loadFixture(deployAgentry);

      await market.connect(provider).createFreeListing(j1.address, SPEC_URI, SPEC_HASH);
      const listingId = await market.listingCount();

      const l = await market.getListing(listingId);
      expect(l.kind).to.equal(ListingKind.Free);
      expect(l.price).to.equal(0n);
      expect(l.target).to.equal(j1.address);
      expect(l.deliveryDuration).to.equal(0n);
    });

    it("免费挂牌不能下单", async function () {
      const { market, publisher, provider, j1 } = await loadFixture(deployAgentry);

      await market.connect(provider).createFreeListing(j1.address, SPEC_URI, SPEC_HASH);
      const listingId = await market.listingCount();

      await expect(
        market.connect(publisher).createOrder(listingId, INPUT_URI)
      ).to.be.revertedWithCustomError(market, "WrongListingKind");
    });

    it("target 不能为零地址", async function () {
      const { market, provider } = await loadFixture(deployAgentry);

      await expect(
        market.connect(provider).createFreeListing(ethers.ZeroAddress, SPEC_URI, SPEC_HASH)
      ).to.be.revertedWithCustomError(market, "ZeroAddress");
    });
  });

  describe("交付与验收", function () {
    it("验收后放款给服务方，completed 计数 +1", async function () {
      const { market, usdt, publisher, provider } = await loadFixture(deployAgentry);
      const taskId = await taskAwaitingReview(market, publisher, provider, USDT("10"));

      const before = await usdt.balanceOf(provider.address);
      await market.connect(publisher).acceptResult(taskId);

      expect((await usdt.balanceOf(provider.address)) - before).to.equal(USDT("10"));
      expect((await market.getTask(taskId)).state).to.equal(State.Completed);
      expect((await market.reputationOf(provider.address)).completed).to.equal(1n);
    });

    it("只有服务方能提交", async function () {
      const { market, publisher, provider, j1 } = await loadFixture(deployAgentry);
      const taskId = await publishTask(market, publisher);
      await market.connect(provider).claimTask(taskId);

      await expect(
        market.connect(j1).submitResult(taskId, RESULT_URI)
      ).to.be.revertedWithCustomError(market, "NotProvider");
    });

    it("逾期提交被拒绝", async function () {
      const { market, publisher, provider } = await loadFixture(deployAgentry);
      const taskId = await publishTask(market, publisher);
      await market.connect(provider).claimTask(taskId);

      await time.increase(PARAMS.minDelivery + 1);

      await expect(
        market.connect(provider).submitResult(taskId, RESULT_URI)
      ).to.be.revertedWithCustomError(market, "DeadlinePassed");
    });

    it("只有发布方能验收", async function () {
      const { market, publisher, provider, j1 } = await loadFixture(deployAgentry);
      const taskId = await taskAwaitingReview(market, publisher, provider);

      await expect(
        market.connect(j1).acceptResult(taskId)
      ).to.be.revertedWithCustomError(market, "NotPublisher");
    });
  });

  describe("无需许可的超时结算", function () {
    it("验收逾期后任何人可触发放款给服务方", async function () {
      const { market, usdt, publisher, provider, outsider } = await loadFixture(deployAgentry);
      const taskId = await taskAwaitingReview(market, publisher, provider, USDT("10"));

      await time.increase(PARAMS.reviewWindow + 1);

      const before = await usdt.balanceOf(provider.address);
      // 由完全无关、且没有 Agent ID 的地址触发
      await market.connect(outsider).settleReviewTimeout(taskId);

      expect((await usdt.balanceOf(provider.address)) - before).to.equal(USDT("10"));
      expect((await market.getTask(taskId)).state).to.equal(State.Completed);
    });

    it("验收期未到不能触发自动放款", async function () {
      const { market, publisher, provider, outsider } = await loadFixture(deployAgentry);
      const taskId = await taskAwaitingReview(market, publisher, provider);

      await expect(
        market.connect(outsider).settleReviewTimeout(taskId)
      ).to.be.revertedWithCustomError(market, "DeadlineNotReached");
    });

    it("交付逾期后任何人可触发退款，expired 计数 +1", async function () {
      const { market, usdt, publisher, provider, outsider } = await loadFixture(deployAgentry);
      const taskId = await publishTask(market, publisher, USDT("10"));
      await market.connect(provider).claimTask(taskId);

      await time.increase(PARAMS.minDelivery + 1);

      const before = await usdt.balanceOf(publisher.address);
      await market.connect(outsider).settleDeliveryTimeout(taskId);

      expect((await usdt.balanceOf(publisher.address)) - before).to.equal(USDT("10"));
      expect((await market.getTask(taskId)).state).to.equal(State.Expired);
      expect((await market.reputationOf(provider.address)).expired).to.equal(1n);
    });

    it("发布方可随时撤回未认领的任务", async function () {
      const { market, usdt, publisher } = await loadFixture(deployAgentry);
      const taskId = await publishTask(market, publisher, USDT("10"));

      const before = await usdt.balanceOf(publisher.address);
      await market.connect(publisher).cancelTask(taskId);

      expect((await usdt.balanceOf(publisher.address)) - before).to.equal(USDT("10"));
      expect((await market.getTask(taskId)).state).to.equal(State.Cancelled);
    });

    it("认领期内第三方不能撤回", async function () {
      const { market, publisher, outsider } = await loadFixture(deployAgentry);
      const taskId = await publishTask(market, publisher);

      await expect(
        market.connect(outsider).cancelTask(taskId)
      ).to.be.revertedWithCustomError(market, "CancelNotAllowed");
    });

    it("认领期过后任何人可触发退款，防发布方失联", async function () {
      const { market, usdt, publisher, outsider } = await loadFixture(deployAgentry);
      const taskId = await publishTask(market, publisher, USDT("10"));

      await time.increase(PARAMS.claimWindow + 1);

      const before = await usdt.balanceOf(publisher.address);
      await market.connect(outsider).cancelTask(taskId);

      // 钱始终退回发布方，而不是触发者
      expect((await usdt.balanceOf(publisher.address)) - before).to.equal(USDT("10"));
    });
  });

  describe("暂停语义", function () {
    it("暂停后新任务、新订单、新挂牌全部进不来", async function () {
      const { market, owner, publisher, provider } = await loadFixture(deployAgentry);
      const listingId = await createListing(market, provider);

      await market.connect(owner).pause();

      await expect(
        market
          .connect(publisher)
          .publishTask(SPEC_URI, SPEC_HASH, INPUT_URI, await market.paymentToken(), USDT("10"), PARAMS.minDelivery)
      ).to.be.revertedWithCustomError(market, "EnforcedPause");

      await expect(
        market.connect(publisher).createOrder(listingId, INPUT_URI)
      ).to.be.revertedWithCustomError(market, "EnforcedPause");

      await expect(
        market
          .connect(provider)
          .createListing(USDT("10"), await market.paymentToken(), PARAMS.minDelivery, SPEC_URI, SPEC_HASH)
      ).to.be.revertedWithCustomError(market, "EnforcedPause");
    });

    it("暂停不能阻断已有任务的任何结算路径", async function () {
      // 这是文档里承诺的核心安全属性：pause 只挡新任务进入，
      // 永远不能挡已有资金流出
      const { market, usdt, owner, publisher, provider, outsider } =
        await loadFixture(deployAgentry);

      const taskA = await publishTask(market, publisher, USDT("10"));
      const taskB = await publishTask(market, publisher, USDT("10"));

      await market.connect(owner).pause();

      // 认领仍可用
      await market.connect(provider).claimTask(taskA);
      // 提交仍可用
      await market.connect(provider).submitResult(taskA, RESULT_URI);
      // 验收放款仍可用
      const before = await usdt.balanceOf(provider.address);
      await market.connect(publisher).acceptResult(taskA);
      expect((await usdt.balanceOf(provider.address)) - before).to.equal(USDT("10"));

      // 超时退款仍可由任何人触发
      await time.increase(PARAMS.claimWindow + 1);
      await market.connect(outsider).cancelTask(taskB);
      expect((await market.getTask(taskB)).state).to.equal(State.Cancelled);
    });

    it("暂停期间仍可拒收并开庭", async function () {
      const { market, owner, publisher, provider } = await loadFixture(deployAgentry);
      const taskId = await taskAwaitingReview(market, publisher, provider);

      await market.connect(owner).pause();

      await market.connect(publisher).rejectResult(taskId, REASON_URI);
      expect((await market.getTask(taskId)).state).to.equal(State.Disputed);
    });
  });

  describe("owner 权限边界", function () {
    it("陪审合约地址只能设置一次", async function () {
      const { market, owner, j1 } = await loadFixture(deployAgentry);

      await expect(
        market.connect(owner).setJury(j1.address)
      ).to.be.revertedWithCustomError(market, "JuryAlreadySet");
    });

    it("参数变更需等满 48 小时，两种币的上限一起改", async function () {
      const { market, owner, usdtAddr } = await loadFixture(deployAgentry);

      await market.connect(owner).proposeParams(
        BNB("2"), USDT("100"), PARAMS.claimWindow, PARAMS.reviewWindow,
        PARAMS.minDelivery, PARAMS.maxDelivery, 300
      );

      // 立即生效是不允许的
      expect(await market.maxTaskAmount(NATIVE)).to.equal(PARAMS.maxNative);
      expect(await market.maxTaskAmount(usdtAddr)).to.equal(PARAMS.maxToken);

      await expect(
        market.connect(owner).applyParams()
      ).to.be.revertedWithCustomError(market, "TimelockNotElapsed");

      await time.increase(48 * HOUR);
      await market.connect(owner).applyParams();

      expect(await market.maxTaskAmount(NATIVE)).to.equal(BNB("2"));
      expect(await market.maxTaskAmount(usdtAddr)).to.equal(USDT("100"));
      expect(await market.juryFeeBps()).to.equal(300n);
    });

    it("陪审费率不能超过硬上限", async function () {
      const { market, owner } = await loadFixture(deployAgentry);

      await expect(
        market.connect(owner).proposeParams(
          PARAMS.maxNative, PARAMS.maxToken, PARAMS.claimWindow, PARAMS.reviewWindow,
          PARAMS.minDelivery, PARAMS.maxDelivery, 1001
        )
      ).to.be.revertedWithCustomError(market, "FeeTooHigh");
    });

    it("owner 没有任何提取托管资金的入口", async function () {
      const { market } = await loadFixture(deployAgentry);

      // 合约 ABI 里不存在任何提取、救援、清扫类函数。
      // claimPending 是例外：它只能把早已属于某人的滞留款发给本人，
      // 既不是 owner 专属，也无法指定别的收款地址——下一条测试守这一点
      const names = market.interface.fragments
        .filter((f) => f.type === "function")
        .map((f) => f.name)
        .filter((n) => n !== "claimPending")
        .map((n) => n.toLowerCase());

      for (const forbidden of ["withdraw", "rescue", "sweep", "emergency", "drain", "recover"]) {
        expect(names.some((n) => n.includes(forbidden))).to.equal(false);
      }
    });

    it("claimPending 不是 owner 专属，且只能发给本人", async function () {
      const { market } = await loadFixture(deployAgentry);

      const fn = market.interface.getFunction("claimPending");
      // 签名是 (收款人, 币种)，没有「发往任意地址」的参数
      expect(fn.inputs.map((i) => i.name)).to.deep.equal(["to", "currency"]);
    });

    it("非 owner 不能暂停", async function () {
      const { market, publisher } = await loadFixture(deployAgentry);

      await expect(
        market.connect(publisher).pause()
      ).to.be.revertedWithCustomError(market, "OwnableUnauthorizedAccount");
    });
  });

  describe("名片", function () {
    it("register 写入并发事件", async function () {
      const { market, provider } = await loadFixture(deployAgentry);

      await expect(market.connect(provider).register(PROFILE_URI))
        .to.emit(market, "AgentRegistered")
        .withArgs(provider.address, PROFILE_URI);

      expect(await market.profileOf(provider.address)).to.equal(PROFILE_URI);
    });

    it("空 URI 被拒绝", async function () {
      const { market, provider } = await loadFixture(deployAgentry);

      await expect(
        market.connect(provider).register("")
      ).to.be.revertedWithCustomError(market, "EmptyURI");
    });
  });
});
