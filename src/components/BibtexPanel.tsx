import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { Workspace } from '../types';
import { api } from '../services/api';
import { IconClose, IconPencil, IconCheck, IconSave } from './Icons';

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
  const [content, setContent] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!workspace) return;
    const fetchBibtex = async () => {
      try {
        const res = await fetch(`${api.baseUrl}/workspaces/${workspace.id}/bibtex`);
        if (res.ok) {
          const data = await res.json();
          setContent(data.content || '');
        }
      } catch (err) {
        console.error('Failed to fetch bibtex', err);
      }
    };
    fetchBibtex();
  }, [workspace]);

  const saveBibtex = useCallback(async (newContent: string) => {
    if (!workspace) return;
    setIsSaving(true);
    setSaveStatus('saving');
    try {
      const res = await fetch(`${api.baseUrl}/workspaces/${workspace.id}/bibtex`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: newContent }),
      });
      if (res.ok) {
        setSaveStatus('saved');
        setTimeout(() => setSaveStatus('idle'), 2000);
        window.dispatchEvent(new CustomEvent('rsrch:bibtex-updated'));
      }
    } catch (err) {
      console.error('Failed to save bibtex', err);
      setSaveStatus('idle');
    } finally {
      setIsSaving(false);
    }
  }, [workspace]);

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
            <button className="icon-btn small panel-close-btn" onClick={onClose}>
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
