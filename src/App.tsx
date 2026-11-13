import React, { useState, useEffect, useRef, useCallback, useMemo, useDeferredValue, Suspense, lazy } from 'react';
import { Reorder, useDragControls } from 'framer-motion';
import type { AppSettings } from './types';
import { DEFAULT_SETTINGS, PANEL_IDS, type PanelId } from './config/defaults';
import { api } from './services/api';
import { onEvent, queuePendingInverseSync } from './utils/events';
import { readRawStored, readStoredJson, STORAGE_KEYS, writeRawStored, writeStoredJson } from './utils/storage';
import { usePanelLayout } from './hooks/usePanelLayout';
import { useWorkspaces } from './hooks/useWorkspaces';
import { useNotes } from './hooks/useNotes';
import { TopBar } from './components/TopBar';
import { Sidebar } from './components/Sidebar';
import { Resizer } from './components/Resizer';
import { WorkspaceOverview } from './components/WorkspaceOverview';
import { NotesPanel } from './components/NotesPanel';
import { AssetsPanel } from './components/AssetsPanel';
import { BibtexPanel } from './components/BibtexPanel';
import { ChatPanel } from './components/ChatPanel';
import { ConfirmModal, NewWorkspaceModal } from './components/Modals';
import { SettingsModal } from './components/SettingsModal';
import { ErrorBoundary } from './components/ErrorBoundary';
import { RightSidebar, type PanelNavItem } from './components/RightSidebar';
import { IconDragHandle, IconDoc, IconChat, IconPencil, IconBook, IconFolder, IconRef } from './components/Icons';

// Code-split the heavy PDF viewer so initial load
// stays fast; it loads on first document open.
const DocViewer = lazy(() =>
  import('./components/DocViewer').then((m) => ({ default: m.DocViewer }))
);

// Stable empty map: when no search is active the sidebar doesn't need note
// contents, so pass this instead of notesCache to keep its memo from
// invalidating (and re-rendering every row) on each note keystroke.
const EMPTY_NOTES_CACHE: Record<string, string> = {};
const FULL_PANEL_STYLE: React.CSSProperties = { width: '100%', height: '100%' };

interface PanelMeta {
  label: string;
  buttonId: string;
  icon: React.ReactNode;
  wrapperClass?: string;
  zIndex?: number;
}

const PANEL_META: Record<PanelId, PanelMeta> = {
  viewer: { label: 'PDF Viewer', buttonId: 'sidebarBtnViewer', icon: <IconDoc size={17} />, wrapperClass: 'viewer', zIndex: 0 },
  chat: { label: 'AI Chat', buttonId: 'sidebarBtnChat', icon: <IconChat size={17} /> },
  notes: { label: 'Notes', buttonId: 'sidebarBtnNotes', icon: <IconPencil size={17} /> },
  assets: { label: 'Assets', buttonId: 'sidebarBtnAssets', icon: <IconFolder size={17} /> },
  bibtex: { label: 'BibTeX', buttonId: 'sidebarBtnBibtex', icon: <IconRef size={17} /> },
};

interface PanelWrapperProps {
  id: string;
  style?: React.CSSProperties;
  className?: string;
  resizer?: React.ReactNode;
  onMove?: (id: string, dir: -1 | 1) => void;
  children: (dragHandle: React.ReactNode) => React.ReactNode;
}

const PanelWrapper = React.forwardRef<HTMLLIElement, PanelWrapperProps>(
  ({ id, style, children, className, resizer, onMove }, ref) => {
    const controls = useDragControls();
    // Memoized so child React.memo comparators see a stable reference
    // instead of a fresh JSX node on every App render.
    const dragHandleNode = useMemo(
      () => (
        <div
          role="button"
          tabIndex={0}
          aria-label={`Reorder ${id} panel. Press left or right arrow to move.`}
          onPointerDown={(e) => controls.start(e)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
              e.preventDefault();
              onMove?.(id, e.key === 'ArrowLeft' ? -1 : 1);
            }
          }}
          style={{ display: 'flex', touchAction: 'none', cursor: 'grab' }}
        >
          <IconDragHandle />
        </div>
      ),
      [id, controls, onMove],
    );
    return (
      <Reorder.Item
        value={id}
        id={id}
        ref={ref}
        style={{ ...style, position: 'relative', height: '100%', display: 'flex', flexDirection: 'row' }}
        dragListener={false}
        dragControls={controls}
        className={className}
        layout="position"
      >
        {resizer}
        <div style={{ flex: 1, display: 'flex', minWidth: 0, flexDirection: 'column', height: '100%' }}>
          {children(dragHandleNode)}
        </div>
      </Reorder.Item>
    );
  },
);

