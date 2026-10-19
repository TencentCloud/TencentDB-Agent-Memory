/**
 * PoolSummary — four numbers above the account table.
 */
import { useTranslation } from 'react-i18next';
import { Card, Text } from 'tea-component';
import i18n from '@/i18n';
import { formatRemaining, formatResetAt } from '@/lib/subscription-pool-display';
import type { SubscriptionPoolProviderStatus } from '@/lib/api/subscription-pool';

interface Props {
  status: SubscriptionPoolProviderStatus;
  thresholdPct: number;
  now: number;
}

export function PoolSummary({ status, thresholdPct, now }: Props) {
  const { t } = useTranslation();
  const { summary } = status;
  const reset = summary.earliest_reset;
  const resetUpcoming = reset !== null && reset > now;
  const items: Array<{ key: string; label: string; value: string; note?: string }> = [
    {
      key: 'available',
      label: t('subscriptionPool.summary.available'),
      value: String(summary.available),
      note: `/ ${summary.total}`,
    },
    { key: 'sessions', label: t('subscriptionPool.summary.sessions'), value: String(summary.active_sessions) },
    {
      key: 'reset',
      label: t('subscriptionPool.summary.earliestReset'),
      value: resetUpcoming ? formatResetAt(reset, now, { locale: i18n.language }) : t('subscriptionPool.summary.none'),
      note: resetUpcoming ? formatRemaining(reset, now) : undefined,
    },
    { key: 'threshold', label: t('subscriptionPool.summary.threshold'), value: `${thresholdPct}%` },
  ];
  return (
    <div className="_memory-pool-summary">
      {items.map((item) => (
        <Card key={item.key}>
          <Card.Body>
            <Text theme="weak" parent="div">{item.label}</Text>
            <div className="_memory-pool-stat">
              <span className="_memory-pool-stat-value">{item.value}</span>
              {item.note && <Text theme="weak">{item.note}</Text>}
            </div>
          </Card.Body>
        </Card>
      ))}
    </div>
  );
}
