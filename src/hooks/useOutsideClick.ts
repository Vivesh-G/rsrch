import { useEffect } from 'react';
import type { RefObject } from 'react';

export function useOutsideClick(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onOutsideClick: () => void,
): void {
  useEffect(() => {
    if (!active) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onOutsideClick();
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [ref, active, onOutsideClick]);
}

