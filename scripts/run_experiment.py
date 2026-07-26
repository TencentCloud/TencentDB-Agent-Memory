#!/usr/bin/env python3
"""
Ablation & verification experiments for Issue #120 — prompt cache hit rate degradation.

Modes:
  --experiment ablation (default)
      Tests 4 conditions:
        A: Baseline  — showInjected=true,  stable content AFTER  CACHE_BOUNDARY
        B: Fix 1     — showInjected=false, stable content AFTER  CACHE_BOUNDARY
        C: Fix 2     — showInjected=true,  stable content BEFORE CACHE_BOUNDARY
        D: Combined  — showInjected=false, stable content BEFORE CACHE_BOUNDARY

  --experiment verify1
      Proves prefix break is caused by "inject-then-strip" mismatch.
      Runs Condition D with two Turn-1 variants:
        D_normal:  Turn 1 with intro text (triggers L1 injection → stripped → prefix break)
        E (noinj): Turn 1 = "你好" (no L1 injection → history matches → prefix intact)
      Hypothesis: D_normal Turn 2 ≈ 40%, E Turn 2 ≈ 98% → proves prefix break

  --experiment verify2
      Runs C and D with pre-generated fixed static content to eliminate variance.
      Requires --fixed-persona and --fixed-scene paths.

Usage:
  # Ablation (original)
  python run_experiment.py --condition A --iterations 3
  python run_experiment.py --all --iterations 3

  # Experiment 1: Verify prefix break
  python run_experiment.py --experiment verify1 --iterations 3

  # Experiment 2: Fixed static content
  python run_experiment.py --experiment verify2 --condition C --iterations 3 \\
      --fixed-persona ./persona.md --fixed-scene ./scene_index.json
"""

import argparse
import json
import os
import shutil
import statistics
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

# ── Configuration ──────────────────────────────────────────────────────────

OPENCLAW_STATE_DIR = Path(
    os.environ.get("OPENCLAW_STATE_DIR", Path.home() / ".openclaw" / "state")
)
PLUGIN_DATA_DIR = OPENCLAW_STATE_DIR / "memory-tdai"
# Default model — leave empty to use the agent's configured model.
# Set EXPERIMENT_MODEL env var to override (e.g. "deepseek/deepseek-chat").
DEFAULT_MODEL = os.environ.get("EXPERIMENT_MODEL", "")

def _find_openclaw_bin() -> str:
    """Auto-detect openclaw CLI binary. Falls back to env var or 'openclaw'."""
    # 1. Explicit override
    explicit = os.environ.get("OPENCLAW_BIN")
    if explicit:
        return explicit

    # 2. Search common install locations
    candidates: list[str] = []
    home = Path.home()
    if os.name == "nt":  # Windows
        candidates = [
            str(home / "AppData" / "Roaming" / "npm" / "openclaw.cmd"),
            str(home / "AppData" / "Roaming" / "npm" / "openclaw.ps1"),
            str(home / "AppData" / "Local" / "openclaw" / "openclaw.cmd"),
        ]
    else:  # macOS / Linux
        candidates = [
            str(home / ".local" / "bin" / "openclaw"),
            "/usr/local/bin/openclaw",
            "/usr/bin/openclaw",
        ]

    for c in candidates:
        if Path(c).exists():
            return c

    # 3. Fall back to PATH lookup
    return "openclaw"


OPENCLAW_BIN = _find_openclaw_bin()

# ── Test conversation turns ────────────────────────────────────────────────

TEST_TURNS: list[str] = [
    "你好，我叫王小明，我是一名软件工程师，主要用 TypeScript 和 Python。",
    "你还记得我的名字和职业吗？",
    "我正在开发一个记忆系统插件，用于 OpenClaw。请帮我看看需要什么功能。",
    "上周我们讨论过向量检索的性能问题，你当时建议了什么优化方案？",
    "基于我们之前的讨论，总结一下这个记忆系统的架构设计要点。",
]

# Experiment 1: Turn 1 with neutral greeting (no personal info → no L1 injection in clean DB)
EXPERIMENT1_TURNS: list[str] = [
    "你好。",  # Turn 1: neutral, won't trigger L1 recall in clean context
    "你还记得我的名字和职业吗？",
    "我正在开发一个记忆系统插件，用于 OpenClaw。请帮我看看需要什么功能。",
    "上周我们讨论过向量检索的性能问题，你当时建议了什么优化方案？",
    "基于我们之前的讨论，总结一下这个记忆系统的架构设计要点。",
]


