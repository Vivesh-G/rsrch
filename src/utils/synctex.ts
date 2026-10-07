import { api } from '../services/api';

export interface SyncTexFile {
  id: number;
  path: string;
  name: string;
}

export interface SyncTexBlock {
  type: string;
  fileNumber: number;
  file?: SyncTexFile;
  line: number;
  column?: number;
  left: number;
  bottom: number;
  width: number;
  height: number;
  depth?: number;
  page: number;
  parent?: SyncTexBlock;
  elements?: SyncTexBlock[];
  blocks?: SyncTexBlock[];
}

export interface SyncTexData {
  version: string;
  unit: number;
  offset: { x: number; y: number };
  files: Record<number, SyncTexFile>;
  pages: Record<number, { page: number; blocks: SyncTexBlock[] }>;
  blocks: SyncTexBlock[];
}

const cache = new Map<string, { timestamp: number; data: SyncTexData }>();

/**
 * Pure TypeScript SyncTeX parser supporting SyncTeX v1, v2, and Tectonic outputs.
 * Correctly captures negative numbers, handles column offsets, applies X/Y margins,
 * and defends against unindexed/missing input files.
 */
export function parseSyncTex(rawContent: string): SyncTexData {
  const result: SyncTexData = {
    version: '',
    unit: 65781.76,
    offset: { x: 0, y: 0 },
    files: {},
    pages: {},
    blocks: [],
  };

  if (!rawContent || !rawContent.trim()) {
    return result;
  }

  const lines = rawContent.split(/\r?\n/);
  let currentPageNum = 1;
  let inContent = false;
  const blockStack: SyncTexBlock[] = [];
  const allBlocks: SyncTexBlock[] = [];

  // Header patterns
  const versionPat = /^SyncTeX Version:\s*(\S+)/i;
  const unitPat = /^Unit:\s*([0-9.]+)/i;
  const xOffsetPat = /^X Offset:\s*(-?[0-9.]+)/i;
  const yOffsetPat = /^Y Offset:\s*(-?[0-9.]+)/i;
  const inputPat = /^Input:\s*([0-9]+)\s*:\s*(.*)/i;

  // Structural patterns
  const openSheetPat = /^\{([0-9]+)/;
  const closeSheetPat = /^\}([0-9]+)/;

  // Box & element patterns with optional column number and negative number support
  // [tag,line(,col)?:x,y:W,H,D
  const vBoxOpenPat = /^\[([0-9]+),([0-9]+)(?:,([0-9]+))?:(-?[0-9]+),(-?[0-9]+):(-?[0-9]+),(-?[0-9]+),(-?[0-9]+)/;
  const vBoxClosePat = /^\]/;
  // (tag,line(,col)?:x,y:W,H,D
  const hBoxOpenPat = /^\(([0-9]+),([0-9]+)(?:,([0-9]+))?:(-?[0-9]+),(-?[0-9]+):(-?[0-9]+),(-?[0-9]+),(-?[0-9]+)/;
  const hBoxClosePat = /^\)/;
  // TypeTag,Line(,Col)?:X,Y(:W(,H,D)?)?
  const elemPat = /^([a-zA-Z$])([0-9]+),([0-9]+)(?:,([0-9]+))?:(-?[0-9]+),(-?[0-9]+)(?::(-?[0-9]+)(?:,(-?[0-9]+),(-?[0-9]+))?)?/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (!inContent) {
      if (line.startsWith('Content:')) {
        inContent = true;
        continue;
      }
      let m = line.match(versionPat);
      if (m) {
        result.version = m[1];
        continue;
      }
      m = line.match(unitPat);
      if (m) {
        const u = parseFloat(m[1]);
        if (Number.isFinite(u) && u > 0) {
          result.unit = u > 1 ? u : 65781.76;
        }
        continue;
      }
      m = line.match(xOffsetPat);
      if (m) {
        const ox = parseFloat(m[1]);
        if (Number.isFinite(ox)) result.offset.x = ox / result.unit;
        continue;
      }
      m = line.match(yOffsetPat);
      if (m) {
        const oy = parseFloat(m[1]);
        if (Number.isFinite(oy)) result.offset.y = oy / result.unit;
        continue;
      }
      m = line.match(inputPat);
      if (m) {
        const fileId = parseInt(m[1], 10);
        const filePath = m[2].trim() || `input_${fileId}.tex`;
        const fileName = filePath.replace(/^.*[\\/]/, '') || filePath;
        result.files[fileId] = {
          id: fileId,
          path: filePath,
          name: fileName,
        };
        continue;
      }
    }

    // Page boundaries
    let m = line.match(openSheetPat);
    if (m) {
      currentPageNum = parseInt(m[1], 10);
      if (!result.pages[currentPageNum]) {
        result.pages[currentPageNum] = { page: currentPageNum, blocks: [] };
      }
      blockStack.length = 0;
      continue;
    }

    m = line.match(closeSheetPat);
    if (m) {
      blockStack.length = 0;
      continue;
    }

    // Vertical Box Open
    m = line.match(vBoxOpenPat);
    if (m) {
      const fileNum = parseInt(m[1], 10);
      const lineNum = parseInt(m[2], 10);
      const colNum = m[3] ? parseInt(m[3], 10) : undefined;
      const left = parseInt(m[4], 10) / result.unit + result.offset.x;
      const bottom = parseInt(m[5], 10) / result.unit + result.offset.y;
      const width = parseInt(m[6], 10) / result.unit;
      const height = parseInt(m[7], 10) / result.unit;
      const depth = parseInt(m[8], 10) / result.unit;

      const fileObj = result.files[fileNum] || {
        id: fileNum,
        path: `file_${fileNum}.tex`,
        name: `file_${fileNum}.tex`,
      };

      const parent = blockStack.length > 0 ? blockStack[blockStack.length - 1] : undefined;
      const block: SyncTexBlock = {
        type: 'vertical',
        fileNumber: fileNum,
        file: fileObj,
        line: lineNum,
        column: colNum,
        left,
        bottom,
        width: Math.max(0, width),
        height: Math.max(0, height),
        depth: Math.max(0, depth),
        page: currentPageNum,
        parent,
        blocks: [],
        elements: [],
      };

      if (parent && parent.blocks) {
        parent.blocks.push(block);
      } else if (result.pages[currentPageNum]) {
        result.pages[currentPageNum].blocks.push(block);
      }

      blockStack.push(block);
      allBlocks.push(block);
      continue;
    }

    if (vBoxClosePat.test(line)) {
      if (blockStack.length > 0) {
        blockStack.pop();
      }
      continue;
    }

    // Horizontal Box Open
    m = line.match(hBoxOpenPat);
    if (m) {
      const fileNum = parseInt(m[1], 10);
      const lineNum = parseInt(m[2], 10);
      const colNum = m[3] ? parseInt(m[3], 10) : undefined;
      const left = parseInt(m[4], 10) / result.unit + result.offset.x;
      const bottom = parseInt(m[5], 10) / result.unit + result.offset.y;
      const width = parseInt(m[6], 10) / result.unit;
      const height = parseInt(m[7], 10) / result.unit;
      const depth = parseInt(m[8], 10) / result.unit;

      const fileObj = result.files[fileNum] || {
        id: fileNum,
        path: `file_${fileNum}.tex`,
        name: `file_${fileNum}.tex`,
      };

      const parent = blockStack.length > 0 ? blockStack[blockStack.length - 1] : undefined;
      const block: SyncTexBlock = {
        type: 'horizontal',
        fileNumber: fileNum,
        file: fileObj,
        line: lineNum,
        column: colNum,
        left,
        bottom,
        width: Math.max(0, width),
        height: Math.max(0, height),
        depth: Math.max(0, depth),
        page: currentPageNum,
        parent,
        blocks: [],
        elements: [],
      };

      if (parent && parent.blocks) {
        parent.blocks.push(block);
      } else if (result.pages[currentPageNum]) {
        result.pages[currentPageNum].blocks.push(block);
      }

      blockStack.push(block);
      allBlocks.push(block);
      continue;
    }

    if (hBoxClosePat.test(line)) {
      if (blockStack.length > 0) {
        blockStack.pop();
      }
      continue;
    }

    // Leaf elements (g, x, k, h, v, $, r)
    m = line.match(elemPat);
    if (m) {
      const type = m[1];
      const fileNum = parseInt(m[2], 10);
      const lineNum = parseInt(m[3], 10);
      const colNum = m[4] ? parseInt(m[4], 10) : undefined;
      const left = parseInt(m[5], 10) / result.unit + result.offset.x;
      const bottom = parseInt(m[6], 10) / result.unit + result.offset.y;
      const width = m[7] != null ? parseInt(m[7], 10) / result.unit : undefined;
      const height = m[8] != null ? parseInt(m[8], 10) / result.unit : undefined;
      const depth = m[9] != null ? parseInt(m[9], 10) / result.unit : undefined;

      const fileObj = result.files[fileNum] || {
        id: fileNum,
        path: `file_${fileNum}.tex`,
        name: `file_${fileNum}.tex`,
      };

      const parent = blockStack.length > 0 ? blockStack[blockStack.length - 1] : undefined;
      const parentH = parent && typeof parent.height === 'number' ? parent.height : 10;
      const elem: SyncTexBlock = {
        type,
        fileNumber: fileNum,
        file: fileObj,
        line: lineNum,
        column: colNum,
        left,
        bottom,
        width: width != null ? Math.max(0, width) : 8,
        height: height != null ? Math.max(0, height) : parentH,
        depth: depth != null ? Math.max(0, depth) : 0,
        page: currentPageNum,
        parent,
      };

      if (parent) {
        if (!parent.elements) parent.elements = [];
        parent.elements.push(elem);
      }

      allBlocks.push(elem);
      continue;
    }
  }

  result.blocks = allBlocks;
  return result;
}

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

    const data = parseSyncTex(text);
    cache.set(docId, { timestamp: Date.now(), data });
    return data;
  } catch (err) {
    console.error('Error parsing SyncTeX:', err);
    return null;
  }
}

