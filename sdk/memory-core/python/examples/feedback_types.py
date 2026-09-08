"""Static consumer check for the installed optional feedback API."""
from typing import Any, Dict, Optional
from tencentdb_agent_memory.feedback import FeedbackOptimizer, PolicySnapshot

optimizer = FeedbackOptimizer(interface_id="typed-consumer", allowed_sources=("reviewer",),
                              excluded_literals=())
policy: PolicySnapshot = optimizer.active
candidate: Optional[PolicySnapshot] = optimizer.candidate
audit: Dict[str, Any] = optimizer.audit()
serialized: str = policy.dump()
loaded: PolicySnapshot = PolicySnapshot.load(serialized)
