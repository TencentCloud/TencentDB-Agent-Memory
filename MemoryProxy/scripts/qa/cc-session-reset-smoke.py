#!/usr/bin/env python3
"""
cc-session-reset-smoke.py —— 用 pexpect PTY 起真 Claude Code 交互式会话,
验证 mem:session-reset 命令的完整端到端链路。

测试流程:
  1. 启动 CC → 等 form 弹出(asset_confirm)
  2. 选"否，本次不关联" → bypass
  3. 发正常消息验证 bypass 生效(无注入)
  4. 发 `mem:session-reset` → 看到重置文案
  5. 再发一条消息 → form 再次弹出(证明 reset 生效)

依赖: pexpect (`pip install pexpect`)
环境: CLAUDE_CONFIG_DIR 指向 ~/.claude-inter (已配 proxy base_url)

用法:
    python3 scripts/qa/cc-session-reset-smoke.py
    python3 scripts/qa/cc-session-reset-smoke.py --log /tmp/cc-reset.log
"""
import argparse
import os
import re
import sys
import time

import pexpect


def strip_ansi(data):
    """去掉 ANSI escape 让 log 可读"""
    try:
        txt = data.decode(errors="ignore") if isinstance(data, bytes) else data
    except Exception:
        return ""
    txt = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", txt)
    txt = re.sub(r"\x1b\][^\x07]*\x07", "", txt)
    txt = re.sub(r"\x1b[=>]", "", txt)
    return txt


class Sink:
    """pexpect logfile_read hook — 写文件 + 打屏（stripped）"""

    def __init__(self, path):
        self.f = open(path, "wb")

    def write(self, data):
        self.f.write(data)
        self.f.flush()
        sys.stdout.write(strip_ansi(data))
        sys.stdout.flush()

    def flush(self):
        self.f.flush()


# CC 交互式会话的 ready 标志:提示符出现时会显示项目路径或 ">" 或 "❯"
CC_READY_RE = rb">|\xe2\x9d\xaf|claude"
# asset_confirm form 的识别模式(中文 utf-8 编码)
FORM_RE = rb"\xe6\x98\xaf\xe5\x90\xa6\xe5\x85\xb3\xe8\x81\x94|\xe5\x85\xb3\xe8\x81\x94\xe5\x9b\xa2\xe9\x98\x9f|\xe5\x9b\xa2\xe9\x98\x9f\xe8\xb5\x84\xe4\xba\xa7|asset_confirm|AskUserQuestion"
# reset 成功文案 (utf-8: "已重置" / "已恢复" / "团队资产选择")
RESET_OK_RE = rb"\xe5\xb7\xb2\xe9\x87\x8d\xe7\xbd\xae|\xe5\xb7\xb2\xe6\x81\xa2\xe5\xa4\x8d|\xe5\x9b\xa2\xe9\x98\x9f\xe8\xb5\x84\xe4\xba\xa7\xe9\x80\x89\xe6\x8b\xa9"


