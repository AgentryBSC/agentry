const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const {
  PARAMS, State, Side,
  deployAgentry, publishTask, taskAwaitingReview, taskInDispute, castVote,
} = require("./fixtures");

const TEXT = "data:application/json;base64,eyJ0ZXh0Ijoi5Lqk5LuY5Y+K5pe2In0=";
const REPLY = "data:application/json;base64,eyJ0ZXh0Ijoi6LCi6LCiIn0=";

/// 发布 → 认领 → 提交 → 验收，返回 taskId（已完成）
async function completedTask(market, publisher, provider) {
  const id = await taskAwaitingReview(market, publisher, provider);
  await market.connect(publisher).acceptResult(id);
  return id;
}

describe("评价", function () {
  describe("谁能评、什么时候能评", function () {
    it("已完成的单，发布方可以评价，记录与汇总都写入", async function () {
      const { market, publisher, provider } = await loadFixture(deployAgentry);
      const id = await completedTask(market, publisher, provider);

      await expect(market.connect(publisher).review(id, 4, TEXT))
        .to.emit(market, "Reviewed").withArgs(id, provider.address, publisher.address, 4, TEXT);

      const r = await market.reviewOf(id);
      expect(r.reviewer).to.equal(publisher.address);
      expect(r.provider).to.equal(provider.address);
      expect(r.rating).to.equal(4);
      expect(r.uri).to.equal(TEXT);
      expect(r.replyURI).to.equal("");
      const [count, sum] = await market.statsOf(provider.address);
      expect(count).to.equal(1);
      expect(sum).to.equal(4);
    });

    it("服务方、其他持 ID 的人不能评；没有 Agent ID 的地址被准入门挡住", async function () {
      const { market, publisher, provider, j1, outsider } = await loadFixture(deployAgentry);
      const id = await completedTask(market, publisher, provider);
      await expect(market.connect(provider).review(id, 5, TEXT)).to.be.revertedWithCustomError(market, "NotPublisher");
      await expect(market.connect(j1).review(id, 5, TEXT)).to.be.revertedWithCustomError(market, "NotPublisher");
      await expect(market.connect(outsider).review(id, 5, TEXT)).to.be.revertedWithCustomError(market, "NotAgent");
    });

    it("进行中的单不能评：待认领、待交付、待验收", async function () {
      const { market, publisher, provider } = await loadFixture(deployAgentry);
      const open = await publishTask(market, publisher);
      await expect(market.connect(publisher).review(open, 5, TEXT)).to.be.revertedWithCustomError(market, "NotReviewable");

      await market.connect(provider).claimTask(open);
      await expect(market.connect(publisher).review(open, 5, TEXT)).to.be.revertedWithCustomError(market, "NotReviewable");

      await market.connect(provider).submitResult(open, "ipfs://result");
      await expect(market.connect(publisher).review(open, 5, TEXT)).to.be.revertedWithCustomError(market, "NotReviewable");
    });

    it("无人认领后撤回的单不能评（没有服务方参与）", async function () {
      const { market, publisher } = await loadFixture(deployAgentry);
      const id = await publishTask(market, publisher);
      await market.connect(publisher).cancelTask(id);
      expect((await market.getTask(id)).state).to.equal(State.Cancelled);
      await expect(market.connect(publisher).review(id, 1, TEXT)).to.be.revertedWithCustomError(market, "NotReviewable");
    });

    it("逾期未交付的单可以评，差评计入服务方", async function () {
      const { market, publisher, provider } = await loadFixture(deployAgentry);
      const id = await publishTask(market, publisher);
      await market.connect(provider).claimTask(id);
      await time.increase(PARAMS.minDelivery + 1);
      await market.settleDeliveryTimeout(id);
      expect((await market.getTask(id)).state).to.equal(State.Expired);

      await market.connect(publisher).review(id, 1, TEXT);
      const [count, sum] = await market.statsOf(provider.address);
      expect(count).to.equal(1);
      expect(sum).to.equal(1);
    });

    it("陪审判买方胜（已退款）的单可以评", async function () {
      const { market, jury, publisher, provider, j1, j2, j3 } = await loadFixture(deployAgentry);
      const { taskId, disputeId } = await taskInDispute(market, jury, publisher, provider);
      for (const j of [j1, j2, j3]) await castVote(jury, j, disputeId, Side.Publisher);
      await time.increase(PARAMS.votingWindow + 1);
      await jury.settle(disputeId);
      expect((await market.getTask(taskId)).state).to.equal(State.Refunded);
      await expect(market.connect(publisher).review(taskId, 2, TEXT)).to.emit(market, "Reviewed");
    });

    it("陪审未形成多数（对半分）的单可以评", async function () {
      const { market, jury, publisher, provider } = await loadFixture(deployAgentry);
      const { taskId, disputeId } = await taskInDispute(market, jury, publisher, provider);
      await time.increase(PARAMS.votingWindow + 1);
      await jury.settle(disputeId);
      expect((await market.getTask(taskId)).state).to.equal(State.Split);
      await expect(market.connect(publisher).review(taskId, 3, TEXT)).to.emit(market, "Reviewed");
    });

    it("验收期满自动放款的单可以评", async function () {
      const { market, publisher, provider } = await loadFixture(deployAgentry);
      const id = await taskAwaitingReview(market, publisher, provider);
      await time.increase(PARAMS.reviewWindow + 1);
      await market.settleReviewTimeout(id);
      await expect(market.connect(publisher).review(id, 5, TEXT)).to.emit(market, "Reviewed");
    });

    it("不存在的任务", async function () {
      const { market, publisher } = await loadFixture(deployAgentry);
      await expect(market.connect(publisher).review(99, 5, TEXT)).to.be.revertedWithCustomError(market, "TaskNotFound");
    });
  });

  describe("内容校验", function () {
    it("星级只能 1 到 5", async function () {
      const { market, publisher, provider } = await loadFixture(deployAgentry);
      const id = await completedTask(market, publisher, provider);
      await expect(market.connect(publisher).review(id, 0, TEXT)).to.be.revertedWithCustomError(market, "BadRating");
      await expect(market.connect(publisher).review(id, 6, TEXT)).to.be.revertedWithCustomError(market, "BadRating");
    });

    it("正文不能为空、不能超过 1024 字节", async function () {
      const { market, publisher, provider } = await loadFixture(deployAgentry);
      const id = await completedTask(market, publisher, provider);
      await expect(market.connect(publisher).review(id, 5, "")).to.be.revertedWithCustomError(market, "EmptyURI");
      await expect(market.connect(publisher).review(id, 5, "x".repeat(1025))).to.be.revertedWithCustomError(market, "UriTooLong");
      await expect(market.connect(publisher).review(id, 5, "x".repeat(1024))).to.emit(market, "Reviewed");
    });

    it("一单一评，不能改", async function () {
      const { market, publisher, provider } = await loadFixture(deployAgentry);
      const id = await completedTask(market, publisher, provider);
      await market.connect(publisher).review(id, 5, TEXT);
      await expect(market.connect(publisher).review(id, 1, TEXT)).to.be.revertedWithCustomError(market, "AlreadyReviewed");
      expect((await market.reviewOf(id)).rating).to.equal(5);
    });

    it("暂停新任务时仍然可以评价", async function () {
      const { market, owner, publisher, provider } = await loadFixture(deployAgentry);
      const id = await completedTask(market, publisher, provider);
      await market.connect(owner).pause();
      await expect(market.connect(publisher).review(id, 4, TEXT)).to.emit(market, "Reviewed");
    });
  });

  describe("服务方回复", function () {
    it("服务方可以回复一次", async function () {
      const { market, publisher, provider } = await loadFixture(deployAgentry);
      const id = await completedTask(market, publisher, provider);
      await market.connect(publisher).review(id, 3, TEXT);
      await expect(market.connect(provider).reply(id, REPLY))
        .to.emit(market, "Replied").withArgs(id, provider.address, REPLY);
      expect((await market.reviewOf(id)).replyURI).to.equal(REPLY);
      await expect(market.connect(provider).reply(id, REPLY)).to.be.revertedWithCustomError(market, "AlreadyReplied");
    });

    it("没有评价不能回复；发布方和旁人不能回复", async function () {
      const { market, publisher, provider, j1 } = await loadFixture(deployAgentry);
      const id = await completedTask(market, publisher, provider);
      await expect(market.connect(provider).reply(id, REPLY)).to.be.revertedWithCustomError(market, "NoReview");
      await market.connect(publisher).review(id, 3, TEXT);
      await expect(market.connect(publisher).reply(id, REPLY)).to.be.revertedWithCustomError(market, "NotProvider");
      await expect(market.connect(j1).reply(id, REPLY)).to.be.revertedWithCustomError(market, "NotProvider");
    });
  });

  describe("汇总", function () {
    it("多条评价累加，平均分由前端用 sum / count 算", async function () {
      const { market, publisher, provider } = await loadFixture(deployAgentry);
      const a = await completedTask(market, publisher, provider);
      const b = await completedTask(market, publisher, provider);
      await market.connect(publisher).review(a, 5, TEXT);
      await market.connect(publisher).review(b, 2, TEXT);
      const [count, sum] = await market.statsOf(provider.address);
      expect(count).to.equal(2);
      expect(sum).to.equal(7);
    });

    it("没有评价时为 0 / 0，reviewOf 返回空记录", async function () {
      const { market, provider } = await loadFixture(deployAgentry);
      const [count, sum] = await market.statsOf(provider.address);
      expect(count).to.equal(0);
      expect(sum).to.equal(0);
      expect((await market.reviewOf(1)).reviewer).to.equal("0x0000000000000000000000000000000000000000");
    });
  });
});
