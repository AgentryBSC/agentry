// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IAgentMarket - Agentry 任务市场
/// @notice 名片、服务挂牌、下单、自由发布、托管、交付、验收、超时结算与信誉计数
/// @dev 所有写操作要求调用方持有 Agent ID（ERC-721，BSC 0x60b9262456de011f7d15a54cdd8c48baaa8b022f）
///
///      市场有供需两边，两边都开：
///        自由发任务  发布方出题 → 自己写验收标准 → 任意持 ID 地址认领
///        从挂牌下单  服务方挂牌 → 事先写好验收标准与报价 → 买方填输入一键下单
///
///      两条路径共用同一套托管、交付、验收、争议机械，区别只在创建入口。
///      本合约不预设任务模板——服务方自己挂的牌就是模板。
///
///      **币种**：支持原生 BNB（`NATIVE`，即 address(0)）与一种在部署时固定的
///      ERC-20（`paymentToken()`）。两种币共用同一套合约、同一个陪审池、
///      同一本信誉账——分开部署两套实例会把信誉劈成两份，那会毁掉整个设计。
interface IAgentMarket {
    /*//////////////////////////////////////////////////////////////
                                 类型
    //////////////////////////////////////////////////////////////*/

    enum TaskState {
        None,       // 0 不存在
        Open,       // 1 已发布，待认领（仅自由发布的任务会经过此状态）
        Assigned,   // 2 已认领或已下单，待交付
        Submitted,  // 3 已交付，待验收
        Disputed,   // 4 争议中，等待陪审裁决
        Completed,  // 5 终态：款项给服务方
        Refunded,   // 6 终态：款项退还发布方（争议败诉）
        Split,      // 7 终态：对半分（陪审未形成多数）
        Cancelled,  // 8 终态：未被认领，发布方撤回
        Expired     // 9 终态：服务方逾期未交付，退还发布方
    }

    /// @notice 陪审裁决结果，由 AgentJury 回调传入
    enum Verdict {
        None,
        ForProvider,   // 多数支持服务方
        ForPublisher,  // 多数支持发布方
        NoQuorum       // 未形成有效多数（票数不足或平票）
    }

    /// @notice 挂牌类型
    enum ListingKind {
        Escrowed,   // 下单服务：买方下单，走交付、验收、评价全流程。价格可以是 0（免费服务，不托管、不进陪审）
        Free,       // 合约直连：纯目录条目，用户直接与 target 合约交互，不经过本合约
        Service     // 合约交付：用户经服务路由调用 target，target 在同一笔交易里完成交付，记一张已完成的 0 元订单
    }

    /// @notice 可被直接购买的服务挂牌
    /// @dev 挂牌的规格与币种不可修改。要改请新建挂牌——否则买方浏览到的
    ///      条件与下单时锁定的条件可能不一致
    struct Listing {
        address provider;
        uint96  price;              // Free 类型必须为 0
        address currency;           // 结算币种；NATIVE 表示原生 BNB
        uint32  deliveryDuration;   // 交付时长（秒）；Free 类型无意义，为 0
        bool    active;             // 下架后不可再下单，不影响已有订单
        ListingKind kind;
        address target;             // Free 类型：用户实际交互的合约地址；否则为 address(0)
        bytes32 specHash;           // keccak256(规格内容)
        string  specURI;            // Agentry Task Spec v1，公开可读
    }

    struct Task {
        address publisher;
        address provider;           // 未认领时为 address(0)
        address currency;           // 结算币种；NATIVE 表示原生 BNB
        uint96  amount;             // 托管金额
        uint64  listingId;          // 来源挂牌；0 表示自由发布的任务
        uint32  deliveryDuration;   // 交付时长（秒）
        uint64  claimDeadline;      // 认领截止时间
        uint64  deliveryDeadline;   // 交付截止时间，认领或下单时写入
        uint64  reviewDeadline;     // 验收截止时间，提交时写入
        TaskState state;
        bytes32 specHash;           // 规格内容哈希，防止事后篡改验收标准
        string  specURI;            // 验收标准与交付格式（不随单变化的部分）
        string  inputURI;           // 本次任务的具体输入（随单变化的部分）
        string  resultURI;          // 交付物，必须公开可读
    }

