import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createPluginRegistration } from '@embedpdf/core';
import { EmbedPDF } from '@embedpdf/core/react';
import { usePdfiumEngine } from '@embedpdf/engines/react';
import { DocumentContent, DocumentManagerPluginPackage, useDocumentManagerCapability } from '@embedpdf/plugin-document-manager/react';
import { Viewport, ViewportPluginPackage } from '@embedpdf/plugin-viewport/react';
import { Scroller, ScrollPluginPackage, useScroll, useScrollCapability } from '@embedpdf/plugin-scroll/react';
import { RenderLayer, RenderPluginPackage } from '@embedpdf/plugin-render/react';
import { ZoomPluginPackage, ZoomMode, useZoom, ZoomGestureWrapper } from '@embedpdf/plugin-zoom/react';
import { InteractionManagerPluginPackage, PagePointerProvider } from '@embedpdf/plugin-interaction-manager/react';
import { SelectionLayer, SelectionPluginPackage, useSelectionCapability } from '@embedpdf/plugin-selection/react';
import { AnnotationLayer, AnnotationPluginPackage, useAnnotationCapability } from '@embedpdf/plugin-annotation/react';
import { HistoryPluginPackage } from '@embedpdf/plugin-history/react';
import { PdfAnnotationSubtype } from '@embedpdf/models';
import type { DocumentItem } from '../types';
import { api } from '../services/api';
import {
  IconBookmark,
  IconBookmarkFilled,
  IconDownload,
  IconMaximize,
  IconMinimize,
  IconTrash,
  IconEye,
  IconDoc,
  IconPencil,
  IconCheck,
  IconHighlighter,
  IconCopy,
  IconClose,
} from './Icons';

// Legacy types kept for export compatibility (pre-EmbedPDF % rects are no
// longer produced; persistent highlights are stored as annotation transfers).
export interface HighlightRect {
  top: number;
  left: number;
  width: number;
  height: number;
}


interface DocViewerProps {
  doc: DocumentItem | null;
  onToggleBookmark: (docId: string) => void;
  onDownloadNotes?: () => void;
  onDeleteDoc?: (docId: string) => void;
  onDropFiles: (files: FileList) => void;
  onAddToNote?: (quoteText: string, pageNumber: number) => void;
  onRenameDoc?: (docId: string, title: string) => void;
}

const baseName = (n?: string) => (n || '').replace(/\.pdf$/i, '');
const HL_KEY = (docId: string) => `rsrch-pdf-highlights-${docId}`;

const plugins = [
  createPluginRegistration(DocumentManagerPluginPackage),
  createPluginRegistration(ViewportPluginPackage),
  createPluginRegistration(ScrollPluginPackage, { defaultPageGap: 24 }),
  createPluginRegistration(RenderPluginPackage),
  createPluginRegistration(InteractionManagerPluginPackage),
  createPluginRegistration(HistoryPluginPackage),
  createPluginRegistration(SelectionPluginPackage),
  createPluginRegistration(AnnotationPluginPackage, { annotationAuthor: 'Rsrch' }),
  // NOTE: must be an auto mode (Automatic/FitPage/FitWidth). A fixed numeric
  // level skips recalcAuto on load, which never releases the viewport gate —
  // leaving the pages blank until the first manual zoom.
  createPluginRegistration(ZoomPluginPackage, { defaultZoomLevel: ZoomMode.Automatic }),
];

