#!/usr/bin/env python3
"""
Cache-Aware Context Lifecycle Management — Cache Hit Rate Test.

Validates the new three-part prompt architecture by running a 35-turn
conversation and measuring DeepSeek prompt cache hit rates.

Design:
  - NEW method (default): MEMORY_TDAI_HISTORY_ENABLED=1, showInjected ignored
    (L1 memories at prompt tail, stable summaries append-only, recent N turns
    circular buffer)
  - BASELINE method (--baseline): history disabled, showInjected=true
    (L1 memories in prependContext, no summary compression)

The 35-turn conversation extends the Task Tracker development scenario
from run_long_conversation_test.py, reusing its send_message(),
extract_usage(), hit_rate(), and fixture management.

Usage:
  # New method test (default)
  python scripts/test_cache_hit_rate.py --iterations 3

  # Baseline comparison
  python scripts/test_cache_hit_rate.py --baseline --iterations 3

  # Dry run (validate config without API calls)
  python scripts/test_cache_hit_rate.py --dry-run
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

# Reuse the existing test framework
from run_long_conversation_test import (
    send_message,
    extract_usage,
    hit_rate,
    clean_context,
    setup_fixed_content,
    generate_fixtures,
    OPENCLAW_BIN,
    PLUGIN_DATA_DIR,
    DEFAULT_MODEL,
    FIXED_PERSONA,
    FIXED_SCENE,
    ExperimentError,
)

SCRIPT_DIR = Path(__file__).resolve().parent
RESULTS_DIR = SCRIPT_DIR / "experiment-results"

# ── Extended 35-turn conversation ────────────────────────────────────────────
# Reuses the first 30 turns from run_long_conversation_test.py and adds 5 more
# covering deployment, testing, and debugging.

CACHE_TEST_TURNS: list[str] = [
    # Phase 1: Project setup (Turns 1-5)
    "你好，我叫张伟，是一名全栈工程师。我想用 React 和 FastAPI 搭建一个任务管理应用。",
    "对，我想先从后端开始。FastAPI 的项目结构应该怎么组织？",
    "好的，那我用你推荐的分层结构。数据库我打算用 PostgreSQL，ORM 用 SQLAlchemy。",
    "帮我写一下 Task 模型，需要有标题、描述、状态、优先级、创建时间、截止日期这些字段。",
    "状态我想用枚举：todo、in_progress、review、done。优先级用 low、medium、high、urgent。",

    # Phase 2: API 设计 (Turns 6-10)
    "模型建好了，现在帮我设计 Task 的 CRUD API。先写创建任务的端点。",
    "创建端点测试通过了。接下来帮我写获取任务列表的端点，需要支持分页和按状态筛选。",
    "列表端点也好了。现在需要一个获取单个任务详情的端点，如果任务不存在要返回 404。",
    "更新任务的端点怎么写？需要支持部分更新（PATCH），只传需要修改的字段。",
    "删除任务用软删除还是硬删除？我倾向于软删除，加一个 is_deleted 字段。",

    # Phase 3: 用户认证 (Turns 11-15)
    "任务 CRUD 做完了，现在要加用户认证。用 JWT 方案怎么样？",
    "JWT 的 access token 过期时间设置多长合适？refresh token 呢？",
    "帮我写注册端点和登录端点。注册需要邮箱、用户名、密码，密码要 bcrypt 哈希。",
    "现在写一个认证中间件，从 Authorization header 解析 Bearer token 并验证。",
    "中间件写好了。怎么把当前用户信息传递给路由处理函数？用 FastAPI 的 Depends？",

    # Phase 4: 前端开始 (Turns 16-20)
    "后端差不多了，开始写前端。React 项目用 Vite 创建，状态管理用 Zustand。",
    "先写一个登录页面，有邮箱和密码输入框，登录成功后把 token 存到 localStorage。",
    "登录成功了。现在写任务列表页面，用卡片布局展示任务，支持按状态筛选。",
    "任务列表需要分页吗？数据量不大的话我觉得前端分页就够了。",
    "创建任务的表单怎么写？用 React Hook Form 还是直接用受控组件？",

    # Phase 5: 前后端联调 (Turns 21-25)
    "创建任务表单写好了，但是提交后列表没有自动刷新。用 Zustand 的 store 该怎么处理？",
    "现在有个问题：用户在任务列表页创建任务后，新任务出现在列表末尾而不是开头。怎么修？",
    "任务编辑页面怎么写？复用创建任务的表单组件，还是单独写一个？",
    "我决定复用表单组件，通过 props 传入初始值来区分创建/编辑模式。帮我改一下。",
    "编辑功能做好了。现在要加删除功能，点删除按钮弹一个确认对话框，确认后调用 API。",

    # Phase 6: 部署与监控 (Turns 26-30)
    "应用基本功能完成了。帮我写 docker-compose.yml：PostgreSQL + FastAPI + Nginx + React。",
    "Docker Compose 写好了，但是现在 API 响应很慢。帮我分析一下可能的性能瓶颈。",
    "数据库查询慢可能是因为缺少索引。帮我给 Task 表加索引：status、priority、due_date。",
    "帮我在 FastAPI 里添加一个 /health 端点，返回数据库连接状态和 API 版本信息。",
    "健康检查端点写好了。现在要加请求日志中间件，记录每个请求的耗时和状态码。",

    # Phase 7: 测试与 CI/CD (Turns 31-35)
    "功能都完成了，开始写测试。先给 Task CRUD 写 pytest 单元测试，覆盖所有端点。",
    "后端测试写好了。前端用 Vitest + React Testing Library 写登录页面和任务列表的测试。",
    "帮我配置 GitHub Actions：跑 lint、test、build，三个 job 并行执行，用 matrix 测试 Python 3.11 和 3.12。",
    "CI 配好了。现在要加一个 staging 环境的 docker-compose.override.yml，和 production 的区别是 DEBUG=true 和 volume mount。",
    "最后帮我写一个 Makefile，包含 setup、test、build、deploy-staging、deploy-prod、logs、clean 这些 target。",
]


def log(msg: str) -> None:
    ts = time.strftime("%H:%M:%S")
    print(f"[{ts}] {msg}")


def run_test(
    baseline: bool = False,
    iterations: int = 1,
    dry_run: bool = False,
    num_turns: int = 35,
    model: str | None = None,
) -> list[dict[str, Any]]:
    """Run cache hit rate test.

    Args:
        baseline: If True, run old method (no history, showInjected=true).
                  If False, run new method (history enabled, showInjected ignored).
        iterations: Number of iterations.
        dry_run: If True, skip API calls.
        num_turns: Number of conversation turns (max 35).
        model: Model override.
    """
    method_label = "BASELINE (old)" if baseline else "NEW (Cache-Aware)"
    turns = CACHE_TEST_TURNS[:num_turns]

    log(f"\n{'=' * 70}")
    log(f"Method: {method_label}")
    log(f"Iterations: {iterations}")
    log(f"Turns: {len(turns)}")
    log(f"{'=' * 70}")

    extra_env: dict[str, str] = {
        "MEMORY_TDAI_DISABLE_PIPELINE": "1",
    }

    if baseline:
        # Old method: no history, showInjected=true
        extra_env["MEMORY_TDAI_SHOW_INJECTED"] = "1"
        # MEMORY_TDAI_HISTORY_ENABLED is NOT set
    else:
        # New method: history enabled, showInjected is ignored (always stripped)
        extra_env["MEMORY_TDAI_HISTORY_ENABLED"] = "1"
        # MEMORY_TDAI_SHOW_INJECTED is NOT set (deprecated, always stripped)

    env_parts = [
        f"HISTORY_ENABLED={'1' if not baseline else '(unset)'}",
        f"SHOW_INJECTED={'1' if baseline else '(unset/deprecated)'}",
        f"DISABLE_PIPELINE=1",
    ]
    log(f"    ENV: {', '.join(env_parts)}")

    all_results: list[dict[str, Any]] = []

    for iteration in range(1, iterations + 1):
        log(f"\n--- Iteration {iteration}/{iterations} ---")

        if not dry_run:
            clean_context()
            setup_fixed_content()
        else:
            log("[DRY RUN] Would clean context and setup fixed content")

        label = "baseline" if baseline else "new"
        session_key = f"agent:main:cacheretry-{label}-{int(time.time())}"
        turn_results: list[dict[str, Any]] = []

        for turn_idx, user_text in enumerate(turns, 1):
            log(f"  Turn {turn_idx}/{len(turns)}: '{user_text[:60]}...'")

            if dry_run:
                log(f"    [DRY RUN] Would run: openclaw agent --message \"...\" --json --session-key {session_key}")
                usage: dict[str, int] = {
                    "prompt_tokens": 1000,
                    "cache_hit_tokens": 800 if turn_idx > 1 else 0,
                    "cache_miss_tokens": 200 if turn_idx > 1 else 1000,
                }
            else:
                try:
                    resp = send_message(
                        user_text,
                        session_key=session_key,
                        model=model,
                        extra_env=extra_env,
                    )
                    debug = (turn_idx == 1)
                    usage = extract_usage(resp, debug=debug)
                    if debug and usage.get("prompt_tokens", 0) == 0:
                        log(f"    DEBUG raw response (first 800 chars): {json.dumps(resp, ensure_ascii=False)[:800]}")
                except ExperimentError as e:
                    log(f"    ERROR: {e}")
                    usage = {
                        "prompt_tokens": 0,
                        "cache_hit_tokens": 0,
                        "cache_miss_tokens": 0,
                        "error": str(e),
                    }

            hr = hit_rate(usage)
            turn_result = {
                "turn": turn_idx,
                "user_text": user_text[:80],
                "prompt_tokens": usage.get("prompt_tokens", 0),
                "cache_hit_tokens": usage.get("cache_hit_tokens", 0),
                "cache_miss_tokens": usage.get("cache_miss_tokens", 0),
                "hit_rate": hr,
                "error": usage.get("error"),
            }
            turn_results.append(turn_result)

            log(
                f"    → prompt={usage.get('prompt_tokens', 0)}, "
                f"hit={usage.get('cache_hit_tokens', 0)}, "
                f"miss={usage.get('cache_miss_tokens', 0)}, "
                f"rate={hr:.1%}"
            )

            if not dry_run:
                time.sleep(1)

        all_results.append({
            "iteration": iteration,
            "condition": "baseline" if baseline else "new",
            "turns": turn_results,
        })

    return all_results


def compute_stats(results: list[dict[str, Any]], num_turns: int) -> dict[str, Any]:
    """Compute per-turn and per-phase statistics (excludes Turn 1 cold start)."""
    import statistics

    per_turn_rates: dict[int, list[float]] = {i: [] for i in range(1, num_turns + 1)}
    all_rates: list[float] = []

    for iteration in results:
        for turn in iteration["turns"]:
            turn_num = turn["turn"]
            rate = turn["hit_rate"]
            if turn_num > 1:
                per_turn_rates[turn_num].append(rate)
                all_rates.append(rate)

    # Phase breakdown
    phases = {
        "Early (2-10)": (2, 10),
        "Mid (11-20)": (11, 20),
        "Late (21-35)": (21, num_turns),
    }
    phase_rates: dict[str, list[float]] = {}
    for phase_name, (start, end) in phases.items():
        vals: list[float] = []
        for tn in range(start, min(end, num_turns) + 1):
            vals.extend(per_turn_rates.get(tn, []))
        phase_rates[phase_name] = vals

    summary: dict[str, Any] = {
        "per_turn": {},
        "per_phase": {},
        "average_rate": statistics.mean(all_rates) if all_rates else 0.0,
        "median_rate": statistics.median(all_rates) if all_rates else 0.0,
        "stdev_rate": statistics.stdev(all_rates) if len(all_rates) > 1 else 0.0,
    }

    for tn in range(2, num_turns + 1):
        rates = per_turn_rates[tn]
        if rates:
            summary["per_turn"][tn] = {
                "mean": statistics.mean(rates),
                "values": rates,
            }

    for pn, vals in phase_rates.items():
        if vals:
            summary["per_phase"][pn] = {
                "mean": statistics.mean(vals),
                "stdev": statistics.stdev(vals) if len(vals) > 1 else 0.0,
                "count": len(vals),
            }

    return summary


def print_report(
    new_results: list[dict[str, Any]] | None,
    baseline_results: list[dict[str, Any]] | None,
    num_turns: int,
) -> None:
    """Print formatted cache hit rate test report."""
    print("\n" + "=" * 80)
    print("CACHE HIT RATE TEST — 35 Turns")
    if new_results:
        print("Method: NEW (Cache-Aware History Enabled)")
    if baseline_results:
        print("Method: BASELINE (Old, showInjected=true)")
    print(f"Date: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 80)

    new_stats = compute_stats(new_results, num_turns) if new_results else None
    base_stats = compute_stats(baseline_results, num_turns) if baseline_results else None
    primary = new_stats or base_stats

    if not primary:
        print("No results to display.")
        return

    # Per-turn table
    print(f"\n{'Turn':<6} | {'Hit Rate':<10}", end="")
    if new_stats and base_stats:
        print(f" | {'BASELINE':<10}", end="")
    print("\n" + "-" * (30 if not (new_stats and base_stats) else 42))

    for tn in range(2, num_turns + 1):
        new_rate = None
        base_rate = None
        if new_stats and tn in new_stats["per_turn"]:
            new_rate = new_stats["per_turn"][tn]["mean"]
        if base_stats and tn in base_stats["per_turn"]:
            base_rate = base_stats["per_turn"][tn]["mean"]

        rate = new_rate if new_rate is not None else base_rate
        if rate is None:
            continue

        print(f"{tn:<6} | {rate:>9.1%}", end="")
        if new_stats and base_stats:
            print(f" | {base_rate:>9.1%}" if base_rate is not None else " |     N/A   ", end="")
        print()

    # Summary
    print("\n" + "=" * 80)
    print("SUMMARY")
    print("=" * 80)

    if new_stats and base_stats:
        print(f"\n{'Metric':<25} | {'BASELINE':<12} | {'NEW':<12} | Delta")
        print("-" * 65)
        for label, key in [("Average Hit Rate", "average_rate"), ("Median Hit Rate", "median_rate"), ("StdDev", "stdev_rate")]:
            b = base_stats[key]
            n = new_stats[key]
            delta = n - b
            print(f"{label:<25} | {b:>11.1%} | {n:>11.1%} | {delta:+.1%}")
    else:
        s = primary
        print(f"\n  Average Hit Rate:  {s['average_rate']:.1%}")
        print(f"  Median Hit Rate:   {s['median_rate']:.1%}")
        print(f"  StdDev:            {s['stdev_rate']:.1%}")

    # Phase breakdown
    print(f"\n{'Phase':<15} | {'Turns':<8} | {'Avg Hit Rate':<14}", end="")
    if new_stats and base_stats:
        print(f" | {'BASELINE':<12}", end="")
    print("\n" + "-" * (42 if not (new_stats and base_stats) else 56))

    phases = [("Early", "Early (2-10)"), ("Mid", "Mid (11-20)"), ("Late", "Late (21-35)")]
    for short_name, full_name in phases:
        new_phase = new_stats["per_phase"].get(full_name) if new_stats else None
        base_phase = base_stats["per_phase"].get(full_name) if base_stats else None
        phase = new_phase or base_phase
        if not phase:
            continue
        turn_range = f"2-10" if short_name == "Early" else ("11-20" if short_name == "Mid" else f"21-{num_turns}")
        print(f"{short_name:<15} | {turn_range:<8} | {phase['mean']:>13.1%}", end="")
        if new_stats and base_stats:
            bp = base_phase["mean"] if base_phase else 0
            print(f" | {bp:>11.1%}", end="")
        print()

    # Expected vs actual
    print("\n" + "-" * 80)
    print("EXPECTED OUTCOME:")
    if not baseline:
        print("  Target: Average hit rate > 85% (35 turns)")
        if primary["average_rate"] >= 0.85:
            print("  ✓ PASS — Hit rate target met")
        else:
            print(f"  ✗ FAIL — Hit rate {primary['average_rate']:.1%} below 85% target")
    else:
        print("  Baseline expected: < 60% average hit rate")
        if primary["average_rate"] < 0.60:
            print("  ✓ Confirmed — Baseline shows low cache hit rate")
        else:
            print(f"  ? Unexpected — Baseline hit rate is {primary['average_rate']:.1%}")

    print("=" * 80)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Cache-Aware Context Lifecycle Management — Cache Hit Rate Test",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # New method (default)
  python scripts/test_cache_hit_rate.py --iterations 3

  # Baseline comparison
  python scripts/test_cache_hit_rate.py --baseline --iterations 3

  # Both methods (new vs baseline comparison)
  python scripts/test_cache_hit_rate.py --both --iterations 1

  # Dry run
  python scripts/test_cache_hit_rate.py --dry-run
""",
    )
    parser.add_argument("--setup", action="store_true", help="Generate fixed persona/scene fixtures")
    parser.add_argument("--iterations", type=int, default=1, help="Iterations per condition (default: 1)")
    parser.add_argument("--turns", type=int, default=35, help="Number of turns (default: 35, max: 35)")
    parser.add_argument("--model", type=str, default=None, help="Model override")
    parser.add_argument("--baseline", action="store_true", help="Run OLD method only (no history, showInjected=true)")
    parser.add_argument("--both", action="store_true", help="Run BOTH new and baseline methods for comparison")
    parser.add_argument("--dry-run", action="store_true", help="Validate config without API calls")
    args = parser.parse_args()

    if args.setup:
        generate_fixtures()
        return

    num_turns = min(args.turns, len(CACHE_TEST_TURNS))
    if args.turns > len(CACHE_TEST_TURNS):
        log(f"WARNING: Requested {args.turns} turns but only {len(CACHE_TEST_TURNS)} defined. Using {num_turns}.")

    print("=" * 80)
    print("CACHE-AWARE CONTEXT LIFECYCLE — CACHE HIT RATE TEST")
    print(f"Turns: {num_turns} | Iterations: {args.iterations} | Dry run: {args.dry_run}")
    print(f"Model: {args.model or '(agent default)'}")
    print(f"OpenClaw binary: {OPENCLAW_BIN}")
    print(f"State dir: {PLUGIN_DATA_DIR}")
    print("=" * 80)

    if not args.dry_run:
        if not FIXED_PERSONA.exists() or not FIXED_SCENE.exists():
            log("Fixtures not found. Generating...")
            generate_fixtures()

    run_new = not args.baseline or args.both
    run_baseline = args.baseline or args.both

    new_results = None
    baseline_results = None

    if run_new:
        log("\n" + "=" * 80)
        log("PHASE: NEW METHOD (Cache-Aware History Enabled)")
        log("=" * 80)
        new_results = run_test(
            baseline=False,
            iterations=args.iterations,
            dry_run=args.dry_run,
            num_turns=num_turns,
            model=args.model,
        )

    if run_baseline:
        log("\n" + "=" * 80)
        log("PHASE: BASELINE (Old Method, showInjected=true)")
        log("=" * 80)
        baseline_results = run_test(
            baseline=True,
            iterations=args.iterations,
            dry_run=args.dry_run,
            num_turns=num_turns,
            model=args.model,
        )

    # Report
    print_report(new_results, baseline_results, num_turns)

    # Save results
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = time.strftime("%Y%m%d-%H%M%S")
    method_tag = "new" if not run_baseline else ("baseline" if not run_new else "comparison")
    result_file = RESULTS_DIR / f"hitrate-{method_tag}-{num_turns}t-{timestamp}.json"

    output: dict[str, Any] = {
        "config": {
            "turns": num_turns,
            "iterations": args.iterations,
            "model": args.model or DEFAULT_MODEL,
            "dry_run": args.dry_run,
            "timestamp": timestamp,
        },
    }
    if new_results:
        output["new_method"] = [
            {"iteration": r["iteration"], "turns": r["turns"]}
            for r in new_results
        ]
    if baseline_results:
        output["baseline"] = [
            {"iteration": r["iteration"], "turns": r["turns"]}
            for r in baseline_results
        ]

    result_file.write_text(
        json.dumps(output, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    log(f"\nResults saved to: {result_file}")


if __name__ == "__main__":
    main()
