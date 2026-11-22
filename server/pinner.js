/* ==========================================================================
   IPFS 固定

   ⚠️ 核心不变量：**固定服务返回的 CID 必须和本地算的完全一致**。

   我们算的是 CIDv1 / raw / sha2-256 / base32（单块）。如果固定服务用了
   别的参数——比如 dag-pb 包装、CIDv0、或者没开 raw-leaves——它返回的 CID
   会不一样。那意味着上链的 URI 指向的内容地址，和我们告诉用户的不是同一个。

   这种错误不会立刻暴露。它会一直沉默到有人去取交付物、取不到为止，
   而那时候钱已经托管了、争议已经开了。所以必须当场对比、当场失败。
   ========================================================================== */

"use strict";

const crypto = require("crypto");

/* ---------- multipart 构造（零依赖） ---------- */

function multipart(buf, filename) {
  const boundary = "----agentry" + crypto.randomBytes(12).toString("hex");
  const head = Buffer.from(
    "--" + boundary + "\r\n" +
    'Content-Disposition: form-data; name="file"; filename="' + filename + '"\r\n' +
    "Content-Type: application/octet-stream\r\n\r\n"
  );
  const tail = Buffer.from("\r\n--" + boundary + "--\r\n");
  return {
    body: Buffer.concat([head, buf, tail]),
    contentType: "multipart/form-data; boundary=" + boundary,
  };
}

/* ---------- 驱动 ---------- */

/// 不固定。开发默认值——内容只在本机，不满足「我们之外也能取到」
function noneDriver() {
  return {
    name: "none",
    enabled: false,
    async pin() {
      return { ok: false, error: "未配置 IPFS 固定" };
    },
  };
}

/// kubo / 任何 kubo 兼容的 HTTP API（自托管节点、Infura IPFS 等）
///
/// **推荐用这个**：add 的参数可以精确控制，CID 必然和我们算的一致
function kuboDriver(cfg) {
  const endpoint = cfg.endpoint.replace(/\/$/, "");

  return {
    name: "kubo",
    enabled: true,
    async pin(cid, buf) {
      const mp = multipart(buf, cid);
      const url =
        endpoint +
        "/api/v0/add?cid-version=1&raw-leaves=true&hash=sha2-256&pin=true&wrap-with-directory=false";

      const headers = { "Content-Type": mp.contentType };
      if (cfg.auth) headers["Authorization"] = cfg.auth;

      const r = await fetch(url, { method: "POST", headers, body: mp.body });
      if (!r.ok) {
        return { ok: false, error: "kubo 返回 " + r.status + "：" + (await r.text()).slice(0, 200) };
      }

      // kubo 对单文件返回一行 JSON
      const text = (await r.text()).trim().split("\n").pop();
      let returned;
      try {
        returned = JSON.parse(text).Hash;
      } catch (e) {
        return { ok: false, error: "kubo 返回了无法解析的内容：" + text.slice(0, 200) };
      }

      return { ok: true, cid: returned };
    },
  };
}

/// Pinata
///
/// ⚠️ Pinata 不暴露 raw-leaves 开关，返回的 CID **有可能**和我们算的不一致。
///    下面的 verify 会当场发现并报错，不会静默接受。真遇上了就改用 kubo。
function pinataDriver(cfg) {
  return {
    name: "pinata",
    enabled: true,
    async pin(cid, buf) {
      const boundary = "----agentry" + crypto.randomBytes(12).toString("hex");
      const parts = [
        Buffer.from(
          "--" + boundary + "\r\n" +
          'Content-Disposition: form-data; name="file"; filename="' + cid + '"\r\n' +
          "Content-Type: application/octet-stream\r\n\r\n"
        ),
        buf,
        Buffer.from(
          "\r\n--" + boundary + "\r\n" +
          'Content-Disposition: form-data; name="pinataOptions"\r\n\r\n' +
          JSON.stringify({ cidVersion: 1 }) +
          "\r\n--" + boundary + "--\r\n"
        ),
      ];

      const r = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + cfg.jwt,
          "Content-Type": "multipart/form-data; boundary=" + boundary,
        },
        body: Buffer.concat(parts),
      });

      if (!r.ok) {
        return { ok: false, error: "Pinata 返回 " + r.status + "：" + (await r.text()).slice(0, 200) };
      }

      const j = await r.json();
      return { ok: true, cid: j.IpfsHash };
    },
  };
}

/* ---------- 工厂 ---------- */

function createPinner(env) {
  env = env || process.env;

  if (env.IPFS_API) {
    return kuboDriver({ endpoint: env.IPFS_API, auth: env.IPFS_AUTH });
  }
  if (env.PINATA_JWT) {
    return pinataDriver({ jwt: env.PINATA_JWT });
  }
  return noneDriver();
}

/* ---------- 带校验的固定 ---------- */

/// 固定并**核对 CID**。这是整个模块存在的理由
async function pinAndVerify(pinner, cid, buf) {
  if (!pinner.enabled) {
    return { pinned: false, driver: pinner.name, error: "未配置 IPFS 固定" };
  }

  let res;
  try {
    res = await pinner.pin(cid, buf);
  } catch (e) {
    return { pinned: false, driver: pinner.name, error: String(e.message || e) };
  }

  if (!res.ok) {
    return { pinned: false, driver: pinner.name, error: res.error };
  }

  if (res.cid !== cid) {
    return {
      pinned: false,
      driver: pinner.name,
      cidMismatch: true,
      returnedCid: res.cid,
      error:
        "固定服务返回的 CID 与本地算的不一致。本地 " + cid + "，对方 " + res.cid +
        "。说明对方用了不同的分块或编码参数——这会让上链的 URI 指向错误的内容地址。" +
        "改用 kubo 并确保参数是 cid-version=1 & raw-leaves=true。",
    };
  }

  return { pinned: true, driver: pinner.name };
}

module.exports = {
  createPinner,
  pinAndVerify,
  noneDriver,
  kuboDriver,
  pinataDriver,
  multipart,
};
