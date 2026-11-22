/* ==========================================================================
   Agentry 舞台滚动 —— 照 niuzi.icu 的那套做法

   一、滚动不劫持。浏览器原生滚动，外层 .story 只负责撑出滚动长度。
   二、滚动距离换算成一条"时间轴" τ：一屏滚动 = 100 × 1.4 个单位。
       时间轴按章节切成两种段，交替排列：
         停顿段 dwell   章节停在台上，给人读的时间
         过渡段 travel  上一章离场、下一章进场，卡片和粒子在这一段变形
   三、顺滑感的来源：画面不直接读滚动位置，而是让 τ 以阻尼 9 去追它
         τ += (目标 - τ) × (1 - e^(-9·dt))
       滚轮一格一格的跳变，被抹成一条连续的曲线；停手之后还会滑一小段才停稳。
   四、每一章有自己的时间窗口：
         进场 = 上一段过渡走到 55%，离场 = 下一段过渡走到 35%
       窗口两端各有 16 个单位的淡入淡出；进场时从下方 46px 浮上来，
       在台上再慢慢上漂最多 28px，离场时继续往上走 46px。
   五、卡片和粒子的姿态按"章节坐标" c 插值：停在第 k 章时 c = k，
       过渡段里 c 从 k 走到 k+1。

   窄屏、矮屏、要求少动时不开舞台，退回普通长页面，c 改由各章在视口里的位置算出。
   对外：AgentryStory.init({ onFrame }) / goTo(k) / chapters
   ========================================================================== */