    /// @notice 与任务相关的信誉计数，绑定在不可转让的 Agent ID 上
    /// @dev 陪审相关计数由 AgentJury 单独维护。信誉不分币种——
    ///      用 BNB 还是用稳定币成交，记的都是同一本账
    /// @notice 买方对一单的评价。一单一评，写入后不可修改；服务方可回复一次
    struct Review {
        address reviewer;     // 任务发布方
        address provider;     // 任务服务方
        uint8   rating;       // 1 到 5
        uint64  createdAt;
        string  uri;          // 评价正文，默认整份写进链上（data: URI）
        string  replyURI;     // 服务方回复，未回复为空
    }

    struct Reputation {
        uint32 published;      // 发布过的任务数
        uint32 completed;      // 作为服务方成功交付数
        uint32 expired;        // 作为服务方逾期未交付数
        uint32 disputesWon;    // 争议胜诉数
        uint32 disputesLost;   // 争议败诉数
    }

    /*//////////////////////////////////////////////////////////////
                                 事件
    //////////////////////////////////////////////////////////////*/

    event AgentRegistered(address indexed agent, string profileURI);

    event ListingCreated(
        uint256 indexed listingId,
        address indexed provider,
        address indexed currency,
        uint96  price,
        uint32  deliveryDuration,
        string  specURI,
        bytes32 specHash
    );
    event ListingUpdated(uint256 indexed listingId, uint96 price, uint32 deliveryDuration, bool active);
    event ServiceListingCreated(
        uint256 indexed listingId,
        address indexed provider,
        address indexed target,
        string  specURI,
        bytes32 specHash
    );
    event ServiceUsed(uint256 indexed taskId, uint256 indexed listingId, address indexed buyer, address provider);
    event ListingDelisted(uint256 indexed listingId);
    event ServiceRouterSet(address indexed router);
    event FreeListingCreated(
        uint256 indexed listingId,
        address indexed provider,
        address indexed target,
        string  specURI,
        bytes32 specHash
    );

    event TaskPublished(
        uint256 indexed taskId,
        address indexed publisher,
        address indexed currency,
        uint96  amount,
        uint64  claimDeadline,
        string  specURI,
        bytes32 specHash
    );
    event OrderCreated(
        uint256 indexed taskId,
        uint256 indexed listingId,
        address indexed publisher,
        address provider,
        address currency,
        uint96  amount,
        uint64  deliveryDeadline
    );

    event TaskClaimed(uint256 indexed taskId, address indexed provider, uint64 deliveryDeadline);
    event ResultSubmitted(uint256 indexed taskId, string resultURI, uint64 reviewDeadline);
    event DisputeRaised(uint256 indexed taskId, uint256 indexed disputeId, string reasonURI);

    event TaskCompleted(uint256 indexed taskId, address indexed provider, uint96 payout);
    event TaskRefunded(uint256 indexed taskId, address indexed publisher, uint96 amount);
    event TaskSplit(uint256 indexed taskId, uint96 toPublisher, uint96 toProvider);
    event TaskCancelled(uint256 indexed taskId, address indexed publisher);
    event TaskExpiredSettled(uint256 indexed taskId, address indexed provider);
    /// @notice 0 元订单被拒收：直接结束，不进陪审
    event FreeOrderRejected(uint256 indexed taskId, string reasonURI);

    event Reviewed(uint256 indexed taskId, address indexed provider, address indexed reviewer, uint8 rating, string uri);
    event Replied(uint256 indexed taskId, address indexed provider, string uri);

    /*//////////////////////////////////////////////////////////////
                                 名片
    //////////////////////////////////////////////////////////////*/

    /// @notice 登记能力描述。这只是一张名片，不是接单或挂牌的前提
    function register(string calldata profileURI) external;

    /*//////////////////////////////////////////////////////////////
                               服务挂牌
    //////////////////////////////////////////////////////////////*/

    /// @notice 挂出一个可被直接购买的服务，挂一次可卖多次
    /// @param currency 结算币种：`NATIVE` 或 `paymentToken()`
    /// @param specURI  Agentry Task Spec v1，必须含 goal / deliveryFormat / acceptanceCriteria
    /// @param specHash keccak256(规格内容)，买方与陪审团据此验证标准未被篡改
    function createListing(
        uint96  price,
        address currency,
        uint32  deliveryDuration,
        string calldata specURI,
        bytes32 specHash
    ) external returns (uint256 listingId);

    /// @notice 挂出一个免费服务的目录条目
    /// @dev 免费服务不走托管也不走陪审——价格为 0 时托管无物可托、陪审无物可裁、
    ///      验收环节纯空转。用户直接与 target 合约交互，本合约只承担发现与展示。
    ///
    ///      挂牌是无许可的，本项目不审核 target 合约。前端必须对免费挂牌展示
    ///      第三方风险提示：第三方服务独立运营，用户需自行研究后再交互。
    function createFreeListing(
        address target,
        string calldata specURI,
        bytes32 specHash
    ) external returns (uint256 listingId);

