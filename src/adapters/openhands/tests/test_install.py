import json
from pathlib import Path

from tdai_openhands import launcher as launcher_module
from tdai_openhands.config import TdaiOpenHandsConfig
from tdai_openhands.install import install_integration
from tdai_openhands.launcher import main as launcher_main


def test_install_merges_project_hooks_and_user_mcp_idempotently(tmp_path) -> None:
    home = tmp_path / "home"
    project = tmp_path / "project"
    project_hooks = project / ".openhands" / "hooks.json"
    project_hooks.parent.mkdir(parents=True)
    project_hooks.write_text(
        json.dumps(
            {
                "stop": [
                    {
                        "matcher": "*",
                        "hooks": [{"command": "./existing-stop.sh", "timeout": 5}],
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    home.mkdir()
    (home / "mcp.json").write_text(
        json.dumps({"mcpServers": {"existing": {"command": "existing"}}}),
        encoding="utf-8",
    )
    config = TdaiOpenHandsConfig()
    config.tools.enabled = True

    first = install_integration(
        config,
        config_path=tmp_path / "tdai.yaml",
        openhands_home=home,
        project_dir=project,
        hooks_scope="auto",
        python_executable=Path("/usr/bin/python3"),
    )
    second = install_integration(
        config,
        config_path=tmp_path / "tdai.yaml",
        openhands_home=home,
        project_dir=project,
        hooks_scope="auto",
        python_executable=Path("/usr/bin/python3"),
    )

    assert first.hooks_path == project_hooks.resolve()
    assert second.hooks_path == first.hooks_path
    hooks = json.loads(project_hooks.read_text(encoding="utf-8"))
    commands = [
        hook["command"]
        for matcher in hooks["stop"]
        for hook in matcher["hooks"]
    ]
    assert "./existing-stop.sh" in commands
    assert sum("run_hook.py" in command for command in commands) == 1
    mcp = json.loads((home / "mcp.json").read_text(encoding="utf-8"))
    assert set(mcp["mcpServers"]) == {"existing", "tdai_search"}


def test_install_project_scope_creates_repository_hooks(tmp_path) -> None:
    result = install_integration(
        TdaiOpenHandsConfig(),
        config_path=None,
        openhands_home=tmp_path / "home",
        project_dir=tmp_path / "repo",
        hooks_scope="project",
    )

    assert result.hooks_path == (tmp_path / "repo" / ".openhands" / "hooks.json").resolve()
    assert result.hooks_path.exists()


def test_launcher_install_command_does_not_start_gateway_or_tui(tmp_path) -> None:
    project = tmp_path / "project"
    config_path = tmp_path / "tdai.json"
    config_path.write_text(json.dumps({"tools": {"enabled": False}}), encoding="utf-8")
    launcher_path = tmp_path / "launcher.json"
    launcher_path.write_text(
        json.dumps(
            {
                "tdai_config": str(config_path),
                "log_dir": str(tmp_path / "logs"),
                "integration": {
                    "openhands_home": str(tmp_path / "home"),
                    "hooks_scope": "project",
                },
                "openhands": {"cwd": str(project), "command": ["must-not-run"]},
            }
        ),
        encoding="utf-8",
    )

    assert launcher_main(["--launcher-config", str(launcher_path), "install"]) == 0
    assert (project / ".openhands" / "hooks.json").exists()


def test_launcher_forwards_resume_arguments_and_persistence_dir(
    tmp_path, monkeypatch
) -> None:
    assert launcher_module._strip_remainder_separator(
        ["--", "--resume", "conversation-id"]
    ) == ["--resume", "conversation-id"]
    calls = []

    def fake_call(command, *, cwd, env):
        calls.append((command, cwd, env))
        return 0

    monkeypatch.setattr(launcher_module.subprocess, "call", fake_call)
    persistence = tmp_path / "openhands-home"

    result = launcher_module._run_openhands_terminal(
        {
            "command": ["openhands", "--override-with-envs"],
            "cwd": str(tmp_path),
            "env": {"OPENHANDS_PERSISTENCE_DIR": str(persistence)},
        },
        TdaiOpenHandsConfig(),
        None,
        tmp_path,
        ["--resume", "conversation-id"],
    )

    assert result == 0
    command, cwd, env = calls[0]
    assert command == [
        "openhands",
        "--override-with-envs",
        "--resume",
        "conversation-id",
    ]
    assert cwd == str(tmp_path.resolve())
    assert env["OPENHANDS_PERSISTENCE_DIR"] == str(persistence)
