# Идеальный пайплайн памяти TDAI

> **Статус:** аналитический документ. Описывает, КАК память TDAI должна работать
> в идеальном случае, и весь пайплайн памяти с архитектурой и слоями.
> Факты о текущем состоянии — из реального кода репозитория `TencentDB-Agent-Memory`
> (состояние на 2026-08-07), проверены чтением `src/`, `tdai-gateway.yaml`,
> живой БД и логов. Пункты «как должно быть» явно помечены **«(идеал/цель)»**.
>
> **Частично устарел на 2026-08-10 — расхождения с `agent-architecture.md` разрешаются в пользу модели, не этого файла.** Три места читать с поправкой: тезисы «L2 — no-op» и «сцены разрежены» (`:24-26`, `:116`, `:532`) опровергнуты, на диске 31 файл сцен и L2 работает; §9 шаг 3 (`:562`) предлагает «снять single-writer gate и включить инлайн-L2/L3» — это ровно тот путь, который tz-02 (A1c) называет источником третьего писателя (`profile-sync.ts:151-155` делает `rm -rf` каталога сцен), то есть предложение разрушает гарантию `single-scene-writer`, а не приближает её; сам файл не цитируется ни в `agent-architecture.md`, ни в `tz/README.md` — источником требований он не является.
>
> Смежный документ: `docs/specs/requirements-memory-agents-draft.md` — черновик
> требований пользователя и целевой архитектуры (§8/§8а/§8б/§8в). Этот документ
> опирается на него и пересекается с ним по агентной подсистеме.

> **Поправка 2026-08-14 для M0→M1 (code:L0→L1):** inline-LLM extraction и fail-open «store all» больше не являются production-путём. Scheduler сохраняет oldest-first cohort и immutable assignment, общий role runtime запускает extractor и отдельного critic, parent-side recall ограничивает допустимые update/merge targets, а родитель коммитит только digest-approved candidate. Assignment/attempt/oplog durable; cursor двигается лишь после JSONL + `IMemoryStore` postconditions, restart replay чинит missing/divergent retrieval projection. Актуальное состояние видно в `/status.l1`. Утверждения ниже о старом `extractL1Memories` оставлены как датированный аудит 2026-08-07, не как описание текущего L1.

---

## 1. Введение

Память TDAI — это подсистема, которая превращает сырые разговоры агента в
структурированные воспоминания (записи, сцены, персону) и отдаёт их обратно в
контекст через recall. Она существует, чтобы агент «знал» о прошлом: о проектах,
инструкциях пользователя и его предпочтениях, не держа всё это в промпте вручную.

Сейчас (по фактам аудита и живой проверке 2026-08-07) память работает плохо:

- **Слои L2/L3 фактически выключены.** При включённой консолидации
  (`memory.consolidation.enabled=true`) инлайн-L2 (сцены) и инлайн-L3 (персона)
  становятся no-op из-за single-writer gate (`src/utils/pipeline-factory/l2-runner.ts`,
  `l3-runner.ts`): сцены и персону должен писать keeper через `/memory/apply`,
  но keeper применяет пустые диффы → сцены по проектам почти не собираются
  (только `_global` 5, `penis` 7, `u24` 5, `portfolio-new` 2 + папки аудиторских
  сессий), `persona.md` не переписывался с 04.08 20:06.
- **Дедуп не работает.** Аудит §7 (на 07.08): 91 кластер дублей, 234 члена
  (≈63% базы L1). Живой `memory_health.md` (2026-08-07T18:41:30Z): 90 кластеров,
  227 членов. Роль `dedup-daily` (расписание 03:00) существует в
  `~/.pi/agent-memory/tdai/roles/`, но **никем не вызывается** — в коде нет
  диспетчера per-role расписаний.
- **Ночной раннер не запускался.** `night-keeper` (06:00) не отработал ни разу:
  баг `ranToday` в `night-run.ts` — `getLastRunAt()` возвращает момент любого
  успешного рана (включая дневной `memory-keeper`), и день помечается как
  «уже бегали».
- **Keeper нестабилен: полезные раны сменяются пустыми.** По логам 07.08 keeper периодически применял непустые диффы (4 merge + 62 rewriteBlock; сцены переписаны 10:27/11:40), но с 15:02 все раны пустые: `recordsPresented` 0–3, `applied` = 0, длительность 134–497 с (один таймаут ~30 мин); три рана упали с «merge cluster member … was not presented to the memory-keeper (cluster ids must be ⊆ the diff)».
- **Recall-качество не измеряется и плохо настроено.** `probe-corpus.json`
  отсутствует → precision@k = `skipped`. `scoreThreshold: 0.2` слишком низкий
  (рекомендация 0.7+), `typeWeights` все 1.0 (выключены). В текущей сессии 4 из 5
  записей recall — почти одинаковые инструкции (дубли).
- **Критики не вызываются.** В контрактах ролей указан `critic_role`
  (`memory-critic`, `night-critic`, `dedup-daily-critic`), но в пайплайне рана
  (`runner.ts`, `runner-stages.ts`) этот механизм не используется.

**Что внутри документа:** §2 — слои памяти, §3 — идеальный пайплайн как единый
цикл, §4 — целевая архитектура (core/gateway/agents и пересечения с §8–§8в),
§5 — роли консолидации, §6 — recall, §7 — наблюдаемость, §8 — таблица
«сейчас vs идеал», §9 — этапы перехода.

---

## 2. Слои памяти и их назначение

Память TDAI организована в четыре слоя. Нижние — сырьё, верхние — сжатая
интерпретация.

