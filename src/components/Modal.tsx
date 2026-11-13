import React, { useEffect } from 'react';
import { IconClose } from './Icons';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  children: React.ReactNode;
  cardClassName?: string;
  role?: 'dialog' | 'alertdialog';
  ariaLabel?: string;
  onEnter?: () => void;
  headerRight?: React.ReactNode;
  footer?: React.ReactNode;
}

export const Modal: React.FC<ModalProps> = ({
  open,
  onClose,
  title,
  children,
  cardClassName = '',
  role = 'dialog',
  ariaLabel,
  onEnter,
  headerRight,
  footer,
}) => {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'Enter' && onEnter) onEnter();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, onEnter]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className={`modal-card ${cardClassName}`.trim()}
        role={role}
        aria-modal="true"
        aria-label={ariaLabel || (typeof title === 'string' ? title : undefined)}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div className="modal-title">{title}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {headerRight}
            <button
              className="icon-btn small modal-close"
              onClick={onClose}
              title="Close"
              type="button"
            >
              <IconClose size={12} />
            </button>
          </div>
        </div>
        <div className="modal-body">{children}</div>
        {footer}
      </div>
    </div>
  );
};

