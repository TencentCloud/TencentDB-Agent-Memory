from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from .client import TdaiGatewayClient
from .config import TdaiOpenHandsConfig, load_config
from .install import install_integration


BUILTIN_SWEBENCH_SEEDS = [
    "在 SWE-bench bug-fix 任务中，先运行或读取 FAIL_TO_PASS 针对性测试，再基于 issue 描述定位最小相关代码路径，避免一开始做大范围重构。",
    "修复软件工程 bug 时，优先构造最小复现脚本或最小测试命令；确认失败现象后再修改代码，修改后重新运行同一个复现命令。",
    "处理 pylint 或 pyreverse 相关问题时，优先检查 pylint/pyreverse/writer.py、inspector.py、diagrams.py 以及 dot graph 序列化逻辑，重点关注输出格式、label 序列化、edge/node 渲染问题。",
    "在 pyreverse 图输出相关 bug 中，先检查 DOT 输出中的 node、edge、label、rankdir、package/module/class 关系，而不是优先怀疑 astroid 推断逻辑。",
    "提交 SWE-bench bug-fix patch 前，删除临时 reproduce 脚本、inspect 脚本、debug 输出文件和生成的 dot 文件，只保留修复代码与必要测试。",
]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Launch OpenHands with TencentDB Agent Memory.")
    parser.add_argument(
        "--launcher-config",
        default=str(Path(__file__).resolve().parents[1] / "configs" / "tdai-openhands-launcher.yaml"),
        help="Path to the launcher YAML/JSON config.",
    )
    parser.add_argument("--tdai-config", help="Override the TDAI OpenHands adapter config path.")
    parser.add_argument("--skip-gateway", action="store_true", help="Do not check or auto-start the TDAI Gateway.")
    parser.add_argument("--skip-seed", action="store_true", help="Skip seed memory injection.")
    parser.add_argument(
        "command",
        nargs="?",
        choices=("tui", "terminal", "install", "seed"),
        default="tui",
    )
    parser.add_argument("openhands_args", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)

    launcher_path = Path(args.launcher_config).expanduser().resolve()
    launcher = _read_mapping(launcher_path)
    base_dir = launcher_path.parent

    tdai_config_path = args.tdai_config or launcher.get("tdai_config")
    resolved_tdai_config = (
        _resolve_path(tdai_config_path, base_dir) if tdai_config_path else None
    )
    tdai_config = load_config(resolved_tdai_config)
    log_dir = _resolve_path(launcher.get("log_dir", ".tdai-launcher/openhands"), base_dir)
    log_dir.mkdir(parents=True, exist_ok=True)

    openhands_config = launcher.get("openhands", {})
    integration_config = launcher.get("integration", {})
    if args.command == "install" or bool(integration_config.get("install_on_launch", True)):
        result = _install_openhands_integration(
            integration_config,
            openhands_config,
            tdai_config,
            resolved_tdai_config,
            base_dir,
        )
        print(f"[tdai] OpenHands hooks ready: {result.hooks_path}")
        if result.mcp_path:
            print(f"[tdai] OpenHands MCP ready: {result.mcp_path}")
        if args.command == "install":
            return 0

    gateway_process: subprocess.Popen[str] | None = None
    try:
        if not args.skip_gateway:
            gateway_process = _ensure_gateway(launcher.get("gateway", {}), tdai_config, base_dir, log_dir)
        if args.command == "seed":
            _seed_gateway(tdai_config, launcher.get("seed", {}), base_dir, log_dir)
            return 0
        if not args.skip_seed:
            _seed_gateway(tdai_config, launcher.get("seed", {}), base_dir, log_dir)
        extra_args = _strip_remainder_separator(args.openhands_args)
        return _run_openhands_terminal(
            openhands_config,
            tdai_config,
            resolved_tdai_config,
            base_dir,
            extra_args,
        )
    finally:
        if gateway_process is not None and launcher.get("gateway", {}).get("stop_on_exit", True):
            gateway_process.terminate()
            try:
                gateway_process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                gateway_process.kill()


