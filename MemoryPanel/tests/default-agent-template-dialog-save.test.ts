/**
 * DefaultAgentTemplateDialog 卸载后的保存回调（issue #1935）。
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
  setDefaultTemplate: vi.fn(),
}));
const notify = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock("@/lib/teamApi", () => ({ agentsApi: api }));
vi.mock("@/services", () => ({
  writeAgentUiMeta: () => '{"ui":{"role_prompt":"","rules_prompt":""}}',
}));
vi.mock("@/lib/tea-bridge", () => ({ tea: { notify } }));
vi.mock("@/lib/error-message", () => ({
  getErrorMessage: (error: unknown) => String(error),
}));
vi.mock("../web/src/components/team/useAgentAssets", () => ({
  useTeamAssets: () => ({
    loading: true,
    skills: [],
    codeGraphs: [],
    wikis: [],
  }),
}));
vi.mock("../web/src/components/team/shared", () => ({
  LightField: ({ children }: { children: unknown }) =>
    createElement("div", null, children),
  CollapseGroup: () => null,
  AssetCheckList: () => null,
  selectableAssetKeys: () => [],
}));

const reactI18nextEntry = resolve(
  dirname(requireWeb.resolve("react-i18next/package.json")),
  requireWeb("react-i18next/package.json").module,
);
vi.doMock(reactI18nextEntry, () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.doMock(requireWeb.resolve("tea-component"), () => {
  function Modal({ children }: { children: unknown }) {
    return createElement("div", null, children);
  }
  Modal.Body = ({ children }: { children: unknown }) =>
    createElement("div", null, children);
  Modal.Footer = ({ children }: { children: unknown }) =>
    createElement("div", null, children);

  function Input(props: {
    value?: string;
    onChange?: (value: string) => void;
  }) {
    return createElement("input", {
      value: props.value,
      onChange: (event: { target: { value: string } }) =>
        props.onChange?.(event.target.value),
    });
  }
  Input.TextArea = Input;

  return {
    Button: ({
      children,
      loading: _loading,
      ...props
    }: Record<string, unknown>) =>
      createElement("button", props, children as never),
    Input,
    Modal,
    Tag: ({ children }: { children: unknown }) =>
      createElement("span", null, children),
  };
});
vi.doMock(requireWeb.resolve("tea-icons-react"), () => ({
  BooksIcon: () => null,
  CodeIcon: () => null,
  ToolsIcon: () => null,
}));

const { default: DefaultAgentTemplateDialog } =
  await import("../web/src/components/team/DefaultAgentTemplateDialog");

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason?: unknown) => void;
};

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("DefaultAgentTemplateDialog save lifecycle", () => {
  let dom: InstanceType<typeof JSDOM>;
  let container: HTMLElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    api.setDefaultTemplate.mockReset();
    notify.error.mockReset();
    notify.success.mockReset();
    dom = new JSDOM("<!doctype html><html><body></body></html>");
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = dom.window.document.createElement("div");
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
    dom.window.close();
  });

  async function renderDialog(onSaved = vi.fn()) {
    await act(async () => {
      root.render(
        createElement(DefaultAgentTemplateDialog, {
          team: { team_id: "team-a", name: "Team A" },
          initial: { name: "A template" },
          onClose: vi.fn(),
          onSaved,
        }),
      );
    });
    return onSaved;
  }

  async function clickSave() {
    const button = Array.from(container.querySelectorAll("button")).find(
      (item) => item.textContent === "defaultAgent.save",
    );
    expect(button).toBeDefined();
    await act(async () => {
      button!.click();
    });
  }

  it("still calls onSaved while the dialog is mounted", async () => {
    const request = deferred();
    api.setDefaultTemplate.mockReturnValue(request.promise);
    const onSaved = await renderDialog();

    await clickSave();
    expect(api.setDefaultTemplate).toHaveBeenCalledWith(
      "team-a",
      expect.objectContaining({ name: "A template" }),
    );

    await act(async () => {
      request.resolve();
      await request.promise;
    });

    expect(onSaved).toHaveBeenCalledWith(
      expect.objectContaining({ name: "A template" }),
    );
  });

  it("ignores an old save success after the dialog unmounts and Team A returns", async () => {
    const request = deferred();
    api.setDefaultTemplate.mockReturnValue(request.promise);
    const onSaved = await renderDialog();

    await clickSave();
    await act(async () => root.unmount());

    root = createRoot(container);
    await renderDialog(onSaved);

    await act(async () => {
      request.resolve();
      await request.promise;
    });

    expect(onSaved).not.toHaveBeenCalled();
    expect(notify.error).not.toHaveBeenCalled();
  });

  it("ignores an old save failure after the dialog unmounts", async () => {
    const request = deferred();
    api.setDefaultTemplate.mockReturnValue(request.promise);
    const onSaved = await renderDialog();

    await clickSave();
    await act(async () => root.unmount());

    await act(async () => {
      request.reject(new Error("old save failed"));
      await request.promise.catch(() => undefined);
    });

    expect(onSaved).not.toHaveBeenCalled();
    expect(notify.error).not.toHaveBeenCalled();
  });
});
