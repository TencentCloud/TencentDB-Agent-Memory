# 自定义上游（Custom Upstream）计量口径说明

> 「这一项」= **instance-upstream 自定义分组（custom group）命中的请求**。
> 本文定义它参与哪些统计/计费环节、计算口径与公式、输入数据来源、边界条件与例外场景，
> 以及在最终输出中如何体现它的贡献。

---

## 1. 结论先行

| 环节 | 是否纳入 | 说明 |
|---|---|---|
| **用量统计**（面板「系统状态 → 用量统计」） | ✅ 完整纳入 | 请求数、5 类 token、等价 Credit 全部可见 |
| **平台计费**（CreditDelta 上报 MemoryPlus） | ❌ **不纳入** | 用户自付，平台不出账 |
| **ClickHouse 用量流水** | 未启用 | 本部署未配置 ClickHouse，故统计走进程内存聚合 |
| **平台账单** | ❌ 不出现 | 与已上报 CreditDelta **不可混加** |

自定义上游的 `base_url` / `api_key` 由用户自备，费用由用户与其自有供应商结算。
平台只提供通道，因此**不出账**——这是 `skipCreditReport = true` 的设计初衷。
但"不出账"不等于"不可见"：这部分流量仍然占用平台的转发与记忆链路，
其用量必须能被看到，否则运维视角里它是一个黑洞。**本改动就是把黑洞点亮。**

---

## 2. 它参与哪些统计/计费环节

### 2.1 纳入：用量统计

- **统计维度**：`spaceId × agent（agent_source）× 分组（group_id / group_name）× model_id`
- **统计指标**：
  - `requests` 请求数
  - `input` / `output` / `cacheRead` / `cacheWrite5m` / `cacheWrite1h` 五类 token
  - `equivalentCredit` 按平台价目表折算的**等价 Credit（参考值）**
  - `unpricedTokens` 价目表未登记、无法折价的 token 量

### 2.2 不纳入：平台计费

命中 custom 组时，`stageCredit` 直接短路，不调用 `tryReportCreditFromPath`，
即 **CreditDelta 不会 POST 到 MemoryPlus**。该笔费用不进任何平台账单。

### 2.3 不纳入：官方通道请求的重复计数

只有 `kind === "override"`（命中 custom 组）的请求才进本统计。
Official / default 组的请求走正常计费链路，不进本统计，避免重复计数。

---

## 3. 计算口径与公式

### 3.1 输入数据来源

| 输入 | 来源 | 说明 |
|---|---|---|
| `usage` | 上游响应体的 usage 对象 | 与计费侧同一份未加工数据 |
| `upstreamUrl` | 实际转发地址 | 用于判定 usage 协议分支 |
| `modelId` | **override 后的**生效 model_id | `row.model_id \|\| 原 modelId` |
| `pricing` | `config.creditPricing` | 价目表，支持热更新 |
| `requestTime` | 请求开始时间 | 用于时段规则判定（北京时间） |
| `spaceId` / `agent` | 请求路径解析 | `/{agent}/{spaceId}/...` |

### 3.2 协议分支（与计费侧完全同口径）

| 判定 | 协议 | 分支要点 |
|---|---|---|
| 路径含 `/v1/messages` | anthropic | `input_tokens` 已扣除缓存 |
| 路径含 `/v1/responses` | responses | `input_tokens` **含**缓存 |
| 其它（含 `/v1/chat/completions`） | openai | `prompt_tokens` **含**缓存 |

### 3.3 Token 五分类

```
nonCacheInput = anthropic ? input_tokens
                          : max(0, input|prompt_tokens − cacheRead)
output        = completion_tokens || output_tokens
cacheRead     = cache_read_input_tokens
              || cache_read_tokens
              || prompt_tokens_details.cached_tokens
              || input_tokens_details.cached_tokens
cacheWrite5m  = cache_creation.ephemeral_5m_input_tokens
                + 无 TTL 明细的 cache_creation_input_tokens 余额
              || cache_write_tokens || prompt_cache_write_tokens
cacheWrite1h  = cache_creation.ephemeral_1h_input_tokens
                （responses / openai 协议无此字段，记 0）
```