// Keeps every opened document open across doc switches. Previously the
// cleanup closed the doc on every switch, so moving back and forth fully
// re-parsed each PDF in pdfium (slow), interleaved close/open races failed
// loads under stress, and scroll/zoom/annotation state was destroyed each
// time. The engine store is keyed by documentId, so multi-open is its
// designed model; switching becomes instant with state intact. Docs close
// only on full viewer unmount (e.g. back to overview). Tradeoff: memory
// grows with open docs instead of re-parse cost — right call for a
// research library of a handful of PDFs.
const DocumentKeeper: React.FC<{ doc: DocumentItem }> = ({ doc }) => {
  const { provides: docManager } = useDocumentManagerCapability();
  const ready = !!docManager;
  const mgrRef = useRef(docManager);
  mgrRef.current = docManager;
  const openedRef = useRef<Set<string>>(new Set());
  const openingRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!ready) return;
    // Synchronous guard: StrictMode double-mounts run this twice; the
    // second run must no-op before any await, or two opens interleave.
    if (openedRef.current.has(doc.id) || openingRef.current.has(doc.id)) return;
    openingRef.current.add(doc.id);
    let cancelled = false;
    const open = async () => {
      const done = (ok: boolean) => {
        openingRef.current.delete(doc.id);
        if (ok) openedRef.current.add(doc.id);
      };
      try {
        const mgr = mgrRef.current;
        if (!mgr) {
          done(false);
          return;
        }
        if (doc.file) {
          const buffer = await doc.file.arrayBuffer();
          if (cancelled) {
            done(false);
            return;
          }
          mgr
            .openDocumentBuffer({ buffer, name: doc.name, documentId: doc.id })
            .wait(
              () => done(true),
              (reason) => {
                console.error('Failed to open PDF buffer:', reason);
                done(false);
              },
            );
        } else if (doc.has_file) {
          if (cancelled) {
            done(false);
            return;
          }
          mgr
            .openDocumentUrl({
              url: api.getDocumentFileUrl(doc.id),
              name: doc.name,
              documentId: doc.id,
            })
            .wait(
              () => done(true),
              (reason) => {
                console.error('Failed to open PDF url:', reason);
                done(false);
              },
            );
        } else {
          done(false);
        }
      } catch (err) {
        console.error('Failed to open PDF in EmbedPDF:', err);
        done(false);
      }
    };
    open();
    // NOTE: no closeDocument here — closing on switch is what made
    // back-and-forth navigation re-parse and race. Full-unmount cleanup
    // below closes everything.
    return () => {
      cancelled = true;
    };
    // NOTE: docManager intentionally excluded — its identity changes on
    // registry updates and would re-trigger open in a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, doc.id, doc.file, doc.has_file, doc.name]);

  // Full unmount only (leaving the viewer): release all engine documents.
  useEffect(() => {
    return () => {
      const mgr = mgrRef.current;
      for (const id of openedRef.current) {
        try {
          mgr?.closeDocument(id);
        } catch {}
      }
      openedRef.current.clear();
      openingRef.current.clear();
    };
  }, []);

  return null;
};

// Restores persisted annotation highlights once the document layout is ready.
// Uses the capability (nullable) instead of useAnnotation(docId), which throws
// when the document state isn't registered yet.
type AnnotationTransfer = { annotation?: { id?: string; pageIndex?: number } };

const transferId = (item: unknown): string | null => {
  const id = (item as AnnotationTransfer)?.annotation?.id;
  return typeof id === 'string' && id ? id : null;
};

