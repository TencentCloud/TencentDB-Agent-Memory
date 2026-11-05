import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeGraphDetail } from "../web/src/lib/api/knowledge-api";

// Vitest belongs to the parent package; reuse the web package's existing DOM/React.
const requireWeb = createRequire(
  new URL("../web/package.json", import.meta.url),
);
const { createElement, act, StrictMode } = requireWeb("react");
const { createRoot } = requireWeb("react-dom/client");
const { JSDOM } = requireWeb("jsdom");
const mocks = vi.hoisted(() => ({
  teamId: "team-A",
  agents: [],
  t: (key: string) => key,
  api: {
    get: vi.fn(),
    create: vi.fn(),
    sync: vi.fn(),
    teamAssets: vi.fn(),
    registerMeta: vi.fn(),
    delete: vi.fn(),
  },
  notify: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));
vi.mock("@/lib/api/knowledge-api", () => ({
  knowledgeApi: { code: mocks.api },
}));
vi.mock("@/services", () => ({
  useTeams: () => ({
    activeTeamId: mocks.teamId,
    activeTeam: { team_id: mocks.teamId },
  }),
  useAgents: () => ({ agents: mocks.agents }),
}));
vi.mock("@/components/LoginGate", () => ({
  readAuth: () => ({ user_id: "tester" }),
}));
vi.mock("@/lib/tea-bridge", () => ({
  tea: { notify: mocks.notify, confirm: async () => true },
}));
vi.mock("@/lib/asset-common", () => import("../web/src/lib/asset-common"));
vi.doMock(
  resolve(
    dirname(requireWeb.resolve("react-i18next/package.json")),
    requireWeb("react-i18next/package.json").module,
  ),
  () => ({
    useTranslation: () => ({ t: mocks.t }),
  }),
);
const { useCodeSources } =
  await import("../web/src/pages/CodePage/hooks/useCodeSources");

function graph(
  id: string,
  status: CodeGraphDetail["status"],
  sync_error: string | null = null,
): CodeGraphDetail {
  return {
    code_graph_id: id,
    team_id: "team-A",
    repo_name: `org/${id}`,
    repo_url: `https://example.com/org/${id}.git`,
    branch: "main",
    status,
    sync_error,
    commit_hash: null,
    service_url: null,
    summary: null,
    version: "1",
    owner_user_id: "tester",
    stats: null,
    last_sync_at: null,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("CodeGraph polling lifecycle", () => {
  let dom: any;
  let root: any;
  let store: ReturnType<typeof useCodeSources>;
  function Probe() {
    store = useCodeSources();
    return null;
  }

  beforeEach(async () => {
    vi.resetAllMocks();
    mocks.teamId = "team-A";
    mocks.api.teamAssets.mockResolvedValue([]);
    mocks.api.sync.mockResolvedValue(undefined);
    mocks.api.registerMeta.mockResolvedValue(undefined);
    mocks.api.delete.mockResolvedValue(undefined);
    // Unknown graph requests fail loudly through the assertions, never return a success fixture.
    mocks.api.get.mockRejectedValue(new Error("unexpected get"));
    dom = new JSDOM("<!doctype html><html><body></body></html>");
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () =>
      root.render(createElement(StrictMode, null, createElement(Probe))),
    );
    await act(async () => store.setScopeTab("team"));
  });

  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    dom.window.close();
    vi.unstubAllGlobals();
  });

  async function advance(ms = 8000) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }
  async function create(
    id = "new",
    status: CodeGraphDetail["status"] = "pending",
  ) {
    mocks.api.create.mockResolvedValueOnce(graph(id, status));
    await act(async () =>
      store.setFormRepo(`https://example.com/org/${id}.git`),
    );
    await act(async () => store.handleRegister());
    expect(mocks.api.create).toHaveBeenLastCalledWith({
      teamId: "team-A",
      repoUrl: `https://example.com/org/${id}.git`,
      repoName: `https://example.com/org/${id}.git`,
      branch: "main",
    });
  }

  it.each(["failed", "missing"] as const)(
    "stops %s polling but retains an unregistered graph and its error",
    async (status) => {
      mocks.api.get.mockResolvedValue(
        graph("new", status, "repository unavailable"),
      );
      await create();
      expect(store.filteredSources).toEqual([
        graph("new", status, "repository unavailable"),
      ]);
      expect(mocks.api.registerMeta).not.toHaveBeenCalled();
      await advance(32000);
      expect(mocks.api.get).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(store.filteredSources).toEqual([
        graph("new", status, "repository unavailable"),
      ]);
      await act(async () => store.setStatusFilter("error"));
      expect(store.filteredSources.map((s) => s.code_graph_id)).toEqual([
        "new",
      ]);
      await act(async () => store.fetchSources());
      expect(store.filteredSources).toHaveLength(1);
    },
  );

  it("keeps pending and processing polling at the existing cadence", async () => {
    mocks.api.get
      .mockResolvedValueOnce(graph("new", "pending"))
      .mockResolvedValueOnce(graph("new", "processing"))
      .mockResolvedValue(graph("new", "failed", "clone failed"));
    await create();
    await advance(7999);
    expect(mocks.api.get).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(store.filteredSources[0].status).toBe("processing");
    expect(mocks.api.get).toHaveBeenCalledTimes(2);
    await advance();
    expect(store.filteredSources[0].sync_error).toBe("clone failed");
    await advance(24000);
    expect(mocks.api.get).toHaveBeenCalledTimes(3);
  });

  it("polls only the active graph when another graph has failed", async () => {
    mocks.api.get.mockImplementation(async (id: string) =>
      graph(id, id === "bad" ? "failed" : "processing"),
    );
    await create("bad");
    await create("busy");
    await advance(24000);
    expect(
      mocks.api.get.mock.calls.filter(([id]) => id === "bad"),
    ).toHaveLength(1);
    expect(
      mocks.api.get.mock.calls.filter(([id]) => id === "busy").length,
    ).toBeGreaterThanOrEqual(3);
    expect(
      store.filteredSources.map((s) => [s.code_graph_id, s.status]),
    ).toEqual([
      ["bad", "failed"],
      ["busy", "processing"],
    ]);
  });

  it.each(["failed", "missing"] as const)(
    "resumes an unregistered %s graph after manual sync and registers ready once",
    async (status) => {
      mocks.api.get.mockResolvedValue(graph("new", status, "old error"));
      await create();
      const pending = deferred<CodeGraphDetail>();
      mocks.api.get.mockReturnValueOnce(pending.promise);
      await act(async () => store.handleSync("new"));
      expect(mocks.api.sync).toHaveBeenCalledWith("new");
      expect(store.filteredSources[0]).toMatchObject({
        status: "processing",
        sync_error: null,
      });
      mocks.api.teamAssets.mockResolvedValue([graph("new", "ready")]);
      await act(async () => pending.resolve(graph("new", "ready")));
      expect(mocks.api.registerMeta).toHaveBeenCalledTimes(1);
      expect(mocks.api.registerMeta).toHaveBeenCalledWith("team-A", "new");
      expect(store.filteredSources).toEqual([graph("new", "ready")]);
      await advance(24000);
      expect(mocks.api.get).toHaveBeenCalledTimes(2);
      expect(mocks.api.registerMeta).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps the failure visible and polling stopped if manual sync is rejected", async () => {
    mocks.api.get.mockResolvedValue(graph("new", "failed", "clone failed"));
    await create();
    const error = new Error("sync unavailable");
    mocks.api.sync.mockRejectedValue(error);
    await act(async () => store.handleSync("new"));
    await advance(24000);
    expect(store.filteredSources[0]).toMatchObject({
      status: "failed",
      sync_error: "clone failed",
    });
    expect(mocks.notify.error).toHaveBeenCalledWith(error);
    expect(mocks.api.get).toHaveBeenCalledTimes(1);
  });

  it("overrides a stale team-list snapshot without duplicating the failed graph", async () => {
    mocks.api.teamAssets.mockResolvedValue([graph("existing", "ready")]);
    await act(async () => store.fetchSources());
    mocks.api.get.mockResolvedValue(
      graph("existing", "failed", "refresh failed"),
    );
    await act(async () => store.handleSync("existing"));
    await advance(16000);
    expect(store.filteredSources).toEqual([
      graph("existing", "failed", "refresh failed"),
    ]);
    expect(mocks.api.get).toHaveBeenCalledTimes(1);
  });

  it("requires explicit sync after an external recovery, keeping list refresh separate from retry", async () => {
    mocks.api.get.mockResolvedValue(graph("new", "failed", "clone failed"));
    await create();
    // The backend has recovered, but a team-list snapshot may still be stale.
    mocks.api.teamAssets.mockResolvedValue([graph("new", "ready")]);
    mocks.api.get.mockResolvedValue(graph("new", "ready"));
    await act(async () => store.fetchSources());
    await advance(32000);
    expect(store.filteredSources).toEqual([graph("new", "failed", "clone failed")]);
    expect(mocks.api.get).toHaveBeenCalledTimes(1);
    expect(mocks.api.sync).not.toHaveBeenCalled();
    await act(async () => store.handleSync("new"));
    expect(store.filteredSources).toEqual([graph("new", "ready")]);
    expect(mocks.api.registerMeta).toHaveBeenCalledWith("team-A", "new");
    await advance(32000);
    expect(mocks.api.get).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries transient transport errors rather than treating them as terminal states", async () => {
    mocks.api.get
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(graph("new", "processing"))
      .mockResolvedValue(graph("new", "missing", "removed"));
    await create();
    await advance();
    expect(store.filteredSources[0].status).toBe("processing");
    await advance();
    await advance(24000);
    expect(mocks.api.get).toHaveBeenCalledTimes(3);
    expect(mocks.notify.error).not.toHaveBeenCalled();
  });

  it("does not overlap slow polls or register a ready graph twice", async () => {
    const response = deferred<CodeGraphDetail>();
    mocks.api.get.mockReturnValue(response.promise);
    await create();
    await advance(24000);
    expect(mocks.api.get).toHaveBeenCalledTimes(1);
    mocks.api.teamAssets.mockResolvedValue([graph("new", "ready")]);
    await act(async () => response.resolve(graph("new", "ready")));
    expect(mocks.api.registerMeta).toHaveBeenCalledTimes(1);
    expect(mocks.api.registerMeta).toHaveBeenCalledWith("team-A", "new");
  });

  it("ignores an in-progress poll after unmount", async () => {
    const response = deferred<CodeGraphDetail>();
    mocks.api.get.mockReturnValue(response.promise);
    await create();
    await act(async () => root.unmount());
    root = null;
    const listCalls = mocks.api.teamAssets.mock.calls.length;
    await act(async () => response.resolve(graph("new", "ready")));
    await advance(24000);
    expect(mocks.api.get).toHaveBeenCalledTimes(1);
    expect(mocks.api.registerMeta).not.toHaveBeenCalled();
    expect(mocks.api.teamAssets).toHaveBeenCalledTimes(listCalls);
  });

  it("removes a retained failure when its existing asset is deleted", async () => {
    mocks.api.teamAssets.mockResolvedValue([graph("existing", "ready")]);
    await act(async () => store.fetchSources());
    mocks.api.get.mockResolvedValue(graph("existing", "failed", "failed"));
    await act(async () => store.handleSync("existing"));
    mocks.api.teamAssets.mockResolvedValue([]);
    await act(async () => store.handleDelete("existing"));
    await advance(16000);
    expect(store.filteredSources).toEqual([]);
    expect(mocks.api.delete).toHaveBeenCalledTimes(1);
    expect(mocks.api.delete).toHaveBeenCalledWith("existing");
    expect(mocks.api.get).toHaveBeenCalledTimes(1);
  });

  it("clears retained failures and ignores old polls when the active team changes", async () => {
    mocks.api.get.mockResolvedValueOnce(
      graph("bad", "failed", "team A failure"),
    );
    await create("bad");
    const response = deferred<CodeGraphDetail>();
    mocks.api.get.mockReturnValue(response.promise);
    await create("busy");
    mocks.teamId = "team-B";
    await act(async () =>
      root.render(createElement(StrictMode, null, createElement(Probe))),
    );
    expect(store.filteredSources).toEqual([]);
    await act(async () => response.resolve(graph("busy", "ready")));
    await advance(24000);
    expect(mocks.api.registerMeta).not.toHaveBeenCalled();
    expect(mocks.api.get.mock.calls.map(([id]) => id)).toEqual(["bad", "busy"]);
    expect(store.filteredSources).toEqual([]);
  });

  it.each(["failed", "ready"] as const)(
    "ignores a stale %s response superseded by manual retry",
    async (status) => {
      const old = deferred<CodeGraphDetail>();
      mocks.api.get
        .mockReturnValueOnce(old.promise)
        .mockResolvedValue(graph("new", "processing"));
      await create();
      await act(async () => store.handleSync("new"));
      await act(async () =>
        old.resolve(graph("new", status, "obsolete result")),
      );
      expect(store.filteredSources[0]).toMatchObject({
        status: "processing",
        sync_error: null,
      });
      expect(mocks.api.registerMeta).not.toHaveBeenCalled();
      await advance();
      expect(mocks.api.get).toHaveBeenCalledTimes(2);
      expect(store.filteredSources[0].status).toBe("processing");
    },
  );

  it("resumes retry when the previous poll fails before the sync acknowledgment arrives", async () => {
    const poll = deferred<CodeGraphDetail>();
    const sync = deferred<void>();
    mocks.api.get
      .mockReturnValueOnce(poll.promise)
      .mockResolvedValue(graph("new", "processing"));
    mocks.api.sync.mockReturnValue(sync.promise);
    await create();
    let retry!: Promise<void>;
    await act(async () => {
      retry = store.handleSync("new");
    });
    await act(async () =>
      poll.resolve(graph("new", "failed", "previous attempt")),
    );
    expect(store.filteredSources[0].status).toBe("failed");
    await act(async () => {
      sync.resolve();
      await retry;
    });
    expect(store.filteredSources[0]).toMatchObject({
      status: "processing",
      sync_error: null,
    });
    expect(mocks.api.get).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["already registered (409)", false],
    ["permission denied", true],
  ])(
    "preserves ready registration error handling: %s",
    async (message, notify) => {
      mocks.api.get.mockResolvedValue(graph("new", "ready"));
      mocks.api.registerMeta.mockRejectedValue(new Error(String(message)));
      mocks.api.teamAssets.mockResolvedValue([graph("new", "ready")]);
      await create();
      await advance(24000);
      expect(mocks.api.registerMeta).toHaveBeenCalledTimes(1);
      expect(mocks.api.get).toHaveBeenCalledTimes(1);
      expect(mocks.notify.error).toHaveBeenCalledTimes(notify ? 1 : 0);
      expect(store.filteredSources[0].status).toBe("ready");
    },
  );

  it("does not reinsert a failed graph when an old-team sync acknowledgment arrives", async () => {
    mocks.api.get.mockResolvedValue(graph("new", "failed", "team A failure"));
    await create();
    const response = deferred<void>();
    mocks.api.sync.mockReturnValue(response.promise);
    let retry!: Promise<void>;
    await act(async () => {
      retry = store.handleSync("new");
    });
    mocks.teamId = "team-B";
    await act(async () =>
      root.render(createElement(StrictMode, null, createElement(Probe))),
    );
    const listCalls = mocks.api.teamAssets.mock.calls.length;
    await act(async () => {
      response.resolve();
      await retry;
    });
    await advance(16000);
    expect(store.filteredSources).toEqual([]);
    expect(mocks.api.get).toHaveBeenCalledTimes(1);
    expect(mocks.api.teamAssets).toHaveBeenCalledTimes(listCalls);
  });

  it("does not enqueue an old-team creation after switching teams", async () => {
    const response = deferred<CodeGraphDetail>();
    mocks.api.create.mockReturnValue(response.promise);
    await act(async () => store.setFormRepo("https://example.com/org/new.git"));
    let creation!: Promise<void>;
    await act(async () => {
      creation = store.handleRegister();
    });
    mocks.teamId = "team-B";
    await act(async () =>
      root.render(createElement(StrictMode, null, createElement(Probe))),
    );
    await act(async () => {
      response.resolve(graph("new", "pending"));
      await creation;
    });
    await advance(16000);
    expect(store.filteredSources).toEqual([]);
    expect(store.submitting).toBe(false);
    expect(mocks.api.get).not.toHaveBeenCalled();
    expect(mocks.notify.info).not.toHaveBeenCalled();
  });
});
