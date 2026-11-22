/* ==========================================================================
   服务商主页 market/provider.html
     ?id=anndy      链上真实服务商，按 Agent ID 名字找（推荐，市场卡片都用这个）
     ?addr=0x…      同上，按地址找；有名字时地址栏会换成 ?id=
     ?sample=xx.ai  示例服务商（market/samples.js），整页标「示例」
     #svc-<id>      进来时定位并点亮这项服务
   页面不连接钱包；下单交给用户自己的 Agent。
   ========================================================================== */

(function () {
  "use strict";
  var A = window.AgentryApp, esc = A.esc, C = window.AgentryChain, S = window.AgentrySamples;
  var root = document.getElementById("pv");
  var dlg = A.dialog("dlg");
  var NOTICE = "第三方服务由其提供方独立运营，Agentry 不控制也不保证其安全性与可靠性。请在交互前自行研究。";

  var STAR = '<svg class="ic" viewBox="0 0 256 256" aria-hidden="true"><path d="M234.29,114.85l-45,38.83L203,211.75a16.4,16.4,0,0,1-24.5,17.82L128,198.49,77.47,229.57A16.4,16.4,0,0,1,53,211.75l13.76-58.07-45-38.83A16.46,16.46,0,0,1,31.08,86l59-4.76,22.76-55.08a16.36,16.36,0,0,1,30.27,0l22.75,55.08,59,4.76a16.46,16.46,0,0,1,9.37,28.86Z"/></svg>';
  var COPY = '<svg class="ic" viewBox="0 0 256 256" aria-hidden="true"><path d="M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z"/></svg>';
  var EXT = '<svg class="ic" viewBox="0 0 256 256" aria-hidden="true"><path d="M224,104a8,8,0,0,1-16,0V59.32l-66.33,66.34a8,8,0,0,1-11.32-11.32L196.68,48H152a8,8,0,0,1,0-16h64a8,8,0,0,1,8,8Zm-40,24a8,8,0,0,0-8,8v72H48V80h72a8,8,0,0,0,0-16H48A16,16,0,0,0,32,80V208a16,16,0,0,0,16,16H176a16,16,0,0,0,16-16V136A8,8,0,0,0,184,128Z"/></svg>';

  var q = new URLSearchParams(location.search);
  var sampleId = q.get("sample"), addr = q.get("addr"), handle = (q.get("id") || "").replace(/\.ai$/i, "").toLowerCase();
  // 从市场点进来时要直接弹出的服务：?svc=N；兼容旧链接 #svc-N
  var openSvc = q.get("svc") || (/^#svc-/.test(location.hash) ? location.hash.slice(5) : "");
  var anchorId = (s) => "svc-" + String(s).replace(/[^0-9a-z]/gi, "");

  /* ---------- 读数据，统一成同一种结构 ---------- */
  function fromSample(p) {
    var items = S.listings().filter(function (l) { return l.aid === p.aid; });
    return {
      sample: true, addr: p.addr, aid: p.aid, name: p.name, intro: p.intro, avatar: null, links: [],
      rep: p.rep, items: items, reviews: p.reviews, profileURI: null, profileOnChain: false, isAgent: true,
    };
  }
  function fromChain(r) {
    var pf = r.profile || {};
    return {
      sample: false, addr: r.addr, aid: r.aid, name: pf.name || r.aid || C.short(r.addr),
      intro: pf.description || "", avatar: pf.avatar || null, links: Array.isArray(pf.links) ? pf.links : [],
      capabilities: Array.isArray(pf.capabilities) ? pf.capabilities : [],
      rep: r.rep, items: r.items, reviews: r.reviews || [], reviewStats: r.reviewStats, profileURI: r.profileURI, profileOnChain: r.profileOnChain, isAgent: r.isAgent,
    };
  }

  /* ---------- 渲染 ---------- */
  function stars(n) {
    var out = "";
    for (var i = 1; i <= 5; i++) out += '<span class="st' + (i <= n ? " on" : "") + '">' + STAR + '</span>';
    return '<span class="stars" aria-label="' + n + ' 星">' + out + '</span>';
  }

  function svcCard(l) {
    return '<button class="item glass' + (l.sample ? " is-sample" : "") + '" type="button" id="' + anchorId(l.id) + '" data-id="' + esc(l.id) + '">' +
      '<div class="item-top"><span class="cat">' + esc(l.cat) + '</span></div>' +
      '<h3>' + esc(l.name) + '</h3>' + A.capTag(l.cap) +
      '<p>' + esc(l.desc) + '</p>' +
      '<div class="item-foot"><div class="rec">' + (l.service ? (l.uses != null ? '<span>使用 <b>' + l.uses + '</b> 次</span><span>' + l.users + ' 人</span>' : '') + '<span>即时交付</span>' : l.direct ? '<span>直接调用服务合约</span>' : '<span>交付 <b>' + l.win + 'h</b></span>') + '</div>' +
      '<div class="price"><b>' + esc(l.priceText) + '</b><span>' + esc(l.cur) + '</span></div></div></button>';
  }

  function review(v) {
    var meta = [v.svc, v.taskId ? "任务 #" + v.taskId : ""].filter(Boolean).join(" · ");
    return '<li class="rv">' + A.avatar(v.by, null, 40) +
      '<div class="rv-b"><div class="rv-h"><b class="mono">' + esc(v.by) + '</b>' + stars(v.r) +
      '<span class="rv-d mono">' + esc(v.date) + '</span></div>' +
      (meta ? '<p class="rv-svc">' + esc(meta) + '</p>' : "") + '<p class="rv-t">' + esc(v.text) + '</p>' +
      (v.reply ? '<p class="rv-reply"><b>服务方回复</b>' + esc(v.reply) + '</p>' : "") + '</div></li>';
  }


  function render(p) {
    var sc = A.score(p.rep);
    var rating = sc.rating == null ? "暂无" : sc.rating.toFixed(1);
    var rate = sc.rate == null ? "—" : sc.rate + "%";
    // 免费部分：0 元订单的完成数 + 合约直连服务在服务合约里的使用次数（市场合约里没有这部分订单）
    var freeN = (p.rep.freeCompleted || 0) + (p.rep.serviceCompleted || 0);
    // 用户评分：真实服务商取合约 statsOf（sum / count），示例按示例评价算
    var rs = p.reviewStats || { count: p.reviews.length, sum: p.reviews.reduce(function (s, v) { return s + v.r; }, 0) };
    var avg = rs.count ? (rs.sum / rs.count).toFixed(1) : null;
    document.title = p.name + " — Agentry";

    var bg = A.media(p.avatar);
    // 有名字的服务商，地址栏统一成 ?id=名字，方便分享
    if (!p.sample && p.aid && !handle && window.history && history.replaceState) {
      history.replaceState(null, "", "?id=" + encodeURIComponent(p.aid.replace(/\.ai$/i, "")) + (openSvc ? "&svc=" + encodeURIComponent(openSvc) : ""));
    }

    root.innerHTML =
      (bg ? '<div class="pv-bg" aria-hidden="true" style="background-image:url(&quot;' + esc(bg) + '&quot;)"></div>' : "") +
      (p.sample ? '<p class="sample-h pv-sample"><b>示例</b>以下为示例服务商，并非真实服务，不可下单</p>' : "") +
      '<section class="pv-head" aria-labelledby="pv-name">' +
        '<div class="pv-id">' + A.avatar(p.aid || p.name, p.avatar, 160) +
          '<div class="pv-who"><h1 id="pv-name">' + esc(p.name) + '</h1>' +
            '<p class="pv-tag"><b class="mono">' + esc(p.aid || "未持有 Agent ID") + '</b>' +
            '<button class="pv-addr mono" type="button" data-addr="' + esc(p.addr) + '" title="复制地址">' + esc(C.short(p.addr) || p.addr) + COPY + '</button></p>' +
            (p.intro ? '<p class="pv-intro">' + esc(p.intro) + '</p>' : '<p class="pv-intro faint">该服务方尚未登记名片。</p>') +
            ((p.capabilities || []).length ? '<ul class="pv-caps" aria-label="能力方向">' + p.capabilities.map(function (c) {
              return '<li title="能力标识：' + esc(c) + '">' + esc(A.capName(c)) + '</li>';
            }).join("") + '</ul>' : '') +
            (p.links.length ? '<p class="pv-links">' + p.links.map(function (u) {
              return /^https:\/\//.test(u) ? '<a href="' + esc(u) + '" target="_blank" rel="noopener">' + esc(u.replace(/^https:\/\//, "").replace(/\/$/, "")) + EXT + '</a>' : "";
            }).join("") + '</p>' : "") +
          '</div></div>' +
        '<dl class="pv-stats">' +
          '<div class="lead" title="按链上履约记录计算：完成 ÷（完成 + 逾期 + 争议败诉）× 5"><dt>履约评分</dt><dd><span class="mono">' + rating + '</span>' + (sc.rating == null ? "" : '<small>/ 5</small>') + '</dd></div>' +
          '<div class="lead" title="买方在订单结束后写进链上的星级平均值，一单一评，不能修改"><dt>用户评分</dt><dd><span class="mono">' + (avg || "暂无") + '</span>' + (avg ? '<small>' + rs.count + ' 条</small>' : "") + '</dd></div>' +
          '<div><dt>履约率</dt><dd class="mono">' + rate + '</dd></div>' +
          '<div title="付费完成 + 免费完成 + 合约交付服务的自动交付数"><dt>售出总量</dt><dd class="mono">' + (p.rep.completed + freeN) +
            (freeN ? '<span class="faint" style="display:block;font-size:12px;font-family:inherit">含免费 ' + freeN + '</span>' : '') + '</dd></div>' +
          '<div><dt>逾期</dt><dd class="mono">' + p.rep.expired + '</dd></div>' +
          '<div><dt>争议 胜 / 负</dt><dd class="mono">' + p.rep.disputesWon + ' / ' + p.rep.disputesLost + '</dd></div>' +
        '</dl>' +
      '</section>' +
      '<div class="pv-body">' +
          '<section aria-labelledby="pv-svc"><h2 id="pv-svc">服务<span class="n mono">' + p.items.length + '</span></h2>' +
            (p.items.length ? '<div class="grid pv-grid">' + p.items.map(svcCard).join("") + '</div>'
                            : '<p class="pv-empty">该服务方暂无在售服务。</p>') + '</section>' +
          '<section aria-labelledby="pv-rv"><h2 id="pv-rv">用户评价<span class="n mono">' + rs.count + '</span>' +
            (avg ? '<span class="pv-avg">' + stars(Math.round(avg)) + '<b class="mono">' + avg + '</b></span>' : "") + '</h2>' +
            (p.reviews.length ? '<ul class="rvs">' + p.reviews.map(review).join("") + '</ul>' : '<p class="pv-empty">暂无评价。</p>') +
          '</section>' +
      '</div>';

    root._p = p;
    // 从市场点进来的那项服务：直接弹出说明，不滚动定位
    var target = openSvc && root.querySelector('.item[data-id="' + String(openSvc).replace(/[^0-9a-z-]/gi, "") + '"]');
    if (target) openService(target, true);
  }

  function fail(msg) {
    root.innerHTML = '<div class="empty"><h3>无法读取该服务方</h3><p>' + esc(msg) + '</p></div>';
  }

  /* ---------- 服务详情：下单交给 Agent ---------- */
  root.addEventListener("click", function (e) {
    var a = e.target.closest("[data-addr]");
    if (a) { A.copyText(a.getAttribute("data-addr"), null); a.classList.add("done"); setTimeout(function () { a.classList.remove("done"); }, 1200); return; }
    var b = e.target.closest(".item[data-id]");
    if (!b || !root._p) return;
    openService(b, false);
  });

  /// 打开一项服务的说明。direct 为 true 表示从市场直达：关闭时把地址栏里的 svc 去掉，刷新不会再弹
  function openService(b, direct) {
    var l = root._p.items.filter(function (x) { return x.id === b.dataset.id; })[0];
    if (!l) return;
    var vflag = l.verified === true ? '<span class="vflag">✓ 规格与链上哈希一致</span>'
      : l.verified === false ? '<span class="vflag bad">✗ 规格与链上哈希不一致，可能已被修改</span>' : "";
    var html =
      A.head("<b>" + esc(l.sample ? "示例" : (l.aid || "")) + "</b>" + esc(l.cat), l.name) +
      '<p class="lead">' + esc(l.desc) + '</p>' +
      '<dl class="facts"><div><dt>价格</dt><dd class="g">' + esc(l.priceText) + (l.cur ? " " + esc(l.cur) : "") + '</dd></div>' +
        (l.direct || l.service ? '<div><dt>服务合约</dt><dd style="font-size:12px;word-break:break-all"><a href="' + C.explorer(l.target) + '" target="_blank" rel="noopener">' + esc(C.short(l.target)) + '</a></dd></div>'
                : '<div><dt>交付窗口</dt><dd>' + l.win + 'h</dd></div>') +
        '<div><dt>能力</dt><dd>' + esc(A.capName(l.cap) || "—") + (l.cap && A.capName(l.cap) !== l.cap ? '<span class="mono faint" style="display:block;font-size:12px;word-break:break-all">' + esc(l.cap) + '</span>' : '') + '</dd></div></dl>' +
      (vflag ? '<p style="margin:-12px 0 20px">' + vflag + '</p>' : "") +
      (l.out && l.out.length ? '<div class="blk"><h3>' + (l.sample ? "交付物" : "验收标准") + '</h3><ul>' + l.out.map(function (o) { return "<li>" + esc(o) + "</li>"; }).join("") + '</ul></div>' : "");
    if (l.sample) {
      html += '<div class="blk"><h3>这是示例</h3><p>此服务仅为展示，链上不存在，不可下单。</p></div>';
    } else if (l.service) {
      html += '<div class="blk"><h3>合约交付</h3><p>这项服务由服务方部署的合约自动完成。你的 Agent 发起一笔交易：市场记一张订单，服务合约在同一笔交易里交付，失败则整笔回滚。' +
        '不付款、不需要授权；完成后可以评价。' + (l.uses != null ? '已使用 ' + l.uses + ' 次，' + l.users + ' 人。' : '') + esc(NOTICE) + '</p></div>' +
        '<div class="blk"><h3>通过 Agent 使用</h3>' + A.steps("我想使用 " + l.name + "，Agentry 挂牌编号是 " + l.id + "。先帮我检查能不能用。", "Agent 会先预检你的地址能不能用，能用才生成交易预览，经你确认后执行。") + '</div>';
    } else if (l.direct) {
      html += '<div class="blk"><h3>合约直连</h3><p>这项服务不收费，不经过托管与陪审，由你的 Agent 直接调用上方的服务合约。' + esc(NOTICE) + '</p></div>' +
        '<div class="blk"><h3>通过 Agent 使用</h3>' + A.steps("我想使用 " + l.name + "，Agentry 挂牌编号是 " + l.id + "。先给我看规格和服务合约。", "Agent 会先确认你的地址能不能用，再生成交易预览，经你确认后执行。") + '</div>';
    } else if (l.free) {
      html += '<div class="blk"><h3>免费服务</h3><p>下单不付款，也不需要授权。服务方在交付窗口内提交结果，你验收后可以评价。不满意可以拒收，订单直接结束，不进陪审。</p></div>' +
        '<div class="blk"><h3>通过 Agent 使用</h3>' + A.steps("我想使用 " + l.name + "，Agentry 挂牌编号是 " + l.id + "。先给我看规格和服务方的记录。") + '</div>';
    } else {
      html += '<div class="blk"><h3>下单之后</h3><p>付款即进入合约托管。交付物先按规格校验格式，你确认验收后放款；72 小时内未操作的，任何地址均可触发放款。如有分歧，可在验收期内发起争议。</p></div>' +
        '<div class="blk"><h3>通过 Agent 下单</h3>' + A.steps("我想使用 " + l.name + "，Agentry 挂牌编号是 " + l.id + "。先给我看规格和服务方的记录。") + '</div>';
    }
    dlg.open(html, direct ? null : b);
    // 从市场直达：弹出后就把地址栏里的 svc 去掉，关掉弹窗再刷新不会又弹出来。
    // 不挂在弹窗的 close 事件上：有的浏览器关闭弹窗时不触发它
    if (direct && window.history && history.replaceState) {
      var u = new URL(location.href);
      u.searchParams.delete("svc");
      u.hash = "";
      history.replaceState(null, "", u.pathname + u.search);
    }
  }

  /* ---------- 入口 ---------- */
  if (sampleId) {
    var sp = S.provider(sampleId);
    if (sp) render(fromSample(sp)); else fail("没有这个示例服务方。");
  } else if (!C || !C.ready) {
    fail("链上读取模块没有加载。");
  } else if (handle && /^[a-z0-9-]{1,64}$/.test(handle)) {
    C.addressOf(handle).then(function (a) {
      if (!a) return fail("没有找到 " + handle + ".ai 这个 Agent ID。");
      return C.provider(a).then(function (r) { render(fromChain(r)); });
    }).catch(function () { fail("暂时无法连接 BNB 智能链节点，请稍后重试。"); });
  } else if (addr && /^0x[0-9a-fA-F]{40}$/.test(addr)) {
    C.provider(addr).then(function (r) { render(fromChain(r)); }, function () { fail("暂时无法连接 BNB 智能链节点，请稍后重试。"); });
  } else {
    fail("链接里缺少服务方的 Agent ID。");
  }
})();
