/**
 * SubscriptionPoolPage — System Admin page for the subscription account pool (route /team/subscription-pool).
 *
 * Claude Code and Codex each have a pool tab. The page only calls Core's public pool actions.
 * Core keeps the login tokens and never returns them.
 */
import { Component, useCallback, useState, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Card, StatusTip } from 'tea-component';
import { useAuthStore } from '@/stores/auth';
import { isGlobalAdmin } from '@/services';
import { tea } from '@/lib/tea-bridge';
import { subscriptionPoolApi, type PoolProvider, type SubscriptionAccount } from '@/lib/api/subscription-pool';
import { accountState } from '@/lib/subscription-pool-display';
import { usePoolStatus } from './use-pool-status';
import { poolErrorCode, poolErrorMessage } from './pool-errors';
import { PoolHeader } from './components/PoolHeader';
import { PoolSummary } from './components/PoolSummary';
import { PoolSettings } from './components/PoolSettings';
import { AccountTable } from './components/AccountTable';
import { AddAccountDialog } from './components/AddAccountDialog';
import { PoolSwitchConfirmDialog } from './components/PoolSwitchConfirmDialog';
import { DeleteAccountDialog } from './components/DeleteAccountDialog';
import './style.css';

/** Pool errors that mean the shown data is stale. */
const STALE_CODES = new Set(['account_not_found', 'version_mismatch']);

export function SubscriptionPoolPage() {
  const { auth } = useAuthStore();
  // Only a System Admin may open the page. The team role is not used: a member without an
  // active team has no team role, and the page must still send that member away.
  if (!auth) return null;
  if (!isGlobalAdmin(auth.user, auth.isAdmin)) return <Navigate to="/" replace />;
  return (
    <SubscriptionPoolBoundary>
      <SubscriptionPoolContent />
    </SubscriptionPoolBoundary>
  );
}

/** Keeps a DOM conflict on this page from replacing the whole app with the router error screen. */
class SubscriptionPoolBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="_memory-pool-body">
          <Alert type="error">
            The account was saved. Reload the page to show it.
          </Alert>
          <Button type="primary" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}

