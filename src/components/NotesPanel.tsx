import React, { useState, useRef, useEffect } from 'react';
import type { DocumentItem } from '../types';
import { LiveMarkdownEditor } from './LiveMarkdownEditor';
import {
  IconSave,
  IconCheck,
  IconDownload,
  IconCalendar,
  IconPencil,
  IconClose,
  IconPlus,
} from './Icons';

interface NotesPanelProps {
  doc: DocumentItem | null;
  noteContent: string;
  style?: React.CSSProperties;
  saveStatus?: 'saved' | 'saving' | 'idle';
  lastSavedTime?: string | null;
  onNoteChange: (content: string) => void;
  onManualSave?: (content?: string) => void;
  onTagChange: (newTag: string) => void;
  dragHandle?: React.ReactNode;
}

const PRESET_TAGS = ['General', 'NLP', 'Architecture', 'Foundations', 'Strategy', 'ML'];

function tagClass(tag?: string): string {
  const key = (tag || '').toLowerCase();
  const map: Record<string, string> = {
    nlp: 'tag-nlp',
    architecture: 'tag-architecture',
    foundations: 'tag-foundations',
    strategy: 'tag-strategy',
    ml: 'tag-ml',
    uploaded: 'tag-uploaded',
    general: 'tag-uploaded',
  };
  return map[key] || 'tag-uploaded';
}