В этом документе далее это **durable memory `M0..M3`**. Фактические имена таблиц и классов пока остаются `L0..L3`; ссылки на них помечаются `code:L*`. В целевой архитектуре префикс `M` обязателен, потому что `src/offload/` использует второй несовместимый словарь L1/L1.5/L2/L3/L4. Его слои называются **offload `O1/O1.5/O2/O3/O4`**.

```text
M0 ──► M1 ──► M2 ──► M3
сырые     записи     сцены     персона
разговоры (episodic/ (по проектам)
          instruction/
          persona)
   │          │         │         │
   └──────────┴─────────┴─────────┘
                 recall (чтение L1 + L2 + L3)
```

### 2.1. M0 (code:L0) — сырые разговоры

- **Что хранит:** каждое user/assistant-сообщение как отдельную строку JSONL
  в `conversations/YYYY-MM-DD.jsonl` (по одному файлу на день, все сессии вперемешку,
  `sessionKey` — поле строки) — `src/core/conversation/l0-recorder.ts`.
  Поля: `sessionKey`, `sessionId`, `id`, `role`, `content`, `timestamp`,
  `recordedAt`, `projectId`.
- **Как пополняется:** `recordConversation()` вызывается из хука после ответа
  агента (agent_end). Инкрементальность — двойная защита: позиционный срез
  (`originalUserMessageCount`, кэш на момент before_prompt_build) и timestamp-курсор
  (`afterTimestamp`, строгое `>`). Сообщения санитизируются (`sanitizeText`,
  вырезаются fenced code blocks у ассистента, base64-картинки → `[image]`),
  мусор отфильтровывается (`shouldCaptureL0`). Запись асинхронная и не блокирует
  ответ агента.
- **Как читается:** `readConversationRecords` / `readConversationMessages` /
  `readConversationMessagesGroupedBySessionId` (группировка по `sessionId` —
  важно для L1: каждая группа = отдельный экземпляр сессии). Плюс L0 поиск через
  FTS (`/search/conversations`).

### 2.2. M1 (code:L1) — структурированные записи

- **Что хранит:** таблица `l1_records` в `vectors.db` (SQLite). На 07.08 ~23:00:
  **378 записей** (по живой БД): episodic 236, instruction 86, persona 56.
  Тип записи (`type`), контент (обрезается до `MAX_CONTENT_CHARS = 600`),
  `scene_name`, `session_key/session_id`, таймстемпы, `project_id`, `scope`
  (`global`/`project`), `priority` (по умолчанию 50, поднимается через
  `/memory/feedback`).
- **Как пополняется:** экстракция L1 из L0. Инициация — `notifyConversation`
  (`src/utils/pipeline/l1.ts`): буфер сообщений, срабатывание по порогу
  `everyNConversations` (в live-конфиге **1** — после каждого раунда) с warmup,
  плюс idle-таймер `l1IdleTimeoutSeconds` (live: 120 с). Затем `extractL1Memories`
  (`src/core/record/l1-extractor.ts`): quality-gate сообщений → LLM-экстракция
  с сегментацией на сцены → лимит на сессию → **batch-конфликт-детект + запись**
  (`runDedupOrStore` → `batchDedup`), при падении дедупа — запись всех как новых
  (fail-open).
- **Как читается:** recall-поиск (стратегия embedding/keyword/hybrid), прямые
  GET-роуты `/memory/records`, `/memory/search`, итерация keeper-ом
  (`queryRecentRecords` по курсору).

### 2.3. M2 (code:L2) — scene-блоки по проектам

- **Что хранит:** markdown-файлы `scene_blocks/<project>/<scene>.md` с META-шапкой,
  лимит `maxScenes` (15), лимит размера блока 1500 символов (по health-отчёту).
  Сцена = тематический контекст проекта («u24-homepage-bugfix-verdict-contract» и т.п.).
  **Сейчас разрежено:** `_global` 5, `penis` 7, `u24` 5, `portfolio-new` 2 +
  папки `agent-end-*` аудиторских сессий.
- **Как пополняется (сейчас):** инлайн-L2 — `createL2Runner`
  (`src/utils/pipeline-factory/l2-runner.ts`). **При `consolidation.enabled=true`
  это no-op** (single-writer gate, строка ~31): сцены должен писать keeper через
  `POST /memory/apply` (op `rewriteBlock`). Keeper применяет пустые диффы → сцены
  не собираются. Инлайн-путь (без консолидации) читает L1-записи с курсора,
  группирует по `projectId`, для каждой группы запускает `SceneExtractor.extract`.
- **Как читается:** `readSceneIndex(dataDir, projectId)` + `generateSceneNavigation`
  в recall — в системный промпт как `<scene-navigation>`, «карта» сцен текущего
  проекта. Это ключевой механизм «агент знает проект при старте».

### 2.4. M3 (code:L3) — персона

- **Что хранит:** `persona.md` в корне dataDir (сейчас ~1303/2000 символов, mtime
  04.08 20:06). Персона описывает пользователя в целом и сознательно читает сцены
  ВСЕХ проектов (`readAllSceneIndexes`), в отличие от recall, который фильтрует
  по проекту.
- **Как пополняется (сейчас):** `createL3Runner` (`l3-runner.ts`) — **no-op при
  консолидации** (тот же single-writer gate). Инлайн-путь: `PersonaTrigger`
  (`triggerEveryN`, дефолт 50) → `PersonaGenerator` (режим first/incremental по
  изменённым сценам, `stripSceneNavigation`, бэкапы `backupCount`=3). При
  консолидации персону должен переписывать keeper опом `rewritePersona` — но не
  пишет. Итог: персона фактически заморожена (аудит §7: не обновлялась с 02.08;
  файл не менялся с 04.08).
