# Tool-routing benchmark

这是一个工具路由 benchmark，没有接入真实的流量。

一条样本由“用户请求 + 固定注入资产 + 期望工具路由”组成。模型只拿到一个 `Bash` schema；runner 解析模型生成的 curl，转发给进程内 mock bridge，而不会执行 shell。评测借鉴了 **BFCL** 的核心方法：用可验证的工具契约评价是否调用、选了哪个工具以及参数是否正确——但数据不是 BFCL 官方数据集。

## 数据和冻结规则

- `dataset.jsonl`：120 条已标记为 `approved` 的样本，80 Dev / 40 Test；分类数量与计划一致。
- `baseline-manifest.json` 固定旧 renderer commit、fixture 和字节哈希。运行时从该 commit 加载旧 renderer，并核对哈希；因此不会把当前分支误当成 Baseline。

## 安装依赖

首次运行前，先从仓库根目录进入 `MemoryProxy` 并安装依赖：

```bash
cd MemoryProxy
npm install
```

如果是严格复现评测，可以使用已提交的 `package-lock.json` 做安装：

```bash
cd MemoryProxy
npm ci
```

## 静态验证

```bash
npm run eval:tool-routing:dry
```

它验证数据规模、Baseline 哈希、重复渲染字节稳定性，并报告每个注入块的字符/字节变化。最终 Token 以 provider 返回的 `usage.prompt_tokens` 为准。

## 接入 provider

runner 使用 OpenAI-compatible `chat/completions`。

```bash
cd ./MemoryProxy
cp .env.tool-routing.local.example .env.tool-routing.local
```

然后编辑新文件，把占位符替换为真实配置：

```dotenv
TOOL_ROUTING_API_BASE_URL=https://provider.example/v1
TOOL_ROUTING_API_KEY=replace-me
TOOL_ROUTING_MODEL=deepseek-v4-flash
TOOL_ROUTING_THINKING_MODE=disabled
TOOL_ROUTING_EXTRA_BODY_JSON={"thinking":{"type":"disabled"}}
```

`TOOL_ROUTING_API_BASE_URL` 会自动拼接 `/chat/completions`。如果 Provider 使用非标准路径，可以在本地配置中注释掉 `TOOL_ROUTING_API_BASE_URL`，改为设置完整地址：

```dotenv
TOOL_ROUTING_API_URL=https://provider.example/custom/chat/completions
```

`npm run eval:tool-routing` 会自动加载本地配置，无需手工 `source`：

```bash
npm run eval:tool-routing -- --split dev --variant both --repetitions 3
```

也可以不创建文件，仅为当前 shell 临时导出环境变量：

```bash
export TOOL_ROUTING_API_BASE_URL='https://provider.example/v1'
export TOOL_ROUTING_API_KEY='...'
export TOOL_ROUTING_MODEL='deepseek-v4-flash'
export TOOL_ROUTING_THINKING_MODE='disabled'
# 若 provider 需要专属字段：
export TOOL_ROUTING_EXTRA_BODY_JSON='{"thinking":{"type":"disabled"}}'

npm run eval:tool-routing -- --split dev --variant both --repetitions 3
```

可用 `--case <id>` 只跑一条连通性或调试样本。

长任务会逐条显示进度、百分比和 ETA，并在每条完成后立即追加 JSONL；每 10 条及结束时原子更新报告。默认并发为 2，可按 provider 限流调整：

```bash
npm run eval:tool-routing -- --split dev --variant both --repetitions 3 --concurrency 2
```

中断后使用相同参数并追加 `--resume`。runner 会复用模型名和 prompt hash 均一致的成功记录，失败或提示词已变化的记录会重跑：

```bash
npm run eval:tool-routing -- --split dev --variant both --repetitions 3 --concurrency 2 --resume
```

不带 `--resume` 会清空目标 JSONL 并开始一轮新实验。需要保留多组实验时用不同的 `--out` 路径。

固定参数为 `temperature=0`、`top_p=1`；实验组按样本和 repetition 交错运行。结果会记录请求模型、响应中的实际模型版本、参数、endpoint/body、mock 接收事件和 usage。

当前样本已标记为 `approved`，可以直接运行冻结评测：先跑 `120 × 3`；通过筛选后另建至少 300 条唯一冻结样本并跑 5 次。评分报告包含有效调用率、误调用率、family/具体工具/协议正确率、分类明细和按 case 聚类的配对 bootstrap 95% CI。

## 安全边界

runner 不启动 shell。它只接受单条 curl 文本，拒绝 shell 操作符、命令替换和 mock allowlist 之外的 host，再把解析后的请求交给进程内 fixture。模型生成的任意命令都不会执行。
