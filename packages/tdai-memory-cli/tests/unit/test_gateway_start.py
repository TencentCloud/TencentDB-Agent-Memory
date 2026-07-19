import subprocess

from tdai_memory_cli.config import load_config
from tdai_memory_cli.gateway_start import ensure_gateway_running
from tdai_memory_cli.runtime import (
    GATEWAY_PID_FILE,
    read_gateway_process_info,
    runtime_dir,
)


class FakeProcess:
    pid = 4242


class FakePopen:
    calls = []

    def __call__(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        return FakeProcess()


def test_ensure_gateway_running_records_pid_and_redirects_logs(monkeypatch, tmp_path):
    responses = iter([
        RuntimeError("down"),
        RuntimeError("down"),
        {"status": "ok"},
    ])

    def request_func(_config, path, **_kwargs):
        assert path == "/health"
        response = next(responses)
        if isinstance(response, Exception):
            raise response
        return response

    fake_popen = FakePopen()
    monkeypatch.setattr(subprocess, "Popen", fake_popen)
    config = load_config({
        "TDAI_GATEWAY_AUTO_START": "1",
        "TDAI_GATEWAY_CWD": str(tmp_path),
        "TDAI_GATEWAY_RUNTIME_DIR": str(tmp_path / "runtime"),
        "TDAI_GATEWAY_LOG_DIR": str(tmp_path / "logs"),
        "TDAI_GATEWAY_IDLE_TIMEOUT_SECONDS": "0",
        "TDAI_GATEWAY_STARTUP_TIMEOUT_MS": "1000",
        "TDAI_GATEWAY_HEALTH_POLL_MS": "1",
    }, str(tmp_path))

    status = ensure_gateway_running(config, request_func=request_func)

    assert status == "started"
    assert (runtime_dir(config) / GATEWAY_PID_FILE).read_text(encoding="utf-8").strip() == "4242"
    assert read_gateway_process_info(config)["pid"] == 4242
    popen_kwargs = fake_popen.calls[0][1]
    assert popen_kwargs["stdout"].name.endswith("gateway.log")
    assert popen_kwargs["stderr"].name.endswith("gateway.log")
