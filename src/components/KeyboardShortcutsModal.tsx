import React from 'react';
import { IconClose } from './Icons';

interface KeyboardShortcutsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ShortcutCategory {
  title: string;
  items: { key: string; description: string }[];
}

const SHORTCUT_DATA: ShortcutCategory[] = [
  {
    title: 'Navigation & App',
    items: [
      { key: 'Ctrl + K', description: 'Focus search bar (outside note editor)' },
      { key: 'Ctrl + S', description: 'Save current note immediately' },
      { key: 'Esc', description: 'Close menus / blur editor' },
    ],
  },
  {
    title: 'Slash Commands Palette',
    items: [
      { key: '/', description: 'Open slash commands menu' },
      { key: '↑ / ↓', description: 'Navigate commands list' },
      { key: 'Enter / Tab', description: 'Insert selected block' },
    ],
  },
  {
    title: 'Text & Inline Formatting',
    items: [
      { key: 'Ctrl + B', description: 'Bold text (**text**)' },
      { key: 'Ctrl + I', description: 'Italic text (*text*)' },
      { key: 'Ctrl + E', description: 'Inline code (`code`)' },
      { key: 'Ctrl + K', description: 'Insert link (inside note editor)' },
    ],
  },
  {
    title: 'Block Structures',
    items: [
      { key: 'Ctrl + 1 / 2 / 3', description: 'Heading 1, 2, or 3' },
      { key: 'Ctrl + Shift + T', description: 'To-do checkbox (- [ ])' },
      { key: 'Ctrl + Shift + L', description: 'Bullet list item (- )' },
      { key: 'Ctrl + Shift + O', description: 'Numbered list item (1. )' },
      { key: 'Ctrl + Shift + Q', description: 'Blockquote (> )' },
      { key: 'Alt + ↑ / ↓', description: 'Move line up / down' },
    ],
  },
];

export const KeyboardShortcutsModal: React.FC<KeyboardShortcutsModalProps> = ({
  isOpen,
  onClose,
}) => {
  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">Keyboard Shortcuts</div>
          <button
            className="icon-btn small modal-close"
            onClick={onClose}
            title="Close"
            type="button"
          >
            <IconClose size={12} />
          </button>
        </div>

        <div className="modal-body">
          <div className="shortcuts-grid">
            {SHORTCUT_DATA.map((cat) => (
              <div key={cat.title} className="shortcut-category">
                <div className="shortcut-category-title">{cat.title}</div>
                <div className="shortcut-list">
                  {cat.items.map((item) => (
                    <div key={item.key} className="shortcut-row">
                      <span className="shortcut-desc">{item.description}</span>
                      <kbd className="shortcut-kbd">{item.key}</kbd>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
