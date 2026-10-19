/**
 * AccountTable — one row per subscription account with status, two quota meters
 * (threshold mark and reset time in local time), extra rows for per-model windows,
 * sessions, last update and actions.
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, StatusTip, Table, Tag, Text, Bubble } from 'tea-component';
import i18n from '@/i18n';
import type { SubscriptionAccount } from '@/lib/api/subscription-pool';
import {
  accountState,
  describeWindow,
  formatClock,
  formatResetAt,
  groupWindows,
  latestObservation,
  thresholdMark,
  usageCheckFailing,
  type AccountState,
  type PoolWindow,
} from '@/lib/subscription-pool-display';

interface Props {
  accounts: SubscriptionAccount[];
  poolEnabled: boolean;
  thresholdPct: number;
  now: number;
  loading: boolean;
  /** Account ids with a running action (check, enable/disable). */
  busyIds: ReadonlySet<string>;
  onCheck: (account: SubscriptionAccount) => void;
  onToggleEnabled: (account: SubscriptionAccount) => void;
  onDelete: (account: SubscriptionAccount) => void;
  onRelogin: (account: SubscriptionAccount) => void;
  emptyText: React.ReactNode;
}

type Row =
  | { kind: 'account'; key: string; account: SubscriptionAccount }
  | { kind: 'extra'; key: string; account: SubscriptionAccount; window: PoolWindow };

const STATE_TAG: Record<AccountState, { theme: 'default' | 'primary' | 'success' | 'warning' | 'error'; mark: string }> = {
  active: { theme: 'success', mark: '●' },
  ready_pool_off: { theme: 'primary', mark: '●' },
  near_limit: { theme: 'warning', mark: '▲' },
  exhausted: { theme: 'error', mark: '■' },
  auth_error: { theme: 'error', mark: '✕' },
  disabled: { theme: 'default', mark: '○' },
};

function Meter({
  window,
  now,
  thresholdPct,
  showMark,
  label,
}: {
  window: PoolWindow | null;
  now: number;
  thresholdPct: number;
  showMark: boolean;
  label?: string;
}) {
  const { t } = useTranslation();
  if (!window) {
    return (
      <div className="_memory-pool-meter">
        <div className="_memory-pool-meter-label">—</div>
        <div className="_memory-pool-bar" />
        <Text theme="weak" className="_memory-pool-small">{t('subscriptionPool.window.noData')}</Text>
      </div>
    );
  }
  const view = describeWindow(window, now, thresholdPct, { locale: i18n.language });
  let note: string;
  if (view.reset) note = t('subscriptionPool.window.hasReset');
  else if (view.resetAt && view.remaining) note = t('subscriptionPool.window.resetsIn', { at: view.resetAt, remaining: view.remaining });
  else note = '';
  return (
    <div className="_memory-pool-meter">
      <div className="_memory-pool-meter-label">
        {label && <span className="_memory-pool-meter-name">{label} </span>}
        {Math.round(view.pct)}%
      </div>
      <div className="_memory-pool-bar">
        <i className={`_memory-pool-fill _memory-pool-fill--${view.level}`} style={{ width: `${view.pct}%` }} />
        {showMark && (
          <span
            className="_memory-pool-mark"
            style={{ left: `${thresholdMark(thresholdPct)}%` }}
            title={t('subscriptionPool.window.thresholdTip', { pct: thresholdPct })}
          />
        )}
      </div>
      {note && <Text theme="weak" className="_memory-pool-small">{note}</Text>}
    </div>
  );
}

function windowLabel(window: PoolWindow, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const key = `subscriptionPool.window.name.${window.name}`;
  const name = i18n.exists(key) ? t(key) : window.name;
  return window.model_scope ? t('subscriptionPool.window.model', { name, scope: window.model_scope }) : name;
}

function sourceLabel(source: string, t: (key: string) => string): string {
  if (source === 'usage_api') return t('subscriptionPool.source.usage_api');
  if (source === '429') return t('subscriptionPool.source.429');
  return t('subscriptionPool.source.proxy');
}

