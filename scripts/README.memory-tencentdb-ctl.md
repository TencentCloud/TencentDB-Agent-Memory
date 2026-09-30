# memory-tencentdb-ctl.sh — memory_tencentdb运维脚本

> 配合 [`install_hermes_memory_tencentdb.sh`](./install_hermes_memory_tencentdb.sh) 使用。
> 先跑安装脚本部署好插件 + Node 依赖，之后日常的启停 / 配置全部通过 `memory-tencentdb-ctl.sh` 完成。

## 1. 运行模式

脚本有两种模式，**默认是独立模式**，完全不触碰 `~/.hermes`：

| 模式 | 激活方式 | 做什么 | 不做什么 |
|---|---|---|---|
| `standalone`（默认） | 无需任何参数 | 启停 Gateway；写 `$TDAI_DATA_DIR/tdai-gateway.json`；日志落 `$TDAI_DATA_DIR/logs/` | 不写 `$HERMES_HOME/env.d/`，不改 `$HERMES_HOME/config.yaml`，不读 hermes 相关 env |
| `hermes` | 命令行追加 `--hermes`，或环境 `MEMORY_TENCENTDB_MODE=hermes` | standalone 的全部 + `config llm` 同步写 `$HERMES_HOME/env.d/memory-tencentdb-llm.sh`；日志落 `$HERMES_HOME/logs/memory_tencentdb/`；开放 `enable-hermes-memory` 子命令 | — |

> **为什么 hermes 模式要多写 env 文件？**
> 因为 hermes 进程会托管式地把 Gateway 以子进程拉起来（supervisor 用 `os.environ.copy()` 传环境），此时 Gateway 读不到 `tdai-gateway.json` 所在的 shell 环境，必须通过 `$HERMES_HOME/env.d/*.sh` 让 hermes 自身 `source` 才能把凭据传进去。独立模式下 Gateway 自己读 JSON，无此需要。

## 2. 路径

> **路径变量约定**：本节及后续示例统一用 `$HERMES_HOME` 指代 hermes 的家目录，**默认 `~/.hermes`**，但你可以通过环境变量覆盖（例如 `export HERMES_HOME=/srv/hermes`），脚本和 hermes 自身都遵守这个变量。
>
> 自 0.4.x 起，所有 tdai 相关数据/代码默认收纳到统一根目录 `$MEMORY_TENCENTDB_ROOT`（默认 `~/.memory-tencentdb`）之下：
>
> - `$TDAI_INSTALL_DIR` 默认 `$MEMORY_TENCENTDB_ROOT/tdai-memory-openclaw-plugin`（即 `~/.memory-tencentdb/tdai-memory-openclaw-plugin`）
> - `$TDAI_DATA_DIR` 默认 `$MEMORY_TENCENTDB_ROOT/memory-tdai`（即 `~/.memory-tencentdb/memory-tdai`）
>
> 下文出现这些变量时**先 `export` 一份覆盖**，再跑命令即可全局生效。
> 旧版本使用 `~/tdai-memory-openclaw-plugin` 与 `~/memory-tdai`；`install_hermes_memory_tencentdb.sh` 在升级时会自动迁移这两个旧目录到新位置。

| 路径 | standalone | hermes | 作用 |
|---|---|---|---|
| `$TDAI_INSTALL_DIR` | ✅ | ✅ | 插件源码 + `node_modules` + `src/gateway/server.ts` |
| `$TDAI_DATA_DIR/tdai-gateway.json` | ✅ | ✅ | Gateway 主配置：`llm` / `memory.embedding` / `memory.tcvdb` / `memory.storeBackend`，权限 `0600` |
| `$TDAI_DATA_DIR/logs/` | ✅ 日志 | — | `gateway.stdout.log` / `gateway.stderr.log` / `gateway.pid` |
| `$HERMES_HOME/logs/memory_tencentdb/` | — | ✅ 日志 | 同上，换目录 |
| `$HERMES_HOME/env.d/memory-tencentdb-llm.sh` | — | ✅ | hermes 启动前 `source`，给 supervisor 托管的 Gateway 子进程注入 LLM 凭据 |
| `$HERMES_HOME/config.yaml` | — | ✅ | `enable-hermes-memory` 修改其 `memory.provider` |
| Gateway 监听 | `127.0.0.1:8420` | `127.0.0.1:8420` | 可被 `MEMORY_TENCENTDB_GATEWAY_HOST/PORT` 覆盖 |

