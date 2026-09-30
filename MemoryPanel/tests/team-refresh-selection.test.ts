import { beforeEach, describe, expect, it, vi } from 'vitest';

const { list, members, notify } = vi.hoisted(() => ({
  list: vi.fn(), members: vi.fn(), notify: vi.fn(),
}));
vi.mock('@/lib/teamApi', () => ({ teamsApi: { list }, membersApi: { list: members }, agentsApi: {}, tasksApi: {} }));
vi.mock('@/lib/tea-bridge', () => ({ tea: { notify: { error: notify } } }));
vi.mock('@/i18n', () => ({ default: { t: (value: string) => value } }));
vi.mock('@/services/user-profile-store', () => ({ seedDisplayNameCache: vi.fn() }));

const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
});
vi.stubGlobal('window', { dispatchEvent: vi.fn() });
const { useBackendStore } = await import('../web/src/stores/backend');
const selectionKey = 'tdai-memory.activeTeam.v1';

describe('Team discovery during create recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storage.clear();
    useBackendStore.getState().clearAll();
    list.mockResolvedValue([
      { team_id: 'other-window', name: 'same-name', owner_user_id: 'user', created_at: 1 },
      { team_id: 'this-window', name: 'same-name', owner_user_id: 'user', created_at: 2 },
    ]);
    members.mockResolvedValue([]);
  });

  it('updates the list without claiming a Team when create response is lost', async () => {
    // Another page may have written its selection into shared localStorage.
    storage.set(selectionKey, 'other-window');
    await useBackendStore.getState().refreshTeams({ preserveActiveTeam: true });
    expect(useBackendStore.getState().teams.map((team) => team.team_id)).toEqual(['other-window', 'this-window']);
    expect(useBackendStore.getState().activeTeamId).toBeNull();
    expect(storage.get(selectionKey)).toBe('other-window');
  });

  it('preserves an existing selection while refreshing for recovery', async () => {
    useBackendStore.getState().setActiveTeamId('this-window');
    await useBackendStore.getState().refreshTeams({ preserveActiveTeam: true });
    expect(useBackendStore.getState().activeTeamId).toBe('this-window');
  });

  it('keeps normal initial-load selection behavior', async () => {
    await useBackendStore.getState().refreshTeams();
    expect(useBackendStore.getState().activeTeamId).toBe('other-window');
  });

  it('preserves selection when recovery joins a pending normal list request', async () => {
    let complete!: (teams: unknown[]) => void;
    list.mockReturnValueOnce(new Promise((resolve) => { complete = resolve; }));
    const normalRefresh = useBackendStore.getState().refreshTeams();
    const recoveryRefresh = useBackendStore.getState().refreshTeams({ preserveActiveTeam: true });
    complete([{ team_id: 'other-window', name: 'same-name', owner_user_id: 'user', created_at: 1 }]);
    await Promise.all([normalRefresh, recoveryRefresh]);
    expect(useBackendStore.getState().activeTeamId).toBeNull();
    expect(list).toHaveBeenCalledTimes(1);
  });
});
