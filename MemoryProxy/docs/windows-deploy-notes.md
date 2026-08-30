# Windows 部署实战笔记（2026-08-30，问题 → 根因 → 修复）

> 记录本次在真实 Windows 环境（Docker Desktop + Git Bash + 多盘符迁移）中遇到并解决的
> 部署/运维问题。每条按「症状 / 根因 / 修复 / 验证」组织，便于对照排查。

## 1. 容器挂载的源码 ≠ 工作区副本（改错地方的经典坑）

**症状**：在 `C:\Users\CJL\Documents\ChatGPT\腾讯犀牛鸟\TencentDB-Agent-Memory` 改了
MemoryProxy 源码，重启容器后行为没变化；`docker logs` 里也没有新日志。

**根因**：`tdai-proxy` 容器实际挂载的是另一份源码：

```text
/c/Users/CJL/Documents/trae_projects/tencent/TencentDB-Agent-Memory-feat-server_team/MemoryProxy/src → /app/src
```

工作区那份只是未挂载的副本；改副本等于没改。

**修复**：先查挂载再动手——

```bash
docker inspect tdai-proxy --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'
```

确认 `src` 挂载点后，编辑挂载指向的路径。

**验证**：改完重启容器，`docker logs tdai-proxy` 出现新日志/新行为。

## 2. 改源码后必须 `docker restart` 才生效（tsx 非热更）

**症状**：改完 `handler.ts` 立刻发请求，`[session-auto]` 新日志不出现。

**根因**：容器用 tsx 直跑 TS，但只在进程启动时读源码，不监听文件变更；若修改发生在
上次重启之后，运行中的进程仍是旧代码。

**修复**：每次改 `MemoryProxy/src` 后重启容器：`docker restart tdai-proxy`。

**验证**：重启后日志出现新代码的标记行。

## 3. 切上游时模型名被定价表改写（DeepSeek → glm-4.5-air）

**症状**：把 codex 上游切到 DeepSeek 后，转发请求报错：
`The supported API model names are deepseek-v4-pro, deepseek-v4-flash... but you passed glm-4.5-air`。

**根因**：`creditPricing.models` 的别名表把所有客户端模型名（含 `deepseek-v4-flash`）
统一改写为 `name = PROXY_UPSTREAM_MODEL`（默认 `glm-4.5-air`）；`resolveModelId` 取
**第一条** `modelName` 命中的 entry，所以 DeepSeek 收到的模型名变成了 glm-4.5-air。

**修复**：在 `creditPricing.models` **最前面**插入恒等条目：

```yaml
creditPricing:
  models:
    - name: "deepseek-v4-flash"
      modelName: "deepseek-v4-flash"
```

让 `deepseek-v4-flash → deepseek-v4-flash` 先命中。

**验证**：重启后按该模型名请求，上游收到正确模型名。

## 4. config.yaml 由 start-proxy.sh 自动生成，手改会被覆盖

**症状**：手工改 `deploy/global-images/.proxy-config/config.yaml` 生效了，但下次跑
`start-proxy.sh` 后配置还原。

**根因**：config.yaml 头部写明「由 start-proxy.sh 自动生成——每次启动覆盖」；环境变量
（`PROXY_UPSTREAM_URL / PROXY_UPSTREAM_API_KEY / PROXY_UPSTREAM_MODEL`、
`PROXY_RESPONSES_UPSTREAM_*` 等）才是持久配置源。

**修复**：持久改动走 `deploy/global-images/.env` + `start-proxy.sh`；临时排查可直接改
config.yaml 后重启容器，但要意识到会被下次生成覆盖。

**验证**：改 .env → 重跑 start-proxy.sh → 检查生成的 config.yaml。

## 5. Git Bash 里裸 `bash` 解析到 WSL，patch 兜底失败

**症状**：`subprocess.run(["bash", "-lc", "patch -p1 ..."])` 报
`WSL (Relay) ERROR: CreateProcessCommon: execvpe(/bin/bash) failed`。

**根因**：Windows 上裸 `bash` 解析到 WSL 的 shim；本机未安装 WSL 发行版，且 Git Bash 的
`bash.exe` 在独立路径（如 `D:\Git\bin\bash.exe`），不会自动被 PATH 命中。

**修复**：显式使用 Git Bash 完整路径，并让报错优先返回真实原因（git apply 的 stderr），
避免被 WSL 错误掩盖：

```python
GITBASH = r"D:\Git\bin\bash.exe"
subprocess.run([GITBASH, "-lc", "..."])
```

