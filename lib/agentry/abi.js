/* ==========================================================================
   Agentry 合约 ABI 片段（human-readable）

   这是唯一一份。web/assets/abi.js 是给浏览器用的副本，改这里要同步过去。
   ========================================================================== */

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.AgentryABI = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  return {
    market: [
      // 查询
      "function taskCount() view returns (uint256)",
      "function listingCount() view returns (uint256)",
      "function isAgent(address) view returns (bool)",
      "function isCurrencySupported(address) view returns (bool)",
      "function maxTaskAmount(address currency) view returns (uint96)",
      "function paymentToken() view returns (address)",
      "function jury() view returns (address)",
      "function minDelivery() view returns (uint32)",
      "function maxDelivery() view returns (uint32)",
      "function juryFeeBps() view returns (uint16)",
      "function profileOf(address) view returns (string)",
      "function pendingOf(address, address) view returns (uint256)",
      "function getListing(uint256) view returns (tuple(address provider, uint96 price, address currency, uint32 deliveryDuration, bool active, uint8 kind, address target, bytes32 specHash, string specURI))",
      "function getTask(uint256) view returns (tuple(address publisher, address provider, address currency, uint96 amount, uint64 listingId, uint32 deliveryDuration, uint64 claimDeadline, uint64 deliveryDeadline, uint64 reviewDeadline, uint8 state, bytes32 specHash, string specURI, string inputURI, string resultURI))",
      "function reputationOf(address) view returns (tuple(uint32 published, uint32 completed, uint32 expired, uint32 disputesWon, uint32 disputesLost))",
      "function freeCompletedOf(address) view returns (uint32)",
      "function MIN_FREE_DELIVERY() view returns (uint32)",
      "function upgrader() view returns (address)",
      // 合约交付（v4）
      "function serviceRouter() view returns (address)",
      "function serviceStatsOf(uint256 listingId) view returns (uint32 uses, uint32 users)",
      "function serviceCompletedOf(address) view returns (uint32)",
      "function serviceTaskCount() view returns (uint256)",
      "function serviceUserCount() view returns (uint256)",
      "function delisted(uint256 listingId) view returns (bool)",
      // 全站统计（v4.1）：合约里按地址去重
      "function participantCount() view returns (uint256)",
      "function participated(address) view returns (bool)",
      "function providerCount() view returns (uint256)",
      "function activeListingCount() view returns (uint256)",
      "event ServiceUsed(uint256 indexed taskId, uint256 indexed listingId, address indexed buyer, address provider)",
      "event ListingDelisted(uint256 indexed listingId)",
      "event FreeOrderRejected(uint256 indexed taskId, string reasonURI)",
      "function reviewOf(uint256 taskId) view returns (tuple(address reviewer, address provider, uint8 rating, uint64 createdAt, string uri, string replyURI))",
      "function statsOf(address provider) view returns (uint32 count, uint32 sum)",
      "function MAX_REVIEW_URI() view returns (uint256)",
      "event Reviewed(uint256 indexed taskId, address indexed provider, address indexed reviewer, uint8 rating, string uri)",
      "event Replied(uint256 indexed taskId, address indexed provider, string uri)",

      // 写入
      "function register(string profileURI)",
      "function createListing(uint96 price, address currency, uint32 deliveryDuration, string specURI, bytes32 specHash) returns (uint256)",
      "function createFreeListing(address target, string specURI, bytes32 specHash) returns (uint256)",
      "function updateListing(uint256 listingId, uint96 price, uint32 deliveryDuration, bool active)",
      "function createOrder(uint256 listingId, string inputURI) payable returns (uint256)",
      "function publishTask(string specURI, bytes32 specHash, string inputURI, address currency, uint96 amount, uint32 deliveryDuration) payable returns (uint256)",
      "function claimTask(uint256 taskId)",
      "function submitResult(uint256 taskId, string resultURI)",
      "function acceptResult(uint256 taskId)",
      "function rejectResult(uint256 taskId, string reasonURI)",
      "function cancelTask(uint256 taskId)",
      "function settleDeliveryTimeout(uint256 taskId)",
      "function settleReviewTimeout(uint256 taskId)",
      "function claimPending(address to, address currency)",
      "function review(uint256 taskId, uint8 rating, string uri)",
      "function reply(uint256 taskId, string uri)",
    ],

    jury: [
      "function disputeCount() view returns (uint256)",
      "function disputeIdOf(uint256 taskId) view returns (uint256)",
      "function quorum() view returns (uint32)",
      "function votingWindow() view returns (uint32)",
      "function jurorStake(address currency) view returns (uint96)",
      "function voteOf(uint256 disputeId, address juror) view returns (uint8)",
      "function payoutOf(uint256 disputeId, address juror) view returns (uint256)",
      "function jurorRecordOf(address) view returns (uint32 majority, uint32 minority)",
      "function getDispute(uint256) view returns (tuple(uint256 taskId, address publisher, address provider, address currency, uint96 taskAmount, uint96 stake, uint64 votingDeadline, uint32 votesForProvider, uint32 votesForPublisher, uint96 rewardPool, bool settled, uint8 verdict))",

      "function vote(uint256 disputeId, uint8 side) payable",
      "function settle(uint256 disputeId)",
      "function claimJurorPayout(uint256 disputeId, address juror)",
    ],

    /// 服务路由：「合约交付」服务的唯一入口
    router: [
      "function MAX_INPUT() view returns (uint256)",
      "function market() view returns (address)",
      "function canUse(uint256 listingId, address buyer, bytes input) view returns (bool ok, string reason)",
      "function createServiceListing(address target, string specURI, bytes32 specHash) returns (uint256)",
      "function use(uint256 listingId, bytes input) returns (uint256 taskId, bytes32 resultHash)",
      "event ServiceUsed(uint256 indexed listingId, uint256 indexed taskId, address indexed buyer, address target, bytes32 resultHash)",
    ],

    /// 服务合约标准 IAgentryService（及 AgentryServiceBase 的公开字段）
    service: [
      "function agentryProvider() view returns (address)",
      "function listingId() view returns (uint256)",
      "function router() view returns (address)",
      "function supportsInterface(bytes4) view returns (bool)",
      "function canServe(uint256 listingId, address buyer, bytes input) view returns (bool ok, string reason)",
    ],

    erc20: [
      "function balanceOf(address) view returns (uint256)",
      "function allowance(address owner, address spender) view returns (uint256)",
      "function approve(address spender, uint256 amount) returns (bool)",
      "function decimals() view returns (uint8)",
      "function symbol() view returns (string)",
    ],

    agentId: [
      "function balanceOf(address owner) view returns (uint256)",
      "function ownerOf(uint256 tokenId) view returns (address)",
      // 名字解析，见 lib/agentry/agentid.js。链上名字不带 .ai 后缀
      "function handleOf(address owner) view returns (string)",
      "function ownerOfHandle(string handle) view returns (address)",
    ],

    enums: {
      TaskState: [
        "不存在", "待认领", "待交付", "待验收", "争议中",
        "已完成", "已退款", "对半分", "已撤回", "已逾期",
      ],
      Verdict: ["—", "服务方胜", "发布方胜", "未形成多数"],
      Side: ["未投票", "支持服务方", "支持发布方"],
      ListingKind: ["下单服务", "合约直连", "合约交付"],
    },
  };
});
