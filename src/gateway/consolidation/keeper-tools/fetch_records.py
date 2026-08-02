#!/usr/bin/env python3
"""
fetch_records.py — универсальный инструмент «пчёлки» (memory-keeper).

GET /memory/records и печатает записи с target-id (--ids). Только stdlib,
только GET, без секретов.

Использование (из scratch-каталога пчёлки):
    python3 tools/fetch_records.py --ids m_1,m_2 [--since ISO] [--limit N] [--url U] [--timeout S]

Default --since: 48 часов назад от now (в ISO UTC).
"""

import argparse
import http.client
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

DEFAULT_URL = os.environ.get("TDAI_GATEWAY_URL", "http://127.0.0.1:8420")

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

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
    parser = argparse.ArgumentParser(description="Fetch /memory/records for target ids")
    parser.add_argument("--ids", required=True, help="comma-separated target record ids")
    parser.add_argument("--since", default=None, help="ISO since (default: 48h ago)")
    parser.add_argument("--limit", type=int, default=1000)
    parser.add_argument("--url", default=DEFAULT_URL)
    parser.add_argument("--timeout", type=float, default=10.0)
    args = parser.parse_args(argv)

    targets = {t.strip() for t in args.ids.split(",") if t.strip()}
    if not targets:
        print("error: --ids empty", file=sys.stderr)
        return 2

    since = args.since or (datetime.now(timezone.utc) - timedelta(hours=48)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    params = {"since": since, "limit": args.limit}
    url = build_url(args.url, "/memory/records", params)

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
    except json.JSONDecodeError as e:
        print(f"error: non-json response: {e}", file=sys.stderr)
        return 1
    except ValueError as e:
        print(f"error: bad url: {e}", file=sys.stderr)
        return 1

    if not isinstance(data, dict) or "records" not in data:
        print(f"error: unexpected /memory/records shape: {str(data)[:200]}", file=sys.stderr)
        return 1

    records = data.get("records", [])
    print(f"since={since} total={data.get('total')}")
    printed = 0
    for rec in records:
        rid = str(rec.get("record_id", ""))
        if rid in targets:
            print(json.dumps(rec, ensure_ascii=False))
            print("---")
            printed += 1
    print(f"target records printed: {printed}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
