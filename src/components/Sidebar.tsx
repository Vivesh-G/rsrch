import React, { useMemo, useState } from 'react';
import type { Workspace } from '../types';
import { buildLoweredNotes, docMatchesQuery } from '../utils/search';
import { getDocDisplayName, isLatexDoc } from '../utils/document';
import { InlineRenameInput } from './InlineRenameInput';
import { IconDoc, IconTrash, IconPlus, IconChevronLeft, IconChevronRight, IconLatex } from './Icons';

interface SidebarProps {
  workspaces: Workspace[];
  activeWsId: string | null;
  activeDocId: string | null;
  collapsed: boolean;
  searchQuery: string;
  notesCache: Record<string, string>;
  style?: React.CSSProperties;
  onToggleSidebar: () => void;
  onSelectWorkspace: (wsId: string) => void;
  onToggleWorkspaceExpand: (wsId: string) => void;
  onSelectDoc: (wsId: string, docId: string) => void;
  onCreateWorkspace: () => void;
  onAddDocToWorkspace: (wsId: string) => void;
  onAddLatexDocToWorkspace?: (wsId: string) => void;
  onDeleteWorkspace?: (wsId: string) => void;
  onDeleteDoc?: (docId: string) => void;
  onRenameDoc?: (docId: string, title: string) => void;
}

export const Sidebar: React.FC<SidebarProps> = React.memo(({
  workspaces,
  activeWsId,
  activeDocId,
  collapsed,
  searchQuery,
  notesCache,
  style,
  onToggleSidebar,
  onSelectWorkspace,
  onToggleWorkspaceExpand,
  onSelectDoc,
  onCreateWorkspace,
  onAddDocToWorkspace,
  onAddLatexDocToWorkspace,
  onDeleteWorkspace,
  onDeleteDoc,
  onRenameDoc,
}) => {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const query = searchQuery.trim().toLowerCase();

  // Pre-lowercase note contents once per cache change so per-keystroke
  // filtering doesn't call toLowerCase() on multi-KB notes for every doc.
  const loweredNotes = useMemo(
    () => (query ? buildLoweredNotes(notesCache) : null),
    [notesCache, query],
  );

  const filteredWorkspaces = useMemo(() => {
    if (!query) return null;
    return new Map(
      workspaces.map((w) => [
        w.id,
        w.docs.filter((d) => docMatchesQuery(d, query, loweredNotes?.[d.id])),
      ])
    );
  }, [workspaces, query, loweredNotes]);

  // Caret toggles expand only; row click selects. Previously both fired on
  // one click, so collapsing a workspace also kicked you out of the open doc
  // (select clears activeDocId).
  const handleCaretClick = (e: React.MouseEvent, wsId: string) => {
    e.stopPropagation();
    onToggleWorkspaceExpand(wsId);
  };

  const handleRowClick = (wsId: string) => {
    onToggleWorkspaceExpand(wsId);
    onSelectWorkspace(wsId);
  };

  return (
    <aside
      className={`sidebar ${collapsed ? 'collapsed' : ''}`}
      id="sidebar"
      style={style}
      aria-label="Workspace sidebar"
    >
      <div className="ws-head">
        <div className="ws-head-left">
          <button
            className="icon-btn small"
            id="sidebarToggle"
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
            aria-controls="wsTree"
            onClick={onToggleSidebar}
            type="button"
          >
            {collapsed ? <IconChevronRight size={13} /> : <IconChevronLeft size={13} />}
          </button>
          <span>Workspace</span>
        </div>
        <button
          className="icon-btn small"
          id="addWsBtn"
          title="Add workspace"
          aria-label="Add workspace"
          onClick={onCreateWorkspace}
          type="button"
        >
          <IconPlus size={11} />
        </button>
      </div>

      <div id="wsTree" className="ws-tree">
        {!workspaces.length ? (
          <div className="sidebar-empty">
            <span>No workspaces yet</span>
            <button className="linkish" onClick={onCreateWorkspace} type="button">
              + Create workspace
            </button>
          </div>
        ) : (
          workspaces.map((w) => {
            const isWsActive = !activeDocId && w.id === activeWsId;
            const matchedDocs = filteredWorkspaces ? filteredWorkspaces.get(w.id) || [] : w.docs;

            return (
              <div key={w.id} className="ws-group">
                <div
                  className={`ws-row ${isWsActive ? 'active' : ''}`}
                  onClick={() => handleRowClick(w.id)}
                >
                  <span className="ws-caret" onClick={(e) => handleCaretClick(e, w.id)}>
                    {w.expanded ? '▾' : '▸'}
                  </span>
                  <span className="ws-name">{w.name}</span>
                  <div className="ws-actions" onClick={(e) => e.stopPropagation()}>
                    {onAddLatexDocToWorkspace && (
                      <button
                        className="ws-action-btn"
                        title={`Add LaTeX Doc to ${w.name}`}
                        aria-label={`Add LaTeX Doc to ${w.name}`}
                        onClick={() => onAddLatexDocToWorkspace(w.id)}
                        type="button"
                      >
                        <IconLatex size={12} />
                      </button>
                    )}
                    <button
                      className="ws-action-btn"
                      title={`Add PDF to ${w.name}`}
                      aria-label={`Add PDF to ${w.name}`}
                      onClick={() => onAddDocToWorkspace(w.id)}
                      type="button"
                    >
                      <IconPlus size={12} />
                    </button>
                    <button
                      className="ws-action-btn ws-delete"
                      title={`Delete workspace "${w.name}"`}
                      aria-label={`Delete workspace "${w.name}"`}
                      onClick={() => onDeleteWorkspace?.(w.id)}
                      type="button"
                    >
                      <IconTrash size={12} />
                    </button>
                  </div>
                </div>

                {w.expanded && (
                  <div className="ws-docs">
                    {!matchedDocs.length && !query && (
                      <div className="ws-tree-empty-branch">
                        <span>No documents yet</span>
                      </div>
                    )}
                    {matchedDocs.map((d) => {
                      const isDocActive = d.id === activeDocId;
                      const title = getDocDisplayName(d);
                      return (
                        <div
                          key={d.id}
                          className={`doc-item-row ${isDocActive ? 'active' : ''}`}
                          onClick={() => onSelectDoc(w.id, d.id)}
                        >
                          {isLatexDoc(d) ? (
                            <IconLatex size={13} className="doc-icon" />
                          ) : (
                            <IconDoc size={13} className="doc-icon" />
                          )}
                          {renamingId === d.id ? (
                            <InlineRenameInput
                              className="inline-rename-input small"
                              initialValue={title}
                              onCommit={(nextTitle) => {
                                setRenamingId(null);
                                onRenameDoc?.(d.id, nextTitle);
                              }}
                              onCancel={() => setRenamingId(null)}
                            />
                          ) : (
                            <span
                              className="doc-label"
                              title={`${d.name}${onRenameDoc ? ' (double-click to rename)' : ''}`}
                              onDoubleClick={(e) => {
                                if (!onRenameDoc) return;
                                e.stopPropagation();
                                setRenamingId(d.id);
                              }}
                            >
                              {title}
                            </span>
                          )}
                          <button
                            className="doc-delete-btn"
                            title={`Delete "${title}"`}
                            aria-label={`Delete "${title}"`}
                            onClick={(e) => {
                              e.stopPropagation();
                              onDeleteDoc?.(d.id);
                            }}
                            type="button"
                          >
                            <IconTrash size={11} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
});
