# Claude Code 会话初始化 CLI

复用已经配置好的 Claude Code，在终端选择 Team、Agent 和可选 Task，再启动新会话。界面支持方向键、Enter 确认和 Esc 取消；`--plain` 使用编号选择，适用于屏幕阅读器。

```bash
node agents/session-init.mjs
node agents/session-init.mjs --panel http://127.0.0.1:8125 --model <模型名>
node agents/session-init.mjs --plain
node --test agents/session-init.test.mjs
```

要求 Node.js 22.16+，`claude` 在 PATH 中。首次客户端接入仍使用已有的 `agents/setup-proxy.sh`。本入口不部署服务、不管理模型供应商，也不保存项目默认绑定。

## 配置与行为

- 默认读取 `~/.claude/settings.json`，支持 `CLAUDE_CONFIG_DIR` 或 `--settings FILE`。需要已有 `env.ANTHROPIC_BASE_URL`（`/claude-code/<实例>`）和 User Key（`ANTHROPIC_AUTH_TOKEN` 或 `ANTHROPIC_API_KEY`）。不读取 OAuth 凭据或执行 apiKeyHelper。
- Panel 后端地址默认 `http://127.0.0.1:8125`，通过 `--panel` 或 `TDAI_PANEL_URL` 修改。务必使用自己信任的服务地址，认证和目录请求会向该服务发送 User Key。
- 使用现有 Panel `auth/verify`、`team/list`、`agent/list`、`task/list` 接口。只查询已选团队的 Agent / Task，列表按 offset 分页；无团队或 Agent 时提示去面板准备资产。
- 通过 Claude Code 的会话临时 settings 和 `ANTHROPIC_CUSTOM_HEADERS` 传递身份。复用 Proxy 的 `headerAutoSelect` 校验和注册，不新增服务接口。
- Proxy 须开启 `sessionInit.enabled`、`sessionInit.headerAutoSelect.enabled`，使用默认 `x-team-id`、`x-agent-id`、`x-task-id` 名称。关闭预选时仍可能出现原生表单；CLI 的“准备就绪”不代表服务已绑定成功。
- “不关联任务”不发送 `x-task-id`，也不发送 `default` / `no-task` 虚拟值。它仍关联团队和 Agent，并非跳过全部记忆。
- Proxy 需要支持仅凭 Team + Agent 完成 header 预选。旧镜像可能仍要求 Task，导致再次弹出表单；本文验证使用 `c387ea4` 的 Proxy 源码，不能仅凭镜像的 `latest` 标签判断兼容性。
- 每次启动新会话，由 Claude 生成 session ID。清除继承的身份和固定 session header；其他自定义 header 保留。此入口不恢复既有会话。
- `--model` 只选择当前会话主模型，须与 Proxy 已配置的上游兼容，不会替换 Proxy 上游、辅助模型别名或服务端抽取模型。未指定时沿用配置。
- `--prompt TEXT` 可附带初始问题。客户端参数不任意透传，避免恢复旧会话时混用新身份。
- 临时配置目录私有，文件权限 `0600`；客户端退出或启动失败后清理，不修改原始 settings 或 CC Switch。强制终止整个进程组可能留下临时目录，需要用户自行清理。

## 验证边界

CLI 完成的是预选和启动；实际权限、身份绑定和注入由现有服务负责。模型能回答不等于已使用记忆，请结合会话日志和实际检索结果验证。真实客户端记录及分阶段界面见[验证附件](evidence/session-init/verification.md)。
