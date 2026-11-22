// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAgentMarket} from "./IAgentMarket.sol";

/// @title IAgentJury - 一 ID 一票的链上仲裁器
/// @notice 争议受理、开放投票、押金结算
/// @dev 本合约独立部署，接口对任何第三方合约开放。
///      抗女巫完全由 Agent ID 承担：一个 KYC 仅一枚、不可转让，
///      因此"一地址一票"在本系统中严格等价于"一人一票"。
///      这里不存在资金加权，巨鲸的一票和任何人的一票等重。
///
///      押金与陪审费的币种跟随争议标的：BNB 计价的任务用 BNB 押注，
///      稳定币计价的任务用稳定币押注。但陪审池本身不分币种——
///      同一批陪审员裁决所有争议，信誉也记在同一本账上。
interface IAgentJury {
    /*//////////////////////////////////////////////////////////////
                                 类型
    //////////////////////////////////////////////////////////////*/

    enum Side {
        None,       // 未投票
        Provider,   // 支持服务方
        Publisher   // 支持发布方
    }

    struct Dispute {
        uint256 taskId;
        address publisher;          // 排除投票
        address provider;           // 排除投票
        address currency;           // 标的币种，押金与陪审费都用它
        uint96  taskAmount;         // 争议标的，用于计算陪审费
        uint96  stake;              // 本争议的单票押金（开庭时快照）
        uint64  votingDeadline;
        uint32  votesForProvider;
        uint32  votesForPublisher;
        uint96  rewardPool;         // 结算后写入：陪审费 + 少数方没收的押金
        bool    settled;
        IAgentMarket.Verdict verdict;
    }

    /*//////////////////////////////////////////////////////////////
                                 事件
    //////////////////////////////////////////////////////////////*/

    event DisputeOpened(
        uint256 indexed disputeId,
        uint256 indexed taskId,
        address indexed currency,
        uint96  taskAmount,
        uint96  stake,
        uint64  votingDeadline
    );
    event VoteCast(uint256 indexed disputeId, address indexed juror, Side side);
    event DisputeSettled(
        uint256 indexed disputeId,
        IAgentMarket.Verdict verdict,
        uint32  votesForProvider,
        uint32  votesForPublisher,
        uint96  rewardPool
    );
    event JurorPaid(uint256 indexed disputeId, address indexed juror, uint256 amount);

    /*//////////////////////////////////////////////////////////////
                                 开庭
    //////////////////////////////////////////////////////////////*/

    /// @notice 受理一笔争议，开启投票窗口
    /// @dev 仅 market() 可调用
    function openDispute(
        uint256 taskId,
        address publisher,
        address provider,
        address currency,
        uint96  taskAmount
    ) external returns (uint256 disputeId);

    /*//////////////////////////////////////////////////////////////
                                 投票
    //////////////////////////////////////////////////////////////*/

    /// @notice 投票。缴纳押金并表态
    /// @dev 要求：
    ///      1. 持有 Agent ID（balanceOf > 0）
    ///      2. 本争议未投过票 —— 一个 ID 只能投一票
    ///      3. 不是该任务的发布方或服务方
    ///      4. 在 votingDeadline 之前
    ///
    ///      押金币种跟随争议标的：BNB 争议需随交易附带等额 BNB，
    ///      ERC-20 争议需提前 approve 精确的押金金额且不得附带 BNB
    function vote(uint256 disputeId, Side side) external payable;

    /*//////////////////////////////////////////////////////////////
                                 结算
    //////////////////////////////////////////////////////////////*/

    /// @notice 窗口结束后结算裁决，任何地址都可以调用
    /// @dev 裁决规则：
    ///      总票数 >= quorum() 且一方票多 → 多数方胜，金额归胜方，扣除陪审费
    ///      总票数 <  quorum() 或 平票     → NoQuorum，托管金额对半分，不收陪审费
    ///
    ///      平票归入 NoQuorum：多数决要求真的存在多数。平票时双方都未能
    ///      说服陪审团，与票数不足同理，不应让任何一方获得意外之利。
    ///
    ///      为什么票数不足时对半分：默认判给任一方，该方都可以通过
    ///      "赌没人来投票"来套利。对半分让双方都有损失，因此双方都有
    ///      动力把陪审团叫来。在陪审池规模尚小时这一条尤其重要。
    ///
    ///      本函数会回调 market.resolveDispute() 执行放款
    function settle(uint256 disputeId) external;

    /// @notice 结算某个陪审员的头寸：发放其应得金额，并记录其陪审信誉
    /// @dev 采用拉取而非推送，避免在未知长度的陪审员列表上循环，
    ///      也避免任一陪审员地址异常导致整笔结算卡死
    ///
    ///      多数方： 退还押金 + rewardPool / 多数方人数
    ///      少数方： 无可领取，押金已没收
    ///      NoQuorum：全额退还押金，无奖励，不计入胜负
    ///
    ///      **任何地址都可以代任意陪审员调用**，款项始终发给该陪审员本人。
    ///      这样设计是因为少数方没有领取动机，若只允许本人调用，其
    ///      jurorMinority 计数就永远不会被记上。开放代调用后，任何人
    ///      （索引器、项目方、对手方）都能把记录补齐
    function claimJurorPayout(uint256 disputeId, address juror) external;

    /*//////////////////////////////////////////////////////////////
                                 查询
    //////////////////////////////////////////////////////////////*/

    function getDispute(uint256 disputeId) external view returns (Dispute memory);

    /// @notice 某地址在某争议中的投票方向
    function voteOf(uint256 disputeId, address juror) external view returns (Side);

    /// @notice 该陪审员当前可领取的金额，未结算时返回 0
    function payoutOf(uint256 disputeId, address juror) external view returns (uint256);

    /// @notice 陪审信誉。绑定在不可转让的 Agent ID 上，换地址洗不掉
    function jurorRecordOf(address agent)
        external
        view
        returns (uint32 majority, uint32 minority);

    function disputeIdOf(uint256 taskId) external view returns (uint256);
    function disputeCount() external view returns (uint256);
    function market() external view returns (address);
    function agentId() external view returns (address);

    /*//////////////////////////////////////////////////////////////
                              参数（可调）
    //////////////////////////////////////////////////////////////*/

    function votingWindow() external view returns (uint32);
    function quorum()       external view returns (uint32);

    /// @notice 单票押金，按币种分别设置
    function jurorStake(address currency) external view returns (uint96);
}
