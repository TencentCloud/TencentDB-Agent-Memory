#!/usr/bin/env bash
# cost-guard-smoke.sh —— P1-K cost-guard 全部 mode 固化（自包含）
#
# 对照 docs/design/2026-09-22-refactor-verification-prioritized.md §P1-K
# 覆盖:
#   K1  mode=full      路由 + 压缩 (analyzer 真跑 → route+confidence)
#   K2  mode=pre       只压缩不路由 (compress_only_mode passthrough)
#   K3  mode=cheap     只路由不压缩 (cheap-forced, skipPrepare)
#   K4  markerOptIn=false 默认行为 (由 p1-api-test.sh 覆盖)
#   K5  retry → routedFrom 清空 (半自动, 需 mock 路由模型 4xx)
#   K6  analyzerTrace report (每次有 tools 的请求都产 cost_guard.analyzed)
#
# 自己起一个 markerOptIn=true + costGuard.enabled=true 的 proxy 实例,
# 发真实请求 → 读 proxy stdout 判定, 退出时自动清理。
#
# 必填环境变量 (全部必填, 无默认值, 避免把测试环境地址/凭据硬编码到仓库):
#   MPROJ     MemoryProxy 本地仓库根目录
#   BASECFG   proxy 的 base config.yaml 路径 (脚本会 sed 复制出变体, 原文件不动)
#   KEY       合法 user_key (sk-mem-* / ck_*)
#   SPACE     spaceId (必须与 KEY 同实例)
#   MODEL     价目表内的模型 (如 deepseek-v4-pro)
# 可选:
#   DRIVE     mock-core.mjs 所在目录 (默认 /tmp/tui-drive)
#   CGPORT    本脚本要起的 proxy 端口 (默认 18196)

set -uo pipefail

MPROJ="${MPROJ:?MPROJ required, e.g. /path/to/tdai-memory-openclaw-plugin/MemoryProxy}"
BASECFG="${BASECFG:?BASECFG required, path to the proxy base config.yaml}"
KEY="${KEY:?KEY required (sk-mem-* / ck_* user_key)}"
SPACE="${SPACE:?SPACE required (spaceId, must match KEY instance)}"
MODEL="${MODEL:?MODEL required (e.g. deepseek-v4-pro)}"
DRIVE="${DRIVE:-/tmp/tui-drive}"

CGPORT="${CGPORT:-18196}"
CGCFG=$DRIVE/cost-guard-smoke.yaml
CGLOG=/tmp/proxy-cg-smoke.log

PASS=0; FAIL=0
ok()  { printf '  \033[32mPASS\033[0m %-8s %s\n' "$1" "$2"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m %-8s %s\n' "$1" "$2"; FAIL=$((FAIL+1)); }
skip(){ printf '  \033[33mSKIP\033[0m %-8s %s\n' "$1" "$2"; }

PIDS=()
cleanup() {
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
  sleep 1
  for p in "${PIDS[@]:-}"; do kill -9 "$p" 2>/dev/null || true; done
}
trap cleanup EXIT

# 1) 起一个 cost-guard 启用 + markerOptIn=true + log.level=debug 的 proxy
sed -e "s|^  port: 8096|  port: $CGPORT|" \
    -e 's|^  level: info.*|  level: debug|' \
    -e 's|^  enabled: false        # 是否启用成本守卫|  enabled: true        # 是否启用成本守卫|' \
    -e 's|^  markerOptIn: false|  markerOptIn: true|' \
    "$BASECFG" > "$CGCFG"

mkdir -p "$DRIVE"
(cd "$MPROJ" && node --import tsx/esm src/index.ts --config "$CGCFG") > "$CGLOG" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 30); do
  curl -sf -m 2 "http://127.0.0.1:$CGPORT/health" >/dev/null 2>&1 && break
  sleep 0.5
done
if ! curl -sf -m 3 "http://127.0.0.1:$CGPORT/health" >/dev/null 2>&1; then
  echo "[FATAL] proxy on $CGPORT 未就绪"
  tail -20 "$CGLOG"
  exit 2
fi
# health 中应显示 costGuard=enabled
if ! curl -s -m 5 "http://127.0.0.1:$CGPORT/health" | grep -q '"costGuard":"enabled"'; then
  echo "[FATAL] proxy 启动了但 costGuard 没启用"
  exit 2
fi

printf '\n\033[1m== P1-K cost-guard mode 固化 ==\033[0m\n'

