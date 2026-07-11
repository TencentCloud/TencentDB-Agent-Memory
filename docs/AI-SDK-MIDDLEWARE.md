# Vercel AI SDK Memory Middleware

`createAiSdkMemoryMiddleware()` connects TencentDB Agent Memory to the Vercel AI SDK v6
through its native `LanguageModelV3Middleware` contract. It works with both
`generateText()` and `streamText()` and does not introduce another Gateway client.
See the [AI SDK middleware contract](https://ai-sdk.dev/docs/ai-sdk-core/middleware) for
the host-side API used by this adapter.

The middleware owns only the platform lifecycle mapping:

| AI SDK phase | Memory action |
| :--- | :--- |
| `transformParams` | Recall from the latest user text and append the context to that user message |
| `wrapGenerate` | Capture the final user/assistant turn after a terminal response |
| `wrapStream` | Collect text deltas and capture after the stream finishes |
| Intermediate `tool-calls` finish | Reuse the active recall and wait for the terminal model step |

Recall and capture errors fail open. The original model call or stream continues, and callers
can observe failures through `onError`.

## Quick Start

Create one middleware instance for each conversation and keep `sessionKey` stable for that
conversation.

```ts
import { createAiSdkMemoryMiddleware } from "@tencentdb-agent-memory/memory-tencentdb/ai-sdk";
import { openai } from "@ai-sdk/openai";
import { generateText, wrapLanguageModel } from "ai";

const gatewayUrl = "http://127.0.0.1:8420";
const apiKey = process.env.TDAI_GATEWAY_API_KEY;
const sessionKey = "customer-42:conversation-7";

const gatewayRequest = async (path: string, body: unknown) => {
  const response = await fetch(`${gatewayUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`TDAI Gateway ${response.status}`);
  return response.json() as Promise<Record<string, unknown>>;
};

const middleware = createAiSdkMemoryMiddleware({
  sessionKey,
  userId: "customer-42",
  memory: {
    async recall({ query, sessionKey, userId }) {
      const result = await gatewayRequest("/recall", {
        query,
        session_key: sessionKey,
        user_id: userId,
      });
      return { context: typeof result.context === "string" ? result.context : "" };
    },
    async capture({ userContent, assistantContent, sessionKey, userId }) {
      await gatewayRequest("/capture", {
        user_content: userContent,
        assistant_content: assistantContent,
        session_key: sessionKey,
        user_id: userId,
      });
    },
  },
  onError: ({ phase, error }) => {
    console.warn(`[tdai-memory] ${phase} failed`, error);
  },
});

const model = wrapLanguageModel({
  model: openai("gpt-4.1-mini"),
  middleware,
});

const result = await generateText({
  model,
  prompt: "What did we decide about the deployment strategy?",
});
```

The same wrapped model can be passed to `streamText()`. Capture waits for a terminal stream
finish and never runs for an intermediate tool-call step. The application must consume the
stream to completion; cancelled or abandoned streams are not persisted as completed turns.

## Prompt Placement

Recalled memory is added as a separate text part at the end of the latest user message:

```xml
<relevant-memories source="tencentdb-agent-memory">
...
</relevant-memories>
```

Earlier system and history messages remain byte-for-byte unchanged. If the middleware is
applied more than once, it replaces its own generated block instead of duplicating it.

## 中文说明

该适配器直接实现 AI SDK v6 的语言模型中间件协议，不新增一套 Gateway SDK：

- `transformParams` 在模型调用前根据最后一条用户文本召回记忆；
- 召回内容追加在当前用户消息末尾，不改写更早的系统提示和历史前缀；
- `wrapGenerate` 在非工具调用的最终响应后写入一轮记忆；
- `wrapStream` 收集流式文本，并在流正常结束后写入；
- 同一轮工具调用链只召回一次，最终回答生成前复用该结果；
- Gateway 不可用时保持 fail-open，不阻断模型回答。

`AiSdkMemoryPort` 是传输无关边界，可以由 Gateway HTTP client、进程内核心调用或测试
替身实现。应用应当为每个会话创建 middleware，并使用稳定且不包含密钥的 `sessionKey`。
