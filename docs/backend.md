# 后端设计

> 合约解决的是「成交之后怎么算账」。这份文档解决的是「成交之前怎么找到对方」，
> 以及「整条链路怎么让 Agent 自己跑完，不需要人盯着」。

---

## 1. 缺口在哪

Agentic Economy 最硬的一条要求是这个：

> 一个 Agent 根据任务目标，**自动**寻找最合适的 Agent，评估能力，比较价格，
> 发起调用，完成支付，并把结果带回自己的工作流。

把这句话拆成六步，对照我们现在有什么：

| 步骤 | 现状 |
|---|---|
| 寻找 | ❌ 链上有挂牌，但没有索引。按能力检索做不到 |
| 评估 | ⚠️ 信誉在链上，但要逐个 `reputationOf` 拉，无法排序比较 |
| 比价 | ⚠️ 价格在链上，同上 |
| 发起调用 | ❌ 规格是给人读的自由文本，Agent 没法程序化构造输入 |
| 完成支付 | ✅ 合约已完成 |
| 带回结果 | ❌ 交付物只有一个 URI，没有存储，也没有结构可解析 |

**六步里合约只盖住了第五步。**前四步和第六步，都是后端的事。

更要紧的是第四步和第六步：现在的 `specURI` 是写给人看的验收标准，
Agent 读不懂也构造不出。这一条不解决，整个「机器速度的商业」就是空话——
每一单还是得有人读需求、手工填参数。

---

## 2. 不可动摇的约束：后端不碰私钥

在往下设计之前先把边界钉死，因为它决定了所有组件的形状。

黑客松红线里有两条是针对这件事的：

> 不得支持网页扫码登录 Agentic Wallet。不得让用户在第三方网站扫码或输入配对码登录，
> **也不得存储用户登录会话替用户下单**。

> 涉及用户资产的操作（转账、交易、授权），项目方 skill 中不得含有绕过用户确认交易的提示词。

所以：

- **后端永远不持有私钥，不托管会话，不代替任何人签名**
- 所有状态变更接口的返回值是**未签名的交易**，由用户自己的钱包签
- 后端只做四件事：**索引、检索、存内容、发通知**

由此得到一条架构不变量，它同时也是「项目方跑路怎么办」的答案：

> **后端整个挂掉，不能阻断任何资金路径。**
> 所有结算仍然可以由任何地址直接调合约触发——这一条在合约层已经做到了，
> 后端不许把它破坏掉。

后端是加速器，不是必经之路。

---

## 3. 架构

```
                    ┌──────────────────────────┐
   BSC 链上  ──事件──▶│  Indexer   索引器         │
   （唯一真相）        │  纯派生，可随时重建       │
                    └────────────┬─────────────┘
                                 │
         ┌───────────────────────┼───────────────────────┐
         ▼                       ▼                       ▼
  ┌─────────────┐        ┌──────────────┐        ┌──────────────┐
  │ Discovery   │        │  Notifier    │        │   Content    │
  │ 只读检索 API │        │  事件推送     │        │  IPFS 固定    │
  └──────┬──────┘        └──────┬───────┘        └──────┬───────┘
         │                      │                       │
         └──────────┬───────────┴───────────────────────┘
                    ▼
            ┌───────────────┐
            │  Agent Skill  │  ← Agent 的工具面
            │  只构造交易    │     签名永远交还用户
            └───────────────┘
```

### 3.1 Indexer（索引器）

监听合约事件，落进可查询的库。

| 索引对象 | 来源事件 |
|---|---|
| 挂牌 | `ListingCreated` / `FreeListingCreated` / `ListingUpdated` |
| 任务 | `TaskPublished` / `OrderCreated` / `TaskClaimed` / `ResultSubmitted` 及各终态事件 |
| 争议 | `DisputeOpened` / `VoteCast` / `DisputeSettled` |
| 信誉聚合 | 由上述事件派生 |

**关键性质：索引器是纯派生的，不是权威。**任何时候可以清库从创世区块重建，
结果必须完全一致。它不存任何链上没有的东西。

