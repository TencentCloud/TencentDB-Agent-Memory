/**
 * LanguageSwitcher — header language picker
 */
import { Dropdown, List } from 'tea-component';
import { InternetIcon } from 'tea-icons-react';
import { changeLanguage, getCurrentLanguage, type Language } from '@/i18n';
import './language-switcher.css';

const LANGUAGE_LABELS: Record<Language, string> = {
  'en-US': 'English',
  'he-IL': 'עברית',
};

export function LanguageSwitcher() {
  const current = getCurrentLanguage();

  return (
    <Dropdown
      appearance="pure"
      clickClose
      button={
        <button type="button" className="_memory-lang-switcher-btn" title="Language">
          <InternetIcon size={16} />
          <span className="_memory-lang-switcher-label">{LANGUAGE_LABELS[current]}</span>
        </button>
      }
    >
      {() => (
        <List type="option">
          {(Object.keys(LANGUAGE_LABELS) as Language[]).map((lang) => (
            <List.Item
              key={lang}
              selected={current === lang}
              onClick={() => { changeLanguage(lang); }}
            >
              {LANGUAGE_LABELS[lang]}
            </List.Item>
          ))}
        </List>
      )}
    </Dropdown>
  );
}
