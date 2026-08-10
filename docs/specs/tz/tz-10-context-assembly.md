# TZ-10: session isolation и единая сборка контекста

> Источник: аудит фактического long-term memory + context-offload, 2026-08-10
> Модель: параллельный safety-track к [agent-architecture.md](../agent-architecture.md)

## Контекст

В проекте существуют две разные системы со своими одинаково названными слоями:

- durable memory: разговоры → L1 records → project scenes → persona;
- short-term context-offload: L1/L1.5/L2/L3/L4 для сжатия текущей сессии.

Смешивать эти словари нельзя. В документации durable-слои называются `M0..M3`, а offload-слои — `O1`, `O1.5`, `O2`, `O3`, `O4`. Это терминологическая миграция; имена таблиц и файлов в первом пакете не меняются.

Фактические риски:

- L2 scheduler выбирает один `lastActiveMgr` (`src/offload/register.ts:24-26`), а не владельца конкретной offload-сессии;
- scheduler при ошибках и фоновых повторах использует process-wide state (`src/offload/l2-scheduler.ts:28-37`, `:77-108`);
- L4-result хранится в общем `ctx.l4State.pendingResult` (`src/offload/register-hooks-input.ts:54`) и потребляется следующей сборкой (`src/offload/engine-assemble.ts:60-63`);
- recall превращает структурированный search result обратно в текст и восстанавливает элементы с `score: 0` (`src/core/hooks/auto-recall/recall.ts:60-70`);
- probe вызывает общий recall без `projectId` (`src/gateway/probe.ts:171-180`), поэтому не доказывает project isolation;
- публичный `RecallResponse` содержит только context/strategy/count (`src/gateway/types.ts:105-109`), без identity и причин включения.

Это отдельный источник «каши»: даже идеальный generic keeper не исправит контекст, если O4 одной сессии попал в другую или assembler не может объяснить, какие memory items съели бюджет.

## Цель

Сделать short-term offload строго session-scoped, а финальную сборку контекста — одной детерминированной функцией над структурированными элементами с identity, scope, provenance, score и token cost.

## Scope

**Входит:**

- namespace `M*` для durable memory и `O*` для offload в документации/диагностике;
- session ownership для O1/O1.5/O2/O3/O4 state, timers, pending results и artifacts;
- `MemoryItem`, `ContextEnvelope`, `ContextAssemblerPolicy`;
- project-aware item-level recall diagnostics и probe corpus с negative cases;
- единый token budget и deterministic precedence при сборке context.

**Не входит:**

- generic RoleRun/apply — tz-01/tz-09;
- изменение формулы recall до снятого baseline — tz-04;
- миграция durable scope/provenance schema — tz-05;
- новый EventBus.

## Контракты

```ts
type MemoryItem = {
  memoryId: string;
  kind: "persona" | "scene" | "l1" | "offload-summary" | "l4-result";
  content: string;
  scope: {
    tenantId?: string;
    userId: string | null;
    projectId?: string;
    roleId?: string;
    taskId?: string;
    runId?: string;
    sessionId?: string;
  };
  provenance: {
    sourceIds: string[];
    producer: string;
    createdAt: string;
    updatedAt: string;
    status: "native" | "projected" | "unknown";
  };
  score: { raw?: number; final?: number; reasons: string[] };
  tokenCost: number;
};

type ContextEnvelope = {
  schemaVersion: 1;
  requestId: string;
  sessionKey: string;
  sessionId: string;
  projectId?: string;
  budget: {
    total: number;
    used: number;
    reservedForUser: number;
    tokenizerId: string;
    tokenizerVersion: string;
    renderOverhead: number;
  };
  included: MemoryItem[];
  excluded: Array<{ item: MemoryItem; reason: string }>;
  diagnostics: Array<{
    stage: "repo" | "tokenize" | "scope" | "dedup" | "budget" | "render";
    code: string;
    message: string;
    itemId?: string;
  }>;
  renderedContext: string;
};
```

`ContextAssemblerPolicy` задаёт:

1. hard scope gate для чужой session/task/run памяти;
2. project policy для durable memory (`same-project`, `global`, затем разрешённый decay);
3. precedence: system rules → user prompt reserve → current-session O4/O2 → same-project scenes/L1 → persona → permitted foreign-project decay;
4. semantic dedup до рендера;
5. token budget по item cost плюс точный wrapper/separator overhead; tokenizer id/version пиннятся в envelope, а итоговый `used` перепроверяется по полностью rendered context;
6. conflict policy: свежий item не побеждает только по времени — identity и provenance сохраняются, конфликт помечается в reasons;
7. fail-closed для session ownership и fail-open только для отсутствующего optional durable item.

Assembler — pure core: получает items + policy + budget и возвращает envelope. Чтение стора, tokenizer и логирование находятся в adapter/repo shell.

## Session ownership

- Ключ состояния: `{sessionKey, sessionId}`; один `lastActiveMgr` не является источником истины.
- O1 capture/decision, O1.5 judge, O2 grouping, O3 compression и O4 result несут один owner key; стадия не принимает artifact без совпадающего owner.
- Каждый O1.5/O2 job пиннит owner key и входной digest. Завершение пишет результат только в state того же owner.
- Timer/poll хранится per owner; process-wide scheduler может выбирать due jobs, но не содержит их mutable work state.
- O4 pending result хранится `pendingResultBySession`, потребляется атомарно только совпадающей сессией и только один раз.
- Закрытие сессии отменяет её jobs, ждёт terminal state и запускает retention; оно не force-settle чужую сессию.
- Поздний результат отменённой/заменённой попытки отклоняется по generation/fence.

