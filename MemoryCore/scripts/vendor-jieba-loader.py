#!/usr/bin/env python3
"""Reproduce/check the licensed Jieba metadata-gate adapter without executing it.

Uses the official archive URL and SHA512 recorded in the provenance manifest.
No dependency files or native binaries are modified. Accepts a local archive
for offline reproduction; otherwise downloads only the integrity-pinned archive.
"""
import argparse
import base64
import hashlib
import io
import json
from pathlib import Path
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
PREFIX = "// Derived from @node-rs/jieba 2.0.3; upstream MIT license retained alongside.\n// The generated loader's expected version is corrected from 2.0.1 to 2.0.3.\n// Lazy invocation preserves optional native loading and package-scoped resolution.\nmodule.exports = function loadJieba(packageRequire) {\n  if (packageRequire('@node-rs/jieba/package.json').version !== '2.0.3') {\n    throw new Error('Unsupported Jieba loader package version');\n  }\n  const require = packageRequire;\n  const module = { exports: {} };\n"
SUFFIX = '\n  return module.exports;\n};\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    manifest = json.loads((ROOT / "vendor/jieba-loader.provenance.json").read_text())
    if args.archive:
        data = args.archive.read_bytes()
    else:
        with urllib.request.urlopen(manifest["resolved"], timeout=60) as response:
            data = response.read(8 * 1024 * 1024 + 1)
    if len(data) > 8 * 1024 * 1024:
        raise ValueError("Jieba archive exceeds limit")
    integrity = "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode()
    if integrity != manifest["integrity"]:
        raise ValueError("Jieba archive integrity mismatch")
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        def read_member(name):
            entries = [m for m in archive.getmembers() if m.name == name]
            if len(entries) != 1 or not entries[0].isfile():
                raise ValueError("Unexpected Jieba archive member")
            return archive.extractfile(entries[0]).read()
        loader = read_member("package/index.js")
        license_bytes = read_member("package/LICENSE")
        package = json.loads(read_member("package/package.json"))
    if package["version"] != manifest["version"] or package["name"] != manifest["upstream_package"]:
        raise ValueError("Unexpected Jieba package metadata")
    if hashlib.sha256(loader).hexdigest() != manifest["original_loader_sha256"]:
        raise ValueError("Unreviewed Jieba loader source")
    text = loader.decode("utf-8")
    if text.count("2.0.1") != 54:
        raise ValueError("Unexpected generated version-gate count")
    derived = (PREFIX + text.replace("2.0.1", "2.0.3") + SUFFIX).encode("utf-8")
    if hashlib.sha256(derived).hexdigest() != manifest["derived_loader_sha256"]:
        raise ValueError("Derived loader fingerprint mismatch")
    if hashlib.sha256(license_bytes).hexdigest() != manifest["license_sha256"]:
        raise ValueError("Upstream license fingerprint mismatch")
    for name, content in (("jieba-loader.cjs", derived), ("jieba-loader.LICENSE", license_bytes)):
        output = ROOT / "vendor" / name
        if args.check:
            if output.read_bytes() != content:
                raise ValueError("Committed Jieba adapter differs from verified reproduction")
        else:
            output.write_bytes(content)
    print("Jieba loader adapter and upstream license: reproducible bytes PASS")


if __name__ == "__main__":
    main()
