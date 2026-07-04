import type {
  AgentSdkDriver,
  AgentSdkRunInput,
  AgentSdkRunResult,
  AgentSdkSession,
  AgentSdkSessionOptions,
  AgentSdkStreamEvent,
} from "../types.js";

export interface MockDriverOptions {
  name?: string;
  responder?: (input: AgentSdkRunInput, sessionOptions?: AgentSdkSessionOptions) => string | Promise<string>;
}

export function createMockDriver(options: MockDriverOptions = {}): AgentSdkDriver {
  return new MockDriver(options);
}

class MockDriver implements AgentSdkDriver {
  readonly name: string;
  private readonly responder: NonNullable<MockDriverOptions["responder"]>;

  constructor(options: MockDriverOptions) {
    this.name = options.name ?? "mock-sdk";
    this.responder = options.responder ?? ((input) => `mock response: ${input.prompt}`);
  }

  async startSession(options?: AgentSdkSessionOptions): Promise<AgentSdkSession> {
    return new MockSession(this.responder, options);
  }
}

class MockSession implements AgentSdkSession {
  constructor(
    private readonly responder: NonNullable<MockDriverOptions["responder"]>,
    private readonly sessionOptions?: AgentSdkSessionOptions,
  ) {}

  async *stream(input: AgentSdkRunInput): AsyncIterable<AgentSdkStreamEvent> {
    const text = await this.responder(input, this.sessionOptions);
    yield { type: "agent.event", event: { type: "mock.response", text } };
    yield { type: "agent.text.delta", text };
    yield { type: "agent.completed", text, result: { text } };
  }

  async run(input: AgentSdkRunInput): Promise<AgentSdkRunResult> {
    const events: AgentSdkStreamEvent[] = [];
    let text = "";
    let rawResult: unknown;
    for await (const event of this.stream(input)) {
      events.push(event);
      if (event.type === "agent.text.delta") text += event.text;
      if (event.type === "agent.completed") rawResult = event.result;
    }
    return { text, rawResult, events };
  }
}
