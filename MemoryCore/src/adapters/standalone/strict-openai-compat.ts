/** Adapt text-only chat requests for endpoints that reject array/null content. */
export function createStrictOpenAICompatFetch(fetchImpl: typeof fetch = globalThis.fetch): typeof fetch {
  return async (input, init) => {
    // The AI SDK sends serialized JSON in init.body. Leave other fetch bodies alone.
    if (typeof init?.body !== "string") return fetchImpl(input, init);
    let body: unknown;
    try {
      body = JSON.parse(init.body);
    } catch {
      return fetchImpl(input, init);
    }
    if (!body || typeof body !== "object" || !("messages" in body) || !Array.isArray(body.messages)) {
      return fetchImpl(input, init);
    }

    let changed = false;
    const messages = body.messages.map((message: unknown) => {
      if (!message || typeof message !== "object" || !("content" in message)) return message;
      const content = message.content;
      if (content === null) {
        changed = true;
        return { ...message, content: "" };
      }
      // Never discard image/audio/unknown parts to satisfy a text-only schema.
      if (Array.isArray(content) && content.every((part) =>
        part && part.type === "text" && typeof part.text === "string",
      )) {
        changed = true;
        return { ...message, content: content.map((part) => part.text).join("") };
      }
      return message;
    });
    return fetchImpl(input, changed ? {
      ...init,
      body: JSON.stringify({ ...body, messages }),
    } : init);
  };
}
