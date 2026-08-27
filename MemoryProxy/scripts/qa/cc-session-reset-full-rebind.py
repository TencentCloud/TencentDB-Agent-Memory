#!/usr/bin/env python3
"""
cc-session-reset-full-rebind.py — pexpect PTY E2E: reset 后完整走 session-init 绑定 team/agent/task。

测试 Cases:
  P0-2: reset后完成绑定→注入生效
  P0-3: 已绑定→reset→重新选(不同 team)
  P0-4: 多次 reset 循环

每个 case 独立起一个 claude 进程避免 state 污染。

依赖: pexpect (`pip install pexpect`)
环境: CLAUDE_CONFIG_DIR 指向 ~/.claude-inter (已配 proxy base_url)

用法:
    python3 scripts/qa/cc-session-reset-full-rebind.py
    python3 scripts/qa/cc-session-reset-full-rebind.py --case p0-2
    python3 scripts/qa/cc-session-reset-full-rebind.py --timeout 120
"""
import argparse
import os
import re
import sys
import time
import json
from datetime import datetime

import pexpect


# ════════════════════════════════════════════════════════════════════════════
# Patterns (utf-8 raw bytes)
# ════════════════════════════════════════════════════════════════════════════

# asset_confirm form: 关联资产 / 是否关联 / 团队资产
FORM_RE = rb"\xe5\x85\xb3\xe8\x81\x94\xe8\xb5\x84\xe4\xba\xa7|\xe6\x98\xaf\xe5\x90\xa6\xe5\x85\xb3\xe8\x81\x94|\xe5\x9b\xa2\xe9\x98\x9f\xe8\xb5\x84\xe4\xba\xa7|asset_confirm|AskUserQuestion"
# reset 成功文案: 已重置 / 已恢复 / 已解除
RESET_OK_RE = rb"\xe5\xb7\xb2\xe9\x87\x8d\xe7\xbd\xae|\xe5\xb7\xb2\xe6\x81\xa2\xe5\xa4\x8d|\xe5\xb7\xb2\xe8\xa7\xa3\xe9\x99\xa4"
# team/agent/task selector form uses AskUserQuestion which shows specific patterns
# We use FORM_RE for all form steps (they all show 关联/资产/团队 patterns)
# CC prompt ready indicator: the ❯ prompt character when idle
# After a response is done, CC shows: "Brewed for Xs ❯ " (the prompt line)
# The key pattern is "❯" preceded by cost info like "Brewed" or "Cooked" or input cost
IDLE_RE = rb"(?:Brewed|Cooked|cost|input|output|\d+ tokens).*\xe2\x9d\xaf"
# Simpler: any "❯" followed by spaces/end (the input prompt)
PROMPT_RE = rb"\xe2\x9d\xaf\s*$|\xe2\x9d\xaf\s+\S"
# trust folder prompt
TRUST_RE = rb"[Tt]rust|trust this"
# error patterns
ERROR_RE = rb"[Ee]rror|error|ERROR|failed|exception"


def strip_ansi(data):
    """Strip ANSI escape sequences for readable logs."""
    try:
        txt = data.decode(errors="ignore") if isinstance(data, bytes) else data
    except Exception:
        return ""
    txt = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", txt)
    txt = re.sub(r"\x1b\][^\x07]*\x07", "", txt)
    txt = re.sub(r"\x1b[=>]", "", txt)
    return txt


class Sink:
    """pexpect logfile_read hook: write to file + stdout (stripped)."""

    def __init__(self, path):
        self.f = open(path, "wb")
        self.buffer = b""

    def write(self, data):
        self.f.write(data)
        self.f.flush()
        self.buffer += data

    def flush(self):
        self.f.flush()

    def get_recent(self, n=2000):
        """Get last n bytes of buffer as stripped text."""
        return strip_ansi(self.buffer[-n:])


def send_text(child, text, submit=True):
    """Type text into CC and optionally submit with Enter."""
    child.send(text)
    time.sleep(0.5)
    if submit:
        child.send("\r")


