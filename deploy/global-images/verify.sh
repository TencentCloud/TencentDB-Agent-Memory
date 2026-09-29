#!/usr/bin/env bash
# 干跑校验：不启动任何容器，只检查环境是否就绪。
#
# 用法：
#   ./verify.sh               # 默认全检（含 LLM 通路预检）
#   ./verify.sh --skip-llm    # 跳过 LLM 检查（离线环境或不希望发外部请求时用）
#
# 检查项：
#   1. docker 命令可用
#   2. .env 文件存在
#   3. .env 中所有必填参数已填写（非 REPLACE_ME 且非空）
#   4. 三个镜像是否已在本地（未在本地也不算失败，只 warn）
#   5. 目标端口是否被占用
#   6. LLM 上游通路（memory 组 + proxy 组，各自预检）
#      - openai 协议：GET {base}/models，不消耗 token
#      - anthropic 协议：POST {base}/v1/messages max_tokens=1，消耗 ≤ 10 token
#      - 若容器已运行，额外 docker exec 从容器内再打一次（验证容器 → LLM 网络可达）
#
# 全部通过 → exit 0；有错 → exit 1；只 warn → exit 0

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_lib.sh
source "$SCRIPT_DIR/_lib.sh"

SKIP_LLM=0
for arg in "$@"; do
  case "$arg" in
    --skip-llm) SKIP_LLM=1 ;;
    --help|-h)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *) warn "未知参数: ${arg}（忽略）" ;;
  esac
done

ERRORS=0
WARNS=0
CURL="$(command -v curl)"

# ─── LLM 通路检查函数 ───────────────────────────────────────────────
# check_llm_openai <label> <base_url> <api_key> <model>
#   OpenAI 兼容：GET {base}/models 只验证 auth+URL，不消耗 token。
#   base_url 允许带或不带 /v1；这里做归一化。
check_llm_openai() {
  local label="$1" base="$2" key="$3" model="$4"
  # 归一化：去尾部 /，去 /messages 或 /chat/completions 后缀
  base="${base%/}"
  base="${base%/messages}"
  base="${base%/chat/completions}"
  local url="${base}/models"
  local code body_file=/tmp/llm-check.$$
  code=$("$CURL" -sS --max-time 10 -o "$body_file" -w "%{http_code}" \
    -H "Authorization: Bearer $key" \
    "$url" 2>/dev/null || echo "000")
  if [[ "$code" == "200" ]]; then
    # 尝试解析 model 是否在列表里（宽松匹配，不匹配也只 warn）
    if grep -q "\"$model\"" "$body_file" 2>/dev/null; then
      ok "$label OpenAI 协议通路 OK（$model 在 /models 列表内）"
    else
      ok "$label OpenAI 协议通路 OK（未在 /models 里显式列出 ${model}，业务侧仍可能可用）"
    fi
    rm -f "$body_file"
    return 0
  elif [[ "$code" == "401" || "$code" == "403" ]]; then
    echo "${C_RED}[error]${C_RST} $label API key 无效（HTTP ${code}）：$url" >&2
    head -c 200 "$body_file" >&2; echo >&2
    rm -f "$body_file"
    return 1
  elif [[ "$code" == "404" ]]; then
    # 部分厂商没有 /models 端点，改用 anthropic 风格或跳过：warn 不 error
    warn "$label GET /models 404 —— 该厂商可能没有该端点，改用 anthropic 协议检查"
    check_llm_anthropic "$label" "$base" "$key" "$model"
    rm -f "$body_file"
    return $?
  else
    warn "$label 无法访问 ${url}（HTTP=${code}）$(head -c 100 "$body_file" 2>/dev/null)"
    rm -f "$body_file"
    return 1
  fi
}

