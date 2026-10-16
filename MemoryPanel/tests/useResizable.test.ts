import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Dependencies = readonly unknown[];
type Options = { initial: number; min: number; max: number; side: 'left' | 'right' };
type Slot = {
  value?: unknown;
  set?: (value: unknown) => void;
  dependencies?: Dependencies;
  cleanup?: () => void;
};

const runtime = { current: undefined as HookHarness | undefined };

// Resolve React from the web package, where the hook also resolves it.
vi.doMock(createRequire(new URL('../web/package.json', import.meta.url)).resolve('react'), () => ({
  useState: (initial: unknown) => runtime.current!.useState(initial),
  useRef: (initial: unknown) => runtime.current!.useRef(initial),
  useCallback: (callback: unknown, dependencies: Dependencies) =>
    runtime.current!.useCallback(callback, dependencies),
  useEffect: (setup: () => void | (() => void), dependencies: Dependencies) =>
    runtime.current!.useEffect(setup, dependencies),
}));

const { useResizable } = await import('../web/src/lib/useResizable');

const sameDependencies = (a: Dependencies | undefined, b: Dependencies) =>
  a !== undefined && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));

// The panel's existing Vitest environment is Node. This small hook host preserves
// state/refs and dependency-based effect cleanup while executing the real hook.
// It tests event and inline-style behavior, not React scheduling or browser layout.
class HookHarness {
  private slots: Slot[] = [];
  private cursor = 0;
  private pending: (() => void)[] = [];
  private options: Options;
  result!: ReturnType<typeof useResizable>;

  constructor(options: Partial<Options> = {}) {
    this.options = { initial: 200, min: 100, max: 300, side: 'left', ...options };
    this.render();
  }

  private nextSlot() {
    return this.slots[this.cursor++] ??= {};
  }

  useState(initial: unknown) {
    const slot = this.nextSlot();
    if (!slot.set) {
      slot.value = initial;
      slot.set = (value) => {
        slot.value = value;
        this.render();
      };
    }
    return [slot.value, slot.set];
  }

  useRef(initial: unknown) {
    const slot = this.nextSlot();
    return slot.value ?? (slot.value = { current: initial });
  }

  useCallback(callback: unknown, dependencies: Dependencies) {
    const slot = this.nextSlot();
    if (!sameDependencies(slot.dependencies, dependencies)) {
      slot.value = callback;
      slot.dependencies = dependencies;
    }
    return slot.value;
  }

  useEffect(setup: () => void | (() => void), dependencies: Dependencies) {
    const slot = this.nextSlot();
    if (!sameDependencies(slot.dependencies, dependencies)) {
      slot.dependencies = dependencies;
      this.pending.push(() => {
        slot.cleanup?.();
        slot.cleanup = setup() || undefined;
      });
    }
  }

  render(options: Partial<Options> = {}) {
    this.options = { ...this.options, ...options };
    this.cursor = 0;
    runtime.current = this;
    try {
      const { initial, min, max, side } = this.options;
      this.result = useResizable(initial, min, max, side);
    } finally {
      runtime.current = undefined;
    }
    this.pending.splice(0).forEach((run) => run());
  }

  start(clientX = 100) {
    const preventDefault = vi.fn();
    this.result.onMouseDown({ clientX, preventDefault } as unknown as Parameters<typeof this.result.onMouseDown>[0]);
    expect(preventDefault).toHaveBeenCalledOnce();
  }

  unmount() {
    for (const slot of this.slots) {
      slot.cleanup?.();
      slot.cleanup = undefined;
    }
  }
}

