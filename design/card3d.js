/* ==========================================================================
   Agent ID 卡 —— 随滚动变形

   这张卡不是视频，也不是图片序列，是一个真实的 DOM 元素，
   用 CSS 3D 变换驱动。理由就是你说的那句：卡是每个 Agent 的标志。
   标志上的名字每个 Agent 都不一样，视频里的名字是死的，换一个 Agent
   就得重新渲染一遍。做成 DOM，名字只是一行文本。

   顺带的好处：任何分辨率都清晰，改一个数就能调，整份素材只有一张 PNG。

   滚动的五个落点（整页进度 0..1）：
     0.00  正面，大，偏右。页面一打开就是它
     0.14  缩小右移，微微侧过去，左边的文案进场
     0.34  转过去再转回来。两面一样，所以这是一次纯粹的翻身
     0.60  继续缩小，收到右上角，正文接管
     0.86  淡出，交给粒子

   对外：init() / setProgress(0..1) / render(now)
   ========================================================================== */

window.AgentryCard = (function () {
  "use strict";

  var el, inner, raf = null;
  var progress = 0;
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var pointer = { x: 0, y: 0, on: false };
  var tiltX = 0, tiltY = 0;
  var fade = 1;   // 外部给的整体淡出系数，页脚进场时用

  /* x / y 是视口比例，s 缩放，ry/rx 旋转角，o 不透明度 */
  var KEY = [
    { at: 0.00, x:  0.17, y:  0.00, s: 1.00, ry:  -8, rx:  2, o: 1 },
    { at: 0.14, x:  0.27, y: -0.02, s: 0.78, ry: -22, rx:  5, o: 1 },
    { at: 0.34, x:  0.29, y:  0.00, s: 0.66, ry: -180, rx: 4, o: 1 },
    { at: 0.60, x:  0.36, y: -0.26, s: 0.40, ry: -196, rx: 0, o: 1 },
    { at: 0.86, x:  0.38, y: -0.34, s: 0.32, ry: -208, rx: 0, o: 0 },
  ];

  var cl01 = function (v) { return v < 0 ? 0 : v > 1 ? 1 : v; };
  var smooth = function (t) { return t * t * (3 - 2 * t); };
  var lerp = function (a, b, t) { return a + (b - a) * t; };

  function frame(p) {
    if (p <= KEY[0].at) return KEY[0];
    if (p >= KEY[KEY.length - 1].at) return KEY[KEY.length - 1];
    var i = 0;
    while (i < KEY.length - 2 && p > KEY[i + 1].at) i++;
    var a = KEY[i], b = KEY[i + 1];
    var t = smooth(cl01((p - a.at) / (b.at - a.at)));
    return {
      x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), s: lerp(a.s, b.s, t),
      ry: lerp(a.ry, b.ry, t), rx: lerp(a.rx, b.rx, t), o: lerp(a.o, b.o, t),
    };
  }

  function render(now) {
    if (!el) return;
    var f = frame(progress);
    var W = window.innerWidth || 1, H = window.innerHeight || 1;

    // 浮动用官方那组参数：周期 5s，幅度 12px
    var bob = reduced ? 0 : Math.sin(now * (2 * Math.PI / 5000)) * 12;
    var sway = reduced ? 0 : Math.sin(now * 0.00048) * 1.4;

    // 窄屏上卡退成背景水印：缩小、少偏移，免得压住标题
    var narrow = W < 860;
    // 卡是按两倍尺寸搭的，所以这里统一再乘 .5
    var sc = (narrow ? f.s * 0.66 : f.s) * 0.5;
    // 这里不能取整。浮动最快时每帧只移动 0.25px，取整之后就变成
    // 停三四帧再跳 1px，看起来就是一顿一顿的。
    // 清晰度靠的是卡按两倍尺寸栅格化，不靠整数位移。
    var tx = f.x * W * (narrow ? 0.5 : 1);
    var ty = f.y * H + bob;

    el.style.opacity = f.o.toFixed(3);
    el.style.visibility = f.o < 0.01 ? "hidden" : "visible";
    inner.style.transform =
      "translate3d(" + tx.toFixed(2) + "px," + ty.toFixed(2) + "px,0) " +
      "rotateX(" + (f.rx + tiltX + sway).toFixed(2) + "deg) " +
      "rotateY(" + (f.ry + tiltY).toFixed(2) + "deg) " +
      "scale(" + sc.toFixed(3) + ")";
  }

  /* 给粒子卡用：这一帧卡在屏幕上的中心、尺寸、角度和不透明度。
     和 render 用的是同一套算法，所以粒子卡和原来的 3D 卡走位完全一致 */
  function pose(now) {
    var f = frame(progress);
    var W = window.innerWidth || 1, H = window.innerHeight || 1;
    var bob = reduced ? 0 : Math.sin(now * (2 * Math.PI / 5000)) * 12;
    var sway = reduced ? 0 : Math.sin(now * 0.00048) * 1.4;
    var narrow = W < 860;
    // 文字随屏宽放大了，卡也跟着放：以 1440 宽为 1，最多放到 1.35
    var vwk = Math.min(1.35, Math.max(0.85, W / 1440));
    var sc = (narrow ? f.s * 0.66 : f.s * vwk) * 0.5;
    return {
      cx: W / 2 + f.x * W * (narrow ? 0.5 : 1),
      cy: H / 2 + f.y * H + bob,
      w: 560 * sc, h: 768 * sc,
      ry: f.ry + tiltY, rx: f.rx + tiltX + sway,
      o: f.o * (narrow ? 0.35 : 1) * fade,
    };
  }

  function loop(now) { render(now); raf = requestAnimationFrame(loop); }

  function init() {
    el = document.getElementById("cardstage");
    inner = document.getElementById("card3d");
    if (!el || !inner) return false;

    // 码出厚度。前后两面各在 ±7px，中间铺薄片，侧过来才看得见边
    var SLICES = 5, front = inner.firstElementChild;
    for (var i = 0; i < SLICES; i++) {
      var z = 14 - (i + 1) * (28 / (SLICES + 1));
      var sl = document.createElement("i");
      sl.className = "slice";
      // 越靠中间越暗，边就有了从亮到暗的过渡
      var k = 1 - Math.abs(z) / 14;
      sl.style.setProperty("--sl", "rgb(" + Math.round(150 - k * 72) + "," +
        Math.round(116 - k * 58) + "," + Math.round(10 - k * 6) + ")");
      sl.style.transform = "translateZ(" + z.toFixed(2) + "px)";
      inner.insertBefore(sl, front);
    }

    if (!reduced) {
      window.addEventListener("pointermove", function (e) {
        var W = window.innerWidth || 1, H = window.innerHeight || 1;
        // 指针只给很小的角度。给多了卡会像在甩，不像悬着
        var want = { y: ((e.clientX / W) - .5) * 9, x: -((e.clientY / H) - .5) * 6 };
        tiltY += (want.y - tiltY) * .08;
        tiltX += (want.x - tiltX) * .08;
        pointer.on = true;
      }, { passive: true });
    }

    render(performance.now());     // rAF 可能被节流，先同步摆一帧
    raf = requestAnimationFrame(loop);
    return true;
  }

  return {
    init: init,
    render: render,
    pose: pose,
    setFade: function (v) { fade = cl01(v); },
    setProgress: function (v) { progress = cl01(v); },
    // 舞台模式下按章节给姿态：keys 里每一项不带 at，按顺序均分到 0..1
    setKeys: function (keys) {
      var n = keys.length;
      KEY = keys.map(function (k, i) {
        return { at: n > 1 ? i / (n - 1) : 0, x: k.x, y: k.y, s: k.s, ry: k.ry, rx: k.rx, o: k.o };
      });
    },
    getProgress: function () { return progress; },
  };
})();
