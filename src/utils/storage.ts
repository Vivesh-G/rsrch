/** Canonical storage keys, with legacy prefix read fallback. */
export const STORAGE_KEYS = {
  theme: 'rsrch-theme',
  activeWorkspace: 'rsrch-ws',
  activeDoc: 'rsrch-doc',
  sidebarCollapsed: 'rsrch-sidecol',
  sidebarWidth: 'rsrch-sidebar-w',
  rightSidebarCollapsed: 'rsrch-right-sidecol',
  panelOrder: 'rsrch-panel-order',
  panelOpen: (panelId: string) => `rsrch-${panelId}-open`,
  settings: 'rsrch-settings',
  onboarded: 'rsrch-onboarded',
  activeChatId: 'rsrch-chat-id',
  pageForDoc: (docId: string) => `rsrch-page-${docId}`,
  noteForDoc: (docId: string) => `rsrch-note-${docId}`,
  pdfHighlights: (docId: string) => `rsrch-pdf-highlights-${docId}`,
} as const;

const LEGACY_KEY_MAP: Record<string, string> = {
  'rsrch-theme': 'rschr-theme',
  'rsrch-ws': 'rschr-ws',
  'rsrch-doc': 'rschr-doc',
  'rsrch-sidecol': 'rschr-sidecol',
  'rsrch-sidebar-w': 'rschr-sidew',
  'rsrch-right-sidecol': 'rschr-right-sidecol',
  'rsrch-panel-order': 'rschr-panel-order',
  'rsrch-chat-id': 'rschr-chat-id',
};

function getLegacyKey(key: string): string | undefined {
  if (key in LEGACY_KEY_MAP) return LEGACY_KEY_MAP[key];
  if (key.startsWith('rsrch-page-')) {
    return `rshr-page-${key.slice('rsrch-page-'.length)}`;
  }
  if (key.startsWith('rsrch-') && key.endsWith('-open')) {
    return `rschr-${key.slice('rsrch-'.length)}`;
  }
  return undefined;
}

export function readRawStored(key: string): string | null {
  try {
    const val = localStorage.getItem(key);
    if (val !== null) return val;
    const legacyKey = getLegacyKey(key);
    if (legacyKey) {
      const legacyVal = localStorage.getItem(legacyKey);
      if (legacyVal !== null) {
        localStorage.setItem(key, legacyVal);
        localStorage.removeItem(legacyKey);
        return legacyVal;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function writeRawStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // quota / privacy mode
  }
}

export function removeStored(key: string): void {
  try {
    localStorage.removeItem(key);
    const legacyKey = getLegacyKey(key);
    if (legacyKey) localStorage.removeItem(legacyKey);
  } catch {
    // ignore
  }
}

export function readStoredJson<T>(key: string, fallback: T): T {
  const raw = readRawStored(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeStoredJson(key: string, value: unknown): void {
  writeRawStored(key, JSON.stringify(value));
}
