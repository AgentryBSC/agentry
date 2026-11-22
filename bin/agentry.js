#!/usr/bin/env node
/* ==========================================================================
   agentry —— Agentry 市场的命令行

   ⚠️ 这个 CLI **不会签名，也不会广播任何交易**。
      所有写操作都只产出 `baw contract-call preview` 命令，
      由用户在自己的钱包里看过 parsedTx 与 risks 之后再确认执行。
   ========================================================================== */

"use strict";

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ABI = require("../lib/agentry/abi");
const CD = require("../lib/agentry/calldata");
const AID = require("../lib/agentry/agentid");
const Inline = require("../lib/agentry/inline");
const Spec = require("../lib/spec");

/* ---------- 配置 ---------- */

function loadConfig() {
  const chainId = Number(process.env.AGENTRY_CHAIN_ID || 56);
  let market = process.env.AGENTRY_MARKET || "";
  let jury = process.env.AGENTRY_JURY || "";
  let router = process.env.AGENTRY_ROUTER || "";

  if (!market || !jury || !router) {
    const file = path.join(__dirname, "..", "deployments", chainId + ".json");
    if (fs.existsSync(file)) {
      const d = JSON.parse(fs.readFileSync(file, "utf8"));
      market = market || d.contracts.AgentMarket.address;
      jury = jury || d.contracts.AgentJury.address;
      router = router || (d.contracts.AgentryServiceRouter && d.contracts.AgentryServiceRouter.address);
    }
  }

  return {
    chainId,
    market,
    jury,
    router,
    rpc: process.env.AGENTRY_RPC ||
      (chainId === 97
        ? "https://data-seed-prebsc-1-s1.binance.org:8545"
        : "https://bsc-dataseed.binance.org"),
    // 线上内容服务；本地开发设 AGENTRY_CONTENT=http://localhost:8787
    content: process.env.AGENTRY_CONTENT || "https://agentrys.fun/content",
    // 规格和名片存在哪：chain（默认，整份写进链上的 data: URI）或 server（上传到内容服务）
    specStore: (process.env.AGENTRY_SPEC_STORE || "chain").toLowerCase(),
  };
}

const CFG = loadConfig();

function needDeployed() {
  if (!CFG.market || !CFG.jury) {
    die(
      "找不到合约地址。请设置 AGENTRY_MARKET 与 AGENTRY_JURY，" +
      "或先运行部署脚本生成 deployments/" + CFG.chainId + ".json"
    );
  }
}

function provider() {
  return new ethers.JsonRpcProvider(CFG.rpc, CFG.chainId);
}

/* ---------- Agent ID 名字：给人看的一律是 .ai 名字，地址作补充 ---------- */

const AGENT_ID_ADDR = process.env.AGENTRY_AGENT_ID || AID.ADDRESS;
const agentIdNft = () => new ethers.Contract(AGENT_ID_ADDR, ABI.agentId, provider());

let _names = null;
function names() {
  return _names || (_names = AID.createResolver(agentIdNft()));
}

/// 参数可以是地址，也可以是 .ai 名字；统一换成地址
async function resolveAddr(v, what) {
  const s = String(v).trim();
  if (AID.isAddress(s)) return ethers.getAddress(s);
  if (!AID.looksLikeName(s)) die(what + " 既不是地址也不是 .ai 名字：" + s);
  const a = await names().addressOf(s);
  if (!a) die("没有人注册 " + AID.toName(AID.toHandle(s)) + "，检查一下拼写");
  return a;
}

/// 展示用："xxx.ai（0x…）"，没有 Agent ID 就只给地址
const who = (addr, name) => AID.label(addr, name);

/// 挂牌的报价文字
function kindPrice(l) {
  const k = Number(l.kind);
  if (k === 2) return "免费 · 合约交付";
  if (k === 1) return "免费 · 合约直连";
  return l.price === 0n ? "免费" : fmtAmount(l.price, l.currency);
}

/// 合约交付挂牌的使用次数和人数（市场合约里记的）
async function serviceUsage(m, id) {
  const [uses, users] = await m.serviceStatsOf(id);
  return { uses: Number(uses), users: Number(users) };
}

const market = () => new ethers.Contract(CFG.market, ABI.market, provider());
const jury = () => new ethers.Contract(CFG.jury, ABI.jury, provider());

/* ---------- 输出 ---------- */

let JSON_MODE = false;

function out(human, data) {
  if (JSON_MODE) console.log(JSON.stringify(data, bigintSafe, 2));
  else console.log(human);
}

function bigintSafe(_k, v) {
  return typeof v === "bigint" ? v.toString() : v;
}

function die(msg) {
  if (JSON_MODE) console.log(JSON.stringify({ error: msg }));
  else console.error("✗ " + msg);
  process.exit(1);
}

/// 写操作的统一出口。只打印 preview 命令，绝不执行
function emitPlan(plan, from) {
  const cmds = CD.toBawCommands(plan, from, CFG.chainId);

  if (JSON_MODE) {
    console.log(JSON.stringify({
      steps: plan.steps,
      note: plan.note,
      commands: cmds,
      reminder: "这些是 preview 命令。执行前必须让用户看到 parsedTx 与 risks 并明确确认。",
    }, bigintSafe, 2));
    return;
  }

  if (plan.note) console.log("\n" + plan.note + "\n");
  cmds.forEach((c, i) => {
    console.log((i + 1) + ". " + c.summary);
    console.log("   " + c.command + "\n");
  });
  console.log("以上是 preview。看过 parsedTx 与 risks、确认无误后，再用返回的 requestId 执行：");
  console.log("   baw contract-call execute --requestId <id> --json");
}

/* ---------- 参数解析辅助 ---------- */

/// 交付时长。接受秒数，也接受 24h / 1d / 90m 这种写法
function parseDuration(v) {
  const m = String(v).trim().match(/^(\d+(?:\.\d+)?)\s*([smhd]?)$/i);
  if (!m) die("交付时长格式不对：" + v + "（支持 86400、24h、1d、90m）");
  const mult = { s: 1, m: 60, h: 3600, d: 86400, "": 1 }[m[2].toLowerCase()];
  return Math.round(Number(m[1]) * mult);
}

/// 把 BNB / USDT / 合约地址解析成 { address, symbol, decimals }
/// 小数位从代币合约读，不写死——换个 6 位小数的结算币也不会算错
async function resolveCurrency(input) {
  const v = String(input || "BNB").trim();

  if (/^(bnb|native)$/i.test(v) || v === CD.NATIVE) {
    return { address: CD.NATIVE, symbol: "BNB", decimals: 18 };
  }

  let addr;
  if (ethers.isAddress(v)) {
    addr = ethers.getAddress(v);
  } else {
    // 非地址一律当成「那个被支持的 ERC-20」，地址从合约读
    addr = await market().paymentToken();
  }

  const token = new ethers.Contract(addr, ABI.erc20, provider());
  const [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()]);
  return { address: addr, symbol, decimals: Number(decimals) };
}

function parseAmount(v, decimals) {
  try {
    return ethers.parseUnits(String(v), decimals);
  } catch (e) {
    die("金额格式不对：" + v);
  }
}

/// 发交易之前先按链上参数自查，省得用户签了才被 revert
async function assertWithinLimits(currency, amount, duration) {
  const m = market();
  const [max, minPaid, maxD, minFree] = await Promise.all([
    m.maxTaskAmount(currency.address),
    m.minDelivery(),
    m.maxDelivery(),
    m.MIN_FREE_DELIVERY().catch(() => null), // v2 合约没有这个常量
  ]);
  const minD = amount === 0n && minFree != null ? minFree : minPaid;

  if (amount > max) {
    die(
      "金额超过上限。当前 " + currency.symbol + " 的单笔上限是 " +
      ethers.formatUnits(max, currency.decimals)
    );
  }
  if (duration < Number(minD) || duration > Number(maxD)) {
    die(
      "交付时长越界。允许范围 " + Number(minD) / 3600 + " ~ " +
      Number(maxD) / 3600 + " 小时"
    );
  }
}

