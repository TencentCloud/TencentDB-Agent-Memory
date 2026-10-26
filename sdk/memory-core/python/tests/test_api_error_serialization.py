"""API failures retain their diagnostics when crossing process boundaries."""
import copy
import multiprocessing
import pickle
from concurrent.futures import ProcessPoolExecutor

import pytest

from tencentdb_agent_memory.errors import TDAMError


def fail_in_worker():
    raise TDAMError(40901, "stale version", "request-1", {"current_version": 3})


@pytest.mark.parametrize("roundtrip", [copy.deepcopy, lambda error: pickle.loads(pickle.dumps(error))])
@pytest.mark.parametrize("details", [None, {"current_version": 3}])
def test_api_error_serialization(roundtrip, details):
    error = TDAMError(40901, "stale version", "request-1", details)
    restored = roundtrip(error)
    assert type(restored) is TDAMError
    assert restored.code == error.code
    assert restored.message == error.message
    assert restored.request_id == error.request_id
    assert restored.details == error.details
    assert str(restored) == str(error)
    if details is not None:
        assert restored.details is not error.details


def test_worker_api_failure_reaches_caller():
    with ProcessPoolExecutor(max_workers=1, mp_context=multiprocessing.get_context("spawn")) as executor:
        future = executor.submit(fail_in_worker)
        with pytest.raises(TDAMError) as caught:
            future.result(timeout=15)
    assert caught.value.code == 40901
    assert caught.value.request_id == "request-1"
    assert caught.value.details == {"current_version": 3}
