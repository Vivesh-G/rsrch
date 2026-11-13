import { emitEvent, type InverseSyncPayload } from './events';
import { A4_PAGE_HEIGHT, A4_PAGE_WIDTH } from './synctex';

interface EmbedPdfTask<T = unknown> {
  wait?: (onOk: (value: T) => void, onErr: (err: any) => void) => void;
  toPromise?: () => Promise<T>;
}

/** Normalize an EmbedPDF Task ({ wait } or { toPromise }) into a Promise that resolves with fallback on failure. */
export function awaitTask<T>(task: EmbedPdfTask<T> | null | undefined, fallback: T): Promise<T>;
export function awaitTask<T>(task: EmbedPdfTask<T> | null | undefined): Promise<T | undefined>;
export function awaitTask<T>(task: EmbedPdfTask<T> | null | undefined, fallback?: T): Promise<T | undefined> {
  if (!task) return Promise.resolve(fallback);
  if (typeof task.wait === 'function') {
    return new Promise((resolve) => {
      try {
        task.wait!(
          (value) => resolve(value),
          () => resolve(fallback),
        );
      } catch {
        resolve(fallback);
      }
    });
  }
  if (typeof task.toPromise === 'function') {
    return task.toPromise().catch(() => fallback);
  }
  return Promise.resolve(fallback);
}

function isScrollLayoutReady(scrollApi: any): boolean {
  try {
    const layout = scrollApi?.getLayout?.();
    return Array.isArray(layout?.virtualItems) && layout.virtualItems.length > 0;
  } catch {
    return false;
  }
}

/**
 * Poll & listen for EmbedPDF layout readiness before scrolling to `pageNumber`.
 * Returns a cleanup function to cancel pending listeners/intervals.
 */
export function scrollWhenLayoutReady(
  scrollApi: any,
  scrollCapability: any,
  docId: string,
  pageNumber: number,
  onScrolled?: () => void,
  maxAttempts = 16,
): () => void {
  if (!scrollApi || !docId || !Number.isFinite(pageNumber) || pageNumber < 1) {
    return () => {};
  }

  let stopped = false;
  let attempts = 0;
  const unsubs: Array<() => void> = [];

  const finish = () => {
    stopped = true;
    clearInterval(timer);
    for (const u of unsubs) {
      try {
        u();
      } catch {
        // ignore unsubscribe errors
      }
    }
    unsubs.length = 0;
  };

  const attempt = () => {
    if (stopped || !isScrollLayoutReady(scrollApi)) return;
    try {
      scrollApi.scrollToPage({ pageNumber, behavior: 'instant' });
      onScrolled?.();
      finish();
    } catch {
      // Transient (state torn down mid-switch) — keep retrying.
    }
  };

  const timer = setInterval(() => {
    attempts += 1;
    if (attempts >= maxAttempts) finish();
    else attempt();
  }, 250);

  attempt();
  try {
    const u = scrollApi.onLayoutChange?.(() => attempt());
    if (u) unsubs.push(u);
  } catch {
    // ignore
  }
  try {
    const u = scrollCapability?.onLayoutReady?.((ev: any) => {
      if (ev?.documentId === docId) attempt();
    });
    if (u) unsubs.push(u);
  } catch {
    // ignore
  }

  return finish;
}

/**
 * Given a DOM node/element inside an EmbedPDF page layer and client coordinates,
 * compute normalized fractions and emit an `inverse-sync` event.
 */
export function emitInverseSyncFromPoint(
  docId: string,
  target: Node | null,
  clientX: number,
  clientY: number,
): boolean {
  const el = target && target.nodeType === Node.TEXT_NODE ? target.parentElement : (target as Element | null);
  const pageEl = el?.closest('[data-testid^="core__page-layer-"]') as HTMLElement | null;
  if (!pageEl) return false;

  const match = pageEl.getAttribute('data-testid')?.match(/core__page-layer-(\d+)/);
  if (!match) return false;

  const pageRect = pageEl.getBoundingClientRect();
  if (pageRect.width <= 0 || pageRect.height <= 0) return false;

  const pageIndex = parseInt(match[1], 10);
  const fx = Math.min(1, Math.max(0, (clientX - pageRect.left) / pageRect.width));
  const fy = Math.min(1, Math.max(0, (clientY - pageRect.top) / pageRect.height));

  const payload: InverseSyncPayload = {
    docId,
    page: pageIndex + 1,
    x: fx * A4_PAGE_WIDTH,
    y: fy * A4_PAGE_HEIGHT,
    fx,
    fy,
  };
  emitEvent('inverse-sync', payload);
  return true;
}

/** Briefly flash a highlight rectangle over an EmbedPDF page layer for forward SyncTeX. */
export function pulseSyncTexRect(
  page: number,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  setTimeout(() => {
    const pageEl = document.querySelector(`[data-testid="core__page-layer-${page - 1}"]`) as HTMLElement | null;
    if (!pageEl) return;

    const hl = document.createElement('div');
    hl.className = 'synctex-highlight-pulse';
    hl.style.position = 'absolute';
    hl.style.left = `${(x / A4_PAGE_WIDTH) * 100}%`;
    hl.style.bottom = `${(1 - y / A4_PAGE_HEIGHT) * 100}%`;
    hl.style.width = `${(width / A4_PAGE_WIDTH) * 100}%`;
    hl.style.height = `${(height / A4_PAGE_HEIGHT) * 100}%`;
    hl.style.backgroundColor = 'rgba(255, 200, 0, 0.4)';
    hl.style.zIndex = '999';
    hl.style.pointerEvents = 'none';
    hl.style.borderRadius = '4px';
    hl.style.animation = 'pulse-fade 1.5s ease-out forwards';

    pageEl.appendChild(hl);
    setTimeout(() => hl.remove(), 1600);
  }, 100);
}
