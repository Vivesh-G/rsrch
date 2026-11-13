import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { Workspace } from '../types';
import { api } from '../services/api';
import { emitEvent } from '../utils/events';
import { IconClose, IconCheck, IconSave } from './Icons';

interface BibtexPanelProps {
  workspace: Workspace | null;
  style?: React.CSSProperties;
  onClose?: () => void;
  dragHandle?: React.ReactNode;
}

export const BibtexPanel: React.FC<BibtexPanelProps> = ({
  workspace,
  style,
  onClose,
  dragHandle,
}) => {
  const workspaceId = workspace?.id ?? null;
  const [content, setContent] = useState('');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!workspaceId) {
      setContent('');
      return;
    }
    let mounted = true;
    api
      .getBibtex(workspaceId)
      .then((text) => {
        if (mounted) setContent(text);
      })
      .catch((err) => {
        console.error('Failed to fetch bibtex', err);
        if (mounted) setContent('');
      });
    return () => {
      mounted = false;
    };
  }, [workspaceId]);

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  const saveBibtex = useCallback(async (newContent: string) => {
    if (!workspaceId) return;
    setSaveStatus('saving');
    try {
      await api.saveBibtex(workspaceId, newContent);
      setSaveStatus('saved');
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setSaveStatus('idle'), 2000);
      emitEvent('bibtex-updated');
    } catch (err) {
      console.error('Failed to save bibtex', err);
      setSaveStatus('idle');
    }
  }, [workspaceId]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setContent(val);
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      saveBibtex(val);
    }, 1000);
  };

  const handleManualSave = () => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    saveBibtex(content);
  };

  if (!workspace) {
    return (
      <aside className="notes is-inactive" style={style}>
        <div className="notes-placeholder">
          {onClose && (
            <button className="icon-btn small panel-close-btn" onClick={onClose} type="button">
              <IconClose size={13} />
            </button>
          )}
          <h3>Bibliography</h3>
          <p>Select a workspace to manage references.bib.</p>
        </div>
      </aside>
    );
  }

  return (
    <aside className="notes" style={style}>
      <div className="notes-content">
        <div className="notes-head" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px', minWidth: 0, gap: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, flex: 1, overflow: 'hidden' }}>
            {dragHandle && <span className="drag-handle-wrapper" style={{ flexShrink: 0 }}>{dragHandle}</span>}
            <div className="notes-meta" style={{ minWidth: 0, flex: 1, overflow: 'hidden' }}>
              <div className="crumbs" style={{ minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', display: 'flex', alignItems: 'center', gap: '4px' }}>
                <span style={{ flexShrink: 0 }}>BibTeX</span>
                <span className="crumb-sep" style={{ flexShrink: 0 }}>/</span>
                <b className="crumb-title" style={{ fontSize: '14px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }}>
                  references.bib
                </b>
              </div>
            </div>
            {saveStatus !== 'idle' && (
              <span className={`save-badge ${saveStatus}`} style={{ marginLeft: '8px', flexShrink: 0 }}>
                {saveStatus === 'saving' ? 'Saving...' : <><IconCheck size={11} /> Saved</>}
              </span>
            )}
          </div>
          <div className="notes-actions" style={{ display: 'flex', gap: '6px', flexShrink: 0, marginLeft: 'auto' }}>
            <button
              className={`icon-btn small save-btn ${saveStatus === 'saved' ? 'is-saved' : ''}`}
              onClick={handleManualSave}
              title="Save BibTeX"
              type="button"
            >
              {saveStatus === 'saved' ? <IconCheck size={13} /> : <IconSave size={13} />}
            </button>
            {onClose && (
              <button className="icon-btn small panel-close-btn" onClick={onClose} aria-label="Close Bibliography" type="button">
                <IconClose size={13} />
              </button>
            )}
          </div>
        </div>

        <textarea
          value={content}
          onChange={handleChange}
          style={{
            flex: 1,
            width: '100%',
            resize: 'none',
            padding: '12px',
            backgroundColor: 'var(--surface-subtle)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border)',
            borderRadius: '6px',
            fontFamily: 'var(--font-mono, monospace)',
            fontSize: '13px',
            outline: 'none',
          }}
          placeholder="@article{key,\n  title={...},\n  author={...},\n  year={...}\n}"
        />
      </div>
    </aside>
  );
};
