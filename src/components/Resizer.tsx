import React from 'react';

interface ResizerProps {
  id: string;
  onMouseDown: (e: React.MouseEvent) => void;
  ariaLabel?: string;
  onNudge?: (deltaPx: number) => void;
}

export const Resizer: React.FC<ResizerProps> = ({ id, onMouseDown, ariaLabel = 'Resize panels', onNudge }) => {
  return (
    <div
      className="resizer"
      id={id}
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      tabIndex={0}
      onMouseDown={onMouseDown}
      onTouchStart={(e) => {
        // Forward the first touch as a mouse-equivalent drag start.
        const t = e.touches[0];
        if (t) {
          onMouseDown({ clientX: t.clientX, preventDefault: () => e.preventDefault() } as unknown as React.MouseEvent);
        }
      }}
      onKeyDown={(e) => {
        if (!onNudge) return;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          onNudge(e.key === 'ArrowLeft' ? -16 : 16);
        }
      }}
    />
  );
};
