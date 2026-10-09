from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .config import TdaiOpenHandsConfig, load_config
from .prompt import build_tdai_mcp_server_config


HOOK_COMMAND_MARKERS = ("tdai_openhands.hook_entry", "run_hook.py")


@dataclass(frozen=True)
class InstallResult:
    hooks_path: Path
    mcp_path: Path | None


def install_integration(
    config: TdaiOpenHandsConfig,
    *,
    config_path: str | Path | None,
    openhands_home: str | Path | None = None,
    project_dir: str | Path | None = None,
    hooks_scope: str = "auto",
    python_executable: str | Path | None = None,
) -> InstallResult:
    home = _openhands_home(openhands_home)
    home.mkdir(parents=True, exist_ok=True)
    adapter_root = Path(__file__).resolve().parents[1]
    hook_script = adapter_root / "run_hook.py"
    # Preserve virtual-environment launchers instead of resolving their symlink
    # to the system interpreter.
    python = os.path.abspath(os.path.expanduser(str(python_executable or sys.executable)))
    command_parts = [python, str(hook_script)]
    if config_path is not None:
        command_parts.extend(
            ["--tdai-config", str(Path(config_path).expanduser().resolve())]
        )
    hook_command = " ".join(shlex.quote(part) for part in command_parts)

    hooks_path = _hooks_path(home, project_dir=project_dir, hooks_scope=hooks_scope)
    hooks = _read_json_mapping(hooks_path)
    merged_hooks = merge_hook_config(hooks, hook_command)
    _backup_once(hooks_path)
    _atomic_write_json(hooks_path, merged_hooks)

    mcp_path: Path | None = None
    if config.tools.enabled:
        mcp_path = home / "mcp.json"
        mcp = _read_json_mapping(mcp_path)
        server = build_tdai_mcp_server_config(
            gateway=config.gateway,
            tools=config.tools,
        )
        server["enabled"] = True
        merged_mcp = merge_mcp_config(
            mcp,
            config.tools.server_name or "tdai_search",
            server,
        )
        _backup_once(mcp_path)
        _atomic_write_json(mcp_path, merged_mcp)
    return InstallResult(hooks_path=hooks_path, mcp_path=mcp_path)


def merge_hook_config(existing: dict[str, Any], command: str) -> dict[str, Any]:
    result = dict(existing)
    wrapped = isinstance(result.get("hooks"), dict)
    target = dict(result.get("hooks") or {}) if wrapped else result
    specs = {
        "user_prompt_submit": 30,
        "stop": 90,
        "session_start": 15,
        "session_end": 120,
    }
    for snake_name, timeout in specs.items():
        event_key = _existing_event_key(target, snake_name)
        matchers = _without_tdai_hooks(target.get(event_key))
        matchers.append(
            {
                "matcher": "*",
                "hooks": [
                    {
                        "type": "command",
                        "command": command,
                        "timeout": timeout,
                    }
                ],
            }
        )
        target[event_key] = matchers
    if wrapped:
        result["hooks"] = target
        return result
    return target


def merge_mcp_config(
    existing: dict[str, Any],
    server_name: str,
    server_config: dict[str, Any],
) -> dict[str, Any]:
    result = dict(existing)
    servers = dict(result.get("mcpServers") or {})
    servers[server_name] = server_config
    result["mcpServers"] = servers
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Install TencentDB memory hooks and MCP into OpenHands CLI."
    )
    parser.add_argument("--tdai-config", required=True)
    parser.add_argument("--openhands-home")
    parser.add_argument("--project-dir")
    parser.add_argument(
        "--hooks-scope",
        choices=("auto", "user", "project"),
        default="auto",
    )
    args = parser.parse_args(argv)
    result = install_integration(
        load_config(args.tdai_config),
        config_path=args.tdai_config,
        openhands_home=args.openhands_home,
        project_dir=args.project_dir,
        hooks_scope=args.hooks_scope,
    )
    print(f"[tdai] OpenHands hooks installed: {result.hooks_path}")
    if result.mcp_path:
        print(f"[tdai] OpenHands MCP installed: {result.mcp_path}")
    return 0


def _openhands_home(value: str | Path | None) -> Path:
    if value is not None:
        return Path(os.path.expandvars(os.path.expanduser(str(value)))).resolve()
    configured = os.getenv("OPENHANDS_PERSISTENCE_DIR", "~/.openhands")
    return Path(os.path.expandvars(os.path.expanduser(configured))).resolve()


def _hooks_path(
    home: Path,
    *,
    project_dir: str | Path | None,
    hooks_scope: str,
) -> Path:
    if hooks_scope not in {"auto", "user", "project"}:
        raise ValueError(f"Unsupported hooks scope: {hooks_scope}")
    project_hooks: Path | None = None
    if project_dir is not None:
        project = Path(
            os.path.expandvars(os.path.expanduser(str(project_dir)))
        ).resolve()
        project_hooks = project / ".openhands" / "hooks.json"
    if hooks_scope == "project":
        if project_hooks is None:
            raise ValueError("project_dir is required when hooks_scope='project'")
        return project_hooks
    if hooks_scope == "auto" and project_hooks is not None and project_hooks.exists():
        return project_hooks
    return home / "hooks.json"


def _existing_event_key(config: dict[str, Any], snake_name: str) -> str:
    pascal_name = "".join(part.title() for part in snake_name.split("_"))
    if snake_name in config:
        return snake_name
    if pascal_name in config:
        return pascal_name
    return snake_name


def _without_tdai_hooks(value: Any) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for matcher in value if isinstance(value, list) else []:
        if not isinstance(matcher, dict):
            continue
        hooks = []
        for hook in matcher.get("hooks", []) or []:
            if not isinstance(hook, dict):
                continue
            command = str(hook.get("command") or "")
            if any(marker in command for marker in HOOK_COMMAND_MARKERS):
                continue
            hooks.append(dict(hook))
        if hooks:
            item = dict(matcher)
            item["hooks"] = hooks
            output.append(item)
    return output


def _read_json_mapping(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(data, dict):
        raise ValueError(f"Expected a JSON object in {path}")
    return data


def _backup_once(path: Path) -> None:
    if not path.exists():
        return
    backup = path.with_suffix(path.suffix + ".tdai.bak")
    if not backup.exists():
        shutil.copy2(path, backup)


def _atomic_write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


if __name__ == "__main__":
    raise SystemExit(main())
