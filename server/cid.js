/* ==========================================================================
   CIDv1 生成（raw 编解码 / sha2-256 / base32）

   自己算而不是依赖 IPFS 客户端，有两个好处：
     1. 零依赖
     2. 现在用本地存储，以后固定到任何 IPFS 节点时 CID 完全一致，
        已经上链的 URI 不需要动

   格式：CIDv1 = <version=0x01><codec=0x55 raw><multihash>
         multihash = <sha2-256=0x12><length=0x20><32 字节摘要>
         再整体 base32（RFC4648 小写无填充），前缀 'b' 表示 multibase

   ⚠️ 只适用于**单块**内容。IPFS 默认对超过 256 KiB 的文件做 UnixFS 分块，
      那种情况下的 CID 和这里算出来的不一样。所以上传有体积上限，
      见 store.js 的 MAX_BYTES。
   ========================================================================== */

"use strict";

const crypto = require("crypto");

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/// RFC4648 base32，小写，无填充
function base32(bytes) {
  let bits = 0;
  let value = 0;
  let out = "";

  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

/// 计算单块 raw CIDv1。等价于 `ipfs add --cid-version=1 --raw-leaves`
function cidV1Raw(buf) {
  const digest = crypto.createHash("sha256").update(buf).digest();
  const bytes = Buffer.concat([
    Buffer.from([0x01, 0x55, 0x12, 0x20]), // version, raw, sha2-256, len
    digest,
  ]);
  return "b" + base32(bytes);
}

/// 只做形状校验，不解码。够用来挡住路径穿越和明显的乱填
const CID_RE = /^bafkrei[a-z2-7]{52}$/;

function isValidCid(s) {
  return typeof s === "string" && CID_RE.test(s);
}

module.exports = { base32, cidV1Raw, isValidCid };
