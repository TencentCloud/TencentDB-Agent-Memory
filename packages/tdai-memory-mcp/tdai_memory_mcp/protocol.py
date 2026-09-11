from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from typing import Any, BinaryIO

from .client import GatewayClient
from .config import AdapterConfig, load_config
from .supervisor import GatewaySupervisor
from .tools import TOOLS, call_tool

PROTOCOL_VERSION = "2024-11-05"
SERVER_INFO = {"name": "tdai-memory-mcp", "version": "0.1.0"}
INSTRUCTIONS = (
    "Use tdai_memory_search for structured long-term memories and "
    "tdai_conversation_search for raw conversation history when prior user context may help."
)


@dataclass
class ParsedMessage:
    body: str
    framed: bool


class McpServer:
    def __init__(
        self,
        *,
        config: AdapterConfig | None = None,
        client: GatewayClient | None = None,
        supervisor: GatewaySupervisor | None = None,
    ):
        self.config = config or load_config()
        self.client = client or GatewayClient(
            gateway_url=self.config.gateway_url,
            timeout_ms=self.config.timeout_ms,
            api_key=self.config.api_key,
        )
        self.supervisor = supervisor or GatewaySupervisor(self.config, self.client)
        self._ready = False

    def serve(self, input_stream: BinaryIO | None = None, output_stream: BinaryIO | None = None) -> None:
        inp = input_stream or sys.stdin.buffer
        out = output_stream or sys.stdout.buffer
        buffer = b""
        try:
            while True:
                chunk = inp.read(1)
                if not chunk:
                    return
                buffer += chunk
                while True:
                    parsed, buffer = parse_next_message(buffer)
                    if parsed is None:
                        break
                    try:
                        message = json.loads(parsed.body)
                        response = self.handle_message(message)
                    except json.JSONDecodeError:
                        response = json_rpc_error(None, -32700, "Parse error")
                    if response is not None:
                        write_message(out, response, parsed.framed)
        finally:
            self.supervisor.stop()

    def handle_message(self, message: Any) -> dict[str, Any] | None:
        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0" or not isinstance(message.get("method"), str):
            return json_rpc_error(_maybe_id(message), -32600, "Invalid Request")

        has_id = "id" in message
        request_id = message.get("id")
        method = message["method"]
        params = message.get("params") if isinstance(message.get("params"), dict) else {}

        try:
            if method == "initialize":
                if not has_id:
                    return None
                return json_rpc_result(request_id, {
                    "protocolVersion": params.get("protocolVersion") or PROTOCOL_VERSION,
                    "capabilities": {"tools": {}},
                    "serverInfo": SERVER_INFO,
                    "instructions": INSTRUCTIONS,
                })

            if method in {"notifications/initialized", "notifications/cancelled"}:
                return None

            if method == "ping":
                return json_rpc_result(request_id, {}) if has_id else None

            if method == "tools/list":
                return json_rpc_result(request_id, {"tools": TOOLS}) if has_id else None

            if method == "tools/call":
                self._ensure_ready()
                name = params.get("name")
                if not isinstance(name, str) or not name:
                    return json_rpc_error(request_id, -32602, "Invalid params: tool name is required")
                result = call_tool(name, params.get("arguments") or {}, self.client)
                return json_rpc_result(request_id, result) if has_id else None

            if method == "resources/list":
                return json_rpc_result(request_id, {"resources": []}) if has_id else None

            if method == "prompts/list":
                return json_rpc_result(request_id, {"prompts": []}) if has_id else None

            if method == "logging/setLevel":
                return json_rpc_result(request_id, {}) if has_id else None

            return json_rpc_error(request_id, -32601, f"Method not found: {method}") if has_id else None
        except Exception as error:
            return json_rpc_error(request_id, -32603, str(error)) if has_id else None

    def _ensure_ready(self) -> None:
        if self._ready:
            return
        self.supervisor.ensure_running()
        self._ready = True


def parse_next_message(buffer: bytes) -> tuple[ParsedMessage | None, bytes]:
    buffer = _skip_leading_blank_lines(buffer)
    if not buffer:
        return None, buffer

    if buffer[:32].lower().startswith(b"content-length:"):
        separator = buffer.find(b"\r\n\r\n")
        if separator < 0:
            return None, buffer
        header = buffer[:separator].decode("utf-8")
        length = _parse_content_length(header)
        body_start = separator + 4
        body_end = body_start + length
        if len(buffer) < body_end:
            return None, buffer
        body = buffer[body_start:body_end].decode("utf-8")
        return ParsedMessage(body=body, framed=True), buffer[body_end:]

    newline = buffer.find(b"\n")
    if newline < 0:
        return None, buffer
    body = buffer[:newline].decode("utf-8").rstrip("\r")
    return ParsedMessage(body=body, framed=False), buffer[newline + 1:]


def encode_frame(message: Any) -> bytes:
    body = json.dumps(message, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return b"Content-Length: " + str(len(body)).encode("ascii") + b"\r\n\r\n" + body


def write_message(output: BinaryIO, message: dict[str, Any], framed: bool) -> None:
    if framed:
        output.write(encode_frame(message))
    else:
        output.write(json.dumps(message, separators=(",", ":"), ensure_ascii=False).encode("utf-8") + b"\n")
    output.flush()


def json_rpc_result(request_id: Any, result: Any) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id if request_id is not None else None, "result": result}


def json_rpc_error(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": request_id if request_id is not None else None,
        "error": {"code": code, "message": message},
    }


def _skip_leading_blank_lines(buffer: bytes) -> bytes:
    while buffer.startswith(b"\n"):
        buffer = buffer[1:]
    while buffer.startswith(b"\r\n"):
        buffer = buffer[2:]
    return buffer


def _parse_content_length(header: str) -> int:
    for line in header.splitlines():
        if line.lower().startswith("content-length:"):
            return int(line.split(":", 1)[1].strip())
    raise ValueError("Missing Content-Length header")


def _maybe_id(message: Any) -> Any:
    if not isinstance(message, dict):
        return None
    request_id = message.get("id")
    if isinstance(request_id, (str, int)) or request_id is None:
        return request_id
    return None
