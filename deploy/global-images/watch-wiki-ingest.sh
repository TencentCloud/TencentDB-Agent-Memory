#!/usr/bin/env bash
# 监控 wiki ingest，直到知识页产出为止
WIKI="${1:-wiki-6y730yt0}"
SK=$(docker inspect tdai-memory-hub --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^KNOWLEDGE_SERVICE_KEY=' | cut -d= -f2-)
for i in $(seq 1 240); do
  N=$(curl -s -m 15 -X POST "http://127.0.0.1:8424/v3/wiki/page/ls" \
      -H "Content-Type: application/json" -H "Authorization: Bearer $SK" \
      -H "x-tdai-service-id: default" \
      -d "{\"team_id\":\"team-vsyicl8ds0\",\"wiki_id\":\"$WIKI\"}" \
    | python -c "import sys,json;print(len((json.load(sys.stdin).get('data') or {}).get('items') or []))" 2>/dev/null)
  echo "$(date +%H:%M:%S) pages=$N"
  [ "${N:-0}" -gt 0 ] && { echo "✓ ingest 完成，知识页 $N"; break; }
  sleep 30
done
