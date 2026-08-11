#!/usr/bin/env bash
# patch-proxy-thinking-openai.sh
# 修复 TencentDB-Agent-Memory proxy 的 OpenAI 协议 thinking 兼容问题：
#   CodeBuddy CLI（OpenAI 协议 /chat/completions）转发到 DeepSeek reasoning
#   模型时，含 tool_calls 的 assistant 历史消息缺 reasoning_content（thinking
#   回传）→ 上游 400 "The reasoning_content in the thinking mode must be
#   passed back to the API"。
#
# 修复内容（把本地仓库 handler.ts 同步进容器 /app/src/handler.ts）：
#   buildUpstreamBody 中对 messages 里含 tool_calls 的 assistant 消息，
#   若缺 reasoning_content 则补空字符串 ""（DeepSeek 接受空值）。
#
# 说明：Claude Code 的 Anthropic 协议 thinking 问题由
#       patch-proxy-thinking.sh（anthropicHandler.ts）处理，两者互补。
#
# 用法：./patch-proxy-thinking-openai.sh [容器名]（默认 tdai-proxy）
# 注意：容器重建（start-all.sh / start-proxy.sh）会从镜像重新创建容器，
#       补丁会丢失，重建后重新执行本脚本即可（有幂等检测）。

set -euo pipefail
CONTAINER="${1:-tdai-proxy}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_FILE="$(cd "$SCRIPT_DIR/../../MemoryProxy/src" && pwd)/handler.ts"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "容器 $CONTAINER 未运行，请先启动 proxy"; exit 1
fi

if docker exec "$CONTAINER" sh -c "grep -q 'reasoning_content' /app/src/handler.ts 2>/dev/null"; then
  echo "检测到已应用过补丁（handler.ts 已含 reasoning_content 处理），跳过。"
  exit 0
fi

echo "正在为容器 $CONTAINER 打 OpenAI thinking 兼容补丁..."
docker cp "$SRC_FILE" "$CONTAINER:/app/src/handler.ts"
docker restart "$CONTAINER"
echo "补丁已应用并重启容器 $CONTAINER。"
echo "验证：curl -s -X POST http://127.0.0.1:8096/codebuddy/default/chat/completions ...（含 tool_calls 历史消息）应返回 200 而非 400"
