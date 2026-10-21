import { useRef, useState } from 'react';
import { Button, Input, Text } from 'tea-component';
import { useTranslation } from 'react-i18next';
import { teamsApi } from '@/lib/teamApi';
import { invalidateBackendCache } from '@/services';
import { useBackendStore } from '@/stores/backend';
import { getErrorMessage } from '@/lib/error-message';

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

  async function submit() {
    if (inFlight.current || !name.trim()) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      let teamId = createdId;
      if (!teamId) {
        if (uncertain) {
          await useBackendStore.getState().refreshTeams({ preserveActiveTeam: true });
          setError(t('teamSwitcher.createUnconfirmed'));
          return;
        } else {
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
            setError(t('teamSwitcher.createUnconfirmed'));
            return;
          }
        }
        setCreatedId(teamId);
        setUncertain(false);
      }

      await useBackendStore.getState().refreshTeams({ preserveActiveTeam: true });
      if (!useBackendStore.getState().teams.some((team) => team.team_id === teamId)) {
        setError(t('teamSwitcher.refreshFailed'));
        return;
      }
      useBackendStore.getState().setActiveTeamId(teamId);
      invalidateBackendCache();
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
