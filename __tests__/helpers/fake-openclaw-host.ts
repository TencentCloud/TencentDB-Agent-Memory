/**
 * FakeOpenClawHost — deterministic offline simulation of the OpenClaw host
 * for prompt-cache stability tests (issue #120).
 *
 * It drives the REAL `register()` from index.ts and mimics the parts of the
 * host that matter for prefix-matching prompt caches:
 *
 *  - `before_prompt_build` hooks run before every turn; their
 *    `{ prependContext, appendSystemContext }` results are merged.
 *  - System prompt composition per build (replace model, like the host's
 *    `composeSystemPromptWithHookContext`):
 *        [base head] <CACHE_BOUNDARY/> [stable additions] [dynamic tail?] [hook context tail]
 *    Stable additions come from `prependSystemPromptAdditionAfterCacheBoundary`
 *    (when `supportsStableInjection`) and are inserted immediately after the
 *    boundary, AHEAD of the per-turn dynamic tail. Legacy hook context
 *    (`appendSystemContext`) is appended at the very tail — after the dynamic
 *    region — which is exactly the cache-hostile placement the issue reports.
 *  - `showInjected` semantics: when true, the user message committed to
 *    history contains the injected `prependContext` (frozen-in); the
 *    `before_message_write` hooks then get a chance to clean it.
 *
 * Fully deterministic: no timers, no network, no LLM.
 */

export interface FakeHostMessage {
  role: string;
  content: string;
}

export interface FakeHostTurnResult {
  /** Composed system prompt for this build. */
  system: string;
  /** Messages array sent to the provider (history + current user message). */
  messages: FakeHostMessage[];
  /** Full serialized request — the byte sequence a prefix cache would see. */
  serialized: string;
  /** The current user message content as sent to the provider this turn. */
  currentUserContent: string;
}

export interface FakeOpenClawHostOptions {
  /** State dir handed to the plugin via runtime.state.resolveStateDir(). */
  stateDir: string;
  /** Raw plugin config (parsed by the real parseConfig inside register()). */
  pluginConfig: Record<string, unknown>;
  /** Expose prependSystemPromptAdditionAfterCacheBoundary on the api (default: false). */
  supportsStableInjection?: boolean;
  /** Freeze injected prependContext into committed history (default: true — the regression). */
  showInjected?: boolean;
  /**
   * Append a per-turn dynamic tail to the system prompt after the boundary
   * (simulates the host's dynamic system region — runtime info, tool results
   * budget, etc.). Default: false so headline byte-stability tests can assert
   * fully identical system prompts.
   */
  simulateDynamicTail?: boolean;
}

type HookHandler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;

export class FakeOpenClawHost {
  readonly systemBase = "You are OpenClaw.\n<CACHE_BOUNDARY/>";

  /** Committed conversation history (grows monotonically across turns). */
  readonly history: FakeHostMessage[] = [];
  /** Every arg ever passed to prependSystemPromptAdditionAfterCacheBoundary. */
  readonly stableAdditionCalls: string[] = [];
  /** Collected log lines by level (diagnostics for tests). */
  readonly logs: Record<"debug" | "info" | "warn" | "error", string[]> = {
    debug: [], info: [], warn: [], error: [],
  };

  readonly api: Record<string, unknown>;

  private readonly handlers = new Map<string, HookHandler[]>();
  private readonly opts: Required<Pick<FakeOpenClawHostOptions, "showInjected" | "supportsStableInjection" | "simulateDynamicTail">> & FakeOpenClawHostOptions;
  private turn = 0;
  /** Stable additions registered during the CURRENT prompt build (replace model). */
  private buildStableAdditions: string[] = [];

