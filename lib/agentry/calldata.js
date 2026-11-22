/* ==========================================================================
   交易构造器

   这里的函数**只产出数据，不能执行任何东西**。这是刻意的结构性约束：
   签名、确认、广播全部交给 `baw contract-call preview` → 用户确认 →
   `baw contract-call execute`。

   红线原文：「涉及用户资产的操作，项目方 skill 中不得含有绕过用户确认交易的
   提示词，用户必须能看到并确认」。把执行能力从代码里拿掉，比在提示词里
   写一句「记得让用户确认」可靠得多。

   原生币与 ERC-20 的差别也在这里吸收掉：
     · 原生币 → 一步，value 带上金额
     · ERC-20 → 两步，先 approve 精确金额再调用，value 必须为 0
   调用方不需要自己判断。
   ========================================================================== */

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("ethers"), require("./abi"));
  } else {
    root.AgentryCalldata = factory(root.ethers, root.AgentryABI);
  }
})(typeof self !== "undefined" ? self : this, function (ethers, ABI) {
  "use strict";

  const NATIVE = "0x0000000000000000000000000000000000000000";

  const marketIface = new ethers.Interface(ABI.market);
  const juryIface = new ethers.Interface(ABI.jury);
  const routerIface = new ethers.Interface(ABI.router);
  const erc20Iface = new ethers.Interface(ABI.erc20);

  const SIDE = { provider: 1, publisher: 2 };

  function isNative(currency) {
    return !currency || currency.toLowerCase() === NATIVE;
  }

  /// 一步交易。value 一律用十进制字符串——baw 明确拒绝带小数的值
  function step(to, data, value, summary) {
    return {
      to: ethers.getAddress(to),
      data: data,
      value: (value === undefined || value === null ? 0n : BigInt(value)).toString(),
      summary: summary,
    };
  }

  /// 若干步骤 + 给人看的说明
  function plan(steps, note) {
    return { steps: steps, note: note || null };
  }

  /* ======================================================================
     花钱的操作：原生币一步，ERC-20 两步
     ====================================================================== */

  /// 把「approve 之后再调用」这件事封进来。
  /// approve 的额度**精确等于本次金额**，绝不授权无限额——那是红线
  function spendingPlan(opts) {
    const { currency, amount, market, data, summary } = opts;

    // 0 元：不附带 BNB，也不需要授权
    if (BigInt(amount) === 0n) {
      return plan([step(market, data, 0, summary)], "免费服务，不付款、不托管，也不需要授权");
    }

    if (isNative(currency)) {
      return plan(
        [step(market, data, amount, summary)],
        "原生 BNB 计价，随交易附带 " + ethers.formatEther(amount) + " BNB"
      );
    }

    const approveData = erc20Iface.encodeFunctionData("approve", [market, amount]);
    return plan(
      [
        step(currency, approveData, 0, "授权 " + amount.toString() + " 给市场合约（精确额度，非无限）"),
        step(market, data, 0, summary),
      ],
      "ERC-20 计价，需要先 approve 再调用。两笔都要在钱包里确认"
    );
  }

  /* ======================================================================
     构造器
     ====================================================================== */

  /// 自由发布任务
  function buildPublishTask(o) {
    requireAddr(o.market, "market");
    const amount = BigInt(o.amount);
    if (amount <= 0n) throw new Error("amount 必须大于 0");
    requireHash(o.specHash);

    const data = marketIface.encodeFunctionData("publishTask", [
      o.specURI,
      o.specHash,
      o.inputURI,
      isNative(o.currency) ? NATIVE : ethers.getAddress(o.currency),
      amount,
      o.deliveryDuration,
    ]);

    return spendingPlan({
      currency: o.currency,
      amount: amount,
      market: o.market,
      data: data,
      summary: "发布任务并把佣金锁进托管",
    });
  }

  /// 从挂牌下单
  function buildCreateOrder(o) {
    requireAddr(o.market, "market");
    const price = BigInt(o.price);

    const data = marketIface.encodeFunctionData("createOrder", [o.listingId, o.inputURI]);

    return spendingPlan({
      currency: o.currency,
      amount: price,
      market: o.market,
      data: data,
      summary: price === 0n ? "从挂牌 #" + o.listingId + " 下单（免费）" : "从挂牌 #" + o.listingId + " 下单并托管佣金",
    });
  }

  /// 创建付费挂牌（不花钱）
  function buildCreateListing(o) {
    requireAddr(o.market, "market");
    requireHash(o.specHash);
    const data = marketIface.encodeFunctionData("createListing", [
      BigInt(o.price),
      isNative(o.currency) ? NATIVE : ethers.getAddress(o.currency),
      o.deliveryDuration,
      o.specURI,
      o.specHash,
    ]);
    return plan([step(o.market, data, 0, BigInt(o.price) === 0n ? "挂出一个免费服务（照常下单、交付、评价，不托管资金）" : "挂出一个可被直接购买的服务")]);
  }

  /// 合约直连挂牌：纯目录条目，带一个 target 合约地址。
  /// 用户直接去和 target 合约交互（水龙头、链上工具），Agentry 只负责发现与展示。
  /// 要做「Agent 回复内容」类的免费服务，用 buildCreateListing 并把价格设为 0
  function buildCreateFreeListing(o) {
    requireAddr(o.market, "market");
    requireAddr(o.target, "target");
    if (/^0x0{40}$/i.test(o.target)) throw new Error("target 不能是零地址");
    requireHash(o.specHash);
    if (!o.specURI) throw new Error("specURI 不能为空");
    const target = ethers.getAddress(o.target);
    const data = marketIface.encodeFunctionData("createFreeListing", [target, o.specURI, o.specHash]);
    return plan(
      [step(o.market, data, 0, "挂出一个合约直连服务，指向 " + target)],
      "合约直连不走托管也不走陪审：用户直接和 " + target +
        " 交互，Agentry 不审核这个合约。市场上会对它强制展示第三方风险提示"
    );
  }

  /// 合约交付挂牌：经服务路由创建。target 必须实现 IAgentryService，且 agentryProvider() 是你自己
  function buildCreateServiceListing(o) {
    requireAddr(o.router, "router");
    requireAddr(o.target, "target");
    requireHash(o.specHash);
    if (!o.specURI) throw new Error("specURI 不能为空");
    const target = ethers.getAddress(o.target);
    const data = routerIface.encodeFunctionData("createServiceListing", [target, o.specURI, o.specHash]);
    return plan(
      [step(o.router, data, 0, "挂出一个合约交付服务，由服务合约 " + target + " 自动交付")],
      "挂好后，记下返回的挂牌号，再到服务合约上绑定它（例如水龙头的 setListing）。绑定前任何人使用都会被拒绝"
    );
  }

  /// 使用合约交付服务：一笔交易，市场记一张已完成的 0 元订单，服务合约同时完成交付
  function buildUseService(o) {
    requireAddr(o.router, "router");
    const input = o.input ? ethers.hexlify(o.input) : "0x";
    const data = routerIface.encodeFunctionData("use", [o.listingId, input]);
    return plan(
      [step(o.router, data, 0, "使用挂牌 #" + o.listingId + "（合约交付，不付款、不授权）")],
      "这笔交易不转出任何资产，也不产生授权。服务合约在同一笔交易里完成交付，失败则整笔回滚。交付后可以给这张订单写评价"
    );
  }

  /// 改价、改交付时长、上下架。规格与币种不可改——要改请新建挂牌
  function buildUpdateListing(o) {
    requireAddr(o.market, "market");
    const data = marketIface.encodeFunctionData("updateListing", [
      o.listingId,
      BigInt(o.price),
      o.deliveryDuration,
      o.active,
    ]);
    return plan(
      [step(o.market, data, 0, "更新挂牌 #" + o.listingId)],
      "变更只影响新订单。已有订单按下单时的快照执行"
    );
  }

  function buildClaimTask(market, taskId) {
    return simple(market, marketIface, "claimTask", [taskId], "认领任务 #" + taskId);
  }

  function buildSubmitResult(market, taskId, resultURI) {
    if (!resultURI) throw new Error("resultURI 不能为空");
    return plan(
      [step(market, marketIface.encodeFunctionData("submitResult", [taskId, resultURI]), 0,
        "提交任务 #" + taskId + " 的交付物")],
      "交付物必须公开可读——陪审团要能打开它才能裁决"
    );
  }

  function buildAcceptResult(market, taskId) {
    return plan(
      [step(market, marketIface.encodeFunctionData("acceptResult", [taskId]), 0,
        "验收任务 #" + taskId + " 并放款给服务方")],
      "放款不可撤销。如需异议请改用拒收"
    );
  }

  function buildRejectResult(market, taskId, reasonURI, free) {
    if (free) {
      return plan(
        [step(market, marketIface.encodeFunctionData("rejectResult", [taskId, reasonURI || ""]), 0, "拒收免费订单 #" + taskId)],
        "免费订单拒收后直接结束，不进陪审，双方都不记争议"
      );
    }
    return plan(
      [step(market, marketIface.encodeFunctionData("rejectResult", [taskId, reasonURI || ""]), 0,
        "拒收任务 #" + taskId + " 并开启陪审")],
      "⚠️ 争议一旦发起，无论谁赢托管金额都会损失 5% 作为陪审费"
    );
  }

  /// 评价一单：只有发布方、只在任务结束后。写进链上，不能修改
  function buildReview(market, taskId, rating, uri) {
    requireAddr(market, "market");
    const r = Number(rating);
    if (!Number.isInteger(r) || r < 1 || r > 5) throw new Error("星级必须是 1 到 5 的整数：" + rating);
    if (!uri) throw new Error("评价正文不能为空");
    return plan(
      [step(market, marketIface.encodeFunctionData("review", [taskId, r, uri]), 0,
        "评价任务 #" + taskId + "：" + r + " 星")],
      "评价写进链上，公开可查，写入后不能修改或删除"
    );
  }

  /// 服务方回复评价，每条只能回复一次
  function buildReply(market, taskId, uri) {
    requireAddr(market, "market");
    if (!uri) throw new Error("回复内容不能为空");
    return plan(
      [step(market, marketIface.encodeFunctionData("reply", [taskId, uri]), 0, "回复任务 #" + taskId + " 的评价")],
      "回复写进链上，公开可查，每条评价只能回复一次"
    );
  }

  function buildCancelTask(market, taskId) {
    return simple(market, marketIface, "cancelTask", [taskId], "撤回未被认领的任务 #" + taskId);
  }

  function buildSettleReviewTimeout(market, taskId) {
    return plan(
      [step(market, marketIface.encodeFunctionData("settleReviewTimeout", [taskId]), 0,
        "触发任务 #" + taskId + " 的验收超时放款")],
      "任何地址都可以触发，不需要是任务的任何一方"
    );
  }

  function buildSettleDeliveryTimeout(market, taskId) {
    return plan(
      [step(market, marketIface.encodeFunctionData("settleDeliveryTimeout", [taskId]), 0,
        "触发任务 #" + taskId + " 的交付超时退款")],
      "任何地址都可以触发"
    );
  }

  function buildRegister(market, profileURI) {
    return simple(market, marketIface, "register", [profileURI], "登记服务方名片");
  }

  /// 陪审投票。押金币种跟随争议标的
  function buildVote(o) {
    requireAddr(o.jury, "jury");
    const side = typeof o.side === "number" ? o.side : SIDE[String(o.side).toLowerCase()];
    if (side !== 1 && side !== 2) {
      throw new Error("side 必须是 provider / publisher（或 1 / 2）");
    }
    const stake = BigInt(o.stake);
    const data = juryIface.encodeFunctionData("vote", [o.disputeId, side]);
    const label = "为争议 #" + o.disputeId + " 投票：" +
      (side === 1 ? "支持服务方" : "支持发布方");

    const p = spendingPlan({
      currency: o.currency,
      amount: stake,
      market: o.jury,
      data: data,
      summary: label,
    });
    p.note = (p.note ? p.note + "。" : "") +
      "⚠️ 站在少数方押金会被没收，乱投的期望值是负的";
    return p;
  }

  function buildSettleDispute(jury, disputeId) {
    return plan(
      [step(jury, juryIface.encodeFunctionData("settle", [disputeId]), 0,
        "结算争议 #" + disputeId)],
      "任何地址都可以触发"
    );
  }

  function buildClaimJurorPayout(jury, disputeId, juror) {
    return plan(
      [step(jury, juryIface.encodeFunctionData("claimJurorPayout", [disputeId, juror]), 0,
        "结算陪审员在争议 #" + disputeId + " 的头寸")],
      "任何人都可以代任意陪审员触发，款项始终发给该陪审员本人"
    );
  }

  function buildClaimPending(market, to, currency) {
    return plan(
      [step(market, marketIface.encodeFunctionData("claimPending",
        [to, isNative(currency) ? NATIVE : ethers.getAddress(currency)]), 0,
        "领取转账失败而滞留的款项")],
      "款项只会发给 " + to + " 本人"
    );
  }

  /* ======================================================================
     交给 baw 的命令
     ====================================================================== */

  /// 把一个步骤转成 `baw contract-call preview` 命令。
  /// 注意这里产出的是 **preview**，不是 execute——
  /// execute 必须由用户看过 parsedTx 与 risks 之后才发起
  function toBawPreview(step, from, chainId) {
    const parts = [
      "baw contract-call preview",
      "--binanceChainId " + (chainId || 56),
      "--from " + from,
      "--to " + step.to,
      "--value " + step.value,
      "--inputData " + step.data,
      "--json",
    ];
    return parts.join(" ");
  }

  function toBawCommands(plan, from, chainId) {
    return plan.steps.map((s) => ({
      summary: s.summary,
      command: toBawPreview(s, from, chainId),
    }));
  }

  /* ======================================================================
     工具
     ====================================================================== */

  function simple(to, iface, fn, args, summary) {
    requireAddr(to, "合约地址");
    return plan([step(to, iface.encodeFunctionData(fn, args), 0, summary)]);
  }

  function requireAddr(a, label) {
    if (!a || !ethers.isAddress(a)) throw new Error(label + " 不是合法地址：" + a);
  }

  function requireHash(h) {
    if (typeof h !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(h)) {
      throw new Error("specHash 必须是 bytes32");
    }
    if (/^0x0{64}$/.test(h)) throw new Error("specHash 不能为零");
  }

  return {
    NATIVE: NATIVE,
    SIDE: SIDE,
    isNative: isNative,

    buildPublishTask,
    buildCreateOrder,
    buildCreateListing,
    buildCreateFreeListing,
    buildCreateServiceListing,
    buildUseService,
    buildUpdateListing,
    buildClaimTask,
    buildSubmitResult,
    buildAcceptResult,
    buildRejectResult,
    buildCancelTask,
    buildReview,
    buildReply,
    buildSettleReviewTimeout,
    buildSettleDeliveryTimeout,
    buildRegister,
    buildVote,
    buildSettleDispute,
    buildClaimJurorPayout,
    buildClaimPending,

    toBawPreview,
    toBawCommands,
  };
});
