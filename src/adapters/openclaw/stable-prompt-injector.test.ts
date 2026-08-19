import { describe, expect, it, vi } from "vitest";

import {
  STABLE_INJECTION_API_CANDIDATES,
  resolveStablePromptInjector,
} from "./stable-prompt-injector.js";

const API_NAME = "prependSystemPromptAdditionAfterCacheBoundary";

describe("resolveStablePromptInjector", () => {
  it("exposes the documented candidate list", () => {
    expect(STABLE_INJECTION_API_CANDIDATES).toContain(API_NAME);
  });

  it("returns undefined when no carrier exposes the API", () => {
    expect(resolveStablePromptInjector({}, {}, {})).toBeUndefined();
    expect(resolveStablePromptInjector(undefined, undefined, undefined)).toBeUndefined();
    expect(resolveStablePromptInjector(null, "string-event", 42)).toBeUndefined();
  });

  it("finds the API on the plugin api object and binds `this`", () => {
    const calls: string[] = [];
    const api = {
      [API_NAME](content: string) {
        calls.push(content);
        expect(this).toBe(api);
      },
    };
    const resolved = resolveStablePromptInjector(api);
    expect(resolved?.source).toBe("api");
    expect(resolved?.apiName).toBe(API_NAME);
    resolved?.injector("stable-block");
    expect(calls).toEqual(["stable-block"]);
  });

  it("finds the API on api.runtime", () => {
    const fn = vi.fn();
    const api = { runtime: { [API_NAME]: fn } };
    const resolved = resolveStablePromptInjector(api);
    expect(resolved?.source).toBe("api.runtime");
    resolved?.injector("x");
    expect(fn).toHaveBeenCalledWith("x");
  });

  it("prefers request-scoped carriers: event > ctx > api > api.runtime", () => {
    const order: string[] = [];
    const mk = (tag: string) => ({ [API_NAME]: () => order.push(tag) });

    const all = resolveStablePromptInjector(mk("api"), mk("event"), mk("ctx"));
    expect(all?.source).toBe("event");
    all?.injector("");
    expect(order).toEqual(["event"]);

    const noEvent = resolveStablePromptInjector(mk("api"), {}, mk("ctx"));
    expect(noEvent?.source).toBe("ctx");

    const apiRuntimeOnly = resolveStablePromptInjector({ runtime: mk("runtime") }, {}, {});
    expect(apiRuntimeOnly?.source).toBe("api.runtime");
  });

  it("ignores non-function values under the candidate name", () => {
    expect(
      resolveStablePromptInjector({ [API_NAME]: "not-a-function" }, { [API_NAME]: 123 }),
    ).toBeUndefined();
  });

  it("never throws on exotic carriers", () => {
    expect(() =>
      resolveStablePromptInjector(Object.create(null), Symbol("e") as unknown, () => {}),
    ).not.toThrow();
  });

  it("never throws when a carrier property getter throws (request-scoped getter)", () => {
    const event = {};
    Object.defineProperty(event, API_NAME, {
      get() {
        throw new Error("accessed outside request scope");
      },
      enumerable: true,
    });
    // Probe must skip the hostile carrier and still find the API further down.
    const fn = vi.fn();
    const resolved = resolveStablePromptInjector({ [API_NAME]: fn }, event, {});
    expect(resolved?.source).toBe("api");
    resolved?.injector("x");
    expect(fn).toHaveBeenCalledWith("x");
  });

  it("never throws when api.runtime itself is a throwing getter", () => {
    const api = {};
    Object.defineProperty(api, "runtime", {
      get() {
        throw new Error("no runtime outside request");
      },
    });
    expect(resolveStablePromptInjector(api)).toBeUndefined();
  });

  it("propagates host API exceptions to the caller (caller owns the try/catch)", () => {
    const api = {
      [API_NAME]: () => {
        throw new Error("host exploded");
      },
    };
    const resolved = resolveStablePromptInjector(api);
    expect(resolved).toBeDefined();
    expect(() => resolved?.injector("x")).toThrow("host exploded");
  });
});
