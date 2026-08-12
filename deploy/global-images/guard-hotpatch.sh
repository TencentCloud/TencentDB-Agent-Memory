#!/usr/bin/env bash
# guard-hotpatch.sh — 946-D 非生产热补丁 guard（source 进各 patch 脚本）。
#
# 生产规则（docs/946spec.md §19）：
#   - 生产实例必须运行不可变镜像（source commit → CI → immutable image → digest
#     → canary → rollout）。在运行容器内改源文件**不是**受支持的部署机制。
#   - 容器内热补丁仅作为「开发者紧急临时手段」，必须显式开启：
#         ALLOW_UNSUPPORTED_HOTPATCH=1 ./patch-xxx.sh
#   - 脚本必须：
#       1) 打印 unsupported warning；
#       2) 在已知生产环境拒绝执行（DEPLOY_ENV=production / DEPLOY_ENV=prod）；
#       3) 记录 changed files + hashes（写 .hotpatch-changes.<ts>.txt）；
#       4) 永不被官方部署自动化调用（start-*.sh 不调用）。

set -euo pipefail

# 从调用方继承 SCRIPT_DIR / CONTAINER（若未定义则不引用）
SCRIPT_DIR_HOTPATCH="${SCRIPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"

HOTPATCH_MARKER="946-D-hotpatch-guard"
HOTPATCH_CHANGES_FILE="${HOTPATCH_CHANGES_FILE:-$SCRIPT_DIR_HOTPATCH/.hotpatch-changes.$(date +%Y%m%d%H%M%S).txt}"

# 已知生产环境标记：DEPLOY_ENV=production|prod 时拒绝。
# 其它环境标记（如 K8S 环境变量存在）可按需扩展。
hotpatch_refuse_in_production() {
  local env_val="${DEPLOY_ENV:-}"
  case "${env_val,,}" in
    production|prod)
      echo "${C_RED:-}[error]${C_RST:-} ALLOW_UNSUPPORTED_HOTPATCH 补丁在生产环境（DEPLOY_ENV=${env_val}）被拒绝。" >&2
      echo "  生产部署必须使用不可变镜像 + image digest 发布（见 docs/946spec.md §19.1）。" >&2
      echo "  如需在开发/测试环境使用，请显式设置 DEPLOY_ENV=dev 或移除该变量。" >&2
      exit 1
      ;;
  esac
}

hotpatch_check_guard() {
  # 1) 必须先显式开启
  if [[ "${ALLOW_UNSUPPORTED_HOTPATCH:-0}" != "1" ]]; then
    echo "${C_RED:-}[error]${C_RST:-} 这是不受支持的容器内热补丁，生产环境禁止。请改用镜像重建。" >&2
    echo "" >&2
    echo "  如需在开发/测试环境临时使用，请显式开启并知晓风险：" >&2
    echo "      ALLOW_UNSUPPORTED_HOTPATCH=1 $0 [容器名]" >&2
    echo "" >&2
    echo "  生产规则（docs/946spec.md §19.1）：" >&2
    echo "      source commit → CI → immutable image → image digest → canary → rollout" >&2
    exit 1
  fi

  # 2) 生产环境拒绝
  hotpatch_refuse_in_production

  # 3) unsupported warning
  echo "${C_YLW:-}[warn]${C_RST:-} ============================================================" >&2
  echo "${C_YLW:-}[warn]${C_RST:-}  容器内热补丁是 UNSUPPORTED 的开发/测试临时手段。" >&2
  echo "${C_YLW:-}[warn]${C_RST:-}  容器重建后补丁会丢失，且不会被官方部署自动化调用。" >&2
  echo "${C_YLW:-}[warn]${C_RST:-}  ============================================================" >&2
}

# 记录一次变更文件及其 sha256（写审计文件，供追溯）。
hotpatch_record_change() {
  local file="$1"
  local target_path="$2"   # 容器内路径，仅记录用
  local hash=""
  if [[ -f "$file" ]]; then
    hash="$(sha256sum "$file" 2>/dev/null | awk '{print $1}')"
  fi
  {
    echo "time=$(date -Iseconds) container=${CONTAINER:-?} src=${file} dst=${target_path} sha256=${hash:-n/a} marker=${HOTPATCH_MARKER}"
  } >> "$HOTPATCH_CHANGES_FILE"
}
