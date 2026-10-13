#!/usr/bin/env bash
# 构建并发布三件套镜像到 Docker Hub 的 agentmemory namespace。
#
# 本脚本是**自包含**的：只依赖仓库里的 Dockerfile、
# deploy/panel-knowledge-combined/build.sh 和 MemoryPanel/scripts/secret-scan.sh，
# 不引用任何内网专用的构建工具，可以原样放到开源分支。
#
# 组件与镜像名：
#   memory-core   MemoryCore/                        → agentmemory/memory-core
#   memory-proxy  MemoryProxy/                       → agentmemory/memory-proxy
#   memory-hub    MemoryPanel/ + MemoryKnowledge/    → agentmemory/memory-hub
#
# 用法（VERSION 必填，避免误发浮动 tag）：
#   VERSION=1.0.0 ./publish.sh all
#   VERSION=1.0.0 ./publish.sh memory-core
#   DRY_RUN=1 VERSION=1.0.0 ./publish.sh all      # 只跑 secret-scan + 备 context
#   PUSH=0 VERSION=1.0.0 ./publish.sh memory-core # 本地单架构 --load，不推送
#
# 常用环境变量：
#   NAMESPACE=agentmemory          目标 namespace
#   PLATFORMS=linux/amd64,linux/arm64
#   ALSO_LATEST=1                  同时推 :latest
#   APT_MIRROR=mirrors.tencent.com 构建期 apt 加速（默认走 Debian 官方源）

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WORKSPACE_ROOT="$(dirname "$REPO_ROOT")"

REGISTRY="${REGISTRY:-docker.io}"
NAMESPACE="${NAMESPACE:-agentmemory}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
BUILDER="${BUILDER:-multiarch}"
PUSH="${PUSH:-1}"
ALSO_LATEST="${ALSO_LATEST:-0}"
DRY_RUN="${DRY_RUN:-0}"
KEEP_CTX="${KEEP_CTX:-0}"
APT_MIRROR="${APT_MIRROR:-deb.debian.org}"
LOAD_PLATFORM="${LOAD_PLATFORM:-linux/amd64}"
SECRET_SCAN="${SECRET_SCAN:-$REPO_ROOT/MemoryPanel/scripts/secret-scan.sh}"

if [[ -t 1 ]]; then
  C_GRN=$'\033[32m'; C_YLW=$'\033[33m'; C_RED=$'\033[31m'; C_BLU=$'\033[34m'; C_RST=$'\033[0m'
else
  C_GRN=""; C_YLW=""; C_RED=""; C_BLU=""; C_RST=""
fi
info() { echo "${C_BLU}[$(date +%H:%M:%S)]${C_RST} $*"; }
ok()   { echo "${C_GRN}[ok]${C_RST} $*"; }
warn() { echo "${C_YLW}[warn]${C_RST} $*" >&2; }
die()  { echo "${C_RED}[error]${C_RST} $*" >&2; exit 1; }

usage() { sed -n '2,26p' "$0"; exit 1; }

# ── 参数校验 ────────────────────────────────────────────────────────
TARGET="${1:-}"
case "$TARGET" in
  memory-core|memory-proxy|memory-hub|all) ;;
  -h|--help|"") usage ;;
  *) die "未知组件: $TARGET（可选 memory-core | memory-proxy | memory-hub | all）" ;;
esac

[[ -n "${VERSION:-}" ]] || die "请显式指定 VERSION，例：VERSION=1.0.0 ./publish.sh $TARGET"
[[ "$VERSION" == dev-* ]] && die "VERSION 不能以 dev- 开头（避免把开发 tag 推上公网）"

if [[ "${DRY_RUN:-0}" != "1" ]]; then
  command -v docker >/dev/null || die "需要 docker"
fi
command -v rsync  >/dev/null || die "需要 rsync"
[[ -f "$SECRET_SCAN" ]] || die "secret-scan 脚本不存在: $SECRET_SCAN"

