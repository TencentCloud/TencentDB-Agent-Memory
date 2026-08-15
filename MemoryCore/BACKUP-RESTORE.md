# Backup and Restore Workflow

This document provides a safe workflow for backing up, restoring, and migrating TencentDB Agent Memory workspaces. It covers MemoryCore chat memory, Skill state, governance metadata, and MemoryKnowledge LLM-Wiki/Code-Graph state.

> Stop write traffic before taking a consistent backup. If the Gateway or Knowledge Service is running, pause it or stop it first.

## Persistence layout

| Component | Primary location | Include in backup? |
| --- | --- | --- |
| MemoryCore data | `TDAI_DATA_DIR`, default `~/.memory-tencentdb/memory-tdai` | Yes. Include the entire directory: SQLite databases, local files, Skill resources, and generated artifacts. |
| MemoryKnowledge data | `KNOWLEDGE_DATA_DIR`, common default `./data`; DB path may be `KNOWLEDGE_DB_PATH` | Yes. Include the entire directory: SQLite database, Wiki artifacts, Code-Graph indexes, and queue state. |
| External vector/embedding state | Provider-specific | Record provider/model in the manifest. If vectors are stored outside the workspace, plan to rebuild or re-export them separately. |

Do not copy only selected SQLite tables or partial index files. The safest unit is the whole data directory for each service.

## Recommended backup procedure

1. Stop or pause MemoryCore Gateway and MemoryKnowledge Service.
2. Choose a clean staging directory.
3. Copy the data directories into the staging directory.
4. Write a manifest describing the archive.
5. Create a single versioned archive.

Example for a local workspace:

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

If `zstd` is available in your environment, you may use `tar --zstd -cf ...` instead of `tar -czf ...`. The archive format is less important than keeping the manifest and data directories together.

## Recommended restore procedure

1. Create the target data directories or choose a clean replacement location.
2. Extract the archive to a temporary directory.
3. Read `manifest.json` first. Verify `schema_version`, included assets, and whether reindexing is required.
4. Copy the restored directories into the target locations.
5. Start MemoryCore and MemoryKnowledge, then verify health endpoints.
6. Rebuild embeddings or Code-Graph indexes if versions are incompatible or if the manifest marks reindexing as required.

Example:

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

If restoring into a different version of the product, check migration documentation before starting write traffic. For MemoryCore major data-format upgrades, run the provided migration script after restoring and before production use.

## Import/export across machines

For moving a workspace between developer machines, CI, staging, or production:

```bash
scp memory-backup-2026-08-04.tar.gz user@target-host:/tmp/
```

On the target host, repeat the restore procedure and ensure the target environment uses the same or compatible MemoryCore/MemoryKnowledge versions. If the target uses different LLM credentials, embedding providers, or isolation identifiers, update configuration after restore rather than editing the archive.

## Data cleaning and processing

If a workspace has been processed by an optional cleaning pipeline, record that state in the manifest `processing` block. Keep raw and cleaned assets separate when possible. Cleaning is not part of backup/restore and should not overwrite the only backup copy.

## Testing guidance

- Use real temporary directories for backup/restore integration tests; do not mock the workspace filesystem.
- Mock only pure logic such as manifest validation or flag parsing.
- Use service virtualization or stub servers for expensive LLM/embedding dependencies.
- Verify at least: archive creation, manifest validation, restore into an empty directory, health checks, and reindex-required branches.
