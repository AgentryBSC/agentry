// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {VaultBaseV2, VaultBaseV3} from "./flap/VaultBase.sol";
import {
    VaultUISchema,
    VaultMethodSchema,
    FieldDescriptor,
    ApproveAction
} from "./flap/IVaultSchemasV1.sol";

/// @title AgentryServiceVault - FLAP 税收金库，为 Agentry 上的免费服务提供资金
/// @notice 接收 bonding curve 代币的 BNB 税收收入，由 operator 提取用于为服务补货。
///         代币、金库、服务三者解耦：本合约只管收 BNB 和放 BNB，不持有代币、
///         不做 swap、不碰领取逻辑。
///
/// @dev 符合 FLAP Vault Specification（VaultBaseV3 / vault spec "v3"）。
///      单实例、终身不可升级设计，不走 factory，也不走 Beacon Proxy——
///      规范允许这种形态，代价是拿不到低风险认证徽章，在 FLAP 网站上
///      显示为 unverified。
///
///      **为什么不在这里 swap**：规范的 ping law 3 明确要求 receive() 保持轻量
///      （协议 keeper 用固定 gas 预算跑整个 dispatch，重的 receive() 会让
///      dispatch 失败），并要求把 swap、staking、buyback 这类重活放到
///      显式的公开函数里，由自己的自动化驱动。此外 bonding curve 代币
///      在迁移前后的买入路径不同，链上实现要同时处理两条路径。
///      因此 BNB→代币的转换留在链下执行。
///
///      ⚠️ **权限披露**：本合约的 OPERATOR_ROLE 可以提走金库内全部 BNB。
///      按 FLAP 规范的 Guardian 强制条款，FLAP Guardian 地址也持有
///      OPERATOR_ROLE，且该授权**不可被任何其他账户撤销**，只有 Guardian
///      自己可以放弃。详见 docs/flap-notes.md。
contract AgentryServiceVault is VaultBaseV3, AccessControl, ReentrancyGuard {
    /*//////////////////////////////////////////////////////////////
                                 角色
    //////////////////////////////////////////////////////////////*/

    /// @notice 可提取金库 BNB 的角色
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    /*//////////////////////////////////////////////////////////////
                                 存储
    //////////////////////////////////////////////////////////////*/

    /// @notice 已确认且尚未支出的收入（balance-delta 记账的基线）
    /// @dev 规范中最危险的一条：**任何流出都必须在同一笔交易内递减它**。
    ///      漏掉的话基线会永久高于真实余额，`bal <= accountedQuote` 从此恒真，
    ///      金库将静默停止确认新收入——不报错、不 revert，直接死掉。
    uint256 public accountedQuote;

    /// @notice 累计确认过的收入
    uint256 public totalReceived;

    /// @notice 累计提取给服务的金额
    uint256 public totalWithdrawn;

    /// @notice 本金库服务的税收代币，发射后一次性写入，仅用于展示与索引
    /// @dev 金库必须先于代币存在（要作为 funds recipient 填进发射参数），
    ///      所以这个地址只能事后补写
    address public taxToken;

    /*//////////////////////////////////////////////////////////////
                                 事件
    //////////////////////////////////////////////////////////////*/

    event RevenueRecognized(uint256 amount, uint256 accounted);
    event Withdrawn(address indexed to, uint256 amount, address indexed by);
    event TaxTokenSet(address indexed taxToken);

    /*//////////////////////////////////////////////////////////////
                                 错误
    //////////////////////////////////////////////////////////////*/

    error ZeroAddress();
    error AmountZero();
    error InsufficientAccounted();
    error TaxTokenAlreadySet();
    error CannotRevokeGuardianRole();
    error TransferFailed();

    /*//////////////////////////////////////////////////////////////
                                 构造
    //////////////////////////////////////////////////////////////*/

    /// @param admin 金库管理员，同时获得 OPERATOR_ROLE
    constructor(address admin) {
        if (admin == address(0)) revert ZeroAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(OPERATOR_ROLE, admin);

        // Guardian 强制条款：本合约有受限函数（withdraw），因此必须把同等
        // 权限授予 FLAP Guardian 作为后备。该授权不可被他人撤销，见 revokeRole
        _grantRole(OPERATOR_ROLE, _getGuardian());
    }

    /*//////////////////////////////////////////////////////////////
                              收入确认
    //////////////////////////////////////////////////////////////*/

    /// @notice 接收税收收入
    /// @dev 必须保持轻量（ping law 3）：只更新记账、发事件、返回。
    ///      注意 ping 可能携带 0 值、也可能被重复触发，零增量唤醒必须静默无操作
    receive() external payable {
        _syncRevenue();
    }

    /// @notice 无需许可的收入确认入口
    /// @dev 规范推荐暴露这个包装：它是 keeper 与 UI 的中性确认入口，
    ///      也是收入未伴随 wake call 到账时（直接转账、协议侧停用 ping）的恢复路径
    function sync() external {
        _syncRevenue();
    }

    /// @dev balance-delta 记账：只把余额相对基线的**增量**认作新收入。
    ///      直接转入的资金（捐赠、误转）不会触发 ping，会在下一次唤醒时
    ///      被确认，且与税收收入无法区分——按规范一律视为捐赠
    function _syncRevenue() internal {
        uint256 bal = address(this).balance;
        if (bal <= accountedQuote) return; // 规则 2：零增量静默无操作

        uint256 newRevenue = bal - accountedQuote;
        accountedQuote = bal; // 规则 1：推进基线
        totalReceived += newRevenue;

        emit RevenueRecognized(newRevenue, bal);
    }

    /*//////////////////////////////////////////////////////////////
                                 提取
    //////////////////////////////////////////////////////////////*/

    /// @notice 提取 BNB 用于为服务补货
    /// @dev 流程严格遵守规范：先 sync 确认（规则 5），再递减基线（规则 3），
    ///      最后才做外部调用
    function withdraw(address to, uint256 amount)
        external
        onlyRole(OPERATOR_ROLE)
        nonReentrant
    {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert AmountZero();

        _syncRevenue(); // 规则 5：先确认后动作，结果不依赖 ping 是否先到

        if (amount > accountedQuote) revert InsufficientAccounted();

        accountedQuote -= amount; // 规则 3：同一笔交易内递减，漏掉则金库死锁
        totalWithdrawn += amount;

        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit Withdrawn(to, amount, msg.sender);
    }

    /// @notice 提取全部可用余额
    function withdrawAll(address to) external onlyRole(OPERATOR_ROLE) nonReentrant {
        if (to == address(0)) revert ZeroAddress();

        _syncRevenue();

        uint256 amount = accountedQuote;
        if (amount == 0) revert AmountZero();

        accountedQuote = 0;
        totalWithdrawn += amount;

        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit Withdrawn(to, amount, msg.sender);
    }

    /*//////////////////////////////////////////////////////////////
                               管理
    //////////////////////////////////////////////////////////////*/

    /// @notice 补写本金库服务的税收代币地址，仅能设置一次
    function setTaxToken(address taxToken_) external onlyRole(OPERATOR_ROLE) {
        if (taxToken != address(0)) revert TaxTokenAlreadySet();
        if (taxToken_ == address(0)) revert ZeroAddress();
        taxToken = taxToken_;
        emit TaxTokenSet(taxToken_);
    }

    /// @notice Guardian 强制条款：Guardian 的授权不可被任何其他账户撤销
    /// @dev 只有 Guardian 自己可以通过 renounceRole 放弃自己的权限——
    ///      OZ 的 renounceRole 要求 callerConfirmation == msg.sender，
    ///      因此无需额外处理
    function revokeRole(bytes32 role, address account)
        public
        override
        onlyRole(getRoleAdmin(role))
    {
        if (account == _getGuardian()) revert CannotRevokeGuardianRole();
        super.revokeRole(role, account);
    }

    /*//////////////////////////////////////////////////////////////
                             FLAP 规范实现
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc VaultBaseV3
    /// @dev 本金库收的是原生 BNB
    function vaultQuoteToken() public pure override returns (address) {
        return address(0);
    }

    /// @notice 供 FLAP 网站与终端展示的动态描述
    function description() public view override returns (string memory) {
        return string.concat(
            "Agentry Service Vault: funds the Agentry platform. ",
            "Available ",
            _formatBnb(accountedQuote),
            " BNB | lifetime revenue ",
            _formatBnb(totalReceived),
            " BNB | withdrawn ",
            _formatBnb(totalWithdrawn),
            " BNB."
        );
    }

    /// @notice 金库状态，供 UI 展示
    function stats()
        external
        view
        returns (
            uint256 available,
            uint256 lifetimeRevenue,
            uint256 deployedToServices,
            uint256 rawBalance
        )
    {
        return (accountedQuote, totalReceived, totalWithdrawn, address(this).balance);
    }

    /// @inheritdoc VaultBaseV2
    function vaultUISchema() public pure override returns (VaultUISchema memory schema) {
        schema.vaultType = "AgentryServiceVault";
        schema.description =
            "Funds the Agentry platform, supporting Agentry's services, operations and growth.";

        schema.methods = new VaultMethodSchema[](3);

        // ---- 0. stats（只读）----
        VaultMethodSchema memory statsMethod;
        statsMethod.name = "stats";
        statsMethod.description = "Vault balance and lifetime flows.";
        statsMethod.inputs = new FieldDescriptor[](0);
        statsMethod.outputs = new FieldDescriptor[](4);
        statsMethod.outputs[0] =
            FieldDescriptor("available", "uint256", "Recognized, not yet deployed", 18);
        statsMethod.outputs[1] =
            FieldDescriptor("lifetimeRevenue", "uint256", "Total revenue recognized", 18);
        statsMethod.outputs[2] =
            FieldDescriptor("deployedToServices", "uint256", "Total withdrawn to services", 18);
        statsMethod.outputs[3] =
            FieldDescriptor("rawBalance", "uint256", "Current contract balance", 18);
        statsMethod.approvals = new ApproveAction[](0);
        statsMethod.isWriteMethod = false;
        schema.methods[0] = statsMethod;

        // ---- 1. sync（任何人可调）----
        VaultMethodSchema memory syncMethod;
        syncMethod.name = "sync";
        syncMethod.description =
            "Recognize any revenue that arrived without a wake call. Callable by anyone.";
        syncMethod.inputs = new FieldDescriptor[](0);
        syncMethod.outputs = new FieldDescriptor[](0);
        syncMethod.approvals = new ApproveAction[](0);
        syncMethod.isWriteMethod = true;
        schema.methods[1] = syncMethod;

        // ---- 2. withdraw（仅 OPERATOR_ROLE）----
        VaultMethodSchema memory withdrawMethod;
        withdrawMethod.name = "withdraw";
        withdrawMethod.description =
            "Withdraw BNB to restock a service. Restricted to OPERATOR_ROLE "
            "(which the Flap Guardian also holds as a non-revocable backup).";
        withdrawMethod.inputs = new FieldDescriptor[](2);
        withdrawMethod.inputs[0] =
            FieldDescriptor("to", "address", "Recipient of the BNB", 0);
        withdrawMethod.inputs[1] =
            FieldDescriptor("amount", "uint256", "Amount of BNB to withdraw", 18);
        withdrawMethod.outputs = new FieldDescriptor[](0);
        withdrawMethod.approvals = new ApproveAction[](0);
        withdrawMethod.isWriteMethod = true;
        schema.methods[2] = withdrawMethod;
    }

    /*//////////////////////////////////////////////////////////////
                               内部工具
    //////////////////////////////////////////////////////////////*/

    /// @dev wei 转为保留 4 位小数的字符串，仅用于 description()
    function _formatBnb(uint256 weiAmount) private pure returns (string memory) {
        uint256 whole = weiAmount / 1e18;
        uint256 frac = (weiAmount % 1e18) / 1e14; // 4 位小数

        string memory fracStr = _toString(frac);
        if (frac < 10) {
            fracStr = string.concat("000", fracStr);
        } else if (frac < 100) {
            fracStr = string.concat("00", fracStr);
        } else if (frac < 1000) {
            fracStr = string.concat("0", fracStr);
        }

        return string.concat(_toString(whole), ".", fracStr);
    }

    /// @dev 自带的十进制转换。不用 OpenZeppelin 的 Strings 是因为它会牵进
    ///      Bytes.sol，而后者依赖 Cancun 的 mcopy 操作码，与本项目锁定的
    ///      evmVersion = paris 冲突
    function _toString(uint256 value) private pure returns (string memory) {
        if (value == 0) return "0";

        uint256 digits;
        uint256 temp = value;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }

        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits--;
            buffer[digits] = bytes1(uint8(48 + (value % 10)));
            value /= 10;
        }

        return string(buffer);
    }
}
