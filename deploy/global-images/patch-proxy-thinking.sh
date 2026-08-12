#!/usr/bin/env bash
# patch-proxy-thinking.sh
# 修复 TencentDB-Agent-Memory proxy 与 DeepSeek 上游的 thinking 兼容问题：
#   Claude Code 新版本发送 thinking:{type:"adaptive"}，DeepSeek 兼容层不识别，
#   且 thinking 模式下要求 tool_use 消息必须带 thinking 块（否则 400
#   "The content[].thinking in the thinking mode must be passed back to the API."）。
#
# 修复内容（写入容器内 /app/src/anthropicHandler.ts，与本地仓库源码同步）：
#   1) hasValidThinkingSignature：放行 UUID 格式 signature（DeepSeek 返回的）
#   2) 转发前把 thinking.type 从 "adaptive" 转为 "enabled"（budget_tokens=16000）
#   3) 转发前给含 tool_use 的 assistant 消息自动补 thinking 块
#
# 用法：ALLOW_UNSUPPORTED_HOTPATCH=1 ./patch-proxy-thinking.sh
# 注意：容器重建（start-all.sh / start-proxy.sh）会从镜像重新创建容器，
#       补丁会丢失，重建后重新执行本脚本即可。
# 946-D：容器内热补丁是 UNSUPPORTED 的临时手段；生产环境禁止（见 guard-hotpatch.sh）。
# 依赖：docker 命令可用；容器名 tdai-proxy。

set -euo pipefail
CONTAINER="${1:-tdai-proxy}"
FILE=/app/src/anthropicHandler.ts
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 946-D guard：显式 ALLOW_UNSUPPORTED_HOTPATCH=1 + 生产环境拒绝 + unsupported warning
# shellcheck source=./guard-hotpatch.sh
source "$SCRIPT_DIR/guard-hotpatch.sh"
hotpatch_check_guard

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "容器 $CONTAINER 未运行，请先启动 proxy"; exit 1
fi

if docker exec "$CONTAINER" sh -c "grep -q 'adaptive' $FILE 2>/dev/null"; then
  echo "检测到已应用过修复（或源码已含 adaptive 处理），跳过。"
  echo "如需强制重打：删除容器内文件中的修复标记后重跑。"
  exit 0
fi

echo "正在为容器 $CONTAINER 打 thinking 兼容补丁..."
docker cp "$CONTAINER:$FILE" /tmp/anthropicHandler.pre-patch.ts

python3 - <<'PYEOF'
src = open('/tmp/anthropicHandler.pre-patch.ts', encoding='utf-8').read()

old_sig = '''function hasValidThinkingSignature(block: Record<string, unknown>): boolean {
  const sig = block.signature;
  if (typeof sig !== "string" || sig.length < 40) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sig)) {
    return false;
  }
  return /^[A-Za-z0-9+/=]+$/.test(sig);
}'''
new_sig = '''function hasValidThinkingSignature(block: Record<string, unknown>): boolean {
  const sig = block.signature;
  if (typeof sig !== "string" || sig.length === 0) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sig)) {
    return true;
  }
  if (sig.length < 40) return false;
  return /^[A-Za-z0-9+/=]+$/.test(sig);
}'''
if old_sig in src:
    src = src.replace(old_sig, new_sig, 1)
    print('patch 1 (UUID signature) applied')
else:
    print('patch 1 skipped: signature function not matched (maybe already patched)')

anchor = '  const { body: upstreamBody, sanitizedCount } = buildUpstreamBody(body, target);'
patch2 = anchor + '''
  try {
    const _ub = upstreamBody as Record<string, any>;
    if (_ub.thinking && Array.isArray(_ub.messages)) {
      if (_ub.thinking?.type === "adaptive") {
        _ub.thinking = { type: "enabled", budget_tokens: 16000 };
      }
      for (const _m of _ub.messages) {
        if (_m?.role === "assistant" && Array.isArray(_m.content)) {
          const _hasTool = _m.content.some((b: any) => b?.type === "tool_use");
          const _hasThk = _m.content.some((b: any) => b?.type === "thinking" || b?.type === "redacted_thinking");
          if (_hasTool && !_hasThk) {
            _m.content.unshift({ type: "thinking", thinking: "" });
          }
        }
      }
    }
  } catch (e) {}'''
if anchor in src and 'adaptive' not in src.split('buildUpstreamBody(body, target);')[1][:400]:
    src = src.replace(anchor, patch2, 1)
    print('patch 2 (adaptive->enabled + backfill thinking) applied')
else:
    print('patch 2 skipped: anchor not matched or already applied')

open('/tmp/anthropicHandler.post-patch.ts', 'w', encoding='utf-8').write(src)
PYEOF

docker cp /tmp/anthropicHandler.post-patch.ts "$CONTAINER:$FILE"
hotpatch_record_change /tmp/anthropicHandler.post-patch.ts "$FILE"
docker restart "$CONTAINER"
echo "补丁已应用并重启容器 $CONTAINER。"
echo "变更记录：$HOTPATCH_CHANGES_FILE"
echo "验证：docker logs $CONTAINER --since 1m | grep -E 'error|ERROR'"
