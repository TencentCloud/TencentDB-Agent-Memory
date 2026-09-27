#!/usr/bin/env python3
"""Local OpenAI chat-completions stub for the first-onboarding smoke test."""

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/v1/chat/completions":
            self.send_error(404)
            return
        try:
            size = int(self.headers.get("content-length", "0"))
            if size <= 0 or size > 1_000_000:
                raise ValueError("invalid request size")
            request = json.loads(self.rfile.read(size))
            if request.get("stream") is not False:
                raise ValueError("only non-streaming requests are supported")
        except (ValueError, json.JSONDecodeError):
            self.send_error(400)
            return

        response = {
            "id": "chatcmpl-onboarding-local",
            "object": "chat.completion",
            "created": 0,
            "model": request.get("model", "onboarding-fake-model"),
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": "Onboarding fake model response."},
                "finish_reason": "stop",
            }],
            "usage": {"prompt_tokens": 10, "completion_tokens": 6, "total_tokens": 16},
        }
        payload = json.dumps(response).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, _format, *_args):
        # Do not log prompts, response bodies or credentials.
        pass


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=18080)
    args = parser.parse_args()
    print(f"Fake model listening on 127.0.0.1:{args.port}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