/* ---------- 格式化 ---------- */

const fmtAmount = (v, currency) =>
  ethers.formatUnits(v, 18) + " " + (CD.isNative(currency) ? "BNB" : "USDT");

const fmtTime = (ts) =>
  Number(ts) === 0 ? "—" : new Date(Number(ts) * 1000).toISOString().replace("T", " ").slice(0, 19);

function remaining(deadline) {
  const s = Number(deadline) - Math.floor(Date.now() / 1000);
  if (s <= 0) return "已超时";
  const h = Math.floor(s / 3600);
  return h >= 24 ? Math.floor(h / 24) + " 天 " + (h % 24) + " 小时" : h + " 小时";
}

/* ======================================================================
   读命令
   ====================================================================== */

/// 免费挂牌必须带的第三方风险提示（docs/mechanics.md 的要求）
const THIRD_PARTY_NOTICE =
  "第三方服务由其提供方独立运营，Agentry 不控制也不保证其安全性与可靠性。请在交互前自行研究。";

async function cmdListings(args) {
  needDeployed();
  const m = market();
  const total = Number(await m.listingCount());
  const limit = Number(args.limit || 20);
  const wantKind = args.kind === "paid" ? 0 : args.kind === "free" ? 1 : args.kind === "service" ? 2 : null;
  const rows = [];

  for (let id = total; id >= 1 && rows.length < limit; id--) {
    const l = await m.getListing(id);
    if (!l.active) continue;
    if (wantKind !== null && Number(l.kind) !== wantKind) continue;
    // 按能力标识筛：能力写在规格里，要把规格取回来看
    if (args.capability) {
      const s = l.specURI ? await fetchJson(l.specURI) : null;
      if (!s || s.capability !== String(args.capability)) continue;
    }
    rows.push({
      id,
      provider: l.provider,
      kind: ABI.enums.ListingKind[Number(l.kind)],
      price: kindPrice(l),
      currency: l.currency,
      deliveryDuration: Number(l.deliveryDuration),
      specURI: l.specURI,
      specHash: l.specHash,
      target: l.target,
      usage: Number(l.kind) === 2 ? await serviceUsage(m, id) : null,
      thirdPartyNotice: Number(l.kind) === 1 ? THIRD_PARTY_NOTICE : null,
    });
  }

  const pn = await names().namesOf(rows.map((r) => r.provider));
  rows.forEach((r, i) => { r.providerName = pn[i]; });

  const hasFree = rows.some((r) => r.thirdPartyNotice);
  out(
    rows.length === 0
      ? "还没有在售挂牌。"
      : rows.map((r) =>
          "#" + r.id + "  " + r.price.padEnd(16) + r.kind + "  " + who(r.provider, r.providerName) +
          (r.usage ? "  使用 " + r.usage.uses + " 次 · " + r.usage.users + " 人" : "") +
          (r.thirdPartyNotice ? "\n     指向第三方合约 " + r.target : "") +
          "\n     " + r.specURI
        ).join("\n") + (hasFree ? "\n\n合约直连：" + THIRD_PARTY_NOTICE : ""),
    { total, listings: rows }
  );
}

async function cmdListing(args) {
  needDeployed();
  const id = requireArg(args._[1], "listingId");
  const m = market();
  const l = await m.getListing(id);
  const [rep, providerName] = await Promise.all([
    m.reputationOf(l.provider),
    names().nameOf(l.provider),
  ]);

  let spec = null;
  let specOk = null;
  if (l.specURI) {
    spec = await fetchJson(l.specURI);
    if (spec) {
      // 规格哈希必须和链上对上，否则服务方可能事后改了验收标准
      const h = Spec.hash(spec, ethers.keccak256, ethers.toUtf8Bytes);
      specOk = h.toLowerCase() === l.specHash.toLowerCase();
    }
  }

  const data = {
    id: Number(id),
    provider: l.provider,
    providerName,
    kind: ABI.enums.ListingKind[Number(l.kind)],
    active: l.active,
    price: l.price.toString(),
    priceHuman: kindPrice(l),
    currency: l.currency,
    deliveryDuration: Number(l.deliveryDuration),
    specURI: l.specURI,
    specHash: l.specHash,
    specHashVerified: specOk,
    spec,
    target: Number(l.kind) !== 0 ? l.target : null,
    thirdPartyNotice: Number(l.kind) !== 0 ? THIRD_PARTY_NOTICE : null,
    usage: Number(l.kind) === 2 ? await serviceUsage(m, id) : null,
    delisted: await m.delisted(id).catch(() => false),
    providerReputation: {
      completed: Number(rep.completed),
      expired: Number(rep.expired),
      disputesWon: Number(rep.disputesWon),
      disputesLost: Number(rep.disputesLost),
    },
  };

  out(
    "挂牌 #" + id + "\n" +
    "  服务方   " + who(l.provider, providerName) + "\n" +
    "  报价     " + data.priceHuman + "\n" +
    (Number(l.kind) === 2
      ? "  服务合约 " + data.target + "（经服务路由调用，一笔交易完成交付，记一张已完成的订单）\n" +
        "  使用     " + data.usage.uses + " 次 · " + data.usage.users + " 人\n"
      : data.target
        ? "  服务合约 " + data.target + "（用户直接和它交互，不走托管与陪审）\n"
        : "  交付时长 " + data.deliveryDuration / 3600 + " 小时\n") +
    (data.delisted ? "  状态     已被平台强制下架\n" : !l.active ? "  状态     已下架\n" : "") +
    "  规格     " + l.specURI + "\n" +
    "  哈希校验 " + (specOk === null ? "未取到规格" : specOk ? "✓ 与链上一致" : "✗ 不一致，有被篡改的可能") + "\n" +
    "  信誉     完成 " + rep.completed + " · 逾期 " + rep.expired +
    " · 争议胜 " + rep.disputesWon + " 负 " + rep.disputesLost +
    (data.thirdPartyNotice ? "\n\n⚠️  " + data.thirdPartyNotice : ""),
    data
  );
}

/// 状态名 → 枚举值。默认只看「待认领」，那才是服务方能接的
const STATE_CODES = {
  open: 1, assigned: 2, submitted: 3, disputed: 4,
  completed: 5, refunded: 6, split: 7, cancelled: 8, expired: 9,
};

function parseStates(v) {
  if (v === undefined) return new Set([1]);
  if (String(v).toLowerCase() === "all") return null;
  const codes = new Set();
  for (const name of String(v).split(",")) {
    const c = STATE_CODES[name.trim().toLowerCase()];
    if (c === undefined) {
      die("未知状态：" + name + "（可用：" + Object.keys(STATE_CODES).join(" / ") + " / all）");
    }
    codes.add(c);
  }
  return codes;
}

