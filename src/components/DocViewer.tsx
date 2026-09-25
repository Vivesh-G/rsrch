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
  IconExternalLink,
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
  onClose?: () => void;
  dragHandle?: React.ReactNode;
}

const baseName = (n?: string) => (n || '').replace(/\.pdf$/i, '');
const HL_KEY = (docId: string) => `rsrch-pdf-highlights-${docId}`;
const PAGE_KEY = (docId: string) => `rshr-page-${docId}`;

// Cross-remount handoff for LaTeX auto-renders. Closing + reopening the
// document resets scroll state to page 1, and the page-save effect would
// persist that transient "1" over the user's real position before the
// restore pass runs — every render lands back on page 1. So the compile
// handler captures the true page BEFORE close (map survives the
// LoadedViewer unmount/remount), the save effect pauses while a reload is
// in flight, and the restore pass prefers the captured value.
const latexPageRestore = new Map<string, number>();
const latexReloading = new Set<string>();

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
        } else if (doc.has_file || doc.doc_type === 'latex') {
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

  useEffect(() => {
    let reloadSeq = 0;
    const handleCompile = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.docId === doc.id && (doc.has_file || doc.doc_type === 'latex') && mgrRef.current) {
         try {
            const mgr: any = mgrRef.current;
            const timestamp = Date.now();
            const mySeq = ++reloadSeq;
            // Capture the open page BEFORE close: after close the scroll
            // state resets to 1 and would clobber the saved position.
            let wantPage: number | null = null;
            try {
              const raw = localStorage.getItem(PAGE_KEY(doc.id));
              const n = raw ? parseInt(raw, 10) : NaN;
              if (Number.isFinite(n) && (n as number) >= 1) wantPage = n as number;
            } catch {}
            if (wantPage == null) {
              const fallback = latexPageRestore.get(doc.id);
              if (fallback != null && fallback >= 1) wantPage = fallback;
            }
            if (wantPage != null) latexPageRestore.set(doc.id, wantPage);
            latexReloading.add(doc.id);
            // closeDocument is ASYNC (returns a Task). The previous code
            // fired open immediately after close, so open raced close on
            // the same documentId: the engine could reject with duplicate
            // id or leave the store closed. Network headers still resolve
            // (HTTP 200) while the viewer stays blank — exactly the
            // reported symptom. Chain open after close settles, and drop
            // stale reloads from rapid successive compiles.
            const doOpen = () => {
              if (mySeq !== reloadSeq) return; // superseded by newer compile
              openedRef.current.delete(doc.id);
              openingRef.current.add(doc.id);
              try {
                mgr
                  .openDocumentUrl({
                    url: api.getDocumentFileUrl(doc.id) + "?t=" + timestamp,
                    name: doc.name,
                    documentId: doc.id,
                  })
                  .wait(
                    () => {
                      if (mySeq !== reloadSeq) return;
                      openingRef.current.delete(doc.id);
                      openedRef.current.add(doc.id);
                      // Notify the viewer (covers the path where LoadedViewer
                      // never unmounted so its mount-restore doesn't rerun).
                      // The remount path consumes latexPageRestore instead;
                      // both target the same page so a double-fire is harmless.
                      const target = latexPageRestore.get(doc.id);
                      if (target != null) {
                        window.dispatchEvent(
                          new CustomEvent('rsrch:latex-restored', {
                            detail: { docId: doc.id, page: target },
                          })
                        );
                      }
                      // Grace period: post-open scroll state briefly reports
                      // page 1 before the restore lands — keep the save
                      // effect paused until then so "1" isn't persisted.
                      setTimeout(() => latexReloading.delete(doc.id), 3000);
                    },
                    (reason: unknown) => {
                      console.error('Failed to reload PDF after compile:', reason);
                      openingRef.current.delete(doc.id);
                      latexReloading.delete(doc.id);
                    },
                  );
              } catch (err) {
                console.error('Failed to reload PDF after compile:', err);
                openingRef.current.delete(doc.id);
                latexReloading.delete(doc.id);
              }
            };
            // Reload under the SAME documentId: Viewport/Scroller/RenderLayer
            // and DocumentContent are all bound to doc.id. Opening a new
            // "_latex_<ts>" id orphans the UI (it keeps watching the closed
            // id → blank viewer). Cache-bust via URL query instead.
            try {
              const closeTask = mgr.closeDocument(doc.id);
              if (closeTask && typeof closeTask.wait === 'function') {
                closeTask.wait(() => doOpen(), () => doOpen());
              } else if (closeTask && typeof closeTask.toPromise === 'function') {
                closeTask.toPromise().then(() => doOpen(), () => doOpen());
              } else {
                doOpen();
              }
            } catch {
              doOpen();
            }
         } catch (err) { console.error(err); }
      }
    };
    window.addEventListener('rsrch:latex-compiled', handleCompile);
    return () => {
      reloadSeq++;
      window.removeEventListener('rsrch:latex-compiled', handleCompile);
    };
  }, [doc.id, doc.has_file, doc.doc_type, doc.name]);

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

