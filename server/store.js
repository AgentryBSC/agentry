/* ==========================================================================
   内容寻址存储

   本地磁盘 + IPFS 固定。CID 按 IPFS 规则算，两边必须完全一致——
   校验在 pinner.js 里做。
   ========================================================================== */

"use strict";

const fs = require("fs");
const path = require("path");

const { cidV1Raw, isValidCid } = require("./cid");
const { createPinner, pinAndVerify } = require("./pinner");

/// 单块 CID 的上限。超过 256 KiB 时 IPFS 会做 UnixFS 分块，
/// 算出来的 CID 就和我们的对不上了
const MAX_BYTES = 256 * 1024;

/// 整个存储目录的总上限。上传接口是公开的，不设上限就可能被人塞满服务器磁盘。
/// 默认 1 GiB，用 CONTENT_MAX_TOTAL_MB 调整
const DEFAULT_MAX_TOTAL = 1024 * 1024 * 1024;

/* ---------- 可内联展示的类型 ----------
   陪审员**必须**打开交付物才能裁决，这让内容服务成了一个直接对准
   持币者的 XSS 入口。所以只有这几种类型允许内联，其余一律当附件下载。
   text/html 和 image/svg+xml 永远不在这个名单里。                        */
const INLINE_TYPES = {
  "application/json": "application/json; charset=utf-8",
  "text/plain": "text/plain; charset=utf-8",
  "text/csv": "text/csv; charset=utf-8",
  "text/markdown": "text/markdown; charset=utf-8",
  // 位图（名片头像用）。只有文件头和声明的类型对得上才按图片返回，见 imageMatches
  "image/png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/webp": "image/webp",
  "image/gif": "image/gif",
};

/// 位图的文件头。声明是图片但内容不是的，一律降级成附件
const IMAGE_MAGIC = {
  "image/png": (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  "image/jpeg": (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/gif": (b) => b.length > 6 && b.toString("latin1", 0, 4) === "GIF8",
  "image/webp": (b) => b.length > 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP",
};
function imageMatches(type, buf) {
  return !IMAGE_MAGIC[type] || IMAGE_MAGIC[type](buf);
}

function createStore(dir, pinner, opts) {
  fs.mkdirSync(dir, { recursive: true });
  pinner = pinner || createPinner();
  const maxTotal = (opts && opts.maxTotal) ||
    (process.env.CONTENT_MAX_TOTAL_MB ? Number(process.env.CONTENT_MAX_TOTAL_MB) * 1024 * 1024 : DEFAULT_MAX_TOTAL);

  // 启动时算一次已用空间，之后每次写入累加
  let used = 0;
  for (const f of fs.readdirSync(dir)) {
    if (isValidCid(f)) used += fs.statSync(path.join(dir, f)).size;
  }

  const blobPath = (cid) => path.join(dir, cid);
  const metaPath = (cid) => path.join(dir, cid + ".meta.json");

  function readMeta(cid) {
    try {
      return JSON.parse(fs.readFileSync(metaPath(cid), "utf8"));
    } catch (e) {
      return { type: "application/octet-stream" };
    }
  }

  function writeMeta(cid, meta) {
    fs.writeFileSync(metaPath(cid), JSON.stringify(meta, null, 2));
  }

  /// 写入并返回 CID。同样的内容写两次得到同一个 CID
  async function put(buf, declaredType) {
    if (!Buffer.isBuffer(buf)) throw new Error("内容必须是 Buffer");
    if (buf.length === 0) throw new Error("内容不能为空");
    if (buf.length > MAX_BYTES) {
      throw new Error(
        "内容超过 " + MAX_BYTES + " 字节。更大的文件请自行托管，" +
        "specURI / resultURI 接受任意公开 URI"
      );
    }

    const cid = cidV1Raw(buf);
    const type = INLINE_TYPES[declaredType] && imageMatches(declaredType, buf) ? declaredType : "application/octet-stream";
    const existed = fs.existsSync(blobPath(cid));

    if (!existed) {
      if (used + buf.length > maxTotal) {
        const err = new Error("存储空间已满，暂时不能再上传。规格和名片可以直接写进链上，不需要上传");
        err.code = "QUOTA";
        throw err;
      }
      fs.writeFileSync(blobPath(cid), buf);
      used += buf.length;
    }

    // 已固定过就不重复提交；之前失败过的会在这里重试
    let meta = existed ? readMeta(cid) : { type, size: buf.length, at: new Date().toISOString() };
    if (!meta.pin || !meta.pin.pinned) {
      meta.pin = await pinAndVerify(pinner, cid, buf);
      meta.type = meta.type || type;
      writeMeta(cid, meta);
    }

    return {
      cid,
      uri: "ipfs://" + cid,
      size: buf.length,
      type: meta.type,
      pin: meta.pin,
    };
  }

  function get(cid) {
    if (!isValidCid(cid)) return null;
    if (!fs.existsSync(blobPath(cid))) return null;
    return { body: fs.readFileSync(blobPath(cid)), meta: readMeta(cid) };
  }

  /// 重试一个此前固定失败的 CID
  async function repin(cid) {
    const found = get(cid);
    if (!found) return null;

    const meta = found.meta;
    meta.pin = await pinAndVerify(pinner, cid, found.body);
    writeMeta(cid, meta);
    return meta.pin;
  }

  /// 返回应当发出的响应头。决定内联还是下载的唯一地方
  function headersFor(meta) {
    const inline = INLINE_TYPES[meta.type];
    return {
      "Content-Type": inline || "application/octet-stream",
      "Content-Disposition": inline ? "inline" : "attachment",
      // 下面三条是防 XSS 的核心，别删
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "public, max-age=31536000, immutable", // 内容寻址，永不失效
    };
  }

  function stats() {
    const files = fs.readdirSync(dir).filter((f) => isValidCid(f));
    let pinned = 0;
    let unpinned = 0;
    for (const f of files) {
      if (readMeta(f).pin && readMeta(f).pin.pinned) pinned++;
      else unpinned++;
    }
    return { count: files.length, pinned, unpinned, driver: pinner.name, dir, usedBytes: used, maxTotalBytes: maxTotal };
  }

  return { put, get, repin, headersFor, stats, MAX_BYTES, INLINE_TYPES, pinner };
}

module.exports = { createStore, MAX_BYTES, INLINE_TYPES };
