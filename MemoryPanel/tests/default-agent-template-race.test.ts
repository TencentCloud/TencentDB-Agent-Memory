/**
 * DefaultAgentTemplateSection 团队切换竞态（issue #1935）。
 *
 * 运行：cd MemoryPanel && npm test
 */
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requireWeb = createRequire(
  new URL("../web/package.json", import.meta.url),
);
const { createElement, act } = requireWeb("react");
const { createRoot } = requireWeb("react-dom/client");
const { JSDOM } = requireWeb("jsdom");

const api = vi.hoisted(() => ({
  getDefaultTemplate: vi.fn(),
}));
const teaMock = vi.hoisted(() => ({
  notify: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));
const buttonProps = vi.hoisted(() => ({
  current: null as Record<string, any> | null,
}));
const dialogMock = vi.hoisted(() => ({ renderCount: 0 }));

vi.mock("@/lib/teamApi", () => ({ agentsApi: api }));
vi.mock("@/lib/tea-bridge", () => ({
  tea: teaMock,
}));
vi.mock("@/lib/error-message", () => ({
  getErrorMessage: (error: unknown) => String(error),
}));

const reactI18nextEntry = resolve(
  dirname(requireWeb.resolve("react-i18next/package.json")),
  requireWeb("react-i18next/package.json").module,
);
vi.doMock(reactI18nextEntry, () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.doMock(requireWeb.resolve("tea-component"), () => ({
  Button: (props: Record<string, any>) => {
    buttonProps.current = props;
    return null;
  },
}));
vi.doMock(requireWeb.resolve("tea-icons-react"), () => ({
  AddIcon: () => null,
  EditIcon: () => null,
}));
vi.doMock(
  requireWeb.resolve("./src/components/team/DefaultAgentTemplateDialog.tsx"),
  () => ({
    default: () => {
      dialogMock.renderCount += 1;
      return null;
    },
  }),
);

const { default: DefaultAgentTemplateSection } =
  await import("../web/src/components/team/DefaultAgentTemplateSection");

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("DefaultAgentTemplateSection team switch race", () => {
  let dom: InstanceType<typeof JSDOM>;
  let root: ReturnType<typeof createRoot>;
  let container: HTMLElement;
  let requests: Map<string, Deferred<{ name: string } | null>>;

  beforeEach(async () => {
    requests = new Map();
    api.getDefaultTemplate.mockReset();
    teaMock.notify.success.mockReset();
    teaMock.notify.error.mockReset();
    buttonProps.current = null;
    dialogMock.renderCount = 0;
    api.getDefaultTemplate.mockImplementation((teamId: string) => {
      const request = deferred<{ name: string } | null>();
      requests.set(teamId, request);
      return request.promise;
    });

    dom = new JSDOM("<!doctype html><html><body></body></html>");
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = dom.window.document.createElement("div");
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    dom.window.close();
  });

  async function renderTeam(teamId: string, teamName: string) {
    await act(async () => {
      root.render(
        createElement(DefaultAgentTemplateSection, {
          teamId,
          teamName,
        }),
      );
    });
  }

  async function resolveRequest(
    teamId: string,
    template: { name: string } | null,
  ) {
    await act(async () => {
      requests.get(teamId)!.resolve(template);
      await requests.get(teamId)!.promise;
    });
  }

  it("keeps team B template when team A responds last", async () => {
    await renderTeam("team-a", "Team A");

    expect(api.getDefaultTemplate).toHaveBeenCalledWith("team-a");

    await renderTeam("team-b", "Team B");

    expect(api.getDefaultTemplate).toHaveBeenCalledWith("team-b");

    await resolveRequest("team-b", { name: "Template B" });
    expect(container.textContent).toContain("Template B");

    await resolveRequest("team-a", { name: "Template A" });

    expect(container.textContent).toContain("Template B");
    expect(container.textContent).not.toContain("Template A");
  });

  it("ignores a stale request failure after switching teams", async () => {
    await renderTeam("team-a", "Team A");
    await renderTeam("team-b", "Team B");
    await resolveRequest("team-b", { name: "Template B" });

    await act(async () => {
      requests.get("team-a")!.reject(new Error("team A failed late"));
      await requests.get("team-a")!.promise.catch(() => undefined);
    });

    expect(container.textContent).toContain("Template B");
    expect(container.textContent).not.toContain("defaultAgent.empty");
    expect(teaMock.notify.error).not.toHaveBeenCalled();
  });

  it("does not notify a stale request failure after unmount", async () => {
    await renderTeam("team-a", "Team A");

    await act(async () => root.unmount());
    await act(async () => {
      requests.get("team-a")!.reject(new Error("team A failed after unmount"));
      await requests.get("team-a")!.promise.catch(() => undefined);
    });

    expect(teaMock.notify.error).not.toHaveBeenCalled();
  });

  it("closes stale editing state and disables actions while the next team loads", async () => {
    await renderTeam("team-a", "Team A");
    await resolveRequest("team-a", { name: "Template A" });

    expect(buttonProps.current?.disabled).toBe(false);
    await act(async () => {
      buttonProps.current?.onClick();
    });
    expect(dialogMock.renderCount).toBe(1);

    await renderTeam("team-b", "Team B");

    expect(container.textContent).not.toContain("Template A");
    expect(container.textContent).toContain("team.loading");
    expect(buttonProps.current?.disabled).toBe(true);
    expect(dialogMock.renderCount).toBe(1);

    await resolveRequest("team-b", { name: "Template B" });

    expect(container.textContent).toContain("Template B");
    expect(buttonProps.current?.disabled).toBe(false);
  });
});