# ── Helpers ────────────────────────────────────────────────────────────────


class ExperimentError(Exception):
    """Experiment-level error."""


def log(msg: str) -> None:
    """Timestamped log line."""
    ts = time.strftime("%H:%M:%S")
    print(f"[{ts}] {msg}")


def send_message(
    message: str,
    session_key: str | None = None,
    model: str | None = None,
    extra_env: dict[str, str] | None = None,
    agent: str = "main",
) -> dict[str, Any]:
    """Send a single message via openclaw agent CLI and parse JSON response.

    Uses ``openclaw agent --agent <agent> --message <msg> --json``.
    Multi-turn continuity is maintained via ``--session-key <key>``.
    If ``model`` is None, the agent's default model is used.
    """
    cmd = [OPENCLAW_BIN, "agent", "--agent", agent, "--message", message, "--json"]
    if session_key:
        cmd.extend(["--session-key", session_key])
    if model:
        cmd.extend(["--model", model])

    env = os.environ.copy()
    if extra_env:
        env.update(extra_env)

    log(f"    CMD: {' '.join(cmd[:5])}...")

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=True,
            timeout=120,
            env=env,
        )
    except subprocess.TimeoutExpired:
        raise ExperimentError("openclaw agent timed out after 120s")
    except subprocess.CalledProcessError as e:
        stderr = e.stderr.strip() if e.stderr else "(no stderr)"
        stdout = e.stdout.strip() if e.stdout else "(no stdout)"
        raise ExperimentError(
            f"openclaw agent failed (exit={e.returncode}): stderr={stderr[:500]}, "
            f"stdout={stdout[:500]}"
        )

    stdout = result.stdout.strip()
    if not stdout:
        return {}

    # The output is a single pretty-printed JSON object (not JSONL).
    # Parse the entire stdout as one JSON document.
    try:
        parsed = json.loads(stdout)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass

    # Fallback: try line-by-line JSONL parsing
    lines = stdout.splitlines()
    for line in reversed(lines):
        if '"usage"' in line:
            try:
                parsed = json.loads(line)
                if isinstance(parsed, dict):
                    return parsed
            except json.JSONDecodeError:
                continue

    # Last resort: try each non-empty line as JSON
    for line in reversed(lines):
        line = line.strip()
        if not line:
            continue
        try:
            parsed = json.loads(line)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            continue

    return {}


def extract_usage(resp: dict[str, Any], debug: bool = False) -> dict[str, int]:
    """Extract cache-relevant usage fields from API response.

    Handles both DeepSeek/OpenClaw naming (``cacheRead``, ``input``)
    and standard OpenAI naming (``prompt_cache_hit_tokens``, etc.).
    The usage object is at ``result.meta.agentMeta.usage`` or ``result.meta.agentMeta.lastCallUsage``.
    """
    # Navigate OpenClaw agent JSON structure
    result = resp.get("result", {})
    meta = result.get("meta", {})
    agent_meta = meta.get("agentMeta", {})
    usage = agent_meta.get("lastCallUsage", agent_meta.get("usage", {}))

    if debug:
        # Print available keys at each level for diagnosis
        log(f"    DEBUG resp keys: {list(resp.keys())}")
        log(f"    DEBUG result keys: {list(result.keys()) if isinstance(result, dict) else type(result).__name__}")
        log(f"    DEBUG meta keys: {list(meta.keys()) if isinstance(meta, dict) else type(meta).__name__}")
        log(f"    DEBUG agentMeta keys: {list(agent_meta.keys()) if isinstance(agent_meta, dict) else type(agent_meta).__name__}")
        log(f"    DEBUG usage: {json.dumps(usage, ensure_ascii=False)[:500] if usage else '(empty)'}")

    # Fallback: direct usage key at top level
    if not usage:
        usage = resp.get("usage", {})

    # DeepSeek naming: cacheRead = hit tokens, input = total prompt (including cached)
    cache_read = usage.get("cacheRead", 0)
    raw_input = usage.get("input", 0)

    if cache_read > 0:
        # DeepSeek format: hit = cacheRead, miss = input - cacheRead (≈ new non-cached tokens)
        # Actually, DeepSeek's cacheRead is tokens served from cache,
        # and input is total prompt tokens sent.
        # miss tokens = input (non-cached portion)
        return {
            "prompt_tokens": raw_input + cache_read,
            "completion_tokens": usage.get("output", 0),
            "total_tokens": usage.get("total", 0),
            "cache_hit_tokens": cache_read,
            "cache_miss_tokens": raw_input,
        }

    # Standard OpenAI naming
    prompt_details = usage.get("prompt_tokens_details", {})
    return {
        "prompt_tokens": usage.get("prompt_tokens", 0),
        "completion_tokens": usage.get("completion_tokens", 0),
        "total_tokens": usage.get("total_tokens", 0),
        "cache_hit_tokens": (
            usage.get("prompt_cache_hit_tokens", 0)
            or prompt_details.get("cached_tokens", 0)
        ),
        "cache_miss_tokens": (
            usage.get("prompt_cache_miss_tokens", 0)
            or prompt_details.get("uncached_tokens", 0)
        ),
    }