PanelWrapper.displayName = 'PanelWrapper';

export const App: React.FC = () => {
  const [searchQuery, setSearchQuery] = useState('');
  const deferredSearchQuery = useDeferredValue(searchQuery);

  const [settings, setSettings] = useState<AppSettings>(() => ({
    ...DEFAULT_SETTINGS,
    ...readStoredJson<Partial<AppSettings>>(STORAGE_KEYS.settings, {}),
  }));
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isFirstRun, setIsFirstRun] = useState(false);
  const [pendingChatSend, setPendingChatSend] = useState<string | null>(null);

  const layout = usePanelLayout();

  const noteActionsRef = useRef<{ seed: (n: Record<string, string>) => void; clear: (id: string) => void }>({
    seed: () => {},
    clear: () => {},
  });
  const seedNotesProxy = useCallback((n: Record<string, string>) => noteActionsRef.current.seed(n), []);
  const clearNoteProxy = useCallback((id: string) => noteActionsRef.current.clear(id), []);

  const ws = useWorkspaces({
    onSeedNotes: seedNotesProxy,
    onDocDeleted: clearNoteProxy,
  });

  const notes = useNotes({
    activeDocId: ws.activeDocId,
    activeDocName: ws.activeDocName,
    activeDocIdRef: ws.activeDocIdRef,
    workspacesRef: ws.workspacesRef,
    autoCompileDelay: settings.auto_compile_delay,
  });
  noteActionsRef.current.seed = notes.seedNotes;
  noteActionsRef.current.clear = notes.clearNote;

  // Load settings from backend on startup, and trigger first-run modal if not onboarded
  useEffect(() => {
    let mounted = true;
    api
      .getSettings()
      .then((backendSettings) => {
        if (!mounted) return;
        setSettings((prev) => {
          const merged = { ...prev, ...backendSettings };
          writeStoredJson(STORAGE_KEYS.settings, merged);
          return merged;
        });
        const onboarded = readRawStored(STORAGE_KEYS.onboarded);
        if (!onboarded && !backendSettings.gemini_api_key_set) {
          setIsFirstRun(true);
          setIsSettingsOpen(true);
        }
      })
      .catch(() => {
        if (!readRawStored(STORAGE_KEYS.onboarded)) {
          setIsFirstRun(true);
          setIsSettingsOpen(true);
        }
      });
    return () => {
      mounted = false;
    };
  }, []);

  // Update CSS variables when settings change (like font size)
  useEffect(() => {
    document.documentElement.style.setProperty(
      '--editor-font-size',
      `${settings.editor_font_size ?? DEFAULT_SETTINGS.editor_font_size}px`,
    );
  }, [settings.editor_font_size]);

  const handleSaveSettings = useCallback(async (updated: Partial<AppSettings>) => {
    const saved = await api.updateSettings(updated);
    setSettings(saved);
    writeStoredJson(STORAGE_KEYS.settings, saved);
    writeRawStored(STORAGE_KEYS.onboarded, 'true');
    setIsFirstRun(false);
  }, []);

  // Message queued by an out-of-chat 'rsrch:chat-send' (editor "Fix with AI").
  useEffect(() => {
    return onEvent('chat-send', (detail) => {
      if (typeof detail?.message !== 'string' || !detail.message.trim()) return;
      setPendingChatSend(detail.message);
      layout.setPanelOpen('chat', true);
    });
  }, [layout.setPanelOpen]);

  // Inverse-search fallback: open Notes panel and queue SyncTeX target if closed.
  const isNotesOpenRef = useRef(layout.openPanels.notes);
  isNotesOpenRef.current = layout.openPanels.notes;
  useEffect(() => {
    return onEvent('inverse-sync', (detail) => {
      if (!detail?.docId || detail.docId !== ws.activeDocIdRef.current) return;
      if (isNotesOpenRef.current) return;
      queuePendingInverseSync(detail);
      layout.setPanelOpen('notes', true);
    });
  }, [ws.activeDocIdRef, layout.setPanelOpen]);

  const rightSidebarItems = useMemo<PanelNavItem[]>(
    () =>
      PANEL_IDS.map((id) => ({
        id,
        label: PANEL_META[id].label,
        buttonId: PANEL_META[id].buttonId,
        icon: PANEL_META[id].icon,
        isOpen: layout.openPanels[id],
        onToggle: () => layout.togglePanel(id),
      })),
    [layout.openPanels, layout.togglePanel],
  );

  const handleSearchChange = useCallback((q: string) => setSearchQuery(q), []);
  const handleNewDocument = useCallback(() => ws.openFilePicker(), [ws.openFilePicker]);
  const handleCloseViewer = useCallback(() => layout.setPanelOpen('viewer', false), [layout.setPanelOpen]);
  const handleCloseChat = useCallback(() => layout.setPanelOpen('chat', false), [layout.setPanelOpen]);
  const handleCloseNotes = useCallback(() => layout.setPanelOpen('notes', false), [layout.setPanelOpen]);
  const handleCloseAssets = useCallback(() => layout.setPanelOpen('assets', false), [layout.setPanelOpen]);
  const handleCloseBibtex = useCallback(() => layout.setPanelOpen('bibtex', false), [layout.setPanelOpen]);
  const handleToggleChat = useCallback(() => layout.togglePanel('chat'), [layout.togglePanel]);

  const sidebarStyle = useMemo(
    () => ({ width: layout.sidebarCollapsed ? undefined : `${layout.sidebarWidth}px` }),
    [layout.sidebarCollapsed, layout.sidebarWidth],
  );
  const noteContent = ws.activeDocId ? notes.notesCache[ws.activeDocId] || '' : '';
  // Sidebar only scans note bodies while a query is active; otherwise hand
  // it a stable empty object so note keystrokes don't re-render the tree.
  const sidebarNotesCache = deferredSearchQuery.trim() ? notes.notesCache : EMPTY_NOTES_CACHE;

  const renderPanelContent = (panelId: PanelId, dragHandle: React.ReactNode) => {
    switch (panelId) {
      case 'viewer':
        return (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%' }}>
            {!ws.activeDocId ? (
              <WorkspaceOverview
                workspace={ws.activeWorkspace}
                searchQuery={deferredSearchQuery}
                notesCache={sidebarNotesCache}
                onAddPdf={handleNewDocument}
                onDropFiles={ws.handleDropFiles}
                onSelectDoc={ws.selectDoc}
                onDeleteDoc={ws.requestDeleteDoc}
                onDeleteWorkspace={ws.requestDeleteWorkspace}
                onRenameDoc={ws.handleRenameDoc}
                onClose={handleCloseViewer}
                dragHandle={dragHandle}
              />
            ) : (
              <ErrorBoundary
                resetKey={ws.activeDocId}
                fallback={<div className="pdf-loading-spinner"><span>This document couldn't be displayed.</span></div>}
              >
                <Suspense fallback={<div className="pdf-loading-spinner"><span>Loading viewer…</span></div>}>
                  <DocViewer
                    doc={ws.activeDoc}
                    onToggleBookmark={ws.handleToggleBookmark}
                    onDeleteDoc={ws.requestDeleteDoc}
                    onDropFiles={ws.handleDropFiles}
                    onAddToNote={notes.handleAddToNoteFromPdf}
                    onRenameDoc={ws.handleRenameDoc}
                    onClose={handleCloseViewer}
                    dragHandle={dragHandle}
                  />
                </Suspense>
              </ErrorBoundary>
            )}
          </div>
        );
      case 'chat':
        return (
          <ErrorBoundary
            resetKey={ws.activeDocId}
            fallback={<aside className="chat-panel" style={FULL_PANEL_STYLE}><div className="chat-empty">Chat unavailable.</div></aside>}
          >
            <ChatPanel
              activeDocId={ws.activeDocId}
              activeDocTitle={ws.activeDocName}
              resolveDocTitle={ws.resolveDocTitle}
              listContextDocs={ws.listContextDocs}
              activeWorkspaceId={ws.activeWorkspace?.id ?? null}
              activeWorkspaceName={ws.activeWorkspace?.name ?? null}
              pendingSend={pendingChatSend}
              onPendingSendConsumed={() => setPendingChatSend(null)}
              style={FULL_PANEL_STYLE}
              dragHandle={dragHandle}
              onClose={handleCloseChat}
            />
          </ErrorBoundary>
        );
      case 'notes':
        return (
          <ErrorBoundary
            resetKey={ws.activeDocId}
            fallback={<aside className="notes" id="notesPanel" style={FULL_PANEL_STYLE}><div className="notes-placeholder"><h3>Notes</h3><p>Notes failed to load for this document.</p></div></aside>}
          >
            <NotesPanel
              doc={ws.activeDoc}
              noteContent={noteContent}
              style={FULL_PANEL_STYLE}
              saveStatus={notes.saveStatus}
              lastSavedTime={notes.lastSavedTime}
              editorWordWrap={settings.editor_word_wrap}
              editorLineNumbers={settings.editor_line_numbers}
              onNoteChange={notes.handleNoteChange}
              onManualSave={notes.handleManualSave}
              onTagChange={ws.handleTagChange}
              onClose={handleCloseNotes}
              dragHandle={dragHandle}
            />
          </ErrorBoundary>
        );
      case 'assets':
        return (
          <ErrorBoundary
            resetKey={ws.activeWsId}
            fallback={<aside className="notes" id="assetsPanel" style={FULL_PANEL_STYLE}><div className="notes-placeholder"><h3>Assets</h3><p>Assets failed to load.</p></div></aside>}
          >
            <AssetsPanel
              workspace={ws.activeWorkspace}
              style={FULL_PANEL_STYLE}
              onClose={handleCloseAssets}
              dragHandle={dragHandle}
            />
          </ErrorBoundary>
        );
      case 'bibtex':
        return (
          <ErrorBoundary
            resetKey={ws.activeWsId}
            fallback={<aside className="notes" id="bibtexPanel" style={FULL_PANEL_STYLE}><div className="notes-placeholder"><h3>BibTeX</h3><p>BibTeX failed to load.</p></div></aside>}
          >
            <BibtexPanel
              workspace={ws.activeWorkspace}
              style={FULL_PANEL_STYLE}
              onClose={handleCloseBibtex}
              dragHandle={dragHandle}
            />
          </ErrorBoundary>
        );
    }
  };

  return (
    <div className="app" id="app">
      <TopBar
        searchQuery={searchQuery}
        onSearchChange={handleSearchChange}
        onNewDocument={handleNewDocument}
        onSelectOverview={ws.selectOverview}
        isChatOpen={layout.openPanels.chat}
        onToggleChat={handleToggleChat}
        userName={settings.user_name}
        hasApiKey={settings.gemini_api_key_set}
        onOpenSettings={() => setIsSettingsOpen(true)}
      />

      <div
        className={`main ${layout.sidebarCollapsed ? 'sidebar-collapsed' : ''} ${layout.rightSidebarCollapsed ? 'right-sidebar-collapsed' : ''}`}
        id="main"
        style={{ display: 'flex', flexDirection: 'row', width: '100%', overflow: 'hidden' }}
      >
        <Sidebar
          workspaces={ws.workspaces}
          activeWsId={ws.activeWsId}
          activeDocId={ws.activeDocId}
          collapsed={layout.sidebarCollapsed}
          searchQuery={deferredSearchQuery}
          notesCache={sidebarNotesCache}
          style={sidebarStyle}
          onToggleSidebar={layout.toggleSidebar}
          onSelectWorkspace={ws.selectWorkspace}
          onToggleWorkspaceExpand={ws.toggleWorkspaceExpand}
          onSelectDoc={ws.selectDoc}
          onCreateWorkspace={() => ws.setNewWorkspaceOpen(true)}
          onAddDocToWorkspace={ws.openFilePicker}
          onAddLatexDocToWorkspace={ws.handleAddLatexDoc}
          onDeleteWorkspace={ws.requestDeleteWorkspace}
          onDeleteDoc={ws.requestDeleteDoc}
          onRenameDoc={ws.handleRenameDoc}
        />
        <Resizer
          id="resizer1"
          onDragStart={layout.handleSidebarResizeStart}
          ariaLabel="Resize workspace sidebar"
          onNudge={layout.nudgeSidebarWidth}
        />

        {layout.visibleOrder.length === 0 ? (
          <div className="all-panels-docked" id="allPanelsDocked">
            <div className="panel-empty-icon">
              <IconBook size={44} />
            </div>
            <h3>All panels are docked</h3>
            <p>Select any tool from the right sidebar to open PDF Viewer, AI Chat, or Notes.</p>
            <div style={{ display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap', justifyContent: 'center' }}>
              <button className="pill-btn add-btn" onClick={() => layout.togglePanel('viewer')} type="button">
                <IconDoc size={13} />
                <span>Open PDF Viewer</span>
              </button>
              <button className="pill-btn" onClick={handleToggleChat} type="button">
                <IconChat size={13} />
                <span>Open AI Chat</span>
              </button>
              <button className="pill-btn" onClick={() => layout.togglePanel('notes')} type="button">
                <IconPencil size={13} />
                <span>Open Notes</span>
              </button>
            </div>
          </div>
        ) : (
          <Reorder.Group
            axis="x"
            values={layout.visibleOrder}
            onReorder={layout.handleReorder}
            style={{ display: 'flex', flexDirection: 'row', flex: 1, minWidth: 0, height: '100%', padding: 0, margin: 0, listStyle: 'none' }}
          >
            {layout.visibleOrder.map((panelId, idx) => {
              const meta = PANEL_META[panelId];
              const panelFlexStyle: React.CSSProperties = {
                flex: `${layout.panelWeights[panelId] ?? 1} 1 0`,
                minWidth: 0,
                width: '100%',
                height: '100%',
                ...(meta.zIndex !== undefined ? { zIndex: meta.zIndex } : {}),
              };
              const resizerNode =
                idx > 0 ? (
                  <Resizer
                    id={`resizer-${layout.visibleOrder[idx - 1]}-${panelId}`}
                    onDragStart={layout.handlePairResizeStart(layout.visibleOrder[idx - 1], panelId)}
                    ariaLabel={`Resize ${layout.visibleOrder[idx - 1]} and ${panelId} panels`}
                    onNudge={layout.nudgePanelPair(layout.visibleOrder[idx - 1], panelId)}
                  />
                ) : null;

              return (
                <PanelWrapper
                  key={panelId}
                  id={panelId}
                  style={panelFlexStyle}
                  className={meta.wrapperClass}
                  resizer={resizerNode}
                  onMove={layout.handleMovePanel}
                >
                  {(dragHandle) => renderPanelContent(panelId, dragHandle)}
                </PanelWrapper>
              );
            })}
          </Reorder.Group>
        )}

        <RightSidebar
          collapsed={layout.rightSidebarCollapsed}
          onToggleCollapse={layout.toggleRightSidebar}
          items={rightSidebarItems}
        />
      </div>

      <input
        type="file"
        id="fileInput"
        ref={ws.fileInputRef}
        accept="application/pdf,.pdf"
        multiple
        hidden
        onChange={ws.handleFileInputChange}
      />

      <NewWorkspaceModal
        open={ws.newWorkspaceOpen}
        onCancel={() => ws.setNewWorkspaceOpen(false)}
        onCreate={ws.confirmCreateWorkspace}
      />
      <ConfirmModal
        open={ws.pendingDelete?.kind === 'workspace'}
        title="Delete workspace?"
        message={
          ws.pendingDelete?.kind === 'workspace'
            ? `"${ws.pendingDelete.name}" and all its ${ws.pendingDelete.count} document(s) will be permanently deleted.`
            : ''
        }
        confirmLabel="Delete"
        onCancel={() => ws.setPendingDelete(null)}
        onConfirm={ws.confirmPendingDelete}
      />
      <ConfirmModal
        open={ws.pendingDelete?.kind === 'doc'}
        title="Delete document?"
        message={
          ws.pendingDelete?.kind === 'doc'
            ? `"${ws.pendingDelete.title}" will be permanently deleted.`
            : ''
        }
        confirmLabel="Delete"
        onCancel={() => ws.setPendingDelete(null)}
        onConfirm={ws.confirmPendingDelete}
      />
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => {
          setIsSettingsOpen(false);
          writeRawStored(STORAGE_KEYS.onboarded, 'true');
        }}
        settings={settings}
        onSaveSettings={handleSaveSettings}
        isFirstRun={isFirstRun}
      />
    </div>
  );
};

export default App;
