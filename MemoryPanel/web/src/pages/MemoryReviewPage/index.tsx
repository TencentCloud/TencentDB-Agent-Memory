/**
 * MemoryReviewPage — 记忆变更审阅（session diff + revert）。
 *
 * 类 GitHub PR 的审阅视图：选中 team/agent/session 后列出该 session
 * 的 L1 变更集，每条 change 可 Revert（撤销已生效变更，updated/merged
 * 会连带恢复被 superseded 的旧记录）。
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Card, Input, Select, Tag } from 'tea-component';
import { tea } from '@/lib/tea-bridge';
import { memoryReviewApi, type MemoryDiffChange } from '@/lib/teamApi';
import { readAuth } from '@/components/LoginGate';
import { useAgents, useTeams } from '@/services';
import { ResourcePage } from '@/pages/ResourcePage';

const OP_TAG: Record<MemoryDiffChange['op'], { theme: 'success' | 'primary' | 'warning' | 'default' | 'error'; }> = {
  created: { theme: 'success' },
  updated: { theme: 'primary' },
  merged: { theme: 'warning' },
  superseded: { theme: 'default' },
  reverted: { theme: 'error' },
};

function ChangeCard({
  change,
  onRevert,
  reverting,
}: {
  change: MemoryDiffChange;
  onRevert: (recordId: string) => void;
  reverting: boolean;
}) {
  const { t } = useTranslation();
  const tag = OP_TAG[change.op] ?? OP_TAG.created;
  const canRevert = (change.op === 'created' || change.op === 'updated' || change.op === 'merged') && !change.reverted;
  return (
    <Card style={{ marginBottom: 12 }}>
      <Card.Body>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <Tag theme={tag.theme} variant="soft" size="sm">{change.op}</Tag>
          <code style={{ fontSize: 12, color: '#888' }}>{change.record_id}</code>
          <span style={{ fontSize: 12, color: '#888' }}>{change.event_ts}</span>
          {change.memory_type ? <Tag theme="default" variant="soft" size="sm">{change.memory_type}</Tag> : null}
          {change.reverted ? <Tag theme="error" variant="soft" size="sm">{t('memoryReview.revertedBadge', '已撤销')}</Tag> : null}
          <div style={{ flex: 1 }} />
          {canRevert ? (
            <Button type="weak" disabled={reverting} onClick={() => onRevert(change.record_id)}>
              {t('memoryReview.revert', '驳回')}
            </Button>
          ) : null}
        </div>
        <div style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{change.content}</div>
        {change.replaced.length > 0 ? (
          <div style={{ marginTop: 10, borderTop: '1px dashed #ddd', paddingTop: 8 }}>
            <div style={{ fontSize: 12, color: '#888', marginBottom: 6 }}>
              {t('memoryReview.replacedTitle', '替代了以下记录')}
            </div>
            {change.replaced.map((r) => (
              <div key={r.record_id} style={{ fontSize: 12, color: '#a33', marginBottom: 6 }}>
                <div>
                  <s>{r.content}</s>
                </div>
                <div style={{ color: '#888' }}>
                  {r.record_id}
                  {r.origin_session_id ? ` · ${t('memoryReview.fromSession', '来自会话')} ${r.origin_session_id}` : ''}
                  {` · v${r.version}`}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </Card.Body>
    </Card>
  );
}

export function MemoryReviewPage() {
  const { t } = useTranslation();
  const auth = readAuth();
  const { activeTeamId, teams } = useTeams();
  const [teamId, setTeamId] = useState<string>(activeTeamId ?? '');
  const { agents } = useAgents(teamId || null);
  const [agentId, setAgentId] = useState<string>('');
  const [userId, setUserId] = useState<string>(auth?.user_id ?? '');
  const [sessionId, setSessionId] = useState<string>('');
  const [changes, setChanges] = useState<MemoryDiffChange[]>([]);
  const [loading, setLoading] = useState(false);
  const [revertingId, setRevertingId] = useState<string | null>(null);
  const [queried, setQueried] = useState(false);

  const teamOptions = useMemo(() => (teams ?? []).map((tm) => ({ value: tm.team_id, text: tm.name ?? tm.team_id })), [teams]);
  const agentOptions = useMemo(() => (agents ?? []).map((a) => ({ value: a.agent_id, text: a.name ?? a.agent_id })), [agents]);

  const canQuery = !!(teamId && agentId && userId && sessionId.trim());

  const fetchDiff = async () => {
    if (!canQuery) return;
    setLoading(true);
    try {
      const data = await memoryReviewApi.diff({
        session_id: sessionId.trim(),
        team_id: teamId,
        agent_id: agentId,
        user_id: userId,
      });
      setChanges(data.changes ?? []);
      setQueried(true);
    } catch (err) {
      tea.notification.error(t('memoryReview.loadFailed', '加载变更集失败'), err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleRevert = async (recordId: string) => {
    const ok = await tea.confirm({
      message: t('memoryReview.revertConfirm', '确认撤销该变更？updated/merged 会连带恢复被替代的旧记录。'),
    });
    if (!ok) return;
    setRevertingId(recordId);
    try {
      const res = await memoryReviewApi.revert({
        record_id: recordId,
        team_id: teamId,
        agent_id: agentId,
        user_id: userId,
      });
      tea.notification.success(t('memoryReview.revertOk', '已撤销'), res.restored.length ? `restored: ${res.restored.join(', ')}` : undefined);
      await fetchDiff();
    } catch (err) {
      tea.notification.error(t('memoryReview.revertFailed', '撤销失败'), err instanceof Error ? err.message : String(err));
    } finally {
      setRevertingId(null);
    }
  };

  return (
    <ResourcePage>
      <div style={{ padding: '16px 20px', maxWidth: 960 }}>
        <h3 style={{ marginBottom: 4 }}>{t('memoryReview.title', '记忆变更审阅')}</h3>
        <p style={{ color: '#888', fontSize: 12, marginBottom: 16 }}>
          {t('memoryReview.subtitle', '查看某个 session 产生的 L1 记忆变更（新增 / 覆盖 / 合并），可撤销已生效的变更。')}
        </p>
        <Card>
          <Card.Body>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <Select
                size="m"
                appearance="button"
                placeholder={t('memoryReview.team', '团队')}
                options={teamOptions}
                value={teamId}
                onChange={(v) => { setTeamId(v); setAgentId(''); }}
              />
              <Select
                size="m"
                appearance="button"
                placeholder={t('memoryReview.agent', 'Agent')}
                options={agentOptions}
                value={agentId}
                onChange={(v) => setAgentId(v)}
              />
              <Input
                size="m"
                style={{ width: 180 }}
                placeholder={t('memoryReview.userId', 'User ID')}
                value={userId}
                onChange={(v) => setUserId(v)}
              />
              <Input
                size="m"
                style={{ width: 240 }}
                placeholder={t('memoryReview.sessionId', 'Session ID')}
                value={sessionId}
                onChange={(v) => setSessionId(v)}
              />
              <Button type="primary" loading={loading} disabled={!canQuery} onClick={() => void fetchDiff()}>
                {t('memoryReview.query', '查询变更')}
              </Button>
            </div>
          </Card.Body>
        </Card>

        <div style={{ marginTop: 16 }}>
          {queried && changes.length === 0 && !loading ? (
            <Card><Card.Body><span style={{ color: '#888' }}>{t('memoryReview.empty', '该 session 暂无记忆变更')}</span></Card.Body></Card>
          ) : null}
          {changes.map((ch) => (
            <ChangeCard key={`${ch.record_id}-${ch.event_ts}-${ch.op}`} change={ch} onRevert={(id) => void handleRevert(id)} reverting={revertingId === ch.record_id} />
          ))}
        </div>
      </div>
    </ResourcePage>
  );
}

export default MemoryReviewPage;
