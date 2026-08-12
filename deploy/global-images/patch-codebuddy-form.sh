#!/usr/bin/env bash
# patch-codebuddy-form.sh
# 修复 TencentDB-Agent-Memory proxy 的 CodeBuddy 表单工具名/格式不兼容问题：
#   proxy 原写死 `ask_followup_question`（CodeBuddy IDE 插件工具名），而
#   CodeBuddy CLI（@tencent-ai/codebuddy-code）的内置交互工具是
#   `AskUserQuestion`（与 Claude Code 同名），导致 CLI 报
#   "Tool ask_followup_question does not exist in the current tool set"，
#   无法弹出 Team / Agent / Task 选择表单。
#
# 修复内容（把本地仓库源码同步进容器 /app/src/session/codebuddy/）：
#   1) form.ts      : TOOL_NAME 改为 "AskUserQuestion"，参数格式改为
#                     { questions: [{question, header, options:[{label,description}], multiSelect}] }
#   2) extractor.ts : 增加 AskUserQuestion / multi_question_result JSON 回写解析
#                     （原实现只解析旧 XML <question_answer>，靠 substring 碰巧匹配）
#
# 用法：ALLOW_UNSUPPORTED_HOTPATCH=1 ./patch-codebuddy-form.sh [容器名]（默认 tdai-proxy）
# 注意：容器重建（start-all.sh / start-proxy.sh）会从镜像重新创建容器，
#       补丁会丢失，重建后重新执行本脚本即可（有幂等检测）。
# 946-D：容器内热补丁是 UNSUPPORTED 的临时手段；生产环境禁止（见 guard-hotpatch.sh）。
set -euo pipefail
CONTAINER="${1:-tdai-proxy}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$(cd "$SCRIPT_DIR/../../MemoryProxy/src/session/codebuddy" && pwd)"

# 946-D guard：显式 ALLOW_UNSUPPORTED_HOTPATCH=1 + 生产环境拒绝 + unsupported warning
# shellcheck source=./guard-hotpatch.sh
source "$SCRIPT_DIR/guard-hotpatch.sh"
hotpatch_check_guard

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "容器 $CONTAINER 未运行，请先启动 proxy"; exit 1
fi

if docker exec "$CONTAINER" sh -c "grep -q 'TOOL_NAME = \"AskUserQuestion\"' /app/src/session/codebuddy/form.ts 2>/dev/null"; then
  echo "检测到已应用过补丁（form.ts 已含 AskUserQuestion），跳过。"
  exit 0
fi

echo "正在为容器 $CONTAINER 打 CodeBuddy 表单兼容补丁..."
docker cp "$SRC_DIR/form.ts"      "$CONTAINER:/app/src/session/codebuddy/form.ts"
docker cp "$SRC_DIR/extractor.ts" "$CONTAINER:/app/src/session/codebuddy/extractor.ts"
hotpatch_record_change "$SRC_DIR/form.ts"      "/app/src/session/codebuddy/form.ts"
hotpatch_record_change "$SRC_DIR/extractor.ts" "/app/src/session/codebuddy/extractor.ts"
docker restart "$CONTAINER"
echo "补丁已应用并重启容器 $CONTAINER。"
echo "变更记录：$HOTPATCH_CHANGES_FILE"
echo "验证：curl -s -X POST http://127.0.0.1:8096/codebuddy/default/chat/completions ... 应返回 AskUserQuestion tool_call"