### 3.4 等价 Credit 公式

单价 `P` 由三级解析得出：
`价目表匹配(modelId)` → `时段规则(rules, 北京时间, priority 降序)` → `分档(tiers, 判据 totalInput = nonCacheInput + cacheRead)`

```
equivalentCredit =
    (nonCacheInput / 1000) * P.input
  + (output       / 1000) * P.output
  + (cacheRead    / 1000) * P.cacheRead
  + (cacheWrite5m / 1000) * P.cacheWrite5m
  + (cacheWrite1h / 1000) * P.cacheWrite1h
```

> ⚠️ 这是**参考值**，含义是"这笔流量若走平台官方通道要花多少钱"。
> 它是**等价折算**，不是账单金额，绝不可与已上报的 CreditDelta 相加。
> 接口返回的 `billedToPlatform` 恒为 `false`，就是为了防止下游误用。

---

## 4. 边界条件与例外场景

| 编号 | 场景 | 处理 |
|---|---|---|
| E1 | `usage` 为空或空对象 | **不计入**（无用量可计） |
| E2 | `usage` 全为 0（上游未回传） | 计入 `requests`，token 记 0 |
| E3 | `modelId` 未登记价目表 | `equivalentCredit = 0`，token 累加进 `unpricedTokens`，保证"用了多少"不丢 |
| E4 | 流式响应上游未回传 usage（只发 `[DONE]`） | 同 E1，不计入 |
| E5 | 非 custom 组（official / default） | **完全不进本模块**，走正常计费链路，避免重复计数 |
| E6 | dsh headless / auxiliary（count_tokens、embeddings、compaction、title） | 由调用方保证不传，本模块不做二次判定 |
| E7 | 进程重启 | 内存态统计**清零**，不持久化、不参与对账；仅用于可观测 |
| E8 | 维度数量超过 512 | 丢弃最旧维度，防止内存无界增长 |

---

## 5. 在最终结果 / 输出中的体现

1. **面板「系统状态 → 用量统计」**：单独一张卡片，标题写明「自定义上游（用户自付）」，
   展示 totals 六个数字 + 按维度明细表，并输出 `note` 与 `billedToPlatform=false`。
2. **HTTP 接口**：`GET {proxy}/internal/upstream-usage` 返回同样数据（不含任何密钥）。
3. **健康看板**：`proxy_usage` 一项反映该统计链路是否可用。

---

## 6. 代码中「不纳入计算」的标注位置

| 文件 | 位置 | 标注内容 |
|---|---|---|
| `MemoryProxy/src/upstream-usage.ts` | 文件头整段注释 | 完整口径：参与环节、公式、边界 E1–E8 |
| `MemoryProxy/src/pipeline/stages/instance-upstream-override.ts` | `skipCreditReport: true` 返回处 + 接口注释 | 不纳入平台计费，但纳入用量统计 |
| `MemoryProxy/src/pipeline/stages/credit.ts` | `if (input.skipCreditReport)` 分支 | 不调计费上报；改为记录用量统计 |
| `MemoryProxy/src/pipeline/runners/utility.ts` | `if (skipCreditReport)` 分支 | 同上（aux 端点） |
| `MemoryPanel/web/src/pages/SystemStatusPage.tsx` | 页面注释 + UI 文案 | 「不纳入平台计费」「非账单金额」提示 |
| `MemoryPanel/src/panel/http/routes/system.ts` | `/system/usage` 透传 | 原样下发 `note` 与 `billedToPlatform` |

---

## 7. 常见误用（明确禁止）

- ❌ 把 `equivalentCredit` 加进平台账单总额 —— 它是不同口径的折算值。
- ❌ 把自定义上游统计与 ClickHouse 官方通道流水直接相加比较 —— 维度与判定规则不同。
- ❌ 用本统计做对账或结算依据 —— 见 E7，进程重启即清零。