# ── 通用步骤 ────────────────────────────────────────────────────────
scan() {
  local dir="$1"; shift
  info "secret-scan: $dir"
  ( cd "$dir" && bash "$SECRET_SCAN" "$@" )
}

ensure_builder() {
  if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
    info "创建 buildx builder: $BUILDER"
    docker buildx create --name "$BUILDER" --driver docker-container >/dev/null
  fi
  docker buildx inspect "$BUILDER" --bootstrap >/dev/null
}

# build_image <image> <context_dir>
# PUSH=1 → 多架构 buildx --push；PUSH=0 → 单架构 --load 供本地抽查。
build_image() {
  local image="$1" ctx="$2"

  if [[ "$PUSH" != "1" ]]; then
    info "PUSH=0 → 本地构建 ${image}:${VERSION} ($LOAD_PLATFORM)"
    docker buildx build \
      --builder "$BUILDER" \
      --platform "$LOAD_PLATFORM" \
      --build-arg "APT_MIRROR=$APT_MIRROR" \
      -t "${image}:${VERSION}" \
      --load \
      "$ctx"
    spot_check "${image}:${VERSION}"
    ok "本地镜像就绪: ${image}:${VERSION}（未推送）"
    return 0
  fi

  local tags=(-t "${image}:${VERSION}")
  [[ "$ALSO_LATEST" == "1" ]] && tags+=(-t "${image}:latest")

  info "buildx --push ${image}:${VERSION} ($PLATFORMS)"
  docker buildx build \
    --builder "$BUILDER" \
    --platform "$PLATFORMS" \
    --build-arg "APT_MIRROR=$APT_MIRROR" \
    "${tags[@]}" \
    --push \
    "$ctx"
  ok "已推送 ${image}:${VERSION}"
  # 用 if 而非 `[[ ]] && ok`：后者作为函数最后一条语句时，条件为假会让函数返回 1，
  # 在 set -e 下会静默中断整个 all 流程。
  if [[ "$ALSO_LATEST" == "1" ]]; then
    ok "已推送 ${image}:latest"
  fi
}

# 抽查镜像文件系统里有没有混进敏感文件
spot_check() {
  local image="$1" cid
  cid=$(docker create "$image")
  # shellcheck disable=SC2064
  trap "docker rm -f '$cid' >/dev/null 2>&1 || true" RETURN
  if docker export "$cid" | tar -t 2>/dev/null \
      | grep -E '(/\.env$|metadata-instances\.json|/\.admin-key$)'; then
    die "镜像内出现疑似敏感文件，中止"
  fi
  ok "镜像抽查通过: $image"
}

# ── memory-core ─────────────────────────────────────────────────────
# MemoryCore/.dockerignore 已排除测试、文档、私有 submodule、真值 yaml，
# 因此直接以源目录为 build context，无需额外清理步骤。
build_memory_core() {
  local image="${REGISTRY}/${NAMESPACE}/memory-core"
  [[ "$REGISTRY" == "docker.io" ]] && image="${NAMESPACE}/memory-core"
  local src="$REPO_ROOT/MemoryCore"

  info "═══ memory-core → ${image}:${VERSION} ═══"
  [[ -f "$src/Dockerfile" ]] || die "缺少 $src/Dockerfile"
  scan "$src" src package.json openclaw.plugin.json

  if [[ "$DRY_RUN" == "1" ]]; then
    ok "DRY_RUN=1 → 跳过 build/push"
    return 0
  fi
  build_image "$image" "$src"
}

