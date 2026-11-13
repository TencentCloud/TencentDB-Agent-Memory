"""Tests for SDK error types."""

from tencentdb_agent_memory.errors import ParamError, TDAMError


def test_param_error_is_an_exception_with_message():
    err = ParamError("apiKey must be provided")
    assert isinstance(err, Exception)
    assert "apiKey must be provided" in str(err)


def test_tdam_error_exposes_fields():
    err = TDAMError(40901, "version stale", "req-123")
    assert err.code == 40901
    assert err.message == "version stale"
    assert err.request_id == "req-123"
    assert err.details is None
    assert "code=40901" in str(err)
    assert "req-123" in str(err)


def test_tdam_error_preserves_conflict_details():
    src = {"current_version": 7}
    err = TDAMError(40901, "version stale", "req-1", src)
    assert err.details == src
    assert isinstance(err.details, dict)
    # errors.py builds dict(details), so later edits by the caller must not
    # mutate details held by an already-raised exception.
    assert err.details is not src
    src["current_version"] = 99
    assert err.details == {"current_version": 7}


def test_tdam_error_string_without_request_id():
    err = TDAMError(500, "internal")
    assert "request_id" not in str(err)
    assert "code=500" in str(err)