/// 任务大厅。服务方找活的入口——`listings` 列的是挂牌，不是开放任务
async function cmdTasks(args) {
  needDeployed();

  // 本地能判的参数先判，别等一次 RPC 往返回来才说状态名写错了
  const wanted = parseStates(args.state);
  const publisher = args.publisher ? (await resolveAddr(args.publisher, "--publisher")).toLowerCase() : null;
  const provider = args.provider ? (await resolveAddr(args.provider, "--provider")).toLowerCase() : null;
  const limit = Number(args.limit || 20);
  if (!Number.isFinite(limit) || limit <= 0) die("--limit 必须是正整数");

  const m = market();
  const total = Number(await m.taskCount());

  const rows = [];
  for (let id = total; id >= 1 && rows.length < limit; id--) {
    const t = await m.getTask(id);
    if (wanted && !wanted.has(Number(t.state))) continue;
    if (publisher && t.publisher.toLowerCase() !== publisher) continue;
    if (provider && t.provider.toLowerCase() !== provider) continue;

    rows.push({
      id,
      state: ABI.enums.TaskState[Number(t.state)],
      stateCode: Number(t.state),
      publisher: t.publisher,
      provider: t.provider === ethers.ZeroAddress ? null : t.provider,
      amount: t.amount.toString(),
      amountHuman: fmtAmount(t.amount, t.currency),
      currency: t.currency,
      deliveryDuration: Number(t.deliveryDuration),
      claimDeadline: fmtTime(t.claimDeadline),
      claimRemaining: Number(t.claimDeadline) ? remaining(t.claimDeadline) : null,
      specURI: t.specURI,
      specHash: t.specHash,
      inputURI: t.inputURI,
    });
  }

  // 规格并行取，取不到就留空——不能因为一个 URI 挂了就让整个大厅打不开
  const specs = await Promise.all(rows.map((r) => fetchJson(r.specURI)));
  rows.forEach((r, i) => {
    const s = specs[i];
    r.capability = s ? s.capability : null;
    r.title = s ? s.title : null;
    r.acceptanceCriteria = s ? s.acceptanceCriteria : null;
  });

  const [pubNames, provNames] = await Promise.all([
    names().namesOf(rows.map((r) => r.publisher)),
    names().namesOf(rows.map((r) => r.provider)),
  ]);
  rows.forEach((r, i) => {
    r.publisherName = pubNames[i];
    r.providerName = provNames[i];
  });

  out(
    rows.length === 0
      ? wanted && wanted.has(1) && wanted.size === 1
        ? "当前没有待认领的任务。"
        : "没有符合条件的任务。"
      : rows.map((r) =>
          "#" + r.id + "  " + r.amountHuman.padEnd(14) + "[" + r.state + "]  " +
          (r.title || "（规格取不到）") +
          "\n     " + (r.capability || "—") +
          "  交付 " + r.deliveryDuration / 3600 + "h" +
          (r.claimRemaining ? "  剩 " + r.claimRemaining + " 可认领" : "") +
          "\n     发布方 " + who(r.publisher, r.publisherName) +
          (r.provider ? "  服务方 " + who(r.provider, r.providerName) : "")
        ).join("\n"),
    { total, tasks: rows }
  );
}

async function cmdTask(args) {
  needDeployed();
  const id = requireArg(args._[1], "taskId");
  const t = await market().getTask(id);
  const state = ABI.enums.TaskState[Number(t.state)];
  const [publisherName, providerName] = await names().namesOf([t.publisher, t.provider]);

  const data = {
    id: Number(id),
    state,
    stateCode: Number(t.state),
    publisher: t.publisher,
    publisherName,
    provider: t.provider,
    providerName,
    amount: t.amount.toString(),
    amountHuman: fmtAmount(t.amount, t.currency),
    currency: t.currency,
    specURI: t.specURI,
    specHash: t.specHash,
    inputURI: t.inputURI,
    resultURI: t.resultURI,
    deliveryDeadline: fmtTime(t.deliveryDeadline),
    reviewDeadline: fmtTime(t.reviewDeadline),
    deliveryRemaining: Number(t.deliveryDeadline) ? remaining(t.deliveryDeadline) : null,
    reviewRemaining: Number(t.reviewDeadline) ? remaining(t.reviewDeadline) : null,
  };

  out(
    "任务 #" + id + "  [" + state + "]\n" +
    "  金额     " + data.amountHuman + "\n" +
    "  发布方   " + who(t.publisher, publisherName) + "\n" +
    "  服务方   " + (t.provider === ethers.ZeroAddress ? "待认领" : who(t.provider, providerName)) + "\n" +
    (Number(t.deliveryDeadline) ? "  交付期限 " + data.deliveryDeadline + "（剩 " + data.deliveryRemaining + "）\n" : "") +
    (Number(t.reviewDeadline) ? "  验收期限 " + data.reviewDeadline + "（剩 " + data.reviewRemaining + "）\n" : "") +
    (t.resultURI ? "  交付物   " + t.resultURI : ""),
    data
  );
}

async function cmdDisputes() {
  needDeployed();
  const j = jury();
  const total = Number(await j.disputeCount());
  const open = [];

  for (let id = total; id >= 1 && open.length < 20; id--) {
    const d = await j.getDispute(id);
    if (d.settled) continue;
    open.push({
      id,
      taskId: Number(d.taskId),
      amount: fmtAmount(d.taskAmount, d.currency),
      stake: d.stake.toString(),
      stakeHuman: fmtAmount(d.stake, d.currency),
      currency: d.currency,
      votesForProvider: Number(d.votesForProvider),
      votesForPublisher: Number(d.votesForPublisher),
      votingDeadline: fmtTime(d.votingDeadline),
      remaining: remaining(d.votingDeadline),
    });
  }

  out(
    open.length === 0
      ? "当前没有待裁决的争议。"
      : open.map((d) =>
          "争议 #" + d.id + "（任务 #" + d.taskId + "）  标的 " + d.amount +
          "\n     票数 " + d.votesForProvider + " : " + d.votesForPublisher +
          " · 押金 " + d.stakeHuman + " · 剩 " + d.remaining
        ).join("\n"),
    { total, open }
  );
}

/// 争议裁决的客观前置：交付物符不符合声明的 output schema 是事实，不是品味
async function cmdVerify(args) {
  needDeployed();
  const id = requireArg(args._[1], "taskId");
  const t = await market().getTask(id);

  if (!t.specURI) die("任务没有规格");
  const spec = await fetchJson(t.specURI);
  if (!spec) die("取不到规格：" + t.specURI);

  const hashOk =
    Spec.hash(spec, ethers.keccak256, ethers.toUtf8Bytes).toLowerCase() ===
    t.specHash.toLowerCase();

  if (!t.resultURI) {
    out("任务 #" + id + " 还没有交付物。", { taskId: Number(id), specHashVerified: hashOk, result: null });
    return;
  }

  const result = await fetchJson(t.resultURI);
  if (!result) die("取不到交付物：" + t.resultURI);

  const check = Spec.validateOutput(spec, result);

  out(
    "任务 #" + id + "\n" +
    "  规格哈希 " + (hashOk ? "✓ 与链上一致" : "✗ 不一致") + "\n" +
    "  结构校验 " + (check.ok ? "✓ 符合声明的 output schema" : "✗ 不符合") + "\n" +
    (check.ok ? "" : check.errors.map((e) => "    · " + e).join("\n") + "\n") +
    "\n注意：结构合规只是客观前置。内容质量仍然要对照 acceptanceCriteria 自行判断。",
    {
      taskId: Number(id),
      specHashVerified: hashOk,
      schemaValid: check.ok,
      errors: check.errors,
      acceptanceCriteria: spec.acceptanceCriteria,
      rejections: spec.rejections || [],
      note: "结构合规是事实；内容质量是判断。陪审团只需处理后者。",
    }
  );
}