- **Как читается:** recall инжектит в системный промпт как `<user-persona>`
  (лимит `maxPersonaChars`=6000).

### 2.5. O1..O4 — short-term offload текущей сессии

Offload не является верхними слоями durable memory. Это рабочее состояние сжатия контекста одной активной сессии:

- `O1/O1.5` — первичное offload-решение и judge;
- `O2` — группировка/сводка offload-entries;
- `O3` — компрессия текущей истории;
- `O4` — одноразовый результат, добавляемый в ближайшую сборку контекста владельца.

У каждого state/job/artifact есть owner `{sessionKey, sessionId}`. Fallback к общему `lastActiveMgr` и общий `pendingResult` запрещены: это смешивает контекст параллельных сессий. Полный контракт, `ContextEnvelope`, budget policy и приёмка — [tz-10](tz/tz-10-context-assembly.md).

Финальная сборка контекста — отдельная pure-функция над структурированными items, а не конкатенация строк из разных подсистем:

```text
durable M1/M2/M3 ─┐
session O2/O3/O4 ─┼─► ContextAssembler(policy, tokenBudget) ─► ContextEnvelope
current prompt ───┘      identity · scope · provenance · scores · exclusions
```

Ни generic keeper, ни хороший dedup сами по себе не гарантируют качественный ответ: `session-state-isolated`, `context-envelope-complete` и `context-budget-enforced` являются отдельными инвариантами.

---

## 3. Идеальный пайплайн памяти (как ДОЛЖНО работать)

**(идеал/цель)** Полный цикл от захвата разговора до отдачи в recall и обратной
связи. Каждый шаг: что делает, кто инициирует, какие события/счётчики порождает.

```text
 capture M0 → M1 extraction (dedup) → M2 scene (per project) → M3 persona
    │           │                       │                      │
    │           ▼                       ▼                      ▼
    │      счётчик newM1          счётчик scenes_updated   счётчик persona_updated
    │           │                       │                      │
    └───────────┴───────► события слоёв памяти ──► экстеншены-подписчики
                            (onM1Extracted, onM2ScenesUpdated,       │
                             onPersonaUpdated, onThresholdCrossed)    │
                                                                      ▼
                                    диспетчер/триггеры ролей (по контракту роли:
                                    schedule | threshold | manual)
                                                                      │
                                    ┌───────────────┬────────────────┴───┐
                                    ▼               ▼                    ▼
                              memory-keeper    night-keeper        dedup-daily
                              (fresh_tail)     (full_store)        (full_store dedup)
                                    │               │                    │
                                    └───────► /memory/apply (diff) ──────┘
                                                        │
                                                        ▼
                                              apply-executor: deleteL1 / merge /
                                              rewriteBlock / rewriteRecord / rewritePersona
                                                        │
                                                        ▼
                                              reindex + probe (precision@k) + memory_health.md
                                                        │
                                                        ▼
                                              recall (проектный приоритет) → feedback
                                              (/memory/feedback) → следующий recall
```

### Шаг 1. Capture (захват разговора)

- **Что:** L0-запись новых сообщений сессии в JSONL (как в §2.1).
- **Кто инициирует:** хук agent_end после каждого ответа агента; `POST /capture`.
- **События/счётчики:** после транзакции записи — событие **onM0Captured**
  (+N сообщений), инкремент счётчика «сырого» в БД (посттранзакционный хук).

### Шаг 2. M1 extraction (code:L1, с дедупом)

- **Что:** quality-gate → LLM-экстракция записей → **дедуп при записи**
  (batch-конфликт-детект: похожие на существующие → merge/дубль не сохраняется).
  Курсор L1 двигается только при успехе; при падении батч перепрезентируется.
- **Кто инициирует:** `notifyConversation` по порогу раундов / idle-таймеру
  (live: 1 раунд / 120 с).
- **События/счётчики:** **onM1Extracted** (+N записей) — главный счётчик, на
  который смотрят роли дедупа и сборщики; инкремент `newL1` в БД.
- **(идеал/цель)** дедуп на этом шаге — первый барьер против «63% базы — дубли»;
  текущий batchDedup существует, но база уже загрязнена — нужен и массовый
  проход (dedup-daily, шаг 5).

### Шаг 3. M2 scene extraction (code:L2, по проектам)

- **Что:** из новых L1-записей формируются/обновляются scene-блоки **по
  `project_id`** (один батч на проект). Сцены — сжатый «контекст проекта».
- **Кто инициирует:** таймер после L1 (delay после L1 / min-interval / max-interval)
  в инлайн-режиме; при консолидации — **keeper (идеал)** через `rewriteBlock`,
  либо повторное включение инлайн-L2 (решение — §9, шаг 3).
- **События/счётчики:** **onM2ScenesUpdated** — ключ к «агент знает проект при
  старте» (этот счётчик кормит recall проектного контекста и роль-сборщик).

### Шаг 4. M3 persona (code:L3)

- **Что:** пересборка `persona.md` из изменённых сцен всех проектов (incremental).
- **Кто инициирует:** после L2 по `triggerEveryN` (дефолт 50) в инлайн-режиме;
  при консолидации — keeper (идеал) через `rewritePersona`.
- **События/счётчики:** **onPersonaUpdated** (+1) — «после апдейта персоны».

### Шаг 5. Роли консолидации (сбор, дедуп, ночная зачистка)

- **Что:** три роли по контракту (подробно §5): memory-keeper (свежий хвост),
  night-keeper (полный стор, ночной прогон), dedup-daily (массовый дедуп).
  Применение через `/memory/apply` с механическими caps.
