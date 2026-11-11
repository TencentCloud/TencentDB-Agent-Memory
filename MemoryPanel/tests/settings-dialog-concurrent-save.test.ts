// @vitest-environment jsdom
// 前置：先在 MemoryPanel/web 执行 npm ci，再在 MemoryPanel 执行 npm test
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type CapabilityKey =
  | 'llm_wiki.enabled'
  | 'code_graph.enabled'
  | 'chat_memory.enabled'
  | 'skill.enabled';

vi.mock('@/lib/teamApi', () => ({
  userConfigApi: {
    getAssetCapabilities: vi.fn(),
    setAssetCapability: vi.fn(),
  },
}));

vi.mock('@/lib/tea-bridge', () => ({
  tea: {
    notify: {
      success: vi.fn(),
      error: vi.fn(),
    },
  },
}));

import '@/i18n';
import { userConfigApi } from '@/lib/teamApi';
import { SettingsDialog } from '../web/src/components/SettingsDialog';

const ALL_ON: Record<CapabilityKey, boolean> = {
  'llm_wiki.enabled': true,
  'code_graph.enabled': true,
  'chat_memory.enabled': true,
  'skill.enabled': true,
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let container: HTMLDivElement;
let root: Root | null = null;
const saves = new Map<CapabilityKey, Deferred<unknown>>();

async function renderDialog(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(React.createElement(SettingsDialog, { onClose: () => {} }));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function switches(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  saves.clear();
  (userConfigApi.getAssetCapabilities as ReturnType<typeof vi.fn>).mockResolvedValue(ALL_ON);
  (userConfigApi.setAssetCapability as ReturnType<typeof vi.fn>).mockImplementation(
    (key: CapabilityKey) => {
      const d = deferred<unknown>();
      saves.set(key, d);
      return d.promise;
    },
  );
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  vi.clearAllMocks();
});

describe('SettingsDialog 并发保存', () => {
  it('Wiki 先完成时，Code 保持 saving 状态直到自身请求结束', async () => {
    await renderDialog();
    const [wiki, code] = switches();

    act(() => {
      wiki.click();
    });
    act(() => {
      code.click();
    });
    expect(saves.has('llm_wiki.enabled')).toBe(true);
    expect(saves.has('code_graph.enabled')).toBe(true);
    expect(code.disabled).toBe(true);

    await act(async () => {
      saves.get('llm_wiki.enabled')!.resolve(undefined);
    });

    expect(code.disabled, 'Code 仍在保存中，不应被 Wiki 的完成解锁').toBe(true);
  });

  it('Code 先完成时，Wiki 保持 saving 状态直到自身请求结束', async () => {
    await renderDialog();
    const [wiki, code] = switches();

    act(() => {
      wiki.click();
    });
    act(() => {
      code.click();
    });

    await act(async () => {
      saves.get('code_graph.enabled')!.resolve(undefined);
    });

    expect(wiki.disabled, 'Wiki 仍在保存中，不应被 Code 的完成解锁').toBe(true);
  });

  it('一个开关失败时，另一个开关的 saving 状态不受影响', async () => {
    await renderDialog();
    const [wiki, code] = switches();

    act(() => {
      wiki.click();
    });
    act(() => {
      code.click();
    });

    await act(async () => {
      saves.get('llm_wiki.enabled')!.reject(new Error('wiki save failed'));
    });

    expect(code.disabled, 'Code 仍在保存中，Wiki 的失败不应解锁它').toBe(true);
  });

  it('失败提示只归属对应的开关，不被其他提交清掉', async () => {
    await renderDialog();
    const [wiki, code] = switches();

    act(() => {
      wiki.click();
    });
    await act(async () => {
      saves.get('llm_wiki.enabled')!.reject(new Error('wiki save failed'));
    });
    await flush();
    expect(document.body.textContent).toContain('wiki save failed');

    act(() => {
      code.click();
    });
    await flush();

    expect(document.body.textContent, 'Wiki 的失败原因不应被 Code 的提交抹掉').toContain(
      'wiki save failed',
    );
  });

  it('同一开关保存未完成时不能重复提交', async () => {
    await renderDialog();
    const [wiki] = switches();

    act(() => {
      wiki.click();
    });
    act(() => {
      wiki.click();
    });

    expect(userConfigApi.setAssetCapability).toHaveBeenCalledTimes(1);
  });

  it('同一帧内连续点击也只发一个请求', async () => {
    await renderDialog();
    const [wiki] = switches();

    // 两次点击落在同一帧，禁用属性还没来得及生效。
    act(() => {
      wiki.click();
      wiki.click();
    });

    expect(userConfigApi.setAssetCapability).toHaveBeenCalledTimes(1);
  });

  it('失败后开关恢复为请求前的值', async () => {
    await renderDialog();
    const [wiki] = switches();
    expect(wiki.checked).toBe(true);

    act(() => {
      wiki.click();
    });
    expect(wiki.checked).toBe(false);

    await act(async () => {
      saves.get('llm_wiki.enabled')!.reject(new Error('wiki save failed'));
    });
    await flush();

    expect(wiki.disabled).toBe(false);
    expect(wiki.checked).toBe(true);
  });

  it('关闭弹窗后晚到的失败响应不回滚已更新的操作', async () => {
    // 同一开关在途时会被拒绝，界面上制造不出同 key 的旧响应；
    // 这里验证的是组件卸载后旧请求结算不写回界面。
    await renderDialog();
    const [wiki] = switches();
    act(() => {
      wiki.click();
    });

    act(() => {
      root!.unmount();
    });
    root = null;
    container.remove();

    await renderDialog();
    await act(async () => {
      saves.get('llm_wiki.enabled')!.reject(new Error('late wiki failure'));
    });
    await flush();

    expect(document.body.textContent).not.toContain('late wiki failure');
  });
});
