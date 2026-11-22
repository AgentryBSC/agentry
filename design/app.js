/* ==========================================================================
   Agent 市场、任务大厅共用的小工具

   照 OKX.AI 的做法：网页只负责「看」，「办」在用户自己的 Agent 里。
   入驻、发需求、下单、认领，页面都不收表单，只告诉用户三件事：
     1. 准备好什么（Agentic Wallet、Agent ID、开发者模式）
     2. 给 Agent 装上 Agentry Skill
     3. 对 Agent 说一句什么话
   之后由 Agent 读 skills/agentry 里的流程，一组一组问清信息，
   出确认卡，再把每一笔交易交给钱包预览、由用户确认。
   页面本身不连接钱包、不发送任何东西。
   ========================================================================== */

window.AgentryApp = (function () {
  "use strict";

  /* Skill 就放在网站上：/skills/agentry/SKILL.md（由 npm run publish:skill 同步）。
     网址按 app.js 自己所在的位置算，换域名、放子目录都不用改这里 */
  var BASE = (document.currentScript && document.currentScript.src) || location.href;
  var SKILL_URL = new URL("skills/agentry/SKILL.md", BASE).href;
  var SKILL_ZIP = new URL("skills/agentry.zip", BASE).href;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function copyText(text, btn) {
    function ok() {
      if (!btn) return;
      var old = btn.textContent;
      btn.textContent = "已复制";
      btn.classList.add("done");
      setTimeout(function () { btn.textContent = old; btn.classList.remove("done"); }, 1600);
    }
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text; ta.setAttribute("readonly", "");
      ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); ok(); } catch (e) {}
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(ok, fallback);
    else fallback();
  }

  /* 一句可以复制给 Agent 的话 */
  function sayBox(text, label) {
    return '<div class="say"><div class="say-bar"><span>' + esc(label || "发给你的 Agent") + '</span>' +
      '<button class="copy" type="button" data-copy>复制</button></div>' +
      '<p class="say-text">' + esc(text) + '</p></div>';
  }

  var SHIELD = '<svg class="ic" viewBox="0 0 256 256" aria-hidden="true"><path d="M208,40H48A16,16,0,0,0,32,56v58.78c0,89.61,75.82,119.34,91,124.39a15.53,15.53,0,0,0,10,0c15.2-5.05,91-34.78,91-124.39V56A16,16,0,0,0,208,40Zm0,74.79c0,78.42-66.35,104.62-80,109.18-13.53-4.51-80-30.69-80-109.18V56H208ZM82.34,141.66a8,8,0,0,1,11.32-11.32L112,148.69l50.34-50.35a8,8,0,0,1,11.32,11.32l-56,56a8,8,0,0,1-11.32,0Z"/></svg>';

  function safeNote() {
    return '<p class="safe">' + SHIELD + '<span>本页面不连接钱包，不发起任何交易。每笔交易均由 Agent 提交至 Agentic Wallet 预览，经你确认后执行。' +
      'Agentry 不会索取助记词、私钥或配对码。</span></p>';
  }

  /* 三步引导：准备 → 装 Skill → 说一句话 */
  function steps(say, after) {
    return '<ol class="steps3">' +
      '<li><b>准备钱包</b><p>在币安 App 中开通 Agentic Wallet 并领取 Agent ID（钱包 → 首页横幅 → Agent ID），' +
        '然后在 Agentic Wallet 设置中开启开发者模式。</p></li>' +
      '<li><b>安装 Agentry Skill</b><p>将下方指令发给你的 Agent。安装后，它将按 Agentry 的规则逐步向你确认信息。</p>' +
        sayBox("安装这个 skill：" + SKILL_URL + "（同一目录下 references/ 里的文件也要一起读，清单见 index.json）", "发给你的 Agent") +
        '<p>手动安装：<a class="dl" href="' + esc(SKILL_ZIP) + '" download>下载 agentry.zip</a>，解压至 Agent 的 skills 目录。</p></li>' +
      '<li><b>向 Agent 发送指令</b>' + sayBox(say) + (after ? '<p>' + after + '</p>' : '') + '</li>' +
      '</ol>' + safeNote();
  }

  var CLOSE = '<button class="x" type="button" data-close aria-label="关闭"><svg class="ic" viewBox="0 0 256 256" aria-hidden="true"><path d="M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z"/></svg></button>';

  function head(kicker, title) {
    return '<div class="sheet-h"><div><p class="kicker">' + kicker + '</p><h2>' + esc(title) + '</h2></div>' + CLOSE + '</div>';
  }

  /* 两个固定的引导：服务商入驻、发需求 */
  var GUIDE = {
    provider: function () {
      return head("<b>入驻</b>服务商", "在 Agent 中入驻") +
        '<p class="lead">入驻无需填写网页表单。Agent 会向你确认名称、能力、输入、交付内容、验收标准、价格与交付时长，' +
        '整理成名片和首条挂牌，交由你确认。</p>' +
        steps("我要在 Agentry 上入驻成服务商，把我的能力挂出去。",
          "Agent 会先展示汇总信息，经你确认后提交。提交共两笔交易（名片、挂牌），每笔均在钱包中预览。");
    },
    request: function () {
      return head("<b>发布</b>买方", "在 Agent 中发布需求") +
        '<p class="lead">发布需求无需填写网页表单。向 Agent 说明需求、可提供的材料、期望结果、预算与期限，' +
        'Agent 会先匹配已上架的服务，没有合适的再整理成公开任务，交由你确认。</p>' +
        steps("帮我在 Agentry 上发个任务：（用你自己的话说要做什么、预算多少、多久要）",
          "发布时预算进入合约托管。7 天内无人认领可撤回；认领后逾期未交付，全额退回。");
    },
    jury: function () {
      return head("<b>评审</b>陪审员", "在 Agent 中参与陪审") +
        '<p class="lead">持有 Agent ID 即可参与陪审，无需报名。Agent 会列出待裁决的争议，核对规格是否被修改、交付物格式是否合规，' +
        '再将验收标准、输入与交付物一并呈现，由你作出判断。</p>' +
        steps("我想在 Agentry 当陪审员，看看现在有哪些待判的争议。",
          "投票须缴纳押金：与多数意见一致的，退还押金并分得陪审费；属于少数意见的，押金没收。每一票均在钱包中预览。");
    },
  };

  /* 弹窗：<dialog>，点背景或按 Esc 关，关掉后焦点回到打开它的那个元素 */
  function dialog(id) {
    var d = document.getElementById(id), opener = null;
    if (!d) return null;
    d.addEventListener("click", function (e) {
      if (e.target === d) d.close();
      var c = e.target.closest("[data-copy]");
      if (c) copyText(c.closest(".say").querySelector(".say-text").textContent, c);
      if (e.target.closest("[data-close]")) d.close();
    });
    d.addEventListener("close", function () { if (opener && opener.focus) opener.focus({ preventScroll: true }); opener = null; });
    return {
      open: function (html, from) {
        opener = from === null ? null : from || document.activeElement;
        d.querySelector(".sheet").innerHTML = html;
        if (d.showModal) d.showModal(); else d.setAttribute("open", "");
      },
    };
  }

  /* 市场和任务大厅共用的类别。归类规则在 chain.js 的 catOf */
  var CATS = ["全部", "交易", "金融", "代币", "链上分析", "开发", "内容", "艺术设计", "生活", "其他"];

  /* 下拉选择：替代原生 select，外观和站点一致，支持键盘
     root 是一个空 div；items 是 [{v, t}]；选中后调用 onChange(v) */
  var CHECK = '<svg class="ic" viewBox="0 0 256 256" aria-hidden="true"><path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z"/></svg>';
  var CARET = '<svg class="ic dd-caret" viewBox="0 0 256 256" aria-hidden="true"><path d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z"/></svg>';
  var ddSeq = 0;
  function dropdown(root, label, items, value, onChange) {
    var id = "dd" + (++ddSeq);
    root.classList.add("dd");
    root.innerHTML =
      '<button class="dd-btn" type="button" aria-haspopup="listbox" aria-expanded="false" aria-controls="' + id + '">' +
        '<span class="dd-label">' + esc(label) + '</span><span class="dd-val"></span>' + CARET + '</button>' +
      '<ul class="dd-menu" role="listbox" id="' + id + '" aria-label="' + esc(label) + '" hidden>' +
        items.map(function (it) {
          return '<li role="option" tabindex="-1" data-v="' + esc(it.v) + '"><span>' + esc(it.t) + '</span>' + CHECK + '</li>';
        }).join("") +
      '</ul>';
    var btn = root.querySelector(".dd-btn"), menu = root.querySelector(".dd-menu");
    var opts = [].slice.call(menu.children);

    function set(v) {
      value = v;
      opts.forEach(function (o) { o.setAttribute("aria-selected", String(o.getAttribute("data-v") === v)); });
      var hit = items.filter(function (it) { return it.v === v; })[0];
      root.querySelector(".dd-val").textContent = hit ? hit.t : "";
    }
    function open(on) {
      menu.hidden = !on;
      btn.setAttribute("aria-expanded", String(on));
      root.classList.toggle("open", on);
      if (on) (menu.querySelector('[aria-selected="true"]') || opts[0]).focus();
    }
    function choose(o) { set(o.getAttribute("data-v")); open(false); btn.focus(); onChange(value); }

    btn.addEventListener("click", function () { open(menu.hidden); });
    menu.addEventListener("click", function (e) { var o = e.target.closest("[data-v]"); if (o) choose(o); });
    menu.addEventListener("keydown", function (e) {
      var i = opts.indexOf(document.activeElement);
      if (e.key === "ArrowDown") { e.preventDefault(); opts[Math.min(opts.length - 1, i + 1)].focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); opts[Math.max(0, i - 1)].focus(); }
      else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (i >= 0) choose(opts[i]); }
      else if (e.key === "Escape") { open(false); btn.focus(); }
      else if (e.key === "Tab") open(false);
    });
    document.addEventListener("click", function (e) { if (!root.contains(e.target)) open(false); });
    set(value);
    return { set: set };
  }

  /* 服务商评分：完全按链上履约记录算，不收集主观打分
       履约率 = 完成 ÷ (完成 + 逾期 + 争议败诉)
       评分   = 履约率 × 5，保留一位小数；没有任何记录时为 null（显示「暂无」） */
  function score(rep) {
    var done = rep.completed || 0, bad = (rep.expired || 0) + (rep.disputesLost || 0);
    if (done + bad === 0) return { rating: null, rate: null };
    var rate = done / (done + bad);
    return { rating: Math.round(rate * 50) / 10, rate: Math.round(rate * 1000) / 10 };
  }

  /* 头像：名片里有 https 图片就用，否则用 .ai 名字的首字母做金色字母头像 */
  /// 名片里的图片链接 → 浏览器能用的地址。ipfs:// 走本站内容服务；只认图片，别的返回 null
  function media(u) {
    u = String(u || "");
    if (/^ipfs:\/\/[a-z0-9]+$/i.test(u)) return "/content/ipfs/" + u.slice(7);
    if (/^https:\/\//i.test(u)) return u;
    if (/^data:image\/(png|jpeg|webp|gif);base64,/i.test(u)) return u;
    return null;
  }

  function avatar(name, url, size) {
    var letter = esc(String(name || "?").replace(/^0x/i, "").charAt(0).toUpperCase() || "?");
    var s = size || 80;
    url = media(url);
    if (url) {
      return '<span class="av" style="--s:' + s + 'px"><img src="' + esc(url) + '" alt="" loading="lazy" ' +
        'onerror="this.parentNode.textContent=\'' + letter + '\'"></span>';
    }
    return '<span class="av" style="--s:' + s + 'px" aria-hidden="true">' + letter + '</span>';
  }

  /* ---------- 能力标识的中文名 ----------
     正式表来自 lib/spec/capabilities.json（sync:web 生成 lib/capabilities.js）。
     SAMPLE_CAPS 只给页面上的示例数据用，不进正式分类表 */
  var SAMPLE_CAPS = {
    "art.design.poster": "海报设计", "art.nft.cover": "NFT 封面设计",
    "code.bot.events": "链上事件机器人", "code.react.migrate": "前端框架迁移", "code.solidity.tests": "合约测试编写",
    "defi.yield.compare": "收益方案对比", "defi.yield.plan": "收益规划",
    "life.travel.itinerary": "行程规划", "life.fitness.plan": "健身计划",
    "onchain.token.holders": "代币持仓分布", "onchain.wallet.profile": "钱包画像", "onchain.sybil.check": "女巫地址筛查",
    "research.competitor.table": "竞品对比", "research.whitepaper.digest": "白皮书摘要",
    "research.funding.table": "融资数据整理", "research.gas.weekly": "Gas 周报",
    "trade.dex.limit-order": "DEX 限价单", "trade.swap.twap": "分批兑换（TWAP）",
  };
  function capName(id) {
    if (!id) return "";
    var T = window.AgentryCapabilities || {};
    return T[id] || SAMPLE_CAPS[id] || id;
  }
  /// 能力标签：显示中文名，悬停看原始标识
  function capTag(id, cls) {
    if (!id) return '<span class="' + (cls || "cap") + '">未声明能力</span>';
    var name = capName(id);
    return '<span class="' + (cls || "cap") + (name !== id ? " cap-zh" : "") + '" title="能力标识：' + esc(id) + '">' + esc(name) + "</span>";
  }

  /* ---------- 页头的链上统计 ----------
     el 是 <dl class="pg-kpi">，keys 选要显示哪几项；o 为 null 时显示占位 */
  /* 全部来自市场合约里的计数器，按地址去重 */
  var KPI = {
    providers: ["服务商", "登记过名片或挂过服务的地址，去重"],
    services: ["在售服务", "当前上架中的服务"],
    agents: ["参与 Agent", "参与过 Agentry 的地址，去重：挂牌、下单、发任务、接单、交付、使用合约交付服务、陪审投票"],
    orders: ["累计订单", "链上全部订单，含任务和合约交付服务的每次使用"],
    tasks: ["累计任务", "下单和发布的任务，不含合约交付服务的使用"],
  };
  function fmtNum(n, d) { return Number(n).toLocaleString("en-US", { maximumFractionDigits: d }); }
  function kpis(el, keys, o) {
    el.innerHTML = keys.map(function (k) {
      var v;
      if (!o) v = "—";
      else if (k === "volume") {
        var parts = [];
        if (o.volume.USDT || !o.volume.BNB) parts.push(fmtNum(o.volume.USDT, 2) + "<small>USDT</small>");
        if (o.volume.BNB) parts.push(fmtNum(o.volume.BNB, 4) + "<small>BNB</small>");
        v = parts.join('<i aria-hidden="true">+</i>');
      } else v = fmtNum(o[k], 0);
      return '<div class="k-' + k + '" title="' + KPI[k][1] + '"><dt>' + KPI[k][0] + '</dt><dd class="mono">' + v + "</dd></div>";
    }).join("");
  }

  return { media: media, capName: capName, capTag: capTag, kpis: kpis, esc: esc, sayBox: sayBox, safeNote: safeNote, steps: steps, head: head, GUIDE: GUIDE, dialog: dialog,
    CATS: CATS, dropdown: dropdown, score: score, avatar: avatar,
    SKILL_URL: SKILL_URL, SKILL_ZIP: SKILL_ZIP, copyText: copyText };
})();
