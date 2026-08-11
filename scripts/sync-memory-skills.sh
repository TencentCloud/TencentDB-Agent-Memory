#!/usr/bin/env bash
# Sync memory-role skills + night-keeper role file from the repo canonical
# copies to their runtime locations. Single-source: repo is the canonical
# source; runtime copies must equal the repo (parity test enforces).
#
#   repo  src/core/prompts/skills/{memory-keeper,memory-critic,night-keeper,night-critic,dedup-daily,dedup-daily-critic}/SKILL.md
#     →   ~/.pi/agent-memory/tdai/skills/<name>/SKILL.md   (forked task-cycle per-role skills)
#   repo  src/core/prompts/{memory-keeper,night-keeper}.md
#     →   the live role prompts the gateway actually reads at spawn time
#         (~/.pi/agent-memory/tdai/roles/<name>/prompt.md + the legacy
#          ~/.pi/agent-memory/tdai/memory-keeper/<name>.md copies)
#
# Live prompts WITHOUT a repo canonical (roles/memory-keeper/prompt.md carries
# an extra output-format block, dedup-daily* have no repo copy at all) cannot be
# synced — they are guarded instead: the retired result path `diff.json` must
# not appear in them as the ROLE RESULT. The only allowed mention is the
# retired INPUT location (fallback), marked by "снятое место входа".
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
  "$REPO_ROOT/src/core/prompts/night-keeper.md|$TDAI/memory-keeper/night-keeper.md"
  "$REPO_ROOT/src/core/prompts/memory-keeper.md|$TDAI/memory-keeper/memory-keeper.md"
  "$REPO_ROOT/src/core/prompts/night-keeper.md|$TDAI/roles/night-keeper/prompt.md"
)

# Live prompts with no repo canonical — guarded, never overwritten.
GUARDED_FILES=(
  "$TDAI/roles/memory-keeper/prompt.md"
  "$TDAI/roles/dedup-daily/prompt.md"
  "$TDAI/roles/dedup-daily-critic/prompt.md"
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

# A live prompt may carry operator additions (roles/memory-keeper/prompt.md has
# an appended "Output format" block). Overwriting such a file destroys them
# silently, so drift beyond the retired-path rename STOPS the sync instead.
for pair in "${ROLE_FILES[@]}"; do
  src="${pair%%|*}"
  dst="${pair#*|}"
  [ -f "$src" ] || fail "missing canonical role file: $src"
  mkdir -p "$(dirname "$dst")"
  if [ -f "$dst" ]; then
    # Compare with the retired/new result path folded together: a file that
    # differs ONLY by that rename is ours to update.
    if ! diff -q \
      <(sed 's|out/result\.json|diff.json|g' "$src") \
      <(sed 's|out/result\.json|diff.json|g' "$dst") >/dev/null; then
      fail "$dst has diverged from its canonical $src — refusing to overwrite.
Review with: diff $src $dst"
    fi
  fi
  cp "$src" "$dst"
  echo "synced $dst"
done

for f in "${GUARDED_FILES[@]}"; do
  [ -f "$f" ] || fail "missing live role prompt: $f"
  stale="$(grep -n 'diff\.json' "$f" | grep -v 'снятое место входа' || true)"
  [ -z "$stale" ] || fail "$f still names the retired result path diff.json (use out/result.json):
$stale"
  echo "checked $f"
done

echo "sync-memory-skills: OK (${#SKILL_NAMES[@]} skills + ${#ROLE_FILES[@]} role files + ${#GUARDED_FILES[@]} guarded)"
