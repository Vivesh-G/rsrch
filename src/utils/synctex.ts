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

export function syncTexLineToRect(data: SyncTexData, line: number, fileKey = 1) {
  // Find the blocks that match this line and file
  const matches = data.blocks.filter(b => b.line === line && b.fileNumber === fileKey);
  if (matches.length === 0) {
    // Try fuzzy matching nearby lines if exact line not found
    for (let offset = 1; offset <= 5; offset++) {
      const fuzzy = data.blocks.filter(b => (b.line === line + offset || b.line === line - offset) && b.fileNumber === fileKey);
      if (fuzzy.length > 0) return fuzzy[0];
    }
    return null;
  }
  return matches[0];
}

export function invalidateSynctexCache(docId: string) {
  cache.delete(docId);
}

export function syncTexRectToLine(data: SyncTexData, page: number, x: number, y: number) {
  // Find the block that encloses this point
  // Note: SyncTeX coordinates are in TeX points (72.27 per inch) from top-left, but 'bottom' is used in h/v boxes.
  // synctex-js usually normalizes these, but we may need a proximity search.
  
  let closest: SyncTexBlock | null = null;
  let minDistance = Infinity;

  for (const block of data.blocks) {
    if (block.page !== page) continue;
    // Simple bounding box check
    // In SyncTeX, left, bottom, width, height are given.
    // 'bottom' is actually the baseline.
    const left = block.left;
    const right = left + block.width;
    const bottom = block.bottom;
    const top = bottom - block.height; // approximate top

    if (x >= left && x <= right && y >= top && y <= bottom) {
      if (block.line && block.fileNumber === 1) { // main.tex is usually fileNumber 1
        return block;
      }
    }

    // Distance metric for fallback
    const cx = left + block.width / 2;
    const cy = bottom - block.height / 2;
    const dist = Math.sqrt(Math.pow(x - cx, 2) + Math.pow(y - cy, 2));
    if (dist < minDistance && block.line && block.fileNumber === 1) {
      minDistance = dist;
      closest = block;
    }
  }

  // If clicked directly in a box, closest distance is best fallback
  if (minDistance < 100) return closest;
  return null;
}
