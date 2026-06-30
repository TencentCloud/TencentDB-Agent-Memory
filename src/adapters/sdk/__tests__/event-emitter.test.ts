/**
 * Unit tests for EventEmitter
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { DefaultEventEmitter, ADAPTER_EVENTS } from "../event-emitter.js";

describe("DefaultEventEmitter", () => {
  let emitter: DefaultEventEmitter;

  beforeEach(() => {
    emitter = new DefaultEventEmitter({ maxHistorySize: 100 });
  });

  describe("on/off", () => {
    it("should add and remove event handlers", () => {
      const handler = vi.fn();
      const unsubscribe = emitter.on("test", handler);

      emitter.emit("test", { data: "value" });
      expect(handler).toHaveBeenCalledWith({ data: "value" });

      unsubscribe();
      emitter.emit("test", { data: "new" });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("should support multiple handlers per event", () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      emitter.on("test", handler1);
      emitter.on("test", handler2);

      emitter.emit("test", {});

      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
    });

    it("should return unsubscribe function", () => {
      const handler = vi.fn();
      const unsubscribe = emitter.on("test", handler);

      expect(typeof unsubscribe).toBe("function");

      unsubscribe();
      emitter.emit("test", {});
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("once", () => {
    it("should auto-unsubscribe after first emit", () => {
      const handler = vi.fn();
      emitter.once("test", handler);

      emitter.emit("test", {});
      emitter.emit("test", {});
      emitter.emit("test", {});

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe("emit", () => {
    it("should pass data to handlers", () => {
      const handler = vi.fn();
      emitter.on("test", handler);

      emitter.emit("test", { foo: "bar", num: 42 });

      expect(handler).toHaveBeenCalledWith({ foo: "bar", num: 42 });
    });

    it("should handle async handlers", async () => {
      const handler = vi.fn().mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
      });
      emitter.on("test", handler);

      await emitter.emit("test", {});
      expect(handler).toHaveBeenCalled();
    });

    it("should not throw when handler throws", () => {
      const throwingHandler = vi.fn(() => {
        throw new Error("Handler error");
      });
      emitter.on("test", throwingHandler);

      // Should not throw
      expect(() => emitter.emit("test", {})).not.toThrow();
      expect(throwingHandler).toHaveBeenCalled();
    });
  });

  describe("removeAllListeners", () => {
    it("should remove all handlers for specific event", () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      emitter.on("test1", handler1);
      emitter.on("test2", handler2);

      emitter.removeAllListeners("test1");

      emitter.emit("test1", {});
      emitter.emit("test2", {});

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
    });

    it("should remove all handlers when no event specified", () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      emitter.on("test1", handler1);
      emitter.on("test2", handler2);

      emitter.removeAllListeners();

      emitter.emit("test1", {});
      emitter.emit("test2", {});

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).not.toHaveBeenCalled();
    });
  });

  describe("history", () => {
    it("should record event history", () => {
      emitter.emit("event1", { data: 1 });
      emitter.emit("event2", { data: 2 });

      const history = emitter.getHistory();
      expect(history.length).toBe(2);
      expect(history[0].event).toBe("event1");
      expect(history[1].event).toBe("event2");
    });

    it("should limit history size", () => {
      const smallEmitter = new DefaultEventEmitter({ maxHistorySize: 3 });

      smallEmitter.emit("e1", {});
      smallEmitter.emit("e2", {});
      smallEmitter.emit("e3", {});
      smallEmitter.emit("e4", {});

      const history = smallEmitter.getHistory();
      expect(history.length).toBe(3);
      expect(history[0].event).toBe("e2");
    });

    it("should not record history when maxHistorySize is 0", () => {
      const noHistoryEmitter = new DefaultEventEmitter({ maxHistorySize: 0 });

      noHistoryEmitter.emit("test", {});

      expect(noHistoryEmitter.getHistory().length).toBe(0);
    });
  });

  describe("listenerCount/hasListeners", () => {
    it("should return correct listener count", () => {
      expect(emitter.listenerCount("test")).toBe(0);
      expect(emitter.hasListeners("test")).toBe(false);

      emitter.on("test", vi.fn());
      expect(emitter.listenerCount("test")).toBe(1);
      expect(emitter.hasListeners("test")).toBe(true);

      emitter.on("test", vi.fn());
      expect(emitter.listenerCount("test")).toBe(2);
    });
  });

  describe("ADAPTER_EVENTS", () => {
    it("should have all required event types", () => {
      expect(ADAPTER_EVENTS.LIFECYCLE_INIT).toBe("lifecycle:init");
      expect(ADAPTER_EVENTS.LIFECYCLE_DISPOSE).toBe("lifecycle:dispose");
      expect(ADAPTER_EVENTS.TOOL_REGISTERED).toBe("tool:registered");
      expect(ADAPTER_EVENTS.RECALL_COMPLETE).toBe("recall:complete");
      expect(ADAPTER_EVENTS.CAPTURE_COMPLETE).toBe("capture:complete");
    });
  });
});
