#!/usr/bin/env python3
"""
Long-conversation cache hit rate test — compares baseline vs split-history
injection for 40-turn conversations.

Motivation:
  In short conversations (5 turns), Cond C (showInjected=T, stable=before
  CACHE_BOUNDARY) achieves ~93% cache hit rate. But as conversations grow,
  the framework's own history rendering accumulates. When total context
  triggers dynamic truncation, the truncation point shifts every turn →
  prefix cache always misses.

  The split-history mechanism:
  1. Compresses old messages into stable summaries → prependSystemContext
     (before CACHE_BOUNDARY → cached). Only changes on compression events.
  2. Keeps recent messages in prependContext (at prompt tail → not cached).
  3. This increases the cached byte count (summaries join persona+scene+tools
     in the stable prefix) without occluding the base system prompt.

Design (avoids randomness):
  - Fixed persona/scene files (pre-generated with --setup)
  - Fixed 40-turn conversation script (deterministic content)
  - Pipeline disabled (MEMORY_TDAI_DISABLE_PIPELINE=1)
  - Both conditions use showInjected=true, stable=before CACHE_BOUNDARY
    (Cond C from the ablation experiment — optimal config)
  - The ONLY variable difference between conditions is history.enabled

Conditions:
  BASELINE:  history.enabled = false
  SPLIT:     history.enabled = true  (split: summaries→prependSystem, recent→prependContext)

Usage:
  # Step 1: Generate fixed persona/scene files (run once)
  python scripts/run_long_conversation_test.py --setup

  # Step 2: Run the comparison test
  python scripts/run_long_conversation_test.py --iterations 1 --turns 40

  # Step 3: Run with simulated truncation to test cache under pressure
  python scripts/run_long_conversation_test.py --iterations 1 --turns 40 --simulated-window 10000

  # Dry run (validate configs without API calls)
  python scripts/run_long_conversation_test.py --iterations 1 --dry-run
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
DEFAULT_MODEL = os.environ.get("EXPERIMENT_MODEL", "")
SCRIPT_DIR = Path(__file__).resolve().parent
FIXED_PERSONA = SCRIPT_DIR / "fixtures" / "longconv-persona.md"
FIXED_SCENE = SCRIPT_DIR / "fixtures" / "longconv-scene_index.json"


def _find_openclaw_bin() -> str:
    explicit = os.environ.get("OPENCLAW_BIN")
    if explicit:
        return explicit
    home = Path.home()
    if os.name == "nt":
        candidates = [
            str(home / "AppData" / "Roaming" / "npm" / "openclaw.cmd"),
            str(home / "AppData" / "Roaming" / "npm" / "openclaw.ps1"),
            str(home / "AppData" / "Local" / "openclaw" / "openclaw.cmd"),
        ]
    else:
        candidates = [
            str(home / ".local" / "bin" / "openclaw"),
            "/usr/local/bin/openclaw",
            "/usr/bin/openclaw",
        ]
    for c in candidates:
        if Path(c).exists():
            return c
    return "openclaw"


OPENCLAW_BIN = _find_openclaw_bin()


# ── Fixed 30-turn conversation ─────────────────────────────────────────────
#
# Simulates a coherent development discussion about building a task-tracker app.
# Each turn references prior context to make the conversation realistic.
# Turn 1 establishes identity (triggers L1 memory creation on capture).

LONG_CONVERSATION_TURNS: list[str] = [
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

    # Phase 6: 优化与部署 (Turns 26-30)
    "应用基本功能完成了。现在要优化性能：任务列表加虚拟滚动，API 响应加缓存。",
    "虚拟滚动用什么库？react-window 还是 react-virtuoso？我有大约 500 条任务。",
    "用 react-window 实现了虚拟滚动，但任务卡片高度不固定，FixedSizeList 不合适。怎么办？",
    "切换到 react-virtuoso 解决了不等高问题。现在部署到哪？Docker Compose 还是直接用 Vercel？",
    "好的，我们用 Docker Compose。帮我写 docker-compose.yml：PostgreSQL + FastAPI + Nginx + React。",

    # Phase 7: 性能调优与监控 (Turns 31-35)
    "Docker Compose 写好了，但是现在 API 响应很慢。帮我分析一下可能的性能瓶颈。",
    "数据库查询慢可能是因为缺少索引。帮我给 Task 表加索引：status、priority、due_date、user_id 各一个。",
    "索引加完后查询快了，但创建任务变慢了。是不是索引太多了？",
    "帮我在 FastAPI 里添加一个 /health 端点，返回数据库连接状态和 API 版本信息。",
    "健康检查端点写好了。现在要加请求日志中间件，记录每个请求的耗时、状态码和用户 ID。",

    # Phase 8: 测试与 CI/CD (Turns 36-40)
    "功能都完成了，开始写测试。先给 Task CRUD 写 pytest 单元测试。",
    "后端测试写好了。前端用 Vitest + React Testing Library 写登录页面的测试。",
    "帮我配置 GitHub Actions：跑 lint、test、build，三个 job 并行执行。",
    "CI 配好了。现在要加一个 staging 环境的 docker-compose，和 production 的区别是 DEBUG=true。",
    "最后帮我写一个 Makefile，包含 setup、test、build、deploy-staging、deploy-prod 这些 target。",
]


# ── Fixture generation ─────────────────────────────────────────────────────

FIXED_PERSONA_CONTENT = """# 张伟 (Zhang Wei)

