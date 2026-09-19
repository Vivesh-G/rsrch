import type { DocumentItem } from '../types';

const baseName = (n?: string) => (n || '').replace(/\.pdf$/i, '');

/**
 * Single shared document-matches-query predicate. Sidebar and
 * WorkspaceOverview must use the same one — previously the sidebar scanned
 * note bodies while the overview only checked name/title, so the same query
 * showed different results in each.
 */
export function docMatchesQuery(
  doc: DocumentItem,
  query: string,
  loweredNote?: string,
): boolean {
  if (baseName(doc.name).toLowerCase().includes(query)) return true;
  if ((doc.note_title || '').toLowerCase().includes(query)) return true;
  if ((doc.tag || '').toLowerCase().includes(query)) return true;
  if (loweredNote && loweredNote.includes(query)) return true;
  return false;
}
