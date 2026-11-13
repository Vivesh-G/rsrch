import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MAX_FILES_PER_BATCH, MAX_PDF_UPLOAD_BYTES } from '../config/defaults';
import { api } from '../services/api';
import type { DocumentItem, Workspace } from '../types';
import { buildStarterNote, cleanDocName, findDocById, getDocDisplayName } from '../utils/document';
import { readStoredJson, STORAGE_KEYS } from '../utils/storage';
import { usePersistentState } from './usePersistentState';

const uid = () => 'id' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const DEFAULT_WORKSPACES: Workspace[] = [
  {
    id: 'ws_default',
    name: 'My Workspace',
    expanded: true,
    created_at: Date.now(),
    docs: [],
  },
];

export type PendingDelete =
  | null
  | { kind: 'workspace'; id: string; name: string; count: number }
  | { kind: 'doc'; docId: string; title: string };

interface UseWorkspacesOptions {
  onSeedNotes: (notes: Record<string, string>) => void;
  onDocDeleted: (docId: string) => void;
}

export function useWorkspaces({ onSeedNotes, onDocDeleted }: UseWorkspacesOptions) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>(DEFAULT_WORKSPACES);
  const [activeWsId, setActiveWsId] = usePersistentState<string>(
    STORAGE_KEYS.activeWorkspace,
    'ws_default',
  );
  const [activeDocId, setActiveDocId] = usePersistentState<string | null>(
    STORAGE_KEYS.activeDoc,
    null,
  );
  const [newWorkspaceOpen, setNewWorkspaceOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingWsIdRef = useRef<string | null>(null);
  const tagSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;
  const activeWsIdRef = useRef(activeWsId);
  activeWsIdRef.current = activeWsId;
  const activeDocIdRef = useRef(activeDocId);
  activeDocIdRef.current = activeDocId;

  useEffect(() => {
    return () => {
      if (tagSaveTimerRef.current) clearTimeout(tagSaveTimerRef.current);
    };
  }, []);

  // Load workspaces on mount and reconcile persisted selection against backend.
  useEffect(() => {
    api
      .getWorkspaces()
      .then((loaded) => {
        if (!loaded || loaded.length === 0) return;
        setWorkspaces(loaded);
        const storedWs = readStoredJson<string>(STORAGE_KEYS.activeWorkspace, loaded[0].id);
        const ws = loaded.find((w) => w.id === storedWs) || loaded[0];
        setActiveWsId(ws.id);
        const storedDoc = readStoredJson<string | null>(STORAGE_KEYS.activeDoc, null);
        const docOk = !!findDocById(loaded, storedDoc);
        setActiveDocId(docOk ? storedDoc : null);
      })
      .catch((err) => {
        console.warn('Could not load workspaces from backend, using local state:', err);
      });
  }, [setActiveWsId, setActiveDocId]);

  const activeWorkspace = useMemo(
    () => workspaces.find((w) => w.id === activeWsId) || workspaces[0],
    [workspaces, activeWsId],
  );
  const activeDoc = useMemo(
    () => findDocById(workspaces, activeDocId),
    [workspaces, activeDocId],
  );
  const activeDocName = getDocDisplayName(activeDoc, 'this document');

  const selectOverview = useCallback(() => setActiveDocId(null), [setActiveDocId]);

  const selectWorkspace = useCallback(
    (wsId: string) => {
      setActiveWsId(wsId);
      setActiveDocId(null);
    },
    [setActiveWsId, setActiveDocId],
  );

  const selectDoc = useCallback(
    (wsId: string, docId: string) => {
      setActiveWsId(wsId);
      setActiveDocId(docId);
    },
    [setActiveWsId, setActiveDocId],
  );

  const toggleWorkspaceExpand = useCallback((wsId: string) => {
    const current = workspacesRef.current.find((w) => w.id === wsId);
    const nextExpanded = !(current?.expanded ?? true);
    setWorkspaces((prev) =>
      prev.map((w) => (w.id === wsId ? { ...w, expanded: nextExpanded } : w)),
    );
    queueMicrotask(() => api.updateWorkspace(wsId, { expanded: nextExpanded }).catch(() => {}));
  }, []);

  const confirmCreateWorkspace = useCallback(
    async (name: string) => {
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
    },
    [setActiveWsId, setActiveDocId],
  );

  const doDeleteWorkspace = useCallback(
    async (wsId: string) => {
      try {
        await api.deleteWorkspace(wsId);
      } catch (err) {
        console.warn('Failed to delete workspace on backend:', err);
      }
      const prev = workspacesRef.current;
      const next = prev.filter((w) => w.id !== wsId);
      if (next.length === 0) {
        setWorkspaces([
          {
            id: 'ws_default',
            name: 'My Workspace',
            expanded: true,
            created_at: Date.now(),
            docs: [],
          },
        ]);
        setActiveWsId('ws_default');
        setActiveDocId(null);
        return;
      }
      const deletedActive = prev.find((w) => w.id === wsId);
      const hadActiveDoc = deletedActive?.docs.some((d) => d.id === activeDocIdRef.current) ?? false;
      setWorkspaces(next);
      setActiveWsId((prevActive) => (prevActive === wsId ? next[0].id : prevActive));
      if (hadActiveDoc) setActiveDocId(null);
    },
    [setActiveWsId, setActiveDocId],
  );

  const doDeleteDoc = useCallback(
    async (docId: string) => {
      if (!docId) return;

      try {
        await api.deleteDocument(docId);
      } catch (err) {
        console.warn('Failed to delete document on backend:', err);
      }

      setWorkspaces((prev) =>
        prev.map((w) => ({
          ...w,
          docs: w.docs.filter((d) => d.id !== docId),
        })),
      );
      onDocDeleted(docId);

      if (activeDocIdRef.current === docId) {
        setActiveDocId(null);
      }
    },
    [onDocDeleted, setActiveDocId],
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

  const requestDeleteDoc = useCallback((docId: string) => {
    if (!docId) return;
    const target = findDocById(workspacesRef.current, docId);
    const title = getDocDisplayName(target, 'this document');
    setPendingDelete({
      kind: 'doc',
      docId,
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
      const { docId } = pendingDelete;
      setPendingDelete(null);
      void doDeleteDoc(docId);
    }
  }, [pendingDelete, doDeleteWorkspace, doDeleteDoc]);

  const handleAddFiles = useCallback(
    async (targetWsId: string, fileList: FileList | File[]) => {
      const all = Array.from(fileList);
      const pdfFiles = all
        .filter((f) => f.type.includes('pdf') || f.name.toLowerCase().endsWith('.pdf'))
        .slice(0, MAX_FILES_PER_BATCH);
      const oversized = pdfFiles.filter((f) => f.size > MAX_PDF_UPLOAD_BYTES).map((f) => f.name);
      const files = pdfFiles.filter((f) => f.size <= MAX_PDF_UPLOAD_BYTES);
      if (oversized.length) {
        console.warn(`Skipped ${oversized.length} file(s) over 50MB:`, oversized);
      }
      if (all.length > files.length + oversized.length) {
        console.warn('Some files were skipped (non-PDF or over the 10-file batch limit).');
      }
      if (!files.length) return;

      const added: DocumentItem[] = [];
      const notes: Record<string, string> = {};
      for (const file of files) {
        const docTitle = cleanDocName(file.name);
        try {
          const uploaded = await api.uploadDocument(targetWsId, file, 'General', docTitle);
          added.push(uploaded);
        } catch (err) {
          console.warn('Backend upload failed, adding locally:', err);
          added.push({
            id: uid(),
            workspace_id: targetWsId,
            name: file.name,
            note_title: docTitle,
            tag: 'General',
            bookmarked: false,
            added_at: Date.now(),
            has_file: true,
            page_count: 1,
            file,
          });
        }
        notes[added[added.length - 1].id] = buildStarterNote(docTitle);
      }
      if (!added.length) return;

      setWorkspaces((prev) =>
        prev.map((w) =>
          w.id === targetWsId ? { ...w, expanded: true, docs: [...w.docs, ...added] } : w,
        ),
      );
      onSeedNotes(notes);
      setActiveWsId(targetWsId);
      setActiveDocId(added[added.length - 1].id);
    },
    [onSeedNotes, setActiveWsId, setActiveDocId],
  );

  const openFilePicker = useCallback((wsId?: string) => {
    pendingWsIdRef.current = wsId || activeWsIdRef.current;
    fileInputRef.current?.click();
  }, []);

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files?.length) {
        handleAddFiles(pendingWsIdRef.current || activeWsIdRef.current, e.target.files);
        e.target.value = '';
      }
      pendingWsIdRef.current = null;
    },
    [handleAddFiles],
  );

  const handleDropFiles = useCallback(
    (files: FileList | File[]) => handleAddFiles(activeWsIdRef.current, files),
    [handleAddFiles],
  );

  const handleAddLatexDoc = useCallback(
    async (targetWsId: string) => {
      try {
        const doc = await api.createLatexDocument(targetWsId, 'New LaTeX Document');
        setWorkspaces((prev) =>
          prev.map((w) =>
            w.id === targetWsId ? { ...w, expanded: true, docs: [...w.docs, doc] } : w,
          ),
        );
        setActiveWsId(targetWsId);
        setActiveDocId(doc.id);
      } catch (err) {
        console.warn('Failed to create LaTeX document:', err);
      }
    },
    [setActiveWsId, setActiveDocId],
  );

  const handleToggleBookmark = useCallback((docId: string) => {
    const current = findDocById(workspacesRef.current, docId);
    const nextBm = !(current?.bookmarked ?? false);
    setWorkspaces((prev) =>
      prev.map((w) => ({
        ...w,
        docs: w.docs.map((d) => (d.id === docId ? { ...d, bookmarked: nextBm } : d)),
      })),
    );
    queueMicrotask(() => api.updateDocument(docId, { bookmarked: nextBm }).catch(() => {}));
  }, []);

  const handleRenameDoc = useCallback((docId: string, newTitle: string) => {
    const trimmed = newTitle.trim();
    if (!docId || !trimmed) return;
    setWorkspaces((prev) =>
      prev.map((w) => ({
        ...w,
        docs: w.docs.map((d) => (d.id === docId ? { ...d, note_title: trimmed } : d)),
      })),
    );
    api.updateDocument(docId, { note_title: trimmed }).catch(() => {});
  }, []);

  const handleTagChange = useCallback((newTag: string) => {
    const id = activeDocIdRef.current;
    if (!id) return;
    setWorkspaces((prev) =>
      prev.map((w) => ({
        ...w,
        docs: w.docs.map((d) => (d.id === id ? { ...d, tag: newTag } : d)),
      })),
    );
    if (tagSaveTimerRef.current) clearTimeout(tagSaveTimerRef.current);
    tagSaveTimerRef.current = setTimeout(() => {
      api.updateDocument(id, { tag: newTag }).catch(() => {});
    }, 400);
  }, []);

  const resolveDocTitle = useCallback((id: string): string | null => {
    const d = findDocById(workspacesRef.current, id);
    return d ? getDocDisplayName(d) : null;
  }, []);

  const listContextDocs = useCallback((): DocumentItem[] => {
    const all = workspacesRef.current;
    const ws = all.find((w) => w.id === activeWsIdRef.current) || all[0];
    if (!ws) return [];
    return ws.docs.filter((d) => d.doc_type === 'pdf' || d.doc_type === 'latex' || d.doc_type === undefined);
  }, []);

  return {
    workspaces,
    workspacesRef,
    activeWsId,
    activeDocId,
    activeDocIdRef,
    activeWorkspace,
    activeDoc,
    activeDocName,
    fileInputRef,
    newWorkspaceOpen,
    setNewWorkspaceOpen,
    pendingDelete,
    setPendingDelete,
    selectOverview,
    selectWorkspace,
    selectDoc,
    toggleWorkspaceExpand,
    confirmCreateWorkspace,
    requestDeleteWorkspace,
    requestDeleteDoc,
    confirmPendingDelete,
    openFilePicker,
    handleFileInputChange,
    handleDropFiles,
    handleAddLatexDoc,
    handleToggleBookmark,
    handleRenameDoc,
    handleTagChange,
    resolveDocTitle,
    listContextDocs,
  };
}

