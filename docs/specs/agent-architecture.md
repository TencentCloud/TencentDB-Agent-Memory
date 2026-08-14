# Generic agent architecture — единая модель ролей tdai-memory

> Статус: целевая архитектура, к которой сводятся пакеты `docs/specs/tz/*`.
> Факт-чек кода: 2026-08-10 (HEAD `5c8e867`). Ссылки `file:line` проверяются скриптом на существование файла и границы строк; точность конкретной строки перепроверяется при каждой ревизии.
> Референсы: pi-аудитор `~/.pi/agent/extensions/auditors.ts` (generic-раннер ролей),
> `agent-platform-unified-final-architecture(1).md` §«Generic Agent model» (унифицированные классы),
> внешнее ревью Codex (2026-08-10).

> Реализация на 2026-08-14: путь L0→L1 уже переведён на эту модель. Durable assignment запускает `l1-extractor` через общий `RoleLauncher`, затем отдельный `l1-extractor-critic`; parent-side recall и проверка дайджестов обязательны, а commit выполняет только родитель под возобновляемым глобальным lease. Exact-id recovery работает через `IMemoryStore` для SQLite и TencentDB, проверяет JSONL/retrieval postconditions и чинит отсутствующую либо расходящуюся проекцию. Старые утверждения ниже про inline-L1 и отсутствие ядрового critic-gate относятся к consolidation legacy path, а не к L1 extraction.

### Реализованный L1 protocol

```text
oldest durable L0 cohort → immutable assignment/workset
  → extractor LaunchAttempt → parent conflict snapshot
  → critic Attempt + digest-bound verdict
  → reviewed candidate → parent commit lease + oplog
  → JSONL and IMemoryStore read-back → cursor finalize
```

Extractor/critic получают отдельные попытки и scratch, `ambient_access: none`, пустой tool subset и `scratch-net-v1`. Их stdout валидирует родитель, включая source/target references и `extraction.maxMemoriesPerSession`. `/status.l1` показывает последний assignment/run, обе attempt outcomes, verdict, typed error и verified/total commit operations. Live role install, config cutover and gateway restart остаются отдельным rollout-gate.

## 1. Зачем документ

Пять пакетов TZ описывали пять несвязанных работ и местами противоречили коду. Причина расхождений одна: **контракт роли сегодня декоративен** — поля есть, исполнение идёт мимо них. Пока это не исправлено, любая доработка (L2, счётчики, recall, scopes) строится на песке.

Документ фиксирует одну модель: роль — самодостаточное расширение, ядро — единственный носитель авторитета (caps, apply, checkpoint, single-flight, critic-gate), хост — сменный launcher.

## 2. Факты (проверено чтением кода)

Контракт не управляет исполнением:

| Поле контракта | Заявлено | Реально |
|---|---|---|
| `prompt_file` | путь к промпту | игнорируется: execution-path идёт `prompt-builder.ts:94` → `role-dir-loader.ts:34-36` (canonical `<role>/prompt.md` + bare fallback); legacy-ветка `role-loader.ts:66-73` в этом пути не участвует |
| `tools_subset` | подмножество тулов | копируется весь каталог — `keeper-tools.ts:55` |
| `model` / `thinking` | параметры роли | берутся глобальные `config.memory.consolidation.*` — `runner-helpers.ts:75-80` |
| `critic_role` | стадия критика ядра | ядром не вызывается — после caps сразу apply (`src/gateway/consolidation/runner.ts:47-50`). Критик существует, но **внутри сессии роли**: pi-расширения `~/.pi/agent-memory/tdai/extensions/task-cycle-{memory,night,dedup-daily}-critic/` + `src/core/prompts/skills/*-critic/SKILL.md`. Т.е. гейт есть, но он host-specific и не поддаётся проверке ядром |
| `ops_subset` | разрешённые операции | `assertOpsSubset` определён (`apply-executor/validate.ts:44`) и экспортирован (`apply-executor.ts:23,58`), но в `apply()` не вызывается — `apply-executor.ts:84-95` |
| `schedule` / `threshold` | расписание роли | таймер берёт `config.memory.nightRun.*` — `server.ts:181-183` |

Диспетчеризации по контракту нет:

- выбор раннера — строковым сравнением с `"night-keeper"` (`orchestrator.ts:143`), таймер знает только эту роль (`night-run.ts:106`);
- `ranToday` считается по глобальному `getLastRunAt` (`server.ts:188`), хотя per-role `lastRunAt` уже хранится (`checkpoint.ts:26-50`);
- `dedup-daily` (`schedule: "03:00"`) не вызывает никто; `listRoles` (`role-loader.ts:90`) используется только для HTTP-листинга (`server.ts:77,680`).

day/night — это **разная семантика**, а не разное время: day — fresh-tail один батч с глобальным `diffCap` (`day-runner.ts:50-60`), night — **bounded** full-store срез (SQL ограничен `NIGHT_SWEEP_LIMIT = 25_000`, `consolidation/queries.ts:31-40`, `types.ts:85`, дальше пагинации нет), затем мультибатч со своими caps и anchored-курсором (`night-runner.ts:50-60`).

Что уже сделано правильно и ломать нельзя:

- single-flight **per role** (`role-gate.ts:10-33`, `tryAcquire` — `:25`);
- diff уходит агенту **в промпт** (`composeSessionPrompt(diff.text, …)`, `runner-stages.ts:68-72`) и дублируется в scratch;
- **env** ребёнка — явный whitelist, секретов в нём нет (`child-spawn.ts:62-79`);
- inline-L2 намеренно no-op при `consolidation.enabled` (`utils/pipeline-factory/l2-runner.ts:29-33`) — но это выключает только inline-путь, а не гарантирует одного писателя сцен (см. §5, `single-scene-writer`);
- `IMemoryStore` (`src/core/store/types.ts`) — backend-neutral **интерфейс ядра**, два бэкенда: `sqlite.ts`, `tcvdb.ts`.

### 2.1 Граница доверия слабее, чем кажется

Формулировку «писать память может только родитель» нельзя использовать как security-инвариант — это соглашение happy-path, не механическая гарантия:

- ребёнку передаётся настоящий `HOME` (`child-spawn.ts:71`), и комментарий рядом (`:62-67`) прямо говорит, что через него читаются provider-credentials из `~/.pi/agent/auth.json` (`:66`);
- `spawnFlags` (`tdai-gateway.yaml:65`, `keeper-run.ts:27`) не ограничивают встроенные тулы хоста — у pi по умолчанию доступны `bash`, `read`, `edit`, `write`;
- `GET /memory/info` **без авторизации** отдаёт абсолютные `dataDir` и `tokenPath` (`memory-routes/info.ts:16-25`).

Итого процесс того же пользователя может править файлы памяти напрямую, прочитать 0600-токен и вызвать защищённый POST с `x-memory-token`; credential-gate (`server.ts:397`) от этого не защищает. Разделяем два утверждения: «в env нет секретов» — истинно и узко; «ребёнок технически не может мутировать память» — **ложно**.

Аналогично про стор: backend-neutral только интерфейс ядра, а role-pipeline его обходит прямым SQL — workset (`consolidation/queries.ts:20`), L0-курсор и счёт (`consolidation/diff-builder.ts:105`), stale/meta-проверки apply (`apply-executor/apply-helpers.ts:38`).

И про критика: инфраструктура есть, но родитель **не имеет доказательства**, что критик запускался и одобрил именно этот кандидат — после `preApply` идёт apply (`runner.ts:47`). Это protocol convention внутри агента, не гейт.

Прочие дефекты: вход и выход роли — один файл `diff.json` (вход `runner-stages.ts:68-78`, результат `:121`); `prompt_file` игнорируется, но fallback не единственный — есть legacy и bare-варианты (`role-loader.ts:57`); каталог тулов копируется целиком на `keeper-tools.ts:55`; scratch после не-dry-run прогона удаляется (`day-runner.ts:119`, `night-runner.ts:112`), т.е. «прогон читаем» сегодня неверно вдвойне — и сессии нет, и scratch стёрт. Плюс checkpoint пишется по снапшоту, а не по живому значению: guard `cursor >= prevCursor` в `advanceCheckpoint` (`consolidation/queries.ts:81`) сверяется с `cp.l0Cursor`, прочитанным в начале прогона (`day-runner.ts:45`, `night-runner.ts:45`), из-за чего параллельные day и night откатывают курсор друг другу (разбор и требование — §8, шаг 8).

