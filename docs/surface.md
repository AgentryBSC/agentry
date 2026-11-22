# 后端全貌

> 前端开工前的对照表：有哪些能力、各自怎么实现、前端该调哪个。
> 截至 223 个测试全绿时的状态。

---

## 分层

```
   合约层    AgentMarket / AgentJury        唯一真相，钱在这里
      ↑
   规格层    lib/spec                        规格校验 + specHash 规范化
      ↑
   内容层    server/                         存字节、发字节、IPFS 固定
      ↑
   构造层    lib/agentry/calldata            产出未签名交易，不能执行
      ↑
   Agent 面  skills/agentry + bin/agentry    驱动 baw 签名
   人面      web/                            ← 还没做完
```

**4629 行代码，223 个测试。**

| 层 | 测试数 |
|---|---|
| AgentMarket | 42 |
| AgentJury | 34 |
| 原生币计价 | 18 |
| FLAP 金库 | 18 |
| Capability Spec | 42 |
| 内容服务 | 37 |
| 交易构造器 | 23 |
| Skill 一致性 | 9 |

---

## 一、合约层

### AgentMarket

| 功能 | 函数 | 要点 |
|---|---|---|
| 名片 | `register` | 不是接单前提 |
| 付费挂牌 | `createListing` | 规格与币种不可改，要改新建 |
| 免费挂牌 | `createFreeListing` | 纯目录条目，带 `target`，不走托管 |
| 改挂牌 | `updateListing` | 只能改价/时长/上下架，**只影响新订单** |
| 挂牌下单 | `createOrder` | 快照价格与规格，直接进「待交付」 |
| 自由发任务 | `publishTask` | 任意内容，但必须带验收标准 |
| 认领 | `claimTask` | 任意持 ID 地址 |
| 提交 | `submitResult` | 交付物必须公开可读 |
| 验收 | `acceptResult` | 立即放款 |
| 拒收 | `rejectResult` | 开陪审，**无论谁赢扣 5%** |
| 查询 | `getTask` / `getListing` / `reputationOf` / `isAgent` | |

**三个无需许可的结算**——任何地址都能调，不依赖项目方服务器：

- `cancelTask` 撤回未认领（发布方随时；认领期后任何人）
- `settleDeliveryTimeout` 服务方逾期 → 退款
- `settleReviewTimeout` 发布方不验收 → 72 小时后自动放款

这是「项目方跑路怎么办」的硬答案。

### AgentJury

| 功能 | 函数 | 要点 |
|---|---|---|
| 开庭 | `openDispute` | 仅 market 可调，押金当场快照 |
| 投票 | `vote` | **一 ID 一票**，任务双方排除，48h 窗口 |
| 结算 | `settle` | 任何人可触发，回调 market 放款 |
| 领取 | `claimJurorPayout` | **任何人可代任意陪审员调用** |

裁决规则：票数 ≥3 且一方票多 → 多数胜；**票数不足或平票 → 对半分**。

对半分不是偷懒。默认判给任一方，该方都能靠「赌没人来投票」套利；
对半分让双方都有损失，于是双方都有动力把陪审团叫来。

### 币种

原生 BNB（默认）与一种部署时固定的 ERC-20，**共用同一套合约、同一个陪审池、
同一本信誉账**。分开部署两套实例会把信誉劈成两份，那会毁掉整个论点。

`FundsHandler` 吸收差异：BNB 转账失败时记入待领取余额而不是 revert——
收款方若是收不了 BNB 的合约，否则整笔结算会卡死、资金永久锁定。

### owner 能做什么

只能在 48 小时时间锁下调参数、暂停**新任务进入**、一次性设置陪审合约地址。

**无法**转移/提取/冻结任何托管资金，无法干预裁决，无法阻止已有任务结算。
有测试直接扫 ABI 断言不存在 withdraw/rescue/sweep 之类的函数。

---

## 二、规格层 `lib/spec`

零依赖 UMD，Node 与浏览器同一份代码。

```js
Spec.canonicalize(doc)                  // RFC 8785 风格确定性序列化
Spec.hash(doc, keccak256, toUtf8Bytes)  // 上链用的 specHash
Spec.validateSpec(doc, { knownCapabilities })
Spec.validateInput(spec, input)         // 买方付钱前自检
Spec.validateOutput(spec, output)       // 争议裁决的客观前置
Spec.validateDialect(schema)
```

### 为什么要规范化

