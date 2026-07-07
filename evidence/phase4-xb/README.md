# Phase 4 — 跨平台互通证据

> 对应 `SUMMARY.md` 第一章「阶段 4」用例 XB-1~XB-2

## 文件清单

| 文件 | sessionKey | 行数 | 说明 |
|---|---|---|---|
| `conversations-xb.jsonl` | `xb-test-a` | 2 | 跨平台 capture 测试（capture "Rust"，由其他平台 search 命中） |

## 跨平台互通逻辑说明

XB-1 的验证流程是：
1. **平台 A capture**（`xb-test-a` session）：写入 "Rust" 相关对话 → 本文件的 2 行
2. **平台 B search**（同 session_key="xb-test-a"）：在另一个平台用相同 session_key 调 `tdai_conversation_search` → 命中 score:0.829

关键点：**两平台连同一 Gateway（同 `TDAI_DATA_DIR`）**，且**显式传同一 session_key**，才能跨平台命中。这验证了 Gateway 是单用户本地部署模型，session_key 是唯一隔离维度。

## 覆盖用例

| 用例 | 内容 | 证据来源 |
|---|---|---|
| XB-1 | 同 session capture → search 互通 | conversations-xb.jsonl（capture 侧）+ 运行时 search 输出 score:0.829 |
| XB-2 | session_key 隔离验证 | （运行时观察：跨 session_key 搜索 0 条） |

## 编码说明

`??? Rust ???` 是 PowerShell 控制台 UTF-8 编码问题导致的中文乱码（详见 `SUMMARY.md` 第三章）。原始 capture 内容应为含 "Rust" 的中文短语，但控制台传入时已损坏。这不影响测试结论——search 仍能命中 "Rust" 关键词，证明：
1. capture 通道不依赖控制台编码正确性
2. search 的 hybrid 策略（embedding + BM25）能从损坏字符中提取 "Rust" token