window.AgentryStory = (function () {
  "use strict";

  var O = 1.4;            // 一屏滚动折合多少个 100 单位
  var DAMP = 9;           // 阻尼系数，参考站同值
  var FADE = 16;          // 章节淡入淡出的长度
  var RISE = 46;          // 进场、离场的位移
  var DRIFT_K = 0.45, DRIFT_MAX = 28;   // 台上慢漂
  var IN_AT = 0.55, OUT_AT = 0.35;

  var story, stage, chapters = [], segs = [], total = 0;
  var on = false, tau = 0, tauS = 0, last = 0, raf = 0;
  var opts = {};
  var rail, railBtns = [], skip, cue;

  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var wideQ = window.matchMedia("(min-width: 1024px) and (min-height: 640px)");

  var cl01 = function (v) { return v < 0 ? 0 : v > 1 ? 1 : v; };
  var smooth = function (t) { t = cl01(t); return t * t * (3 - 2 * t); };

  /* ---------- 时间轴 ---------- */
  function buildTimeline() {
    segs = []; var t = 0;
    chapters.forEach(function (ch, k) {
      var d = +ch.el.dataset.dwell || 40;
      segs.push({ type: "dwell", k: k, start: t, end: t + d }); t += d;
      if (k < chapters.length - 1) {
        var v = +ch.el.dataset.travel || 80;
        segs.push({ type: "travel", k: k, start: t, end: t + v }); t += v;
      }
    });
    total = t;
    chapters.forEach(function (ch, k) {
      var prev = k > 0 ? travelOf(k - 1) : null, next = travelOf(k);
      ch.win = {
        start: prev ? prev.start + (prev.end - prev.start) * IN_AT : -Infinity,
        end: next ? next.start + (next.end - next.start) * OUT_AT : Infinity,
      };
      ch.dwell = dwellOf(k);
    });
  }
  function dwellOf(k) { for (var i = 0; i < segs.length; i++) if (segs[i].type === "dwell" && segs[i].k === k) return segs[i]; }
  function travelOf(k) { for (var i = 0; i < segs.length; i++) if (segs[i].type === "travel" && segs[i].k === k) return segs[i]; return null; }

  /* τ 落在哪一段 → 章节坐标 */
  function coord(t) {
    t = Math.min(Math.max(t, 0), total);
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (t <= s.end) {
        var u = s.end > s.start ? (t - s.start) / (s.end - s.start) : 1;
        return s.type === "dwell" ? s.k : s.k + u;
      }
    }
    return chapters.length - 1;
  }
  /* 跳到某一章：停顿段的正中；首章就是 0 */
  function anchor(k, sub) {
    var d = chapters[k].dwell;
    if (k === 0) return 0;
    return d.start + (d.end - d.start) * (sub == null ? 0.5 : sub);
  }

  /* ---------- 尺寸 ---------- */
  function vh() { return window.innerHeight || 1; }
  function px(t) { return t / 100 / O * vh(); }
  function storyTop() { return story.getBoundingClientRect().top + window.scrollY; }
  function layout() {
    if (!on) return;
    story.style.height = (px(total) + vh()) + "px";
    fit();
  }
  /* 一章必须一屏放下。放不下的，整块按比例缩小（最多缩到 .78），
     笔记本那种 768 高的屏幕上靠它兜底 */
  function fit() {
    chapters.forEach(function (ch) {
      var w = ch.el.querySelector(".wrap");
      if (!w) return;
      w.style.transform = "";
      var cs = getComputedStyle(ch.el);
      var avail = ch.el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      var s = Math.max(0.78, Math.min(1, avail / Math.max(1, w.offsetHeight)));
      if (s < 0.999) {
        w.style.transformOrigin = "left center";
        w.style.transform = "scale(" + s.toFixed(3) + ")";
      }
    });
  }
  function unfit() {
    chapters.forEach(function (ch) {
      var w = ch.el.querySelector(".wrap");
      if (w) w.style.transform = "";
    });
  }
  function target() { return cl01((window.scrollY - storyTop()) / Math.max(1, px(total))) * total; }

  /* ---------- 每帧 ---------- */
  function frame(now) {
    var dt = Math.min(Math.max((now - last) / 1000, 0), 0.05) || 0.016;
    last = now;
    tau = target();
    tauS += (tau - tauS) * (1 - Math.exp(-dt * DAMP));
    if (!isFinite(tauS) || Math.abs(tau - tauS) < 0.01) tauS = tau;
    paint(tauS);
  }
  function paint(t) {
    var best = 0, bestO = -1;
    chapters.forEach(function (ch, k) {
      var s = ch.win.start, e = ch.win.end;
      var a = isFinite(s) ? smooth((t - s) / FADE) : 1;
      var b = isFinite(e) ? smooth((t - (e - FADE)) / FADE) : 0;
      var o = a * (1 - b);
      var drift = Math.min(Math.max(t - (isFinite(s) ? s : 0), 0) * DRIFT_K, DRIFT_MAX);
      var y = (1 - a) * RISE - b * RISE - drift;
      if (Math.abs(o - ch.o) > 0.002 || Math.abs(y - ch.y) > 0.2) {
        ch.o = o; ch.y = y;
        ch.el.style.opacity = o.toFixed(3);
        ch.el.style.transform = "translate3d(0," + y.toFixed(1) + "px,0)";
        ch.el.style.visibility = o < 0.004 ? "hidden" : "visible";
      }
      ch.el.classList.toggle("is-live", o > 0.5);
      // 章内进度：0 = 刚进场，1 = 停顿段走完
      ch.p = cl01((t - (isFinite(s) ? s : 0)) / Math.max(1, ch.dwell.end - (isFinite(s) ? s : 0)));
      ch.inP = a;
      // 停顿段自己的进度，流程那一章靠它决定翻到第几步
      ch.dp = cl01((t - ch.dwell.start) / Math.max(1, ch.dwell.end - ch.dwell.start));
      if (o > bestO) { bestO = o; best = k; }
    });
    setCurrent(best);
    if (skip) skip.hidden = t > total - 60;
    if (cue) cue.style.opacity = t < 12 ? "1" : "0";
    emit(coord(t), t / total);
  }

  /* 普通长页面：哪一章在视口中线上，就是第几章；章内的位置给出小数部分 */
  function paintFlat() {
    var mid = vh() * 0.5, c = 0;
    chapters.forEach(function (ch, k) {
      var r = ch.el.getBoundingClientRect();
      var f = cl01((mid - r.top) / Math.max(1, r.height));
      if (r.top <= mid) c = k + (k < chapters.length - 1 ? smooth(cl01((f - 0.5) * 2)) : 0);
      ch.p = f; ch.inP = cl01((vh() - r.top) / (vh() * 0.6)); ch.o = 1;
    });
    var max = document.documentElement.scrollHeight - vh();
    setCurrent(Math.round(c));
    emit(c, max > 0 ? window.scrollY / max : 0);
  }

  var cur = -1;
  function setCurrent(k) {
    if (k === cur) return;
    cur = k;
    railBtns.forEach(function (b, i) { b.setAttribute("aria-current", String(i === k)); });
    if (opts.onChapter) opts.onChapter(k, chapters[k]);
  }
  function emit(c, prog) {
    if (opts.onFrame) opts.onFrame({ c: c, n: chapters.length, progress: prog, chapters: chapters, on: on });
  }

  /* ---------- 跳转 ---------- */
  function goTo(k, sub) {
    if (!on) {
      var el = chapters[k] && chapters[k].el;
      if (el) el.scrollIntoView({ behavior: reduced ? "auto" : "smooth" });
      return;
    }
    // 瞬间跳过去，画面靠阻尼追上 —— 参考站同样的手法，所以点导航也是一段顺滑的过场
    window.scrollTo({ top: storyTop() + px(anchor(k, sub)), behavior: "instant" });
  }
  function goToEnd() {
    window.scrollTo({ top: storyTop() + px(total) + vh() * 0.02, behavior: "instant" });
  }

  function buildRail() {
    rail = document.getElementById("rail");
    if (!rail) return;
    rail.innerHTML = "";
    railBtns = chapters.map(function (ch, k) {
      var b = document.createElement("button");
      b.type = "button";
      b.setAttribute("aria-label", "跳到" + ch.label);
      b.innerHTML = "<span>" + ch.label + "</span><i></i>";
      b.addEventListener("click", function () { goTo(k); });
      rail.appendChild(b);
      return b;
    });
  }

  /* 页内锚点：指向某一章（或章里的东西）就换成 goTo */
  function hookLinks() {
    document.addEventListener("click", function (e) {
      var a = e.target.closest && e.target.closest('a[href^="#"]');
      if (!a) return;
      var id = a.getAttribute("href").slice(1);
      if (id === "top" || id === "main") { if (on) { e.preventDefault(); goTo(0); } return; }
      var el = id && document.getElementById(id);
      if (!el) return;
      for (var k = 0; k < chapters.length; k++) {
        if (chapters[k].el === el || chapters[k].el.contains(el)) {
          e.preventDefault(); goTo(k); return;
        }
      }
    });
    // 键盘用户 Tab 进了一章还没到台上的内容，就把那一章请上台
    document.addEventListener("focusin", function (e) {
      if (!on) return;
      for (var k = 0; k < chapters.length; k++) {
        if (chapters[k].el.contains(e.target) && !chapters[k].el.classList.contains("is-live")) {
          goTo(k); tauS = target(); paint(tauS); return;
        }
      }
    });
  }

  function enable(want) {
    on = want;
    document.documentElement.classList.toggle("story-on", on);
    if (rail) rail.hidden = !on;
    if (skip) skip.hidden = !on;
    if (cue) cue.hidden = !on;
    if (on) {
      layout();
      tauS = tau = target();
      chapters.forEach(function (ch) { ch.o = -1; ch.y = 0; });
      paint(tauS);
    } else {
      story.style.height = "";
      unfit();
      chapters.forEach(function (ch) {
        ch.el.style.opacity = ""; ch.el.style.transform = ""; ch.el.style.visibility = "";
        ch.el.classList.remove("is-live");
        // 章内逐条浮起留下的样式也清掉，普通长页面里内容原样显示
        [].forEach.call(ch.el.querySelectorAll(".r"), function (el) {
          el.style.opacity = ""; el.style.translate = ""; el._e = null;
        });
      });
      paintFlat();
    }
  }

  function init(o) {
    opts = o || {};
    story = document.getElementById("story");
    if (!story) return false;
    stage = story.querySelector(".story-stage");
    chapters = [].slice.call(story.querySelectorAll("[data-chapter]")).map(function (el) {
      return { el: el, id: el.id, label: el.dataset.label || el.id, o: -1, y: 0, p: 0, inP: 0 };
    });
    if (!chapters.length) return false;
    buildTimeline();
    buildRail();
    skip = document.getElementById("storySkip");
    cue = document.getElementById("storyCue");
    if (skip) skip.addEventListener("click", goToEnd);
    hookLinks();

    enable(!reduced && wideQ.matches);
    var onQ = function () { enable(!reduced && wideQ.matches); };
    if (wideQ.addEventListener) wideQ.addEventListener("change", onQ); else wideQ.addListener(onQ);
    // 有的环境改窗口大小不触发 matchMedia 的 change，resize 里再核一次
    window.addEventListener("resize", function () {
      var want = !reduced && wideQ.matches;
      if (want !== on) enable(want); else { layout(); if (!on) paintFlat(); }
    });
    // 字体落位后各章高度会变，重新量一次
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(layout);
    window.addEventListener("scroll", function () { if (!on) paintFlat(); }, { passive: true });

    last = performance.now();
    raf = requestAnimationFrame(function tick(now) {
      if (on) frame(now);
      raf = requestAnimationFrame(tick);
    });
    return true;
  }

  return {
    init: init,
    goTo: goTo,
    get chapters() { return chapters; },
    get on() { return on; },
    // rAF 被节流时手动推一帧（调试用）
    tick: function (now) { if (on) frame(now || performance.now()); else paintFlat(); },
    anchor: function (k, sub) { return storyTop() + px(anchor(k, sub)); },
  };
})();
