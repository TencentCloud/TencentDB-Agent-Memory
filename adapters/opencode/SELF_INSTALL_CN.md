# OpenCode 源码自动安装任务书

本文件只给 OpenCode 模型读取和执行。用户已经按照 `USER_GUIDE_CN.md` 创建并填写 `MemoryCore/.env.opencode.local`。你必须直接执行安装，不要把命令重新交给用户手动运行。

## 安全边界

- 先运行 `git status --short`，记录但不得清理、重置、覆盖或提交已有修改。
- 不得显示、复制或要求用户发送 `.env.opencode.local` 的内容或任何 Key。
- 不得使用尚未发布的 `npx @tencentdb-agent-memory/opencode-adapter`，不得运行 `npm pack` 或生成 `.tgz`。
- 不得结束未知进程；不得改动用户现有的其他 OpenCode 插件。
- 安装脚本是本任务的唯一实现来源。不要把脚本内容重写成临时 PowerShell，也不要自行生成 Gateway YAML、PID 文件或加载器。

## 1. 定位仓库

定位同时包含以下文件的仓库根目录，并保存为绝对路径 `$repo`：

```text
MemoryCore/package.json
adapters/opencode/package.json
adapters/opencode/scripts/install-from-source.ps1
```

确认私密配置存在且被 Git 忽略：

```powershell
Test-Path (Join-Path $repo 'MemoryCore\.env.opencode.local')
git -C $repo check-ignore --quiet --no-index -- MemoryCore/.env.opencode.local
if ($LASTEXITCODE -ne 0) { throw '.env.opencode.local is not ignored by Git' }
```

只报告“文件存在、已忽略”，不得读取或输出文件内容。

## 2. 执行唯一安装命令

在一次 Shell 工具调用中执行：

```powershell
& (Join-Path $repo 'adapters\opencode\scripts\install-from-source.ps1') -RepoRoot $repo
```

允许最长 15 分钟完成首次依赖安装、Gateway 启动和适配器测试。脚本会自行：

1. 静默解析并校验 `.env`；
2. 生成不含真实 Key 的私有 Gateway 运行配置；
3. 启动并确认目标端口的真实所有者后才记录 PID；
4. 运行适配器 typecheck、测试和 build；
5. 在 `XDG_CONFIG_HOME`（如已设置）或用户全局 OpenCode 配置目录中创建源码加载器；
6. 返回不含密钥的 JSON 结果。

若脚本失败，报告其脱敏错误并停止。不得绕过失败步骤、不得重复启动 Gateway、不得手工“修好”后声称脚本通过。修改说明或脚本后，必须从干净的隔离目录重新执行验收。

## 3. 安装后核验

只有脚本退出码为 `0` 且 JSON 中 `installed` 为 `true`，才继续：

```powershell
$endpoint = 'http://127.0.0.1:<脚本返回端口>'
Invoke-RestMethod "$endpoint/health" -TimeoutSec 5
git -C $repo status --short
```

逐项确认：

- `/health` 返回 HTTP 200；没有 Embedding 时 `degraded` 是正常状态，不表示请求超时。
- JSON 中的 Gateway PID 是目标端口当前监听者。
- 数据文件只出现在脚本返回的 `dataDir`。
- 加载器直接引用本仓库的 `adapters/opencode/dist/index.js`。
- 私密 OpenCode JSON 不包含 `TDAI_LLM_*`、`TDAI_EMBEDDING_*` 或模型 Key。
- `.env.opencode.local`、`.opencode-runtime` 和独立数据目录均未进入 Git。
- 用户原有修改没有被删除或覆盖。

## 4. 交付

报告脚本返回的 endpoint、健康状态、加载器路径以及 L0、L1、Embedding、Skill 的启用状态，不得输出 Key。然后要求用户完全退出并重新打开 OpenCode，并发送：

```text
请调用 tdai_memory_status 工具，不要解释名称，不要使用 Shell，只返回工具结果。
```

## 完成标准

- 安装脚本退出码 `0`，适配器全部测试通过。
- Gateway 健康端点可达，PID 与端口所有者一致。
- OpenCode 源码加载器和私密插件配置正确生成，无 npm 发布包或 `.tgz`。
- 所有密钥均未进入聊天、命令参数、日志、OpenCode 配置或 Git 跟踪文件。
- 未覆盖用户修改、其他插件或未知进程。
