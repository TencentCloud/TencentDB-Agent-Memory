"""Explicit synthetic API demonstration, not a memory efficacy experiment."""

import argparse
import json

from tencentdb_agent_memory.feedback import FeedbackOptimizer, PolicySnapshot


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", action="store_true")
    args = parser.parse_args()
    if not args.fixture:
        print(json.dumps(dict(enabled=False, model_calls=0, database_writes=0)))
        return
    from _feedback_fixture import (
        AUTHORITY,
        INTERFACE,
        feedback_fixture,
        scripted_proposal,
        synthetic_comparison,
    )

    optimizer = FeedbackOptimizer(
        interface_id=INTERFACE,
        allowed_sources=AUTHORITY,
        excluded_literals=("D1", "D2", "D3"),
        enabled=True,
    )
    before = feedback_fixture()
    prepared = optimizer.prepare(before)
    optimizer.generation_request(
        "Synthetic classifier contract supplied by the example host."
    )
    candidate = optimizer.submit_response(
        prepared["packet_sha256"], json.dumps(scripted_proposal(prepared))
    )
    assert optimizer.active == PolicySnapshot()
    decision = optimizer.evaluate(synthetic_comparison(before, candidate))
    loaded = PolicySnapshot.load(optimizer.active.dump())
    optimizer.rollback("operator_request")
    print(
        json.dumps(
            dict(
                synthetic_fixture=True,
                authored_proposal=True,
                model_calls=0,
                database_writes=0,
                adopted=decision["adopt"],
                loaded_version=loaded.version,
                rollback_version=optimizer.active.version,
                independent_effect_proven=False,
                audit=optimizer.audit(),
            )
        )
    )


if __name__ == "__main__":
    main()
