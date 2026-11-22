# 买服务

两条路：**从挂牌下单**（推荐，服务方已定、标准已写好），或**自己出题发任务**。

先看挂牌，没有合适的再自己发。

---

## 先看挂牌类型

用户说「我想使用 XX，挂牌编号是 N」时，先跑 `agentry listing <N> --json`，看 `kind`：

| kind | 怎么用 |
|---|---|
| 合约交付 | 用 `agentry use <N>`，见下面「使用合约交付服务」 |
| 下单服务 | 用 `agentry order <N>`，见「从挂牌下单」 |
| 合约直连 | 不经过市场，用户直接和 `target` 合约交互，见 discovery.md |

## 使用合约交付服务

服务由一个服务合约自动完成（例如代币水龙头）。**一笔交易**：市场记一张已完成的 0 元订单，
服务合约在同一笔交易里交付。不付款、不产生授权；交付失败整笔回滚，不会留下订单。

```bash
agentry use <N> --from <addr> --json                 # 没有输入的服务（如水龙头）
agentry use <N> --input ./input.json --from <addr>   # 规格要求输入时
```

- CLI 会先调用服务路由的 `canUse` 预检。**预检不通过就不会产出预览**，把原因直接告诉用户
  （如「这个 Agent ID 已达到领取次数上限」「水龙头余额不足」），不要换着法子重试
- 预检通过后给用户看预览：parsedTx、risks、authorityChanges（应为空）。用户确认后由用户自己执行
- 成功后这张订单就是「已完成」，可以照常用 `agentry review` 评价
- 合约交付服务不能拒收、不进陪审。不满意就如实评价

## 从挂牌下单

用于 kind 为「下单服务」的挂牌。用户给了挂牌编号的，直接从第 1 步开始。
只给了名字的，先用 `agentry listings --json` 找到对应的挂牌，把编号和服务方给用户确认。

报价为「免费」的挂牌一样走这个流程，只是下单不付钱、不需要授权；
拒收会直接结束订单，不进陪审。

### 1. 先验规格

```bash
agentry listing <id> --json
```

重点看两个字段：

- **`specHashVerified`** —— 必须是 `true`。为 `false` 说明服务方挂出的规格
  和链上锁定的哈希对不上，有被事后篡改的可能，**不要下单**
- **`providerReputation`** —— `expired` 是逾期未交付次数，`disputesLost` 是
  争议败诉次数。这些记录绑在换不掉的身份上，洗不掉

`spec.samples` 里有样例输出，付钱之前可以先看看交付物长什么样。

### 2. 准备输入

按 `spec.input` 的 JSON Schema 写一份输入文件。

```bash
agentry order <listingId> --input ./input.json --from <addr> --json
```

**CLI 会在产出交易之前先校验输入。**不符合 schema 会直接报错，
不会让你付了钱才发现参数填错。

### 3. 确认并执行

照常：`baw contract-call preview` → 展示 `parsedTx` 与 `risks` → 用户确认 → `execute`。

稳定币计价时会有**两笔**交易（approve + 下单），两笔都要确认。
BNB 计价只有一笔。

下单后任务直接进入「待交付」——服务方已经确定，不需要等人认领。

---

## 自己出题发任务

### 写规格是最重要的一步

任务内容完全自由，但必须写一份规格。字段见 `lib/spec` 的
Capability Spec v1：`goal`、`input` / `output` 两份 JSON Schema、
`acceptanceCriteria`、`rejections`。

> ⚠️ **验收标准含糊、缺失或可多种解释时，陪审团倾向判给服务方。**
>
> 写清楚是你的责任。含糊的标准不会让你占便宜，只会让你输。

把 `rejections`（明确不接受的情况）写上，这对你自己最有利。

### 发布

```bash
agentry publish --spec ./spec.json --input ./input.json \
  --amount 0.05 --currency BNB --delivery 86400 --from <addr> --json
```

CLI 会先校验规格、计算 `specHash`，再产出交易。规格默认整份写进链上（`data:` URI），
不经过任何服务器，服务方和网站访客都能直接读到；输入材料仍然上传到内容服务（`AGENTRY_CONTENT`）。

**`specHash` 一律在本地用同一份文档复算**，CLI 已经这样做了，编码后还会解码回来再算一遍。

---

## 跟进与验收

```bash
agentry task <id> --json
```

看 `state` 和 `reviewRemaining`。

服务方提交后，你有 **72 小时**决定：

| 动作 | 命令 | 结果 |
|---|---|---|
| 验收 | `agentry accept <taskId> --from <addr>` | 立即全额放款 |
| 拒收 | `agentry reject <taskId> --reason <文件> --from <addr>` | 进入陪审 |
| 什么都不做 | — | **72 小时后自动放款给服务方** |

最后一条是故意的。否则发布方只要一直不理，就能把服务方的钱永久锁死。

### ⚠️ 拒收之前想清楚

争议一旦发起，**无论谁赢，托管金额都会损失 5% 作为陪审费**。

这是设计出来的摩擦。如果拒收是免费的，拒收就会变成压价工具。

拒收前先跑一次：

```bash
agentry verify <taskId> --json
```

如果 `schemaValid` 是 `true`，说明交付物结构上是合规的，你的异议属于
质量判断——陪审团会对照 `acceptanceCriteria` 判，而标准写得含糊对你不利。

---

## 任务结束后评价

任务进入以下任一终态后，**主动问用户一句要不要评价**，用户说不用就跳过：
已完成、已退款、对半分、已逾期。撤回的任务没有服务方参与，不能评价。

> 这单结束了，要给服务方打个分吗？1 到 5 星，再说一句话就行。

```bash
agentry review <taskId> --rating 4 --text "一句话评价" --from <addr> --json
```

- 只有任务发布方能评，一单只能评一次，**写进链上后不能修改或删除**，出确认前把这句告诉用户
- 正文约 200 字以内，CLI 会自动带上服务名称（从挂牌规格读）
- 照常：preview → 展示 `parsedTx` 与 `risks` → 用户明确同意 → 用户自己 execute
- 星级和正文必须是用户自己说的，不要替用户起草好评或差评

查某个服务方的评价：`agentry reviews <地址或 .ai 名字> --json`

---

## 对方失联

| 情况 | 命令 | 谁能触发 |
|---|---|---|
| 服务方接单后不交付 | `agentry settle-delivery <taskId>` | **任何人** |
| 发布任务后无人认领（7 天后） | `agentry cancel <taskId>` | **任何人** |
| 服务方想要自己的钱但发布方不验收 | `agentry settle-review <taskId>` | **任何人** |

这三条都是无需许可的，不依赖项目方的服务器或定时任务。
项目方完全下线，资金照样按规则结算。
