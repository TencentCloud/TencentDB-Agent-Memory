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
const { createElement, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const { JSDOM } = requireWeb('jsdom');

const { code } = vi.hoisted(() => ({
  code: {
    get: vi.fn(),
    registerMeta: vi.fn(),
    teamAssets: vi.fn(),
    sync: vi.fn(),
    agentFixed: vi.fn(),
  },
}));

vi.mock('@/lib/api/knowledge-api', () => ({
  knowledgeApi: { code, source: { providers: vi.fn(async () => []) } },
}));
vi.mock('@/services', () => ({
  useTeams: () => ({ activeTeamId: 'team-1', activeTeam: { team_id: 'team-1' } }),
  useAgents: () => ({ agents: [] }),
}));
vi.mock('@/components/LoginGate', () => ({ readAuth: () => ({ user_id: 'user-1' }) }));
vi.mock('@/lib/tea-bridge', () => ({
  tea: { notify: { success: vi.fn(), error: vi.fn(), info: vi.fn() }, confirm: vi.fn() },
}));
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

function Probe(props: { apiRef: { current: any } }) {
  props.apiRef.current = useCodeSources();
  return null;
}

describe('useCodeSources 轮询接线', () => {
  let dom: InstanceType<typeof JSDOM>;
  let root: ReturnType<typeof createRoot>;
  const apiRef: { current: any } = { current: null };

  beforeEach(async () => {
    vi.useFakeTimers();
    code.get.mockReset();
    code.registerMeta.mockReset().mockResolvedValue(undefined);
    code.teamAssets.mockReset().mockResolvedValue([]);
    code.sync.mockReset().mockResolvedValue(undefined);
    code.agentFixed.mockReset().mockResolvedValue([]);

    dom = new JSDOM('<!doctype html><html><body></body></html>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    root = createRoot(dom.window.document.createElement('div'));
    await act(async () => {
      root.render(createElement(Probe, { apiRef }));
    });
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

  it('图失败后不再发起周期性请求', async () => {
    code.get.mockResolvedValue(detail('failed'));

    await act(async () => {
      apiRef.current.setInFlight([detail('processing')]);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(24000);
    });

    expect(code.get).toHaveBeenCalledTimes(1);
    expect(code.get).toHaveBeenCalledWith('cg1');
    expect(apiRef.current.inFlight[0].status).toBe('failed');
    expect(apiRef.current.inFlight[0].sync_error).toBe('clone 失败');
  });

  it('手动同步后恢复轮询', async () => {
    code.get.mockResolvedValue(detail('failed'));

    await act(async () => {
      apiRef.current.setInFlight([detail('processing')]);
    });
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

    await act(async () => {
      apiRef.current.setInFlight([detail('processing')]);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16000);
    });

    // 立即一次 + 两个周期
    expect(code.get).toHaveBeenCalledTimes(3);
  });
});
