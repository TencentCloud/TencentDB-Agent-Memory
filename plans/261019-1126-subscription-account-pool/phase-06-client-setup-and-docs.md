---
phase: 6
title: "Client setup script and docs"
status: completed
priority: P2
effort: "0.5d"
dependencies: [4, 5]
---

# Phase 6: Client setup script and docs

## Goal
Let users opt in to "keep my own login as fallback" from the setup script and document the
feature for admins and users.

## Files to Create / Modify
- Modify: `agents/setup-proxy.sh` — Claude Code: add a yes/no question "Keep your own Claude login
  as fallback?" (default no). Yes → write `ANTHROPIC_CUSTOM_HEADERS="x-tdai-user-key: <key>"` and
  remove `ANTHROPIC_AUTH_TOKEN` (writes at `:734`, `:756`); No → current behavior. Codex block
  (`:279-289`) per the phase 0 result. Keep `--quick` mode non-interactive (default no).
- Modify: `agents/skills/setup-proxy/` — same option.
- Modify: `agents/claude-code/README.md`, `agents/codex/README.md` — header layout, fallback note.
- Modify: `INSTALL.md` and `INSTALL_CN.md` — section "Subscription account pool (optional)":
  enable in Panel, add accounts, how rotation and reset work, risks (provider terms, undocumented
  endpoints), how to turn off. State that port 8420 must stay on a trusted network because the
  internal API returns Subscription Account tokens (accepted risk, decision 12), and that one Core
  process per instance runs the pool timers.
- Prepare (not commit to upstream from here): the sqlite restart-drop fix as a separate upstream
  PR branch, per decision 20.
- Modify: `deploy/global-images/.env.example` — `SUBSCRIPTION_POOL_ENABLED`,
  `SUBSCRIPTION_POOL_CHECK_INTERVAL_MIN` with comments.
- Modify: `CHANGELOG.md` — feature entry.

## Verification
- `bash -n agents/setup-proxy.sh` passes; run `agents/setup-proxy.sh --agent claude-code --quick`
  in a temp `HOME` and confirm the file content for both answers.
- Docs links resolve (`grep -o "](\./[^)]*)" INSTALL.md` targets exist).

## Risk / rollback
- Script default keeps the current config, so existing users are not affected.

## Scope after decision 33 (Codex only) — added 2026-10-19

- No Claude Code fallback question. The Codex block gets the yes/no question; yes writes the
  Codex provider with `requires_openai_auth = true` and `http_headers` carrying `x-tdai-user-key`.
- INSTALL: the pool supports ChatGPT (Codex) accounts only and says why Claude is not supported.

## Results (2026-10-19)

- `agents/setup-proxy.sh` and `agents/skills/setup-proxy/setup-proxy.sh`: Codex yes/no question
  (default no; not asked with `--quick` or `--non-interactive`) and flag `--codex-own-login`. Yes →
  `requires_openai_auth = true` and `http_headers = { "x-tdai-user-key" = "<key>" }` instead of
  `experimental_bearer_token`. Verified: `bash -n` passes; non-interactive runs in a temp `HOME`
  (fresh file, flag, patching an existing file) produce the expected provider block, and the TOML
  parses with Python `tomllib`.
- `agents/skills/setup-proxy/SKILL.md`, `agents/codex/README.md`: the fallback option.
- `INSTALL.md`, `INSTALL_CN.md`: section "Subscription account pool (Codex, off by default)" with
  risks, Codex-only reason, port 8420 on a trusted network, one Core process per instance, env vars,
  how to turn it off.
- `deploy/global-images/.env.example` and `start-memory-core.sh`: `SUBSCRIPTION_POOL_ENABLED`,
  `SUBSCRIPTION_POOL_CHECK_INTERVAL_MIN` are documented and passed into the Core container only
  when set.
- `CHANGELOG.md`: Unreleased entry.
- Upstream sqlite fix: no branch was created (no commit was asked for). The standalone patch is
  `reports/upstream-sqlite-restart-fix.patch` (adapter change + restart test). Proof: on a clean
  HEAD copy the restart test fails without the patch and passes with it; `git apply --check`
  passes on HEAD.
- The menu path named in INSTALL ("Organization → Subscription Pool") must match the Panel build.
