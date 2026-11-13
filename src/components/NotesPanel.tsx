import React, { useState, useRef, useCallback } from 'react';
import type { DocumentItem } from '../types';
import { getDocDisplayName, cleanDocName, isLatexDoc } from '../utils/document';
import { toMs, triggerDownloadBlob } from '../utils/dom';
import { useOutsideClick } from '../hooks/useOutsideClick';
import { LiveMarkdownEditor } from './LiveMarkdownEditor';
import { CodeMirrorLatexEditor } from './CodeMirrorLatexEditor';
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
  saveStatus?: 'saved' | 'saving' | 'idle' | 'error';
  lastSavedTime?: string | null;
  editorWordWrap?: boolean;
  editorLineNumbers?: boolean;
  onNoteChange: (content: string) => void;
  onManualSave?: (content?: string) => void;
  onTagChange: (newTag: string) => void;
  onClose?: () => void;
  dragHandle?: React.ReactNode;
}

const PRESET_TAGS = ['General', 'NLP', 'Architecture', 'Foundations', 'Strategy', 'ML'];
const MAX_TAG_LEN = 30;

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
  const ms = d?.added_at && Number.isFinite(d.added_at) ? toMs(d.added_at) : Date.now();
  return new Date(ms).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

const NotesPanelInner: React.FC<NotesPanelProps> = ({
  doc,
  noteContent,
  style,
  saveStatus = 'idle',
  lastSavedTime,
  editorWordWrap = true,
  editorLineNumbers = true,
  onNoteChange,
  onManualSave,
  onTagChange,
  onClose,
  dragHandle,
}) => {
  const [wordCount, setWordCount] = useState<number>(0);
  const [isTagMenuOpen, setIsTagMenuOpen] = useState<boolean>(false);
  const [customTagInput, setCustomTagInput] = useState<string>('');
  const tagMenuRef = useRef<HTMLDivElement>(null);

  const isInactive = !doc;
  const latexDoc = isLatexDoc(doc);
  const currentTitle = doc ? getDocDisplayName(doc) : '';

  const closeTagMenu = useCallback(() => setIsTagMenuOpen(false), []);
  useOutsideClick(tagMenuRef, isTagMenuOpen, closeTagMenu);

  const handleSelectTag = (tag: string) => {
    const clean = tag.trim().slice(0, MAX_TAG_LEN);
    if (!clean) return;
    onTagChange(clean);
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
    const ext = latexDoc ? '.tex' : '.md';
    const mime = latexDoc ? 'text/x-tex;charset=utf-8' : 'text/markdown;charset=utf-8';
    const base = cleanDocName(currentTitle).trim() || 'document';
    const safeName = base.replace(/[\\/:*?"<>|]/g, '').slice(0, 100) || 'document';
    triggerDownloadBlob(noteContent, `${safeName}${ext}`, mime);
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
        {onClose && (
          <button
            className="icon-btn small panel-close-btn notes-placeholder-close"
            id="closeInactiveNotesBtn"
            title="Close Notes panel (move to right sidebar)"
            aria-label="Close Notes panel"
            onClick={onClose}
            type="button"
          >
            <IconClose size={13} />
          </button>
        )}
        <div className="panel-empty-icon">
          <IconPencil size={36} />
        </div>
        <h3>Notes</h3>
        <p>Select a document to start writing markdown notes or LaTeX.</p>
      </div>

      <div className="notes-content">
        <div className="notes-head" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px', minWidth: 0, gap: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, flex: 1, overflow: 'hidden' }}>
            {dragHandle && <span className="drag-handle-wrapper" style={{ flexShrink: 0 }}>{dragHandle}</span>}
            <div className="notes-meta" style={{ minWidth: 0, flex: 1, overflow: 'hidden' }}>
              <div className="crumbs" style={{ minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', display: 'flex', alignItems: 'center', gap: '4px' }}>
                <span style={{ flexShrink: 0 }}>{latexDoc ? 'LaTeX' : 'Notes'}</span>
                <span className="crumb-sep" style={{ flexShrink: 0 }}>/</span>
                <b id="crumbLabel" className="crumb-title" title={currentTitle} style={{ fontSize: '14px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }}>
                  {currentTitle || '—'}
                </b>
              </div>
            </div>
          </div>
          <div className="notes-actions" style={{ display: 'flex', gap: '6px', flexShrink: 0, marginLeft: 'auto' }}>
            <button
              className={`icon-btn small save-btn ${saveStatus === 'saved' ? 'is-saved' : ''}`}
              id="saveBtn"
              title="Save note (Ctrl+S)"
              aria-label="Save note"
              onClick={() => onManualSave?.(noteContent)}
              type="button"
            >
              {saveStatus === 'saved' ? <IconCheck size={13} /> : <IconSave size={13} />}
            </button>
            <button
              className="icon-btn small"
              id="downloadNoteBtn"
              title={latexDoc ? 'Download LaTeX source (.tex)' : 'Download note as Markdown'}
              aria-label={latexDoc ? 'Download LaTeX source' : 'Download note as Markdown'}
              onClick={handleDownloadNote}
              type="button"
            >
              <IconDownload size={13} />
            </button>
            {onClose && (
              <button
                className="icon-btn small panel-close-btn"
                id="closeNotesBtn"
                title="Close Notes panel (move to right sidebar)"
                aria-label="Close Notes panel"
                onClick={onClose}
                type="button"
              >
                <IconClose size={13} />
              </button>
            )}
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
                    placeholder="Enter custom tag…"
                    aria-label="Custom tag"
                    value={customTagInput}
                    onChange={(e) => setCustomTagInput(e.target.value.slice(0, MAX_TAG_LEN))}
                    maxLength={MAX_TAG_LEN}
                    autoFocus
                  />
                  <button type="submit" title="Add custom tag" aria-label="Add custom tag">
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
              ) : saveStatus === 'error' ? (
                <span>{latexDoc ? 'Build failed' : 'Save failed'}</span>
              ) : (
                <>
                  <IconCheck size={11} />
                  <span>Saved{lastSavedTime ? ' ' + lastSavedTime : ''}</span>
                </>
              )}
            </span>
          )}

          <span className="meta-right" id="wordCount">
            {wordCount} words
          </span>
        </div>

        {doc && latexDoc ? (
          <CodeMirrorLatexEditor
            docId={doc.id}
            workspaceId={doc.workspace_id}
            content={noteContent}
            wordWrap={editorWordWrap}
            lineNumbers={editorLineNumbers}
            onChange={onNoteChange}
            onManualSave={onManualSave}
            onWordCountChange={setWordCount}
          />
        ) : doc ? (
          <LiveMarkdownEditor
            content={noteContent}
            onChange={onNoteChange}
            onManualSave={onManualSave}
            onWordCountChange={setWordCount}
          />
        ) : null}
      </div>
    </aside>
  );
};

export const NotesPanel: React.FC<NotesPanelProps> = React.memo(NotesPanelInner);