function SubscriptionPoolContent() {
  const { t } = useTranslation();
  const { auth } = useAuthStore();
  const [provider, setProvider] = useState<PoolProvider>('codex');
  const { provider: pool, thresholdPct, loading, error, refresh } = usePoolStatus(provider);

  const [switchTarget, setSwitchTarget] = useState<boolean | null>(null);
  const [switching, setSwitching] = useState(false);
  const [savingThreshold, setSavingThreshold] = useState(false);
  const [checkingAll, setCheckingAll] = useState(false);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [adding, setAdding] = useState<{ reloginName?: string } | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<SubscriptionAccount | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);

  const now = Date.now();
  const accounts = pool?.accounts ?? [];
  const poolEnabled = pool ? pool.enabled : null;

  /** Shows a pool error; refreshes the list when the error means the shown data is stale. */
  const reportError = useCallback(
    (e: unknown) => {
      const message = poolErrorMessage(e);
      if (message) tea.notify.error(message);
      else tea.notify.error(e);
      const code = poolErrorCode(e);
      if (code && STALE_CODES.has(code)) void refresh();
    },
    [refresh],
  );

  const withBusy = useCallback(async (accountId: string, run: () => Promise<void>) => {
    setBusyIds((prev) => new Set(prev).add(accountId));
    try {
      await run();
    } catch (e) {
      reportError(e);
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(accountId);
        return next;
      });
    }
  }, [reportError]);

  async function confirmSwitch() {
    if (switchTarget === null) return;
    setSwitching(true);
    try {
      if (switchTarget) await subscriptionPoolApi.enable(provider);
      else await subscriptionPoolApi.disable(provider);
      tea.notify.success(t(switchTarget ? 'subscriptionPool.toast.poolOn' : 'subscriptionPool.toast.poolOff'));
      setSwitchTarget(null);
      await refresh();
    } catch (e) {
      reportError(e);
    } finally {
      setSwitching(false);
    }
  }

  async function saveThreshold(value: number) {
    setSavingThreshold(true);
    try {
      await subscriptionPoolApi.updateThreshold(value);
      tea.notify.success(t('subscriptionPool.toast.thresholdSaved'));
      await refresh();
    } catch (e) {
      reportError(e);
    } finally {
      setSavingThreshold(false);
    }
  }

  async function checkAll() {
    setCheckingAll(true);
    try {
      const result = await subscriptionPoolApi.checkAll();
      tea.notify.success(t('subscriptionPool.toast.checkedAll', result));
      await refresh();
    } catch (e) {
      reportError(e);
    } finally {
      setCheckingAll(false);
    }
  }

  const checkAccount = (account: SubscriptionAccount) =>
    withBusy(account.account_id, async () => {
      await subscriptionPoolApi.checkUsage(account.account_id);
      tea.notify.success(t('subscriptionPool.toast.checked', { name: account.display_name }));
      await refresh();
    });

  const toggleEnabled = (account: SubscriptionAccount) =>
    withBusy(account.account_id, async () => {
      const enable = !account.enabled;
      await subscriptionPoolApi.updateAccount({
        account_id: account.account_id,
        enabled: enable,
        expected_version: account.version,
        // A stored "disabled" status would keep the account out of service after the switch is on again.
        ...(enable && account.status === 'disabled' ? { status: 'active' as const } : {}),
      });
      tea.notify.success(t(enable ? 'subscriptionPool.toast.enabled' : 'subscriptionPool.toast.disabled', { name: account.display_name }));
      await refresh();
    });

  async function confirmDelete() {
    if (!deleting) return;
    setDeletingBusy(true);
    try {
      await subscriptionPoolApi.deleteAccount(deleting.account_id);
      tea.notify.success(t('subscriptionPool.toast.deleted'));
      setDeleting(null);
      await refresh();
    } catch (e) {
      reportError(e);
      setDeleting(null);
    } finally {
      setDeletingBusy(false);
    }
  }

  const lastUpdate = accounts.reduce<number | null>(
    (best, a) => (a.usage_updated_at !== null && (best === null || a.usage_updated_at > best) ? a.usage_updated_at : best),
    null,
  );
  const availableCount = pool?.summary.available ?? 0;
  const disabledCount = accounts.filter(
    (a) => accountState(a, { now, threshold: thresholdPct, poolEnabled: poolEnabled === true }) === 'disabled',
  ).length;

  return (
    <div className="_memory-pool-body">
      {savedNotice && (
        <Alert type="success" onClose={() => setSavedNotice(null)}>
          {savedNotice}
        </Alert>
      )}
      <PoolHeader
        provider={provider}
        onProviderChange={setProvider}
        poolEnabled={poolEnabled}
        switchDisabled={switching}
        onToggle={setSwitchTarget}
        instanceName={auth?.instance_name || auth?.instance_id || ''}
      />

      {error && !pool ? (
        <Card>
          <Card.Body>
            <StatusTip
              status="error"
              emptyText={t('subscriptionPool.loadFailed')}
              onRetry={() => void refresh()}
              retryText={t('subscriptionPool.retry')}
            />
          </Card.Body>
        </Card>
      ) : (
        <>
          {pool && !pool.enabled && (
            <Alert type="info">
              {t('subscriptionPool.offNotice', { agent: t(`subscriptionPool.agent.${provider}`) })}
            </Alert>
          )}
          <Alert type="warning">{t(`subscriptionPool.fallbackWarn.${provider}`)}</Alert>

          {pool && <PoolSummary status={pool} thresholdPct={thresholdPct} now={now} />}

          <PoolSettings
            thresholdPct={thresholdPct}
            lastUpdate={lastUpdate}
            saving={savingThreshold}
            checking={checkingAll}
            onSave={(v) => void saveThreshold(v)}
            onCheckAll={() => void checkAll()}
          />

          <Card>
            <Card.Body
              title={t('subscriptionPool.accounts.title')}
              subtitle={t('subscriptionPool.accounts.tokensHidden')}
              operation={
                <Button
                  type="primary"
                  onClick={() => setAdding({})}
                >
                  {t('subscriptionPool.accounts.add')}
                </Button>
              }
            >
              <AccountTable
                accounts={accounts}
                poolEnabled={poolEnabled === true}
                thresholdPct={thresholdPct}
                now={now}
                loading={loading}
                busyIds={busyIds}
                onCheck={(a) => void checkAccount(a)}
                onToggleEnabled={(a) => void toggleEnabled(a)}
                onDelete={setDeleting}
                onRelogin={(a) => setAdding({ reloginName: a.display_name })}
                emptyText={t(`subscriptionPool.accounts.empty.${provider}`)}
              />
              {accounts.length > 0 && (
                <div className="_memory-pool-footnote">
                  {t('subscriptionPool.summary.availableHint')}{' '}
                  {t('subscriptionPool.accounts.summary', { total: accounts.length, disabled: disabledCount })}
                </div>
              )}
            </Card.Body>
          </Card>
        </>
      )}

      {switchTarget !== null && (
        <PoolSwitchConfirmDialog
          provider={provider}
          turnOn={switchTarget}
          accountCount={accounts.length}
          availableCount={availableCount}
          activeSessions={pool?.summary.active_sessions ?? 0}
          busy={switching}
          onConfirm={() => void confirmSwitch()}
          onClose={() => setSwitchTarget(null)}
        />
      )}
      {adding && (
        <AddAccountDialog
          provider={provider}
          reloginName={adding.reloginName}
          onClose={() => setAdding(null)}
          onDone={({ name, created }) => {
            setAdding(null);
            setSavedNotice(t(created ? 'subscriptionPool.toast.added' : 'subscriptionPool.toast.reloggedIn', { name }));
            void refresh();
          }}
        />
      )}
      {deleting && (
        <DeleteAccountDialog
          accountName={deleting.display_name}
          busy={deletingBusy}
          onConfirm={() => void confirmDelete()}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