- **Кто инициирует:** **(идеал/цель)** диспетчер по контракту роли: per-role
  schedule/threshold из `role.json` + per-role single-flight (RoleGate — уже есть);
  события durable-слоёв (onM1Extracted/onThresholdCrossed) могут триггерить роли через
  экстеншены-подписчики (§4, §8а). Сейчас: только night-run таймер с двумя
  runType (`night-keeper` по расписанию 06:00, `memory-keeper` по порогу 50),
  dedup-daily не вызывается вовсе.
- **События/счётчики:** onRunStart/onRunEnd, отчёт в `logs/<role>-<ts>.json`,
  обновление checkpoint (per-role курсор).

### Шаг 6. Apply + reindex + метрики

- **Что:** apply-executor применяет ops (`deleteL1`, `merge`, `rewriteBlock`,
  `rewriteRecord`, `rewritePersona`) с верификацией по манифесту; при изменении
  векторов — reindex; после рана — probe precision@k, `memory_health.md`,
  digest.
- **Кто инициирует:** сам ран роли (шаг 5).
- **События/счётчики:** onApplyError (retry/частичный приём), onMetric,
  onProbeResult.

### Шаг 7. Recall (с приоритетом проектной памяти)

- **Что:** поиск по L1 (стратегия + typeWeights + crossProject-decay), инжекция
  L3-персоны и L2-навигации сцен текущего проекта. Подробно §6.
- **Кто инициирует:** каждый ход агента (auto-recall, `recall.timeoutMs`=5000
  защищает от блокировки).
- **События/счётчики:** **onRecall** — фидбек-петля: что вернулось, что
  пропущено (пища для probe-корпуса).

### Шаг 8. Фидбек-петля

- **Что:** `POST /memory/feedback` поднимает `priority` L1-записей по 80-символьным
  ключам (реализовано). **(идеал/цель)** дополняется событием onRecall →
  экстеншен-подписчик корректирует веса/корпус; результаты ранов (проценты
  merge/delete) влияют на пороги ролей.

---

## 4. Архитектура и слои в идеале

**(идеал/цель)** Целевая раскладка — три раздельные подсистемы, не перемешанные:

```text
TencentDB-Agent-Memory/src/
├── gateway/   ← HTTP-слой (тонкий): роуты, /status, /memory/run → делегирует в agents/
├── core/      ← ПАМЯТЬ: L0/L1/L2/L3, recall, scene, persona, store (концептуально не трогаем)
└── agents/    ← АГЕНТНЫЙ ПАЙПЛАЙН (новая подсистема, по §8 черновика):
    ├── types.ts        — контракт роли + шаги пайплайна
    ├── registry.ts     — загрузка ролей: roles/*.json + roles/*.ts (как экстеншены pi)
    ├── dispatcher.ts   — единая точка входа: run(roleName, reason); триггеры из контракта
    ├── runner.ts       — универсальный раннер (стадии + хуки)
    ├── hooks.ts        — хук-точки, встроенные в runner
    ├── spawn.ts        — спавн pi-агента (аргументы из контракта)
    ├── scratch.ts      — папка сессии: mkdir, cwd, keep_scratch, cleanup
    ├── diff-builder.ts — построение диффа по scope роли
    ├── caps.ts         — механические лимиты (ops_subset, caps)
    └── checkpoint.ts   — per-role курсоры
roles/                 ← КОНТРАКТЫ РОЛЕЙ (данные): memory-keeper.json, night-keeper.json,
                           dedup-daily.json, <custom>.ts (код-роль)
```

### Пересечения с целевой архитектурой из requirements-memory-agents-draft.md

**§8 (агентный пайплайн отдельной подсистемой `src/agents/`):** именно эта схема
выше. Ключевые принципы из §8, которые документ берёт как целевые:

- **Фулл дженерик** (решение юзера R-Д-О2): нет специализированных day/night
  режимов; всё разнообразие — из контракта роли. Текущий код частично противоречит
  этому: `executeRun` в `orchestrator.ts` делит мир на `night-keeper` →
  `executeRunNight` и всё остальное → `executeRunDay` (два захардкоженных режима
  вместо универсального раннера). **(идеал/цель)** — один раннер, режимы приходят
  из контракта (`scope`, `trigger`, `caps`, `opsSubset`).
- **Роль = json или ts-модуль** (R-Д-О3): уже есть роль-контракт в
  `role.json` (см. §5) с 19+ полями (`trigger`, `scope`, `ops_subset`, `caps`,
  `runtime`); ts-код-роли — цель.
- **Своя папка сессии, путь из роли** (R-А1/А2/А4/А5): уже частично реализовано —
  `runtime.scratch_root` в `role.json` (напр. `~/.pi/agent-memory/tdai/runs/dedup-daily`),
  `day-runner.ts`/`night-runner.ts` читают `resolveRoleRuntimeFromDir`; папка
  создаётся и удаляется per-run. **keep_scratch** для отладки — цель.
- **Единая точка входа** (R-Д2): сейчас `trigger()`/`runNow()` в `triggers.ts` +
  `POST /memory/run` — единая точка уже есть; не хватает диспетчера расписаний
  по контрактам ролей (§5).

**§8а (event-driven):** счётчики слоёв памяти в БД (посттранзакционный хук после
каждого слоя: `+N L1` после экстракции, `+1` после апдейта персоны) →
экстеншены-подписчики (ts-модули с основной апишкой: memory recall/search/apply/
records/duplicates, счётчики, spawn) сами решают, когда запускать агента →
основной цикл просто «триггерит их раз в какое-то время». **(идеал/цель)** —
инверсия от центрального раннера ролей. Сейчас этого нет: роль-вызов завязан на
night-run таймер и порог newL0, а не на события слоёв.

