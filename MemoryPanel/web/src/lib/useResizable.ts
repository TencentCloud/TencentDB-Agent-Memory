import { useState, useCallback, useRef, useEffect } from 'react';

/**
 * 可拖拽分割线 hook
 * @param initial  初始宽度 (px)
 * @param min      最小宽度 (px)
 * @param max      最大宽度 (px)
 * @param side     拖拽边：'left' 表示左侧面板宽度可调，'right' 表示右侧面板宽度可调
 */
export function useResizable(initial: number, min: number, max: number, side: 'left' | 'right' = 'left') {
  const [width, setWidth] = useState(initial);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startW = useRef(0);
  const previousBodyStyle = useRef({ cursor: '', userSelect: '' });

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    if (dragging.current) return;
    previousBodyStyle.current = {
      cursor: document.body.style.cursor,
      userSelect: document.body.style.userSelect,
    };
    dragging.current = true;
    startX.current = e.clientX;
    startW.current = width;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [width]);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const delta = e.clientX - startX.current;
      const newW = side === 'left'
        ? Math.max(min, Math.min(max, startW.current + delta))
        : Math.max(min, Math.min(max, startW.current - delta));
      setWidth(newW);
    };
    const onMouseUp = () => {
      if (dragging.current) {
        dragging.current = false;
        document.body.style.cursor = previousBodyStyle.current.cursor;
        document.body.style.userSelect = previousBodyStyle.current.userSelect;
      }
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('blur', onMouseUp);
    return () => {
      onMouseUp();
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('blur', onMouseUp);
    };
  }, [min, max, side]);

  return { width, onMouseDown };
}
