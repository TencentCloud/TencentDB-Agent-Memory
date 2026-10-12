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
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'zh-CN' || stored === 'en-US') return stored;
  const nav = navigator.language || 'zh-CN';
  return nav.startsWith('zh') ? 'zh-CN' : 'en-US';
}

export function changeLanguage(lang: string): void {
  i18n.changeLanguage(lang);
  localStorage.setItem(STORAGE_KEY, lang);
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
