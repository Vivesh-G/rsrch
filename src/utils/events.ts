import type { CompileDiagnostic } from '../types';

export interface InverseSyncPayload {
  docId: string;
  page: number;
  x: number;
  y: number;
  fx?: number;
  fy?: number;
}

interface AppEventMap {
  'chat-send': {
    message: string;
  };
  'chat-append': {
    text: string;
  };
  'scroll-to-page': { page: number };
  'scroll-to-rect': {
    docId: string;
    page: number;
    x: number;
    y: number;
    width: number;
    height: number;
  };
  'inverse-sync': InverseSyncPayload;
  'latex-compiled': { docId: string };
  'latex-errors': { docId: string; errors: CompileDiagnostic[] };
  'latex-restored': { docId: string; page: number };
  'latex-insert': { code: string };
  'latex-apply': { code: string };
  'bibtex-updated': undefined;
}

type AppEventName = keyof AppEventMap;

let pendingInverseSync: InverseSyncPayload | null = null;

export function queuePendingInverseSync(payload: InverseSyncPayload): void {
  pendingInverseSync = payload;
}

export function consumePendingInverseSync(docId?: string): InverseSyncPayload | null {
  if (!pendingInverseSync) return null;
  if (docId && pendingInverseSync.docId !== docId) return null;
  const payload = pendingInverseSync;
  pendingInverseSync = null;
  return payload;
}

export function emitEvent<K extends AppEventName>(
  name: K,
  ...args: AppEventMap[K] extends undefined ? [] : [AppEventMap[K]]
): void {
  window.dispatchEvent(new CustomEvent(`rsrch:${name}`, { detail: args[0] }));
}

export function onEvent<K extends AppEventName>(
  name: K,
  handler: (detail: AppEventMap[K]) => void,
): () => void {
  const listener = (e: Event) => {
    handler((e as CustomEvent<AppEventMap[K]>).detail);
  };
  window.addEventListener(`rsrch:${name}`, listener);
  return () => window.removeEventListener(`rsrch:${name}`, listener);
}
