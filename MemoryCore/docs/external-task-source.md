# External task sources

`MemoryCore/src/task-source/` imports work items from an external tracker into
`meta_tasks`. The shipped provider is **TAPD** (`tapd`). Add a provider here when
you need another tracker — ONES, Jira, or anything else that exposes the same
three calls.

This file is the guide referenced from [`MemoryCore/README.md`](../README.md).

## How it fits together

```
Panel ──POST /v3/task-source/*──▶ TaskSourceRegistry ──▶ tapdProvider ──MCP──▶ TAPD
                │                        │
                │                        └─ writes meta_tasks rows via TaskSourceImportService
                └─ credential injected per request, never persisted
```

- `registry.ts` — provider registry and the deployment config it validates.
- `import-service.ts` — persists a batch into `meta_tasks`; this module owns all
  local state. Everything else in `task-source/` is a side-effect-free export
  surface.
- `providers/<id>/` — one directory per tracker.

The registry mirrors the Knowledge-side `WikiSourceRegistry`: the enabled list
comes from deployment config, endpoints have **no built-in defaults**, and a
missing config fails fast at context construction rather than degrading silently.

## The four endpoints

All are `POST` under `/v3/task-source` and reuse the same `x-tdai-user-key`
user auth as the rest of v3.

| Path | Purpose |
|---|---|
| `/providers` | List enabled providers and their metadata. Does **not** require a credential. |
| `/workspaces` | List workspaces for a provider. |
| `/candidates` | Browse/filter work items to pick from. |
| `/import` | Import the chosen items into `meta_tasks`. |

`/providers`, `/workspaces` and `/candidates` first call
`assertExternalTaskImportAllowed(team_id, caller)` — the caller must be an active
member of the team.

Source credentials never appear in a request *header*: Panel passes them in the
request body's `credential` field, and the router passes them straight to the
provider. They are not written to the database.

## TAPD specifics

| Property | Value |
|---|---|
| Provider id | `tapd` |
| Item types | `story` (需求), `task` (任务), `bug` (缺陷) |
| Max batch size | `50` |
| Needs a workspace | yes |
| Transport | TAPD MCP gateway |
| Optional capability | `todo` — adds the `only_todo` filter, backed by `user_todo_*_get` |

Two auth schemes are offered; both hit the same endpoint and differ only by
header:

- **太湖统一认证令牌** — `Authorization` bearer header.
- **TAPD 个人令牌** — `x-tapd-access-token` header.

The "how do I get a token?" link below each field is delivered as
`token_doc_url`. When the matching env var is unset the field renders as
`null` and the front end hides that scheme's link entirely. For the太湖 scheme
that env var is `TAI_PAT_URL`, which iWiki also uses.

Because the `task` item type returns no detail link from TAPD, the provider
needs **both** the MCP endpoint and the site root to build detail URLs.

### Item-type differences

TAPD's three types are not shaped alike, and `providers/tapd/mapper.ts`
normalizes them:

| Field | story | task | bug |
|---|---|---|---|
| title key | `name` | `name` | `title` (no `name`) |
| detail link | from the table | not returned | from the table |

The optional todo tools (`user_todo_stories_get` / `user_todo_tasks_get` /
`user_todo_bugs_get`) accept **only `workspace_id`**. `limit`, `page`, `owner`,
`name` and `with_v_status` are rejected, so the todo mode can only fetch the
current user's own todo items — their state is stored locally.

## Configuration

Endpoints are deployment config with no defaults. Gateway config keys are
camelCase and map to env vars as `sources.<id>.<key>` ⇒
`TASK_SOURCE_<ID>_<UPPER_SNAKE_KEY>`:

```yaml
# tdai-gateway.yaml
taskSource:
  enabled: "${TASK_SOURCE_ENABLED}"        # comma-separated provider ids; unconfigured = none enabled
  taiPatUrl: "${TAI_PAT_URL}"              # 太湖 token page (shared with iWiki)
  sources:
    tapd:
      mcpUrl: "${TASK_SOURCE_TAPD_MCP_URL}"              # required
      siteBaseUrl: "${TASK_SOURCE_TAPD_SITE_BASE_URL}"   # required
      personalTokenUrl: "${TASK_SOURCE_TAPD_PERSONAL_TOKEN_URL}"  # optional
```

Each provider declares which suffixes it needs via `requiredEnv`, and the
registry validates only the declared ones. If one is missing, context
construction throws `task_source_config_missing` — it does not fall back to a
default.

## Adding a source

1. **Create `providers/<id>/`.** Implement `TaskSourceProvider`
   (`providers/tapd/index.ts` is the reference): `listWorkspaces`,
   `listCandidates`, `fetchTask`, plus the metadata the front end drives its UI
   from — `itemTypes`, `maxBatchSize`, `needsWorkspace`, `authSchemes`,
   `capabilities`, and `requiredEnv`.
2. **Normalize in a `mapper.ts`.** Keep the front end on one snake_case shape
   (see `candidates` above), so source-specific quirks stay inside the provider.
3. **Register it** in the `PROVIDERS` map in `registry.ts`.
4. **Declare its config** in `requiredEnv`. The generic layer needs no changes —
   the suffix-to-env mapping is generic.
5. **Add the gateway keys** under `taskSource.sources.<id>` in
   `tdai-gateway.yaml`, then set `TASK_SOURCE_ENABLED=<id>`.
6. **Reuse the existing routes.** They are provider-agnostic; a new provider is
   reachable as soon as it is in `PROVIDERS` and enabled.

Because the registry holds no state and only `import-service.ts` writes to the
database, a new source never needs changes outside its own directory plus the
one registry entry.

Imported rows are attributed to the reserved agent id `external-import`.

## Related

- Wiki and code sources live in MemoryKnowledge, not here.
- `TASK_SOURCE_*` config belongs to the **`tdai-memory-core`** container. Panel
  only forwards `/api/v1/task/source/*` → `/v3/task-source/*`.