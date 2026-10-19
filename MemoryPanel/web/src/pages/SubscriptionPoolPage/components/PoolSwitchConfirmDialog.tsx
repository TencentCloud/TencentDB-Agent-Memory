/**
 * PoolSwitchConfirmDialog — confirms turning the pool on or off before the agent moves groups.
 */
import { useTranslation } from 'react-i18next';
import { Alert, Button, Modal } from 'tea-component';
import type { PoolProvider } from '@/lib/api/subscription-pool';

interface Props {
  provider: PoolProvider;
  /** Target state of the switch. */
  turnOn: boolean;
  accountCount: number;
  availableCount: number;
  activeSessions: number;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export function PoolSwitchConfirmDialog({ provider, turnOn, accountCount, availableCount, activeSessions, busy, onConfirm, onClose }: Props) {
  const { t } = useTranslation();
  const agent = t(`subscriptionPool.agent.${provider}`);
  return (
    <Modal
      visible
      size="m"
      caption={turnOn ? t('subscriptionPool.enable.title', { agent }) : t('subscriptionPool.disable.title', { agent })}
      onClose={onClose}
      disableEscape={busy}
    >
      <Modal.Body>
        {turnOn ? (
          <>
            <ul className="_memory-pool-list">
              <li>{t('subscriptionPool.enable.b1', { agent })}</li>
              <li>{t('subscriptionPool.enable.b2', { agent })}</li>
              <li>{t('subscriptionPool.enable.b3')}</li>
            </ul>
            <Alert type="info">
              {accountCount > 0
                ? t('subscriptionPool.enable.ready', { count: availableCount })
                : t('subscriptionPool.enable.noAccounts')}
            </Alert>
          </>
        ) : (
          <>
            <p>{t('subscriptionPool.disable.desc', { agent })}</p>
            <ul className="_memory-pool-list">
              <li>{t('subscriptionPool.disable.b1', { count: activeSessions })}</li>
              <li>{t('subscriptionPool.disable.b2')}</li>
            </ul>
          </>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button type={turnOn ? 'primary' : 'error'} loading={busy} disabled={busy} onClick={onConfirm}>
          {turnOn ? t('subscriptionPool.enable.ok') : t('subscriptionPool.disable.ok')}
        </Button>
        <Button disabled={busy} onClick={onClose}>
          {t('subscriptionPool.dialog.cancel')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