const MAX_SAVED_ANNOTATIONS = 500;
const MAX_SAVED_ANNOTATIONS_BYTES = 1_000_000;

const transferId = (item: unknown): string | null => {
  const id = (item as AnnotationTransfer)?.annotation?.id;
  return typeof id === 'string' && id ? id : null;
};

// M5: localStorage is same-origin attacker-controlled input. Validate shape
// before handing objects to the WASM engine — id/pageIndex bounds, finite
// numbers, bounded counts — so a poisoned cache can't inject arbitrary
// payloads into importAnnotations.
const isValidTransfer = (item: unknown): boolean => {
  if (typeof item !== 'object' || item === null) return false;
  const ann = (item as AnnotationTransfer)?.annotation;
  if (typeof ann !== 'object' || ann === null) return false;
  if (typeof ann.id !== 'string' || !ann.id || ann.id.length > 128) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(ann.id)) return false;
  if (typeof ann.pageIndex !== 'number' || !Number.isInteger(ann.pageIndex)) return false;
  if (ann.pageIndex < 0 || ann.pageIndex > 10000) return false;
  return true;
};

const sanitizeTransfers = (items: unknown[]): unknown[] => {
  if (!Array.isArray(items)) return [];
  return items.filter(isValidTransfer).slice(0, MAX_SAVED_ANNOTATIONS);
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
        if (raw.length > MAX_SAVED_ANNOTATIONS_BYTES) {
          try {
            localStorage.removeItem(HL_KEY(docId));
          } catch {}
        } else {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length > 0) {
            // If the first item lacks an annotation field, it's the old layout format.
            if (parsed[0]?.annotation) saved = dedupeTransfers(sanitizeTransfers(parsed));
          }
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
        const fresh = sanitizeTransfers(
          wanted.filter((it) => {
            const id = transferId(it);
            return !id || !existing.has(id);
          })
        );
        for (const [id, n] of counts) {
          if (n <= 1) continue;
          const survivor =
            wanted.find((it) => transferId(it) === id) ??
            current.find((it) => transferId(it) === id);
          if (survivor && isValidTransfer(survivor) && !fresh.includes(survivor)) fresh.push(survivor);
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
            const clean = dedupeTransfers(sanitizeTransfers(Array.isArray(exported) ? exported : []));
            const json = JSON.stringify(clean);
            if (json.length > MAX_SAVED_ANNOTATIONS_BYTES) return;
            localStorage.setItem(HL_KEY(docId), json);
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
  isLatex: boolean;
  onAddToNote?: (quoteText: string, pageNumber: number) => void;
  onToast: (msg: string) => void;
}> = ({ menuWrapperProps, documentId, isLatex, onAddToNote, onToast }) => {
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

  const handleGoToBlock = () => {
    try {
      const domSelection = window.getSelection();
      if (domSelection && domSelection.rangeCount > 0) {
        const range = domSelection.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        
        let container: Node | null = range.startContainer;
        if (container.nodeType === Node.TEXT_NODE) {
          container = container.parentElement;
        }
        const pageEl = (container as Element)?.closest('[data-testid^="core__page-layer-"]') as HTMLElement;
        
        if (pageEl) {
          const match = pageEl.getAttribute('data-testid')?.match(/core__page-layer-(\d+)/);
          if (match) {
            const pageIndex = parseInt(match[1], 10);
            const pageRect = pageEl.getBoundingClientRect();
            const x = rect.left - pageRect.left;
            const y = rect.top - pageRect.top;
            
            const pdfWidth = 595.28;
            const pdfHeight = 841.89;
            const pdfX = (x / pageRect.width) * pdfWidth;
            const pdfY = (y / pageRect.height) * pdfHeight;
            
            window.dispatchEvent(
              new CustomEvent('rsrch:inverse-sync', {
                detail: { docId: documentId, page: pageIndex + 1, x: pdfX, y: pdfY }
              })
            );
            selection?.forDocument(documentId)?.clear();
          }
        }
      }
    } catch (err) {
      console.warn('handleGoToBlock failed:', err);
    }
  };

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
        {isLatex ? (
          <button className="pdf-popup-btn primary" onClick={handleGoToBlock} title="Go to source block in editor" type="button">
            <IconExternalLink size={12} />
            <span>Go to Block</span>
          </button>
        ) : (
          <button className="pdf-popup-btn primary" onClick={handleAdd} title="Insert selected quote into notes with page reference" type="button">
            <IconPencil size={12} />
            <span>Add to note</span>
          </button>
        )}
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
  onClose,
  dragHandle,
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
    // Prefer the pre-reload capture (immune to the page-1 clobber); consume
    // it so a later remount falls back to the persisted value.
    const pending = latexPageRestore.get(docId);
    if (pending != null) latexPageRestore.delete(docId);
    const saved = pending != null ? String(pending) : localStorage.getItem(PAGE_KEY(docId));
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

  // Save scroll (paused while a LaTeX reload is in flight — the torn-down
  // document briefly reports page 1, which must not overwrite the real
  // position being restored).
  useEffect(() => {
    if (scrollState?.currentPage && docId && !latexReloading.has(docId)) {
      try {
        localStorage.setItem(PAGE_KEY(docId), String(scrollState.currentPage));
      } catch {}
    }
  }, [scrollState?.currentPage, docId]);

  // Latex-reload restore for the no-unmount path: if LoadedViewer survived
  // the close/open (mount-restore didn't rerun), scroll once layout is
  // measurable. Retries mirror the mount-restore polling.
  useEffect(() => {
    if (!scrollApi || !docId) return;
    const handler = (e: Event) => {
      const d = (e as CustomEvent<{ docId: string; page: number }>).detail;
      if (!d || d.docId !== docId || !d.page || d.page < 1) return;
      let attempts = 0;
      const t = setInterval(() => {
        attempts += 1;
        let ready = false;
        try {
          const layout = (scrollApi as any).getLayout?.();
          ready = Array.isArray(layout?.virtualItems) && layout.virtualItems.length > 0;
        } catch {
          ready = false;
        }
        if (ready) {
          try {
            scrollApi.scrollToPage({ pageNumber: d.page, behavior: 'instant' });
          } catch {}
          latexPageRestore.delete(docId);
          clearInterval(t);
        } else if (attempts >= 16) {
          clearInterval(t);
        }
      }, 250);
    };
    window.addEventListener('rsrch:latex-restored', handler);
    return () => window.removeEventListener('rsrch:latex-restored', handler);
  }, [scrollApi, docId]);

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
    
    const rectHandler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail || !detail.page || detail.page < 1) return;
      try {
        scrollApi?.scrollToPage({ pageNumber: detail.page, behavior: 'smooth' });
      } catch {}
      
      setTimeout(() => {
        // EmbedPDF pages are usually available by index.
        const pageEl = document.querySelector(`[data-testid="core__page-layer-${detail.page - 1}"]`) as HTMLElement;
        if (pageEl) {
          const hl = document.createElement('div');
          hl.className = 'synctex-highlight-pulse';
          hl.style.position = 'absolute';
          // SyncTeX coordinates are in TeX points (1/72.27 inch). 
          // We can approximate by converting to percentages based on A4 size, 
          // but if we use the unscaled PDF points, EmbedPDF applies a scale transform!
          // We'll use percentages assuming ~595x842 as fallback, but use the pageEl's dimensions to scale if it's already scaled.
          // Since it's a quick pulse, a CSS animation on the Y offset will do.
          const pdfWidth = 595.28;
          const pdfHeight = 841.89;
          
          hl.style.left = `${(detail.x / pdfWidth) * 100}%`;
          hl.style.bottom = `${(1 - (detail.y / pdfHeight)) * 100}%`;
          hl.style.width = `${(detail.width / pdfWidth) * 100}%`;
          hl.style.height = `${(detail.height / pdfHeight) * 100}%`;
          hl.style.backgroundColor = 'rgba(255, 200, 0, 0.4)';
          hl.style.zIndex = '999';
          hl.style.pointerEvents = 'none';
          hl.style.borderRadius = '4px';
          hl.style.animation = 'pulse-fade 1.5s ease-out forwards';
          
          pageEl.appendChild(hl);
          setTimeout(() => hl.remove(), 1600);
        }
      }, 100);
    };

    window.addEventListener('rsrch:scroll-to-page', handler);
    window.addEventListener('rsrch:scroll-to-rect', rectHandler);
    return () => {
      window.removeEventListener('rsrch:scroll-to-page', handler);
      window.removeEventListener('rsrch:scroll-to-rect', rectHandler);
    };
  }, [scrollApi]);

  if (!doc) return null;
  const displayTitle = doc.note_title || baseName(doc.name);

  const prevPage = () => scrollApi?.scrollToPreviousPage('smooth');
  const nextPage = () => scrollApi?.scrollToNextPage('smooth');

  const handleDownload = async () => {
    if (!doc) return;
    const downloadName = doc.name.replace(/\.tex$/i, '.pdf');
    if (doc.file) {
      const a = document.createElement('a');
      document.body.appendChild(a);
      const url = URL.createObjectURL(doc.file);
      a.href = url;
      a.download = downloadName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      a.remove();
      showToast('Downloaded PDF');
    } else if (doc.has_file || doc.doc_type === 'latex') {
      try {
        const fileUrl = api.getDocumentFileUrl(doc.id);
        const res = await fetch(fileUrl);
        if (!res.ok) {
          if (res.status === 404) {
            showToast('PDF not ready — please check compile errors first');
            return;
          }
          throw new Error(`Download failed with status ${res.status}`);
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        document.body.appendChild(a);
        a.href = url;
        a.download = downloadName;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        a.remove();
        showToast('Downloaded PDF');
      } catch (err) {
        console.warn('Blob download failed, falling back to direct anchor:', err);
        const a = document.createElement('a');
        document.body.appendChild(a);
        a.href = api.getDocumentFileUrl(doc.id);
        a.download = downloadName;
        a.click();
        a.remove();
      }
    } else if (onDownloadNotes) {
      onDownloadNotes();
    }
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
                <SelectionMenu {...props} documentId={doc.id} isLatex={doc.doc_type === 'latex'} onAddToNote={onAddToNote} onToast={showToast} />
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
        <div className="viewer-toolbar-left" style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0, flexShrink: 1, overflow: 'hidden' }}>
          {dragHandle && <span className="drag-handle-wrapper" style={{ flexShrink: 0 }}>{dragHandle}</span>}
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
        </div>

        <div className="viewer-toolbar-center" style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
          <div className="page-ctrl">
            <button className="icon-btn small" id="prevPage" onClick={prevPage} disabled={currentPage <= 1} title="Previous page" aria-label="Previous page" type="button">‹</button>
            <span className="page-ind">
              <b id="pageNum">{currentPage}</b>
              <span className="page-sep">/</span>
              <span id="pageTotal" className="muted">{totalPages}</span>
            </span>
            <button className="icon-btn small" id="nextPage" onClick={nextPage} disabled={currentPage >= totalPages} title="Next page" aria-label="Next page" type="button">›</button>
          </div>

          <div className="zoom-ctrl">
            <button className="icon-btn small" id="zoomOut" onClick={() => zoomApi?.zoomOut()} title="Zoom out" aria-label="Zoom out" type="button">−</button>
            <span id="zoomLabel" onClick={() => zoomApi?.requestZoom(1 as any)} title="Click to reset zoom (100%)" style={{ cursor: 'pointer' }}>
              {Math.round(zoom * 100)}%
            </span>
            <button className="icon-btn small" id="zoomIn" onClick={() => zoomApi?.zoomIn()} title="Zoom in" aria-label="Zoom in" type="button">+</button>
          </div>
        </div>

        <div className="tool-ctrl" style={{ display: 'inline-flex', alignItems: 'center', gap: '2px', flexShrink: 0, marginLeft: 'auto' }}>
          <button className={`icon-btn small ${tintMode !== 'normal' ? 'tint-active' : ''}`} id="tintBtn" title={`Reading tint: ${tintMode} (click to cycle)`} aria-label={`Reading tint: ${tintMode}`} onClick={cycleTintMode} type="button">
            <IconEye size={14} />
          </button>
          <button className="icon-btn small" id="bookmarkBtn" title="Bookmark document" aria-label={doc.bookmarked ? 'Remove bookmark' : 'Bookmark document'} aria-pressed={doc.bookmarked} onClick={() => onToggleBookmark(doc.id)} type="button">
            {doc.bookmarked ? <IconBookmarkFilled size={14} /> : <IconBookmark size={14} />}
          </button>
          <button className="icon-btn small" id="downloadBtn" title="Download PDF" aria-label="Download PDF" onClick={handleDownload} type="button">
            <IconDownload size={14} />
          </button>
          <button className="icon-btn small" id="presentBtn" title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen presentation'} aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'} onClick={togglePresent} type="button">
            {isFullscreen ? <IconMinimize size={14} /> : <IconMaximize size={14} />}
          </button>
          <button className="icon-btn small tool-delete" id="deleteDocBtn" title={`Delete "${displayTitle}"`} aria-label={`Delete "${displayTitle}"`} onClick={() => onDeleteDoc?.(doc.id)} type="button">
            <IconTrash size={13} />
          </button>
          {onClose && (
            <button
              className="icon-btn small panel-close-btn"
              id="closeViewerBtn"
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

      <div
        className="viewer-body"
        id="viewerBody"
        onDragEnter={(e) => { if (!hasFileDrag(e)) return; e.preventDefault(); setIsDraggingOver(true); }}
        onDragOver={(e) => { if (!hasFileDrag(e)) return; e.preventDefault(); setIsDraggingOver(true); }}
        onDragLeave={(e) => { e.preventDefault(); setIsDraggingOver(false); }}
        onDrop={(e) => { e.preventDefault(); setIsDraggingOver(false); if (e.dataTransfer.files?.length) onDropFiles(e.dataTransfer.files); }}
        onDoubleClick={(e) => {
          const pageEl = (e.target as HTMLElement).closest('[data-testid^="core__page-layer-"]') as HTMLElement;
          if (!pageEl) return;
          const match = pageEl.getAttribute('data-testid')?.match(/core__page-layer-(\d+)/);
          if (!match) return;
          const pageIndex = parseInt(match[1], 10);
          const rect = pageEl.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const y = e.clientY - rect.top;
          const pdfWidth = 595.28;
          const pdfHeight = 841.89;
          const pdfX = (x / rect.width) * pdfWidth;
          const pdfY = (y / rect.height) * pdfHeight;
          window.dispatchEvent(
            new CustomEvent('rsrch:inverse-sync', {
              detail: { docId: doc.id, page: pageIndex + 1, x: pdfX, y: pdfY }
            })
          );
        }}
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
                  {props.onClose && (
                    <div className="tool-ctrl">
                      <button
                        className="icon-btn small panel-close-btn"
                        id="closeViewerLoadingBtn"
                        title="Close PDF viewer (move to right sidebar)"
                        aria-label="Close PDF viewer panel"
                        onClick={props.onClose}
                        type="button"
                      >
                        <IconClose size={13} />
                      </button>
                    </div>
                  )}
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
      prev.onRenameDoc === next.onRenameDoc &&
      prev.onClose === next.onClose
    );
  }
);
