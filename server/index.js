/* ==========================================================================
   Agentry 内容服务

   职责只有一件：**存字节、发字节**。
   不持私钥，不托管会话，不代签，不碰链上状态。
   它整个挂掉也不能阻断任何资金路径——所有结算在合约层都是无需许可的。

   接口：
     GET  /health
     GET  /capabilities          能力分类表
     POST /spec                  校验 + 规范化 + 存储，返回可上链的 specHash
     POST /content               存任意字节（交付物）
     GET  /ipfs/:cid             取回内容
   ========================================================================== */

"use strict";

const http = require("http");
const path = require("path");

const { createStore } = require("./store");
const Spec = require("../lib/spec");
const REGISTRY = require("../lib/spec/capabilities.json");

const KNOWN_CAPABILITIES = REGISTRY.capabilities.map((c) => c.id);

/* ---------- 配置 ---------- */

const PORT = Number(process.env.PORT || 8787);
const CONTENT_DIR = process.env.CONTENT_DIR || path.join(__dirname, "..", ".content");

/* ---------- keccak ----------
   specHash 要和合约里的 bytes32 对上，需要 keccak256。
   ethers 已经是本项目的依赖，直接用                                       */
let keccak256, toUtf8Bytes;
try {
  const ethers = require("ethers");
  keccak256 = ethers.keccak256;
  toUtf8Bytes = ethers.toUtf8Bytes;
} catch (e) {
  console.warn("未找到 ethers，/spec 将不返回 specHash");
}

/* ---------- 工具 ---------- */

function send(res, status, obj, extraHeaders) {
  const body = Buffer.from(JSON.stringify(obj, null, 2) + "\n", "utf8");
  res.writeHead(status, Object.assign({
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "X-Content-Type-Options": "nosniff",
  }, extraHeaders || {}));
  res.end(body);
}

/// 错误响应也必须带 CORS，否则浏览器端拿不到错误内容，
/// 只会看到一个没有信息量的 network error
function fail(res, status, message, detail) {
  send(res, status, { error: message, detail: detail || undefined }, CORS);
}

/// 读取请求体。返回 { buf } 或 { tooLarge: true }
///
/// 不能在超限时 destroy 连接：那样响应还没写出去链路就断了，
/// 客户端只会看到一个莫名其妙的 socket reset，而不是「内容太大」。
/// 所以先按 Content-Length 预判，流式超限时继续接收但丢弃，
/// 保住连接把 413 送出去。
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] || 0);
    if (declared > limit) {
      resolve({ tooLarge: true });
      req.resume(); // 排干，否则连接会挂住
      return;
    }

    const chunks = [];
    let size = 0;
    let over = false;

    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        over = true;
        chunks.length = 0; // 丢掉已收的，但继续排干
        return;
      }
      if (!over) chunks.push(c);
    });
    req.on("end", () =>
      resolve(over ? { tooLarge: true } : { buf: Buffer.concat(chunks) })
    );
    req.on("error", reject);
  });
}

const TOO_LARGE = "内容超过上限，更大的文件请自行托管——" +
  "specURI / resultURI 接受任意公开 URI";

