import React, { useEffect, useRef, useCallback, useState, useMemo } from 'react';

interface LiveMarkdownEditorProps {
  content: string;
  onChange: (content: string) => void;
  onManualSave?: (content: string) => void;
  onWordCountChange?: (count: number) => void;
}

interface SlashCommandItem {
  id: string;
  label: string;
  description: string;
  badge: string;
  category: string;
  keywords: string[];
  action: (line: HTMLElement, queryText: string) => void;
}

function esc(s: string): string {
  // Quote-escaping matters: interpolated values land inside double-quoted
  // attributes (href="...", data-page="..."), so an unescaped `"` in a
  // note breaks out of the attribute (stored HTML via innerHTML).
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inline(md: string): string {
  let h = esc(md);
  h = h
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|\W)\*(.+?)\*/g, '$1<i>$2</i>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\[\[([^\]]+)\]\]/g, '<span class="wiki">[[ $1 ]]</span>')
    .replace(/#(\w+)/g, '<span class="wiki">#$1</span>');

  // Match [p. 1], [p.1], [page 1], [Page 1], [p1], or [1] for clickable PDF page jump badges
  h = h.replace(
    /(?:^|\s)\[(?:p(?:age)?\.?\s*)?(\d+)\]/gi,
    (match, pageNum) => {
      const prefix = match.startsWith(' ') ? ' ' : '';
      return `${prefix}<span class="pdf-page-ref" data-page="${pageNum}" role="button" tabindex="0" title="Jump to page ${pageNum} in PDF">[${pageNum}]</span>`;
    }
  );

  return h;
}

function renderBlock(src: string): string {
  const t = src.trim();
  if (!t) return '';
  let m: RegExpMatchArray | null;

  if ((m = t.match(/^(#{1,3})\s+(.*)/))) {
    const lvl = m[1].length;
    return `<h${lvl}>${inline(m[2])}</h${lvl}>`;
  }
  if ((m = t.match(/^>\s?(.*)/))) {
    return `<blockquote>${inline(m[1])}</blockquote>`;
  }
  if ((m = t.match(/^-\s\[x\]\s+(.*)/i))) {
    return `<div class="task"><span class="chk done"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg></span><span>${inline(m[1])}</span></div>`;
  }
  if ((m = t.match(/^-\s\[\s\]\s+(.*)/))) {
    return `<div class="task"><span class="chk"></span><span>${inline(m[1])}</span></div>`;
  }
  if ((m = t.match(/^-\s+(.*)/))) {
    return `<div>• ${inline(m[1])}</div>`;
  }
  if ((m = t.match(/^\d+\.\s+(.*)/))) {
    return `<div>${inline(t)}</div>`;
  }
  if (t === '---' || t === '***') {
    return `<hr class="live-hr" />`;
  }
  return inline(t);
}

function makeLine(src: string = '', rendered: boolean = true): HTMLDivElement {
  const d = document.createElement('div');
  d.className = 'live-line';
  d.dataset.source = src;
  d.contentEditable = 'true';
  d.spellcheck = false;
  if (rendered && src.trim()) {
    d.innerHTML = renderBlock(src);
  } else {
    d.textContent = src;
    if (src || !rendered) d.classList.add('editing');
  }
  return d;
}

function placeCaretEnd(el: HTMLElement) {
  el.focus();
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  const s = window.getSelection();
  if (s) {
    s.removeAllRanges();
    s.addRange(r);
  }
}

function ensureEditing(line: HTMLElement) {
  if (!line.classList.contains('editing')) {
    line.classList.add('editing');
    line.textContent = line.dataset.source || '';
  }
}

function commitLine(line: HTMLElement) {
  if (!line?.classList.contains('editing')) return;
  const src = line.textContent?.replace(/\r?\n/g, '') || '';
  line.dataset.source = src;
  line.classList.remove('editing');
  line.innerHTML = src.trim() ? renderBlock(src) : '';
}

export const LiveMarkdownEditor: React.FC<LiveMarkdownEditorProps> = ({
  content,
  onChange,
  onManualSave,
  onWordCountChange,
}) => {
  const editorRef = useRef<HTMLDivElement>(null);
  const menuListRef = useRef<HTMLDivElement>(null);
  const isInternalChangeRef = useRef<boolean>(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeSlashLineRef = useRef<HTMLElement | null>(null);
  const lastWordCountRef = useRef<number>(-1);

  // Slash menu state
  const [slashMenu, setSlashMenu] = useState<{
    open: boolean;
    query: string;
    x: number;
    y: number;
    selectedIndex: number;
  }>({
    open: false,
    query: '',
    x: 0,
    y: 0,
    selectedIndex: 0,
  });

  const slashMenuRef = useRef(slashMenu);
  slashMenuRef.current = slashMenu;

  const collectMD = useCallback((): string => {
    if (!editorRef.current) return '';
    return Array.from(editorRef.current.children)
      .map((el) => {
        const line = el as HTMLElement;
        if (line.dataset.source !== undefined) return line.dataset.source;
        return line.textContent?.replace(/\r?\n/g, '') || '';
      })
      .join('\n');
  }, []);

  const updateWordCount = useCallback(() => {
    const md = collectMD();
    const words = (md.trim().match(/\S+/g) || []).length;
    // Typing inside a word doesn't change the count — skip the parent
    // setState entirely instead of relying on React's same-value bailout.
    if (words !== lastWordCountRef.current) {
      lastWordCountRef.current = words;
      onWordCountChange?.(words);
    }

    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      isInternalChangeRef.current = true;
      onChange(md);
      setTimeout(() => {
        isInternalChangeRef.current = false;
      }, 50);
    }, 250);
  }, [collectMD, onChange, onWordCountChange]);

  // Insert lines helper for templates
  const insertTemplateLines = useCallback((targetLine: HTMLElement, linesToInsert: string[]) => {
    let current = targetLine;
    if (linesToInsert.length > 0) {
      current.textContent = linesToInsert[0];
      current.dataset.source = linesToInsert[0];
    }
    for (let i = 1; i < linesToInsert.length; i++) {
      const nl = makeLine(linesToInsert[i], false);
      current.after(nl);
      current = nl;
    }
    placeCaretEnd(current);
    updateWordCount();
  }, [updateWordCount]);

  // Clean trigger text from line
  const replaceTriggerAndApply = useCallback(
    (
      line: HTMLElement,
      formatter: (cleanRemainingText: string) => { text: string; caretPos?: number } | string[]
    ) => {
      ensureEditing(line);
      const text = line.textContent || '';
      const sel = window.getSelection();
      const offset = sel?.anchorOffset ?? text.length;
      const beforeCaret = text.slice(0, offset);
      const afterCaret = text.slice(offset);

      const match = beforeCaret.match(/(?:^|\s)\/([a-zA-Z0-9_-]*)$/);
      const triggerLen = match ? match[0].length : 1;
      const startIdx = match ? offset - triggerLen + (match[0].startsWith(' ') ? 1 : 0) : 0;
      const prefix = text.slice(0, startIdx);
      const remaining = (prefix + afterCaret).trim();

      const result = formatter(remaining);
      if (Array.isArray(result)) {
        insertTemplateLines(line, result);
      } else {
        line.textContent = result.text;
        line.dataset.source = result.text;
        placeCaretEnd(line);
        updateWordCount();
      }
      setSlashMenu((prev) => ({ ...prev, open: false }));
    },
    [insertTemplateLines, updateWordCount]
  );

  // Slash commands registry (strictly zero emojis)
  const commands: SlashCommandItem[] = useMemo(
    () => [
      {
        id: 'h1',
        label: 'Heading 1',
        description: 'Large section heading',
        badge: 'H1',
        category: 'Headings',
        keywords: ['h1', 'heading', 'title', 'header', 'large'],
        action: (line) =>
          replaceTriggerAndApply(line, (rem) => ({ text: `# ${rem}` })),
      },
      {
        id: 'h2',
        label: 'Heading 2',
        description: 'Medium section heading',
        badge: 'H2',
        category: 'Headings',
        keywords: ['h2', 'heading', 'subtitle', 'header', 'medium'],
        action: (line) =>
          replaceTriggerAndApply(line, (rem) => ({ text: `## ${rem}` })),
      },
      {
        id: 'h3',
        label: 'Heading 3',
        description: 'Small subsection heading',
        badge: 'H3',
        category: 'Headings',
        keywords: ['h3', 'heading', 'sub', 'header', 'small'],
        action: (line) =>
          replaceTriggerAndApply(line, (rem) => ({ text: `### ${rem}` })),
      },
      {
        id: 'todo',
        label: 'To-do List',
        description: 'Interactive checklist task',
        badge: '[ ]',
        category: 'Lists & Tasks',
        keywords: ['todo', 'task', 'check', 'checkbox', 'list'],
        action: (line) =>
          replaceTriggerAndApply(line, (rem) => ({ text: `- [ ] ${rem}` })),
      },
      {
        id: 'bullet',
        label: 'Bullet List',
        description: 'Simple unnumbered list item',
        badge: '•',
        category: 'Lists & Tasks',
        keywords: ['bullet', 'list', 'unordered', 'item', 'point'],
        action: (line) =>
          replaceTriggerAndApply(line, (rem) => ({ text: `- ${rem}` })),
      },
      {
        id: 'numbered',
        label: 'Numbered List',
        description: 'Ordered sequential list item',
        badge: '1.',
        category: 'Lists & Tasks',
        keywords: ['numbered', 'number', 'ordered', 'list', 'sequence'],
        action: (line) =>
          replaceTriggerAndApply(line, (rem) => ({ text: `1. ${rem}` })),
      },
      {
        id: 'quote',
        label: 'Blockquote',
        description: 'Callout or quotation block',
        badge: '"',
        category: 'Quotes & Code',
        keywords: ['quote', 'blockquote', 'callout', 'cite'],
        action: (line) =>
          replaceTriggerAndApply(line, (rem) => ({ text: `> ${rem}` })),
      },
      {
        id: 'code',
        label: 'Code Snippet',
        description: 'Inline code or formatted snippet',
        badge: '<>',
        category: 'Quotes & Code',
        keywords: ['code', 'snippet', 'syntax', 'programming'],
        action: (line) =>
          replaceTriggerAndApply(line, (rem) => ({ text: `\`${rem || 'code'}\`` })),
      },
      {
        id: 'divider',
        label: 'Divider',
        description: 'Horizontal divider line',
        badge: '---',
        category: 'Structure',
        keywords: ['divider', 'line', 'separator', 'hr', 'rule'],
        action: (line) =>
          replaceTriggerAndApply(line, () => ({ text: '---' })),
      },
      {
        id: 'date',
        label: 'Today\'s Date',
        description: 'Insert current formatted date',
        badge: 'CAL',
        category: 'Inserts',
        keywords: ['date', 'today', 'time', 'timestamp'],
        action: (line) => {
          const now = new Date().toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          });
          replaceTriggerAndApply(line, (rem) => ({
            text: `${now} ${rem}`.trim(),
          }));
        },
      },
      {
        id: 'wiki',
        label: 'Wiki Link',
        description: 'Internal concept or paper link',
        badge: '[[ ]]',
        category: 'Inserts',
        keywords: ['wiki', 'link', 'concept', 'paper', 'page'],
        action: (line) =>
          replaceTriggerAndApply(line, (rem) => ({
            text: `[[${rem || 'Concept'}]]`,
          })),
      },
      {
        id: 'tag',
        label: 'Tag',
        description: 'Category or topic hashtag',
        badge: '#',
        category: 'Inserts',
        keywords: ['tag', 'hashtag', 'label', 'topic'],
        action: (line) =>
          replaceTriggerAndApply(line, (rem) => ({
            text: `#${rem || 'topic'}`,
          })),
      },
      {
        id: 'summary-template',
        label: 'Research Summary',
        description: 'Structured objective & findings template',
        badge: 'DOC',
        category: 'Templates',
        keywords: ['summary', 'template', 'findings', 'research', 'paper'],
        action: (line) =>
          replaceTriggerAndApply(line, () => [
            '### Research Summary',
            '- **Core Objective:** ',
            '- **Key Methodology:** ',
            '- **Primary Findings:** ',
            '- **Significance & Limitations:** ',
          ]),
      },
      {
        id: 'takeaways-template',
        label: 'Key Takeaways',
        description: 'Actionable checklist of insights',
        badge: 'LIST',
        category: 'Templates',
        keywords: ['takeaways', 'insights', 'action', 'template', 'key'],
        action: (line) =>
          replaceTriggerAndApply(line, () => [
            '### Key Takeaways',
            '- [ ] Critical insight 1',
            '- [ ] Critical insight 2',
            '- [ ] Open research question',
          ]),
      },
      {
        id: 'quotes-template',
        label: 'Key Quotation',
        description: 'Paper excerpt with citation',
        badge: '"',
        category: 'Templates',
        keywords: ['quote', 'quotation', 'citation', 'excerpt', 'reference'],
        action: (line) =>
          replaceTriggerAndApply(line, () => [
            '> "Insert key quote from the document here"',
            '— *Page reference / Author*',
          ]),
      },
    ],
    [replaceTriggerAndApply]
  );

  // Filter commands by query
  const filteredCommands = useMemo(() => {
    const q = slashMenu.query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) =>
        c.label.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q) ||
        c.keywords.some((k) => k.includes(q))
    );
  }, [commands, slashMenu.query]);

  const filteredCommandsRef = useRef(filteredCommands);
  filteredCommandsRef.current = filteredCommands;

  // Auto-scroll active item into view
  useEffect(() => {
    if (slashMenu.open && menuListRef.current) {
      const activeEl = menuListRef.current.querySelector('.slash-item.active') as HTMLElement | null;
      if (activeEl) {
        activeEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }, [slashMenu.selectedIndex, slashMenu.open]);

  // Load Initial Lines
  const loadLines = useCallback(
    (md: string) => {
      const editor = editorRef.current;
      if (!editor) return;
      editor.innerHTML = '';
      const lines = (md || '').split('\n');
      lines.forEach((s) => editor.appendChild(makeLine(s, true)));
      if (!editor.children.length) editor.appendChild(makeLine('', false));
      const words = (md.trim().match(/\S+/g) || []).length;
      lastWordCountRef.current = words;
      onWordCountChange?.(words);
    },
    [onWordCountChange]
  );

  useEffect(() => {
    if (!isInternalChangeRef.current) {
      loadLines(content);
    }
  }, [content, loadLines]);

  // Debounced onChange timer must not fire after unmount (stale write to
  // a switched-away document's note).
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, []);

  // Handle Slash Menu execution
  const executeCommand = useCallback((cmd: SlashCommandItem) => {
    const line = activeSlashLineRef.current;
    if (!line) return;
    cmd.action(line, slashMenuRef.current.query);
  }, []);

  // Editor Event Listeners
  useEffect(() => {
    const liveEd = editorRef.current;
    if (!liveEd) return;

    let isDragging = false;
    let dragStartLine: HTMLElement | null = null;
    let dragCurrentLine: HTMLElement | null = null;
    let hasBlockSelection = false;

    const updateBlockSelection = (startLine: HTMLElement, currentLine: HTMLElement) => {
       hasBlockSelection = true;
       window.getSelection()?.removeAllRanges();
       
       const children = Array.from(liveEd.children) as HTMLElement[];
       const startIdx = children.indexOf(startLine);
       const currentIdx = children.indexOf(currentLine);
       const first = Math.min(startIdx, currentIdx);
       const last = Math.max(startIdx, currentIdx);
       
       children.forEach((c, idx) => {
           if (idx >= first && idx <= last) {
               c.classList.add('selected-block');
           } else {
               c.classList.remove('selected-block');
           }
       });
    };

    const handleFocusIn = (e: FocusEvent) => {
      if ((e.target as HTMLElement)?.closest('.pdf-page-ref')) return;
      const line = (e.target as HTMLElement)?.closest('.live-line') as HTMLElement | null;
      if (!line || line.classList.contains('editing')) return;
      line.classList.add('editing');
      line.textContent = line.dataset.source ?? '';
    };

    const handleMouseDown = (e: MouseEvent) => {
      if ((e.target as HTMLElement)?.closest('.pdf-page-ref')) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      
      Array.from(liveEd.children).forEach(c => c.classList.remove('selected-block'));
      hasBlockSelection = false;
      
      const line = (e.target as HTMLElement)?.closest('.live-line') as HTMLElement | null;
      if (line) {
         isDragging = true;
         dragStartLine = line;
         dragCurrentLine = line;
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
       if (!isDragging || !dragStartLine) return;
       const line = (e.target as HTMLElement)?.closest('.live-line') as HTMLElement | null;
       if (line && line !== dragCurrentLine) {
           dragCurrentLine = line;
           updateBlockSelection(dragStartLine, dragCurrentLine);
       }
    };

    const handleMouseUp = () => {
       isDragging = false;
    };

    const handleFocusOut = (e: FocusEvent) => {
      const line = (e.target as HTMLElement)?.closest('.live-line') as HTMLElement | null;
      if (!line) return;
      if (liveEd.contains(e.relatedTarget as Node)) return;
      commitLine(line);
      setSlashMenu((prev) => (prev.open ? { ...prev, open: false } : prev));
    };

    const handleInput = (e: Event) => {
      const line = (e.target as HTMLElement)?.closest('.live-line') as HTMLElement | null;
      if (!line?.classList.contains('editing')) return;
      line.dataset.source = line.textContent || '';
      updateWordCount();

      // Check for Slash Command trigger
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const text = line.textContent || '';
        const offset = sel.anchorOffset;
        const beforeCaret = text.slice(0, offset);
        const slashMatch = beforeCaret.match(/(?:^|\s)\/([a-zA-Z0-9_-]*)$/);

        if (slashMatch) {
          const query = slashMatch[1].toLowerCase();
          const range = sel.getRangeAt(0);
          const rect = range.getBoundingClientRect();
          activeSlashLineRef.current = line;

          const menuWidth = 300;
          const menuHeight = 320;
          const posX = Math.max(16, Math.min(rect.left, window.innerWidth - menuWidth - 20));
          const posY =
            rect.bottom + menuHeight > window.innerHeight
              ? Math.max(16, rect.top - menuHeight - 6)
              : rect.bottom + 6;

          setSlashMenu({
            open: true,
            query,
            x: posX,
            y: posY,
            selectedIndex: 0,
          });
          return;
        }
      }

      setSlashMenu((prev) => (prev.open ? { ...prev, open: false } : prev));
    };

    const handleClick = (e: MouseEvent) => {
      const pageRef = (e.target as HTMLElement)?.closest('.pdf-page-ref') as HTMLElement | null;
      if (pageRef) {
        e.preventDefault();
        e.stopPropagation();
        const pageNum = parseInt(pageRef.dataset.page || '1', 10);
        window.dispatchEvent(
          new CustomEvent('rsrch:scroll-to-page', { detail: { page: pageNum } })
        );
        return;
      }

      const chk = (e.target as HTMLElement)?.closest('.chk');
      if (!chk) return;
      e.stopPropagation();
      const line = chk.closest('.live-line') as HTMLElement | null;
      if (!line) return;
      const src = line.dataset.source || '';
      const next = /\[x\]/i.test(src)
        ? src.replace(/\[x\]/i, '[ ]')
        : src.replace(/\[\s\]/, '[x]');
      line.dataset.source = next;
      line.innerHTML = renderBlock(next);
      updateWordCount();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;

      if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          const line = (e.target as HTMLElement)?.closest('.live-line') as HTMLElement | null;
          if (!hasBlockSelection && line) {
              dragStartLine = line;
              dragCurrentLine = line;
          }
          
          if (dragStartLine && dragCurrentLine) {
              e.preventDefault();
              const sib = (e.key === 'ArrowUp' ? dragCurrentLine.previousElementSibling : dragCurrentLine.nextElementSibling) as HTMLElement | null;
              if (sib && sib.classList.contains('live-line')) {
                  dragCurrentLine = sib;
                  updateBlockSelection(dragStartLine, dragCurrentLine);
              }
              return;
          }
      }
      
      if (hasBlockSelection) {
          if (!e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
              Array.from(liveEd.children).forEach(c => c.classList.remove('selected-block'));
              hasBlockSelection = false;
              if (dragCurrentLine) {
                  ensureEditing(dragCurrentLine);
                  placeCaretEnd(dragCurrentLine);
              }
              e.preventDefault();
              return;
          }

          const selectedBlocks = Array.from(liveEd.querySelectorAll('.selected-block')) as HTMLElement[];
          if (selectedBlocks.length > 0) {
              if (e.key === 'Backspace' || e.key === 'Delete') {
                  e.preventDefault();
                  selectedBlocks.slice(1).forEach(b => b.remove());
                  const first = selectedBlocks[0];
                  first.textContent = '';
                  first.dataset.source = '';
                  ensureEditing(first);
                  placeCaretEnd(first);
                  first.classList.remove('selected-block');
                  hasBlockSelection = false;
                  updateWordCount();
                  return;
              }
              if (e.key.length === 1 && !mod) {
                  e.preventDefault();
                  selectedBlocks.slice(1).forEach(b => b.remove());
                  const first = selectedBlocks[0];
                  first.textContent = e.key;
                  first.dataset.source = e.key;
                  ensureEditing(first);
                  placeCaretEnd(first);
                  first.classList.remove('selected-block');
                  hasBlockSelection = false;
                  updateWordCount();
                  return;
              }
          }
      }

      const line = (e.target as HTMLElement)?.closest('.live-line') as HTMLElement | null;
      if (!line) return;
      const plain = () => line.textContent?.replace(/\r?\n/g, '') || '';

      // Ctrl + S / Cmd + S - Manual Save
      if (mod && !e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (line.classList.contains('editing')) {
          line.dataset.source = line.textContent || '';
        }
        const md = collectMD();
        if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
        isInternalChangeRef.current = true;
        onChange(md);
        onManualSave?.(md);
        setTimeout(() => {
          isInternalChangeRef.current = false;
        }, 50);
        return;
      }

      // Handle active Slash Menu navigation
      const curSlash = slashMenuRef.current;
      const curCommands = filteredCommandsRef.current;
      if (curSlash.open && curCommands.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          e.stopPropagation();
          setSlashMenu((prev) => {
            const nextIdx = (prev.selectedIndex + 1) % curCommands.length;
            return {
              ...prev,
              selectedIndex: nextIdx,
            };
          });
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          e.stopPropagation();
          setSlashMenu((prev) => {
            const prevIdx = (prev.selectedIndex - 1 + curCommands.length) % curCommands.length;
            return {
              ...prev,
              selectedIndex: prevIdx,
            };
          });
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          e.stopPropagation();
          const selected = curCommands[curSlash.selectedIndex] || curCommands[0];
          if (selected) {
            executeCommand(selected);
          }
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          setSlashMenu((prev) => ({ ...prev, open: false }));
          return;
        }
      }

      const setPlain = (txt: string, selStart: number | null = null, selEnd: number | null = null) => {
        line.textContent = txt;
        line.dataset.source = txt;
        if (selStart !== null) {
          const node = line.firstChild || line;
          const len = (node.textContent || '').length;
          const r = document.createRange();
          try {
            r.setStart(node, Math.min(selStart, len));
            r.setEnd(node, Math.min(selEnd ?? selStart, len));
            const s = window.getSelection();
            if (s) {
              s.removeAllRanges();
              s.addRange(r);
            }
          } catch {}
        }
        updateWordCount();
      };

      const selRange = () => {
        const s = window.getSelection();
        if (!s || !s.rangeCount) return { start: 0, end: 0, sel: '', text: plain() };
        const r = s.getRangeAt(0);
        const pre = r.cloneRange();
        pre.selectNodeContents(line);
        pre.setEnd(r.startContainer, r.startOffset);
        const start = pre.toString().length;
        return { start, end: start + r.toString().length, sel: r.toString(), text: plain() };
      };

      const wrapSel = (pre: string, post: string) => {
        ensureEditing(line);
        const { start, end, sel, text } = selRange();
        const mid = sel || 'text';
        setPlain(
          text.slice(0, start) + pre + mid + post + text.slice(end),
          start + pre.length,
          start + pre.length + mid.length
        );
      };

      const togglePrefix = (prefixFn: (t: string) => string) => {
        ensureEditing(line);
        setPlain(prefixFn(plain()));
        placeCaretEnd(line);
      };

      if (mod && !e.shiftKey) {
        const k = e.key.toLowerCase();
        if (k === 'b') {
          e.preventDefault();
          wrapSel('**', '**');
          return;
        }
        if (k === 'i') {
          e.preventDefault();
          wrapSel('*', '*');
          return;
        }
        if (k === 'e' || k === '`') {
          e.preventDefault();
          wrapSel('`', '`');
          return;
        }
        if (k === 'k') {
          e.preventDefault();
          ensureEditing(line);
          const { start, end, sel, text } = selRange();
          const mid = sel || 'link text';
          setPlain(
            text.slice(0, start) + `[${mid}](https://)` + text.slice(end),
            start + 1,
            start + 1 + mid.length
          );
          return;
        }
        if (['1', '2', '3', '4', '0'].includes(e.key)) {
          e.preventDefault();
          togglePrefix((t) => {
            const stripped = t.replace(/^(#{1,3}\s)/, '');
            if (e.key === '4' || e.key === '0') return stripped;
            const p = '#'.repeat(Number(e.key)) + ' ';
            return t.startsWith(p) ? stripped : p + stripped;
          });
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          togglePrefix((t) => {
            if (/\[x\]/i.test(t)) return t.replace(/\[x\]/i, '[ ]');
            if (/\[\s\]/.test(t)) return t.replace(/\[\s\]/, '[x]');
            return `- [x] ${t.replace(/^([->\d.]\s*)*/, '').trim()}`;
          });
          return;
        }
      }

      if (mod && e.shiftKey) {
        const k = e.key.toLowerCase();
        if (k === 'l') {
          e.preventDefault();
          togglePrefix((t) =>
            /^-(\s|$)/.test(t)
              ? t.replace(/^-\s?/, '')
              : `- ${t.replace(/^([#>]\s*|-\s\[[ x]\]\s*|\d+\.\s*)/, '')}`
          );
          return;
        }
        if (k === 'o') {
          e.preventDefault();
          togglePrefix((t) =>
            /^\d+\.\s/.test(t)
              ? t.replace(/^\d+\.\s?/, '')
              : `1. ${t.replace(/^([#>]\s*|-\s\[[ x]\]\s*|-\s*)/, '')}`
          );
          return;
        }
        if (k === 't') {
          e.preventDefault();
          togglePrefix((t) =>
            /-\s\[[ x]\]/.test(t)
              ? t.replace(/^-\s\[[ x]\]\s?/, '')
              : `- [ ] ${t.replace(/^([#>]\s*|-\s?|\d+\.\s*)/, '')}`
          );
          return;
        }
        if (k === 'q') {
          e.preventDefault();
          togglePrefix((t) =>
            /^>\s?/.test(t) ? t.replace(/^>\s?/, '') : `> ${t.replace(/^(#{1,3}\s|-\s?)/, '')}`
          );
          return;
        }
        if (k === 'k' || k === 'd') {
          e.preventDefault();
          const nxt = (line.nextElementSibling || line.previousElementSibling) as HTMLElement | null;
          line.remove();
          if (!liveEd.children.length) {
            liveEd.appendChild(makeLine('', false));
          } else if (nxt?.classList.contains('live-line')) {
            placeCaretEnd(nxt);
          }
          updateWordCount();
          return;
        }
      }

      if (e.altKey || (mod && e.shiftKey)) {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          const sib = (e.key === 'ArrowUp'
            ? line.previousElementSibling
            : line.nextElementSibling) as HTMLElement | null;
          if (sib?.classList.contains('live-line')) {
            commitLine(line);
            if (e.key === 'ArrowUp') liveEd.insertBefore(line, sib);
            else liveEd.insertBefore(sib, line);
            ensureEditing(line);
            placeCaretEnd(line);
            updateWordCount();
          }
          return;
        }
      }

      if (e.key === 'Tab') {
        e.preventDefault();
        ensureEditing(line);
        const { start, end, text } = selRange();
        if (e.shiftKey) {
          setPlain(text.replace(/^ {2}/, ''), Math.max(0, start - 2), Math.max(0, end - 2));
        } else {
          setPlain(text.slice(0, start) + '  ' + text.slice(end), start + 2, start + 2);
        }
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        commitLine(line);
        line.blur();
        setSlashMenu((prev) => ({ ...prev, open: false }));
        return;
      }

      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const s = window.getSelection();
        if (!s) return;
        const atStart = s.anchorOffset === 0;
        const atEnd = s.anchorOffset === (s.anchorNode?.textContent?.length || 0);
        const sib = (e.key === 'ArrowUp'
          ? line.previousElementSibling
          : line.nextElementSibling) as HTMLElement | null;

        if (sib?.classList.contains('live-line') && (atStart || atEnd || !line.classList.contains('editing'))) {
          e.preventDefault();
          commitLine(line);
          ensureEditing(sib);
          placeCaretEnd(sib);
        }
        return;
      }

      if (e.key === 'Enter' && !mod) {
        e.preventDefault();
        ensureEditing(line);
        const src = plain();
        commitLine(line);

        let cont = '';
        let m: RegExpMatchArray | null;
        if ((m = src.match(/^(\s*-\s\[[ x]\]\s*)$/i))) {
          /* empty task line */
        } else if ((m = src.match(/^(\s*-\s*)$/))) {
          /* empty bullet */
        } else if ((m = src.match(/^(\s*-\s\[[ x]\]\s+)/i))) {
          cont = '- [ ] ';
        } else if ((m = src.match(/^(\s*-\s+)/))) {
          cont = m[1];
        } else if ((m = src.match(/^(\s*(\d+)\.\s+)/))) {
          cont = `${parseInt(m[2], 10) + 1}. `;
        } else if ((m = src.match(/^(\s*>\s?)/))) {
          cont = m[1];
        }

        const nl = makeLine(cont, false);
        line.after(nl);
        placeCaretEnd(nl);
        updateWordCount();
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        if (e.key === 'Backspace') {
            const { start, end, text: currentText } = selRange();
            if (start === 0 && end === 0) {
                e.preventDefault();
                const prev = line.previousElementSibling as HTMLElement | null;
                if (prev?.classList.contains('live-line')) {
                    ensureEditing(prev);
                    const prevText = prev.dataset.source || '';
                    prev.textContent = prevText + currentText;
                    prev.dataset.source = prev.textContent;
                    line.remove();
                    
                    const node = prev.firstChild || prev;
                    const r = document.createRange();
                    try {
                        r.setStart(node, prevText.length);
                        r.setEnd(node, prevText.length);
                        const sel = window.getSelection();
                        sel?.removeAllRanges();
                        sel?.addRange(r);
                    } catch {}
                    updateWordCount();
                } else if (currentText === '') {
                    line.remove();
                    if (!liveEd.children.length) {
                        liveEd.appendChild(makeLine('', false));
                    }
                    updateWordCount();
                }
                return;
            }
        }
      }
    };

    const handlePaste = (e: ClipboardEvent) => {
      if (hasBlockSelection) {
          const selectedBlocks = Array.from(liveEd.querySelectorAll('.selected-block')) as HTMLElement[];
          if (selectedBlocks.length > 0) {
              const text = e.clipboardData?.getData('text/plain');
              if (!text) return;
              e.preventDefault();
              const lines = text.split(/\r?\n/);
              
              selectedBlocks.slice(1).forEach(b => b.remove());
              const first = selectedBlocks[0];
              first.textContent = lines[0];
              first.dataset.source = lines[0];
              ensureEditing(first);
              if (lines.length > 1) {
                  insertTemplateLines(first, lines.slice(1));
              } else {
                  placeCaretEnd(first);
              }
              first.classList.remove('selected-block');
              hasBlockSelection = false;
              updateWordCount();
              return;
          }
      }

      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      const startLine = (range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer as HTMLElement)?.closest('.live-line') as HTMLElement | null;

      if (!startLine) return;

      const text = e.clipboardData?.getData('text/plain');
      if (!text) return;
      e.preventDefault();

      const lines = text.split(/\r?\n/);

      ensureEditing(startLine);
      const newSel = window.getSelection();
      const currentText = startLine.dataset.source || '';
      let start = currentText.length;
      let end = currentText.length;
      if (newSel && newSel.rangeCount) {
         const r = newSel.getRangeAt(0);
         const pre = r.cloneRange();
         pre.selectNodeContents(startLine);
         pre.setEnd(r.startContainer, r.startOffset);
         start = pre.toString().length;
         end = start + r.toString().length;
      }
      
      const before = currentText.slice(0, start);
      const after = currentText.slice(end);

      if (lines.length === 1) {
         startLine.textContent = before + lines[0] + after;
         startLine.dataset.source = startLine.textContent;
         
         const r = document.createRange();
         const node = startLine.firstChild || startLine;
         try {
             r.setStart(node, start + lines[0].length);
             r.setEnd(node, start + lines[0].length);
             newSel?.removeAllRanges();
             newSel?.addRange(r);
         } catch {}
      } else {
         const newLines = [...lines];
         newLines[0] = before + newLines[0];
         newLines[newLines.length - 1] = newLines[newLines.length - 1] + after;
         insertTemplateLines(startLine, newLines);
      }
      updateWordCount();
    };

    const handleCopyCut = (e: ClipboardEvent) => {
      if (hasBlockSelection) {
          const selectedBlocks = Array.from(liveEd.querySelectorAll('.selected-block')) as HTMLElement[];
          if (selectedBlocks.length > 0) {
             e.preventDefault();
             const text = selectedBlocks.map(b => b.dataset.source || '').join('\n');
             e.clipboardData?.setData('text/plain', text);
             
             if (e.type === 'cut') {
                 selectedBlocks.slice(1).forEach(b => b.remove());
                 const first = selectedBlocks[0];
                 first.textContent = '';
                 first.dataset.source = '';
                 ensureEditing(first);
                 placeCaretEnd(first);
                 first.classList.remove('selected-block');
                 hasBlockSelection = false;
                 updateWordCount();
             }
          }
      }
    };

    liveEd.addEventListener('focusin', handleFocusIn);
    liveEd.addEventListener('focusout', handleFocusOut);
    liveEd.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    liveEd.addEventListener('input', handleInput);
    liveEd.addEventListener('click', handleClick);
    liveEd.addEventListener('keydown', handleKeyDown);
    liveEd.addEventListener('paste', handlePaste);
    liveEd.addEventListener('copy', handleCopyCut);
    liveEd.addEventListener('cut', handleCopyCut);

    return () => {
      liveEd.removeEventListener('focusin', handleFocusIn);
      liveEd.removeEventListener('focusout', handleFocusOut);
      liveEd.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      liveEd.removeEventListener('input', handleInput);
      liveEd.removeEventListener('click', handleClick);
      liveEd.removeEventListener('keydown', handleKeyDown);
      liveEd.removeEventListener('paste', handlePaste);
      liveEd.removeEventListener('copy', handleCopyCut);
      liveEd.removeEventListener('cut', handleCopyCut);
    };
  }, [updateWordCount, collectMD, onChange, onManualSave, executeCommand]);

  return (
    <div className="live-editor-container">
      <div id="liveEditor" className="live-editor" ref={editorRef} />

      {/* Floating Slash Commands Menu (Zero Emojis) */}
      {slashMenu.open && (
        <div
          className="slash-menu"
          style={{ top: `${slashMenu.y}px`, left: `${slashMenu.x}px` }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="slash-menu-head">
            <span>Blocks & Tools</span>
            <kbd>ESC to close</kbd>
          </div>
          <div className="slash-menu-list" ref={menuListRef}>
            {filteredCommands.length === 0 ? (
              <div className="slash-menu-empty">No matching commands</div>
            ) : (
              filteredCommands.map((cmd, idx) => {
                const isSelected = idx === slashMenu.selectedIndex;
                return (
                  <button
                    key={cmd.id}
                    className={`slash-item ${isSelected ? 'active' : ''}`}
                    onClick={() => executeCommand(cmd)}
                    type="button"
                  >
                    <span className="slash-item-badge">{cmd.badge}</span>
                    <div className="slash-item-info">
                      <div className="slash-item-title">{cmd.label}</div>
                      <div className="slash-item-desc">{cmd.description}</div>
                    </div>
                    {isSelected && <span className="slash-item-hint">↵</span>}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
};
