"""Tests for ``_resolve_gateway_api_key`` (Gateway Bearer source precedence).

Locks in the closure-review contract (plugin dotenv fallback 6bb69f0 +
review round 2026-09-16):

  1. **env 优先** — a key present in ``os.environ`` wins and the dotenv
     path is never consulted (a fake that raises proves the negative).
  2. **namespaced > legacy** — ``MEMORY_TENCENTDB_GATEWAY_API_KEY`` beats
     ``TDAI_GATEWAY_API_KEY`` when both are set.
  3. **dotenv 兜底** — with no env vars, the profile-aware
     ``<hermes_home>/.env`` value (via ``agent.credential_pool``) supplies
     the key.
  4. **缺文件降级** — when ``agent.credential_pool`` is unavailable
     (ImportError), the fallback degrades to ``None`` instead of raising
     (legacy env-only behaviour preserved).
  5. **无钥** — nothing anywhere → ``None`` → the client attaches no
     ``Authorization`` header (open-gateway compatibility).
  6. **逐变量隔离** — a non-ImportError helper failure on the first
     variable neither escapes nor abandons the second variable
     (``is_available`` must never throw during provider registration).
  7. **日志无钥** — no code path writes key material into logs
     (env win, dotenv success, helper failure, ImportError degradation).
     The helper-failure test also pins the sanitized attribution line
     (variable + class name) *positively* — deleting the warning itself
     turns the suite red, so 401 attribution is protected too.
  8. **import 期异常** — a credential_pool that explodes at import time
     with a non-ImportError (module-level raise in a broken checkout) is
     contained by the widened import guard: debug with the class name
     only, resolver returns ``None``. The never-raise contract has no
     ImportError-shaped hole.
  9. **超时界** — a hung credential-pool helper (e.g. a locked secret
     vault) degrades after ``_DOTENV_HELPER_TIMEOUT_S`` instead of
     stalling provider registration: the late value is never adopted,
     the sanitized timeout warning names the variable, and the loop
     continues to the next variable.

Whitespace-only env values count as unset (defensive strip). The client
header assertions pin the end effect: ``None`` key ⇒ no ``Authorization``.
"""

from __future__ import annotations

import sys
import types

import pytest

from plugins.memory.memory_tencentdb import _resolve_gateway_api_key
from plugins.memory.memory_tencentdb.client import MemoryTencentdbSdkClient

_VARS = ("MEMORY_TENCENTDB_GATEWAY_API_KEY", "TDAI_GATEWAY_API_KEY")


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for var in _VARS:
        monkeypatch.delenv(var, raising=False)


def _install_fake_dotenv(monkeypatch, values=None, forbidden=False, getenv=None):
    """Pin a fake ``agent.credential_pool`` for the duration of a test.

    ``getenv`` supplies a fully custom lookup function (used by the timeout
    tests to simulate a hung credential-pool helper).

    With ``forbidden=True`` the fake raises AssertionError on any lookup.
    The resolver swallows that via ``except Exception``, so the assertion
    never surfaces — the falsification actually works through the RETURN
    value: if the resolver consulted dotenv, it would return the (absent)
    dotenv value / None instead of the env key, and the ``==`` assertion
    below fails.
    """
    if forbidden:
        def get_env_prefer_dotenv(key: str) -> str:
            raise AssertionError("dotenv consulted while an env key is present")
    elif getenv is not None:
        get_env_prefer_dotenv = getenv
    else:
        def get_env_prefer_dotenv(key: str) -> str:
            return (values or {}).get(key, "")
    module = types.ModuleType("agent.credential_pool")
    module.get_env_prefer_dotenv = get_env_prefer_dotenv
    monkeypatch.setitem(sys.modules, "agent.credential_pool", module)
    return module


def test_env_wins_over_dotenv(monkeypatch):
    monkeypatch.setenv("TDAI_GATEWAY_API_KEY", "env-key")
    _install_fake_dotenv(monkeypatch, values={"TDAI_GATEWAY_API_KEY": "dotenv-key"},
                         forbidden=True)
    assert _resolve_gateway_api_key() == "env-key"


def test_namespaced_var_beats_legacy(monkeypatch):
    monkeypatch.setenv("TDAI_GATEWAY_API_KEY", "legacy")
    monkeypatch.setenv("MEMORY_TENCENTDB_GATEWAY_API_KEY", "namespaced")
    assert _resolve_gateway_api_key() == "namespaced"


