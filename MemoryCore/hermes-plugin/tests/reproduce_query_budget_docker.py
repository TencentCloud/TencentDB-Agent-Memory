"""Reproduce #1928 with Python 3.9+ and Docker.

Run from the repository root:
  python MemoryCore/hermes-plugin/tests/reproduce_query_budget_docker.py

Negative control (must fail candidate assertions):
  python MemoryCore/hermes-plugin/tests/reproduce_query_budget_docker.py --candidate-ref ecc01a5

The test seeds a synthetic L1 record, then exercises real HTTP search and Hermes
prefetch. No model API is used. Containers and temporary data are removed on exit.
"""

import argparse
from pathlib import Path
import subprocess
import tempfile
import uuid


GATEWAY_IMAGE = "agentmemory/memory-core@sha256:342331d5ccdb31ce84ac1ba205aa0b1a8b16a13fe71b6a104d17d41197eb7112"
PYTHON_IMAGE = "python@sha256:b18b261e1b4974b4f321451ad5251ded85abb22c2b8b262da527dda1d031ab30"
BASE_REF = "ecc01a545da0b2ac6cae2f0f0af0d39d41469793"
CLIENT_PATH = "MemoryCore/hermes-plugin/memory/memory_tencentdb/client.py"
CONFIG = """deployMode: standalone
stateBackend: local
server: {host: 127.0.0.1, port: 8420}
data: {baseDir: /data/tdai-memory}
llm: {baseUrl: 'http://127.0.0.1:1/v1', apiKey: offline, model: offline}
memory:
  extraction: {enabled: false}
  embedding: {provider: none}
  bm25: {enabled: true, language: en}
  storeBackend: sqlite
skill: {enabled: false}
"""

SEED = """
import assert from 'node:assert/strict';
import { VectorStore } from './src/core/store/sqlite/memory-store.ts';
const store = new VectorStore('/data/tdai-memory/vectors.db', 0);
store.init();
const now = new Date().toISOString();
assert(store.upsertL1({
  id: 'query-budget-fixture', content: 'handheld preference: I like portable consoles.',
  type: 'persona', priority: 70, scene_name: 'games', source_message_ids: [],
  metadata: {}, timestamps: [now], createdAt: now, updatedAt: now,
  sessionKey: 'docker-test', sessionId: 'docker-test'
}));
store.close();
"""

PROBE = r"""
import importlib.util
import sys
import time
import types
import urllib.error
sys.path.insert(0, "/plugin")
host = types.ModuleType("agent.memory_provider")
host.MemoryProvider = object
sys.modules[host.__name__] = host
from memory.memory_tencentdb import MemoryTencentdbProvider

def load_client(name):
    spec = importlib.util.spec_from_file_location(name, "/checks/" + name + ".py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.MemoryTencentdbSdkClient(api_key="local-test", timeout=5)

baseline, candidate = load_client("baseline"), load_client("candidate")
for attempt in range(60):
    try:
        health = candidate.health(timeout=1)
        assert health["status"] == "ok" and health["stores"]["ftsAvailable"], health
        break
    except OSError:
        time.sleep(0.25)
else:
    raise AssertionError("Gateway did not become healthy")

def found(result):
    return result["code"] == 0 and any(
        hit["id"] == "query-budget-fixture" for hit in result["data"]["items"]
    )

def prefetch(client, query):
    provider = MemoryTencentdbProvider()
    provider._client, provider._gateway_available = client, True
    return provider.prefetch(query)

query = "handheld scheduled check\n" + "\U0001f642 " * 2000 + "\nWhich handheld did I prefer?"
units = sum(2 if ord(char) > 0xFFFF else 1 for char in query)
assert found(baseline.atomic_search("handheld")), "Fixture is not searchable"
for method in (baseline.atomic_search, baseline.conversation_search):
    try:
        method(query)
    except urllib.error.HTTPError as error:
        assert error.code == 400, error.code
        print("BASE", method.__name__, "rejected", units, "UTF-16 units", flush=True)
    else:
        raise AssertionError("Baseline unexpectedly accepted the oversized query")
assert "I like portable consoles." not in prefetch(baseline, query)

# The identical query must return known content, not merely HTTP 200.
assert found(candidate.atomic_search(query)), "Candidate did not recall the fixture"
assert "I like portable consoles." in prefetch(candidate, query), "L1 missing from context"
print("CANDIDATE L1 search and prefetch returned the known preference", flush=True)

raw_text = "handheld " + "original message " * 300
added = candidate.conversation_add(
    [{"role": "user", "content": raw_text}], session_id="docker-test"
)
assert added["code"] == 0 and added["data"]["total_count"] == 1, added
messages = candidate.conversation_search(query)["data"]["messages"]
assert any(hit["content"] == raw_text for hit in messages), "L0 content was altered or lost"
print("CANDIDATE L0 search returned the full stored message", flush=True)
"""


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate-ref", help="Read candidate client from this local Git ref")
    args = parser.parse_args()
    core = Path(__file__).resolve().parents[2]
    repository = core.parent
    name = "memory-query-budget-" + uuid.uuid4().hex[:10]
    run(["docker", "info"], stdout=subprocess.DEVNULL)
    # Pin both images so another machine exercises the same runtime.
    for image in (GATEWAY_IMAGE, PYTHON_IMAGE):
        if subprocess.run(["docker", "image", "inspect", image],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
            run(["docker", "pull", image])
    with tempfile.TemporaryDirectory(prefix="memory-query-budget-") as temporary:
        checks = Path(temporary)
        (checks / "baseline.py").write_bytes(subprocess.check_output(
            ["git", "show", BASE_REF + ":" + CLIENT_PATH], cwd=repository))
        candidate = subprocess.check_output(
            ["git", "show", args.candidate_ref + ":" + CLIENT_PATH], cwd=repository
        ) if args.candidate_ref else (repository / CLIENT_PATH).read_bytes()
        (checks / "candidate.py").write_bytes(candidate)
        (checks / "gateway.yaml").write_text(CONFIG, encoding="utf-8")
        try:
            run(["docker", "run", "--rm", "-d", "--name", name, "--network", "none",
                 "--mount", f"type=bind,src={checks / 'gateway.yaml'},dst=/data/config/tdai-gateway.yaml,readonly",
                 "--tmpfs", "/data/tdai-memory:rw", "-e", "TDAI_GATEWAY_API_KEY=local-test",
                 "-e", "STORE_MODE=sqlite", GATEWAY_IMAGE], stdout=subprocess.DEVNULL)
            run(["docker", "exec", "-i", name, "node", "--import", "tsx",
                 "--input-type=module", "-"], input=SEED.encode())
            run(["docker", "run", "--rm", "-i", "--network", "container:" + name,
                 "--mount", f"type=bind,src={core / 'hermes-plugin'},dst=/plugin,readonly",
                 "--mount", f"type=bind,src={checks},dst=/checks,readonly",
                 "-e", "PYTHONDONTWRITEBYTECODE=1", PYTHON_IMAGE, "python", "-"],
                input=PROBE.encode())
        finally:
            subprocess.run(["docker", "rm", "-f", name], stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL)


if __name__ == "__main__":
    main()
