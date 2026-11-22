// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

import {FundsHandler} from "./FundsHandler.sol";
import {IAgentJury} from "./interfaces/IAgentJury.sol";
import {IAgentMarket} from "./interfaces/IAgentMarket.sol";

/// @title AgentJury - 一 ID 一票的链上仲裁器
/// @notice 争议受理、开放投票、押金结算
/// @dev 抗女巫完全由 Agent ID 承担：一个 KYC 仅一枚、不可转让，
///      因此"一地址一票"严格等价于"一人一票"。这里不存在资金加权，
///      巨鲸的一票和任何人的一票等重。
///
///      与 OKX.AI 的根本差异：那边要求质押 ≥100 OKB 才能当陪审员，且按
///      质押量加权分配案件；被罚没后换个地址重新质押即可恢复。这里押金
///      只是防摸鱼的象征性金额，而惩罚落在一个换不掉的身份上。
///
///      押金与陪审费的币种跟随争议标的，但陪审池本身不分币种——
///      同一批陪审员裁决所有争议，信誉记在同一本账上。
///
///      可升级（UUPS 代理），升级权在 upgrader（48 小时 TimelockController），owner 无权升级。
///      存储布局：升级只能在末尾追加新变量。
/// @custom:oz-upgrades-unsafe-allow constructor
contract AgentJury is IAgentJury, FundsHandler, Initializable, OwnableUpgradeable, UUPSUpgradeable {
    /*//////////////////////////////////////////////////////////////
                                 常量
    //////////////////////////////////////////////////////////////*/

    uint64 public constant PARAM_DELAY = 48 hours;

    /*//////////////////////////////////////////////////////////////
                                 不变量
    //////////////////////////////////////////////////////////////*/

    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    address public immutable agentId;

    /// @notice 除原生币外唯一被支持的 ERC-20，与 market 保持一致
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    address public immutable paymentToken;

    /// @notice 唯一有权开庭的合约（market 代理地址）。写在实现合约字节码里
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    address public immutable market;

    /*//////////////////////////////////////////////////////////////
                                 存储
    //////////////////////////////////////////////////////////////*/

    uint256 public disputeCount;

    mapping(uint256 => Dispute) private _disputes;

    /// @notice taskId => disputeId，0 表示该任务没有争议
    mapping(uint256 => uint256) public disputeIdOf;

    mapping(uint256 => mapping(address => Side)) private _voteOf;

    /// @notice 该陪审员在该争议中的头寸是否已结算
    mapping(uint256 => mapping(address => bool)) public positionSettled;

    mapping(address => uint32) private _jurorMajority;
    mapping(address => uint32) private _jurorMinority;

    // ---- 可调参数 ----
    uint32 public votingWindow;
    uint32 public quorum;

    /// @notice 单票押金，按币种分别设置
    mapping(address => uint96) public jurorStake;

    struct PendingParams {
        uint32 votingWindow;
        uint32 quorum;
        uint96 stakeNative;
        uint96 stakeToken;
        uint64 eta;
    }

    PendingParams public pendingParams;

    /*//////////////////////////////////////////////////////////////
                                 事件
    //////////////////////////////////////////////////////////////*/

    event ParamsProposed(PendingParams params);
    event ParamsApplied(PendingParams params);

    /*//////////////////////////////////////////////////////////////
                                 错误
    //////////////////////////////////////////////////////////////*/

    error NotAgent();
    error OnlyMarket();
    error ZeroAddress();
    error BadSide();
    error DisputeNotFound();
    error DisputeExists();
    error AlreadySettled();
    error NotSettled();
    error VotingClosed();
    error VotingOpen();
    error PartyCannotVote();
    error AlreadyVoted();
    error DidNotVote();
    error PositionAlreadySettled();
    error BadParams();
    error NoPendingParams();
    error TimelockNotElapsed();

    /*//////////////////////////////////////////////////////////////
                               修饰器
    //////////////////////////////////////////////////////////////*/

    modifier onlyAgent() {
        if (IERC721(agentId).balanceOf(msg.sender) == 0) revert NotAgent();
        _;
    }

    /*//////////////////////////////////////////////////////////////
                               构造
    //////////////////////////////////////////////////////////////*/

    constructor(address agentId_, address paymentToken_, address market_) {
        if (agentId_ == address(0) || paymentToken_ == address(0) || market_ == address(0)) {
            revert ZeroAddress();
        }
        agentId = agentId_;
        paymentToken = paymentToken_;
        market = market_;
        _disableInitializers();
    }

    /// @notice 代理部署时调用一次
    function initialize(
        address owner_,
        address upgrader_,
        uint32 votingWindow_,
        uint32 quorum_,
        uint96 stakeNative_,
        uint96 stakeToken_
    ) external initializer {
        if (upgrader_ == address(0)) revert ZeroAddress();
        if (votingWindow_ == 0 || quorum_ == 0) revert BadParams();

        __Ownable_init(owner_);
        upgrader = upgrader_;
        emit UpgraderSet(upgrader_);

        votingWindow = votingWindow_;
        quorum = quorum_;
        jurorStake[NATIVE] = stakeNative_;
        jurorStake[paymentToken] = stakeToken_;
    }

    /// @notice 接收 market 转来的陪审费（原生币）
    /// @dev 只认 market，其他地址的转账一律拒绝——避免来历不明的 BNB
    ///      混进来干扰按争议记账
    receive() external payable {
        if (msg.sender != market) revert OnlyMarket();
    }

    /*//////////////////////////////////////////////////////////////
                                 开庭
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAgentJury
    function openDispute(
        uint256 taskId,
        address publisher,
        address provider,
        address currency,
        uint96 taskAmount
    ) external returns (uint256 disputeId) {
        if (msg.sender != market) revert OnlyMarket();
        if (disputeIdOf[taskId] != 0) revert DisputeExists();

        disputeId = ++disputeCount;
        uint64 deadline = uint64(block.timestamp) + votingWindow;
        // 押金在开庭时快照，避免投票期间 owner 调参导致先投与后投的人押金不一致
        uint96 stake = jurorStake[currency];

        Dispute storage d = _disputes[disputeId];
        d.taskId = taskId;
        d.publisher = publisher;
        d.provider = provider;
        d.currency = currency;
        d.taskAmount = taskAmount;
        d.stake = stake;
        d.votingDeadline = deadline;

        disputeIdOf[taskId] = disputeId;

        emit DisputeOpened(disputeId, taskId, currency, taskAmount, stake, deadline);
    }

    /*//////////////////////////////////////////////////////////////
                                 投票
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAgentJury
    function vote(uint256 disputeId, Side side) external payable onlyAgent nonReentrant {
        if (side == Side.None) revert BadSide();

        Dispute storage d = _disputes[disputeId];
        if (d.taskId == 0) revert DisputeNotFound();
        if (d.settled) revert AlreadySettled();
        if (block.timestamp > d.votingDeadline) revert VotingClosed();
        if (msg.sender == d.publisher || msg.sender == d.provider) revert PartyCannotVote();
        if (_voteOf[disputeId][msg.sender] != Side.None) revert AlreadyVoted();

        _voteOf[disputeId][msg.sender] = side;
        if (side == Side.Provider) {
            d.votesForProvider += 1;
        } else {
            d.votesForPublisher += 1;
        }

        _pull(d.currency, msg.sender, d.stake);
        // 陪审员计入全站参与者（市场合约按地址去重）
        IAgentMarket(market).noteParticipant(msg.sender);

        emit VoteCast(disputeId, msg.sender, side);
    }

    /*//////////////////////////////////////////////////////////////
                                 结算
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAgentJury
    function settle(uint256 disputeId) external nonReentrant {
        Dispute storage d = _disputes[disputeId];
        if (d.taskId == 0) revert DisputeNotFound();
        if (d.settled) revert AlreadySettled();
        if (block.timestamp <= d.votingDeadline) revert VotingOpen();

        uint32 forProvider = d.votesForProvider;
        uint32 forPublisher = d.votesForPublisher;
        uint32 total = forProvider + forPublisher;

        IAgentMarket.Verdict verdict;
        if (total < quorum || forProvider == forPublisher) {
            // 票数不足，或平票。多数决要求真的存在多数
            verdict = IAgentMarket.Verdict.NoQuorum;
        } else if (forProvider > forPublisher) {
            verdict = IAgentMarket.Verdict.ForProvider;
        } else {
            verdict = IAgentMarket.Verdict.ForPublisher;
        }

        // 先落状态再做外部调用
        d.settled = true;
        d.verdict = verdict;

        uint96 fee = IAgentMarket(market).resolveDispute(d.taskId, verdict);

        if (verdict != IAgentMarket.Verdict.NoQuorum) {
            uint32 majority =
                verdict == IAgentMarket.Verdict.ForProvider ? forProvider : forPublisher;
            uint32 minority = total - majority;
            // 奖励池 = 陪审费 + 少数方被没收的押金
            d.rewardPool = fee + uint96(uint256(minority) * d.stake);
        }

        emit DisputeSettled(disputeId, verdict, forProvider, forPublisher, d.rewardPool);
    }

    /// @inheritdoc IAgentJury
    function claimJurorPayout(uint256 disputeId, address juror) external nonReentrant {
        Dispute storage d = _disputes[disputeId];
        if (d.taskId == 0) revert DisputeNotFound();
        if (!d.settled) revert NotSettled();

        Side side = _voteOf[disputeId][juror];
        if (side == Side.None) revert DidNotVote();
        if (positionSettled[disputeId][juror]) revert PositionAlreadySettled();

        positionSettled[disputeId][juror] = true;

        uint256 amount = _payoutOf(d, side);

        if (d.verdict == IAgentMarket.Verdict.NoQuorum) {
            // 未形成多数，不计入胜负
        } else if (_isMajority(d, side)) {
            _jurorMajority[juror] += 1;
        } else {
            _jurorMinority[juror] += 1;
        }

        _push(d.currency, juror, amount);

        emit JurorPaid(disputeId, juror, amount);
    }

    /*//////////////////////////////////////////////////////////////
                               内部计算
    //////////////////////////////////////////////////////////////*/

    function _isMajority(Dispute storage d, Side side) private view returns (bool) {
        if (d.verdict == IAgentMarket.Verdict.ForProvider) return side == Side.Provider;
        if (d.verdict == IAgentMarket.Verdict.ForPublisher) return side == Side.Publisher;
        return false;
    }

    /// @dev 取整产生的零头留在本合约内，无人可提取 —— 这是故意的，
    ///      任何提取入口都会变成 owner 对资金的权限
    function _payoutOf(Dispute storage d, Side side) private view returns (uint256) {
        if (d.verdict == IAgentMarket.Verdict.NoQuorum) {
            return d.stake;
        }
        if (!_isMajority(d, side)) {
            return 0;
        }
        uint32 majority = d.verdict == IAgentMarket.Verdict.ForProvider
            ? d.votesForProvider
            : d.votesForPublisher;
        return uint256(d.stake) + (uint256(d.rewardPool) / majority);
    }

    /*//////////////////////////////////////////////////////////////
                                 查询
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IAgentJury
    function getDispute(uint256 disputeId) external view returns (Dispute memory) {
        Dispute memory d = _disputes[disputeId];
        if (d.taskId == 0) revert DisputeNotFound();
        return d;
    }

    /// @inheritdoc IAgentJury
    function voteOf(uint256 disputeId, address juror) external view returns (Side) {
        return _voteOf[disputeId][juror];
    }

    /// @inheritdoc IAgentJury
    function payoutOf(uint256 disputeId, address juror) external view returns (uint256) {
        Dispute storage d = _disputes[disputeId];
        if (!d.settled) return 0;
        if (positionSettled[disputeId][juror]) return 0;

        Side side = _voteOf[disputeId][juror];
        if (side == Side.None) return 0;

        return _payoutOf(d, side);
    }

    /// @inheritdoc IAgentJury
    function jurorRecordOf(address agent)
        external
        view
        returns (uint32 majority, uint32 minority)
    {
        return (_jurorMajority[agent], _jurorMinority[agent]);
    }

    /*//////////////////////////////////////////////////////////////
                             owner 操作
    //////////////////////////////////////////////////////////////*/

    /// @notice 提议参数变更，48 小时后才可生效
    function proposeParams(
        uint32 votingWindow_,
        uint32 quorum_,
        uint96 stakeNative_,
        uint96 stakeToken_
    ) external onlyOwner {
        if (votingWindow_ == 0 || quorum_ == 0) revert BadParams();

        pendingParams = PendingParams({
            votingWindow: votingWindow_,
            quorum: quorum_,
            stakeNative: stakeNative_,
            stakeToken: stakeToken_,
            eta: uint64(block.timestamp) + PARAM_DELAY
        });

        emit ParamsProposed(pendingParams);
    }

    /// @notice 时间锁到期后应用参数变更
    /// @dev 已开庭的争议使用开庭时快照的押金，不受此影响
    function applyParams() external onlyOwner {
        PendingParams memory p = pendingParams;
        if (p.eta == 0) revert NoPendingParams();
        if (block.timestamp < p.eta) revert TimelockNotElapsed();

        votingWindow = p.votingWindow;
        quorum = p.quorum;
        jurorStake[NATIVE] = p.stakeNative;
        jurorStake[paymentToken] = p.stakeToken;

        delete pendingParams;
        emit ParamsApplied(p);
    }

    /*//////////////////////////////////////////////////////////////
                                 升级
    //////////////////////////////////////////////////////////////*/

    /// @notice 唯一有权升级合约的地址（48 小时 TimelockController）
    address public upgrader;

    event UpgraderSet(address indexed upgrader);
    error NotUpgrader();

    function _authorizeUpgrade(address) internal view override {
        if (msg.sender != upgrader) revert NotUpgrader();
    }

    /// @notice 转交升级权。只能由 upgrader 自己发起
    function setUpgrader(address upgrader_) external {
        if (msg.sender != upgrader) revert NotUpgrader();
        if (upgrader_ == address(0)) revert ZeroAddress();
        upgrader = upgrader_;
        emit UpgraderSet(upgrader_);
    }
}
