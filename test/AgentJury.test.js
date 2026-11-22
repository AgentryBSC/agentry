const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const {
  USDT, BNB, NATIVE, HOUR, PARAMS, REASON_URI,
  State, Verdict, Side, pay,
  deployAgentry, taskInDispute, taskAwaitingReview, castVote,
} = require("./fixtures");

describe("AgentJury", function () {
  describe("开庭", function () {
    it("只有 market 能开庭", async function () {
      const { jury, publisher, provider, j1 } = await loadFixture(deployAgentry);

      await expect(
        jury
          .connect(j1)
          .openDispute(1, publisher.address, provider.address, NATIVE, USDT("10"))
      ).to.be.revertedWithCustomError(jury, "OnlyMarket");
    });

    it("拒收会开庭并记录双方", async function () {
      const { market, jury, publisher, provider } = await loadFixture(deployAgentry);
      const { taskId, disputeId } = await taskInDispute(market, jury, publisher, provider);

      expect((await market.getTask(taskId)).state).to.equal(State.Disputed);

      const d = await jury.getDispute(disputeId);
      expect(d.taskId).to.equal(taskId);
      expect(d.publisher).to.equal(publisher.address);
      expect(d.provider).to.equal(provider.address);
      expect(d.taskAmount).to.equal(USDT("10"));
      expect(d.stake).to.equal(PARAMS.stakeToken);
      expect(d.settled).to.equal(false);
    });

    it("同一任务不能开两次庭", async function () {
      const { market, jury, publisher, provider } = await loadFixture(deployAgentry);
      const { taskId } = await taskInDispute(market, jury, publisher, provider);

      // 任务已进入 Disputed，再次拒收会先被状态检查拦住
      await expect(
        market.connect(publisher).rejectResult(taskId, REASON_URI)
      ).to.be.revertedWithCustomError(market, "BadState");
    });
  });

  describe("投票", function () {
    it("一个 Agent ID 只能投一票", async function () {
      const { market, jury, publisher, provider, j1 } = await loadFixture(deployAgentry);
      const { disputeId } = await taskInDispute(market, jury, publisher, provider);

      await jury.connect(j1).vote(disputeId, Side.Provider);

      await expect(
        jury.connect(j1).vote(disputeId, Side.Publisher)
      ).to.be.revertedWithCustomError(jury, "AlreadyVoted");
    });

    it("任务双方不能投票", async function () {
      const { market, jury, publisher, provider } = await loadFixture(deployAgentry);
      const { disputeId } = await taskInDispute(market, jury, publisher, provider);

      await expect(
        jury.connect(publisher).vote(disputeId, Side.Publisher)
      ).to.be.revertedWithCustomError(jury, "PartyCannotVote");

      await expect(
        jury.connect(provider).vote(disputeId, Side.Provider)
      ).to.be.revertedWithCustomError(jury, "PartyCannotVote");
    });

    it("无 Agent ID 不能投票", async function () {
      const { market, jury, publisher, provider, outsider } = await loadFixture(deployAgentry);
      const { disputeId } = await taskInDispute(market, jury, publisher, provider);

      await expect(
        jury.connect(outsider).vote(disputeId, Side.Provider)
      ).to.be.revertedWithCustomError(jury, "NotAgent");
    });

    it("投票时扣押金", async function () {
      const { market, jury, juryAddr, usdt, publisher, provider, j1 } =
        await loadFixture(deployAgentry);
      const { disputeId } = await taskInDispute(market, jury, publisher, provider);

      const before = await usdt.balanceOf(j1.address);
      await jury.connect(j1).vote(disputeId, Side.Provider);

      expect(before - (await usdt.balanceOf(j1.address))).to.equal(PARAMS.stakeToken);
      expect(await usdt.balanceOf(juryAddr)).to.equal(PARAMS.stakeToken);
    });

    it("窗口结束后不能投票", async function () {
      const { market, jury, publisher, provider, j1 } = await loadFixture(deployAgentry);
      const { disputeId } = await taskInDispute(market, jury, publisher, provider);

      await time.increase(PARAMS.votingWindow + 1);

      await expect(
        jury.connect(j1).vote(disputeId, Side.Provider)
      ).to.be.revertedWithCustomError(jury, "VotingClosed");
    });

    it("不能投 None", async function () {
      const { market, jury, publisher, provider, j1 } = await loadFixture(deployAgentry);
      const { disputeId } = await taskInDispute(market, jury, publisher, provider);

      await expect(
        jury.connect(j1).vote(disputeId, Side.None)
      ).to.be.revertedWithCustomError(jury, "BadSide");
    });
  });

  describe("裁决：多数支持服务方", function () {
    it("服务方拿 95%，陪审分 5%", async function () {
      const { market, jury, usdt, publisher, provider, j1, j2, j3, j4 } =
        await loadFixture(deployAgentry);
      const { taskId, disputeId } = await taskInDispute(
        market, jury, publisher, provider, USDT("10")
      );

      await jury.connect(j1).vote(disputeId, Side.Provider);
      await jury.connect(j2).vote(disputeId, Side.Provider);
      await jury.connect(j3).vote(disputeId, Side.Provider);
      await jury.connect(j4).vote(disputeId, Side.Publisher);

      await time.increase(PARAMS.votingWindow + 1);

      const before = await usdt.balanceOf(provider.address);
      await jury.settle(disputeId);

      // 10 USDT 的 5% 是 0.5，服务方拿 9.5
      expect((await usdt.balanceOf(provider.address)) - before).to.equal(USDT("9.5"));
      expect((await market.getTask(taskId)).state).to.equal(State.Completed);

      const d = await jury.getDispute(disputeId);
      expect(d.verdict).to.equal(Verdict.ForProvider);
      expect(d.votesForProvider).to.equal(3n);
      expect(d.votesForPublisher).to.equal(1n);
      // 奖励池 = 陪审费 0.5 + 少数方被没收的 1 枚押金
      expect(d.rewardPool).to.equal(USDT("1.5"));
    });

    it("账目必须平：陪审合约收到的钱刚好发完", async function () {
      // 这是整套结算数学的核心校验。合约持有 4 枚押金 + 0.5 陪审费 = 4.5，
      // 三名多数方每人拿 押金 1 + 奖励池 1.5/3 = 1.5，合计 4.5
      const { market, jury, juryAddr, usdt, publisher, provider, j1, j2, j3, j4 } =
        await loadFixture(deployAgentry);
      const { disputeId } = await taskInDispute(
        market, jury, publisher, provider, USDT("10")
      );

      await jury.connect(j1).vote(disputeId, Side.Provider);
      await jury.connect(j2).vote(disputeId, Side.Provider);
      await jury.connect(j3).vote(disputeId, Side.Provider);
      await jury.connect(j4).vote(disputeId, Side.Publisher);

      await time.increase(PARAMS.votingWindow + 1);
      await jury.settle(disputeId);

      expect(await usdt.balanceOf(juryAddr)).to.equal(USDT("4.5"));

      for (const j of [j1, j2, j3]) {
        const before = await usdt.balanceOf(j.address);
        await jury.claimJurorPayout(disputeId, j.address);
        expect((await usdt.balanceOf(j.address)) - before).to.equal(USDT("1.5"));
      }

      // 少数方领到 0
      const beforeLoser = await usdt.balanceOf(j4.address);
      await jury.claimJurorPayout(disputeId, j4.address);
      expect(await usdt.balanceOf(j4.address)).to.equal(beforeLoser);

      // 全部领完后合约清零，一分不多一分不少
      expect(await usdt.balanceOf(juryAddr)).to.equal(0n);
    });

    it("胜负计入陪审信誉", async function () {
      const { market, jury, publisher, provider, j1, j2, j3, j4 } =
        await loadFixture(deployAgentry);
      const { disputeId } = await taskInDispute(market, jury, publisher, provider);

      await jury.connect(j1).vote(disputeId, Side.Provider);
      await jury.connect(j2).vote(disputeId, Side.Provider);
      await jury.connect(j3).vote(disputeId, Side.Provider);
      await jury.connect(j4).vote(disputeId, Side.Publisher);

      await time.increase(PARAMS.votingWindow + 1);
      await jury.settle(disputeId);

      await jury.claimJurorPayout(disputeId, j1.address);
      await jury.claimJurorPayout(disputeId, j4.address);

      const winner = await jury.jurorRecordOf(j1.address);
      expect(winner.majority).to.equal(1n);
      expect(winner.minority).to.equal(0n);

      const loser = await jury.jurorRecordOf(j4.address);
      expect(loser.majority).to.equal(0n);
      expect(loser.minority).to.equal(1n);
    });

    it("任务双方的争议胜负也被记录", async function () {
      const { market, jury, publisher, provider, j1, j2, j3 } =
        await loadFixture(deployAgentry);
      const { disputeId } = await taskInDispute(market, jury, publisher, provider);

      await jury.connect(j1).vote(disputeId, Side.Provider);
      await jury.connect(j2).vote(disputeId, Side.Provider);
      await jury.connect(j3).vote(disputeId, Side.Provider);

      await time.increase(PARAMS.votingWindow + 1);
      await jury.settle(disputeId);

      expect((await market.reputationOf(provider.address)).disputesWon).to.equal(1n);
      expect((await market.reputationOf(publisher.address)).disputesLost).to.equal(1n);
    });
  });

  describe("裁决：多数支持发布方", function () {
    it("发布方拿回 95%", async function () {
      const { market, jury, usdt, publisher, provider, j1, j2, j3 } =
        await loadFixture(deployAgentry);
      const { taskId, disputeId } = await taskInDispute(
        market, jury, publisher, provider, USDT("10")
      );

      await jury.connect(j1).vote(disputeId, Side.Publisher);
      await jury.connect(j2).vote(disputeId, Side.Publisher);
      await jury.connect(j3).vote(disputeId, Side.Publisher);

      await time.increase(PARAMS.votingWindow + 1);

      const before = await usdt.balanceOf(publisher.address);
      await jury.settle(disputeId);

      expect((await usdt.balanceOf(publisher.address)) - before).to.equal(USDT("9.5"));
      expect((await market.getTask(taskId)).state).to.equal(State.Refunded);
      expect((await market.reputationOf(publisher.address)).disputesWon).to.equal(1n);
      expect((await market.reputationOf(provider.address)).disputesLost).to.equal(1n);
    });
  });

  describe("裁决：未形成多数", function () {
    it("票数不足法定数 → 对半分，不收陪审费", async function () {
      const { market, jury, usdt, publisher, provider, j1, j2 } =
        await loadFixture(deployAgentry);
      const { taskId, disputeId } = await taskInDispute(
        market, jury, publisher, provider, USDT("10")
      );

      // 只有 2 票，法定数是 3
      await jury.connect(j1).vote(disputeId, Side.Provider);
      await jury.connect(j2).vote(disputeId, Side.Provider);

      await time.increase(PARAMS.votingWindow + 1);

      const pubBefore = await usdt.balanceOf(publisher.address);
      const provBefore = await usdt.balanceOf(provider.address);
      await jury.settle(disputeId);

      expect((await usdt.balanceOf(publisher.address)) - pubBefore).to.equal(USDT("5"));
      expect((await usdt.balanceOf(provider.address)) - provBefore).to.equal(USDT("5"));
      expect((await market.getTask(taskId)).state).to.equal(State.Split);

      const d = await jury.getDispute(disputeId);
      expect(d.verdict).to.equal(Verdict.NoQuorum);
      expect(d.rewardPool).to.equal(0n); // 不收陪审费
    });

    it("平票 → 同样对半分", async function () {
      // 2:2 共 4 票，达到了法定数，但没有多数。多数决要求真的存在多数
      const { market, jury, usdt, publisher, provider, j1, j2, j3, j4 } =
        await loadFixture(deployAgentry);
      const { taskId, disputeId } = await taskInDispute(
        market, jury, publisher, provider, USDT("10")
      );

      await jury.connect(j1).vote(disputeId, Side.Provider);
      await jury.connect(j2).vote(disputeId, Side.Provider);
      await jury.connect(j3).vote(disputeId, Side.Publisher);
      await jury.connect(j4).vote(disputeId, Side.Publisher);

      await time.increase(PARAMS.votingWindow + 1);

      const pubBefore = await usdt.balanceOf(publisher.address);
      const provBefore = await usdt.balanceOf(provider.address);
      await jury.settle(disputeId);

      expect((await usdt.balanceOf(publisher.address)) - pubBefore).to.equal(USDT("5"));
      expect((await usdt.balanceOf(provider.address)) - provBefore).to.equal(USDT("5"));
      expect((await market.getTask(taskId)).state).to.equal(State.Split);
      expect((await jury.getDispute(disputeId)).verdict).to.equal(Verdict.NoQuorum);
    });

    it("未形成多数时押金全退，且不计胜负", async function () {
      const { market, jury, juryAddr, usdt, publisher, provider, j1, j2 } =
        await loadFixture(deployAgentry);
      const { disputeId } = await taskInDispute(market, jury, publisher, provider);

      await jury.connect(j1).vote(disputeId, Side.Provider);
      await jury.connect(j2).vote(disputeId, Side.Publisher);

      await time.increase(PARAMS.votingWindow + 1);
      await jury.settle(disputeId);

      for (const j of [j1, j2]) {
        const before = await usdt.balanceOf(j.address);
        await jury.claimJurorPayout(disputeId, j.address);
        expect((await usdt.balanceOf(j.address)) - before).to.equal(PARAMS.stakeToken);

        const rec = await jury.jurorRecordOf(j.address);
        expect(rec.majority).to.equal(0n);
        expect(rec.minority).to.equal(0n);
      }

      expect(await usdt.balanceOf(juryAddr)).to.equal(0n);
    });

    it("零票也能结算，不会卡住资金", async function () {
      const { market, jury, usdt, publisher, provider } = await loadFixture(deployAgentry);
      const { taskId, disputeId } = await taskInDispute(
        market, jury, publisher, provider, USDT("10")
      );

      await time.increase(PARAMS.votingWindow + 1);

      const pubBefore = await usdt.balanceOf(publisher.address);
      await jury.settle(disputeId);

      expect((await usdt.balanceOf(publisher.address)) - pubBefore).to.equal(USDT("5"));
      expect((await market.getTask(taskId)).state).to.equal(State.Split);
    });
  });

  describe("结算与领取", function () {
    it("窗口未结束不能结算", async function () {
      const { market, jury, publisher, provider } = await loadFixture(deployAgentry);
      const { disputeId } = await taskInDispute(market, jury, publisher, provider);

      await expect(
        jury.settle(disputeId)
      ).to.be.revertedWithCustomError(jury, "VotingOpen");
    });

    it("任何地址都能触发结算", async function () {
      const { market, jury, publisher, provider, outsider } = await loadFixture(deployAgentry);
      const { disputeId } = await taskInDispute(market, jury, publisher, provider);

      await time.increase(PARAMS.votingWindow + 1);
      // 由没有 Agent ID 的无关地址触发
      await jury.connect(outsider).settle(disputeId);

      expect((await jury.getDispute(disputeId)).settled).to.equal(true);
    });

    it("不能重复结算", async function () {
      const { market, jury, publisher, provider } = await loadFixture(deployAgentry);
      const { disputeId } = await taskInDispute(market, jury, publisher, provider);

      await time.increase(PARAMS.votingWindow + 1);
      await jury.settle(disputeId);

      await expect(
        jury.settle(disputeId)
      ).to.be.revertedWithCustomError(jury, "AlreadySettled");
    });

    it("结算前不能领取", async function () {
      const { market, jury, publisher, provider, j1 } = await loadFixture(deployAgentry);
      const { disputeId } = await taskInDispute(market, jury, publisher, provider);

      await jury.connect(j1).vote(disputeId, Side.Provider);

      await expect(
        jury.claimJurorPayout(disputeId, j1.address)
      ).to.be.revertedWithCustomError(jury, "NotSettled");
    });

    it("没投票的人不能领取", async function () {
      const { market, jury, publisher, provider, j1, j2, j3, j4 } =
        await loadFixture(deployAgentry);
      const { disputeId } = await taskInDispute(market, jury, publisher, provider);

      await jury.connect(j1).vote(disputeId, Side.Provider);
      await jury.connect(j2).vote(disputeId, Side.Provider);
      await jury.connect(j3).vote(disputeId, Side.Provider);

      await time.increase(PARAMS.votingWindow + 1);
      await jury.settle(disputeId);

      await expect(
        jury.claimJurorPayout(disputeId, j4.address)
      ).to.be.revertedWithCustomError(jury, "DidNotVote");
    });

    it("不能重复领取", async function () {
      const { market, jury, publisher, provider, j1, j2, j3 } =
        await loadFixture(deployAgentry);
      const { disputeId } = await taskInDispute(market, jury, publisher, provider);

      await jury.connect(j1).vote(disputeId, Side.Provider);
      await jury.connect(j2).vote(disputeId, Side.Provider);
      await jury.connect(j3).vote(disputeId, Side.Provider);

      await time.increase(PARAMS.votingWindow + 1);
      await jury.settle(disputeId);
      await jury.claimJurorPayout(disputeId, j1.address);

      await expect(
        jury.claimJurorPayout(disputeId, j1.address)
      ).to.be.revertedWithCustomError(jury, "PositionAlreadySettled");
    });

    it("任何人可代少数方触发领取，把 minority 记录补齐", async function () {
      // 少数方押金被没收，没有任何领取动机。若只允许本人调用，
      // 他的 jurorMinority 就永远记不上
      const { market, jury, publisher, provider, j1, j2, j3, j4, outsider } =
        await loadFixture(deployAgentry);
      const { disputeId } = await taskInDispute(market, jury, publisher, provider);

      await jury.connect(j1).vote(disputeId, Side.Provider);
      await jury.connect(j2).vote(disputeId, Side.Provider);
      await jury.connect(j3).vote(disputeId, Side.Provider);
      await jury.connect(j4).vote(disputeId, Side.Publisher);

      await time.increase(PARAMS.votingWindow + 1);
      await jury.settle(disputeId);

      // 由无关地址代为触发
      await jury.connect(outsider).claimJurorPayout(disputeId, j4.address);

      expect((await jury.jurorRecordOf(j4.address)).minority).to.equal(1n);
    });

    it("代调用时款项仍发给陪审员本人", async function () {
      const { market, jury, usdt, publisher, provider, j1, j2, j3, outsider } =
        await loadFixture(deployAgentry);
      const { disputeId } = await taskInDispute(market, jury, publisher, provider);

      await jury.connect(j1).vote(disputeId, Side.Provider);
      await jury.connect(j2).vote(disputeId, Side.Provider);
      await jury.connect(j3).vote(disputeId, Side.Provider);

      await time.increase(PARAMS.votingWindow + 1);
      await jury.settle(disputeId);

      const jurorBefore = await usdt.balanceOf(j1.address);
      const callerBefore = await usdt.balanceOf(outsider.address);

      await jury.connect(outsider).claimJurorPayout(disputeId, j1.address);

      expect(await usdt.balanceOf(j1.address)).to.be.gt(jurorBefore);
      expect(await usdt.balanceOf(outsider.address)).to.equal(callerBefore);
    });

    it("payoutOf 在领取前后反映正确金额", async function () {
      const { market, jury, publisher, provider, j1, j2, j3, j4 } =
        await loadFixture(deployAgentry);
      const { disputeId } = await taskInDispute(market, jury, publisher, provider);

      await jury.connect(j1).vote(disputeId, Side.Provider);
      await jury.connect(j2).vote(disputeId, Side.Provider);
      await jury.connect(j3).vote(disputeId, Side.Provider);
      await jury.connect(j4).vote(disputeId, Side.Publisher);

      // 未结算时为 0
      expect(await jury.payoutOf(disputeId, j1.address)).to.equal(0n);

      await time.increase(PARAMS.votingWindow + 1);
      await jury.settle(disputeId);

      expect(await jury.payoutOf(disputeId, j1.address)).to.equal(USDT("1.5"));
      expect(await jury.payoutOf(disputeId, j4.address)).to.equal(0n);

      await jury.claimJurorPayout(disputeId, j1.address);
      expect(await jury.payoutOf(disputeId, j1.address)).to.equal(0n);
    });
  });

  describe("参数与权限", function () {
    it("押金在开庭时快照，后续改参数不影响已开庭的争议", async function () {
      const { market, jury, owner, publisher, provider } = await loadFixture(deployAgentry);
      const { disputeId: first } = await taskInDispute(market, jury, publisher, provider);

      expect((await jury.getDispute(first)).stake).to.equal(USDT("1"));

      await jury.connect(owner).proposeParams(
        PARAMS.votingWindow, PARAMS.quorum, PARAMS.stakeNative, USDT("2")
      );
      await time.increase(48 * HOUR);
      await jury.connect(owner).applyParams();

      expect(await jury.jurorStake(await jury.paymentToken())).to.equal(USDT("2"));
      // 老争议仍按开庭时的押金
      expect((await jury.getDispute(first)).stake).to.equal(USDT("1"));

      // 新争议用新押金
      const taskId = await taskAwaitingReview(market, publisher, provider);
      await market.connect(publisher).rejectResult(taskId, REASON_URI);
      const second = await jury.disputeIdOf(taskId);
      expect((await jury.getDispute(second)).stake).to.equal(USDT("2"));
    });

    it("参数变更需等满 48 小时", async function () {
      const { jury, owner } = await loadFixture(deployAgentry);

      await jury.connect(owner).proposeParams(24 * HOUR, 5, PARAMS.stakeNative, USDT("2"));

      await expect(
        jury.connect(owner).applyParams()
      ).to.be.revertedWithCustomError(jury, "TimelockNotElapsed");

      await time.increase(48 * HOUR);
      await jury.connect(owner).applyParams();

      expect(await jury.votingWindow()).to.equal(24n * 3600n);
      expect(await jury.quorum()).to.equal(5n);
    });

    it("owner 没有任何提取资金的入口", async function () {
      const { jury } = await loadFixture(deployAgentry);

      // claimPending 是例外，它只能把早已属于某人的滞留款发给本人
      const names = jury.interface.fragments
        .filter((f) => f.type === "function")
        .map((f) => f.name)
        .filter((n) => n !== "claimPending")
        .map((n) => n.toLowerCase());

      for (const forbidden of ["withdraw", "rescue", "sweep", "emergency", "drain", "recover"]) {
        expect(names.some((n) => n.includes(forbidden))).to.equal(false);
      }
    });

    it("只有陪审合约能调用 market.resolveDispute", async function () {
      const { market, publisher } = await loadFixture(deployAgentry);

      await expect(
        market.connect(publisher).resolveDispute(1, Verdict.ForProvider)
      ).to.be.revertedWithCustomError(market, "OnlyJury");
    });

    it("不存在的争议查询会 revert", async function () {
      const { jury } = await loadFixture(deployAgentry);

      await expect(
        jury.getDispute(999)
      ).to.be.revertedWithCustomError(jury, "DisputeNotFound");
    });
  });

  describe("取整零头", function () {
    it("奖励池除不尽时零头留在合约内，且上限是多数方人数的 wei 级", async function () {
      // 代码注释里声明过这个行为：零头无人可提取。任何提取入口都会变成
      // owner 对资金的权限，而权限披露里写的是 owner 无法提取任何资金。
      // 这里验证它确实只是几 wei，不是漏损
      const { market, jury, juryAddr, usdt, publisher, provider, j1, j2, j3 } =
        await loadFixture(deployAgentry);
      const { disputeId } = await taskInDispute(
        market, jury, publisher, provider, USDT("10")
      );

      // 3 票全站服务方，没有少数方押金进池 → 奖励池 = 0.5e18，除以 3 除不尽
      await jury.connect(j1).vote(disputeId, Side.Provider);
      await jury.connect(j2).vote(disputeId, Side.Provider);
      await jury.connect(j3).vote(disputeId, Side.Provider);

      await time.increase(PARAMS.votingWindow + 1);
      await jury.settle(disputeId);

      for (const j of [j1, j2, j3]) {
        await jury.claimJurorPayout(disputeId, j.address);
      }

      const dust = await usdt.balanceOf(juryAddr);
      expect(dust).to.be.gt(0n); // 确实有零头
      expect(dust).to.be.lt(3n); // 但不超过多数方人数
    });
  });

  describe("奇数金额的对半分", function () {
    it("对半分时零头归服务方，总额不丢", async function () {
      const { market, jury, marketAddr, usdt, publisher, provider } =
        await loadFixture(deployAgentry);

      // 故意用一个奇数 wei 的金额
      const odd = USDT("10") + 1n;
      await market
        .connect(publisher)
        .publishTask(
          "ipfs://spec",
          ethers.keccak256(ethers.toUtf8Bytes("s")),
          "ipfs://in",
          await market.paymentToken(),
          odd,
          PARAMS.minDelivery
        );
      const taskId = await market.taskCount();
      await market.connect(provider).claimTask(taskId);
      await market.connect(provider).submitResult(taskId, "ipfs://r");
      await market.connect(publisher).rejectResult(taskId, REASON_URI);
      const disputeId = await jury.disputeIdOf(taskId);

      await time.increase(PARAMS.votingWindow + 1);

      const pubBefore = await usdt.balanceOf(publisher.address);
      const provBefore = await usdt.balanceOf(provider.address);
      await jury.settle(disputeId);

      const toPub = (await usdt.balanceOf(publisher.address)) - pubBefore;
      const toProv = (await usdt.balanceOf(provider.address)) - provBefore;

      expect(toPub + toProv).to.equal(odd); // 一 wei 都没丢
      expect(toProv - toPub).to.equal(1n); // 零头归服务方
      expect(await usdt.balanceOf(marketAddr)).to.equal(0n);
    });
  });
});
