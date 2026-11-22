// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IAgentryService} from "./IAgentryService.sol";

/// @title AgentryServiceBase - 合约交付服务的基础合约
/// @notice 继承它，只需要实现 _fulfill、_canServe 和 agentryProvider。
///         它替你做好三件事：只认服务路由、只认自己绑定的挂牌、声明 ERC-165 接口。
///
///         挂牌流程：部署 → 服务方经路由创建挂牌（路由核对 agentryProvider）→ 调 _bindListing 绑定挂牌号。
///         绑定之前任何使用都会被拒绝。
abstract contract AgentryServiceBase is IAgentryService, IERC165 {
    /// @notice Agentry 服务路由。只有它能调用 fulfill
    address public immutable router;

    /// @notice 本合约服务的挂牌号，0 表示还没绑定
    uint256 public listingId;

    event ListingBound(uint256 indexed listingId);

    error OnlyRouter();
    error WrongListing();
    error ZeroRouter();

    constructor(address router_) {
        if (router_ == address(0)) revert ZeroRouter();
        router = router_;
    }

    /// @inheritdoc IAgentryService
    function fulfill(uint256 listingId_, address buyer, bytes calldata input) external returns (bytes32) {
        if (msg.sender != router) revert OnlyRouter();
        if (listingId_ == 0 || listingId_ != listingId) revert WrongListing();
        return _fulfill(buyer, input);
    }

    /// @inheritdoc IAgentryService
    function canServe(uint256 listingId_, address buyer, bytes calldata input)
        external
        view
        returns (bool ok, string memory reason)
    {
        if (listingId == 0) return (false, "listing not bound");
        if (listingId_ != listingId) return (false, "wrong listing");
        return _canServe(buyer, input);
    }

    function supportsInterface(bytes4 interfaceId) public view virtual returns (bool) {
        return interfaceId == type(IAgentryService).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    /// @dev 绑定或更换挂牌号。由子合约在权限检查后调用（通常是 onlyOwner）
    function _bindListing(uint256 listingId_) internal {
        listingId = listingId_;
        emit ListingBound(listingId_);
    }

    /// @dev 交付逻辑。出错就 revert，整笔交易（包括市场里的订单）都会回滚
    function _fulfill(address buyer, bytes calldata input) internal virtual returns (bytes32 resultHash);

    /// @dev 预检逻辑，与 _fulfill 的拒绝条件保持一致
    function _canServe(address buyer, bytes calldata input) internal view virtual returns (bool ok, string memory reason);
}
