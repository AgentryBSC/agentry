// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// 只为让 hardhat 编译出这两个合约的 artifact，供部署脚本和测试使用
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