async function cmdAgent(args) {
  needDeployed();
  const addr = await resolveAddr(requireArg(args._[1], "地址或 .ai 名字"), "参数");
  const m = market();
  const rep = await m.reputationOf(addr);
  const free = await m.freeCompletedOf(addr).catch(() => 0n); // v2 合约没有
  const auto = await m.serviceCompletedOf(addr).catch(() => 0n); // v4 之前的合约没有
  const [maj, min] = await jury().jurorRecordOf(addr);
  const holds = (await agentIdNft().balanceOf(addr)) > 0n;
  const name = holds ? await names().nameOf(addr) : null;

  const data = {
    address: addr,
    name,
    holdsAgentId: holds,
    published: Number(rep.published),
    completed: Number(rep.completed),
    freeCompleted: Number(free),
    serviceCompleted: Number(auto),
    expired: Number(rep.expired),
    disputesWon: Number(rep.disputesWon),
    disputesLost: Number(rep.disputesLost),
    jurorMajority: Number(maj),
    jurorMinority: Number(min),
  };

  out(
    who(addr, name) + "\n" +
    "  Agent ID " + (holds ? "✓ " + (name || "持有") : "✗ 未持有，无法参与任何写操作") + "\n" +
    "  作为发布方 发布 " + data.published + "\n" +
    "  作为服务方 付费完成 " + data.completed + " · 免费完成 " + data.freeCompleted + " · 自动交付 " + data.serviceCompleted + " · 逾期 " + data.expired + "\n" +
    "  争议       胜 " + data.disputesWon + " · 负 " + data.disputesLost + "\n" +
    "  陪审       多数 " + data.jurorMajority + " · 少数 " + data.jurorMinority,
    data
  );
}

/// 地址 ↔ .ai 名字互查。只读 Agent ID 合约，市场没部署也能用
async function cmdWhois(args) {
  const q = String(requireArg(args._[1], "地址或 .ai 名字")).trim();
  let address = null;
  let name = null;
  if (AID.isAddress(q)) {
    address = ethers.getAddress(q);
    name = await names().nameOf(address);
  } else if (AID.looksLikeName(q)) {
    name = AID.toName(AID.toHandle(q));
    address = await names().addressOf(q);
  } else {
    die("既不是地址也不是 .ai 名字：" + q);
  }
  const found = !!(address && name);
  out(
    found
      ? name + "\n  地址 " + address
      : AID.isAddress(q)
        ? address + "\n  没有 Agent ID，接不了单也发不了任务"
        : name + "\n  还没有人注册这个名字",
    { query: q, address, name: found ? name : null, holdsAgentId: found }
  );
}

/* ======================================================================
   写命令 —— 只产出 preview，不执行
   ====================================================================== */

async function cmdOrder(args) {
  needDeployed();
  const listingId = requireArg(args._[1], "listingId");
  const from = requireArg(args.from, "--from");

  const l = await market().getListing(listingId);
  if (Number(l.kind) === 2) die("这是合约交付服务，用 agentry use " + listingId + " --from <地址>，不走普通下单");
  if (Number(l.kind) !== 0) die("这是合约直连服务，直接与 " + l.target + " 交互，不经过市场下单");
  if (!l.active) die("挂牌已下架");

  // 付钱之前先按规格校验输入，错了在这里就拦住
  const spec = await fetchJson(l.specURI);
  let inputURI = args.inputUri;

  if (args.input) {
    const input = JSON.parse(fs.readFileSync(args.input, "utf8"));
    if (spec) {
      const check = Spec.validateInput(spec, input);
      if (!check.ok) die("输入不符合规格：\n  " + check.errors.join("\n  "));
    }
    inputURI = await uploadJson(input);
  }
  if (!inputURI) die("需要 --input <文件> 或 --input-uri <uri>");

  emitPlan(
    CD.buildCreateOrder({
      market: CFG.market,
      listingId: Number(listingId),
      inputURI,
      currency: l.currency,
      price: l.price,
    }),
    from
  );
}

async function cmdSubmit(args) {
  needDeployed();
  const taskId = requireArg(args._[1], "taskId");
  const from = requireArg(args.from, "--from");

  let resultURI = args.resultUri;
  if (args.file) {
    const t = await market().getTask(taskId);
    const spec = await fetchJson(t.specURI);
    const raw = fs.readFileSync(args.file, "utf8");

    // 交之前自己先过一遍 schema。不合规的交付物在争议里是摆在明面上的事实
    if (spec && args.file.endsWith(".json")) {
      const check = Spec.validateOutput(spec, JSON.parse(raw));
      if (!check.ok && !args.force) {
        die(
          "交付物不符合声明的 output schema：\n  " + check.errors.join("\n  ") +
          "\n\n这在争议里是客观事实，会直接对你不利。确实要提交请加 --force"
        );
      }
    }
    resultURI = await uploadRaw(raw, args.file.endsWith(".json") ? "application/json" : "text/plain");
  }
  if (!resultURI) die("需要 --file <文件> 或 --result-uri <uri>");

  emitPlan(CD.buildSubmitResult(CFG.market, Number(taskId), resultURI), from);
}

async function cmdVote(args) {
  needDeployed();
  const disputeId = requireArg(args._[1], "disputeId");
  const side = requireArg(args.side, "--side（provider 或 publisher）");
  const from = requireArg(args.from, "--from");

  const d = await jury().getDispute(disputeId);
  if (d.settled) die("争议已结算");

  emitPlan(
    CD.buildVote({
      jury: CFG.jury,
      disputeId: Number(disputeId),
      side,
      currency: d.currency,
      stake: d.stake,
    }),
    from
  );
}

function simpleWrite(builder, contract) {
  return async function (args) {
    needDeployed();
    const id = requireArg(args._[1], "id");
    const from = requireArg(args.from, "--from");
    emitPlan(builder(contract === "jury" ? CFG.jury : CFG.market, Number(id)), from);
  };
}

/// 自由发布任务
async function cmdPublish(args) {
  needDeployed();
  const from = requireArg(args.from, "--from");
  const specFile = requireArg(args.spec, "--spec <规格文件>");

  const spec = JSON.parse(fs.readFileSync(specFile, "utf8"));

  // 本地先校验，不合格的规格别上链——争议时陪审团只能对着含糊的标准判
  const check = Spec.validateSpec(spec);
  if (!check.ok) die("规格未通过校验：\n  " + check.errors.join("\n  "));
  if (check.warnings.length && !JSON_MODE) {
    console.error("提醒：\n  " + check.warnings.join("\n  ") + "\n");
  }

  const currency = await resolveCurrency(args.currency);
  const duration = parseDuration(requireArg(args.delivery, "--delivery"));
  const amount = parseAmount(requireArg(args.amount, "--amount"), currency.decimals);
  if (amount === 0n) die("公开任务的预算必须大于 0。想提供免费服务，用 agentry listing create --price 0");
  await assertWithinLimits(currency, amount, duration);

  // 输入也按规格自检一遍
  let inputURI = args.inputUri;
  if (args.input) {
    const input = JSON.parse(fs.readFileSync(args.input, "utf8"));
    const ic = Spec.validateInput(spec, input);
    if (!ic.ok) die("输入不符合自己写的规格：\n  " + ic.errors.join("\n  "));
    inputURI = await uploadJson(input);
  }
  if (!inputURI) die("需要 --input <文件> 或 --input-uri <uri>");

  const uploaded = await uploadSpec(spec);

  emitPlan(
    CD.buildPublishTask({
      market: CFG.market,
      specURI: uploaded.uri,
      specHash: uploaded.specHash,
      inputURI,
      currency: currency.address,
      amount,
      deliveryDuration: duration,
    }),
    from
  );
}

