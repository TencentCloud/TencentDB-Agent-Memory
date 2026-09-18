#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# setup-offload.sh — Offload 功能一键开启/关闭
# ═══════════════════════════════════════════════════════════════════
#
# 用法:
#   bash setup-offload.sh --enable --user-id <userId> --backend-url <url> [--backend-api-key <key>]
#   bash setup-offload.sh --disable
#   bash setup-offload.sh --status
#
# 开启流程:
#   1. 前置检查（openclaw.json 存在、openclaw 已安装）
#   2. Patch 校验 & 执行（after_tool_call messages 注入）— 失败则终止
#   3. 设置 plugins.slots.contextEngine
#   4. 设置 offload.enabled + backendUrl + userId [+ backendApiKey]
#   5. 设置 compaction.mode = safeguard
#
# 关闭流程:
#   1. 设置 offload.enabled = false
#   2. 删除 plugins.slots.contextEngine（清理 slot 占用）
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

# ── 颜色 ──
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
fail()  { echo -e "${RED}[FAIL]${NC}  $*" >&2; exit 1; }

# ── 常量 ──
OPENCLAW_JSON="${HOME}/.openclaw/openclaw.json"
PLUGIN_ID="memory-tencentdb"
CONTEXT_ENGINE_ID="memory-tencentdb"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATCH_SCRIPT="${SCRIPT_DIR}/openclaw-after-tool-call-messages.patch.sh"

# ── 参数解析 ──
MODE=""
USER_ID=""
BACKEND_URL=""
BACKEND_API_KEY=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --enable)   MODE="enable"; shift ;;
        --disable)  MODE="disable"; shift ;;
        --status)   MODE="status"; shift ;;
        --user-id)  USER_ID="$2"; shift 2 ;;
        --backend-url) BACKEND_URL="$2"; shift 2 ;;
        --backend-api-key) BACKEND_API_KEY="$2"; shift 2 ;;
        -h|--help)
            echo "用法:"
            echo "  bash setup-offload.sh --enable --user-id <userId> --backend-url <url> [--backend-api-key <key>]"
            echo "  bash setup-offload.sh --disable"
            echo "  bash setup-offload.sh --status"
            echo ""
            echo "参数:"
            echo "  --user-id         (必填) 用户 ID"
            echo "  --backend-url     (必填) offload 后端地址，如 http://1.2.3.4:8080"
            echo "  --backend-api-key (可选) 后端 API 认证 token"
            exit 0
            ;;
        *) fail "未知参数: $1" ;;
    esac
done

[[ -z "$MODE" ]] && fail "请指定模式: --enable / --disable / --status"

# ═══════════════════════════════════════════════════════════════════
# 公共函数
# ═══════════════════════════════════════════════════════════════════

check_openclaw_json() {
    if [[ ! -f "$OPENCLAW_JSON" ]]; then
        fail "openclaw.json 不存在: $OPENCLAW_JSON"
    fi
    # 验证 JSON 格式
    python3 -c "import json; json.load(open('$OPENCLAW_JSON'))" 2>/dev/null \
        || fail "openclaw.json 格式错误"
}

backup_config() {
    local bak="${OPENCLAW_JSON}.bak.$(date +%Y%m%d_%H%M%S)"
    cp "$OPENCLAW_JSON" "$bak"
    info "配置已备份: $bak"
}

# ═══════════════════════════════════════════════════════════════════
# --status: 显示当前配置状态
# ═══════════════════════════════════════════════════════════════════
show_status() {
    check_openclaw_json
    python3 -c "
import json

with open('$OPENCLAW_JSON') as f:
    cfg = json.load(f)

# Context Engine Slot
slot = cfg.get('plugins', {}).get('slots', {}).get('contextEngine', '(未设置)')
print(f'  Context Engine Slot: {slot}')

# Offload config
offload = cfg.get('plugins', {}).get('entries', {}).get('$PLUGIN_ID', {}).get('config', {}).get('offload', {})
enabled = offload.get('enabled', False)
backend = offload.get('backendUrl', '(未设置)')
user_id = offload.get('userId', '(未设置)')
api_key = offload.get('backendApiKey', '')
timeout = offload.get('backendTimeoutMs', '(默认)')
mild = offload.get('mildOffloadRatio', '(默认 0.5)')
agg = offload.get('aggressiveCompressRatio', '(默认 0.85)')

status_icon = '✅ 已开启' if enabled else '❌ 已关闭'
api_key_display = f'{api_key[:8]}...' if api_key and len(api_key) > 8 else (api_key or '(未设置)')
print(f'  Offload 状态: {status_icon}')
print(f'  Backend URL:  {backend}')
print(f'  Backend Key:  {api_key_display}')
print(f'  User ID:      {user_id}')
print(f'  Timeout:      {timeout}ms')
print(f'  Mild Ratio:   {mild}')
print(f'  Aggressive:   {agg}')

# Compaction mode
compaction = cfg.get('agents', {}).get('defaults', {}).get('compaction', {}).get('mode', '(未设置)')
print(f'  Compaction:   {compaction}')
"
}

