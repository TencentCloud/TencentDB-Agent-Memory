"""Bounded generator output parsing; no transport or response repair."""

from copy import deepcopy
from typing import Any, Dict, Sequence, Tuple
import unicodedata

from ._core import UpdateRejected, validate_support
from ._json_surface import unwrap_json_object


def parse_proposal(
    raw: str, excluded_literals: Sequence[str]
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    if type(raw) is not str or not 0 < len(raw.encode("utf-8")) <= 8192:
        raise UpdateRejected("proposal_response_capacity")
    surface = unwrap_json_object(raw, allow_json_fence=True)
    value = surface.value
    if set(value) != {"family", "support", "patch"}:
        raise UpdateRejected("proposal_fields")
    patch = value["patch"]
    text = patch.get("text") if type(patch) is dict else None
    if text is not None:
        if type(text) is not str:
            raise UpdateRejected("proposal_text_type")
        folded = unicodedata.normalize("NFKC", text).casefold()
        if any(
            unicodedata.normalize("NFKC", s).casefold() in folded
            for s in excluded_literals
        ):
            raise UpdateRejected("proposal_copies_training_literal")
    result = deepcopy(value)
    result["support"] = validate_support(result["support"])
    audit = surface.audit()
    audit.update(
        support_transformation="none",
        support_objects_enabled=False,
        semantic_repair=False,
    )
    return result, audit
