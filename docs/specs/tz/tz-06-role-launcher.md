# TZ-06: RoleLauncher — исполнение роли под сменным хостом (Phase 6)

> Источник: производный пакет, [agent-architecture.md](../agent-architecture.md) §3.6 (граница host-agnostic), §5 (`no-host-hardcode`), §8 шаги 4 и 16
> Факт-чек кода: 2026-08-10

## Контекст

Роль сегодня исполняется исключительно pi-спавном, и это зашито не в одном месте:

- форма аргументов — `keeper-run.ts:27-40`: `[...spawnFlags, ...extraArgs, "--model", …, "--thinking", …, "--system-prompt", …, taskPrompt]`, бинарь `opts.piBinary`;
- pi-специфичные флаги собираются в общем коде — `role-spawn-args.ts:24-32` (`--no-extensions`, `--extension`, `--skill`);
- дефолт `spawnFlags` в `src/config.ts:733-737` (`-p`, `--no-context-files`, `--no-session`) — сам по себе pi-хардкод;
- `piBinary` и `spawnFlags` **уже конфигурируемы** (`src/config.ts:732-737`), поэтому проблема не в имени бинаря, а в **форме команды**: смена значения не даст рабочего вызова Claude Code или Codex.

Ориентир организации — pi-аудитор (`~/.pi/agent/extensions/auditors.ts`): generic-раннер ролей со своим корнем сессий (`:72`), спавном (`:840-856`) и явным отказом от `--no-session` (`:825-828`).

## Цель

Свести всё хост-специфичное к одной точке подстановки, чтобы роль исполнялась под pi, Claude Code и Codex без правок ядра.

## Ожидаемый результат

- Интерфейс `RoleLauncher` с реализациями `pi`, `claude`, `codex`.
- Ядро не знает ни имени бинаря, ни формы аргументов, ни способа доставки промпта.
- Одна и та же роль отрабатывает как минимум под двумя launcher'ами.
- Terminal result появляется только после закрытия процесса и reap потомков; timeout/cancel не оставляют поздний writer.

## Контракт порта

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

`LaunchInput` содержит preallocated `attemptId/sessionRef`, attempt snapshot, materialized bundle, resolved binding и capability-set. Он не содержит gateway config целиком. Expected start failures (`ENOENT`, `EACCES`, host/capability/isolation mismatch) возвращаются как typed `LaunchError`; `launch()` не reject'ит ими. Unexpected throw ловится на service boundary, получает `errorClass=internal-launcher` и фиксируется в том же Attempt. stdout/stderr имеют фиксированный in-memory cap и дальше spool'ятся в attempt artifacts. `completion` и `cancelAndWait` сходятся к одному terminal result и завершаются только после `close`, не по событию `exit` и не сразу после отправки сигнала. Любой status кроме `succeeded`, а также ненулевой exit code, запрещает parse/apply.

## Scope

**Входит:**

- `RoleLauncher`: подготовка команды, доставка system- и task-промпта, регистрация тулов и skills, auth-discovery, преобразование вывода в единый результат, lifecycle (kill, timeout).
- Перенос pi-специфики из `keeper-run.ts:27-40`, `role-spawn-args.ts:24-32`, `runner-helpers.ts:63`, `prompt-builder.ts` в `launchers/pi.ts`.
- Сессии ролей: `--no-session` **не ставится**; каждая попытка получает собственную сессию (§3.5 модели), прогон остаётся инспектируемым.
- Security-профиль ребёнка с явным критерием выхода (см. ниже).

**Не входит:**

- Корни путей и auth-root — tz-07 (ортогонально, свои критерии).
- Обёртка потребителя памяти — tz-08.
- Смена launcher/провайдера/модели роли: они фиксированы instance `ExecutionBinding` (tz-01 B5); launcher их исполняет, а не выбирает.

**Инварианты пакета:**

| Инвариант | Проверка |
|---|---|
| `no-host-hardcode` | `[a]` вне `launchers/` и тестов нет имени бинаря и pi-флагов: `--session-dir`, `--thinking`, `--system-prompt`, `--no-context-files`, `--no-session`, `--no-extensions`, `--extension`, `--skill`, `--no-skills`, `-p`. `src/config.ts` **не исключение** — дефолт `spawnFlags` уезжает в launcher |
| `session-per-attempt` | `[f]` у двух попыток одного Run разные `hostSessionRef` и непересекающиеся каталоги; в транскрипте второй нет сообщений первой (по id) |
| `least-privilege-child` | `[t]` негативный: чтение чужого auth-файла, запись вне scratch, исходящее соединение — все три падают |