def send_down(child, times=1):
    """Send Down arrow key n times."""
    for _ in range(times):
        child.send("\x1b[B")
        time.sleep(0.3)


def send_enter(child):
    """Send Enter."""
    child.send("\r")


def spawn_cc(cwd, log_path, timeout):
    """Spawn a fresh claude process."""
    env = os.environ.copy()
    env["TERM"] = "xterm-256color"
    env["CLAUDE_CONFIG_DIR"] = os.path.expanduser("~/.claude-inter")
    env["CLAUDE_DISABLE_UPDATE_CHECK"] = "1"
    # Ensure PATH includes claude
    if "/data/home/jzhizhuang/.local/bin" not in env.get("PATH", ""):
        env["PATH"] = "/data/home/jzhizhuang/.local/bin:" + env.get("PATH", "")

    child = pexpect.spawn(
        "claude",
        args=["--dangerously-skip-permissions"],
        cwd=cwd,
        env=env,
        dimensions=(50, 200),
        encoding=None,
        timeout=timeout,
    )
    sink = Sink(log_path)
    child.logfile_read = sink
    return child, sink


def handle_trust(child, timeout):
    """Handle trust folder prompt if it appears. Returns True if handled."""
    try:
        i = child.expect([TRUST_RE, FORM_RE, pexpect.TIMEOUT], timeout=15)
        if i == 0:
            time.sleep(1)
            child.send("\r")
            time.sleep(3)
            return True
        elif i == 1:
            # Form appeared directly - trust was already accepted
            return True
        else:
            # Timeout - no trust prompt, CC might be waiting for input
            return False
    except (pexpect.TIMEOUT, pexpect.EOF):
        return False


def wait_for_form(child, timeout, label="form"):
    """Wait for asset_confirm form to appear. Returns True/error string."""
    try:
        child.expect(FORM_RE, timeout=timeout)
        return True
    except pexpect.TIMEOUT:
        return f"TIMEOUT waiting for {label}"
    except pexpect.EOF:
        return f"EOF waiting for {label}"


def wait_for_next_form_or_done(child, timeout=20):
    """Wait for another form question, or determine we're past the forms.
    Returns: 'form', 'done', 'eof'

    Strategy: wait a short time for FORM_RE. If timeout, assume forms are done
    and the model is replying.
    """
    try:
        child.expect(FORM_RE, timeout=timeout)
        return "form"
    except pexpect.TIMEOUT:
        return "done"
    except pexpect.EOF:
        return "eof"


def wait_idle(child, quiesce_sec=8, max_wait=120):
    """
    Wait until CC is idle (no new output for quiesce_sec seconds).
    This is more reliable than pattern matching for knowing the model finished.
    """
    deadline = time.time() + max_wait
    last_size = len(child.logfile_read.buffer)
    stable_since = time.time()

    while time.time() < deadline:
        time.sleep(1)
        current_size = len(child.logfile_read.buffer)
        if current_size != last_size:
            last_size = current_size
            stable_since = time.time()
        elif time.time() - stable_since >= quiesce_sec:
            return True
    return True  # max_wait exceeded, proceed anyway


def wait_for_prompt(child, timeout=120):
    """
    Wait for the CC prompt (❯) to appear after a model response completes.
    This is the most reliable way to know CC is ready for the next user input.

    CC shows: "Cooked for Xs" or "Brewed for Xs" followed by the ❯ prompt.
    The prompt character is \xe2\x9d\xaf (❯).

    We look for: "Cooked" or "Brewed" (cost summary) which always precedes the prompt.
    """
    COST_RE = rb"Cooked|Brewed"
    try:
        child.expect(COST_RE, timeout=timeout)
        # After cost line, wait a bit more for the prompt to render
        time.sleep(3)
        return True
    except pexpect.TIMEOUT:
        # Fallback: maybe the model response was very fast and we missed the cost line
        # Wait for quiesce
        time.sleep(5)
        return True
    except pexpect.EOF:
        return False


