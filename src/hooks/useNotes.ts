import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_SETTINGS } from '../config/defaults';
import { api } from '../services/api';
import type { Workspace } from '../types';
import { buildStarterNote, findDocById, getDocDisplayName, isLatexDoc, normalizeQuoteText } from '../utils/document';
import { emitEvent } from '../utils/events';
import { readRawStored, removeStored, STORAGE_KEYS, writeRawStored } from '../utils/storage';

interface UseNotesOptions {
  activeDocId: string | null;
  activeDocName: string;
  activeDocIdRef: React.MutableRefObject<string | null>;
  workspacesRef: React.MutableRefObject<Workspace[]>;
  autoCompileDelay: number | undefined;
}

export function useNotes({
  activeDocId,
  activeDocName,
  activeDocIdRef,
  workspacesRef,
  autoCompileDelay,
}: UseNotesOptions) {
  const [notesCache, setNotesCache] = useState<Record<string, string>>({});
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'idle' | 'error'>('idle');
  const [lastSavedTime, setLastSavedTime] = useState<string | null>(null);

  const notesCacheRef = useRef<Record<string, string>>({});
  notesCacheRef.current = notesCache;
  const noteSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoCompileDelayRef = useRef(autoCompileDelay ?? DEFAULT_SETTINGS.auto_compile_delay);
  autoCompileDelayRef.current = autoCompileDelay ?? DEFAULT_SETTINGS.auto_compile_delay;

  useEffect(() => {
    return () => {
      if (noteSaveTimerRef.current) clearTimeout(noteSaveTimerRef.current);
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, []);

  const flashSaveStatus = useCallback((status: 'saved' | 'error', durationMs: number) => {
    setSaveStatus(status);
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => setSaveStatus('idle'), durationMs);
  }, []);

  const compileLatex = useCallback(async (docId: string): Promise<boolean> => {
    const targetDoc = findDocById(workspacesRef.current, docId);
    if (!isLatexDoc(targetDoc)) return true;

    const res = await api.compileDocument(docId);
    if (res?.status === 'success') {
      emitEvent('latex-compiled', { docId });
      emitEvent('latex-errors', { docId, errors: [] });
      return true;
    }
    if (res?.status === 'error' || res?.status === 'timeout') {
      const errors = res.diagnostics ?? [];
      console.warn('LaTeX compile returned diagnostics:', errors);
      emitEvent('latex-errors', { docId, errors });
      return false;
    }
    return true;
  }, [workspacesRef]);

  // Load note for active document — keyed strictly on id/name so typing never retriggers fetch.
  useEffect(() => {
    if (!activeDocId) return;
    if (notesCacheRef.current[activeDocId] !== undefined) return;

    const cachedLocal = readRawStored(STORAGE_KEYS.noteForDoc(activeDocId));
    if (cachedLocal) {
      setNotesCache((prev) =>
        prev[activeDocId] !== undefined ? prev : { ...prev, [activeDocId]: cachedLocal },
      );
      return;
    }

    let cancelled = false;
    api
      .getNote(activeDocId)
      .then((data) => {
        if (cancelled) return;
        const content = data?.content || buildStarterNote(activeDocName);
        setNotesCache((prev) =>
          prev[activeDocId] !== undefined ? prev : { ...prev, [activeDocId]: content },
        );
      })
      .catch(() => {
        if (cancelled) return;
        const fallback = buildStarterNote(activeDocName);
        setNotesCache((prev) =>
          prev[activeDocId] !== undefined ? prev : { ...prev, [activeDocId]: fallback },
        );
      });

    return () => {
      cancelled = true;
    };
  }, [activeDocId, activeDocName]);

  const handleNoteChange = useCallback(
    (newContent: string) => {
      const id = activeDocIdRef.current;
      if (!id) return;
      setNotesCache((prev) => (prev[id] === newContent ? prev : { ...prev, [id]: newContent }));
      writeRawStored(STORAGE_KEYS.noteForDoc(id), newContent);

      const delay = autoCompileDelayRef.current === 0 ? 800 : (autoCompileDelayRef.current || DEFAULT_SETTINGS.auto_compile_delay);
      if (noteSaveTimerRef.current) clearTimeout(noteSaveTimerRef.current);
      noteSaveTimerRef.current = setTimeout(async () => {
        try {
          await api.saveNote(id, newContent);
          if (autoCompileDelayRef.current !== 0) {
            const compiled = await compileLatex(id);
            if (!compiled) flashSaveStatus('error', 4000);
          }
        } catch (err) {
          console.warn('Save or compile failed', err);
        }
      }, delay);
    },
    [activeDocIdRef, compileLatex, flashSaveStatus],
  );

  // Flush any pending note save when tab becomes hidden.
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'hidden') return;
      const id = activeDocIdRef.current;
      if (!id || !noteSaveTimerRef.current) return;
      clearTimeout(noteSaveTimerRef.current);
      noteSaveTimerRef.current = null;
      const content = notesCacheRef.current[id];
      if (content !== undefined) {
        writeRawStored(STORAGE_KEYS.noteForDoc(id), content);
        api.saveNote(id, content).catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [activeDocIdRef]);

  const handleAddToNoteFromPdf = useCallback(
    (quoteText: string, pageNumber: number) => {
      const id = activeDocIdRef.current;
      if (!id) return;
      const cleanQuote = normalizeQuoteText(quoteText);
      if (!cleanQuote) return;

      const targetDoc = findDocById(workspacesRef.current, id);
      const docTitle = getDocDisplayName(targetDoc, 'Document');
      const currentNote =
        notesCacheRef.current[id] !== undefined
          ? notesCacheRef.current[id]
          : buildStarterNote(docTitle);
      const updatedNote = `${currentNote ? currentNote.trimEnd() : ''}\n\n> "${cleanQuote}" [p. ${pageNumber}]\n`;

      setNotesCache((prev) => (prev[id] === updatedNote ? prev : { ...prev, [id]: updatedNote }));
      writeRawStored(STORAGE_KEYS.noteForDoc(id), updatedNote);
      api.saveNote(id, updatedNote).catch(() => {});
    },
    [activeDocIdRef, workspacesRef],
  );

  const handleManualSave = useCallback(
    async (overrideContent?: string) => {
      const id = activeDocIdRef.current;
      if (!id) return;
      if (noteSaveTimerRef.current) clearTimeout(noteSaveTimerRef.current);
      const contentToSave =
        overrideContent !== undefined ? overrideContent : notesCacheRef.current[id] || '';

      setSaveStatus('saving');
      writeRawStored(STORAGE_KEYS.noteForDoc(id), contentToSave);

      let compileOk = true;
      try {
        await api.saveNote(id, contentToSave);
      } catch (err) {
        compileOk = false;
        console.warn('API saveNote failed, saved locally:', err);
      }

      if (compileOk) {
        try {
          compileOk = await compileLatex(id);
        } catch (err) {
          compileOk = false;
          console.warn('API compileDocument failed:', err);
        }
      }

      setLastSavedTime(
        new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
      );
      flashSaveStatus(compileOk ? 'saved' : 'error', compileOk ? 3000 : 4000);
    },
    [activeDocIdRef, compileLatex, flashSaveStatus],
  );

  // Global Ctrl+S / Cmd+S handler
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        handleManualSave();
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [handleManualSave]);

  const seedNotes = useCallback((notes: Record<string, string>) => {
    setNotesCache((prev) => ({ ...prev, ...notes }));
  }, []);

  const clearNote = useCallback((docId: string) => {
    setNotesCache((prev) => {
      if (!(docId in prev)) return prev;
      const copy = { ...prev };
      delete copy[docId];
      return copy;
    });
    removeStored(STORAGE_KEYS.noteForDoc(docId));
  }, []);

  return {
    notesCache,
    saveStatus,
    lastSavedTime,
    handleNoteChange,
    handleManualSave,
    handleAddToNoteFromPdf,
    seedNotes,
    clearNote,
  };
}