**§8б (ООП-схема Agent/AgentPrepare):**

- Template method: базовый `Agent` держит НЕИЗМЕНЯЕМУЮ цепочку
  `run()` (shouldRun → prepare → buildDiff → spawn → parseResult → caps → apply →
  advance → report); подкласс переопределяет только protected-шаги.
  Это ровно отражает текущий конвейер `preApply` (`runner-stages.ts`: diff → prompt
  → tools → spawn → parse → caps) → `applyDiff` → `advanceCheckpoint`.
- **AgentPrepare → переопределяемый `prepare()`** (TS: `extends` только одного
  класса): дефолт — mkdir + prompt.md + diff.json + tools/; переиспользование —
  через интерфейс `ScratchPreparer` (композиция, не наследование).
- **init-хук**: `export default (api, config) => new MyAgent(api, config)` — паттерн
  pi-экстеншенов; импортируется экстеншеном и вызывает конструктор.
- Сейчас в коде подготовки есть зачатки: `prepareScratch`-логика в `runner-stages.ts`,
  `copyKeeperTools`, но она захардкожена под keeper, а не универсальна.

**§8в (каталог хуков):** целевой каталог (идеал/цель):

| Группа | Хуки |
|---|---|
| Жизненный цикл рана | onPrepareError, onSpawnError, onTimeout, onParseError, onCapsRejected, onApplyError, onCleanup |
| События памяти (подписка) | onM0Captured, onM1Extracted, onM2ScenesUpdated, onPersonaUpdated, onRecall, onThresholdCrossed, onSessionEnd |
| Окружение/lifecycle | onInit, onShutdown, onRoleReload, onConfigChange |
| Наблюдаемость | onRunStart/onRunEnd, onStatusTick, onMetric, onProbeResult |

Обязательный минимум (для «память заработает заметно»):

1. **onM1Extracted + onPersonaUpdated + onThresholdCrossed** — связка «счётчик в БД
   после каждого слоя → экстеншен решает, пора ли запускать агента».
2. **onTimeout + onParseError + onApplyError** — fail-open трио. Сейчас ошибки
   глотаются: keeper «молча успешен» с пустыми диффами, а таймаут лишь пишется в
   отчёт (`keeper timed out — process group killed`, лог 2026-08-07T18:08).
3. **onM2ScenesUpdated** — ключ к «агент знает проект при старте» (R-П5).

Правило добавления: хуки — опциональные protected-методы с no-op дефолтом,
чтобы новый хук = правка базового класса, а не всех ролей.

---

## 5. Роли консолидации в идеале

### 5.1. Текущее состояние (факты)

Четыре каталога в `~/.pi/agent-memory/tdai/roles/` (проверено 07.08): три роли с
контрактом `role.json` — `memory-keeper`, `night-keeper`, `dedup-daily`; каталог
`dedup-daily-critic` содержит только `prompt.md` (без `role.json`):

| Роль | trigger | schedule/threshold | scope | ops_subset | critic_role | Вызывается? |
|---|---|---|---|---|---|---|
| `memory-keeper` | threshold | порог 50 | fresh_tail | deleteL1, merge, rewriteBlock, rewritePersona | memory-critic | да, по порогу newL0; делает ноль |
| `night-keeper` | schedule | 06:00 | full_store | deleteL1, merge, rewriteRecord, rewriteBlock, rewritePersona | night-critic | **нет** — баг ranToday |
| `dedup-daily` | schedule | 03:00 | full_store | deleteL1, merge | dedup-daily-critic | **нет** — нет диспетчера |
| `dedup-daily-critic` | — (нет role.json, только prompt.md) | — | — | — | — | нет (критик вообще не вызывается) |

Механика рана (факты кода):

- **Диспетчеризация захардкожена**: `ConsolidationOrchestrator.executeRun` —
  `opts.role === "night-keeper" ? executeRunNight : executeRunDay`
  (`orchestrator.ts`). `night-run.ts` timer: schedule-ветка шлёт `runType:"night-keeper"`,
  threshold-ветка — `memory-keeper` (дефолт). Роль `dedup-daily` не имеет ни одного
  пути вызова в `src/` (только упоминания в комментариях RoleGate и тестах).
- **Per-role single-flight есть**: `RoleGate.tryAcquire(role)` — разные роли могут
  идти параллельно, та же роль — никогда (полезный примитив для идеала).
- **Per-role курсор есть**: `ConsolidationCheckpoint` (`l0Cursor`, `lastRunAt`,
  `l0Count`, `roles`).
- **Per-role scratch есть**: `role-runtime.ts` → `runtime.scratch_root` из
  `role.json` (в `day-runner.ts`/`night-runner.ts`), плюс `runtime.extension_path`
  и `runtime.skill_path` уже умеют превращаться в `--extension/--skill` аргументы
  спавна (`role-spawn-args.ts`, `runner-helpers.ts`).

### 5.2. Баг ranToday (почему night-keeper не запускался)

`night-run.ts`:

- `getLastRunAt()` в `server.ts` — это `orchestrator.getLastRun()?.startedAt`:
  время **любого** последнего успешного рана (на старте — из `readLastReport()`,
  который берёт самый свежий отчёт **по всем ролям** из `logs/`, `reports.ts`).
- `ranToday = lastRunAt !== null && sameZoneDay(nowMs, lastRunAt, zone)`.
- Дневной рапорт memory-keeper помечает сегодняшний день как «уже бегали» →
  `scheduleDue && !ranToday` ложно → ночной ран **никогда** не запускается по
  расписанию (ни по catch-up при старте гейтвея).
