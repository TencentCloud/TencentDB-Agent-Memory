#!/usr/bin/env bash
# patch-proxy-thinking-openai.sh
# 修复 TencentDB-Agent-Memory proxy 的 OpenAI 协议 thinking 兼容问题：
#   CodeBuddy CLI（OpenAI 协议 /chat/completions）转发到 DeepSeek reasoning
#   模型时，含 tool_calls 的 assistant 历史消息缺 reasoning_content（thinking
#   回传）→ 上游 400 "The reasoning_content in the thinking mode must be
#   passed back to the API"。
#
# 修复内容（把本地仓库文件同步进容器）：
#   - /app/src/handler.ts：OpenAI 协议转发前对 messages 里含 tool_calls 的
#     assistant 消息补 reasoning_content=""（DeepSeek 接受空值），并把规范化
#     结果写回 upstreamBody（`upstreamBody = norm.body`，旧补丁缺失此行无效）。
#   - /app/src/reasoning/adapter.ts + openai-forward.ts：模型匹配规则——DeepSeek
#     thinking 家族（reasoner / r1 / v4* 如 deepseek-v4-flash / think 字样）
#     才触发回填；其它 provider 不做任何注入。
#
# 说明：Claude Code 的 Anthropic 协议 thinking 问题由
#       patch-proxy-thinking.sh（anthropicHandler.ts）处理，两者互补。
#
# 用法：ALLOW_UNSUPPORTED_HOTPATCH=1 ./patch-proxy-thinking-openai.sh [容器名]（默认 tdai-proxy）
# 注意：容器重建（start-all.sh / start-proxy.sh）会从镜像重新创建容器，
#       补丁会丢失，重建后重新执行本脚本即可（有幂等检测）。
# 946-D：容器内热补丁是 UNSUPPORTED 的临时手段；生产环境禁止（见 guard-hotpatch.sh）。

set -euo pipefail
CONTAINER="${1:-tdai-proxy}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$(cd "$SCRIPT_DIR/../../MemoryProxy/src" && pwd)"
SRC_HANDLER="$SRC_DIR/handler.ts"
SRC_ADAPTER="$SRC_DIR/reasoning/adapter.ts"
SRC_FORWARD="$SRC_DIR/reasoning/openai-forward.ts"

# 946-D guard：显式 ALLOW_UNSUPPORTED_HOTPATCH=1 + 生产环境拒绝 + unsupported warning
# shellcheck source=./guard-hotpatch.sh
source "$SCRIPT_DIR/guard-hotpatch.sh"
hotpatch_check_guard

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "容器 $CONTAINER 未运行，请先启动 proxy"; exit 1
fi

# 幂等检测：新规则要求 adapter.ts 含 v4 匹配（deepseek-v4-flash 等 thinking 模型）。
# 仅检测 handler.ts 的 reasoning_content 会误判旧补丁为已应用（旧补丁缺
# upstreamBody = norm.body 且匹配规则不含 v4，实际不生效）。
if docker exec "$CONTAINER" sh -c "grep -q 'm.includes(\"v4\")' /app/src/reasoning/adapter.ts 2>/dev/null && grep -q 'upstreamBody = norm.body' /app/src/handler.ts 2>/dev/null"; then
  echo "检测到已应用过补丁（handler.ts 回填写回 + adapter.ts v4 匹配均在），跳过。"
  exit 0
fi

echo "正在为容器 $CONTAINER 打 OpenAI thinking 兼容补丁..."
docker cp "$SRC_HANDLER" "$CONTAINER:/app/src/handler.ts"
docker cp "$SRC_ADAPTER" "$CONTAINER:/app/src/reasoning/adapter.ts"
docker cp "$SRC_FORWARD" "$CONTAINER:/app/src/reasoning/openai-forward.ts"
hotpatch_record_change "$SRC_HANDLER" "/app/src/handler.ts"
hotpatch_record_change "$SRC_ADAPTER" "/app/src/reasoning/adapter.ts"
hotpatch_record_change "$SRC_FORWARD" "/app/src/reasoning/openai-forward.ts"
docker restart "$CONTAINER"
echo "补丁已应用并重启容器 $CONTAINER。"
echo "变更记录：$HOTPATCH_CHANGES_FILE"
echo "验证：curl -s -X POST http://127.0.0.1:8096/codebuddy/default/chat/completions ...（含 tool_calls 历史消息）应返回 200 而非 400"
