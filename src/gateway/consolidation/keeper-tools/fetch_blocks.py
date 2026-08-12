#!/usr/bin/env python3
"""
fetch_blocks.py — универсальный инструмент «пчёлки» (memory-keeper).

GET /memory/blocks: список переразмеренных блоков (метаданные), затем для
каждого — GET /memory/blocks?path=<rel> и копирование контента в зеркальную
структуру <out>/<rel-path> + _manifest.json. Только stdlib, только GET.

Использование (из scratch-каталога пчёлки):
    python3 tools/fetch_blocks.py [--out ./raw] [--url U] [--timeout S]

Поведение:
  - 404 на ОДИН блок → missing-запись в манифест + continue (не abort);
  - abort только на 5xx/сеть (консолидация блоков конкурентна, один
    пропавший не должен валить весь прогон);
  - path из ответа сервера перед записью валидируется (reject .. / absolute /
    leading-/) — defence-in-depth;
  - URL-кодирование path: ровно ОДИН способ — urlencode({'path': rel})
    (композиция quote() + urlencode дала бы двойное кодирование и тихую 404
    для кириллических имён).
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


def reject_rel(rel: str) -> bool:
    """True = path is unsafe (must be skipped). Mirrors dump_bullets guard."""
    if not rel or rel.startswith("/") or rel.startswith("~"):
        return True
    if ".." in rel.split("/"):
        return True
    return False


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Fetch over-limit memory blocks into a mirror tree")
    parser.add_argument("--out", default="./raw", help="output dir (default ./raw)")
    parser.add_argument("--url", default=DEFAULT_URL)
    parser.add_argument("--timeout", type=float, default=10.0)
    args = parser.parse_args(argv)

    out_dir = args.out

    try:
        listing = get_json(build_url(args.url, "/memory/blocks", {}), args.timeout)
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

    if not isinstance(listing, dict) or "blocks" not in listing:
        print(f"error: unexpected /memory/blocks shape: {str(listing)[:200]}", file=sys.stderr)
        return 1

    over = [b for b in listing.get("blocks", []) if b.get("over")]
    print(f"over blocks: {len(over)}")

    os.makedirs(out_dir, exist_ok=True)
    manifest = []
    for b in over:
        rel = b.get("path", "")
        kind = b.get("kind", "scene")
        size = b.get("size", 0)
        limit = b.get("limit", 0)
        if reject_rel(rel):
            print(f"skip unsafe path from server: {rel!r}", file=sys.stderr)
            continue
        # Mirror write: <out>/<rel-path> — injective by construction.
        dest = os.path.join(out_dir, rel)
        try:
            entry = get_json(build_url(args.url, "/memory/blocks", {"path": rel}), args.timeout)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                print(f"missing block (404): {rel}", file=sys.stderr)
                manifest.append(
                    {"path": rel, "kind": kind, "size": size, "limit": limit, "file": None, "missing": True}
                )
                continue
            print(f"error: block {rel}: http {e.code}: {e.reason}", file=sys.stderr)
            return 1
        except (http.client.HTTPException, urllib.error.URLError, TimeoutError, ConnectionError, json.JSONDecodeError) as e:
            print(f"error: block {rel}: {e}", file=sys.stderr)
            return 1
        if not isinstance(entry, dict) or "content" not in entry:
            print(f"error: block {rel}: unexpected shape {str(entry)[:200]}", file=sys.stderr)
            return 1
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "w", encoding="utf-8", errors="replace") as fh:
            fh.write(entry["content"])
        rel_file = rel
        manifest.append(
            {"path": rel, "kind": kind, "size": size, "limit": limit, "file": rel_file, "missing": False}
        )
        print(f"wrote {dest} (api_size={size}, limit={limit})")

    manifest_path = os.path.join(out_dir, "_manifest.json")
    with open(manifest_path, "w", encoding="utf-8", errors="replace") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=1)
    print(f"manifest: {manifest_path} ({len(manifest)} entries)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
