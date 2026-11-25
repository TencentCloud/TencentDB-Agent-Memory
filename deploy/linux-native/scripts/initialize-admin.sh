#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/config/core.env"
ADMIN_KEY="$(<"$ROOT/config/admin.key")"
BODY="$(printf '{"username":"admin","user_key":"%s"}' "$ADMIN_KEY")"
STATUS="$(curl --noproxy '*' -sS -o /dev/null -w '%{http_code}' --max-time 10 \
  -H 'Content-Type: application/json' -H 'x-tdai-service-id: default' \
  -d "$BODY" "http://127.0.0.1:$TDAI_GATEWAY_PORT/v3/internal/meta/user/init-admin")"
if [[ "$STATUS" != "200" && "$STATUS" != "409" ]]; then
  echo "init-admin returned HTTP $STATUS" >&2
  exit 1
fi
VERIFY_BODY="$(printf '{"user_key":"%s"}' "$ADMIN_KEY")"
curl --noproxy '*' -fsS --max-time 10 -H 'Content-Type: application/json' -H 'x-tdai-service-id: default' \
  -d "$VERIFY_BODY" "http://127.0.0.1:$TDAI_GATEWAY_PORT/v3/meta/auth/verify" >/dev/null
echo "Core admin key is initialized and verified."
