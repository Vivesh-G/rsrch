import { useCallback, useEffect, useRef } from 'react';
import { MIN_PANEL_WIDTH, type PanelId } from '../config/defaults';

export function useGlobalResize() {
  const resizeRafRef = useRef<number>(0);
  const resizeCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      if (resizeRafRef.current) cancelAnimationFrame(resizeRafRef.current);
      try {
        resizeCleanupRef.current?.();
      } catch {
        // ignore cleanup errors on unmount
      }
      resizeCleanupRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, []);

  const startDragLoop = useCallback((onFrameMove: (clientX: number) => void) => {
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const scheduleMove = (clientX: number) => {
      if (resizeRafRef.current) return;
      resizeRafRef.current = requestAnimationFrame(() => {
        resizeRafRef.current = 0;
        onFrameMove(clientX);
      });
    };

    const onMouseMove = (moveEvent: MouseEvent) => scheduleMove(moveEvent.clientX);
    const onTouchMove = (te: TouchEvent) => {
      if (te.touches.length > 0) {
        if (te.cancelable) te.preventDefault();
        scheduleMove(te.touches[0].clientX);
      }
    };
    const onKeyCancel = (ke: KeyboardEvent) => {
      if (ke.key === 'Escape') cleanup();
    };

    const cleanup = () => {
      if (resizeRafRef.current) cancelAnimationFrame(resizeRafRef.current);
      resizeRafRef.current = 0;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', cleanup);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', cleanup);
      window.removeEventListener('keydown', onKeyCancel);
      if (resizeCleanupRef.current === cleanup) resizeCleanupRef.current = null;
    };

    resizeCleanupRef.current?.();
    resizeCleanupRef.current = cleanup;
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', cleanup);
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', cleanup);
    window.addEventListener('keydown', onKeyCancel);
  }, []);

  const startSidebarResize = useCallback(
    (
      clientX: number,
      setWidth: React.Dispatch<React.SetStateAction<number>>,
      widthRef: React.MutableRefObject<number>,
      min: number,
      max: number,
    ) => {
      const startWidth = widthRef.current;
      startDragLoop((nextX) => {
        setWidth(Math.min(max, Math.max(min, startWidth + (nextX - clientX))));
      });
    },
    [startDragLoop],
  );

  const startPairResize = useCallback(
    (
      clientX: number,
      leftId: PanelId,
      rightId: PanelId,
      setPanelWeights: React.Dispatch<React.SetStateAction<Record<PanelId, number>>>,
    ) => {
      const leftEl = document.getElementById(leftId);
      const rightEl = document.getElementById(rightId);
      if (!leftEl || !rightEl) return;

      const startLeftW = leftEl.getBoundingClientRect().width;
      const startRightW = rightEl.getBoundingClientRect().width;
      const totalW = startLeftW + startRightW;
      if (totalW <= 0) return;

      startDragLoop((nextX) => {
        const delta = nextX - clientX;
        const screen30Percent = window.innerWidth * 0.3;
        const minLeftW =
          leftId === 'viewer' ? Math.min(screen30Percent, totalW - MIN_PANEL_WIDTH) : MIN_PANEL_WIDTH;
        const minRightW =
          rightId === 'viewer' ? Math.min(screen30Percent, totalW - MIN_PANEL_WIDTH) : MIN_PANEL_WIDTH;

        const newLeftW = Math.max(minLeftW, Math.min(totalW - minRightW, startLeftW + delta));
        const newRightW = totalW - newLeftW;

        setPanelWeights((prev) => {
          const pairSum = (prev[leftId] ?? 1) + (prev[rightId] ?? 1);
          return {
            ...prev,
            [leftId]: (newLeftW / totalW) * pairSum,
            [rightId]: (newRightW / totalW) * pairSum,
          };
        });
      });
    },
    [startDragLoop],
  );

  return { startSidebarResize, startPairResize };
}

