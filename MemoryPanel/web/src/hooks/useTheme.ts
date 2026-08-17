/**
 * useTheme — dark/light mode hook.
 *
 * Alterna o atributo `theme-mode` no <html>, que o tea-component usa
 * (seletor `.tea-theme-dark, [theme-mode=dark]`) para aplicar os tokens
 * dark. Persiste a preferência em localStorage.
 */
import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'memory-hub-theme';
type Theme = 'light' | 'dark';

function getInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'light';
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === 'dark' || stored === 'light') return stored;
  // fallback: segue o sistema
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.setAttribute('theme-mode', 'dark');
    } else {
      root.removeAttribute('theme-mode');
    }
    window.localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  }, []);

  return { theme, toggle, setTheme };
}
