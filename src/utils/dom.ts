/** Convert Unix timestamp (seconds or ms) cleanly to milliseconds. */
export function toMs(ts: number): number {
  return ts < 1e12 ? ts * 1000 : ts;
}

/** Trigger a browser file download from an arbitrary URL. */
export function triggerDownloadUrl(url: string, filename: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/** Trigger a browser file download from a text or binary payload. */
export function triggerDownloadBlob(
  content: BlobPart,
  filename: string,
  mimeType: string = 'text/plain',
): void {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  triggerDownloadUrl(url, filename);
  URL.revokeObjectURL(url);
}

/** Position a floating menu near a caret/anchor rect, flipping above if needed and clamping to viewport. */
export function computePopoverCoords(
  anchor: { left: number; top: number; bottom: number },
  menuWidth = 280,
  menuHeight = 250,
  margin = 12,
): { top: number; left: number } {
  const spaceBelow = window.innerHeight - anchor.bottom;
  const top =
    spaceBelow < menuHeight && anchor.top > menuHeight
      ? Math.max(margin, anchor.top - menuHeight - 6)
      : Math.min(window.innerHeight - menuHeight - margin, anchor.bottom + 4);
  const left = Math.max(margin, Math.min(window.innerWidth - menuWidth - margin, anchor.left));
  return { top, left };
}
