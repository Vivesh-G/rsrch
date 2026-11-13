import React, { useEffect, useRef, useState } from 'react';

interface InlineRenameInputProps {
  initialValue: string;
  onCommit: (nextValue: string) => void;
  onCancel: () => void;
  className?: string;
  maxLength?: number;
}

export const InlineRenameInput: React.FC<InlineRenameInputProps> = ({
  initialValue,
  onCommit,
  onCancel,
  className = '',
  maxLength = 120,
}) => {
  const [draft, setDraft] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== initialValue.trim()) {
      onCommit(trimmed);
    } else {
      onCancel();
    }
  };

  return (
    <input
      ref={inputRef}
      className={className}
      value={draft}
      maxLength={maxLength}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
    />
  );
};

