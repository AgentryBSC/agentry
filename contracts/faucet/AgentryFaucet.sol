// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {AgentryServiceBase} from "../service/AgentryServiceBase.sol";

/// @title AgentryFaucet - 持有 Agent ID 才能领的代币水龙头（Agentry 合约交付服务）
/// @notice 用户在 Agentry 上调用 AgentryServiceRouter.use(挂牌号, "")，路由在市场里记一张已完成的
///         0 元订单，再调用本合约 fulfill，代币直接发到用户自己的地址。不需要任何授权。
///         只能经路由领取，所以每次领取都有一张市场订单，用户可以评价，统计都在市场合约里。
///         Agent ID 一个地址一枚、不可转让，所以「每个地址」就是「每个 Agent ID」。
///
///         管理员（owner）可以随时设置：
///           · 发放哪个代币（可以先部署，代币发行后再设置）
///           · 每次领多少
///           · 每个 Agent ID 最多领几次、两次之间隔多久
///         领取记录按代币分开记：换成新代币后，大家可以重新领新代币。
///
///         不可升级。没有第三方权限。合约里的代币只能由 owner 取回到 owner 自己的地址。
contract AgentryFaucet is AgentryServiceBase, Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice 冷却时间上限，防止误填成几十年
    uint32 public constant MAX_COOLDOWN = 365 days;

    /// @notice 官方 Agent ID 合约（不可转让的 ERC-721）
    IERC721 public immutable agentId;

    /// @notice 当前发放的代币，0 表示还没设置
    IERC20 public token;
    /// @notice 每次领取的数量（按代币最小单位）
    uint256 public claimAmount;
    /// @notice 每个 Agent ID 对当前代币最多领几次，0 表示不限次数
    uint32 public maxClaims;
    /// @notice 两次领取之间至少隔多少秒
    uint32 public cooldown;

    struct Record {
        uint32 count;
        uint64 lastAt;
    }

    /// @dev 代币 → 领取人 → 记录
    mapping(address => mapping(address => Record)) private _records;
    /// @notice 代币 → 一共发出多少（按领取人实际到账计）
    mapping(address => uint256) public totalClaimed;
    /// @notice 代币 → 一共多少个不同的 Agent ID 领过
    mapping(address => uint256) public claimers;
    /// @notice 代币 → 一共领了多少次
    mapping(address => uint256) public claimCount;

    event Claimed(address indexed account, address indexed token, uint256 amount);
    event TokenSet(address indexed token);
    event ClaimAmountSet(uint256 amount);
    event ClaimRuleSet(uint32 maxClaims, uint32 cooldown);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);

    error ZeroAddress();
    error NotAContract();
    error TokenNotSet();
    error AmountNotSet();
    error NoAgentId();
    error LimitReached();
    error CoolingDown(uint64 nextAt);
    error InsufficientBalance();
    error BadRule();

    /// @param admin   管理员，显式传入（经 CREATE2 工厂部署时不能用 msg.sender）
    /// @param agentId_ 官方 Agent ID 合约
    /// @param router_  Agentry 服务路由
    constructor(address admin, address agentId_, address router_) Ownable(admin) AgentryServiceBase(router_) {
        if (agentId_ == address(0)) revert ZeroAddress();
        if (agentId_.code.length == 0) revert NotAContract();
        agentId = IERC721(agentId_);
        // 默认：每个 Agent ID 只领一次
        maxClaims = 1;
        emit ClaimRuleSet(1, 0);
    }

    /*//////////////////////////////////////////////////////////////
                                领取
    //////////////////////////////////////////////////////////////*/

    /// @dev 由服务路由调用（AgentryServiceBase 已核对调用方和挂牌号）。buyer 是实际发起交易的用户
    function _fulfill(address buyer, bytes calldata) internal override nonReentrant whenNotPaused returns (bytes32) {
        IERC20 t = token;
        (bool ok, uint8 code, uint64 nextAt) = _check(buyer);
        if (!ok) _revertWith(code, nextAt);

        Record storage r = _records[address(t)][buyer];
        if (r.count == 0) claimers[address(t)] += 1;
        r.count += 1;
        r.lastAt = uint64(block.timestamp);
        claimCount[address(t)] += 1;

        // 按领取人实际到账记账：FLAP 税收代币转账可能扣税
        uint256 before = t.balanceOf(buyer);
        t.safeTransfer(buyer, claimAmount);
        uint256 received = t.balanceOf(buyer) - before;
        totalClaimed[address(t)] += received;

        emit Claimed(buyer, address(t), received);
        return keccak256(abi.encode(address(t), received));
    }

    /// @dev 预检，与 _fulfill 的拒绝条件一致
    function _canServe(address buyer, bytes calldata) internal view override returns (bool ok, string memory reason) {
        uint8 code;
        (ok, code, ) = _check(buyer);
        if (ok && paused()) return (false, "paused");
        reason = _reason(code);
    }

    /// @notice 有权把本合约挂到 Agentry 市场的地址：合约的 owner
    function agentryProvider() external view returns (address) {
        return owner();
    }

    /// @notice 绑定 Agentry 挂牌号。先经路由创建挂牌，再用返回的挂牌号调用这里
    function setListing(uint256 listingId_) external onlyOwner {
        _bindListing(listingId_);
    }

    /*//////////////////////////////////////////////////////////////
                                查询
    //////////////////////////////////////////////////////////////*/

    /// @notice 某个地址现在能不能领。不能领时给出原因，nextAt 是冷却结束时间（只在冷却中有值）
    function canClaim(address account) external view returns (bool ok, string memory reason, uint64 nextAt) {
        uint8 code;
        (ok, code, nextAt) = _check(account);
        if (ok && paused()) return (false, "paused", 0);
        reason = _reason(code);
    }

    /// @notice 某个地址对当前代币领了几次、上次什么时候领
    function recordOf(address account) external view returns (uint32 count, uint64 lastAt) {
        Record memory r = _records[address(token)][account];
        return (r.count, r.lastAt);
    }

    /// @notice 水龙头里还剩多少当前代币
    function remaining() public view returns (uint256) {
        return address(token) == address(0) ? 0 : token.balanceOf(address(this));
    }

    /// @notice 一次读全部配置和统计，给网站和 Agent 用
    function info()
        external
        view
        returns (
            address token_,
            uint256 claimAmount_,
            uint32 maxClaims_,
            uint32 cooldown_,
            bool paused_,
            uint256 remaining_,
            uint256 totalClaimed_,
            uint256 claimers_,
            uint256 claimCount_
        )
    {
        address t = address(token);
        return (t, claimAmount, maxClaims, cooldown, paused(), remaining(), totalClaimed[t], claimers[t], claimCount[t]);
    }

    /*//////////////////////////////////////////////////////////////
                              管理员
    //////////////////////////////////////////////////////////////*/

    /// @notice 设置或更换发放的代币。旧代币的余额留在合约里，可用 withdraw 取回
    function setToken(address token_) external onlyOwner {
        if (token_ == address(0)) revert ZeroAddress();
        if (token_.code.length == 0) revert NotAContract();
        token = IERC20(token_);
        emit TokenSet(token_);
    }

    /// @notice 设置每次领取的数量（按代币最小单位，18 位小数的代币 1 枚 = 1e18）
    function setClaimAmount(uint256 amount) external onlyOwner {
        claimAmount = amount;
        emit ClaimAmountSet(amount);
    }

    /// @notice 设置领取次数和间隔
    /// @param maxClaims_ 每个 Agent ID 最多领几次，0 = 不限
    /// @param cooldown_  两次之间至少隔多少秒；能领多次时必须大于 0，否则一个人可以连续领光
    function setClaimRule(uint32 maxClaims_, uint32 cooldown_) external onlyOwner {
        if (cooldown_ > MAX_COOLDOWN) revert BadRule();
        if (maxClaims_ != 1 && cooldown_ == 0) revert BadRule();
        maxClaims = maxClaims_;
        cooldown = cooldown_;
        emit ClaimRuleSet(maxClaims_, cooldown_);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice 取回合约里的任意代币，只能发到 owner 自己的地址
    function withdraw(address token_, uint256 amount) external onlyOwner nonReentrant {
        if (token_ == address(0)) revert ZeroAddress();
        IERC20(token_).safeTransfer(owner(), amount);
        emit Withdrawn(token_, owner(), amount);
    }

    /// @dev 不允许放弃所有权：否则剩余代币会永久锁死
    function renounceOwnership() public pure override {
        revert BadRule();
    }

    /*//////////////////////////////////////////////////////////////
                              内部
    //////////////////////////////////////////////////////////////*/

    // 原因代码：0 可领 1 没设代币 2 没设数量 3 没有 Agent ID 4 次数用完 5 冷却中 6 余额不足
    function _check(address account) private view returns (bool, uint8, uint64) {
        IERC20 t = token;
        if (address(t) == address(0)) return (false, 1, 0);
        if (claimAmount == 0) return (false, 2, 0);
        if (agentId.balanceOf(account) == 0) return (false, 3, 0);
        Record memory r = _records[address(t)][account];
        if (maxClaims != 0 && r.count >= maxClaims) return (false, 4, 0);
        if (r.count != 0 && cooldown != 0) {
            uint64 nextAt = r.lastAt + cooldown;
            if (block.timestamp < nextAt) return (false, 5, nextAt);
        }
        if (t.balanceOf(address(this)) < claimAmount) return (false, 6, 0);
        return (true, 0, 0);
    }

    function _revertWith(uint8 code, uint64 nextAt) private pure {
        if (code == 1) revert TokenNotSet();
        if (code == 2) revert AmountNotSet();
        if (code == 3) revert NoAgentId();
        if (code == 4) revert LimitReached();
        if (code == 5) revert CoolingDown(nextAt);
        revert InsufficientBalance();
    }

    function _reason(uint8 code) private pure returns (string memory) {
        if (code == 0) return "";
        if (code == 1) return "token not set";
        if (code == 2) return "claim amount not set";
        if (code == 3) return "no Agent ID";
        if (code == 4) return "claim limit reached";
        if (code == 5) return "cooling down";
        return "faucet is empty";
    }
}
