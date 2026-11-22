/* 自动生成，请勿直接修改。
   源文件 lib/agentry/inline.js，改完跑 `npm run sync:web` 重新生成。 */
/* ==========================================================================
   把规格、名片直接写进链上：data: URI

   规格和名片都是公开的小 JSON。与其放在某台服务器上（关机就取不到、网站访客也打不开），
   不如整份编码进 specURI / profileURI，随交易一起上链：
     - 不依赖任何服务器，谁都能从链上读回来
     - 写进去就改不了，和 specHash 一起构成双保险
     - 浏览器的 fetch 和 Node 都能直接读 data: URI，这里也提供不依赖 fetch 的解码

   编码的是规范化 JSON（Spec.canonicalize），所以解码后复算 specHash 必然一致。
   体积上限 INLINE_MAX：BSC 上每 32 字节存储约 2 万 gas，9000 字节约 0.0003 BNB；
   同时让 baw preview 的命令行保持在 Windows 32767 字符的上限以内。

   交付物、输入材料可能很大或不宜公开，不走这里。

   Node 与浏览器共用（UMD）。
   ========================================================================== */

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.AgentryInline = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const PREFIX = "data:application/json;base64,";
  const INLINE_MAX = 9000; // data URI 总长度，单位：字符（= 字节，base64 全是 ASCII）

  function utf8ToBase64(str) {
    if (typeof Buffer !== "undefined") return Buffer.from(str, "utf8").toString("base64");
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function base64ToUtf8(b64) {
    if (typeof Buffer !== "undefined") return Buffer.from(b64, "base64").toString("utf8");
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function isInline(uri) {
    return typeof uri === "string" && /^data:application\/json(;[^,]*)?,/i.test(uri);
  }

  /// JSON 对象 → data URI。canonical 传入规范化函数（规格用 Spec.canonicalize），不传就用 JSON.stringify
  function encode(doc, canonical) {
    const text = canonical ? canonical(doc) : JSON.stringify(doc);
    const uri = PREFIX + utf8ToBase64(text);
    return { uri: uri, size: uri.length, fits: uri.length <= INLINE_MAX };
  }

  /// data URI → JSON 对象。不是 data URI 或解析失败返回 null
  function decode(uri) {
    if (!isInline(uri)) return null;
    const comma = uri.indexOf(",");
    const meta = uri.slice(5, comma);
    const body = uri.slice(comma + 1);
    try {
      const text = /;base64/i.test(meta) ? base64ToUtf8(body) : decodeURIComponent(body);
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  return { PREFIX, INLINE_MAX, isInline, encode, decode };
});