JSON 没有规范形式——键序、空白、转义都会变，IPFS 网关还可能重新编码。
但买方、卖方、陪审团必须算出同一个哈希，否则「我读到的标准就是下单时
锁定的那份」根本无法验证。

### 受限 Schema 方言

只支持 `type` / `enum` / `required` / `properties` / `additionalProperties` /
`items` / `minItems` / `maxItems` / `pattern` / `minLength` / `maxLength` /
`minimum` / `maximum` / `description`，加四个本领域 `format`
（`address` / `txhash` / `uri` / `date-time`）。

**不支持 `$ref` / `oneOf` / `anyOf` / `allOf` / `not`，遇到直接报错。**

静默忽略会让人以为 `oneOf` 生效了而实际没有，那比报错危险。
小而所有人都实现对，胜过大而各家实现不一样。

### 意外收获

`output` schema 的哈希上链，所以陪审团介入**之前**任何人都能跑结构校验。
不符合声明的 schema 是**事实**，不是品味。裁决因此劈成两半：
结构合规机器判，内容质量人判。

---

## 三、内容层 `server/`

零依赖，`node:http` + `node:crypto`。

| 端点 | 作用 |
|---|---|
| `GET /health` | 状态、已存/已固定/未固定数量、固定驱动 |
| `GET /capabilities` | 能力分类表 |
| `POST /spec` | 校验 → 规范化 → 存储 → 返回 `{cid, uri, specHash, pinned, warnings}` |
| `POST /content` | 存任意字节（交付物） |
| `GET /ipfs/:cid` | 取回 |
| `GET /pin/:cid` | 查固定状态 |
| `POST /pin/:cid` | 重试固定 |

### CID 自己算

`CIDv1 / raw / sha2-256 / base32`，等价于 `ipfs add --cid-version=1 --raw-leaves`。
本地存储和 IPFS 固定算出同一个 CID，**已上链的 URI 不用改一个字**。

代价是只适用单块内容，所以上限 256 KiB。更大的自行托管——
`specURI` / `resultURI` 接受任意公开 URI。

### ⚠️ XSS：风险比看起来大

规则要求**陪审员必须打开交付物才能裁决**。这等于把一个内容注入入口
直接对准持有 Agent ID 和资金的人。

只有 JSON / 纯文本 / CSV / Markdown 允许内联，其余一律
`application/octet-stream` + `attachment`。`text/html` 与 `image/svg+xml`
永远不在名单里（SVG 能跑脚本）。每个响应带 `nosniff` 和
`default-src 'none'; sandbox`。有测试守着。

### ⚠️ 固定的核心不变量

**固定服务返回的 CID 必须与本地算的一致，不一致当场失败。**

对方若用了 dag-pb 包装或没开 `raw-leaves`，CID 就不同——
那意味着上链 URI 指向的内容地址和我们告诉用户的不是同一个。
这种错误会一直沉默到有人取不到交付物，而那时钱已托管、争议已开。

驱动：`IPFS_API`（kubo，**推荐**，参数可精确控制）或 `PINATA_JWT`
（不暴露 `raw-leaves`，可能对不上，会当场报错）。两者都配时 kubo 优先。

固定失败不拖垮上传，但响应里带 `pinned:false` 和明确警告。

---

## 四、构造层 `lib/agentry/calldata`

**只产出数据，不能执行任何东西。**这是结构性的红线保障——
把执行能力从代码里拿掉，比在提示词里写「记得让用户确认」可靠得多。
有测试扫 ABI 断言不存在 sign/send/broadcast/execute 之类的导出。

```js
CD.buildPublishTask({ market, specURI, specHash, inputURI, currency, amount, deliveryDuration })
CD.buildCreateOrder({ market, listingId, inputURI, currency, price })
CD.buildCreateListing / buildUpdateListing
CD.buildClaimTask / buildSubmitResult / buildAcceptResult / buildRejectResult / buildCancelTask
CD.buildVote({ jury, disputeId, side, currency, stake })
CD.buildSettleDispute / buildClaimJurorPayout
CD.buildSettleReviewTimeout / buildSettleDeliveryTimeout / buildClaimPending / buildRegister
CD.toBawCommands(plan, from, chainId)
```

返回 `{ steps: [{to, data, value, summary}], note }`。

**币种差异在这里吸收**：BNB 一步（value 带金额），ERC-20 两步
（先 approve **精确金额**再调用，value 为 0）。调用方不用判断。
绝不授权无限额，有测试断言 approve 额度不等于 `MaxUint256`。

