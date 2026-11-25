#!/usr/bin/env bash
# iu-smoke.sh —— P0-D2/D3/D4 实例上游 4 态验证（自包含：起 mock core + 临时 proxy）
#
# 为什么不用主实例测：
#   blocked / unmanaged 两态需要把某个组的 enabled 改成 false，或让 agent 不在
#   任何组里。直接改共享测试实例会污染其他人正在跑的会话，所以用 mock core
#   提供 instance-upstream/list 的三种返回形态。
#
# 用法: bash iu-smoke.sh
#   退出时自动清理所有 mock + 临时 proxy 进程。

#
# 必填环境变量:
#   MPROJ        MemoryProxy 本地仓库根目录
#   BASECFG      proxy 的 base config.yaml 路径 (脚本会 sed 复制出若干变体, 原文件不动)
#   CORE_URL     config 里要替换的 core 原始地址 (如 http://10.0.0.1:8420),
#                脚本会把它改成 http://127.0.0.1:<mock-port>
# 可选:
#   DRIVE        mock-core.mjs 所在目录 (默认 /tmp/tui-drive)
#   SPACE        spaceId (默认 default)
#   MODEL        价目表内的模型 (默认 deepseek-v4-pro)

set -uo pipefail

MPROJ="${MPROJ:?MPROJ required, e.g. /path/to/tdai-memory-openclaw-plugin/MemoryProxy}"
BASECFG="${BASECFG:?BASECFG required, path to the proxy base config.yaml}"
CORE_URL="${CORE_URL:?CORE_URL required, the core http URL to swap out (e.g. http://10.0.0.1:8420)}"
DRIVE="${DRIVE:-/tmp/tui-drive}"
KEY=any-mock-key
SPACE="${SPACE:-default}"
MODEL="${MODEL:-deepseek-v4-pro}"

PASS=0; FAIL=0
ok()  { printf '  \033[32mPASS\033[0m %-8s %s\n' "$1" "$2"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m %-8s %s\n' "$1" "$2"; FAIL=$((FAIL+1)); }

PIDS=()
cleanup() {
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
  sleep 1
  for p in "${PIDS[@]:-}"; do kill -9 "$p" 2>/dev/null || true; done
}
trap cleanup EXIT

start_mock() { # $1=mode $2=port
  MOCK_MODE="$1" MOCK_PORT="$2" node "$DRIVE/mock-core.mjs" > "/tmp/iu-mock-$2.log" 2>&1 &
  PIDS+=($!)
}

start_proxy() { # $1=port $2=core_port
  local cfg="$DRIVE/iu-test-$1.yaml"
  sed -e "s|^  port: 8096|  port: $1|" \
      -e "s|$CORE_URL|http://127.0.0.1:$2|g" "$BASECFG" > "$cfg"
  (cd "$MPROJ" && node --import tsx/esm src/index.ts --config "$cfg") > "/tmp/iu-proxy-$1.log" 2>&1 &
  PIDS+=($!)
}

wait_up() { # $1=url
  for _ in $(seq 1 40); do
    curl -sf -m 2 "$1" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  return 1
}

# 三种形态: blocked-default(18610/18620) blocked-custom(18611/18621) unmanaged(18612/18622)
start_mock blocked-default 18610
start_mock blocked-custom  18611
start_mock unmanaged       18612
sleep 2
start_proxy 18620 18610
start_proxy 18621 18611
start_proxy 18622 18612

for u in http://127.0.0.1:18620/health http://127.0.0.1:18621/health http://127.0.0.1:18622/health; do
  if ! wait_up "$u"; then echo "[FATAL] $u 未就绪"; exit 2; fi
done

printf '\n\033[1m== P0-D 实例上游 4 态（mock core）==\033[0m\n'

# D2 blocked（default 组 disabled）—— anthropic 形态
body_a="{\"model\":\"$MODEL\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
r=$(curl -s -m 20 -w '\n%{http_code}' -X POST "http://127.0.0.1:18620/claude-code/$SPACE/v1/messages" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d "$body_a")
code=$(printf '%s' "$r" | tail -1); b=$(printf '%s' "$r" | sed '$d')
if [[ "$code" == "400" ]] && printf '%s' "$b" | grep -q "upstream_disabled"; then
  ok "P0-D2" "blocked(default_disabled) → 400 upstream_disabled (anthropic envelope)"
else
  bad "P0-D2" "期望 400+upstream_disabled, 实际 $code｜$(printf '%s' "$b" | head -c 120)"
fi

# D2 blocked（custom 组 disabled）—— openai 形态
r=$(curl -s -m 20 -w '\n%{http_code}' -X POST "http://127.0.0.1:18621/codebuddy/$SPACE/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d "$body_a")
code=$(printf '%s' "$r" | tail -1); b=$(printf '%s' "$r" | sed '$d')
if [[ "$code" == "400" ]] && printf '%s' "$b" | jq -e '.error_code=="UPSTREAM_DISABLED"' >/dev/null 2>&1; then
  ok "P0-D2" "blocked(custom_disabled) → 400 UPSTREAM_DISABLED (openai envelope)"
else
  bad "P0-D2" "期望 400+UPSTREAM_DISABLED, 实际 $code｜$(printf '%s' "$b" | head -c 120)"
fi

# D3 unmanaged —— openai 形态
r=$(curl -s -m 20 -w '\n%{http_code}' -X POST "http://127.0.0.1:18622/codebuddy/$SPACE/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d "$body_a")
code=$(printf '%s' "$r" | tail -1); b=$(printf '%s' "$r" | sed '$d')
if [[ "$code" == "400" ]] && printf '%s' "$b" | jq -e '.error_code=="AGENT_NOT_CONFIGURED"' >/dev/null 2>&1; then
  ok "P0-D3" "unmanaged → 400 AGENT_NOT_CONFIGURED (openai envelope)"
else
  bad "P0-D3" "期望 400+AGENT_NOT_CONFIGURED, 实际 $code｜$(printf '%s' "$b" | head -c 120)"
fi

# D3 unmanaged —— anthropic 形态
r=$(curl -s -m 20 -w '\n%{http_code}' -X POST "http://127.0.0.1:18622/claude-code/$SPACE/v1/messages" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d "$body_a")
code=$(printf '%s' "$r" | tail -1); b=$(printf '%s' "$r" | sed '$d')
if [[ "$code" == "400" ]] && printf '%s' "$b" | grep -q "agent_not_configured"; then
  ok "P0-D3" "unmanaged → 400 agent_not_configured (anthropic envelope)"
else
  bad "P0-D3" "期望 400+agent_not_configured, 实际 $code｜$(printf '%s' "$b" | head -c 120)"
fi

printf '\n  PASS=%d FAIL=%d\n\n' "$PASS" "$FAIL"
exit $(( FAIL > 0 ? 1 : 0 ))