## Зависимости

Предшественник — tz-01 (нужен резолвнутый контракт с binding). С tz-07 независим: тот про корни путей, этот про форму запуска. Идёт **до** cutover (§8 шаг 4), иначе generic-раннер закрепит pi-флаги.

## Требования (функциональные)

- **L1**: `RoleLauncher` — единственное место, где известны бинарь и флаги хоста.
- **L2**: launcher задаётся в обязательном instance `ExecutionBinding`, а не в portable-контракте роли. Pi-специфичные legacy-ключи `runtime` (`extension_path`, `skill_path`) адаптирует единый `LegacyRoleAdapter` (tz-01); pi-launcher получает уже resolved assets. V2 package не содержит host-флагов и путей.
- **L3**: `--no-session` убирается из дефолта; сессия — на попытку. Обоснование: «`--no-session` made the child ephemeral and verdict failures opaque» (`auditors.ts:825-828`).
- **L4**: `tools_subset` роли отображается на инструменты конкретного хоста; сегодня тулы копируются каталогом целиком (`keeper-tools.ts:55`).
- **L5**: хост, не поддерживающий обязательную capability роли, отклоняется как `host-incompatible`. Молча выкинуть критика или тул нельзя.
- **L6 (критерий выхода по изоляции)**: выбран и зафиксирован конкретный механизм — отдельный uid, контейнер или mount namespace; проверен негативным тестом. Пока не выполнен, generic V2 принимает только declarative packages. Текущие executable роли остаются на старом пути через `LegacyRoleAdapter`; это совместимость, не разрешение generic packaged tools.
- **L7**: lifecycle contract обязателен для каждого launcher'а: bounded/spooled output; nonzero exit → `failed`; timeout/cancel → kill дерева процессов + wait for close/reap; повторный cancel идемпотентен; `sessionRef` известен до успешного завершения и сохраняется даже при сбое.

## Критерии приёмки

1. `[a]` `grep -rnE 'piBinary|--no-context-files|--no-session|--extension|--skill|--session-dir|--thinking|--system-prompt' src/ --include='*.ts' | grep -vE '^src/gateway/consolidation/launchers/|\.test\.ts'` → 0.
2. `[t]` Instance `ExecutionBinding` с `launcherId: "claude"` даёт аргументы claude-launcher'а и ни одного pi-флага; portable package идентичен pi-варианту.
3. `[t]` Smoke: одна и та же роль отрабатывает под двумя launcher'ами, результат парсится одинаково.
4. `[f]` После прогона сессия роли существует и читается; у двух попыток одного Run сессии разные.
5. `[t]` Роль, требующая недоступной на хосте capability, отклоняется с `host-incompatible`, а не запускается урезанной.
6. `[t]` Негативный набор по изоляции проходит (чтение auth, запись вне scratch, сеть).
7. `[t]` Ребёнок пишет после SIGTERM и держит потомка: timeout не возвращает terminal result до reap; поздний `out/result.json` не принимается.
8. `[t]` Бесконечный stdout/stderr не увеличивает память gateway сверх заданного cap; полный вывод доступен по artifact refs.
9. `[t]` Ненулевой exit code с формально валидным `out/result.json` не доходит до parse/apply.
10. `[t]` `ENOENT`, `EACCES`, host-incompatible и isolation-unavailable возвращаются как соответствующий `LaunchError`, сохраняются в preallocated Attempt и не reject'ят service promise.

## План

1. Выделить `RoleLauncher` и перенести pi-спавн в `launchers/pi.ts`.
1a. Зафиксировать `Result<RunningHandle, LaunchError>`, preallocated attempt/session refs, bounded output и kill-and-wait contract-тестом до второго launcher'а.
2. Убрать `--no-session`, ввести сессию на попытку.
3. Отобразить `tools_subset` на тулы хоста.
4. Зафиксировать механизм изоляции и негативные тесты (L6).
5. Реализовать claude-launcher, прогнать smoke.
6. Codex-launcher — тем же контрактным тестом.

## Самостоятельная проверка (не тестами исполнителя)

**S1. Роль отработала под чужим хостом.**
Запустить одну и ту же роль под pi и под вторым launcher'ом.
→ Обе выдали кандидата, оба разобраны одинаково.
Это и есть смысл пакета: пока роль не отработала под вторым хостом, абстракция не доказана — она только описана.
Фальсификация: убрать pi-бинарь из `PATH` и запустить тот же package с instance binding второго launcher'а. Он обязан отработать. Если падает — где-то остался вызов pi вне binding/launcher.