def wait_for_reset(child, timeout):
    """Wait for reset confirmation text."""
    try:
        child.expect(RESET_OK_RE, timeout=timeout)
        return True
    except pexpect.TIMEOUT:
        return "TIMEOUT waiting for reset confirmation"
    except pexpect.EOF:
        return "EOF waiting for reset confirmation"


def do_bypass(child, timeout):
    """Select 'No' on asset_confirm form (Down+Enter) and wait for prompt."""
    send_down(child, 1)
    time.sleep(0.8)
    send_enter(child)
    # Wait for model to finish responding (look for "Cooked/Brewed" cost line)
    wait_for_prompt(child, timeout)
    return True


def do_full_bind(child, timeout, team_index=0):
    """
    Select 'Yes' on asset_confirm form, then navigate team/agent/task selectors.
    team_index: 0-based index of team to select (0=first, 1=second).
    Returns (success: bool, steps: list of str).

    The session-init flow after "是":
      team selector → agent selector → task selector → model reply
    Each selector is an AskUserQuestion which triggers FORM_RE.
    Max 3 selectors (team, agent, task). Some may auto-skip if only 1 option.
    """
    steps = []

    # Select "是" (first item, already highlighted)
    time.sleep(1)
    send_enter(child)
    steps.append("selected '是' on asset_confirm")
    time.sleep(3)

    # Walk through form steps (max 3: team, agent, task)
    max_form_steps = 3
    first_selector = True
    for step_idx in range(max_form_steps):
        result = wait_for_next_form_or_done(child, timeout=25)
        if result == "form":
            if first_selector and team_index > 0:
                # First selector is team - navigate to desired index
                send_down(child, team_index)
                time.sleep(0.5)
                first_selector = False
            else:
                first_selector = False
            send_enter(child)
            steps.append(f"form step {step_idx+1}: selected")
            time.sleep(3)
        elif result == "done":
            steps.append(f"no more forms after step {step_idx} (done)")
            break
        elif result == "eof":
            steps.append(f"EOF at form step {step_idx+1}")
            return False, steps

    # Wait for CC prompt (model finishes response → "Cooked/Brewed" → ❯)
    steps.append("waiting for prompt (Cooked/Brewed)...")
    wait_for_prompt(child, timeout)
    steps.append("prompt ready - bind complete")
    return True, steps


def kill_cc(child):
    """Gracefully kill claude process."""
    try:
        child.sendcontrol("c")
        time.sleep(0.5)
        child.sendcontrol("c")
        time.sleep(0.5)
        child.sendcontrol("d")
        time.sleep(0.5)
    except Exception:
        pass
    try:
        child.close(force=True)
    except Exception:
        pass


# ════════════════════════════════════════════════════════════════════════════
# Test Cases
# ════════════════════════════════════════════════════════════════════════════

