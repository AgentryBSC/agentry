// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

import {FundsHandler} from "./FundsHandler.sol";
import {IAgentMarket} from "./interfaces/IAgentMarket.sol";
import {IAgentJury} from "./interfaces/IAgentJury.sol";

/// @title AgentMarket - Agentry 任务市场
/// @notice 名片、服务挂牌、下单、自由发布、托管、交付、验收、超时结算与信誉计数
/// @dev 支持原生 BNB 与一种在部署时固定的 ERC-20。两种币共用同一套合约、
///      同一个陪审池、同一本信誉账。
///
///      权限边界见 docs/mechanics.md「权限披露」。要点：
///      owner 可在 48 小时时间锁下调整参数、暂停新任务进入、一次性设置陪审合约地址。
///      owner **无法**转移、提取或冻结任何托管资金，无法干预裁决，
///      也无法阻止已有任务的超时结算与提现。
///
///      可升级（UUPS 代理）。升级权不在 owner 手里，而在 upgrader：部署时设为一个
///      48 小时延迟的 TimelockController。任何升级都要先在链上排队公示 48 小时才能执行，
///      用户有时间看到新代码并撤出。
///
///      存储布局：升级只能在末尾追加新变量，不能删改、重排已有变量。
/// @custom:oz-upgrades-unsafe-allow constructor
contract AgentMarket is IAgentMarket, FundsHandler, Initializable, OwnableUpgradeable, PausableUpgradeable, UUPSUpgradeable {
    /*//////////////////////////////////////////////////////////////
                                 常量
    //////////////////////////////////////////////////////////////*/

    /// @notice 参数变更的时间锁延迟
    uint64 public constant PARAM_DELAY = 48 hours;

    /// @notice 陪审费率硬上限，owner 也无法突破
    uint16 public constant MAX_JURY_FEE_BPS = 1_000; // 10%

    uint16 private constant BPS_DENOMINATOR = 10_000;

    /// @notice 评价正文与回复的长度上限（字节）。正文默认写成 data: URI，约 200 个汉字
    uint256 public constant MAX_REVIEW_URI = 1024;

    /// @notice 0 元服务的最短交付时长。付费服务仍以 minDelivery 为下限
    uint32 public constant MIN_FREE_DELIVERY = 1 hours;

    /*//////////////////////////////////////////////////////////////
                                 不变量
    //////////////////////////////////////////////////////////////*/

    /// @notice Agent ID 合约（ERC-721，不可转让，一个 KYC 一枚）
    /// @dev 写在实现合约的字节码里。换实现时必须传入同一个地址
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    address public immutable agentId;

    /// @notice 除原生币外唯一被支持的 ERC-20，部署时固定
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    address public immutable paymentToken;

    /*//////////////////////////////////////////////////////////////
                                 存储
    //////////////////////////////////////////////////////////////*/

    /// @notice 陪审合约地址，仅能设置一次
    address public jury;

    uint256 public listingCount;
    uint256 public taskCount;

    mapping(uint256 => Listing) private _listings;
    mapping(uint256 => Task) private _tasks;
    mapping(address => Reputation) private _reputation;

    /// @dev 评价：taskId → 评价；服务方 → 条数与星级总和
    mapping(uint256 => Review) private _reviews;
    struct ReviewStats { uint32 count; uint32 sum; }
    mapping(address => ReviewStats) private _reviewStats;

    /// @notice 服务方名片
    mapping(address => string) public profileOf;

    // ---- 可调参数 ----
    /// @notice 单笔任务金额上限，按币种分别设置
    mapping(address => uint96) public maxTaskAmount;

    uint32 public claimWindow;
    uint32 public reviewWindow;
    uint32 public minDelivery;
    uint32 public maxDelivery;
    uint16 public juryFeeBps;

    struct PendingParams {
        uint96 maxNative;
        uint96 maxToken;
        uint32 claimWindow;
        uint32 reviewWindow;
        uint32 minDelivery;
        uint32 maxDelivery;
        uint16 juryFeeBps;
        uint64 eta; // 0 表示无待生效变更
    }

    PendingParams public pendingParams;

    /// @notice 唯一有权升级合约的地址（48 小时 TimelockController）
    address public upgrader;

    /// @dev 0 元订单的完成数单独记，不混进 completed，防止靠免费单刷信誉
    mapping(address => uint32) private _freeCompleted;

    // ---- 合约交付（v4）----
    /// @notice 服务路由合约：唯一能创建「合约交付」挂牌、记录使用的地址
    address public serviceRouter;
    /// @inheritdoc IAgentMarket
    mapping(uint256 => bool) public delisted;
    /// @notice 合约交付订单总数（已计入 taskCount）。页面用 taskCount - serviceTaskCount 得到普通订单数
    uint256 public serviceTaskCount;
    /// @notice 用过任一「合约交付」服务的不重复地址数
    uint256 public serviceUserCount;
    struct ServiceStats { uint32 uses; uint32 users; }
    mapping(uint256 => ServiceStats) private _serviceStats;
    mapping(uint256 => mapping(address => bool)) private _usedListing;
    mapping(address => bool) private _usedAnyService;
    mapping(address => uint32) private _serviceCompleted;

    // ---- 全站统计（v4.1）：页面只读这几个数，不用遍历订单 ----
    /// @inheritdoc IAgentMarket
    mapping(address => bool) public participated;
    /// @inheritdoc IAgentMarket
    uint256 public participantCount;
    mapping(address => bool) private _isProvider;
    /// @inheritdoc IAgentMarket
    uint256 public providerCount;
    /// @inheritdoc IAgentMarket
    uint256 public activeListingCount;

    /*//////////////////////////////////////////////////////////////
                                 事件
    //////////////////////////////////////////////////////////////*/

    event JurySet(address indexed jury);
    event UpgraderSet(address indexed upgrader);
    event ParamsProposed(PendingParams params);
    event ParamsApplied(PendingParams params);

    /*//////////////////////////////////////////////////////////////
                                 错误
    //////////////////////////////////////////////////////////////*/

    error NotAgent();
    error JuryAlreadySet();
    error JuryNotSet();
    error OnlyJury();
    error ZeroAddress();
    error AmountZero();
    error AmountTooLarge();
    error UnsupportedCurrency();
    error BadDeliveryDuration();
    error SpecHashRequired();
    error EmptyURI();
    error ListingNotFound();
    error ListingInactive();
    error WrongListingKind();
    error NotListingOwner();
    error SelfDealing();
    error TaskNotFound();
    error BadState();
    error NotPublisher();
    error NotProvider();
    error DeadlinePassed();
    error DeadlineNotReached();
    error CancelNotAllowed();
    error FeeTooHigh();
    error BadWindow();
    error NoPendingParams();
    error TimelockNotElapsed();
    error BadRating();
    error UriTooLong();
    error NotReviewable();
    error AlreadyReviewed();
    error NoReview();
    error AlreadyReplied();
    error NotUpgrader();
    error OnlyServiceRouter();
    error ListingIsDelisted();

    /*//////////////////////////////////////////////////////////////
                               修饰器
    //////////////////////////////////////////////////////////////*/

    /// @dev 唯一的准入门：持有 Agent ID。一个 KYC 一枚且不可转让，
    ///      所以"一地址一票/一身份"严格等价于"一人"
    modifier onlyAgent() {
        if (IERC721(agentId).balanceOf(msg.sender) == 0) revert NotAgent();
        _;
    }

    modifier onlyJury() {
        if (msg.sender != jury) revert OnlyJury();
        _;
    }

    /*//////////////////////////////////////////////////////////////
                               构造
    //////////////////////////////////////////////////////////////*/

    /// @dev 实现合约的构造函数只写两个不可变地址，并锁死实现合约本身的初始化
    constructor(address agentId_, address paymentToken_) {
        if (agentId_ == address(0) || paymentToken_ == address(0)) revert ZeroAddress();
        agentId = agentId_;
        paymentToken = paymentToken_;
        _disableInitializers();
    }

    /// @notice 代理部署时调用一次
    function initialize(
        address owner_,
        address upgrader_,
        uint96 maxNative_,
        uint96 maxToken_,
        uint32 claimWindow_,
        uint32 reviewWindow_,
        uint32 minDelivery_,
        uint32 maxDelivery_,
        uint16 juryFeeBps_
    ) external initializer {
        if (upgrader_ == address(0)) revert ZeroAddress();
        if (juryFeeBps_ > MAX_JURY_FEE_BPS) revert FeeTooHigh();
        if (minDelivery_ == 0 || minDelivery_ > maxDelivery_) revert BadWindow();
        if (claimWindow_ == 0 || reviewWindow_ == 0) revert BadWindow();
        if (maxNative_ == 0 || maxToken_ == 0) revert AmountZero();

        __Ownable_init(owner_);
        __Pausable_init();
        upgrader = upgrader_;
        emit UpgraderSet(upgrader_);

        maxTaskAmount[NATIVE] = maxNative_;
        maxTaskAmount[paymentToken] = maxToken_;

        claimWindow = claimWindow_;
        reviewWindow = reviewWindow_;
        minDelivery = minDelivery_;
        maxDelivery = maxDelivery_;
        juryFeeBps = juryFeeBps_;
    }

    /*//////////////////////////////////////////////////////////////
                                 名片
    //////////////////////////////////////////////////////////////*/

    /// @dev 第一次参与才计数：同一个地址做多少事都只算一次
    function _join(address who) private {
        if (!participated[who]) {
            participated[who] = true;
            participantCount += 1;
        }
    }

    function _joinProvider(address who) private {
        _join(who);
        if (!_isProvider[who]) {
            _isProvider[who] = true;
            providerCount += 1;
        }
    }

    /// @inheritdoc IAgentMarket
    function noteParticipant(address account) external onlyJury {
        _join(account);
    }

    /// @inheritdoc IAgentMarket
    function register(string calldata profileURI) external onlyAgent {
        if (bytes(profileURI).length == 0) revert EmptyURI();
        _joinProvider(msg.sender);
        profileOf[msg.sender] = profileURI;
        emit AgentRegistered(msg.sender, profileURI);
    }

    /*//////////////////////////////////////////////////////////////
                               服务挂牌
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAgentMarket
    function createListing(
        uint96 price,
        address currency,
        uint32 deliveryDuration,
        string calldata specURI,
        bytes32 specHash
    ) external onlyAgent whenNotPaused returns (uint256 listingId) {
        if (!isCurrencySupported(currency)) revert UnsupportedCurrency();
        _checkTerms(price, currency, deliveryDuration);
        if (bytes(specURI).length == 0) revert EmptyURI();
        if (specHash == bytes32(0)) revert SpecHashRequired();

        listingId = ++listingCount;
        _listings[listingId] = Listing({
            provider: msg.sender,
            price: price,
            currency: currency,
            deliveryDuration: deliveryDuration,
            active: true,
            kind: ListingKind.Escrowed,
            target: address(0),
            specHash: specHash,
            specURI: specURI
        });

        _joinProvider(msg.sender);
        activeListingCount += 1;
        emit ListingCreated(listingId, msg.sender, currency, price, deliveryDuration, specURI, specHash);
    }

    /// @inheritdoc IAgentMarket
    function createFreeListing(
        address target,
        string calldata specURI,
        bytes32 specHash
    ) external onlyAgent whenNotPaused returns (uint256 listingId) {
        if (target == address(0)) revert ZeroAddress();
        if (bytes(specURI).length == 0) revert EmptyURI();
        if (specHash == bytes32(0)) revert SpecHashRequired();

        listingId = ++listingCount;
        _listings[listingId] = Listing({
            provider: msg.sender,
            price: 0,
            currency: NATIVE,
            deliveryDuration: 0,
            active: true,
            kind: ListingKind.Free,
            target: target,
            specHash: specHash,
            specURI: specURI
        });

        _joinProvider(msg.sender);
        activeListingCount += 1;
        emit FreeListingCreated(listingId, msg.sender, target, specURI, specHash);
    }

    /*//////////////////////////////////////////////////////////////
                         合约交付（仅服务路由可调）
    //////////////////////////////////////////////////////////////*/

    modifier onlyServiceRouter() {
        if (msg.sender != serviceRouter || msg.sender == address(0)) revert OnlyServiceRouter();
        _;
    }

    /// @inheritdoc IAgentMarket
    function createServiceListing(address provider, address target, string calldata specURI, bytes32 specHash)
        external
        onlyServiceRouter
        whenNotPaused
        returns (uint256 listingId)
    {
        if (IERC721(agentId).balanceOf(provider) == 0) revert NotAgent();
        if (target == address(0)) revert ZeroAddress();
        if (bytes(specURI).length == 0) revert EmptyURI();
        if (specHash == bytes32(0)) revert SpecHashRequired();

        listingId = ++listingCount;
        _listings[listingId] = Listing({
            provider: provider,
            price: 0,
            currency: NATIVE,
            deliveryDuration: 0,
            active: true,
            kind: ListingKind.Service,
            target: target,
            specHash: specHash,
            specURI: specURI
        });
        _joinProvider(provider);
        activeListingCount += 1;
        emit ServiceListingCreated(listingId, provider, target, specURI, specHash);
    }

    /// @inheritdoc IAgentMarket
    /// @dev 只写一张极简的已完成订单：不复制规格正文（规格在挂牌里，按 listingId 取），
    ///      否则每次使用都要把几 KB 的规格再写一遍存储
    function recordServiceUse(uint256 listingId, address buyer)
        external
        onlyServiceRouter
        whenNotPaused
        nonReentrant
        returns (uint256 taskId, address target)
    {
        Listing storage l = _listings[listingId];
        if (l.provider == address(0)) revert ListingNotFound();
        if (l.kind != ListingKind.Service) revert WrongListingKind();
        if (!l.active) revert ListingInactive();
        if (IERC721(agentId).balanceOf(buyer) == 0) revert NotAgent();
        address provider = l.provider;
        if (provider == buyer) revert SelfDealing();

        taskId = ++taskCount;
        serviceTaskCount += 1;
        Task storage t = _tasks[taskId];
        t.publisher = buyer;
        t.provider = provider;
        t.listingId = uint64(listingId);
        t.state = TaskState.Completed;
        t.specHash = l.specHash;

        ServiceStats storage st = _serviceStats[listingId];
        st.uses += 1;
        if (!_usedListing[listingId][buyer]) {
            _usedListing[listingId][buyer] = true;
            st.users += 1;
        }
        if (!_usedAnyService[buyer]) {
            _usedAnyService[buyer] = true;
            serviceUserCount += 1;
        }
        _serviceCompleted[provider] += 1;
        _join(buyer);

        emit ServiceUsed(taskId, listingId, buyer, provider);
        emit TaskCompleted(taskId, provider, 0);
        return (taskId, l.target);
    }

    /// @inheritdoc IAgentMarket
    function serviceStatsOf(uint256 listingId) external view returns (uint32 uses, uint32 users) {
        ServiceStats memory st = _serviceStats[listingId];
        return (st.uses, st.users);
    }

    /// @inheritdoc IAgentMarket
    function serviceCompletedOf(address agent) external view returns (uint32) {
        return _serviceCompleted[agent];
    }

    /// @notice 设置服务路由。路由有 bug 时可以换掉，换掉后旧路由立即失效
    function setServiceRouter(address router) external onlyOwner {
        serviceRouter = router;
        emit ServiceRouterSet(router);
    }

    /// @notice 平台强制下架：用于诈骗、侵权等滥用。只影响新订单与新使用，已有订单照常结算。
    ///         下架后服务方不能自行重新上架
    function delist(uint256 listingId) external onlyOwner {
        Listing storage l = _listings[listingId];
        if (l.provider == address(0)) revert ListingNotFound();
        if (l.active) activeListingCount -= 1;
        l.active = false;
        delisted[listingId] = true;
        emit ListingDelisted(listingId);
        emit ListingUpdated(listingId, l.price, l.deliveryDuration, false);
    }

    /// @inheritdoc IAgentMarket
    /// @dev 规格与币种不可修改，这里只能改价、改交付时长、上下架。变更只影响新订单
    function updateListing(
        uint256 listingId,
        uint96 price,
        uint32 deliveryDuration,
        bool active
    ) external {
        Listing storage l = _listings[listingId];
        if (l.provider == address(0)) revert ListingNotFound();
        if (l.provider != msg.sender) revert NotListingOwner();
        if (active && delisted[listingId]) revert ListingIsDelisted();

        if (l.kind == ListingKind.Escrowed) {
            _checkTerms(price, l.currency, deliveryDuration);
            l.price = price;
            l.deliveryDuration = deliveryDuration;
        }
        // 免费挂牌没有价格与交付时长可改，只能上下架

        if (l.active != active) {
            if (active) activeListingCount += 1;
            else activeListingCount -= 1;
        }
        l.active = active;
        emit ListingUpdated(listingId, l.price, l.deliveryDuration, active);
    }

    /// @dev 价格可以是 0（免费服务，照常走下单、交付、验收、评价，只是不托管资金）。
    ///      0 元服务的交付时长下限放宽到 MIN_FREE_DELIVERY
    function _checkTerms(uint96 price, address currency, uint32 deliveryDuration) private view {
        if (price > maxTaskAmount[currency]) revert AmountTooLarge();
        uint32 lo = price == 0 ? MIN_FREE_DELIVERY : minDelivery;
        if (deliveryDuration < lo || deliveryDuration > maxDelivery) revert BadDeliveryDuration();
    }

    /*//////////////////////////////////////////////////////////////
                                 下单
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAgentMarket
    function createOrder(uint256 listingId, string calldata inputURI)
        external
        payable
        onlyAgent
        whenNotPaused
        nonReentrant
        returns (uint256 taskId)
    {
        Listing storage l = _listings[listingId];
        if (l.provider == address(0)) revert ListingNotFound();
        if (l.kind != ListingKind.Escrowed) revert WrongListingKind();
        if (!l.active) revert ListingInactive();
        if (l.provider == msg.sender) revert SelfDealing();
        if (bytes(inputURI).length == 0) revert EmptyURI();

        uint96 amount = l.price;
        address currency = l.currency;
        if (amount > maxTaskAmount[currency]) revert AmountTooLarge();

        taskId = ++taskCount;
        uint64 deliveryDeadline = uint64(block.timestamp) + l.deliveryDuration;

        // 价格、币种、交付时长、规格在此刻快照进任务，之后挂牌怎么改都与本单无关
        Task storage t = _tasks[taskId];
        t.publisher = msg.sender;
        t.provider = l.provider;
        t.currency = currency;
        t.amount = amount;
        t.listingId = uint64(listingId);
        t.deliveryDuration = l.deliveryDuration;
        t.deliveryDeadline = deliveryDeadline;
        t.state = TaskState.Assigned;
        t.specHash = l.specHash;
        t.specURI = l.specURI;
        t.inputURI = inputURI;

        _reputation[msg.sender].published += 1;
        _join(msg.sender);

        _pull(currency, msg.sender, amount);

        emit OrderCreated(taskId, listingId, msg.sender, l.provider, currency, amount, deliveryDeadline);
    }

    /*//////////////////////////////////////////////////////////////
                             自由发布任务
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAgentMarket
    function publishTask(
        string calldata specURI,
        bytes32 specHash,
        string calldata inputURI,
        address currency,
        uint96 amount,
        uint32 deliveryDuration
    ) external payable onlyAgent whenNotPaused nonReentrant returns (uint256 taskId) {
        if (!isCurrencySupported(currency)) revert UnsupportedCurrency();
        if (amount == 0) revert AmountZero();
        if (amount > maxTaskAmount[currency]) revert AmountTooLarge();
        if (deliveryDuration < minDelivery || deliveryDuration > maxDelivery) {
            revert BadDeliveryDuration();
        }
        if (bytes(specURI).length == 0) revert EmptyURI();
        if (specHash == bytes32(0)) revert SpecHashRequired();

        taskId = ++taskCount;

        Task storage t = _tasks[taskId];
        t.publisher = msg.sender;
        t.currency = currency;
        t.amount = amount;
        t.deliveryDuration = deliveryDuration;
        t.claimDeadline = uint64(block.timestamp) + claimWindow;
        t.state = TaskState.Open;
        t.specHash = specHash;
        t.specURI = specURI;
        t.inputURI = inputURI;

        _reputation[msg.sender].published += 1;
        _join(msg.sender);

        _pull(currency, msg.sender, amount);

        emit TaskPublished(
            taskId, msg.sender, currency, amount, t.claimDeadline, specURI, specHash
        );
    }

    /// @inheritdoc IAgentMarket
    function claimTask(uint256 taskId) external onlyAgent {
        Task storage t = _tasks[taskId];
        if (t.state != TaskState.Open) revert BadState();
        if (block.timestamp > t.claimDeadline) revert DeadlinePassed();
        if (t.publisher == msg.sender) revert SelfDealing();

        _join(msg.sender);
        _assign(taskId, t, msg.sender);
    }

    // 没有「发布方指派」：服务方必须自己认领（或自己挂牌被下单），
    // 否则发布方可以把任务硬塞给任何人、等它超时，白白给对方记一笔逾期
    function _assign(uint256 taskId, Task storage t, address provider) private {
        uint64 deliveryDeadline = uint64(block.timestamp) + t.deliveryDuration;
        t.provider = provider;
        t.deliveryDeadline = deliveryDeadline;
        t.state = TaskState.Assigned;
        emit TaskClaimed(taskId, provider, deliveryDeadline);
    }

    /*//////////////////////////////////////////////////////////////
                             交付与验收
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAgentMarket
    function submitResult(uint256 taskId, string calldata resultURI) external {
        Task storage t = _tasks[taskId];
        if (t.state != TaskState.Assigned) revert BadState();
        if (t.provider != msg.sender) revert NotProvider();
        if (block.timestamp > t.deliveryDeadline) revert DeadlinePassed();
        if (bytes(resultURI).length == 0) revert EmptyURI();

        uint64 reviewDeadline = uint64(block.timestamp) + reviewWindow;
        t.resultURI = resultURI;
        t.reviewDeadline = reviewDeadline;
        t.state = TaskState.Submitted;

        emit ResultSubmitted(taskId, resultURI, reviewDeadline);
    }

    /// @inheritdoc IAgentMarket
    function acceptResult(uint256 taskId) external nonReentrant {
        Task storage t = _tasks[taskId];
        if (t.state != TaskState.Submitted) revert BadState();
        if (t.publisher != msg.sender) revert NotPublisher();
        _complete(taskId, t);
    }

    /// @inheritdoc IAgentMarket
    function rejectResult(uint256 taskId, string calldata reasonURI) external {
        Task storage t = _tasks[taskId];
        if (t.state != TaskState.Submitted) revert BadState();
        if (t.publisher != msg.sender) revert NotPublisher();
        if (block.timestamp > t.reviewDeadline) revert DeadlinePassed();

        // 0 元订单没有钱可裁，拒收直接结束，不进陪审、不计任何一方的争议记录
        if (t.amount == 0) {
            t.state = TaskState.Refunded;
            emit FreeOrderRejected(taskId, reasonURI);
            return;
        }
        if (jury == address(0)) revert JuryNotSet();

        t.state = TaskState.Disputed;

        uint256 disputeId = IAgentJury(jury).openDispute(
            taskId, t.publisher, t.provider, t.currency, t.amount
        );

        emit DisputeRaised(taskId, disputeId, reasonURI);
    }

    /*//////////////////////////////////////////////////////////////
                        无需许可的超时结算
    //////////////////////////////////////////////////////////////*/
    //
    // 以下三个函数任何地址都可以调用，不依赖项目方的服务器或定时任务。
    // 即使项目方完全下线，所有托管资金仍能按规则结算。
    // 它们也不受 pause 影响 —— 暂停只能阻止新任务进入，不能阻止资金流出。
    //

    /// @inheritdoc IAgentMarket
    function cancelTask(uint256 taskId) external nonReentrant {
        Task storage t = _tasks[taskId];
        if (t.state != TaskState.Open) revert BadState();
        // 发布方随时可撤；认领期过后任何人都可触发退款，防发布方失联导致资金长期滞留
        if (msg.sender != t.publisher && block.timestamp <= t.claimDeadline) {
            revert CancelNotAllowed();
        }

        t.state = TaskState.Cancelled;
        address publisher = t.publisher;
        uint96 amount = t.amount;

        _push(t.currency, publisher, amount);
        emit TaskCancelled(taskId, publisher);
    }

    /// @inheritdoc IAgentMarket
    function settleDeliveryTimeout(uint256 taskId) external nonReentrant {
        Task storage t = _tasks[taskId];
        if (t.state != TaskState.Assigned) revert BadState();
        if (block.timestamp <= t.deliveryDeadline) revert DeadlineNotReached();

        t.state = TaskState.Expired;
        address provider = t.provider;
        address publisher = t.publisher;
        uint96 amount = t.amount;

        // 0 元订单的逾期不计：否则任何人都能对免费挂牌批量下单、刷对方的逾期记录
        if (amount != 0) _reputation[provider].expired += 1;

        _push(t.currency, publisher, amount);
        emit TaskExpiredSettled(taskId, provider);
        emit TaskRefunded(taskId, publisher, amount);
    }

    /// @inheritdoc IAgentMarket
    function settleReviewTimeout(uint256 taskId) external nonReentrant {
        Task storage t = _tasks[taskId];
        if (t.state != TaskState.Submitted) revert BadState();
        if (block.timestamp <= t.reviewDeadline) revert DeadlineNotReached();
        _complete(taskId, t);
    }

    function _complete(uint256 taskId, Task storage t) private {
        t.state = TaskState.Completed;
        address provider = t.provider;
        uint96 amount = t.amount;

        if (amount == 0) _freeCompleted[provider] += 1;
        else _reputation[provider].completed += 1;

        _push(t.currency, provider, amount);
        emit TaskCompleted(taskId, provider, amount);
    }

    /*//////////////////////////////////////////////////////////////
                              陪审回调
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAgentMarket
    function resolveDispute(uint256 taskId, Verdict verdict)
        external
        onlyJury
        nonReentrant
        returns (uint96 feePaid)
    {
        Task storage t = _tasks[taskId];
        if (t.state != TaskState.Disputed) revert BadState();

        address publisher = t.publisher;
        address provider = t.provider;
        address currency = t.currency;
        uint96 amount = t.amount;

        if (verdict == Verdict.NoQuorum) {
            // 票数不足或平票：对半分。默认判给任一方都会让该方有动力
            // "赌没人来投票"，对半分让双方都蒙受损失，因此双方都有动力
            // 把陪审团叫来
            t.state = TaskState.Split;
            uint96 toPublisher = amount / 2;
            uint96 toProvider = amount - toPublisher;

            _push(currency, publisher, toPublisher);
            _push(currency, provider, toProvider);
            emit TaskSplit(taskId, toPublisher, toProvider);
            return 0;
        }

        feePaid = uint96((uint256(amount) * juryFeeBps) / BPS_DENOMINATOR);
        uint96 payout = amount - feePaid;

        address winner;
        if (verdict == Verdict.ForProvider) {
            t.state = TaskState.Completed;
            _reputation[provider].disputesWon += 1;
            _reputation[publisher].disputesLost += 1;
            winner = provider;
            emit TaskCompleted(taskId, provider, payout);
        } else {
            t.state = TaskState.Refunded;
            _reputation[publisher].disputesWon += 1;
            _reputation[provider].disputesLost += 1;
            winner = publisher;
            emit TaskRefunded(taskId, publisher, payout);
        }

        // 先付给受信任的陪审合约，再付给可能是任意合约的胜方
        if (feePaid > 0) {
            _push(currency, jury, feePaid);
        }
        _push(currency, winner, payout);
    }

    /*//////////////////////////////////////////////////////////////
                                 评价
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAgentMarket
    /// @dev 不受 owner 控制、不受暂停影响：评价是对已结束交易的记录，不应被平台拦下
    function review(uint256 taskId, uint8 rating, string calldata uri) external onlyAgent {
        Task storage t = _tasks[taskId];
        if (t.publisher == address(0)) revert TaskNotFound();
        if (msg.sender != t.publisher) revert NotPublisher();
        TaskState s = t.state;
        // 只有服务方参与过、且已经结束的单能评。撤回的单没有服务方，进行中的单还没有结果
        if (s != TaskState.Completed && s != TaskState.Refunded && s != TaskState.Split && s != TaskState.Expired) {
            revert NotReviewable();
        }
        if (rating == 0 || rating > 5) revert BadRating();
        if (bytes(uri).length == 0) revert EmptyURI();
        if (bytes(uri).length > MAX_REVIEW_URI) revert UriTooLong();
        Review storage r = _reviews[taskId];
        if (r.reviewer != address(0)) revert AlreadyReviewed();

        address provider = t.provider;
        r.reviewer = msg.sender;
        r.provider = provider;
        r.rating = rating;
        r.createdAt = uint64(block.timestamp);
        r.uri = uri;

        ReviewStats storage st = _reviewStats[provider];
        st.count += 1;
        st.sum += rating;
        emit Reviewed(taskId, provider, msg.sender, rating, uri);
    }

    /// @inheritdoc IAgentMarket
    function reply(uint256 taskId, string calldata uri) external onlyAgent {
        Review storage r = _reviews[taskId];
        if (r.reviewer == address(0)) revert NoReview();
        if (msg.sender != r.provider) revert NotProvider();
        if (bytes(r.replyURI).length != 0) revert AlreadyReplied();
        if (bytes(uri).length == 0) revert EmptyURI();
        if (bytes(uri).length > MAX_REVIEW_URI) revert UriTooLong();
        r.replyURI = uri;
        emit Replied(taskId, msg.sender, uri);
    }

    /// @inheritdoc IAgentMarket
    function reviewOf(uint256 taskId) external view returns (Review memory) {
        return _reviews[taskId];
    }

    /// @inheritdoc IAgentMarket
    function statsOf(address provider) external view returns (uint32 count, uint32 sum) {
        ReviewStats memory st = _reviewStats[provider];
        return (st.count, st.sum);
    }

    /*//////////////////////////////////////////////////////////////
                                 查询
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAgentMarket
    function isAgent(address account) external view returns (bool) {
        return IERC721(agentId).balanceOf(account) > 0;
    }

    /// @inheritdoc IAgentMarket
    function isCurrencySupported(address currency) public view returns (bool) {
        return currency == NATIVE || currency == paymentToken;
    }

    /// @inheritdoc IAgentMarket
    function getListing(uint256 listingId) external view returns (Listing memory) {
        Listing memory l = _listings[listingId];
        if (l.provider == address(0)) revert ListingNotFound();
        return l;
    }

    /// @inheritdoc IAgentMarket
    function getTask(uint256 taskId) external view returns (Task memory) {
        Task memory t = _tasks[taskId];
        if (t.publisher == address(0)) revert TaskNotFound();
        return t;
    }

    /// @inheritdoc IAgentMarket
    function reputationOf(address agent) external view returns (Reputation memory) {
        return _reputation[agent];
    }

    /// @inheritdoc IAgentMarket
    function freeCompletedOf(address agent) external view returns (uint32) {
        return _freeCompleted[agent];
    }

    /*//////////////////////////////////////////////////////////////
                             owner 操作
    //////////////////////////////////////////////////////////////*/

    /// @notice 设置陪审合约地址，**仅能设置一次**
    /// @dev AgentMarket 与 AgentJury 互相持有对方地址，两者不可能同时部署，
    ///      因此需要这个 setter。实现为一次性写入：若可反复更改，owner 就能
    ///      换上一个假陪审合约来操纵裁决，这是必须堵死的攻击面
    function setJury(address jury_) external onlyOwner {
        if (jury != address(0)) revert JuryAlreadySet();
        if (jury_ == address(0)) revert ZeroAddress();
        jury = jury_;
        emit JurySet(jury_);
    }

    /// @notice 提议参数变更，48 小时后才可生效
    function proposeParams(
        uint96 maxNative_,
        uint96 maxToken_,
        uint32 claimWindow_,
        uint32 reviewWindow_,
        uint32 minDelivery_,
        uint32 maxDelivery_,
        uint16 juryFeeBps_
    ) external onlyOwner {
        if (juryFeeBps_ > MAX_JURY_FEE_BPS) revert FeeTooHigh();
        if (minDelivery_ == 0 || minDelivery_ > maxDelivery_) revert BadWindow();
        if (claimWindow_ == 0 || reviewWindow_ == 0) revert BadWindow();
        if (maxNative_ == 0 || maxToken_ == 0) revert AmountZero();

        pendingParams = PendingParams({
            maxNative: maxNative_,
            maxToken: maxToken_,
            claimWindow: claimWindow_,
            reviewWindow: reviewWindow_,
            minDelivery: minDelivery_,
            maxDelivery: maxDelivery_,
            juryFeeBps: juryFeeBps_,
            eta: uint64(block.timestamp) + PARAM_DELAY
        });

        emit ParamsProposed(pendingParams);
    }

    /// @notice 时间锁到期后应用参数变更
    function applyParams() external onlyOwner {
        PendingParams memory p = pendingParams;
        if (p.eta == 0) revert NoPendingParams();
        if (block.timestamp < p.eta) revert TimelockNotElapsed();

        maxTaskAmount[NATIVE] = p.maxNative;
        maxTaskAmount[paymentToken] = p.maxToken;
        claimWindow = p.claimWindow;
        reviewWindow = p.reviewWindow;
        minDelivery = p.minDelivery;
        maxDelivery = p.maxDelivery;
        juryFeeBps = p.juryFeeBps;

        delete pendingParams;
        emit ParamsApplied(p);
    }

    /// @notice 暂停**新任务与新挂牌进入**
    /// @dev 核心安全属性：pause 不影响已有任务的任何结算路径。
    ///      认领、提交、验收、拒收、超时结算、裁决执行全部不受影响
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /*//////////////////////////////////////////////////////////////
                                 升级
    //////////////////////////////////////////////////////////////*/

    /// @dev 只有 upgrader（48 小时时间锁）能换实现。owner 不能
    function _authorizeUpgrade(address) internal view override {
        if (msg.sender != upgrader) revert NotUpgrader();
    }

    /// @notice 转交升级权，比如换成多签。同样只能由 upgrader 自己发起，也就同样要过时间锁
    function setUpgrader(address upgrader_) external {
        if (msg.sender != upgrader) revert NotUpgrader();
        if (upgrader_ == address(0)) revert ZeroAddress();
        upgrader = upgrader_;
        emit UpgraderSet(upgrader_);
    }
}