所有路径都能用同名环境变量覆盖（再次列出便于对照）：`MEMORY_TENCENTDB_ROOT`（默认 `~/.memory-tencentdb`）、`TDAI_INSTALL_DIR`（默认 `$MEMORY_TENCENTDB_ROOT/tdai-memory-openclaw-plugin`）、`TDAI_DATA_DIR`（默认 `$MEMORY_TENCENTDB_ROOT/memory-tdai`）、`HERMES_HOME`（默认 `~/.hermes`）、`MEMORY_TENCENTDB_LOG_DIR`、`MEMORY_TENCENTDB_GATEWAY_HOST/PORT`。

依赖：`bash`、`python3`、`node >= 22`、`lsof` 或 `ss`。

## 3. 安装 & 调用

脚本随 npm 包发布到 `node_modules/.../scripts/` 下，但**没有**注册为 `bin` 命令。要用全局命令名调用，必须自己做一次软链。

### 3.1 从 npm 包里直接运行（无需任何配置）

```bash
npm install @tencentdb-agent-memory/memory-tencentdb

# 项目内安装，路径可由 npm root 动态算出
"$(npm root)/@tencentdb-agent-memory/memory-tencentdb/scripts/memory-tencentdb-ctl.sh" --help

# 全局安装则用 npm root -g
"$(npm root -g)/@tencentdb-agent-memory/memory-tencentdb/scripts/memory-tencentdb-ctl.sh" --help
```

`npm root` / `npm root -g` 会在所有包管理器（npm / pnpm / yarn）和不同的 prefix 配置下返回正确目录，避免硬编码 `node_modules/` 路径。适合一次性、临时使用的场景。

### 3.2 软链到 PATH（推荐给运维 / 长期使用）

不论脚本来源（git clone 出来的仓库 / `npm install` 装的包 / 自定义部署目录），先把脚本路径**算出来存到一个变量里**，再统一做软链。这样无需关心你把仓库放在 `~/code/`、`/opt/`、还是别的什么地方。

```bash
# 第一步：定位 memory-tencentdb-ctl.sh 的真实路径（任选一种来源）

# (a) 从 git 仓库（在仓库根目录或任意子目录里执行）
SCRIPT="$(git -C "$(git rev-parse --show-toplevel)" ls-files | \
          grep -E 'scripts/memory-tencentdb-ctl\.sh$' | head -1)"
SCRIPT="$(git rev-parse --show-toplevel)/$SCRIPT"

# (b) 从已 npm 全局安装的包
SCRIPT="$(npm root -g)/@tencentdb-agent-memory/memory-tencentdb/scripts/memory-tencentdb-ctl.sh"

# (c) 从项目本地的 node_modules
SCRIPT="$(npm root)/@tencentdb-agent-memory/memory-tencentdb/scripts/memory-tencentdb-ctl.sh"

# (d) 完全手写绝对路径（如部署到非标准位置）
SCRIPT="/opt/tdai/scripts/memory-tencentdb-ctl.sh"

# 第二步：验证路径正确，然后软链
test -f "$SCRIPT" && echo "ok: $SCRIPT" || { echo "not found"; exit 1; }
chmod +x "$SCRIPT"
sudo ln -sf "$SCRIPT" /usr/local/bin/memory-tencentdb-ctl

# 同样的办法把 install_hermes_memory_tencentdb.sh 链接成 install-memory-tencentdb（可选）
INSTALL_SCRIPT="$(dirname "$SCRIPT")/install_hermes_memory_tencentdb.sh"
test -f "$INSTALL_SCRIPT" && {
  chmod +x "$INSTALL_SCRIPT"
  sudo ln -sf "$INSTALL_SCRIPT" /usr/local/bin/install-memory-tencentdb
}
```

之后直接 `memory-tencentdb-ctl …` / `install-memory-tencentdb …`。

> **为什么不直接用 `npm bin` 注册？** 这两个脚本是运维工具而不是包的核心 API，主仓库希望用户**显式**完成 PATH 注册（避免无意中污染全局命令空间，并避免 npm 卸载时静默移除运维入口）。

## 4. 生命周期管理（两种模式通用）

