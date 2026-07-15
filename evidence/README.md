# Evidence — 三平台实环境测试证据

> 本目录是 2026 犀牛鸟开源人才培养项目 TencentDB-Agent-Memory 提交的实环境测试证据集合。
> 完整测试报告见 [`SUMMARY.md`](./SUMMARY.md)（7 章节，26 + 11 个用例全绿）。

## 目录结构

```
evidence/
├── SUMMARY.md                       # 测试报告主文档（7 章节）
├── README.md                        # 本索引
│
├── persona.md                       # L3 用户画像（Step-3.5-Flash 生成，3310 字节）
├── scene_blocks/
│   └── Go语言学习计划.md              # L2 场景块（含 META 头 + 用户特征叙事）
├── records/
│   └── 2026-07-06.jsonl             # L1 结构化记忆（episodic 类型，含 metadata）
├── conversations/
│   └── 2026-07-06.jsonl             # L0 原始对话（llm-test-5 + llm-test-6）
├── llm-metadata/                    # LLM 管线运行时元数据
│   ├── manifest.json                # 存储清单（v1, sqlite）
│   ├── recall_checkpoint.json       # 召回检查点（含 runner_states + pipeline_states）
│   └── scene_index.json             # 场景索引（含 heat/summary/created）
│
├── phase1-cc/                       # Phase 0+1: Claude Code 实测
│   ├── README.md                    # 阶段说明 + 用例映射
│   ├── conversations-smoke-test.jsonl   # 暖启动（2 行）
│   └── conversations-claude-code.jsonl  # CC 真实会话（16 行，CC-2~CC-7）
│
├── phase2-cx/                       # Phase 2: Codex 实测
│   ├── README.md
│   └── conversations-codex.jsonl    # Codex MCP 调用（6 行，CX-2~CX-4）
│
├── phase3-df/                       # Phase 3: Dify 实测
│   ├── README.md
│   └── conversations-dify.jsonl     # DifyEventBinding capture（2 行，DF-4）
│
└── phase4-xb/                       # Phase 4: 跨平台互通
    ├── README.md
    └── conversations-xb.jsonl       # 跨平台 capture 侧（2 行，XB-1）
```

## 两类证据的互补关系

| 维度 | 三平台对话日志（phase1~4） | LLM 管线产物（根目录） |
|---|---|---|
| 验证目标 | 三平台 capture/search 行为正确 | L0→L1→L2→L3 全链路提取正确 |
| 测试条件 | `TDAI_LLM_API_KEY=""`（禁用 extraction） | `TDAI_LLM_API_KEY="ms-..."`（启用 extraction） |
| 数据目录 | `.test-data/real-env/` | `.test-data/llm-env/`（独立隔离） |
| 用例数 | 26（SUMMARY 第 1~5 章） | 11（SUMMARY 第 7 章） |
| 评审复现 | 见 SUMMARY 第六章 | 见 SUMMARY 第 7.6 节 |

## 评审者快速核对清单

- [ ] `persona.md` 含 4 个 Chapter + Deep Insights + Scene Navigation（L3 persona 生成成功）
- [ ] `scene_blocks/Go语言学习计划.md` 含 META 头 + 用户特征叙事（L2 场景提取成功）
- [ ] `records/2026-07-06.jsonl` 含 1 条 episodic 记忆 + activity_start_time metadata（L1 提取成功）
- [ ] `llm-metadata/recall_checkpoint.json` 显示 `total_memories_extracted: 1`、`scenes_processed: 1`、`last_persona_time` 非空
- [ ] `phase1-cc/conversations-claude-code.jsonl` 16 行对应 CC-2~CC-7 的 8 轮对话
- [ ] `phase2-cx/conversations-codex.jsonl` sessionKey 为 `cwd::date` 格式（resolveSessionKey 回退路径验证）
- [ ] `phase3-df/conversations-dify.jsonl` sessionKey 为显式传入的 `dify-test`（Dify binding 强校验路径验证）
- [ ] `phase4-xb/conversations-xb.jsonl` 2 行 capture，跨平台 search 命中（session_key 级隔离 + 互通验证）

## 切分脚本

`scripts/split-evidence.mjs` —— 按 sessionKey 切分 `.test-data/real-env/conversations/*.jsonl` 到 `evidence/phase*/`。
使用 Node.js 而非 PowerShell 是为了避免 Windows 控制台 UTF-8 编码问题损坏中文 JSONL。