def _ensure_gateway(
    gateway_launcher: dict[str, Any],
    tdai_config: TdaiOpenHandsConfig,
    base_dir: Path,
    log_dir: Path,
) -> subprocess.Popen[str] | None:
    if _gateway_healthy(tdai_config):
        print(f"[tdai] Gateway ready: {tdai_config.gateway.url}")
        return None
    if not bool(gateway_launcher.get("auto_start", False)):
        raise SystemExit(f"TDAI Gateway is not reachable at {tdai_config.gateway.url}. Start it or set gateway.auto_start=true.")

    command = _command(gateway_launcher.get("command"))
    if not command:
        raise SystemExit("gateway.command is required when gateway.auto_start=true")
    cwd = _resolve_path(gateway_launcher.get("cwd", "."), base_dir)
    env = _merged_env(gateway_launcher.get("env", {}))
    stdout = (log_dir / "tdai-gateway.stdout.log").open("a", encoding="utf-8")
    stderr = (log_dir / "tdai-gateway.stderr.log").open("a", encoding="utf-8")
    print(f"[tdai] Starting Gateway: {' '.join(command)}")
    process = subprocess.Popen(command, cwd=str(cwd), env=env, stdout=stdout, stderr=stderr, text=True)

    timeout = float(gateway_launcher.get("startup_timeout_seconds", 45))
    deadline = time.time() + timeout
    while time.time() < deadline:
        if process.poll() is not None:
            raise SystemExit(f"TDAI Gateway exited early with code {process.returncode}. See {log_dir}")
        if _gateway_healthy(tdai_config):
            print(f"[tdai] Gateway ready: {tdai_config.gateway.url}")
            return process
        time.sleep(1)
    raise SystemExit(f"TDAI Gateway did not become ready within {timeout:.0f}s. See {log_dir}")


def _gateway_healthy(tdai_config: TdaiOpenHandsConfig) -> bool:
    try:
        data = TdaiGatewayClient(tdai_config.gateway).health()
    except Exception:
        return False
    return "_tdai_error" not in data


def _seed_gateway(
    tdai_config: TdaiOpenHandsConfig,
    seed_config: dict[str, Any],
    base_dir: Path,
    log_dir: Path,
) -> None:
    if not bool(seed_config.get("enabled", False)):
        return
    items = _seed_items(seed_config, base_dir)
    if not items:
        print("[tdai] Seed enabled but no seed items were provided.")
        return

    session_key = str(seed_config.get("session_key") or "tdai-seed/software-engineering")
    session_id = str(seed_config.get("session_id") or "tdai-seed-software-engineering")
    user_id = str(seed_config.get("user_id") or tdai_config.session.user_id)
    delay_seconds = float(seed_config.get("delay_seconds", 20))
    assistant_ack = str(seed_config.get("assistant_ack") or "已记录这条工程经验。")
    client = TdaiGatewayClient(tdai_config.gateway)
    log_path = log_dir / "seed-capture.jsonl"

    print(f"[tdai] Seeding {len(items)} engineering memories into session_key={session_key!r}")
    base_timestamp = int(time.time() * 1000) + 5000
    with log_path.open("a", encoding="utf-8") as log_file:
        for index, item in enumerate(items, start=1):
            timestamp = base_timestamp + index * 2000
            messages = [
                {"role": "user", "content": item, "timestamp": timestamp},
                {"role": "assistant", "content": assistant_ack, "timestamp": timestamp + 1000},
            ]
            result = client.capture(
                user_content=item,
                assistant_content=assistant_ack,
                session_key=session_key,
                session_id=session_id,
                user_id=user_id,
                messages=messages,
            )
            log_file.write(json.dumps({"index": index, "item": item, "result": result.raw}, ensure_ascii=False) + "\n")
            log_file.flush()
            print(f"[tdai] Seed {index}/{len(items)} captured; l0_recorded={result.l0_recorded}")
            if delay_seconds > 0 and index < len(items):
                time.sleep(delay_seconds)

    if bool(seed_config.get("session_end", True)):
        response = client.session_end(session_key=session_key, user_id=user_id)
        (log_dir / "seed-session-end.json").write_text(
            json.dumps(response, ensure_ascii=False, indent=2, sort_keys=True),
            encoding="utf-8",
        )
        print("[tdai] Seed session flushed with /session/end")
    wait_seconds = float(seed_config.get("post_session_end_wait_seconds", 0))
    if wait_seconds > 0:
        print(f"[tdai] Waiting {wait_seconds:.0f}s for async memory extraction")
        time.sleep(wait_seconds)