def hit_rate(usage: dict[str, int]) -> float:
    """Compute cache hit rate: hit / (hit + miss). Returns 0 if no prompt tokens."""
    hit = usage.get("cache_hit_tokens", 0)
    miss = usage.get("cache_miss_tokens", 0)
    total_cached = hit + miss
    if total_cached == 0:
        return 0.0
    return hit / total_cached


# ── Condition management ───────────────────────────────────────────────────


class Condition:
    """Experiment condition with config values."""

    def __init__(self, name: str, show_injected: bool, stable_before_cache: bool):
        self.name = name
        self.show_injected = show_injected
        self.stable_before_cache = stable_before_cache

    @property
    def label(self) -> str:
        labels = {
            "A": "Baseline (showInjected=T, stable=after CACHE_BOUNDARY)",
            "B": "Fix1 only (showInjected=F, stable=after CACHE_BOUNDARY)",
            "C": "Fix2 only (showInjected=T, stable=before CACHE_BOUNDARY)",
            "D": "Combined (showInjected=F, stable=before CACHE_BOUNDARY)",
            "E": "NoInject Turn1 (showInjected=F, stable=before CACHE_BOUNDARY)",
        }
        return labels.get(self.name, self.name)

    def subprocess_env(self) -> dict[str, str]:
        """Extra env vars to pass to the openclaw subprocess for this condition."""
        env: dict[str, str] = {}
        # Control stable content position via env var (read by auto-recall.ts)
        if not self.stable_before_cache:
            env["MEMORY_TDAI_STABLE_SYSTEM_APPEND"] = "1"
        # Control showInjected via env var (read by index.ts before_message_write)
        if self.show_injected:
            env["MEMORY_TDAI_SHOW_INJECTED"] = "1"
        return env


CONDITIONS: dict[str, Condition] = {
    "A": Condition("A", show_injected=True, stable_before_cache=False),
    "B": Condition("B", show_injected=False, stable_before_cache=False),
    "C": Condition("C", show_injected=True, stable_before_cache=True),
    "D": Condition("D", show_injected=False, stable_before_cache=True),
    # Experiment 1: D with neutral Turn 1 (no injection → no strip → prefix intact)
    "E": Condition("E", show_injected=False, stable_before_cache=True),
}

# Labels for Experiment 1 conditions
VERIFY1_LABELS: dict[str, str] = {
    "D": "D_normal (Turn1=full intro → injection → strip → prefix break)",
    "E": "E_noinj  (Turn1=neutral  → no injection → history matches → prefix intact)",
}


# ── Context cleanup ────────────────────────────────────────────────────────


