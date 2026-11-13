import React, { useEffect, useRef } from 'react';

export const SLASH_TRIGGER_RE = /(?:^|\s)\/([a-zA-Z0-9_-]*)$/;
export const SLASH_MENU_BOUNDS = { width: 300, height: 320, margin: 16 } as const;

export interface SlashCommandItem {
  id: string;
  label: string;
  description: string;
  badge: string;
  keywords: string[];
}

interface SlashCommandMenuProps<T extends SlashCommandItem> {
  open: boolean;
  x: number;
  y: number;
  selectedIndex: number;
  items: T[];
  onSelect: (item: T) => void;
  onHoverIndex?: (index: number) => void;
  onClose?: () => void;
  containerRef?: React.RefObject<HTMLDivElement | null>;
}

export function SlashCommandMenu<T extends SlashCommandItem>({
  open,
  x,
  y,
  selectedIndex,
  items,
  onSelect,
  onHoverIndex,
  onClose,
  containerRef,
}: SlashCommandMenuProps<T>) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !listRef.current) return;
    const active = listRef.current.children[selectedIndex] as HTMLElement | undefined;
    active?.scrollIntoView({ block: 'nearest' });
  }, [open, selectedIndex]);

  if (!open) return null;

  return (
    <div
      ref={containerRef}
      className="slash-menu"
      style={{ top: `${y}px`, left: `${x}px` }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="slash-menu-head">
        <span>Blocks & Tools</span>
        <kbd onClick={onClose}>ESC to close</kbd>
      </div>
      <div className="slash-menu-list" ref={listRef}>
        {items.length === 0 ? (
          <div className="slash-menu-empty">No matching commands</div>
        ) : (
          items.map((cmd, idx) => {
            const isSelected = idx === selectedIndex;
            return (
              <button
                key={cmd.id}
                className={`slash-item ${isSelected ? 'active' : ''}`}
                onClick={() => onSelect(cmd)}
                type="button"
                onMouseEnter={onHoverIndex ? () => onHoverIndex(idx) : undefined}
              >
                <span className="slash-item-badge">{cmd.badge}</span>
                <div className="slash-item-info">
                  <div className="slash-item-title">{cmd.label}</div>
                  <div className="slash-item-desc">{cmd.description}</div>
                </div>
                {isSelected && <span className="slash-item-hint">↵</span>}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