function getDocDate(d?: DocumentItem | null): string {
  if (d?.added_at) {
    const ms = d.added_at > 1e11 ? d.added_at : d.added_at * 1000;
    return new Date(ms).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }
  return new Date().toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

const baseName = (n?: string) => (n || '').replace(/\.pdf$/i, '');

const NotesPanelInner: React.FC<NotesPanelProps> = ({
  doc,
  noteContent,
  style,
  saveStatus = 'idle',
  lastSavedTime,
  onNoteChange,
  onManualSave,
  onTagChange,
  dragHandle,
}) => {
  const [wordCount, setWordCount] = useState<number>(0);
  const [isTagMenuOpen, setIsTagMenuOpen] = useState<boolean>(false);
  const [customTagInput, setCustomTagInput] = useState<string>('');
  const tagMenuRef = useRef<HTMLDivElement>(null);

  const isInactive = !doc;

  const externalTitle = doc ? doc.note_title || baseName(doc.name) : '';
  const currentTitle = externalTitle;

  // Close tag menu on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (tagMenuRef.current && !tagMenuRef.current.contains(e.target as Node)) {
        setIsTagMenuOpen(false);
      }
    };
    if (isTagMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isTagMenuOpen]);

  const handleSelectTag = (tag: string) => {
    onTagChange(tag);
    setIsTagMenuOpen(false);
    setCustomTagInput('');
  };

  const handleCustomTagSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (customTagInput.trim()) {
      handleSelectTag(customTagInput.trim());
    }
  };





  const handleDownloadNote = () => {
    if (!doc) return;
    const safeName =
      (currentTitle.trim() || 'note').replace(/[\\/:*?"<>|]/g, '').slice(0, 100) || 'note';
    const blob = new Blob([noteContent], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeName}.md`;
    // Appended (not detached) so Firefox/Safari honor the click.
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    // Persist the same snapshot that was downloaded.
    onManualSave?.(noteContent);
  };

  return (
    <aside
      className={`notes ${isInactive ? 'is-inactive' : ''}`}
      id="notesPanel"
      style={style}
    >
      <div className="notes-placeholder">
        <div className="panel-empty-icon">
          <IconPencil size={36} />
        </div>
        <h3>Notes</h3>
        <p>Select a document to start writing markdown notes.</p>
      </div>

      <div className="notes-content">
        <div className="notes-head" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {dragHandle && <span className="drag-handle-wrapper">{dragHandle}</span>}
            <div className="notes-meta">
              <div className="crumbs">
                <span>Notes</span>
                <span className="crumb-sep">/</span>
                <b id="crumbLabel" className="crumb-title" title={currentTitle} style={{ fontSize: '14px' }}>
                  {currentTitle || '—'}
                </b>
              </div>
            </div>
          </div>
          <div className="notes-actions" style={{ display: 'flex', gap: '8px' }}>
            <button
              className={`icon-btn small save-btn ${saveStatus === 'saved' ? 'is-saved' : ''}`}
              id="saveBtn"
              title="Save note (Ctrl+S)"
              onClick={() => onManualSave?.(noteContent)}
              type="button"
            >
              {saveStatus === 'saved' ? <IconCheck size={13} /> : <IconSave size={13} />}
            </button>
            <button
              className="icon-btn small"
              id="downloadNoteBtn"
              title="Download note as Markdown"
              onClick={handleDownloadNote}
              type="button"
            >
              <IconDownload size={13} />
            </button>
          </div>
        </div>

        <div className="meta">
          <span className="date" id="noteDate">
            <IconCalendar size={12} className="meta-icon" />
            <span>{getDocDate(doc)}</span>
          </span>

          <div className="tag-picker-wrap" ref={tagMenuRef}>
            <span
              className={`tag ${tagClass(doc?.tag)}`}
              id="metaTag"
              title="Click to change category tag"
              onClick={() => setIsTagMenuOpen((prev) => !prev)}
            >
              {doc?.tag || 'General'}
            </span>

            {isTagMenuOpen && (
              <div className="tag-dropdown-menu">
                <div className="tag-dropdown-head">
                  <span>Category Tags</span>
                  <button
                    className="tag-dropdown-close"
                    onClick={() => setIsTagMenuOpen(false)}
                    type="button"
                  >
                    <IconClose size={10} />
                  </button>
                </div>
                <div className="tag-dropdown-presets">
                  {PRESET_TAGS.map((t) => (
                    <button
                      key={t}
                      className={`tag-preset-btn ${tagClass(t)} ${
                        (doc?.tag || 'General').toLowerCase() === t.toLowerCase() ? 'selected' : ''
                      }`}
                      onClick={() => handleSelectTag(t)}
                      type="button"
                    >
                      {t}
                    </button>
                  ))}
                </div>
                <form className="tag-custom-form" onSubmit={handleCustomTagSubmit}>
                  <input
                    type="text"
                    placeholder="Custom tag…"
                    value={customTagInput}
                    onChange={(e) => setCustomTagInput(e.target.value)}
                    autoFocus
                  />
                  <button type="submit" title="Add custom tag">
                    <IconPlus size={12} />
                  </button>
                </form>
              </div>
            )}
          </div>

          {saveStatus && saveStatus !== 'idle' && (
            <span className={`save-badge ${saveStatus}`} id="saveBadge">
              {saveStatus === 'saving' ? (
                <span>Saving…</span>
              ) : (
                <>
                  <IconCheck size={11} />
                  <span>Saved {lastSavedTime ? ' ' + lastSavedTime : ''}</span>
                </>
              )}
            </span>
          )}

          <span className="meta-right" id="wordCount">
            {wordCount} words
          </span>
        </div>

        {doc && (
          <LiveMarkdownEditor
            content={noteContent}
            onChange={onNoteChange}
            onManualSave={onManualSave}
            onWordCountChange={setWordCount}
          />
        )}
      </div>
    </aside>
  );
};

export const NotesPanel: React.FC<NotesPanelProps> = React.memo(
  NotesPanelInner,
  (prev, next) => {
    const a = prev.doc;
    const b = next.doc;
    if (a?.id !== b?.id) return false;
    if ((a?.note_title || '') !== (b?.note_title || '')) return false;
    if ((a?.tag || '') !== (b?.tag || '')) return false;
    if ((a?.name || '') !== (b?.name || '')) return false;
    if (!!a?.has_file !== !!b?.has_file) return false;
    if ((a?.file ?? null) !== (b?.file ?? null)) return false;
    return (
      prev.noteContent === next.noteContent &&
      prev.saveStatus === next.saveStatus &&
      prev.lastSavedTime === next.lastSavedTime &&
      prev.style === next.style &&
      prev.onNoteChange === next.onNoteChange &&
      prev.onManualSave === next.onManualSave &&
      prev.onTitleChange === next.onTitleChange &&
      prev.onTagChange === next.onTagChange
    );
  }
);
