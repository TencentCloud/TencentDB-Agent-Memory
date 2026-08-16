# Факты архитектуры TDAI (замер)

Дата замера: 2026-08-15. Файлов без тестов: 374.

## 1. Циклы между модулями (взаимный импорт)

- `agents` ⇄ `gateway/consolidation`
- `core` ⇄ `core/hooks`
- `core` ⇄ `core/record`
- `core` ⇄ `core/store`
- `core` ⇄ `core/tools`
- `core` ⇄ `utils`
- `core/conversation` ⇄ `utils`
- `core/hooks` ⇄ `core/store`
- `core/hooks` ⇄ `src(root)`
- `core/persona` ⇄ `utils`
- `core/profile` ⇄ `core/record`
- `core/prompts` ⇄ `core/record`
- `core/record` ⇄ `core/scene`
- `core/record` ⇄ `core/store`
- `core/record` ⇄ `utils`
- `core/scene` ⇄ `utils`
- `core/store` ⇄ `utils`
- `gateway` ⇄ `gateway/apply-executor`
- `gateway` ⇄ `gateway/consolidation`
- `gateway` ⇄ `gateway/control-plane`
- `gateway` ⇄ `gateway/l1`
- `gateway` ⇄ `gateway/memory-routes`
- `gateway` ⇄ `utils`
- `src(root)` ⇄ `utils`

## 2. Где выполняется SQL

Файлов, выполняющих SQL напрямую: **37**

| модуль                   | файлов с SQL |
| ------------------------ | -----------: |
| `gateway/control-plane`  |           11 |
| `offload`                |            6 |
| `gateway/l1`             |            5 |
| `gateway`                |            4 |
| `gateway/consolidation`  |            4 |
| `core/store`             |            2 |
| `gateway/memory-routes`  |            2 |
| `gateway/apply-executor` |            1 |
| `utils`                  |            1 |
| `src(root)`              |            1 |

Топ-20 файлов по числу SQL-обращений:

| обращений | файл                                            | модуль                  |
| --------: | ----------------------------------------------- | ----------------------- |
|       157 | `src/core/store/sqlite.ts`                      | `core/store`            |
|        16 | `src/gateway/l1/l1-cohort-repo.ts`              | `gateway/l1`            |
|        13 | `src/gateway/l1/l1-attempt-repo.ts`             | `gateway/l1`            |
|        11 | `src/gateway/l1/l1-status-repo.ts`              | `gateway/l1`            |
|        11 | `src/gateway/http-utils.ts`                     | `gateway`               |
|        10 | `src/gateway/control-plane/run-repo.ts`         | `gateway/control-plane` |
|         9 | `src/gateway/consolidation/diff-builder.ts`     | `gateway/consolidation` |
|         7 | `src/gateway/l1/l1-assignment-repo.ts`          | `gateway/l1`            |
|         7 | `src/gateway/control-plane/oplog.ts`            | `gateway/control-plane` |
|         7 | `src/gateway/control-plane/lease.ts`            | `gateway/control-plane` |
|         7 | `src/gateway/control-plane/checkpoint-claim.ts` | `gateway/control-plane` |
|         7 | `src/gateway/control-plane/attempt-repo.ts`     | `gateway/control-plane` |
|         5 | `src/gateway/server.ts`                         | `gateway`               |
|         5 | `src/gateway/memory-routes/validate-checks.ts`  | `gateway/memory-routes` |
|         5 | `src/gateway/control-plane/applying.ts`         | `gateway/control-plane` |
|         4 | `src/gateway/reports.ts`                        | `gateway`               |
|         4 | `src/gateway/memory-routes/helpers.ts`          | `gateway/memory-routes` |
|         4 | `src/gateway/l1/l1-cohort-write.ts`             | `gateway/l1`            |
|         4 | `src/gateway/control-plane/run-row.ts`          | `gateway/control-plane` |
|         4 | `src/gateway/consolidation/queries.ts`          | `gateway/consolidation` |

## 3. Межмодульные рёбра

