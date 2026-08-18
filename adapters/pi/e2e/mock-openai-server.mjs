import http from "node:http";

const port = Number(process.env.TDAI_PI_E2E_OPENAI_PORT ?? 18080);

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function responseText(payload) {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const lastUser = [...messages].reverse().find((message) => message?.role === "user");
  const text =
    typeof lastUser?.content === "string"
      ? lastUser.content
      : Array.isArray(lastUser?.content)
        ? lastUser.content
            .map((part) => (part?.type === "text" ? part.text : ""))
            .filter(Boolean)
            .join(" ")
        : "";
  return "E2E_OK: " + (text || "no user prompt");
}

function sendSse(res, payload) {
  const id = "chatcmpl-tdai-e2e";
  const model = payload.model ?? "tdai-e2e-model";
  const chunks = [
    { id, object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
    { id, object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta: { content: responseText(payload) }, finish_reason: null }] },
    { id, object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const chunk of chunks) {
    res.write("data: " + JSON.stringify(chunk) + "\n\n");
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

function sendJson(res, payload) {
  const body = JSON.stringify({
    id: "chatcmpl-tdai-e2e",
    object: "chat.completion",
    created: 0,
    model: payload.model ?? "tdai-e2e-model",
    choices: [{ index: 0, message: { role: "assistant", content: responseText(payload) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "tdai-e2e-model", object: "model" }] }));
    return;
  }
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
    return;
  }
  try {
    const payload = await readJson(req);
    if (payload.stream) {
      sendSse(res, payload);
    } else {
      sendJson(res, payload);
    }
  } catch (error) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock-openai listening on http://127.0.0.1:${port}/v1`);
});

process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
