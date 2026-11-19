/**
 * useCodeSources 的轮询接线测试（issue #1937）。
 *
 * 父包没有 React / jsdom，这里用 createRequire 借用 web 包已有的依赖，
 * 不改任何 package.json。验证的是真实 hook：effect 何时启动/停止定时器、
 * 失败后是否真的不再请求、手动同步是否恢复轮询。
 *
 * 运行：cd MemoryPanel && npm test
 */
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodeGraphDetail } from '../web/src/lib/api/knowledge-api';

const requireWeb = createRequire(new URL('../web/package.json', import.meta.url));
const { createElement, act, StrictMode } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const { JSDOM } = requireWeb('jsdom');

const { code, view, notify } = vi.hoisted(() => ({
  code: {
    create: vi.fn(),
    get: vi.fn(),
    registerMeta: vi.fn(),
    teamAssets: vi.fn(),
    sync: vi.fn(),
    agentFixed: vi.fn(),
  },
  view: { teamId: 'team-1' },
  notify: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/lib/api/knowledge-api', () => ({
  knowledgeApi: { code, source: { providers: vi.fn(async () => []) } },
}));
vi.mock('@/services', () => ({
  useTeams: () => ({ activeTeamId: view.teamId, activeTeam: { team_id: view.teamId } }),
  useAgents: () => ({ agents: [] }),
}));
vi.mock('@/components/LoginGate', () => ({ readAuth: () => ({ user_id: 'user-1' }) }));
vi.mock('@/lib/tea-bridge', () => ({
  tea: { notify, confirm: vi.fn() },
}));
vi.mock('@/pages/ResourcePage', () => ({ ResourcePage: ({ children }: { children: unknown }) => children }));
vi.mock('../web/src/pages/CodePage/components/CodeSourcesPanel', () => ({ default: Probe }));
vi.mock('@/lib/asset-common', () => ({ formatShortTime: () => '刚刚' }));
vi.mock('@/lib/codeGraphPolling', async () => await import('../web/src/lib/codeGraphPolling'));
// t 必须是稳定引用：hook 的轮询 effect 依赖里有 t，每次渲染换新函数会导致
// effect 反复重建 → 立即轮询 → 触发渲染 → 死循环。
const stableT = (key: string) => key;
vi.doMock(
  resolve(
    dirname(requireWeb.resolve('react-i18next/package.json')),
    requireWeb('react-i18next/package.json').module,
  ),
  () => ({ useTranslation: () => ({ t: stableT }) }),
);

const { useCodeSources } = await import('../web/src/pages/CodePage/hooks/useCodeSources');
const { CodePage } = await import('../web/src/pages/CodePage/index');

function detail(status: CodeGraphDetail['status']): CodeGraphDetail {
  return {
    code_graph_id: 'cg1',
    team_id: 'team-1',
    repo_name: 'repo',
    repo_url: 'https://example.com/repo.git',
    branch: 'main',
    commit_hash: null,
    service_url: null,
    summary: null,
    status,
    sync_error: status === 'failed' ? 'clone 失败' : null,
    version: '1',
    owner_user_id: 'user-1',
    stats: null,
    last_sync_at: null,
    created_at: '',
    updated_at: '',
  };
}

const apiRef: { current: ReturnType<typeof useCodeSources> } = { current: null! };

