/**
 * MemoryReviewPage — 记忆变更审阅（session diff + revert）。
 *
 * 类 GitHub PR 的审阅视图：选中 team/agent/session 后列出该 session
 * 的 L1 变更集，每条 change 可 Revert（撤销已生效变更，updated/merged
 * 会连带恢复被 superseded 的旧记录）。
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Card, Checkbox, Input, Select, Tag } from 'tea-component';
import { tea } from '@/lib/tea-bridge';
import {
  memoryReviewApi,
  type MemoryDiffChange,
  type MemoryHistoryEvent,
  type MemoryReviewInboxSession,
} from '@/lib/teamApi';
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
  checked,
  onToggle,
  history,
  historyLoading,
  onToggleHistory,
}: {
  change: MemoryDiffChange;
  onRevert: (recordId: string) => void;
  reverting: boolean;
  checked: boolean;
  onToggle: (recordId: string) => void;
  history?: MemoryHistoryEvent[];
  historyLoading: boolean;
  onToggleHistory: (recordId: string) => void;
}) {
  const { t } = useTranslation();
  const tag = OP_TAG[change.op] ?? OP_TAG.created;
  const canRevert = (change.op === 'created' || change.op === 'updated' || change.op === 'merged') && !change.reverted;
  return (
    <Card style={{ marginBottom: 12 }}>
      <Card.Body>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          {canRevert ? (
            <Checkbox value={checked} onChange={() => onToggle(change.record_id)} />
          ) : null}
          <Tag theme={tag.theme} variant="soft" size="sm">{change.op}</Tag>
          <code style={{ fontSize: 12, color: '#888' }}>{change.record_id}</code>
          <span style={{ fontSize: 12, color: '#888' }}>{change.event_ts}</span>
          {change.memory_type ? <Tag theme="default" variant="soft" size="sm">{change.memory_type}</Tag> : null}
          {change.reverted ? <Tag theme="error" variant="soft" size="sm">{t('memoryReview.revertedBadge', '已撤销')}</Tag> : null}
          {change.reverted_by ? (
            <span style={{ fontSize: 12, color: '#888' }}>
              {t('memoryReview.revertedBy', '由 {{user}} 驳回', { user: change.reverted_by })}
            </span>
          ) : null}
          <div style={{ flex: 1 }} />
          <Button
            type="link"
            disabled={historyLoading}
            onClick={() => onToggleHistory(change.record_id)}
          >
            {history ? t('memoryReview.hideHistory', '收起历史') : t('memoryReview.showHistory', '历史')}
          </Button>
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
        {history ? (
          <div style={{ marginTop: 10, borderTop: '1px dashed #ddd', paddingTop: 8 }}>
            <div style={{ fontSize: 12, color: '#888', marginBottom: 6 }}>
              {t('memoryReview.historyTitle', '记录血统')}
            </div>
            {history.length === 0 ? (
              <div style={{ fontSize: 12, color: '#888' }}>{t('memoryReview.historyEmpty', '无事件记录')}</div>
            ) : (
              history.map((ev, i) => (
                <div key={`${ev.event_ts}-${i}`} style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>
                  <Tag theme={OP_TAG[ev.op]?.theme ?? 'default'} variant="soft" size="sm">{ev.op}</Tag>
                  <span style={{ marginLeft: 6 }}>{ev.event_ts}</span>
                  <span style={{ marginLeft: 6, color: '#888' }}>v{ev.version}</span>
                  {ev.reviewer_id ? (
                    <span style={{ marginLeft: 6, color: '#888' }}>
                      {t('memoryReview.revertedBy', '由 {{user}} 驳回', { user: ev.reviewer_id })}
                    </span>
                  ) : null}
                  {ev.session_id ? (
                    <span style={{ marginLeft: 6, color: '#888' }}>
                      {t('memoryReview.fromSession', '来自会话')} {ev.session_id}
                    </span>
                  ) : null}
                </div>
              ))
            )}
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
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [opFilter, setOpFilter] = useState<string>('');
  const [sinceInput, setSinceInput] = useState<string>('');
  const [untilInput, setUntilInput] = useState<string>('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchReverting, setBatchReverting] = useState(false);
  const [historyMap, setHistoryMap] = useState<Record<string, MemoryHistoryEvent[]>>({});
  const [historyLoadingId, setHistoryLoadingId] = useState<string | null>(null);
  const [inbox, setInbox] = useState<MemoryReviewInboxSession[] | null>(null);
  const [inboxTruncated, setInboxTruncated] = useState(false);
  const [inboxLoading, setInboxLoading] = useState(false);

  const teamOptions = useMemo(() => (teams ?? []).map((tm) => ({ value: tm.team_id, text: tm.name ?? tm.team_id })), [teams]);
  const agentOptions = useMemo(() => (agents ?? []).map((a) => ({ value: a.agent_id, text: a.name ?? a.agent_id })), [agents]);

  const canQuery = !!(teamId && agentId && userId && sessionId.trim());
  const canInbox = !!(teamId && agentId && userId);

  const opOptions = useMemo(() => [
    { value: '', text: t('memoryReview.opAll', '全部类型') },
    { value: 'created', text: 'created' },
    { value: 'updated', text: 'updated' },
    { value: 'merged', text: 'merged' },
    { value: 'reverted', text: 'reverted' },
  ], [t]);

  const fetchDiff = async (offset = 0, sid?: string) => {
    const targetSession = (sid ?? sessionId).trim();
    if (!teamId || !agentId || !userId || !targetSession) return;
    setLoading(true);
    try {
      const data = await memoryReviewApi.diff({
        session_id: targetSession,
        team_id: teamId,
        agent_id: agentId,
        user_id: userId,
        limit: 100,
        offset,
        ...(opFilter ? { op: opFilter } : {}),
        ...(sinceInput.trim() ? { since: sinceInput.trim() } : {}),
        ...(untilInput.trim() ? { until: untilInput.trim() } : {}),
      });
      const page = data.changes ?? [];
      setChanges((prev) => (offset === 0 ? page : [...prev, ...page]));
      setHasMore(data.has_more ?? false);
      setNextOffset(data.next_offset ?? offset + page.length);
      setQueried(true);
      if (offset === 0) {
        setSelected(new Set());
        setHistoryMap({});
      }
    } catch (err) {
      tea.notification.error(t('memoryReview.loadFailed', '加载变更集失败'), err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const fetchInbox = async () => {
    if (!canInbox) return;
    setInboxLoading(true);
    try {
      const data = await memoryReviewApi.inbox({
        team_id: teamId,
        agent_id: agentId,
        user_id: userId,
        ...(sinceInput.trim() ? { since: sinceInput.trim() } : {}),
        ...(untilInput.trim() ? { until: untilInput.trim() } : {}),
        limit: 50,
      });
      setInbox(data.sessions ?? []);
      setInboxTruncated(data.truncated ?? false);
    } catch (err) {
      tea.notification.error(t('memoryReview.inboxFailed', '加载收件箱失败'), err instanceof Error ? err.message : String(err));
    } finally {
      setInboxLoading(false);
    }
  };

  // 三元组齐了且还没填 session 时自动拉一次收件箱。
  useEffect(() => {
    if (canInbox && !sessionId.trim() && inbox === null && !inboxLoading) {
      void fetchInbox();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canInbox]);

  const pickSession = (sid: string) => {
    setSessionId(sid);
    void fetchDiff(0, sid);
  };

  const toggleSelected = (recordId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(recordId)) next.delete(recordId); else next.add(recordId);
      return next;
    });
  };

  const toggleHistory = async (recordId: string) => {
    if (historyMap[recordId]) {
      setHistoryMap((prev) => {
        const next = { ...prev };
        delete next[recordId];
        return next;
      });
      return;
    }
    setHistoryLoadingId(recordId);
    try {
      const data = await memoryReviewApi.history({
        record_id: recordId,
        team_id: teamId,
        agent_id: agentId,
        user_id: userId,
        limit: 50,
      });
      setHistoryMap((prev) => ({ ...prev, [recordId]: data.events ?? [] }));
    } catch (err) {
      tea.notification.error(t('memoryReview.historyFailed', '加载历史失败'), err instanceof Error ? err.message : String(err));
    } finally {
      setHistoryLoadingId(null);
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
      const detail = [
        res.restored.length ? `restored: ${res.restored.join(', ')}` : '',
        res.missing?.length ? `missing snapshot: ${res.missing.join(', ')}` : '',
      ].filter(Boolean).join(' · ');
      tea.notification.success(t('memoryReview.revertOk', '已撤销'), detail || undefined);
      await fetchDiff(0);
    } catch (err) {
      tea.notification.error(t('memoryReview.revertFailed', '撤销失败'), err instanceof Error ? err.message : String(err));
    } finally {
      setRevertingId(null);
    }
  };

  const handleBatchRevert = async () => {
    if (selected.size === 0) return;
    const ok = await tea.confirm({
      message: t('memoryReview.batchRevertConfirm', '确认撤销选中的 {{count}} 条变更？updated/merged 会连带恢复被替代的旧记录。', { count: selected.size }),
    });
    if (!ok) return;
    setBatchReverting(true);
    try {
      const res = await memoryReviewApi.revertBatch({
        record_ids: [...selected],
        team_id: teamId,
        agent_id: agentId,
        user_id: userId,
      });
      const failedItems = (res.results ?? []).filter((r) => !r.reverted);
      if (failedItems.length === 0) {
        tea.notification.success(
          t('memoryReview.batchRevertOk', '已撤销 {{count}} 条', { count: res.succeeded }),
        );
      } else {
        tea.notification.warning(
          t('memoryReview.batchRevertPartial', '成功 {{ok}} 条，失败 {{fail}} 条', { ok: res.succeeded, fail: res.failed }),
          failedItems.map((r) => `${r.record_id}: ${r.error ?? r.status}`).join('\n'),
        );
      }
      await fetchDiff(0);
    } catch (err) {
      tea.notification.error(t('memoryReview.revertFailed', '撤销失败'), err instanceof Error ? err.message : String(err));
    } finally {
      setBatchReverting(false);
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
              <Select
                size="m"
                appearance="button"
                placeholder={t('memoryReview.opAll', '全部类型')}
                options={opOptions}
                value={opFilter}
                onChange={(v) => setOpFilter(v)}
              />
              <Input
                size="m"
                style={{ width: 170 }}
                placeholder={t('memoryReview.since', '起始时间 (ISO)')}
                value={sinceInput}
                onChange={(v) => setSinceInput(v)}
              />
              <Input
                size="m"
                style={{ width: 170 }}
                placeholder={t('memoryReview.until', '截止时间 (ISO)')}
                value={untilInput}
                onChange={(v) => setUntilInput(v)}
              />
              <Button type="primary" loading={loading} disabled={!canQuery} onClick={() => void fetchDiff()}>
                {t('memoryReview.query', '查询变更')}
              </Button>
            </div>
          </Card.Body>
        </Card>

        {!sessionId.trim() ? (
          <Card style={{ marginTop: 16 }}>
            <Card.Body>
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>
                  {t('memoryReview.inboxTitle', '收件箱：近期有变更的会话')}
                </span>
                <div style={{ flex: 1 }} />
                <Button type="link" loading={inboxLoading} disabled={!canInbox} onClick={() => void fetchInbox()}>
                  {t('memoryReview.inboxRefresh', '刷新')}
                </Button>
              </div>
              {inboxTruncated ? (
                <div style={{ fontSize: 12, color: '#a60', marginBottom: 8 }}>
                  {t('memoryReview.inboxTruncated', '事件量达到扫描上限，以下只是部分结果——可用时间窗收窄')}
                </div>
              ) : null}
              {inbox === null ? (
                <div style={{ fontSize: 12, color: '#888' }}>{t('memoryReview.inboxLoading', '加载中…')}</div>
              ) : inbox.length === 0 ? (
                <div style={{ fontSize: 12, color: '#888' }}>{t('memoryReview.inboxEmpty', '近期无记忆变更')}</div>
              ) : (
                inbox.map((s) => (
                  <div
                    key={s.session_id}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
                      border: '1px solid #eee', borderRadius: 4, marginBottom: 6, cursor: 'pointer',
                    }}
                    onClick={() => pickSession(s.session_id)}
                  >
                    <code style={{ fontSize: 12 }}>{s.session_id}</code>
                    <Tag theme="primary" variant="soft" size="sm">
                      {t('memoryReview.inboxChanges', '{{count}} 条变更', { count: s.changes })}
                    </Tag>
                    {Object.entries(s.by_op).map(([op, n]) => (
                      <Tag key={op} theme={OP_TAG[op as MemoryDiffChange['op']]?.theme ?? 'default'} variant="soft" size="sm">
                        {op}×{n}
                      </Tag>
                    ))}
                    {s.has_reverted ? (
                      <Tag theme="error" variant="soft" size="sm">{t('memoryReview.inboxHasReverted', '含已驳回')}</Tag>
                    ) : null}
                    <div style={{ flex: 1 }} />
                    <span style={{ fontSize: 12, color: '#888' }}>{s.last_event_ts}</span>
                  </div>
                ))
              )}
            </Card.Body>
          </Card>
        ) : null}

        <div style={{ marginTop: 16 }}>
          {selected.size > 0 ? (
            <Card style={{ marginBottom: 12 }}>
              <Card.Body>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ fontSize: 13 }}>
                    {t('memoryReview.selectedCount', '已选 {{count}} 条', { count: selected.size })}
                  </span>
                  <div style={{ flex: 1 }} />
                  <Button type="weak" onClick={() => setSelected(new Set())}>
                    {t('memoryReview.clearSelection', '清空')}
                  </Button>
                  <Button type="primary" loading={batchReverting} onClick={() => void handleBatchRevert()}>
                    {t('memoryReview.batchRevert', '批量驳回')}
                  </Button>
                </div>
              </Card.Body>
            </Card>
          ) : null}
          {queried && changes.length === 0 && !loading ? (
            <Card><Card.Body><span style={{ color: '#888' }}>{t('memoryReview.empty', '该 session 暂无记忆变更')}</span></Card.Body></Card>
          ) : null}
          {changes.map((ch) => (
            <ChangeCard
              key={`${ch.record_id}-${ch.event_ts}-${ch.op}`}
              change={ch}
              onRevert={(id) => void handleRevert(id)}
              reverting={revertingId === ch.record_id}
              checked={selected.has(ch.record_id)}
              onToggle={toggleSelected}
              history={historyMap[ch.record_id]}
              historyLoading={historyLoadingId === ch.record_id}
              onToggleHistory={(id) => void toggleHistory(id)}
            />
          ))}
          {hasMore ? (
            <div style={{ textAlign: 'center', padding: '4px 0 12px' }}>
              <Button type="weak" loading={loading} onClick={() => void fetchDiff(nextOffset)}>
                {t('memoryReview.loadMore', '加载更多')}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </ResourcePage>
  );
}

export default MemoryReviewPage;
