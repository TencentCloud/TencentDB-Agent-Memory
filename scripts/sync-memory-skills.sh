#!/usr/bin/env bash
# Sync memory-role skills + night-keeper role file from the repo canonical
# copies to their runtime locations. Single-source: repo is the canonical
# source; runtime copies must equal the repo (parity test enforces).
#
#   repo  src/core/prompts/skills/{memory-keeper,memory-critic,night-keeper,night-critic,dedup-daily,dedup-daily-critic}/SKILL.md
#     →   ~/.pi/agent-memory/tdai/skills/<name>/SKILL.md   (forked task-cycle per-role skills)
#   repo  src/core/prompts/night-keeper.md
#     →   ~/.pi/agent-memory/tdai/memory-keeper/night-keeper.md
#
# Idempotent; safe to re-run. Fails loudly on a missing source (never silently
# ships a stale runtime copy).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILLS_SRC="$REPO_ROOT/src/core/prompts/skills"
SKILLS_DST="$HOME/.pi/agent-memory/tdai/skills"
ROLE_SRC="$REPO_ROOT/src/core/prompts/night-keeper.md"
ROLE_DST_DIR="$HOME/.pi/agent-memory/tdai/memory-keeper"

SKILL_NAMES=(memory-keeper memory-critic night-keeper night-critic dedup-daily dedup-daily-critic)

fail() {
  echo "sync-memory-skills: $1" >&2
  exit 1
}

mkdir -p "$SKILLS_DST"
for name in "${SKILL_NAMES[@]}"; do
  src="$SKILLS_SRC/$name/SKILL.md"
  [ -f "$src" ] || fail "missing canonical skill: $src"
  mkdir -p "$SKILLS_DST/$name"
  cp "$src" "$SKILLS_DST/$name/SKILL.md"
  echo "synced ~/.pi/agent-memory/tdai/skills/$name/SKILL.md"
done

[ -f "$ROLE_SRC" ] || fail "missing canonical role file: $ROLE_SRC"
mkdir -p "$ROLE_DST_DIR"
cp "$ROLE_SRC" "$ROLE_DST_DIR/night-keeper.md"
echo "synced $ROLE_DST_DIR/night-keeper.md"

echo "sync-memory-skills: OK (${#SKILL_NAMES[@]} skills + night-keeper.md)"