这条性质有实际意义：它意味着索引器出错、丢数据、被攻破，都不会影响资金安全——
最坏情况是检索不准，用户仍然可以直接读链。

### 3.2 Discovery API（只读检索）

```
GET  /listings?capability=&maxPrice=&currency=&minClients=&sort=
GET  /listings/:id
GET  /agents/:address            → 信誉、历史、在售挂牌
GET  /tasks/:id
GET  /disputes?status=open       → 等待陪审的争议
```

每条返回都带上**链上出处**（区块号、交易哈希、合约地址），
让调用方可以自行核验。涉及钱的判断不许只信 API。

### 3.3 Content（内容服务）

这是唯一一个**不做就转不起来**的组件。

`specURI` 和 `resultURI` 必须公开可读——陪审团要能打开交付物才能裁决。
如果让用户「自己传 IPFS」，那是把一个基础设施问题甩给用户，没人会用。

```
POST /content    → 上传，返回 { cid, uri, hash }
```

要求：

- **内容寻址**：返回的哈希必须和上链的 `specHash` 对得上
- **公开可读**：任何人、任何时候都能取
- **可自托管**：用户也能用自己的 IPFS 节点或任意公开 URL，不绑定我们

最后一条是故意的。内容服务是便利，不是锁定。

### 实现要点（`server/`）

**CID 自己算，不依赖 IPFS 客户端。**`CIDv1 / raw / sha2-256 / base32`，
等价于 `ipfs add --cid-version=1 --raw-leaves`。这样现在用本地存储、
以后固定到任何 IPFS 节点时 CID 完全一致，**已经上链的 URI 一个字都不用改**。

代价是只适用于**单块**内容：超过 256 KiB 时 IPFS 会做 UnixFS 分块，
CID 就对不上了。所以上传有 256 KiB 上限，更大的文件请自行托管——
`specURI` / `resultURI` 本来就接受任意公开 URI。

**存的是规范化后的字节。**这样两条验证路径会得到同一个答案：
取回原始字节直接哈希，和解析后重新规范化再哈希，结果一致。

**规格在上链之前就被拦。**`POST /spec` 先跑校验器，不合格直接 422。
一份含糊的规格进了链，争议时陪审团就只能对着含糊的标准判。

### ⚠️ XSS：这里的风险比看起来大

规则要求**陪审员必须打开交付物才能裁决**。这等于把一个内容注入入口
直接对准了持有 Agent ID 和资金的人——恶意服务方上传一个 HTML 交付物，
陪审员一点就中招。

所以只有 `application/json`、`text/plain`、`text/csv`、`text/markdown`
允许内联，其余一律 `application/octet-stream` + `attachment` 下载。
`text/html` 和 `image/svg+xml` 永远不在名单里（SVG 能跑脚本）。
每个响应都带 `X-Content-Type-Options: nosniff` 和
`Content-Security-Policy: default-src 'none'; sandbox`。

这几条有专门的测试守着，别删。

### IPFS 固定

两个驱动，按环境变量选：

```bash
IPFS_API=http://127.0.0.1:5001 npm run serve:content   # kubo，推荐
PINATA_JWT=<jwt>               npm run serve:content   # Pinata
```

两个都配时 **kubo 优先**。不配则不固定，内容只在本机——开发够用，上主网不行。

#### ⚠️ 核心不变量：返回的 CID 必须和本地算的一致

我们算的是 `CIDv1 / raw / sha2-256 / base32`（单块）。固定服务如果用了别的
参数——dag-pb 包装、CIDv0、没开 `raw-leaves`——返回的 CID 就不一样。
那意味着**上链的 URI 指向的内容地址，和我们告诉用户的不是同一个**。

这种错误不会立刻暴露。它会一直沉默到有人去取交付物、取不到为止，
而那时候钱已经托管了、争议已经开了。

所以 `pinAndVerify` 当场对比、当场失败，并在错误信息里直接告诉用户怎么修
（改用 kubo 并确保 `cid-version=1 & raw-leaves=true`）。有专门的测试，
用一个故意返回错误 CID 的假驱动来守这条。

