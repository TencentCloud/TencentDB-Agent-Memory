"""Fake ``agent.credential_pool`` for the stub tree.

The real hermes-agent module resolves credentials from the operator's
profile-aware ``<hermes_home>/.env``. The plugin's dotenv fallback
(``_resolve_gateway_api_key``) imports this module lazily at call time, so
tests control it via ``monkeypatch.setitem(sys.modules, ...)`` — which works
identically whether the conftest wired the real checkout or this stub.

The stub deliberately simulates an EMPTY dotenv file: no test needs a
populated fallback, and tests that do exercise dotenv semantics install
their own fake via ``monkeypatch.setitem`` rather than mutating this module.
"""


def get_env_prefer_dotenv(key: str) -> str:
    return ""
