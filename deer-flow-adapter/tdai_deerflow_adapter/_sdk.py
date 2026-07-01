"""Helpers for importing the shared Python adapter SDK from this repo layout."""

from __future__ import annotations

import sys
from pathlib import Path


def ensure_adapter_sdk_path() -> None:
    sdk_path = Path(__file__).resolve().parents[2] / "adapter-sdk" / "python"
    if sdk_path.exists():
        sdk_path_str = str(sdk_path)
        if sdk_path_str not in sys.path:
            sys.path.insert(0, sdk_path_str)
