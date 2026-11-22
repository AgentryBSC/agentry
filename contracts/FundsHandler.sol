// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title FundsHandler - 原生币与 ERC-20 的统一收付层
/// @notice `AgentMarket` 与 `AgentJury` 共用。币种以地址表示，`address(0)` 代表原生 BNB
/// @dev 原生币有一个 ERC-20 没有的风险：**收款方如果是不接收 BNB 的合约，
///      转账会 revert，整笔结算随之卡死，资金永久锁定**。
///
///      所以 `_push` 对原生币不采用「失败就 revert」的策略，而是把金额记入
///      待领取余额，让结算继续走完。收款方之后随时可以领走。
abstract contract FundsHandler is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice 原生币（BNB）的币种标识
    address public constant NATIVE = address(0);

    /// @notice 转账失败而滞留的款项：收款方 => 币种 => 金额
    mapping(address => mapping(address => uint256)) public pendingOf;

    event PaymentDeferred(address indexed to, address indexed currency, uint256 amount);
    event PendingClaimed(address indexed to, address indexed currency, uint256 amount);

    error WrongMsgValue();
    error NothingPending();
    error NativeTransferFailed();

    /// @dev 收款。原生币校验 `msg.value`，ERC-20 走 `transferFrom` 且不接受附带的 BNB
    function _pull(address currency, address from, uint256 amount) internal {
        if (amount == 0) {
            if (msg.value != 0) revert WrongMsgValue();
            return;
        }
        if (currency == NATIVE) {
            if (msg.value != amount) revert WrongMsgValue();
        } else {
            if (msg.value != 0) revert WrongMsgValue();
            IERC20(currency).safeTransferFrom(from, address(this), amount);
        }
    }

    /// @dev 付款。原生币转账失败时记入待领取余额而不是 revert
    function _push(address currency, address to, uint256 amount) internal {
        if (amount == 0) return;

        if (currency == NATIVE) {
            // 用汇编调用且不拷贝返回数据：收款合约返回超大数据也不能把整笔结算的 gas 耗光
            bool ok;
            assembly {
                ok := call(gas(), to, amount, 0, 0, 0, 0)
            }
            if (!ok) {
                pendingOf[to][NATIVE] += amount;
                emit PaymentDeferred(to, NATIVE, amount);
            }
        } else {
            IERC20(currency).safeTransfer(to, amount);
        }
    }

    /// @notice 领取此前转账失败而滞留的款项
    /// @dev 任何地址都可以代领，款项始终发给 `to` 本人。
    ///      这不是管理员提款入口——它只能把早已属于 `to` 的钱发给 `to`
    function claimPending(address to, address currency) external nonReentrant {
        uint256 amount = pendingOf[to][currency];
        if (amount == 0) revert NothingPending();

        pendingOf[to][currency] = 0;

        if (currency == NATIVE) {
            (bool ok, ) = to.call{value: amount}("");
            if (!ok) revert NativeTransferFailed();
        } else {
            IERC20(currency).safeTransfer(to, amount);
        }

        emit PendingClaimed(to, currency, amount);
    }
}
