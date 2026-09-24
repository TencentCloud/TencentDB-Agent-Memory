# Code Graph 稀疏检出 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Code Graph 增加可持久化、可同步的 `sparse_paths` 配置，减少大仓库检出和索引的资源消耗。

**Architecture:** 路由负责输入校验，SQLite 元数据保存规范化 JSON，CodeGraphService/worker 在构建和同步时传递配置，GitSourceFetcher 负责执行 sparse-checkout。默认空配置保持当前完整浅克隆行为。

**Tech Stack:** TypeScript、Hono、Drizzle/better-sqlite3、simple-git、Vitest。

## Global Constraints

- 不增加运行时依赖。
- `sparse_paths` 为空或缺省时保持完整检出兼容性。
- Git 参数必须继续通过 simple-git 参数数组传递。
- 路径必须是相对 POSIX 路径，拒绝绝对路径、`.`、`..`、空路径段和反斜杠。
- 每完成一个任务运行对应测试，并只提交本任务文件。

---

### Task 1: 路径规范化与 Git fetcher 契约

**Files:**
- Create: `MemoryKnowledge/src/source-fetcher/sparse-paths.ts`
- Create: `MemoryKnowledge/src/source-fetcher/sparse-paths.test.ts`
- Modify: `MemoryKnowledge/src/source-fetcher/types.ts`

**Interfaces:**
- Produces `normalizeSparsePaths(value: unknown): string[]`, which throws on invalid input and returns deduplicated normalized paths.
- Extends `ISourceFetcher.fetch` and `sync` with optional `sparsePaths?: string[]`.

- [ ] **Step 1: Write failing tests** for valid paths, deduplication, empty arrays, absolute paths, traversal, empty segments, and non-array input.
- [ ] **Step 2: Run** `cd MemoryKnowledge && npm test -- src/source-fetcher/sparse-paths.test.ts`; expect failure because the helper does not exist.
- [ ] **Step 3: Implement** `normalizeSparsePaths` with the exact validation rules from the spec.
- [ ] **Step 4: Run** the focused test and confirm all cases pass.
- [ ] **Step 5: Extend** `ISourceFetcher` signatures with the optional argument and run `npm run typecheck` if available.

### Task 2: Git sparse clone and sync

**Files:**
- Modify: `MemoryKnowledge/src/source-fetcher/git-fetcher.ts`
- Create: `MemoryKnowledge/src/source-fetcher/git-fetcher.test.ts`

**Interfaces:**
- `GitSourceFetcher.fetch(sourceUrl, branch, localPath, sparsePaths?)`.
- `GitSourceFetcher.sync(sourceUrl, branch, localPath, sparsePaths?)`.

- [ ] **Step 1: Write failing tests** using a fake simple-git boundary to assert default clone options, sparse clone options, and sparse-checkout reapplication during sync.
- [ ] **Step 2: Run** the focused test and confirm it fails because sparse arguments are not present.
- [ ] **Step 3: Implement** sparse clone with `--filter=blob:none`, `--sparse`, and `sparseCheckout("set", ["--cone", ...paths])`; reapply it after sync reset.
- [ ] **Step 4: Run** focused tests and confirm default and sparse paths both pass.
- [ ] **Step 5: Run** `cd MemoryKnowledge && npm run typecheck` and fix only feature-related errors.

### Task 3: Persist sparse configuration

**Files:**
- Modify: `MemoryKnowledge/src/db/schema.ts`
- Modify: `MemoryKnowledge/src/db/client.ts`
- Modify: `MemoryKnowledge/src/store/types.ts`
- Modify: `MemoryKnowledge/src/store/sqlite-store.ts`
- Create or modify: `MemoryKnowledge/src/store/code-graph-sparse.test.ts`

**Interfaces:**
- `CodeGraphRow.sparse_paths: string[]`.
- `CreateCodeGraphInput.sparse_paths?: string[]`.
- Store serialization uses JSON text and returns `[]` for legacy/null rows.

- [ ] **Step 1: Write failing store tests** for create/read round-trip and legacy row default.
- [ ] **Step 2: Run** the focused store test and confirm failure.
- [ ] **Step 3: Add** nullable `sparse_paths` column to Drizzle schema and idempotent runtime migration.
- [ ] **Step 4: Implement** JSON serialization/deserialization in create and row mapping.
- [ ] **Step 5: Run** focused store tests and confirm pass.

### Task 4: Route, service, and worker propagation

**Files:**
- Modify: `MemoryKnowledge/src/routes/code-graph.ts`
- Modify: `MemoryKnowledge/src/store/code-graph-service.ts`
- Modify: `MemoryKnowledge/src/module.ts`
- Modify: `MemoryKnowledge/src/api-helpers.ts`
- Create or modify: `MemoryKnowledge/src/routes/code-graph-sparse.test.ts`

**Interfaces:**
- `POST /create` accepts `sparse_paths` and returns it in the resource detail.
- CodeGraphWorker context carries `sparsePaths: string[]`.
- Fetcher calls receive the persisted paths for both clone and sync.

- [ ] **Step 1: Write failing route/worker tests** for request validation and propagation.
- [ ] **Step 2: Run** focused tests and confirm failure.
- [ ] **Step 3: Implement** route normalization, service input propagation, detail serialization, and worker fetch/sync propagation.
- [ ] **Step 4: Run** focused route/worker tests and confirm pass.
- [ ] **Step 5: Run** MemoryKnowledge typecheck and full test suite.

### Task 5: Documentation and final verification

**Files:**
- Modify: `MemoryKnowledge/README.md`
- Modify: `MemoryKnowledge/openapi.yaml` if Code Graph create schema is documented there

- [ ] **Step 1: Document** `sparse_paths`, its defaults, validation rules, and a large-monorepo example.
- [ ] **Step 2: Run** `npm test`, `npm run build`, and `git diff --check` from the relevant package.
- [ ] **Step 3: Review** the diff for unrelated changes and verify migration compatibility.
- [ ] **Step 4: Commit**, push, and open a Draft PR referencing #941.