def clean_context() -> None:
    """Delete all session history and memory files for a clean start."""
    log(f"Cleaning context: {PLUGIN_DATA_DIR}")
    if PLUGIN_DATA_DIR.exists():
        # Remove L0 conversation JSONL
        for pattern in ["conversations", "records", "sessions"]:
            target = PLUGIN_DATA_DIR / pattern
            if target.exists():
                if target.is_dir():
                    shutil.rmtree(target, ignore_errors=True)
                else:
                    target.unlink(missing_ok=True)

        # Remove SQLite databases
        for db_file in PLUGIN_DATA_DIR.glob("*.db"):
            db_file.unlink(missing_ok=True)
            for suffix in ["-wal", "-shm"]:
                p = Path(str(db_file) + suffix)
                p.unlink(missing_ok=True)

        # Remove persona and scene files
        for f in ["persona.md", "persona.md.bak", "scene_index.json"]:
            p = PLUGIN_DATA_DIR / f
            p.unlink(missing_ok=True)

        # Remove scene_blocks directory
        scene_blocks = PLUGIN_DATA_DIR / "scene_blocks"
        if scene_blocks.exists():
            shutil.rmtree(scene_blocks, ignore_errors=True)

    PLUGIN_DATA_DIR.mkdir(parents=True, exist_ok=True)
    log("Context cleaned")


# ── Experiment runner ──────────────────────────────────────────────────────


def run_single_experiment(
    condition: Condition,
    iterations: int,
    dry_run: bool = False,
    turns: list[str] | None = None,
    fixed_persona: Path | None = None,
    fixed_scene: Path | None = None,
    extra_env: dict[str, str] | None = None,
) -> list[dict[str, Any]]:
    """Run a single experiment condition for N iterations."""
    _turns = turns if turns is not None else TEST_TURNS
    log(f"\n{'=' * 70}")
    log(f"Condition {condition.name}: {condition.label}")
    log(f"Iterations: {iterations}")
    log(f"Turns: {len(_turns)} (Turn1: '{_turns[0][:50]}...')")
    if fixed_persona:
        log(f"Fixed persona: {fixed_persona}")
    if fixed_scene:
        log(f"Fixed scene: {fixed_scene}")
    log(f"{'=' * 70}")

    all_results: list[dict[str, Any]] = []
    subprocess_env = condition.subprocess_env()
    if extra_env:
        subprocess_env.update(extra_env)
    log(f"    ENV: SHOW_INJECTED={subprocess_env.get('MEMORY_TDAI_SHOW_INJECTED', '(unset)')}, "
        f"STABLE_APPEND={subprocess_env.get('MEMORY_TDAI_STABLE_SYSTEM_APPEND', '(unset)')}, "
        f"DISABLE_PIPELINE={subprocess_env.get('MEMORY_TDAI_DISABLE_PIPELINE', '(unset)')}")

    for iteration in range(1, iterations + 1):
        log(f"\n--- Iteration {iteration}/{iterations} ---")

        # 1. Clean context
        if not dry_run:
            clean_context()
            # Experiment 2: copy fixed static content after clean
            if fixed_persona and fixed_persona.exists():
                shutil.copy(fixed_persona, PLUGIN_DATA_DIR / "persona.md")
                log(f"    Copied fixed persona: {fixed_persona}")
            if fixed_scene and fixed_scene.exists():
                shutil.copy(fixed_scene, PLUGIN_DATA_DIR / "scene_index.json")
                log(f"    Copied fixed scene: {fixed_scene}")
        else:
            log("[DRY RUN] Would clean context")

        # 2. Run multi-turn conversation via openclaw agent CLI
        session_key = f"agent:main:experiment-{condition.name}-{int(time.time())}"
        turn_results: list[dict[str, Any]] = []

        for turn_idx, user_text in enumerate(_turns, 1):
            log(f"  Turn {turn_idx}: '{user_text[:60]}...'")

            if dry_run:
                log(f"    [DRY RUN] Would run: openclaw agent --message \"...\" --json --session-key {session_key}")
                usage = {"prompt_tokens": 1000, "cache_hit_tokens": 0, "cache_miss_tokens": 1000}
            else:
                try:
                    resp = send_message(
                        user_text,
                        session_key=session_key,
                        extra_env=subprocess_env,
                    )
                    # Debug first turn of each iteration to diagnose JSON structure
                    debug = (turn_idx == 1)
                    usage = extract_usage(resp, debug=debug)
                    if debug and usage.get("prompt_tokens", 0) == 0:
                        log(f"    DEBUG raw response (first 1000 chars): {json.dumps(resp, ensure_ascii=False)[:1000]}")
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
            "condition": condition.name,
            "turns": turn_results,
        })

    return all_results