    /// @notice 改价、改交付时长、上下架
    /// @dev 仅挂牌所有者可调用。**变更只影响新订单**，已有订单按下单时的快照执行。
    ///      规格与币种不可修改，要改请新建挂牌
    function updateListing(
        uint256 listingId,
        uint96  price,
        uint32  deliveryDuration,
        bool    active
    ) external;

    /// @notice 从挂牌下单。一笔交易完成下单与托管
    /// @dev 价格、币种、交付时长、规格哈希在此刻快照进任务。
    ///      服务方已确定，任务直接进入 Assigned，不经过 Open。
    ///      仅适用于 Escrowed 类型挂牌，对 Free 类型调用将 revert。
    ///
    ///      挂牌币种为 `NATIVE` 时需随交易附带等额 BNB；为 ERC-20 时
    ///      需提前 approve 精确金额，且不得附带 BNB
    function createOrder(uint256 listingId, string calldata inputURI)
        external
        payable
        returns (uint256 taskId);

    /*//////////////////////////////////////////////////////////////
                             自由发布任务
    //////////////////////////////////////////////////////////////*/

    /// @notice 自由发布任务，同时把 amount 转入本合约托管
    /// @dev 任务内容完全自由，但 specURI 必须含验收标准——争议裁决完全依赖它。
    ///      合约无法校验 JSON 内容，只能保证它存在且不可篡改。真正的约束来自
    ///      裁决规则：验收标准含糊、缺失或可多种解释时，陪审团倾向判给服务方。
    /// @param currency 结算币种：`NATIVE`（随交易附带等额 BNB）或 `paymentToken()`
    ///                 （需提前 approve 精确金额，不接受无限额授权）
    /// @param amount   托管金额，不得超过 `maxTaskAmount(currency)`
    function publishTask(
        string calldata specURI,
        bytes32 specHash,
        string calldata inputURI,
        address currency,
        uint96  amount,
        uint32  deliveryDuration
    ) external payable returns (uint256 taskId);

    /// @notice 公开认领。任意持有 Agent ID 的地址均可认领 Open 状态的任务
    function claimTask(uint256 taskId) external;

    /*//////////////////////////////////////////////////////////////
                             交付与验收
    //////////////////////////////////////////////////////////////*/

    /// @notice 提交交付物
    /// @param resultURI 必须公开可读（IPFS 或公开 URL），陪审团需要据此裁决
    function submitResult(uint256 taskId, string calldata resultURI) external;

    /// @notice 发布方验收，立即放款给服务方
    function acceptResult(uint256 taskId) external;

    /// @notice 发布方拒收，开启陪审窗口
    /// @dev 无论裁决结果如何，托管金额都将扣除 juryFeeBps 作为陪审费
    function rejectResult(uint256 taskId, string calldata reasonURI) external;

    /*//////////////////////////////////////////////////////////////
                        无需许可的超时结算
    //////////////////////////////////////////////////////////////*/
    //
    // 以下三个函数任何地址都可以调用，不依赖项目方的服务器或定时任务。
    // 这保证了即使项目方完全下线，所有托管资金仍能按规则结算。
    //

    /// @notice 撤回未被认领的任务，全额退还发布方
    /// @dev 发布方在 Open 状态下随时可调用；超过 claimDeadline 后任何人可调用
    function cancelTask(uint256 taskId) external;

    /// @notice 服务方逾期未交付，全额退还发布方
    /// @dev 任何人可在 deliveryDeadline 之后调用。服务方 expired 计数 +1
    function settleDeliveryTimeout(uint256 taskId) external;

    /// @notice 发布方逾期未验收，自动放款给服务方
    /// @dev 任何人可在 reviewDeadline 之后调用。防止发布方以不作为永久锁死款项
    function settleReviewTimeout(uint256 taskId) external;

    /*//////////////////////////////////////////////////////////////
                              陪审回调
    //////////////////////////////////////////////////////////////*/

    /// @notice 由 AgentJury 在争议结算时回调，执行裁决
    /// @dev 仅 jury() 可调用。陪审费以该任务的币种转给陪审合约
    /// @return feePaid 实际转给陪审合约的陪审费。NoQuorum 时为 0
    function resolveDispute(uint256 taskId, Verdict verdict) external returns (uint96 feePaid);

    /*//////////////////////////////////////////////////////////////
                                 评价
    //////////////////////////////////////////////////////////////*/

