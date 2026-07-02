"""
Integrity verification for bridge_adapter module.

Generates and verifies SHA256 checksums for all source files
to detect tampering (malicious or accidental).

Usage:
    python -m bridge_adapter.integrity --check    # verify
    python -m bridge_adapter.integrity --generate  # update manifest
"""

from __future__ import annotations

import argparse
import hashlib
import os
import sys
from pathlib import Path

_MANIFEST = "SHA256SUMS"
_SOURCE_PATTERNS = ("*.py", "plugin.yaml", "pyproject.toml", "README.md")


def _compute_sha256(filepath: Path) -> str:
    """Compute SHA256 hex digest of a file."""
    h = hashlib.sha256()
    with open(filepath, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _module_root() -> Path:
    """Return the bridge_adapter package directory."""
    return Path(__file__).parent.resolve()


def _source_files(root: Path) -> list[Path]:
    """List all tracked source files under root."""
    files: list[Path] = []
    for pattern in _SOURCE_PATTERNS:
        files.extend(sorted(root.glob(pattern)))
    return [f for f in files if f.name != _MANIFEST and f.is_file()]


def generate_manifest(root: Path | None = None) -> str:
    """Generate SHA256SUMS content for all source files."""
    root = root or _module_root()
    lines: list[str] = []
    for f in _source_files(root):
        rel = f.relative_to(root).as_posix()
        digest = _compute_sha256(f)
        lines.append(f"{digest}  {rel}")
    return "\n".join(lines) + "\n"


def write_manifest(root: Path | None = None) -> Path:
    """Write SHA256SUMS to module root."""
    root = root or _module_root()
    content = generate_manifest(root)
    manifest_path = root / _MANIFEST
    manifest_path.write_text(content, encoding="utf-8")
    return manifest_path


def verify_manifest(root: Path | None = None) -> list[str]:
    """Verify all files against SHA256SUMS. Returns list of violations."""
    root = root or _module_root()
    manifest_path = root / _MANIFEST
    if not manifest_path.exists():
        return ["MISSING_MANIFEST"]

    violations: list[str] = []
    expected: dict[str, str] = {}

    for line in manifest_path.read_text(encoding="utf-8").strip().splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split("  ", 1)
        if len(parts) != 2:
            violations.append(f"INVALID_LINE: {line}")
            continue
        expected[parts[1]] = parts[0]

    # Check each source file
    for f in _source_files(root):
        rel = f.relative_to(root).as_posix()
        if rel not in expected:
            violations.append(f"UNTRACKED: {rel}")
            continue
        actual = _compute_sha256(f)
        if actual != expected[rel]:
            violations.append(
                f"HASH_MISMATCH: {rel} "
                f"(expected={expected[rel][:16]}..., actual={actual[:16]}...)"
            )

    # Check for missing files
    for rel in expected:
        if not (root / rel).exists():
            violations.append(f"MISSING: {rel}")

    return violations


def main() -> int:
    parser = argparse.ArgumentParser(description="bridge_adapter integrity tool")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--check", action="store_true", help="Verify file integrity")
    group.add_argument("--generate", action="store_true", help="Generate SHA256SUMS")
    args = parser.parse_args()

    root = _module_root()

    if args.generate:
        path = write_manifest(root)
        n = len(_source_files(root))
        print(f"Generated {_MANIFEST} ({n} files) at {path}")
        return 0

    if args.check:
        violations = verify_manifest(root)
        if not violations:
            n = len(_source_files(root))
            print(f"Integrity OK: {n} files verified against {_MANIFEST}")
            return 0

        print(f"Integrity FAILURE: {len(violations)} violation(s):")
        for v in violations:
            print(f"  ️ {v}")
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
