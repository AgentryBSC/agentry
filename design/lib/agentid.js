/* 自动生成，请勿直接修改。
   源文件 lib/agentry/agentid.js，改完跑 `npm run sync:web` 重新生成。 */
/* ==========================================================================
   Agent ID 名字解析：地址 ↔ .ai 名字

   Agent ID 合约（SPACE ID 发行，BSC 0x60b9262456de011f7d15a54cdd8c48baaa8b022f）
   自带两个只读方法，不花 gas、不需要登录：
     handleOf(address)      → "anndy"   没有 Agent ID 返回 ""
     ownerOfHandle(string)  → 地址      没人注册返回零地址
   链上存的名字不带后缀，展示时统一补成 "anndy.ai"。

   Node 和浏览器共用这一份；contract 只要有 handleOf / ownerOfHandle 两个异步方法即可。
   ========================================================================== */

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.AgentryAgentId = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const ADDRESS = "0x60b9262456de011f7d15a54cdd8c48baaa8b022f";
  const SUFFIX = ".ai";
  const ZERO = "0x0000000000000000000000000000000000000000";
  const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

  /// 链上 handle → 展示用名字；空串表示没有 Agent ID
  function toName(handle) {
    const h = String(handle || "").trim().toLowerCase();
    return h ? h + SUFFIX : null;
  }

  /// 用户输入的名字 → 链上 handle。"Anndy.ai" / "anndy" 都认
  function toHandle(name) {
    let h = String(name || "").trim().toLowerCase();
    if (h.endsWith(SUFFIX)) h = h.slice(0, -SUFFIX.length);
    return h;
  }

  function isAddress(v) {
    return ADDR_RE.test(String(v || ""));
  }

  /// 看起来像 .ai 名字（而不是地址）
  function looksLikeName(v) {
    const s = String(v || "").trim();
    return !!s && !isAddress(s) && !s.startsWith("0x");
  }

  /// 展示：有名字就 "名字（地址）"，没有就只给地址
  function label(addr, name) {
    return name ? name + "（" + addr + "）" : addr;
  }

  function createResolver(contract) {
    const names = new Map(); // 小写地址 → Promise<名字|null>

    /// 地址 → "xxx.ai"；没有 Agent ID 或查询失败都返回 null，不让一个名字查不到拖垮整个列表
    function nameOf(addr) {
      if (!isAddress(addr) || addr.toLowerCase() === ZERO) return Promise.resolve(null);
      const key = addr.toLowerCase();
      if (!names.has(key)) {
        names.set(
          key,
          Promise.resolve()
            .then(() => contract.handleOf(addr))
            .then(toName)
            .catch(() => {
              names.delete(key); // 网络错误不缓存，下次还能再查
              return null;
            })
        );
      }
      return names.get(key);
    }

    /// 批量查，同一个地址只查一次
    function namesOf(addrs) {
      return Promise.all(addrs.map(nameOf));
    }

    /// "xxx.ai" → 地址；没人注册返回 null
    async function addressOf(name) {
      const h = toHandle(name);
      if (!h) return null;
      const a = await contract.ownerOfHandle(h);
      return a && a.toLowerCase() !== ZERO ? a : null;
    }

    return { nameOf, namesOf, addressOf };
  }

  return {
    ADDRESS,
    SUFFIX,
    toName,
    toHandle,
    isAddress,
    looksLikeName,
    label,
    createResolver,
  };
});
