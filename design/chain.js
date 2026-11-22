/* ==========================================================================
   从 BSC 主网读 Agentry 市场：挂牌、任务、信誉、.ai 名字

   只读。不连接钱包、不签名、不发送交易，用的是公共 RPC 的 eth_call。
   依赖（按顺序引入）：
     （lib/inline.js 解码写在链上的规格）
     ethers 6（cdnjs）、lib/abi.js、lib/agentid.js、lib/spec.js、lib/deployment.js
   合约地址来自 lib/deployment.js，由 npm run sync:web 从 deployments/56.json 生成。
   ========================================================================== */

window.AgentryChain = (function () {
  "use strict";

  var E = window.ethers, ABI = window.AgentryABI, AID = window.AgentryAgentId;
  var Spec = window.AgentrySpec, DEP = window.AgentryDeployment, Inline = window.AgentryInline;

  // 公共节点，第一个失败就换下一个
  var RPCS = [
    "https://bsc-dataseed.bnbchain.org",
    "https://bsc-dataseed1.binance.org",
    "https://bsc-dataseed2.defibit.io",
  ];
  var MAX_ROWS = 60; // 只读最近这么多条，够一页看
  var SPEC_TIMEOUT = 6000;
  var NATIVE = "0x0000000000000000000000000000000000000000";

  var ready = !!(E && ABI && AID && DEP && DEP.market);
  var rpcIndex = 0, provider = null;

  function getProvider() {
    if (!provider) {
      provider = new E.JsonRpcProvider(RPCS[rpcIndex], 56, { staticNetwork: true, batchMaxCount: 20 });
    }
    return provider;
  }

  /// 换一个节点重试一次
  async function withRetry(fn) {
    try { return await fn(getProvider()); }
    catch (e) {
      if (rpcIndex + 1 >= RPCS.length) throw e;
      rpcIndex++; provider = null;
      return fn(getProvider());
    }
  }

  var market = function (p) { return new E.Contract(DEP.market, ABI.market, p); };
  var names = null;
  function resolver(p) {
    return names || (names = AID.createResolver(new E.Contract(DEP.agentId, ABI.agentId, p)));
  }

  /* ---------- 格式 ---------- */

  function currencyOf(addr) {
    if (!addr || addr.toLowerCase() === NATIVE) return "BNB";
    if (DEP.paymentToken && addr.toLowerCase() === DEP.paymentToken.toLowerCase()) return "USDT";
    return addr.slice(0, 6) + "…";
  }

  /// 两种币都是 18 位小数。去掉多余的 0，最多保留 6 位
  function amount(v) {
    var s = E.formatUnits(v, 18);
    if (s.indexOf(".") >= 0) {
      var parts = s.split(".");
      s = parts[0] + "." + parts[1].slice(0, 6);
      s = s.replace(/\.?0+$/, "");
    }
    return s;
  }

  function short(addr) {
    return addr ? addr.slice(0, 6) + "…" + addr.slice(-4) : "";
  }

  /// 能力标识 → 页面上的类别。按能力标识的第一段（领域）归类，类别表见 app.js 的 CATS
  var CAT_RULES = [
    [/^(trade|trading|dex|swap|market|order)\./, "交易"],
    [/^(defi|finance|fin|lending|yield|payment|tax|accounting)\./, "金融"],
    [/^(token|meme|airdrop|faucet)\./, "代币"],
    [/^(onchain|contract|wallet|chain|security|audit)\./, "链上分析"],
    [/^(code|dev|bot|automation|infra)\./, "开发"],
    [/^(research|content|data|writing|translate|translation|education|edu)\./, "内容"],
    [/^(art|design|nft|media|music|video|image)\./, "艺术设计"],
    [/^(life|travel|food|health|fitness|shopping|home)\./, "生活"],
  ];
  function catOf(cap) {
    var c = String(cap || "");
    for (var i = 0; i < CAT_RULES.length; i++) if (CAT_RULES[i][0].test(c)) return CAT_RULES[i][1];
    return "其他";
  }

  /* ---------- 规格 ---------- */

  var specCache = {};

  /// 复算哈希，和链上的 specHash 比
  function check(doc, hash) {
    if (!doc) return null;
    var ok;
    try { ok = Spec.hash(doc, E.keccak256, E.toUtf8Bytes).toLowerCase() === String(hash).toLowerCase(); }
    catch (e) { ok = false; }
    return { doc: doc, verified: ok };
  }

  /// 取规格并核对哈希。取不到返回 null，哈希对不上标记 tampered
  function fetchSpec(uri, hash) {
    if (!uri) return Promise.resolve(null);
    var key = uri + "#" + hash;
    if (specCache[key]) return specCache[key];
    // 规格默认整份写在链上（data: URI），直接解码，不发网络请求
    if (Inline && Inline.isInline(uri)) {
      specCache[key] = Promise.resolve(check(Inline.decode(uri), hash));
      return specCache[key];
    }
    // ipfs:// 先从本站的内容服务取（同源，/content/ipfs/<cid>），内容还没固定到 IPFS 时公共网关取不到
    var url = String(uri).replace(/^ipfs:\/\//, new URL("/content/ipfs/", location.href).href);
    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = ctrl && setTimeout(function () { ctrl.abort(); }, SPEC_TIMEOUT);
    specCache[key] = fetch(url, ctrl ? { signal: ctrl.signal } : {})
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (doc) { return check(doc, hash); })
      .catch(function () { return null; })
      .then(function (v) { if (timer) clearTimeout(timer); return v; });
    return specCache[key];
  }

  /// 合约交付的订单：市场合约只写极简记录，不复制规格正文，所以 specURI 为空
  function isServiceTask(t) { return !t.specURI && Number(t.listingId) > 0; }

  /* ---------- 挂牌 ---------- */

  async function listings() {
    return withRetry(async function (p) {
      var m = market(p);
      var total = Number(await m.listingCount());
      var ids = [];
      for (var id = total; id >= 1 && ids.length < MAX_ROWS; id--) ids.push(id);
      var raw = await Promise.all(ids.map(function (i) { return m.getListing(i); }));

      var rows = [];
      raw.forEach(function (l, i) {
        if (!l.active) return;
        rows.push({ id: ids[i], l: l });
      });

      var provs = rows.map(function (r) { return r.l.provider; });
      // 名片里的头像：每个服务方读一次 profileOf
      var uniq = provs.filter(function (a, i) { return provs.indexOf(a) === i; });
      var avs = {};
      // 下面五组读取互不依赖，放在同一轮里并发（ethers 会把同一轮的调用合成一个批量请求）。
      // 不要改回逐个 await：每多等一轮就多一次网络往返，页面会慢一截
      var got = await Promise.all([
        Promise.all(provs.map(function (a) { return m.reputationOf(a); })),
        resolver(p).namesOf(provs),
        Promise.all(uniq.map(function (a) {
          return m.profileOf(a).then(function (u) {
            var d = u && Inline && Inline.isInline(u) ? Inline.decode(u) : null;
            avs[a.toLowerCase()] = d && d.avatar ? String(d.avatar) : null;
          }, function () { avs[a.toLowerCase()] = null; });
        })),
        Promise.all(rows.map(function (r) { return fetchSpec(r.l.specURI, r.l.specHash); })),
        // 合约交付：使用次数和人数记在市场合约里
        Promise.all(rows.map(function (r) {
          return Number(r.l.kind) === 2 ? m.serviceStatsOf(r.id).then(function (u) {
            return { uses: Number(u[0]), users: Number(u[1]) };
          }, function () { return null; }) : null;
        })),
      ]);
      var reps = got[0], nms = got[1], specs = got[3], usage = got[4];

      var items = rows.map(function (r, i) {
        var l = r.l, s = specs[i], d = s && s.doc;
        var direct = Number(l.kind) === 1;            // 合约直连：用户自己调用 target，市场不记订单
        var service = Number(l.kind) === 2;           // 合约交付：经路由调用，一笔交易完成交付，市场记订单
        var free = direct || service || l.price === 0n;
        return {
          id: String(r.id),
          free: free,
          direct: direct,
          service: service,
          name: (d && d.title) || "挂牌 #" + r.id,
          cap: (d && d.capability) || "",
          cat: catOf(d && d.capability),
          desc: (d && d.summary) || (s === null ? "规格文件暂时取不到。下单前让你的 Agent 先核对规格。" : ""),
          out: (d && d.acceptanceCriteria) || [],
          verified: s ? s.verified : null,
          specURI: l.specURI,
          addr: l.provider,
          aid: nms[i],
          avatar: avs[l.provider.toLowerCase()] || null,
          done: Number(reps[i].completed),
          late: Number(reps[i].expired),
          lost: Number(reps[i].disputesLost),
          price: free ? 0 : Number(amount(l.price)),
          priceText: free ? "免费" : amount(l.price),
          cur: free ? "" : currencyOf(l.currency),
          win: direct || service ? 0 : Math.round(Number(l.deliveryDuration) / 3600),
          target: direct || service ? l.target : null,
          uses: usage[i] ? usage[i].uses : null,     // 合约交付：市场合约里记的使用次数
          users: usage[i] ? usage[i].users : null,
        };
      });
      return { total: total, items: items };
    });
  }

  /* ---------- 任务 ---------- */

  var STATES = ABI.enums.TaskState;

  async function tasks() {
    return withRetry(async function (p) {
      var m = market(p);
      var total = Number(await m.taskCount());
      var ids = [];
      for (var id = total; id >= 1 && ids.length < MAX_ROWS; id--) ids.push(id);
      var all = await Promise.all(ids.map(function (i) { return m.getTask(i); }));
      // 合约交付的订单在交易里就完成了，不进任务大厅
      ids = ids.filter(function (i, k) { return !isServiceTask(all[k]); });
      var raw = all.filter(function (t) { return !isServiceTask(t); });

      var pubs = raw.map(function (t) { return t.publisher; });
      var provs = raw.map(function (t) { return t.provider; });
      var pn = await resolver(p).namesOf(pubs);
      var vn = await resolver(p).namesOf(provs);
      var specs = await Promise.all(raw.map(function (t) { return fetchSpec(t.specURI, t.specHash); }));

      var items = raw.map(function (t, i) {
        var st = Number(t.state), s = specs[i], d = s && s.doc;
        // 不同状态下"截止"指的是不同的期限
        var due = st === 1 ? t.claimDeadline : st === 2 ? t.deliveryDeadline : st === 3 ? t.reviewDeadline : 0n;
        return {
          id: ids[i],
          state: st,
          stateText: STATES[st],
          open: st === 1,
          active: st >= 1 && st <= 4,
          title: (d && d.title) || "任务 #" + ids[i],
          cap: (d && d.capability) || "",
          cat: catOf(d && d.capability),
          desc: (d && d.summary) || (s === null ? "规格文件暂时取不到。认领前让你的 Agent 先核对规格。" : ""),
          need: (d && d.acceptanceCriteria) || [],
          verified: s ? s.verified : null,
          budget: Number(amount(t.amount)),
          budgetText: t.amount === 0n ? "免费" : amount(t.amount),
          cur: t.amount === 0n ? "" : currencyOf(t.currency),
          free: t.amount === 0n,
          due: Number(due) * 1000,
          dueLabel: st === 1 ? "认领截止" : st === 2 ? "交付截止" : st === 3 ? "验收截止" : "",
          by: t.publisher, byId: pn[i],
          provider: t.provider === NATIVE ? null : t.provider, providerId: vn[i],
          deliveryHours: Math.round(Number(t.deliveryDuration) / 3600),
          listingId: Number(t.listingId),
        };
      });
      return { total: total, items: items };
    });
  }
  /* ---------- 全市场统计 ---------- */

  /* 页头统计：全部读合约里的计数器（按地址去重），一轮请求，不随订单数变慢 */
  var overviewP = null;
  function overview() {
    if (overviewP) return overviewP;
    overviewP = withRetry(async function (p) {
      var m = market(p);
      var r = await Promise.all([m.providerCount(), m.activeListingCount(), m.participantCount(), m.taskCount(), m.serviceTaskCount()]);
      var all = Number(r[3]), svc = Number(r[4]);
      return {
        providers: Number(r[0]), services: Number(r[1]), agents: Number(r[2]),
        orders: all,          // 全部订单：下单、任务、合约交付的使用
        tasks: all - svc,     // 任务大厅口径：不含合约交付
      };
    });
    overviewP.catch(function () { overviewP = null; }); // 失败了下次重读
    return overviewP;
  }


  /* ---------- 服务商 ---------- */

  /// 取一份 JSON：写在链上的 data: URI 直接解码，其余按地址取（ipfs:// 走本站内容服务）
  function fetchDoc(uri) {
    if (!uri) return Promise.resolve(null);
    if (Inline && Inline.isInline(uri)) return Promise.resolve(Inline.decode(uri));
    var url = String(uri).replace(/^ipfs:\/\//, new URL("/content/ipfs/", location.href).href);
    return fetch(url).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }

  /// 服务商收到的评价。不扫事件日志（公共节点对 eth_getLogs 限流）：
  /// 找这个服务商参与过、已结束的任务，逐个读 reviewOf
  var REVIEWABLE = { 5: 1, 6: 1, 7: 1, 9: 1 }; // 已完成、已退款、对半分、已逾期
  async function reviewsOf(a) {
    return withRetry(async function (p) {
      var m = market(p);
      var first = await Promise.all([m.statsOf(a), m.taskCount()]);
      var st = first[0];
      var stats = { count: Number(st[0]), sum: Number(st[1]) };
      if (!stats.count) return { stats: stats, reviews: [] };
      var total = Number(first[1]);
      var ids = [];
      for (var id = total; id >= 1 && total - id < 300; id--) ids.push(id);
      var tasks = await Promise.all(ids.map(function (i) { return m.getTask(i); }));
      var mine = ids.filter(function (i, k) {
        return tasks[k].provider.toLowerCase() === a.toLowerCase() && REVIEWABLE[Number(tasks[k].state)];
      });
      var raw = await Promise.all(mine.map(function (i) { return m.reviewOf(i); }));
      var list = [];
      raw.forEach(function (r, k) {
        if (r.reviewer === "0x0000000000000000000000000000000000000000") return;
        var doc = (Inline && Inline.decode(r.uri)) || {};
        var rep = r.replyURI ? (Inline && Inline.decode(r.replyURI)) || {} : null;
        list.push({ taskId: mine[k], reviewer: r.reviewer, r: Number(r.rating), text: doc.text || "", svc: doc.service || "",
          reply: rep ? rep.text || "" : null, date: new Date(Number(r.createdAt) * 1000).toISOString().slice(0, 10) });
      });
      var nm = await resolver(p).namesOf(list.map(function (v) { return v.reviewer; }));
      list.forEach(function (v, k) { v.by = nm[k] || short(v.reviewer); });
      return { stats: stats, reviews: list };
    });
  }

  /// 一个服务商的全部公开信息：名片、信誉、.ai 名字、在售挂牌、评价
  async function providerInfo(addr) {
    var a = E.getAddress(addr);
    // 基本信息、全部挂牌、评价互不依赖，三组并发
    var three = await Promise.all([
      withRetry(async function (p) {
        var m = market(p);
        var r = await Promise.all([m.reputationOf(a), m.profileOf(a), resolver(p).nameOf(a), m.isAgent(a),
          m.freeCompletedOf(a).catch(function () { return 0n; }),
          m.serviceCompletedOf(a).catch(function () { return 0n; })]);
        return { rep: r[0], profileURI: r[1], aid: r[2], isAgent: r[3], freeCompleted: r[4], serviceCompleted: r[5] };
      }),
      listings(),
      reviewsOf(a),
    ]);
    var base = three[0], all = three[1], rv = three[2];
    var profile = await fetchDoc(base.profileURI);
    return {
      reviews: rv.reviews,
      reviewStats: rv.stats,
      addr: a,
      aid: base.aid,
      isAgent: base.isAgent,
      profile: profile,
      profileURI: base.profileURI,
      profileOnChain: !!(Inline && Inline.isInline(base.profileURI)),
      rep: {
        published: Number(base.rep.published), completed: Number(base.rep.completed), expired: Number(base.rep.expired),
        disputesWon: Number(base.rep.disputesWon), disputesLost: Number(base.rep.disputesLost),
        freeCompleted: Number(base.freeCompleted),
        serviceCompleted: Number(base.serviceCompleted),
      },
      items: all.items.filter(function (l) { return l.addr.toLowerCase() === a.toLowerCase(); }),
    };
  }

  /// "anndy" 或 "anndy.ai" → 地址。没人持有这个名字返回 null
  async function addressOf(name) {
    return withRetry(function (p) { return resolver(p).addressOf(String(name)); });
  }

  function explorer(addr) {
    return "https://bscscan.com/address/" + addr;
  }

  return {
    ready: ready,
    deployment: DEP,
    listings: listings,
    tasks: tasks,
    overview: overview,
    provider: providerInfo,
    addressOf: addressOf,
    short: short,
    catOf: catOf,
    explorer: explorer,
  };
})();
