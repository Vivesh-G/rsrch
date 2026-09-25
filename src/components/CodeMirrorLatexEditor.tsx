import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { EditorState, StateField, Prec } from '@codemirror/state';
import {
  EditorView,
  lineNumbers,
  keymap,
  showTooltip,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
} from '@codemirror/view';
import type { Tooltip } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { StreamLanguage } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { snippet, nextSnippetField, prevSnippetField, clearSnippet, autocompletion, CompletionContext } from '@codemirror/autocomplete';
import { lintGutter, setDiagnostics, linter } from '@codemirror/lint';
import { katexPlugin } from './katexDecoration';
import { LATEX_SLASH_COMMANDS, type LatexSlashCommand } from './latexAutocomplete';
import { api } from '../services/api';
import { fetchAndParseSynctex, syncTexLineToRect, syncTexRectToLine } from '../utils/synctex';

const selectionTooltip = StateField.define<Tooltip | null>({
  create: getCursorTooltip,
  update(tooltip, tr) {
    if (!tr.docChanged && !tr.selection) return tooltip;
    return getCursorTooltip(tr.state);
  },
  provide: (f) => showTooltip.from(f),
});

function getCursorTooltip(state: EditorState): Tooltip | null {
  const ranges = state.selection.ranges;
  if (ranges.length === 0 || ranges[0].empty) return null;
  const range = ranges[0];
  const selectedText = state.doc.sliceString(range.from, range.to);
  if (!selectedText.trim()) return null;

  return {
    pos: range.from,
    above: true,
    strictSide: true,
    create: () => {
      const dom = document.createElement('div');
      dom.className = 'latex-ask-ai-popup';

      const btn = document.createElement('button');
      btn.className = 'latex-ask-ai-btn';
      btn.type = 'button';

      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('width', '12');
      icon.setAttribute('height', '12');
      icon.setAttribute('viewBox', '0 0 24 24');
      icon.setAttribute('fill', 'none');
      icon.setAttribute('stroke', 'currentColor');
      icon.setAttribute('stroke-width', '2.5');
      icon.setAttribute('stroke-linecap', 'round');
      icon.setAttribute('stroke-linejoin', 'round');
      icon.innerHTML =
        '<path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/>';

      const label = document.createElement('span');
      label.textContent = 'Ask AI';

      btn.appendChild(icon);
      btn.appendChild(label);

      btn.onmousedown = (e) => {
        e.preventDefault();
      };

      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.dispatchEvent(
          new CustomEvent('rsrch:chat-append', {
            detail: { text: 'Regarding this LaTeX block:\n```latex\n' + selectedText + '\n```\n' },
          })
        );
      };

      dom.appendChild(btn);
      return {
        dom,
        mount: () => {
          dom.parentElement?.classList.add('cm-selection-tooltip-wrapper');
        },
      };
    },
  };
}

interface CodeMirrorLatexEditorProps {
  docId: string;
  workspaceId: string;
  content: string;
  onChange: (content: string) => void;
  onManualSave?: (content: string) => void;
  onWordCountChange?: (count: number) => void;
}