## 3. Модель

### 3.1 Унифицированные сущности

По образцу платформенного документа — один жизненный цикл вместо класса на роль:

```text
RoleExtension   — пакет: манифест + промпт + тулы + схемы (долговременная специализация)
Assignment      — конкретная работа сейчас: TASK / INPUTS / PROCEDURE / OUTPUT CONTRACT
RoleRun         — логическая ответственность за выполнение assignment (id, role, trigger, status)
LaunchAttempt   — одна попытка исполнения RoleRun
HostSession     — нативная сессия конкретного хоста (pi / Claude Code / Codex)
```

Никаких `MemoryKeeperAgent extends Agent`. Роль — данные; поведение — стандартные стратегии ядра, выбранные контрактом.

Имён недостаточно — нужен сохраняемый контракт и state machine, иначе ретраи, отмена и partial apply некуда записать:

```text
RoleRun     { runId, assignmentId, roleId, roleVersion, contractHash,
              binding: ResolvedExecutionBinding, inputDigest,
              state, attempts[], createdAt }
LaunchAttempt { attemptId, runId, hostSessionRef, lease{owner,expiresAt,fence},
              startedAt, endedAt, exit: {code|signal|timeout|cancel},
              candidateDigest?, errorClass? }
state: pending → running → candidate → reviewed → applying → applied
                        ↘ failed ↘ rejected  ──(retry-policy)──→ pending
                                             ↘ needs-reconciliation ↘ cancelled
```

**Линеаризация — два разных claim'а, не один.** Apply-claim на `reviewed → applying` не мешает двум попыткам параллельно дойти до `reviewed`: обе стартовали, обе произвели кандидата, вторая просто проиграет гонку уже после того, как потратила запуск модели и, возможно, записала свой кандидат поверх. Поэтому claim нужен и на старте попытки.

| | attempt-claim | apply-claim |
|---|---|---|
| переход | `pending|failed → running` | `reviewed → applying` |
| инвариант | ровно одна **активная** попытка на Run | ровно один обработчик в apply |
| единица владения | lease `{ runId, attemptId, owner, expiresAt, fence }` | тот же lease, проверяемый на входе в мутацию |

`fence` — монотонный счётчик Run, инкремент на каждый выданный lease. Это и есть защита от «зависший владелец ожил после takeover».

**Fence проверяется на каждой записи в Run, а не только перед мутацией.** Иначе гонка просто съезжает со старта попытки на сдачу её результата: A1 берёт lease (`fence=1`), heartbeat запаздывает (не смерть процесса — медленный провайдер), takeover выдаёт A2 `fence=2`, A1 помечена `abandoned` — и тут A1 дописывает кандидата и делает `running → candidate`. Поэтому **любая** запись в состояние Run принимает `fence` и отвергается, если в Run записан больший (`stale-fence-rejected`): переходы `running → candidate | failed | rejected`, `candidate → reviewed`, записи `out/result.json`, `out/critic.json` и receipt'ов: результат заброшенной попытки не становится кандидатом Run. Отвергнутая запись не теряется — она остаётся в артефактах своей попытки для разбора, но не влияет на состояние Run. Владение каталогом `out/` попытки к этому не сводится: каталог у каждой попытки свой (§3.5), а конфликт возникает именно на общем состоянии Run.

- **Takeover.** Lease с истёкшим `expiresAt` перезахватывается любым обработчиком: новый `attemptId`, новый `fence`, прежняя попытка помечается `abandoned`. Продление lease — heartbeat владельца; отсутствие heartbeat ≠ смерть процесса, поэтому корректность держится на fence, а не на kill.
- **Run застрял в `applying`.** Единственный выход — reconciliation (§4.4), не takeover apply: журнал операций по `(runId, candidateDigest)` перечитывается, каждая операция проверяется на факт в сторе, Run уходит в `applied` (все verified) либо в `needs-reconciliation`. Автоматический повторный вход в `applying` по истёкшему lease запрещён.
- **Cancel vs claim.** Cancel — это захват того же lease с записью terminal-намерения, а не сигнал процессу. Проиграл гонку claim'у — cancel не отменяет уже начатый apply (тот доиграет до `applied`/`needs-reconciliation`); выиграл — Run уходит в `cancelled`, а поздний результат прежнего владельца отсекается по fence. Cancel в состоянии `applying` не переводит Run в `cancelled` — только помечает «не ретраить после завершения».
- **Ретрай.** `failed` и `rejected` — не терминальные для Run, а терминальные для попытки: retry-policy роли переводит Run обратно в `pending` (новый `LaunchAttempt`, тот же пиннутый контракт и workset). Терминальны для Run: `applied`, `cancelled`, `needs-reconciliation` и исчерпание retry-бюджета (тогда попытка фиксируется как `failed-terminal`).

Метаданных мало — нужны и сами payload'ы. Assignment/workset, кандидат, вердикт и журнал apply лежат в durable контент-адресуемом хранилище, а не только в scratch: после падения одного дайджеста недостаточно, чтобы повторить попытку, доказать содержимое входа или продолжить reconciliation. Scratch остаётся рабочей копией для человека и стирается (`day-runner.ts:119`).

`RoleRun` неизменяем внутри себя: роль, её версия, хеш резолвнутого контракта, binding и входной digest пинятся при создании (`contract-snapshot-pinned`). Ретрай — это новый `LaunchAttempt` того же Run, а не новый Run. Репозиторий Run/Attempt — серверный и durable; `run.json` в scratch остаётся копией для человека, но не источником истины (scratch удаляется — `day-runner.ts:119`).

Сегодня в `RunSummary` нет даже `runId` (`src/gateway/consolidation/types.ts:34`) — это стартовая точка работ по наблюдаемости (§4.1).

### 3.2 Слои

```text
transport   HTTP /memory/*, таймер, ручной запуск
   ↓
service     Dispatcher (что и когда) → RoleRunService (prepare → launch → parse → critic → caps → apply → checkpoint)
   ↓
domain      RoleExtension (манифест+контракт), trigger-предикаты, batching-стратегии, схемы результата и вердикта
   ↓
repo        IMemoryStore, scene-репозиторий (файлы), checkpoint, реестр расширений
```

Точек расширения три — **RoleExtension**, **Dispatcher**, **RoleLauncher** (сущности жизненного цикла из §3.1 к ним не относятся, их пять). `Store` уже есть (`IMemoryStore`) — второй клиент памяти не вводится. Универсальный EventBus и каталог из пяти хуков — YAGNI: подписчиков нет. Вместо них один узкий порт на границе репозитория — `MemoryCommitObserver` (§4.5).

### 3.3 Роль как расширение

```text
role-extensions/tdai.memory-keeper/
├── manifest.json        id, version, engine.roleApi, entry, assets, contract, permissions, tools, critic
├── entry.json           декларативный контракт (ts-модуль — только под нестандартный workset/parser)
├── prompts/system.md
├── tools/*.tool.json    схема + переносимая реализация
├── skills/*.md          host-neutral описание процесса (фазы, требуемые артефакты)
└── schemas/output.json  + critic.json
```

Разложение существующего `RoleConfigFile` (`src/gateway/role-schema.ts`): `name → manifest.id`; `scope, idsOnly, diff_cap, diff_byte_cap → entry.workset/batching`; `trigger, schedule, threshold →` дефолт в entry + instance-override; `ops_subset, caps, max_run_ms → entry.policy` (enforced ядром); `tools_subset → manifest.tools`; `prompt_file → assets.prompt`; `critic_role → entry.critic`; **`model, thinking →` instance-уровневый `ExecutionBinding`, а не `entry`** (см. §3.4: обязательный, но не часть переносимой identity; launcher транслирует его в свой синтаксис, но не выбирает); `enabled, scratch_root, keep_scratch →` instance-конфиг (`keep_scratch` по умолчанию `false`, retention прогонов — N последних на роль, значение задаётся в instance-конфиге); `extension_path, skill_path` — legacy assets адаптера, в V2 их нет.

