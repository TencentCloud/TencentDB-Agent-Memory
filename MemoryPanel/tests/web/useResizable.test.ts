import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Panel's Vitest runs in Node. These substitutes exercise the hook's handlers
// and effect cleanup; actual React rendering and text selection need a browser.
const setWidth = vi.fn();
let cleanup: () => void;
vi.doMock(createRequire(new URL('../../web/package.json', import.meta.url)).resolve('react'), () => ({
  useState: (initial: number) => [initial, setWidth],
  useRef: (current: unknown) => ({ current }),
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => () => void) => { cleanup = effect(); },
}));
const { useResizable } = await import('../../web/src/lib/useResizable');

let target: EventTarget;
let style: { cursor: string; userSelect: string };
let addListener: ReturnType<typeof vi.spyOn>;
let removeListener: ReturnType<typeof vi.spyOn>;

function dispatch(type: string, clientX = 0) {
  const event = Object.assign(new Event(type), { clientX });
  target.dispatchEvent(event);
}

function startDrag(hook: ReturnType<typeof useResizable>, clientX = 100) {
  const preventDefault = vi.fn();
  hook.onMouseDown({ clientX, preventDefault } as Parameters<typeof hook.onMouseDown>[0]);
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(style).toEqual({ cursor: 'col-resize', userSelect: 'none' });
}

beforeEach(() => {
  setWidth.mockClear();
  target = new EventTarget();
  style = { cursor: 'crosshair', userSelect: 'text' };
  vi.stubGlobal('window', target);
  vi.stubGlobal('document', { body: { style } });
  addListener = vi.spyOn(target, 'addEventListener');
  removeListener = vi.spyOn(target, 'removeEventListener');
});

afterEach(() => {
  cleanup?.();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('useResizable drag cleanup', () => {
  it.each(['mouseup', 'blur', 'unmount'])('restores existing styles on %s and stops resizing', (exit) => {
    const hook = useResizable(300, 200, 500);
    startDrag(hook);
    dispatch('mousemove', 150);
    expect(setWidth).toHaveBeenLastCalledWith(350);

    if (exit === 'unmount') cleanup();
    else dispatch(exit);

    expect(style).toEqual({ cursor: 'crosshair', userSelect: 'text' });
    setWidth.mockClear();
    dispatch('mousemove', 200);
    expect(setWidth).not.toHaveBeenCalled();

    // Late events and repeated cleanup must not overwrite later style changes.
    style.cursor = 'help';
    style.userSelect = 'all';
    dispatch('mouseup');
    dispatch('blur');
    cleanup();
    cleanup();
    expect(style).toEqual({ cursor: 'help', userSelect: 'all' });
  });

  it.each(['mouseup', 'blur', 'unmount'])('restores originally empty styles on %s', (exit) => {
    style.cursor = '';
    style.userSelect = '';
    const hook = useResizable(300, 200, 500);
    startDrag(hook);
    if (exit === 'unmount') cleanup();
    else dispatch(exit);
    expect(style).toEqual({ cursor: '', userSelect: '' });
  });

  it('does not modify styles when no drag was started', () => {
    useResizable(300, 200, 500);
    dispatch('mouseup');
    dispatch('blur');
    cleanup();
    expect(style).toEqual({ cursor: 'crosshair', userSelect: 'text' });
  });

  it('does not let an idle instance restore another instance\'s styles', () => {
    const active = useResizable(300, 200, 500);
    const activeCleanup = cleanup;
    useResizable(300, 200, 500);
    startDrag(active);
    cleanup();
    expect(style).toEqual({ cursor: 'col-resize', userSelect: 'none' });
    activeCleanup();
    expect(style).toEqual({ cursor: 'crosshair', userSelect: 'text' });
  });

  it('captures the current styles for each successive drag', () => {
    const hook = useResizable(300, 200, 500);
    startDrag(hook);
    dispatch('mouseup');
    style.cursor = 'help';
    style.userSelect = 'all';
    startDrag(hook);
    dispatch('blur');
    expect(style).toEqual({ cursor: 'help', userSelect: 'all' });
    startDrag(hook);
    cleanup();
    expect(style).toEqual({ cursor: 'help', userSelect: 'all' });
  });

  it('does not overwrite the original styles on a duplicate mousedown', () => {
    const hook = useResizable(300, 200, 500);
    startDrag(hook);
    startDrag(hook, 120);
    dispatch('mouseup');
    expect(style).toEqual({ cursor: 'crosshair', userSelect: 'text' });
  });

  it.each([
    ['left', 150, 350], ['left', -100, 200], ['left', 1000, 500],
    ['right', 150, 250], ['right', -100, 500], ['right', 1000, 200],
  ] as const)('preserves %s resizing at x=%i (width=%i)', (side, clientX, width) => {
    const hook = useResizable(300, 200, 500, side);
    startDrag(hook);
    dispatch('mousemove', clientX);
    expect(setWidth).toHaveBeenLastCalledWith(width);
  });

  it('removes every registered listener on cleanup', () => {
    const hook = useResizable(300, 200, 500);
    expect(addListener.mock.calls.map(([type]) => type).sort()).toEqual(['blur', 'mousemove', 'mouseup']);
    startDrag(hook);
    const registrations = [...addListener.mock.calls];
    cleanup();
    expect(removeListener.mock.calls).toEqual(registrations);
    setWidth.mockClear();
    dispatch('mousemove', 200);
    expect(setWidth).not.toHaveBeenCalled();
  });
});