export const CodeMirrorLatexEditor: React.FC<CodeMirrorLatexEditorProps> = ({
  docId,
  workspaceId,
  content,
  onChange,
  onManualSave,
  onWordCountChange,
}) => {
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastWordCountRef = useRef<number>(-1);
  const docIdRef = useRef(docId);
  const workspaceIdRef = useRef(workspaceId);
  workspaceIdRef.current = workspaceId;
  const contentRef = useRef(content);
  contentRef.current = content;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onWordCountRef = useRef(onWordCountChange);
  onWordCountRef.current = onWordCountChange;

  const [activeErrors, setActiveErrors] = useState<{ line: number | null; message: string; severity: string }[]>([]);
  const diagnosticsRef = useRef<any[]>([]);

  // Slash commands popup state
  const [slashMenu, setSlashMenu] = useState<{
    open: boolean;
    query: string;
    from: number;
    to: number;
    x: number;
    y: number;
    selectedIndex: number;
  }>({
    open: false,
    query: '',
    from: 0,
    to: 0,
    x: 0,
    y: 0,
    selectedIndex: 0,
  });

  const [bibEntries, setBibEntries] = useState<{key: string, title: string, author: string, year: string}[]>([]);
  
  useEffect(() => {
    if (!workspaceId) return;
    const fetchBib = async () => {
      try {
        const res = await fetch(`${api.baseUrl}/workspaces/${workspaceId}/bibtex`);
        if (res.ok) {
          const data = await res.json();
          const content = data.content || '';
          
          const entries = [];
          const regex = /@\w+\s*{\s*([^,]+),/g;
          let match;
          while ((match = regex.exec(content)) !== null) {
            const key = match[1].trim();
            const nextAt = content.indexOf('@', match.index + 1);
            const entryContent = nextAt === -1 ? content.slice(match.index) : content.slice(match.index, nextAt);
            
            // Allow matching curly braces or quotes, handles newlines
            const titleMatch = entryContent.match(/title\s*=\s*[{"]([^}"]*)[}"]/i);
            const authorMatch = entryContent.match(/author\s*=\s*[{"]([^}"]*)[}"]/i);
            const yearMatch = entryContent.match(/year\s*=\s*[{"]?(\d+)[}"]?/i);
            
            entries.push({
              key,
              title: titleMatch ? titleMatch[1].replace(/\s+/g, ' ') : 'Unknown Title',
              author: authorMatch ? authorMatch[1].replace(/\s+/g, ' ') : 'Unknown Author',
              year: yearMatch ? yearMatch[1] : '',
            });
          }
          setBibEntries(entries);
        }
      } catch (e) {
        console.error('Failed to parse bibtex for autocomplete', e);
      }
    };
    fetchBib();
    
    window.addEventListener('rsrch:bibtex-updated', fetchBib);
    return () => window.removeEventListener('rsrch:bibtex-updated', fetchBib);
  }, [workspaceId]);

  useEffect(() => {
    const handleInverseSync = (e: Event) => {
      const currentDocId = docIdRef.current;
      const detail = (e as CustomEvent).detail;
      if (!detail || detail.docId !== currentDocId) return;
      fetchAndParseSynctex(currentDocId).then((data) => {
        if (!data) return;
        const block = syncTexRectToLine(data, detail.page, detail.x, detail.y);
        if (block && block.line) {
          const view = viewRef.current;
          if (view) {
            const line = view.state.doc.line(Math.min(block.line, view.state.doc.lines));
            view.dispatch({
              selection: { anchor: line.from },
              scrollIntoView: true,
            });
            view.focus();
          }
        }
      });
    };
    window.addEventListener('rsrch:inverse-sync', handleInverseSync);
    return () => window.removeEventListener('rsrch:inverse-sync', handleInverseSync);
  }, [docId]);

  const bibEntriesRef = useRef(bibEntries);
  bibEntriesRef.current = bibEntries;
  
  const slashMenuRef = useRef(slashMenu);
  slashMenuRef.current = slashMenu;

  const menuListRef = useRef<HTMLDivElement>(null);
  const menuContainerRef = useRef<HTMLDivElement>(null);

  // Filter commands by query
  const filteredCommands = useMemo(() => {
    const q = slashMenu.query.trim().toLowerCase();
    if (!q) return LATEX_SLASH_COMMANDS;
    return LATEX_SLASH_COMMANDS.filter(
      (c) =>
        c.label.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q) ||
        c.id.toLowerCase().includes(q) ||
        c.keywords.some((k) => k.toLowerCase().includes(q))
    );
  }, [slashMenu.query]);

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

  // Execute Slash Command
  const executeCommand = useCallback((cmd: LatexSlashCommand) => {
    const view = viewRef.current;
    if (!view) return;
    const cur = slashMenuRef.current;
    const from = cur.open ? cur.from : view.state.selection.main.head;
    const to = view.state.selection.main.head;

    const snipFn = snippet(cmd.template);
    snipFn(view, null, from, to);
    view.focus();
    setSlashMenu((prev) => ({ ...prev, open: false }));
  }, []);

  const executeCommandRef = useRef(executeCommand);
  executeCommandRef.current = executeCommand;

  useEffect(() => {
    if (!editorRef.current) return;

    const onUpdate = EditorView.updateListener.of((v) => {
      if (v.docChanged) {
        const newContent = v.state.doc.toString();

        // Compute word count
        const words = (newContent.trim().match(/\S+/g) || []).length;
        if (words !== lastWordCountRef.current) {
          lastWordCountRef.current = words;
          onWordCountRef.current?.(words);
        }

        if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = setTimeout(() => {
          onChangeRef.current(newContent);
        }, 250);
      }

      // Check for Slash Command trigger on doc change or selection move
      if (v.docChanged || v.selectionSet) {
        const sel = v.state.selection.main;
        if (!sel.empty) {
          setSlashMenu((prev) => (prev.open ? { ...prev, open: false } : prev));
          return;
        }

        const head = sel.head;
        const line = v.state.doc.lineAt(head);
        const col = head - line.from;
        const beforeCaret = line.text.slice(0, col);
        const slashMatch = beforeCaret.match(/(?:^|\s)\/([a-zA-Z0-9_-]*)$/);

        if (slashMatch) {
          const query = slashMatch[1].toLowerCase();
          const triggerLen = slashMatch[0].length;
          const startOffset = slashMatch[0].startsWith(' ') ? 1 : 0;
          const from = head - triggerLen + startOffset;
          const coords = v.view.coordsAtPos(head);

          if (coords) {
            const menuWidth = 300;
            const menuHeight = 320;
            const posX = Math.max(16, Math.min(coords.left, window.innerWidth - menuWidth - 20));
            const posY =
              coords.bottom + menuHeight > window.innerHeight
                ? Math.max(16, coords.top - menuHeight - 6)
                : coords.bottom + 6;

            setSlashMenu({
              open: true,
              query,
              from,
              to: head,
              x: posX,
              y: posY,
              selectedIndex: 0,
            });
            return;
          }
        }

        setSlashMenu((prev) => (prev.open ? { ...prev, open: false } : prev));
      }
    });

    const slashMenuKeymap = Prec.highest(
      keymap.of([
        {
          key: 'ArrowDown',
          run: () => {
            if (!slashMenuRef.current.open) return false;
            const cmds = filteredCommandsRef.current;
            if (cmds.length === 0) return false;
            setSlashMenu((prev) => ({
              ...prev,
              selectedIndex: (prev.selectedIndex + 1) % cmds.length,
            }));
            return true;
          },
        },
        {
          key: 'ArrowUp',
          run: () => {
            if (!slashMenuRef.current.open) return false;
            const cmds = filteredCommandsRef.current;
            if (cmds.length === 0) return false;
            setSlashMenu((prev) => ({
              ...prev,
              selectedIndex: (prev.selectedIndex - 1 + cmds.length) % cmds.length,
            }));
            return true;
          },
        },
        {
          key: 'Enter',
          run: () => {
            if (!slashMenuRef.current.open) return false;
            const cmds = filteredCommandsRef.current;
            if (cmds.length === 0) return false;
            const selected = cmds[slashMenuRef.current.selectedIndex] || cmds[0];
            if (selected) {
              executeCommandRef.current(selected);
            }
            return true;
          },
        },
        {
          key: 'Tab',
          run: () => {
            if (!slashMenuRef.current.open) return false;
            const cmds = filteredCommandsRef.current;
            if (cmds.length === 0) return false;
            const selected = cmds[slashMenuRef.current.selectedIndex] || cmds[0];
            if (selected) {
              executeCommandRef.current(selected);
            }
            return true;
          },
        },
        {
          key: 'Escape',
          run: () => {
            if (!slashMenuRef.current.open) return false;
            setSlashMenu((prev) => ({ ...prev, open: false }));
            return true;
          },
        },
      ])
    );

    const keymapConfig = keymap.of([
      ...defaultKeymap,
      ...historyKeymap,
      { key: 'Tab', run: nextSnippetField, shift: prevSnippetField },
      { key: 'Escape', run: clearSnippet },
      {
        key: 'Mod-s',
        run: (view) => {
          const docStr = view.state.doc.toString();
          if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
          onChangeRef.current(docStr);
          onManualSave?.(docStr);
          return true;
        },
      },
    ]);

    const state = EditorState.create({
      doc: content,
      extensions: [
        EditorView.domEventHandlers({
          click: (e, view) => {
            if (e.ctrlKey || e.metaKey) {
              const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
              if (pos !== null) {
                const line = view.state.doc.lineAt(pos).number;
                e.preventDefault();
                const currentDocId = docIdRef.current;
                // Forward sync: parse synctex and scroll PDF
                fetchAndParseSynctex(currentDocId).then((data) => {
                  if (!data) return;
                  const rect = syncTexLineToRect(data, line);
                  if (rect) {
                    window.dispatchEvent(
                      new CustomEvent('rsrch:scroll-to-rect', {
                        detail: {
                          docId: currentDocId,
                          page: rect.page,
                          x: rect.left,
                          y: rect.bottom,
                          width: rect.width || 5, // Fallback width if missing
                          height: rect.height || 10,
                        },
                      })
                    );
                  } else {
                    console.warn('No SyncTeX block found for this line. (Preamble or non-typeset line?)');
                  }
                });
              }
            }
          },
          drop: (e, view) => {
            if (e.dataTransfer && e.dataTransfer.files.length > 0) {
              const file = e.dataTransfer.files[0];
              if (file.type.startsWith('image/') || file.name.endsWith('.pdf')) {
                e.preventDefault();
                const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
                if (pos !== null) {
                  // Upload to backend
                  const formData = new FormData();
                  formData.append('files', file);
                  fetch(`${api.baseUrl}/workspaces/${workspaceIdRef.current}/assets`, {
                    method: 'POST',
                    body: formData,
                  }).catch(err => console.error("Drop upload failed", err));

                  // Insert template
                  const template = `\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=\\linewidth]{figures/${file.name}}\n  \\caption{${file.name}}\n\\end{figure}\n`;
                  view.dispatch({ changes: { from: pos, insert: template } });
                  return true;
                }
              }
            }
            return false;
          }
        }),
        autocompletion({
          override: [
            (context: CompletionContext) => {
              const word = context.matchBefore(/\\cite[a-z]*\{[^}]*/);
              if (!word) return null;
              if (word.from === word.to && !context.explicit) return null;
              
              const options = bibEntriesRef.current.map(entry => ({
                label: entry.key,
                type: 'text',
                detail: entry.year ? `(${entry.year})` : '',
                info: `${entry.title}\n${entry.author}`,
              }));
              
              return {
                from: word.from + word.text.lastIndexOf('{') + 1,
                options,
                validFor: /^[\w.-]*$/
              };
            }
          ]
        }),
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        history(),
        drawSelection(),
        dropCursor(),
        slashMenuKeymap,
        keymapConfig,
        StreamLanguage.define(stex),
        linter(() => diagnosticsRef.current),
        lintGutter(),
        katexPlugin,
        selectionTooltip,
        onUpdate,
        EditorView.theme({
          '&': { height: '100%', fontSize: '14px', backgroundColor: 'transparent', color: 'var(--text-primary)' },
          '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-mono, monospace)', lineHeight: '1.6' },
          '.cm-content': { padding: '16px 16px 16px 12px', minHeight: '100%', caretColor: 'var(--text-primary)' },
          '&.cm-focused': { outline: 'none' },
          '.cm-gutters': {
            backgroundColor: 'var(--surface)',
            borderRight: '1px solid var(--border)',
            color: 'var(--text-tertiary)',
            position: 'sticky',
            left: 0,
            zIndex: 10,
            boxShadow: '2px 0 4px -2px rgba(0, 0, 0, 0.05)',
          },
          '.cm-gutter': {
            backgroundColor: 'var(--surface)',
          },
          '.cm-lineNumbers': {
            backgroundColor: 'var(--surface)',
          },
          '.cm-gutterElement': {
            padding: '0 8px 0 10px',
            minWidth: '36px',
            textAlign: 'right',
            backgroundColor: 'var(--surface)',
          },
          '.cm-activeLine': {
            backgroundColor: 'rgba(255, 255, 255, 0.035)',
          },
          '.cm-activeLineGutter': {
            backgroundColor: 'var(--surface-subtle) !important',
            color: 'var(--text-primary)',
            fontWeight: '600',
          },
          '.cm-cursor, .cm-cursor-primary, .cm-dropCursor': {
            borderLeft: '2px solid var(--text-primary) !important',
          },
          '&.cm-focused > .cm-scroller > .cm-cursorLayer': {
            zIndex: 5,
          },
          '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
            backgroundColor: 'var(--accent-alpha) !important',
            borderRadius: '2px',
          },
          '.cm-content ::selection, .cm-line ::selection, .cm-line::selection': {
            backgroundColor: 'transparent !important',
          },
          '.cm-tooltip': {
            backgroundColor: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            overflow: 'hidden',
            boxShadow: 'var(--shadow-md)',
            color: 'var(--text-primary)',
            zIndex: 20,
          },
          '.cm-tooltip.cm-selection-tooltip-wrapper': {
            backgroundColor: 'transparent !important',
            border: 'none !important',
            borderRadius: '0 !important',
            boxShadow: 'none !important',
            padding: '0 !important',
            overflow: 'visible !important',
            marginBottom: '6px !important',
            zIndex: 100,
          },
          '.cm-tooltip.cm-tooltip-lint': {
            padding: '4px',
            backgroundColor: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: '8px',
            boxShadow: 'var(--shadow-md)',
            zIndex: 20,
          },
          '.cm-diagnostic': {
            padding: '6px 12px',
            fontFamily: 'var(--font-sans)',
            fontSize: '12.5px',
            color: 'var(--text-primary)',
            borderLeft: '3px solid var(--danger)',
            borderRadius: '4px',
            backgroundColor: 'var(--surface-subtle)',
            margin: '2px',
            fontWeight: '500',
          },
          '.cm-diagnostic-error': { borderLeftColor: 'var(--danger)' },
          '.cm-diagnostic-warning': { borderLeftColor: 'var(--warning)' },
        }),
      ],
    });

    const view = new EditorView({
      state,
      parent: editorRef.current,
    });
    viewRef.current = view;

    const handleOutsideClick = (e: MouseEvent) => {
      if (menuContainerRef.current && !menuContainerRef.current.contains(e.target as Node)) {
        setSlashMenu((prev) => (prev.open ? { ...prev, open: false } : prev));
      }
    };
    window.addEventListener('mousedown', handleOutsideClick);

    const handleScroll = () => {
      if (slashMenuRef.current.open && viewRef.current) {
        const sel = viewRef.current.state.selection.main;
        const coords = viewRef.current.coordsAtPos(sel.head);
        if (!coords) {
          setSlashMenu((prev) => (prev.open ? { ...prev, open: false } : prev));
          return;
        }
        const menuWidth = 300;
        const menuHeight = 320;
        const posX = Math.max(16, Math.min(coords.left, window.innerWidth - menuWidth - 20));
        const posY =
          coords.bottom + menuHeight > window.innerHeight
            ? Math.max(16, coords.top - menuHeight - 6)
            : coords.bottom + 6;

        setSlashMenu((prev) => ({ ...prev, x: posX, y: posY }));
      }
    };
    view.scrollDOM.addEventListener('scroll', handleScroll);

    return () => {
      view.destroy();
      window.removeEventListener('mousedown', handleOutsideClick);
      view.scrollDOM.removeEventListener('scroll', handleScroll);
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, []); // Run once on mount

  // Sync external content: full replace on doc switch; otherwise only
  // accept external updates when the editor is empty or from external edits
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const currentDoc = view.state.doc.toString();
    if (docIdRef.current !== docId) {
      docIdRef.current = docId;
      setActiveErrors([]);
      diagnosticsRef.current = [];
      if (currentDoc !== content) {
        view.dispatch({
          changes: { from: 0, to: currentDoc.length, insert: content },
        });
      }
      try {
        view.dispatch(setDiagnostics(view.state, []));
      } catch {}
      return;
    }
    if (currentDoc !== content) {
      const isEmpty = currentDoc.length === 0;
      const externalAppend =
        content.length > currentDoc.length &&
        content.startsWith(currentDoc.slice(0, Math.min(currentDoc.length, 512)));
      const unfocused = !view.hasFocus;
      if (isEmpty || (externalAppend && unfocused)) {
        view.dispatch({
          changes: { from: 0, to: currentDoc.length, insert: content },
        });
      }
    }
  }, [docId, content]);

  useEffect(() => {
    const handleApply = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.code != null && viewRef.current) {
        const view = viewRef.current;
        const selection = view.state.selection.main;
        const code = String(detail.code);
        view.dispatch({
          changes: { from: selection.from, to: selection.to, insert: code },
          selection: { anchor: selection.from, head: selection.from + code.length },
        });
        view.focus();
        if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
        onChangeRef.current(view.state.doc.toString());
      }
    };
    window.addEventListener('rsrch:latex-apply', handleApply);
    return () => window.removeEventListener('rsrch:latex-apply', handleApply);
  }, []);

  useEffect(() => {
    const handleErrors = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail && detail.docId === docId && viewRef.current) {
        const view = viewRef.current;
        const doc = view.state.doc;
        const rawErrors = detail.errors || [];
        setActiveErrors(rawErrors);

        const cmDiagnostics = rawErrors.map((err: any) => {
          let lineNo = err.line ? err.line : 1;
          if (lineNo > doc.lines) lineNo = doc.lines;
          if (lineNo < 1) lineNo = 1;

          const line = doc.line(lineNo);
          return {
            from: line.from,
            to: line.to,
            severity: err.severity === 'warning' ? 'warning' : 'error',
            message: err.message,
          };
        });

        diagnosticsRef.current = cmDiagnostics;
        view.dispatch(setDiagnostics(view.state, cmDiagnostics));
      }
    };

    const handleCompiled = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail && detail.docId === docId && viewRef.current) {
        setActiveErrors([]);
        diagnosticsRef.current = [];
        try {
          viewRef.current.dispatch(setDiagnostics(viewRef.current.state, []));
        } catch {}
      }
    };

    window.addEventListener('rsrch:latex-errors', handleErrors);
    window.addEventListener('rsrch:latex-compiled', handleCompiled);
    return () => {
      window.removeEventListener('rsrch:latex-errors', handleErrors);
      window.removeEventListener('rsrch:latex-compiled', handleCompiled);
    };
  }, [docId]);

  const handleJumpToError = (lineNo: number | null) => {
    if (!viewRef.current || !lineNo) return;
    const view = viewRef.current;
    const clampedLine = Math.min(Math.max(1, lineNo), view.state.doc.lines);
    const line = view.state.doc.line(clampedLine);
    view.dispatch({
      selection: { anchor: line.from },
      scrollIntoView: true,
    });
    view.focus();
  };

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: 'transparent',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      <div ref={editorRef} style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }} />

      {/* Floating Slash Commands Menu (Consistent with Notes UI) */}
      {slashMenu.open && (
        <div
          ref={menuContainerRef}
          className="slash-menu"
          style={{ top: `${slashMenu.y}px`, left: `${slashMenu.x}px` }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="slash-menu-head">
            <span>Blocks & Tools</span>
            <kbd onClick={() => setSlashMenu((prev) => ({ ...prev, open: false }))}>ESC to close</kbd>
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
                    onMouseEnter={() => setSlashMenu((prev) => ({ ...prev, selectedIndex: idx }))}
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

      {activeErrors.length > 0 && (
        <div
          className="cm-compile-error-bar"
          style={{
            backgroundColor: 'var(--surface-subtle)',
            borderTop: '1px solid var(--danger)',
            padding: '8px 14px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: '12px',
            fontFamily: 'var(--font-sans)',
            color: 'var(--text-primary)',
            boxShadow: 'var(--shadow-md)',
            zIndex: 10,
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', overflow: 'hidden' }}>
            <span
              style={{
                backgroundColor: activeErrors[0].severity === 'warning' ? 'var(--warning, #eab308)' : 'var(--danger)',
                color: '#fff',
                borderRadius: '3px',
                padding: '1px 6px',
                fontWeight: 'bold',
                fontSize: '11px',
                flexShrink: 0,
              }}
            >
              {activeErrors[0].severity === 'warning' ? 'Warning' : 'Build Error'}
            </span>
            <span style={{ fontWeight: 600, flexShrink: 0 }}>
              {activeErrors[0].line ? `Line ${activeErrors[0].line}:` : ''}
            </span>
            <span
              title={activeErrors[0].message}
              style={{
                textOverflow: 'ellipsis',
                overflow: 'hidden',
                whiteSpace: 'nowrap',
              }}
            >
              {activeErrors[0].message}
            </span>
            {activeErrors.length > 1 && (
              <span style={{ color: 'var(--text-tertiary)', fontSize: '11px', flexShrink: 0 }}>
                (+{activeErrors.length - 1} more)
              </span>
            )}
          </div>
          {activeErrors[0].line && (
            <button
              type="button"
              onClick={() => handleJumpToError(activeErrors[0].line)}
              style={{
                backgroundColor: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: '4px',
                padding: '3px 8px',
                fontSize: '11px',
                cursor: 'pointer',
                color: 'var(--text-primary)',
                marginLeft: '12px',
                flexShrink: 0,
                fontWeight: 500,
              }}
            >
              Jump to line
            </button>
          )}
        </div>
      )}
    </div>
  );
};