- Важно: правильный источник **существует** — checkpoint хранит per-role
  `roles[role].lastRunAt` (`advanceCheckpoint`, `queries.ts:83`); баг в том, что
  night-run читает глобальный `getLastRunAt()` (любой последний ран), а не
  ролевой курсор.

### 5.3. Идеал (цель)

**(идеал/цель)** Вызов ролей — через **диспетчер по контракту роли**:

- Каждая роль в `role.json` объявляет `trigger: schedule|threshold|both|manual_only`,
  свой `schedule`, свой `threshold`, свой `scope`, свои `caps` и `ops_subset`.
- **Диспетчер** (`agents/dispatcher.ts` в целевой архитектуре §8) регистрирует
  расписания и пороги из контрактов; timer тикает и запускает **каждую** роль,
  чьё условие выполнено (dedup-daily в 03:00, night-keeper в 06:00, memory-keeper
  по порогу). single-flight — через существующий RoleGate.
- **Роль критиков** — отдельная роль (`trigger: manual`) или шаг `[hook] beforeApply`;
  критик перечитывает `diff.json` роли и даёт вердикт до применения (fail-loud для
  критиков, fail-open для сборщиков). Сейчас `critic_role` — мёртвое поле.
- **Событийная связка (§8а):** роли могут быть экстеншенами-подписчиками на
  `onThresholdCrossed`/`onM1Extracted` — основной цикл их триггерит, не зная логики.

Распределение по ролям (идеал):

| Роль | Scope | Триггер | Задача | Почему именно она |
|---|---|---|---|---|
| memory-keeper | fresh_tail | threshold (событие L1) | оперативная консолидация хвоста: merge близких, чистка переписанных | малый дифф, быстрый отклик |
| night-keeper | full_store | schedule 06:00 | полная ночная зачистка: старые дубли, over-limit блоки, rewriteRecord, cleanupPeriodDays | полный проход, дорогой — раз в сутки |
| dedup-daily | full_store | schedule 03:00 | массовый дедуп: deleteL1+merge по кластерам, idsOnly | «63% базы — дубли» требует массового прохода, отдельного от сбора |
| критики (×3) | diff роли | manual / beforeApply | верификация диффа до применения | защита от «молча успешных» ранов |

Чего не хватает сейчас (проверено):

1. dedup-daily мёртв — нет диспетчера per-role расписаний (исправить: таймер читает
   `roles/*/role.json`, а не только два хардкод-случая).
2. night-keeper не запускался — баг ranToday: night-run читает глобальный
   `getLastRunAt()` вместо per-role `roles[role].lastRunAt` из checkpoint
   (источник уже хранится, `queries.ts:83`).
3. memory-keeper нестабилен: с 15:02 07.08 все раны пустые (`applied` = 0 при
   `recordsPresented` 0–3, elapsed 134–497 с); три рана упали с «cluster ids must
   be ⊆ the diff» (presented-set не включал всех членов merge-кластера); нужно,
   чтобы presented-set включал все члены кластера.
4. критики не вызываются — `critic_role` не подключён к конвейеру.
5. Ошибки глотаются — нет fail-open трио (onTimeout/onParseError/onApplyError);
   таймауты keeper фиксируются только в отчёте.

---

## 6. Recall в идеале

### 6.1. Текущая механика (факты кода)

`performAutoRecall` (`src/core/hooks/auto-recall/recall.ts`):

- L1-поиск: стратегия `embedding` (live yaml), кандидаты
  `maxResults*2` (в decay-режиме `*6`), фильтр `passesScope` (hidden/decay),
  **scopeDecayMultiplier применяется ДО порога** (иначе низкий cosine не выживет),
  затем `applyTypeWeights` (умножение score на вес типа), фильтр
  `score >= scoreThreshold`, top-K (`maxResults`=5). Бюджет: `maxCharsPerMemory`=500,
  `maxTotalRecallChars`=2000.
- L3: `persona.md` → `<user-persona>` (лимит 6000). L2: сцены текущего проекта →
  `<scene-navigation>`.
- `crossProject: decay` уже включён в live yaml (wave recall-scope-threshold-fix,
  2026-08-04): записи чужих проектов не выпиливаются, а умножаются на decay.
- `scope-decay.ts`: exact match project_id → 1.0; projectMap (сейчас `{}` пуст) →
  множитель из карты; иначе prefix-depth decay `1/(1+decay*uniqueSegments)`;
  дефолт `defaultCrossProjectMultiplier`=0.5.
- **Фидбек-петля существует**: `POST /memory/feedback` поднимает `priority` записи
  по 80-символьному ключу (`feedback.ts`).

### 6.2. Проблемы (факты)

- `scoreThreshold: 0.2` — почти всё проходит порог → recall тащит шум, в текущей
  сессии 4 из 5 записей — почти одинаковые инструкции (дубли). Рекомендация
  аудита: 0.7+.
- `typeWeights` все 1.0 — инструкции и персональные записи не приоритезируются.
- `probe-corpus.json` отсутствует → precision@k = `skipped` (проверено в
  `memory_health.md`: `status: skipped (probe corpus not found or unusable …)`).

### 6.3. Идеал (цель)

1. **Приоритет проектной памяти** — работает уже: exact match 1.0, decay для чужих
   (R-П3/П4). **(идеал/цель)** — заполнить `projectMap` явными множителями для
   ключевых проектов и проверить, что prefix-depth decay не топит легитимный
   кросс-проектный контекст (аудиты, общие правила).
2. **scoreThreshold 0.7+** — отсекать шум; подбирать по precision@k (ниже).
3. **typeWeights** — `instruction`/`persona` выше `episodic` (напр. 1.2/1.1/1.0),
   чтобы важные правила не тонули в эпизодике. Механика уже реализована —
   нужно только настроить.
