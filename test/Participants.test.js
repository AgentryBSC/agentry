const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  SPEC_URI, SPEC_HASH, INPUT_URI, RESULT_URI, PROFILE_URI, NATIVE, HOUR, Side,
  deployAgentry, publishTask, taskInDispute, castVote, createListing,
} = require("./fixtures");

/// 全站统计：参与者、服务方、在售挂牌都在合约里按地址去重计数，页面只读这几个数
describe("全站统计计数器", function () {
  it("初始都是 0", async function () {
    const { market } = await deployAgentry();
    expect(await market.participantCount()).to.equal(0n);
    expect(await market.providerCount()).to.equal(0n);
    expect(await market.activeListingCount()).to.equal(0n);
  });

  it("同一个地址做多少事都只算一个参与者", async function () {
    const { market, provider } = await deployAgentry();
    await market.connect(provider).register(PROFILE_URI);
    await createListing(market, provider);
    await createListing(market, provider);
    expect(await market.participantCount()).to.equal(1n);
    expect(await market.providerCount()).to.equal(1n);
    expect(await market.participated(provider.address)).to.equal(true);
  });

  it("下单、发任务、认领、交付都计入；买方不算服务方", async function () {
    const { market, publisher, provider, j1 } = await deployAgentry();
    const id = await createListing(market, provider);
    await market.connect(publisher).createOrder(id, INPUT_URI);
    expect(await market.participantCount()).to.equal(2n);
    expect(await market.providerCount()).to.equal(1n);

    const taskId = await publishTask(market, j1);
    expect(await market.participantCount()).to.equal(3n);
    await market.connect(publisher).claimTask(taskId);
    await market.connect(publisher).submitResult(taskId, RESULT_URI);
    expect(await market.participantCount()).to.equal(3n); // publisher 早已计入
  });

  it("认领任务的服务方计入", async function () {
    const { market, publisher, j2 } = await deployAgentry();
    const taskId = await publishTask(market, publisher);
    await market.connect(j2).claimTask(taskId);
    expect(await market.participated(j2.address)).to.equal(true);
    await market.connect(j2).submitResult(taskId, RESULT_URI);
    expect(await market.participantCount()).to.equal(2n);
  });

  it("陪审员投票时计入", async function () {
    const { market, jury, publisher, provider, j1, j2 } = await deployAgentry();
    const { disputeId } = await taskInDispute(market, jury, publisher, provider);
    expect(await market.participantCount()).to.equal(2n);
    await castVote(jury, j1, disputeId, Side.Provider);
    await castVote(jury, j2, disputeId, Side.Publisher);
    expect(await market.participantCount()).to.equal(4n);
    expect(await market.participated(j1.address)).to.equal(true);
  });

  it("只有陪审合约能报告参与者", async function () {
    const { market, publisher } = await deployAgentry();
    await expect(market.connect(publisher).noteParticipant(publisher.address))
      .to.be.revertedWithCustomError(market, "OnlyJury");
  });

  it("在售挂牌数随上下架、强制下架变化", async function () {
    const { market, owner, provider } = await deployAgentry();
    await createListing(market, provider);
    await market.connect(provider).createFreeListing(provider.address, SPEC_URI, SPEC_HASH);
    expect(await market.activeListingCount()).to.equal(2n);
    await market.connect(provider).updateListing(1, 0, HOUR, false);
    expect(await market.activeListingCount()).to.equal(1n);
    await market.connect(provider).updateListing(1, 0, HOUR, false); // 重复下架不重复扣
    expect(await market.activeListingCount()).to.equal(1n);
    await market.connect(provider).updateListing(1, 0, HOUR, true);
    expect(await market.activeListingCount()).to.equal(2n);
    await market.connect(owner).delist(2);
    expect(await market.activeListingCount()).to.equal(1n);
    await market.connect(owner).delist(2); // 已下架的再强制下架不重复扣
    expect(await market.activeListingCount()).to.equal(1n);
  });

  it("合约交付：使用者计入，服务方经路由挂牌也计入服务方", async function () {
    const { market, agentId, owner, provider, publisher } = await deployAgentry();
    const router = await (await ethers.getContractFactory("AgentryServiceRouter")).deploy(
      await market.getAddress(), await agentId.getAddress());
    await market.connect(owner).setServiceRouter(await router.getAddress());
    const svc = await (await ethers.getContractFactory("MockService")).deploy(await router.getAddress(), provider.address);
    await router.connect(provider).createServiceListing(await svc.getAddress(), SPEC_URI, SPEC_HASH);
    await svc.bind(1);
    expect(await market.providerCount()).to.equal(1n);
    expect(await market.activeListingCount()).to.equal(1n);
    await router.connect(publisher).use(1, "0x");
    await router.connect(publisher).use(1, "0x");
    expect(await market.participantCount()).to.equal(2n);
  });

  it("交易失败时不计数", async function () {
    const { market, outsider } = await deployAgentry();
    await expect(market.connect(outsider).register(PROFILE_URI)).to.be.revertedWithCustomError(market, "NotAgent");
    expect(await market.participantCount()).to.equal(0n);
  });
});
