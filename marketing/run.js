// 本地起一个 http 服务，用无头 Chrome 打开 render.html，接收渲染好的 MP4 / 截图
// 用法：node run.js [--stills 1,6,12] [--out file.mp4]
const http = require("http"), fs = require("fs"), path = require("path"), { spawn } = require("child_process");
const args = process.argv.slice(2);
const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const stills = get("--stills"), out = get("--out") || path.join(__dirname, "agentry-promo.mp4");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
let chrome;
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (req.method === "POST") {
    const bufs = [];
    req.on("data", (d) => bufs.push(d));
    req.on("end", () => {
      const b = Buffer.concat(bufs);
      res.end("ok");
      if (u.pathname === "/log") console.log(b.toString());
      else if (u.pathname === "/error") { console.error("错误：", b.toString()); finish(1); }
      else if (u.pathname === "/still") { const f = path.join(__dirname, "still-" + u.searchParams.get("t") + ".png"); fs.writeFileSync(f, b); console.log("still", f); }
      else if (u.pathname === "/video") { fs.writeFileSync(out, b); console.log("视频", out, (b.length / 1e6).toFixed(1) + " MB"); }
      else if (u.pathname === "/done") finish(0);
    });
    return;
  }
  const f = path.join(__dirname, decodeURIComponent(u.pathname));
  if (!f.startsWith(__dirname) || !fs.existsSync(f)) { res.statusCode = 404; return res.end(); }
  res.setHeader("content-type", f.endsWith(".html") ? "text/html; charset=utf-8" : f.endsWith(".mp4") ? "video/mp4" : f.endsWith(".png") ? "image/png" : "text/javascript");
  fs.createReadStream(f).pipe(res);
});
function finish(code) { try { chrome.kill(); } catch {} srv.close(); setTimeout(() => process.exit(code), 300); }
srv.listen(0, "127.0.0.1", () => {
  const url = "http://127.0.0.1:" + srv.address().port + "/" + (process.env.PAGE || "render.html") + (stills ? "?stills=" + stills : "");
  chrome = spawn(CHROME, ["--headless=new", "--disable-gpu-sandbox", "--no-first-run", "--window-size=1920,1080",
    "--user-data-dir=" + path.join(__dirname, ".chrome"), "--autoplay-policy=no-user-gesture-required", url], { stdio: "ignore" });
  setTimeout(() => { console.error("超时"); finish(1); }, 9 * 60 * 1000);
});
