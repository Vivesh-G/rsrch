import React, { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';

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
  return (
    <Modal
      open={open}
      onClose={onCancel}
      onEnter={onConfirm}
      title={title}
      role="alertdialog"
      cardClassName="modal-small"
    >
      <p className="modal-desc">{message}</p>
      <div className="modal-actions">
        <button className="modal-btn secondary" onClick={onCancel} type="button">
          Cancel
        </button>
        <button className="modal-btn danger" onClick={onConfirm} type="button" autoFocus>
          {confirmLabel}
        </button>
      </div>
    </Modal>
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
  }, [open]);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onCreate(trimmed);
  };

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title="New workspace"
      cardClassName="modal-small"
    >
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
    </Modal>
  );
};