  constructor(options: FakeOpenClawHostOptions) {
    this.opts = {
      showInjected: true,
      supportsStableInjection: false,
      simulateDynamicTail: false,
      ...options,
    };

    const host = this;
    this.api = {
      // Full registration mode (undefined = not "cli-metadata")
      registrationMode: undefined,
      pluginConfig: this.opts.pluginConfig,
      config: {},
      logger: {
        debug: (m: string) => host.logs.debug.push(m),
        info: (m: string) => host.logs.info.push(m),
        warn: (m: string) => host.logs.warn.push(m),
        error: (m: string) => host.logs.error.push(m),
      },
      runtime: {
        agent: {},
        // IMPORTANT: keep version undefined. register() gates the hook-policy
        // auto-patch on a parsable version; a modern version string + vitest
        // argv would send ensurePluginHookPolicy down the manual-patch path,
        // which can touch the developer's real ~/.openclaw/openclaw.json.
        version: undefined,
        config: undefined,
        state: { resolveStateDir: () => host.opts.stateDir },
      },
      on(name: string, fn: HookHandler) {
        const list = host.handlers.get(name) ?? [];
        list.push(fn);
        host.handlers.set(name, list);
      },
      registerTool(_def: unknown, _opts?: unknown) { /* not needed for these tests */ },
      registerCli(_fn: unknown, _opts?: unknown) { /* not needed for these tests */ },
      ...(this.opts.supportsStableInjection
        ? {
            prependSystemPromptAdditionAfterCacheBoundary(content: string) {
              host.stableAdditionCalls.push(content);
              host.buildStableAdditions.push(content);
            },
          }
        : {}),
    };
  }

  handlerCount(name: string): number {
    return this.handlers.get(name)?.length ?? 0;
  }

  /**
   * Run one full conversation turn:
   *  1. fire before_prompt_build hooks and merge their results;
   *  2. compose the system prompt (replace model) + provider messages;
   *  3. serialize the request (what a prefix-matching cache hashes);
   *  4. commit the turn: before_message_write → history push (+ fake reply).
   */
  async runTurn(sessionKey: string, userText: string): Promise<FakeHostTurnResult> {
    this.turn++;
    this.buildStableAdditions = []; // per-build replace model

    // 1. before_prompt_build
    let prependContext: string | undefined;
    let appendSystemContext: string | undefined;
    const event = { prompt: userText, messages: [...this.history] };
    const ctx = { sessionKey };
    for (const handler of this.handlers.get("before_prompt_build") ?? []) {
      const result = (await handler(event, ctx)) as
        | { prependContext?: string; appendSystemContext?: string }
        | undefined;
      if (result?.prependContext) prependContext = result.prependContext;
      if (result?.appendSystemContext) appendSystemContext = result.appendSystemContext;
    }

    // 2. Compose system prompt: base head, boundary, stable additions right
    //    after the boundary, then the dynamic tail, then legacy hook context
    //    at the very end (composeSystemPromptWithHookContext tail-append).
    let system = this.systemBase;
    if (this.buildStableAdditions.length > 0) {
      system += `\n${this.buildStableAdditions.join("\n\n")}`;
    }
    if (this.opts.simulateDynamicTail) {
      system += `\n<runtime-info turn="${this.turn}" budget="${1000 - this.turn * 37}"/>`;
    }
    if (appendSystemContext) {
      system += `\n${appendSystemContext}`;
    }

    const currentUserContent = prependContext
      ? `${prependContext}\n\n${userText}`
      : userText;
    const messages: FakeHostMessage[] = [
      ...this.history.map((m) => ({ ...m })),
      { role: "user", content: currentUserContent },
    ];

    // 3. Serialize the full provider request
    const serialized = JSON.stringify({ system, messages });

    // 4. Commit to history. showInjected=true freezes the injected content
    //    into the committed message; before_message_write may clean it.
    let committed: FakeHostMessage = {
      role: "user",
      content: this.opts.showInjected ? currentUserContent : userText,
    };
    for (const handler of this.handlers.get("before_message_write") ?? []) {
      const result = (await handler({ message: committed }, ctx)) as
        | { message?: FakeHostMessage }
        | undefined;
      if (result?.message) committed = result.message;
    }
    this.history.push(committed);
    this.history.push({ role: "assistant", content: `reply-${this.turn}` });

    return { system, messages, serialized, currentUserContent };
  }

  /** Fire registered gateway_stop handlers (cleanup guard for tests). */
  async stop(): Promise<void> {
    for (const handler of this.handlers.get("gateway_stop") ?? []) {
      await handler({}, {});
    }
  }
}

/** Longest common prefix length of two strings (byte-prefix stability metric). */
export function lcpLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}
