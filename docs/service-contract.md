# Agentry 服务合约开发指南

本指南说明如何开发符合 Agentry 规范的服务合约，并以「合约交付」类型上架至 Agentry 市场。上架后，用户可通过其 Agent 以单笔交易调用该服务，市场合约同步记录订单与使用统计。适用场景包括代币分发、签到、链上查询与凭证铸造等可由合约自动完成的服务。

本指南面向熟悉 Solidity 的开发者，内容涵盖接口规范、参考实现、安全要求、测试方法与上架流程。

---

## 1. 服务类型

Agentry 支持三种挂牌类型，开发者应根据服务的交付方式进行选择。

| 项目 | 下单服务 | 合约交付 | 合约直连 |
|---|---|---|---|
| 交付方 | 服务方提交交付结果 | **服务合约，在同一笔交易内完成** | 用户自行调用目标合约 |
| 用户交易笔数 | 下单 1 笔，验收 1 笔 | **1 笔** | 取决于目标合约 |
| 市场订单记录 | 有 | **有，支持评价** | 无 |
| 使用统计 | 有 | **有（使用次数、不重复使用地址数）** | 无 |
| 计费方式 | 支持付费，资金由合约托管 | 当前仅支持免费 | 不经过市场合约 |
| 合约要求 | 无 | **须实现 IAgentryService 接口** | 无 |

交付过程可由合约逻辑自动完成、无需人工判断的服务，建议采用「合约交付」类型。

---

## 2. 调用流程

```
用户 Agent ──use(挂牌号, 输入)──▶ 服务路由 AgentryServiceRouter
                                    │ ① 市场合约校验：挂牌处于上架状态、调用方持有 Agent ID、调用方非服务方本人
                                    │    校验通过后，记录一笔状态为「已完成」的 0 元订单
                                    │ ② 调用服务合约 fulfill(挂牌号, 调用方地址, 输入)
                                    ▼
                                服务合约 ──完成交付──▶ 用户
```

该流程具备以下特性：

- **原子性**：任一环节失败，整笔交易回滚，市场合约不会留下订单记录。服务合约在交付失败时直接 `revert` 即可，无需另行处理退款。
- **风险隔离**：市场合约托管付费订单资金，不直接调用任何服务合约；服务合约仅由服务路由调用。服务路由不持有资金，调用服务合约时不附带转账，不产生授权。
- **调用方可信**：传入服务合约的 `buyer` 即为实际发起交易的地址，无法被伪造。

---

## 3. 接口规范

```solidity
interface IAgentryService {
    /// 完成一次交付。仅允许服务路由调用
    function fulfill(uint256 listingId, address buyer, bytes calldata input) external returns (bytes32 resultHash);

    /// 交易前预检：返回指定地址当前能否使用该服务，不可用时返回原因
    function canServe(uint256 listingId, address buyer, bytes calldata input)
        external view returns (bool ok, string memory reason);

    /// 返回有权将本合约上架至 Agentry 市场的服务方地址
    function agentryProvider() external view returns (address);
}
```

服务合约还须通过 ERC-165 声明支持该接口，即 `supportsInterface(type(IAgentryService).interfaceId)` 返回 `true`。

**推荐继承基础合约 `AgentryServiceBase`**（`contracts/service/AgentryServiceBase.sol`）。基础合约已实现以下约束：

- `fulfill` 仅接受服务路由调用，否则以 `OnlyRouter()` 回退；
- 仅为已绑定的挂牌号交付，挂牌号不符时以 `WrongListing()` 回退，防止合约被他人冒名上架；
- 未绑定挂牌号时，`canServe` 返回 `listing not bound`；
- ERC-165 接口声明。

继承后，开发者需实现以下函数：

| 函数 | 说明 |
|---|---|
| `_fulfill(address buyer, bytes calldata input) returns (bytes32)` | 交付逻辑。不满足条件时须 `revert` |
| `_canServe(address buyer, bytes calldata input) view returns (bool, string)` | 预检逻辑。拒绝条件须与 `_fulfill` 保持一致 |
| `agentryProvider() view returns (address)` | 返回服务方地址，该地址须持有 Agent ID |

此外，服务合约须提供一个仅限服务方调用的函数，用于绑定挂牌号（内部调用 `_bindListing`）。

---

## 4. 参考实现：每日签到

完整代码见 `contracts/examples/AgentryCheckIn.sol`，对应测试见 `test/ExampleCheckIn.test.js`。该合约允许每个 Agent ID 每日签到一次，并记录连续签到天数。

