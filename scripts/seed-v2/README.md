# seed-v2

> 通过 v2 API 把历史对话灌入 memory-tencentdb gateway。

## 是什么

`seed-v2` 是一个**纯 HTTP 客户端**，把一批历史对话喂给已经在跑的 gateway：

```
fixture.json
   │
   │ HTTP POST /v2/conversation/add  (一轮一次)
   ▼
gateway (standalone or service)
   │
   │ 自动调度 L0 → L1 → L2 → L3
   ▼
本地 vectors.db / records / scene_blocks / persona.md
```

客户端**不 import 任何 plugin 内部模块**，只用 fetch + `/v2/conversation/add` + `/v2/pipeline/status`。

跟老版 `src/cli/commands/seed.ts`（v1，import 核心 runtime 直跑）相比：
- ✅ 同一份代码同时适用于 standalone 和 service 模式
- ✅ 不会和已经在跑的 gateway 抢同一份 SQLite / state
- ✅ 通过 status 接口节流，串行写入 → 等抽取完 → 再写下一批
- ✅ 调度状态由 gateway 侧 `StatefulPipelineManager` 统一管，跟生产路径完全一致

## 调用方式

### 方式 1：通过 npm bin（推荐）

```bash
# 1. 把 gateway 起起来（standalone 用法）
cd extensions/memory-tencentdb/__tests__/standalone && ./start.sh

# 2. 灌数据
cd ../..
npm run seed-v2 -- --input ./scripts/seed-v2/fixtures/minimal.json

# 3. 完事停 gateway
./__tests__/standalone/stop.sh
```

### 方式 2：直接命令

```bash
node ./bin/seed-v2.mjs --input fixture.json --endpoint http://127.0.0.1:18420
```

### 方式 3：一键 wrapper（含起停 + 落盘断言）

```bash
./scripts/seed-v2/seed-v2.sh                         # 默认 fixture
./scripts/seed-v2/seed-v2.sh path/to/my-fixture.json # 自定 fixture
./scripts/seed-v2/seed-v2.sh --keep                  # 跑完不停 gateway
./scripts/seed-v2/seed-v2.sh --no-start              # gateway 已在跑
```

## CLI 参数

| 参数 | 短 | env | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `--input <file>` | `-i` | — | **必填** | fixture JSON 路径 |
| `--endpoint <url>` | `-e` | `SEED_ENDPOINT` | `http://127.0.0.1:18420` | gateway 地址 |
| `--api-key <key>` | — | `SEED_API_KEY` | `standalone-e2e` | Bearer key |
| `--service-id <id>` | `-s` | `SEED_SERVICE_ID` | `default` | `x-tdai-service-id` |
| `--every-n <n>` | `-n` | `SEED_EVERY_N` | 5 | 每 N 轮等一次 L1 idle |
| `--poll-ms <ms>` | — | `SEED_POLL_MS` | 500 | status 轮询间隔 |
| `--stable-rounds <n>` | — | `SEED_STABLE_ROUNDS` | 2 | 连续 N 次 idle 才认为 stable |
| `--max-wait-ms <ms>` | — | `SEED_MAX_WAIT_MS` | 600000 | 每批 wait（L1 only）超时（默认 10 分钟）|
| `--final-max-wait-ms <ms>` | — | `SEED_FINAL_MAX_WAIT_MS` | 600000 | 最终 wait（L1+L2+L3 全 idle）超时（默认 10 分钟）|
| `--no-final-wait` | — | — | false | 写完最后一批不等 cascade |
| `--dry-run` | — | — | false | 只打印计划不实际请求 |
| `--session-key <key>` | — | `SEED_FALLBACK_SESSION_KEY` | — | fallback 给缺 sessionKey 的 session |
| `--strict-round-role` | — | `SEED_STRICT_ROUND_ROLE=1` | false | 每 round 必须含 user+assistant |
| `--no-auto-fill-timestamps` | — | `SEED_AUTO_FILL_TIMESTAMPS=0` | false | 缺 ts 时不自动 fill |
| `--quiet` | `-q` | `SEED_VERBOSE=0` | false | 静默 |
| `--help` | `-h` | — | — | 帮助 |

## Fixture 校验（与 v1 seed 完全对齐）

启动时会做 6 层校验（任一失败 → exit 2，不会浪费时间灌一半才挂）：