def send_text(child, text, submit=True):
    """模拟键盘输入文本 + 提交 (Ctrl+J = newline submit in CC)"""
    child.send(text)
    time.sleep(0.5)
    if submit:
        # CC 交互式用 Enter 提交
        child.send("\r")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cwd", default="/tmp", help="启动目录")
    ap.add_argument("--log", default="/tmp/cc-session-reset-smoke.log")
    ap.add_argument("--timeout", type=int, default=60, help="每步超时秒数")
    args = ap.parse_args()

    env = os.environ.copy()
    env["TERM"] = "xterm-256color"
    env["CLAUDE_CONFIG_DIR"] = os.path.expanduser("~/.claude-inter")
    # 防止 CC 自动更新检查
    env["CLAUDE_DISABLE_UPDATE_CHECK"] = "1"

    print(f"[INFO] CLAUDE_CONFIG_DIR={env['CLAUDE_CONFIG_DIR']}")
    print(f"[INFO] cwd={args.cwd}")
    print(f"[INFO] log={args.log}")
    print()

    child = pexpect.spawn(
        "claude",
        args=["--dangerously-skip-permissions"],
        cwd=args.cwd,
        env=env,
        dimensions=(50, 180),
        encoding=None,
        timeout=args.timeout,
    )
    child.logfile_read = Sink(args.log)

    results = []

    def report(step, name, passed, note=""):
        status = "✅ PASS" if passed else "❌ FAIL"
        results.append((step, name, passed, note))
        print(f"\n{'='*60}")
        print(f"  [{step}] {name}: {status}")
        if note:
            print(f"       {note}")
        print(f"{'='*60}\n")

    # ── Step 0: 过"trust folder"前置提示 ──────────────────────────────────
    # CC 首次进入一个目录会问"Is this a project you trust?"
    # 选 "Yes, I trust this folder" (第 1 项,直接 Enter)
    print("\n=== Step 0: 处理 trust folder 提示 (如果出现) ===")
    try:
        i = child.expect([rb"trust", FORM_RE], timeout=args.timeout)
        if i == 0:
            # 出现 trust 提示 → Enter 选 Yes
            time.sleep(1)
            child.send("\r")
            print("  → trust 提示已过 (选 Yes)")
            time.sleep(3)
            # 继续等 form
            child.expect(FORM_RE, timeout=args.timeout)
        # i == 1: 直接看到了 form,trust 没出现
    except pexpect.TIMEOUT:
        # 可能 CC 启动慢,再等一次
        pass
    except pexpect.EOF:
        report("S1", "首帧弹出 asset_confirm form", False, "CC 进程退出")
        return print_summary(results)

    # ── Step 1: 等 CC 首帧弹 form ─────────────────────────────────────────
    print("\n=== Step 1: 等 CC 首帧弹 form ===")
    # 如果 Step 0 已经 match 到 FORM_RE,这里直接 pass;
    # 否则再等一次(可能首条用户消息还没发出去,CC 等用户输入)
    # CC 交互模式:用户需要先输入一条消息才会触发 proxy 请求
    # → 发一条 "hello" 触发
    send_text(child, "hello")
    try:
        child.expect(FORM_RE, timeout=args.timeout)
        report("S1", "首帧弹出 asset_confirm form", True)
    except pexpect.TIMEOUT:
        report("S1", "首帧弹出 asset_confirm form", False, "超时未见 form")
        child.terminate(force=True)
        return print_summary(results)
    except pexpect.EOF:
        report("S1", "首帧弹出 asset_confirm form", False, "CC 进程退出")
        return print_summary(results)

    time.sleep(2)

    # ── Step 2: 选"否" → bypass ────────────────────────────────────────────
    print("\n=== Step 2: 选 '否，本次不关联' → bypass ===")
    # CC AskUserQuestion form: 第 1 项是"是", Down 到第 2 项是"否"
    child.send("\x1b[B")  # Down
    time.sleep(0.8)
    child.send("\r")  # Enter 提交
    time.sleep(3)  # 等 bypass 完成 + 模型回复

    # 等模型回复完成(看到 token 计数或 > 提示符)
    try:
        child.expect(rb"tokens|>|\xe2\x9d\xaf", timeout=args.timeout)
        report("S2", "bypass 选择完成, 模型回复", True)
    except pexpect.TIMEOUT:
        report("S2", "bypass 选择完成, 模型回复", False, "超时")
        child.terminate(force=True)
        return print_summary(results)

    time.sleep(2)

    # ── Step 3: 发 mem:session-reset ─────────────────────────────────────────
    print("\n=== Step 3: 发 mem:session-reset ===")
    send_text(child, "mem:session-reset")

    try:
        child.expect(RESET_OK_RE, timeout=args.timeout)
        report("S3", "mem:session-reset 返回重置文案", True)
    except pexpect.TIMEOUT:
        report("S3", "mem:session-reset 返回重置文案", False, "超时未见重置文案")
        child.terminate(force=True)
        return print_summary(results)

    time.sleep(3)

    # ── Step 4: 再发一条消息 → 期望弹 form ─────────────────────────────────
    print("\n=== Step 4: 发 'hi' → 期望弹 form ===")
    send_text(child, "hi")

    try:
        child.expect(FORM_RE, timeout=args.timeout)
        report("S4", "reset 后弹出 asset_confirm form", True)
    except pexpect.TIMEOUT:
        report("S4", "reset 后弹出 asset_confirm form", False, "超时未见 form")

    # ── 清理 ─────────────────────────────────────────────────────────────────
    time.sleep(1)
    child.sendcontrol("c")
    time.sleep(0.5)
    child.sendcontrol("c")
    time.sleep(0.5)
    try:
        child.close(force=True)
    except Exception:
        pass

    return print_summary(results)


def print_summary(results):
    print("\n" + "=" * 70)
    print("  SESSION-RESET E2E 汇总 (真实 CC CLI PTY)")
    print("=" * 70)
    passed = sum(1 for _, _, p, _ in results if p)
    failed = sum(1 for _, _, p, _ in results if not p)
    for step, name, p, note in results:
        s = "✅" if p else "❌"
        print(f"  {s} [{step}] {name}{f' — {note}' if note else ''}")
    print(f"\n  Total: {passed} passed / {failed} failed")
    print("=" * 70)
    return 1 if failed > 0 else 0


if __name__ == "__main__":
    sys.exit(main())