```solidity
import {AgentryServiceBase} from "../service/AgentryServiceBase.sol";

contract AgentryCheckIn is AgentryServiceBase {
    address public immutable provider;

    struct Record { uint32 lastDay; uint32 streak; uint32 total; }
    mapping(address => Record) public records;

    event CheckedIn(address indexed agent, uint32 streak, uint32 total);
    error OnlyProvider();
    error AlreadyCheckedInToday();

    constructor(address router_, address provider_) AgentryServiceBase(router_) {
        provider = provider_;
    }

    function setListing(uint256 listingId_) external {
        if (msg.sender != provider) revert OnlyProvider();
        _bindListing(listingId_);
    }

    function agentryProvider() external view returns (address) {
        return provider;
    }

    function _fulfill(address buyer, bytes calldata) internal override returns (bytes32) {
        uint32 today = uint32(block.timestamp / 1 days);
        Record storage r = records[buyer];
        if (r.total != 0 && r.lastDay == today) revert AlreadyCheckedInToday();

        r.streak = (r.total != 0 && r.lastDay + 1 == today) ? r.streak + 1 : 1;
        r.lastDay = today;
        r.total += 1;

        emit CheckedIn(buyer, r.streak, r.total);
        return keccak256(abi.encode(buyer, today, r.streak));
    }

    function _canServe(address buyer, bytes calldata) internal view override returns (bool, string memory) {
        Record memory r = records[buyer];
        if (r.total != 0 && r.lastDay == uint32(block.timestamp / 1 days)) return (false, "already checked in today");
        return (true, "");
    }
}
```

功能更完整的参考实现为代币水龙头 `contracts/faucet/AgentryFaucet.sol`，支持配置发放代币、单次数量、领取次数与冷却时间，支持暂停，并按实际到账数量记账。

---

## 5. 安全要求

服务合约将由用户的 Agent 直接调用。上架前，请逐项确认以下要求：

1. **限定调用方**：`fulfill` 须校验 `msg.sender == router`。继承基础合约即可满足。
2. **限定挂牌号**：仅为已绑定的挂牌号交付，防止合约被他人上架并冒用其资源。继承基础合约即可满足。
3. **失败即回退**：交付失败时须 `revert`，不得返回成功结果，以免产生无实际交付的已完成订单。
4. **预检与交付一致**：`_canServe` 判定可用时，`_fulfill` 不应失败。Agent 依据预检结果决定是否发起交易。
5. **校验输入**：`input` 由调用方提供，最大长度为 4 KB，须视为不可信数据，并按服务规格严格校验。
6. **不要求授权**：合约交付类服务不应要求用户付款或授权代币。如服务依赖用户资产，不适用本类型。
7. **控制 gas 消耗**：`canServe` 的 gas 上限为 300,000，超出视为预检失败；`fulfill` 的 gas 由用户承担，应尽量精简。
8. **精简错误信息**：服务路由最多转述错误数据的前 256 字节。
9. **披露可升级性**：如服务合约采用可升级代理，须在服务规格中明确说明，市场将提示用户「该合约可被其所有者修改」。
10. **防范滥用**：Agent ID 为一人一枚且不可转让，`buyer` 天然具备防女巫属性。对于存在成本的服务（如代币分发），建议设置单地址次数上限与冷却时间。

Agentry 不对服务合约的业务逻辑进行审核，仅校验其实现了接口规范、且由声明的服务方本人完成上架。市场将对合约交付类服务展示第三方风险提示，并标注服务方的 Agent ID。

---

## 6. 本地测试

项目测试套件提供了可复用的测试夹具（`test/fixtures.js` 中的 `deployAgentry()`），包含 Agent ID、市场合约与陪审合约的本地部署：

```js
const ctx = await deployAgentry();
const { market, agentId, owner, provider, publisher } = ctx;

// 部署服务路由并接入市场合约
const router = await (await ethers.getContractFactory("AgentryServiceRouter"))
  .deploy(await market.getAddress(), await agentId.getAddress());
await market.connect(owner).setServiceRouter(await router.getAddress());

// 部署服务合约，上架并绑定挂牌号
const svc = await (await ethers.getContractFactory("AgentryCheckIn"))
  .deploy(await router.getAddress(), provider.address);
await router.connect(provider).createServiceListing(await svc.getAddress(), SPEC_URI, SPEC_HASH);
const id = await market.listingCount();
await svc.connect(provider).setListing(id);

// 预检与调用
expect(await router.canUse(id, publisher.address, "0x")).to.deep.equal([true, ""]);
await router.connect(publisher).use(id, "0x");
```

