/* ==========================================================================
   Agentry 交互与动效

   滚动这条线全部交给 story.js：它把滚动换算成时间轴、做阻尼、排章节。
   这里做四件事：
     1. 不依赖滚动的交互：菜单、导航压暗
     2. 每章换一个粒子造型：卡 → 指纹 → 三人星座 → 锁 → 星球 → AGENTRY
     3. 章内的小动画全挂在滚动上：内容逐条浮起、数字累积、
        角色逐个点亮、流程翻步、到账那一步锁扣弹开
     4. 首屏的那一次载入入场（GSAP + SplitText，没加载就跳过）
   ========================================================================== */

(function () {
  "use strict";

  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var cl01 = function (v) { return v < 0 ? 0 : v > 1 ? 1 : v; };
  var smooth = function (t) { t = cl01(t); return t * t * (3 - 2 * t); };

  /* ===================================================================
     一、交互
     =================================================================== */

  (function menu() {
    var burger = document.getElementById("burger");
    var sheet = document.getElementById("sheet");
    if (!burger || !sheet) return;
    var links = [].slice.call(sheet.querySelectorAll("a"));
    function setOpen(open) {
      burger.setAttribute("aria-expanded", String(open));
      burger.setAttribute("aria-label", open ? "关闭菜单" : "打开菜单");
      sheet.classList.toggle("open", open);
      document.body.style.overflow = open ? "hidden" : "";
      links.forEach(function (a, i) {
        a.style.transitionDelay = open ? Math.min(i * 60, 400) + "ms" : "0ms";
      });
    }
    burger.addEventListener("click", function () {
      setOpen(burger.getAttribute("aria-expanded") !== "true");
    });
    links.forEach(function (a) { a.addEventListener("click", function () { setOpen(false); }); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") setOpen(false); });
  })();

  (function navSolid() {
    var nav = document.getElementById("nav");
    if (!nav) return;
    var queued = false;
    function tick() { queued = false; nav.classList.toggle("solid", window.scrollY > 24); }
    window.addEventListener("scroll", function () {
      if (queued) return;
      queued = true;
      requestAnimationFrame(tick);
    }, { passive: true });
    tick();
  })();

  var S = window.AgentryStory;
  var FX = window.AgentryField;
  var field = FX && FX.init(document.getElementById("cv"));

  /* 流程五步：舞台模式下"第几步"由滚动决定，点一下就滚到那一步 */
  var flow = (function () {
    var btns = [].slice.call(document.querySelectorAll(".fl-b"));
    var panes = [].slice.call(document.querySelectorAll(".fl-p"));
    var bar = document.querySelector(".fl-bar");
    var cur = -1;
    function show(i) {
      if (i === cur || !btns[i]) return;
      cur = i;
      btns.forEach(function (b, j) {
        b.setAttribute("aria-selected", String(j === i));
        b.tabIndex = j === i ? 0 : -1;
      });
      panes.forEach(function (p, j) { p.classList.toggle("on", j === i); });
      if (bar) bar.style.transform = "scaleX(" + ((i + 1) / btns.length).toFixed(3) + ")";
    }
    btns.forEach(function (b, i) {
      b.addEventListener("click", function () {
        if (S && S.on) {
          var k = S.chapters.findIndex(function (c) { return c.id === "how"; });
          S.goTo(k, (i + 0.5) / btns.length);
        }
        show(i);
      });
      b.addEventListener("keydown", function (e) {
        var d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        var n = (i + d + btns.length) % btns.length;
        btns[n].focus(); btns[n].click();
      });
    });
    show(0);
    return { show: show, n: btns.length };
  })();

  /* 角色：悬停哪一行，星座里哪个节点亮；没人悬停时跟着滚动一个个点 */
  var roles = (function () {
    var rows = [].slice.call(document.querySelectorAll(".role2"));
    var hover = -1, auto = -1;
    function apply() {
      var i = hover >= 0 ? hover : auto;
      rows.forEach(function (r, j) { r.classList.toggle("is-on", j === i); });
      if (field) FX.setFocus(i);
    }
    rows.forEach(function (r, j) {
      r.addEventListener("pointerenter", function () { hover = j; apply(); });
      r.addEventListener("pointerleave", function () { hover = -1; apply(); });
      r.addEventListener("focusin", function () { hover = j; apply(); });
      r.addEventListener("focusout", function () { hover = -1; apply(); });
    });
    return {
      setAuto: function (i) { if (i !== auto) { auto = i; apply(); } },
      n: rows.length,
    };
  })();

  /* 粒子上浮出 .ai 时，左键点一下去 Agent ID 页面。
     点在按钮或链接上时照常走它们自己的，不抢 */
  var AI_URL = "https://web3.binance.com/en/agent-id/agentry?ref=Z6EX4VQ2";
  if (field) {
    document.addEventListener("click", function (e) {
      if (e.button !== 0 || !FX.aiShown()) return;
      if (e.target.closest && e.target.closest("a, button, input, textarea, select, summary, label")) return;
      e.preventDefault();
      // 不能传 "noopener"：带上它 window.open 永远返回 null，就分不清是不是被拦了
      var w = window.open(AI_URL, "_blank");
      if (w) w.opener = null;
      else window.location.href = AI_URL;      // 新标签被拦就在当前页打开
    });
    // .ai 出现时光标变成手形，提示这里能点
    var cursorOn = false;
    (function watchCursor() {
      var on = FX.aiShown();
      if (on !== cursorOn) { cursorOn = on; document.documentElement.style.cursor = on ? "pointer" : ""; }
      requestAnimationFrame(watchCursor);
    })();
  }

  /* ===================================================================
     二、粒子造型，和章内的滚动动画
     =================================================================== */

  var SHAPE = { hero: "card", id: "print", who: "trio", how: "lock", market: "globe", end: "word" };
  var nums = [].slice.call(document.querySelectorAll(".num"));
  var bar = document.querySelector("#frame b");
  var navLinks = {};
  // 只有指向本页章节的链接（#id）才跟着滚动高亮；Agent 市场、任务大厅是别的页面
  document.querySelectorAll('.nav-links a[href^="#"]').forEach(function (a) {
    navLinks[a.getAttribute("href").slice(1)] = a;
  });

  if (S && S.init({ onFrame: onFrame, onChapter: onChapter })) {
    var ids = S.chapters.map(function (c) { return c.id; });
    if (field) {
      FX.setShapes(ids.map(function (id) { return SHAPE[id] || "globe"; }));
      // 背景那层星点：首页绕成轨道，后面都是慢慢流动的星海
      FX.setPlan(ids.map(function (id) { return id === "hero" ? "orbit" : "sea"; }));
    }
    // 每章里要逐条浮起的内容
    S.chapters.forEach(function (ch) { ch.items = [].slice.call(ch.el.querySelectorAll(".r")); });
  }

  function byId(st, id) {
    for (var i = 0; i < st.chapters.length; i++) if (st.chapters[i].id === id) return st.chapters[i];
  }

  function onFrame(st) {
    if (field) {
      FX.setChapter(st.c);
      FX.setProgress(st.n > 1 ? st.c / (st.n - 1) : 0);
    }
    if (bar) bar.style.transform = "scaleX(" + st.progress.toFixed(4) + ")";

    // 章内容逐条浮起：跟着这一章的进场进度走，后一条比前一条晚一点
    if (st.on && !reduced) {
      st.chapters.forEach(function (ch) {
        if (!ch.items || !ch.items.length) return;
        var p = ch.inP || 0;
        ch.items.forEach(function (el, i) {
          var e = smooth(p * 1.5 - i * 0.1);
          var key = e.toFixed(3);
          if (el._e === key) return;
          el._e = key;
          el.style.opacity = key;
          el.style.translate = "0 " + ((1 - e) * 32).toFixed(1) + "px";
        });
      });
    }

    // 31 和 0：跟着 Agent ID 这一章的进场一起累积
    var idc = byId(st, "id");
    if (idc && nums.length) {
      var k = reduced ? 1 : smooth(idc.inP * 1.3 - .3);
      nums.forEach(function (el) {
        var v = String(Math.round(+el.dataset.to * k));
        if (el.textContent !== v) el.textContent = v;
      });
    }

    // 角色：停顿段切三份，滚到哪份点亮哪个
    var who = byId(st, "who");
    if (st.on && who && who.o > 0.3) roles.setAuto(Math.min(roles.n - 1, Math.floor((who.dp || 0) * roles.n)));
    else if (st.on) roles.setAuto(-1);

    // 流程：停顿段切五份，滚到哪份翻到哪步
    var how = byId(st, "how");
    if (st.on && how && how.dp != null && how.o > 0.3) {
      flow.show(Math.min(flow.n - 1, Math.floor(how.dp * flow.n)));
    }
  }

  function onChapter(k) {
    var id = S.chapters[k] && S.chapters[k].id;
    Object.keys(navLinks).forEach(function (key) {
      if (key === id) navLinks[key].setAttribute("aria-current", "page");
      else navLinks[key].removeAttribute("aria-current");
    });
  }

  /* ===================================================================
     三、首屏的那一次载入入场
     =================================================================== */

  if (reduced || typeof window.gsap === "undefined") return;
  var hasSplit = typeof window.SplitText !== "undefined";
  if (hasSplit) gsap.registerPlugin(SplitText);
  gsap.defaults({ ease: "power3.out", duration: 0.7 });

  var h1 = document.querySelector(".hero h1");
  if (hasSplit && h1) {
    SplitText.create(h1, {
      type: "lines", mask: "lines", autoSplit: true, linesClass: "hline",
      onSplit: function (self) {
        return gsap.from(self.lines, { yPercent: 115, duration: 1, stagger: 0.1, ease: "expo.out", delay: 0.1 });
      },
    });
  } else if (h1) {
    gsap.from(h1, { autoAlpha: 0, y: 24, delay: 0.1 });
  }

  gsap.timeline({ delay: 0.12 })
    .from(".hero .eyebrow", { autoAlpha: 0, x: -12, duration: 0.5 }, 0)
    .from(".hero .sub", { autoAlpha: 0, y: 16 }, 0.34)
    .from(".hero .cta .btn", { autoAlpha: 0, y: 12, stagger: 0.07, duration: 0.5 }, 0.48)
    .from(".hero .proof span", { autoAlpha: 0, y: 10, stagger: 0.06, duration: 0.45 }, 0.62)
    .from(".cue", { autoAlpha: 0, duration: 0.6 }, 0.84);
})();
