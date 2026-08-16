#!/usr/bin/env bash
# Sync memory-role skills + night-keeper role file from the repo canonical
# copies to their runtime locations. Single-source: repo is the canonical
# source; runtime copies must equal the repo (parity test enforces).
#
#   repo  src/core/prompts/skills/{memory-keeper,memory-critic,night-keeper,night-critic,dedup-daily,dedup-daily-critic}/SKILL.md
#     →   ~/.pi/agent-memory/tdai/skills/<name>/SKILL.md   (forked task-cycle per-role skills)
#   repo  src/core/prompts/{memory-keeper,night-keeper,dedup-daily}.md
#     →   ~/.pi/agent-memory/tdai/roles/<name>/prompt.md — the ONE path the
#         gateway reads at spawn time (resolveRolePrompt), so parity is checked
#         where the child actually gets its prompt.
#
# Every SPAWNABLE role has a repo canonical, and the sync OVERWRITES it: edit
# the prompt in the repo, never in the live tree. A hand edit under ~/.pi is
# erased by the next sync without warning — git is what keeps prompt history.
# (The old "guarded" carve-out did the opposite: it protected the live file from
# the repo, and that is how roles/memory-keeper/prompt.md sat at a 6-byte stub
# while the real 7 KB prompt lived in the repo unused.)
#
# One live prompt stays out: roles/dedup-daily-critic/prompt.md. A critic is not
# a TDAI role at all (AGENTS.md: TDAI does not know whether a critic exists) —
# it has no role.json, cannot be spawned, and the whole directory goes away with
# the other critic roles. No canonical is written for a prompt on its way out.
#
# Idempotent; safe to re-run. Fails loudly on a missing source (never silently
# ships a stale runtime copy).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILLS_SRC="$REPO_ROOT/src/core/prompts/skills"
SKILLS_DST="$HOME/.pi/agent-memory/tdai/skills"
TDAI="$HOME/.pi/agent-memory/tdai"

SKILL_NAMES=(memory-keeper memory-critic night-keeper night-critic dedup-daily dedup-daily-critic)

# "<repo canonical>|<live copy>" — byte-for-byte parity (test enforces).
ROLE_FILES=(
  "$REPO_ROOT/src/core/prompts/memory-keeper.md|$TDAI/roles/memory-keeper/prompt.md"
  "$REPO_ROOT/src/core/prompts/night-keeper.md|$TDAI/roles/night-keeper/prompt.md"
  "$REPO_ROOT/src/core/prompts/dedup-daily.md|$TDAI/roles/dedup-daily/prompt.md"
)

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

for pair in "${ROLE_FILES[@]}"; do
  src="${pair%%|*}"
  dst="${pair#*|}"
  [ -f "$src" ] || fail "missing canonical role file: $src"
  mkdir -p "$(dirname "$dst")"
  cp "$src" "$dst"
  echo "synced $dst"
done

echo "sync-memory-skills: OK (${#SKILL_NAMES[@]} skills + ${#ROLE_FILES[@]} role prompts)"