```bash
memory-tencentdb-ctl start        # 若 :8420 已占用会直接返回；否则后台 spawn，等待 /health 通过
memory-tencentdb-ctl stop         # 先 SIGTERM，5s 内未退则 SIGKILL
memory-tencentdb-ctl restart
memory-tencentdb-ctl status       # 打印模式、端口、data/log 路径、进程状态
memory-tencentdb-ctl health       # GET /health，纯 python3 实现，不要求 curl
memory-tencentdb-ctl logs         # tail -f stdout + stderr
memory-tencentdb-ctl logs err 500 # 只看 stderr 最近 500 行
```

启动命令解析顺序：

1. 环境变量 `MEMORY_TENCENTDB_GATEWAY_CMD`（`install_hermes_memory_tencentdb.sh` 写入 `/etc/profile.d/memory-tencentdb-env.sh` 的那条）。
2. 回退到 `sh -c 'cd $TDAI_INSTALL_DIR && exec node --import tsx/esm src/gateway/server.ts'`。

启动时会自动 `source` 的环境文件：

- 两种模式：`/etc/profile.d/memory-tencentdb-env.sh`
- 仅 hermes 模式：`/etc/profile.d/hermes-env.sh` 以及 `$HERMES_HOME/env.d/*.sh`

## 5. 配置 LLM / Embedding / VDB

三类凭据统一落到 `$TDAI_DATA_DIR/tdai-gateway.json`（`0600`，原子写）。**`config llm` 在 `--hermes` 模式下会额外写一份 env 文件**；Embedding / VDB 从不写 env。

### 5.1 LLM

```bash
# standalone 模式：只写 tdai-gateway.json
memory-tencentdb-ctl config llm \
  --api-key   "sk-xxxxxxxxxxxx" \
  --base-url  "https://api.openai.com/v1" \
  --model     "gpt-4o" \
  --restart

# hermes 模式：tdai-gateway.json + $HERMES_HOME/env.d/memory-tencentdb-llm.sh
memory-tencentdb-ctl --hermes config llm \
  --api-key   "sk-xxxxxxxxxxxx" \
  --base-url  "https://api.openai.com/v1" \
  --model     "gpt-4o" \
  --restart
```

- JSON 写入点：`$.llm.{baseUrl, apiKey, model}`。
- env 文件写入（仅 `--hermes`）：`TDAI_LLM_*` 及 `MEMORY_TENCENTDB_LLM_*` 别名（Python provider 的 `get_config_schema()` 会读后者）。

### 5.2 Embedding

默认关闭（`provider=none`）。启用远端 OpenAI 兼容服务：

```bash
memory-tencentdb-ctl config embedding \
  --provider   openai \
  --api-key    "sk-xxxx" \
  --base-url   "https://api.openai.com/v1" \
  --model      "text-embedding-3-small" \
  --dimensions 1536 \
  --restart

# 关闭 embedding（退化为 BM25/关键词召回）
memory-tencentdb-ctl config embedding --provider none --restart
```

- JSON 写入点：`$.memory.embedding.{provider, baseUrl, apiKey, model, dimensions, enabled, proxyUrl?}`。
- `qclaw` provider 额外要求 `--proxy-url`。
- 校验规则与 `src/config.ts` 的 `parseConfig()` 对齐：`dimensions` 为正整数，非 `none` 必须带 `apiKey/baseUrl/model/dimensions`；缺项直接报错不写半残 JSON。

### 5.3 VectorDB（Tencent Cloud VDB / tcvdb）

```bash
memory-tencentdb-ctl config vdb \
  --url       "http://xxx-vdb.tencentclb.com:8100" \
  --username  root \
  --api-key   "YOUR-VDB-API-KEY" \
  --database  "openclaw_memory" \
  --alias     "primary" \
  --embedding-model "bge-large-zh" \
  --ca-pem    "/etc/ssl/vdb-ca.pem" \
  --restart
```

- JSON 写入点：`$.memory.tcvdb.{url, username, apiKey, database, alias?, caPemPath?, embeddingModel?}`。
- 默认同时把 `$.memory.storeBackend` 切到 `"tcvdb"`；只想预埋配置先不切，加 `--no-set-backend`。
- `--ca-pem` 只写路径不复制文件；脚本会校验可读性。

### 5.4 退回本地 SQLite（关闭 VDB 后端）

```bash
# 默认：保留 memory.tcvdb 凭据（方便随时再切回去），仅把 storeBackend 改回 sqlite
memory-tencentdb-ctl config vdb-off --restart

# 同时把腾讯云 VDB 的 url / apiKey / database 等凭据从 JSON 中清掉
memory-tencentdb-ctl config vdb-off --purge-creds --restart
```