# check_llm_anthropic <label> <base_url> <api_key> <model>
#   Anthropic：POST {base}/v1/messages 发 max_tokens=1，消耗 ≤ 10 token 但能同时验 URL/auth/model。
check_llm_anthropic() {
  local label="$1" base="$2" key="$3" model="$4"
  base="${base%/}"
  # 归一化：若已含 /messages 直接用；否则拼 /v1/messages
  local url
  if [[ "$base" == */messages ]]; then
    url="$base"
  elif [[ "$base" == */v1 ]]; then
    url="${base}/messages"
  else
    url="${base}/v1/messages"
  fi
  local code body_file=/tmp/llm-check.$$
  code=$("$CURL" -sS --max-time 15 -o "$body_file" -w "%{http_code}" \
    -X POST -H "Content-Type: application/json" \
    -H "x-api-key: $key" \
    -H "Authorization: Bearer $key" \
    -H "anthropic-version: 2023-06-01" \
    -d "{\"model\":\"$model\",\"max_tokens\":1,\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}" \
    "$url" 2>/dev/null || echo "000")
  case "$code" in
    200)
      ok "$label Anthropic 协议通路 OK（模型 $model 已应答）"
      rm -f "$body_file"; return 0 ;;
    401|403)
      echo "${C_RED}[error]${C_RST} $label API key 无效（HTTP ${code}）：$url" >&2
      head -c 200 "$body_file" >&2; echo >&2
      rm -f "$body_file"; return 1 ;;
    404)
      echo "${C_RED}[error]${C_RST} $label URL 不存在（HTTP 404）：$url —— 检查 BASE_URL" >&2
      rm -f "$body_file"; return 1 ;;
    400)
      # 400 常见于模型名不存在或 body 校验失败
      if grep -qE "model.*not.*found|invalid.*model|model_not_found" "$body_file" 2>/dev/null; then
        echo "${C_RED}[error]${C_RST} $label 模型名 '$model' 无效（HTTP 400）" >&2
        rm -f "$body_file"; return 1
      fi
      warn "$label HTTP 400（可能是参数格式问题，非通路错）：$(head -c 150 "$body_file")"
      rm -f "$body_file"; return 0 ;;
    *)
      warn "$label 无法访问 ${url}（HTTP=${code}）$(head -c 100 "$body_file" 2>/dev/null)"
      rm -f "$body_file"; return 1 ;;
  esac
}

# check_llm_group <label> <base_url> <api_key> <model> <protocol>
check_llm_group() {
  local label="$1" base="$2" key="$3" model="$4" proto="${5:-openai}"
  info "检查 $label 通路（协议=${proto}，base=${base}，model=${model}）..."
  case "$proto" in
    anthropic) check_llm_anthropic "$label" "$base" "$key" "$model" ;;
    *)         check_llm_openai    "$label" "$base" "$key" "$model" ;;
  esac
}

# 容器内 curl 验证（可选，容器已运行时才做）
check_llm_from_container() {
  local container="$1" label="$2" base="$3" key="$4" model="$5" proto="${6:-openai}"
  if ! $DOCKER ps --format '{{.Names}}' | grep -qx "$container"; then
    return 0  # 容器没跑，跳过（非错误）
  fi
  info "  ↳ 从容器 $container 内部再打一次 $label..."
  # 关注点是"网络可达"：只要能拿到任何 HTTP 状态码就算通；000 才算不可达。
  # auth 错在宿主机侧已经报过，容器内不再重复触发 error。
  local url code
  case "$proto" in
    anthropic)
      base="${base%/}"; [[ "$base" == */messages ]] || base="${base}/v1/messages"
      url="$base"
      code=$($DOCKER exec "$container" curl -sS -o /dev/null --max-time 15 \
         -w "%{http_code}" -X POST -H "Content-Type: application/json" \
         -H "x-api-key: $key" -H "anthropic-version: 2023-06-01" \
         -d "{\"model\":\"$model\",\"max_tokens\":1,\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}" \
         "$url" 2>/dev/null || echo "000")
      ;;
    *)
      base="${base%/}"; base="${base%/v1}"
      url="${base}/v1/models"
      code=$($DOCKER exec "$container" curl -sS -o /dev/null --max-time 10 \
         -w "%{http_code}" -H "Authorization: Bearer $key" "$url" 2>/dev/null || echo "000")
      ;;
  esac
  if [[ "$code" == "000" ]]; then
    warn "  容器 ${container} 无法访问 ${url}（网络隔离 / DNS 失败）"
    WARNS=$((WARNS+1))
  else
    ok "  容器 ${container} → $label 网络可达（HTTP ${code}）"
  fi
}

# 1. docker
if command -v "$DOCKER" >/dev/null 2>&1 || [[ -x "$DOCKER" ]]; then
  ok "docker 可用: $DOCKER"
else
  ERRORS=$((ERRORS+1))
  echo "${C_RED}[error]${C_RST} docker 不可用" >&2
fi

# 2. .env
if [[ ! -f "$ENV_FILE" ]]; then
  ERRORS=$((ERRORS+1))
  echo "${C_RED}[error]${C_RST} $ENV_FILE 不存在。执行：cp .env.example .env" >&2
