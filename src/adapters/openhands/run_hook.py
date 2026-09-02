from __future__ import annotations

import sys
from pathlib import Path


ADAPTER_ROOT = Path(__file__).resolve().parent
if str(ADAPTER_ROOT) not in sys.path:
    sys.path.insert(0, str(ADAPTER_ROOT))

from tdai_openhands.hook_entry import main


if __name__ == "__main__":
    raise SystemExit(main())