export function resolveMainFileNumber(data: SyncTexData): number | null {
  const files = data.files || {};
  const keys = Object.keys(files)
    .map((k) => parseInt(k, 10))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);

  for (const k of keys) {
    const f = files[k];
    const name = f?.name ?? f?.path ?? '';
    if (/\.tex$/i.test(name) && !/dummy\d+\.tex$/i.test(name) && !/input_\d+\.tex$/i.test(name)) {
      return k;
    }
  }
  for (const k of keys) {
    const f = files[k];
    const name = f?.name ?? f?.path ?? '';
    if (name && name.trim()) return k;
  }
  return keys.length ? keys[0] : null;
}

export function invalidateSynctexCache(docId: string) {
  cache.delete(docId);
}

/**
 * Forward search: Code line -> PDF coordinates.
 * Selects the most specific matching box (horizontal box or glyph element)
 * rather than a page-wide vertical container.
 */
export function syncTexLineToRect(
  data: SyncTexData,
  line: number,
  fileKey?: number,
): SyncTexBlock | null {
  const key = fileKey ?? resolveMainFileNumber(data) ?? 1;

  const matches = data.blocks.filter(
    (b) => b.line === line && (b.fileNumber === key || b.fileNumber == null),
  );

  const chooseBestBlock = (candidates: SyncTexBlock[]): SyncTexBlock | null => {
    if (candidates.length === 0) return null;
    const sorted = [...candidates].sort((a, b) => {
      const isAHoriz = a.type === 'horizontal' || a.type === 'h' || a.type === 'g';
      const isBHoriz = b.type === 'horizontal' || b.type === 'h' || b.type === 'g';
      if (isAHoriz && !isBHoriz) return -1;
      if (!isAHoriz && isBHoriz) return 1;

      const areaA = (a.width || 8) * (a.height || 10);
      const areaB = (b.width || 8) * (b.height || 10);
      return areaA - areaB;
    });
    return sorted[0];
  };

  const exact = chooseBestBlock(matches);
  if (exact) return exact;

  // Fuzzy match nearby lines
  for (let offset = 1; offset <= 5; offset++) {
    const nearby = data.blocks.filter(
      (b) =>
        (b.line === line + offset || b.line === line - offset) &&
        (b.fileNumber === key || b.fileNumber == null),
    );
    const best = chooseBestBlock(nearby);
    if (best) return best;
  }

  return null;
}

