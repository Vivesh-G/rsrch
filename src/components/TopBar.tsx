import React, { useEffect, useRef, useState } from 'react';
import { IconSun, IconMoon, IconMaximize, IconMinimize, IconKeyboard, IconSearch, IconPlus, IconChat } from './Icons';
import { KeyboardShortcutsModal } from './KeyboardShortcutsModal';

interface TopBarProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onNewDocument: () => void;
  onSelectOverview: () => void;
  isChatOpen: boolean;
  onToggleChat: () => void;
}

const TopBarInner: React.FC<TopBarProps> = ({
  searchQuery,
  onSearchChange,
  onNewDocument,
  onSelectOverview,
  isChatOpen,
  onToggleChat,
}) => {
  const [isDark, setIsDark] = useState<boolean>(() => {
    // Same source of truth as the pre-paint script in index.html.
    try {
      const stored = localStorage.getItem('rschr-theme');
      if (stored) return stored === 'dark';
      if (window.matchMedia('(prefers-color-scheme: light)').matches) return false;
    } catch {}
    return document.body.classList.contains('dark');
  });
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [isShortcutsOpen, setIsShortcutsOpen] = useState<boolean>(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Local input state keeps typing at 60fps; propagate debounced to avoid
  // re-rendering the whole app (incl. PDF canvases) on every keystroke.
  const [localQuery, setLocalQuery] = useState(searchQuery);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLocalQuery(searchQuery);
  }, [searchQuery]);

  const handleSearchInput = (value: string) => {
    setLocalQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => onSearchChange(value), 150);
  };

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        const target = e.target as HTMLElement | null;
        // Never steal focus from an editable field (chat input, rename
        // inputs, note title, editor) — previously Ctrl+K inside any of
        // those yanked focus to search mid-typing.
        if (target && (target.closest('#liveEditor') || target.closest('input, textarea, [contenteditable="true"]'))) return;
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Invariant: body class always matches state (covers pre-paint script races).
  useEffect(() => {
    document.body.classList.toggle('dark', isDark);
  }, [isDark]);

  useEffect(() => {
    const handleFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', handleFsChange);
    return () => document.removeEventListener('fullscreenchange', handleFsChange);
  }, []);

  const toggleTheme = () => {
    const nextDark = !isDark;
    setIsDark(nextDark);
    try {
      localStorage.setItem('rschr-theme', nextDark ? 'dark' : 'light');
    } catch {}
  };

  const toggleFocus = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen?.();
    } else {
      document.documentElement.requestFullscreen?.();
    }
  };

  return (
    <>
      <header className="topbar">
        <div className="topbar-left">
          <div className="brand-text" onClick={onSelectOverview}>
            <strong>Rsrch</strong>
          </div>
        </div>

        <div className="search-center">
          <div className="search-wrap minimal" onClick={() => searchInputRef.current?.focus()}>
            <IconSearch size={14} className="search-icon" />
            <input
              id="globalSearch"
              ref={searchInputRef}
              type="text"
              placeholder="Search documents…"
              value={localQuery}
              onChange={(e) => handleSearchInput(e.target.value)}
            />
            <kbd className="search-kbd">Ctrl K</kbd>
          </div>
        </div>

        <div className="topbar-right">
          <button
            className="pill-btn add-btn"
            id="newDocTopBtn"
            onClick={onNewDocument}
            type="button"
          >
            <IconPlus size={12} />
            <span>New document</span>
          </button>
          <div className="vdiv" />
          <button
            className="icon-btn"
            id="shortcutsBtn"
            title="Keyboard shortcuts"
            onClick={() => setIsShortcutsOpen(true)}
            type="button"
          >
            <IconKeyboard size={15} />
          </button>
          <button
            className={`icon-btn ${isChatOpen ? 'active' : ''}`}
            id="chatBtn"
            title="Toggle Chat"
            onClick={onToggleChat}
            type="button"
          >
            <IconChat size={15} />
          </button>
          <button
            className="icon-btn"
            id="themeBtn"
            title={isDark ? 'Light mode' : 'Dark mode'}
            onClick={toggleTheme}
            type="button"
          >
            {isDark ? <IconSun size={15} /> : <IconMoon size={15} />}
          </button>
          <button
            className="icon-btn"
            id="focusBtn"
            title={isFullscreen ? 'Exit focus mode' : 'Focus mode'}
            onClick={toggleFocus}
            type="button"
          >
            {isFullscreen ? <IconMinimize size={15} /> : <IconMaximize size={15} />}
          </button>
          <div className="user">
            <div className="avatar">V</div>
            <span>Vives</span>
          </div>
        </div>
      </header>

      <KeyboardShortcutsModal
        isOpen={isShortcutsOpen}
        onClose={() => setIsShortcutsOpen(false)}
      />
    </>
  );
};

export const TopBar: React.FC<TopBarProps> = React.memo(TopBarInner);
