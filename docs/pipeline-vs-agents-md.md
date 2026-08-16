# Пайплайн памяти vs AGENTS.md — расхождения

**Дата:** 2026-08-15
**Метод:** чтение кода TDAI (`src/`), живых ролей (`~/.pi/agent-memory/tdai/`),
скиллов и субагентов pi (`~/.pi/agent/`), плюс разбор реальных прогонов из
`~/.pi/agent-memory/tdai/logs/`.

Ниже — только то, что расходится с AGENTS.md либо просто не работает.
Каждый пункт подтверждён файлом/строкой или выводом прогона.

---

## 0. Итог одной строкой

Пайплайн **не консолидирует память вообще**. Три из трёх keeper-ролей в
последних прогонах дали ноль применённых операций: `memory-keeper` запускается
с пустым системным промптом, `night-keeper` роняет apply на `rewritePersona:
null`, критик не спавнится ни у одной роли — потому что субагент ему недоступен
физически.

---

## 1. Роль запускается без промпта (блокирующее)

`~/.pi/agent-memory/tdai/roles/memory-keeper/prompt.md` — **6 байт**, содержимое
буквально `prompt`.

Проверка на живом прогоне (`80139f18`, 2026-08-14 16:39):

```console
$ head -3 ~/.pi/agent-memory/tdai-memory-keeper/80139f18-*/memory-keeper-prompt.md
prompt

## Текущий дифф (что разгрести)
```

Системный промпт роли = слово `prompt` + дифф. Все критерии роли (лимиты, META,
подтверждение дублей, only-GET) до модели не доезжают. `out/` по итогу пуст.

Канонический промпт в репозитории есть — `src/core/prompts/memory-keeper.md`,
7372 байта. Но `scripts/sync-memory-skills.sh` кладёт его в
`$TDAI/memory-keeper/memory-keeper.md` — путь, который **никто не читает**:
исполнение берёт промпт через `resolveRolePrompt()`
(`src/gateway/consolidation/role-contract-prompt.ts:47`) из
`<roleDir>/<role>/prompt.md`. А `roles/memory-keeper/prompt.md` в том же скрипте
объявлен `GUARDED_FILES` («несёт операторские добавки, перезаписывать нельзя») —
охраняется огрызок.

## 2. Критик-субагент недоступен изнутри роли (блокирующее)

AGENTS.md: «Каждая роль работает через свой скилл с критиком… Keeper спавнит его
через `subagent` tool».

Фактически:

* Лаунчер pi ставит ребёнку `HOME: privateHome`
  (`src/gateway/consolidation/launchers/pi.ts:88`), где privateHome —
  `<attempt>/home`. В него копируется **только** `.pi/agent/auth.json`
  (`pi.ts:66`).
* pi ищет субагентов в `$PI_CODING_AGENT_DIR/agents` (дефолт `~/.pi/agent`), то
  есть внутри privateHome. Там пусто.
* Определения субагентов существуют и лежат в настоящем хоуме:
  `~/.pi/agent/agents/{memory-critic,night-critic,dedup-daily-critic}.md`.
  Ребёнок их не видит.

Итог: инструкция скилла «спавни критика memory-critic» невыполнима by design.

## 3. У memory-keeper нет скилла вовсе

`roles/memory-keeper/role.json` не содержит блока `runtime`, значит нет
`skill_path`. Скилл подаётся ребёнку только флагом `--skill`, который строится
из `contract.assets.skillPath`
(`src/gateway/consolidation/launchers/pi-policy.ts:41`). Нет пути — нет скилла.

`night-keeper` и `dedup-daily` свои `runtime.skill_path` имеют, но получают
**только собственный** скилл; `*-critic` SKILL.md не передаётся.

## 4. Расположение скиллов в AGENTS.md не соответствует архитектуре

AGENTS.md: «Keeper skills (`~/.pi/agent/skills/`)». Фактически скиллы ролей
лежат в `~/.pi/agent-memory/tdai/skills/` (туда их кладёт
`scripts/sync-memory-skills.sh`), а в `~/.pi/agent/skills/` их нет вовсе —
и быть не может: у ребёнка приватный HOME. Рабочий механизм — `runtime.skill_path`
в role.json, а не общий каталог.

## 5. Ночной прогон теряет весь батч на `rewritePersona: null`

Прогон `f947be67` (night-keeper, 2026-08-14 13:53 → 14:09):

```text
presented    : 362 записей
applied      : merges=0 deletes=0 rewrites=0
error        : Invalid apply request: ✖ Invalid input: expected string, received null
             → at diff.rewritePersona
state        : failed / invalid-role-output
```

16 минут работы модели, 362 записи — всё в мусор из-за одного `null` в
необязательной секции.

**Закрыто 2026-08-15.** Отказ стал ПООПЕРАЦИОННЫМ: `null` в необязательной
секции читается как «секции нет», негодная операция выбрасывается из диффа со
своей причиной в `ApplyResult.rejected` (и в отчёте прогона, и в логе на уровне
warn), остальные операции применяются. Отбраковано всё — прогон падает громко
(`aborted` / 400, `every operation in the diff was refused: …`), а не выглядит
пустым успехом. Отказ никогда не превращается в удаление: id, заявленный двумя
секциями сразу, отклоняет обе, а `deleteL1` на члена кластера отклонённой
`merge` уходит вместе с ней. На весь запрос теперь отказывают только два
случая, и оба говорят «контракт роли сломан целиком»: дифф не объект и секция
сверх своего капа по количеству операций.
Код: `src/gateway/apply-executor/salvage.ts` (форма) и `validate.ts` (семантика);
регрессии: `salvage.test.ts`, `blank-rewrite.test.ts`, `partial-apply.test.ts`.