**Source of truth и precedence — один, без скрытых fallback'ов:**

| Уровень | Что хранит | Может переопределять |
|---|---|---|
| `RolePackage` | переносимую identity: workset, batching, prompt/schema/tool assets, policy, critic reference | ничего хостового |
| `RoleInstance` | `enabled`, trigger override, scratch/retention и обязательный `ExecutionBinding { launcherId, provider, model, thinking, authProfileRef, isolationProfileRef }` | только явно разрешённые instance-поля |
| `RoleRun` | immutable snapshot package + instance, их hashes и resolved assets | ничего после создания Run |

`launcherId` не является полем переносимого контракта роли: он живёт только в `ExecutionBinding`. `model`/`thinking` в нынешнем `role.json` — legacy-форма того же binding, а не часть будущей identity. `ResolvedRoleContract` строится один раз при создании Run; после этого чтение глобального `config.memory.consolidation.*` запрещено.

Совместимость текущего формата обеспечивается единственным `LegacyRoleAdapter`: он валидирует нынешний полный `role.json`, переводит `model`/`thinking` и pi-runtime wiring в synthetic `RoleInstance`, пишет warning и возвращает тот же `ResolvedRoleContract`. Только этот адаптер на переходном этапе может подставить старый глобальный pi-конфиг для действительно отсутствующего legacy-поля. V2 package/instance fail-closed: битый package, отсутствующий binding или asset дают `disabled(reason)`, а не runtime fallback. Так устраняется противоречие «строгая схема, но значения всё равно берутся из global».

Поля уже резолвятся в `RoleRuntime` (`src/gateway/consolidation/role-runtime.ts:114-126`) — и там же обрываются: потребителей у `promptFile` / `toolsSubset` / `criticRole` / `model` нет, дальше используется только `runtime.*`.

**Batching — явный enum контракта**, не вывод из `scope`:

- `memory-keeper`: fresh-tail, single-batch, advance-on-success/empty;
- `night-keeper`: bounded full-store, чанкование, накопленные caps, anchored checkpoint;
- `dedup-daily`: bounded full-store, чанкование, только `deleteL1`/`merge`, свой checkpoint-policy.

«Чанкование», не «пагинация»: night делает **один** `SELECT … ORDER BY created_time ASC LIMIT 25000` без курсора (`queries.ts:29-46`) и режет результат в памяти (`chunkRecords`, `night-runner.ts:63`). Записи за пределами `NIGHT_SWEEP_LIMIT` не увидит ни один прогон — это не «дочитается в следующий раз». Контракт обязан различать `chunked` и настоящий `paged` (курсорный обход всего стора); сегодня реализован только первый.

Исполняемый код роли не обязателен в целевой модели: три живые роли можно выразить декларативно, когда стратегии стандартизованы. **Но текущие роли ещё не декларативны фактически**: их `role.json` указывает `runtime.extension_path` и `runtime.skill_path`, а `role-spawn-args.ts:22-33` добавляет эти pi-артефакты в запуск. Поэтому единственный `LegacyRoleAdapter` переводит одновременно старый формат, binding и executable wiring в synthetic package/instance/assets. Удалять его можно только после characterization + parity-shadow каждой роли и переноса обязательного task-cycle/critic поведения в ядро. `import()` пользовательского кода внутри gateway запрещён; `vm` границей безопасности не считается, и «отдельный процесс» без своего uid / контейнера / mount namespace — тоже не sandbox.

**Два класса доверия** (иначе запрет на `fs`/spawn противоречит §3.5, где роли подкладывают python-скрипты анализа — им как раз нужны файлы и запуск):

| Класс | Что это | Что доступно |
|---|---|---|
| `declarative` / untrusted entry | контракт без кода либо чужой пакет | только capability-RPC: `memory.*.read`, `scratch.rw`, clock, logger. Никакого сырого `fs`, `process.env`, spawn, write-креденшелов |
| `packaged-tool` (trusted) | тулы роли, в т.ч. python-скрипты | запускает launcher/контейнер-адаптер по явному allow-list: конкретные бинари, рабочий каталог прогона, разрешённый loopback-endpoint |

`allowExecutable` разрешает второй класс поимённо — не «роль может всё». И объявить себя trusted пакет не может: доверие назначается снаружи, admin-controlled реестром с digest/подписью пакета. Ограничение `cwd` и allow-list бинарей само по себе не мешает python-коду ходить по ФС и в сеть — это уровень OS/capability, а не аргументов запуска.

### 3.4 Модель и сессия роли (решение владельца)

- **Провайдер и модель фиксированы для роли** — явные `provider/model`, никакого sentinel-наследования (`"model": "inherit"` из pi-аудитора, `auditors.ts:74-75,829-839`) как основного механизма: исполнение роли должно быть детерминированным. Отдельно чинится то, что роль-значения сегодня не доезжают до спавна (`runner-helpers.ts:75-80`).
- **Где именно они лежат**: не внутри переносимой identity расширения, а в instance-уровневом `ExecutionBinding` рядом с ролью, и фиксируются в `RoleRun.binding` (`ExecutionBinding {launcherId, provider, model, thinking, authProfileRef, isolationProfileRef}`) на момент создания прогона. Причина: платформенный референс держит execution вне идентичности роли (`preferredExecution` — policy hint, `agent-platform-unified-final-architecture(1).md:2045,2059`); если модель попадёт в identity, смена модели породит «новую роль», а pinned pi-провайдер сделает пакет несовместимым с Claude/Codex. Детерминирован при этом **выбор execution-конфигурации**, а не результат LLM: binding обязателен, дефолта «выбери сам» нет, он записан в каждом прогоне. Для воспроизводимости прогона к нему добавляются digest пакета и ассетов, версия launcher'а и точная ревизия модели, если провайдер её отдаёт.
- **`--no-session` не ставится.** У каждой попытки собственная сессия (топология — §3.5, общий `<root>/<role>` недостаточен). Обоснование зафиксировано в pi-аудиторе: «`--no-session` made the child ephemeral and verdict failures opaque» (`auditors.ts:825-828`, замена — `:848`). Из `spawnFlags` (`src/config.ts:733-737`) флаг убирается.

### 3.5 Рабочая папка агента и поток данных

Агент должен *видеть*, что происходит: ядро материализует одинаковый bundle, а diff кладётся и в промпт, и в файл. Вход и выход разводятся (сейчас оба — `diff.json`):

Топология — `<role>/<runId>/attempt-<n>/`: нативная `HostSession` появляется только после запуска, поэтому её id пишется в метаданные попытки, а не в путь. `session-per-attempt` — это не общий `--session-dir <root>/<role>` (у аудитора вообще один общий корень, `auditors.ts:72`): нужен attempt-специфичный каталог либо явный идентификатор сессии на попытку, и обязательный `hostSessionRef` в записи попытки. Иначе вторая попытка молча продолжит контекст первой.

```text
<scratch>/<role>/<runId>/attempt-<n>/
├── run.json            что за прогон, чем триггернут
├── input/workset.json  предъявленный diff (read-only для роли)
├── prompt/system.md
├── schemas/output.json
├── tools/              только tools_subset роли
├── skills/
├── artifacts/          рабочие файлы роли (сюда же — будущие скрипты анализа)
└── out/result.json     кандидат; out/critic.json — вердикт
```

`keep_scratch` — поле instance-конфига (внесено в маппинг §3.3, дефолт `false`, retention — N последних прогонов на роль): без него прогон стирается после каждого не-dry-run запуска (`day-runner.ts:119`, `night-runner.ts:112`) и инвариант `inspectable-run` непроверяем. Скрипты анализа подкладываются в `tools/` пакета роли — без изменения ядра.