**S2. Сессия существует и читается.**
После прогона открыть сессию роли.
→ Видно, что модель получила на вход и что ответила; при провале вердикта причина видна в сессии, а не только в логе.
Сегодня `--no-session` делает прогон эфемерным (`auditors.ts:825-828` — ровно эта причина), поэтому до правки смотреть нечего.

**S3. Попытки не склеились.**
Заставить роль сделать вторую попытку (например уронив первую).
→ Две разные сессии; во второй нет сообщений первой. Проверять по идентификаторам сообщений, а не по объёму: похожий размер ничего не доказывает.
Фальсификация: намеренно указать двум попыткам один каталог сессии — проверка обязана упасть. Если она проходит и в этом случае, она сравнивает не то (например только имена каталогов, а не содержимое).

**S4. pi-специфика не осталась в ядре — проверяется запуском, не грепом.**
Подменить pi-launcher заглушкой, которая падает при вызове, и запустить роль с `ExecutionBinding.launcherId = "claude"`.
→ Заглушка не вызвана ни разу; роль отработала.
Грепа здесь недостаточно: он проходит и на закомментированном коде, и на строке, собранной из частей. Дополнительно — снять фактическую командную строку дочернего процесса (`/proc/<pid>/cmdline` или лог спавна) и убедиться, что в ней нет pi-флагов и нет значений из дефолта `spawnFlags`.
Фальсификация: вернуть instance binding `launcherId = "pi"` — заглушка обязана быть вызвана и вернуть typed launch failure.

**S5. Несовместимость объявляется, а не обходится.**
Дать роли требование, которого на выбранном хосте нет.
→ Явный отказ `host-incompatible`. Молчаливый запуск с урезанным набором тулов — худший исход, чем отказ, потому что роль отработает неправильно и никто не заметит.
Фальсификация: убрать это требование из контракта роли — она обязана запуститься. Если отказ остался, матрица capability отвергает не то, что заявлено.

**S6. Ребёнок ограничен.**
Из процесса роли попробовать: прочитать чужой auth-файл, записать файл вне scratch, открыть исходящее соединение.
→ Все три попытки неуспешны. Пока этот пункт не пройден, executable-роли не включаются (L6).
Фальсификация обязательна, иначе проверка ничего не стоит: те же три действия выполнить **вне** изоляции, из обычного процесса того же пользователя — все три обязаны пройти. Если и там не проходят, падение внутри изоляции вызвано чем-то посторонним (нет сети на машине, нет файла), а не ограничением.

## Нефункциональные

- Контрактный тест launcher'а не требует живого провайдера: команда проверяется по форме, а не по ответу модели.
- Kill попытки завершает и потомков; висящих процессов после timeout не остаётся.

## Риски

- **R1 (high)**: снятие `--no-session` меняет поведение боевого keeper'а — сессии начинают накапливаться. Retention принадлежит tz-07 (H5), поэтому здесь это **связь, а не независимость**: снятие флага не выкатывается раньше, чем закрыт H5. Пакеты остаются независимыми по коду, но упорядочены по выкатке.
- **R2 (medium)**: claude/codex могут не иметь эквивалента какому-то pi-флагу. План: это и есть `host-incompatible` — фиксируется в матрице capability, а не обходится молча.
- **R3 (medium)**: изоляция может потребовать инфраструктурного решения (контейнер). План: L6 — явный гейт; до его выполнения executable-роли не включаются.

## Risk tier

**Tier-2**, с **security**-элементом на L6: механизм изоляции требует отдельного ревью.

## Откат

- Launcher выбирается instance binding; откат — вернуть `ExecutionBinding.launcherId: "pi"`, не меняя package identity.
- `--no-session` **обратно не возвращается**: флаг снят по решению владельца, а `spawnFlags` уезжают из `src/config.ts` в launcher. Если сессии окажутся проблемой, лечение — retention (tz-07 H5), а не возврат флага.
- Пока не пройден L6, executable-entry выключен, поэтому откатывать нечего.

## Глоссарий

- **RoleLauncher** — точка подстановки хоста: бинарь, аргументы, доставка промпта, тулы, сессия, lifecycle.
- **host-incompatible** — явный отказ запускать роль на хосте без обязательной capability.
- **Capability-матрица** — соответствие требований роли возможностям хоста.