/// 拒收并开启陪审
async function cmdReject(args) {
  needDeployed();
  const taskId = requireArg(args._[1], "taskId");
  const from = requireArg(args.from, "--from");

  let reasonURI = args.reasonUri || "";
  if (args.reason) {
    reasonURI = await uploadRaw(fs.readFileSync(args.reason, "utf8"), "text/plain");
  }

  // 拒收之前先跑一次客观前置，让用户知道自己站在哪一边
  if (!JSON_MODE) {
    const t = await market().getTask(taskId);
    const spec = await fetchJson(t.specURI);
    const result = t.resultURI ? await fetchJson(t.resultURI) : null;
    if (spec && result) {
      const v = Spec.validateOutput(spec, result);
      console.error(
        v.ok
          ? "提醒：交付物结构上是合规的，你的异议属于质量判断。" +
            "陪审团会对照 acceptanceCriteria 判，标准写得含糊对你不利。\n"
          : "交付物不符合声明的 output schema，这对你有利：\n  " +
            v.errors.join("\n  ") + "\n"
      );
    }
  }

  const tk = await market().getTask(taskId);
  emitPlan(CD.buildRejectResult(CFG.market, Number(taskId), reasonURI, tk.amount === 0n), from);
}

/* ---------- 评价 ----------
   正文写成 data: URI 整份上链：{ "text": "…", "service": "挂牌标题" }，上限见合约 MAX_REVIEW_URI */

const REVIEWABLE = new Set([5, 6, 7, 9]); // 已完成、已退款、对半分、已逾期

function reviewDoc(text, service) {
  const t = String(text || "").trim();
  if (!t) die("评价内容不能为空（--text）");
  const enc = Inline.encode(service ? { text: t, service: String(service) } : { text: t });
  if (enc.size > 1024) die("内容编码后 " + enc.size + " 字节，超过链上上限 1024 字节，请精简到 200 字左右");
  return enc.uri;
}

/// 买方评价一单
async function cmdReview(args) {
  needDeployed();
  const taskId = requireArg(args._[1], "taskId");
  const from = await resolveAddr(requireArg(args.from, "--from"), "--from");
  const rating = Number(requireArg(args.rating, "--rating（1 到 5）"));
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) die("--rating 必须是 1 到 5 的整数");

  // 本地先判资格，省得交易预览才报错
  const m = market();
  const t = await m.getTask(taskId);
  if (t.publisher.toLowerCase() !== from.toLowerCase()) die("只有任务发布方能评价。任务 #" + taskId + " 的发布方是 " + t.publisher);
  if (!REVIEWABLE.has(Number(t.state))) die("任务 #" + taskId + " 当前状态是「" + ABI.enums.TaskState[Number(t.state)] + "」，结束后才能评价（撤回的任务不能评价）");
  const existing = await m.reviewOf(taskId);
  if (existing.reviewer !== ethers.ZeroAddress) die("任务 #" + taskId + " 已经评价过，评价不能修改");

  let service = args.service;
  if (!service && Number(t.listingId)) {
    const l = await m.getListing(t.listingId);
    const spec = await fetchJson(l.specURI);
    service = spec && spec.title;
  }
  emitPlan(CD.buildReview(CFG.market, Number(taskId), rating, reviewDoc(args.text, service)), from);
}

/// 服务方回复评价
async function cmdReply(args) {
  needDeployed();
  const taskId = requireArg(args._[1], "taskId");
  const from = await resolveAddr(requireArg(args.from, "--from"), "--from");
  const r = await market().reviewOf(taskId);
  if (r.reviewer === ethers.ZeroAddress) die("任务 #" + taskId + " 还没有评价");
  if (r.provider.toLowerCase() !== from.toLowerCase()) die("只有该任务的服务方能回复");
  if (r.replyURI) die("这条评价已经回复过");
  emitPlan(CD.buildReply(CFG.market, Number(taskId), reviewDoc(args.text)), from);
}

/// 某个服务方收到的评价
async function cmdReviews(args) {
  needDeployed();
  const addr = await resolveAddr(requireArg(args._[1], "地址或 .ai 名字"), "参数");
  const m = market();
  const [stats, name] = await Promise.all([m.statsOf(addr), names().nameOf(addr)]);
  // 不扫事件日志（公共节点对 eth_getLogs 限流），直接按任务找：这个服务方参与过、已结束的单，逐个读 reviewOf
  const total = Number(await m.taskCount());
  const ids = [];
  for (let id = total; id >= 1 && total - id < 500; id--) ids.push(id);
  const tasks = await Promise.all(ids.map((id) => m.getTask(id)));
  const mine = ids.filter((id, i) => tasks[i].provider.toLowerCase() === addr.toLowerCase() && REVIEWABLE.has(Number(tasks[i].state)));
  const reviewed = (await Promise.all(mine.map(async (id) => ({ id, r: await m.reviewOf(id) })))).filter((x) => x.r.reviewer !== ethers.ZeroAddress);
  const items = await Promise.all(reviewed.map(async ({ id, r }) => {
    const doc = Inline.decode(r.uri) || {};
    const rep = r.replyURI ? Inline.decode(r.replyURI) || {} : null;
    return {
      taskId: id, rating: Number(r.rating), reviewer: r.reviewer, reviewerName: await names().nameOf(r.reviewer),
      createdAt: fmtTime(r.createdAt), text: doc.text || "", service: doc.service || null, reply: rep ? rep.text || "" : null,
    };
  }));
  items.sort((a, b) => b.taskId - a.taskId);
  const count = Number(stats[0]), sum = Number(stats[1]);
  const avg = count ? Math.round((sum / count) * 10) / 10 : null;
  out(
    who(addr, name) + "\n" +
    "  用户评分 " + (avg == null ? "暂无" : avg + " / 5（" + count + " 条）") +
    (items.length ? "\n\n" + items.map((v) =>
      "#" + v.taskId + "  " + "★".repeat(v.rating) + "☆".repeat(5 - v.rating) + "  " + (v.reviewerName || v.reviewer) +
      (v.service ? "  · " + v.service : "") + "\n    " + v.text + (v.reply != null ? "\n    回复：" + v.reply : "")
    ).join("\n") : ""),
    { address: addr, name, count, sum, average: avg, reviews: items }
  );
}

/// agentry listing <id> | create | update
async function cmdListingRouter(args) {
  const sub = args._[1];
  if (sub === "create") return cmdListingCreate(args);
  if (sub === "create-free") return cmdListingCreateFree(args);
  if (sub === "create-service") return cmdListingCreateService(args);
  if (sub === "update") return cmdListingUpdate(args);
  return cmdListing(args);
}

async function cmdListingCreate(args) {
  needDeployed();
  const from = requireArg(args.from, "--from");
  const spec = JSON.parse(fs.readFileSync(requireArg(args.spec, "--spec <规格文件>"), "utf8"));

  const check = Spec.validateSpec(spec);
  if (!check.ok) die("规格未通过校验：\n  " + check.errors.join("\n  "));
  if (check.warnings.length && !JSON_MODE) {
    console.error("提醒：\n  " + check.warnings.join("\n  ") + "\n");
  }

  const currency = await resolveCurrency(args.currency);
  const duration = parseDuration(requireArg(args.delivery, "--delivery"));
  const price = parseAmount(requireArg(args.price, "--price"), currency.decimals);
  await assertWithinLimits(currency, price, duration);

  const uploaded = await uploadSpec(spec);

  emitPlan(
    CD.buildCreateListing({
      market: CFG.market,
      price,
      currency: currency.address,
      deliveryDuration: duration,
      specURI: uploaded.uri,
      specHash: uploaded.specHash,
    }),
    from
  );
}