Остаётся вне этой правки и ждёт своей задачи: `StaleDeleteError`
(`apply-ops-rewrite.ts:48`) по-прежнему прерывает весь батч — это срыв ПОСРЕДИ
мутаций с семантикой сверки (`partial` / `storeTouched`), а не отбраковка на
входе.

## 6. TDAI по-прежнему оркестрирует критика

AGENTS.md: «TDAI НЕ знает о критике… не спавнит критика, не парсит verdict, не
проверяет receipt».

Живой гейтвей (systemd `tdai-gateway.service`, код HEAD) на каждом прогоне пишет:

```text
[critic] SHADOW memory-keeper: critic "memory-critic" unusable: prompt
  "memory-critic.md" not found under .../roles and fail_on_missing_prompt is set
[memory/apply] candidate gate SHADOW (would refuse in enforce)
  run=...: run "..." is running, not reviewed by a critic
```

То есть TDAI резолвит критика как свою роль, требует его prompt.md в своём
roleDir и держит apply-гейт на «reviewed by a critic».

В рабочем дереве часть critic-кода уже удалена (`critic-bootstrap.ts`,
`critic-launch.ts`, `critic-stage.ts`), но:

* `src/gateway/apply-executor/run-policy.ts:83-94` всё ещё требует
  `state === "reviewed"` и непустой `criticReceipt` — писать их теперь **некому**,
  значит при `applyGateMode=enforce` apply откажет всегда;
* L1-ветка осталась на полпути и **не компилируется**:
  `l1-agent-dispatcher.ts:16` импортирует несуществующий `resolveL1RolePair`,
  `l1-dispatch-pair.ts:64` читает `input.critic`, которого уже нет в типе;
* `l1-dispatch-review.ts` (132 строки) — целиком critic-ревью внутри TDAI;
* `l1-role-installer.ts:7` хардкодит `["l1-extractor", "l1-extractor-critic"]`;
* схема БД хранит `criticReceipt` (`control-plane/db.ts:37`),
  `criticReceiptDigest`/`criticAttemptId` (`control-plane/l1-schema.ts:29-30`).

## 7. Критик как роль TDAI — сам по себе нарушение

AGENTS.md: «Критик — это pi subagent role». Фактически в TDAI живут роли-критики:
`roles/l1-extractor-critic/` в репозитории и `dedup-daily-critic` в живом
roleDir. Причём у `dedup-daily-critic` нет `role.json` вообще — только
`prompt.md`.

## 8. Модели расходятся с AGENTS.md

AGENTS.md: «Все роли используют `xiaomi-token-plan-sgp/mimo-v2.5`».

| Роль | model |
| --- | --- |
| memory-keeper, night-keeper, dedup-daily | `xiaomi-token-plan-sgp/mimo-v2.5` ✓ |
| l1-extractor, l1-extractor-critic | `opencode-go/deepseek-v4-flash` ✗ |

## 9. Мандат «роль-скилл-критик» не прописан ни в одном роль-промпте

AGENTS.md требует в конце системного промпта каждой роли: «работай через свой
скилл, спавни критика через subagent, проверь вердикт, финализируй diff.json
только при ok».

`grep -niE "скилл|skill|критик|critic"` по `roles/*/prompt.md` даёт только
упоминания «не открывай новых subagent-хэндлов после сводки» — то есть прямо
противоположный по смыслу текст. Мандата нет ни у одной роли.

## 10. Мелочи, которые шумят и врут

* `prompt_file` в role.json не совпадает с реальным именем файла у `night-keeper`
  (`night-keeper.md` vs `prompt.md`) и `dedup-daily` (`dedup-daily.md`) —
  срабатывает fallback с WARN на каждом прогоне.
* Финальная строка лога любого прогона помечена ролью `memory-keeper`:
  `[memory-keeper] run aborted (manual)` — в прогоне **night-keeper** (`f947be67`).
* AGENTS.md называет артефакт результата `diff.json`; реальный контракт —
  `out/result.json` (`diff.json` — снятое место входа).
* Роль-каталог засорён тестовыми ролями: `broken`, `fractional`, `huge`,
  `infinite`, `negative`, `no-budget`, `prompt-only`, `string`, `with-budget`,
  `zero`.

---

## Самостоятельный чек

```console
# 1. Промпт роли доезжает до ребёнка
head -1 ~/.pi/agent-memory/tdai-memory-keeper/*/memory-keeper-prompt.md
# ожидаемо: "# Роль: memory-keeper", а не "prompt"

# 2. Компиляция без critic-хвостов
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "src/gateway/(l1|apply-executor)/"
# ожидаемо: пусто

# 3. Прогон без critic-варнингов и с применением
npx tsx scripts/tdai-run-log.mts last
# ожидаемо: state=applied, applied != 0/0/0, ни одной строки [critic]
```
