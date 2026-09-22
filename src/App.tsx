import React, { useState, useEffect, useRef, useCallback, useMemo, useDeferredValue, Suspense, lazy } from 'react';
import type { Workspace, DocumentItem } from './types';
import { api } from './services/api';
import { TopBar } from './components/TopBar';
import { Sidebar } from './components/Sidebar';
import { Resizer } from './components/Resizer';
import { WorkspaceOverview } from './components/WorkspaceOverview';
import { NotesPanel } from './components/NotesPanel';
import { ChatPanel, PERSISTED_CHAT_KEY } from './components/ChatPanel';
import { ConfirmModal, NewWorkspaceModal } from './components/Modals';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Reorder, useDragControls } from 'framer-motion';
import { IconDragHandle } from './components/Icons';
import './index.css';

// Code-split the heavy PDF viewer (pdfjs-dist ~800KB) so initial load
// stays fast; it loads on first document open.
const DocViewer = lazy(() =>
  import('./components/DocViewer').then((m) => ({ default: m.DocViewer }))
);

const STARTER_NOTE = `## Getting started

Welcome! This is your note for this document.

- [ ] Summarize the main ideas
- [ ] Pull out key quotes
- [ ] Link related papers

> Tip: use **bold**, *italic*, \`code\`, and markdown shortcuts.
> Press Enter to move to the next line — formatting renders automatically.`;

const uid = () => 'id' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const baseName = (n?: string) => (n || '').replace(/\.pdf$/i, '');
// Stable empty map: when no search is active the sidebar doesn't need note
// contents, so pass this instead of notesCache to keep its memo from
// invalidating (and re-rendering every row) on each note keystroke.
const EMPTY_NOTES_CACHE: Record<string, string> = {};

// UI state that survives refresh (selection, layout, panel visibility).
// Stored as JSON; anything unreadable falls back silently.
const readStored = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

function usePersistentState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => readStored(key, initial));
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  }, [key, value]);
  return [value, setValue] as const;
}

interface PanelWrapperProps {
  id: string;
  style?: React.CSSProperties;
  className?: string;
  resizer?: React.ReactNode;
  resizerPosition?: 'left' | 'right';
  children: (dragHandle: React.ReactNode) => React.ReactNode;
}