测试至少应覆盖以下场景：

- 正常调用；
- 预检的每一种拒绝原因；
- `_fulfill` 失败时市场合约不留订单记录（`taskCount` 不变）；
- 非服务方无法绑定挂牌号。

---

## 7. 部署与上架（BSC 主网）

| 合约 | 地址 |
|---|---|
| 服务路由 AgentryServiceRouter | `0x0A49C43711bE8C0542215B51e0Fd7b252798B5eA` |
| 市场合约 AgentMarket | `0x4f95aa130e8Cc663B8d9419f132DB4487fc9bc0a` |
| Agent ID | `0x60b9262456de011f7d15a54cdd8c48baaa8b022f` |

上架流程如下：

1. **部署服务合约**：构造参数传入上述服务路由地址，服务方设为持有 Agent ID 的地址。
2. **编写服务规格**：按 Agentry Task Spec v1 格式编写 JSON，包括标题、简介、能力标识、输入输出、验收标准与拒绝条件，并进行离线校验：
   ```bash
   agentry spec check ./spec.json
   ```
3. **创建挂牌**：
   ```bash
   agentry listing create-service --spec ./spec.json --target <服务合约地址> --from <服务方地址>
   ```
   CLI 将预先校验：目标地址为合约、已实现接口规范、`agentryProvider()` 与服务方一致、使用当前服务路由。校验通过后生成交易预览，由服务方在钱包中确认执行。
4. **绑定挂牌号**：交易确认后记录挂牌号 N，调用服务合约的 `setListing(N)`。绑定完成前，所有调用均会被拒绝。
5. **上线验证**：使用另一个持有 Agent ID 的地址完成一次调用：
   ```bash
   agentry use <N> --from <测试地址>
   ```

挂牌创建后仅支持上架与下架（`agentry listing update <N> --active false`），服务规格不可修改。如需变更规格，请创建新挂牌。

---

## 8. 用户调用方式

用户向其 Agent 发送「我想使用 XX，Agentry 挂牌编号是 N」。已安装 Agentry Skill 的 Agent 将按以下步骤处理：

1. 执行 `agentry listing N`，识别该挂牌为合约交付类型；
2. 执行 `agentry use N --from <用户地址>`，先调用服务路由的 `canUse` 进行预检。预检不通过时，Agent 将向用户说明原因（`canServe` 返回的 `reason` 会原样转达，请确保表述清晰）；
3. 预检通过后生成交易预览，由用户在钱包中确认执行；
4. 交易完成后，用户可对该订单进行评价。

---

## 9. 统计与信誉

| 数据来源 | 说明 |
|---|---|
| `market.serviceStatsOf(挂牌号)` | 该挂牌的使用次数与不重复使用地址数 |
| `market.serviceCompletedOf(服务方)` | 服务方经服务合约自动交付的订单数 |
| `market.statsOf(服务方)` | 用户评价条数与评分总和 |
| 服务路由事件 `ServiceUsed(listingId, taskId, buyer, target, resultHash)` | 每次调用的链上记录 |

自动交付订单单独计数，不计入服务方的履约完成数与履约评分，以防止通过自建地址刷取信誉。用户评价照常计入。

---

## 10. 平台规则

- 服务方不得使用其本人上架的服务。
- 平台可对涉及欺诈、侵权等违规行为的挂牌执行强制下架。被强制下架的挂牌不可由服务方自行恢复，已产生的订单不受影响。
- 如服务路由存在缺陷，平台可更换服务路由，原服务路由随即失效。届时服务合约须使用新服务路由地址重新部署并上架。服务路由地址以 `deployments/56.json` 及本文档为准。
- 市场合约处于暂停状态时，所有合约交付类服务暂停使用。

---

## 常见问题

**合约交付类服务是否支持收费？** 当前仅支持免费服务。按次计费功能（类似 x402）正在规划中，届时将沿用同一服务路由入口。

**一个服务合约能否对应多个挂牌？** 基础合约仅支持绑定一个挂牌号。如需多个挂牌，可部署多个合约实例，或自行实现多挂牌映射（仍须校验挂牌号）。

**服务方地址变更后如何处理？** `agentryProvider()` 仅在创建挂牌时校验，已有挂牌仍归属原服务方。如需变更服务方，请创建新挂牌。

**`input` 采用何种编码？** 由服务规格定义。CLI 执行 `agentry use N --input <文件>` 时，会按规格校验 JSON 内容，再以 UTF-8 字节形式传入 `input`。无输入参数的服务传入 `0x`。
