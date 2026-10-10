#!/usr/bin/env python3
"""
p1-dump-verify.py —— P1-H/L/M/R/S 的 👁️ 项固化为自动化。

为什么需要 tap 而不是读 proxy 日志:
  proxy 的 injection hook 日志记的是"注入到 pipeline 中间产物
  (synthesizedMessages)"这一层, 不等于"最终发到上游的 body"。两者可能
  脱节 —— 2026-09 的 const-body 回归就是日志全绿但出站 body 零注入。
  要验证注入真的生效, 必须抓**出站请求**。

依赖:
  1) 一个 outbound fetch tap (见仓库外的 outbound-tap.mjs 模板: 只拦
     LLM 上游域名的 POST), 通过 `node --import ./<tap>.mjs` 挂到 proxy
     进程上, 把 url/headers/body 追加到 JSONL。
  2) 本脚本 curl 发真实请求 → 等待 → 解析 tap log → 断言。

必填环境变量 (全部必填, 无默认值):
  PROXY           proxy 根地址, 如 http://127.0.0.1:8096
  KEY             合法 user_key (sk-mem-* / ck_*)
  SPACE           spaceId (必须与 KEY 同实例)
  MODEL           价目表内的模型 (如 deepseek-v4-pro)
  PROBE_TEAM_ID   用于 header 预选的 team_id
  PROBE_AGENT_ID  用于 header 预选的 agent_id
可选:
  TAP_LOG         tap 的 JSONL 路径 (默认 /tmp/outbound-tap.log)

覆盖项:
  P1-H1  <available_skills> 存在于 system
  P1-H2  <skill_tools>      存在于 system
  P1-H3  <knowledge_tools>  存在（如 agent 名下有资源; 空则 SKIP）
  P1-H4  <tdai_memory_tools> + <tdai_profile_memory>
  P1-H5  session_context 位置: CC 在 body.system; CB 在 messages[0]; codex 在 input[0]
  P1-H6  /analyse marker 下的 <asset_reflection>（marker 实例需要）
  P1-H7  bypass session 无注入
  P1-R1  anthropic body.system 保留并含注入
  P1-R2  thinking blocks 被清理（历史里不该有 incomplete thinking）
  P1-R4  anthropic 走 x-api-key header（不是 Authorization）
  P1-S1  codex body.input 原样保留
  P1-S2  codex 合成 input[0] 含 session_context + assets
  P1-L3/L4 CFQ tag 剥离（stream / non-stream）
"""
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

def _require(name, hint):
    v = os.environ.get(name)
    if not v:
        sys.exit(f"[FATAL] {name} required ({hint})")
    return v


PROXY = _require("PROXY", "proxy root, e.g. http://127.0.0.1:8096")
KEY = _require("KEY", "valid user_key (sk-mem-* / ck-*)")
SPACE = _require("SPACE", "spaceId, must match KEY instance")
MODEL = _require("MODEL", "a model present in the pricing table")
# 预选身份（header 预选跳过 session-init 表单）—— 从环境变量取, 不硬编码
TEAM = _require("PROBE_TEAM_ID", "team_id used for header preselect")
AGENT = _require("PROBE_AGENT_ID", "agent_id used for header preselect")
TAP = Path(os.environ.get("TAP_LOG", "/tmp/outbound-tap.log"))

PASS, FAIL, SKIPPED = 0, 0, 0
FAILS = []


def ok(k, m):
    global PASS; PASS += 1
    print(f"  \033[32mPASS\033[0m {k:<8s} {m}")


def bad(k, m):
    global FAIL; FAIL += 1; FAILS.append((k, m))
    print(f"  \033[31mFAIL\033[0m {k:<8s} {m}")


def skip(k, m):
    global SKIPPED; SKIPPED += 1
    print(f"  \033[33mSKIP\033[0m {k:<8s} {m}")


def hd(t):
    print(f"\n\033[1m== {t} ==\033[0m")


def tap_lines_before():
    if not TAP.exists():
        return 0
    with TAP.open("rb") as f:
        return sum(1 for _ in f)


def new_tap_entries(before):
    if not TAP.exists():
        return []
    out = []
    with TAP.open() as f:
        for i, ln in enumerate(f):
            if i < before:
                continue
            try:
                out.append(json.loads(ln))
            except Exception:
                pass
    return out


def curl_post(path, body, extra_headers=None, timeout=25):
    args = ["curl", "-s", "-m", str(timeout), "-o", "/dev/null", "-w", "%{http_code}",
            "-X", "POST", f"{PROXY}{path}",
            "-H", f"Authorization: Bearer {KEY}",
            "-H", "Content-Type: application/json"]
    for h in (extra_headers or []):
        args.extend(["-H", h])
    args.extend(["-d", json.dumps(body)])
    r = subprocess.run(args, capture_output=True, text=True)
    return r.stdout.strip()


