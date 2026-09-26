import { api } from '../services/api';
import { parseSyncTex } from './synctexParser';

export interface SyncTexBlock {
  type: string;
  parent?: SyncTexBlock;
  elements?: SyncTexBlock[];
  fileNumber: number;
  line: number;
  left: number;
  bottom: number;
  width: number;
  height: number;
  page: number;
}

export interface SyncTexData {
  blocks: SyncTexBlock[];
  files: Record<number, string>;
  offset: { x: number; y: number };
}

const cache = new Map<string, { timestamp: number; data: SyncTexData }>();

export async function fetchAndParseSynctex(docId: string): Promise<SyncTexData | null> {
  const cached = cache.get(docId);
  if (cached && Date.now() - cached.timestamp < 2000) {
    return cached.data;
  }
  try {
    const url = `${api.baseUrl}/documents/${docId}/synctex`;
    const res = await fetch(url);
    if (!res.ok) {
      if (res.status !== 404) console.error('Failed to fetch SyncTeX map', res.status);
      return null;
    }
    const text = await res.text();
    if (!text) return null;

    // Tectonic sometimes outputs empty Input lines which crashes synctex-js parser.
    const sanitizedText = text.replace(/Input:(\d+):[ \t]*\r?\n/g, 'Input:$1:dummy$1.tex\n');
    const parsed = parseSyncTex(sanitizedText) as any;
    
    // Flatten all blocks recursively for easier spatial searching
    const allBlocks: SyncTexBlock[] = [];
    const flatten = (block: any, page: number) => {
      if (block.type === 'horizontal' || block.type === 'vertical' || block.type === 'h' || block.type === 'v' || block.type === 'g' || block.type === 'x' || block.type === 'k') {
        block.page = page;
        allBlocks.push(block as SyncTexBlock);
      }
      if (block.elements && Array.isArray(block.elements)) {
        block.elements.forEach((b: any) => flatten(b, page));
      }
      if (block.blocks && Array.isArray(block.blocks)) {
        block.blocks.forEach((b: any) => flatten(b, page));
      }
    };

    if (parsed.pages) {
      for (const [pageNum, pageObj] of Object.entries(parsed.pages)) {
        if ((pageObj as any).blocks) {
          (pageObj as any).blocks.forEach((b: any) => flatten(b, parseInt(pageNum, 10)));
        }
      }
    }

    const data: SyncTexData = {
      blocks: allBlocks,
      files: parsed.files || {},
      offset: parsed.offset || { x: 0, y: 0 }
    };

    cache.set(docId, { timestamp: Date.now(), data });
    return data;
  } catch (err) {
    console.error('Error parsing SyncTeX:', err);
    return null;
  }
}

export function resolveMainFileNumber(data: SyncTexData): number | null {
  // Tectonic usually puts the entrypoint at Input:1, but never assume it:
  // match the doc's .tex name first, else first non-empty input.
  const files = data.files || {};
  const keys = Object.keys(files)
    .map((k) => parseInt(k, 10))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  for (const k of keys) {
    const f: any = (files as any)[k];
    const name = typeof f === 'string' ? f : f?.name ?? f?.path ?? '';
    if (/\.tex$/i.test(name) && !/dummy\d+\.tex$/i.test(name)) return k;
  }
  for (const k of keys) {
    const f: any = (files as any)[k];
    const name = typeof f === 'string' ? f : f?.name ?? f?.path ?? '';
    if (name && name.trim()) return k;
  }
  return keys.length ? keys[0] : null;
}

function blockRight(b: SyncTexBlock): number {
  // Most glyph elements (g/x) carry no width (null) — treat as a point
  // with a small tolerance instead of NaN (which fails every bbox test).
  const w = typeof b.width === 'number' && Number.isFinite(b.width) ? b.width : 8;
  return b.left + w;
}

function blockTop(b: SyncTexBlock): number {
  const h = typeof b.height === 'number' && Number.isFinite(b.height) ? b.height : 10;
  return b.bottom - h;
}

export function syncTexLineToRect(data: SyncTexData, line: number, fileKey?: number) {
  const key = fileKey ?? resolveMainFileNumber(data) ?? 1;
  // Find the blocks that match this line and file
  const matches = data.blocks.filter(b => b.line === line && b.fileNumber === key);
  if (matches.length === 0) {
    // Try fuzzy matching nearby lines if exact line not found
    for (let offset = 1; offset <= 5; offset++) {
      const fuzzy = data.blocks.filter(b => (b.line === line + offset || b.line === line - offset) && b.fileNumber === key);
      if (fuzzy.length > 0) return fuzzy[0];
    }
    return null;
  }
  return matches[0];
}

export function invalidateSynctexCache(docId: string) {
  cache.delete(docId);
}

export function syncTexRectToLine(
  data: SyncTexData,
  page: number,
  x: number,
  y: number,
  opts?: { fx?: number; fy?: number; fileKey?: number },
) {
  // Inverse search: PDF click -> source line. Must never silently return
  // null on whitespace clicks (the reported "200 but no scroll"):
  // 1. exact bbox hit (with padding, null-width safe), else
  // 2. nearest block on the SAME page (no harsh distance cutoff).
  const mainFile = opts?.fileKey ?? resolveMainFileNumber(data) ?? 1;
  const onPage = data.blocks.filter(
    (b) => b.page === page && b.line && (b.fileNumber === mainFile || b.fileNumber == null),
  );
  const scope = onPage.length
    ? onPage
    : data.blocks.filter((b) => b.page === page && b.line);
  if (!scope.length) return null;

  // If the caller passed DOM fractions, map them into SyncTeX space via
  // the page's own extents — no hardcoded A4/letter assumption.
  let px = x;
  let py = y;
  if (
    opts?.fx != null &&
    opts?.fy != null &&
    Number.isFinite(opts.fx) &&
    Number.isFinite(opts.fy)
  ) {
    let maxR = 0;
    let maxB = 0;
    for (const b of scope) {
      if (!Number.isFinite(b.left) || !Number.isFinite(b.bottom)) continue;
      maxR = Math.max(maxR, blockRight(b));
      maxB = Math.max(maxB, b.bottom);
    }
    if (maxR > 0 && maxB > 0) {
      px = opts.fx * maxR;
      py = opts.fy * maxB;
    }
  }

  const PAD = 6; // pt tolerance so clicks near (not inside) glyphs still hit
  for (const block of scope) {
    if (!Number.isFinite(block.left) || !Number.isFinite(block.bottom)) continue;
    const left = block.left;
    const right = blockRight(block);
    const bottom = block.bottom;
    const top = blockTop(block);
    if (px >= left - PAD && px <= right + PAD && py >= top - PAD && py <= bottom + PAD) {
      return block;
    }
  }

  // Whitespace click: nearest center, vertical distance weighted heavier
  // (columns shouldn't steal a match from the adjacent paragraph).
  let closest: SyncTexBlock | null = null;
  let best = Infinity;
  for (const block of scope) {
    if (!Number.isFinite(block.left) || !Number.isFinite(block.bottom)) continue;
    const w = typeof block.width === 'number' && Number.isFinite(block.width)
      ? block.width
      : 8;
    const h = typeof block.height === 'number' && Number.isFinite(block.height)
      ? block.height
      : 10;
    const cx = block.left + w / 2;
    const cy = block.bottom - h / 2;
    const dx = px - cx;
    const dy = (py - cy) * 2;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < best) {
      best = dist;
      closest = block;
    }
  }
  return closest;
}
