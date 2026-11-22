const { expect } = require("chai");
const { ethers } = require("hardhat");
const { HOUR, NATIVE, SPEC_URI, SPEC_HASH, INPUT_URI, State, deployAgentry } = require("./fixtures");

const Mode = { Ok: 0, Revert: 1, ReturnBomb: 2, ShortReturn: 3, ReenterRouter: 4, ReenterMarket: 5, BurnGas: 6 };
const KIND_SERVICE = 2n;

/// 合约交付：用户经路由调用服务合约，市场记一张已完成的 0 元订单
describe("合约交付（服务路由）", function () {
  async function setup() {
    const ctx = await deployAgentry();
    const { market, agentId, owner, provider } = ctx;
    const router = await (await ethers.getContractFactory("AgentryServiceRouter")).deploy(
      await market.getAddress(), await agentId.getAddress());
    await market.connect(owner).setServiceRouter(await router.getAddress());
    const svc = await (await ethers.getContractFactory("MockService")).deploy(await router.getAddress(), provider.address);
    return { ...ctx, router, svc };
  }

  async function listed() {
    const ctx = await setup();
    const { router, svc, provider, market } = ctx;
    await router.connect(provider).createServiceListing(await svc.getAddress(), SPEC_URI, SPEC_HASH);
    const id = await market.listingCount();
    await svc.bind(id);
    return { ...ctx, id };
  }

  describe("挂牌", function () {
    it("服务方经路由挂出，挂牌类型是合约交付", async function () {
      const { market, provider, svc, id } = await listed();
      const l = await market.getListing(id);
      expect(l.kind).to.equal(KIND_SERVICE);
      expect(l.provider).to.equal(provider.address);
      expect(l.target).to.equal(await svc.getAddress());
      expect(l.price).to.equal(0n);
      expect(l.active).to.equal(true);
    });

    it("没有 Agent ID 不能挂", async function () {
      const { router, svc, outsider } = await setup();
      await svc.setProvider(outsider.address);
      await expect(router.connect(outsider).createServiceListing(await svc.getAddress(), SPEC_URI, SPEC_HASH))
        .to.be.revertedWithCustomError(router, "NotAgent");
    });

    it("目标不是合约、或没实现服务接口，不能挂", async function () {
      const { router, provider, publisher } = await setup();
      await expect(router.connect(provider).createServiceListing(publisher.address, SPEC_URI, SPEC_HASH))
        .to.be.revertedWithCustomError(router, "NotAContract");
      const plain = await (await ethers.getContractFactory("MockNotService")).deploy();
      await expect(router.connect(provider).createServiceListing(await plain.getAddress(), SPEC_URI, SPEC_HASH))
        .to.be.revertedWithCustomError(router, "NotAService");
    });

    it("防冒用：别人不能把你的服务合约挂到他名下", async function () {
      const { router, svc, j1 } = await setup();
      await expect(router.connect(j1).createServiceListing(await svc.getAddress(), SPEC_URI, SPEC_HASH))
        .to.be.revertedWithCustomError(router, "NotServiceProvider");
    });

    it("只有路由能调用市场的合约交付入口", async function () {
      const { market, provider, svc, publisher } = await listed();
      await expect(market.connect(provider).createServiceListing(provider.address, await svc.getAddress(), SPEC_URI, SPEC_HASH))
        .to.be.revertedWithCustomError(market, "OnlyServiceRouter");
      await expect(market.connect(publisher).recordServiceUse(1, publisher.address))
        .to.be.revertedWithCustomError(market, "OnlyServiceRouter");
    });

    it("合约交付挂牌不能走普通下单", async function () {
      const { market, publisher, id } = await listed();
      await expect(market.connect(publisher).createOrder(id, INPUT_URI))
        .to.be.revertedWithCustomError(market, "WrongListingKind");
    });
  });

  describe("使用", function () {
    it("一笔交易：记一张已完成的 0 元订单，并由服务合约交付", async function () {
      const { router, market, svc, publisher, provider, id } = await listed();
      const input = ethers.toUtf8Bytes("hello");
      await expect(router.connect(publisher).use(id, input))
        .to.emit(market, "ServiceUsed").withArgs(1n, id, publisher.address, provider.address)
        .and.to.emit(router, "ServiceUsed");

      const t = await market.getTask(1);
      expect(t.publisher).to.equal(publisher.address);
      expect(t.provider).to.equal(provider.address);
      expect(t.state).to.equal(State.Completed);
      expect(t.amount).to.equal(0n);
      expect(t.listingId).to.equal(id);
      expect(t.specHash).to.equal(SPEC_HASH);

      expect(await svc.served()).to.equal(1n);
      expect(await svc.lastBuyer()).to.equal(publisher.address);
      expect(await svc.lastInput()).to.equal(ethers.hexlify(input));
    });

    it("计数：次数、不重复人数、服务方自动交付数，不计入履约完成数", async function () {
      const { router, market, publisher, provider, j1, id } = await listed();
      await router.connect(publisher).use(id, "0x");
      await router.connect(publisher).use(id, "0x");
      await router.connect(j1).use(id, "0x");
      const [uses, users] = await market.serviceStatsOf(id);
      expect(uses).to.equal(3n);
      expect(users).to.equal(2n);
      expect(await market.serviceTaskCount()).to.equal(3n);
      expect(await market.serviceUserCount()).to.equal(2n);
      expect(await market.taskCount()).to.equal(3n);
      expect(await market.serviceCompletedOf(provider.address)).to.equal(3n);
      expect((await market.reputationOf(provider.address)).completed).to.equal(0n);
      expect(await market.freeCompletedOf(provider.address)).to.equal(0n);
    });

    it("用户可以评价这张订单，服务方可以回复", async function () {
      const { router, market, publisher, provider, id } = await listed();
      await router.connect(publisher).use(id, "0x");
      await market.connect(publisher).review(1, 5, "data:,good");
      expect((await market.reviewOf(1)).rating).to.equal(5n);
      await market.connect(provider).reply(1, "data:,thanks");
      const [count, sum] = await market.statsOf(provider.address);
      expect(count).to.equal(1n);
      expect(sum).to.equal(5n);
    });

    it("没有 Agent ID、服务方自己，都不能用", async function () {
      const { router, market, outsider, provider, id } = await listed();
      await expect(router.connect(outsider).use(id, "0x")).to.be.revertedWithCustomError(market, "NotAgent");
      await expect(router.connect(provider).use(id, "0x")).to.be.revertedWithCustomError(market, "SelfDealing");
    });

    it("普通挂牌、不存在的挂牌，不能经路由使用", async function () {
      const { router, market, provider, publisher } = await listed();
      await market.connect(provider).createListing(0, NATIVE, HOUR, SPEC_URI, SPEC_HASH);
      const normal = await market.listingCount();
      await expect(router.connect(publisher).use(normal, "0x")).to.be.revertedWithCustomError(market, "WrongListingKind");
      await expect(router.connect(publisher).use(99, "0x")).to.be.revertedWithCustomError(market, "ListingNotFound");
    });

    it("输入超过 4 KB 被拒绝", async function () {
      const { router, publisher, id } = await listed();
      await expect(router.connect(publisher).use(id, "0x" + "00".repeat(4097)))
        .to.be.revertedWithCustomError(router, "InputTooLarge");
    });

    it("服务方下架后不能用，重新上架后可以", async function () {
      const { router, market, publisher, provider, id } = await listed();
      await market.connect(provider).updateListing(id, 0, 0, false);
      await expect(router.connect(publisher).use(id, "0x")).to.be.revertedWithCustomError(market, "ListingInactive");
      await market.connect(provider).updateListing(id, 0, 0, true);
      await router.connect(publisher).use(id, "0x");
    });

    it("市场暂停时不能用", async function () {
      const { router, market, owner, publisher, id } = await listed();
      await market.connect(owner).pause();
      await expect(router.connect(publisher).use(id, "0x")).to.be.revertedWithCustomError(market, "EnforcedPause");
    });
  });

  describe("预检 canUse", function () {
    it("各种不能用的原因", async function () {
      const { router, market, svc, publisher, provider, outsider, owner, id } = await listed();
      expect(await router.canUse(id, publisher.address, "0x")).to.deep.equal([true, ""]);
      expect((await router.canUse(99, publisher.address, "0x"))[1]).to.equal("listing not found");
      expect((await router.canUse(id, outsider.address, "0x"))[1]).to.equal("no Agent ID");
      expect((await router.canUse(id, provider.address, "0x"))[1]).to.equal("provider cannot use own service");
      await svc.setMode(Mode.Revert);
      expect((await router.canUse(id, publisher.address, "0x"))[1]).to.equal("service says no");
      await svc.setMode(Mode.Ok);
      await market.connect(owner).pause();
      expect((await router.canUse(id, publisher.address, "0x"))[1]).to.equal("market paused");
    });
  });

  describe("恶意或出错的服务合约", function () {
    it("服务合约报错：整笔回滚，不留订单", async function () {
      const { router, market, svc, publisher, id } = await listed();
      await svc.setMode(Mode.Revert);
      await expect(router.connect(publisher).use(id, "0x")).to.be.revertedWith("service says no");
      expect(await market.taskCount()).to.equal(0n);
      expect((await market.serviceStatsOf(id))[0]).to.equal(0n);
    });

    it("超大错误数据：只转述前 256 字节，不会耗光 gas", async function () {
      const { router, market, svc, publisher, id } = await listed();
      await svc.setMode(Mode.ReturnBomb);
      await expect(router.connect(publisher).use(id, "0x", { gasLimit: 3_000_000 })).to.be.reverted;
      expect(await market.taskCount()).to.equal(0n);
    });

    it("不返回结果哈希：回滚", async function () {
      const { router, svc, publisher, id } = await listed();
      await svc.setMode(Mode.ShortReturn);
      await expect(router.connect(publisher).use(id, "0x")).to.be.revertedWithCustomError(router, "BadServiceResponse");
    });

    it("重入路由：被防重入锁挡住，整笔回滚", async function () {
      const { router, market, svc, publisher, id } = await listed();
      await svc.setMode(Mode.ReenterRouter);
      await expect(router.connect(publisher).use(id, "0x")).to.be.reverted;
      expect(await market.taskCount()).to.equal(0n);
    });

    it("交付中途调用市场合约：被拒绝，整笔回滚", async function () {
      const { router, market, svc, publisher, id } = await listed();
      await svc.setMarket(await market.getAddress());
      await svc.setMode(Mode.ReenterMarket);
      await expect(router.connect(publisher).use(id, "0x")).to.be.reverted;
      expect(await market.taskCount()).to.equal(0n);
    });

    it("耗光 gas：只影响这笔交易", async function () {
      const { router, market, svc, publisher, id } = await listed();
      await svc.setMode(Mode.BurnGas);
      await expect(router.connect(publisher).use(id, "0x", { gasLimit: 1_000_000 })).to.be.reverted;
      await svc.setMode(Mode.Ok);
      await router.connect(publisher).use(id, "0x");
      expect(await market.taskCount()).to.equal(1n);
    });

    it("服务合约只认路由，也只认自己绑定的挂牌", async function () {
      const { svc, publisher, id } = await listed();
      await expect(svc.connect(publisher).fulfill(id, publisher.address, "0x")).to.be.revertedWithCustomError(svc, "OnlyRouter");
    });

    it("服务合约绑定了别的挂牌号：拒绝交付，整笔回滚", async function () {
      const { router, market, svc, publisher, id } = await listed();
      await svc.bind(id + 100n);
      await expect(router.connect(publisher).use(id, "0x")).to.be.revertedWithCustomError(svc, "WrongListing");
      expect(await market.taskCount()).to.equal(0n);
    });

    it("服务合约事后换了服务方，已有挂牌仍归原服务方", async function () {
      const { router, market, svc, publisher, provider, j1, id } = await listed();
      await svc.setProvider(j1.address);
      await router.connect(publisher).use(id, "0x");
      expect((await market.getTask(1)).provider).to.equal(provider.address);
    });
  });

  describe("平台权限", function () {
    it("owner 可以强制下架，服务方不能自行重新上架", async function () {
      const { router, market, owner, publisher, provider, id } = await listed();
      await expect(market.connect(owner).delist(id)).to.emit(market, "ListingDelisted").withArgs(id);
      expect(await market.delisted(id)).to.equal(true);
      await expect(router.connect(publisher).use(id, "0x")).to.be.revertedWithCustomError(market, "ListingInactive");
      await expect(market.connect(provider).updateListing(id, 0, 0, true)).to.be.revertedWithCustomError(market, "ListingIsDelisted");
    });

    it("强制下架也适用于普通挂牌；已有订单不受影响", async function () {
      const { market, owner, publisher, provider } = await setup();
      await market.connect(provider).createListing(0, NATIVE, HOUR, SPEC_URI, SPEC_HASH);
      await market.connect(publisher).createOrder(1, INPUT_URI);
      await market.connect(owner).delist(1);
      await expect(market.connect(publisher).createOrder(1, INPUT_URI)).to.be.revertedWithCustomError(market, "ListingInactive");
      expect((await market.getTask(1)).state).to.equal(State.Assigned);
    });

    it("非 owner 不能下架、不能换路由", async function () {
      const { market, provider, publisher, id } = await listed();
      await expect(market.connect(provider).delist(id)).to.be.revertedWithCustomError(market, "OwnableUnauthorizedAccount");
      await expect(market.connect(publisher).setServiceRouter(publisher.address)).to.be.revertedWithCustomError(market, "OwnableUnauthorizedAccount");
    });

    it("换掉路由后，旧路由立即失效", async function () {
      const { router, market, owner, publisher, id } = await listed();
      await market.connect(owner).setServiceRouter(ethers.ZeroAddress);
      await expect(router.connect(publisher).use(id, "0x")).to.be.revertedWithCustomError(market, "OnlyServiceRouter");
    });
  });
});