# ── helper ──
log_lines() { wc -l < "$CGLOG" 2>/dev/null || echo 0; }
# 发一个带 tools 的"复杂请求", 触发 analyzer 真跑
cg_req() {
  local marker="$1" path_suffix="${2:-v1/messages}"
  curl -s -m 40 -o /dev/null -w "%{http_code}" \
    -X POST "http://127.0.0.1:$CGPORT/claude-code/$SPACE/$marker/$path_suffix" \
    -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
    -d "{\"model\":\"$MODEL\",\"max_tokens\":64,\"tools\":[{\"name\":\"Read\",\"description\":\"read a file\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\"}}}}],\"messages\":[{\"role\":\"user\",\"content\":\"请读取 /etc/passwd 并重构整个模块, 这是一个涉及多步骤的复杂任务\"}]}"
}

# ── K1: full ─────────────────────────────────────────────────────────────────
B=$(log_lines)
C=$(cg_req "cost-guard")
sleep 2
D=$(tail -n +$((B+1)) "$CGLOG")
analyzed=$(printf '%s' "$D" | grep -oE 'cost_guard\.analyzed [^}]+}' | head -1)
if [[ "$C" == "200" ]] && [[ -n "$analyzed" ]]; then
  ok "P1-K1" "mode=full → http=$C | $(printf '%s' "$analyzed" | head -c 120)"
else
  bad "P1-K1" "期望 200+analyzed, 实际 http=$C analyzed=$analyzed"
fi

# ── K2: pre (compress-only) ──────────────────────────────────────────────────
B=$(log_lines)
C=$(cg_req "cost-guard/pre")
sleep 2
D=$(tail -n +$((B+1)) "$CGLOG")
pt=$(printf '%s' "$D" | grep -oE 'guard_adapter\.passthrough [^}]+}' | head -1)
if [[ "$C" == "200" ]] && printf '%s' "$pt" | grep -q "compress_only_mode"; then
  ok "P1-K2" "mode=pre → compress_only_mode passthrough (http=$C)"
else
  bad "P1-K2" "期望 compress_only_mode, 实际 http=$C passthrough=$pt"
fi

# ── K3: cheap (route-only, skip prepare) ─────────────────────────────────────
B=$(log_lines)
C=$(cg_req "cost-guard/cheap")
sleep 2
D=$(tail -n +$((B+1)) "$CGLOG")
# cheap mode: cost-guard 强制 cheap model (log 里有 analyzed route=cheap, 或 forced)
analyzed=$(printf '%s' "$D" | grep -oE 'cost_guard\.analyzed [^}]+}' | head -1)
forced=$(printf '%s' "$D" | grep -ic "cheap\|forced")
if [[ "$C" == "200" ]] && [[ -n "$analyzed" || "$forced" -gt 0 ]]; then
  ok "P1-K3" "mode=cheap → http=$C | analyzed=${analyzed:-'(no analyzer)'} forced_hits=$forced"
else
  bad "P1-K3" "期望 cheap 分支生效, 实际 http=$C"
fi

# ── K6: analyzer trace report ────────────────────────────────────────────────
# K1 请求已经应该产 analyzer trace 到 opik/langfuse, 这里从 log 里确认
# analyzer 产生 cost_guard.analyzed 日志 (已在 K1 验证), 以及可选的
# analyzer_usage 事件写 ClickHouse。
if grep -q "cost_guard\.analyzed" "$CGLOG"; then
  cnt=$(grep -c "cost_guard\.analyzed" "$CGLOG")
  ok "P1-K6" "analyzer trace: $cnt 次 cost_guard.analyzed 已上报"
else
  bad "P1-K6" "未见 cost_guard.analyzed"
fi

# ── K5: retry → routedFrom 清空 ──────────────────────────────────────────────
# 要构造 "路由到 cheap → cheap 返 4xx → retry 到 target 成功 → writeLog routedFrom="""
# 这需要 cheap model 失败, 当前实例的 cheap=deepseek-v4-pro 跟 target 同一个
# 不会 4xx, 没法稳定触发。记为 skip 并给出复现路径。
skip "P1-K5" "需构造 cheap→4xx→retry 场景: 把 costGuard.cheapModel 指向一个会返 4xx 的模型 (如 no-such-model); 当前实例 cheap=$MODEL 不会 4xx"

# ── K7: anthropic independent upstream (重复 p1-api-test, 这里确认 marker 模式下也成立) ─
B=$(log_lines)
curl -s -m 25 -o /dev/null -X POST "http://127.0.0.1:$CGPORT/claude-code/$SPACE/v1/messages" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" >/dev/null
sleep 2
D=$(tail -n +$((B+1)) "$CGLOG")
fwd=$(printf '%s' "$D" | grep -oE "FORWARD upstream=\S+" | head -1)
if [[ -n "$fwd" ]]; then
  ok "P1-K7" "marker 实例下 CC 转发: $fwd"
else
  bad "P1-K7" "未捕获转发目标"
fi

printf '\n  PASS=%d FAIL=%d (K5 需手动)\n\n' "$PASS" "$FAIL"
exit $(( FAIL > 0 ? 1 : 0 ))
