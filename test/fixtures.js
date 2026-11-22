const { ethers } = require("hardhat");

/// BSC 上的 USDT（BSC-USD）是 18 位小数
const USDT = (n) => ethers.parseEther(n);
const BNB = (n) => ethers.parseEther(n);

/// 原生币的币种标识
const NATIVE = ethers.ZeroAddress;

const DAY = 24 * 3600;
const HOUR = 3600;

const PARAMS = {
  maxNative: BNB("1"), // 单笔 BNB 任务上限
  maxToken: USDT("50"), // 单笔稳定币任务上限
  claimWindow: 7 * DAY,
  reviewWindow: 72 * HOUR,
  minDelivery: 1 * DAY,
  maxDelivery: 7 * DAY,
  juryFeeBps: 500, // 5%
  votingWindow: 48 * HOUR,
  quorum: 3,
  stakeNative: BNB("0.02"), // BNB 争议的单票押金
  stakeToken: USDT("1"), // 稳定币争议的单票押金
};

const SPEC_URI = "ipfs://spec-v1";
const SPEC_HASH = ethers.keccak256(ethers.toUtf8Bytes("spec-v1"));
const INPUT_URI = "ipfs://input";
const RESULT_URI = "ipfs://result";
const REASON_URI = "ipfs://reason";
const PROFILE_URI = "ipfs://profile";

const State = {
  None: 0n,
  Open: 1n,
  Assigned: 2n,
  Submitted: 3n,
  Disputed: 4n,
  Completed: 5n,
  Refunded: 6n,
  Split: 7n,
  Cancelled: 8n,
  Expired: 9n,
};

const Verdict = { None: 0n, ForProvider: 1n, ForPublisher: 2n, NoQuorum: 3n };
const Side = { None: 0, Provider: 1, Publisher: 2 };
const ListingKind = { Escrowed: 0n, Free: 1n };

/// 币种为原生币时附带 msg.value，否则不附带
const pay = (currency, amount) => (currency === NATIVE ? { value: amount } : {});

/// 该币种下的默认任务金额
const defaultAmount = (currency) => (currency === NATIVE ? BNB("0.1") : USDT("10"));

/// 部署实现合约和代理，返回挂在代理地址上的合约实例
async function deployProxy(name, ctorArgs, init, initArgs) {
  const F = await ethers.getContractFactory(name);
  const impl = await F.deploy(...ctorArgs);
  const data = F.interface.encodeFunctionData(init, initArgs);
  const proxy = await (await ethers.getContractFactory("ERC1967Proxy")).deploy(await impl.getAddress(), data);
  return F.attach(await proxy.getAddress());
}

async function deployAgentry() {
  const [owner, publisher, provider, j1, j2, j3, j4, outsider] = await ethers.getSigners();

  const agentId = await (await ethers.getContractFactory("MockAgentId")).deploy();
  const usdt = await (await ethers.getContractFactory("MockERC20")).deploy("BSC-USD", "USDT");

  // 和主网一样走 UUPS 代理：实现合约 + ERC1967Proxy，初始化在代理里做。
  // 测试里 upgrader 用 owner 账户，时间锁另有专门的测试
  const market = await deployProxy("AgentMarket", [await agentId.getAddress(), await usdt.getAddress()], "initialize", [
    owner.address,
    owner.address,
    PARAMS.maxNative,
    PARAMS.maxToken,
    PARAMS.claimWindow,
    PARAMS.reviewWindow,
    PARAMS.minDelivery,
    PARAMS.maxDelivery,
    PARAMS.juryFeeBps,
  ]);

  const jury = await deployProxy("AgentJury", [await agentId.getAddress(), await usdt.getAddress(), await market.getAddress()], "initialize", [
    owner.address,
    owner.address,
    PARAMS.votingWindow,
    PARAMS.quorum,
    PARAMS.stakeNative,
    PARAMS.stakeToken,
  ]);

  await market.setJury(await jury.getAddress());

  const marketAddr = await market.getAddress();
  const juryAddr = await jury.getAddress();
  const usdtAddr = await usdt.getAddress();

  // outsider 刻意不发 Agent ID，用来验证准入门
  const holders = [publisher, provider, j1, j2, j3, j4];
  for (const h of holders) {
    await agentId.mint(h.address);
    await usdt.mint(h.address, USDT("1000"));
    await usdt.connect(h).approve(marketAddr, USDT("1000"));
    await usdt.connect(h).approve(juryAddr, USDT("1000"));
  }
  await usdt.mint(outsider.address, USDT("1000"));
  await usdt.connect(outsider).approve(marketAddr, USDT("1000"));
  await usdt.connect(outsider).approve(juryAddr, USDT("1000"));

  return {
    owner, publisher, provider, j1, j2, j3, j4, outsider,
    agentId, usdt, usdtAddr, market, jury, marketAddr, juryAddr,
  };
}

/// 自由发布一个任务，返回 taskId
async function publishTask(market, publisher, amount, currency) {
  const cur = currency ?? (await market.paymentToken());
  const amt = amount ?? defaultAmount(cur);
  await market
    .connect(publisher)
    .publishTask(SPEC_URI, SPEC_HASH, INPUT_URI, cur, amt, PARAMS.minDelivery, pay(cur, amt));
  return await market.taskCount();
}

/// 发布 → 认领 → 提交，返回 taskId（停在待验收状态）
async function taskAwaitingReview(market, publisher, provider, amount, currency) {
  const taskId = await publishTask(market, publisher, amount, currency);
  await market.connect(provider).claimTask(taskId);
  await market.connect(provider).submitResult(taskId, RESULT_URI);
  return taskId;
}

/// 发布 → 认领 → 提交 → 拒收，返回 { taskId, disputeId }
async function taskInDispute(market, jury, publisher, provider, amount, currency) {
  const taskId = await taskAwaitingReview(market, publisher, provider, amount, currency);
  await market.connect(publisher).rejectResult(taskId, REASON_URI);
  const disputeId = await jury.disputeIdOf(taskId);
  return { taskId, disputeId };
}

/// 投票，自动按币种附带押金
async function castVote(jury, juror, disputeId, side) {
  const d = await jury.getDispute(disputeId);
  await jury.connect(juror).vote(disputeId, side, pay(d.currency, d.stake));
}

/// 创建一个付费挂牌，返回 listingId
async function createListing(market, provider, price, currency) {
  const cur = currency ?? (await market.paymentToken());
  const p = price ?? defaultAmount(cur);
  await market.connect(provider).createListing(p, cur, PARAMS.minDelivery, SPEC_URI, SPEC_HASH);
  return await market.listingCount();
}

module.exports = {
  USDT, BNB, NATIVE, DAY, HOUR, PARAMS,
  SPEC_URI, SPEC_HASH, INPUT_URI, RESULT_URI, REASON_URI, PROFILE_URI,
  State, Verdict, Side, ListingKind,
  pay, defaultAmount,
  deployProxy, deployAgentry, publishTask, taskAwaitingReview, taskInDispute, castVote, createListing,
};
