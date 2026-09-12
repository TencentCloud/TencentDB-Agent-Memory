from __future__ import annotations


class GatewayError(RuntimeError):
    """Base error for TencentDB Agent Memory Gateway operations."""


class GatewayConnectionError(GatewayError):
    def __init__(self, operation: str, message: str) -> None:
        self.operation = operation
        super().__init__(f"Gateway {operation} failed: {message}")


class GatewayHTTPError(GatewayError):
    def __init__(self, operation: str, status_code: int, body: str) -> None:
        self.operation = operation
        self.status_code = status_code
        self.body = body[:500]
        super().__init__(
            f"Gateway {operation} returned HTTP {status_code}: {self.body}"
        )


class GatewayResponseError(GatewayError):
    def __init__(self, operation: str, message: str) -> None:
        self.operation = operation
        super().__init__(f"Gateway {operation} response is invalid: {message}")
