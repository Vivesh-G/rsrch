// Standard PDF A4 page dimensions in pt (72 pt/in)
export const A4_PAGE_WIDTH = 595.28;
export const A4_PAGE_HEIGHT = 841.89;

interface SyncTexFile {
  id: number;
  path: string;
  name: string;
}

interface SyncTexBlock {
  type: string;
  fileNumber: number;
  file?: SyncTexFile;
  line: number;
  left: number;
  bottom: number;
  width: number;
  height: number;
  depth: number;
  page: number;
}

export interface SyncTexData {
  version: string;
  unit: number;
  offset: { x: number; y: number };
  files: Record<number, SyncTexFile>;
  blocks: SyncTexBlock[];
}

function compareBlocksBySpecificity(a: SyncTexBlock, b: SyncTexBlock): number {
  const isAHoriz = a.type === 'horizontal' || a.type === 'h' || a.type === 'g';
  const isBHoriz = b.type === 'horizontal' || b.type === 'h' || b.type === 'g';
  if (isAHoriz !== isBHoriz) return isAHoriz ? -1 : 1;

  const areaA = (a.width || 8) * (a.height || 10);
  const areaB = (b.width || 8) * (b.height || 10);
  return areaA - areaB;
}

function chooseBestBlock(candidates: SyncTexBlock[]): SyncTexBlock | null {
  if (candidates.length === 0) return null;
  return [...candidates].sort(compareBlocksBySpecificity)[0];
}

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
    blocks: [],
  };

  if (!rawContent || !rawContent.trim()) {
    return result;
  }

  const lines = rawContent.split(/\r?\n/);
  let currentPageNum = 1;
  let inContent = false;
  const heightStack: number[] = [];

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
  // `[` = vertical box, `(` = horizontal box: [tag,line(,col)?:x,y:W,H,D
  const boxOpenPat =
    /^([[(])([0-9]+),([0-9]+)(?:,[0-9]+)?:(-?[0-9]+),(-?[0-9]+):(-?[0-9]+),(-?[0-9]+),(-?[0-9]+)/;
  const boxClosePat = /^[)\]]/;
  // TypeTag,Line(,Col)?:X,Y(:W(,H,D)?)?
  const elemPat =
    /^([a-zA-Z$])([0-9]+),([0-9]+)(?:,[0-9]+)?:(-?[0-9]+),(-?[0-9]+)(?::(-?[0-9]+)(?:,(-?[0-9]+),(-?[0-9]+))?)?/;

  const fileFor = (fileNum: number): SyncTexFile =>
    result.files[fileNum] || {
      id: fileNum,
      path: `file_${fileNum}.tex`,
      name: `file_${fileNum}.tex`,
    };

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
      heightStack.length = 0;
      continue;
    }

    if (closeSheetPat.test(line)) {
      heightStack.length = 0;
      continue;
    }

    // Vertical (`[`) or Horizontal (`(`) Box Open
    m = line.match(boxOpenPat);
    if (m) {
      const fileNum = parseInt(m[2], 10);
      const lineNum = parseInt(m[3], 10);
      const height = Math.max(0, parseInt(m[7], 10) / result.unit);
      result.blocks.push({
        type: m[1] === '[' ? 'vertical' : 'horizontal',
        fileNumber: fileNum,
        file: fileFor(fileNum),
        line: lineNum,
        left: parseInt(m[4], 10) / result.unit + result.offset.x,
        bottom: parseInt(m[5], 10) / result.unit + result.offset.y,
        width: Math.max(0, parseInt(m[6], 10) / result.unit),
        height,
        depth: Math.max(0, parseInt(m[8], 10) / result.unit),
        page: currentPageNum,
      });
      heightStack.push(height);
      continue;
    }

    if (boxClosePat.test(line)) {
      if (heightStack.length > 0) heightStack.pop();
      continue;
    }

    // Leaf elements (g, x, k, h, v, $, r)
    m = line.match(elemPat);
    if (m) {
      const fileNum = parseInt(m[2], 10);
      const lineNum = parseInt(m[3], 10);
      const width = m[6] != null ? parseInt(m[6], 10) / result.unit : undefined;
      const height = m[7] != null ? parseInt(m[7], 10) / result.unit : undefined;
      const depth = m[8] != null ? parseInt(m[8], 10) / result.unit : undefined;
      const parentH = heightStack.length > 0 ? heightStack[heightStack.length - 1] : 10;

      result.blocks.push({
        type: m[1],
        fileNumber: fileNum,
        file: fileFor(fileNum),
        line: lineNum,
        left: parseInt(m[4], 10) / result.unit + result.offset.x,
        bottom: parseInt(m[5], 10) / result.unit + result.offset.y,
        width: width != null ? Math.max(0, width) : 8,
        height: height != null ? Math.max(0, height) : parentH,
        depth: depth != null ? Math.max(0, depth) : 0,
        page: currentPageNum,
      });
    }
  }

  return result;
}

function resolveMainFileNumber(data: SyncTexData): number | null {
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

  const exact = chooseBestBlock(
    data.blocks.filter((b) => b.line === line && (b.fileNumber === key || b.fileNumber == null)),
  );
  if (exact) return exact;

  // Fuzzy match nearby lines
  for (let offset = 1; offset <= 5; offset++) {
    const best = chooseBestBlock(
      data.blocks.filter(
        (b) =>
          (b.line === line + offset || b.line === line - offset) &&
          (b.fileNumber === key || b.fileNumber == null),
      ),
    );
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

  let px = x;
  let py = y;

  if (
    opts?.fx != null &&
    opts?.fy != null &&
    Number.isFinite(opts.fx) &&
    Number.isFinite(opts.fy)
  ) {
    px = opts.fx * A4_PAGE_WIDTH;
    py = opts.fy * A4_PAGE_HEIGHT;
  }

  const PAD = 8;
  const directHits: SyncTexBlock[] = [];

  for (const block of scope) {
    if (!Number.isFinite(block.left) || !Number.isFinite(block.bottom)) continue;
    const w = Number.isFinite(block.width) ? block.width : 8;
    const h = Number.isFinite(block.height) ? block.height : 10;
    const d = Number.isFinite(block.depth) ? block.depth : 2;

    if (
      px >= block.left - PAD &&
      px <= block.left + w + PAD &&
      py >= block.bottom - h - PAD &&
      py <= block.bottom + d + PAD
    ) {
      directHits.push(block);
    }
  }

  const hit = chooseBestBlock(directHits);
  if (hit) return hit;

  // Margin / whitespace click: closest box center
  let closest: SyncTexBlock | null = null;
  let bestDist = Infinity;

  for (const block of scope) {
    if (!Number.isFinite(block.left) || !Number.isFinite(block.bottom)) continue;
    const w = Number.isFinite(block.width) ? block.width : 8;
    const h = Number.isFinite(block.height) ? block.height : 10;

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