def _run_openhands_terminal(
    openhands_config: dict[str, Any],
    tdai_config: TdaiOpenHandsConfig,
    tdai_config_path: Path | None,
    base_dir: Path,
    extra_args: list[str],
) -> int:
    command = _command(openhands_config.get("command"))
    if not command:
        command = _discover_openhands_command()
    command.extend(extra_args)
    cwd = _resolve_path(openhands_config.get("cwd", "."), base_dir)
    env = _merged_env(openhands_config.get("env", {}))
    python_paths = [str(Path(__file__).resolve().parents[1])]
    python_paths.extend(str(_resolve_path(path, base_dir)) for path in openhands_config.get("python_paths", []) or [])
    env["PYTHONPATH"] = os.pathsep.join([*python_paths, env.get("PYTHONPATH", "")]).rstrip(os.pathsep)
    if bool(openhands_config.get("pass_tdai_env", True)):
        env["TDAI_GATEWAY_URL"] = tdai_config.gateway.url
        env["TDAI_GATEWAY_API_KEY_ENV"] = tdai_config.gateway.api_key_env
        if tdai_config_path is not None:
            env["TDAI_OPENHANDS_CONFIG"] = str(tdai_config_path)
    print(f"[tdai] Launching OpenHands TUI: {' '.join(command)}")
    return subprocess.call(command, cwd=str(cwd), env=env)


def _install_openhands_integration(
    integration_config: dict[str, Any],
    openhands_config: dict[str, Any],
    tdai_config: TdaiOpenHandsConfig,
    tdai_config_path: Path | None,
    base_dir: Path,
):
    project_dir = _resolve_path(openhands_config.get("cwd", "."), base_dir)
    openhands_home = integration_config.get("openhands_home")
    return install_integration(
        tdai_config,
        config_path=tdai_config_path,
        openhands_home=(
            _resolve_path(openhands_home, base_dir) if openhands_home else None
        ),
        project_dir=project_dir,
        hooks_scope=str(integration_config.get("hooks_scope") or "auto"),
    )


def _discover_openhands_command() -> list[str]:
    for candidate in ("openhands", "openhands-cli"):
        if shutil.which(candidate):
            return [candidate]
    raise SystemExit("OpenHands executable was not found. Set openhands.command in the launcher config.")


def _seed_items(seed_config: dict[str, Any], base_dir: Path) -> list[str]:
    items: list[str] = []
    if seed_config.get("builtin") == "swe_bugfix":
        items.extend(BUILTIN_SWEBENCH_SEEDS)
    seed_file = seed_config.get("file")
    if seed_file:
        items.extend(_read_seed_file(_resolve_path(seed_file, base_dir)))
    for item in seed_config.get("items", []) or []:
        if isinstance(item, str):
            text = item
        elif isinstance(item, dict):
            text = str(item.get("content") or item.get("text") or "")
        else:
            text = str(item)
        text = text.strip()
        if text:
            items.append(text)
    return items


def _read_seed_file(path: Path) -> list[str]:
    raw = path.read_text(encoding="utf-8-sig")
    if path.suffix.lower() == ".json":
        data = json.loads(raw)
    elif path.suffix.lower() in {".yaml", ".yml"}:
        try:
            import yaml  # type: ignore
        except ImportError as exc:
            raise RuntimeError("PyYAML is required to read YAML seed files") from exc
        data = yaml.safe_load(raw)
    else:
        return [part.strip() for part in raw.split("\n\n") if part.strip()]
    if isinstance(data, dict):
        data = data.get("items", [])
    items: list[str] = []
    for item in data or []:
        if isinstance(item, dict):
            text = str(item.get("content") or item.get("text") or "").strip()
        else:
            text = str(item).strip()
        if text:
            items.append(text)
    return items


def _read_mapping(path: Path) -> dict[str, Any]:
    raw = path.read_text(encoding="utf-8-sig")
    if path.suffix.lower() == ".json":
        data = json.loads(raw)
    else:
        try:
            import yaml  # type: ignore
        except ImportError as exc:
            raise RuntimeError("PyYAML is required to load launcher YAML config files") from exc
        data = yaml.safe_load(raw)
    if not isinstance(data, dict):
        raise ValueError(f"launcher config must be a mapping: {path}")
    return data


def _resolve_path(value: Any, base_dir: Path) -> Path:
    path = Path(os.path.expandvars(os.path.expanduser(str(value))))
    if not path.is_absolute():
        path = base_dir / path
    return path.resolve()


def _command(value: Any) -> list[str]:
    if value is None or value == "":
        return []
    if isinstance(value, str):
        return shlex.split(value, posix=os.name != "nt")
    return [str(part) for part in value]


def _merged_env(extra: dict[str, Any]) -> dict[str, str]:
    env = os.environ.copy()
    for key, value in (extra or {}).items():
        if value is None:
            continue
        env[str(key)] = os.path.expandvars(os.path.expanduser(str(value)))
    return env


def _strip_remainder_separator(args: list[str]) -> list[str]:
    return args[1:] if args and args[0] == "--" else args


if __name__ == "__main__":
    sys.exit(main())
