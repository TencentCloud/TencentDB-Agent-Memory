#!/usr/bin/env bash
# 一键拉起 **MongoDB 模式** 三件套（memory-core + memory-hub + proxy）。
#
# 与 start-all.sh 的关系：
#   - start-all.sh 保持原逻辑不变 —— 默认 sqlite，数据落容器卷；
#   - 本脚本复用同一套流程，仅强制 MEMORY_CORE_STORE_MODE=mongodb：
#       · 数据面（L0/L1 记忆、profile、skill）走 MongoDB + mongot 原生 BM25；
#       · 元数据（meta_* 团队/用户/agent/task）默认跟随落同一个 Mongo
#         （MEMORY_CORE_METADATA_BACKEND=auto）；
#       · .env 未设 MONGODB_ENDPOINT 时，自动在同网络起一个本地
#         mongodb-atlas-local 容器（mongod + mongot 一体，卷 mongo-local-* 持久化）。
#
# 用法（与 start-all.sh 完全一致）：
#   ./start-all-mongo.sh            # 交互式引导 LLM，通过后一键起
#   PULL=1 ./start-all-mongo.sh     # 先 docker pull 升级镜像
#
# 想回 sqlite：直接用 ./start-all.sh 即可（.env 里不要显式设 MEMORY_CORE_STORE_MODE）。

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 冲突检测：.env 里若**显式**设置了非 mongodb 的 MEMORY_CORE_STORE_MODE，
# start-all.sh 里 source .env 会盖掉下面的 export，静默跑成别的模式 —— 提前拦下。
# （.env.example 里该行默认注释，标准用户不会触发。）
if [[ -f "$SCRIPT_DIR/.env" ]]; then
  env_mode=$(grep -E '^[[:space:]]*MEMORY_CORE_STORE_MODE=' "$SCRIPT_DIR/.env" \
    | tail -n1 | cut -d= -f2- | tr -d '[:space:]"' || true)
  if [[ -n "$env_mode" && "$env_mode" != "mongodb" ]]; then
    echo "[error] .env 里显式设置了 MEMORY_CORE_STORE_MODE=$env_mode，与本脚本冲突。" >&2
    echo "        二选一：" >&2
    echo "          ① 想用 mongo：注释掉 .env 里该行，重跑本脚本；" >&2
    echo "          ② 想用 $env_mode：直接 ./start-all.sh。" >&2
    exit 1
  fi
fi

export MEMORY_CORE_STORE_MODE=mongodb
echo "[start-all-mongo] 强制 MEMORY_CORE_STORE_MODE=mongodb（数据面 + 元数据默认均落 MongoDB）"

exec "$SCRIPT_DIR/start-all.sh" "$@"
