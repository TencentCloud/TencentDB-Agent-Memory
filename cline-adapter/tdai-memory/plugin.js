import {
  createMemoryRuntime,
  injectRecallIntoMessages,
  latestUserText,
} from "./runtime.mjs";

function conversationId(snapshot) {
  return snapshot?.conversationId ?? snapshot?.runId ?? snapshot?.agentId ?? "";
}

export function createClineMemoryPlugin({ runtime = createMemoryRuntime() } = {}) {
  const recalledByConversation = new Map();

  return {
    name: "tencentdb-agent-memory",
    manifest: { capabilities: ["hooks"] },
    hooks: {
      async beforeRun({ snapshot }) {
        const id = conversationId(snapshot);
        try {
          const prompt = latestUserText(snapshot?.messages);
          const context = await runtime.recall(prompt, id);
          if (context) recalledByConversation.set(id, context);
          else recalledByConversation.delete(id);
        } catch {
          recalledByConversation.delete(id);
        }
        return undefined;
      },

      beforeModel({ snapshot, request }) {
        const context = recalledByConversation.get(conversationId(snapshot));
        if (!context) return undefined;
        return {
          messages: injectRecallIntoMessages(request.messages, context),
        };
      },

      async afterRun({ snapshot, result }) {
        const id = conversationId(snapshot);
        recalledByConversation.delete(id);
        if (result?.status !== "completed") return;
        const userContent =
          latestUserText(result.messages) || latestUserText(snapshot?.messages);
        const assistantContent =
          typeof result.outputText === "string" ? result.outputText.trim() : "";
        try {
          await runtime.capture(userContent, assistantContent, id);
        } catch {
          // Memory is best-effort and must never fail the Cline run.
        }
      },
    },
  };
}

const plugin = createClineMemoryPlugin();
export { plugin };
export default plugin;
