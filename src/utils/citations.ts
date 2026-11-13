/**
 * Shared PDF page citation regex + message cleanup helpers (mirrors backend/citations.py).
 */
export const PAGE_CITATION_RE =
  /\[p{1,2}s?\.\s*\d+(?:\s*[-\u2013]\s*\d+)?(?:\s*,\s*(?:p{1,2}s?\.\s*)?\d+(?:\s*[-\u2013]\s*\d+)?)*\]/g;

export function extractCitationPages(marker: string): number[] {
  const pages = new Set<number>();
  for (const part of marker.replace(/[[\]]/g, '').split(',')) {
    const nums = part.match(/\d+/g)?.map(Number) ?? [];
    if (nums.length === 2 && /[-\u2013]\s*\d/.test(part)) {
      const [lo, hi] = nums[0] <= nums[1] ? nums : [nums[1], nums[0]];
      if (lo >= 1 && hi - lo <= 500) {
        for (let p = lo; p <= hi; p++) pages.add(p);
        continue;
      }
    }
    nums.forEach((p) => pages.add(p));
  }
  return [...pages].filter((p) => Number.isFinite(p) && p >= 1).sort((a, b) => a - b);
}

export function stripLeakedDspyMarkers(text: string): string {
  return (text || '')
    .replace(/\[\[\s*##.*?##\s*\]*\]?/g, '')
    .replace(/\[\[\s*##\s*completed\b.*$/gim, '')
    .trim();
}
