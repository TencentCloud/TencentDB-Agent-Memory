# OpenCode Source Auto-Installation Task

This file is for the OpenCode model to read and execute. The user has already created and filled `MemoryCore/.env.opencode.local` according to `USER_GUIDE.md`. Perform the installation directly; do not hand commands back to the user.

## Safety boundary

- Run `git status --short` first. Record existing changes, but never clean, reset, overwrite, or commit them.
- Never display, copy, or ask the user to send `.env.opencode.local`, any key, or any credential value.
- Never call the unpublished `npx @tencentdb-agent-memory/opencode-adapter`, run `npm pack`, or generate a `.tgz`.
- Never terminate an unknown process or modify unrelated OpenCode plugins.
- The checked-in installation script is the only implementation source. Do not rewrite it as temporary PowerShell, and do not generate the Gateway YAML, PID file, or loader yourself.

## 1. Locate the repository

Locate the absolute repository root containing all three files and save it as `$repo`:

```text
MemoryCore/package.json
adapters/opencode/package.json
adapters/opencode/scripts/install-from-source.ps1
```

Confirm that the private configuration exists and is ignored by Git:

```powershell
Test-Path (Join-Path $repo 'MemoryCore\.env.opencode.local')
git -C $repo check-ignore --quiet --no-index -- MemoryCore/.env.opencode.local
if ($LASTEXITCODE -ne 0) { throw '.env.opencode.local is not ignored by Git' }
```

Report only that the file exists and is ignored. Never read or print its contents.

## 2. Run the single installation command

Run this in one Shell tool call:

```powershell
& (Join-Path $repo 'adapters\opencode\scripts\install-from-source.ps1') -RepoRoot $repo
```

Allow up to 15 minutes for a first-time dependency install, Gateway launch, and adapter checks. The script itself:

1. silently parses and validates `.env`;
2. generates a private Gateway runtime config without real key values;
3. records a PID only after confirming that the process owns the target port;
4. runs adapter typecheck, tests, and build;
5. creates a source loader under `XDG_CONFIG_HOME` when set, otherwise under the user's global OpenCode configuration;
6. returns a key-free JSON result.

If the script fails, report its redacted error and stop. Never bypass a failed step, start the Gateway repeatedly, or claim success after a manual repair. After changing the guide or script, rerun acceptance from a clean isolated directory.

## 3. Post-install verification

Continue only when the script exits with code `0` and its JSON has `installed: true`:

```powershell
$endpoint = 'http://127.0.0.1:<port returned by the script>'
Invoke-RestMethod "$endpoint/health" -TimeoutSec 5
git -C $repo status --short
```

Confirm every item:

- `/health` returns HTTP 200. A `degraded` status is expected without Embedding and does not mean that the request timed out.
- The JSON Gateway PID currently owns the target port.
- Data files exist only under the returned `dataDir`.
- The loader directly imports this repository's `adapters/opencode/dist/index.js`.
- The private OpenCode JSON contains no `TDAI_LLM_*`, `TDAI_EMBEDDING_*`, or model key.
- `.env.opencode.local`, `.opencode-runtime`, and the isolated data directory remain outside Git.
- No pre-existing user change was deleted or overwritten.

## 4. Delivery

Report the returned endpoint, health status, loader path, and whether L0, L1, Embedding, and Skill are enabled. Never output a key. Ask the user to fully quit and reopen OpenCode, then send:

```text
Call the tdai_memory_status tool. Do not explain the name, do not use Shell, and return only the tool result.
```

## Completion criteria

- The installation script exits with code `0`, and all adapter checks pass.
- Gateway health is reachable, and its recorded PID owns the configured port.
- The OpenCode source loader and private plugin config are generated without an npm release package or `.tgz`.
- No key enters chat, command arguments, logs, OpenCode configuration, or Git-tracked files.
- No user change, unrelated plugin, or unknown process is overwritten.