# ── memory-proxy ────────────────────────────────────────────────────
# Build a clean public context from source and the committed lockfile.
build_memory_proxy() {
  local image="${REGISTRY}/${NAMESPACE}/memory-proxy"
  [[ "$REGISTRY" == "docker.io" ]] && image="${NAMESPACE}/memory-proxy"
  local src="$REPO_ROOT/MemoryProxy"
  local ctx="${CTX_DIR:-$WORKSPACE_ROOT/dockerhub-memory-proxy-ctx}"

  info "═══ memory-proxy → ${image}:${VERSION} ═══"
  [[ -f "$src/Dockerfile" ]] || die "缺少 $src/Dockerfile"
  scan "$src" src package.json

  [[ "$KEEP_CTX" == "1" ]] || rm -rf "$ctx"
  mkdir -p "$ctx"
  info "rsync $src → $ctx"
  rsync -a --delete \
    --exclude '.git' \
    --exclude 'node_modules' \
    --exclude 'dist' \
    --exclude 'coverage' \
    --exclude '.env' \
    --exclude '.env.*' \
    --exclude '**/.env' \
    --exclude '**/.env.*' \
    --exclude 'config.yaml' \
    --exclude 'config.*.local.yaml' \
    "$src"/ "$ctx"/


  scan "$ctx" src package.json

  if [[ "$DRY_RUN" == "1" ]]; then
    ok "DRY_RUN=1 → context 就绪在 ${ctx}，跳过 build/push"
    return 0
  fi
  build_image "$image" "$ctx"
  info "context 保留在 $ctx"
}

# ── memory-hub ──────────────────────────────────────────────────────
# 复用 panel-knowledge-combined/build.sh 的 context 准备逻辑（PREPARE_ONLY=1），
# 这里只负责 buildx 推 Docker Hub。
build_memory_hub() {
  local image="${REGISTRY}/${NAMESPACE}/memory-hub"
  [[ "$REGISTRY" == "docker.io" ]] && image="${NAMESPACE}/memory-hub"
  local combined="$REPO_ROOT/deploy/panel-knowledge-combined"
  local ctx="${CTX_DIR:-$WORKSPACE_ROOT/dockerhub-memory-hub-ctx}"

  info "═══ memory-hub → ${image}:${VERSION} ═══"
  [[ -f "$combined/build.sh" ]] || die "缺少 $combined/build.sh"
  scan "$REPO_ROOT/MemoryPanel" src web/src config package.json
  scan "$REPO_ROOT/MemoryKnowledge" src .env.example package.json

  info "准备 context via panel-knowledge-combined/build.sh"
  KEEP_CTX="$KEEP_CTX" PREPARE_ONLY=1 CTX_DIR="$ctx" \
    IMAGE_TAG="scan-$VERSION" bash "$combined/build.sh"

  [[ -f "$ctx/panel/package.json" && -f "$ctx/knowledge/package.json" ]] \
    || die "context 准备失败: $ctx"
  [[ -f "$ctx/knowledge/openapi.yaml" ]] \
    || die "context 缺少 knowledge/openapi.yaml —— Swagger UI 运行时需要它"

  scan "$ctx" panel knowledge Dockerfile start-combined.sh

  if [[ "$DRY_RUN" == "1" ]]; then
    ok "DRY_RUN=1 → context 就绪在 ${ctx}，跳过 build/push"
    return 0
  fi
  build_image "$image" "$ctx"
  info "context 保留在 $ctx"
}

# ── 主流程 ──────────────────────────────────────────────────────────
if [[ "$DRY_RUN" != "1" ]]; then
  ensure_builder
  if [[ "$PUSH" == "1" ]]; then
    docker login "$REGISTRY" >/dev/null 2>&1 \
      || warn "未检测到 $REGISTRY 登录态，push 阶段可能失败（先执行 docker login）"
  fi
fi

case "$TARGET" in
  memory-core)  build_memory_core ;;
  memory-proxy) build_memory_proxy ;;
  memory-hub)   build_memory_hub ;;
  all)
    build_memory_core
    build_memory_proxy
    build_memory_hub
    ;;
esac

echo ""
ok "完成: $TARGET (version=$VERSION)"
if [[ "$PUSH" == "1" && "$DRY_RUN" != "1" ]]; then
  echo "  验证："
  echo "    docker pull ${NAMESPACE}/memory-core:${VERSION}"
  echo "    docker buildx imagetools inspect ${NAMESPACE}/memory-core:${VERSION}"
fi