| 层 | 检查 |
| --- | --- |
| 1. file | 存在 + 非空 + 合法 JSON |
| 2. top-level | Format A `{ sessions: [...] }` 或 Format B `[...]` |
| 3. session | sessionKey 必须非空字符串 + conversations 必须 2D array |
| 4. round | 必须非空 array；`--strict-round-role` 时还要求 user + assistant 同时存在 |
| 5. message | role/content 非空字符串 + timestamp 类型校验（int 或 ISO string）|
| 6. timestamp consistency | **全有 / 全无 / mixed** 三态：mixed 拒绝；全无时按 `--no-auto-fill-timestamps` 决定行为 |

错误输出示例（mixed timestamps）：

```
$ seed-v2 --input mixed.json
[seed-v2] Seed input validation failed (1 error(s)):
  [timestamp_consistency] Timestamp consistency check failed: some messages have timestamps while others do not. ...
exit code: 2
```

## Timestamp 三态

| 状态 | 行为 |
| --- | --- |
| **全有** | 保留原值，`hasTimestamps=true` |
| **全无 + auto-fill 开**（默认）| `fillTimestamps()` 给全局递增 epoch ms（`Date.now()` 起，每条 +100ms）—— 跨 session 也单调，避免 L0 capture cursor 误过滤 |
| **全无 + `--no-auto-fill-timestamps`** | timestamp=0；写入时 client 用 `Date.now()` 兜底 |
| **mixed** | exit 2，明确报错 |

## Fixture 格式

兼容老 seed Format A（`{ sessions: [...] }`）和 Format B（顶层数组）：

```jsonc
{
  "sessions": [
    {
      "sessionKey": "user-001",
      "sessionId": "user-001",          // 可选，缺省 = sessionKey
      "conversations": [                // rounds
        [                                // round 0：一组消息
          { "role": "user",      "content": "..." },
          { "role": "assistant", "content": "..." }
        ],
        [ /* round 1 ... */ ]
      ]
    }
  ]
}
```

参考最小示例：[`fixtures/minimal.json`](./fixtures/minimal.json)（2 session × 6 round = 24 messages）。

## 阻塞节奏（重要）

完全对齐老 `src/core/seed/seed-runtime.ts:executeSeed`：

```
for session, round:
  POST /v2/conversation/add { session_id, messages }   # 立刻返回
  if (round + 1) % every_n == 0:
    waitForL1Idle  (stable 2 polls)                    # 只等 L1，L2/L3 后台异步跑
end-of-session: waitForL1Idle                          # 末尾再等一次
final: waitForL1Idle                                   # 写完所有 round 后再等 L1 drain
```

`/v2/pipeline/status` 按 L 分桶返回 `{ l1: {idle,…}, l2: {…}, l3: {…} }`。seed-v2 **只看 `data.l1.idle`**：

- `l1.idle = (l1.queued === 0 && l1.running === 0)` — 跟老 v1 `seed-runtime.waitForL1Idle` 完全对齐
- L2/L3 抽取慢（cascade 一次 LLM 工具链可能 3-5 分钟）→ **不会**阻塞 seed 的下一批 dispatch
- L2 LLM timeout / lock-conflict drop 等异常情况 → **不会**让 `l1.idle` 误判 false（之前用单标量 `busy` 时会被这两个 bug 污染）

详见 [`docs/plans/server/14-pipeline-status-api.md`](../../docs/plans/server/14-pipeline-status-api.md)。

## Pipeline 调参（服务端 yaml）