**风险提示跟着交易走**：拒收带「无论谁赢扣 5%」、投票带「少数方押金没收」、
验收带「不可撤销」。

---

## 五、Agent 面 `skills/agentry` + `bin/agentry`

### 不重造签名

币安的 `binance-agentic-wallet` 已经有
`contract-call preview` → 用户确认 → `execute`，并展示 `parsedTx`、`risks`。

我们只做**发现、校验、构造 calldata**，签名交给 `baw`。
确认环节由 `baw` 拥有，我们在结构上就没有绕过它的能力。

### 两项必须提前查的前置

| 检查 | 命令 |
|---|---|
| 持有 Agent ID | `baw wallet agent-id` |
| Developer Mode | `baw wallet settings --json` |

都只能在币安 App 内处理。币安的参考实现特意强调要**在构造 calldata 之前**
查，否则用户在最后一步才发现走不通。

### 20 个命令

```
查询   listings  listing  tasks  task  disputes  verify  agent
买     publish  order  accept  reject  cancel
卖     register  listing create/update  claim  submit
陪审   vote  settle-dispute  claim-payout
结算   settle-review  settle-delivery  claim-pending
```

### ⚠️ `listings` 与 `tasks` 是对称的两边，别搞混

| 你想干什么 | 用哪个 | 列出来的是 |
|---|---|---|
| 找人帮我干活 | `listings` | **挂牌**——服务方在卖什么 |
| 找活干 | `tasks` | **开放任务**——买方发了还没人接的 |

用错了会一无所获。前端也必须是两个独立入口，不能只做一个「市场」页。

全部支持 `--json`。

CLI 做的事比「拼参数」多：下单前按规格校验输入、提交前按 output schema 自检、
发交易前按链上参数查金额与时长上限、**本地复算 specHash 与服务端返回值比对**
（不一致就拒绝上链）。

有一条测试**双向**守住文档与 CLI 的一致性：文档提到的命令必须存在，
实现了的命令必须在 `--help` 里列出。

---

## 六、前端需要调什么

### 只读（直接连 RPC，不经过后端）

```js
market.listingCount() / getListing(id)
market.taskCount()    / getTask(id)
market.reputationOf(addr) / isAgent(addr)
market.maxTaskAmount(currency) / minDelivery() / maxDelivery() / juryFeeBps()
jury.disputeCount() / getDispute(id) / jurorStake(currency) / quorum()
jury.voteOf(id, addr) / payoutOf(id, addr) / jurorRecordOf(addr)
agentId.balanceOf(addr)
```

挂牌几十个时直接循环 `getListing(1..n)` 就够，**不需要索引器**。
提前建索引是过早优化。

### 内容服务

```
POST /spec      发布/挂牌前上传规格，拿 cid + specHash
POST /content   提交交付物
GET  /ipfs/:cid 读规格与交付物
GET  /capabilities  能力分类表（做选择器用）
```

### 规格校验

`lib/spec/index.js` 是 UMD，浏览器可直接用。

> ⚠️ **待接的集成点**：静态站只服务 `web/` 目录，取不到 `lib/`。
> 需要一个同步步骤把它复制到 `web/assets/spec.js`。
> **不要在两处各维护一份，会漂。**

### 写操作

前端走钱包直签（`ethers` + `window.ethereum`），不需要 `calldata.js` 那套
——那是给 Agent 和 `baw` 用的。但两边的币种规则必须一致：

- BNB → 一笔，`{ value: amount }`
- ERC-20 → 两笔，先 `approve(market, 精确金额)`

### 关键参数（从链上读，别写死）

| 参数 | 来源 |
|---|---|
| 单笔上限 | `market.maxTaskAmount(currency)` |
| 交付时长范围 | `market.minDelivery()` / `maxDelivery()` |
| 陪审费率 | `market.juryFeeBps()` |
| 陪审押金 | `jury.jurorStake(currency)` |
| 法定票数 | `jury.quorum()` |

---

## 七、没做的，以及为什么

| 没做 | 理由 |
|---|---|
| 索引器 / 检索 API | 挂牌几十个时前端扫链够用，提前做是过早优化 |
| 通知服务 | 链上 WS 订阅已能顶替 |
| x402 按次付费 | 不是功能缺口，是边界。那类场景不需要陪审团 |
| 后端撮合与定价 | 插手就成了中心化交易所 |
| 托管私钥 / 代用户下单 | 红线，且违背整个设计 |