4. **probe-corpus** — завести `~/.pi/agent-memory/tdai/probe-corpus.json`
   (фиксированные запросы с известными ответами; формат в `probe.ts`:
   `{ queries: [{ id, query, expected: string[] }] }`), цель precision@k ≥ 0.9
   при topK=3 (уже в конфиге). Прогон — после каждого консолидационного рана
   (`runPostRunSteps`), результат — в отчёт и health.
5. **onRecall-фидбек** — событие после каждого recall: что вернулось/пропущено →
   подпитка корпуса и автонастройка порога (идеал, §8а).

---

## 7. Наблюдаемость

**(идеал/цель — наблюдаемость «катастрофически не хватает», по §8в-4; ниже — что уже
есть и что должно стать живым)**

Что уже есть (факты кода):

- **`memory_health.md`** (пишется после каждого рана, `writeDashboard` в
  `reports.ts`): L1 by type, duplicate clusters, scene sizes (файл/лимит),
  vec-vs-meta consistency, **precision@k**, last runs. Живой пример —
  `~/.pi/agent-memory/tdai/memory_health.md` от 2026-08-07T18:41:30Z.
- **`GET /status`** (auth-free): `status`, `uptimeSec`, `dataPath`,
  `consolidation { enabled, checkpoint, inFlight, lastRun }`, `roles`
  (`listRoles()` — все роли из `roles/` с enabled/model/scope/trigger/criticRole),
  `reindexInProgress`.
- **`GET /memory/*`** read-роуты: `info`, `records`, `duplicates`, `blocks`,
  `validate`, `search`.
- **Логи ранов**: `logs/<role>-<ts>.json` (RunSummary) + sidecar `.diff.md`;
  digest `.metadata/last-digest.json`; dev-лог `logs/gateway-dev.log`.
- **Probe** (после каждого рана): precision@k + top1HitRate, fail-open (`skipped`
  при отсутствии корпуса) — `probe.ts`.

Чего не хватает (идеал/цель, из §8в):

- Живые счётчики слоёв в БД (посттранзакционные) и их показ в `/status`
  (onStatusTick): `newL0`, `newL1`, `scenes_updated`, `persona_updated`,
  пороги ролей.
- onRunStart/onRunEnd с обогащённым отчётом (что presented/applied/skipped и
  **почему пусто** — сейчас «ok» с пустым applied неотличим от полезного рана).
- onMetric/onProbeResult: тренд precision@k во времени, дельта дублей после
  dedup-проходов (метрика успеха дедупа).
- Публикация метрик в единый dashboard/лог для мониторинга, а не только в файлы.

---

## 8. Таблица «сейчас vs идеал»

| Аспект | Сейчас (07.08, факты) | Идеал/цель |
|---|---|---|
| **L2 сцены** | no-op при консолидации (single-writer gate, `l2-runner.ts`); сцены разрежены (_global 5, penis 7, u24 5, portfolio-new 2 + аудиторские) | keeper пишет сцены через `rewriteBlock` ИЛИ снят gate; у каждого активного проекта растут scene-блоки (R-П1/П2) |
| **L3 персона** | no-op при консолидации; `persona.md` не менялся с 04.08; аудит §7: не обновлялась с 02.08 | keeper `rewritePersona` (или инлайн-L3); пересборка по изменённым сценам, событие onPersonaUpdated |
| **Дедуп** | 90–91 кластер / 227–234 члена (63% базы); inline batchDedup не спасает загрязнённую базу | dedup-daily (03:00) массово схлопывает кластеры; inline-дедуп держит базу чистой на входе; метрика «дельта дублей» |
| **Вызов ролей** | только 2 хардкод-пути: night-keeper (06:00) и memory-keeper (порог 50); dedup-daily никто не вызывает | диспетчер по контракту роли: каждая роль со своим schedule/threshold; RoleGate per-role (уже есть) |
| **night-keeper** | не запускался ни разу (баг ranToday: любой дневной ран помечает день «уже бегали») | отдельный «последний ночной ран»; ночной прогон по расписанию и catch-up |
| **Критики** | `critic_role` указан в role.json, но не используется | критик = отдельная роль (manual) или шаг beforeApply; вердикт до применения |
| **Keeper-эффективность** | нестабилен: 5 ранов с непустым applied (4 merge + 62 rewriteBlock), но с 15:02 07.08 — пустые (31 из 36 ранов за день пустые), presented 0–3, elapsed 134–497 с; 3 aborted «cluster ids must be ⊆ the diff»; 1 timeout | непустые диффы (presented-set включает всех членов кластера); fail-open трио onTimeout/onParseError/onApplyError |
| **scoreThreshold** | 0.2 — шум в recall (4 из 5 записей — дубли) | 0.7+, подбор по precision@k |
| **typeWeights** | все 1.0 (выключены) | instruction/persona > episodic (механика уже есть) |
| **crossProject** | decay уже включён (yaml), projectMap пуст | заполнить projectMap; проверить decay на легитимном кросс-проектном контексте |
| **Probe precision@k** | `skipped` (probe-corpus.json отсутствует) | корпус заведён; precision@k ≥ 0.9 (topK=3) после каждого рана |
| **Наблюдаемость** | memory_health.md, /status, логи ранов есть | + живые счётчики слоёв в БД и /status, тренд precision@k, onRunStart/onRunEnd |
| **Offload/context assembly** | process-wide scheduler state, fallback к last-active session, общий O4 pending result; recall items теряют id/score при text projection | per-session O-state; structured ContextEnvelope с identity/scope/provenance/score/token cost; детерминированный budget |
| **Архитектура** | агентный пайплайн перемешан: orchestrator + day/night ветки + роли в `src/gateway/consolidation/` | отдельная подсистема `src/agents/` (§8), event-driven (§8а), ООП Agent (§8б), каталог хуков (§8в) |