const PanelWrapper = React.forwardRef<HTMLLIElement, PanelWrapperProps>(({ id, style, children, className, resizer, resizerPosition }, ref) => {
  const controls = useDragControls();
  const dragHandleNode = (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Reorder ${id} panel`}
      onPointerDown={(e) => controls.start(e)}
      style={{ display: 'flex', touchAction: 'none', cursor: 'grab' }}
    >
      <IconDragHandle />
    </div>
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
      {resizerPosition === 'left' && resizer}
      <div style={{ flex: 1, display: 'flex', minWidth: 0, flexDirection: 'column', height: '100%' }}>
        {children(dragHandleNode)}
      </div>
      {resizerPosition === 'right' && resizer}
    </Reorder.Item>
  );
});

export const App: React.FC = () => {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([
    {
      id: 'ws_default',
      name: 'My Workspace',
      expanded: true,
      created_at: Date.now(),
      docs: [],
    },
  ]);
  const [activeWsId, setActiveWsId] = usePersistentState<string>('rschr-ws', 'ws_default');
  const [activeDocId, setActiveDocId] = usePersistentState<string | null>('rschr-doc', null);
  const [sidebarCollapsed, setSidebarCollapsed] = usePersistentState<boolean>('rschr-sidecol', false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [notesCache, setNotesCache] = useState<Record<string, string>>({});
  const [pendingWsId, setPendingWsId] = useState<string | null>(null);

  // Save feedback state
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'idle'>('idle');
  const [lastSavedTime, setLastSavedTime] = useState<string | null>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [sidebarWidth, setSidebarWidth] = usePersistentState<number>('rschr-sidew', 240);
  const [notesWidth, setNotesWidth] = usePersistentState<number>('rschr-notesw', 400);
  const [chatWidth, setChatWidth] = usePersistentState<number>('rschr-chatw', 300);
  const [isChatOpen, setIsChatOpen] = usePersistentState<boolean>('rschr-chat-open', false);
  const PANEL_IDS = useMemo(() => ['viewer', 'chat', 'notes'] as string[], []);
  const [panelOrderRaw, setPanelOrder] = usePersistentState<string[]>('rschr-panel-order', ['viewer', 'chat', 'notes']);
  // Sanitize persisted order: drop unknowns/'sidebar', dedupe, append missing
  // so corrupt localStorage can never render an empty or partial layout.
  const panelOrder = useMemo(() => {
    const seen = new Set<string>();
    const clean = (Array.isArray(panelOrderRaw) ? panelOrderRaw : []).filter((p) => {
      if (!PANEL_IDS.includes(p) || seen.has(p)) return false;
      seen.add(p);
      return true;
    });
    for (const id of PANEL_IDS) if (!seen.has(id)) clean.push(id);
    return clean;
  }, [panelOrderRaw, PANEL_IDS]);
  // Visible subset must match rendered Items 1:1 — Group `values` + map must
  // use this, never the full order (hidden chat would otherwise desync and
  // onReorder would persist a list missing 'chat', losing it permanently).
  const visibleOrder = useMemo(
    () => panelOrder.filter((p) => p !== 'chat' || isChatOpen),
    [panelOrder, isChatOpen]
  );
  // Merge a visible-only reorder back into the full order, preserving the
  // previous index of hidden panels so reopening lands where it was.
  const handleReorder = useCallback((nextVisible: string[]) => {
    setPanelOrder((prev) => {
      const valid = ['viewer', 'chat', 'notes'];
      const seen = new Set<string>();
      const base = (Array.isArray(prev) ? prev : []).filter((p) => {
        if (!valid.includes(p) || seen.has(p)) return false;
        seen.add(p);
        return true;
      });
      const hidden = base.filter((p) => !nextVisible.includes(p));
      if (hidden.length === 0) return nextVisible.filter((p) => valid.includes(p));
      const result = nextVisible.filter((p) => valid.includes(p));
      for (const h of hidden) {
        const oldIdx = base.indexOf(h);
        result.splice(oldIdx < 0 ? result.length : Math.min(oldIdx, result.length), 0, h);
      }
      return result;
    });
  }, []);
  
  const sidebarWidthRef = useRef(sidebarWidth);
  sidebarWidthRef.current = sidebarWidth;
  const chatWidthRef = useRef(chatWidth);
  chatWidthRef.current = chatWidth;
  // Deferred query lets the search input stay at 60fps while heavy
  // sidebar/overview filtering renders at lower priority.
  const deferredSearchQuery = useDeferredValue(searchQuery);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const resizeRafRef = useRef<number>(0);
  const noteSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tagSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notesCacheRef = useRef<Record<string, string>>({});
  notesCacheRef.current = notesCache;
  const activeDocIdRef = useRef<string | null>(null);
  activeDocIdRef.current = activeDocId;
  const notesWidthRef = useRef(notesWidth);
  notesWidthRef.current = notesWidth;
  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;

  useEffect(() => {
    return () => {
      if (resizeRafRef.current) cancelAnimationFrame(resizeRafRef.current);
      if (noteSaveTimerRef.current) clearTimeout(noteSaveTimerRef.current);
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, []);

  // Load Workspaces on Mount
  useEffect(() => {
    const fetchInitialData = async () => {
      try {
        const loadedWorkspaces = await api.getWorkspaces();
        if (loadedWorkspaces && loadedWorkspaces.length > 0) {
          setWorkspaces(loadedWorkspaces);
          // Reconcile persisted selection — stored ids may reference
          // workspaces/docs deleted since (previously this reset to the
          // first workspace and dropped the open doc on every refresh).
          const storedWs = readStored<string>('rschr-ws', loadedWorkspaces[0].id);
          const ws = loadedWorkspaces.find((w) => w.id === storedWs) || loadedWorkspaces[0];
          setActiveWsId(ws.id);
          const storedDoc = readStored<string | null>('rschr-doc', null);
          const docOk =
            !!storedDoc && loadedWorkspaces.some((w) => w.docs.some((d) => d.id === storedDoc));
          setActiveDocId(docOk ? storedDoc : null);
        }
      } catch (err) {
        console.warn('Could not load workspaces from backend, using local state:', err);
      }
    };
    fetchInitialData();
  }, []);

  // Memoized selectors: previously flatMap ran on every render,
  // including 60fps resizer mousemoves.
  const activeWorkspace = useMemo(
    () => workspaces.find((w) => w.id === activeWsId) || workspaces[0],
    [workspaces, activeWsId]
  );
  const activeDoc: DocumentItem | null = useMemo(
    () =>
      activeDocId
        ? workspaces.flatMap((w) => w.docs).find((d) => d.id === activeDocId) || null
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspaces, activeDocId]
  );
  const activeDocName = activeDoc ? activeDoc.note_title || baseName(activeDoc.name) : 'this document';

  // Load Note for Active Document — dep is id only. Previously
  // [activeDocId, activeDoc, notesCache] re-ran on every keystroke.
  useEffect(() => {
    if (!activeDocId) return;
    if (notesCacheRef.current[activeDocId] !== undefined) return;

    const cachedLocal = localStorage.getItem(`rsrch-note-${activeDocId}`);
    if (cachedLocal) {
      setNotesCache((prev) =>
        prev[activeDocId] !== undefined ? prev : { ...prev, [activeDocId]: cachedLocal }
      );
      return;
    }
    let cancelled = false;
    api
      .getNote(activeDocId)
      .then((data) => {
        if (cancelled) return;
        if (data?.content) {
          setNotesCache((prev) =>
            prev[activeDocId] !== undefined ? prev : { ...prev, [activeDocId]: data.content }
          );
        } else {
          const defaultNote = STARTER_NOTE.replace('this document', activeDocName);
          setNotesCache((prev) =>
            prev[activeDocId] !== undefined ? prev : { ...prev, [activeDocId]: defaultNote }
          );
        }
      })
      .catch(() => {
        if (cancelled) return;
        const defaultNote = STARTER_NOTE.replace('this document', activeDocName);
        setNotesCache((prev) =>
          prev[activeDocId] !== undefined ? prev : { ...prev, [activeDocId]: defaultNote }
        );
      });
    return () => {
      cancelled = true;
    };
  }, [activeDocId, activeDocName]);

  // Sidebar Actions — stable identities keep memoized children from
  // re-rendering on unrelated state changes.
  const handleToggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => !prev);
  }, []);

  const handleSelectWorkspace = useCallback((wsId: string) => {
    setActiveWsId(wsId);
    setActiveDocId(null);
  }, []);

  const handleToggleWorkspaceExpand = useCallback((wsId: string) => {
    let nextExpanded = false;
    setWorkspaces((prev) =>
      prev.map((w) => {
        if (w.id === wsId) {
          nextExpanded = !w.expanded;
          return { ...w, expanded: nextExpanded };
        }
        return w;
      })
    );
    queueMicrotask(() => api.updateWorkspace(wsId, { expanded: nextExpanded }).catch(() => {}));
  }, []);

  const [newWorkspaceOpen, setNewWorkspaceOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<
    | null
    | { kind: 'workspace'; id: string; name: string; count: number }
    | { kind: 'doc'; wsId?: string; docId: string; title: string }
  >(null);

  const handleCreateWorkspace = useCallback(() => {
    setNewWorkspaceOpen(true);
  }, []);

  const handleConfirmCreateWorkspace = useCallback(async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setNewWorkspaceOpen(false);
    try {
      const newWs = await api.createWorkspace(trimmed);
      setWorkspaces((prev) => [...prev, newWs]);
      setActiveWsId(newWs.id);
      setActiveDocId(null);
    } catch {
      const fallbackWs: Workspace = {
        id: uid(),
        name: trimmed,
        expanded: true,
        created_at: Date.now(),
        docs: [],
      };
      setWorkspaces((prev) => [...prev, fallbackWs]);
      setActiveWsId(fallbackWs.id);
      setActiveDocId(null);
    }
  }, []);

  // Delete Workspace — no setState inside updater; derive next state
  // from the current snapshot so this runs a single render pass.
  const doDeleteWorkspace = useCallback(
    async (wsId: string) => {
      try {
        await api.deleteWorkspace(wsId);
      } catch (err) {
        console.warn('Failed to delete workspace on backend:', err);
      }
      setWorkspaces((prev) => {
        const next = prev.filter((w) => w.id !== wsId);
        if (next.length === 0) {
          const fallbackWs: Workspace = {
            id: 'ws_default',
            name: 'My Workspace',
            expanded: true,
            created_at: Date.now(),
            docs: [],
          };
          queueMicrotask(() => {
            setActiveWsId('ws_default');
            setActiveDocId(null);
          });
          return [fallbackWs];
        }
        const deletedActive = prev.find((w) => w.id === wsId);
        const hadActiveDoc =
          deletedActive?.docs.some((d) => d.id === activeDocIdRef.current) ?? false;
        queueMicrotask(() => {
          setActiveWsId((prevActive) =>
            prevActive === wsId ? next[0].id : prevActive
          );
          if (hadActiveDoc) setActiveDocId(null);
        });
        return next;
      });
    },
    []
  );

  const requestDeleteWorkspace = useCallback((wsId: string) => {
    const ws = workspacesRef.current.find((w) => w.id === wsId);
    setPendingDelete({
      kind: 'workspace',
      id: wsId,
      name: ws?.name || 'this workspace',
      count: ws?.docs.length || 0,
    });
  }, []);

  const requestDeleteDoc = useCallback((wsIdOrDocId: string, docIdParam?: string) => {
    const targetDocId = docIdParam || wsIdOrDocId;
    if (!targetDocId) return;
    const allDocs = workspacesRef.current.flatMap((w) => w.docs);
    const target = allDocs.find((d) => d.id === targetDocId);
    const title = target?.note_title || target?.name?.replace(/\.pdf$/i, '') || 'this document';
    setPendingDelete({
      kind: 'doc',
      wsId: docIdParam ? wsIdOrDocId : undefined,
      docId: targetDocId,
      title,
    });
  }, []);

  const confirmPendingDelete = useCallback(() => {
    if (!pendingDelete) return;
    if (pendingDelete.kind === 'workspace') {
      const id = pendingDelete.id;
      setPendingDelete(null);
      void doDeleteWorkspace(id);
    } else {
      const { wsId, docId } = pendingDelete;
      setPendingDelete(null);
      void doDeleteDoc(wsId || docId, wsId ? docId : undefined);
    }
  }, [pendingDelete]);

  // Delete Document
  const doDeleteDoc = useCallback(async (wsIdOrDocId: string, docIdParam?: string) => {
    const targetDocId = docIdParam || wsIdOrDocId;
    if (!targetDocId) return;

    try {
      await api.deleteDocument(targetDocId);
    } catch (err) {
      console.warn('Failed to delete document on backend:', err);
    }

    setWorkspaces((prev) =>
      prev.map((w) => ({
        ...w,
        docs: w.docs.filter((d) => d.id !== targetDocId),
      }))
    );

    setNotesCache((prev) => {
      if (!(targetDocId in prev)) return prev;
      const copy = { ...prev };
      delete copy[targetDocId];
      return copy;
    });

    try {
      localStorage.removeItem(`rsrch-note-${targetDocId}`);
    } catch {}

    if (activeDocIdRef.current === targetDocId) {
      setActiveDocId(null);
    }
  }, []);

  // Add Files / PDFs
  const activeWsIdRef = useRef(activeWsId);
  activeWsIdRef.current = activeWsId;
  const pendingWsIdRef = useRef(pendingWsId);
  pendingWsIdRef.current = pendingWsId;
  const openFilePicker = useCallback((wsId?: string) => {
    setPendingWsId(wsId || activeWsIdRef.current);
    fileInputRef.current?.click();
  }, []);

  const handleAddFiles = useCallback(async (targetWsId: string, fileList: FileList) => {
    const pdfFiles = Array.from(fileList).filter(
      (f) => f.type.includes('pdf') || f.name.toLowerCase().endsWith('.pdf')
    );
    if (!pdfFiles.length) return;

    // Upload all, then commit once: previously each file fired its own
    // setWorkspaces + activation, flickering through every intermediate doc.
    const added: DocumentItem[] = [];
    const notes: Record<string, string> = {};
    for (const file of pdfFiles) {
      try {
        const newDoc = await api.uploadDocument(targetWsId, file, 'General', baseName(file.name));
        newDoc.file = file;
        added.push(newDoc);
      } catch (err) {
        console.warn('Backend upload failed, adding locally:', err);
        added.push({
          id: uid(),
          workspace_id: targetWsId,
          name: file.name,
          note_title: baseName(file.name),
          tag: 'General',
          bookmarked: false,
          added_at: Date.now(),
          has_file: true,
          page_count: 1,
          file,
        });
      }
      notes[added[added.length - 1].id] = STARTER_NOTE.replace('this document', baseName(file.name));
    }
    if (!added.length) return;

    setWorkspaces((prev) =>
      prev.map((w) => {
        if (w.id === targetWsId) {
          return {
            ...w,
            expanded: true,
            docs: [...w.docs, ...added],
          };
        }
        return w;
      })
    );
    setNotesCache((prev) => ({ ...prev, ...notes }));
    setActiveWsId(targetWsId);
    setActiveDocId(added[added.length - 1].id);
  }, []);

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files?.length) {
        handleAddFiles(pendingWsIdRef.current || activeWsIdRef.current, e.target.files);
        e.target.value = '';
      }
      setPendingWsId(null);
    },
    [handleAddFiles]
  );

  const handleSelectDoc = useCallback((wsId: string, docId: string) => {
    setActiveWsId(wsId);
    setActiveDocId(docId);
  }, []);

  // Document Attribute Modifications — stable callbacks so memoized
  // DocViewer/Sidebar don't re-render; network writes are debounced.
  const handleToggleBookmark = useCallback((docId: string) => {
    let nextBm = false;
    setWorkspaces((prev) =>
      prev.map((w) => ({
        ...w,
        docs: w.docs.map((d) => {
          if (d.id === docId) {
            nextBm = !d.bookmarked;
            return { ...d, bookmarked: nextBm };
          }
          return d;
        }),
      }))
    );
    // Fire-and-forget outside the updater (updater must stay pure)
    queueMicrotask(() => api.updateDocument(docId, { bookmarked: nextBm }).catch(() => {}));
  }, []);

  const handleRenameDoc = useCallback((docId: string, newTitle: string) => {
    const trimmed = newTitle.trim();
    if (!docId || !trimmed) return;
    setWorkspaces((prev) =>
      prev.map((w) => ({
        ...w,
        docs: w.docs.map((d) => (d.id === docId ? { ...d, note_title: trimmed } : d)),
      }))
    );
    api.updateDocument(docId, { note_title: trimmed }).catch(() => {});
  }, []);

  const handleTagChange = useCallback(
    (newTag: string) => {
      const id = activeDocIdRef.current;
      if (!id) return;
      setWorkspaces((prev) =>
        prev.map((w) => ({
          ...w,
          docs: w.docs.map((d) => (d.id === id ? { ...d, tag: newTag } : d)),
        }))
      );
      if (tagSaveTimerRef.current) clearTimeout(tagSaveTimerRef.current);
      tagSaveTimerRef.current = setTimeout(() => {
        api.updateDocument(id, { tag: newTag }).catch(() => {});
      }, 400);
    },
    []
  );

  const handleNoteChange = useCallback((newContent: string) => {
    const id = activeDocIdRef.current;
    if (!id) return;
    // Instant UI update; persist debounced to avoid localStorage +
    // network on every keystroke (was the main typing-jank source).
    setNotesCache((prev) => (prev[id] === newContent ? prev : { ...prev, [id]: newContent }));
    if (noteSaveTimerRef.current) clearTimeout(noteSaveTimerRef.current);
    noteSaveTimerRef.current = setTimeout(() => {
      try {
        localStorage.setItem(`rsrch-note-${id}`, newContent);
      } catch {}
      api.saveNote(id, newContent).catch(() => {});
    }, 800);
  }, []);

  // Add to note from PDF selection citation — stable ref-based callback.
  // NOTE: the state updater stays pure (no localStorage/network inside);
  // persistence happens after, so StrictMode's double-invoked updaters
  // can't fire duplicate saveNote calls.
  const handleAddToNoteFromPdf = useCallback(
    (quoteText: string, pageNumber: number) => {
      const id = activeDocIdRef.current;
      if (!id) return;
      const cleanQuote = quoteText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .join(' ');

      if (!cleanQuote) return;

      const citationBlock = `\n\n> "${cleanQuote}" [p. ${pageNumber}]\n`;
      const cache = notesCacheRef.current;
      const targetDoc = workspacesRef.current
        .flatMap((w) => w.docs)
        .find((d) => d.id === id);
      const docTitle = targetDoc?.note_title || (targetDoc ? baseName(targetDoc.name) : 'Document');
      const currentNote =
        cache[id] !== undefined ? cache[id] : STARTER_NOTE.replace('this document', docTitle);
      const updatedNote = (currentNote ? currentNote.trimEnd() : '') + citationBlock;

      setNotesCache((prev) =>
        prev[id] === updatedNote ? prev : { ...prev, [id]: updatedNote }
      );
      try {
        localStorage.setItem(`rsrch-note-${id}`, updatedNote);
      } catch {}
      api.saveNote(id, updatedNote).catch(() => {});
    },
    []
  );

  // Manual Note Save (Ctrl + S & Save button)
  const handleManualSave = useCallback(async (overrideContent?: string) => {
    const id = activeDocIdRef.current;
    if (!id) return;
    if (noteSaveTimerRef.current) clearTimeout(noteSaveTimerRef.current);
    const contentToSave =
      overrideContent !== undefined ? overrideContent : notesCacheRef.current[id] || '';

    setSaveStatus('saving');
    try {
      localStorage.setItem(`rsrch-note-${id}`, contentToSave);
    } catch {}

    try {
      await api.saveNote(id, contentToSave);
    } catch (err) {
      console.warn('API saveNote failed, saved locally:', err);
    }

    const timeStr = new Date().toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    });
    setLastSavedTime(timeStr);
    setSaveStatus('saved');

    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      setSaveStatus('idle');
    }, 3000);
  }, []);

  // Global Ctrl + S keydown listener
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        handleManualSave();
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [handleManualSave]);

  // Resizing Logic — rAF-throttled so mousemove (100+ Hz) commits at
  // most one React render per frame instead of one per event.
  const createResizeHandler = useCallback(
    (
      setWidth: React.Dispatch<React.SetStateAction<number>>,
      widthRef: React.MutableRefObject<number>,
      direction: 1 | -1,
      min: number,
      max: number
    ) => (e: React.MouseEvent) => {
      e.preventDefault();
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      const startX = e.clientX;
      const startWidth = widthRef.current;

      const onMouseMove = (moveEvent: MouseEvent) => {
        if (resizeRafRef.current) return;
        resizeRafRef.current = requestAnimationFrame(() => {
          resizeRafRef.current = 0;
          const delta = (moveEvent.clientX - startX) * direction;
          setWidth(Math.min(max, Math.max(min, startWidth + delta)));
        });
      };
      const onMouseUp = () => {
        if (resizeRafRef.current) cancelAnimationFrame(resizeRafRef.current);
        resizeRafRef.current = 0;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
      };
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    },
    []
  );

  const getResizeDirection = useCallback((panelId: string) => {
    const viewerIndex = panelOrder.indexOf('viewer');
    const panelIndex = panelOrder.indexOf(panelId);
    return panelIndex < viewerIndex ? 1 : -1;
  }, [panelOrder]);

  const handleResizer1MouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (sidebarCollapsed) return;
      createResizeHandler(setSidebarWidth, sidebarWidthRef, getResizeDirection('sidebar'), 180, 420)(e);
    },
    [sidebarCollapsed, createResizeHandler, getResizeDirection]
  );

  const handleResizer2MouseDown = useCallback(
    (e: React.MouseEvent) => {
      createResizeHandler(setNotesWidth, notesWidthRef, getResizeDirection('notes'), 280, 720)(e);
    },
    [createResizeHandler, getResizeDirection]
  );

  const handleResizerChatMouseDown = useCallback(
    (e: React.MouseEvent) => {
      createResizeHandler(setChatWidth, chatWidthRef, getResizeDirection('chat'), 250, 600)(e);
    },
    [createResizeHandler, getResizeDirection]
  );

  // Stable render callbacks + memoized styles: previously every App
  // render created new closures/objects, defeating memoization below.
  const handleNewDocument = useCallback(() => openFilePicker(activeWsIdRef.current), [openFilePicker]);
  const handleSelectOverview = useCallback(() => setActiveDocId(null), []);
  // Closing the panel intentionally clears the persisted open-chat id, so
  // a toggle always lands on a blank draft while a refresh restores the
  // chat (refresh never runs this handler).
  const handleToggleChat = useCallback(() => {
    setIsChatOpen((v) => {
      if (v) {
        try {
          localStorage.removeItem(PERSISTED_CHAT_KEY);
        } catch {}
      }
      return !v;
    });
  }, []);
  const handleSearchChange = useCallback((q: string) => setSearchQuery(q), []);
  const handleAddDocToWorkspace = useCallback(
    (wsId: string) => openFilePicker(wsId),
    [openFilePicker]
  );
  const handleDeleteDoc2 = useCallback(
    (wsId: string, docId: string) => requestDeleteDoc(wsId, docId),
    [requestDeleteDoc]
  );
  const handleDeleteDoc1 = useCallback((docId: string) => requestDeleteDoc(docId), [requestDeleteDoc]);
  const handleDropFiles = useCallback(
    (files: FileList) => handleAddFiles(activeWsIdRef.current, files),
    [handleAddFiles]
  );

  // Title lookup for chat context chips — ref-based so the identity stays
  // stable and the global chat panel doesn't re-render on workspace edits.
  const resolveDocTitle = useCallback((id: string): string | null => {
    const d = workspacesRef.current.flatMap((w) => w.docs).find((d) => d.id === id);
    return d ? d.note_title || baseName(d.name) : null;
  }, []);

  const sidebarStyle = useMemo(
    () => ({ width: sidebarCollapsed ? undefined : `${sidebarWidth}px` }),
    [sidebarCollapsed, sidebarWidth]
  );
  const notesStyle = useMemo(() => ({ width: `${notesWidth}px`, height: '100%' }), [notesWidth]);
  const chatStyle = useMemo(() => ({ width: `${chatWidth}px`, height: '100%' }), [chatWidth]);
  const noteContent = activeDocId ? notesCache[activeDocId] || '' : '';
  // Sidebar only scans note bodies while a query is active; otherwise hand
  // it a stable empty object so note keystrokes don't re-render the tree.
  const sidebarNotesCache = deferredSearchQuery.trim() ? notesCache : EMPTY_NOTES_CACHE;

  return (
    <div className="app" id="app">
      <TopBar
        searchQuery={searchQuery}
        onSearchChange={handleSearchChange}
        onNewDocument={handleNewDocument}
        onSelectOverview={handleSelectOverview}
        isChatOpen={isChatOpen}
        onToggleChat={handleToggleChat}
      />

      <div
        className={`main ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}
        id="main"
        ref={mainRef as any}
        style={{ display: 'flex', flexDirection: 'row', width: '100%', overflow: 'hidden' }}
      >
        <Sidebar
          workspaces={workspaces}
          activeWsId={activeWsId}
          activeDocId={activeDocId}
          collapsed={sidebarCollapsed}
          searchQuery={deferredSearchQuery}
          notesCache={sidebarNotesCache}
          style={sidebarStyle}
          onToggleSidebar={handleToggleSidebar}
          onSelectWorkspace={handleSelectWorkspace}
          onToggleWorkspaceExpand={handleToggleWorkspaceExpand}
          onSelectDoc={handleSelectDoc}
          onCreateWorkspace={handleCreateWorkspace}
          onAddDocToWorkspace={handleAddDocToWorkspace}
          onDeleteWorkspace={requestDeleteWorkspace}
          onDeleteDoc={handleDeleteDoc2}
          onRenameDoc={handleRenameDoc}
        />
        <Resizer id="resizer1" onMouseDown={handleResizer1MouseDown} />

        <Reorder.Group
          axis="x"
          values={visibleOrder}
          onReorder={handleReorder}
          style={{ display: 'flex', flexDirection: 'row', flex: 1, minWidth: 0, height: '100%', padding: 0, margin: 0, listStyle: 'none' }}
        >
          {visibleOrder.map((panelId) => {
            
            const dir = getResizeDirection(panelId);
            const resizerPosition = dir === 1 ? 'right' : 'left';
            
            if (panelId === 'viewer') {
            return (
              <PanelWrapper key="viewer" id="viewer" style={{ flex: '1 1 0', minWidth: 0, zIndex: 0 }} className="viewer" resizer={null}>
                {(dragHandle: React.ReactNode) => (
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%' }}>
                    {!activeDocId ? (
                      <WorkspaceOverview
                        workspace={activeWorkspace}
                        searchQuery={deferredSearchQuery}
                        notesCache={sidebarNotesCache}
                        onAddPdf={handleNewDocument}
                        onSelectDoc={handleSelectDoc}
                        onDeleteDoc={handleDeleteDoc2}
                        onDeleteWorkspace={requestDeleteWorkspace}
                        onRenameDoc={handleRenameDoc}
                        dragHandle={dragHandle}
                      />
                    ) : (
                      <ErrorBoundary
                        resetKey={activeDocId}
                        fallback={<div className="pdf-loading-spinner"><span>This document couldn't be displayed.</span></div>}
                      >
                        <Suspense
                          fallback={<div className="pdf-loading-spinner"><span>Loading viewer…</span></div>}
                        >
                          <DocViewer
                            doc={activeDoc}
                            onToggleBookmark={handleToggleBookmark}
                            onDeleteDoc={handleDeleteDoc1}
                            onDropFiles={handleDropFiles}
                            onAddToNote={handleAddToNoteFromPdf}
                            onRenameDoc={handleRenameDoc}
                            dragHandle={dragHandle}
                          />
                        </Suspense>
                      </ErrorBoundary>
                    )}
                  </div>
                )}
              </PanelWrapper>
            );
          }
          if (panelId === 'chat') {
            return (
              <PanelWrapper key="chat" id="chat" style={{ flexShrink: 0 }} resizer={<Resizer id="resizer-chat" onMouseDown={handleResizerChatMouseDown} />} resizerPosition={resizerPosition}>
                {(dragHandle: React.ReactNode) => (
                  <ErrorBoundary
                    resetKey={activeDocId}
                    fallback={<aside className="chat-panel" style={chatStyle}><div className="chat-empty">Chat unavailable.</div></aside>}
                  >
                    <ChatPanel
                      activeDocId={activeDocId}
                      activeDocTitle={activeDocName}
                      resolveDocTitle={resolveDocTitle}
                      style={chatStyle}
                      dragHandle={dragHandle}
                    />
                  </ErrorBoundary>
                )}
              </PanelWrapper>
            );
          }
          if (panelId === 'notes') {
            return (
              <PanelWrapper key="notes" id="notes" style={{ flexShrink: 0 }} resizer={<Resizer id="resizer2" onMouseDown={handleResizer2MouseDown} />} resizerPosition={resizerPosition}>
                {(dragHandle: React.ReactNode) => (
                  <ErrorBoundary
                    resetKey={activeDocId}
                    fallback={<aside className="notes" id="notesPanel" style={notesStyle}><div className="notes-placeholder"><h3>Notes</h3><p>Notes failed to load for this document.</p></div></aside>}
                  >
                    <NotesPanel
                      doc={activeDoc}
                      noteContent={noteContent}
                      style={notesStyle}
                      saveStatus={saveStatus}
                      lastSavedTime={lastSavedTime}
                      onNoteChange={handleNoteChange}
                      onManualSave={handleManualSave}
                      onTagChange={handleTagChange}
                      dragHandle={dragHandle}
                    />
                  </ErrorBoundary>
                )}
              </PanelWrapper>
            );
          }
          return null;
        })}
        </Reorder.Group>
      </div>

      <input
        type="file"
        id="fileInput"
        ref={fileInputRef}
        accept="application/pdf,.pdf"
        multiple
        hidden
        onChange={handleFileInputChange}
      />

      <NewWorkspaceModal
        open={newWorkspaceOpen}
        onCancel={() => setNewWorkspaceOpen(false)}
        onCreate={handleConfirmCreateWorkspace}
      />
      <ConfirmModal
        open={pendingDelete?.kind === 'workspace'}
        title="Delete workspace?"
        message={
          pendingDelete?.kind === 'workspace'
            ? `"${pendingDelete.name}" and all its ${pendingDelete.count} document(s) will be permanently deleted.`
            : ''
        }
        confirmLabel="Delete"
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmPendingDelete}
      />
      <ConfirmModal
        open={pendingDelete?.kind === 'doc'}
        title="Delete document?"
        message={
          pendingDelete?.kind === 'doc'
            ? `"${pendingDelete.title}" will be permanently deleted.`
            : ''
        }
        confirmLabel="Delete"
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmPendingDelete}
      />
    </div>
  );
};

export default App;

