#!/usr/bin/env python3
"""
codex-tui-smoke.py —— 用 pexpect PTY 起真 Codex TUI，模拟真实用户交互
走完 session-init 5-step form，捕获用户可见的第一条 assistant 回复。

关键目的：验证 P1-1 —— form 完成后模型是否会 hallucinate 解释最后一条
form output（如"我们需要理解用户说的\"否，本次不关联\"是什么意思"）。
真 CLI 会全量重放 input[]，上游看到完整 tool loop 理论上不该幻觉；
但必须真跑一遍 TUI 才能断言。

依赖: pexpect
用法:
    python3 codex-tui-smoke.py                      # 完整 init 流程
    python3 codex-tui-smoke.py --bypass             # asset_confirm 选"否"
    python3 codex-tui-smoke.py --prompt "1+1=?"     # 覆盖首条 user 消息
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bypass", action="store_true", help="asset_confirm 选'否'走 bypass 路径")
    ap.add_argument("--prompt", default="1+1=?", help="首条 user 消息")
    ap.add_argument("--cwd", default="/tmp", help="启动目录（需已 trusted）")
    ap.add_argument("--log", default="/tmp/codex-tui-smoke.log")
    args = ap.parse_args()

    env = os.environ.copy()
    env["TERM"] = "xterm-256color"
    env["CODEX_DISABLE_UPDATE_CHECK"] = "1"

    child = pexpect.spawn(
        "codex",
        args=[],
        cwd=args.cwd,
        env=env,
        dimensions=(50, 180),
        encoding=None,
        timeout=45,
    )
    child.logfile_read = Sink(args.log)

    # 等 TUI 就绪
    try:
        child.expect(rb"directory:", timeout=20)
    except pexpect.TIMEOUT:
        print("\n[FAIL] TUI 未就绪", file=sys.stderr)
        return 1

    time.sleep(1.5)

    # ── 首条 user 消息 ────────────────────────────────────────────────────
    # 依赖 ~/.codex/config.toml 里 features.default_mode_request_user_input = true
    # 让 Default 模式也能弹 request_user_input form (跟 Plan 模式等价触发)。
    #
    # codex TUI composer: 打字 → 再单独按 Enter 提交。sendline 里的 \n 会跟
    # 文字一起送进输入框但不触发提交，所以拆两步 (send 文字 → sleep → 单独 Enter)。
    print(f"\n=== [STEP 1] 发首条消息: {args.prompt} ===")
    child.send(args.prompt)
    time.sleep(1.5)
    child.send("\r")  # Enter 提交

    # 等 asset_confirm form —— 匹配中文"是否关联"或英文关键字
    try:
        child.expect(
            rb"\xe6\x98\xaf\xe5\x90\xa6\xe5\x85\xb3\xe8\x81\x94|\xe5\x85\xb3\xe8\x81\x94\xe5\x9b\xa2\xe9\x98\x9f\xe8\xb5\x84\xe4\xba\xa7|asset_confirm|Question",
            timeout=45,
        )
        print("\n=== [STEP 2] asset_confirm form 出现 ✓ ===")
    except pexpect.TIMEOUT:
        print("\n[FAIL] 首帧未见 asset_confirm form (45s)", file=sys.stderr)
        child.terminate(force=True)
        return 1

    time.sleep(1.5)

    # ── 选 asset_confirm ─────────────────────────────────────────────────
    # codex 每个 form 首选就是第 1 项 (是/关联)，Down 一次到第 2 项 (否/bypass)。
    # 用 \r 而非 sendline 提交，避免把 \n 也解读成额外的 Down。
    if args.bypass:
        print("\n=== [STEP 3] 选 '否，本次不关联' → Down + Enter ===")
        child.send("\x1b[B")  # Down 到第 2 项
        time.sleep(0.8)
        child.send("\r")      # Enter 提交
    else:
        print("\n=== [STEP 3] 选 '是，关联团队资产' → Enter ===")
        time.sleep(0.8)
        child.send("\r")

    # ── 后续步骤（非 bypass）—— 每步 Enter 选首项 ─────────────────
    if not args.bypass:
        for step in range(6):
            try:
                i = child.expect(
                    [
                        rb"Question|\xe8\xaf\xb7\xe9\x80\x89\xe6\x8b\xa9",  # 请选择
                        rb"tokens used|response\.completed|assistant",
                    ],
                    timeout=60,
                )
                if i == 1:
                    print(f"\n=== [STEP {4 + step}] 到达 assistant 首条回复 ===")
                    break
                print(f"\n=== [STEP {4 + step}] 下一步 form → Enter ===")
                time.sleep(1)
                child.send("\r")
            except pexpect.TIMEOUT:
                print(f"\n[TIMEOUT step {4 + step}]")
                break

    # ── 抓 assistant 首条完整回复 ─────────────────────────────────────
    print("\n=== [FINAL] 等 assistant 完成（tokens used 出现） ===")
    try:
        child.expect(rb"tokens used", timeout=90)
        print("\n[DONE] assistant 已完成回复 ✓")
    except pexpect.TIMEOUT:
        print("\n[WARN] 90s 未见 tokens used", file=sys.stderr)

    time.sleep(2)
    child.sendcontrol("c")
    time.sleep(0.5)
    child.sendcontrol("c")
    child.close(force=True)

    print(f"\n\n=== 完整 log 落 {args.log} ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
