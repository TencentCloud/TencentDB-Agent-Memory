from __future__ import annotations

import dataclasses
import json
from typing import Any

from pydantic import BaseModel


def serialize_output(output: Any) -> str:
    if isinstance(output, str):
        return output
    if isinstance(output, BaseModel):
        value = output.model_dump(mode="json")
    elif dataclasses.is_dataclass(output) and not isinstance(output, type):
        value = dataclasses.asdict(output)
    else:
        value = output

    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