/// 固定失败必须让调用方看见。内容只在我们本机意味着
/// 「陪审团依赖我们活着」，而那是设计约束明确禁止的
function pinWarning(pin) {
  if (pin.pinned) return [];
  if (pin.cidMismatch) {
    return ["⚠️ 固定服务返回的 CID 与本地不一致，内容未固定：" + pin.error];
  }
  return [
    "⚠️ 内容未固定到 IPFS（" + (pin.error || "原因未知") + "）。" +
    "目前只存在于本服务器上——上链之前请确认这是可以接受的。",
  ];
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

/* ---------- 路由 ---------- */

function createApp(store) {
  return async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    const route = url.pathname;

    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS);
      res.end();
      return;
    }

    try {
      // ---- 健康检查 ----
      if (req.method === "GET" && route === "/health") {
        const s = store.stats();
        return send(res, 200, {
          ok: true,
          specVersion: Spec.VERSION,
          maxBytes: store.MAX_BYTES,
          stored: s.count,
          pinned: s.pinned,
          unpinned: s.unpinned,
          pinDriver: s.driver,
          usedBytes: s.usedBytes,
          maxTotalBytes: s.maxTotalBytes,
        }, CORS);
      }

      // ---- 能力分类表 ----
      if (req.method === "GET" && route === "/capabilities") {
        return send(res, 200, REGISTRY, CORS);
      }

      // ---- 上传规格 ----
      if (req.method === "POST" && route === "/spec") {
        const body = await readBody(req, store.MAX_BYTES);
        if (body.tooLarge) return fail(res, 413, TOO_LARGE);

        let doc;
        try {
          doc = JSON.parse(body.buf.toString("utf8"));
        } catch (e) {
          return fail(res, 400, "请求体不是合法 JSON", e.message);
        }

        // 不合格的规格直接拦在上链之前。一份坏规格进了链，
        // 争议时陪审团就只能对着含糊的标准判
        const check = Spec.validateSpec(doc, { knownCapabilities: KNOWN_CAPABILITIES });
        if (!check.ok) {
          return fail(res, 422, "规格未通过校验", check.errors);
        }

        // 存的就是规范化后的字节，这样两条验证路径会得到同一个答案：
        //   取回原始字节直接哈希  ==  解析后重新规范化再哈希
        let canonical;
        try {
          canonical = Spec.canonicalize(doc);
        } catch (e) {
          return fail(res, 422, "规格无法规范化", e.message);
        }

        const stored = await store.put(Buffer.from(canonical, "utf8"), "application/json");

        return send(res, 201, {
          cid: stored.cid,
          uri: stored.uri,
          size: stored.size,
          specHash: keccak256 ? keccak256(toUtf8Bytes(canonical)) : null,
          pinned: stored.pin.pinned,
          pin: stored.pin,
          warnings: check.warnings.concat(pinWarning(stored.pin)),
          note: "specHash 请在本地用同一份文档复算后再上链，不要只信本接口",
        }, CORS);
      }

      // ---- 上传任意内容（交付物）----
      if (req.method === "POST" && route === "/content") {
        const body = await readBody(req, store.MAX_BYTES);
        if (body.tooLarge) return fail(res, 413, TOO_LARGE);
        if (body.buf.length === 0) return fail(res, 400, "内容不能为空");

        const declared = (req.headers["content-type"] || "").split(";")[0].trim();
        const stored = await store.put(body.buf, declared);

        return send(res, 201, {
          cid: stored.cid,
          uri: stored.uri,
          size: stored.size,
          type: stored.type,
          inline: stored.type !== "application/octet-stream",
          pinned: stored.pin.pinned,
          pin: stored.pin,
          warnings: pinWarning(stored.pin),
        }, CORS);
      }

      // ---- 固定状态 / 重试 ----
      if (route.startsWith("/pin/")) {
        const cid = route.slice("/pin/".length);
        const found = store.get(cid);
        if (!found) return fail(res, 404, "未找到该 CID", cid);

        if (req.method === "GET") {
          return send(res, 200, {
            cid,
            pin: found.meta.pin || { pinned: false, error: "未记录" },
          }, CORS);
        }
        if (req.method === "POST") {
          const result = await store.repin(cid);
          return send(res, 200, { cid, pin: result }, CORS);
        }
      }

      // ---- 取回 ----
      if (req.method === "GET" && route.startsWith("/ipfs/")) {
        const cid = route.slice("/ipfs/".length);
        const found = store.get(cid);
        if (!found) return fail(res, 404, "未找到该 CID", cid);

        const headers = Object.assign(
          store.headersFor(found.meta),
          CORS,
          { "Content-Length": found.body.length }
        );
        res.writeHead(200, headers);
        res.end(found.body);
        return;
      }

      return fail(res, 404, "没有这个接口", route);
    } catch (e) {
      if (e && e.code === "QUOTA") return fail(res, 507, e.message);
      console.error(e);
      return fail(res, 500, "服务内部错误");
    }
  };
}

function createServer(opts) {
  const store = createStore((opts && opts.dir) || CONTENT_DIR, opts && opts.pinner, opts && { maxTotal: opts.maxTotal });
  const server = http.createServer(createApp(store));
  server.store = store;
  return server;
}

/* ---------- 启动 ---------- */

if (require.main === module) {
  const server = createServer();
  // 默认只听本机，对外由反向代理（Caddy）转发。要直接对外设 HOST=0.0.0.0
  server.listen(PORT, process.env.HOST || "127.0.0.1", () => {
    const s = server.store.stats();

    console.log("Agentry 内容服务");
    console.log("  监听     http://" + (process.env.HOST || "127.0.0.1") + ":" + PORT);
    console.log("  存储目录 " + CONTENT_DIR);
    console.log("  固定驱动 " + s.driver);
    if (s.count) {
      console.log("  已存内容 " + s.count + "（已固定 " + s.pinned + " · 未固定 " + s.unpinned + "）");
    }
    console.log("");

    if (s.driver === "none") {
      console.log("  ⚠️  未配置 IPFS 固定，内容只写本地磁盘。");
      console.log("     上主网前必须接上，否则内容在我们之外取不到，");
      console.log("     陪审团就依赖我们活着——那违背了设计约束。");
      console.log("");
      console.log("     自托管 kubo（推荐，CID 必然一致）：");
      console.log("       IPFS_API=http://127.0.0.1:5001 npm run serve:content");
      console.log("     Pinata：");
      console.log("       PINATA_JWT=<jwt> npm run serve:content");
    } else if (s.unpinned) {
      console.log("  ⚠️  有 " + s.unpinned + " 份内容尚未固定。");
      console.log("     重试：curl -X POST http://localhost:" + PORT + "/pin/<cid>");
    }
  });
}

module.exports = { createServer, createApp, createStore };
