#!/usr/bin/env bash
# Host-side one-liner: pull (optional) + run team-knowledge with required CLI flags.
#
# Usage:
#   ./docker/run.sh \
#     --public-url http://203.0.113.10:8421/v3 \
#     --tmc-callback http://203.0.113.10:8123 \
#     --llm-key sk-xxx \
#     --llm-base-url https://api.example.com/v1
#
# Env overrides:
#   TEAM_KNOWLEDGE_IMAGE=csighub.tencentyun.com/<ns>/team-knowledge:0.1.0
#   TEAM_KNOWLEDGE_CONTAINER=team-knowledge
#   TEAM_KNOWLEDGE_VOLUME=team-knowledge-data
#   TEAM_KNOWLEDGE_HOST_PORT=8421

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

IMAGE="${TEAM_KNOWLEDGE_IMAGE:-team-knowledge:latest}"
CONTAINER="${TEAM_KNOWLEDGE_CONTAINER:-team-knowledge}"
VOLUME="${TEAM_KNOWLEDGE_VOLUME:-team-knowledge-data}"
HOST_PORT="${TEAM_KNOWLEDGE_HOST_PORT:-8421}"

if [[ $# -eq 0 ]] || [[ "${1:-}" == "--help" ]] || [[ "${1:-}" == "-h" ]]; then
  exec docker run --rm "$IMAGE" --help
fi

if [[ "$IMAGE" != *"/"* ]] || [[ "$IMAGE" == team-knowledge:* ]]; then
  if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "==> Building $IMAGE from $ROOT"
    DOCKER_BUILDKIT=1 docker build -t "$IMAGE" "$ROOT"
  fi
fi

docker rm -f "$CONTAINER" 2>/dev/null || true

# After start: ./docker/smoke-test.sh --base-url "http://127.0.0.1:${HOST_PORT}"

exec docker run -d \
  --name "$CONTAINER" \
  -p "${HOST_PORT}:8421" \
  -v "${VOLUME}:/app/data" \
  --restart unless-stopped \
  "$IMAGE" \
  "$@"
