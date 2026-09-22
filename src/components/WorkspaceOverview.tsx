import React, { useMemo, useState } from 'react';
import type { Workspace } from '../types';
import { docMatchesQuery } from '../utils/search';
import { IconDoc, IconBook, IconTrash, IconClose, IconPencil } from './Icons';

interface WorkspaceOverviewProps {
  workspace?: Workspace;
  searchQuery: string;
  notesCache?: Record<string, string>;
  onAddPdf: () => void;
  onSelectDoc: (wsId: string, docId: string) => void;
  onDeleteDoc?: (wsId: string, docId: string) => void;
  onDeleteWorkspace?: (wsId: string) => void;
  onRenameDoc?: (docId: string, title: string) => void;
  dragHandle?: React.ReactNode;
}

const baseName = (n?: string) => (n || '').replace(/\.pdf$/i, '');

const WorkspaceOverviewInner: React.FC<WorkspaceOverviewProps> = ({
  workspace,
  searchQuery,
  notesCache,
  onAddPdf,
  onSelectDoc,
  onDeleteDoc,
  onDeleteWorkspace,
  onRenameDoc,
  dragHandle,
}) => {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const commitRename = (docId: string, fallback: string) => {
    setRenamingId(null);
    if (renameValue.trim() && renameValue.trim() !== fallback) {
      onRenameDoc?.(docId, renameValue);
    }
  };
  const query = searchQuery.trim().toLowerCase();
  const docs = workspace?.docs || [];

  // Same predicate as the sidebar (name/title/tag/note body) so both views
  // agree. Safe to take notesCache: the overview is only visible when no
  // doc is open, i.e. exactly when no note keystrokes are happening.
  const matchedDocs = useMemo(() => {
    if (!query) return docs;
    const lowered = (id: string) => {
      const v = notesCache?.[id];
      return typeof v === 'string' ? v.toLowerCase() : undefined;
    };
    return docs.filter((d) => docMatchesQuery(d, query, lowered(d.id)));
  }, [docs, query, notesCache]);

  const docCount = docs.length;

  return (
    <div id="wsOverview" className="ws-overview">
      <div className="ws-ov-head" style={{ position: 'relative' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {dragHandle && <span className="drag-handle-wrapper">{dragHandle}</span>}
          <div>
            <h2 id="wsTitle">{workspace?.name || 'Workspace'}</h2>
            <div className="muted" id="wsSub">
              {docCount} document{docCount !== 1 ? 's' : ''}
            </div>
          </div>
        </div>
        <div className="ws-ov-actions">
          {workspace && (
            <button
              className="icon-btn small ws-ov-delete"
              title={`Delete workspace "${workspace.name}"`}
              onClick={() => onDeleteWorkspace?.(workspace.id)}
              type="button"
            >
              <IconTrash size={14} />
            </button>
          )}
          <button
            className="pill-btn add-btn"
            id="wsAddPdfBtn"
            onClick={onAddPdf}
            type="button"
          >
            Add PDF
          </button>
        </div>
      </div>

      {matchedDocs.length > 0 ? (
        <div id="wsGrid" className="ws-grid">
          {matchedDocs.map((d) => (
            <div
              key={d.id}
              className="ws-card"
              onClick={() => workspace && onSelectDoc(workspace.id, d.id)}
            >
              <button
                className="card-delete-btn"
                title={`Delete "${d.note_title || baseName(d.name)}"`}
                onClick={(e) => {
                  e.stopPropagation();
                  if (workspace) {
                    onDeleteDoc?.(workspace.id, d.id);
                  }
                }}
                type="button"
              >
                <IconClose size={12} />
              </button>
              {onRenameDoc && renamingId !== d.id && (
                <button
                  className="card-rename-btn"
                  title={`Rename "${d.note_title || baseName(d.name)}"`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setRenameValue(d.note_title || baseName(d.name));
                    setRenamingId(d.id);
                  }}
                  type="button"
                >
                  <IconPencil size={12} />
                </button>
              )}
              <div className="thumb">
                <IconDoc size={32} />
              </div>
              {renamingId === d.id ? (
                <input
                  className="inline-rename-input"
                  value={renameValue}
                  autoFocus
                  onFocus={(e) => e.target.select()}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={() => commitRename(d.id, d.note_title || baseName(d.name))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    if (e.key === 'Escape') setRenamingId(null);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  maxLength={120}
                />
              ) : (
                <b>{d.note_title || baseName(d.name)}</b>
              )}
              <small>{d.tag || 'PDF'} • Notes</small>
            </div>
          ))}
        </div>
      ) : query ? (
        <div id="wsEmpty" className="panel-empty">
          <div className="panel-empty-icon">
            <IconBook size={48} />
          </div>
          <h3>No matching documents</h3>
          <p>No documents in this workspace match “{searchQuery.trim()}”.</p>
        </div>
      ) : (
        <div id="wsEmpty" className="panel-empty">
          <div className="panel-empty-icon">
            <IconBook size={48} />
          </div>
          <h3>Welcome to Rsrch</h3>
          <p>Create a workspace, then add PDFs to read and take notes side by side.</p>
          <button
            className="pill-btn add-btn"
            id="wsEmptyAddBtn"
            onClick={onAddPdf}
            type="button"
          >
            Add your first PDF
          </button>
        </div>
      )}
    </div>
  );
};

export const WorkspaceOverview = React.memo(
  WorkspaceOverviewInner,
  (prev, next) => {
    return (
      prev.workspace === next.workspace &&
      prev.searchQuery === next.searchQuery &&
      prev.notesCache === next.notesCache
    );
  }
);