**验证**：patch 兜底不再报 WSL 错误；错误信息能看到 git apply 的真实输出。

## 6. git apply 把「缺末尾换行」的 diff 报成 corrupt patch

**症状**：模型生成的 unified diff 看起来完全合法（hunk 计数也对），但
`git apply` 一律报 `error: corrupt patch at line N`。

**根因**：diff 文件末尾没有 `\n`，git apply 把最后一个 hunk 判为截断；补一个换行后立刻
变成真实的 `patch does not apply`（上下文不匹配）。

**修复**：写 diff 文件时统一补末尾换行：

```python
fh.write(patch_text.replace("\r\n", "\n").rstrip("\n") + "\n")
```

**验证**：报错信息从误导性的 corrupt 变为可定位的 apply 失败。

## 7. Docker Desktop 启动失败：dockerInference socket 残留

**症状**：Docker Desktop 报
`starting services: initializing Inference manager: listening on unix://.../dockerInference:
remove ...: The file cannot be accessed by the system`；从命令行起不来，但从桌面图标点开
却能正常启动。

**根因**：上次异常退出残留的 unix socket 文件/命名管道未被清理，Inference manager 初始化
时无法删除旧监听点；桌面端启动路径与命令行不一致（配置/工作目录不同）。

**修复**：
1. 先确认没有残留 Docker 进程（`tasklist | findstr docker` / `Get-Process docker*`）；
2. 清理 `%LOCALAPPDATA%\Docker\run` 下的残留 socket/pipe（确认无进程占用后）；
3. 优先用 Docker Desktop 正常启动；若 CLI 启动失败，检查是否用了不同的配置/代理。

**验证**：`docker ps` 正常列出容器，Inference manager 不再报错。

## 8. C 盘 → D 盘迁移后，自启动/服务路径失效

**症状**：把文件从 C 盘挪到 D 盘后，重启电脑提示找不到
`C:\CJL\openclaw\gateway` 之类的路径，服务/自启动项起不来。

**根因**：Windows 自启动（注册表 Run / 启动文件夹 / 服务）里写死了旧 C 盘绝对路径；
文件移动后路径失效。

**修复**：
1. 用 `reg query HKCU\Software\Microsoft\Windows\CurrentVersion\Run`（及 HKLM）和
   启动文件夹 `shell:startup` 找出自启动项；
2. 把路径改成新盘符（或改用环境变量/相对定位脚本）；
3. 服务类用 `sc qc <name>` 查看 `BINARY_PATH_NAME` 并修正。

**验证**：重启后服务自动拉起，`docker ps` / 端口监听正常。

## 9. 定位端口归属的容器（权限受限环境）

**症状**：想知道 8096 是谁在监听；`Get-NetTCPConnection` / `Get-CimInstance` 在某些受限
环境被拒（拒绝访问）。

**修复**：用 `netstat -ano | findstr :8096` 拿 PID，再
`tasklist /FI "PID eq <pid>"` 看进程名（如 `com.docker.backend`），最后
`docker ps` 按端口映射定位容器。

**验证**：能确定端口 → 容器 → 挂载源码的完整链路。

## 10. Python 3.14 下 `requests` 报 `No module named 'cgi'`

**症状**：评测/运维脚本用 `requests` 时在 Python 3.14 报
`ModuleNotFoundError: No module named 'cgi'`。

**根因**：Python 3.13+ 移除了标准库 `cgi`，旧版 `requests` 依赖它。

**修复**：改用 `httpx`（本仓库兼容路径已在用），或升级 requests。

**验证**：HTTP 调用正常，无 `cgi` 导入错误。

---

## 排查速查表

| 症状 | 一句话排查 |
|---|---|
| 改了源码不生效 | `docker inspect` 看挂载路径 → 重启容器 |
| 上游报“不支持的模型名” | 查 `creditPricing.models` 别名是否把模型改写了 |
| config 被还原 | 改 .env + start-proxy.sh，config.yaml 是生成物 |
| bash/patch 报 WSL 错误 | 显式用 Git Bash 路径 |
| git apply 报 corrupt | 先补末尾换行再查上下文 |
| Docker 起不来 | 清 `%LOCALAPPDATA%\Docker\run` 残留，用桌面端启动 |
| 迁移后自启动失效 | reg query Run 键 + shell:startup 修正路径 |
| 端口归属不清 | netstat -ano → tasklist → docker ps |
