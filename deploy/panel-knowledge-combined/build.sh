#!/usr/bin/env bash
# 构建 panel + knowledge 合并镜像。
#
# 用法（在 deploy/panel-knowledge-combined/ 下执行）：
#   ./build.sh                              # 用默认路径 + 默认 tag
#   TMC_DIR=/path/to/MemoryPanel ./build.sh # 自定义 panel 源码目录
#   KNOWLEDGE_DIR=/path/to/MemoryKnowledge ./build.sh
#   IMAGE_TAG=my-tag ./build.sh             # 自定义 tag
#   CTX_DIR=/tmp/my-ctx ./build.sh          # 自定义临时 context 目录
#   KEEP_CTX=1 ./build.sh                    # 不清理 context（调试用）
#   PREPARE_ONLY=1 ./build.sh                # 只 rsync context，不 docker build（供 publish.sh）
#
# 默认源码均在本仓库根下：
#   memory-tencentdb/
#   ├── MemoryPanel/                         # panel 后端 + web 前端
#   ├── MemoryKnowledge/                     # knowledge service
#   └── deploy/panel-knowledge-combined/     # 本配方
#
# 输出镜像名：team-memory-panel-knowledge:${TAG}（默认 tag=amd64）

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"          # memory-tencentdb 根
WORKSPACE_ROOT="$(dirname "$REPO_ROOT")"               # 上一级（默认 CTX_DIR 落点）

TMC_DIR="${TMC_DIR:-$REPO_ROOT/MemoryPanel}"
KNOWLEDGE_DIR="${KNOWLEDGE_DIR:-$REPO_ROOT/MemoryKnowledge}"
IMAGE_NAME="${IMAGE_NAME:-team-memory-panel-knowledge}"
IMAGE_TAG="${IMAGE_TAG:-amd64}"
CTX_DIR="${CTX_DIR:-$WORKSPACE_ROOT/panel-knowledge-builder}"
KEEP_CTX="${KEEP_CTX:-0}"
PREPARE_ONLY="${PREPARE_ONLY:-0}"
PLATFORM="${PLATFORM:-linux/amd64}"
EVALUATION_BUNDLE_DIR="${EVALUATION_BUNDLE_DIR:-$TMC_DIR/evaluation-bundles}"
EVALUATION_BUNDLE_PATH="${EVALUATION_BUNDLE_PATH:-$EVALUATION_BUNDLE_DIR/recorded-e1.json}"
EVALUATION_BUNDLE_PIN_PATH="${EVALUATION_BUNDLE_PIN_PATH:-$EVALUATION_BUNDLE_DIR/recorded-e1.sha256}"
EVALUATION_BUNDLE_MAX_BYTES="${EVALUATION_BUNDLE_MAX_BYTES:-10485760}"

err() { echo "[build-combined] error: $*" >&2; exit 1; }

[[ -d "$TMC_DIR/package.json" || -f "$TMC_DIR/package.json" ]] \
  || err "MemoryPanel 不在 $TMC_DIR（设 TMC_DIR=<path> 指定）"
[[ -f "$KNOWLEDGE_DIR/package.json" ]] \
  || err "MemoryKnowledge 不在 $KNOWLEDGE_DIR（设 KNOWLEDGE_DIR=<path> 指定）"
[[ -f "$SCRIPT_DIR/Dockerfile" ]] || err "Dockerfile 不在 $SCRIPT_DIR"
[[ -f "$SCRIPT_DIR/start-combined.sh" ]] || err "start-combined.sh 不在 $SCRIPT_DIR"
[[ -f "$SCRIPT_DIR/verify-evaluation-assets.sh" ]] || err "verify-evaluation-assets.sh 不在 $SCRIPT_DIR"

verify_regular_asset() {
  local file="$1" label="$2" max_bytes="$3"
  [[ -f "$file" && ! -L "$file" ]] || err "$label 必须是非 symlink regular file: $file"
  local size
  size=$(wc -c < "$file" | tr -d ' ')
  [[ "$size" =~ ^[0-9]+$ && "$size" -le "$max_bytes" ]] || err "$label 超过大小门禁: $size > $max_bytes"
}

verify_regular_asset "$EVALUATION_BUNDLE_PATH" "evaluation bundle" "$EVALUATION_BUNDLE_MAX_BYTES"
verify_regular_asset "$EVALUATION_BUNDLE_PIN_PATH" "evaluation pin" 256
EXPECTED_PIN=$(tr -d '\r\n' < "$EVALUATION_BUNDLE_PIN_PATH")
[[ "$EXPECTED_PIN" =~ ^sha256:[a-f0-9]{64}$ ]] || err "evaluation pin 格式无效"
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_HEX=$(sha256sum "$EVALUATION_BUNDLE_PATH" | awk '{print $1}')
else
  ACTUAL_HEX=$(shasum -a 256 "$EVALUATION_BUNDLE_PATH" | awk '{print $1}')
fi
[[ "sha256:$ACTUAL_HEX" == "$EXPECTED_PIN" ]] || err "evaluation bundle 与外部 pin 不一致"
EVALUATION_BUNDLE_EXPECTED_SHA256="$EXPECTED_PIN"

echo "[build-combined] panel  (MemoryPanel): $TMC_DIR"
echo "[build-combined] knowledge:            $KNOWLEDGE_DIR"
echo "[build-combined] context dir:                 $CTX_DIR"
echo "[build-combined] image:                       $IMAGE_NAME:$IMAGE_TAG"
echo ""

