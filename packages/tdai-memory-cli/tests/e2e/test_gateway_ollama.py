import os
import time

import pytest

from tdai_memory_cli.__main__ import run_cli


pytestmark = pytest.mark.skipif(
    os.environ.get("TDAI_MEMORY_CLI_E2E") != "1",
    reason="set TDAI_MEMORY_CLI_E2E=1 to run real Gateway e2e",
)


def test_real_hook_cli_path_with_gateway_ollama():
    env = {
        **os.environ,
        "TDAI_GATEWAY_URL": os.environ.get("TDAI_GATEWAY_URL") or "http://127.0.0.1:8420",
        "TDAI_REQUEST_TIMEOUT_MS": os.environ.get("TDAI_REQUEST_TIMEOUT_MS") or "120000",
    }
    session_key = os.environ.get("TDAI_SESSION_KEY") or f"agent:cli-e2e:{int(time.time() * 1000)}"

    capture = run_cli([
        "sync-turn",
        "--user-content",
        "我正在测试 TencentDB Memory CLI，偏好使用 qwen2.5:7b 和 bge-m3。",
        "--assistant-content",
        "已记录：本次 CLI 测试偏好 qwen2.5:7b 和 bge-m3。",
        "--session-key",
        session_key,
    ], env=env)
    assert capture["code"] == 0, capture.get("stderr")
    assert "l0_recorded:" in capture["stdout"]

    recall = run_cli([
        "prefetch",
        "--query",
        "我刚才说 CLI 测试偏好什么模型？",
        "--session-key",
        session_key,
    ], env=env)
    assert recall["code"] == 0, recall.get("stderr")
    assert "TDAI Memory Recall" in recall["stdout"]

    session_end = run_cli(["end-session", "--session-key", session_key], env=env)
    assert session_end["code"] == 0, session_end.get("stderr")
    assert "flushed: true" in session_end["stdout"]
