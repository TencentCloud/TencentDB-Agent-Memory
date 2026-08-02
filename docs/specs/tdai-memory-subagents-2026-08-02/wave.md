# Wave: tdai-memory-subagents-2026-08-02

> Оператор-волна (system-constitution). Источник правды: ТЗ
> `~/.pi/agent/tasks/--home-penis--/2026-08-02/030925-tdai-memory-subagent-pipeline.tz.md`
> (кристалл `...030925-tdai-memory-subagent-pipeline.md`). Код пишут executor'ы
> (`task`), гейты — Reviewer + Teamlead + Tier-1 на каждый пакет, Auditor на
> Tier-2 каденции. Defect ledger: `docs/specs/<wave>/defects.json`.

## Meta-goal

Перенести консолидацию/валидацию памяти из инлайн-LLM гейтвея tdai-memory в
pi-саб-сессии («пчёлки»), добавить ночной прогон с реиндексом, офф-свитч
реколла, тулы памяти агенту и 6 улучшений; всё выносимое — в конфиг.
Критерии приёмки — §7 ТЗ (21 критерий). Non-goals — INVARIANT-ы §4 ТЗ.

## Пакеты (DAG)

| id | имя | цель | blocked_by | diff_budget_loc | files_max | risk |
|----|-----|------|-----------|-----------------|-----------|------|
| P1 | config-schema | zod-секции memory.consolidation/nightRun/cleanup/probe/typeWeights + fail-loud; + **tsconfig.check.json (владелец критерия 1)** | — | 120 | 3 | config |
| P2 | loopback-token | токен-файл dataDir/../tdai-gateway.token + write-гейт OR Bearer/x-memory-token + GET /memory/info | P1 | 100 | 2 | security |
| P3 | memory-read-routes | GET /memory/records\|duplicates\|blocks\|validate (auth-free loopback) | P1 | 250 | 3 | — |
| P4 | apply-executor | POST /memory/apply: ApplyExecutor (zod-валидация diff, манифест, backup, abort-цикл, stale-delete re-check, count-чек+orphan purge, syncSceneIndex) | P2, P3 | 350 | 3 | db |
| P5 | single-writer-gate | createL2Runner/createL3Runner no-op при enabled + warnOnce + seed-контракт | P1 | 60 | 2 | — |
| P6 | consolidation-orchestrator | чекпоинт, diff-сборка (double cap), спавн pi child, манифест baseline/recheck, single-flight, kill/sweep, отчёты, /status | P1..P5 | **650** | 6 | security |
| P7 | night-run-timer | schedule 06:00 + threshold ≥50 L0 (курсорный), catch-up на старте, TZ из конфига | P6 | 120 | 2 | — |
| P8 | reindex-integration | per-row delete+insert, reindexAll под single-flight, skip-dual-write, livelock-cap, reindex-gate на recall/search, sqlite-vec 0.1.9 bump+бэкап | P5, P6 | 200 | 3 | db |
| P9 | role-prompts | memory-keeper.md + role-файлы + дифф-секция в системном промте (escape фенсов, double cap) | P6 | 150 | 3 | — |
| P10 | improvements | зонд recall (precision@k), typeWeights реранк, dashboard memory_health.md, POST /memory/feedback (80-char dedup), digest last-digest.json, memory_search/memory_note | **P2,** P3, P5, P6 | 400 | 5 | — |
| P11 | pi-extension | офф-свитч TDAI_MEMORY_RECALL=off, PI_MEMORY_KEEPER гвард, MCP-тулы memory_search/note, TDAI_MEMORY_DIGEST opt-in, фидбек-петля agent_end | P2, P10 | **250** | 4 | — |
| P11a | cleanup | §5.10 memory.cleanup: интервал+пути, чистка логов/диффов/бэкапов/scratch **и детерминированного поддерева `~/.pi/agent/tasks/--<sanitized-scratch-cwd>--/`** (критерий 10 + 19f); НЕ records/vectors | P6 | 80 | 1 | — |
| P12 | tests | критерии §7 ТЗ (1-21) **vitest run** (репо: vitest ^4.1.2 + vitest.config.ts; НЕ bun test) | P1..P11, P11a | 500 | 8 | — |

Сумма: ~2700 LOC + ~500 тесты. Executor depth: P4/P6/P8/P10/P12 → complex
(risk db/security + budget > 200), P1/P2/P11 → standard, остальные standard.

### Батчинг (юзер: 2-4 пакета/executor, не 12 микродоков)

- **B1**: P1 + P2 + P3 (config → token → read-роуты)
- **B2**: P4 + P5 (apply-executor + single-writer gate)
- **B3**: P6 + P7 (оркестратор + night-run)
- **B4**: P8 + P9 + P11a (reindex + role-prompts + cleanup)
- **B5**: P10 + P11 (improvements + pi-extension)
- **B6**: P12 (tests)

