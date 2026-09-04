# Hermes 接入 + Windows 部署实战记录（问题 → 原因 → 解决）

> 2026-08-30 部署会话沉淀。环境：Windows 11 + Git Bash（mingw64）+ Docker Desktop，
> 按 `deploy/global-images/`（INSTALL.md）官方路径部署三件套，并接入 hermes-agent 0.20.6。
> 客户端适配设计见 `agents/hermes/README.md`；本文只记录**踩坑与修复**。

---

## 一、官方部署脚本的 Windows / Git Bash 兼容问题（已修复）

### 1. `/usr/bin/curl` 硬编码 → init-admin 失败

- **现象**：`start-memory-core.sh` 初始化 admin user 返回 `HTTP=000`，`.admin-key` 不落盘。
- **原因**：脚本硬编码 `/usr/bin/curl`。Git Bash 没有这个路径（curl 在 `/mingw64/bin/curl`）。
- **修复**：统一改用 `_lib.sh` 已解析的 `$CURL`（自动探测）；另加宿主机→容器可达性等待
  （15×3s）与 init-admin 重试（5×3s），避免 Docker Desktop 端口转发未就绪时误判失败。

### 2. MSYS 路径转换搅坏 docker 挂载 → 容器静默回退默认配置

- **现象**：三件套"启动成功"，但 proxy 日志显示 `sessionInit` / `auth` 全 disabled、
  tdai 地址指向默认值；memory-core 用内置默认配置（数据写在容器 overlay 层，见 §二）。
- **原因**：MSYS bash 会把 `docker run -v /c/Users/.../.memory-core-config/tdai-gateway.yaml:/data/config/...`
  里的 POSIX 路径**双向改写**，destination 变成 `\Program Files\Git\data\...`。
  挂载失效但 `docker run` 不报错（docker 会自动创建 destination 目录），于是容器
  拿不到生成的配置文件，静默回退内置默认。
- **修复**：`_lib.sh` 统一 `export MSYS_NO_PATHCONV=1`。实测 docker 可识别 `/c/...` 形式路径。
- **教训**：这类失败**完全静默**，务必在部署后核对容器内配置
  （`docker inspect <c> --format '{{json .Mounts}}'` + 服务启动日志的 config 摘要行）。

### 3. `detect_host_ip` 在 Windows 解析出垃圾 → memory-hub 配置语法错误

- **现象**：memory-hub 容器启动即崩溃，Python 报 config SyntaxError。
- **原因**：Windows 无 `getifaddr`，脚本回退解析 `ipconfig` 输出；用法帮助文本混入 stdout
  被当成 IP 拼进配置。
- **修复**：`start-memory-hub.sh` 增加 mingw 分支，按 `IPv4 地址` 行解析本机 IP；
  该值仅影响 Panel 展示，可用 `.env` 的 `MEMORY_HUB_PROXY_PUBLIC_URL` 显式覆盖。

## 二、凭据与 volume 生命周期：资产"蒸发"

- **现象**：admin key / 业务用户 / team / agent / task 创建均返回成功，随后全部
  `verify → valid:false`；且 `.admin-key` 里的 key 在 volume 里查无此 key。
- **原因**（两个因素叠加）：
  1. 问题 2 存在期间，memory-core 挂载失效，`baseDir` 回退到容器 overlay 内的默认路径
     ——期间创建的所有资产都写在 overlay，**容器重建即蒸发**；
  2. volume（named volume）里残留着更早一次试验（旧版栈）的 metadata.db，其中有旧 admin，
     导致 init-admin 返回 409 "system already has users"，脚本于是复用 `.admin-key`
     ——但那个 key 从未写入当前数据库。
- **修复**：`./stop-all.sh --purge`（官方脚本自带：删 volume + 网络 + `.admin-key` +
  生成配置目录）后全新初始化。purge 注释明确写了"admin key 与 volume 强绑定"。
- **教训**：
  - 资产创建务必在**配置挂载验证通过之后**进行；
  - `init-admin` 对非空库返回 409 并复用 `.admin-key` 的行为，在"volume 有旧数据 +
    key 文件失配"时会把失效 key 当有效用——如遇全线 401，先 `verify` 一下 admin key。

## 三、curl 中文 argv 编码（Windows Git Bash 特有）

- **现象**：Panel 上 Team/Agent 的中文 description 全变成 `◆◆◆`（U+FFFD）；
  同一字符串经 `--data-binary @file` 发送则完好。
- **原因**：mingw64 curl 接收**命令行参数**时经 Windows ANSI 代码页（GBK）转码，
  UTF-8 中文字节被破坏；memory-core（Node）按 UTF-8 解码失败存入 U+FFFD。
  bash 变量本身是完好的 UTF-8 字节——坏的只是"argv"这一段。
- **修复**：含非 ASCII 的 JSON body 一律先写 UTF-8 临时文件再
  `curl --data-binary @file` 发送（`.trial-setup.sh` 即此写法）；纯 ASCII body 不受影响。
  INSTALL.md 已加警告。
- **附带记录**：`team/agent/task delete` API 的参数是**数组**（`team_ids` / `agent_ids` /
  `task_ids`），传单数形式报 400。

## 四、官方镜像 vs 本地源码

