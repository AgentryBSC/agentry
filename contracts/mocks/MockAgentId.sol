// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MockAgentId - 测试用的 Agent ID 替身
/// @dev 只实现 Agentry 真正用到的 `balanceOf` 和 `ownerOf`。
///      刻意手写而不继承 OpenZeppelin 的 ERC721：后者会引入 Strings → Bytes，
///      而 Bytes 依赖 Cancun 的 mcopy，与本项目锁定的 evmVersion = paris 冲突。
///
///      复刻真实 Agent ID 的两条关键性质：一个地址只能有一枚，且不可转让。
contract MockAgentId {
    mapping(address => uint256) private _balances;
    mapping(uint256 => address) private _owners;

    uint256 public totalMinted;

    error AlreadyHolds();
    error NonexistentToken();

    function mint(address to) external returns (uint256 tokenId) {
        if (_balances[to] != 0) revert AlreadyHolds();
        tokenId = ++totalMinted;
        _owners[tokenId] = to;
        _balances[to] = 1;
    }

    function balanceOf(address owner) external view returns (uint256) {
        return _balances[owner];
    }

    function ownerOf(uint256 tokenId) external view returns (address owner) {
        owner = _owners[tokenId];
        if (owner == address(0)) revert NonexistentToken();
    }
}