describe('useResizable', () => {
  let events: EventTarget;
  let style: { cursor: string; userSelect: string };
  let panels: HookHarness[];

  const mount = (options: Partial<Options> = {}) => {
    const panel = new HookHarness(options);
    panels.push(panel);
    return panel;
  };
  const move = (clientX: number) => events.dispatchEvent(Object.assign(new Event('mousemove'), { clientX }));
  const end = (method: string, panel: HookHarness) => {
    if (method === 'unmount') panel.unmount();
    else events.dispatchEvent(new Event(method));
  };

  beforeEach(() => {
    events = new EventTarget();
    style = { cursor: '', userSelect: '' };
    panels = [];
    vi.stubGlobal('window', events);
    vi.stubGlobal('document', { body: { style } });
  });

  afterEach(() => {
    panels.forEach((panel) => panel.unmount());
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe.each(['mouseup', 'unmount', 'blur'])('ending a drag with %s', (method) => {
    it.each([
      { cursor: '', userSelect: '' },
      { cursor: 'crosshair', userSelect: 'text' },
    ])('restores $cursor/$userSelect and stops resizing', (original) => {
      Object.assign(style, original);
      const panel = mount();
      panel.start();
      expect(style).toEqual({ cursor: 'col-resize', userSelect: 'none' });
      move(125);
      expect(panel.result.width).toBe(225);

      end(method, panel);
      expect(style).toEqual(original);
      move(175);
      expect(panel.result.width).toBe(225);
    });
  });

  it('leaves another instance\'s drag styles intact when an idle instance unmounts', () => {
    Object.assign(style, { cursor: 'pointer', userSelect: 'text' });
    const idle = mount();
    const active = mount();
    active.start();

    idle.unmount();
    expect(style).toEqual({ cursor: 'col-resize', userSelect: 'none' });
    move(125);
    expect(active.result.width).toBe(225);
    end('mouseup', active);
    expect(style).toEqual({ cursor: 'pointer', userSelect: 'text' });
  });

  describe.each(['active first', 'idle first'])('shared window events with %s', (order) => {
    it.each(['mouseup', 'blur'])('restores styles on %s while both instances remain mounted', (method) => {
      Object.assign(style, { cursor: 'pointer', userSelect: 'text' });
      const first = mount();
      const second = mount();
      const [active, idle] = order === 'active first' ? [first, second] : [second, first];
      active.start();
      move(125);
      expect(active.result.width).toBe(225);
      expect(idle.result.width).toBe(200);

      end(method, active);
      expect(style).toEqual({ cursor: 'pointer', userSelect: 'text' });
      move(175);
      expect(active.result.width).toBe(225);
      expect(idle.result.width).toBe(200);

      Object.assign(style, { cursor: 'wait', userSelect: 'all' });
      end('mouseup', active);
      end('blur', active);
      idle.unmount();
      active.unmount();
      expect(style).toEqual({ cursor: 'wait', userSelect: 'all' });
    });
  });

  it('does not change styles again after a drag has already ended', () => {
    const panel = mount();
    panel.start();
    end('blur', panel);
    Object.assign(style, { cursor: 'wait', userSelect: 'all' });

    end('mouseup', panel);
    end('blur', panel);
    panel.unmount();
    panel.unmount();
    expect(style).toEqual({ cursor: 'wait', userSelect: 'all' });
  });

  it('captures fresh styles and the current width for each new drag', () => {
    const panel = mount();
    panel.start();
    move(120);
    end('mouseup', panel);
    expect(panel.result.width).toBe(220);
    expect(style).toEqual({ cursor: '', userSelect: '' });

    Object.assign(style, { cursor: 'crosshair', userSelect: 'text' });
    panel.start(140);
    move(150);
    expect(panel.result.width).toBe(230);
    end('blur', panel);
    expect(style).toEqual({ cursor: 'crosshair', userSelect: 'text' });
  });

  it('preserves the original styles and drag origin on repeated mousedown', () => {
    Object.assign(style, { cursor: 'pointer', userSelect: 'text' });
    const panel = mount();
    panel.start();
    move(125);
    expect(panel.result.width).toBe(225);

    panel.start(140);
    move(150);
    expect(panel.result.width).toBe(250);
    end('mouseup', panel);
    expect(style).toEqual({ cursor: 'pointer', userSelect: 'text' });
  });

  it.each(['left', 'right'] as const)('resizes the %s side and respects both bounds', (side) => {
    const panel = mount({ side });
    panel.start();
    move(150);
    expect(panel.result.width).toBe(side === 'left' ? 250 : 150);
    move(1000);
    expect(panel.result.width).toBe(side === 'left' ? 300 : 100);
    move(-1000);
    expect(panel.result.width).toBe(side === 'left' ? 100 : 300);
  });

  it.each<Partial<Options>>([{ min: 150 }, { max: 250 }, { side: 'right' }])(
    'ends the active drag when effect options change to %j',
    (options) => {
      Object.assign(style, { cursor: 'pointer', userSelect: 'text' });
      const panel = mount();
      panel.start();
      move(125);
      panel.render(options);

      expect(style).toEqual({ cursor: 'pointer', userSelect: 'text' });
      move(150);
      expect(panel.result.width).toBe(225);
      panel.start();
      move(110);
      expect(panel.result.width).toBe(options.side === 'right' ? 215 : 235);
    },
  );

  it('removes every registered window listener on unmount', () => {
    const add = vi.spyOn(events, 'addEventListener');
    const remove = vi.spyOn(events, 'removeEventListener');
    const panel = mount();
    panel.start();
    panel.unmount();

    expect(add.mock.calls.map(([type]) => type).sort()).toEqual(['blur', 'mousemove', 'mouseup']);
    expect(remove.mock.calls).toHaveLength(add.mock.calls.length);
    expect(remove.mock.calls).toEqual(expect.arrayContaining(add.mock.calls));
  });
});