else
  ok ".env 存在"
  set -a; source "$ENV_FILE"; set +a

  # 3. 必填参数
  MISSING=()
  for var in \
    MEMORY_CORE_IMAGE MEMORY_HUB_IMAGE PROXY_IMAGE \
    MEMORY_CORE_PORT PANEL_PORT KNOWLEDGE_PORT PROXY_PORT \
    MEMORY_CORE_VOLUME PANEL_VOLUME \
    MEMORY_LLM_BASE_URL MEMORY_LLM_API_KEY MEMORY_LLM_MODEL \
    KNOWLEDGE_PUBLIC_BASE_URL \
    PROXY_UPSTREAM_URL PROXY_UPSTREAM_API_KEY PROXY_UPSTREAM_MODEL; do
    val="${!var:-}"
    if [[ -z "$val" || "$val" == "REPLACE_ME" ]]; then
      MISSING+=("$var")
    fi
  done
  if (( ${#MISSING[@]} > 0 )); then
    ERRORS=$((ERRORS+1))
    echo "${C_RED}[error]${C_RST} 以下必填参数未设置：${MISSING[*]}" >&2
  else
    ok "所有必填参数已填写"
  fi

  # 4. 镜像是否本地存在
  for img_var in MEMORY_CORE_IMAGE MEMORY_HUB_IMAGE PROXY_IMAGE; do
    img="${!img_var:-}"
    if [[ -z "$img" ]]; then continue; fi
    if $DOCKER image inspect "$img" >/dev/null 2>&1; then
      ok "镜像本地已存在: $img"
    else
      WARNS=$((WARNS+1))
      warn "镜像本地不存在，启动时会 pull: $img"
    fi
  done

  # 5. 端口占用（仅提醒）
  for port_var in MEMORY_CORE_PORT PANEL_PORT KNOWLEDGE_PORT PROXY_PORT; do
    port="${!port_var:-}"
    if [[ -z "$port" ]]; then continue; fi
    if lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      WARNS=$((WARNS+1))
      warn "端口 $port ($port_var) 已被占用，启动前请释放或在 .env 改端口"
    else
      ok "端口 $port ($port_var) 空闲"
    fi
  done

  # 6. LLM 通路（默认检查，--skip-llm 跳过）
  if (( SKIP_LLM == 1 )); then
    info "跳过 LLM 通路检查（--skip-llm）"
  elif (( ${#MISSING[@]} > 0 )); then
    warn "跳过 LLM 通路检查（必填参数未填齐）"
  else
    echo ""
    info "═══ LLM 通路检查 ═══════════════════════════════════════"

    # memory 组
    if ! check_llm_group "memory 组" "$MEMORY_LLM_BASE_URL" "$MEMORY_LLM_API_KEY" \
         "$MEMORY_LLM_MODEL" "${MEMORY_LLM_PROTOCOL:-openai}"; then
      ERRORS=$((ERRORS+1))
    fi
    # 容器已运行则容器内也验一次
    check_llm_from_container tdai-memory-hub "memory 组 (from container)" \
      "$MEMORY_LLM_BASE_URL" "$MEMORY_LLM_API_KEY" "$MEMORY_LLM_MODEL" \
      "${MEMORY_LLM_PROTOCOL:-openai}"

    # proxy 组（如果与 memory 组值完全一样，说明用户填的是同一份，只验 1 次即可）
    if [[ "$PROXY_UPSTREAM_URL" == "$MEMORY_LLM_BASE_URL" && \
          "$PROXY_UPSTREAM_API_KEY" == "$MEMORY_LLM_API_KEY" && \
          "$PROXY_UPSTREAM_MODEL" == "$MEMORY_LLM_MODEL" ]]; then
      ok "proxy 组 与 memory 组完全相同，跳过重复检查"
    else
      # proxy 组默认按 openai 协议（与 config.yaml 一致）
      if ! check_llm_group "proxy 组" "$PROXY_UPSTREAM_URL" "$PROXY_UPSTREAM_API_KEY" \
           "$PROXY_UPSTREAM_MODEL" openai; then
        ERRORS=$((ERRORS+1))
      fi
      check_llm_from_container tdai-proxy "proxy 组 (from container)" \
        "$PROXY_UPSTREAM_URL" "$PROXY_UPSTREAM_API_KEY" "$PROXY_UPSTREAM_MODEL" openai
    fi
  fi
fi

echo ""
if (( ERRORS > 0 )); then
  echo "${C_RED}✗ ${ERRORS} 个错误，${WARNS} 个警告 —— 无法启动${C_RST}" >&2
  exit 1
elif (( WARNS > 0 )); then
  echo "${C_YLW}⚠ ${WARNS} 个警告 —— 可以启动，但请注意上面的提示${C_RST}"
  exit 0
else
  echo "${C_GRN}✓ 全部检查通过 —— 可以直接 ./start-all.sh${C_RST}"
  exit 0
fi