/// 合约交付挂牌：服务合约必须实现 IAgentryService，且 agentryProvider() 就是 --from
async function cmdListingCreateService(args) {
  needDeployed();
  needRouter();
  const from = ethers.getAddress(await resolveAddr(requireArg(args.from, "--from"), "--from"));
  const spec = JSON.parse(fs.readFileSync(requireArg(args.spec, "--spec <规格文件>"), "utf8"));
  const target = String(requireArg(args.target, "--target <服务合约地址>")).trim();
  if (!ethers.isAddress(target)) die("--target 不是合法地址：" + target);

  // 上链前把路由会做的检查先做一遍，免得白付 gas
  const p = provider();
  if ((await p.getCode(target)) === "0x") die("--target " + target + " 上没有合约代码");
  const svc = new ethers.Contract(target, ABI.service, p);
  const IID = serviceInterfaceId();
  const supports = await svc.supportsInterface(IID).catch(() => false);
  if (!supports) {
    die("--target 没有实现 IAgentryService（ERC-165 接口 " + IID + "）。" +
      "普通合约请用 agentry listing create-free 挂成合约直连");
  }
  const declared = await svc.agentryProvider().catch(() => ethers.ZeroAddress);
  if (declared.toLowerCase() !== from.toLowerCase()) {
    die("服务合约声明的服务方是 " + declared + "，不是 " + from + "。只有它声明的服务方能挂这个合约");
  }
  const svcRouter = await svc.router().catch(() => null);
  if (svcRouter && svcRouter.toLowerCase() !== CFG.router.toLowerCase()) {
    die("服务合约认的路由是 " + svcRouter + "，不是当前市场的路由 " + CFG.router + "，挂上去也没法用");
  }

  const check = Spec.validateSpec(spec);
  if (!check.ok) die("规格未通过校验：\n  " + check.errors.join("\n  "));
  const uploaded = await uploadSpec(spec);

  emitPlan(
    CD.buildCreateServiceListing({ router: CFG.router, target, specURI: uploaded.uri, specHash: uploaded.specHash }),
    from
  );
}

/// agentry use <listingId> --from <addr> [--input <文件>]
/// 使用合约交付服务：先预检，能用才产出预览
async function cmdUse(args) {
  needDeployed();
  needRouter();
  const listingId = requireArg(args._[1], "listingId");
  const from = ethers.getAddress(await resolveAddr(requireArg(args.from, "--from"), "--from"));
  const l = await market().getListing(listingId);
  if (Number(l.kind) !== 2) {
    die(Number(l.kind) === 1
      ? "挂牌 #" + listingId + " 是合约直连服务，直接与 " + l.target + " 交互"
      : "挂牌 #" + listingId + " 是下单服务，用 agentry order " + listingId);
  }

  // 输入：服务规格里约定的格式。没有输入的服务（比如水龙头）传空
  let input = "0x";
  if (args.input) {
    const raw = fs.readFileSync(args.input, "utf8");
    const spec = await fetchJson(l.specURI);
    if (spec) {
      const check = Spec.validateInput(spec, JSON.parse(raw));
      if (!check.ok) die("输入不符合规格：\n  " + check.errors.join("\n  "));
    }
    input = ethers.hexlify(ethers.toUtf8Bytes(raw));
  }

  const r = routerContract();
  const [ok, reason] = await r.canUse(listingId, from, input);
  if (!ok) die("现在用不了挂牌 #" + listingId + "：" + explainUse(reason));

  emitPlan(CD.buildUseService({ router: CFG.router, listingId: Number(listingId), input }), from);
}

const USE_REASONS = {
  "listing not found": "挂牌不存在",
  "not a service listing": "不是合约交付服务",
  "listing inactive": "挂牌已下架",
  "market paused": "市场暂停中",
  "no Agent ID": "这个地址没有 Agent ID",
  "provider cannot use own service": "服务方不能使用自己的服务",
  "service check failed": "服务合约预检出错",
  "listing not bound": "服务合约还没绑定挂牌号",
  "wrong listing": "服务合约绑定的不是这个挂牌",
  "token not set": "水龙头还没设置发放的代币",
  "claim amount not set": "水龙头还没设置每次领取数量",
  "claim limit reached": "这个 Agent ID 已达到领取次数上限",
  "cooling down": "还在冷却期，稍后再领",
  "faucet is empty": "水龙头余额不足",
  "paused": "服务已暂停",
};
const explainUse = (r) => USE_REASONS[r] || r;

function needRouter() {
  if (!CFG.router) die("找不到服务路由地址。请设置 AGENTRY_ROUTER，或在 deployments/" + CFG.chainId + ".json 里加上 AgentryServiceRouter");
}
const routerContract = () => new ethers.Contract(CFG.router, ABI.router, provider());

/// IAgentryService 的 ERC-165 接口号 = 三个函数选择器异或
function serviceInterfaceId() {
  const sel = (sig) => BigInt(ethers.id(sig).slice(0, 10));
  const x = sel("fulfill(uint256,address,bytes)") ^ sel("canServe(uint256,address,bytes)") ^ sel("agentryProvider()");
  return "0x" + x.toString(16).padStart(8, "0");
}

/// 合约直连挂牌：纯目录条目。不收钱、不托管、不陪审，用户直接去和 target 合约交互
async function cmdListingCreateFree(args) {
  needDeployed();
  const from = requireArg(args.from, "--from");
  const spec = JSON.parse(fs.readFileSync(requireArg(args.spec, "--spec <规格文件>"), "utf8"));
  const target = String(requireArg(args.target, "--target <服务合约地址>")).trim();

  if (!ethers.isAddress(target) || /^0x0{40}$/i.test(target)) {
    die("--target 不是合法的合约地址：" + target);
  }
  // 指向一个没有代码的地址，用户去交互时什么也不会发生。上链之前就拦下
  const code = await provider().getCode(target);
  if (!code || code === "0x") {
    die(
      "--target " + target + " 在链 " + CFG.chainId + " 上没有合约代码。" +
      "合约直连必须指向已经部署好的服务合约。不需要合约的免费服务，用 agentry listing create --price 0"
    );
  }

  const check = Spec.validateSpec(spec);
  if (!check.ok) die("规格未通过校验：\n  " + check.errors.join("\n  "));
  if (check.warnings.length && !JSON_MODE) {
    console.error("提醒：\n  " + check.warnings.join("\n  ") + "\n");
  }

  const uploaded = await uploadSpec(spec);

  emitPlan(
    CD.buildCreateFreeListing({
      market: CFG.market,
      target,
      specURI: uploaded.uri,
      specHash: uploaded.specHash,
    }),
    from
  );
}

async function cmdListingUpdate(args) {
  needDeployed();
  const id = requireArg(args._[2], "listingId");
  const from = requireArg(args.from, "--from");

  const l = await market().getListing(id);
  // 免费挂牌没有价格和交付时长，合约只认上下架。别让用户以为改价生效了
  if (Number(l.kind) === 1 && (args.price || args.delivery)) {
    die("挂牌 #" + id + " 是合约直连服务，只能上下架（--active true|false），不能改价或改交付时长");
  }
  const currency = await resolveCurrency(l.currency);

  const price = args.price ? parseAmount(args.price, currency.decimals) : l.price;
  const duration = args.delivery ? parseDuration(args.delivery) : Number(l.deliveryDuration);
  const active = args.active === undefined ? l.active : args.active !== "false";

  if (Number(l.kind) === 0) await assertWithinLimits(currency, price, duration);

  emitPlan(
    CD.buildUpdateListing({
      market: CFG.market,
      listingId: Number(id),
      price,
      deliveryDuration: duration,
      active,
    }),
    from
  );
}

