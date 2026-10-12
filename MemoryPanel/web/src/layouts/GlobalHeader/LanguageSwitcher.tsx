/**
 * LanguageSwitcher — 顶部语言切换器
 */
import { Dropdown, List } from 'tea-component';
import { InternetIcon } from 'tea-icons-react';
import { changeLanguage, getCurrentLanguage } from '@/i18n';
import './language-switcher.css';

export function LanguageSwitcher() {
  const current = getCurrentLanguage();

  return (
    <Dropdown
      appearance="pure"
      clickClose
      button={
        <button type="button" className="_memory-lang-switcher-btn" title="Language">
          <InternetIcon size={16} />
          <span className="_memory-lang-switcher-label">{current === 'zh-CN' ? '中文' : 'English'}</span>
        </button>
      }
    >
      {() => (
        <List type="option">
          <List.Item
            selected={current === 'zh-CN'}
            onClick={() => { changeLanguage('zh-CN'); }}
          >
            中文
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
