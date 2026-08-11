#!/usr/bin/env bash
# tz-07 criterion 1 (`no-pi-path-hardcode`) — the ONE source of this regexp.
# Both the vitest guard and the CI job call this script, so they cannot drift.
#
# Rule 1: outside launchers/ and tests, no literal `~/.pi`, `.pi/agent` or
#         `pi-auditor-sessions` — comments and docstrings included, because the
#         criterion's own grep sees them.
# Rule 2: the read-only legacy fallback stays read-only — `legacyReadPath` may
#         only be called from the files listed below, and its result may never
#         appear inside a writing fs call.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 2

# The fallback cannot be built without naming the old location, so exactly one
# file is allowed to hold the literal. Kept to one on purpose: an allowlist is
# a hole, and a hole with one entry is auditable.
ALLOWLIST="src/gateway/tdai-root.ts"
# Only these may CALL the fallback; everything else must resolve under the root.
LEGACY_CALLERS="src/gateway/tdai-root.ts src/gateway/role-paths.ts"

status=0

hits=$(grep -rnE '\.pi/agent|pi-auditor-sessions|"\.pi"' src/ --include='*.ts' \
  | grep -vE '^src/gateway/consolidation/launchers/|\.test\.ts' \
  | grep -vE "^${ALLOWLIST}:" || true)
if [ -n "$hits" ]; then
  echo "FAIL rule 1: hardcoded host path outside launchers/ (tz-07 criterion 1)"
  echo "$hits"
  status=1
fi

callers=$(grep -rln 'legacyReadPath' src/ --include='*.ts' \
  | grep -vE '\.test\.ts' || true)
for f in $callers; do
  case " $LEGACY_CALLERS " in
    *" $f "*) ;;
    *)
      echo "FAIL rule 2: $f calls legacyReadPath; only [$LEGACY_CALLERS] may"
      status=1
      ;;
  esac
done

writes=$(grep -rnE '(writeFile|appendFile|mkdir|rmSync|rm\(|rename|unlink|createWriteStream)[^)]*legacyReadPath' \
  src/ --include='*.ts' | grep -vE '\.test\.ts' || true)
if [ -n "$writes" ]; then
  echo "FAIL rule 2: legacyReadPath feeds a write — the fallback is read-only"
  echo "$writes"
  status=1
fi

[ "$status" -eq 0 ] && echo "ok: no hardcoded host paths; legacy fallback is read-only"
exit "$status"
