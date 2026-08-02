import ReactDOM from 'react-dom/client';
import App from './App';
import './i18n';
// 外部版 tea-component@2.8.0 没有 console-pack.css（那是内部版独有的 Tencent Cloud Console 主题包），
// 使用 default-pack.css 替代（包含 Tea Design Token 体系 + 默认 light 主题变量定义）。
import 'tea-component/dist/themes/default-pack.css';
import 'tea-component/dist/tea-themeable.css';
import './index.css';
import './tea-override.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <App />
);
