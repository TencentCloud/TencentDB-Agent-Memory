import { useEffect } from 'react';
import { ResourcePage } from '@/pages/ResourcePage';
import WikiSourcesPanel from './components/WikiSourcesPanel';
import { ensureFormats } from './utils/wiki-format-store';

export function WikiPage() {
  // 进入 Wiki 页时拉取格式注册表（单一真源）。
  // 白名单 / 上传通道 / accept 属性全部由它派生，故须在任何文件操作前就绪。
  useEffect(() => {
    void ensureFormats();
  }, []);

  return (
    <ResourcePage>
      <WikiSourcesPanel />
    </ResourcePage>
  );
}
