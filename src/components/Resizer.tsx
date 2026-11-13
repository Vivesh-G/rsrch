import React from 'react';

interface ResizerProps {
  id: string;
  onDragStart: (clientX: number) => void;
  ariaLabel?: string;
  onNudge?: (deltaPx: number) => void;
}

export const Resizer: React.FC<ResizerProps> = ({
  id,
  onDragStart,
  ariaLabel = 'Resize panels',
  onNudge,
}) => {
  return (
    <div
      className="resizer"
      id={id}
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      tabIndex={0}
      onMouseDown={(e) => {
        e.preventDefault();
        onDragStart(e.clientX);
      }}
      onTouchStart={(e) => {
        const t = e.touches[0];
        if (t) {
          e.preventDefault();
          onDragStart(t.clientX);
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