## Инварианты

| Инвариант | Проверка |
|---|---|
| `session-state-isolated` | `[t]` две параллельные сессии с маркерами A/B: ни один O1/O1.5/O2/O3/O4 state/artifact/result не пересекает owner key |
| `context-envelope-complete` | `[t]` каждый фрагмент `renderedContext` трассируется к `memoryId`, scope, provenance, score reason и token cost |
| `context-budget-enforced` | `[t]` `used <= total - reservedForUser`; изменение порядка входа не меняет included ids |
| `project-recall-measurable` | `[t]` probe corpus содержит same-project positive и foreign-project negative; диагностика сохраняет raw/final score и exclusion reason |
| `single-consume-o4` | `[t]` O4-result появляется ровно в одной сборке своей сессии и не виден следующей/соседней |

## Функциональные требования

- **C10.1**: существующие offload state/timers переводятся с global singleton/last-active выбора на per-session repository.
- **C10.2**: assembly принимает только structured items; обратный parse строк recall запрещён.
- **C10.3**: internal API recall возвращает item-level data. Текстовый `RecallResponse.context` остаётся compatibility projection из `ContextEnvelope`.
- **C10.4**: probe передаёт `projectId`, сохраняет ids/scope/raw+final score и умеет считать foreign-project leakage rate.
- **C10.5**: лог/trace хранит envelope metadata без полного чувствительного content; content — по отдельной debug policy. Ошибки repo/tokenizer/scope фиксируются в `diagnostics`, а не схлопываются в пустую память.
- **C10.6**: если session identity отсутствует или неоднозначна, offload result не инжектится; это typed expected failure, а не fallback на `lastActiveMgr`.
- **C10.7**: до tz-05 durable item строится через versioned projection: неизвестные `userId`/source IDs остаются `null`/`[]` с `provenance.status="unknown"`, а не подменяются global. tz-05 обогащает тот же контракт native provenance без смены assembler API.

## Критерии приёмки

1. `[t]` Characterization воспроизводит текущий cross-session O4/L2 риск до правки и перестаёт воспроизводить после неё.
2. `[t]` 100 конкурентных проходов O1→O1.5→O2→O3→O4→assembly двух сессий не дают ни одного чужого marker/state/artifact.
3. `[t]` Один набор items в разных permutation даёт одинаковые included ids, причины исключения и token totals; повторный tokenize полного `renderedContext` тем же tokenizer/version равен `budget.used` и включает wrappers/separators.
4. `[t]` Probe с `projectId=A` штрафует попадание foreign negative B; тот же corpus без project context считается отдельным baseline, не смешивается.
5. `[t]` Ошибка tokenizer/repo различима в envelope diagnostics и не превращается в «памяти нет».
6. `[a]` Assembly domain не импортирует fs/network/db/time/global state.

## План

1. Добавить characterization-тесты двух параллельных сессий и O4 single-consume.
2. Ввести session-scoped state repository для O1/O1.5/O2/O3/O4 и перенести O4 pending results.
3. Перенести O2 timers/jobs на owner key + generation; удалить fallback к `lastActiveMgr` из execution path.
4. Ввести structured internal recall items и `ContextEnvelope`; сохранить старый text response как projection.
5. Реализовать pure `assembleContext(items, policy, budget)` и property-тесты порядка/бюджета.
6. Выпустить tz-10a: item diagnostics + project positives/foreign negatives + versioned pre-tz-05 projection; снять baseline tz-04.
7. Только после baseline выпустить tz-10b: новый assembler budget/scoring projection и затем enrichment provenance из tz-05.

## Самостоятельная проверка

**S1. Две живые сессии.** Одновременно дать A и B разные секретные маркеры, провести O1→O1.5→O2→O3→O4 и несколько сборок. В state/artifacts/context/trace A нет B и наоборот. Фальсификация: намеренно вернуть общий `pendingResult` — тест обязан поймать утечку.

**S2. Объяснимый context.** Для каждого абзаца финального context показать item id, scope, score reason и стоимость. Фрагмент без источника — дефект сборки.

**S3. Бюджет.** Уменьшить budget вдвое. Низкоприоритетные items переходят в `excluded(reason=budget)`, user reserve не съедается, а порядок входного массива не влияет на результат.

**S4. Чужой проект.** В corpus добавить семантически очень похожий foreign negative. Он либо исключён policy, либо явно понижен и измерен как leakage; скрытого попадания без diagnostics нет.

## Риски и откат

- Переход на structured recall меняет внутренний API: вводится dual projection, старый text path удаляется только после parity.
- Per-session timers увеличат число объектов: scheduler хранит только due metadata, retention удаляет terminal state.
- Откат feature-флага возвращает старый assembler, но не смешивает новые и старые pending results: namespaces/version keys различаются.

## Risk tier

**Tier-2** для session state и assembly; **Tier-3** для изменения фактической recall-инъекции. Сначала shadow-envelope и сравнение, затем cutover.