# 清理旧 context（KEEP_CTX=1 时跳过）
if [[ "$KEEP_CTX" == "1" ]]; then
  echo "[build-combined] KEEP_CTX=1 → 保留旧 context"
else
  rm -rf "$CTX_DIR"
fi
mkdir -p "$CTX_DIR"

# rsync panel（builder stage 编译需要 src/ + web/ + package*.json + tsconfig.json，
# 排除敏感真值 config/*.json、文档、测试、.claude、docker 配置等非必要文件）
echo "[build-combined] rsync panel → $CTX_DIR/panel/"
rsync -a --delete \
  --exclude .git \
  --exclude node_modules \
  --exclude web/node_modules \
  --exclude dist \
  --exclude build \
  --exclude coverage \
  --exclude data \
  --exclude .claude \
  --exclude .env \
  --exclude .env.* \
  --exclude config/metadata-instances.json \
  --exclude config/*.yaml \
  --exclude config/*.yml \
  --exclude docs/ \
  --exclude tests/ \
  --exclude scripts/ \
  --exclude docker/ \
  --exclude e2e-*.sh \
  --exclude *.md \
  --exclude pnpm-lock.yaml \
  --exclude pnpm-workspace.yaml \
  --exclude vitest.config.ts \
  --exclude evaluation-bundles/ \
  "$TMC_DIR"/ "$CTX_DIR/panel"/

# rsync knowledge（builder stage 编译需要 src/ + package*.json + tsconfig.json + tsdown.config.ts，
# runtime 需要包根的 openapi.yaml（Swagger UI）。排除文档、测试、.claude、docker 配置等）
echo "[build-combined] rsync knowledge → $CTX_DIR/knowledge/"
rsync -a --delete \
  --exclude .git \
  --exclude node_modules \
  --exclude dist \
  --exclude coverage \
  --exclude data \
  --exclude .claude \
  --exclude .env \
  --exclude .env.* \
  --exclude bin/ \
  --exclude docs/ \
  --exclude __tests__/ \
  --exclude docker/ \
  --exclude docker-compose*.yml \
  --exclude Dockerfile \
  --exclude .dockerignore \
  --exclude *.md \
  --exclude pnpm-lock.yaml \
  --exclude vitest.config.ts \
  --exclude start.sh \
  "$KNOWLEDGE_DIR"/ "$CTX_DIR/knowledge"/

# 拷 Dockerfile + start-combined.sh + .dockerignore + README（rsync 已过滤敏感文件，.dockerignore 作兜底）
cp "$SCRIPT_DIR/Dockerfile" "$CTX_DIR"/
cp "$SCRIPT_DIR/start-combined.sh" "$CTX_DIR"/
cp "$SCRIPT_DIR/verify-evaluation-assets.sh" "$CTX_DIR"/
cp "$SCRIPT_DIR/README.md" "$CTX_DIR"/
if [[ -f "$SCRIPT_DIR/.dockerignore" ]]; then
  cp "$SCRIPT_DIR/.dockerignore" "$CTX_DIR"/
fi

# Evaluation 资产是 producer 原始 bytes 的只读副本；不解析、不重序列化。
mkdir -p "$CTX_DIR/evaluation/bundle" "$CTX_DIR/evaluation/pin"
cp "$EVALUATION_BUNDLE_PATH" "$CTX_DIR/evaluation/bundle/evaluation-view-bundle.json"
cp "$EVALUATION_BUNDLE_PIN_PATH" "$CTX_DIR/evaluation/pin/evaluation-view-bundle.sha256"
chmod 0444 "$CTX_DIR/evaluation/bundle/evaluation-view-bundle.json" "$CTX_DIR/evaluation/pin/evaluation-view-bundle.sha256"
EVALUATION_BUNDLE_PATH="$CTX_DIR/evaluation/bundle/evaluation-view-bundle.json" \
EVALUATION_BUNDLE_PIN_PATH="$CTX_DIR/evaluation/pin/evaluation-view-bundle.sha256" \
EVALUATION_BUNDLE_EXPECTED_SHA256="$EVALUATION_BUNDLE_EXPECTED_SHA256" \
  bash "$SCRIPT_DIR/verify-evaluation-assets.sh"

# 镜像 metadata 冻结运行时 authority；runtime 不从同目录 sidecar 获取信任。
sed "s|sha256:1a5083dedc77ecff1d37340661c133176b46528d152ee9e750fcc7571de84bc8|${EVALUATION_BUNDLE_EXPECTED_SHA256}|g" \
  "$CTX_DIR/Dockerfile" > "$CTX_DIR/.Dockerfile.evaluation.tmp"
mv "$CTX_DIR/.Dockerfile.evaluation.tmp" "$CTX_DIR/Dockerfile"

if [[ "$PREPARE_ONLY" == "1" ]]; then
  echo ""
  echo "[build-combined] PREPARE_ONLY=1 → context 已就绪: $CTX_DIR"
  exit 0
fi

# build
echo "[build-combined] docker build --platform $PLATFORM -t $IMAGE_NAME:$IMAGE_TAG $CTX_DIR"
docker build --platform "$PLATFORM" -t "$IMAGE_NAME:$IMAGE_TAG" "$CTX_DIR"

echo ""
echo "[build-combined] ✅ done: $IMAGE_NAME:$IMAGE_TAG"
echo "[build-combined] context 保留在 $CTX_DIR（KEEP_CTX=0 时下次会清掉）"
