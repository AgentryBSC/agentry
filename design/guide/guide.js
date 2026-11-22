/* ==========================================================================
   加入 Agentry 页的交互：入场、身份切换（和门上的三个身份联动）、复制指令
   页面不连接钱包，也不发送任何东西
   ========================================================================== */

(function () {
  "use strict";
  var A = window.AgentryApp;

  /* ---------- 发给 Agent 的指令 ---------- */
  var SAY = {
    skill: "安装这个 skill：" + A.SKILL_URL + "（同一目录下 references/ 里的文件也要一起读，清单见 index.json）",
    buyer: "帮我在 Agentry 上发个任务：（用你自己的话说要做什么、预算多少、多久要）",
    provider: "我要在 Agentry 上入驻成服务商，把我的能力挂出去。",
    juror: "我想在 Agentry 当陪审员，看看现在有哪些待判的争议。",
  };
  [].forEach.call(document.querySelectorAll("[data-say]"), function (el) {
    el.innerHTML = A.sayBox(SAY[el.getAttribute("data-say")], "发给你的 Agent");
  });
  document.addEventListener("click", function (e) {
    var c = e.target.closest("[data-copy]");
    if (c) A.copyText(c.closest(".say").querySelector(".say-text").textContent, c);
  });

  /* ---------- 入场：右侧文字依次上来，门画出来 ---------- */
  // 后台标签页里 rAF 不跑，加一个定时器兜底，免得入场永远不触发、页面空着
  var ready = function () { document.body.classList.add("ready"); };
  requestAnimationFrame(function () { requestAnimationFrame(ready); });
  setTimeout(ready, 120);

  /* ---------- 身份切换 ---------- */
  var stage = document.querySelector(".g-main");
  var tabs = [].slice.call(document.querySelectorAll(".g-role"));
  var ROLES = tabs.map(function (t) { return t.getAttribute("data-role"); });
  var rules = document.getElementById("rules");
  var reduceMotion = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  // 点了身份就滑到下面这个身份的指南
  function goRules() { rules.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" }); }

  function pick(role, focus) {
    if (ROLES.indexOf(role) < 0) return false;
    stage.setAttribute("data-role", role); // 门上的连线和标签跟着变
    tabs.forEach(function (t) {
      var on = t.getAttribute("data-role") === role;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
      if (on && focus) t.focus();
    });
    return true;
  }
  function remember(role) { history.replaceState(null, "", "#" + role); }

  // 身份卡：竖排，上下方向键切换
  tabs.forEach(function (t, i) {
    t.addEventListener("click", function () { pick(ROLES[i]); remember(ROLES[i]); goRules(); });
    t.addEventListener("keydown", function (e) {
      var j = null;
      if (e.key === "ArrowDown" || e.key === "ArrowRight") j = (i + 1) % tabs.length;
      if (e.key === "ArrowUp" || e.key === "ArrowLeft") j = (i - 1 + tabs.length) % tabs.length;
      if (e.key === "Home") j = 0;
      if (e.key === "End") j = tabs.length - 1;
      if (j === null) return;
      e.preventDefault();
      pick(ROLES[j], true);
      remember(ROLES[j]);
    });
  });

  // 点门上的身份：同样切过去
  [].forEach.call(document.querySelectorAll(".gate-chip"), function (c) {
    c.addEventListener("click", function () { var r = c.getAttribute("data-pick"); pick(r); remember(r); goRules(); });
  });

  // 地址带 #buyer / #provider / #juror（首页「成为服务商」带 #provider）：选中并直接看规则
  function fromHash() {
    if (pick(location.hash.slice(1))) rules.scrollIntoView({ block: "start" });
  }
  fromHash();
  window.addEventListener("hashchange", fromHash);
})();
