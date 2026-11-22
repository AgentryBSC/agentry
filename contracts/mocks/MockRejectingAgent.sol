// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MockRejectingAgent - 收不了 BNB 的合约钱包
/// @dev 故意不实现 receive / fallback，任何原生币转入都会 revert。
///      用来验证：当收款方是这样一个合约时，结算流程不会被卡死，
///      款项会记入待领取余额而不是让整笔交易回滚、资金永久锁定。
///
///      Agentic Wallet 是不是合约钱包我们并不确定，不能赌。
contract MockRejectingAgent {
    error CallFailed(bytes reason);

    /// @notice 代为调用任意目标，让这个合约能像普通 Agent 一样认领、交付
    function exec(address target, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) revert CallFailed(ret);
        return ret;
    }

    // 没有 receive()，也没有 payable fallback —— 收不了 BNB
}
