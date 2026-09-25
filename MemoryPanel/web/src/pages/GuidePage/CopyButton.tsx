/**
 * CopyButton — GuidePage 内复用的“复制到剪贴板”按钮。
 *
 * 从 GuidePage/index.tsx 抽出，供快速接入 / 记忆指令等多个子模块共享，
 * 避免重复实现复制逻辑与 copied 态反馈。
 *
 * 复制实现复用项目统一的 copyToClipboard：优先安全上下文下的 Clipboard API，
 * 在非安全上下文（http:// + 内网 IP 访问的面板）下自动降级到
 * document.execCommand('copy') 的临时 textarea 方案，避免直接复制失败。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { tea } from '@/lib/tea-bridge';
import { copyToClipboard } from '@/pages/ChatMemoryPage/utils/memory-utils';

export function CopyButton({ value, label }: { value: string; label?: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const ok = await copyToClipboard(value);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } else {
      tea.notify.error(t('guide.copyFailed'));
    }
  };
  return (
    <button type="button" className="guide-copy" onClick={copy}>
      {copied ? t('guide.copied') : (label ?? t('guide.copy'))}
    </button>
  );
}