def test_legacy_var_used_when_namespaced_missing(monkeypatch):
    monkeypatch.setenv("TDAI_GATEWAY_API_KEY", "legacy")
    assert _resolve_gateway_api_key() == "legacy"


def test_dotenv_fallback_when_env_missing(monkeypatch):
    _install_fake_dotenv(monkeypatch, values={"TDAI_GATEWAY_API_KEY": "dotenv-key"})
    assert _resolve_gateway_api_key() == "dotenv-key"


def test_whitespace_only_env_counts_as_unset(monkeypatch):
    monkeypatch.setenv("TDAI_GATEWAY_API_KEY", "   \n")
    _install_fake_dotenv(monkeypatch, values={"TDAI_GATEWAY_API_KEY": "dotenv-key"})
    assert _resolve_gateway_api_key() == "dotenv-key"


def test_degrades_when_credential_pool_missing(monkeypatch):
    # None in sys.modules ⇒ import raises ImportError ⇒ graceful None.
    monkeypatch.setitem(sys.modules, "agent.credential_pool", None)
    assert _resolve_gateway_api_key() is None


def test_no_key_anywhere_returns_none(monkeypatch):
    _install_fake_dotenv(monkeypatch, values={})
    assert _resolve_gateway_api_key() is None


def test_helper_exception_isolated_per_var(monkeypatch):
    """A non-ImportError helper failure on the first variable must neither
    escape nor abandon the second variable (never-throw registration
    contract of ``is_available``)."""
    calls = []

    def flaky(key: str) -> str:
        calls.append(key)
        if key == "MEMORY_TENCENTDB_GATEWAY_API_KEY":
            raise RuntimeError("simulated helper misbehaviour")
        return "dotenv-key"

    module = types.ModuleType("agent.credential_pool")
    module.get_env_prefer_dotenv = flaky
    monkeypatch.setitem(sys.modules, "agent.credential_pool", module)

    assert _resolve_gateway_api_key() == "dotenv-key"
    assert calls == ["MEMORY_TENCENTDB_GATEWAY_API_KEY", "TDAI_GATEWAY_API_KEY"]


def test_no_key_material_in_logs(monkeypatch, caplog):
    """Pin the no-leak contract across all four resolution paths."""
    import logging

    secret = "super-secret-key-material"
    with caplog.at_level(
        logging.DEBUG, logger="plugins.memory.memory_tencentdb"
    ):
        # 1) env win
        monkeypatch.setenv("TDAI_GATEWAY_API_KEY", secret)
        assert _resolve_gateway_api_key() == secret
        # 2) dotenv success
        monkeypatch.delenv("TDAI_GATEWAY_API_KEY")
        _install_fake_dotenv(monkeypatch, values={"TDAI_GATEWAY_API_KEY": secret})
        assert _resolve_gateway_api_key() == secret
        # 3) helper failure → warning path, degraded to None
        module = types.ModuleType("agent.credential_pool")

        def boom(key: str) -> str:
            raise RuntimeError("boom")

        module.get_env_prefer_dotenv = boom
        monkeypatch.setitem(sys.modules, "agent.credential_pool", module)
        assert _resolve_gateway_api_key() is None
        # 4) ImportError degradation → debug path
        monkeypatch.setitem(sys.modules, "agent.credential_pool", None)
        assert _resolve_gateway_api_key() is None

    assert secret not in caplog.text


def test_helper_exception_message_not_logged(monkeypatch, caplog):
    """The exception MESSAGE itself is the most dangerous leak channel:
    ``exc_info=True`` writes the full traceback (including the message) into
    the log. The resolver must log only the exception class name and the
    variable name — helper exception text is operator-adjacent data and may
    embed credential material (e.g. a helper that interpolates the value it
    failed to read)."""
    import logging

    secret = "super-secret-key-material"
    module = types.ModuleType("agent.credential_pool")

    def leaky(key: str) -> str:
        raise RuntimeError(f"helper failed to read {key}: {secret}")

    module.get_env_prefer_dotenv = leaky
    monkeypatch.setitem(sys.modules, "agent.credential_pool", module)

    with caplog.at_level(
        logging.DEBUG, logger="plugins.memory.memory_tencentdb"
    ):
        assert _resolve_gateway_api_key() is None

    assert secret not in caplog.text
    assert "leaky" not in caplog.text  # function name must not leak either
    assert "helper failed to read" not in caplog.text  # message text excluded
    # Positive pin: the sanitized attribution line (variable + class name)
    # must survive — removing the warning itself turns this test red, so
    # the no-leak contract cannot be "passed" by silently dropping the
    # 401-attribution log.
    assert (
        "dotenv fallback lookup failed for MEMORY_TENCENTDB_GATEWAY_API_KEY"
        " (RuntimeError)" in caplog.text
    )