def compute_summary(results: list[dict[str, Any]], num_turns: int = 5) -> dict[str, Any]:
    """Compute summary statistics across iterations."""
    per_turn_rates: dict[int, list[float]] = {i: [] for i in range(1, num_turns + 1)}
    all_rates: list[float] = []

    for iteration in results:
        for turn in iteration["turns"]:
            turn_num = turn["turn"]
            rate = turn["hit_rate"]
            if turn_num > 1:  # Skip cold start (turn 1)
                per_turn_rates[turn_num].append(rate)
                all_rates.append(rate)

    summary: dict[str, Any] = {
        "per_turn": {},
        "average_rate": statistics.mean(all_rates) if all_rates else 0.0,
        "median_rate": statistics.median(all_rates) if all_rates else 0.0,
        "stdev_rate": statistics.stdev(all_rates) if len(all_rates) > 1 else 0.0,
    }

    for turn_num in range(2, num_turns + 1):
        rates = per_turn_rates[turn_num]
        if rates:
            summary["per_turn"][turn_num] = {
                "mean": statistics.mean(rates),
                "stdev": statistics.stdev(rates) if len(rates) > 1 else 0.0,
                "values": rates,
            }

    return summary


# ── Report generation ──────────────────────────────────────────────────────


def print_report(
    all_results: dict[str, tuple[list[dict[str, Any]], dict[str, Any]]],
    mode: str = "ablation",
    num_turns: int = 5,
) -> None:
    """Print a formatted experiment report."""
    if mode == "verify1":
        _print_verify1_report(all_results, num_turns)
    else:
        _print_ablation_report(all_results, num_turns)


