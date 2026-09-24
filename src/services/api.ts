import type { Workspace, DocumentItem, NoteData, ChatMessage, ChatSession } from '../types';

// Production builds may serve the frontend from a different origin than the
// API — VITE_API_URL lets the deploy point at it (dev falls back to the
// Vite proxy via the relative path).
const API_BASE = `${import.meta.env.VITE_API_URL ?? ''}/api`;

const DEFAULT_TIMEOUT_MS = 30_000;
const LONG_TIMEOUT_MS = 120_000; // uploads + chat generation

class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function req<T>(
  path: string,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}${path}`, { ...init, signal: ctrl.signal });
    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json();
        detail = typeof body?.detail === 'string' ? body.detail : '';
      } catch {
        /* non-JSON error body */
      }
      throw new ApiError(res.status, detail || `Request failed (${res.status})`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('Request timed out');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const json = (body: unknown): RequestInit => ({
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// Path segments come from localStorage/backend payloads — always encode so
// a `/`, `?`, `#` or `%` in an id can't corrupt the route.
const enc = (s: string) => encodeURIComponent(s);

export const api = {
  async getWorkspaces(): Promise<Workspace[]> {
    try {
      return await req<Workspace[]>('/workspaces');
    } catch (err) {
      console.warn('API getWorkspaces error, fallback to local', err);
      return [];
    }
  },

  async createWorkspace(name: string): Promise<Workspace> {
    return req<Workspace>('/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
  },

  async updateWorkspace(id: string, updates: { name?: string; expanded?: boolean }): Promise<Workspace> {
    return req<Workspace>(`/workspaces/${enc(id)}`, { ...json(updates), method: 'PUT' });
  },

  async deleteWorkspace(id: string): Promise<void> {
    await req<void>(`/workspaces/${enc(id)}`, { method: 'DELETE' });
  },

  async uploadDocument(
    workspaceId: string,
    file: File,
    tag: string = 'General',
    noteTitle?: string
  ): Promise<DocumentItem> {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('tag', tag);
    if (noteTitle) formData.append('note_title', noteTitle);

    const doc = await req<DocumentItem>(
      `/workspaces/${enc(workspaceId)}/documents/upload`,
      { method: 'POST', body: formData },
      LONG_TIMEOUT_MS,
    );
    // Do not attach the File here: retaining it pins full PDF bytes in
    // memory. Callers keep the File only for local-fallback docs.
    return doc;
  },

  async updateDocument(
    id: string,
    updates: { note_title?: string; tag?: string; bookmarked?: boolean }
  ): Promise<DocumentItem> {
    return req<DocumentItem>(`/documents/${enc(id)}`, { ...json(updates), method: 'PUT' });
  },

  async deleteDocument(id: string): Promise<void> {
    await req<void>(`/documents/${enc(id)}`, { method: 'DELETE' });
  },

  async getNote(docId: string): Promise<NoteData> {
    return req<NoteData>(`/documents/${enc(docId)}/note`);
  },

  async saveNote(docId: string, content: string): Promise<NoteData> {
    return req<NoteData>(`/documents/${enc(docId)}/note`, { ...json({ content }), method: 'PUT' });
  },

  getDocumentFileUrl(docId: string): string {
    return `${API_BASE}/documents/${enc(docId)}/file`;
  },

  // Chats are global sessions, independent of documents. A chat records an
  // origin document and each send may attach context documents.
  async getChats(): Promise<ChatSession[]> {
    try {
      return await req<ChatSession[]>('/chats');
    } catch {
      return [];
    }
  },

  async createChat(opts?: { title?: string; document_id?: string | null }): Promise<ChatSession> {
    return req<ChatSession>('/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: opts?.title ?? null, document_id: opts?.document_id ?? null }),
    });
  },

  async getChatMessages(chatId: string): Promise<ChatMessage[]> {
    try {
      return await req<ChatMessage[]>(`/chats/${enc(chatId)}/messages`);
    } catch {
      return [];
    }
  },

  async sendChatMessage(chatId: string, message: string, documentIds: string[] = []): Promise<ChatMessage> {
    const data = await req<{ message: ChatMessage }>(
      `/chats/${enc(chatId)}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, document_ids: documentIds }),
      },
      LONG_TIMEOUT_MS,
    );
    return data.message;
  },

  async deleteChat(chatId: string): Promise<void> {
    await req<void>(`/chats/${enc(chatId)}`, { method: 'DELETE' });
  },
};