async function cmdRegister(args) {
  needDeployed();
  const from = requireArg(args.from, "--from");
  let uri = args.profileUri;
  if (args.profile) {
    let profile;
    try { profile = JSON.parse(fs.readFileSync(args.profile, "utf8")); }
    catch (e) { die("名片文件不是合法的 JSON：" + e.message); }
    // 头像必填：市场上的服务商页用它做头像和背景
    if (args.avatar) profile.avatar = await uploadAvatar(args.avatar);
    if (!profile.avatar) {
      die("名片需要头像。加上 --avatar <图片文件>（PNG、JPG、WebP 或 GIF，正方形，256 KB 以内），或在名片里填 avatar 链接");
    }
    if (!/^(ipfs:\/\/|https:\/\/)/.test(String(profile.avatar))) die("avatar 必须是 ipfs:// 或 https:// 链接");
    if (CFG.specStore !== "server") {
      // 名片和规格一样直接写进链上
      const enc = Inline.encode(profile);
      if (!enc.fits) die("名片编码后 " + enc.size + " 字节，超过上限 " + Inline.INLINE_MAX + "，精简一下介绍");
      uri = enc.uri;
    } else {
      uri = await uploadRaw(JSON.stringify(profile), "application/json");
    }
  }
  if (!uri) die("需要 --profile <文件> 或 --profile-uri <uri>");
  emitPlan(CD.buildRegister(CFG.market, uri), from);
}

/// 上传头像到内容服务，返回 ipfs:// 链接。按文件头判断类型，不信扩展名
async function uploadAvatar(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch (e) { die("读不到头像文件：" + file); }
  if (buf.length > 256 * 1024) die("头像 " + Math.round(buf.length / 1024) + " KB，超过 256 KB，先压缩或缩小尺寸（建议 512×512 以内）");
  const type =
    buf[0] === 0x89 && buf.toString("latin1", 1, 4) === "PNG" ? "image/png" :
    buf[0] === 0xff && buf[1] === 0xd8 ? "image/jpeg" :
    buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP" ? "image/webp" :
    buf.toString("latin1", 0, 4) === "GIF8" ? "image/gif" : null;
  if (!type) die("头像只支持 PNG、JPG、WebP、GIF");
  return uploadRaw(buf, type);
}

/* ---------- 规格：离线工具，不碰链也不碰内容服务 ----------
   给 Agent 在出确认卡之前用：用户口述需求 → Agent 起草 spec.json →
   `agentry spec check` 过一遍 → 没有错误才把汇总卡给用户看。
   这样用户回复确认之后，listing create / publish 不会再因为规格被拦。 */

function loadCapabilities() {
  try {
    return require("../lib/spec/capabilities.json").capabilities || [];
  } catch (e) {
    return [];
  }
}

async function cmdSpec(args) {
  const sub = args._[1];

  if (sub === "capabilities") {
    const caps = loadCapabilities();
    out(
      caps.map((c) => c.id + "\n    " + c.title + "：" + c.summary).join("\n") ||
        "（没有内置的能力分类表）",
      { capabilities: caps }
    );
    return;
  }

  if (sub === "check") {
    const file = requireArg(args._[2], "spec check <规格文件>");
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      die("读不出规格文件：" + e.message);
    }
    const known = loadCapabilities().map((c) => c.id);
    const r = Spec.validateSpec(doc, { knownCapabilities: known });
    // 规格默认整份写进链上，体积超了提交时会被拦，所以在出确认卡之前就要知道
    const enc = Inline.encode(doc, Spec.canonicalize);
    const tooBig = CFG.specStore !== "server" && !enc.fits;
    if (tooBig) {
      r.errors.push("规格编码后 " + enc.size + " 字节，超过直接上链的上限 " + Inline.INLINE_MAX + " 字节，精简说明、验收标准或样例");
      r.ok = false;
    }
    const data = {
      ok: r.ok,
      errors: r.errors,
      warnings: r.warnings,
      specHash: r.ok ? Spec.hash(doc, ethers.keccak256, ethers.toUtf8Bytes) : null,
      storage: CFG.specStore === "server" ? "server" : "chain",
      onchainBytes: enc.size,
      onchainLimit: Inline.INLINE_MAX,
    };
    out(
      (r.ok ? "规格通过校验" : "规格未通过校验") +
        (r.errors.length ? "\n错误：\n  " + r.errors.join("\n  ") : "") +
        (r.warnings.length ? "\n提醒：\n  " + r.warnings.join("\n  ") : "") +
        (data.specHash ? "\nspecHash " + data.specHash : "") +
        (data.storage === "chain" ? "\n上链体积 " + enc.size + " / " + Inline.INLINE_MAX + " 字节（规格整份写进链上，谁都能读到）" : ""),
      data
    );
    if (!r.ok) process.exitCode = 1;
    return;
  }

  die("用法：agentry spec check <规格文件> | agentry spec capabilities");
}

async function cmdClaimPayout(args) {
  needDeployed();
  const disputeId = requireArg(args._[1], "disputeId");
  const from = requireArg(args.from, "--from");
  const juror = args.juror || from;
  emitPlan(CD.buildClaimJurorPayout(CFG.jury, Number(disputeId), juror), from);
}

async function cmdClaimPending(args) {
  needDeployed();
  const from = requireArg(args.from, "--from");
  const to = args.to || from;
  const currency = await resolveCurrency(args.currency);

  const amount = await market().pendingOf(to, currency.address);
  if (amount === 0n) die(to + " 没有 " + currency.symbol + " 的待领取款项");

  if (!JSON_MODE) {
    console.error("待领取 " + ethers.formatUnits(amount, currency.decimals) +
      " " + currency.symbol + "\n");
  }
  emitPlan(CD.buildClaimPending(CFG.market, to, currency.address), from);
}

/* ---------- 内容服务 ---------- */

async function uploadJson(obj) {
  return uploadRaw(JSON.stringify(obj), "application/json");
}

/// 上传规格，并**在本地复算 specHash 与服务端返回值比对**。
/// 不比对就等于把一个上链的关键值完全交给服务端——
/// 服务端有 bug 或被改了，验收标准就对不上，陪审团会判不了
async function uploadSpec(spec) {
  const local = Spec.hash(spec, ethers.keccak256, ethers.toUtf8Bytes);

  // 默认把规格整份写进链上：不依赖任何服务器，网站和别人的 Agent 都能直接读到
  if (CFG.specStore !== "server") {
    const enc = Inline.encode(spec, Spec.canonicalize);
    if (!enc.fits) {
      die(
        "规格编码后 " + enc.size + " 字节，超过直接上链的上限 " + Inline.INLINE_MAX + " 字节。\n" +
        "  精简一下说明、验收标准或样例；\n" +
        "  或者设置 AGENTRY_SPEC_STORE=server，把规格放到一个公网能访问的内容服务上（同时设置 AGENTRY_CONTENT）"
      );
    }
    // 解码回来复算一遍，确认上链的内容和哈希对得上
    const back = Inline.decode(enc.uri);
    if (!back || Spec.hash(back, ethers.keccak256, ethers.toUtf8Bytes).toLowerCase() !== local.toLowerCase()) {
      die("规格编码后复算哈希不一致，这不正常，在查清楚之前不要上链。");
    }
    return { uri: enc.uri, cid: null, specHash: local, inline: true, size: enc.size };
  }

  const r = await fetch(CFG.content + "/spec", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(spec),
  });
  if (!r.ok) die("规格上传失败：" + (await r.text()));

  const res = await r.json();

  if (res.specHash && res.specHash.toLowerCase() !== local.toLowerCase()) {
    die(
      "内容服务返回的 specHash 与本地复算不一致。\n" +
      "  服务端 " + res.specHash + "\n" +
      "  本地   " + local + "\n" +
      "这不正常，在查清楚之前不要上链。"
    );
  }

  return { uri: res.uri, cid: res.cid, specHash: local };
}