- JSON 写入点：把 `$.memory.storeBackend` 设为 `"sqlite"`；`--purge-creds` 时额外删除整段 `$.memory.tcvdb`。
- `$.llm` / `$.memory.embedding` 等其它顶级段**完全保留**，hermes 侧 `memory.provider` **不动**（仍是 `memory_tencentdb`，只是它内部存储退回 sqlite）。
- 配置文件不存在时给出 `warn` 并写入仅含 `{"memory":{"storeBackend":"sqlite"}}` 的最小配置。
- 与 `config vdb` 完全镜像：可与 `--dry-run` / `--restart` 组合使用。

### 5.5 查看当前配置

```bash
memory-tencentdb-ctl config show
```

- 打印 `tdai-gateway.json`，`apiKey`/`password`/`token` 字段自动脱敏为 `<redacted:NN chars>`。
- hermes 模式下额外打印 `$HERMES_HOME/env.d/memory-tencentdb-*.sh`（API key 也会脱敏），可直接贴工单。

## 6. 打通 hermes（仅 `--hermes` 模式）

```bash
memory-tencentdb-ctl --hermes enable-hermes-memory
```

幂等：把 `$HERMES_HOME/config.yaml` 的 `memory:` 段的 `provider:` 改成 `memory_tencentdb`（不存在则新增整段）。改完后重启 hermes：

```bash
source "$HERMES_HOME/env.d/memory-tencentdb-llm.sh"
pkill -f hermes-agent || true
hermes
```