// The store appends imported uids to the page array with no dedupe, so
// importing an export that already contains the PDF's own embedded
// highlights renders the same id twice (React duplicate-key warning) and
// every cycle adds more copies. Dedupe keeps first-seen order.
const dedupeTransfers = (items: unknown[]): unknown[] => {
  const seen = new Set<string>();
  return (items || []).filter((it) => {
    const id = transferId(it);
    if (!id) return true; // unidentifiable — can't dedupe, keep it
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
};

// exportAnnotations() returns a Task shaped either { wait } or { toPromise }
// depending on build — normalize to a promise that never rejects.
const exportCurrent = (scope: any): Promise<unknown[]> =>
  new Promise((resolve) => {
    try {
      const task = scope?.exportAnnotations();
      if (!task) return resolve([]);
      const done = (list: unknown) => resolve(Array.isArray(list) ? list : []);
      if (typeof task.wait === 'function') {
        task.wait(done, () => resolve([]));
      } else if (typeof task.toPromise === 'function') {
        task.toPromise().then(done, () => resolve([]));
      } else {
        resolve([]);
      }
    } catch {
      resolve([]);
    }
  });

const HighlightRestorer: React.FC<{ docId: string }> = ({ docId }) => {
  const { provides: annotationCapability } = useAnnotationCapability();

  // Keep a stable ref to the capability so callbacks always use the latest
  // without being listed as effect dependencies (its identity can change on
  // registry updates, which would re-trigger effects in a loop).
  const capRef = useRef(annotationCapability);
  capRef.current = annotationCapability;

  // Import once per doc. We track the doc ID we've already imported for so
  // a doc switch correctly re-imports, but a capability identity change does not.
  // The import is idempotent: ids already in the store are skipped, and ids
  // stored more than once are repaired (delete all copies, re-add one), so
  // foreign embedded highlights can never multiply no matter how often this
  // runs or how the saved payload was produced.
  const importedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!annotationCapability || importedRef.current === docId) return;
    let cancelled = false;
    let saved: unknown[] | null = null;
    try {
      const raw = localStorage.getItem(HL_KEY(docId));
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          // If the first item lacks an annotation field, it's the old layout format.
          if (parsed[0]?.annotation) saved = dedupeTransfers(parsed);
        }
      }
    } catch {
      // Corrupt cache — fall through with saved = null (repair-only run).
    }
    // Defer to allow initial layout pass.
    const t = setTimeout(async () => {
      if (cancelled) return;
      try {
        const scope = capRef.current?.forDocument(docId);
        if (!scope) {
          importedRef.current = docId;
          return;
        }
        const current = await exportCurrent(scope);
        if (cancelled) return;
        const existing = new Set<string>();
        const counts = new Map<string, number>();
        for (const it of current) {
          const id = transferId(it);
          if (!id) continue;
          existing.add(id);
          counts.set(id, (counts.get(id) ?? 0) + 1);
        }
        // Repair duplicated store entries first.
        for (const [id, n] of counts) {
          if (n <= 1) continue;
          const sample = (current.find((it) => transferId(it) === id) as AnnotationTransfer) || {};
          const pageIndex = sample.annotation?.pageIndex ?? 0;
          try {
            scope.deleteAnnotation(pageIndex, id);
          } catch (err) {
            console.warn('Failed to repair duplicate annotation:', err);
          }
        }
        // Import only what's missing; re-add one survivor per repaired id.
        const wanted = saved ?? [];
        const fresh = wanted.filter((it) => {
          const id = transferId(it);
          return !id || !existing.has(id);
        });
        for (const [id, n] of counts) {
          if (n <= 1) continue;
          const survivor =
            wanted.find((it) => transferId(it) === id) ??
            current.find((it) => transferId(it) === id);
          if (survivor && !fresh.includes(survivor)) fresh.push(survivor);
        }
        if (fresh.length > 0) {
          try {
            scope.importAnnotations(fresh as any);
          } catch (err) {
            console.warn('Failed to import annotations:', err);
          }
        }
        try {
          (scope as any)?.commit?.();
        } catch {}
        importedRef.current = docId;
      } catch (err) {
        console.warn('Annotation restore failed:', err);
        importedRef.current = docId;
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // NOTE: annotationCapability intentionally excluded — its identity changes
    // on registry updates, which would cancel the deferred import.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  // Persist on every annotation change.
  // Subscribe at the capability (global) level so the subscription is stable
  // and doesn't churn on capability identity changes.
  useEffect(() => {
    if (!annotationCapability) return;
    const unsub = annotationCapability.onAnnotationEvent((ev: any) => {
      // Only persist events for our document.
      if (ev.documentId !== docId) return;
      try {
        const scope = capRef.current?.forDocument(docId);
        if (!scope) return;
        const task = scope.exportAnnotations();
        // Dedupe before saving so a duplicated store can't poison the cache
        // and multiply further on the next import; quota failure must not
        // throw out of these async callbacks.
        const save = (exported: unknown) => {
          try {
            const clean = dedupeTransfers(Array.isArray(exported) ? exported : []);
            localStorage.setItem(HL_KEY(docId), JSON.stringify(clean));
          } catch (err) {
            console.warn('Failed to persist annotations:', err);
          }
        };
        if (task) {
          if (typeof task.wait === 'function') {
            task.wait(save, (err: any) => console.error('Export failed:', err));
          } else if (typeof (task as any).toPromise === 'function') {
            (task as any).toPromise().then(save).catch((err: any) => console.error('Export failed:', err));
          }
        }
      } catch (err) {
        console.error('onAnnotationEvent error:', err);
      }
    });
    return () => {
      try { unsub?.(); } catch {}
    };
  }, [annotationCapability, docId]);

  return null;
};

// Custom selection menu preserving Add to note / Highlight / Copy UX.
const SelectionMenu: React.FC<{
  menuWrapperProps: any;
  documentId: string;
  onAddToNote?: (quoteText: string, pageNumber: number) => void;
  onToast: (msg: string) => void;
}> = ({ menuWrapperProps, documentId, onAddToNote, onToast }) => {
  const { provides: selection } = useSelectionCapability();
  const { provides: annotationCapability } = useAnnotationCapability();
  let annotationApi: any = null;
  try {
    annotationApi = annotationCapability?.forDocument(documentId) ?? null;
  } catch {
    annotationApi = null;
  }

  const withText = (fn: (text: string, pageNumber: number) => void) => () => {
    try {
      const scope = selection?.forDocument(documentId);
      if (!scope) return;
      const formatted = scope.getFormattedSelection();
      const first = formatted?.[0];
      const pageNumber = first ? first.pageIndex + 1 : 1;
      scope.getSelectedText().wait(
        (lines: string[]) => {
          const text = (lines || []).join(' ').trim();
          if (!text) return;
          fn(text, pageNumber);
        },
        () => {},
      );
    } catch (err) {
      console.warn('Selection action failed:', err);
    }
  };

  const handleAdd = withText((text, pageNumber) => {
    onAddToNote?.(text, pageNumber);
    onToast(`Added quote from Page ${pageNumber} to note`);
    selection?.forDocument(documentId)?.clear();
  });

  const handleCopy = withText((text, pageNumber) => {
    const clean = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(' ');
    navigator.clipboard?.writeText(`> "${clean}" [p. ${pageNumber}]`).then(() => {
      onToast('Copied citation to clipboard');
    }).catch(() => {
      onToast('Copy failed — clipboard unavailable');
    });
    selection?.forDocument(documentId)?.clear();
  });

  const handleHighlight = () => {
    try {
      const scope = selection?.forDocument(documentId);
      const formatted = scope?.getFormattedSelection() ?? [];
      if (!scope || formatted.length === 0) return;
      scope.getSelectedText().wait(
        (lines: string[]) => {
          const text = (lines || []).join(' ').trim();
          for (const f of formatted) {
            const bounding =
              f.rect ??
              (f.segmentRects?.[0] as any);
            if (!bounding) continue;
            try {
              (annotationApi as any)?.createAnnotation?.(f.pageIndex, {
                id: `hl_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
                type: PdfAnnotationSubtype.HIGHLIGHT,
                pageIndex: f.pageIndex,
                rect: bounding,
                segmentRects: f.segmentRects,
                contents: text,
                opacity: 1,
                strokeColor: '#FACC15',
              });
            } catch (err) {
              console.warn('createAnnotation failed:', err);
            }
          }
          
          try {
             const commitTask = (annotationApi as any)?.commit?.();
             if (commitTask && typeof commitTask.toPromise === 'function') {
                 commitTask.toPromise().catch(console.error);
             } else if (commitTask && typeof commitTask.wait === 'function') {
                 commitTask.wait(() => {}, console.error);
             }
          } catch (err) {
             console.error('commit failed', err);
          }

          onToast(
            formatted.length === 1
              ? `Highlighted text on Page ${formatted[0].pageIndex + 1}`
              : `Highlighted across ${formatted.length} pages`,
          );
          scope.clear();
        },
        () => {},
      );
    } catch (err) {
      console.warn('Highlight failed:', err);
    }
  };

  return (
    <div {...menuWrapperProps}>
      {/* Wrapper is the selection box (top-left anchored) — left:50% pairs
          with the CSS translate(-50%,-100%) to center the menu above it. */}
      <div className="pdf-selection-popup" style={{ position: 'absolute', left: '50%', pointerEvents: 'auto' }}>
        <button className="pdf-popup-btn primary" onClick={handleAdd} title="Insert selected quote into notes with page reference" type="button">
          <IconPencil size={12} />
          <span>Add to note</span>
        </button>
        <button className="pdf-popup-btn" onClick={handleHighlight} title="Highlight selected text on document" type="button">
          <IconHighlighter size={12} />
          <span>Highlight</span>
        </button>
        <button className="pdf-popup-btn" onClick={handleCopy} title="Copy citation to clipboard" type="button">
          <IconCopy size={12} />
          <span>Copy</span>
        </button>
        <button
          className="pdf-popup-btn close"
          onClick={() => selection?.forDocument(documentId)?.clear()}
          title="Dismiss"
          type="button"
        >
          <IconClose size={10} />
        </button>
      </div>
    </div>
  );
};

// Mounted only once DocumentContent reports isLoaded — useScroll/useZoom
// throw when the document state isn't registered yet, so they must not mount
// before the open completes (or after close on doc switch).
const LoadedViewer: React.FC<DocViewerProps> = ({
  doc,
  onToggleBookmark,
  onDownloadNotes,
  onDeleteDoc,
  onDropFiles,
  onAddToNote,
  onRenameDoc,
}) => {
  const docViewRef = useRef<HTMLDivElement>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  // No key={doc.id} remount here on purpose: remounting the whole
  // viewport/scroller/gesture subtree against persisted engine state caused
  // revisit-only breakage (shifted layout, dead touchpad zoom). The subtree
  // switches docs via documentId props — the library's designed flow.
  // Per-doc UI state lives in maps/sets below instead of fresh mounts.
  const [tints, setTints] = useState<Record<string, 'normal' | 'sepia' | 'invert'>>({});
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  const docId = doc?.id ?? '';
  const tintMode = (docId && tints[docId]) || 'normal';
  const { provides: scrollApi, state: scrollState } = useScroll(docId);
  const { provides: zoomApi, state: zoomState } = useZoom(docId);

  const currentPage = scrollState?.currentPage ?? 1;
  const totalPages = scrollState?.totalPages ?? 1;
  const zoom = zoomState?.currentZoomLevel ?? 1;

  // Transient UI resets on doc switch (previously handled by remount).
  useEffect(() => {
    setRenaming(false);
    setRenameValue('');
    setToastMessage(null);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
  }, [docId]);

  const cycleTintMode = () =>
    setTints((prev) => ({
      ...prev,
      [docId]: prev[docId] === 'normal' || !prev[docId] ? 'sepia' : prev[docId] === 'sepia' ? 'invert' : 'normal',
    }));

  const scrollRestoredRef = useRef<Set<string>>(new Set());
  const { provides: scrollCapability } = useScrollCapability();

  // Restore last-viewed page. scrollToPage() sets the page NUMBER first and
  // only moves the viewport if the page's position is already measured —
  // calling it pre-layout updates the toolbar while leaving the view on
  // page 1. So gate on measurable layout (virtualItems), not on the number:
  // poll until positions exist, then scroll 'instant'. Layout events are
  // extra triggers (onLayoutChange replays the last layout to subscribers).
  useEffect(() => {
    if (!scrollApi || !docId || scrollRestoredRef.current.has(docId)) return;
    const saved = localStorage.getItem(`rshr-page-${docId}`);
    if (!saved) { scrollRestoredRef.current.add(docId); return; }
    const pageNum = parseInt(saved, 10);
    if (isNaN(pageNum) || pageNum < 1) { scrollRestoredRef.current.add(docId); return; }
    // Mark immediately to prevent duplicate attempts from re-renders.
    scrollRestoredRef.current.add(docId);
    let stopped = false;
    let attempts = 0;
    const MAX_ATTEMPTS = 16; // ~4s
    const unsubs: Array<() => void> = [];
    const finish = () => {
      stopped = true;
      clearInterval(timer);
      for (const u of unsubs) {
        try { u(); } catch {}
      }
      unsubs.length = 0;
    };
    const layoutReady = (): boolean => {
      try {
        const layout = scrollApi.getLayout();
        return Array.isArray(layout?.virtualItems) && layout.virtualItems.length > 0;
      } catch {
        return false; // no doc state yet
      }
    };
    const attempt = () => {
      if (stopped || !layoutReady()) return;
      try {
        scrollApi.scrollToPage({ pageNumber: pageNum, behavior: 'instant' });
        finish();
      } catch {
        // Transient (state torn down mid-switch) — keep retrying.
      }
    };
    const timer = setInterval(() => {
      attempts += 1;
      if (attempts > MAX_ATTEMPTS) finish();
      else attempt();
    }, 250);
    attempt();
    try {
      unsubs.push(scrollApi.onLayoutChange(() => attempt()));
    } catch {}
    try {
      const u = scrollCapability?.onLayoutReady((ev: any) => {
        if (ev.documentId === docId) attempt();
      });
      if (u) unsubs.push(u);
    } catch {}
    return () => {
      finish();
    };
  }, [scrollApi, scrollCapability, docId]);

  // Save scroll
  useEffect(() => {
    if (scrollState?.currentPage && docId) {
      localStorage.setItem(`rshr-page-${docId}`, String(scrollState.currentPage));
    }
  }, [scrollState?.currentPage, docId]);

  const showToast = useCallback((msg: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToastMessage(msg);
    toastTimerRef.current = setTimeout(() => setToastMessage(null), 2800);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const handleFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', handleFsChange);
    return () => document.removeEventListener('fullscreenchange', handleFsChange);
  }, []);

  // Drop hint must only react to FILE drags. Native text-selection drags also
  // fire dragenter/dragover — without this guard the "Drop PDF here" overlay
  // appears mid-selection, covers the pages, and can get stuck on.
  const hasFileDrag = (e: React.DragEvent) => {
    try {
      return Array.from(e.dataTransfer?.types ?? []).includes('Files');
    } catch {
      return false;
    }
  };

  // Safety net: a drag cancelled outside the viewer (Esc, drop elsewhere)
  // fires no dragleave/drop here — always reset so the hint can't stick.
  useEffect(() => {
    const reset = () => setIsDraggingOver(false);
    window.addEventListener('dragend', reset);
    window.addEventListener('drop', reset);
    return () => {
      window.removeEventListener('dragend', reset);
      window.removeEventListener('drop', reset);
    };
  }, []);

  // Preserve the rsrch:scroll-to-page contract from the notes panel.
  useEffect(() => {
    const handler = (e: Event) => {
      const page = (e as CustomEvent<{ page: number }>).detail?.page;
      if (!page || page < 1) return;
      try {
        scrollApi?.scrollToPage({ pageNumber: page, behavior: 'smooth' });
      } catch {
        document.getElementById(`pdf-page-${page}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      const el = document.getElementById(`pdf-page-${page}`);
      if (el) {
        el.classList.remove('pdf-page-focus-pulse');
        void el.offsetWidth;
        el.classList.add('pdf-page-focus-pulse');
        setTimeout(() => el.classList.remove('pdf-page-focus-pulse'), 1800);
      }
    };
    window.addEventListener('rsrch:scroll-to-page', handler);
    return () => window.removeEventListener('rsrch:scroll-to-page', handler);
  }, [scrollApi]);

  if (!doc) return null;
  const displayTitle = doc.note_title || baseName(doc.name);

  const prevPage = () => scrollApi?.scrollToPreviousPage('smooth');
  const nextPage = () => scrollApi?.scrollToNextPage('smooth');

  const handleDownload = () => {
    const a = document.createElement('a');
    // Detached-anchor click() is ignored by Firefox/Safari — append first.
    document.body.appendChild(a);
    if (doc.file) {
      const url = URL.createObjectURL(doc.file);
      a.href = url;
      a.download = doc.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } else if (doc.has_file) {
      a.href = api.getDocumentFileUrl(doc.id);
      a.download = doc.name;
      a.click();
    } else if (onDownloadNotes) {
      a.remove();
      onDownloadNotes();
      return;
    }
    a.remove();
  };

  const togglePresent = () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else docViewRef.current?.requestFullscreen?.();
  };

  // Stable page renderer: Scroller receives this per page, so an inline
  // closure would re-render every page on each toolbar tick (zoom/page).
  const renderPage = useCallback(
    ({ width, height, pageIndex }: { width: number; height: number; pageIndex: number }) => {
      if (!doc) return null;
      const pageNumber = pageIndex + 1;
      return (
        <div
          id={`pdf-page-${pageNumber}`}
          data-page-number={pageNumber}
          className={`pdf-page-wrapper tint-${tintMode}`}
          style={{ width, height, position: 'relative' }}
        >
          <PagePointerProvider documentId={doc.id} pageIndex={pageIndex}>
            {/* RenderLayer outputs a native <img> (draggable by default),
                which hijacks selection gestures into image drags and
                trips the drop hint — disable dragging at the source. */}
            <RenderLayer
              documentId={doc.id}
              pageIndex={pageIndex}
              draggable={false}
              onDragStart={(e) => e.preventDefault()}
            />
            <SelectionLayer
              documentId={doc.id}
              pageIndex={pageIndex}
              selectionMenu={(props: any) => (
                <SelectionMenu {...props} documentId={doc.id} onAddToNote={onAddToNote} onToast={showToast} />
              )}
            />
            <AnnotationLayer documentId={doc.id} pageIndex={pageIndex} />
          </PagePointerProvider>
          <span className="pdf-page-number-badge">Page {pageNumber}</span>
        </div>
      );
    },
    [doc?.id, tintMode, onAddToNote, showToast]
  );

  return (
    <div id="docView" className="doc-view" ref={docViewRef}>
      <div className="viewer-toolbar">
        <div className="file-name" title={renaming ? `Source: ${doc.name}` : `Source: ${doc.name} (click to rename)`}>
          <IconDoc size={13} className="viewer-doc-icon" />
          {renaming ? (
            <input
              className="inline-rename-input"
              value={renameValue}
              autoFocus
              onFocus={(e) => e.target.select()}
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={() => {
                setRenaming(false);
                if (renameValue.trim() && renameValue.trim() !== displayTitle) {
                  onRenameDoc?.(doc.id, renameValue);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') setRenaming(false);
              }}
              onClick={(e) => e.stopPropagation()}
              maxLength={120}
            />
          ) : (
            <span
              id="currentFileName"
              className="name-text"
              style={onRenameDoc ? { cursor: 'text' } : undefined}
              onClick={() => {
                if (!onRenameDoc) return;
                setRenameValue(displayTitle);
                setRenaming(true);
              }}
            >
              {displayTitle}
            </span>
          )}
        </div>

        <div className="page-ctrl">
          <button className="icon-btn small" id="prevPage" onClick={prevPage} disabled={currentPage <= 1} title="Previous page" type="button">‹</button>
          <span className="page-ind">
            <b id="pageNum">{currentPage}</b>
            <span className="page-sep">/</span>
            <span id="pageTotal" className="muted">{totalPages}</span>
          </span>
          <button className="icon-btn small" id="nextPage" onClick={nextPage} disabled={currentPage >= totalPages} title="Next page" type="button">›</button>
        </div>

        <div className="zoom-ctrl">
          <button className="icon-btn small" id="zoomOut" onClick={() => zoomApi?.zoomOut()} title="Zoom out" type="button">−</button>
          <span id="zoomLabel" onClick={() => zoomApi?.requestZoom(1 as any)} title="Click to reset zoom (100%)" style={{ cursor: 'pointer' }}>
            {Math.round(zoom * 100)}%
          </span>
          <button className="icon-btn small" id="zoomIn" onClick={() => zoomApi?.zoomIn()} title="Zoom in" type="button">+</button>
        </div>

        <div className="tool-ctrl">
          <button className={`icon-btn small ${tintMode !== 'normal' ? 'tint-active' : ''}`} id="tintBtn" title={`Reading tint: ${tintMode} (click to cycle)`} onClick={cycleTintMode} type="button">
            <IconEye size={14} />
          </button>
          <button className="icon-btn small" id="bookmarkBtn" title="Bookmark document" onClick={() => onToggleBookmark(doc.id)} type="button">
            {doc.bookmarked ? <IconBookmarkFilled size={14} /> : <IconBookmark size={14} />}
          </button>
          <button className="icon-btn small" id="downloadBtn" title="Download PDF" onClick={handleDownload} type="button">
            <IconDownload size={14} />
          </button>
          <button className="icon-btn small" id="presentBtn" title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen presentation'} onClick={togglePresent} type="button">
            {isFullscreen ? <IconMinimize size={14} /> : <IconMaximize size={14} />}
          </button>
          <button className="icon-btn small tool-delete" id="deleteDocBtn" title={`Delete "${displayTitle}"`} onClick={() => onDeleteDoc?.(doc.id)} type="button">
            <IconTrash size={13} />
          </button>
        </div>
      </div>

      <div
        className="viewer-body"
        id="viewerBody"
        onDragEnter={(e) => { if (!hasFileDrag(e)) return; e.preventDefault(); setIsDraggingOver(true); }}
        onDragOver={(e) => { if (!hasFileDrag(e)) return; e.preventDefault(); setIsDraggingOver(true); }}
        onDragLeave={(e) => { e.preventDefault(); setIsDraggingOver(false); }}
        onDrop={(e) => { e.preventDefault(); setIsDraggingOver(false); if (e.dataTransfer.files?.length) onDropFiles(e.dataTransfer.files); }}
      >
        <HighlightRestorer docId={doc.id} />
        <Viewport documentId={doc.id} style={{ flex: 1, minHeight: 0, width: '100%', height: '100%', background: 'transparent' }}>
          <ZoomGestureWrapper documentId={doc.id}>
            <Scroller
              documentId={doc.id}
              renderPage={renderPage}
            />
          </ZoomGestureWrapper>
        </Viewport>

        {toastMessage && (
          <div className="pdf-cite-toast" role="status">
            <IconCheck size={12} />
            <span>{toastMessage}</span>
          </div>
        )}

        {isDraggingOver && (
          <div id="dropHint" className="drop-hint">Drop PDF here to upload</div>
        )}
      </div>
    </div>
  );
};

// Thin shell with no document-scoped hooks: opens the doc and only mounts
// LoadedViewer (useScroll/useZoom) once the document is registered.
const InnerViewer: React.FC<DocViewerProps> = (props) => {
  const { doc } = props;
  if (!doc) return null;
  const displayTitle = doc.note_title || baseName(doc.name);
  return (
    <div id="docView" className="doc-view">
      <DocumentKeeper doc={doc} />
      <DocumentContent documentId={doc.id}>
        {({ isLoading, isError, isLoaded }) => (
          <>
            {!isLoaded && !isError && (
              <>
                <div className="viewer-toolbar">
                  <div className="file-name" title={`Source: ${doc.name}`}>
                    <IconDoc size={13} className="viewer-doc-icon" />
                    <span className="name-text">{displayTitle}</span>
                  </div>
                </div>
                <div className="viewer-body">
                  <div className="pdf-loading-spinner">
                    <span>{isLoading ? 'Loading pages…' : 'Opening document…'}</span>
                  </div>
                </div>
              </>
            )}
            {isError && (
              <div className="viewer-body">
                <div className="pdf-loading-spinner"><span>Failed to load PDF</span></div>
              </div>
            )}
            {isLoaded && <LoadedViewer {...props} />}
          </>
        )}
      </DocumentContent>
    </div>
  );
};

const DocViewerInner: React.FC<DocViewerProps> = (props) => {
  const { engine, isLoading, error } = usePdfiumEngine();

  if (!props.doc) return null;
  if (isLoading || !engine) {
    return (
      <div id="docView" className="doc-view">
        <div className="pdf-loading-spinner"><span>Loading PDF engine…</span></div>
      </div>
    );
  }
  if (error) {
    return (
      <div id="docView" className="doc-view">
        <div className="pdf-loading-spinner"><span>Failed to load PDF engine</span></div>
      </div>
    );
  }

  return (
    <EmbedPDF engine={engine} plugins={plugins}>
      <InnerViewer {...props} />
    </EmbedPDF>
  );
};

export const DocViewer: React.FC<DocViewerProps> = React.memo(
  DocViewerInner,
  (prev, next) => {
    const a = prev.doc;
    const b = next.doc;
    if (a?.id !== b?.id) return false;
    if (a?.name !== b?.name) return false;
    if (a?.note_title !== b?.note_title) return false;
    if (a?.bookmarked !== b?.bookmarked) return false;
    if (a?.has_file !== b?.has_file) return false;
    if ((a?.file ?? null) !== (b?.file ?? null)) return false;
    return (
      prev.onToggleBookmark === next.onToggleBookmark &&
      prev.onDownloadNotes === next.onDownloadNotes &&
      prev.onDeleteDoc === next.onDeleteDoc &&
      prev.onDropFiles === next.onDropFiles &&
      prev.onAddToNote === next.onAddToNote &&
      prev.onRenameDoc === next.onRenameDoc
    );
  }
);
