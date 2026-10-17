/**
 * Tea 组件桥接工具
 *
 * 提供便捷的方式在现有代码中使用 Tea 组件，
 * 逐步替换原生 HTML 元素和自定义实现。
 *
 * 使用方式:
 *   import { tea } from '@/lib/tea-bridge';
 *   tea.confirm({ message: '确认删除？' }).then(ok => { ... });
 *   tea.notify.success('操作成功');
 *   tea.notify.error('加载失败');  // 弹右上角通知卡片，需手动关闭，不会一闪而过
 *   tea.notify.error(err);  // 传入 Error / ApiError，自动提取 message + request_id
 */

import { getErrorMessage } from './error-message';
import { Modal, message, notification } from 'tea-component';
import i18n from '@/i18n';

function t(key: string, opts?: Record<string, unknown>): string {
  return i18n.t(key, opts);
}

/**
 * 结构化错误通知入参 — 适合需要展示 title + detail + requestId 的场景。
 */
interface StructuredErrorInput {
  title?: string;
  detail?: string;
  requestId?: string;
}

/**
 * 从 unknown 错误对象中尽力提取 request_id。
 * 支持 ApiError（name === 'ApiError'）、SkillApiError、KnowledgeApiError 等。
 */
function extractRequestId(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'requestId' in err) {
    const v = (err as { requestId?: unknown }).requestId;
    if (typeof v === 'string' && v) return v;
  }
  if (err && typeof err === 'object' && 'request_id' in err) {
    const v = (err as { request_id?: unknown }).request_id;
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}

export const tea = {
  /**
   * 确认对话框 — 替代 confirm()
   */
  confirm: async (opts: {
    message: string;
    description?: string;
    okText?: string;
    cancelText?: string;
  }) => {
    return Modal.confirm({
      message: opts.message,
      description: opts.description,
      okText: opts.okText ?? t('teaBridge.confirm.ok'),
      cancelText: opts.cancelText ?? t('teaBridge.confirm.cancel'),
    });
  },

  /**
   * 消息提示
   *
   * - success: 轻量 toast（一闪即过，不打断操作）
   * - error:   右上角通知卡片（需手动关闭，确保用户看到错误信息）
   * - warning:  右上角通知卡片（同 error，需手动关闭）
   * - info:     右上角通知卡片
   *
   * 之前 error/warning 用 message.error（toast），3 秒自动消失，
   * 用户经常看不到错误提示就消失了。改用 notification 后错误提示
   * 会一直停留在右上角直到用户手动关闭，确保不会被遗漏。
   *
   * error 入参支持三种形式：
   *   - string：直接作为 description
   *   - Error / ApiError / SkillApiError / KnowledgeApiError：自动提取 message + request_id
   *   - StructuredErrorInput { title?, detail?, requestId? }：结构化方式
   */
  notify: {
    success: (msg: string) => message.success({ content: msg }),
    error: (msg: unknown) => {
      // 结构化入参 { title?, detail?, requestId? }
      if (msg && typeof msg === 'object' && !((msg as unknown) instanceof Error) && ('title' in msg || 'detail' in msg || 'requestId' in msg)) {
        const input = msg as StructuredErrorInput;
        const desc = input.requestId
          ? input.detail
            ? `${input.detail}\nrequest_id: ${input.requestId}`
            : `request_id: ${input.requestId}`
          : input.detail;
        notification.error({
          title: input.title ?? t('teaBridge.notify.errorTitle'),
          description: desc,
        });
        return;
      }
      // Error / string / 其他 — 走 getErrorMessage 提取友好提示
      const friendly = getErrorMessage(msg);
      const requestId = extractRequestId(msg);
      const desc = requestId
        ? `${friendly}\nrequest_id: ${requestId}`
        : friendly;
      notification.error({
        title: t('teaBridge.notify.errorTitle'),
        description: desc,
      });
    },
    warning: (msg: string) =>
      notification.warning({
        title: t('teaBridge.notify.warningTitle'),
        description: msg,
      }),
    info: (msg: string) =>
      notification.success({ description: msg }),
  },

  /**
   * 复杂通知（带自定义标题）
   */
  notification: {
    success: (title: string, description?: string) =>
      notification.success({ title, description }),
    error: (title: string, description?: string) =>
      notification.error({ title, description: description ? getErrorMessage(description) : undefined }),
    warning: (title: string, description?: string) =>
      notification.warning({ title, description }),
  },

  /**
   * 确认删除
   */
  confirmDelete: (name: string, detail?: string) =>
    Modal.confirm({
      message: t('teaBridge.confirmDelete.message', { name }),
      description: detail ?? t('teaBridge.confirmDelete.desc'),
      okText: t('teaBridge.confirmDelete.ok'),
      cancelText: t('teaBridge.confirm.cancel'),
    }),
};

/**
 * 「确认后执行」帮助函数 —— 收敛各资产页大量重复的
 * `tea.confirm(...) → if (!ok) return → try/catch → tea.notify.error` 样板。
 *
 * 用户确认后执行 action；action 抛错时默认走 tea.notify.error(err)
 * （可传 onError 自定义错误提示，如带 i18n 兜底文案）。
 *
 * @returns 用户是否确认并成功执行（取消 / 执行失败均为 false）
 */
export async function confirmThenRun(
  opts: {
    message: string;
    description?: string;
    okText?: string;
    cancelText?: string;
  },
  action: () => Promise<void> | void,
  onError?: (err: unknown) => void,
): Promise<boolean> {
  const ok = await tea.confirm(opts);
  if (!ok) return false;
  try {
    await action();
    return true;
  } catch (err) {
    if (onError) {
      onError(err);
    } else {
      tea.notify.error(err);
    }
    return false;
  }
}
