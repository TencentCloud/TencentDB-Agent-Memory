declare module "@openai/codex-sdk" {
  export class Codex {
    constructor(options?: Record<string, unknown>);
    startThread(options?: Record<string, unknown>): Promise<unknown>;
    createThread?(options?: Record<string, unknown>): Promise<unknown>;
    thread?(options?: Record<string, unknown>): Promise<unknown>;
  }
  const defaultExport: typeof Codex;
  export default defaultExport;
}

declare module "@anthropic-ai/claude-agent-sdk" {
  export function query(input: {
    prompt: string;
    options?: Record<string, unknown>;
  }): AsyncIterable<unknown>;
}