**Переименование не бесплатно.** `diff.json` как имя контракта зашит в промпты: 45 упоминаний в шести `src/core/prompts/skills/{memory-keeper,night-keeper,dedup-daily,memory-critic,night-critic,dedup-daily-critic}/SKILL.md`, плюс материализованные зеркала в `~/.pi/agent-memory/tdai/skills/` (`scripts/sync-memory-skills.sh`). Порядок: (1) ядро пишет `input/workset.json` и **дублирует** его в `diff.json`, читает результат из `out/result.json` с fallback на `diff.json`; (2) скиллы правятся lockstep и пересинхронизируются; (3) legacy-имя удаляется отдельным шагом. Без этого роли начнут читать пустоту.

### 3.6 Граница host-agnostic

| Ядро (host-neutral) | RoleLauncher (per host) |
|---|---|
| контракт роли и его резолв | бинарь, argv, SDK |
| trigger / due / skip, per-role `lastRunAt` | доставка system/task-промпта |
| сборка workset и diff, материализация bundle | регистрация тулов, skills |
| схемы результата и вердикта | auth discovery, HOME/сессии |
| caps, `ops_subset`, apply, checkpoint | lifecycle процесса, kill, timeout |
| single-flight per role, critic-стадия | преобразование вывода в `HostRunResult` |

Минимальный порт launcher'а фиксирован, иначе реализации нельзя взаимозаменять:

```ts
interface RoleLauncher {
  launch(
    input: LaunchInput,
    signal: AbortSignal,
  ): Promise<Result<RunningHandle, LaunchError>>;
}

interface RunningHandle {
  readonly sessionRef: string;
  readonly completion: Promise<HostRunResult>;
  cancelAndWait(reason: string): Promise<HostRunResult>;
}

type HostRunResult = {
  status: "succeeded" | "failed" | "timed_out" | "cancelled";
  exitCode: number | null;
  signal: string | null;
  sessionRef: string;
  stdoutRef: string;
  stderrRef: string;
  startedAt: string;
  endedAt: string;
  outputRef?: string;
  errorClass?: string;
};

type LaunchError = {
  kind: "binary-not-found" | "permission-denied" | "host-incompatible" |
    "invalid-binding" | "isolation-unavailable";
  message: string;
  cause?: Error;
  isRetryable: boolean;
};
```

Attempt и `sessionRef` создаёт core до launcher-вызова. Expected start failures возвращаются typed `LaunchError` и сохраняются в этот Attempt; launcher не reject'ит ими. Unexpected throw конвертируется service boundary в `internal-launcher`. `completion` завершается только после `close` процесса и reap потомков, а не сразу после отправки `SIGKILL`. stdout/stderr ограничены и spool'ятся в артефакты; память процесса не растёт вместе с выводом. `exitCode !== 0`, timeout, cancel и start failure никогда не переходят к parse/apply. `cancelAndWait` идемпотентен и возвращает тот же terminal result, что `completion`.

`HostAdapter` (`src/core/types.ts:154-166`) для этого **не расширяется** — он про `getRuntimeContext/getLogger/getLLMRunnerFactory`, памяти в нём нет. Доступ ребёнка к памяти — только чтение через HTTP `/memory/*`; мутации — родитель через `ApplyExecutor`. Хост, не поддерживающий обязательную capability, отваливается `host-incompatible` — молча выкинуть критика или тул нельзя.