def test_import_explosion_non_importerror_degrades(monkeypatch, caplog):
    """The widened import guard (``except Exception``, not just
    ``except ImportError``) must contain a credential_pool that explodes at
    import time with a non-ImportError — e.g. a module-level raise in a
    broken checkout, which is not an ImportError subclass. The resolver
    degrades to ``None`` and the debug line carries the class name only."""
    import logging

    class ExplodingPool(types.ModuleType):
        def __getattr__(self, name):
            raise RuntimeError("credential_pool exploded at import")

    monkeypatch.setitem(
        sys.modules, "agent.credential_pool", ExplodingPool("agent.credential_pool")
    )

    with caplog.at_level(
        logging.DEBUG, logger="plugins.memory.memory_tencentdb"
    ):
        assert _resolve_gateway_api_key() is None

    assert "credential pool import failed (RuntimeError)" in caplog.text
    assert "exploded" not in caplog.text  # message excluded, class name only


def test_client_omits_authorization_without_key():
    client = MemoryTencentdbSdkClient(api_key=None)
    assert "Authorization" not in client._build_headers(content_type=False)


def test_client_sends_bearer_with_key():
    client = MemoryTencentdbSdkClient(api_key="secret")
    headers = client._build_headers(content_type=False)
    assert headers["Authorization"] == "Bearer secret"


def test_dotenv_lookup_timeout_degrades(monkeypatch, caplog, _clean_env):
    """契约 9 — 挂死的 credential-pool 助手在超时后降级。

    整个有界查找的实质就在这条路径上：若有人把 join(timeout) 改回
    join()、或调换 is_alive/error 的检查顺序，此测试必须变红——否则
    注册会被锁死的 secret scope 无界拖住，且迟到值会被静默采用。
    """
    import logging
    import time as time_mod

    import plugins.memory.memory_tencentdb as provider

    monkeypatch.setattr(provider, "_DOTENV_HELPER_TIMEOUT_S", 0.05)

    def hung_helper(key: str) -> str:
        time_mod.sleep(0.5)
        return "late-key-that-must-not-be-used"

    _install_fake_dotenv(monkeypatch, getenv=hung_helper)

    with caplog.at_level(logging.WARNING):
        assert _resolve_gateway_api_key() is None

    timeout_lines = [r for r in caplog.records if "timed out" in r.getMessage()]
    assert len(timeout_lines) == 2  # both variables hit the ceiling
    assert all(
        "TDAI_GATEWAY_API_KEY" in r.getMessage()
        or "MEMORY_TENCENTDB_GATEWAY_API_KEY" in r.getMessage()
        for r in timeout_lines
    )
    assert all("late-key" not in r.getMessage() for r in caplog.records)


def test_dotenv_timeout_continues_to_next_var(monkeypatch, caplog, _clean_env):
    """契约 9b — 超时只跳过当前变量，continue 到下一个变量。

    钉死 ("timeout", None) 分支的 continue 语义：第一个变量挂死时，
    第二个变量的正常返回值仍被采用；第一个变量迟到的值不得出现。
    """
    import logging
    import time as time_mod

    import plugins.memory.memory_tencentdb as provider

    monkeypatch.setattr(provider, "_DOTENV_HELPER_TIMEOUT_S", 0.05)

    def selective_helper(key: str) -> str:
        if key == "MEMORY_TENCENTDB_GATEWAY_API_KEY":
            time_mod.sleep(0.5)  # hangs past the ceiling
            return "late-namespaced-key"
        return "dotenv-key"

    _install_fake_dotenv(monkeypatch, getenv=selective_helper)

    with caplog.at_level(logging.WARNING):
        assert _resolve_gateway_api_key() == "dotenv-key"

    assert any(
        "MEMORY_TENCENTDB_GATEWAY_API_KEY" in r.getMessage()
        and "timed out" in r.getMessage()
        for r in caplog.records
    )
    assert all("late-namespaced" not in r.getMessage() for r in caplog.records)
