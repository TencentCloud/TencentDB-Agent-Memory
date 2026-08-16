# Coupling Audit: TDAI ↔ pi Critic Knowledge

**Date:** 2026-08-04  
**Auditor:** researcher (automated)  
**Principle:** AGENTS.md — "TDAI НЕ знает и НЕ хочет знать: Есть ли критик, как он вызывается, что он проверяет. Какой pipeline внутри роли."

## Summary

TDAI Gateway **существенно нарушает** принцип минимальной связанности: код в `src/` содержит **полный critic pipeline** — от резолва critic-контракта через bootstrap, launch, stage, до записи verdict и receipt в БД. Это не просто знание о существовании критика — это **полноценная оркестрация critic-цикла внутри TDAI**.

Кроме того, `role.json` файлы содержат поле `critic_role`, которое TDAI парсит, валидирует и использует для резолва контракта критика. DB-схема хранит `criticReceipt`, `criticAttemptId`, `verdictJson`.

---

## Findings Table

| # | Компонент | Что есть | Нарушение принципа | Severity |
|---|-----------|----------|-------------------|----------|
| 1 | `src/gateway/role-schema.ts:37,128,163` | Поле `critic_role` в RoleConfigFile, валидация `v === null \|\| isStr(v)`, включение в `REQUIRED_PRESENT_FIELDS` | TDAI **знает формат** critic-поля и **требует** его в role.json | **high** |
| 2 | `src/gateway/role-loader.ts:86,113` | `RoleListing.criticRole` — поле в выдаче `/status`, парсинг `cfg?.critic_role ?? null` | TDAI **экспонирует** critic-информацию в API | **medium** |
| 3 | `src/gateway/consolidation/role-contract-types.ts:69` | `ResolvedRoleContract.criticRole: string \| null` | **Контракт** роли несёт знание о критике — TDAI резолвит и хранит critic-role как часть контракта | **high** |
| 4 | `src/gateway/consolidation/role-contract-legacy.ts:151,197` | `criticRole: cfg.critic_role ?? null` в LegacyRoleAdapter | TDAI **маппит** critic_role из role.json в контракт | **high** |
| 5 | `src/gateway/consolidation/critic-bootstrap.ts` (весь файл) | `resolveCriticPackage()` — полная валидация critic-контракта: проверка source, enabled, launcher, prompt | TDAI **полностью оркестрирует** bootstrap критика: резолв → валидация → проверка совместимости | **high** |
| 6 | `src/gateway/consolidation/critic-launch.ts` (весь файл) | `launchCritic()` — спавн критика, запись attempt, чтение verdict file | TDAI **запускает** критика как child-процесс и **читает его verdict** | **high** |
| 7 | `src/gateway/consolidation/critic-stage.ts` (весь файл) | `runCriticStage()` — gate между candidate и apply: bootstrap → launch → parse verdict → write receipt | TDAI **реализует critic-gate**: fail-closed логика, проверка candidateDigest, запись receipt | **high** |
| 8 | `src/gateway/consolidation/runner.ts:15,48-56` | `import { runCriticStage, digestOf }` + вызов `runCriticStage()` перед apply | **Конвейер** consolidation напрямую вызывает critic-stage как обязательный gate перед apply | **high** |
| 9 | `src/gateway/consolidation/execute-run.ts:17,73-84` | `import { resolveCriticPackage }` + вызов до первого LaunchAttempt | TDAI **блокирует** роль если critic не резолвится (enforce mode) | **high** |
| 10 | `src/gateway/consolidation/runner-stages.ts:111` | Комментарий "rule critic-launch.ts applies to critic.json" | Мягкое знание — только комментарий | **low** |
| 11 | `src/gateway/l1/l1-role-resolution.ts:31-57` | `resolveL1RolePair()` — резолв extractor + critic как пары, проверка enabled/source/artifactTransport | TDAI **резолвит critic-контракт** для L1 pipeline и **валидирует** его | **high** |
| 12 | `src/gateway/l1/l1-dispatch-review.ts:32,55-88,117,129` | `reviewL1Candidate()` — запуск critic-роли, парсинг verdict, запись critic.json, проверка digest match | TDAI **полностью оркестрирует** L1 critic-ревью: spawn → parse → approve/reject → DB write | **high** |
| 13 | `src/gateway/l1/l1-dispatch-pair.ts:27,65,84-96` | `executeL1RolePair()` — retry loop с critic-rejected, budget取min(extractor, critic) | TDAI **управляет** retry-логикой критика: знает budget критика, обрабатывает `critic-rejected` | **high** |
| 14 | `src/gateway/l1/l1-status-repo.ts:15-17,59-61` | `L1StatusProjection.criticAttemptId/criticOutcome/criticVerdict` | TDAI **проецирует** critic-состояние в status API | **medium** |
| 15 | `src/gateway/l1/l1-attempt-repo.ts:11,51,61-66` | `recordL1CriticVerdict()` — UPDATE с criticAttemptId, verdictJson, verdictDigest, state | TDAI **персистит** critic-verdict в БД | **high** |
| 16 | `src/gateway/l1/l1-dispatch-fixture.ts:35-88` | Test fixture с `criticVerdict` параметром, fake launcher по role.endsWith("critic") | Tесты ** кодируют** знание о critic-role naming convention | **low** |
| 17 | `src/gateway/l1/l1-role-installer.ts:7` | `ROLE_NAMES = ["l1-extractor", "l1-extractor-critic"]` | TDAI **хардкодит** имена critic-ролей | **medium** |
| 18 | `src/gateway/control-plane/db.ts:37` | `criticReceipt TEXT` в runs table | DB-схема **хранит** critic-receipt как column | **medium** |
| 19 | `src/gateway/control-plane/l1-schema.ts:30,52` | `criticReceiptDigest TEXT`, `criticAttemptId TEXT` в L1 tables | DB-схема **хранит** critic-поля для L1 | **medium** |
| 20 | `src/gateway/control-plane/run-repo.ts:15,86` | `criticReceipt` в RunPatch/RunRow SELECT | Run repository **читает/пишет** criticReceipt | **medium** |
| 21 | `src/gateway/control-plane/applying.ts:20` | Комментарий "the critic deliberately writes no receipt" | Мягкое знание | **low** |
| 22 | `src/gateway/apply-executor/run-policy.ts:63` | Комментарий "reviewed is written only on approval (critic-stage.ts)" | Мягкое знание | **low** |
| 23 | `src/gateway/apply-executor.ts:118` | Комментарий "the critic digested the bytes" | Мяггкое знание | **low** |
| 24 | `src/agents/role-execution-service.ts:72` | `kind: "launch" \| "critic"` в runStdoutRoleAttempt | TDAI **различает** типы attempts по critic/launch | **medium** |
| 25 | `src/core/record/l1-agent-types.ts:62,71,81` | `"critic-rejected"` failure kind, `criticReceipt` в L1DispatchResult, shutdown comment | Core типы **кодируют** critic-состояние | **medium** |
| 26 | `src/gateway/memory-skills.test.ts:46-55,125-157` | Тесты на critic skills: проверка night-critic/memory-critic/dedup-daily-critic | Tесты **кодируют** знание о critic skills и их relationship | **low** |
| 27 | `src/gateway/consolidation/role-contract.test.ts:4,57,122` | Тест на `critic_role` в контракте | Tесты **кодируют** critic-role валидацию | **low** |
| 28 | `src/gateway/consolidation/critic-stage.test.ts` (весь файл) | Тесты critic-stage: verdict parsing, approve/reject flow | Tесты **кодируют** полный critic pipeline | **low** |
| 29 | `src/gateway/consolidation/critic-bootstrap.test.ts` (весь файл) | Тесты bootstrap: no critic_role, disabled, empty prompt | Tесты **кодируют** critic bootstrap логику | **low** |
| 30 | `src/gateway/consolidation/characterization.test.ts:110,142,163` | `critic_role: "memory-critic"`, `"night-critic"`, `"dedup-daily-critic"` в characterization tests | Tесты **кодируют** знание о конкретных critic-ролях | **low** |
| 31 | `src/gateway/role-files.test.ts:47,153,162` | `critic_role: "memory-critic"` в test fixtures | Tесты **кодируют** critic-role в fixtures | **low** |
| 32 | `src/utils/pipeline-factory/l1-runner.test.ts:84` | "does not advance the cursor when the critic rejects" | Tест **кодирует** critic reject behavior | **low** |
| 33 | `src/gateway/l1/l1-receipt-mismatch.test.ts:20,52` | "L1 critic receipt" test, criticAttemptId | Tесты **кодируют** critic receipt logic | **low** |
| 34 | `src/gateway/l1/l1-durable-protocol.test.ts:99` | `criticAttemptId: "critic-1"` | Tест **кодирует** critic attempt ID | **low** |