def _print_ablation_report(
    all_results: dict[str, tuple[list[dict[str, Any]], dict[str, Any]]],
    num_turns: int,
) -> None:
    """Print ablation experiment report (A/B/C/D)."""
    print("\n" + "=" * 80)
    print("ABLATION EXPERIMENT REPORT — Prompt Cache Hit Rate")
    print("Issue #120: Cache Hit Rate Degradation Fix")
    print("=" * 80)
    print(f"Model: {DEFAULT_MODEL}")
    print(f"CLI:   openclaw agent --json")
    print(f"Turns per iteration: {num_turns}")
    print(f"Date: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print()

    header = f"{'Condition':<12} | " + " | ".join(
        f"Turn {i}" for i in range(2, num_turns + 1)
    )
    header += " | Average | Median | StdDev"
    print(header)
    print("-" * len(header))

    for cond_name in ["A", "B", "C", "D"]:
        if cond_name not in all_results:
            continue
        _, summary = all_results[cond_name]
        turn_strs: list[str] = []
        for turn_num in range(2, num_turns + 1):
            if turn_num in summary["per_turn"]:
                turn_strs.append(f"{summary['per_turn'][turn_num]['mean']:6.1%}")
            else:
                turn_strs.append("   N/A ")
        label = f"Cond {cond_name}"
        print(
            f"{label:<12} | "
            + " | ".join(turn_strs)
            + f" | {summary['average_rate']:6.1%}"
            f" | {summary['median_rate']:6.1%}"
            f" | {summary['stdev_rate']:6.1%}"
        )

    print()

    if "A" in all_results:
        baseline_avg = all_results["A"][1]["average_rate"]
        print(f"Baseline (A) average hit rate: {baseline_avg:.1%}")
        print()
        print(f"{'Condition':<12} | {'Avg Rate':<10} | {'vs Baseline':<12} | Description")
        print("-" * 70)
        for cond_name in ["A", "B", "C", "D"]:
            if cond_name not in all_results:
                continue
            _, summary = all_results[cond_name]
            avg = summary["average_rate"]
            delta = avg - baseline_avg
            desc = CONDITIONS[cond_name].label.split("(")[0].strip()
            print(f"Cond {cond_name:<9} | {avg:7.1%}   | {delta:+.1%}       | {desc}")
        print()

    print("Per-Turn Detailed Breakdown (after cold start, across all iterations):")
    print()
    for cond_name in ["A", "B", "C", "D"]:
        if cond_name not in all_results:
            continue
        results, summary = all_results[cond_name]
        print(f"  Condition {cond_name}: {CONDITIONS[cond_name].label}")
        for turn_num in range(2, num_turns + 1):
            if turn_num in summary["per_turn"]:
                info = summary["per_turn"][turn_num]
                vals = ", ".join(f"{v:.1%}" for v in info["values"])
                print(f"    Turn {turn_num}: avg={info['mean']:.1%}, std={info['stdev']:.1%}, values=[{vals}]")
        print()

    print("=" * 80)
    if "A" in all_results and "D" in all_results:
        a_avg = all_results["A"][1]["average_rate"]
        d_avg = all_results["D"][1]["average_rate"]
        print(f"Combined fix (D) improves cache hit rate by {d_avg - a_avg:+.1%} over baseline (A).")
        if "B" in all_results:
            print(f"Fix 1 alone (B) contributes {all_results['B'][1]['average_rate'] - a_avg:+.1%}.")
        if "C" in all_results:
            print(f"Fix 2 alone (C) contributes {all_results['C'][1]['average_rate'] - a_avg:+.1%}.")
    print("=" * 80)


def _print_verify1_report(
    all_results: dict[str, tuple[list[dict[str, Any]], dict[str, Any]]],
    num_turns: int,
) -> None:
    """Print Experiment 1 (verify1) report comparing D_normal vs E."""
    print("\n" + "=" * 80)
    print("EXPERIMENT 1 — Verify Prefix Break (Inject-then-Strip Mismatch)")
    print("Issue #120: Cache Hit Rate Degradation Fix")
    print("=" * 80)
    print(f"Model: {DEFAULT_MODEL}")
    print(f"CLI:   openclaw agent --json")
    print(f"Turns per iteration: {num_turns}")
    print(f"Date: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print()
    print("Hypothesis: Cond D Turn 2 low hit rate is caused by Turn 1's")
    print("  <relevant-memories> being injected then stripped from history,")
    print("  creating a byte-level mismatch vs the cached prompt.")
    print()
    print("  D_normal: Turn 1 = full intro → triggers L1 injection →")
    print("            showInjected=false strips it → history ≠ cached → prefix break")
    print("  E_noinj:  Turn 1 = '你好' (neutral) → no L1 injection →")
    print("            nothing to strip → history = cached → prefix intact")
    print()

    # Per-turn comparison
    header = f"{'Condition':<16} | " + " | ".join(f"Turn {i}" for i in range(2, num_turns + 1))
    header += " | Average | Median | StdDev"
    print(header)
    print("-" * len(header))

    for cond_name in ["D", "E"]:
        if cond_name not in all_results:
            continue
        _, summary = all_results[cond_name]
        turn_strs: list[str] = []
        for turn_num in range(2, num_turns + 1):
            if turn_num in summary["per_turn"]:
                turn_strs.append(f"{summary['per_turn'][turn_num]['mean']:6.1%}")
            else:
                turn_strs.append("   N/A ")
        label = VERIFY1_LABELS.get(cond_name, cond_name).split("(")[0].strip()
        print(
            f"{label:<16} | "
            + " | ".join(turn_strs)
            + f" | {summary['average_rate']:6.1%}"
            f" | {summary['median_rate']:6.1%}"
            f" | {summary['stdev_rate']:6.1%}"
        )
    print()

    # Key metric: Turn 2 comparison
    print("=" * 80)
    print("KEY METRIC — Turn 2 Cache Hit Rate:")
    print()
    for cond_name in ["D", "E"]:
        if cond_name not in all_results:
            continue
        _, summary = all_results[cond_name]
        if 2 in summary["per_turn"]:
            info = summary["per_turn"][2]
            vals = ", ".join(f"{v:.1%}" for v in info["values"])
            label = VERIFY1_LABELS.get(cond_name, cond_name)
            print(f"  {label}")
            print(f"    Turn 2: avg={info['mean']:.1%}, std={info['stdev']:.1%}, values=[{vals}]")
    print()

    if "D" in all_results and "E" in all_results:
        d_t2 = all_results["D"][1]["per_turn"].get(2, {}).get("mean", 0)
        e_t2 = all_results["E"][1]["per_turn"].get(2, {}).get("mean", 0)
        delta = e_t2 - d_t2
        print(f"  Turn 2 improvement (E − D): {delta:+.1%}")
        print()
        if delta > 30:
            print("  ✓ HYPOTHESIS CONFIRMED: Removing Turn 1 injection eliminates")
            print("    the prefix mismatch → Turn 2 hit rate recovers dramatically.")
            print("    This PROVES the inject-then-strip cycle is the root cause")
            print("    of Condition D's cache degradation.")
        elif delta > 10:
            print("  ~ HYPOTHESIS PARTIALLY SUPPORTED: Turn 2 hit rate improved")
            print("    but not as dramatically as expected. Other factors may be involved.")
        else:
            print("  ✗ HYPOTHESIS REJECTED: Turn 1 injection removal did not")
            print("    significantly improve Turn 2 hit rate. The prefix break")
            print("    must have a different root cause. Investigate further.")

    print()
    print("Per-Turn Detailed Breakdown:")
    for cond_name in ["D", "E"]:
        if cond_name not in all_results:
            continue
        results, summary = all_results[cond_name]
        label = VERIFY1_LABELS.get(cond_name, cond_name)
        print(f"  {label}")
        for turn_num in range(2, num_turns + 1):
            if turn_num in summary["per_turn"]:
                info = summary["per_turn"][turn_num]
                vals = ", ".join(f"{v:.1%}" for v in info["values"])
                print(f"    Turn {turn_num}: avg={info['mean']:.1%}, std={info['stdev']:.1%}, values=[{vals}]")
        print()
    print("=" * 80)


def save_results(
    all_results: dict[str, tuple[list[dict[str, Any]], dict[str, Any]]],
    output_dir: Path,
) -> None:
    """Save raw results to JSON files."""
    output_dir.mkdir(parents=True, exist_ok=True)
    timestamp = time.strftime("%Y%m%d-%H%M%S")

    for cond_name, (results, summary) in all_results.items():
        data = {
            "condition": cond_name,
            "label": CONDITIONS[cond_name].label,
            "showInjected": CONDITIONS[cond_name].show_injected,
            "stableBeforeCache": CONDITIONS[cond_name].stable_before_cache,
            "model": DEFAULT_MODEL,
            "timestamp": timestamp,
            "summary": {k: v for k, v in summary.items() if k != "per_turn"},
            "per_turn": {
                str(k): v for k, v in summary.get("per_turn", {}).items()
            },
            "raw_iterations": results,
        }
        out_path = output_dir / f"experiment-{cond_name}-{timestamp}.json"
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        log(f"Saved results: {out_path}")


# ── Main ───────────────────────────────────────────────────────────────────


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Ablation & verification experiments for Issue #120"
    )
    parser.add_argument(
        "--experiment",
        choices=["ablation", "verify1", "verify2"],
        default="ablation",
        help="Experiment mode: ablation (A/B/C/D), verify1 (prefix break proof), verify2 (fixed static content)",
    )
    parser.add_argument(
        "--condition",
        choices=["A", "B", "C", "D", "E"],
        help="Run a single condition (E only valid with --experiment verify1)",
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="Run all conditions for the selected experiment mode",
    )
    parser.add_argument(
        "--iterations",
        type=int,
        default=3,
        help="Number of iterations per condition (default: 3)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate configuration without making API calls",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("./experiment-results"),
        help="Directory for result JSON files (default: ./experiment-results)",
    )
    parser.add_argument(
        "--model",
        default="",
        help="Model override (default: use agent's configured model)",
    )
    parser.add_argument(
        "--fixed-persona",
        type=Path,
        help="Path to fixed persona.md (Experiment 2: verify2 mode)",
    )
    parser.add_argument(
        "--fixed-scene",
        type=Path,
        help="Path to fixed scene_index.json (Experiment 2: verify2 mode)",
    )
    parser.add_argument(
        "--disable-pipeline",
        action="store_true",
        help="Set MEMORY_TDAI_DISABLE_PIPELINE env var to prevent L2/L3 during experiment",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    if not args.condition and not args.all:
        print("ERROR: Specify --condition <A|B|C|D|E> or --all")
        sys.exit(1)

    global DEFAULT_MODEL
    DEFAULT_MODEL = args.model or "(agent default)"

    mode = args.experiment

    # Determine conditions and turns per mode
    if mode == "verify1":
        conditions_to_run: list[str] = (
            ["D", "E"] if args.all else [args.condition]
        )
        for c in conditions_to_run:
            if c not in ("D", "E"):
                print(f"ERROR: verify1 mode only supports conditions D and E, got '{c}'")
                sys.exit(1)
        turns_d: list[str] | None = TEST_TURNS       # normal Turn 1 (triggers L1)
        turns_e: list[str] | None = EXPERIMENT1_TURNS  # neutral Turn 1 (no L1)
        num_turns = len(TEST_TURNS)
    elif mode == "verify2":
        conditions_to_run = (
            ["C", "D"] if args.all else [args.condition]
        )
        for c in conditions_to_run:
            if c not in ("C", "D"):
                print(f"ERROR: verify2 mode only supports conditions C and D, got '{c}'")
                sys.exit(1)
        turns_d = None  # use TEST_TURNS
        turns_e = None
        num_turns = len(TEST_TURNS)
        if not args.fixed_persona:
            print("ERROR: verify2 requires --fixed-persona path to pre-generated persona.md")
            sys.exit(1)
        if not args.fixed_scene:
            print("ERROR: verify2 requires --fixed-scene path to pre-generated scene_index.json")
            sys.exit(1)
    else:  # ablation
        conditions_to_run = (
            ["A", "B", "C", "D"] if args.all else [args.condition]
        )
        turns_d = None
        turns_e = None
        num_turns = len(TEST_TURNS)

    log("Experiment plan:")
    log(f"  Mode:       {mode}")
    log(f"  Conditions: {conditions_to_run}")
    log(f"  Iterations per condition: {args.iterations}")
    log(f"  Model:      {DEFAULT_MODEL}")
    log(f"  CLI:        openclaw agent --json")
    log(f"  Data:       {PLUGIN_DATA_DIR}")
    log(f"  Dry run:    {args.dry_run}")
    if mode == "verify1":
        log(f"  D Turn1:    '{TEST_TURNS[0][:50]}...' (has injection)")
        log(f"  E Turn1:    '{EXPERIMENT1_TURNS[0][:50]}...' (no injection)")
    if mode == "verify2":
        log(f"  Fixed persona: {args.fixed_persona}")
        log(f"  Fixed scene:   {args.fixed_scene}")
    if args.disable_pipeline:
        log(f"  Pipeline:   DISABLED (MEMORY_TDAI_DISABLE_PIPELINE=1)")
    log("")

    # Verify openclaw CLI is available
    if not args.dry_run:
        try:
            result = subprocess.run(
                [OPENCLAW_BIN, "--version"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=10,
            )
            log(f"openclaw version: {result.stdout.strip() or result.stderr.strip()}")
        except FileNotFoundError:
            log(f"ERROR: '{OPENCLAW_BIN}' not found. Set OPENCLAW_BIN env var or ensure openclaw is in PATH.")
            sys.exit(1)
        except Exception as e:
            log(f"WARNING: Could not verify openclaw CLI: {e}")

    all_results: dict[str, tuple[list[dict[str, Any]], dict[str, Any]]] = {}

    for cond_name in conditions_to_run:
        condition = CONDITIONS[cond_name]

        # Select turns for this condition
        if mode == "verify1":
            _turns = turns_d if cond_name == "D" else turns_e
        else:
            _turns = TEST_TURNS

        # Build extra env: disable pipeline if requested
        extra_env = condition.subprocess_env()
        if args.disable_pipeline:
            extra_env["MEMORY_TDAI_DISABLE_PIPELINE"] = "1"

        results = run_single_experiment(
            condition, args.iterations, args.dry_run,
            turns=_turns,
            fixed_persona=args.fixed_persona if mode == "verify2" else None,
            fixed_scene=args.fixed_scene if mode == "verify2" else None,
            extra_env=extra_env if args.disable_pipeline else None,
        )
        summary = compute_summary(results, num_turns)
        all_results[cond_name] = (results, summary)

        if len(conditions_to_run) > 1 and not args.dry_run:
            log("\nPausing 5s before next condition...")
            time.sleep(5)

    print_report(all_results, mode=mode, num_turns=num_turns)

    if not args.dry_run:
        save_results(all_results, args.output_dir)

    log("Experiment complete.")


if __name__ == "__main__":
    main()
