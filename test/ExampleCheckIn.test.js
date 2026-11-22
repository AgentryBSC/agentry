const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { SPEC_URI, SPEC_HASH, deployAgentry } = require("./fixtures");

/// 开发者文档里的示例服务：确保文档中的代码真的能编译、能挂牌、能用
describe("示例服务：每日签到（开发者文档）", function () {
  async function setup() {
    const ctx = await deployAgentry();
    const { market, agentId, owner, provider } = ctx;
    const router = await (await ethers.getContractFactory("AgentryServiceRouter")).deploy(
      await market.getAddress(), await agentId.getAddress());
    await market.connect(owner).setServiceRouter(await router.getAddress());
    const svc = await (await ethers.getContractFactory("AgentryCheckIn")).deploy(await router.getAddress(), provider.address);
    await router.connect(provider).createServiceListing(await svc.getAddress(), SPEC_URI, SPEC_HASH);
    const id = await market.listingCount();
    await svc.connect(provider).setListing(id);
    return { ...ctx, router, svc, id };
  }

  it("文档里的流程：部署 → 挂牌 → 绑定 → 使用", async function () {
    const { router, market, svc, publisher, id } = await setup();
    expect(await router.canUse(id, publisher.address, "0x")).to.deep.equal([true, ""]);
    await expect(router.connect(publisher).use(id, "0x")).to.emit(svc, "CheckedIn").withArgs(publisher.address, 1, 1);
    expect((await market.getTask(1)).state).to.equal(5n);
  });

  it("一天只能签一次，预检给出原因；第二天连续签到", async function () {
    const { router, svc, publisher, id } = await setup();
    await router.connect(publisher).use(id, "0x");
    await expect(router.connect(publisher).use(id, "0x")).to.be.revertedWithCustomError(svc, "AlreadyCheckedInToday");
    expect((await router.canUse(id, publisher.address, "0x"))[1]).to.equal("already checked in today");
    await time.increase(24 * 3600);
    await expect(router.connect(publisher).use(id, "0x")).to.emit(svc, "CheckedIn").withArgs(publisher.address, 2, 2);
  });

  it("只有服务方能绑定挂牌号", async function () {
    const { svc, publisher } = await setup();
    await expect(svc.connect(publisher).setListing(9)).to.be.revertedWithCustomError(svc, "OnlyProvider");
  });
});
