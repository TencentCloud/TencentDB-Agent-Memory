/**
 * PoolHeader — page title, provider tabs and the pool switch.
 * The switch only asks for a change; the page confirms it in a dialog before anything is sent.
 */
import { useTranslation } from 'react-i18next';
import { Card, Switch, Tabs, Tag, Text, H3 } from 'tea-component';
import type { PoolProvider } from '@/lib/api/subscription-pool';

interface Props {
  provider: PoolProvider;
  onProviderChange: (provider: PoolProvider) => void;
  /** Pool state of the working provider. Null while loading. */
  poolEnabled: boolean | null;
  switchDisabled: boolean;
  onToggle: (next: boolean) => void;
  instanceName: string;
}

export function PoolHeader({ provider, onProviderChange, poolEnabled, switchDisabled, onToggle, instanceName }: Props) {
  const { t } = useTranslation();
  const agent = t(`subscriptionPool.agent.${provider}`);
  return (
    <Card>
      <Card.Body>
        <div className="_memory-pool-header">
          <H3>{t('subscriptionPool.title')}</H3>
          <Tabs
            tabs={[
              { id: 'claude', label: t('subscriptionPool.tab.claude') },
              { id: 'codex', label: t('subscriptionPool.tab.codex') },
            ]}
            activeId={provider}
            onActive={(tab) => onProviderChange(tab.id as PoolProvider)}
          />
          <div className="_memory-pool-switch">
              <Text theme="label">{t('subscriptionPool.pool')}</Text>
              <Switch
                value={poolEnabled === true}
                disabled={switchDisabled || poolEnabled === null}
                onChange={onToggle}
              />
              {poolEnabled !== null && (
                <Tag theme={poolEnabled ? 'success' : 'default'}>
                  {poolEnabled ? t('subscriptionPool.pool.on', { agent }) : t('subscriptionPool.pool.off')}
                </Tag>
              )}
            </div>
        </div>
        <Text theme="weak" parent="div" style={{ marginTop: 8 }}>
          {t('subscriptionPool.subtitle', { instance: instanceName, agent })}
        </Text>
      </Card.Body>
    </Card>
  );
}