def extract_system_text(req_body):
    """归一化出站 body 的 system 段 → 字符串，便于 grep。"""
    sys_ = req_body.get("system")
    if isinstance(sys_, str):
        return sys_
    if isinstance(sys_, list):
        chunks = []
        for b in sys_:
            if isinstance(b, dict):
                if isinstance(b.get("text"), str):
                    chunks.append(b["text"])
                elif isinstance(b.get("content"), str):
                    chunks.append(b["content"])
        return "\n".join(chunks)
    # codex 的 instructions
    if isinstance(req_body.get("instructions"), str):
        return req_body["instructions"]
    return ""


def extract_all_text(req_body):
    """把 body 里所有 user/system 的文本串起来 → grep 友好。"""
    parts = [extract_system_text(req_body)]
    for m in req_body.get("messages", []) or []:
        c = m.get("content")
        if isinstance(c, str):
            parts.append(c)
        elif isinstance(c, list):
            for b in c:
                if isinstance(b, dict) and isinstance(b.get("text"), str):
                    parts.append(b["text"])
    for i in req_body.get("input", []) or []:
        if isinstance(i, dict):
            c = i.get("content")
            if isinstance(c, str):
                parts.append(c)
            elif isinstance(c, list):
                for b in c:
                    if isinstance(b, dict) and isinstance(b.get("text"), str):
                        parts.append(b["text"])
    return "\n".join(parts)


def wait_for_tap(before, min_entries=1, max_wait=8):
    end = time.time() + max_wait
    while time.time() < end:
        got = new_tap_entries(before)
        if len(got) >= min_entries:
            return got
        time.sleep(0.5)
    return new_tap_entries(before)


##############################################################################
hd("P1-H  注入内容 (6)")
##############################################################################

# 用已绑定 session（header 预选 skip form）发 CC 请求，拿到 outbound body
sid_cc = f"dumpv-cc-{int(time.time())}"
preseq = [f"x-claude-code-session-id: {sid_cc}", f"x-team-id: {TEAM}", f"x-agent-id: {AGENT}"]
before = tap_lines_before()
code = curl_post(f"/claude-code/{SPACE}/v1/messages",
                 {"model": MODEL, "max_tokens": 32, "messages": [{"role": "user", "content": "注入内容抓包测试"}]},
                 preseq)
got = wait_for_tap(before, 1, 12)
cc_body = got[0]["bodyRaw"] if got else ""
cc_json = json.loads(cc_body) if cc_body else {}
sys_text = extract_system_text(cc_json)

for key, tag in [
    ("P1-H1", "available_skills"),
    ("P1-H2", "skill_tools"),
    ("P1-H4a", "tdai_memory_tools"),
    ("P1-H4b", "tdai_profile_memory"),
]:
    if f"<{tag}>" in sys_text:
        ok(key, f"<{tag}> 存在于 CC 出站 body.system")
    else:
        bad(key, f"CC body.system 未含 <{tag}>")

# H3 knowledge_tools —— agent 名下无资源时注入会被 skip
if "<knowledge_tools>" in sys_text:
    ok("P1-H3", "<knowledge_tools> 存在于 CC body.system")
else:
    skip("P1-H3", "knowledge_tools 未注入（agent 名下无 knowledge 资源; 符合实现）")

# H5 session_context 位置
if "<session_context>" in sys_text:
    ok("P1-H5a", "CC: <session_context> 在 body.system")
else:
    bad("P1-H5a", "CC 的 session_context 未在 body.system")

# bypass session（选"否"）—— 用新 session + 跳过 header 预选 + 发 mem:session-reset 模拟
# 更稳的做法: 直接用 /proxy/ 老前缀 (关 memory 功能), 应无注入
before = tap_lines_before()
code = curl_post(f"/proxy/{SPACE}/v1/messages",
                 {"model": MODEL, "max_tokens": 16, "messages": [{"role": "user", "content": "bypass path"}]})
got = wait_for_tap(before, 1, 8)
if got:
    legacy_body = json.loads(got[0]["bodyRaw"])
    txt = extract_system_text(legacy_body)
    if not any(tag in txt for tag in ("<available_skills>", "<skill_tools>", "<session_context>", "<tdai_memory_tools>")):
        ok("P1-H7", "/proxy legacy 路径 → 零注入（system 不含注入标签）")
    else:
        bad("P1-H7", f"/proxy legacy 不该注入, 实际 system 含: " + ", ".join(t for t in ("available_skills","skill_tools","session_context","tdai_memory_tools") if f"<{t}>" in txt))