## 基本信息
- 姓名：张伟
- 职业：全栈工程师
- 技术栈：React, TypeScript, FastAPI, Python, PostgreSQL, Docker
- 工作经验：5年

## 技术偏好
- 前端：React + TypeScript + Vite，状态管理用 Zustand
- 后端：FastAPI + SQLAlchemy + PostgreSQL
- 认证：JWT (access token + refresh token)
- 部署：Docker Compose
- 代码风格：函数式组件，类型安全，RESTful API

## 项目偏好
- 喜欢分层架构（router → service → repository）
- 数据库使用软删除而非硬删除
- API 设计遵循 RESTful 规范
- 前端表单偏好 React Hook Form
- 长列表使用虚拟滚动优化性能
"""

FIXED_SCENE_CONTENT = [
    {
        "name": "task-tracker-backend",
        "description": "任务管理应用后端开发，使用 FastAPI + SQLAlchemy + PostgreSQL，包含 Task CRUD API 和 JWT 认证",
        "path": "scene_blocks/task-tracker-backend.md",
    },
    {
        "name": "task-tracker-frontend",
        "description": "任务管理应用前端开发，使用 React + TypeScript + Vite + Zustand，包含登录、任务列表、创建/编辑/删除功能",
        "path": "scene_blocks/task-tracker-frontend.md",
    },
]


def generate_fixtures() -> None:
    """Generate fixed persona and scene files for the experiment."""
    fixtures_dir = SCRIPT_DIR / "fixtures"
    fixtures_dir.mkdir(parents=True, exist_ok=True)

    # Write persona
    FIXED_PERSONA.write_text(FIXED_PERSONA_CONTENT, encoding="utf-8")
    print(f"[setup] Wrote persona: {FIXED_PERSONA}")

    # Write scene index
    FIXED_SCENE.write_text(json.dumps(FIXED_SCENE_CONTENT, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[setup] Wrote scene index: {FIXED_SCENE}")

    # Write scene block files
    scene_blocks_dir = fixtures_dir / "scene_blocks"
    scene_blocks_dir.mkdir(parents=True, exist_ok=True)

    backend_scene = (scene_blocks_dir / "task-tracker-backend.md")
    backend_scene.write_text("""# Task Tracker Backend

## 架构
- 框架：FastAPI
- ORM：SQLAlchemy (async)
- 数据库：PostgreSQL
- 认证：JWT (OAuth2PasswordBearer)

## API 端点
- POST /api/auth/register — 用户注册
- POST /api/auth/login — 用户登录
- GET /api/tasks — 任务列表（分页 + 状态筛选）
- POST /api/tasks — 创建任务
- GET /api/tasks/{id} — 任务详情
- PATCH /api/tasks/{id} — 部分更新任务
- DELETE /api/tasks/{id} — 软删除任务

