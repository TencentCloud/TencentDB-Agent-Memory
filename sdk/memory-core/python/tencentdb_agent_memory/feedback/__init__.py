"""Optional bounded memory-policy adaptation; disabled until explicitly enabled.

The host supplies verified feedback and a bounded model transport. Importing
this module neither contacts a provider nor changes a memory store.
"""

from ._api import FeedbackOptimizer
from ._single import MECHANISM, SCHEMA as FEEDBACK_SCHEMA
from ._core import PolicySnapshot, UpdateRejected as FeedbackRejected

__all__ = [
    "FeedbackOptimizer",
    "PolicySnapshot",
    "FeedbackRejected",
    "FEEDBACK_SCHEMA",
    "MECHANISM",
]
