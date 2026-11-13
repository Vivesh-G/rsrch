import type {
  Workspace,
  DocumentItem,
  NoteData,
  ChatMessage,
  ChatSession,
  AppSettings,
  CompileResult,
  WorkspaceAsset,
} from '../types';
import { parseSyncTex, type SyncTexData } from '../utils/synctex';

// Production builds may serve the frontend from a different origin than the
// API — VITE_API_URL lets the deploy point at it (dev falls back to the
// Vite proxy via the relative path).
const API_BASE = `${import.meta.env.VITE_API_URL ?? ''}/api`;

const DEFAULT_TIMEOUT_MS = 30_000;
const LONG_TIMEOUT_MS = 120_000; // uploads + chat generation
const SYNCTEX_CACHE_TTL_MS = 2_000;

const synctexCache = new Map<string, { timestamp: number; data: SyncTexData }>();

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
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
    return req<Workspace[]>('/workspaces');
  },

  async createWorkspace(name: string): Promise<Workspace> {
    return req<Workspace>('/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
  },

  async updateWorkspace(id: string, updates: { name?: string; expanded?: boolean }): Promise<Workspace> {
    return req<Workspace>(`/workspaces/${enc(id)}`, json(updates));
  },

  async deleteWorkspace(id: string): Promise<void> {
    await req<void>(`/workspaces/${enc(id)}`, { method: 'DELETE' });
  },

  async getBibtex(workspaceId: string): Promise<string> {
    const data = await req<{ content: string }>(`/workspaces/${enc(workspaceId)}/bibtex`);
    return data.content || '';
  },

  async saveBibtex(workspaceId: string, content: string): Promise<void> {
    await req<{ status: string }>(`/workspaces/${enc(workspaceId)}/bibtex`, json({ content }));
  },

  async getWorkspaceAssets(workspaceId: string): Promise<WorkspaceAsset[]> {
    const data = await req<{ assets: WorkspaceAsset[] }>(`/workspaces/${enc(workspaceId)}/assets`);
    return data.assets || [];
  },

  async uploadWorkspaceAssets(
    workspaceId: string,
    files: File[],
    path: string = 'figures'
  ): Promise<{ path: string; filename: string }[]> {
    const formData = new FormData();
    files.forEach((f) => formData.append('files', f));
    formData.append('path', path);
    const data = await req<{ status: string; uploaded: { path: string; filename: string }[] }>(
      `/workspaces/${enc(workspaceId)}/assets`,
      { method: 'POST', body: formData },
      LONG_TIMEOUT_MS,
    );
    return data.uploaded || [];
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

  async createLatexDocument(
    workspaceId: string,
    name: string = "document.tex"
  ): Promise<DocumentItem> {
    const formData = new FormData();
    formData.append('name', name);

    return req<DocumentItem>(
      `/workspaces/${enc(workspaceId)}/documents/latex`,
      { method: 'POST', body: formData },
      LONG_TIMEOUT_MS,
    );
  },

  async compileDocument(docId: string): Promise<CompileResult> {
    return req<CompileResult>(
      `/documents/${enc(docId)}/compile`,
      { method: 'POST' },
      LONG_TIMEOUT_MS,
    );
  },

  async updateDocument(
    id: string,
    updates: { note_title?: string; tag?: string; bookmarked?: boolean }
  ): Promise<DocumentItem> {
    return req<DocumentItem>(`/documents/${enc(id)}`, json(updates));
  },

  async deleteDocument(id: string): Promise<void> {
    await req<void>(`/documents/${enc(id)}`, { method: 'DELETE' });
  },

  async getNote(docId: string): Promise<NoteData> {
    return req<NoteData>(`/documents/${enc(docId)}/note`);
  },

  async saveNote(docId: string, content: string): Promise<NoteData> {
    return req<NoteData>(`/documents/${enc(docId)}/note`, json({ content }));
  },

  getDocumentFileUrl(docId: string): string {
    return `${API_BASE}/documents/${enc(docId)}/file`;
  },

  invalidateSynctexCache(docId: string): void {
    synctexCache.delete(docId);
  },

  async getSynctex(docId: string): Promise<SyncTexData | null> {
    const cached = synctexCache.get(docId);
    if (cached && Date.now() - cached.timestamp < SYNCTEX_CACHE_TTL_MS) {
      return cached.data;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const res = await fetch(`${API_BASE}/documents/${enc(docId)}/synctex`, {
        signal: ctrl.signal,
      });
      if (!res.ok) {
        if (res.status !== 404) console.error('Failed to fetch SyncTeX map', res.status);
        return null;
      }
      const text = await res.text();
      if (!text) return null;
      const data = parseSyncTex(text);
      synctexCache.set(docId, { timestamp: Date.now(), data });
      return data;
    } catch (err) {
      console.error('Error fetching SyncTeX:', err);
      return null;
    } finally {
      clearTimeout(timer);
    }
  },

  // Chats are global sessions, independent of documents. A chat records an
  // origin document and each send may attach context documents.
  async getChats(): Promise<ChatSession[]> {
    return req<ChatSession[]>('/chats');
  },

  async createChat(opts?: { title?: string; document_id?: string | null }): Promise<ChatSession> {
    return req<ChatSession>('/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: opts?.title ?? null, document_id: opts?.document_id ?? null }),
    });
  },

  async getChatMessages(chatId: string): Promise<ChatMessage[]> {
    return req<ChatMessage[]>(`/chats/${enc(chatId)}/messages`);
  },

  async sendChatMessage(chatId: string, message: string, documentIds: string[] = [], workspaceIds: string[] = []): Promise<ChatMessage> {
    const data = await req<{ message: ChatMessage }>(
      `/chats/${enc(chatId)}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, document_ids: documentIds, workspace_ids: workspaceIds }),
      },
      LONG_TIMEOUT_MS,
    );
    return data.message;
  },

  async deleteChat(chatId: string): Promise<void> {
    await req<void>(`/chats/${enc(chatId)}`, { method: 'DELETE' });
  },

  async getSettings(): Promise<AppSettings> {
    return await req<AppSettings>('/settings');
  },

  async updateSettings(settings: Partial<AppSettings>): Promise<AppSettings> {
    return await req<AppSettings>('/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
  },

  async testApiKey(apiKey?: string): Promise<{ valid: boolean; message?: string; error?: string }> {
    return await req<{ valid: boolean; message?: string; error?: string }>('/settings/test-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey }),
    });
  },
};