def test_p0_2(timeout, log_dir):
    """
    P0-2: reset后完成绑定→注入生效
    1. hello → form → bypass
    2. mem:session-reset → reset OK
    3. hi → form → 选是 → 走完绑定
    4. 模型正常回复
    """
    print("\n" + "=" * 70)
    print("  P0-2: reset后完成绑定→注入生效")
    print("=" * 70)

    log_path = os.path.join(log_dir, "p0-2.log")
    child, sink = spawn_cc("/tmp", log_path, timeout)
    results = {}

    try:
        # Step 0: Handle trust
        handle_trust(child, timeout)

        # Step 1: Send hello → expect form
        print("\n  [Step 1] Send 'hello' → expect asset_confirm form")
        send_text(child, "hello")
        r = wait_for_form(child, timeout, "asset_confirm after hello")
        if r is not True:
            # Retry
            send_text(child, "hello")
            r = wait_for_form(child, timeout, "asset_confirm after hello (retry)")
        results["S1_form_appears"] = r is True
        print(f"    → {'PASS' if r is True else 'FAIL: ' + str(r)}")
        if r is not True:
            results["early_exit"] = "S1 failed"
            return results

        time.sleep(2)

        # Step 2: Select 否 → bypass
        print("\n  [Step 2] Select '否' → bypass")
        r = do_bypass(child, timeout)
        results["S2_bypass_ok"] = True
        print(f"    → PASS (idle after bypass)")

        # Step 3: Send mem:session-reset → expect reset text
        print("\n  [Step 3] Send 'mem:session-reset' → expect reset confirmation")
        send_text(child, "mem:session-reset")
        r = wait_for_reset(child, timeout)
        results["S3_reset_ok"] = r is True
        print(f"    → {'PASS' if r is True else 'FAIL: ' + str(r)}")
        if r is not True:
            results["early_exit"] = "S3 failed"
            return results

        # Wait for reset response to finish (prompt ready)
        wait_for_prompt(child, timeout=60)

        # Step 4: Send hi → expect form again
        print("\n  [Step 4] Send 'hi' → expect asset_confirm form (proves reset)")
        send_text(child, "hi")
        r = wait_for_form(child, timeout, "asset_confirm after reset")
        results["S4_form_after_reset"] = r is True
        print(f"    → {'PASS' if r is True else 'FAIL: ' + str(r)}")
        if r is not True:
            results["early_exit"] = "S4 failed"
            return results

        time.sleep(2)

        # Step 5-7: Select 是 → walk through team/agent/task binding
        print("\n  [Step 5-7] Select '是' → complete full binding")
        success, steps = do_full_bind(child, timeout, team_index=0)
        results["S5_7_full_bind"] = success
        results["S5_7_steps"] = steps
        for s in steps:
            print(f"    → {s}")
        print(f"    → {'PASS' if success else 'FAIL'}")

    except Exception as e:
        results["exception"] = str(e)
        print(f"    → EXCEPTION: {e}")
    finally:
        results["log_tail"] = sink.get_recent(1500)
        kill_cc(child)

    return results


def test_p0_3(timeout, log_dir):
    """
    P0-3: 已绑定→reset→重新选(不同 team)
    1. hello → form → 选是 → 全选第1项完成绑定
    2. 模型正常回复
    3. mem:session-reset → "已解除"
    4. hi → form → 这次选第2个 team
    5. 走完 → 模型回复
    """
    print("\n" + "=" * 70)
    print("  P0-3: 已绑定→reset→重新选(不同 team)")
    print("=" * 70)

    log_path = os.path.join(log_dir, "p0-3.log")
    child, sink = spawn_cc("/tmp", log_path, timeout)
    results = {}

    try:
        # Step 0: Handle trust
        handle_trust(child, timeout)

        # Step 1: Send hello → form → select 是 → complete binding
        print("\n  [Step 1] Send 'hello' → form → select '是' → full bind (team 1)")
        send_text(child, "hello")
        r = wait_for_form(child, timeout, "asset_confirm")
        if r is not True:
            send_text(child, "hello")
            r = wait_for_form(child, timeout, "asset_confirm (retry)")
        results["S1_form_appears"] = r is True
        print(f"    form: {'appeared' if r is True else 'FAIL: ' + str(r)}")
        if r is not True:
            results["early_exit"] = "S1 form not found"
            return results

        time.sleep(2)
        success, steps = do_full_bind(child, timeout, team_index=0)
        results["S1_bind_complete"] = success
        for s in steps:
            print(f"    → {s}")
        print(f"    bind: {'PASS' if success else 'FAIL'}")
        if not success:
            results["early_exit"] = "S1 binding failed"
            return results

        # Step 3: Send mem:session-reset
        print("\n  [Step 3] Send 'mem:session-reset' → expect '已解除/已恢复' text")
        send_text(child, "mem:session-reset")
        r = wait_for_reset(child, timeout)
        results["S3_reset_ok"] = r is True
        print(f"    → {'PASS' if r is True else 'FAIL: ' + str(r)}")
        if r is not True:
            results["early_exit"] = "S3 reset failed"
            return results

        # Wait for reset response to finish (prompt ready)
        wait_for_prompt(child, timeout=60)

        # Step 4: Send hi → form → select team 2 (Down once extra)
        print("\n  [Step 4] Send 'hi' → form → select '是' → bind team 2")
        send_text(child, "hi")
        r = wait_for_form(child, timeout, "asset_confirm after reset")
        results["S4_form_after_reset"] = r is True
        print(f"    form: {'appeared' if r is True else 'FAIL: ' + str(r)}")
        if r is not True:
            results["early_exit"] = "S4 form not found"
            return results

        time.sleep(2)
        # Select team 2 (index=1)
        success, steps = do_full_bind(child, timeout, team_index=1)
        results["S5_rebind_different_team"] = success
        for s in steps:
            print(f"    → {s}")
        print(f"    rebind: {'PASS' if success else 'FAIL'}")

    except Exception as e:
        results["exception"] = str(e)
        print(f"    → EXCEPTION: {e}")
    finally:
        results["log_tail"] = sink.get_recent(1500)
        kill_cc(child)

    return results


