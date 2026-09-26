import React, { useEffect, useRef, useState } from 'react';
import { IconClose } from './Icons';

interface ConfirmModalProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export const ConfirmModal: React.FC<ConfirmModalProps> = ({
  open,
  title,
  message,
  confirmLabel = 'Delete',
  onCancel,
  onConfirm,
}) => {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter') onConfirm();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel, onConfirm]);

  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal-card modal-small"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div className="modal-title">{title}</div>
          <button className="icon-btn small" onClick={onCancel} title="Close" type="button">
            <IconClose size={12} />
          </button>
        </div>
        <div className="modal-body">
          <p className="modal-desc">{message}</p>
          <div className="modal-actions">
            <button className="modal-btn secondary" onClick={onCancel} type="button">
              Cancel
            </button>
            <button className="modal-btn danger" onClick={onConfirm} type="button" autoFocus>
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

interface NewWorkspaceModalProps {
  open: boolean;
  onCancel: () => void;
  onCreate: (name: string) => void;
}

export const NewWorkspaceModal: React.FC<NewWorkspaceModalProps> = ({
  open,
  onCancel,
  onCreate,
}) => {
  const [name, setName] = useState('Projects');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setName('Projects');
      setTimeout(() => inputRef.current?.select(), 50);
    }
  }, [open ]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onCreate(trimmed);
  };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal-card modal-small"
        role="dialog"
        aria-modal="true"
        aria-label="New workspace"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div className="modal-title">New workspace</div>
          <button className="icon-btn small" onClick={onCancel} title="Close" type="button">
            <IconClose size={12} />
          </button>
        </div>
        <div className="modal-body">
          <label className="modal-label" htmlFor="newWsName">
            Workspace name
          </label>
          <input
            id="newWsName"
            ref={inputRef}
            className="modal-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
            placeholder="Enter workspace name"
            maxLength={60}
          />
          <div className="modal-actions">
            <button className="modal-btn secondary" onClick={onCancel} type="button">
              Cancel
            </button>
            <button
              className="modal-btn primary"
              onClick={submit}
              type="button"
              disabled={!name.trim()}
            >
              Create
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
