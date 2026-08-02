#!/usr/bin/env python3
"""
fetch_dups.py — универсальный инструмент «пчёлки» (memory-keeper).

GET $TDAI_GATEWAY_URL/memory/duplicates и печатает кластеры дублей для
целевых записей (--ids). Только stdlib, только GET, без секретов.

Использование (из scratch-каталога пчёлки, где лежит memory-keeper-prompt.md):
    python3 tools/fetch_dups.py --ids m_1,m_2 [--since ISO] [--limit N] [--url U] [--timeout S]

Формат вывода: для каждого target — строки кластеров, где он record_id или
similar-кандидат (record_id / score / scope / project_id / type).
"""

import argparse
import http.client
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_URL = os.environ.get("TDAI_GATEWAY_URL", "http://127.0.0.1:8420")

# UTF-8 everywhere (defence-in-depth; C locale would otherwise be ASCII).
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# No env-proxy routing: urlopen would go through http_proxy and break the
# loopback fake-server smoke + the real localhost gateway when a proxy env is
# set.
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def build_url(base: str, path: str, params: dict) -> str:
    qs = urllib.parse.urlencode(params)
    sep = "&" if "?" in path else "?"
    return f"{base.rstrip('/')}{path}{sep}{qs}"


def get_json(url: str, timeout: int):
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with OPENER.open(req, timeout=timeout) as resp:
        raw = resp.read()
    text = raw.decode("utf-8", errors="replace")
    return json.loads(text)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Fetch /memory/duplicates for target ids")
    parser.add_argument("--ids", required=True, help="comma-separated target record ids")
    parser.add_argument("--since", default=None, help="ISO since (records updated >= this)")
    parser.add_argument("--limit", type=int, default=500)
    parser.add_argument("--url", default=DEFAULT_URL)
    parser.add_argument("--timeout", type=float, default=10.0)
    args = parser.parse_args(argv)

    targets = {t.strip() for t in args.ids.split(",") if t.strip()}
    if not targets:
        print("error: --ids empty", file=sys.stderr)
        return 2

    params = {"limit": args.limit}
    if args.since:
        params["since"] = args.since
    url = build_url(args.url, "/memory/duplicates", params)

    try:
        data = get_json(url, args.timeout)
    except http.client.HTTPException as e:
        print(f"error: http client: {e}", file=sys.stderr)
        return 1
    except urllib.error.HTTPError as e:
        print(f"error: http {e.code}: {e.reason}", file=sys.stderr)
        return 1
    except urllib.error.URLError as e:
        reason = getattr(e, "reason", e)
        if isinstance(reason, TimeoutError):
            print(f"error: timeout after {args.timeout}s: {e}", file=sys.stderr)
        else:
            print(f"error: {e}", file=sys.stderr)
        return 1
    except TimeoutError as e:
        print(f"error: timeout after {args.timeout}s: {e}", file=sys.stderr)
        return 1
    except ConnectionError as e:
        print(f"error: connection: {e}", file=sys.stderr)
        return 1
    except ValueError as e:
        print(f"error: bad url: {e}", file=sys.stderr)
        return 1
    except json.JSONDecodeError as e:
        print(f"error: non-json response: {e}", file=sys.stderr)
        return 1

    # Envelope version-guard: fail fast (not silently) when the API shape changes.
    if not isinstance(data, dict) or "clusters" not in data:
        print(f"error: unexpected /memory/duplicates shape: {str(data)[:200]}", file=sys.stderr)
        return 1

    total = data.get("total", 0)
    threshold = data.get("threshold", "")
    topk = data.get("topK", "")
    print(f"total clusters: {total}  threshold: {threshold}  topK: {topk}")

    hits = 0
    for cluster in data.get("clusters", []):
        cid = str(cluster.get("record_id", ""))
        if cid in targets:
            hits += 1
            print(f"== TARGET cluster: {cid}")
            for s in cluster.get("similar", []):
                print(
                    f"   -> {s.get('record_id')} score={s.get('score')} "
                    f"scope={s.get('scope')} project={s.get('project_id')} type={s.get('type')}"
                )
        else:
            for s in cluster.get("similar", []):
                if str(s.get("record_id", "")) in targets:
                    hits += 1
                    print(f"== TARGET as similar of: {cid}")
                    print(
                        f"   -> {s.get('record_id')} score={s.get('score')} "
                        f"scope={s.get('scope')} project={s.get('project_id')} type={s.get('type')}"
                    )
    print(f"target clusters found: {hits}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