灌入速度由**两侧**共同决定：seed 客户端的 wait 节奏 + gateway 流水线的触发节奏。客户端参数已在上面 [CLI 参数](#cli-参数) 表里，下面是**服务端**对应的 `tdai-gateway.standalone.yaml` 配置项（标星号的最常调）：

```yaml
memory:
  capture:
    enabled: true                    # L0 capture 开关，必须 true 否则没数据进流水线

  extraction:
    enabled: true
    enableDedup: true                # L1 抽取后去重（vector recall topK=5）；关掉提速但可能产生重复 record
    maxMemoriesPerSession: 20      # ★ 单 session L1 抽取的 atomic memory 数上限

  persona:
    triggerEveryN: 50              # ★ 每抽取 N 条 L1 record 触发 1 次 L3 persona-gen
    maxScenes: 15                   # L2 scene 数上限（达到后停止 CREATE 新 scene）

  pipeline:
    everyNConversations: 5         # ★★★ 每 N 轮对话触发 1 次 L1 抽取（必须跟 seed 客户端 --every-n 对齐）
    enableWarmup: true              # 冷启动前几次更快触发 L1（让 persona.md 早点形成骨架）
    l1IdleTimeoutSeconds: 600      # ★ session 空闲 N 秒后强制触发 L1（兜底，防 conversation < everyN 时 L1 永不抽）
    l2DelayAfterL1Seconds: 90      # ★★ L1 完成后延迟 N 秒触发 L2（避免每条 L1 都触发一次 L2，太碎）
    l2MinIntervalSeconds: 900      # ★★ 同 session 两次 L2 之间最小间隔（节流，防 L2 LLM 调用过频）
    l2MaxIntervalSeconds: 3600     # ★ 同 session L2 最大间隔（兜底，无论间隔多久必跑一次）
```

### 怎么调：常见场景

| 场景 | 怎么调 |
| --- | --- |
| **seed 灌入想最快**（接受 L1 粒度粗）| `everyNConversations: 20`（每 20 轮才抽一次 L1）+ seed `--every-n 20` 对齐 |
| **seed 灌入想 L1 立即抽**（每轮都抽，最细粒度但贵）| `everyNConversations: 1` + seed `--every-n 1` |
| **fixture 是短对话**（< everyN 轮）触发不到 L1 | 缩 `l1IdleTimeoutSeconds: 60`（1分钟无新消息就触发兜底）|
| **L2 cascade 太频繁**（cost 高）| 拉大 `l2MinIntervalSeconds: 1800`（30 分钟才一次）|
| **L2 cascade 太稀疏** | 缩 `l2DelayAfterL1Seconds: 30` + `l2MinIntervalSeconds: 300` |
| **测试/调试想看快速反馈** | `triggerEveryN: 10` + `everyNConversations: 2` + `l1IdleTimeoutSeconds: 30` |

### seed 客户端 vs 服务端的对应

| seed 参数 | 服务端 yaml 对应 | 是否需对齐 |
| --- | --- | --- |
| `--every-n` (`SEED_EVERY_N`) | `pipeline.everyNConversations` | ⚠️ **建议一致**（客户端 wait 间隔 = 服务端触发间隔，灌入流畅）|
| `--max-wait-ms` | `pipeline.l1IdleTimeoutSeconds` | wait 时长应 ≥ idle timeout（否则会 max-wait-reach 而不是 stable-idle）|
| `--final-max-wait-ms` | 综合 L2 慢 task 时长 | ≥ p95(L2 LLM duration) × maxScenes/(同时抽的 scene 数)（默认 10 分钟够大多数场景）|
| `--stable-rounds` | — | 客户端独有，控制连续多少次 idle 才认定真稳定 |

### 调参对 seed 总耗时的影响（粗估）

| 配置 | persona-0（10 sessions × 366 msgs）耗时 |
| --- | --- |
| 默认（`everyNConversations=5`，`l2DelayAfterL1=90s`，`l2MinInterval=900s`）| ~90 min（实测 persona-0）|
| 降本：`everyNConversations=20`，`l2MinInterval=3600s` | ~30-50 min（L1 抽得粗，L2 抽得少）|
| 极速：`--no-final-wait` + 仅 L0 模式（`extraction.enabled=false`）| ~1-2 min（只灌 L0，不抽取）|

> ⚠️ **改 yaml 后必须重启 gateway**（`scripts/seed-v2/seed-v2.sh` 自动起停；如果用 `start.sh` 手动起的需 `stop.sh && start.sh`）。

## 退出码

| code | 含义 |
| --- | --- |
| 0 | 全部成功 |
| 1 | seed 失败（写入或 wait 异常）|
| 2 | 前置条件不满足（fixture 缺失 / gateway 不通 / 配置错误）|

## 构建 + 发布

```bash
npm run build:seed-v2     # tsc 编译到 scripts/seed-v2/dist/
npm run build:scripts     # 构建所有 scripts（含 seed-v2）
```

`bin/seed-v2.mjs` 是薄启动器：dist 存在就跑 dist，否则 fallback 到 `tsx` 跑源码。开发期不需要先 build。
