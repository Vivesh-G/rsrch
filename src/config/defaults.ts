import type { AppSettings } from '../types';

export const DEFAULT_SETTINGS: AppSettings = {
  user_name: 'Researcher',
  user_affiliation: '',
  gemini_model: 'gemini-3.5-flash-lite',
  gemini_api_key: '',
  gemini_api_key_set: false,
  gemini_api_key_masked: '',
  ai_temperature: 0.7,
  ai_persona: 'academic',
  auto_compile_delay: 1500,
  editor_font_size: 13,
  editor_word_wrap: true,
  editor_line_numbers: true,
};

export const PANEL_IDS = ['viewer', 'chat', 'notes', 'assets', 'bibtex'] as const;
export type PanelId = (typeof PANEL_IDS)[number];

export const DEFAULT_PANEL_OPEN: Record<PanelId, boolean> = {
  viewer: true,
  chat: false,
  notes: true,
  assets: false,
  bibtex: false,
};

export const DEFAULT_SIDEBAR_WIDTH = 240;
export const MIN_SIDEBAR_WIDTH = 180;
export const MAX_SIDEBAR_WIDTH = 420;
export const MIN_PANEL_WIDTH = 160;

export const GEMINI_MODELS = [
  { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash Lite', desc: 'Default · Ultra fast & lightweight (Free tier)' },
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', desc: 'High-speed multimodal reasoning (Free tier)' },
  { id: 'gemma-4-31b-it', name: 'Gemma 4 31B IT', desc: 'High-capacity open instruction model (Free tier)' },
  { id: 'gemma-4-26b-a4b-it', name: 'Gemma 4 26B A4B IT', desc: 'Architecture-optimized instruction model (Free tier)' },
] as const;

export const MAX_ATTACHED_DOCS = 6;
export const MAX_CHAT_MESSAGE_CHARS = 4000;
export const MAX_PDF_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_FILES_PER_BATCH = 10;
