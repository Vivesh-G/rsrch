export interface DocumentItem {
  id: string;
  workspace_id: string;
  name: string;
  note_title?: string;
  tag: string;
  bookmarked: boolean;
  added_at: number;
  has_file: boolean;
  page_count: number;
  file?: File;
}

export interface Workspace {
  id: string;
  name: string;
  expanded: boolean;
  created_at: number;
  docs: DocumentItem[];
}

export interface NoteData {
  document_id: string;
  content: string;
  updated_at: number;
}

export interface SearchResult {
  document_id: string;
  workspace_id: string;
  workspace_name: string;
  document_name: string;
  note_title: string;
  tag: string;
  snippet?: string;
  match_type: 'name' | 'title' | 'tag' | 'note';
}

export type CategoryTag = 'NLP' | 'Architecture' | 'Foundations' | 'Strategy' | 'ML' | 'General' | string;

export interface ChatMessage {
  id?: number;
  chat_id?: string;
  document_id?: string | null;
  role: 'user' | 'assistant';
  content: string;
  created_at: number;
}

export interface ChatSession {
  id: string;
  title: string;
  document_id?: string | null;
  origin_title?: string | null;
  message_count: number;
  last_preview?: string | null;
  created_at: number;
  updated_at: number;
}
