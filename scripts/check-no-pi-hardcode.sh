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

# The fallback cannot be built without naming the old location, so exactly two
# LINES are allowed to hold the literal — not a whole file, which would let any
# future path slip in under the same exemption.
ALLOWLIST="src/gateway/tdai-root.ts"
ALLOWED_LINES=2
# tz-08 host descriptors tell a USER which file of THEIR host to paste a
# registration into. That literal is documentation, never a path this code
# resolves, opens or writes — so it is exempted on the same terms as the
# fallback above: one named file, an exact line count, and (below) a hard
# check that the file touches no filesystem at all. A descriptor that ever
# started doing fs work would lose the exemption immediately.
DOC_ALLOWLIST="src/consumer/hosts/pi.ts"
DOC_ALLOWED_LINES=1
# Only these may CALL the fallback; everything else must resolve under the root.
# role-paths is the only consumer, and inside it only the *ForRead resolvers
# may call the fallback — a writer that resolves through it would put writes
# into the pre-tz-07 tree (found by the S5 probe).
LEGACY_CALLERS="src/gateway/tdai-root.ts src/gateway/role-paths.ts"

status=0

raw=$(grep -rnE '\.pi/agent|pi-auditor-sessions|"\.pi"' src/ --include='*.ts' \
  | grep -vE '^src/gateway/consolidation/launchers/|\.test\.ts' || true)
hits=$(echo "$raw" | grep -vE "^${ALLOWLIST}:|^${DOC_ALLOWLIST}:" | grep -v '^$' || true)
if [ -n "$hits" ]; then
  echo "FAIL rule 1: hardcoded host path outside launchers/ (tz-07 criterion 1)"
  echo "$hits"
  status=1
fi

# The exemption is bounded by COUNT too: the allowlisted file may hold exactly
# the two lines the fallback needs, so a third one cannot hide behind it.
allowed=$(echo "$raw" | grep -cE "^${ALLOWLIST}:" || true)
if [ "$allowed" -ne "$ALLOWED_LINES" ]; then
  echo "FAIL rule 1: ${ALLOWLIST} holds $allowed exempt lines, expected ${ALLOWED_LINES}"
  echo "$raw" | grep -E "^${ALLOWLIST}:"
  status=1
fi

# Same bounding for the descriptor exemption: an exact line count, plus proof
# that the file does no filesystem work — the exemption covers documentation,
# not a second way to resolve a host path.
doc_allowed=$(echo "$raw" | grep -cE "^${DOC_ALLOWLIST}:" || true)
if [ "$doc_allowed" -ne "$DOC_ALLOWED_LINES" ]; then
  echo "FAIL rule 1: ${DOC_ALLOWLIST} holds $doc_allowed exempt lines, expected ${DOC_ALLOWED_LINES}"
  echo "$raw" | grep -E "^${DOC_ALLOWLIST}:"
  status=1
fi
doc_fs=$(grep -nE "node:fs|\bfs\.|readFile|writeFile|path\.(join|resolve)" "${DOC_ALLOWLIST}" || true)
if [ -n "$doc_fs" ]; then
  echo "FAIL rule 1: ${DOC_ALLOWLIST} touches the filesystem; its path literal is documentation only"
  echo "$doc_fs"
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
