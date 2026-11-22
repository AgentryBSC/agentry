// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockTaxToken - 测试用：每笔转账扣 3% 的代币，模拟转账收税
contract MockTaxToken is ERC20 {
    constructor() ERC20("Tax", "TAX") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 tax = (value * 3) / 100;
            super._update(from, address(0xdead), tax);
            value -= tax;
        }
        super._update(from, to, value);
    }
}
