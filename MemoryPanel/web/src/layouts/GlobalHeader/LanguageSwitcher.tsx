/**
 * LanguageSwitcher — 顶部语言切换器
 */
import { Dropdown, List } from 'tea-component';
import { InternetIcon } from 'tea-icons-react';
import { useTranslation } from 'react-i18next';
import { changeLanguage, getCurrentLanguage } from '@/i18n';
import './language-switcher.css';

export function LanguageSwitcher() {
  const { t: _t } = useTranslation();
  const current = getCurrentLanguage();

  return (
    <Dropdown
      appearance="pure"
      clickClose
      button={
        <button type="button" className="_memory-lang-switcher-btn" title="Language">
          <InternetIcon size={16} />
          <span className="_memory-lang-switcher-label">{current === 'zh-CN' ? '中文' : 'English'}</span> {/* i18n-ignore: native language name */}
        </button>
      }
    >
      {() => (
        <List type="option">
          <List.Item
            selected={current === 'zh-CN'}
            onClick={() => { changeLanguage('zh-CN'); }}
          >
            中文 {/* i18n-ignore: native language name */}
          </List.Item>
          <List.Item
            selected={current === 'en-US'}
            onClick={() => { changeLanguage('en-US'); }}
          >
            English
          </List.Item>
        </List>
      )}
    </Dropdown>
  );
}