function Probe(team: Parameters<typeof useCodeSources>[0]) {
  apiRef.current = useCodeSources(team);
  return null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('useCodeSources 轮询接线', () => {
  let dom: InstanceType<typeof JSDOM>;
  let root: ReturnType<typeof createRoot>;

  async function switchTeam(teamId: string) {
    view.teamId = teamId;
    await act(async () => root.render(createElement(StrictMode, null, createElement(CodePage))));
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    code.create.mockReset();
    code.get.mockReset();
    code.registerMeta.mockReset().mockResolvedValue(undefined);
    code.teamAssets.mockReset().mockResolvedValue([]);
    code.sync.mockReset().mockResolvedValue(undefined);
    code.agentFixed.mockReset().mockResolvedValue([]);

    dom = new JSDOM('<!doctype html><html><body></body></html>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('React', requireWeb('react'));
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    root = createRoot(dom.window.document.createElement('div'));
    await switchTeam('team-1');
    // 等挂载后的 fetchSources 完成
    await act(async () => {
      await Promise.resolve();
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    dom.window.close();
  });

  async function registerGraph() {
    code.create.mockResolvedValueOnce(detail('processing'));
    await act(async () => apiRef.current.setFormRepo('https://example.com/repo.git'));
    await act(async () => apiRef.current.submitCreate());
  }

  it('图失败后不再发起周期性请求', async () => {
    code.get.mockResolvedValue(detail('failed'));

    await registerGraph();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(24000);
    });

    expect(code.get).toHaveBeenCalledTimes(1);
    expect(code.get).toHaveBeenCalledWith('cg1');
    expect(apiRef.current.displaySources[0].status).toBe('failed');
    expect(apiRef.current.displaySources[0].sync_error).toBe('clone 失败');
  });

  it('手动同步后恢复轮询', async () => {
    code.get.mockResolvedValue(detail('failed'));

    await registerGraph();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });
    expect(code.get).toHaveBeenCalledTimes(1);

    await act(async () => {
      await apiRef.current.handleSync('cg1');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(code.sync).toHaveBeenCalledWith('cg1');
    expect(code.get).toHaveBeenCalledTimes(2);
  });

  it('进行中的图继续按 8 秒节奏轮询', async () => {
    code.get.mockResolvedValue(detail('processing'));

    await registerGraph();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16000);
    });

    // 立即一次 + 两个周期
    expect(code.get).toHaveBeenCalledTimes(3);
  });

  it('leaves failed graphs and the open details behind on a team switch', async () => {
    code.get.mockResolvedValue(detail('failed'));
    await registerGraph();
    await act(async () => apiRef.current.openDetail('cg1'));
    expect(apiRef.current.selected?.sync_error).toBe('clone 失败');

    await switchTeam('team-2');
    expect(apiRef.current.subView).toBe('list');
    expect(apiRef.current.displaySources).toEqual([]);
    await switchTeam('team-1');
    expect(apiRef.current.displaySources).toEqual([]);
  });

  it('loads the new team list after the development StrictMode mount replay', async () => {
    const next = { ...detail('ready'), team_id: 'team-2', code_graph_id: 'team-2-graph' };
    code.teamAssets.mockImplementation(async (teamId: string) => teamId === 'team-2' ? [next] : []);
    await switchTeam('team-2');
    expect(apiRef.current.loading).toBe(false);
    expect(apiRef.current.displaySources).toEqual([next]);
  });

  it('stops old polls and discards a ready response even after switching back', async () => {
    const pending = deferred<CodeGraphDetail>();
    code.get.mockReturnValueOnce(pending.promise).mockResolvedValue(detail('processing'));
    await registerGraph();
    expect(code.get).toHaveBeenCalledTimes(1);

    await switchTeam('team-2');
    await switchTeam('team-1');
    await act(async () => pending.resolve(detail('ready')));
    await act(async () => vi.advanceTimersByTimeAsync(16000));
    expect(code.registerMeta).not.toHaveBeenCalled();
    expect(code.get).toHaveBeenCalledTimes(1);
    expect(apiRef.current.displaySources).toEqual([]);
  });

  it('does not refresh or announce a creation completed for the departed team', async () => {
    const pending = deferred<CodeGraphDetail>();
    code.create.mockReturnValueOnce(pending.promise);
    await act(async () => apiRef.current.setFormRepo('https://example.com/repo.git'));
    let submitted!: Promise<void>;
    await act(async () => { submitted = apiRef.current.submitCreate(); });
    expect(code.create).toHaveBeenCalledWith(expect.objectContaining({ teamId: 'team-1' }));

    await switchTeam('team-2');
    code.teamAssets.mockClear();
    await act(async () => { pending.resolve(detail('pending')); await submitted; });
    expect(code.teamAssets).not.toHaveBeenCalled();
    expect(notify.info).not.toHaveBeenCalled();
    expect(apiRef.current.displaySources).toEqual([]);
  });
});