| импортов | из                       | в                        |
| -------: | ------------------------ | ------------------------ |
|       23 | `gateway/consolidation`  | `gateway`                |
|       19 | `gateway`                | `gateway/apply-executor` |
|       19 | `gateway/consolidation`  | `gateway/control-plane`  |
|       18 | `services`               | `core/record`            |
|       17 | `core/hooks`             | `core/store`             |
|       15 | `core/record`            | `core/store`             |
|       14 | `gateway/consolidation`  | `core`                   |
|       13 | `gateway/memory-routes`  | `gateway`                |
|       12 | `gateway/l1`             | `core/record`            |
|       12 | `utils`                  | `core/store`             |
|       11 | `gateway/l1`             | `gateway/control-plane`  |
|       10 | `gateway/l1`             | `gateway/consolidation`  |
|        9 | `gateway`                | `core`                   |
|        8 | `core/hooks`             | `core`                   |
|        8 | `core/record`            | `core`                   |
|        7 | `gateway`                | `gateway/memory-routes`  |
|        7 | `gateway/apply-executor` | `gateway`                |
|        7 | `services`               | `core/store`             |
|        6 | `core/persona`           | `utils`                  |
|        6 | `core/record`            | `utils`                  |
|        6 | `core/tools`             | `core/store`             |
|        6 | `gateway`                | `utils`                  |
|        6 | `utils`                  | `core`                   |
|        6 | `utils`                  | `src(root)`              |
|        6 | `utils`                  | `gateway/l1`             |
|        5 | `core/hooks`             | `src(root)`              |
|        5 | `core/store`             | `core`                   |
|        5 | `gateway`                | `gateway/consolidation`  |
|        5 | `gateway/l1`             | `core`                   |
|        5 | `utils`                  | `core/record`            |

## 4. Размеры

Всего строк без тестов: 59296

| строк | файл                                        |
| ----: | ------------------------------------------- |
|  3924 | `src/core/store/sqlite.ts`                  |
|  1584 | `src/core/store/tcvdb.ts`                   |
|  1451 | `src/gateway/server.ts`                     |
|  1177 | `src/config.ts`                             |
|   887 | `src/core/store/embedding.ts`               |
|   661 | `src/core/conversation/l0-recorder.ts`      |
|   630 | `src/core/record/l1-dedup.ts`               |
|   594 | `src/offload/hooks/after-tool-call.ts`      |
|   584 | `src/gateway/probe.ts`                      |
|   565 | `src/utils/clean-context-runner.ts`         |
|   559 | `src/core/tdai-core.ts`                     |
|   550 | `src/core/scene/scene-extractor.ts`         |
|   545 | `src/utils/checkpoint.ts`                   |
|   532 | `src/gateway/consolidation/diff-builder.ts` |
|   530 | `src/gateway/cleanup.ts`                    |

| модуль                   | файлов |
| ------------------------ | -----: |
| `offload`                |     81 |
| `gateway/consolidation`  |     64 |
| `utils`                  |     35 |
| `gateway/apply-executor` |     24 |
| `gateway/l1`             |     23 |
| `gateway`                |     22 |
| `gateway/control-plane`  |     18 |
| `core/record`            |     17 |
| `core/hooks`             |     14 |
| `core/store`             |     10 |
| `consumer`               |     10 |
| `gateway/memory-routes`  |      8 |
| `adapters`               |      7 |
| `core/scene`             |      7 |
| `services`               |      6 |
| `core/prompts`           |      4 |
| `core`                   |      3 |
| `core/seed`              |      3 |
| `core/context`           |      3 |
| `cli`                    |      2 |
| `core/persona`           |      2 |
| `core/profile`           |      2 |
| `core/tools`             |      2 |
| `agents`                 |      2 |
| `src(root)`              |      1 |
| `core/conversation`      |      1 |
| `core/report`            |      1 |
| `test-support`           |      1 |
| `repo`                   |      1 |

## 5. Цена одной фичи (замер по истории)

| коммит    | не-тестовых `.ts` | что это было                                                      |
| --------- | ----------------: | ----------------------------------------------------------------- |
| `e362999` |                68 | `feat(l1): wire agentic extraction into the gateway pipeline`     |
| `87f9647` |                18 | `feat(l1): add durable agent extraction protocol`                 |
| `f832dc3` |                 2 | `fix(tz-03b): shutdown waits for the bookkeeping it started`      |
| `f07fd3d` |                 1 | `fix(feedback): a confirmed record stops at the top of the scale` |

Отдельно — цена ОДНОГО поля. Цикл «пооперационная отбраковка» (2026-08-15) добавил
в результат apply одно поле `rejected` и потребовал правки в 12 не-тестовых файлах
плюс в 3 рукописных литералах `ApplyResult`, разбросанных по тестам и пробам:

```
apply-executor/types.ts        — объявление поля
apply-executor/schemas.ts      — поэлементные схемы
apply-executor/salvage.ts      — новый слой формы
apply-executor/validate.ts     — семантика
apply-executor/manifest.ts     — сигнатура
apply-executor.ts              — сборка
consolidation/apply-batch.ts   — перекладывание поля
consolidation/runner.ts        — инициализация
consolidation/runner-types.ts  — ПОВТОРНОЕ объявление поля
consolidation/types.ts         — ТРЕТЬЕ объявление поля
consolidation/night-batches.ts — накопление
consolidation/run-strategy-fresh-tail.ts — накопление
```

Причина не в размере системы, а в том, что результат ПЕРЕОБЪЯВЛЯЕТСЯ на каждом
переходе (`ApplyResult` → `RunBatchResult` → `RunSummary`) вместо того, чтобы
ссылаться на один владеющий тип.