async function uploadRaw(body, type) {
  const r = await fetch(CFG.content + "/content", {
    method: "POST",
    headers: { "Content-Type": type },
    body,
  });
  if (!r.ok) die("上传失败：" + (await r.text()));
  return (await r.json()).uri;
}

async function fetchJson(uri) {
  if (Inline.isInline(uri)) return Inline.decode(uri);
  try {
    const url = uri.startsWith("ipfs://")
      ? CFG.content + "/ipfs/" + uri.slice("ipfs://".length)
      : uri;
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  }
}

/* ---------- 参数解析 ---------- */

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") { JSON_MODE = true; continue; }
    if (a.startsWith("--")) {
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) { args[key] = true; }
      else { args[key] = next; i++; }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function requireArg(v, label) {
  if (v === undefined || v === true) die("缺少参数：" + label);
  return v;
}

/* ---------- 路由 ---------- */

const COMMANDS = {
  // 查询
  listings: cmdListings,
  listing: cmdListingRouter, // listing <id> | create | update
  tasks: cmdTasks, // 任务大厅：服务方找活的入口
  task: cmdTask,
  disputes: cmdDisputes,
  verify: cmdVerify,
  agent: cmdAgent,
  whois: cmdWhois, // 地址 ↔ .ai 名字
  reviews: cmdReviews, // 某个服务方收到的评价

  // 买
  publish: cmdPublish,
  order: cmdOrder,
  use: cmdUse, // 使用合约交付服务（一笔交易完成交付）
  accept: simpleWrite(CD.buildAcceptResult),
  reject: cmdReject,
  cancel: simpleWrite(CD.buildCancelTask),
  review: cmdReview, // 买方评价一单

  // 卖
  register: cmdRegister,
  spec: cmdSpec, // spec check <文件> | spec capabilities
  claim: simpleWrite(CD.buildClaimTask),
  submit: cmdSubmit,
  reply: cmdReply, // 服务方回复评价

  // 陪审
  vote: cmdVote,
  "settle-dispute": simpleWrite(CD.buildSettleDispute, "jury"),
  "claim-payout": cmdClaimPayout,

  // 无需许可的结算
  "settle-review": simpleWrite(CD.buildSettleReviewTimeout),
  "settle-delivery": simpleWrite(CD.buildSettleDeliveryTimeout),
  "claim-pending": cmdClaimPending,
};

function usage() {
  console.log(`agentry —— Agentry 市场命令行

⚠️  本工具不签名、不广播。写操作只产出 baw contract-call preview 命令，
    由你在钱包里看过 parsedTx 与 risks 之后自行确认执行。

查询
  agentry listings [--limit N]          列出在售挂牌（服务方在卖什么）
         [--kind paid|free|service] [--capability <能力标识>]
  agentry listing <id>                  挂牌详情（含规格哈希校验与服务方信誉）
  agentry tasks                         任务大厅：待认领的开放任务
         [--state open|assigned|submitted|disputed|all]
         [--publisher <addr>] [--provider <addr>] [--limit N]
  agentry task <id>                     单个任务的状态与剩余时限
  agentry disputes                      待裁决的争议
  agentry verify <taskId>               校验交付物是否符合声明的 output schema
  agentry agent <地址|名字.ai>          某地址的信誉与 Agent ID（.ai 名字）
  agentry whois <地址|名字.ai>          地址和 .ai 名字互查，市场没部署也能用
  agentry reviews <地址|名字.ai>        某个服务方收到的评价和用户评分

买服务
  agentry order <listingId> --input <文件> --from <addr>
  agentry use <listingId> --from <addr> [--input <文件>]
                         使用合约交付服务（如水龙头）：先预检能不能用，再出预览。一笔交易，不付款、不授权
  agentry publish --spec <文件> --input <文件> --amount 0.05
                  --currency BNB --delivery 1d --from <addr>
  agentry accept <taskId> --from <addr>
  agentry reject <taskId> --reason <文件> --from <addr>
  agentry cancel <taskId> --from <addr>
  agentry review <taskId> --rating 1-5 --text "一句话评价" --from <addr>
                         任务结束后评价服务方（已完成、已退款、对半分、已逾期），一单一评，不能修改

卖服务
  agentry register --profile <文件> --avatar <图片> --from <addr>
                         头像必填：PNG/JPG/WebP/GIF，正方形，256 KB 以内
  agentry listing create --spec <文件> --price 0.05
                         --currency BNB --delivery 1d --from <addr>
                         --price 0 即免费服务：照常下单、交付、评价，不托管、不进陪审，交付时长最短 1h
  agentry listing create-service --spec <文件> --target <服务合约地址> --from <addr>
                         合约交付：服务合约实现 IAgentryService，用户一笔交易完成使用，市场记一张已完成订单，可评价
  agentry listing create-free --spec <文件> --target <服务合约地址> --from <addr>
                         合约直连：纯目录条目，用户直接和 target 合约交互（水龙头、链上工具）
  agentry listing update <id> [--price X] [--delivery 1d] [--active false] --from <addr>
  agentry claim <taskId> --from <addr>
  agentry submit <taskId> --file <文件> --from <addr>
  agentry reply <taskId> --text "回复内容" --from <addr>     回复买方的评价，每条只能回复一次

规格（离线，不碰链）
  agentry spec check <文件>             校验规格，出确认卡之前先过这一步
  agentry spec capabilities             列出能力分类表，帮用户选能力标识

陪审
  agentry vote <disputeId> --side provider|publisher --from <addr>
  agentry settle-dispute <disputeId> --from <addr>
  agentry claim-payout <disputeId> [--juror <addr>] --from <addr>

无需许可的结算（任何人都能触发）
  agentry settle-review <taskId> --from <addr>
  agentry settle-delivery <taskId> --from <addr>
  agentry claim-pending [--to <addr>] [--currency BNB] --from <addr>

金额与时长
  --amount / --price   人类可读，按币种小数位换算（0.05、10）
  --delivery           秒数或带后缀：86400 / 24h / 1d / 90m
  --currency           BNB（默认）、USDT，或代币合约地址
  --publisher / --provider  地址或 .ai 名字都行

环境变量
  AGENTRY_CHAIN_ID   默认 56
  AGENTRY_MARKET     市场合约地址（也可从 deployments/ 读取）
  AGENTRY_JURY       陪审合约地址
  AGENTRY_RPC        RPC 节点
  AGENTRY_AGENT_ID   Agent ID 合约，默认 BSC 上的 SPACE ID Agent ID
  AGENTRY_CONTENT    内容服务地址，默认 https://agentrys.fun/content（输入材料、交付物用）
  AGENTRY_SPEC_STORE 规格和名片存哪：chain（默认，直接写进链上）或 server（上传到内容服务）
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];

  if (!cmd || cmd === "help" || args.help) { usage(); return; }

  const fn = COMMANDS[cmd];
  if (!fn) die("没有这个命令：" + cmd + "（agentry help 查看用法）");

  await fn(args);
}

if (require.main === module) {
  main().catch((e) => die(e.message || String(e)));
}

// 导出给测试用：文档里承诺的命令必须都在这里面
module.exports = { COMMANDS, parseDuration, usage };
