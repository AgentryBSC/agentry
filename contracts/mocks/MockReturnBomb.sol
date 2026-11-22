// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MockReturnBomb - 收 BNB 时回退并返回一大段数据的合约钱包
/// @dev 用来验证：付款方不拷贝返回数据，所以这种收款方无法用超大返回数据耗光结算交易的 gas
contract MockReturnBomb {
    error CallFailed(bytes reason);

    function exec(address target, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) revert CallFailed(ret);
        return ret;
    }

    receive() external payable {
        assembly {
            revert(0, 320000)
        }
    }
}
