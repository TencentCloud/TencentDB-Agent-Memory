/**
 * i18n 初始化模块
 *
 * - 首次访问读取 navigator.language（zh 开头 → 中文，其他 → 英文）
 * - 用户手动切换后持久化到 localStorage
 * - react-i18next 的 useTranslation 会自动触发组件重渲染
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { zhCN } from './zh-CN';
import { enUS } from './en-US';

const STORAGE_KEY = 'tdai-memory.lang';

function detectInitialLanguage(): string {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (stored === 'zh-CN' || stored === 'en-US') return stored;
  } catch {
    // Storage can be unavailable under browser privacy or sandbox policies.
  }
  const nav = (typeof navigator !== 'undefined' && navigator.language) || 'zh-CN';
  return nav.startsWith('zh') ? 'zh-CN' : 'en-US';
}

export function changeLanguage(lang: string): void {
  void i18n.changeLanguage(lang);
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, lang);
  } catch {
    // Persisting the preference is optional; the in-memory switch still stands.
  }
}

export function getCurrentLanguage(): string {
  return i18n.language || 'zh-CN';
}

i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': { translation: zhCN },
    'en-US': { translation: enUS },
  },
  lng: detectInitialLanguage(),
  fallbackLng: 'zh-CN',
  interpolation: {
    escapeValue: false,
  },
  react: {
    useSuspense: false,
  },
});

export default i18n;