# ═══════════════════════════════════════════════════════════════════
# --enable: 开启 offload
# ═══════════════════════════════════════════════════════════════════
enable_offload() {
    # 参数校验
    [[ -z "$USER_ID" ]] && fail "缺少 --user-id 参数"
    [[ -z "$BACKEND_URL" ]] && fail "缺少 --backend-url 参数"

    # URL 格式基本校验
    if [[ ! "$BACKEND_URL" =~ ^https?:// ]]; then
        fail "backendUrl 格式错误，应以 http:// 或 https:// 开头: $BACKEND_URL"
    fi

    check_openclaw_json
    backup_config

    echo ""
    info "${BOLD}[1/4] Patch 校验${NC}"

    # ── Step 1: 调用 patch 脚本（幂等，已 patch 过会跳过） ──
    # patch 脚本自带精确的幂等检测，通过退出码判断结果：
    #   0 = 成功（新 patch 或已跳过）
    #   1 = 失败（无法 patch）
    if [[ -f "$PATCH_SCRIPT" ]]; then
        info "执行 patch 脚本..."
        local patch_exit=0
        local patch_output
        patch_output=$(bash "$PATCH_SCRIPT" 2>&1) || patch_exit=$?

        # 显示 patch 脚本输出（缩进）
        while IFS= read -r line; do
            echo "  $line"
        done <<< "$patch_output"

        if [[ $patch_exit -eq 0 ]]; then
            ok "Patch 校验通过"
        else
            echo ""
            echo -e "${RED}═══════════════════════════════════════════════════${NC}"
            echo -e "${RED}  ❌ Patch 失败（退出码: $patch_exit）${NC}"
            echo -e "${RED}═══════════════════════════════════════════════════${NC}"
            echo ""
            echo -e "  ${RED}after_tool_call hook 无法获取 session messages，${NC}"
            echo -e "  ${RED}offload L1/L3 压缩将无法正常工作。${NC}"
            echo ""
            echo -e "  ${CYAN}排查步骤:${NC}"
            echo -e "    1. DEBUG=1 bash $PATCH_SCRIPT"
            echo -e "    2. 检查 openclaw 版本是否兼容"
            echo ""
            exit 2
        fi
    else
        echo -e "${RED}[FAIL]${NC}  Patch 脚本不存在: $PATCH_SCRIPT" >&2
        echo -e "  ${RED}offload 功能依赖此 patch，终止开启流程。${NC}" >&2
        exit 2
    fi

    # ── Step 2: 设置 context engine slot ──
    echo ""
    info "${BOLD}[2/4] 设置 Context Engine Slot${NC}"

    python3 -c "
import json

with open('$OPENCLAW_JSON') as f:
    cfg = json.load(f)

# 确保 plugins.slots 存在
cfg.setdefault('plugins', {}).setdefault('slots', {})
cfg['plugins']['slots']['contextEngine'] = '$CONTEXT_ENGINE_ID'
print('  slots.contextEngine = $CONTEXT_ENGINE_ID')

with open('$OPENCLAW_JSON', 'w') as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
    f.write('\n')
"
    ok "Context Engine Slot 已设置"

    # ── Step 3: 设置 offload 配置 ──
    echo ""
    info "${BOLD}[3/4] 设置 Offload 配置${NC}"

    python3 -c "
import json

with open('$OPENCLAW_JSON') as f:
    cfg = json.load(f)

# 确保路径存在
entry = cfg.setdefault('plugins', {}).setdefault('entries', {}).setdefault('$PLUGIN_ID', {})
config = entry.setdefault('config', {})
offload = config.setdefault('offload', {})

# 设置必要配置
offload['enabled'] = True
offload['backendUrl'] = '$BACKEND_URL'
offload['userId'] = '$USER_ID'
offload.setdefault('backendTimeoutMs', 120000)

api_key = '$BACKEND_API_KEY'
if api_key:
    offload['backendApiKey'] = api_key
    print(f'  offload.backendApiKey = {api_key[:8]}...' if len(api_key) > 8 else f'  offload.backendApiKey = {api_key}')
elif 'backendApiKey' in offload:
    del offload['backendApiKey']

print('  offload.enabled = true')
print('  offload.backendUrl = $BACKEND_URL')
print('  offload.userId = $USER_ID')
print(f'  offload.backendTimeoutMs = {offload[\"backendTimeoutMs\"]}')

with open('$OPENCLAW_JSON', 'w') as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
    f.write('\n')
"
    ok "Offload 配置已设置"

    # ── Step 4: 设置 compaction mode ──
    echo ""
    info "${BOLD}[4/4] 设置 Compaction Mode${NC}"

    python3 -c "
import json

with open('$OPENCLAW_JSON') as f:
    cfg = json.load(f)

defaults = cfg.setdefault('agents', {}).setdefault('defaults', {})
compaction = defaults.setdefault('compaction', {})
old_mode = compaction.get('mode', '(未设置)')
compaction['mode'] = 'safeguard'
print(f'  compaction.mode: {old_mode} → safeguard')

with open('$OPENCLAW_JSON', 'w') as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
    f.write('\n')
"
    ok "Compaction mode 已设置为 safeguard"

    # ── 完成 ──
    echo ""
    echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}  ✅ Offload 已开启${NC}"
    echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
    echo ""
    show_status
    echo ""
    echo -e "  ${CYAN}提示: 需要重启 gateway 才能生效${NC}"
    echo -e "  ${CYAN}  bash install-plugin.sh --restart${NC}"
}

# ═══════════════════════════════════════════════════════════════════
# --disable: 关闭 offload
# ═══════════════════════════════════════════════════════════════════
disable_offload() {
    check_openclaw_json
    backup_config

    python3 -c "
import json

with open('$OPENCLAW_JSON') as f:
    cfg = json.load(f)

# 关闭 offload.enabled（用 setdefault 确保路径存在，修改能回写到 cfg）
entry = cfg.setdefault('plugins', {}).setdefault('entries', {}).setdefault('$PLUGIN_ID', {})
config = entry.setdefault('config', {})
offload = config.setdefault('offload', {})
offload['enabled'] = False
print('  offload.enabled = false')

# 移除 contextEngine slot
plugins = cfg.get('plugins', {})
slots = plugins.get('slots', {})
if 'contextEngine' in slots:
    del slots['contextEngine']
    print('  slots.contextEngine → 已删除')
    # 如果 slots 变空了，也一并移除 slots 键
    if not slots and 'slots' in plugins:
        del plugins['slots']
        print('  plugins.slots → 已清理（空对象）')
else:
    print('  slots.contextEngine → 无需删除（不存在）')

with open('$OPENCLAW_JSON', 'w') as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
    f.write('\n')
"

    echo ""
    echo -e "${YELLOW}═══════════════════════════════════════════════════${NC}"
    echo -e "${YELLOW}  ❌ Offload 已关闭${NC}"
    echo -e "${YELLOW}═══════════════════════════════════════════════════${NC}"
    echo ""
    echo -e "  ${CYAN}提示: 需要重启 gateway 才能生效${NC}"
    echo -e "  ${CYAN}  bash install-plugin.sh --restart${NC}"
}

# ═══════════════════════════════════════════════════════════════════
# 主入口
# ═══════════════════════════════════════════════════════════════════
case "$MODE" in
    enable)  enable_offload ;;
    disable) disable_offload ;;
    status)
        echo ""
        info "${BOLD}Offload 配置状态${NC}"
        show_status
        ;;
esac
