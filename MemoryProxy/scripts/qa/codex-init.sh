#!/usr/bin/env bash
# codex-init.sh —— 用 curl 走完 Codex 5-step session-init form，
# 得到 initialized session。用法：
#   ./codex-init.sh                       # 走完整流程，SID 自动生成
#   ./codex-init.sh --sid <uuid>          # 指定 SID
#   ./codex-init.sh --bypass              # 只走 asset_confirm 选"否" → bypassed session
#   ./codex-init.sh --team memory --agent "开发大师" --task "接入e2e联合评测"
# 结果 SID 打在最后一行，也写 /tmp/codex-qa-sid.env

set -uo pipefail
# 注意：不用 set -e，因为 send_form_answer 里的 awk exit 会让 curl 收 SIGPIPE 返 141

BASE="${BASE:?BASE required, e.g. BASE=http://127.0.0.1:8096}"
USER_KEY="${USER_KEY:?USER_KEY required (sk-mem-* / ck_* from MemoryPanel)}"
SPACE="${SPACE:-default}"
SID=""
TEAM="memory"          # 默认选第一个 team
AGENT="开发大师"        # 默认选一个 agent
TASK=""                # 空则选第一个非"更多"的 task
MODE="full"            # full | bypass

# 参数解析
while (( "$#" )); do
  case "$1" in
    --sid)    SID="$2"; shift 2;;
    --team)   TEAM="$2"; shift 2;;
    --agent)  AGENT="$2"; shift 2;;
    --task)   TASK="$2"; shift 2;;
    --bypass) MODE="bypass"; shift;;
    --space)  SPACE="$2"; shift 2;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

[[ -z "$SID" ]] && SID="$(cat /proc/sys/kernel/random/uuid)"

echo "SID=$SID  MODE=$MODE  SPACE=$SPACE" >&2

# 通用 helper: 发一个 turn, capture call_id, print event.name summary
call_id_of() {
  grep -oP 'call_codex_session_init_\d+' | head -1
}

send_first_turn() {
  # ⚠️ input[i] 必须带 type:"message"，否则 codexAdapter.extractUserText
  # (agent-adapters/codex.ts:88) 返 null，mem: 命令一律无法拦截。
  curl -sS -N -X POST "$BASE/codex/$SPACE/responses" \
    -H "authorization: Bearer $USER_KEY" \
    -H "session-id: $SID" \
    -H 'content-type: application/json' --max-time 15 \
    -d '{"model":"deepseek-v4-pro","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}],"stream":true}'
}

send_form_answer() {
  local call_id="$1" answer="$2"
  # 早退：读到 response.completed 立即中断（curl 会 SIGPIPE 出，不影响返回内容）
  set +e
  curl -sS -N -X POST "$BASE/codex/$SPACE/responses" \
    -H "authorization: Bearer $USER_KEY" \
    -H "session-id: $SID" \
    -H 'content-type: application/json' --max-time 60 \
    -d "$(jq -cn --arg cid "$call_id" --arg ans "$answer" \
      '{model:"deepseek-v4-pro",input:[{type:"function_call_output",call_id:$cid,output:$ans}],stream:true}')" \
    2>/dev/null | awk '/response.completed/ {print; exit} {print}'
  set -e
}

# 从响应中拿 form 的第一个 question 的 label 列表
# arguments 里 label 是 \"escaped\"，用 python 抠出来
extract_options() {
  python3 -c '
import sys, json, re
data = sys.stdin.read()
labels = re.findall(r"\\\"label\\\":\\\"([^\\\\\"]+)\\\"", data)
seen = set()
for l in labels:
    if l not in seen:
        seen.add(l); print(l)
'
}

extract_stage() {
  python3 -c '
import sys, re
data = sys.stdin.read()
m = re.search(r"\\\"id\\\":\\\"(asset_confirm|team|agent_task|agent_select|task_select|team_select)\\\"", data)
print(m.group(1) if m else "")
'
}

# ── Step 1: asset_confirm ──────────────────────────────────────────────
echo "=== step1: asset_confirm ===" >&2
R1="$(send_first_turn)"
CID1="$(echo "$R1" | call_id_of)"
[[ -z "$CID1" ]] && { echo "ERR: no call_id from step1"; echo "$R1" | head -c 2000; exit 1; }
echo "  call_id=$CID1  stage=$(echo "$R1" | extract_stage)" >&2

