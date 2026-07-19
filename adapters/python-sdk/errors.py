"""TDAI SDK error types."""


class TdaiError(Exception):
    def __init__(self, message: str, code: int = 500):
        super().__init__(message)
        self.code = code


class TdaiConnectionError(TdaiError):
    def __init__(self, message: str = "Gateway unreachable"):
        super().__init__(message, 503)


class TdaiAuthError(TdaiError):
    def __init__(self, message: str = "Authentication failed"):
        super().__init__(message, 401)


class TdaiRateLimitError(TdaiError):
    def __init__(self, message: str = "Rate limit exceeded"):
        super().__init__(message, 429)