- **现象**：proxy 行为与仓库源码不符（hermes 请求被当成 codebuddy 渲染 `ask_followup_question`）。
- **原因**：`agentmemory/memory-proxy:latest` 是 Docker Hub 官方镜像，**不含仓库里
  未发版的适配代码**；仓库源码改动只存在于本地。
- **修复**：本地构建并覆盖本地 tag：`cd MemoryProxy && docker build -t agentmemory/memory-proxy:latest .`
  → `./start-proxy.sh` 重建 proxy 容器（core/hub 不动，数据保留）。
- **教训**：改了 `MemoryProxy/src` 之后，验证前必须重建镜像；`.env` 的 `PROXY_IMAGE`
  不变即可复用官方启动脚本。

## 五、hermes-agent 0.20.6 接入的非显而易见行为

以下全部实测（Windows），细节同步在 `agents/hermes/README.md`。

1. **HERMES_HOME 平台差异**：Windows 是 `%LOCALAPPDATA%\hermes\`（`C:\Users\<you>\AppData\Local\hermes`），
   **不是** `~/.hermes`。config.yaml 与 plugins 都装在 HERMES_HOME 下——装错位置的表现是
   `No inference provider configured`（config 没被读）。
2. **named custom provider 的运行时重写**：config `providers:` 段定义的自定义端点，
   运行时 `agent.provider` 被**统一重写为 `"custom"`**（原名仅用于读取连接信息）。
   因此 provider profile 插件若按 `name="tdaimemory"` 注册，运行时**永远查不到**。
   正确做法：subclass 内置 `CustomProfile` 并以 `name="custom"` 注册
   （用户插件 last-writer-wins 覆盖 bundled），钩子内按 `base_url 含 /hermes/` 门控，
   只对指向本 Proxy 的端点注入 `x-conversation-id`，其他 custom 端点零影响。
3. **config 结构**：`model.provider` 引用的名字必须在顶层 `providers:` 段有定义
   （承载 base_url/api_key）。只写在 `model:` 段下 → `Unknown provider` /
   `No inference provider configured`。
4. **ProviderProfile 是 dataclass**：子类要么 `@dataclass` + 字段默认值，要么构造时传参；
   类属性赋值 + 无参实例化报 `missing 1 required positional argument: 'name'`。
   本插件不覆盖整个 `custom` profile 的 `supports_health_check`，以免改变
   Ollama / vLLM / llama.cpp 等 alias 的父类行为；仅当实际 `base_url` 指向
   MemoryProxy `/hermes/` 路径时，让 `fetch_models()` 返回 `None`，跳过该端点
   不支持的模型列表探测。其他 custom endpoint 继续委托父类实现。
5. **插件发现的 import 环境**：用户插件里 `from plugins.model_providers.custom import CustomProfile`
   可行——bundled 插件先于用户插件加载（`_discover_providers` 顺序保证），
   且 bundled 插件以 `plugins.model_providers.<name>` 注册进 `sys.modules`。
6. **x-conversation-id 的来源与稳定性**：header 值 = `ses_` + hermes `agent.session_id`
   （格式 `{YYYYmmdd_HHMMSS}_{uuid6}`）。同一会话多轮恒定（表单跨轮续跑依赖它）；
   `/new` 产生新 ID → proxy 识别为新会话重新走 session-init。
   **压缩是否换 session_id 由 `compression.in_place` 配置决定**（0.20.6 实测，
   `conversation_compression.py:2878`）：默认 `true` = 原地压缩、**session_id 不变**、
   不重弹表单（手动 `/compact` 是 `/compress` 别名，与 auto-compact 同受此开关
   控制，无行为差异）；显式配 `compression.in_place: false` 才走 legacy rotation
   （`agent.session_id = new_session_id`）→ 压缩后下一轮重弹表单（不沉默、不报错；
   如需零打扰可在 config 里静态配 `x-team-id/x-agent-id/x-task-id` 走 Header 预选，
   见 agents/hermes/README.md §3.2）。早期版本默认 rotation，部署首测时观察到
   的"压缩即换 ID"即源于此——对 proxy 而言两种模式都正确：ID 变 → 新 session
   重弹表单；ID 不变 → 状态延续，均无需 proxy 感知。
7. **DeepSeek thinking 模型的多轮约束**：带 `tool_calls` 的 assistant 消息必须回传
   `reasoning_content`（哪怕是单个空格），否则上游 400
   `"The reasoning_content in the thinking mode must be passed back to the API."`。
   hermes 已内置自动 pad（`agent._needs_thinking_reasoning_pad()`）；自研客户端必须自行处理。
8. **oneshot（`hermes -z`）**：无持久 session_id → 插件不注入 header → proxy 侧
   `conversationId=null` 跳过 session-init 直接透传，属预期 bypass。

## 六、其他 API / 工具备注

- memory-core 元数据 API 创建资产需带 `owner_user_id`（team/agent）/
  `creator_user_id`（task），文档曾未记录；
- admin 不是 team 成员，不能直接在他人 team 下建 agent——需用业务用户的 user_key 调用；
- Python 侧验证 sqlite 落库内容比看 API 回显更可靠（`docker cp` 出
  `metadata/tdai_metadata_default/metadata.db` 用 `sqlite3` 查 `meta_user_keys` /
  `meta_agents` 等表）。