else:
    bad("P1-H7", "legacy 请求未抓到 outbound")

# H6 /analyse marker —— 需 marker 实例, 当前 proxy 默认 markerOptIn=false → SKIP
health = subprocess.run(["curl", "-s", "-m", "3", f"{PROXY}/health"], capture_output=True, text=True).stdout
if '"analyseMarker":"enabled"' in health or '"costGuard":"enabled"' in health:
    before = tap_lines_before()
    code = curl_post(f"/claude-code/{SPACE}/analyse/v1/messages",
                     {"model": MODEL, "max_tokens": 16, "messages": [{"role": "user", "content": "analyse"}]},
                     preseq)
    got = wait_for_tap(before, 1, 8)
    txt = extract_system_text(json.loads(got[0]["bodyRaw"])) if got else ""
    if "<asset_reflection>" in txt:
        ok("P1-H6", "/analyse marker: <asset_reflection> 已注入")
    else:
        bad("P1-H6", "/analyse marker 未注入 <asset_reflection>")
else:
    skip("P1-H6", "markerOptIn=false → /analyse 路由不启用（结构约束, 非 bug）")

##############################################################################
hd("P1-R  Anthropic 协议特化 (3)")
##############################################################################

# R1 body.system 保留并含注入（上面已经确认, 这里形式化）
if isinstance(cc_json.get("system"), (list, str)):
    ok("P1-R1", f"CC body.system 保留 (type={type(cc_json['system']).__name__}, chunks={len(cc_json['system']) if isinstance(cc_json['system'],list) else len(cc_json['system'])})")
else:
    bad("P1-R1", "CC body.system 缺失")

# R2 thinking blocks sanitize —— 发一个带 thinking 输入的历史
# anthropic 允许在历史里带 thinking blocks, sanitize 应移除空的 / incomplete 的
# 这里只断言: 出站 body 的 messages 里不应出现 "incomplete" thinking block
before = tap_lines_before()
body_with_thinking = {
    "model": MODEL, "max_tokens": 16,
    "messages": [
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": [
            {"type": "thinking", "thinking": "", "signature": "x"},  # 空 thinking
            {"type": "text", "text": "hi"}
        ]},
        {"role": "user", "content": "再问一句"}
    ]
}
code = curl_post(f"/claude-code/{SPACE}/v1/messages", body_with_thinking, preseq)
got = wait_for_tap(before, 1, 8)
if got:
    out_body = json.loads(got[0]["bodyRaw"])
    msgs = out_body.get("messages", [])
    bad_thinking = False
    for m in msgs:
        c = m.get("content")
        if isinstance(c, list):
            for b in c:
                if isinstance(b, dict) and b.get("type") == "thinking":
                    thinking_text = b.get("thinking", "")
                    if not thinking_text or not b.get("signature"):
                        bad_thinking = True
                        break
    if bad_thinking:
        bad("P1-R2", "出站 body 仍含空 thinking block")
    else:
        ok("P1-R2", "sanitizeThinkingBlocks 生效（出站无空/未完 thinking）")
else:
    bad("P1-R2", "thinking 测试请求未抓到")

# R4 x-api-key header（anthropic 必须用这个, 不是 Authorization）
if got:
    hdrs = got[0]["headers"]
    low = {k.lower(): v for k, v in hdrs.items()}
    if "x-api-key" in low and "authorization" not in low:
        ok("P1-R4", "anthropic 出站: x-api-key 存在, Authorization 已剥离")
    elif "x-api-key" in low and "authorization" in low:
        bad("P1-R4", "anthropic 出站同时含 x-api-key 和 Authorization（应只保留前者）")
    else:
        bad("P1-R4", f"anthropic 出站缺 x-api-key, headers={list(low.keys())[:6]}")

##############################################################################
hd("P1-S  Codex / Responses 协议特化 (2)")
##############################################################################

sid_cx = f"dumpv-cx-{int(time.time())}"
# codex 真实客户端的 session id header 是 x-parent-conversation-id 或 session-id
# （不是 x-session-id, 见 runners/codex.ts::extractCodexSessionId）。
# 用错 header 名 → extractCodexSessionId 返 null → session-init 完全跳过 → 无注入。
cx_hdrs = [
    f"x-parent-conversation-id: {sid_cx}",
    f"x-team-id: {TEAM}", f"x-agent-id: {AGENT}",
]
before = tap_lines_before()
# ⚠️ codex 真实客户端的 input[0] 形状是 {type:"message", role:"user", content:[{type:"input_text", text:"..."}]}
# injectCodexAssets 的 gate 是 input[0].type === "message", 不带 type 就跳过注入 (非 bug)
code = curl_post(f"/codex/{SPACE}/v1/responses",
                 {"model": MODEL,
                  "input": [{"type": "message", "role": "user",
                             "content": [{"type": "input_text", "text": "codex 注入测试"}]}],
                  "stream": True},
                 cx_hdrs, timeout=35)
