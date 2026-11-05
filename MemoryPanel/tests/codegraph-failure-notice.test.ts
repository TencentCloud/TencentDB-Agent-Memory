import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requireWeb = createRequire(
  new URL("../web/package.json", import.meta.url),
);
const { createElement, act } = requireWeb("react");
const { createRoot } = requireWeb("react-dom/client");
const { JSDOM } = requireWeb("jsdom");
vi.doMock(
  resolve(
    dirname(requireWeb.resolve("react-i18next/package.json")),
    requireWeb("react-i18next/package.json").module,
  ),
  () => ({
    useTranslation: () => ({
      t: () => "Automatic checks stopped. Use Sync to retry.",
    }),
  }),
);
const { default: CodeGraphFailureNotice } =
  await import("../web/src/pages/CodePage/components/CodeGraphFailureNotice");

describe("CodeGraph terminal-state recovery guidance", () => {
  let dom: any, root: any, container: HTMLElement;
  beforeEach(() => {
    dom = new JSDOM("<!doctype html><html><body></body></html>");
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    vi.unstubAllGlobals();
  });
  it.each(["failed", "missing"])(
    "explains how to recover %s even without an upstream error",
    async (status) => {
      await act(async () =>
        root.render(
          createElement(CodeGraphFailureNotice, { status, sync_error: null }),
        ),
      );
      expect(container.querySelector('[role="status"]')?.textContent).toContain(
        "Use Sync to retry",
      );
    },
  );
  it("preserves the diagnostic as text without interpreting repository-controlled markup", async () => {
    await act(async () =>
      root.render(
        createElement(CodeGraphFailureNotice, {
          status: "failed",
          sync_error: "<img src=x onerror=bad()> repository inaccessible",
        }),
      ),
    );
    expect(container.textContent).toContain(
      "<img src=x onerror=bad()> repository inaccessible",
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("Use Sync to retry");
  });
  it.each(["pending", "processing", "ready"])(
    "clears terminal guidance when the graph becomes %s",
    async (status) => {
      await act(async () =>
        root.render(
          createElement(CodeGraphFailureNotice, {
            status: "failed",
            sync_error: "old error",
          }),
        ),
      );
      await act(async () =>
        root.render(
          createElement(CodeGraphFailureNotice, { status, sync_error: null }),
        ),
      );
      expect(container.textContent).toBe("");
    },
  );
});
