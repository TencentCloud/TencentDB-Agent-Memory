#!/usr/bin/env python3
"""
dump_bullets.py — универсальный инструмент «пчёлки» (memory-keeper).

ЛОКАЛЬНЫЙ (без сети): печатает bullet/heading строки тела scene-блока
(после META-frontmatter `-----META-END-----`), чтобы пчёлка быстро видела
структуру без чтения всего файла.

Использование (из scratch-каталога пчёлки, где лежит raw/_manifest.json
и зеркальная структура raw/<rel-path> от fetch_blocks.py):
    python3 tools/dump_bullets.py                          # все .md entries манифеста
    python3 tools/dump_bullets.py --file scene_blocks/_global/x.md

Поведение:
  - base dir ./raw (зеркальная структура <out>/<rel-path>, инъективна);
  - --file: rel ∉ файлов под base → HARD ERROR (rc=2); reject absolute/..;
  - default: все .md entries из _manifest.json; entries без файла на диске
    (missing, 404-continue из fetch_blocks) → SKIP + warning в stderr;
  - persona.md без META-END → тело as-is.
"""

import argparse
import json
import os
import re
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

META_END_RE = re.compile(r"-----META-END-----\n(.*)", re.S)
BULLET_LIMIT = 130


def reject_rel(rel: str) -> bool:
    if not rel or rel.startswith("/") or rel.startswith("~"):
        return True
    if ".." in rel.split("/"):
        return True
    return False


def dump_body(body: str, label: str) -> int:
    print("=" * 100)
    print(label, "body:", len(body))
    shown = 0
    for ln in body.splitlines():
        s = ln.strip()
        if not s:
            continue
        if s.startswith(("##", "###", "-", "*", "1.", "2.", "3.", "4.", "5.", "6.", "7.", "8.", "9.")):
            print(s[:260])
            shown += 1
        if shown > BULLET_LIMIT:
            print("... [truncated bullets]")
            break
    return shown


def dump_file(path: str, rel: str) -> int:
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        content = fh.read()
    m = META_END_RE.search(content)
    body = m.group(1) if m else content  # persona.md: no META-END → as-is
    return dump_body(body, rel)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Dump bullet structure of scene blocks (local)")
    parser.add_argument("--file", default=None, help="rel path under base (e.g. scene_blocks/_global/x.md)")
    parser.add_argument("--base", default="./raw", help="base dir with mirror tree + _manifest.json (default ./raw)")
    args = parser.parse_args(argv)

    base = args.base

    if args.file:
        rel = args.file
        if reject_rel(rel):
            print(f"error: unsafe path: {rel!r}", file=sys.stderr)
            return 2
        path = os.path.join(base, rel)
        if not os.path.isfile(path):
            print(f"error: no such file under {base}: {rel}", file=sys.stderr)
            return 2
        dump_file(path, rel)
        return 0

    # Default: all .md entries from the manifest.
    manifest_path = os.path.join(base, "_manifest.json")
    if not os.path.isfile(manifest_path):
        print(f"error: no _manifest.json in {base} (run fetch_blocks.py first)", file=sys.stderr)
        return 2
    with open(manifest_path, "r", encoding="utf-8", errors="replace") as fh:
        manifest = json.load(fh)

    total = 0
    for entry in manifest:
        rel = entry.get("file")
        if not rel or not isinstance(rel, str):
            continue
        if reject_rel(rel):
            print(f"warning: skip unsafe path in manifest: {rel!r}", file=sys.stderr)
            continue
        path = os.path.join(base, rel)
        if not os.path.isfile(path):
            print(f"warning: skip missing file: {rel}", file=sys.stderr)
            continue
        total += dump_file(path, rel)
    print(f"total bullets dumped: {total}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
