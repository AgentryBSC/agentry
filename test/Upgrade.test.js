const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { NATIVE, PARAMS, DAY, SPEC_URI, SPEC_HASH, deployProxy } = require("./fixtures");

const DELAY = 48 * 3600;

/// 与主网一致的部署：时间锁持有升级权，owner 只管参数与暂停
async function deployWithTimelock() {
  const [owner, publisher, provider, stranger] = await ethers.getSigners();
  const agentId = await (await ethers.getContractFactory("MockAgentId")).deploy();
  const usdt = await (await ethers.getContractFactory("MockERC20")).deploy("BSC-USD", "USDT");
  const timelock = await (await ethers.getContractFactory("TimelockController")).deploy(
    DELAY, [owner.address], [owner.address], ethers.ZeroAddress
  );
  const tl = await timelock.getAddress();
  const market = await deployProxy("AgentMarket", [await agentId.getAddress(), await usdt.getAddress()], "initialize", [
    owner.address, tl, PARAMS.maxNative, PARAMS.maxToken, PARAMS.claimWindow, PARAMS.reviewWindow,
    PARAMS.minDelivery, PARAMS.maxDelivery, PARAMS.juryFeeBps,
  ]);
  const jury = await deployProxy("AgentJury", [await agentId.getAddress(), await usdt.getAddress(), await market.getAddress()], "initialize", [
    owner.address, tl, PARAMS.votingWindow, PARAMS.quorum, PARAMS.stakeNative, PARAMS.stakeToken,
  ]);
  await market.setJury(await jury.getAddress());
  await agentId.mint(provider.address);
  return { owner, publisher, provider, stranger, agentId, usdt, timelock, market, jury };
}

/// 新实现：同样的不可变地址，换一份字节码（这里用同一个合约重新部署代替）
async function newMarketImpl(ctx) {
  const F = await ethers.getContractFactory("AgentMarket");
  const impl = await F.deploy(await ctx.agentId.getAddress(), await ctx.usdt.getAddress());
  return impl.getAddress();
}

async function implOf(proxy) {
  const slot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  const raw = await ethers.provider.getStorage(await proxy.getAddress(), slot);
  return ethers.getAddress("0x" + raw.slice(26));
}

describe("可升级与时间锁", function () {
  it("代理初始化后参数正确，升级权在时间锁，owner 是部署钱包", async function () {
    const { owner, market, jury, timelock } = await deployWithTimelock();
    expect(await market.owner()).to.equal(owner.address);
    expect(await market.upgrader()).to.equal(await timelock.getAddress());
    expect(await jury.upgrader()).to.equal(await timelock.getAddress());
    expect(await market.minDelivery()).to.equal(BigInt(PARAMS.minDelivery));
    expect(await jury.market()).to.equal(await market.getAddress());
  });

  it("代理不能重复初始化，实现合约本身不能被初始化", async function () {
    const ctx = await deployWithTimelock();
    const { owner, market } = ctx;
    await expect(market.initialize(owner.address, owner.address, 1, 1, 1, 1, 1, 1, 0))
      .to.be.revertedWithCustomError(market, "InvalidInitialization");
    const impl = (await ethers.getContractFactory("AgentMarket")).attach(await implOf(market));
    await expect(impl.initialize(owner.address, owner.address, 1, 1, 1, 1, 1, 1, 0))
      .to.be.revertedWithCustomError(market, "InvalidInitialization");
  });

  it("owner 和旁人都不能直接升级", async function () {
    const ctx = await deployWithTimelock();
    const { owner, stranger, market, jury } = ctx;
    const impl = await newMarketImpl(ctx);
    await expect(market.connect(owner).upgradeToAndCall(impl, "0x")).to.be.revertedWithCustomError(market, "NotUpgrader");
    await expect(market.connect(stranger).upgradeToAndCall(impl, "0x")).to.be.revertedWithCustomError(market, "NotUpgrader");
    await expect(jury.connect(owner).upgradeToAndCall(impl, "0x")).to.be.revertedWithCustomError(jury, "NotUpgrader");
  });

  it("经时间锁升级：排队后 48 小时内不能执行，到期后可以，数据保留", async function () {
    const ctx = await deployWithTimelock();
    const { owner, provider, market, timelock } = ctx;

    // 升级前写一条数据
    await market.connect(provider).createListing(0, NATIVE, 3600, SPEC_URI, SPEC_HASH);

    const impl = await newMarketImpl(ctx);
    const data = market.interface.encodeFunctionData("upgradeToAndCall", [impl, "0x"]);
    const target = await market.getAddress();
    const salt = ethers.id("upgrade-1");
    await timelock.connect(owner).schedule(target, 0, data, ethers.ZeroHash, salt, DELAY);

    await expect(timelock.connect(owner).execute(target, 0, data, ethers.ZeroHash, salt))
      .to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");

    await time.increase(DELAY + 1);
    await timelock.connect(owner).execute(target, 0, data, ethers.ZeroHash, salt);

    expect(await implOf(market)).to.equal(impl);
    expect(await market.listingCount()).to.equal(1n);
    expect((await market.getListing(1)).provider).to.equal(provider.address);
    expect(await market.owner()).to.equal(owner.address);
  });

  it("时间锁的延迟不能被跳过：排队时延迟短于 48 小时会被拒绝", async function () {
    const ctx = await deployWithTimelock();
    const { owner, market, timelock } = ctx;
    const impl = await newMarketImpl(ctx);
    const data = market.interface.encodeFunctionData("upgradeToAndCall", [impl, "0x"]);
    await expect(timelock.connect(owner).schedule(await market.getAddress(), 0, data, ethers.ZeroHash, ethers.ZeroHash, DELAY - 1))
      .to.be.revertedWithCustomError(timelock, "TimelockInsufficientDelay");
  });

  it("只有时间锁的提议人能排队", async function () {
    const ctx = await deployWithTimelock();
    const { stranger, market, timelock } = ctx;
    const impl = await newMarketImpl(ctx);
    const data = market.interface.encodeFunctionData("upgradeToAndCall", [impl, "0x"]);
    await expect(timelock.connect(stranger).schedule(await market.getAddress(), 0, data, ethers.ZeroHash, ethers.ZeroHash, DELAY))
      .to.be.revertedWithCustomError(timelock, "AccessControlUnauthorizedAccount");
  });

  it("升级权转交只能由 upgrader 发起", async function () {
    const ctx = await deployWithTimelock();
    const { owner, stranger, market } = ctx;
    await expect(market.connect(owner).setUpgrader(stranger.address)).to.be.revertedWithCustomError(market, "NotUpgrader");
  });

  it("owner 仍然可以暂停和调参，不经过升级时间锁", async function () {
    const { owner, market } = await deployWithTimelock();
    await market.connect(owner).pause();
    expect(await market.paused()).to.equal(true);
    await market.connect(owner).unpause();
    await market.connect(owner).proposeParams(
      PARAMS.maxNative, PARAMS.maxToken, PARAMS.claimWindow, PARAMS.reviewWindow, DAY, PARAMS.maxDelivery, PARAMS.juryFeeBps
    );
  });
});