export function AccountTable({
  accounts,
  poolEnabled,
  thresholdPct,
  now,
  loading,
  busyIds,
  onCheck,
  onToggleEnabled,
  onDelete,
  onRelogin,
  emptyText,
}: Props) {
  const { t } = useTranslation();

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const account of accounts) {
      out.push({ kind: 'account', key: account.account_id, account });
      for (const window of groupWindows(account.usage.windows).extra) {
        out.push({ kind: 'extra', key: `${account.account_id}:${window.name}:${window.model_scope ?? ''}`, account, window });
      }
    }
    return out;
  }, [accounts]);

  const stateOf = (account: SubscriptionAccount) =>
    accountState(account, { now, threshold: thresholdPct, poolEnabled });

  // Empty and loading stay outside the table. Tea Table's autotip row is a SlideTransition
  // inside <tbody>. Turning that row off in the same commit that inserts the first account
  // makes the browser throw NotFoundError (insertBefore) and the route error boundary
  // replaces the page. That happens right after the first OAuth account is saved.
  if (rows.length === 0) {
    return (
      <StatusTip
        status={loading ? 'loading' : 'empty'}
        emptyText={emptyText}
      />
    );
  }

  return (
    <Table
      verticalTop
      records={rows}
      recordKey="key"
      columns={[
        {
          key: 'account',
          header: t('subscriptionPool.col.account'),
          render: (row) =>
            row.kind === 'extra' ? (
              <Text theme="weak" className="_memory-pool-extra-name">↳ {windowLabel(row.window, t)}</Text>
            ) : (
              <div className="_memory-pool-account">
                <b>{row.account.display_name}</b>
                <Text theme="weak" parent="div" className="_memory-pool-small">{row.account.account_label}</Text>
              </div>
            ),
        },
        {
          key: 'status',
          header: t('subscriptionPool.col.status'),
          render: (row) => {
            if (row.kind === 'extra') return null;
            const { account } = row;
            const state = stateOf(account);
            const tag = STATE_TAG[state];
            let note: string | null = null;
            if (state === 'near_limit') note = t('subscriptionPool.status.near_limit.note');
            else if (state === 'exhausted') {
              note = account.exhausted_until && account.exhausted_until > now
                ? t('subscriptionPool.status.exhausted.note', {
                    time: formatResetAt(account.exhausted_until, now, { locale: i18n.language }),
                  })
                : t('subscriptionPool.status.exhausted.noteNoTime');
            } else if (state === 'auth_error') note = account.last_error;
            return (
              <div>
                <Tag theme={tag.theme}>{tag.mark} {t(`subscriptionPool.status.${state}`)}</Tag>
                {note && <Text theme="weak" parent="div" className="_memory-pool-small">{note}</Text>}
                {usageCheckFailing(account) && (
                  <Bubble content={t('subscriptionPool.usageFailing.tip', { count: account.usage_fail_count })}>
                    <Text theme="warning" parent="div" className="_memory-pool-small">⚠ {t('subscriptionPool.usageFailing')}</Text>
                  </Bubble>
                )}
              </div>
            );
          },
        },
        {
          key: 'primary',
          header: t('subscriptionPool.col.primary'),
          width: 220,
          render: (row) => {
            if (row.kind === 'extra') {
              return <Meter window={row.window} now={now} thresholdPct={thresholdPct} showMark={false} />;
            }
            const state = stateOf(row.account);
            return (
              <Meter
                window={groupWindows(row.account.usage.windows).primary}
                now={now}
                thresholdPct={thresholdPct}
                showMark={state !== 'disabled' && state !== 'auth_error'}
              />
            );
          },
        },
        {
          key: 'secondary',
          header: t('subscriptionPool.col.secondary'),
          width: 220,
          render: (row) => {
            if (row.kind === 'extra') return null;
            const state = stateOf(row.account);
            return (
              <Meter
                window={groupWindows(row.account.usage.windows).secondary}
                now={now}
                thresholdPct={thresholdPct}
                showMark={state !== 'disabled' && state !== 'auth_error'}
              />
            );
          },
        },
        {
          key: 'sessions',
          header: t('subscriptionPool.col.sessions'),
          width: 120,
          render: (row) => (row.kind === 'extra' ? null : <Text>{row.account.active_sessions || '—'}</Text>),
        },
        {
          key: 'updated',
          header: t('subscriptionPool.col.updated'),
          width: 150,
          render: (row) => {
            if (row.kind === 'extra') return null;
            const seen = latestObservation(row.account.usage.windows);
            if (!seen) return <Text theme="weak">{t('subscriptionPool.updated.none')}</Text>;
            return (
              <Text theme="weak" className="_memory-pool-small">
                {sourceLabel(seen.source, t)} · {formatClock(seen.observedAt, { locale: i18n.language })}
              </Text>
            );
          },
        },
        {
          key: 'actions',
          header: t('subscriptionPool.col.actions'),
          width: 260,
          render: (row) => {
            if (row.kind === 'extra') return null;
            const { account } = row;
            const busy = busyIds.has(account.account_id);
            const state = stateOf(account);
            return (
              <div className="_memory-pool-actions">
                {state === 'auth_error' ? (
                  <Button type="primary" disabled={busy} onClick={() => onRelogin(account)}>
                    {t('subscriptionPool.action.relogin')}
                  </Button>
                ) : (
                  <>
                    <Button type="link" disabled={busy} onClick={() => onCheck(account)}>
                      {t('subscriptionPool.action.checkNow')}
                    </Button>
                    <Button type="link" disabled={busy} onClick={() => onToggleEnabled(account)}>
                      {account.enabled ? t('subscriptionPool.action.disable') : t('subscriptionPool.action.enable')}
                    </Button>
                  </>
                )}
                <Button type="error" disabled={busy} onClick={() => onDelete(account)}>
                  {t('subscriptionPool.action.delete')}
                </Button>
              </div>
            );
          },
        },
      ]}
    />
  );
}
