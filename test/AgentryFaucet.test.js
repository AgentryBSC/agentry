const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { SPEC_URI, SPEC_HASH, deployAgentry } = require("./fixtures");

const E = (n) => ethers.parseEther(String(n));
const DAY = 24 * 3600;

/// 水龙头是一个「合约交付」服务：用户经路由领取，每次领取都是一张市场订单
describe("AgentryFaucet", function () {
  let owner, alice, bob, nobody, aid, market, router, tok, faucet, id;

  beforeEach(async function () {
    const ctx = await deployAgentry();
    // provider 是水龙头 owner；publisher、j1 当领取人；outsider 没有 Agent ID
    owner = ctx.provider; alice = ctx.publisher; bob = ctx.j1; nobody = ctx.outsider;
    aid = ctx.agentId; market = ctx.market;
    router = await (await ethers.getContractFactory("AgentryServiceRouter")).deploy(await market.getAddress(), await aid.getAddress());
    await market.connect(ctx.owner).setServiceRouter(await router.getAddress());
    tok = await (await ethers.getContractFactory("MockERC20")).deploy("Agentry", "AGT");
    faucet = await (await ethers.getContractFactory("AgentryFaucet")).deploy(owner.address, await aid.getAddress(), await router.getAddress());
    await router.connect(owner).createServiceListing(await faucet.getAddress(), SPEC_URI, SPEC_HASH);
    id = await market.listingCount();
    await faucet.connect(owner).setListing(id);
  });

  const claim = (who) => router.connect(who).use(id, "0x");
  const f = () => faucet.connect(owner);

  async function ready(amount = 100, fund = 1000) {
    await f().setToken(await tok.getAddress());
    await f().setClaimAmount(E(amount));
    await tok.mint(await faucet.getAddress(), E(fund));
  }

  describe("部署与挂牌", function () {
    it("owner 是传入的管理员，也是声明的服务方；默认每人只能领一次", async function () {
      expect(await faucet.owner()).to.equal(owner.address);
      expect(await faucet.agentryProvider()).to.equal(owner.address);
      expect(await faucet.router()).to.equal(await router.getAddress());
      expect(await faucet.listingId()).to.equal(id);
      expect(await faucet.maxClaims()).to.equal(1);
      expect(await faucet.token()).to.equal(ethers.ZeroAddress);
    });

    it("参数不能是 0 或非合约", async function () {
      const F = await ethers.getContractFactory("AgentryFaucet");
      const r = await router.getAddress();
      await expect(F.deploy(owner.address, ethers.ZeroAddress, r)).to.be.revertedWithCustomError(F, "ZeroAddress");
      await expect(F.deploy(owner.address, alice.address, r)).to.be.revertedWithCustomError(F, "NotAContract");
      await expect(F.deploy(owner.address, await aid.getAddress(), ethers.ZeroAddress)).to.be.revertedWithCustomError(F, "ZeroRouter");
    });

    it("只有 owner 能绑定挂牌号；别人不能把水龙头挂到自己名下", async function () {
      await expect(faucet.connect(alice).setListing(5)).to.be.revertedWithCustomError(faucet, "OwnableUnauthorizedAccount");
      await expect(router.connect(alice).createServiceListing(await faucet.getAddress(), SPEC_URI, SPEC_HASH))
        .to.be.revertedWithCustomError(router, "NotServiceProvider");
    });

    it("不能绕过路由直接领", async function () {
      await ready();
      await expect(faucet.connect(alice).fulfill(id, alice.address, "0x")).to.be.revertedWithCustomError(faucet, "OnlyRouter");
    });

    it("没设代币、没设数量时不能领，预检给出原因", async function () {
      await expect(claim(alice)).to.be.revertedWithCustomError(faucet, "TokenNotSet");
      expect((await router.canUse(id, alice.address, "0x"))[1]).to.equal("token not set");
      await f().setToken(await tok.getAddress());
      await expect(claim(alice)).to.be.revertedWithCustomError(faucet, "AmountNotSet");
    });
  });

  describe("领取", function () {
    beforeEach(() => ready());

    it("领到固定数量，同时市场里多一张已完成的订单", async function () {
      await expect(claim(alice)).to.emit(faucet, "Claimed").withArgs(alice.address, await tok.getAddress(), E(100));
      expect(await tok.balanceOf(alice.address)).to.equal(E(100));
      expect(await faucet.remaining()).to.equal(E(900));
      const t = await market.getTask(1);
      expect(t.publisher).to.equal(alice.address);
      expect(t.provider).to.equal(owner.address);
      expect(t.state).to.equal(5n);
      expect(await market.serviceStatsOf(id)).to.deep.equal([1n, 1n]);
    });

    it("领完可以评价", async function () {
      await claim(alice);
      await market.connect(alice).review(1, 5, "data:,thanks");
      expect((await market.statsOf(owner.address))[0]).to.equal(1n);
    });

    it("没有 Agent ID 不能领", async function () {
      await expect(claim(nobody)).to.be.revertedWithCustomError(market, "NotAgent");
      expect((await router.canUse(id, nobody.address, "0x"))[1]).to.equal("no Agent ID");
    });

    it("默认规则下同一个 Agent ID 只能领一次，失败时不留订单", async function () {
      await claim(alice);
      await expect(claim(alice)).to.be.revertedWithCustomError(faucet, "LimitReached");
      await time.increase(365 * DAY);
      await expect(claim(alice)).to.be.revertedWithCustomError(faucet, "LimitReached");
      expect(await market.taskCount()).to.equal(1n);
      expect((await router.canUse(id, alice.address, "0x"))[1]).to.equal("claim limit reached");
    });

    it("余额不够时拒绝", async function () {
      await f().setClaimAmount(E(600));
      await claim(alice);
      await expect(claim(bob)).to.be.revertedWithCustomError(faucet, "InsufficientBalance");
      expect((await router.canUse(id, bob.address, "0x"))[1]).to.equal("faucet is empty");
    });

    it("统计：总发放、领取人数、领取次数", async function () {
      await claim(alice);
      await claim(bob);
      const i = await faucet.info();
      expect(i.totalClaimed_).to.equal(E(200));
      expect(i.claimers_).to.equal(2);
      expect(i.claimCount_).to.equal(2);
      expect(await market.serviceStatsOf(id)).to.deep.equal([2n, 2n]);
    });

    it("暂停后不能领，恢复后可以", async function () {
      await f().pause();
      await expect(claim(alice)).to.be.revertedWithCustomError(faucet, "EnforcedPause");
      expect((await router.canUse(id, alice.address, "0x"))[1]).to.equal("paused");
      await f().unpause();
      await claim(alice);
    });

    it("市场下架后不能领", async function () {
      await market.connect(owner).updateListing(id, 0, 0, false);
      await expect(claim(alice)).to.be.revertedWithCustomError(market, "ListingInactive");
    });
  });

  describe("可配置的领取次数", function () {
    beforeEach(() => ready());

    it("能领多次时必须设冷却", async function () {
      await expect(f().setClaimRule(3, 0)).to.be.revertedWithCustomError(faucet, "BadRule");
      await expect(f().setClaimRule(0, 0)).to.be.revertedWithCustomError(faucet, "BadRule");
      await expect(f().setClaimRule(1, 366 * DAY)).to.be.revertedWithCustomError(faucet, "BadRule");
    });

    it("最多 3 次、每 7 天一次", async function () {
      await f().setClaimRule(3, 7 * DAY);
      await claim(alice);
      await expect(claim(alice)).to.be.revertedWithCustomError(faucet, "CoolingDown");
      expect((await router.canUse(id, alice.address, "0x"))[1]).to.equal("cooling down");
      await time.increase(7 * DAY);
      await claim(alice);
      await time.increase(7 * DAY);
      await claim(alice);
      await time.increase(7 * DAY);
      await expect(claim(alice)).to.be.revertedWithCustomError(faucet, "LimitReached");
      expect(await market.serviceStatsOf(id)).to.deep.equal([3n, 1n]);
    });

    it("不限次数、每天一次", async function () {
      await f().setClaimRule(0, DAY);
      for (let i = 0; i < 5; i++) {
        await claim(alice);
        await time.increase(DAY);
      }
      expect(await tok.balanceOf(alice.address)).to.equal(E(500));
    });
  });

  describe("更换代币", function () {
    it("换成新代币后按新代币重新算；旧代币可以取回", async function () {
      await ready();
      await claim(alice);
      const tok2 = await (await ethers.getContractFactory("MockERC20")).deploy("New", "NEW");
      await tok2.mint(await faucet.getAddress(), E(1000));
      await f().setToken(await tok2.getAddress());
      await claim(alice);
      expect(await tok2.balanceOf(alice.address)).to.equal(E(100));
      await f().withdraw(await tok.getAddress(), E(900));
      expect(await tok.balanceOf(owner.address)).to.equal(E(900));
    });
  });

  describe("转账收税的代币", function () {
    it("按领取人实际到账记账", async function () {
      const tax = await (await ethers.getContractFactory("MockTaxToken")).deploy();
      await tax.mint(await faucet.getAddress(), E(1000));
      await f().setToken(await tax.getAddress());
      await f().setClaimAmount(E(100));
      await claim(alice);
      expect(await tax.balanceOf(alice.address)).to.equal(E(97));
      expect(await faucet.totalClaimed(await tax.getAddress())).to.equal(E(97));
    });
  });

  describe("权限", function () {
    beforeEach(() => ready());

    it("非 owner 不能改任何配置，也不能取币", async function () {
      const x = faucet.connect(alice);
      await expect(x.setToken(await tok.getAddress())).to.be.revertedWithCustomError(faucet, "OwnableUnauthorizedAccount");
      await expect(x.setClaimAmount(1)).to.be.revertedWithCustomError(faucet, "OwnableUnauthorizedAccount");
      await expect(x.setClaimRule(0, DAY)).to.be.revertedWithCustomError(faucet, "OwnableUnauthorizedAccount");
      await expect(x.pause()).to.be.revertedWithCustomError(faucet, "OwnableUnauthorizedAccount");
      await expect(x.withdraw(await tok.getAddress(), 1)).to.be.revertedWithCustomError(faucet, "OwnableUnauthorizedAccount");
    });

    it("不能放弃所有权；转移所有权要新 owner 确认", async function () {
      await expect(f().renounceOwnership()).to.be.revertedWithCustomError(faucet, "BadRule");
      await f().transferOwnership(bob.address);
      expect(await faucet.owner()).to.equal(owner.address);
      await faucet.connect(bob).acceptOwnership();
      expect(await faucet.agentryProvider()).to.equal(bob.address);
    });

    it("声明支持 IAgentryService 接口", async function () {
      expect(await faucet.supportsInterface("0x01ffc9a7")).to.equal(true);
    });
  });
});
