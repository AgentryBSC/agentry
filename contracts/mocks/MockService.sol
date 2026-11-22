// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AgentryServiceBase} from "../service/AgentryServiceBase.sol";

interface IRouterLike {
    function use(uint256 listingId, bytes calldata input) external returns (uint256, bytes32);
}

interface IMarketLike {
    function createOrder(uint256 listingId, string calldata inputURI) external payable returns (uint256);
}

/// @title MockService - 测试用的服务合约，可以切换成各种恶意行为
contract MockService is AgentryServiceBase {
    enum Mode { Ok, Revert, ReturnBomb, ShortReturn, ReenterRouter, ReenterMarket, BurnGas }

    address public provider;
    Mode public mode;
    uint256 public served;
    address public lastBuyer;
    address public marketAddr;
    bytes public lastInput;

    constructor(address router_, address provider_) AgentryServiceBase(router_) {
        provider = provider_;
    }

    function setMode(Mode m) external { mode = m; }
    function setProvider(address p) external { provider = p; }
    function setMarket(address m) external { marketAddr = m; }
    function bind(uint256 id) external { _bindListing(id); }

    function agentryProvider() external view returns (address) { return provider; }

    function _fulfill(address buyer, bytes calldata input) internal override returns (bytes32) {
        Mode m = mode;
        if (m == Mode.Revert) revert("service says no");
        if (m == Mode.ReturnBomb) {
            assembly { revert(0, 200000) }
        }
        if (m == Mode.ShortReturn) {
            assembly { return(0, 0) }
        }
        if (m == Mode.ReenterRouter) {
            IRouterLike(router).use(listingId, "");
        }
        if (m == Mode.ReenterMarket) {
            // 试图在交付中途用市场合约下别的单：服务合约没有 Agent ID，应被拒绝并让整笔回滚
            IMarketLike(marketAddr).createOrder(1, "x");
        }
        if (m == Mode.BurnGas) {
            while (true) {}
        }
        served += 1;
        lastBuyer = buyer;
        lastInput = input;
        return keccak256(abi.encode(buyer, served));
    }

    function _canServe(address, bytes calldata) internal view override returns (bool, string memory) {
        if (mode == Mode.Revert) return (false, "service says no");
        return (true, "");
    }
}

/// @title MockNotService - 不支持 IAgentryService 的普通合约
contract MockNotService {
    function agentryProvider() external pure returns (address) { return address(1); }
}