/**
 * Inverse search: PDF click -> LaTeX line.
 * Tests bounding box hit in PDF coordinate space, with fallback to nearest block.
 */
export function syncTexRectToLine(
  data: SyncTexData,
  page: number,
  x: number,
  y: number,
  opts?: { fx?: number; fy?: number; fileKey?: number },
): SyncTexBlock | null {
  const mainFile = opts?.fileKey ?? resolveMainFileNumber(data) ?? 1;
  const onPage = data.blocks.filter(
    (b) => b.page === page && b.line && (b.fileNumber === mainFile || b.fileNumber == null),
  );
  const scope = onPage.length
    ? onPage
    : data.blocks.filter((b) => b.page === page && b.line);
  if (!scope.length) return null;

  // Standard PDF page dimension reference in pt (A4: 595.28 x 841.89 pt)
  const defaultPageWidth = 595.28;
  const defaultPageHeight = 841.89;

  let px = x;
  let py = y;

  if (
    opts?.fx != null &&
    opts?.fy != null &&
    Number.isFinite(opts.fx) &&
    Number.isFinite(opts.fy)
  ) {
    px = opts.fx * defaultPageWidth;
    py = opts.fy * defaultPageHeight;
  }

  const PAD = 8;
  const directHits: SyncTexBlock[] = [];

  for (const block of scope) {
    if (!Number.isFinite(block.left) || !Number.isFinite(block.bottom)) continue;
    const w = typeof block.width === 'number' && Number.isFinite(block.width) ? block.width : 8;
    const h = typeof block.height === 'number' && Number.isFinite(block.height) ? block.height : 10;
    const d = typeof block.depth === 'number' && Number.isFinite(block.depth) ? block.depth : 2;

    const left = block.left;
    const right = block.left + w;
    const top = block.bottom - h;
    const bottom = block.bottom + d;

    if (
      px >= left - PAD &&
      px <= right + PAD &&
      py >= top - PAD &&
      py <= bottom + PAD
    ) {
      directHits.push(block);
    }
  }

  if (directHits.length > 0) {
    directHits.sort((a, b) => {
      const isAHoriz = a.type === 'horizontal' || a.type === 'h' || a.type === 'g';
      const isBHoriz = b.type === 'horizontal' || b.type === 'h' || b.type === 'g';
      if (isAHoriz && !isBHoriz) return -1;
      if (!isAHoriz && isBHoriz) return 1;
      const areaA = (a.width || 8) * (a.height || 10);
      const areaB = (b.width || 8) * (b.height || 10);
      return areaA - areaB;
    });
    return directHits[0];
  }

  // Margin / whitespace click: closest box center
  let closest: SyncTexBlock | null = null;
  let bestDist = Infinity;

  for (const block of scope) {
    if (!Number.isFinite(block.left) || !Number.isFinite(block.bottom)) continue;
    const w = typeof block.width === 'number' && Number.isFinite(block.width) ? block.width : 8;
    const h = typeof block.height === 'number' && Number.isFinite(block.height) ? block.height : 10;

    const cx = block.left + w / 2;
    const cy = block.bottom - h / 2;

    const dx = px - cx;
    const dy = (py - cy) * 1.5;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < bestDist) {
      bestDist = dist;
      closest = block;
    }
  }

  return closest;
}
