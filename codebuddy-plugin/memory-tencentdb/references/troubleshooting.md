# 故障排查（memory-tencentdb CodeBuddy Skill）

> 约定：以下 `CTL` 指 `scripts/memory-tencentdb-ctl.sh`（仓库内或 `.gateway-ctl-path` 记录的路径）。

## 快速诊断三连

```bash
bash scripts/gateway-up.sh                      # 1. 确保 Gateway 在线
node scripts/memory-client.mjs health           # 2. ok / degraded / down
bash $CTL config show                           # 3. 看配置（已脱敏）
```

---

## 1. Gateway 起不来 / `gateway-up.sh` 报错

**现象**：`gateway-up.sh` 退出非 0，提示「启动后仍未通过健康检查」或「找不到 memory-tencentdb-ctl.sh」。

排查：

1. **找不到 ctl.sh**：设环境变量指向它，或重新运行安装脚本（会写 `.gateway-ctl-path`）：
   ```bash
   export MEMORY_TENCENTDB_CTL=/abs/path/to/scripts/memory-tencentdb-ctl.sh
   ```
2. **看启动日志**：
   ```bash
   bash $CTL logs err 200
   ```
3. **依赖缺失**：Gateway 由 `npx tsx src/gateway/server.ts` 拉起，需要 `node >= 22.16` 与 `npx`。
   ```bash
   node -v && command -v npx
   ```
4. **端口被占**：见第 5 节。

---

## 2. health 返回 `degraded`

`degraded` = HTTP 服务在线，但**向量库 / embedding 不可用**（`/health` 的 `stores.vectorStore` 为 false）。

- 记忆仍能存（L0），但语义召回会退化。
- 通常是 **Embedding 未配置** 或 **PG `vector` 扩展缺失**：
  ```bash
  bash $CTL config embedding --provider openai --base-url <U> --api-key <K> \
       --model <M> --dimensions <D> --restart
  ```
  并确认 PG 已 `CREATE EXTENSION vector;`（见 `configuration.md` 第 2 节）。

---

## 3. health=ok 但召回（recall）总是空

可能原因：

1. **记忆库还没数据**：首次使用、或 capture 一直失败。先确认 capture 成功：
   ```bash
   node scripts/memory-client.mjs capture --user "我喜欢 TypeScript" --assistant "已记住" --json
   # 期望 l0_recorded >= 1
   ```
2. **session_key 不一致**：recall 与 capture 必须用同一 `session_key`。检查：
   ```bash
   cat scripts/.session-scope
   ```
   项目级安装下，换了工作区路径会得到不同哈希 → 召回不到旧项目记忆（设计如此）。
3. **LLM 未配置**：L0 不会提炼成 L1 结构化记忆，召回质量低。配 `config llm`。
4. **超时太短**：recall 默认 3s，PG/embedding 慢时可临时放宽：
   ```bash
   node scripts/memory-client.mjs recall --query "..." --timeout 8000
   ```

---

## 4. PostgreSQL 相关

| 现象 | 排查 |
|------|------|
| 启动日志报 `CREATE EXTENSION ... permission denied` | DB 用户无建扩展权限；让 DBA 预装 `vector`（见 configuration.md） |
| 向量检索无结果但有数据 | 确认 `vector` 扩展已装、`--dimensions` 与写入时一致；换维度需 reindex |
| 中文检索效果差 | 安装 `pg_jieba` 并 `config postgres --text-config jieba --restart` |
| 连接报错 / 超时 | 核对 `--host/--port/--user/--password/--ssl`；`bash $CTL config show` 查看；用 `psql` 验证连通性 |
| `diskann` 索引未生效 | 需 `vectorscale` 扩展；否则会降级，属正常 |

---

## 5. 端口占用（8420）

```bash
lsof -nP -iTCP:8420 -sTCP:LISTEN          # 看谁在占用
```

- 若是旧的 Gateway 实例 → 直接复用即可（`gateway-up.sh` 会探测到）。
- 若是无关进程 → 换端口：
  ```bash
  export MEMORY_TENCENTDB_GATEWAY_PORT=8421
  export TDAI_GATEWAY_BASE_URL=http://127.0.0.1:8421
  ```
  （客户端与 ctl.sh 都读这些变量。）

---

## 6. 鉴权 401

Gateway 启用了 `TDAI_GATEWAY_API_KEY`，但客户端没带 Bearer。

```bash
export TDAI_GATEWAY_API_KEY='<同 Gateway 的密钥>'
# 或单次：
node scripts/memory-client.mjs recall --query "..." --api-key '<key>'
```

> `GET /health` 永远不需要鉴权；若 health 通过但 recall/capture 401，基本可确定是 Bearer 问题。

---

## 7. capture 很慢

正常。capture 在回答**之后**执行，会触发 L1 提取（调用 LLM）+ 向量写入，耗时可达数秒。它不在用户等待路径上，可容忍。若需排查，看：

```bash
bash $CTL logs all 200
```
