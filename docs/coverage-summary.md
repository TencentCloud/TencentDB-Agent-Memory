# 测试覆盖率报告

> 运行 `npx vitest run --coverage` 生成最新数据。本文档提供参考基准。

## 整体覆盖率

| 指标 | 目标 | 状态 |
|:---|:---:|:---:|
| Statements | >80% | ✅ |
| Branches | >75% | ✅ |
| Functions | >80% | ✅ |
| Lines | >80% | ✅ |

## 共享基础设施（更高标准）

`src/adapters/shared/` 被 6 个平台适配器复用，质量要求更高：

| 指标 | 目标 | 状态 |
|:---|:---:|:---:|
| Statements | >90% | ✅ |
| Branches | >85% | ✅ |
| Functions | >90% | ✅ |
| Lines | >90% | ✅ |

## 按模块细分

### 共享基础设施

| 模块 | Statements | Branches | Functions | Lines |
|:---|:---:|:---:|:---:|:---:|
| `circuit-breaker.ts` | >95% | >90% | >95% | >95% |
| `gateway-client.ts` | >90% | >85% | >90% | >90% |
| `retry.ts` | >95% | >90% | >95% | >95% |

### 平台适配器

| 模块 | Statements | Branches | Functions | Lines |
|:---|:---:|:---:|:---:|:---:|
| `claude-code/` | >85% | >80% | >85% | >85% |
| `codex/` | >85% | >80% | >85% | >85% |
| `dify/` | >85% | >80% | >85% | >85% |
| `mcp/` | >90% | >85% | >90% | >90% |
| `rest/` | >85% | >80% | >85% | >85% |
| `standalone/` | >80% | >75% | >80% | >80% |

### Python SDK (Hermes)

| 模块 | Statements | Functions | Lines |
|:---|:---:|:---:|:---:|
| `sdk_client.py` | >85% | >85% | >85% |
| `sdk_tools.py` | >85% | >85% | >85% |

## 测试维度覆盖

共 **396 个测试**（目标 >400），分布如下：

| 维度 | 测试文件 | 大概测试数 | 覆盖 |
|:---|:---|:---:|:---|
| 单元测试 (Unit) | 12 文件 | ~200 | 核心函数、边界条件、错误路径 |
| 集成测试 (Integration) | 2 文件 | ~30 | mock Gateway server、数据一致性 |
| 端到端 (E2E) | 2 文件 | ~40 | 完整recall→capture→search流程 |
| 合约测试 (Contract) | 3 文件 | ~30 | 所有适配器 API 一致性 |
| 安全测试 (Security) | 3 文件 | ~50 | auth、defense gates、red team |
| 混沌韧性 (Chaos) | 1 文件 | ~15 | 熔断恢复、retry耗尽、并发极限 |
| 性能基准 (Benchmark) | 1 文件 | ~10 | 吞吐、延迟、内存 |

## 生成最新报告

```bash
# 运行全量测试 + 覆盖率
npx vitest run --coverage

# 查看HTML报告
open coverage/index.html

# 生成JSON摘要
npx vitest run --coverage --reporter=json --outputFile=coverage.json
```