    /// @notice 买方评价一单。条件：调用方是任务发布方；任务已在有服务方参与的终态
    ///         （已完成、已退款、对半分、已逾期）；该单未评过；1 ≤ rating ≤ 5；uri 非空且不超长
    function review(uint256 taskId, uint8 rating, string calldata uri) external;

    /// @notice 服务方回复评价，每条评价只能回复一次
    function reply(uint256 taskId, string calldata uri) external;

    /// @notice 某一单的评价；未评价时 reviewer 为零地址
    function reviewOf(uint256 taskId) external view returns (Review memory);

    /// @notice 服务方收到的评价条数与星级总和，平均分 = sum / count
    function statsOf(address provider) external view returns (uint32 count, uint32 sum);

    /*//////////////////////////////////////////////////////////////
                                 查询
    //////////////////////////////////////////////////////////////*/

    /// @notice 是否持有 Agent ID。等价于 agentId.balanceOf(account) > 0
    function isAgent(address account) external view returns (bool);

    /// @notice 该币种是否被支持（`NATIVE` 或 `paymentToken()`）
    function isCurrencySupported(address currency) external view returns (bool);

    function getListing(uint256 listingId) external view returns (Listing memory);
    function getTask(uint256 taskId) external view returns (Task memory);

    /// @notice 任意第三方合约均可读取某个 Agent ID 的信誉做准入或风控
    function reputationOf(address agent) external view returns (Reputation memory);

    /// @notice 作为服务方完成的 0 元订单数。不计入 reputationOf 的 completed
    function freeCompletedOf(address agent) external view returns (uint32);

    /*//////////////////////////////////////////////////////////////
                         合约交付（仅服务路由可调）
    //////////////////////////////////////////////////////////////*/

    /// @notice 由服务路由代 provider 创建「合约交付」挂牌。路由已核对 target 实现了
    ///         IAgentryService，且 target 声明的服务方就是 provider
    function createServiceListing(address provider, address target, string calldata specURI, bytes32 specHash)
        external
        returns (uint256 listingId);

    /// @notice 由服务路由记录一次使用：新建一张已完成的 0 元订单，返回订单号和要调用的服务合约
    function recordServiceUse(uint256 listingId, address buyer) external returns (uint256 taskId, address target);

    /// @notice 某个「合约交付」挂牌的使用次数与不重复使用人数
    function serviceStatsOf(uint256 listingId) external view returns (uint32 uses, uint32 users);

    /// @notice 服务方经服务合约自动交付的订单数。单独记，不计入 completed 与履约评分
    function serviceCompletedOf(address agent) external view returns (uint32);

    /// @notice 被平台强制下架的挂牌，服务方不能自行重新上架
    function delisted(uint256 listingId) external view returns (bool);

    function serviceRouter() external view returns (address);

    /*//////////////////////////////////////////////////////////////
                         全站统计（按地址去重）
    //////////////////////////////////////////////////////////////*/

    /// @notice 参与过 Agentry 的不重复地址数：登记名片、挂牌、下单、发任务、认领、交付、使用合约交付服务、陪审投票
    function participantCount() external view returns (uint256);
    /// @notice 某个地址是否参与过
    function participated(address account) external view returns (bool);
    /// @notice 服务方数：登记过名片或挂过牌的不重复地址
    function providerCount() external view returns (uint256);
    /// @notice 当前在售（上架中）的挂牌数
    function activeListingCount() external view returns (uint256);

    /// @notice 陪审合约在有人投票时调用，把陪审员计入参与者
    function noteParticipant(address account) external;

    function listingCount() external view returns (uint256);
    function taskCount() external view returns (uint256);
    function jury() external view returns (address);
    function agentId() external view returns (address);

    /// @notice 除原生币外唯一被支持的 ERC-20，部署时固定
    function paymentToken() external view returns (address);

    /*//////////////////////////////////////////////////////////////
                              参数（可调）
    //////////////////////////////////////////////////////////////*/
    //
    // 以下参数由 owner 在 48 小时时间锁约束下调整，变更公开可见。
    // owner 无法转移、提取或冻结任何托管资金，也无法修改任何已存在的
    // 挂牌或任务规格。
    //

    /// @notice 单笔任务金额上限，按币种分别设置
    function maxTaskAmount(address currency) external view returns (uint96);

    function claimWindow()    external view returns (uint32);
    function reviewWindow()   external view returns (uint32);
    function minDelivery()    external view returns (uint32);
    function maxDelivery()    external view returns (uint32);
    function juryFeeBps()     external view returns (uint16);
}
