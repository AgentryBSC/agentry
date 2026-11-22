const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const {
  NATIVE, HOUR, DAY, PARAMS, SPEC_URI, SPEC_HASH, INPUT_URI, RESULT_URI, REASON_URI,
  State, deployAgentry,
} = require("./fixtures");

/// 0 元服务：照常下单、交付、验收、评价，只是不托管资金、不进陪审
describe("0 元服务", function () {
  async function freeListing(market, provider, currency, duration) {
    await market.connect(provider).createListing(0, currency ?? NATIVE, duration ?? HOUR, SPEC_URI, SPEC_HASH);
    return await market.listingCount();
  }

  async function freeOrder(ctx, currency) {
    const { market, publisher, provider } = ctx;
    const id = await freeListing(market, provider, currency);
    await market.connect(publisher).createOrder(id, INPUT_URI);
    return await market.taskCount();
  }

  describe("挂牌", function () {
    it("可以挂 0 元服务，交付时长下限放宽到 1 小时", async function () {
      const { market, provider } = await deployAgentry();
      const id = await freeListing(market, provider, NATIVE, HOUR);
      const l = await market.getListing(id);
      expect(l.price).to.equal(0n);
      expect(l.kind).to.equal(0n); // 仍是下单服务，不是合约直连
      expect(await market.MIN_FREE_DELIVERY()).to.equal(BigInt(HOUR));
    });

    it("0 元服务的交付时长不能短于 1 小时、不能长于上限", async function () {
      const { market, provider } = await deployAgentry();
      await expect(market.connect(provider).createListing(0, NATIVE, HOUR - 1, SPEC_URI, SPEC_HASH))
        .to.be.revertedWithCustomError(market, "BadDeliveryDuration");
      await expect(market.connect(provider).createListing(0, NATIVE, PARAMS.maxDelivery + 1, SPEC_URI, SPEC_HASH))
        .to.be.revertedWithCustomError(market, "BadDeliveryDuration");
    });

    it("付费服务的交付时长下限不变", async function () {
      const { market, provider } = await deployAgentry();
      await expect(market.connect(provider).createListing(1n, NATIVE, HOUR, SPEC_URI, SPEC_HASH))
        .to.be.revertedWithCustomError(market, "BadDeliveryDuration");
    });

    it("付费挂牌可以改成免费，免费挂牌也可以改回付费", async function () {
      const { market, provider } = await deployAgentry();
      await market.connect(provider).createListing(ethers.parseEther("0.01"), NATIVE, DAY, SPEC_URI, SPEC_HASH);
      const id = await market.listingCount();
      await market.connect(provider).updateListing(id, 0, HOUR, true);
      expect((await market.getListing(id)).price).to.equal(0n);
      await expect(market.connect(provider).updateListing(id, ethers.parseEther("0.01"), HOUR, true))
        .to.be.revertedWithCustomError(market, "BadDeliveryDuration");
      await market.connect(provider).updateListing(id, ethers.parseEther("0.01"), DAY, true);
      expect((await market.getListing(id)).price).to.equal(ethers.parseEther("0.01"));
    });

    it("公开任务仍然不能是 0 元", async function () {
      const { market, publisher } = await deployAgentry();
      await expect(market.connect(publisher).publishTask(SPEC_URI, SPEC_HASH, INPUT_URI, NATIVE, 0, DAY))
        .to.be.revertedWithCustomError(market, "AmountZero");
    });
  });

  describe("下单", function () {
    it("下单不收钱，任务直接进入待交付", async function () {
      const ctx = await deployAgentry();
      const { market, publisher, provider, marketAddr } = ctx;
      const before = await ethers.provider.getBalance(marketAddr);
      const id = await freeOrder(ctx);
      const t = await market.getTask(id);
      expect(t.amount).to.equal(0n);
      expect(t.state).to.equal(State.Assigned);
      expect(t.provider).to.equal(provider.address);
      expect(t.publisher).to.equal(publisher.address);
      expect(await ethers.provider.getBalance(marketAddr)).to.equal(before);
    });

    it("0 元下单附带 BNB 会被拒绝", async function () {
      const { market, publisher, provider } = await deployAgentry();
      const id = await freeListing(market, provider);
      await expect(market.connect(publisher).createOrder(id, INPUT_URI, { value: 1n }))
        .to.be.revertedWithCustomError(market, "WrongMsgValue");
    });

    it("USDT 计价的 0 元服务不需要授权、不转账", async function () {
      const ctx = await deployAgentry();
      const { market, usdt, usdtAddr, publisher } = ctx;
      const before = await usdt.balanceOf(publisher.address);
      await usdt.connect(publisher).approve(ctx.marketAddr, 0);
      const id = await freeOrder(ctx, usdtAddr);
      expect((await market.getTask(id)).state).to.equal(State.Assigned);
      expect(await usdt.balanceOf(publisher.address)).to.equal(before);
    });

    it("没有 Agent ID 不能下单", async function () {
      const { market, provider, outsider } = await deployAgentry();
      const id = await freeListing(market, provider);
      await expect(market.connect(outsider).createOrder(id, INPUT_URI))
        .to.be.revertedWithCustomError(market, "NotAgent");
    });
  });

  describe("交付与验收", function () {
    it("验收通过计入免费完成数，不计入付费完成数", async function () {
      const ctx = await deployAgentry();
      const { market, publisher, provider } = ctx;
      const id = await freeOrder(ctx);
      await market.connect(provider).submitResult(id, RESULT_URI);
      await expect(market.connect(publisher).acceptResult(id))
        .to.emit(market, "TaskCompleted").withArgs(id, provider.address, 0);
      expect((await market.getTask(id)).state).to.equal(State.Completed);
      expect((await market.reputationOf(provider.address)).completed).to.equal(0n);
      expect(await market.freeCompletedOf(provider.address)).to.equal(1n);
    });

    it("验收期满自动完成，同样计入免费完成数", async function () {
      const ctx = await deployAgentry();
      const { market, provider, outsider } = ctx;
      const id = await freeOrder(ctx);
      await market.connect(provider).submitResult(id, RESULT_URI);
      await time.increase(PARAMS.reviewWindow + 1);
      await market.connect(outsider).settleReviewTimeout(id);
      expect(await market.freeCompletedOf(provider.address)).to.equal(1n);
    });

    it("拒收直接结束：不进陪审，双方都不记争议", async function () {
      const ctx = await deployAgentry();
      const { market, jury, publisher, provider } = ctx;
      const id = await freeOrder(ctx);
      await market.connect(provider).submitResult(id, RESULT_URI);
      await expect(market.connect(publisher).rejectResult(id, REASON_URI))
        .to.emit(market, "FreeOrderRejected").withArgs(id, REASON_URI);
      expect((await market.getTask(id)).state).to.equal(State.Refunded);
      expect(await jury.disputeCount()).to.equal(0n);
      const rp = await market.reputationOf(provider.address);
      const rb = await market.reputationOf(publisher.address);
      expect(rp.disputesLost + rp.disputesWon + rb.disputesLost + rb.disputesWon).to.equal(0n);
      expect(await market.freeCompletedOf(provider.address)).to.equal(0n);
    });

    it("逾期未交付：订单退回，但不计服务方逾期（防止批量免费下单刷逾期）", async function () {
      const ctx = await deployAgentry();
      const { market, provider, outsider } = ctx;
      const id = await freeOrder(ctx);
      await time.increase(HOUR + 1);
      await market.connect(outsider).settleDeliveryTimeout(id);
      expect((await market.getTask(id)).state).to.equal(State.Expired);
      expect((await market.reputationOf(provider.address)).expired).to.equal(0n);
    });
  });

  describe("评价", function () {
    it("0 元订单结束后可以评价，计入用户评分", async function () {
      const ctx = await deployAgentry();
      const { market, publisher, provider } = ctx;
      const id = await freeOrder(ctx);
      await market.connect(provider).submitResult(id, RESULT_URI);
      await market.connect(publisher).acceptResult(id);
      await market.connect(publisher).review(id, 5, "data:,ok");
      const [count, sum] = await market.statsOf(provider.address);
      expect(count).to.equal(1n);
      expect(sum).to.equal(5n);
    });

    it("被拒收的 0 元订单也可以评价", async function () {
      const ctx = await deployAgentry();
      const { market, publisher, provider } = ctx;
      const id = await freeOrder(ctx);
      await market.connect(provider).submitResult(id, RESULT_URI);
      await market.connect(publisher).rejectResult(id, REASON_URI);
      await market.connect(publisher).review(id, 2, "data:,bad");
      expect((await market.statsOf(provider.address))[0]).to.equal(1n);
    });
  });
});