## 数据模型
Task: id, title, description, status(enum), priority(enum), created_at, due_date, is_deleted, user_id
User: id, email, username, hashed_password, created_at
""", encoding="utf-8")
    print(f"[setup] Wrote scene block: {backend_scene}")

    frontend_scene = (scene_blocks_dir / "task-tracker-frontend.md")
    frontend_scene.write_text("""# Task Tracker Frontend

## 技术栈
- 构建工具：Vite
- 框架：React 18 + TypeScript
- 状态管理：Zustand
- 表单：React Hook Form
- 虚拟滚动：react-virtuoso
- UI：自定义 CSS Modules

## 页面
- /login — 登录页
- /tasks — 任务列表（卡片布局 + 状态筛选）
- /tasks/new — 创建任务
- /tasks/:id/edit — 编辑任务

## 组件树
App → AuthProvider → Router → LoginPage | TaskListPage | TaskFormPage

## 状态设计
- authStore: user, token, login(), logout()
- taskStore: tasks, filters, createTask(), updateTask(), deleteTask(), fetchTasks()
""", encoding="utf-8")
    print(f"[setup] Wrote scene block: {frontend_scene}")

    print("\n[setup] Fixtures generated successfully.")
    print(f"  Persona: {FIXED_PERSONA}")
    print(f"  Scene:   {FIXED_SCENE}")
    print(f"  Blocks:  {scene_blocks_dir}")


# ── Helpers ────────────────────────────────────────────────────────────────


class ExperimentError(Exception):
    """Experiment-level error."""


def log(msg: str) -> None:
    ts = time.strftime("%H:%M:%S")
    print(f"[{ts}] {msg}")


def send_message(
    message: str,
    session_key: str | None = None,
    model: str | None = None,
    extra_env: dict[str, str] | None = None,
    agent: str = "main",
) -> dict[str, Any]:
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

    try:
        parsed = json.loads(stdout)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass

    lines = stdout.splitlines()
    for line in reversed(lines):
        if '"usage"' in line:
            try:
                parsed = json.loads(line)
                if isinstance(parsed, dict):
                    return parsed
            except json.JSONDecodeError:
                continue

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
    # OpenClaw response can have meta at two levels depending on CLI version:
    #   1. {"result": {"meta": {"agentMeta": {"usage": ...}}}}
    #   2. {"payloads": [...], "meta": {"agentMeta": {"usage": ...}}}
    result = resp.get("result", {})
    meta = result.get("meta", {}) or resp.get("meta", {})
    agent_meta = meta.get("agentMeta", {})
    usage = agent_meta.get("lastCallUsage", agent_meta.get("usage", {}))

    if debug and not usage:
        log(f"    DEBUG resp keys: {list(resp.keys())}")
        log(f"    DEBUG result keys: {list(result.keys()) if isinstance(result, dict) else type(result).__name__}")
        log(f"    DEBUG meta keys: {list(meta.keys()) if isinstance(meta, dict) else type(meta).__name__}")
        if agent_meta:
            log(f"    DEBUG agentMeta keys: {list(agent_meta.keys()) if isinstance(agent_meta, dict) else type(agent_meta).__name__}")

    if not usage:
        usage = resp.get("usage", {})

    cache_read = usage.get("cacheRead", 0)
    raw_input = usage.get("input", 0)

    if cache_read > 0:
        return {
            "prompt_tokens": raw_input + cache_read,
            "completion_tokens": usage.get("output", 0),
            "total_tokens": usage.get("total", 0),
            "cache_hit_tokens": cache_read,
            "cache_miss_tokens": raw_input,
        }

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
    hit = usage.get("cache_hit_tokens", 0)
    miss = usage.get("cache_miss_tokens", 0)
    total = hit + miss
    if total == 0:
        return 0.0
    return hit / total


# ── Context cleanup ────────────────────────────────────────────────────────


def clean_context() -> None:
    log(f"Cleaning context: {PLUGIN_DATA_DIR}")
    if PLUGIN_DATA_DIR.exists():
        for pattern in ["conversations", "records", "sessions"]:
            target = PLUGIN_DATA_DIR / pattern
            if target.exists():
                if target.is_dir():
                    shutil.rmtree(target, ignore_errors=True)
                else:
                    target.unlink(missing_ok=True)

        for db_file in PLUGIN_DATA_DIR.glob("*.db"):
            db_file.unlink(missing_ok=True)
            for suffix in ["-wal", "-shm"]:
                p = Path(str(db_file) + suffix)
                p.unlink(missing_ok=True)

        for f in ["persona.md", "persona.md.bak", "scene_index.json"]:
            p = PLUGIN_DATA_DIR / f
            p.unlink(missing_ok=True)

        scene_blocks = PLUGIN_DATA_DIR / "scene_blocks"
        if scene_blocks.exists():
            shutil.rmtree(scene_blocks, ignore_errors=True)

    PLUGIN_DATA_DIR.mkdir(parents=True, exist_ok=True)
    log("Context cleaned")


def setup_fixed_content() -> None:
    """Copy fixed persona/scene fixtures to plugin data dir."""
    if not FIXED_PERSONA.exists() or not FIXED_SCENE.exists():
        log("ERROR: Fixed fixtures not found. Run --setup first.")
        sys.exit(1)

    shutil.copy(FIXED_PERSONA, PLUGIN_DATA_DIR / "persona.md")
    log(f"  Copied fixed persona ({FIXED_PERSONA.stat().st_size} bytes)")

    shutil.copy(FIXED_SCENE, PLUGIN_DATA_DIR / "scene_index.json")
    log(f"  Copied fixed scene index ({FIXED_SCENE.stat().st_size} bytes)")

    # Copy scene block files
    fixtures_scene_blocks = SCRIPT_DIR / "fixtures" / "scene_blocks"
    target_scene_blocks = PLUGIN_DATA_DIR / "scene_blocks"
    if fixtures_scene_blocks.exists():
        if target_scene_blocks.exists():
            shutil.rmtree(target_scene_blocks, ignore_errors=True)
        shutil.copytree(fixtures_scene_blocks, target_scene_blocks)
        log(f"  Copied scene blocks from {fixtures_scene_blocks}")


# ── Experiment runner ──────────────────────────────────────────────────────


def run_long_conversation(
    history_enabled: bool,
    iterations: int,
    dry_run: bool = False,
    num_turns: int = 40,
    model: str | None = None,
    simulated_window: int | None = None,
) -> list[dict[str, Any]]:
    """Run a long-conversation experiment.

    Args:
        history_enabled: Whether to enable the split-history mechanism.
        iterations: Number of iterations to run.
        dry_run: If True, skip API calls.
        num_turns: Number of conversation turns (max 40).
        model: Model override.
        simulated_window: If set, adds MEMORY_TDAI_SIMULATED_CONTEXT_WINDOW
            to simulate a short context window (tests cache under truncation).
    """
    label = "SPLIT (history.enabled=true)" if history_enabled else "BASELINE (history.enabled=false)"
    turns = LONG_CONVERSATION_TURNS[:num_turns]

    log(f"\n{'=' * 70}")
    log(f"Condition: {label}")
    log(f"Iterations: {iterations}")
    log(f"Turns: {len(turns)}")
    if simulated_window:
        log(f"Simulated window: {simulated_window} tokens")
    log(f"{'=' * 70}")

    # Base env: Cond C settings (showInjected=true, stable=before CACHE_BOUNDARY)
    # + disable pipeline for deterministic results
    extra_env: dict[str, str] = {
        "MEMORY_TDAI_SHOW_INJECTED": "1",         # showInjected=true (Cond C)
        "MEMORY_TDAI_DISABLE_PIPELINE": "1",       # no background processing
        # MEMORY_TDAI_STABLE_SYSTEM_APPEND is NOT set → stable content before CACHE_BOUNDARY
    }
    if simulated_window:
        extra_env["MEMORY_TDAI_SIMULATED_CONTEXT_WINDOW"] = str(simulated_window)
    if history_enabled:
        extra_env["MEMORY_TDAI_HISTORY_ENABLED"] = "1"

    env_parts = [
        f"SHOW_INJECTED={extra_env.get('MEMORY_TDAI_SHOW_INJECTED', '(unset)')}",
        f"DISABLE_PIPELINE={extra_env.get('MEMORY_TDAI_DISABLE_PIPELINE', '(unset)')}",
        f"SIMULATED_WINDOW={extra_env.get('MEMORY_TDAI_SIMULATED_CONTEXT_WINDOW', '(unset)')}",
        f"HISTORY_ENABLED={extra_env.get('MEMORY_TDAI_HISTORY_ENABLED', '(unset)')}",
    ]
    log(f"    ENV: {', '.join(env_parts)}")

    all_results: list[dict[str, Any]] = []

    for iteration in range(1, iterations + 1):
        log(f"\n--- Iteration {iteration}/{iterations} ---")

        # 1. Clean context + setup fixed content
        if not dry_run:
            clean_context()
            setup_fixed_content()
        else:
            log("[DRY RUN] Would clean context and setup fixed content")

        # 2. Run multi-turn conversation
        session_key = f"agent:main:longconv-{'reversed' if history_enabled else 'baseline'}-{int(time.time())}"
        turn_results: list[dict[str, Any]] = []

        for turn_idx, user_text in enumerate(turns, 1):
            log(f"  Turn {turn_idx}/{len(turns)}: '{user_text[:60]}...'")

            if dry_run:
                log(f"    [DRY RUN] Would run: openclaw agent --message \"...\" --json --session-key {session_key}")
                usage = {"prompt_tokens": 1000, "cache_hit_tokens": 0, "cache_miss_tokens": 1000}
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
            "condition": "reversed" if history_enabled else "baseline",
            "turns": turn_results,
        })

    return all_results


def compute_summary(results: list[dict[str, Any]], num_turns: int) -> dict[str, Any]:
    """Compute summary statistics with phase breakdown."""
    per_turn_rates: dict[int, list[float]] = {i: [] for i in range(1, num_turns + 1)}
    all_rates: list[float] = []

    for iteration in results:
        for turn in iteration["turns"]:
            turn_num = turn["turn"]
            rate = turn["hit_rate"]
            if turn_num > 1:  # Skip cold start
                per_turn_rates[turn_num].append(rate)
                all_rates.append(rate)

    # Phase breakdown: early (2-10), mid (11-20), late (21+)
    phases = {"early": (2, 10), "mid": (11, 20), "late": (21, num_turns)}
    phase_rates: dict[str, list[float]] = {}
    for phase_name, (start, end) in phases.items():
        phase_vals: list[float] = []
        for turn_num in range(start, end + 1):
            phase_vals.extend(per_turn_rates.get(turn_num, []))
        phase_rates[phase_name] = phase_vals

    summary: dict[str, Any] = {
        "per_turn": {},
        "per_phase": {},
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

    for phase_name, vals in phase_rates.items():
        if vals:
            summary["per_phase"][phase_name] = {
                "mean": statistics.mean(vals),
                "stdev": statistics.stdev(vals) if len(vals) > 1 else 0.0,
                "count": len(vals),
            }

    return summary


# ── Report ─────────────────────────────────────────────────────────────────


def print_report(
    baseline_results: list[dict[str, Any]],
    reversed_results: list[dict[str, Any]],
    num_turns: int,
) -> None:
    """Print comparison report."""
    baseline_summary = compute_summary(baseline_results, num_turns)
    reversed_summary = compute_summary(reversed_results, num_turns)

    print("\n" + "=" * 80)
    print("LONG CONVERSATION CACHE HIT RATE TEST")
    print(f"Turns: {num_turns} | Model: {DEFAULT_MODEL or '(agent default)'}")
    print(f"Date:  {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 80)

    # Overall comparison
    print(f"\n{'Metric':<25} | {'BASELINE':<15} | {'SPLIT':<15} | Delta")
    print("-" * 75)
    print(f"{'Average Hit Rate':<25} | {baseline_summary['average_rate']:>14.1%} | {reversed_summary['average_rate']:>14.1%} | {reversed_summary['average_rate'] - baseline_summary['average_rate']:+.1%}")
    print(f"{'Median Hit Rate':<25} | {baseline_summary['median_rate']:>14.1%} | {reversed_summary['median_rate']:>14.1%} | {reversed_summary['median_rate'] - baseline_summary['median_rate']:+.1%}")
    print(f"{'StdDev':<25} | {baseline_summary['stdev_rate']:>14.1%} | {reversed_summary['stdev_rate']:>14.1%} |")
    print()

    # Phase breakdown
    print(f"{'Phase':<15} | {'BASELINE':<12} | {'SPLIT':<12} | Delta")
    print("-" * 55)
    for phase_name in ["early", "mid", "late"]:
        b = baseline_summary["per_phase"].get(phase_name, {})
        r = reversed_summary["per_phase"].get(phase_name, {})
        if b and r:
            delta = r["mean"] - b["mean"]
            print(f"{phase_name:<15} | {b['mean']:>11.1%} | {r['mean']:>11.1%} | {delta:+.1%}")
    print()

    # Per-turn breakdown
    print("Per-Turn Hit Rate Comparison (after cold start):")
    print(f"{'Turn':<6} | {'BASELINE':<10} | {'SPLIT':<10} | Delta")
    print("-" * 45)
    for turn_num in range(2, num_turns + 1):
        b_info = baseline_summary["per_turn"].get(turn_num)
        r_info = reversed_summary["per_turn"].get(turn_num)
        if b_info and r_info:
            delta = r_info["mean"] - b_info["mean"]
            marker = " !" if abs(delta) > 0.1 else ""
            print(f"{turn_num:<6} | {b_info['mean']:>9.1%} | {r_info['mean']:>9.1%} | {delta:+.1%}{marker}")
    print()

    # Interpretation
    print("─" * 80)
    print("INTERPRETATION:")
    print("─" * 80)

    b_early = baseline_summary["per_phase"].get("early", {}).get("mean", 0)
    b_late = baseline_summary["per_phase"].get("late", {}).get("mean", 0)
    r_early = reversed_summary["per_phase"].get("early", {}).get("mean", 0)
    r_late = reversed_summary["per_phase"].get("late", {}).get("mean", 0)

    b_degradation = b_early - b_late
    r_degradation = r_early - r_late

    print(f"  Baseline hit rate degradation (early→late): {b_degradation:+.1%}")
    print(f"  Split     hit rate degradation (early→late): {r_degradation:+.1%}")
    print()

    if r_degradation < b_degradation - 0.05:
        print("  ✓ Split history reduces cache degradation in long conversations.")
        print("    Compressed summaries in prependSystemContext contribute to cached")
        print("    tokens without occluding the base system prompt.")
    elif abs(r_degradation - b_degradation) <= 0.05:
        print("  ~ Degradation is similar between baseline and split history.")
        print("    At this conversation length, the summary contribution may not")
        print("    yet be measurable. Consider more turns or --simulated-window.")
    else:
        print("  ✗ Split history shows MORE degradation than baseline.")
        print("    The additional summary content may be inflating the")
        print("    system prompt beyond what cache coverage saves.")

    print()
    print("Key metrics to watch:")
    print("  1. Average hit rate: higher is better")
    print("  2. Phase degradation: smaller drop from early→late is better")
    print("  3. Per-turn stability: consistent rates across turns indicate")
    print("     no truncation-triggered cache invalidation")
    print("=" * 80)


# ── Main ───────────────────────────────────────────────────────────────────


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Long-conversation cache hit rate test — compares baseline vs split-history injection",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Generate fixtures first
  python run_long_conversation_test.py --setup

  # Run comparison with default 40 turns
  python run_long_conversation_test.py --iterations 1

  # Run with simulated truncation to test cache under pressure
  python run_long_conversation_test.py --iterations 1 --simulated-window 10000

  # Dry run
  python run_long_conversation_test.py --iterations 1 --dry-run
""",
    )
    parser.add_argument("--setup", action="store_true", help="Generate fixed persona/scene fixtures")
    parser.add_argument("--iterations", type=int, default=1, help="Number of iterations per condition (default: 1)")
    parser.add_argument("--turns", type=int, default=40, help="Number of conversation turns (default: 40, max: 40)")
    parser.add_argument("--model", type=str, default=None, help="Model override (default: agent's configured default)")
    parser.add_argument("--simulated-window", type=int, default=None, help="Simulated context window in tokens (e.g. 10000). Simulates truncation pressure for testing cache behavior.")
    parser.add_argument("--dry-run", action="store_true", help="Validate configs without API calls")
    args = parser.parse_args()

    if args.setup:
        generate_fixtures()
        return

    num_turns = min(args.turns, len(LONG_CONVERSATION_TURNS))
    if args.turns > len(LONG_CONVERSATION_TURNS):
        log(f"WARNING: Requested {args.turns} turns but only {len(LONG_CONVERSATION_TURNS)} are defined. Using {num_turns}.")

    print("=" * 80)
    print("LONG CONVERSATION CACHE HIT RATE TEST — SPLIT HISTORY")
    print(f"Turns: {num_turns} | Iterations: {args.iterations} | Dry run: {args.dry_run}")
    print(f"Model: {args.model or '(agent default)'}")
    print(f"OpenCLaw binary: {OPENCLAW_BIN}")
    print(f"State dir: {OPENCLAW_STATE_DIR}")
    if args.simulated_window:
        print(f"Simulated window: {args.simulated_window} tokens")
    print(f"Controlled variables: showInjected=true, stable=before CACHE_BOUNDARY, pipeline=disabled")
    print(f"Independent variable: history.enabled (BASELINE=false vs SPLIT=true)")
    print("=" * 80)

    if not args.dry_run:
        if not FIXED_PERSONA.exists() or not FIXED_SCENE.exists():
            log("Fixtures not found. Generating...")
            generate_fixtures()

    # Run baseline
    log("\n" + "=" * 80)
    log("PHASE 1/2: BASELINE (history.enabled=false)")
    log("=" * 80)
    baseline_results = run_long_conversation(
        history_enabled=False,
        iterations=args.iterations,
        dry_run=args.dry_run,
        num_turns=num_turns,
        model=args.model,
        simulated_window=args.simulated_window,
    )

    # Run split
    log("\n" + "=" * 80)
    log("PHASE 2/2: SPLIT (history.enabled=true)")
    log("=" * 80)
    split_results = run_long_conversation(
        history_enabled=True,
        iterations=args.iterations,
        dry_run=args.dry_run,
        num_turns=num_turns,
        model=args.model,
        simulated_window=args.simulated_window,
    )

    # Report
    print_report(baseline_results, split_results, num_turns)

    # Save results
    results_dir = SCRIPT_DIR / "experiment-results"
    results_dir.mkdir(parents=True, exist_ok=True)
    timestamp = time.strftime("%Y%m%d-%H%M%S")
    window_suffix = f"-win{args.simulated_window}" if args.simulated_window else ""
    result_file = results_dir / f"longconv-{num_turns}t-{args.iterations}i{window_suffix}-{timestamp}.json"
    result_file.write_text(
        json.dumps({
            "config": {
                "turns": num_turns,
                "iterations": args.iterations,
                "model": DEFAULT_MODEL,
                "simulated_window": args.simulated_window,
                "timestamp": timestamp,
            },
            "baseline": [{"iteration": r["iteration"], "turns": r["turns"]} for r in baseline_results],
            "split": [{"iteration": r["iteration"], "turns": r["turns"]} for r in split_results],
        }, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    log(f"\nResults saved to: {result_file}")


if __name__ == "__main__":
    main()