### Role.json файлы

| Файл | `critic_role` | Нарушение |
|------|--------------|-----------|
| `roles/l1-extractor/role.json` | `"l1-extractor-critic"` | TDAI **требует** critic_role в schema → role.json обязан его декларировать |
| `roles/l1-extractor-critic/role.json` | `null` | Critic сам не имеет critic_role (корректно) |
| `~/.pi/agent-memory/tdai/roles/*/role.json` (12 файлов) | Нет поля `critic_role` | Legacy-роли не декларируют critic → TDAI резолвит `null` |

### Ключевые файлы-нарушители (полный critic pipeline)

1. **`src/gateway/consolidation/critic-bootstrap.ts`** — 72 строки, полный bootstrap критика
2. **`src/gateway/consolidation/critic-launch.ts`** — 109 строк, spawn критика + чтение verdict
3. **`src/gateway/consolidation/critic-stage.ts`** — 145 строк, gate: bootstrap → launch → parse → receipt
4. **`src/gateway/l1/l1-dispatch-review.ts`** — 130 строк, L1 critic review pipeline
5. **`src/gateway/l1/l1-dispatch-pair.ts`** — 96 строк, L1 pair execution с critic retry
6. **`src/gateway/l1/l1-role-resolution.ts`** — 57 строк, L1 role pair resolution

