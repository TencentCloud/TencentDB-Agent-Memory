# Fix Notes — session-init form artifacts 400 (DeepSeek thinking)

**Status**: 已修复并验证（2026-08-12），改动已 `docker cp` 进运行中 `tdai-proxy` 容器。

## 问题

代理 sessionInit 在首次请求时伪造 `AskUserQuestion`（id `toolu_cc_session_init_*`）消息，用户回答后这段
**无 thinking 签名的合成消息被原样转发给上游**（DeepSeek thinking 模式）。DeepSeek 校验 assistant 消息
thinking 签名真实性，合成消息无签名 → **400**：`The content[].thinking in the thinking mode must be passed back to the API.`

触发窗口：仅首次请求（回答后下一条真实回复带有效签名压上去，历史合成消息不再触发校验）。
答"是"（关联资产）路径 `init.ts` auto-register（单 team）必挂；答"否"（bypass）也受影响。

## 修复

3 个源码文件 + 1 个测试：

| 文件 | 改动 |
|------|------|
| `src/session/claude-code/form.ts` | 新增 `stripSessionInitArtifacts()`：剥离合成 form 消息（assistant 含 init tool_use 整条删；user 含 init tool_result 的 block 删，保留真实文本；其余原样） |
| `src/session/claude-code/init.ts` | `stripped = stripSessionInitArtifacts(messages)`（原 `= messages`） |
| `src/anthropicHandler.ts` | 转发前兜底剥离（injection 之后、`resolveForwardTarget` 之前），覆盖 bypass/未拦截/fork/sidequery |
| `src/session/claude-code/__tests__/form.test.ts` | 6 个回归测试 |

## 验证

- 单元测试 `npm test`：**6/6 PASS**（含真实 thinking+tool_use 保留、混合会话、identity）
- tsc 无新增错误（6 个既有错误全在未触碰文件）
- 端到端（本机 `<proxy-host>:8096`）：
  - Step 1 新会话触发 form：✅
  - Step 2 答"是"：**200**（修复前必 400）
  - Step 3 历史含 form 对 + 续聊：✅ 200

## 部署（重要）

镜像用 **tsx 直接执行 TypeScript，不预编译**，所以运行中的容器只需 `docker cp` 3 个文件 + restart：

```bash
cd MemoryProxy
docker cp src/session/claude-code/form.ts        tdai-proxy:/app/src/session/claude-code/form.ts
docker cp src/session/claude-code/init.ts        tdai-proxy:/app/src/session/claude-code/init.ts
docker cp src/anthropicHandler.ts                tdai-proxy:/app/src/anthropicHandler.ts
docker restart tdai-proxy
```

⚠️ **容器重建会丢**：`docker rm` 或下次 `start-all.sh`（重新 `docker run` 拉旧镜像）后需重新应用，
或重建镜像固化（`docker build` 直连 docker.io 超时，需先配 registry-mirrors）。
