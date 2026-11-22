// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IAgentMarket} from "../interfaces/IAgentMarket.sol";
import {IAgentryService} from "./IAgentryService.sol";

interface IPausable {
    function paused() external view returns (bool);
}

/// @title AgentryServiceRouter - 「合约交付」的唯一入口
/// @notice 用户调用 use(挂牌号, 输入)：
///           1. 市场合约记一张已完成的 0 元订单（买方 = 发起交易的人，服务方 = 挂牌人）
///           2. 调用挂牌指定的服务合约 fulfill，由它完成交付
///         任何一步出错，整笔交易回滚。
///
///         为什么单独一个合约：调用陌生合约的风险被隔离在这里，市场合约（托管着付费订单的资金）
///         从不直接调用服务合约。本合约不持有任何资金，调用服务合约时不转账、不授权、不用 delegatecall。
///
///         防冒用：只有服务合约 agentryProvider() 声明的地址能把它挂到市场上；
///         服务合约自己再核对挂牌号（见 AgentryServiceBase）。
contract AgentryServiceRouter is ReentrancyGuard {
    /// @notice 用户输入上限
    uint256 public constant MAX_INPUT = 4096;
    /// @notice 服务合约报错时，最多转述这么多字节的错误信息（防止超大返回数据耗光 gas）
    uint256 private constant MAX_REVERT = 256;
    /// @notice 预检时给服务合约的 gas 上限
    uint256 private constant CHECK_GAS = 300_000;

    IAgentMarket public immutable market;
    address public immutable agentId;

    event ServiceUsed(
        uint256 indexed listingId,
        uint256 indexed taskId,
        address indexed buyer,
        address target,
        bytes32 resultHash
    );

    error NotAgent();
    error NotAContract();
    error NotAService();
    error NotServiceProvider();
    error InputTooLarge();
    error BadServiceResponse();
    error ZeroAddress();

    constructor(address market_, address agentId_) {
        if (market_ == address(0) || agentId_ == address(0)) revert ZeroAddress();
        market = IAgentMarket(market_);
        agentId = agentId_;
    }

    /*//////////////////////////////////////////////////////////////
                                挂牌
    //////////////////////////////////////////////////////////////*/

    /// @notice 把一个服务合约挂到市场上。调用者必须持有 Agent ID，且是服务合约声明的服务方
    function createServiceListing(address target, string calldata specURI, bytes32 specHash)
        external
        nonReentrant
        returns (uint256 listingId)
    {
        if (IERC721(agentId).balanceOf(msg.sender) == 0) revert NotAgent();
        if (target.code.length == 0) revert NotAContract();
        if (!_supportsService(target)) revert NotAService();
        if (_providerOf(target) != msg.sender) revert NotServiceProvider();
        listingId = market.createServiceListing(msg.sender, target, specURI, specHash);
    }

    /*//////////////////////////////////////////////////////////////
                                使用
    //////////////////////////////////////////////////////////////*/

    /// @notice 使用一个「合约交付」服务。一笔交易完成下单与交付
    function use(uint256 listingId, bytes calldata input)
        external
        nonReentrant
        returns (uint256 taskId, bytes32 resultHash)
    {
        if (input.length > MAX_INPUT) revert InputTooLarge();

        // 先记订单（市场合约检查挂牌类型、上架状态、Agent ID、自买自卖），再调用外部合约
        address target;
        (taskId, target) = market.recordServiceUse(listingId, msg.sender);

        bytes memory data = abi.encodeCall(IAgentryService.fulfill, (listingId, msg.sender, input));
        bool ok;
        uint256 size;
        assembly {
            ok := call(gas(), target, 0, add(data, 32), mload(data), 0, 0)
            size := returndatasize()
        }
        if (!ok) _bubble(size);
        if (size < 32) revert BadServiceResponse();
        assembly {
            let p := mload(0x40)
            returndatacopy(p, 0, 32)
            resultHash := mload(p)
        }

        emit ServiceUsed(listingId, taskId, msg.sender, target, resultHash);
    }

    /// @notice 交易前预检。返回 false 时附原因，Agent 应先告诉用户，不要生成交易
    function canUse(uint256 listingId, address buyer, bytes calldata input)
        external
        view
        returns (bool ok, string memory reason)
    {
        if (input.length > MAX_INPUT) return (false, "input too large");
        IAgentMarket.Listing memory l;
        try market.getListing(listingId) returns (IAgentMarket.Listing memory got) {
            l = got;
        } catch {
            return (false, "listing not found");
        }
        if (l.kind != IAgentMarket.ListingKind.Service) return (false, "not a service listing");
        if (!l.active) return (false, "listing inactive");
        if (IPausable(address(market)).paused()) return (false, "market paused");
        if (IERC721(agentId).balanceOf(buyer) == 0) return (false, "no Agent ID");
        if (buyer == l.provider) return (false, "provider cannot use own service");
        try IAgentryService(l.target).canServe{gas: CHECK_GAS}(listingId, buyer, input) returns (bool a, string memory r) {
            return (a, r);
        } catch {
            return (false, "service check failed");
        }
    }

    /*//////////////////////////////////////////////////////////////
                                内部
    //////////////////////////////////////////////////////////////*/

    function _supportsService(address target) private view returns (bool) {
        try IERC165(target).supportsInterface{gas: 30_000}(type(IAgentryService).interfaceId) returns (bool yes) {
            return yes;
        } catch {
            return false;
        }
    }

    function _providerOf(address target) private view returns (address) {
        try IAgentryService(target).agentryProvider{gas: 50_000}() returns (address p) {
            return p;
        } catch {
            return address(0);
        }
    }

    /// @dev 转述服务合约的错误，最多 MAX_REVERT 字节
    function _bubble(uint256 size) private pure {
        if (size > MAX_REVERT) size = MAX_REVERT;
        assembly {
            let p := mload(0x40)
            returndatacopy(p, 0, size)
            revert(p, size)
        }
    }
}
