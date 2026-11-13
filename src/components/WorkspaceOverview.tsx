import React, { useMemo, useState } from 'react';
import type { Workspace } from '../types';
import { buildLoweredNotes, docMatchesQuery } from '../utils/search';
import { getDocDisplayName, isLatexDoc } from '../utils/document';
import { useFileDrop } from '../hooks/useFileDrop';
import { InlineRenameInput } from './InlineRenameInput';
import { IconDoc, IconBook, IconTrash, IconClose, IconPencil, IconLatex } from './Icons';

interface WorkspaceOverviewProps {
  workspace?: Workspace;
  searchQuery: string;
  notesCache?: Record<string, string>;
  onAddPdf: () => void;
  onDropFiles?: (files: File[]) => void;
  onSelectDoc: (wsId: string, docId: string) => void;
  onDeleteDoc?: (docId: string) => void;
  onDeleteWorkspace?: (wsId: string) => void;
  onRenameDoc?: (docId: string, title: string) => void;
  onClose?: () => void;
  dragHandle?: React.ReactNode;
}

const WorkspaceOverviewInner: React.FC<WorkspaceOverviewProps> = ({
  workspace,
  searchQuery,
  notesCache,
  onAddPdf,
  onDropFiles,
  onSelectDoc,
  onDeleteDoc,
  onDeleteWorkspace,
  onRenameDoc,
  onClose,
  dragHandle,
}) => {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const query = searchQuery.trim().toLowerCase();
  const docs = workspace?.docs || [];

  const { dragActive: isDraggingOver, handleDrag, handleDrop } = useFileDrop((files) => {
    onDropFiles?.(files);
  });

  // Same predicate as the sidebar (name/title/tag/note body) so both views
  // agree. Safe to take notesCache: the overview is only visible when no
  // doc is open, i.e. exactly when no note keystrokes are happening.
  const loweredNotes = useMemo(
    () => (query ? buildLoweredNotes(notesCache) : {}),
    [notesCache, query],
  );
  const matchedDocs = useMemo(() => {
    if (!query) return docs;
    return docs.filter((d) => docMatchesQuery(d, query, loweredNotes[d.id]));
  }, [docs, query, loweredNotes]);

  const docCount = docs.length;

  return (
    <div
      id="wsOverview"
      className={`ws-overview ${isDraggingOver ? 'drag-over' : ''}`}
      style={{ position: 'relative' }}
      onDragEnter={handleDrag}
      onDragOver={handleDrag}
      onDragLeave={handleDrag}
      onDrop={handleDrop}
    >
      {isDraggingOver && (
        <div className="drop-hint">Drop PDF here to add to workspace</div>
      )}
      <div className="ws-ov-head" style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'space-between', minWidth: 0, gap: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0, flex: 1, overflow: 'hidden' }}>
          {dragHandle && <span className="drag-handle-wrapper" style={{ flexShrink: 0 }}>{dragHandle}</span>}
          <div style={{ minWidth: 0, overflow: 'hidden' }}>
            <h2 id="wsTitle" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', margin: 0 }}>{workspace?.name || 'Workspace'}</h2>
            <div className="muted" id="wsSub" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontSize: '11.5px' }}>
              {docCount} document{docCount !== 1 ? 's' : ''}
            </div>
          </div>
        </div>
        <div className="ws-ov-actions" style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0, marginLeft: 'auto' }}>
          {workspace && (
            <button
              className="icon-btn small ws-ov-delete"
              title={`Delete workspace "${workspace.name}"`}
              aria-label={`Delete workspace "${workspace.name}"`}
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
          {onClose && (
            <button
              className="icon-btn small panel-close-btn"
              id="closeOverviewBtn"
              title="Close PDF viewer (move to right sidebar)"
              aria-label="Close PDF viewer panel"
              onClick={onClose}
              type="button"
            >
              <IconClose size={13} />
            </button>
          )}
        </div>
      </div>

      {matchedDocs.length > 0 ? (
        <div id="wsGrid" className="ws-grid">
          {matchedDocs.map((d) => {
            const displayName = getDocDisplayName(d);
            return (
              <div
                key={d.id}
                className="ws-card"
                onClick={() => workspace && onSelectDoc(workspace.id, d.id)}
              >
                <button
                  className="card-delete-btn"
                  title={`Delete "${displayName}"`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (workspace) {
                      onDeleteDoc?.(d.id);
                    }
                  }}
                  type="button"
                >
                  <IconClose size={12} />
                </button>
                {onRenameDoc && renamingId !== d.id && (
                  <button
                    className="card-rename-btn"
                    title={`Rename "${displayName}"`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setRenamingId(d.id);
                    }}
                    type="button"
                  >
                    <IconPencil size={12} />
                  </button>
                )}
                <div className="thumb">
                  {isLatexDoc(d) ? <IconLatex size={32} /> : <IconDoc size={32} />}
                </div>
                {renamingId === d.id ? (
                  <InlineRenameInput
                    className="inline-rename-input"
                    initialValue={displayName}
                    onCommit={(nextTitle) => {
                      setRenamingId(null);
                      onRenameDoc?.(d.id, nextTitle);
                    }}
                    onCancel={() => setRenamingId(null)}
                  />
                ) : (
                  <b>{displayName}</b>
                )}
                <small>{isLatexDoc(d) ? 'LaTeX • Code' : `${d.tag || 'PDF'} • Notes`}</small>
              </div>
            );
          })}
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

export const WorkspaceOverview = React.memo(WorkspaceOverviewInner);