**推荐 kubo 的原因就在这里**：`add` 的参数可以精确控制，CID 必然一致。
Pinata 不暴露 `raw-leaves` 开关，有可能对不上——真遇上了会当场报错，不会静默。

#### 固定失败怎么办

固定失败**不会拖垮上传**。内容照常存下、照常可取，但响应里会带：

```json
{ "pinned": false, "warnings": ["⚠️ 内容未固定到 IPFS…上链之前请确认这是可以接受的"] }
```

调用方必须看见这条——内容只在我们本机，就等于「陪审团依赖我们活着」。

重试：

```bash
curl -X POST http://localhost:8787/pin/<cid>      # 重新固定
curl        http://localhost:8787/pin/<cid>       # 查状态
```

`/health` 会报已固定与未固定的数量，启动日志里也会提醒。

### 3.4 Notifier（通知）

服务方得知道自己接到单了，陪审员得知道有争议开庭了。

**但这件事链本身就能做**：Agent 可以用 WebSocket RPC 订阅 `OrderCreated`
并按自己的地址过滤，完全不需要我们。

所以 Notifier 是**可选的便利层**，优先级最低。它只服务于那些不想自己跑订阅的轻客户端。

### 3.5 Agent Skill（工具面）

这是让宣言里那段话成真的部件。

| 工具 | 作用 |
|---|---|
| `search_capabilities` | 按能力、价格、信誉检索挂牌 |
| `inspect_listing` | 拿到规格、输入输出 schema、样例输出、服务方信誉 |
| `prepare_order` | 校验输入是否符合 schema，**返回未签名交易** |
| `check_task` | 查任务状态与剩余时限 |
| `fetch_deliverable` | 取回交付物并按 output schema 校验 |
| `prepare_vote` | 陪审投票，同样只返回未签名交易 |

**每一个写操作都止步于「构造交易」。**签名、确认、广播全部在用户自己的钱包里完成。

### 实现：不重造签名，交给 `baw`

读过币安 `binance-agentic-wallet` 的 SKILL 之后，有一个关键发现：
**它已经有 `contract-call preview` → 用户确认 → `execute` 这套流程**，
而且会把 `parsedTx`、`risks`、`authorityChanges` 摆出来给用户看。

所以我们不该重造签名，只负责**发现、校验、构造 calldata**，
然后把 `baw contract-call preview` 命令交出去。

这个分工天然满足红线：确认环节由 `baw` 拥有，我们**在结构上**就没有
绕过它的能力。比在提示词里写一句「记得让用户确认」可靠得多——
`lib/agentry/calldata.js` 里根本不存在任何签名或广播函数，有测试扫 ABI 守着这一点。

### 两个必须提前查的前置

币安的参考实现特意强调：**在构造 calldata 之前**就要查 Developer Mode，
否则用户会在最后一步才发现走不通。我们照做，并加上 Agent ID 检查：

| 检查 | 命令 |
|---|---|
| 持有 Agent ID | `baw wallet agent-id` |
| Developer Mode 已开 | `baw wallet settings --json` |

两者都只能在币安 App 内处理，CLI 改不了。

### 原生币与 ERC-20 的差别被吸收在构造器里

- **BNB** → 一步，`value` 带上金额
- **ERC-20** → 两步，先 `approve` **精确金额**再调用，`value` 必须为 0

调用方不需要自己判断。`approve` 的额度严格等于本次金额，
**绝不授权无限额**——有专门的测试守着这条红线。

---

## 4. Capability Spec v1：把规格从「人读」升级成「机器可调用」

这是整份设计里最实质的一处改动。

现在的 Task Spec 是 `goal` / `deliveryFormat` / `acceptanceCriteria` 三段自由文本，
人能读，Agent 不能。要让 Agent 自动下单，规格必须同时是一份**接口定义**。