if [[ "$MODE" == "bypass" ]]; then
  R2="$(send_form_answer "$CID1" "否，本次不关联")"
  echo "  BYPASSED" >&2
  echo "$SID"
  echo "SID=$SID BYPASSED=1" > /tmp/codex-qa-sid.env
  exit 0
fi

R2="$(send_form_answer "$CID1" "是，关联团队资产")"
CID2="$(echo "$R2" | call_id_of)"
STAGE2="$(echo "$R2" | extract_stage)"
echo "  step2 stage=$STAGE2 call_id=$CID2" >&2
if [[ -z "$CID2" ]]; then
  echo "ERR: no call_id from step2 (asset_confirm=yes)"
  echo "$R2" | head -c 2000; exit 1
fi

# ── Step 2: team ──────────────────────────────────────────────
# team 选项形如 "memory (uyb7sion)"，需要匹配包含 $TEAM 的 label
TEAM_OPTS="$(echo "$R2" | extract_options)"
TEAM_LABEL="$(echo "$TEAM_OPTS" | grep -F "$TEAM" | head -1)"
[[ -z "$TEAM_LABEL" ]] && { echo "ERR: team '$TEAM' not in options: $TEAM_OPTS"; exit 1; }
echo "  picking team: $TEAM_LABEL" >&2

R3="$(send_form_answer "$CID2" "$TEAM_LABEL")"
CID3="$(echo "$R3" | call_id_of)"
STAGE3="$(echo "$R3" | extract_stage)"
echo "  step3 stage=$STAGE3 call_id=$CID3" >&2

# ── Step 3: agent (可能 stage=agent_task 合并页 or agent_select) ─────
AGENT_OPTS="$(echo "$R3" | extract_options)"
AGENT_LABEL="$(echo "$AGENT_OPTS" | grep -F "$AGENT" | head -1)"
if [[ -z "$AGENT_LABEL" ]]; then
  # fallback：取第一个非"更多"的选项
  AGENT_LABEL="$(echo "$AGENT_OPTS" | grep -v -F "更多..." | head -1)"
fi
echo "  picking agent: $AGENT_LABEL" >&2

R4="$(send_form_answer "$CID3" "$AGENT_LABEL")"
CID4="$(echo "$R4" | call_id_of)"
STAGE4="$(echo "$R4" | extract_stage)"
echo "  step4 stage=$STAGE4 call_id=$CID4" >&2

# ── Step 4+: task select（可能翻页几次） ──────────────────────────────
# 循环退出 = CID4 空（form 结束）或 stage 不是 task 相关
while [[ -n "$CID4" ]] && [[ "$STAGE4" == "task_select" || "$STAGE4" == "agent_task" ]]; do
  TASK_OPTS="$(echo "$R4" | extract_options)"
  # 如果没指定 TASK，选第一个非"更多..."的
  if [[ -n "$TASK" ]]; then
    PICK="$(echo "$TASK_OPTS" | grep -F "$TASK" | head -1)"
  else
    PICK="$(echo "$TASK_OPTS" | grep -v -F "更多..." | head -1)"
  fi
  if [[ -z "$PICK" ]]; then
    # 没匹配到，翻页
    if echo "$TASK_OPTS" | grep -qF "更多..."; then
      PICK="$(echo "$TASK_OPTS" | grep -F "更多..." | head -1)"
      echo "  paginate: $PICK" >&2
    else
      echo "ERR: task '$TASK' not found, no more pages"
      exit 1
    fi
  fi
  echo "  picking task: $PICK" >&2
  R4="$(send_form_answer "$CID4" "$PICK")"
  CID4="$(echo "$R4" | call_id_of)"
  STAGE4="$(echo "$R4" | extract_stage)"
  echo "  next stage=$STAGE4 call_id=$CID4" >&2
done

# 到这里应该 initialized 了 —— R4 应该是正常 LLM 回复（response.output_text）
if echo "$R4" | grep -q 'response.completed' && ! echo "$R4" | grep -q 'call_codex_session_init_'; then
  echo "  INITIALIZED ✓" >&2
else
  echo "  WARN: unexpected final response shape" >&2
  echo "$R4" | tail -c 500 >&2
fi

echo "$SID"
echo "SID=$SID BYPASSED=0" > /tmp/codex-qa-sid.env