---

## 9. Этапы перехода (от текущего состояния к идеалу)

*Краткий маршрут (идеал/цель). Нормативный порядок generic cutover задан в `agent-architecture.md` §8; ниже только продуктовые tracks.*

0. **Изолировать short-term context:** characterization двух параллельных сессий → per-session O1.5/O2/O4 state → structured `ContextEnvelope` → project-aware probe. Это safety-track tz-10; он не ждёт generic keeper, потому что устраняет уже существующее смешивание контекста.

1. **Починить вызов ролей** (быстрые победы):
   - баг `ranToday` в `night-run.ts` — читать per-role `roles[role].lastRunAt`
     из checkpoint (уже хранится, `queries.ts:83`), а не глобальный `getLastRunAt()`;
   - диспетчер per-role расписаний: таймер читает `roles/*/role.json`
     (`schedule`/`threshold`), а не два хардкод-случая → запускается `dedup-daily`.
2. **Оживить memory-keeper**: непустые диффы (merge-кластер ⊆ presented-set),
   fail-open трио (onTimeout/onParseError/onApplyError), чтобы «ok с пустым
   applied» перестал маскировать проблемы.
3. **Вернуть L2/L3**: либо keeper реально пишет сцены/персону
   (`rewriteBlock`/`rewritePersona`) — тогда сцены по проектам начнут расти, —
   либо снять single-writer gate и включить инлайн-L2/L3. Результат:
   «агент знает проект при старте» (R-П5).
4. **Критики**: подключить `critic_role` как отдельные роли (manual) или шаг
   beforeApply; вердикт до применения.
5. **Probe-корпус**: завести `probe-corpus.json`; начать измерять precision@k.
6. **Тюнинг recall**: scoreThreshold → 0.7+, typeWeights (instruction/persona выше),
   projectMap.
7. **Агентный пайплайн по §8/§8а/§8б/§8в**: вынести агентский пайплайн в
   `src/agents/` (registry/dispatcher/runner/hooks/spawn/scratch), контракты ролей —
   данные, событийная связка «счётчики в БД → экстеншены-подписчики», ООП-база
   Agent с template-method и каталогом хуков.

---

## Приложение: опорные факты (файл:строка / источник)

- L0: `src/core/conversation/l0-recorder.ts` — JSONL по дням, позиционный срез +
  timestamp-курсор, sanitize, `projectId`.
- L1: `src/core/record/l1-extractor.ts` — quality-gate, LLM + сцены, лимит 600;
  `l1-extraction-dedup.ts` — batchDedup fail-open; `l1-runner.ts` — курсор.
- Инициация L1: `src/utils/pipeline/l1.ts` — порог + idle; live `everyNConversations=1`,
  `l1IdleTimeoutSeconds=120` (`tdai-gateway.yaml`).
- L2 no-op: `src/utils/pipeline-factory/l2-runner.ts` (~строка 31,
  `isConsolidationEnabled(cfg)` → `{skipped:true}`).
- L3 no-op: `src/utils/pipeline-factory/l3-runner.ts` (тот же gate);
  `src/core/persona/persona-generator.ts` — first/incremental, бэкапы.
- Таймеры L2/L3: `src/utils/pipeline/timers.ts` — advanceL2Timer, armL2MaxInterval,
  triggerL3.
- Диспетчеризация: `src/gateway/consolidation/orchestrator.ts` —
  `role === "night-keeper" ? executeRunNight : executeRunDay`;
  `night-run.ts` — schedule/threshold/catch-up; `server.ts` — `getLastRunAt` =
  любой последний ран (корень бага ranToday).
- Роли: `~/.pi/agent-memory/tdai/roles/` — `role.json` у `memory-keeper`,
  `night-keeper`, `dedup-daily`; `dedup-daily-critic` — только `prompt.md`
  (проверено 07.08); `src/gateway/role-paths.ts`, `role-loader.ts`, `role-runtime.ts`.
- RoleGate: `src/gateway/consolidation/role-gate.ts` — per-role single-flight.
- Checkpoint: `src/gateway/consolidation/checkpoint.ts` — per-role курсоры.
- Apply ops: `src/gateway/role-paths.ts` (`ApplyOp` = deleteL1|merge|rewriteBlock|
  rewriteRecord|rewritePersona); `src/gateway/apply-executor.ts`.
- Recall: `src/core/hooks/auto-recall/recall.ts`, `scope.ts`, `scope-decay.ts`,
  `search-embedding.ts` (decay ДО порога, typeWeights ДО top-K); конфиг
  `scoreThreshold=0.2`, `typeWeights` 1.0, `crossProject=decay` — `tdai-gateway.yaml`.
- Probe: `src/gateway/probe.ts` — формат корпуса, fail-open, precision@k.
- Health: `src/gateway/reports.ts` — writeDashboard/writeDigest; живой файл
  `~/.pi/agent-memory/tdai/memory_health.md` (2026-08-07T18:41:30Z).
- Логи ранов: `~/.pi/agent-memory/tdai/logs/memory-keeper-*.json` (07.08:
  непустой applied в 5 ранах — 4 merge + 62 rewriteBlock, 10:27/11:40; с 15:02 —
  всё пусто; 3 aborted «cluster ids must be ⊆ the diff»; 1 timeout).
- БД (живая, 07.08 ~23:00): `l0_conversations` 15348, `l1_records` 378
  (episodic 236 / instruction 86 / persona 56).