```json
{
  "version": 1,
  "capability": "contract.audit.owner-privileges",
  "title": "BSC 合约 owner 权限审查",
  "summary": "列出合约全部特权函数并评级风险",

  "input": {
    "type": "object",
    "required": ["address", "chainId"],
    "properties": {
      "address": { "type": "string", "pattern": "^0x[a-fA-F0-9]{40}$" },
      "chainId": { "type": "integer", "enum": [56] }
    }
  },

  "output": {
    "type": "object",
    "required": ["privilegedFunctions", "riskLevel"],
    "properties": {
      "privilegedFunctions": {
        "type": "array",
        "items": {
          "type": "object",
          "required": ["name", "canAffectUserAssets"],
          "properties": {
            "name": { "type": "string" },
            "canAffectUserAssets": { "type": "boolean" },
            "note": { "type": "string" }
          }
        }
      },
      "riskLevel": { "type": "string", "enum": ["low", "medium", "high"] }
    }
  },

  "acceptanceCriteria": [
    "覆盖合约中全部 onlyOwner 修饰的函数，无遗漏",
    "每一项标注是否可影响用户资产",
    "给出总体风险等级与依据"
  ],
  "rejections": ["仅复制粘贴源码而无分析"],

  "turnaround": 86400,
  "samples": ["ipfs://bafy…"]
}
```

四个新字段各自解决一个问题：

| 字段 | 解决什么 |
|---|---|
| `capability` | 「自动寻找最合适的 Agent」需要稳定的能力标识，关键词检索不够 |
| `input` | 买方 Agent 能程序化构造参数，付钱前就能校验合法性 |
| `output` | 卖方 Agent 知道该交什么；买方 Agent 能解析结果塞回自己的工作流 |
| `samples` | 「评估能力」——付钱前先看样例输出 |

### 意外收获：争议裁决多了一道客观前置

`output` 是声明在链上（哈希）的。所以在陪审团看之前，**任何人都可以跑一次 schema 校验**：

- 交付物不符合声明的 output schema → 这是一个**事实**，不是品味
- 符合 schema 但质量有争议 → 这才需要陪审团的判断

这把裁决拆成了两段：结构合规性机器判，内容质量人判。
陪审团只需要处理后一半，判决会稳定得多。

### 能力分类法

`capability` 取点分命名空间，例如 `contract.audit.owner-privileges`、
`data.collect.onchain`、`token.research.diligence`。

分类表就是 `lib/spec/capabilities.json`，谁要加新的就提 PR。
不需要治理，不需要投票，不需要合约。**先用最笨的方式跑起来，有人用了再说。**

**表外的能力标识只给警告，不拒绝。**挡住表外能力等于我们在预设分类，
那和「挂牌即模板、分类由市场自己长出来」是矛盾的。分类表是发现层的便利设施，
不是准入门槛。

### Schema 方言：受限子集，零依赖

`input` / `output` **不用完整的 JSON Schema，用一个受限子集**，实现在
`lib/spec/index.js`。

只支持：`type`（object / array / string / number / integer / boolean）、
`enum`、`required`、`properties`、`additionalProperties`、`items`、
`minItems` / `maxItems`、`pattern`、`minLength` / `maxLength`、
`minimum` / `maximum`、`description`，外加四个本领域的 `format`
（`address` / `txhash` / `uri` / `date-time`）。

**不支持 `$ref`、`oneOf`、`anyOf`、`allOf`、`not`。**

三个理由：

1. **互操作**。这份格式要让各种语言写的 Agent 都能正确实现。
   小而所有人都实现对，胜过大而各家实现不一样
2. **安全**。不编译任意用户提供的 schema，不解析远程 `$ref`，
   `pattern` 有长度上限，嵌套有深度上限
3. **零依赖**。Node、浏览器、任意 Skill 运行时跑的是同一份代码，
   不需要打包，不需要 ajv

**遇到不支持的关键字直接报错，绝不静默忽略。**静默忽略会让人以为
`oneOf` 生效了而实际没有——那比报错危险得多。

### specHash 怎么算

JSON 没有规范形式：键序、空白、转义都可能变，IPFS 网关和 CDN 还可能
重新编码。但买方、卖方、陪审团三方必须算出同一个哈希，否则
「我读到的标准就是下单时锁定的那份」无法验证。

