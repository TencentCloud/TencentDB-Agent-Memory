import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './i18n';
// 外部版 tea-component@2.8.0 没有 console-pack.css（那是内部版独有的 Tencent Cloud Console 主题包），
// 使用 default-pack.css 替代（包含 Tea Design Token 体系 + 默认 light 主题变量定义）。
import 'tea-component/dist/themes/default-pack.css';
import 'tea-component/dist/tea-themeable.css';
import './index.css';
import './tea-override.css';

// WOA SSO 认证后会把授权码挂在站点地址上（?code=...&state=...）跳回。
// 会话已由后端 Cookie 建立，前端无需该参数，登录完成后清理地址栏，避免 code 残留/被复制分享。
(function stripWoaAuthParams() {
  try {
    const url = new URL(window.location.href);
    let changed = false;
    for (const key of ['code', 'state']) {
      if (url.searchParams.has(key)) {
        url.searchParams.delete(key);
        changed = true;
      }
    }
    if (changed) {
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    }
  } catch {
    /* URL 解析失败时不影响应用启动 */
  }
})();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
