/* ==========================================================================
   Agentry 粒子场

   01  轨道   粒子绕着一个中心转。一个 Agent 在接单。
   02  星海   视野拉远，每一颗是一个有 ID 的 Agent。
   03  字     粒子汇成 AGENTRY。

   形态由整页滚动进度驱动，粒子每帧往目标插值，不需要动画库。
   对外：init(canvas) / setProgress(0..1) / render(now)
   render 单独暴露，是为了 rAF 被节流时还能手动推帧。
   ========================================================================== */

window.AgentryField = (function () {
  "use strict";

  // 全站只有金这一个强调色，粒子也只用它和两级暖白
  var GOLD = [240, 185, 11], HI = [252, 213, 53], PALE = [237, 235, 228];

  var canvas, ctx, raf = null;
  var W = 0, H = 0, dpr = 1;
  var progress = 0;
  var pointer = { x: -9999, y: -9999, on: false };
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var TOTAL = 1560;
  var P = [], word = [];

  // 布在离开首屏时就该散掉，拖着不走会在正文上留一个拱形的影子
  var ANCHOR = [0, .46, .86, 1];

  var rand = function (a, b) { return a + Math.random() * (b - a); };
  var cl01 = function (v) { return v < 0 ? 0 : v > 1 ? 1 : v; };
  var clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };
  var smooth = function (t) { return t * t * (3 - 2 * t); };
  var lerp = function (a, b, t) { return a + (b - a) * t; };

  function hub() {
    return W > 1040 ? { x: W * .70, y: H * .5 } : { x: W * .5, y: H * .46 };
  }
  /* 中后段的颗粒收在右侧，别压住左边的正文 */
  function band() {
    return W > 1040 ? { x: W * .44, w: W * .60 } : { x: 0, w: W };
  }

  /* ===== AGENTRY 的采样点 ===== */
  function buildWord() {
    word = [];
    var size = Math.min(W * (W > 1040 ? .11 : .15), 132);
    // ow 必须取整：canvas.width 会取整，而下面的索引用的是同一个 ow
    var ow = Math.round(Math.min(W, 1600)), oh = Math.round(size * 1.7);
    if (ow < 8 || oh < 8) return;
    var off = document.createElement("canvas");
    off.width = ow; off.height = oh;
    var g = off.getContext("2d");
    g.fillStyle = "#fff";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = "600 " + size + 'px "Geist Mono", ui-monospace, monospace';
    g.fillText("AGENTRY", ow / 2, oh / 2);

    var d = g.getImageData(0, 0, ow, oh).data;
    for (var y = 0; y < oh; y += 3) {
      for (var x = 0; x < ow; x += 3) {
        if (d[(y * ow + x) * 4 + 3] > 130) word.push([x - ow / 2, y - oh / 2]);
      }
    }
    for (var i = word.length - 1; i > 0; i--) {
      var j = (Math.random() * (i + 1)) | 0, t = word[i]; word[i] = word[j]; word[j] = t;
    }
    if (word.length > TOTAL) word.length = TOTAL;
  }

  function build() {
    P = [];
    for (var i = 0; i < TOTAL; i++) {
      P.push({
        x: rand(0, W), y: rand(0, H),
        a: rand(0, 6.2832), ring: Math.random(), depth: rand(.25, 1),
        sx: Math.random(), sy: Math.random(), tw: rand(0, 6.2832),
        wi: i % Math.max(1, word.length),
        c: i % 9 === 0 ? PALE : (i % 4 === 0 ? HI : GOLD),
        rad: rand(.5, 1.7),
        ease: rand(.05, .1),
      });
    }
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    var rect = canvas.getBoundingClientRect();
    W = rect.width; H = rect.height;
    if (!W || !H) return;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    buildWord();
    build();
  }

  /* ===== 四个形态 ===== */
  function posOrbit(p, t, o) {
    var h = hub(), R = Math.min(W, H) * (.16 + p.ring * .46);
    var ang = p.a + t * (1.1 - p.ring * .7) * .00022;
    o.x = h.x + Math.cos(ang) * R;
    o.y = h.y + Math.sin(ang) * R * .58;
    o.r = p.rad * (.7 + p.depth * .7);
    o.a = .13 + p.depth * .27;
  }

  function posSea(p, t, o) {
    var bd = band(), dz = p.depth;
    o.x = bd.x + ((p.sx + t * .0000115 * (1 + dz)) % 1) * bd.w;
    o.y = ((p.sy + t * .000006) % 1) * (H * 1.08) - H * .04;
    o.r = p.rad * (.35 + dz * .85);
    o.a = (.1 + dz * .3) * (.72 + .28 * Math.sin(t * .0016 + p.tw));
  }

  function posWord(p, t, o) {
    if (!word.length) { posSea(p, t, o); return; }
    var w = word[p.wi];
    o.x = (W > 1040 ? W * .62 : W * .5) + w[0] + Math.sin(t * .0011 + p.tw) * 1.5;
    o.y = H * .46 + w[1] + Math.cos(t * .0013 + p.tw) * 1.5;
    o.r = p.rad * .92;
    o.a = .55 + .4 * p.depth;
  }

  var FORM = [posOrbit, posSea, posWord, posWord];

  /* ===== 粒子造型 =====
     一群粒子，每一章排成一个造型，造型都停在右侧同一个位置、同一个大小：
       card   Agent ID 卡（原图采样，文字清楚）
       print  指纹：一个 KYC 只对应一个人
       trio   三个节点连成的星座：服务商、买方、陪审员
       lock   锁：钱锁在合约里，到账那一步锁扣弹开
       globe  旋转的点阵星球：市场
       word   AGENTRY
     两章之间按滚动进度过渡：每颗粒子有自己的延迟，先向外散开再收进下一个造型。
     造型用不完的粒子不浪费，绕着造型转成一圈淡淡的尘环。 */
  var CW = 560, CH = 768;
  var REPEL_R = 48, REPEL_K = 1.5;
  var STEP_GOLD = 5, STEP_INK = 2.5, STEP_TEXT = 1.6;
  var DUST_N = 1600;              // 尘环用多少颗

  var SH = {};                    // 造型表
  var plan = ["card"];            // 每章一个造型名
  var chap = 0;                   // 章节坐标，story.js 给
  var focus = -1, focusS = 0;     // 角色那一章悬停哪个节点
  var lockOpen = 0, lockOpenS = 0;
  var fadeAll = 1;
  var NP = 0, morphReady = false;
  var PX, PY, PS, DL, N1, N2, KK, PH, HA, HR, HV;
  var TONES = [];                 // 颜色表，按下标分桶画
  var BK = [];

  /* 金色色阶：0 深墨，1..10 由暗到亮，11 高光，12 尘环，13 球背面 */
  (function palette() {
    TONES.push("#1E1502");
    for (var i = 0; i < 10; i++) {
      var t = i / 9;
      TONES.push("rgb(" + Math.round(lerp(120, 255, t)) + "," + Math.round(lerp(84, 222, t)) + "," + Math.round(lerp(4, 110, t * t)) + ")");
    }
    TONES.push("#FFF2C2");
    TONES.push("rgba(240,185,11,.30)");
    TONES.push("rgba(240,185,11,.38)");
  })();
  var T_INK = 0, T_HI = 11, T_DUST = 12, T_BACK = 13;
  function ramp(l) { return 1 + Math.max(0, Math.min(9, Math.round(l * 9))); }

  function shuffleIdx(n) {
    var a = new Uint32Array(n);
    for (var i = 0; i < n; i++) a[i] = i;
    for (i = n - 1; i > 0; i--) { var j = (Math.random() * (i + 1)) | 0, t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  /* 把点列表装成造型。pts: [{u,v,w?,tone,sz,grp?}]，坐标以造型框边长为 1 */
  function pack(pts, extra) {
    var n = pts.length, ord = shuffleIdx(n);
    var s = { n: n, u: new Float32Array(n), v: new Float32Array(n), w: new Float32Array(n),
              tone: new Uint16Array(n), sz: new Float32Array(n), grp: new Int8Array(n) };
    for (var i = 0; i < n; i++) {
      var p = pts[ord[i]];
      s.u[i] = p.u; s.v[i] = p.v; s.w[i] = p.w || 0;
      s.tone[i] = p.tone; s.sz[i] = p.sz; s.grp[i] = p.grp == null ? -1 : p.grp;
    }
    for (var k in extra) s[k] = extra[k];
    return s;
  }
  /* 在一张离屏画布上画白色图形，按网格把有颜色的像素取成点 */
  function sampleDraw(w, h, step, draw, toneOf, grpOf) {
    var c = document.createElement("canvas");
    c.width = w; c.height = h;
    var g = c.getContext("2d");
    g.fillStyle = g.strokeStyle = "#fff";
    draw(g, w, h);
    var d = g.getImageData(0, 0, w, h).data, out = [], norm = Math.max(w, h);
    for (var y = step / 2; y < h; y += step) for (var x = step / 2; x < w; x += step) {
      var a = d[((y | 0) * w + (x | 0)) * 4 + 3];
      if (a < 120) continue;
      out.push({ u: (x - w / 2) / norm, v: (y - h / 2) / norm,
                 tone: toneOf ? toneOf(x, y, w, h) : 7, sz: step / norm * .82,
                 grp: grpOf ? grpOf(x, y, w, h) : -1 });
    }
    return out;
  }

  /* ---------- 各个造型 ---------- */
  function buildPrint() {
    var pts = sampleDraw(600, 600, 3.2, function (g) {
      g.lineCap = "round"; g.lineWidth = 5.5;
      var cx = 300, cy = 318, seed = 7;
      var rnd = function () { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
      for (var r = 18; r < 262; r += 13) {
        // 每一圈是一个略扁的椭圆，带一点起伏，再随机断开一两处
        var gaps = 1 + (rnd() * 2 | 0), start = rnd() * 6.28;
        for (var k = 0; k < gaps; k++) {
          var a0 = start + k * 6.28 / gaps, a1 = a0 + 6.28 / gaps - (.18 + rnd() * .35), pen = false;
          g.beginPath();
          for (var a = a0; a <= a1; a += .03) {
            var wob = 1 + Math.sin(a * 3 + r * .05) * .025 + Math.sin(a * 5 + r * .11) * .015;
            var rx = r * .78 * wob, ry = r * wob * (Math.sin(a) < 0 ? .96 : 1.06);
            var x = cx + Math.cos(a) * rx, y = cy + Math.sin(a) * ry;
            if (y > 560 || x < 40 || x > 560) { pen = false; continue; }
            if (!pen) { g.moveTo(x, y); pen = true; } else g.lineTo(x, y);
          }
          g.stroke();
        }
      }
    }, function (x, y) {
      var dx = x - 300, dy = y - 318, r = Math.sqrt(dx * dx + dy * dy) / 262;
      return ramp(1 - r * .75 + (dy < 0 ? .08 : 0));
    });
    return pack(pts);
  }

  var TRIO_NODES = [[0, -.29], [-.31, .21], [.31, .21]];
  function buildTrio() {
    var labels = ["服务商", "买方", "陪审员"];
    var pts = sampleDraw(600, 600, 2.2, function (g) {
      var N = TRIO_NODES.map(function (p) { return [300 + p[0] * 600, 300 + p[1] * 600]; });
      g.lineWidth = 3.4;
      // 三条边和指向中心合约的三条线
      g.setLineDash([2, 7]);
      for (var i = 0; i < 3; i++) {
        var a = N[i], b = N[(i + 1) % 3];
        g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
      }
      g.setLineDash([]);
      g.lineWidth = 2.6;
      N.forEach(function (p) { g.beginPath(); g.moveTo(300, 300); g.lineTo(p[0], p[1]); g.stroke(); });
      // 中心：合约
      g.beginPath(); g.arc(300, 300, 16, 0, 6.29); g.fill();
      g.lineWidth = 3; g.beginPath(); g.arc(300, 300, 30, 0, 6.29); g.stroke();
      // 三个节点：外环 + 实心 + 外圈细环 + 名字
      N.forEach(function (p, i) {
        g.lineWidth = 7; g.beginPath(); g.arc(p[0], p[1], 58, 0, 6.29); g.stroke();
        g.beginPath(); g.arc(p[0], p[1], 30, 0, 6.29); g.fill();
        g.lineWidth = 2; g.beginPath(); g.arc(p[0], p[1], 78, 0, 6.29); g.stroke();
        g.font = '600 26px "Geist", "PingFang SC", "Microsoft YaHei", sans-serif';
        g.textAlign = "center"; g.textBaseline = "middle";
        g.fillText(labels[i], p[0], p[1] + (i === 0 ? -112 : 112));
      });
    }, function (x, y) {
      var dx = x - 300, dy = y - 300;
      return ramp(.45 + .5 * (1 - Math.min(1, Math.sqrt(dx * dx + dy * dy) / 300)));
    }, function (x, y) {
      var best = -1, bd = 1e9;
      TRIO_NODES.forEach(function (p, i) {
        var dx = x - (300 + p[0] * 600), dy = y - (300 + p[1] * 600), d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = i; }
      });
      return bd < 130 * 130 ? best : -1;
    });
    return pack(pts);
  }

  var LOCK_TOP = 300;   // 锁身上沿，往上的点是锁扣
  function buildLock() {
    var pts = sampleDraw(600, 600, 3.2, function (g) {
      // 锁扣
      g.lineWidth = 40; g.lineCap = "butt";
      g.beginPath(); g.moveTo(205, 312); g.lineTo(205, 200);
      g.arc(300, 200, 95, Math.PI, 0); g.lineTo(395, 312); g.stroke();
      // 锁身
      var x = 150, y = LOCK_TOP, w = 300, h = 240, r = 34;
      g.beginPath();
      g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
      g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); g.fill();
      // 钥匙孔和两道细槽挖掉
      g.globalCompositeOperation = "destination-out";
      g.beginPath(); g.arc(300, 400, 28, 0, 6.29); g.fill();
      g.beginPath(); g.moveTo(286, 412); g.lineTo(314, 412); g.lineTo(322, 478); g.lineTo(278, 478); g.closePath(); g.fill();
      g.lineWidth = 3;
      g.beginPath(); g.moveTo(176, 330); g.lineTo(424, 330); g.stroke();
      g.beginPath(); g.moveTo(176, 510); g.lineTo(424, 510); g.stroke();
      g.globalCompositeOperation = "source-over";
    }, function (x, y) {
      return y < LOCK_TOP ? ramp(.95 - (LOCK_TOP - y) / 420) : ramp(.9 - (y - LOCK_TOP) / 520 + (x < 300 ? .06 : 0));
    }, function (x, y) { return y < LOCK_TOP + 8 ? 1 : 0; });
    return pack(pts);
  }

  function buildGlobe() {
    var pts = [], n = 7200, R = .40;
    for (var i = 0; i < n; i++) {
      var y = 1 - (i / (n - 1)) * 2, r = Math.sqrt(1 - y * y), th = i * 2.39996;
      pts.push({ u: Math.cos(th) * r * R, v: y * R, w: Math.sin(th) * r * R, tone: 7, sz: .0042, grp: 0 });
    }
    // 一条斜着的轨道环
    for (i = 0; i < 1400; i++) {
      var a = i / 1400 * 6.2832, rr = .5 + (Math.random() - .5) * .012;
      pts.push({ u: Math.cos(a) * rr, v: Math.sin(a) * rr * .2, w: Math.sin(a) * rr, tone: 9, sz: .0034, grp: 1 });
    }
    return pack(pts, { dyn: true });
  }

  function buildWord() {
    var pts = sampleDraw(1400, 260, 3.4, function (g, w, h) {
      g.textAlign = "center"; g.textBaseline = "middle";
      g.font = '600 200px "Geist Mono", ui-monospace, monospace';
      g.fillText("AGENTRY", w / 2, h / 2 + 6);
    }, function (x, y, w, h) { return ramp(.55 + .45 * (1 - y / h)); });
    return pack(pts);
  }

  function buildCardShape(done) {
    var img = new Image();
    img.onload = function () {
      var off = document.createElement("canvas");
      off.width = CW; off.height = CH;
      var g = off.getContext("2d");
      g.drawImage(img, -6, -4, 572, 784);
      g.fillStyle = "#2B1F02";
      g.textAlign = "center"; g.textBaseline = "middle";
      g.font = '600 92px "Geist", system-ui, sans-serif';
      g.fillText(".ai", CW / 2, CH / 2);
      g.font = '500 36px "Geist", system-ui, sans-serif';
      g.fillText(".ai", 42 + 127, CH - 74);
      var d;
      try { d = g.getImageData(0, 0, CW, CH).data; } catch (e) { done(null); return; }  // file:// 下会被拦

      var narrow = (window.innerWidth || 1440) < 860;
      var sg = narrow ? 8 : STEP_GOLD, si = narrow ? 4 : STEP_INK;
      var K = .92 / CH;                    // 卡高占造型框的 92%
      // 只认实心像素。原图最外一圈是半透明的抗锯齿，透明度在 128 上下跳，
      // 用 128 当门槛时边上会一节算进来一节不算，看起来就是一排小毛刺
      var CUT = 200;
      var colorTone = {};
      function px(x, y) { var i = ((y | 0) * CW + (x | 0)) * 4; return [d[i], d[i + 1], d[i + 2], d[i + 3]]; }
      function lumOf(p) { return (p[0] * .3 + p[1] * .59 + p[2] * .11) / 255; }
      function alpha(x, y) { return (x < 0 || y < 0 || x >= CW || y >= CH) ? 0 : d[((y | 0) * CW + (x | 0)) * 4 + 3]; }
      function inside(x, y, r) {
        return alpha(x - r, y - r) >= CUT && alpha(x + r, y - r) >= CUT &&
               alpha(x - r, y + r) >= CUT && alpha(x + r, y + r) >= CUT;
      }
      // 卡用原图的颜色，量化成 16 级加进色表
      function toneFor(p) {
        var key = (p[0] >> 4) + "," + (p[1] >> 4) + "," + (p[2] >> 4);
        if (colorTone[key] == null) {
          colorTone[key] = TONES.length;
          TONES.push("rgb(" + ((p[0] >> 4) * 16 + 8) + "," + ((p[1] >> 4) * 16 + 8) + "," + ((p[2] >> 4) * 16 + 8) + ")");
        }
        return colorTone[key];
      }
      var pts = [];
      function add(x, y, tone, step, mul) {
        pts.push({ u: (x - CW / 2) * K, v: (y - CH / 2) * K, tone: tone, sz: step * K * mul });
      }
      for (var y = sg / 2; y < CH; y += sg) for (var x = sg / 2; x < CW; x += sg) {
        var p = px(x, y);
        if (p[3] >= CUT && lumOf(p) >= .3 && inside(x, y, sg * .45)) add(x, y, toneFor(p), sg, .8);
      }
      // 轮廓一圈细点，把直边和斜角描顺
      var seen = {};
      for (y = 0; y < CH; y += 1.25) for (x = 0; x < CW; x += 1.25) {
        if (alpha(x, y) < CUT) continue;
        if (alpha(x - 2, y) >= CUT && alpha(x + 2, y) >= CUT && alpha(x, y - 2) >= CUT && alpha(x, y + 2) >= CUT) continue;
        var key = Math.round(x / si) + "," + Math.round(y / si);
        if (seen[key]) continue;
        seen[key] = 1;
        var pc = px(x + (x < CW / 2 ? 5 : -5), y + (y < CH / 2 ? 5 : -5));
        if (lumOf(pc) < .3) pc = [214, 160, 18, 255];
        add(x, y, toneFor(pc), si, 1.15);
      }
      for (y = si; y < CH; y += si) for (x = si; x < CW; x += si) {
        if (!inside(x, y, si * .45) || inside(x, y, sg)) continue;
        p = px(x, y);
        if (lumOf(p) < .3) p = px(x + (x < CW / 2 ? 4 : -4), y + (y < CH / 2 ? 4 : -4));
        if (lumOf(p) < .3) continue;
        add(x, y, toneFor(p), si, 1.15);
      }
      // 字：单独用更细的网格（1.6）取点，深墨色，压在最上面。
      // 卡上的小字只有十来像素高，按 2.5 取点时 E、N 的细笔画会漏掉，AGENT 读起来像 AGDIT
      var sk = narrow ? 3 : STEP_TEXT;
      for (y = sk / 2; y < CH; y += sk) for (x = sk / 2; x < CW; x += sk) {
        p = px(x, y);
        if (p[3] >= CUT && lumOf(p) < .3 && inside(x, y, 9)) add(x, y, T_INK, sk, 1.2);
      }
      done(pack(pts, { card: true }));
    };
    img.onerror = function () { done(null); };
    img.src = "agent-id-card.png";
  }

  function buildMorph() {
    try {
      SH.print = buildPrint(); SH.trio = buildTrio(); SH.lock = buildLock();
      SH.globe = buildGlobe(); SH.word = buildWord();
    } catch (e) { return; }
    buildCardShape(function (card) {
      SH.card = card || SH.print;
      NP = 0;
      for (var k in SH) NP = Math.max(NP, SH[k].n);
      PX = new Float32Array(NP); PY = new Float32Array(NP); PS = new Float32Array(NP);
      DL = new Float32Array(NP); N1 = new Float32Array(NP); N2 = new Float32Array(NP);
      KK = new Float32Array(NP); PH = new Float32Array(NP);
      HA = new Float32Array(NP); HR = new Float32Array(NP); HV = new Float32Array(NP);
      for (var i = 0; i < NP; i++) {
        PX[i] = rand(0, W); PY[i] = rand(0, H); PS[i] = 1.5;
        DL[i] = Math.random() * .38;                      // 过渡时各自的起步延迟
        var a = rand(0, 6.2832), m = rand(.25, 1);
        N1[i] = Math.cos(a) * m; N2[i] = Math.sin(a) * m; // 散开的方向和远近
        KK[i] = rand(.5, 2.2); PH[i] = rand(0, 6.2832);
        HA[i] = rand(0, 6.2832); HR[i] = rand(.5, .82); HV[i] = rand(.00004, .00012) * (Math.random() < .5 ? -1 : 1);
      }
      BK = TONES.map(function () { return []; });
      morphReady = true;
    });
  }

  /* 每个造型在屏幕上的位置和大小。宽屏放右侧，窄屏放正中当背景 */
  function poseOf(name) {
    var wide = W > 1040;
    if (name === "word") return { cx: W / 2, cy: H * .46, S: Math.min(W * .82, 1180) };
    if (!wide) return { cx: W / 2, cy: H * .5, S: Math.min(W * .92, H * .6) };
    return { cx: W * .7, cy: H * .53, S: Math.min(H * .68, W * .36) };
  }

  /* 每帧给各个造型准备的参数 */
  var F = {};
  function frameParams(t) {
    F.bob = reduced ? 0 : Math.sin(t * (6.2832 / 5000)) * 10;
    F.cardY = reduced ? 0 : Math.sin(t * .0005) * .22 + (pointer.on ? ((pointer.x / W) - .5) * .35 : 0);
    F.trioRot = reduced ? 0 : Math.sin(t * .00022) * .09;
    F.globeRot = reduced ? .6 : t * .00022;
    F.breath = reduced ? 1 : 1 + Math.sin(t * .0012) * .012;
    focusS += ((focus >= 0 ? 1 : 0) - focusS) * .12;
    lockOpenS += (lockOpen - lockOpenS) * .08;
  }
  /* 第 i 颗粒子在某个造型里的屏幕位置、大小和颜色，写进 O */
  var O = { x: 0, y: 0, s: 1, t: 7 };
  function place(name, sh, ps, i, t) {
    if (i >= sh.n) {
      // 用不完的粒子：一小部分绕成一圈淡淡的尘环，贴着造型，不铺到左边的字上
      if (i - sh.n < DUST_N && name !== "word") {
        var a = HA[i] + t * HV[i], r = (.5 + (HR[i] - .5) * .5) * ps.S;
        O.x = ps.cx + Math.cos(a) * r; O.y = ps.cy + Math.sin(a) * r * .62;
        O.s = Math.max(1, ps.S * .0028); O.t = T_DUST; return;
      }
      // 其余的和造型里的某个点重合，不画。过渡时它们从那个点出发，不会凭空冒出来
      place(name, sh, ps, i % sh.n, t);
      O.t = -1; return;
    }
    var u = sh.u[i], v = sh.v[i], tone = sh.tone[i];
    if (name === "card") {
      var cy = Math.cos(F.cardY);
      O.x = ps.cx + u * ps.S * cy; O.y = ps.cy + F.bob + v * ps.S * (1 + u * Math.sin(F.cardY) * .14);
    } else if (name === "trio") {
      var c = Math.cos(F.trioRot), s = Math.sin(F.trioRot);
      O.x = ps.cx + (u * c - v * s) * ps.S; O.y = ps.cy + (u * s + v * c) * ps.S;
      if (focusS > .01) {
        if (sh.grp[i] === focus) tone = tone + Math.round((T_HI - tone) * focusS);
        else tone = Math.max(1, tone - Math.round(4 * focusS));
      }
    } else if (name === "lock") {
      var lift = sh.grp[i] === 1 ? lockOpenS * .11 : 0;
      O.x = ps.cx + u * ps.S; O.y = ps.cy + (v - lift) * ps.S;
      if (lockOpenS > .01 && sh.grp[i] === 0) tone = Math.min(T_HI, tone + Math.round(2 * lockOpenS));
    } else if (name === "globe") {
      var w = sh.w[i], cr = Math.cos(F.globeRot), sr = Math.sin(F.globeRot);
      var x = u * cr + w * sr, z = -u * sr + w * cr, y = v;
      if (sh.grp[i] === 1) {   // 轨道环再绕 X 轴倾一下
        var ty = y * .94 - z * .34; z = y * .34 + z * .94; y = ty;
      }
      var k = 1 + z * .35;     // 近大远小
      O.x = ps.cx + x * ps.S * k; O.y = ps.cy + y * ps.S * k;
      tone = z < -.02 ? T_BACK : ramp(.45 + z * 1.2);
    } else {
      var br = name === "print" ? F.breath : 1;
      O.x = ps.cx + u * ps.S * br; O.y = ps.cy + v * ps.S * br;
    }
    O.s = Math.max(1, sh.sz[i] * ps.S); O.t = tone;
  }

  function drawMorph(t) {
    if (!morphReady || fadeAll < .01) return;
    var k0 = Math.max(0, Math.min(plan.length - 1, Math.floor(chap)));
    var u = chap - k0;
    var nA = plan[k0], nB = plan[Math.min(plan.length - 1, k0 + 1)];
    var A = SH[nA] || SH.card, B = SH[nB] || A;
    if (u < 1e-4 || A === B) { B = A; nB = nA; u = 0; }
    var pA = poseOf(nA), pB = poseOf(nB);
    frameParams(t);
    for (var b = 0; b < BK.length; b++) BK[b].length = 0;

    var hasP = pointer.on && !reduced, R2 = REPEL_R * REPEL_R, hit = 0;
    for (var i = 0; i < NP; i++) {
      place(nA, A, pA, i, t);
      var x = O.x, y = O.y, s = O.s, tone = O.t;
      if (u > 0) {
        var m = smooth(cl01((u - DL[i]) / .62));
        if (m > 0) {
          place(nB, B, pB, i, t);
          var sc = Math.sin(m * Math.PI), spread = (pA.S + pB.S) * .32;
          x = lerp(x, O.x, m) + N1[i] * sc * spread;
          y = lerp(y, O.y, m) + N2[i] * sc * spread;
          s = lerp(s, O.s, m);
          if (m > .5) tone = O.t;
        }
      }
      if (hasP) {
        var dx = x - pointer.x, dy = y - pointer.y, d2 = dx * dx + dy * dy;
        if (d2 < R2) {
          if (tone >= 0 && tone !== T_DUST) hit++;
          var dd = Math.sqrt(d2) || 1, f = (REPEL_R - dd) / REPEL_R;
          var push = f * REPEL_R * REPEL_K * KK[i], ang = Math.atan2(dy, dx) + Math.sin(PH[i]) * .6;
          x += Math.cos(ang) * push; y += Math.sin(ang) * push;
        }
      }
      PX[i] += (x - PX[i]) * .14;
      PY[i] += (y - PY[i]) * .14;
      PS[i] = s;
      if (tone >= 0) BK[tone].push(i);
    }

    var narrow = W <= 1040;
    ctx.globalAlpha = fadeAll * (narrow ? .38 : 1);
    // 深墨（卡上的字）最后画，压在金面上面
    for (b = 1; b <= BK.length; b++) {
      var tb = b === BK.length ? 0 : b, list = BK[tb];
      if (!list.length) continue;
      ctx.fillStyle = TONES[tb];
      for (var j = 0; j < list.length; j++) {
        var q = list[j], h = PS[q] / 2;
        ctx.fillRect(PX[q] - h, PY[q] - h, PS[q], PS[q]);
      }
    }

    // 鼠标压在造型上时，吹开的那个圆圈中间浮出 .ai。
    // 圈里有足够多的粒子才算"在造型上"；淡入淡出都带缓动，不会一闪一闪
    if (aiA < .02 && pointer.on) { aiX = pointer.x; aiY = pointer.y; }   // 刚出现时直接在鼠标处，不从角落滑过来
    aiA += ((hasP && hit > 12 ? 1 : 0) - aiA) * .14;
    if (aiA > .02) {
      var fs = Math.round(REPEL_R * .62);
      ctx.globalAlpha = aiA * fadeAll;
      ctx.font = "600 " + fs + 'px "Geist", system-ui, sans-serif';
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillStyle = "#F0B90B";
      ctx.shadowColor = "rgba(240,185,11,.55)"; ctx.shadowBlur = 14;
      ctx.fillText(".ai", aiX, aiY + (1 - aiA) * 6);
      ctx.shadowBlur = 0;
    }
    // 文字跟着鼠标走，但带一点滞后，读起来是浮在圈里而不是贴在光标上
    if (pointer.on) { aiX += (pointer.x - aiX) * .3; aiY += (pointer.y - aiY) * .3; }
    ctx.globalAlpha = 1;
  }
  var aiA = 0, aiX = 0, aiY = 0;
  var oa = { x: 0, y: 0, r: 1, a: 1 }, ob = { x: 0, y: 0, r: 1, a: 1 };

  function render(now) {
    if (!W || !H || !P.length) return;
    var t = now, p = progress;

    var k = 0;
    while (k < ANCHOR.length - 2 && p > ANCHOR[k + 1]) k++;
    var span = ANCHOR[k + 1] - ANCHOR[k] || 1;
    var mix = smooth(cl01((p - ANCHOR[k]) / span));

    ctx.clearRect(0, 0, W, H);

    var fa = FORM[k], fb = FORM[k + 1];
    for (var i = 0; i < P.length; i++) {
      var q = P[i];
      fa(q, t, oa); fb(q, t, ob);
      var tx = lerp(oa.x, ob.x, mix), ty = lerp(oa.y, ob.y, mix);
      var tr = lerp(oa.r, ob.r, mix), ta = lerp(oa.a, ob.a, mix);

      var e = (k === 0 && mix < .3) ? .55 : q.ease;
      q.x += (tx - q.x) * e;
      q.y += (ty - q.y) * e;

      if (ta < .012 || tr < .12) continue;
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(q.x, q.y, tr, 0, 6.2832);
      ctx.fillStyle = "rgba(" + q.c[0] + "," + q.c[1] + "," + q.c[2] + "," + ta.toFixed(3) + ")";
      ctx.fill();
    }
    drawMorph(t);
  }

  function loop(now) { render(now); raf = requestAnimationFrame(loop); }

  function init(el) {
    canvas = el;
    if (!canvas || !canvas.getContext) return false;
    ctx = canvas.getContext("2d");
    resize();
    // 加载那一刻画布可能还是 0×0（后台标签、窗口还没排好版）。
    // 这里不能就此放弃：下面的 ResizeObserver 等它有了尺寸会自己 resize，
    // render 在尺寸为 0 时什么也不画，等得起
    // 等字体到位再采样，否则 .ai 会用后备字体画
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(buildMorph); else buildMorph();

    if (typeof ResizeObserver !== "undefined") {
      new ResizeObserver(function () {
        var r = canvas.getBoundingClientRect();
        if (r.width > 0 && (Math.abs(r.width - W) > 1 || Math.abs(r.height - H) > 1)) resize();
      }).observe(canvas);
    }
    window.addEventListener("resize", resize);

    if (!reduced) {
      window.addEventListener("pointermove", function (e) {
        pointer.x = e.clientX; pointer.y = e.clientY; pointer.on = true;
      }, { passive: true });
      window.addEventListener("pointerleave", function () { pointer.on = false; });
    }

    render(performance.now());     // rAF 可能被节流，先同步画一帧
    raf = requestAnimationFrame(loop);
    return true;
  }

  return {
    init: init,
    render: render,
    setProgress: function (v) { progress = cl01(v); },
    stats: function () {
      var o = { particles: NP, tones: TONES.length, ready: morphReady };
      for (var k in SH) o[k] = SH[k].n;
      return o;
    },
    /* 粒子造型：每章一个造型名，章节坐标，悬停的节点，锁扣开合，整体淡出 */
    setShapes: function (names) { plan = names.slice(); },
    setChapter: function (c) { chap = c; },
    setFocus: function (i) { focus = i == null ? -1 : i; },
    setLock: function (v) { lockOpen = cl01(v); },
    setFade: function (v) { fadeAll = cl01(v); },
    // 圆圈里的 .ai 现在是否显示着（右键跳转用）
    aiShown: function () { return aiA > .5 && pointer.on; },
    // 每章一个形态：["orbit","orbit","sea",…,"word"]，按顺序均分到 0..1
    setPlan: function (names) {
      var map = { orbit: posOrbit, sea: posSea, word: posWord };
      var n = names.length;
      FORM = names.map(function (s) { return map[s] || posSea; });
      ANCHOR = names.map(function (_, i) { return n > 1 ? i / (n - 1) : 0; });
    },
    getProgress: function () { return progress; },
  };
})();