所以：**先规范化再哈希**，规则对齐 RFC 8785——
对象键按 UTF-16 码元升序、无多余空白、数字用 ECMAScript 的
`Number::toString`、字符串用 JSON 最短转义。

```js
specHash = keccak256(utf8(canonicalize(doc)))
```

---

## 5. 差异化：人头加权的发现层

这一节是我们和 OKX 真正分开的地方，也是后端能做而他们结构上做不到的事。

所有现存平台的排序信号都是**钱加权**的：交易额、GMV、累计流水。这些可以用钱伪造——
自己左手倒右手，刷出漂亮的数字。

Agent ID 一个 KYC 一枚、不可转让，所以我们可以算一个别人算不出来的指标：

```
distinctClients   有多少个不同的真人买过这个服务
distinctJurors    有多少个不同的真人为这个服务方的争议投过票
repeatRate        回头客比例
```

**`distinctClients = 47` 这句话没法用钱伪造。**要刷到 47，得搞到 47 个真人 KYC。

所以 Discovery API 的默认排序是**按人头**，不是按交易额。这既是功能，也是叙事：
整个项目的论点在发现层又兑现了一次。

---

## 6. 三周怎么切

距离 12 月 9 日还有 20 天，合约和测试已经完成。后端要按「不做会死」排序。

| 优先级 | 组件 | 理由 |
|---|---|---|
| ~~P0~~ | ~~Capability Spec v1 + 校验器~~ | ✅ **已完成**，`lib/spec/`，42 个测试 |
| ~~P0~~ | ~~Content 服务~~ | ✅ **已完成**，`server/`，37 个测试（含 IPFS 固定与 CID 校验） |
| ~~P1~~ | ~~Agent Skill~~ | ✅ **已完成**，`skills/agentry/` + `bin/agentry.js` + `lib/agentry/`，23 个测试 |
| **P2** | Indexer + Discovery API | 挂牌几十个时前端直接扫链就够。数量起来了再做 |
| **P3** | Notifier | 链上 WS 订阅已经能顶替，纯便利 |

**P2 可以先不做。**前端用 `listingCount()` 配 `getListing(i)` 循环，几十条毫无压力。
提前建索引器是典型的过早优化，三周里这个时间花不起。

---

## 7. 明确不做什么

| 不做 | 理由 |
|---|---|
| 托管私钥 / 代用户下单 | 红线，而且违背整个设计 |
| 后端撮合与定价 | 价格由服务方挂牌决定，链上成交。后端插手就成了中心化交易所 |
| 把索引器当真相源 | 它是纯派生的。任何「只有后端知道」的状态都是架构错误 |
| 自建存储替代 IPFS | 内容必须在我们之外也能取到，否则陪审团依赖我们活着 |
| 代币激励 / 积分 | 不承诺收益是红线，也不需要 |

---

## 8. 技术选型（待定）

| 组件 | 选型 | 说明 |
|---|---|---|
| 规格校验 | **零依赖，自实现受限方言** | 已完成。不用 ajv：互操作、安全、三端同码 |
| 运行时 | Node.js | 和合约工具链同栈，ethers 直接复用 |
| 索引 | ethers + SQLite | 几十万条事件以内 SQLite 足够，部署简单 |
| 内容 | IPFS（Pinata 或自托管 kubo） | 内容寻址，哈希能和链上对上 |
| Skill | 遵循币安 Skill Hub 规范 | 公告给了 binance-skills-hub 的参考实现 |

### 待接的集成点

`lib/spec/index.js` 是 UMD，Node 与浏览器都能直接用。但前端静态站只服务
`web/` 目录，取不到 `lib/`。等发布表单做出来时需要一个同步步骤
（复制到 `web/assets/spec.js`），或者把静态站根目录调整一下。
**不要在两处各维护一份，会漂。**

Skill 的具体规范还没读，写之前要先看
`github.com/binance/binance-skills-hub` 下 `binance-agentic-wallet` 的实现。
