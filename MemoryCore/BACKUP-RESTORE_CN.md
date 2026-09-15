# 备份与恢复工作流

本文档给出一套安全的工作流，用于备份、恢复和迁移 TencentDB Agent Memory 工作区。覆盖 MemoryCore 的会话记忆、Skill 状态、治理元数据，以及 MemoryKnowledge 的 LLM-Wiki / Code-Graph 状态。

> 备份前请停止写入流量。如果 Gateway 或 Knowledge Service 正在运行，请先暂停或停止服务。

## 持久化布局

| 组件 | 主要位置 | 是否纳入备份 |
| --- | --- | --- |
| MemoryCore 数据 | `TDAI_DATA_DIR`，默认 `~/.memory-tencentdb/memory-tdai` | 是。应包含整个目录：SQLite 数据库、本地文件、Skill 资源和生成产物。 |
| MemoryKnowledge 数据 | `KNOWLEDGE_DATA_DIR`，常见默认值为 `./data`；数据库路径也可能由 `KNOWLEDGE_DB_PATH` 指定 | 是。应包含整个目录：SQLite 数据库、Wiki 产物、Code-Graph 索引和队列状态。 |
| 外部向量 / Embedding 状态 | 取决于具体 Provider | 在 manifest 中记录 provider/model。如果向量数据存储在工作区之外，需要单独重建或导出。 |

不要只复制部分 SQLite 表或孤立的索引文件。最安全的备份单元是每个服务完整的数据目录。

## 推荐备份流程

1. 停止或暂停 MemoryCore Gateway 和 MemoryKnowledge Service。
2. 准备一个干净的临时 staging 目录。
3. 将数据目录复制到 staging 目录。
4. 写入 manifest，描述该归档。
5. 打包为一个带版本信息的归档文件。

本地工作区示例：

```bash
export TDAI_DATA_DIR="${TDAI_DATA_DIR:-$HOME/.memory-tencentdb/memory-tdai}"
export KNOWLEDGE_DATA_DIR="${KNOWLEDGE_DATA_DIR:-$PWD/MemoryKnowledge/data}"

STAGE_ROOT="$(mktemp -d)"
STAGE="$STAGE_ROOT/memory-workspace"
mkdir -p "$STAGE"

cp -a "$TDAI_DATA_DIR" "$STAGE/memory-core"
if [ -d "$KNOWLEDGE_DATA_DIR" ]; then
  cp -a "$KNOWLEDGE_DATA_DIR" "$STAGE/memory-knowledge"
fi

cat > "$STAGE/manifest.json" <<JSON
{
  "schema_version": 1,
  "product": "TencentDB-Agent-Memory",
  "exported_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "services": {
    "memory_core": {
      "directory": "memory-core",
      "storage": "sqlite+files"
    },
    "memory_knowledge": {
      "directory": "memory-knowledge",
      "storage": "sqlite+files"
    }
  },
  "assets": {
    "chat_memory": true,
    "skills": true,
    "governance_metadata": true,
    "llm_wiki": true,
    "code_graph": true
  },
  "embedding": {
    "included": false,
    "provider": "",
    "model": "",
    "reindex_required": true
  },
  "processing": {
    "pipeline_version": "",
    "config_hash": "",
    "steps": []
  }
}
JSON

tar -czf "memory-backup-$(date -u +%Y%m%d-%H%M%S).tar.gz" -C "$STAGE_ROOT" memory-workspace
```

如果环境中可用 `zstd`，也可以使用 `tar --zstd -cf ...` 替代 `tar -czf ...`。归档格式不是最关键的，关键是 manifest 和数据目录保持在同一个归档中。

## 推荐恢复流程

1. 创建目标数据目录，或准备一个干净的替换位置。
2. 将归档解压到临时目录。
3. 先读取 `manifest.json`，校验 `schema_version`、包含的资产以及是否需要重建索引。
4. 将恢复目录复制到目标位置。
5. 启动 MemoryCore 和 MemoryKnowledge，并检查健康检查接口。
6. 如果版本不兼容，或 manifest 中标记需要重建索引，则重建 embedding / Code-Graph 索引。

示例：

```bash
export TDAI_DATA_DIR="${TDAI_DATA_DIR:-$HOME/.memory-tencentdb/memory-tdai}"
export KNOWLEDGE_DATA_DIR="${KNOWLEDGE_DATA_DIR:-$PWD/MemoryKnowledge/data}"

RESTORE_TMP="$(mktemp -d)"
tar -xzf memory-backup-*.tar.gz -C "$RESTORE_TMP"

cat "$RESTORE_TMP/memory-workspace/manifest.json"

mkdir -p "$TDAI_DATA_DIR" "$KNOWLEDGE_DATA_DIR"
cp -a "$RESTORE_TMP/memory-workspace/memory-core/." "$TDAI_DATA_DIR/"
if [ -d "$RESTORE_TMP/memory-workspace/memory-knowledge" ]; then
  cp -a "$RESTORE_TMP/memory-workspace/memory-knowledge/." "$KNOWLEDGE_DATA_DIR/"
fi

curl -fsS http://127.0.0.1:8420/health
curl -fsS http://127.0.0.1:8421/health || true
```

如果恢复到不同版本的产品环境，请先查看迁移文档，再开启写入流量。对于 MemoryCore 的重大数据格式升级，应在恢复后、正式使用前运行官方迁移脚本。

## 跨机器导入导出

在开发机、CI、预发和生产之间迁移工作区时，可以先传输归档文件：

```bash
scp memory-backup-2026-08-04.tar.gz user@target-host:/tmp/
```

在目标机器上重复上面的恢复流程，并确保目标环境使用相同或兼容的 MemoryCore / MemoryKnowledge 版本。如果目标环境使用不同的 LLM 凭证、Embedding Provider 或隔离标识，请在恢复后更新配置，而不是直接修改归档内容。

## 数据清洗与加工

如果工作区曾经经过可选的数据清洗流水线处理，应在 manifest 的 `processing` 字段中记录处理状态。尽可能保留 raw / cleaned 两层资产。清洗不属于备份恢复流程本身，不应覆盖唯一的备份副本。

## 测试建议

- 备份 / 恢复集成测试应使用真实临时目录，不要 mock 工作区文件系统。
- 只 mock 纯逻辑，例如 manifest 校验或参数解析。
- 对昂贵的 LLM / Embedding 依赖使用服务虚拟化或 stub server。
- 至少覆盖：归档创建、manifest 校验、恢复到空目录、健康检查、以及需要重建索引的分支。