Каждый батч — один task-субагент (сам гонит план→критик→импл внутри), диспатч
по готовности DAG; независимые батчи параллельно до капа 3 активных субагента.

### P11 вне git-репо (механизм дифф/ревью/отката)

`~/.pi/agent/extensions/` — НЕ git-репо: пер-пакетный дифф через **baseline-diff**:
перед батчем B5 — `cp` целевых файлов в /tmp/baseline-<pkg>.diff (или .bak-*),
после — `diff -u` против baseline; Reviewer/Teamlead ревьюят по этому диффу;
откат — восстановление из бэкапа. Тот же механизм, что у task 014808 (L1-промт).

## INVARIANT-ы (из §4 ТЗ) — Tier-1 coverage gate (coverage-gate.sh, mechanize-first)

Формат: `INVARIANT:` на старте строки + `CHECK:` в том же блоке (см. ~/.agents/skills/system-constitution/coverage-gate.sh). CHECK = негативный grep-ban против **коммиченного HEAD** (не worktree): rc=0 пока инвариант держится, rc!=0 при нарушении.

INVARIANT: nogo-l1-prompt — L1-промт-фиксы 014808 держать в коммиченном дереве: 判据-критерий + exclusion-пункты в l1-extraction.ts, MAX_CONTENT_CHARS=600 в l1-extractor.ts. Per-artifact presence (откат любого артефакта = нарушение).
CHECK: bash -c 'cd /home/penis/TencentDB-Agent-Memory && git grep -q "判据" HEAD -- src/core/prompts/l1-extraction.ts && git grep -q "不应该提取的内容" HEAD -- src/core/prompts/l1-extraction.ts && git grep -qE "MAX_CONTENT_CHARS[[:space:]]*=[[:space:]]*600" HEAD -- src/core/record/l1-extractor.ts'

INVARIANT: nogo-recall-knobs — recall-кнобы yaml (scoreThreshold 0.85 / maxResults 3 / strategy embedding) не менять; в коммиченном src нет переопределения кнобов-констант.
CHECK: bash -c 'cd /home/penis/TencentDB-Agent-Memory && grep -q "scoreThreshold: 0.85" tdai-gateway.yaml && grep -q "maxResults: 3" tdai-gateway.yaml && grep -q "strategy: embedding" tdai-gateway.yaml && ! git grep -qE "scoreThreshold[[:space:]]*=[[:space:]]*0\.85|maxResults[[:space:]]*=[[:space:]]*3" HEAD -- src/core'

INVARIANT: nogo-records-rewrite — records/*.jsonl пишут только allowlist (l1-writer.ts гейтвей-экстрактор, apply-executor.ts /memory/apply, token.ts, тесты); ВСЕ файлы с write-вызовами ⊆ allowlist (path-exact, не substring).
CHECK: bash -c 'cd /home/penis/TencentDB-Agent-Memory && test -z "$(git grep -lE "appendFile|writeFile" HEAD -- src/gateway src/core/record | sed "s/^HEAD://" | grep -vxE "src/core/record/l1-writer.ts|src/gateway/apply-executor.ts|src/gateway/token.ts|src/gateway/apply-executor.test.ts|src/gateway/memory-routes.test.ts")"'

INVARIANT: nogo-l0-path — L0 capture-путь без LLM-вызовов в коммиченном HEAD (негатив: generateText/generateObject в capture-коде = нарушение).
CHECK: bash -c 'cd /home/penis/TencentDB-Agent-Memory && ! git grep -qE "generateText|generateObject" HEAD -- src/core/conversation/l0-recorder.ts src/core/hooks/auto-capture.ts'

INVARIANT: nogo-pi-core [semantic] — tdai-memory.ts при включённом реколле не менять поведение (офф-свитч аддитивно, P11/B5). Немеханизируемо до P11: файл вне git-репо, diff-гейты неприменимы; реализация офф-свитча (P11) добавит механический CHECK на инъекционные пути. Оценка — Auditor.
JUSTIFICATION: tdai-memory.ts лежит в ~/.pi/agent/extensions (не git-репо) — механический diff-CHECK невозможен; поведенческая проверка (реколл работает как сейчас) — ручная, Tier-2.

INVARIANT: nogo-secrets — саб-сессия/тулы не получают gateway-ключей; apiKey не в коммиченном дереве; yaml с apiKey остаётся untracked (негатив: hardcoded ключ в src/ = нарушение; yaml закоммичен = нарушение).
CHECK: bash -c 'cd /home/penis/TencentDB-Agent-Memory && ! git grep -qE "sk-[A-Za-z0-9]{20,}" HEAD && { ! git ls-files --error-unmatch tdai-gateway.yaml >/dev/null 2>&1; }'

## Wave-close

- Все пакеты DONE (per-packet triple-gate).
- `open_defects == 0` в defects.json.
- Tier-1 гейт зелёный wave-wide.
- Финальный Auditor pass чистый.