**Host-agnostic — это две границы, а не одна.** Выше описан производитель памяти (роль под сменным launcher'ом). Вторая, независимая — **потребитель**: сессия, которая память читает и пополняет. Сегодня это `GET /memory/search` и `POST /memory/note` (`src/gateway/memory-tools.ts:1-9`), которые pi-расширение выставляет как MCP-тулы `memory_search` / `memory_note`. Требование владельца «память адаптирована и для Claude, и для Codex» закрывается именно здесь: контракт потребителя — HTTP + его MCP-обёртка, и он обязан быть одинаков для всех трёх хостов.

| | производитель (роль) | потребитель (сессия) |
|---|---|---|
| что делает | строит кандидата, ядро применяет | читает recall, пишет заметку в L0 |
| граница | `RoleLauncher` | HTTP `/memory/*` + MCP-обёртка |
| авторизация | нет прямого доступа к мутациям | `search` auth-free loopback, `note` под write-gate |
| смена хоста | новый launcher | ничего не меняется, обёртка та же |

Из этого следуют две вещи, которые нельзя молча пропустить при перенарезке: MCP-сервер как таковой в репозитории **не существует** — обёртка живёт на стороне pi-расширения, поэтому «Claude/Codex тоже умеют» означает написать хост-нейтральную обёртку, а не переиспользовать имеющуюся; и `nogo-l0-path` (`memory-tools.ts:99`) остаётся в силе — `note` вливается в существующий capture-путь, а не заводит второй.

## 4. Протоколы исполнения

### 4.1 Наблюдаемость

Durable Run-репозиторий (не scratch): `runId` / `assignmentId` / `attemptId` / ссылка на `HostSession`; `roleId` + `roleVersion` + hash резолвнутого контракта; `binding` (host, provider, model, thinking); дайджесты входа, кандидата и вердикта; таймстемпы и переходы состояний; исход попытки (`code` / `signal` / `timeout` / `cancel`); receipts критика и apply; пути к сессии, scratch и логам; категория ошибки. Стартовая точка: в `RunSummary` сегодня нет даже `runId` (`consolidation/types.ts:34`).

### 4.2 Отказы и ретраи

| Класс отказа | Реакция |
|---|---|
| transient launcher/provider | новый `LaunchAttempt` того же Run |
| невалидный вывод / reject критика | новая попытка либо terminal reject по policy роли |
| конфликт манифеста/стора (устарел workset) | новый Assignment и Run с новым workset |
| **partial apply** | не ретрай, а reconciliation (§4.4) |
| timeout / cancel | kill процесса и потомков, поздний apply запрещён (`cancel-means-no-late-apply`) |

Fail-open уместен для advisory-аудита (`auditors.ts:933`), но **не** для критика перед мутацией — там fail-closed.

### 4.3 Схема вердикта критика

```text
schemaVersion, runId, candidateDigest, criticAttemptId, fence,
decision: approve | reject | retryable_error,
findings[]: { severity, code, opIndex|location, evidence, remediation },
reviewer: { roleId, roleVersion, provider, model },
checkedPolicy: { opsSubset, caps, manifestDigest }
```

Ядро сверяет `runId` и `candidateDigest` — это связывает **вердикт с кандидатом**. Отдельно кандидат связывается **со входом и с попыткой**: `out/result.json` обязан нести `runId`, `inputDigest`, `attemptId` и `fence`; ядро сверяет первые два с неизменяемым Assignment из Run-репозитория (`candidate-bound-to-input`), а вторые два — с текущим lease Run (§3.1, `stale-fence-rejected`). Иначе роль может предъявить результат, посчитанный на другом workset.

Вердикт живёт по тем же правилам, что и кандидат, и **критик-стадия — отдельно захватываемая единица, а не поле попытки роли**. Причина: критик — самостоятельный вызов ядра после `parse` (§3.2), и «невалидный вывод критика» (§4.2) чинится повторным запуском критика над тем же кандидатом, а не перегенерацией кандидата ролью. Значит двух критик-инстансов на один `candidateDigest` достаточно для той же гонки: медленный первый и его ретрай оба пишут `out/critic.json`.

`CriticAttempt { criticAttemptId, runId, attemptId, candidateDigest, fence, verdictDigest? }` — берёт lease того же Run и тот же `fence`-счётчик, инкрементируемый при выдаче. Запись `out/critic.json` и переход `candidate → reviewed` отвергаются по устаревшему `fence` так же, как результат роли (§3.1). Ретрай критика — новый `CriticAttempt`, а не перезапись; ретрай, потребовавший нового кандидата, — новый `LaunchAttempt`. После принятого вердикта на запись недоступны обе стороны: и роль, и предыдущие критик-инстансы.

Критик — такой же версионированный `RolePackage`, но с отдельной `CriticPolicy`: только read-only candidate/workset, схема `critic.json`, ноль memory-write capabilities и обязательный `ExecutionBinding`. Ссылка `critic_role` разрешается fail-closed **при создании Run**, а не после дорогого запуска основной роли. До первого shadow-run должны существовать валидные package + instance для каждого критика; prompt без manifest/contract не считается ролью. Bootstrap-порядок: package критика → binding → launcher capability-check → synthetic negative verdict test → только затем включение основной роли. In-session task-cycle критик текущего pi-extension остаётся частью `LegacyRoleAdapter`, но не считается доказательством generic critic-gate.

### 4.4 Partial apply

Мутации идут последовательно — merge → rewriteRecord → delete → files (`apply-executor.ts:93`), и ошибка приходит уже после части изменений; при провале scene-index статус становится `failed`, но признак частичности не выставляется (`apply-executor.ts:104`). Нужны: журнал apply с ключом идемпотентности `(runId, candidateDigest)`, receipt на операцию, терминальное состояние `needs-reconciliation`, запрет checkpoint при частичном применении, блокировка конфликтующих apply.

Отдельно — crash-window: «операция выполнена → процесс упал → receipt не записан». Уникальность `(runId, candidateDigest)` его не закрывает — она идентифицирует применение целиком, а восстанавливать надо пооперационно.

**`operationId` = `hash(runId, candidateDigest, opIndex)`** — стабилен между рестартами, вычисляется из неизменяемого кандидата, не из порядка выполнения. Журнал ведётся по `operationId`, каждая запись несёт `fence`.

Восстановление — не «перезапустить apply», а функция от состояния записи в журнале:

| состояние в журнале | что известно | восстановление |
|---|---|---|
| записи нет | операция не начиналась | выполнить |
| `prepared` | могла выполниться, могла нет | проверить **postcondition** в сторе → `applied` либо выполнить |
| `applied` | мутация прошла, verify не подтверждён | проверить postcondition → `verified` либо `needs-reconciliation` |
| `verified` | подтверждена | пропустить |

Postcondition обязателен для каждого типа операции и проверяем чтением, а не «должно было получиться»: `deleteL1` — записи с `record_id` нет; `merge` — целевая запись содержит слитый контент, исходные отсутствуют; `rewriteRecord` — содержимое равно ожидаемому дайджесту; `rewriteBlock` — файл блока и его запись в `scene_index` совпадают по дайджесту с кандидатом. Без сформулированного postcondition операция не имеет права быть в `ops_subset`.

**Домены транзакций у стора разные, и это не деталь реализации.** SQLite-бэкенд (`src/core/store/sqlite.ts`) может писать мутацию и запись журнала в одной транзакции — тогда `prepared` не нужен вовсе. TCVDB (`src/core/store/tcvdb.ts`) и scene-файлы — нет. Значит журнал обязан жить в SQLite рядом с Run-репозиторием. **Это локальный control-plane, а не бэкенд памяти**: Run/Attempt/журнал лежат в собственной локальной SQLite независимо от того, TCVDB или SQLite обслуживает саму память — иначе выбор бэкенда памяти определял бы наличие транзакций в протоколе управления. В перечень деградаций `backend-parity` (§5) это входит явной строкой: на TCVDB-бэкенде мутации памяти не разделяют транзакцию с журналом, поэтому там работает saga, а не common-commit.

Для не-SQLite операций работает saga: `prepared` (журнал) → мутация → `applied` (журнал) → verify-чтение → `verified`. Компенсации нет — рекавери idempotent-повтором, поэтому каждая операция обязана быть переигрываемой (`delete` уже удалённого — успех, не ошибка).

Fencing участвует и здесь: запись в журнал с `fence` меньше текущего отвергается. Иначе воскресший владелец допишет `verified` поверх состояния, которое уже переигрывает новый.

Реконсилиация — отдельная явная операция (ручная или по расписанию), не тихий фон: Run в `needs-reconciliation` блокирует checkpoint роли и её следующий запуск.

### 4.5 Точка коммита памяти

Вместо разрозненных колбэков durable M0/M1/M2/M3 (code: L0/L1/L2/L3) — один узкий порт на границе репозитория: `MemoryCommitObserver.onCommitted(MemoryMutation)`. Разрозненные колбэки пропустят apply, retention-очистку памяти (`LocalMemoryCleaner`, `src/utils/memory-cleaner.ts:108` — именно она мутирует стор; gateway-`runCleanup`, `cleanup.ts:4`, чистит только артефакты прогонов и памяти не касается), profile-sync или новый бэкенд. Если доставка должна переживать краш — durable outbox. Универсальный EventBus по-прежнему не нужен.

## 5. Инварианты

Целевые. Колонка «сегодня» — честное состояние, а не намерение: почти все нарушены, и это и есть объём работ.

**У каждого инварианта — исполняемая проверка.** Инвариант без неё нерабочий: grep по подстроке ловит формулировку, а не поведение, и зеленеет на закомментированном коде. Ниже колонка «проверка» — это то, что должно упасть при нарушении. `[t]` — рантайм-тест, `[a]` — AST/import-чек по исходникам, `[f]` — проверка артефактов на диске после прогона.

| Инвариант | Что значит | Проверка | Сегодня |
|---|---|---|---|
| `single-writer-per-role` | один активный прогон роли | `[t]` два процесса gateway на одном `dataDir` стартуют роль одновременно → ровно один получает lease, второй ждёт | частично: только внутри процесса, две инстанции gateway не координируются (`role-gate.ts:25`) |
| `single-apply-per-store` | apply сериализован по стору; конфликтующие ждут | `[t]` два apply разных ролей параллельно → сериализованы; порядок мутаций в журнале не переплетён | **нарушен**: разные роли проходят `ApplyExecutor` параллельно |
| `single-scene-writer` | scene-bundle проекта пишет ровно один прогон | `[t]` две роли с `rewriteBlock` на один слаг → сериализованы claim'ом `scene:<slug>` (файлы **и** `scene_index`); второй проходит после ожидания и перепроверки manifest'а | **нарушен**: `memory-keeper` и `night-keeper` имеют разные ключи гейта и оба несут `rewriteBlock`; индекс пишется отдельной поздней операцией без атомарной подмены |
| `single-persona-writer` | `persona.md` пишет ровно один прогон | `[t]` два Run с `rewritePersona` → итог равен одной verified-операции, не смеси | **нарушен**: обе роли несут `rewritePersona`, гейт их не разделяет |
| `core-owns-apply` | роль отдаёт кандидата, пишет ядро | `[t]` ребёнок пробует прямую запись в `dataDir` и вызов `/memory/apply` своим токеном → отказ на обоих путях | **нарушен**: см. §2.1 — у ребёнка `HOME`, файловые тулы и путь к токену |
| `least-privilege-child` | ограничены env, argv, ФС, креды и сеть | `[t]` негативный: чтение `~/.pi/agent/auth.json`, запись вне scratch, исходящее соединение — все три падают | **нарушен**: заданы env, argv и cwd (`keeper-run.ts:28-44`), но ФС, креды и сеть — нет; тот же UID видит и `HOME`, и credential из `tdai-gateway.yaml:11` |
| `caps-enforced` | `ops_subset` и caps проверяются на каждом apply | `[t]` кандидат с операцией вне `ops_subset` и кандидат сверх cap → оба отклонены до мутаций; `[a]` каждый путь в `apply()` проходит через `assertOpsSubset` | **нарушен**: `assertOpsSubset` не вызывается |
| `critic-before-apply` + `critic-fail-closed` | без валидного вердикта apply не идёт | `[t]` apply без `out/critic.json`, с битым вердиктом и с вердиктом на другой `candidateDigest` → отказ во всех трёх | **нарушен**: критик — соглашение внутри сессии |
| `candidate-bound-to-input` | результат и вердикт несут digest неизменяемого workset | `[t]` подмена `inputDigest` в `out/result.json` → apply отклонён | нет |
| `idempotent-apply-by-run-id` | повтор apply с тем же `(runId, candidateDigest)` не дублирует | `[t]` тот же apply дважды → счётчики и содержимое стора идентичны после первого и второго | нет |
| `partial-apply-requires-reconciliation` | частичный apply → терминальное состояние, не тихий `failed` | `[t]` инъекция сбоя на 2-й из 3 операций → Run в `needs-reconciliation`, checkpoint не сдвинут, журнал перечисляет `verified`/`prepared` | **нарушен** (`apply-executor.ts:104`) |
| `checkpoint-after-complete-apply` | checkpoint только после полного применения | `[t]` сбой позднего батча → курсор равен значению до прогона; повторная финализация того же `runId` → no-op | **частично нарушен**: day не двигает checkpoint при ошибке батча, night может вызвать `advanceCheckpoint` после ранее успешных батчей даже при поздней ошибке (`night-runner.ts:86-93`, `night-batches.ts:81-89`) |
| `checkpoint-cursor-monotonic` | `l0Cursor` не убывает ни при каком переплетении прогонов | `[t]` параллельные day и night со снапшотом одного `P0`, night финиширует вторым с меньшим anchor → курсор остался максимальным | **нарушен**: guard сверяется со снапшотом старта (`queries.ts:81`, §2) |
| `contract-snapshot-pinned` | роль, версия, схемы и binding неизменны внутри Run | `[t]` правка `role.json` между попытками одного Run → вторая попытка идёт по пиннутому контракту, `contractHash` не изменился | нет |
| `session-per-attempt` | каждая попытка — своя сессия, без неявного resume | `[f]` у двух попыток одного Run разные `hostSessionRef` и непересекающиеся каталоги; в транскрипте второй сессии нет ни одного сообщения первой (сверка по id сообщений, а не по объёму) | нет |
| `cancel-means-no-late-apply` | после отмены/таймаута apply запрещён | `[t]` cancel во время `running` + попытка позднего apply прежним владельцем → отклонён по fence | нет |
| `stale-fence-rejected` | запись от заброшенной попытки не меняет состояние Run | `[t]` takeover по истёкшему lease, затем запись `out/result.json`, `out/critic.json` и receipt прежним владельцем → все три отклонены, состояние Run от них не зависит | нет |
| `contract-drives-execution` | ни один параметр роли не берётся из глобального конфига | `[a]` в `RoleRunService` и стратегиях нет обращений к `config.memory.consolidation.*` / `config.memory.nightRun.*`; `[t]` две роли с разными `model` в одном прогоне получают разные binding | **нарушен**: §2 |
| `no-host-hardcode` | бинарь и хост-флаги только в `launchers/<host>.ts` | `[a]` вне `launchers/` и тестов нет ни имени бинаря, ни pi-флагов: `--session-dir`, `--thinking`, `--system-prompt`, `--no-context-files`, `--no-session`, `--no-extensions`, `--extension`, `--skill`, `--no-skills`, `-p`. **`src/config.ts` не исключение** — дефолт `spawnFlags` там сам является pi-хардкодом (`src/config.ts:733-737`) и обязан уехать в launcher; проверка покрывает все аргументы спавна, а не только те, что собираются в общем коде (`role-spawn-args.ts:24-32`) | **нарушен**: pi-спавн в общем коде (`runner-helpers.ts:63`), pi-флаги в дефолте конфига и в `role-spawn-args.ts:24-32` |
| `fail-closed-role` | невалидный пакет отключает роль с диагностикой | `[t]` битый JSON, неизвестное поле и отсутствующий промпт → роль в `disabled` с причиной, а не молчаливое исчезновение из реестра | **нарушен**: тихий `null` (`role-loader.ts:27`, тот же путь на `:66-73`) |
| `backend-parity` | возможность есть на обоих бэкендах либо явно объявлена отсутствующей — с перечнем того, что деградирует | `[t]` **contract-тест против `IMemoryStore`**, гоняемый дважды: на живой SQLite и на TCVDB-заглушке, воспроизводящей записанные ответы реального бэкенда (фикстуры обновляются отдельной ручной задачей против живого TCVDB). Список деградаций — данные теста: заявленная деградация без строки в списке роняет тест, строка без реальной деградации — тоже. Живой TCVDB в CI не требуется; если фикстуры устарели относительно версии клиента, тест падает, а не скипается | **нарушен**: consolidation и apply читают прямым SQL |
| `inspectable-run` | обязательный набор артефактов + retention | `[f]` после прогона существуют `run.json`, `input/workset.json`, `out/result.json`, `out/critic.json`, лог сессии; удаляются не раньше retention | **нарушен**: `--no-session` и удаление scratch |
| `nogo-secrets` | в env ребёнка нет секретов | `[t]` env ребёнка сверяется с whitelist; ни одно значение не совпадает с содержимым `auth.json` и loopback-токена | выполняется (узко: только env) |
| `session-state-isolated` (tz-10) | offload state/result принадлежит ровно одной `{sessionKey, sessionId}` | `[t]` две параллельные сессии с маркерами A/B не видят чужих O1/O1.5/O2/O3/O4 state/artifacts/results | **нарушен**: scheduler выбирает `lastActiveMgr`, O4 pending result process-wide |
| `context-envelope-complete` (tz-10) | каждый фрагмент context имеет identity, scope, provenance, score reason и token cost | `[t]` любой rendered fragment трассируется к структурированному item; text-only fragment роняет тест | **нарушен**: recall повторно парсит строки и восстанавливает `score: 0` |
| `context-budget-enforced` (tz-10) | сборка детерминирована и не съедает user reserve | `[t]` permutation даёт те же ids/reasons; tokenizer/version и render overhead пиннуты, tokenize rendered context равен `used` | нет единого assembler contract |
| `project-recall-measurable` (tz-10) | project positives и foreign negatives имеют item-level диагностику | `[t]` corpus считает foreign-project leakage по id/scope/raw+final score | probe не передаёт projectId |
| `single-consume-o4` (tz-10) | O4-result потребляется один раз только владельцем | `[t]` параллельная и следующая сборка не видят уже потреблённый/чужой result | process-wide pending result |
| `counters-match-store` (tz-03) | счётчики слоёв равны факту в сторе, а не накопленной дельте | `[t]` после apply, `LocalMemoryCleaner` и прямого SQL-пути счётчик каждого слоя совпадает с `COUNT(*)` по соответствующей таблице; расхождение — падение, а не warning | **нарушен**: `l0Count` накапливается через `+=` (`queries.ts:82`), мутации мимо `MemoryCommitObserver` не учитываются |
| `scope-filter-enforced` (tz-05) | scope — атрибут записи, а не текстовый матч | `[t]` recall с `scope=project` не возвращает записи другого проекта при совпадающем тексте; запись без scope не «просачивается» как global | частично: сравнение уже атрибутное (`scope.ts:29-38`, `sqlite.ts:929`), но `scope !== "project"` пропускается как global, а боевой конфиг стоит в `crossProject: decay` (`tdai-gateway.yaml:43`), где фильтр отключён целиком |
| `no-pi-path-hardcode` (tz-07) | корни путей резолвятся из конфига, не из `~/.pi` | `[a]` вне `launchers/` и тестов нет литералов `~/.pi`, `.pi/agent`, `pi-auditor-sessions`; `[t]` смена `TDAI_HOME` уводит sessions/scratch/auth-root целиком | **нарушен**: pi-пути зашиты в общий код |
| `nogo-l0-path` + `consumer-parity` (tz-08) | `note` вливается в существующий capture-путь; обёртка одинакова на всех хостах | `[t]` `POST /memory/note` не создаёт второй путь записи L0 (`memory-tools.ts:99`); `[t]` contract-тест обёртки: один запрос → идентичный ответ под pi, Claude Code и Codex | частично: инвариант соблюдён в коде, обёртка существует только для pi |

Три формулировки требуют отдельной дисциплины, иначе проверка вырождается: «писатель один» — это взаимное исключение по ключу ресурса, а не свойство идентичности (тест обязан гонять два процесса, а не один); «прогон читаем» — конкретный список файлов и срок хранения, проверяемый на диске; `backend-parity` без перечня деградаций позволяет формально «объявить недоступным» что угодно — поэтому список деградаций живёт в самом тесте.

## 6. Что не делаем

- `MemoryClient` — дубль `IMemoryStore`.
- SQL-триггеры / SQL-view для счётчиков — ломают `tcvdb`.
- Универсальный EventBus и каталог из 5 lifecycle-хуков — нет подписчиков; вместо них узкий `MemoryCommitObserver` (§4.5).
- Переезд в `src/agents/` — косметика, вне фаз.
- Совместимость с ABI pi-расширений — иначе пакет снова становится pi-специфичным. Общими должны быть манифест и role API; pi — один из launcher-биндингов.

## 7. Сведение пакетов

| Пакет | Компонент этой модели |
|---|---|
| tz-01 | RoleExtension + Dispatcher + `contract-drives-execution` (включая caps-гейт и per-role `lastRunAt`) |
| tz-02 | `single-scene-writer` (keeper → `rewriteBlock` → `/memory/apply`) + scratch-bundle из §3.5 |
| tz-03 | счётчики слоёв через `IMemoryStore` + `MemoryCommitObserver` (§4.5), без EventBus |
| tz-04 | recall: probe-baseline → скоринг поверх существующих `scope-decay` / type-weights. **Единственный пакет без инварианта** — качество recall не выражается булевым свойством, его приёмка идёт по метрике `precision@5/@10` против снятого baseline (§9). Искать для него строку в §5 не нужно |
| tz-05 | scopes и provenance поверх `l1_records`; носитель для durable M2/M3 (code: L2/L3) задаётся явно |
| tz-06 (**новый**) | RoleLauncher: pi → claude → codex, форма аргументов и сессии ролей |
| tz-07 (**новый**) | host-neutral корни: `TDAI_HOME`, sessions-root, auth-root |
| tz-08 (**новый**) | контракт потребителя памяти (§3.6): хост-нейтральная обёртка над `/memory/search` и `/memory/note` для pi / Claude Code / Codex — владелец требования D1 и «память универсальна» |
| tz-09 (**новый**) | протокол прогона и безопасность apply: `RoleRun` / `LaunchAttempt` / `CriticAttempt`, claim + lease + fence (§3.1), стадия критика с fail-closed (§4.3), журнал операций и partial apply (§4.4). Владелец одиннадцати инвариантов §5 |
| tz-10 (**новый**) | session isolation short-term offload + `ContextEnvelope`/assembler + project-aware item diagnostics; safety-track против смешивания контекста |

Все десять пакетов лежат в `docs/specs/tz/` (плюс `README.md` с трассируемостью и сквозной приёмкой). Разделение tz-06 / tz-08 не косметическое: launcher и потребитель — независимые границы (§3.6), у них разные тесты и разный порядок в §8 (launcher до cutover, потребитель после). tz-10 ортогонален generic role cutover, но не recall-порядку: session isolation и tz-10a diagnostics/corpus идут сразу, затем tz-04 baseline, затем tz-10b assembler/scoring cutover. До tz-05 используется versioned projection с explicit unknown provenance; tz-05 обогащает её native lineage.

C4 драфта (фидбек-петля: события recall ↔ `/memory/feedback`) остаётся в tz-04 отдельным требованием — не выкидывается в roadmap: `/memory/feedback` уже существует (`src/gateway/feedback.ts`), не хватает только связи с recall-событиями.

## 8. Порядок миграции

**Первая невозвратная точка — первый боевой generic-apply**, а не живой `dedup-daily`: он уже может выполнить merge/delete/rewrite или оставить частичное применение, и откат feature-флага этих мутаций не вернёт. Поэтому всё, что делает apply безопасным, идёт ДО cutover, а не после. `dedup-daily` — первая намеренно вводимая деструктивная роль, но не первая необратимость.

Параллельно с шагами 1–10 идёт safety-track: tz-10 session isolation → tz-10a structured diagnostics/project corpus → tz-04 baseline → tz-10b assembler/scoring cutover. Session isolation не зависит от generic apply и закрывается до сквозной проверки памяти E2. До tz-05 envelope использует versioned projection (`null`/`unknown`, не fake-global); tz-05 добавляет native scope/provenance без смены assembler API.

1. **Characterization-тесты** текущего поведения: fresh-tail single-batch и bounded full-store chunked раздельно (включая факт, что за `NIGHT_SWEEP_LIMIT` данные не обходятся). Без нового scheduler, без изменений apply.
2. **Версионирование**: `manifestVersion`, `engine.roleApi`, схемы результата и вердикта; legacy-адаптер `role.json → synthetic extension` (для `prompt_file` — сначала указанный файл, затем текущий legacy/bare-fallback с warning — `role-loader.ts:66-73`).
3. **Persisted Run/Attempt + durable payload store** (§3.1, §4.1): репозиторий, state machine с `applying`, контент-адресуемое хранилище для Assignment/workset, кандидата, вердикта и журнала.
4. **Ранний `PiLauncher`**: выделить pi-спавн из общего кода (`runner-helpers.ts:63`, `keeper-run.ts:27`, `role-spawn-args.ts`), задать namespace сессий (attempt-специфичный, без `--no-session`) и security-профиль ребёнка. До первого generic-запуска — иначе generic runner закрепит pi-флаги.

   Критерий выхода по изоляции (без него шаг не закрыт и cutover не разрешён): выбран и зафиксирован конкретный механизм — отдельный uid, контейнер или mount namespace; проверено тестом, что ребёнок не читает `~/.pi/agent/auth.json` вне выданного ему профиля и не пишет в `dataDir` мимо gateway; env-whitelist (`child-spawn.ts:62-79`) сведён с этим механизмом, а не заменяет его. Пока критерий не выполнен, generic V2 принимает только declarative packages; текущие executable роли продолжают работать исключительно через изолированный feature-флагом `LegacyRoleAdapter` и не считаются частью generic cutover.

    Что это стоит сегодня: в каталогах ролей действительно лежат `prompt.md` и `role.json`, но контракты ссылаются на внешние `runtime.extension_path` / `runtime.skill_path`, а pi-launcher реально загружает их через `--extension` / `--skill` (`role-spawn-args.ts:22-33`). Поэтому выключить executable wiring без остановки текущего task-cycle нельзя. До прохождения изоляции и parity-shadow живой путь остаётся под `LegacyRoleAdapter`; generic-путь работает только в shadow и не получает apply-authority. Новые executable-пакеты до закрытия гейта запрещены.
5. **Dual-layout bundle** (§3.5): `input/workset.json` + `out/result.json` + `out/critic.json` с дайджестами, дубль входа в `diff.json`, fallback-чтение.
6. **Версионированные пакеты ролей и критиков**: keeper+critic как v1 (с in-session критиком, legacy-путь) и v2 (generic core запускает отдельный `CriticAttempt`). Для каждого `critic_role` до shadow обязательны package, instance binding, output schema и negative-verdict smoke. Один скилл не обслужит оба пути: иначе старый останется без критика либо новый получит двойного.
7. **Shadow-прогон generic-пути**: кандидат собирается и проверяется, apply не выполняется. Сравнение workset/prompt/tools/кандидата со старым путём.
8. **Apply-контракт и гейты, всё ещё без cutover**: в payload добавляются `runId` и `candidateDigest` (`apply-executor/types.ts:47-58` сегодня не содержит даже `runId`), политика и кандидат берутся **из серверного Run-репозитория по `runId`**, а не из HTTP-payload. Включаются: критик-стадия ядра, `assertOpsSubset` и caps, `candidate-bound-to-input`, attempt-claim и apply-claim с fencing, журнал по `operationId`, reconciliation, store-wide сериализация apply (`single-apply-per-store`) и разведение конфликтующих ресурсов (scene-файлы по проектам). Сначала shadow, затем fail-closed. Это полный tz-09; только после него начинается tz-03a.

9. **Checkpoint-протокол (tz-03a), после полного apply-протокола и до cutover.** Сегодня checkpoint не идемпотентен и не привязан к полноте применения: night вызывает `advanceCheckpoint` при `anyApplied`, даже если поздний батч упал (`night-runner.ts:86-93`, `night-batches.ts:81-89`), а `d.l0Count += newL0` в `advanceCheckpoint` (`consolidation/queries.ts:82`) — накопительное сложение, так что повтор прогона после краша удваивает счётчик. Требуется: финализация checkpoint по `runId` (повторная финализация того же Run — no-op), продвижение курсора только после того, как **все** операции кандидата в состоянии `verified`, и жёсткий запрет продвижения при Run в `applying`/`needs-reconciliation`.

   **Счётчики — recompute из стора, а не `prevSnapshot + delta`.** Замена `+=` на присваивание сама по себе гонку не убирает: `l0Count` глобален (`consolidation/checkpoint.ts:48`), тогда как per-role состояние живёт в `roles` (`:26-50`), а day- и night-роль идут параллельно (single-flight — per role, `role-gate.ts:25`). Два Run, каждый записавший «свой снапшот + свою дельту», затрут инкремент друг друга. Значение обязано читаться фактом на момент финализации, а не выводиться из предыдущего значения checkpoint. Альтернатива, если ground-truth-счёт окажется дорогим, — перевести `l0Count` в per-role, где владелец записи один; глобальный счётчик с расчётом от снапшота не допускается ни в каком виде.

   Счёт берётся **по зафиксированному курсору, а не по всему стору** — предикат обязателен, безусловный `tableRowCount("l0_conversations")` (`src/core/store/sqlite.ts:614`, там он служит другой цели — bootstrap embedding-меты) воспроизведёт тот же баг в новой форме. По контракту `l0Count` — «cumulative L0 messages processed at the last run» (`consolidation/checkpoint.ts:11`), то есть величина **относительно `l0Cursor`**, а не размер таблицы. Для night они расходятся системно: срез ограничен `NIGHT_SWEEP_LIMIT`, а при skip-merge в первом чанке anchor равен предыдущему курсору и курсор не двигается вовсе (`night-runner.ts:86-93`).

   Формула: `COUNT(*) FROM l0_conversations WHERE recorded_at != '' AND recorded_at <= <курсор, записываемый этой же финализацией>` (то есть `anchoredCursor ?? prevCursor`), вычисленная в той же операции, что пишет курсор. Она self-consistent по построению: курсор не сдвинулся — счётчик не изменился; прогон применился частично — счётчик отражает ровно применённую часть.

   **И тот же guard нужен самому курсору — сегодня он сравнивается со снапшотом.** `advanceCheckpoint` принимает `prevCursor` аргументом и проверяет `if (cursor && cursor >= prevCursor)` (`consolidation/queries.ts:69-82`), но `prevCursor` — это `cp.l0Cursor`, прочитанный в **начале** прогона (`day-runner.ts:45,96`, `night-runner.ts:45,92`), тогда как `d` внутри `checkpoint.update` — живое значение. Курсор из-за этого немонотонен:

   1. day и night стартуют, оба читают `l0Cursor = P0` (роли разные — single-flight их не разводит, `role-gate.ts:25`);
   2. day финиширует первым, пишет `D1 ≥ P0`;
   3. night заканчивает долгий sweep, его `anchoredCursor = A` посчитан относительно `P0` и вполне может быть `< D1` (bounded-срез, а при skip-merge в первом чанке anchor вообще равен предыдущему курсору);
   4. guard `A >= P0` проходит — курсор откатывается `D1 → A`;
   5. следующий day переобрабатывает уже пройденный диапазон `(A, D1]`.

   Recompute-формула сама по себе от этого не спасает — она честно пересчитает count по откатившемуся курсору, поэтому двойного учёта не даст, но `l0Cursor` перестанет быть монотонным «докуда дошли», а это его единственная функция. Требование: guard сравнивает с **живым** значением внутри той же locked-операции (`update((d) => { if (cursor >= d.l0Cursor) d.l0Cursor = cursor; … })`), а не с переданным снапшотом. Альтернатива — та же, что для счётчика: перевести `l0Cursor` в per-role, где владелец записи один. Реализация «по образцу существующего `advanceCheckpoint`» без этой оговорки воспроизведёт откат один в один.
10. **Batching-dispatch**: стратегии day/night становятся именованными policy ядра, выбор по `batching.strategy` вместо сравнения имени (`orchestrator.ts:143`).
11. **Cutover одной роли** по feature-флагу — первый боевой generic-apply. Только теперь: гейты fail-closed, apply сериализован, семантика батчей выбирается контрактом, а не хардкодом.
12. **Упаковка остальных ролей**, каждая через shadow → cutover.
13. **Сведение записей под общий commit-boundary** (`MemoryCommitObserver`, §4.5): прямой SQL (`consolidation/queries.ts:29`, `diff-builder.ts:110`, `apply-executor/apply-helpers.ts:49`), scene-файлы, `LocalMemoryCleaner` и profile-sync — иначе наблюдатель не увидит часть мутаций и счётчики разъедутся.

    **Принятый риск шагов 11–12** (называется явно, а не замалчивается): `LocalMemoryCleaner` до этого шага работает по своему расписанию мимо apply-claim и fence. Удалит запись, на которую нацелен `merge`/`rewriteRecord` уже боевого generic-apply — postcondition не сойдётся и Run уйдёт в ложный `needs-reconciliation`. Данные при этом не теряются (обе операции идемпотентны, cleaner удаляет по retention, а не по кандидату), цена — ручная реконсилиация. Риск существует и сегодня; на время окна между cutover и этим шагом cleaner-расписание разводится по времени с ролями, а не оставляется на удачу.
14. **Registry-driven scheduler** по `trigger`/`schedule`/`threshold` + per-role `lastRunAt`.
15. **`dedup-daily`**: dry-run с parity-сверкой, затем отдельным решением — живое расписание (full-store, `delete_per_run: 100`).
16. **Claude Code / Codex launchers** после contract-тестов launcher'а; следом — хост-нейтральная обёртка потребителя памяти (§3.6, tz-08): она независима от launcher'ов и не блокирует их.
17. Релиз с warning и телеметрией использования legacy, затем удаление старого формата и name-based dispatch.

## 9. Метрики

Числа «сейчас» — из дашборда `~/.pi/agent-memory/tdai/memory_health.md` (прогон 2026-08-09T22:17:49.860Z) и с диска, а не из аудита в драфте: тот устарел. Дашборд перезаписывается после каждой консолидации, поэтому цифры дубликатов волатильны — перед использованием перечитать файл, а не эту таблицу.

| Что | Сейчас | Цель |
|---|---|---|
| роли, запускающиеся по своему контракту | **0 из 3**: порог и расписание берутся из `config.memory.nightRun.*` (`server.ts:181-188`), выбор роли — по хардкоду имени | 3 из 3, плюс критики как роли |
| duplicate-clusters M1 (code:L1) | 84 кластера / 216 участника (было 91/234 в драфте) | измерить после первого прогона `dedup-daily` |
| M2 scene-блоки (code:L2) | **31 файл**, не 0 — сцены пишутся keeper'ом через apply; тезис драфта «L2 отключена» устарел | растут по проектам, `_global` разъезжается по проектным слагам |
| параметры роли, доезжающие до исполнения | 0 из 5 (`prompt_file`, `tools_subset`, `model`, `thinking`, `critic_role`) | 5 из 5 |
| apply без caps-гейта роли | да | нет |
| recall precision@5 / @10 | не измеряется (probe-корпуса нет) | baseline снят до правки скоринга, дальше — рост против него |
| роли, отработавшие под ≥2 launcher'ами | 0 | 2 |

## 10. Открытые вопросы

- Уровень изоляции executable-entry: отдельного процесса под тем же UID **недостаточно** (§3.3) — открытый вопрос в том, что именно берём: отдельный uid, контейнер или mount/network namespace.
- `/memory/info` отдаёт `dataDir` и `tokenPath` (`info.ts:16-25`) — нужен ли роли отдельный read-профиль без него.
- Где хранить сессии ролей: под `TDAI_HOME` или отдельным корнем, как `~/pi-auditor-sessions` у аудитора.