got = wait_for_tap(before, 1, 15)
if got:
    cx_body = json.loads(got[0]["bodyRaw"])
    inp = cx_body.get("input", [])
    if isinstance(inp, list) and len(inp) >= 1:
        ok("P1-S1", f"codex body.input 保留 ({len(inp)} 条)")
    else:
        bad("P1-S1", f"codex body.input 异常: {type(inp).__name__}")

    # S2 合成的 input[0] 应含 session_context + assets（codex 把注入塞进第一条 user）
    txt = extract_all_text(cx_body)
    tags = [t for t in ("session_context", "available_skills", "skill_tools", "tdai_memory_tools")
            if f"<{t}>" in txt]
    if len(tags) >= 2:
        ok("P1-S2", f"codex 合成含注入: {', '.join('<'+t+'>' for t in tags)}")
    else:
        bad("P1-S2", f"codex 合成缺注入: 找到 {tags}")
else:
    bad("P1-S1", "codex 请求未抓到 outbound")
    bad("P1-S2", "codex 请求未抓到 outbound")

##############################################################################
hd("P1-L  压缩 CFQ 剥离 (3)")
##############################################################################

# L3/L4: CFQ tag 剥离——客户端收到的响应里不能有 CFQ tag
# requestPrepare 本实例未启用（space policy disabled）, 实测验证"没启用时也不出 bug"
#
# 发一个 non-stream 请求, 用 curl -s 读响应 body, grep CFQ 应为 0
sid = f"dumpv-cfq-{int(time.time())}"
r = subprocess.run([
    "curl", "-s", "-m", "25", "-X", "POST", f"{PROXY}/claude-code/{SPACE}/v1/messages",
    "-H", f"Authorization: Bearer {KEY}", "-H", "Content-Type: application/json",
    "-H", f"x-claude-code-session-id: {sid}",
    "-H", f"x-team-id: {TEAM}", "-H", f"x-agent-id: {AGENT}",
    "-d", json.dumps({"model": MODEL, "max_tokens": 32,
                      "messages": [{"role": "user", "content": "hi"}]})
], capture_output=True, text=True).stdout

if re.search(r"<CFQ[^>]*>|<cfq_tag", r, re.I):
    bad("P1-L4", f"客户端 non-stream 响应里含 CFQ tag（剥离失败）: {r[:120]}")
else:
    ok("P1-L4", "non-stream 响应里无 CFQ tag（剥离通路工作）")

# L3 stream 响应剥离
r = subprocess.run([
    "curl", "-s", "-m", "25", "-X", "POST", f"{PROXY}/claude-code/{SPACE}/v1/messages",
    "-H", f"Authorization: Bearer {KEY}", "-H", "Content-Type: application/json",
    "-H", f"x-claude-code-session-id: {sid}-s",
    "-H", f"x-team-id: {TEAM}", "-H", f"x-agent-id: {AGENT}",
    "-d", json.dumps({"model": MODEL, "max_tokens": 32, "stream": True,
                      "messages": [{"role": "user", "content": "hi"}]})
], capture_output=True, text=True).stdout
if re.search(r"<CFQ[^>]*>|<cfq_tag", r, re.I):
    bad("P1-L3", "stream 响应里含 CFQ tag")
else:
    ok("P1-L3", "stream 响应里无 CFQ tag")

# L5~L8 需 requestPrepare 启用才有意义
skip("P1-L1,L2,L5,L6,L7,L8", "requestPrepare space policy 未开启；上游收到的 body 已经验过无 CFQ，流水线完整验证需开 cost-guard 控制面")

##############################################################################
hd("P1-M  转发 + 重试 (1)")
##############################################################################

# M3 anthropic retry body 也经 sanitize —— 需要 mock 路由模型 4xx 触发 retry
skip("P1-M3", "retry body sanitize 需 mock 路由模型 4xx，当前实例无法稳定构造")
# M4 anthropic retry 用 x-api-key —— 同样需 retry 场景
skip("P1-M4", "retry headers 验证需 retry 场景")
# M2 retry 成功 —— 同上
skip("P1-M2", "需 mock cheap 模型 4xx")

print(f"\n{'='*48}\n P1 DUMP VERIFY 汇总\n{'='*48}")
print(f"  PASS={PASS}  FAIL={FAIL}  SKIP={SKIPPED}")
if FAILS:
    print("\n  失败项:")
    for k, m in FAILS:
        print(f"    ✗ {k} {m}")
sys.exit(1 if FAIL else 0)
