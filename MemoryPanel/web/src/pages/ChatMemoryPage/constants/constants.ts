import { useTranslation } from 'react-i18next';
import type { LayerMeta, ScopeTab } from './types';

export function useLayers(): LayerMeta[] {
  const { t } = useTranslation();
  return [
    { id: 'L0', label: t('memory.layer.L0.label'), short: t('memory.layer.L0.short'), desc: t('memory.layer.L0.desc'), tone: 'default' },
    { id: 'L1', label: t('memory.layer.L1.label'), short: t('memory.layer.L1.short'), desc: t('memory.layer.L1.desc'), tone: 'brand' },
    { id: 'L2', label: t('memory.layer.L2.label'), short: t('memory.layer.L2.short'), desc: t('memory.layer.L2.desc'), tone: 'success' },
    { id: 'L3', label: t('memory.layer.L3.label'), short: t('memory.layer.L3.short'), desc: t('memory.layer.L3.desc'), tone: 'warning' },
  ];
}

export function useScopeTabLabels(): Record<ScopeTab, string> {
  const { t } = useTranslation();
  return {
    team: t('memory.scope.team'),
    fixed: t('memory.scope.fixed'),
  };
}

// Keep static export for backward compatibility — uses i18next global instance
// so it reflects the current language without a hook. Prefer useScopeTabLabels() in components.
import i18n from '@/i18n';
export const SCOPE_TAB_LABELS: Record<ScopeTab, string> = new Proxy({} as Record<ScopeTab, string>, {
  get(_target, prop: string) {
    const map: Record<string, string> = {
      team: 'memory.scope.team',
      fixed: 'memory.scope.fixed',
    };
    const key = map[prop];
    return key ? i18n.t(key) : prop;
  },
});