**Итого ~609 строк** чистого critic pipeline кода внутри TDAI Gateway.

---

## Severity Summary

| Severity | Count | Description |
|----------|-------|-------------|
| **high** | 14 | Полная оркестрация critic pipeline: bootstrap, launch, stage, L1 review, L1 pair, role resolution, schema, contract |
| **medium** | 11 | DB schema поля, API exposure, типы, хардкод имён ролей |
| **low** | 9 | Комментарии и тесты (мягкое знание, не нарушает runtime behavior) |

---

## Architectural Analysis

Согласно AGENTS.md, TDAI должен делать **ровно две вещи**:
1. Отдать задачу агенту (запустить pi с ролью через RoleLauncher)
2. Забрать результат (прочитать `diff.json` из scratch и применить через `/memory/apply`)

Фактически TDAI **делает значительно больше**:

### Что TDAI делает сверх принципа:

1. **Резолвит critic-контракт** (`critic-bootstrap.ts`, `l1-role-resolution.ts`) — знает имя critic-роли, её role.json, prompt, binding
2. **Валидирует critic-контракт** (`critic-bootstrap.ts`) — проверяет source, enabled, launcher, prompt
3. **Спавнит критика** (`critic-launch.ts`) — создаёт child-процесс, пишет prompt, читает verdict
4. **Реализует critic-gate** (`critic-stage.ts`) — fail-closed логика, проверка candidateDigest
5. **Парсит verdict** (`critic-stage.ts`) — JSON.parse, проверка полей
6. **Записывает receipt** (`critic-stage.ts`, `l1-attempt-repo.ts`) — criticReceipt в DB
7. **Управляет retry** (`l1-dispatch-pair.ts`) — retry budget = min(extractor, critic)
8. **Хранит critic state в DB** — `criticReceipt`, `criticAttemptId`, `verdictJson`, `verdictDigest`

### Аргументы ЗА текущую архитектуру:

- **Fail-closed gate** требует знания о verdict на уровне TDAI — иначе gate невозможен
- **Lease/fence** привязан к candidate → critic receipt → apply — цепочка требует единой точки контроля
- **Shadow mode** позволяет ship без critic package — TDAI может работать в degraded mode
- **DB schema** хранит critic state для crash recovery и audit trail

### Аргументы ПРОТИВ (нарушение принципа):

- **609 строк** critic pipeline кода в TDAI — это не "забирает результат", это "оркестрирует весь critic цикл"
- **TDAI спавнит** критика — это внутреннее дело pi-роли
- **TDAI парсит verdict** — формат verdict внутренний контракт между ролью и критиком
- **role.json содержит `critic_role`** — TDAI знает о существовании критика через конфиг

---

## Gaps

- Не проверены `core/prompts/skills/*/SKILL.md` — они содержат инструкции для критиков, но это промпты, а не код TDAI
- Не проверены `src/gateway/consolidation/launchers/` — launcher может неявно знать о critic через contract
- Не проверены migration scripts — могут содержать critic-related schema changes
- `~/.pi/agent-memory/tdai/roles/` не содержит critic_role ни в одном role.json — legacy-роли живут без критиков
