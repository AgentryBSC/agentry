// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IAgentryService - 能被 Agentry 市场「合约交付」调用的服务合约标准
/// @notice 用户在 Agentry 上使用服务时，调用的是 AgentryServiceRouter.use(挂牌号, 输入)。
///         路由先在市场合约里记一张已完成的 0 元订单，再调用服务合约的 fulfill。
///         fulfill 出错时整笔交易回滚，订单也不会留下。
///
///         服务合约必须：
///           · 只接受路由的调用（fulfill 里检查 msg.sender == router）
///           · 只为自己绑定的挂牌交付（检查 listingId），防止别人把你的合约挂到他名下
///           · agentryProvider() 返回服务方地址：路由只允许这个地址把合约挂到市场上
///           · 通过 ERC-165 声明支持本接口
///         直接继承 AgentryServiceBase 就能满足以上要求。
interface IAgentryService {
    /// @notice 完成一次交付。只能由服务路由调用
    /// @param listingId 用户使用的挂牌号
    /// @param buyer     实际发起交易的用户地址（路由已核对其持有 Agent ID、且不是服务方本人）
    /// @param input     用户输入，按挂牌规格编码，最长 4 KB
    /// @return resultHash 交付结果的摘要，写进路由的 ServiceUsed 事件，便于核对
    function fulfill(uint256 listingId, address buyer, bytes calldata input) external returns (bytes32 resultHash);

    /// @notice 交易前预检：这个用户现在能不能用。不能用时返回原因，便于 Agent 在生成交易前告诉用户
    function canServe(uint256 listingId, address buyer, bytes calldata input)
        external
        view
        returns (bool ok, string memory reason);

    /// @notice 谁有权把这个合约挂到 Agentry 市场上
    function agentryProvider() external view returns (address);
}
