// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AgentryServiceBase} from "../service/AgentryServiceBase.sol";

/// @title AgentryCheckIn - 最小的「合约交付」服务示例：每日签到
/// @notice 开发者文档（docs/service-contract.md）里的示例代码就是这个文件。
///         每个 Agent ID 每天能签到一次，合约记下连续签到天数。
///         用户在 Agentry 上调用 AgentryServiceRouter.use(挂牌号, "")，
///         路由在市场里记一张已完成的订单，再调用这里的 _fulfill。
contract AgentryCheckIn is AgentryServiceBase {
    /// @notice 服务方：只有这个地址能把本合约挂到 Agentry 上，也只有它能绑定挂牌号
    address public immutable provider;

    struct Record {
        uint32 lastDay;   // 上次签到是第几天（block.timestamp / 1 days）
        uint32 streak;    // 连续签到天数
        uint32 total;     // 累计签到次数
    }

    mapping(address => Record) public records;

    event CheckedIn(address indexed agent, uint32 streak, uint32 total);

    error OnlyProvider();
    error AlreadyCheckedInToday();

    constructor(address router_, address provider_) AgentryServiceBase(router_) {
        provider = provider_;
    }

    /// @notice 挂牌后由服务方绑定挂牌号；绑定前任何使用都会被拒绝
    function setListing(uint256 listingId_) external {
        if (msg.sender != provider) revert OnlyProvider();
        _bindListing(listingId_);
    }

    function agentryProvider() external view returns (address) {
        return provider;
    }

    /// @dev 交付逻辑：出错就 revert，整笔交易（包括市场里的订单）一起回滚
    function _fulfill(address buyer, bytes calldata) internal override returns (bytes32) {
        uint32 today = uint32(block.timestamp / 1 days);
        Record storage r = records[buyer];
        if (r.total != 0 && r.lastDay == today) revert AlreadyCheckedInToday();

        r.streak = (r.total != 0 && r.lastDay + 1 == today) ? r.streak + 1 : 1;
        r.lastDay = today;
        r.total += 1;

        emit CheckedIn(buyer, r.streak, r.total);
        // 结果摘要：写进路由的 ServiceUsed 事件，方便核对
        return keccak256(abi.encode(buyer, today, r.streak));
    }

    /// @dev 预检：拒绝条件必须和 _fulfill 一致
    function _canServe(address buyer, bytes calldata) internal view override returns (bool, string memory) {
        Record memory r = records[buyer];
        if (r.total != 0 && r.lastDay == uint32(block.timestamp / 1 days)) return (false, "already checked in today");
        return (true, "");
    }
}
