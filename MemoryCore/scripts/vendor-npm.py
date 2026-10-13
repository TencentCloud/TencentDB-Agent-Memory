#!/usr/bin/env python3
"""Reproduce the unbundled, development-only npm archive from verified npm bytes.

No npm JavaScript or license is changed. Removing prebundled dependencies lets
npm ci install the patched, integrity-locked dependencies in package-lock.json.
This does not install packages or execute upstream lifecycle scripts.
"""
import base64
import gzip
import hashlib
import io
import json
from pathlib import Path
import tarfile
import urllib.request

VERSION = "12.2.0"
URL = f"https://registry.npmjs.org/npm/-/npm-{VERSION}.tgz"
INTEGRITY = "ZsJjKpTnlmSXOLLXiU1xDCzC4Wlok4IwZmh/aw2KUuXytU7q6qMv/cUT7MoeSf95Slwuw/lRXYefGzGCspHPNQ=="
OUTPUT = Path(__file__).resolve().parent.parent / "vendor" / f"npm-{VERSION}-unbundled.tgz"


def main():
    with urllib.request.urlopen(URL, timeout=60) as response:
        data = response.read(32 * 1024 * 1024 + 1)
    if len(data) > 32 * 1024 * 1024:
        raise ValueError("upstream archive exceeds limit")
    actual = base64.b64encode(hashlib.sha512(data).digest()).decode()
    if actual != INTEGRITY:
        raise ValueError("official npm archive integrity mismatch")
    buffer = io.BytesIO()
    retained = 0
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as source:
        with gzip.GzipFile(fileobj=buffer, mode="wb", filename="", mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as dest:
                for member in sorted(source.getmembers(), key=lambda item: item.name):
                    path = Path(member.name)
                    if path.is_absolute() or ".." in path.parts or path.parts[0] != "package":
                        raise ValueError("unexpected upstream archive path")
                    if member.name.startswith("package/node_modules/") or member.name in (
                        "package/node_modules", "package/npm-shrinkwrap.json", "package/package-lock.json"
                    ):
                        continue
                    if not (member.isfile() or member.isdir()):
                        raise ValueError("unexpected upstream archive member type")
                    content = source.extractfile(member).read() if member.isfile() else b""
                    if member.name == "package/package.json":
                        package = json.loads(content)
                        package["bundleDependencies"] = False
                        package.pop("bundledDependencies", None)
                        # The published CLI needs no lifecycle scripts. Do not execute
                        # upstream development/release scripts when using this artifact.
                        package.pop("scripts", None)
                        content = (json.dumps(package, indent=2) + "\n").encode()
                    normalized = tarfile.TarInfo(member.name)
                    normalized.type = member.type
                    normalized.mode = member.mode
                    normalized.mtime = 0
                    normalized.size = len(content) if member.isfile() else 0
                    dest.addfile(normalized, io.BytesIO(content) if member.isfile() else None)
                    retained += int(member.isfile())
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_bytes(buffer.getvalue())
    print(f"{OUTPUT.name}: {retained} files, SHA256 {hashlib.sha256(buffer.getvalue()).hexdigest()}")


if __name__ == "__main__":
    main()
