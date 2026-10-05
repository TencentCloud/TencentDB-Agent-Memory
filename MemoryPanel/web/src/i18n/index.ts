/**
 * i18n setup
 *
 * - First visit: navigator.language starting with "he" (or legacy "iw") → Hebrew, anything else → English
 * - A manual switch is persisted to localStorage
 * - react-i18next's useTranslation re-renders components on change
 * - <html lang/dir> follows the language so Hebrew renders right-to-left
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { enUS } from './en-US';
import { heIL } from './he-IL';

const STORAGE_KEY = 'tdai-memory.lang';

export const SUPPORTED_LANGUAGES = ['en-US', 'he-IL'] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];

const RTL_LANGUAGES: ReadonlySet<string> = new Set(['he-IL']);

function isSupported(lang: string | null): lang is Language {
  return lang !== null && (SUPPORTED_LANGUAGES as readonly string[]).includes(lang);
}

function detectInitialLanguage(): Language {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    // storage unavailable (private mode etc.) — fall through to navigator
  }
  if (isSupported(stored)) return stored;
  const nav = (navigator.language || '').toLowerCase();
  return nav.startsWith('he') || nav.startsWith('iw') ? 'he-IL' : 'en-US';
}

function applyDocumentDirection(lang: string): void {
  const root = document.documentElement;
  root.lang = lang;
  root.dir = RTL_LANGUAGES.has(lang) ? 'rtl' : 'ltr';
}

export function changeLanguage(lang: Language): void {
  i18n.changeLanguage(lang);
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // not persisted; the switch still applies for this page load
  }
}

export function getCurrentLanguage(): Language {
  return isSupported(i18n.language) ? i18n.language : 'en-US';
}

i18n.on('languageChanged', applyDocumentDirection);

i18n.use(initReactI18next).init({
  resources: {
    'en-US': { translation: enUS },
    'he-IL': { translation: heIL },
  },
  lng: detectInitialLanguage(),
  fallbackLng: 'en-US',
  interpolation: {
    escapeValue: false,
  },
  react: {
    useSuspense: false,
  },
});

applyDocumentDirection(i18n.language);

export default i18n;
