import { useRef, useState } from 'react';
import { Button, Input, Text } from 'tea-component';
import { useTranslation } from 'react-i18next';
import { teamsApi } from '@/lib/teamApi';
import { invalidateBackendCache } from '@/services';
import { useBackendStore } from '@/stores/backend';
import { getErrorMessage } from '@/lib/error-message';
import { getPanelSession } from '@/lib/panelSession';

/** Create only a self-owned Team. A confirmed create is never repeated during a refresh retry. */
export function CreateOwnTeamForm({ onCancel, onCreated }: {
  onCancel: () => void;
  onCreated: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const beforeIds = useRef<Set<string> | null>(null);

  async function findNewTeam() {
    const ownerId = getPanelSession()?.user?.user_id;
    const matches = (await teamsApi.list()).filter((team) =>
      team.name === name.trim() && team.owner_user_id === ownerId &&
      !beforeIds.current?.has(team.team_id));
    return matches.length === 1 ? matches[0].team_id : null;
  }

  async function submit() {
    if (inFlight.current || !name.trim()) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      let teamId = createdId;
      if (!teamId) {
        if (uncertain) {
          teamId = await findNewTeam();
          if (!teamId) {
            setError(t('teamSwitcher.createUnconfirmed'));
            return;
          }
        } else {
          beforeIds.current = new Set((await teamsApi.list()).map((team) => team.team_id));
          try {
            const created = await teamsApi.create({ name: name.trim(), description: description.trim() });
            teamId = created.team_id;
          } catch (failure) {
            const { status } = (failure ?? {}) as { status?: number };
            if (status && status < 500) {
              setError(getErrorMessage(failure));
              return;
            }
            setUncertain(true);
            try { teamId = await findNewTeam(); } catch { /* Keep the outcome uncertain. */ }
            if (!teamId) {
              setError(t('teamSwitcher.createUnconfirmed'));
              return;
            }
          }
        }
        setCreatedId(teamId);
        setUncertain(false);
      }

      invalidateBackendCache();
      await useBackendStore.getState().refreshTeams();
      if (!useBackendStore.getState().teams.some((team) => team.team_id === teamId)) {
        setError(t('teamSwitcher.refreshFailed'));
        return;
      }
      useBackendStore.getState().setActiveTeamId(teamId);
      onCreated();
    } catch (failure) {
      setError(getErrorMessage(failure));
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  }

  return (
    <div className="_memory-team-switcher-create-form">
      <Input autoFocus size="full" value={name} disabled={busy || Boolean(createdId || uncertain)}
        onChange={setName} placeholder={t('teamSwitcher.teamNamePlaceholder')} />
      <Input size="full" value={description} disabled={busy || Boolean(createdId || uncertain)}
        onChange={setDescription} placeholder={t('teamSwitcher.teamDescPlaceholder')} />
      {error && <Text theme="danger" parent="div">{error}</Text>}
      <div className="_memory-team-switcher-create-actions">
        <Button onClick={onCancel} disabled={busy}>{t('teamSwitcher.cancel')}</Button>
        <Button type="primary" loading={busy} disabled={!name.trim() || busy}
          onClick={() => void submit()}>
          {createdId ? t('teamSwitcher.retryRefresh') : uncertain
            ? t('teamSwitcher.checkCreate') : t('teamSwitcher.create')}
        </Button>
      </div>
    </div>
  );
}