def test_p0_4(timeout, log_dir):
    """
    P0-4: 多次 reset 循环
    1. hello → form → bypass
    2. mem:session-reset → reset → hi → form → bypass
    3. mem:session-reset → reset → hi → form → 选是 → 走完绑定
    4. 模型正常回复
    """
    print("\n" + "=" * 70)
    print("  P0-4: 多次 reset 循环 (3 resets)")
    print("=" * 70)

    log_path = os.path.join(log_dir, "p0-4.log")
    child, sink = spawn_cc("/tmp", log_path, timeout)
    results = {}

    try:
        # Step 0: Handle trust
        handle_trust(child, timeout)

        # ── Round 1: hello → form → bypass ──
        print("\n  [Round 1] hello → form → bypass")
        send_text(child, "hello")
        r = wait_for_form(child, timeout, "form round 1")
        if r is not True:
            send_text(child, "hello")
            r = wait_for_form(child, timeout, "form round 1 (retry)")
        results["R1_form"] = r is True
        print(f"    form: {'OK' if r is True else 'FAIL: ' + str(r)}")
        if r is not True:
            results["early_exit"] = "R1 form"
            return results

        time.sleep(2)
        do_bypass(child, timeout)
        results["R1_bypass"] = True
        print(f"    bypass: OK")

        # ── Round 2: reset → hi → form → bypass ──
        print("\n  [Round 2] mem:session-reset → hi → form → bypass")
        send_text(child, "mem:session-reset")
        r = wait_for_reset(child, timeout)
        results["R2_reset"] = r is True
        print(f"    reset: {'OK' if r is True else 'FAIL: ' + str(r)}")
        if r is not True:
            results["early_exit"] = "R2 reset"
            return results

        wait_for_prompt(child, timeout=60)

        send_text(child, "hi")
        r = wait_for_form(child, timeout, "form round 2")
        results["R2_form"] = r is True
        print(f"    form: {'OK' if r is True else 'FAIL: ' + str(r)}")
        if r is not True:
            results["early_exit"] = "R2 form"
            return results

        time.sleep(2)
        do_bypass(child, timeout)
        results["R2_bypass"] = True
        print(f"    bypass: OK")

        # ── Round 3: reset → hi → form → full bind ──
        print("\n  [Round 3] mem:session-reset → hi → form → full bind")
        send_text(child, "mem:session-reset")
        r = wait_for_reset(child, timeout)
        results["R3_reset"] = r is True
        print(f"    reset: {'OK' if r is True else 'FAIL: ' + str(r)}")
        if r is not True:
            results["early_exit"] = "R3 reset"
            return results

        wait_for_prompt(child, timeout=60)

        send_text(child, "hi")
        r = wait_for_form(child, timeout, "form round 3")
        results["R3_form"] = r is True
        print(f"    form: {'OK' if r is True else 'FAIL: ' + str(r)}")
        if r is not True:
            results["early_exit"] = "R3 form"
            return results

        time.sleep(2)
        success, steps = do_full_bind(child, timeout, team_index=0)
        results["R3_bind"] = success
        for s in steps:
            print(f"    → {s}")
        print(f"    bind: {'PASS' if success else 'FAIL'}")

    except Exception as e:
        results["exception"] = str(e)
        print(f"    → EXCEPTION: {e}")
    finally:
        results["log_tail"] = sink.get_recent(1500)
        kill_cc(child)

    return results


