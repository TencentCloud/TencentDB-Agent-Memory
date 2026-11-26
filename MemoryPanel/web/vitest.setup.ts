/**
 * vitest 全局 setup：注入 @testing-library/jest-dom 的断言扩展
 * （toBeInTheDocument / toHaveAttribute 等），并在每个用例后清理 DOM。
 */
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// jsdom 不实现 ResizeObserver / matchMedia，而 OnboardingGuide、AssetSplitLayout
// 等组件会用到。这里给出最小桩，避免用例里 import 页面组件时直接抛错。
if (!('ResizeObserver' in globalThis)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
}

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}