> **关于写入策略**：脚本采用"格式保真"双路径，**永不重写整个 YAML**：
>
> 1. **首选**：检测到 [`ruamel.yaml`](https://yaml.readthedocs.io/) 时走 round-trip，完整保留注释、键序、引号、缩进风格（推荐 `pip install --user ruamel.yaml` 享受最佳保真度，**非必装**）；
> 2. **降级**：未安装 ruamel 时走最小化原位行编辑——只重写 `provider:` 那一行，缩进直接从同段已有兄弟键的前缀**逐字符拷贝**（零猜测、零格式破坏）；
> 3. 若 `memory:` 段不存在，则在文件末尾追加最小段，缩进从文档其它顶级段的子键拓印。
>
> 实测对真实 `~/.hermes/config.yaml` 做 byte-for-byte diff，除 `provider` 值本身外其余字节完全一致。

非 hermes 模式下调用该命令会直接报错退出。

> 想反过来"保留 hermes provider 不变，仅让 TDAI 内部存储退回 sqlite"，用 §5.4 的 `config vdb-off` 即可（不需要也**不要**改 hermes 的 `memory.provider`）。

## 7. 典型使用流程

### 场景 A：Gateway 独立部署（不使用 hermes）

```bash
# 1) 安装
#    INSTALL_SCRIPT 的取值方式见上文 3.2 节（git rev-parse / npm root / 手填均可）
#    例如从 git 仓库根：INSTALL_SCRIPT="$(git rev-parse --show-toplevel)/scripts/install_hermes_memory_tencentdb.sh"
#         从 npm 全局：  INSTALL_SCRIPT="$(npm root -g)/@tencentdb-agent-memory/memory-tencentdb/scripts/install_hermes_memory_tencentdb.sh"
bash "$INSTALL_SCRIPT"

# 2) 只配 Gateway 所需凭据
memory-tencentdb-ctl config llm       --api-key "sk-..." --base-url "https://api.openai.com/v1" --model gpt-4o
memory-tencentdb-ctl config embedding --provider openai --api-key "sk-..." --base-url "https://api.openai.com/v1" \
                                      --model text-embedding-3-small --dimensions 1536
memory-tencentdb-ctl config vdb       --url "http://xxx:8100" --api-key "..." --database openclaw_memory

# 3) 启动 + 自检
memory-tencentdb-ctl start
memory-tencentdb-ctl status
memory-tencentdb-ctl health      # 预期: {"status":"ok",...}
```

### 场景 B：集成 hermes

```bash
# 1) 安装（与场景 A 相同；INSTALL_SCRIPT 由上文 3.2 节算出）
bash "$INSTALL_SCRIPT"

# 2) 全程加 --hermes（或 export MEMORY_TENCENTDB_MODE=hermes 一次）
memory-tencentdb-ctl --hermes config llm --api-key "sk-..." --base-url "https://api.openai.com/v1" --model gpt-4o
memory-tencentdb-ctl --hermes config embedding --provider openai --api-key "sk-..." \
                                               --base-url "https://api.openai.com/v1" \
                                               --model text-embedding-3-small --dimensions 1536
memory-tencentdb-ctl --hermes config vdb --url "http://xxx:8100" --api-key "..." --database openclaw_memory

# 3) 启动 Gateway（通常由 hermes supervisor 托管，这里是手动兜底）
memory-tencentdb-ctl --hermes start
memory-tencentdb-ctl --hermes status

# 4) 在 hermes config 里启用 provider，并重启 hermes
memory-tencentdb-ctl --hermes enable-hermes-memory
source "$HERMES_HOME/env.d/memory-tencentdb-llm.sh"
pkill -f hermes-agent ; hermes
```

如果嫌 `--hermes` 每次都要带，可以：

```bash
export MEMORY_TENCENTDB_MODE=hermes
```

之后所有调用自动切到 hermes 模式，命令行无需再加 `--hermes`。

### 场景 C：临时把 TDAI 的存储退回 sqlite（保留 hermes 集成）

适用于 VDB 不可达 / 排障 / 离线开发等场景：希望 hermes 端 `memory.provider` 仍是 `memory_tencentdb`，但让 Gateway 改用本地 SQLite 落盘。

```bash
# (A) 默认：保留 memory.tcvdb 凭据，仅把 storeBackend 切回 sqlite
memory-tencentdb-ctl config vdb-off --restart

# (B) 排障结束想切回 vdb：当前需要重新跑一次 config vdb（必填项需重新提供，
#     即使 JSON 里凭据还在；脚本是基于必填校验的"重新声明"语义，不是 toggle）
memory-tencentdb-ctl config vdb \
  --url "http://xxx-vdb.tencentclb.com:8100" \
  --api-key "<你的 KEY>" \
  --database "openclaw_memory" \
  --restart

# (C) 彻底放弃 vdb：清掉凭据
memory-tencentdb-ctl config vdb-off --purge-creds --restart
```

> 之所以 (B) 不提供"零参数 vdb-on"，是因为原 `config vdb` 子命令把 `--url/--api-key/--database` 设为强校验，避免用户拼装出半残配置；如果你希望把"已存的凭据重新激活"也做成单命令，告诉维护者补一个 `config vdb-on` 即可（实现方式与 `vdb-off` 完全镜像）。

> **不要**为了"切回 sqlite"去改 `~/.hermes/config.yaml` 的 `memory.provider`！hermes 看到的依然是 `memory_tencentdb` provider，存储后端切换是 Gateway 内部的事，对 hermes 完全透明。

## 8. 全局选项 & 调试技巧

- 所有写操作支持 `--dry-run`（放在命令最前），会打印将要写入的内容但不落盘：
  ```bash
  memory-tencentdb-ctl --dry-run config llm --api-key k --base-url https://x --model m
  ```
- 敏感文件权限一律 `0600`；`env.d/memory-tencentdb-llm.sh` 含明文 API key，**不要** commit。
- 启动失败：`memory-tencentdb-ctl logs err 200` 查看 stderr；手动前台跑一遍更容易看到报错：
  ```bash
  cd "$TDAI_INSTALL_DIR" && node --import tsx/esm src/gateway/server.ts
  ```
- 端口冲突：`MEMORY_TENCENTDB_GATEWAY_PORT=18420 memory-tencentdb-ctl restart`。
- 验证 hermes 有没有吃到新 env（hermes 模式）：
  ```bash
  tr '\0' '\n' < /proc/$(pgrep -n hermes-agent)/environ | grep -E 'TDAI_|MEMORY_TENCENTDB_'
  ```

## 9. 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 参数错误 / 业务校验失败（如 `--base-url` 非 http(s)；在 standalone 下调 hermes 专属命令） |
| 2 | 写盘失败（磁盘满、权限不足等） |
| 127 | 依赖缺失（`python3` / `node`） |

---

要封装成 systemd unit，基于 `memory-tencentdb-ctl start` / `memory-tencentdb-ctl stop` 写 `Type=forking` 的 service 即可（Gateway 是无状态 HTTP sidecar，不依赖 systemd readiness 协议）。