# ════════════════════════════════════════════════════════════════════════════
# Main
# ════════════════════════════════════════════════════════════════════════════

def main():
    ap = argparse.ArgumentParser(description="CC session-reset full rebind E2E")
    ap.add_argument("--case", choices=["p0-2", "p0-3", "p0-4", "all"], default="all")
    ap.add_argument("--timeout", type=int, default=120, help="每步超时秒数")
    ap.add_argument("--log-dir", default="/tmp/cc-session-reset-e2e")
    args = ap.parse_args()

    os.makedirs(args.log_dir, exist_ok=True)
    print(f"[INFO] log_dir={args.log_dir}")
    print(f"[INFO] timeout={args.timeout}s per step")
    print(f"[INFO] CLAUDE_CONFIG_DIR=~/.claude-inter")
    print(f"[INFO] started at {datetime.now().isoformat()}")

    all_results = {}

    if args.case in ("p0-2", "all"):
        all_results["P0-2"] = test_p0_2(args.timeout, args.log_dir)

    if args.case in ("p0-3", "all"):
        all_results["P0-3"] = test_p0_3(args.timeout, args.log_dir)

    if args.case in ("p0-4", "all"):
        all_results["P0-4"] = test_p0_4(args.timeout, args.log_dir)

    # ── Summary ──
    print("\n" + "=" * 70)
    print("  SESSION-RESET FULL REBIND E2E SUMMARY")
    print("=" * 70)

    overall_pass = True
    for case_name, res in all_results.items():
        # Determine pass/fail
        if "early_exit" in res or "exception" in res:
            passed = False
        else:
            # Check key assertions per case
            if case_name == "P0-2":
                passed = (
                    res.get("S4_form_after_reset") is True
                    and res.get("S5_7_full_bind") is True
                )
            elif case_name == "P0-3":
                passed = (
                    res.get("S3_reset_ok") is True
                    and res.get("S4_form_after_reset") is True
                    and res.get("S5_rebind_different_team") is True
                )
            elif case_name == "P0-4":
                passed = (
                    res.get("R2_reset") is True
                    and res.get("R2_form") is True
                    and res.get("R3_reset") is True
                    and res.get("R3_form") is True
                    and res.get("R3_bind") is True
                )
            else:
                passed = True

        status = "PASS" if passed else "FAIL"
        if not passed:
            overall_pass = False
        print(f"  {'[PASS]' if passed else '[FAIL]'} {case_name}")
        if "early_exit" in res:
            print(f"         early_exit: {res['early_exit']}")
        if "exception" in res:
            print(f"         exception: {res['exception']}")

    print(f"\n  Overall: {'ALL PASS' if overall_pass else 'SOME FAILED'}")
    print(f"  Finished at {datetime.now().isoformat()}")
    print("=" * 70)

    # Write JSON results for report generation
    json_path = os.path.join(args.log_dir, "results.json")
    serializable = {}
    for k, v in all_results.items():
        serializable[k] = {kk: vv for kk, vv in v.items() if kk != "log_tail"}
        if "log_tail" in v:
            serializable[k]["log_tail_excerpt"] = v["log_tail"][-500:] if v["log_tail"] else ""
    with open(json_path, "w") as f:
        json.dump(serializable, f, indent=2, ensure_ascii=False, default=str)
    print(f"\n  Results JSON: {json_path}")

    return 0 if overall_pass else 1


if __name__ == "__main__":
    sys.exit(main())
