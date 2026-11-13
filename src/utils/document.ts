import type { DocumentItem, Workspace } from '../types';

/**
 * Strip known document extensions (.pdf, .tex) from file names for display.
 */
export function cleanDocName(name?: string): string {
  if (!name) return '';
  return name.replace(/\.(pdf|tex)$/i, '');
}

/**
 * Get display title for a document: user-assigned note_title, or base name.
 */
export function getDocDisplayName(
  doc?: Pick<DocumentItem, 'name' | 'note_title'> | null,
  fallback: string = 'document',
): string {
  if (!doc) return fallback;
  return doc.note_title?.trim() || cleanDocName(doc.name) || fallback;
}

export function isLatexDoc(doc?: Pick<DocumentItem, 'doc_type'> | null): boolean {
  return doc?.doc_type === 'latex';
}

export function hasPdfOutput(
  doc?: Pick<DocumentItem, 'has_file' | 'doc_type'> | null,
): boolean {
  return Boolean(doc && (doc.has_file || doc.doc_type === 'latex'));
}

export function findDocById(
  workspaces: Workspace[],
  docId: string | null | undefined,
): DocumentItem | null {
  if (!docId) return null;
  for (const ws of workspaces) {
    const found = ws.docs.find((d) => d.id === docId);
    if (found) return found;
  }
  return null;
}

const STARTER_NOTE_TEMPLATE = `## Getting started

Welcome! This is your note for this document.

- [ ] Summarize the main ideas
- [ ] Pull out key quotes
- [ ] Link related papers

> Tip: use **bold**, *italic*, \`code\`, and markdown shortcuts.
> Press Enter to move to the next line — formatting renders automatically.`;

export function buildStarterNote(title: string): string {
  return STARTER_NOTE_TEMPLATE.replace('this document', title);
}

export function countWords(text: string): number {
  return (text.trim().match(/\S+/g) || []).length;
}

export function normalizeQuoteText(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
}
