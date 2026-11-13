import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { Compartment, EditorState, StateField, Prec } from '@codemirror/state';
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
import type { CompileDiagnostic } from '../types';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { StreamLanguage } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { snippet, nextSnippetField, prevSnippetField, clearSnippet, autocompletion, CompletionContext } from '@codemirror/autocomplete';
import { lintGutter, setDiagnostics, linter } from '@codemirror/lint';
import { katexPlugin } from './katexDecoration';
import { LATEX_SLASH_COMMANDS, type LatexSlashCommand } from './latexAutocomplete';
import { SLASH_MENU_BOUNDS, SLASH_TRIGGER_RE, SlashCommandMenu } from './SlashCommandMenu';
import { useOutsideClick } from '../hooks/useOutsideClick';
import { api } from '../services/api';
import { countWords } from '../utils/document';
import { computePopoverCoords } from '../utils/dom';
import { consumePendingInverseSync, emitEvent, onEvent, type InverseSyncPayload } from '../utils/events';
import { syncTexLineToRect, syncTexRectToLine } from '../utils/synctex';
import { IconSparkles } from './Icons';

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
        emitEvent('chat-append', {
          text: 'Regarding this LaTeX block:\n```latex\n' + selectedText + '\n```\n',
        });
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
  wordWrap?: boolean;
  lineNumbers?: boolean;
}

export const CodeMirrorLatexEditor: React.FC<CodeMirrorLatexEditorProps> = ({
  docId,
  workspaceId,
  content,
  onChange,
  onManualSave,
  onWordCountChange,
  wordWrap = true,
  lineNumbers: showLineNumbers = true,
}) => {
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastWordCountRef = useRef<number>(-1);
  const docIdRef = useRef(docId);
  const workspaceIdRef = useRef(workspaceId);
  workspaceIdRef.current = workspaceId;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onManualSaveRef = useRef(onManualSave);
  onManualSaveRef.current = onManualSave;
  const onWordCountRef = useRef(onWordCountChange);
  onWordCountRef.current = onWordCountChange;
  const lineNumbersCompartmentRef = useRef(new Compartment());
  const wordWrapCompartmentRef = useRef(new Compartment());

  const [activeErrors, setActiveErrors] = useState<CompileDiagnostic[]>([]);
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
        const content = await api.getBibtex(workspaceId);
        if (!content) {
          setBibEntries([]);
          return;
        }

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
      } catch (e) {
        console.error('Failed to parse bibtex for autocomplete', e);
      }
    };
    fetchBib();

    return onEvent('bibtex-updated', fetchBib);
  }, [workspaceId]);

  useEffect(() => {
    const runInverseSync = (detail: InverseSyncPayload) => {
      const currentDocId = docIdRef.current;
      if (!detail || detail.docId !== currentDocId) return;
      if (detail.page == null || detail.x == null || detail.y == null) {
        console.warn('Go to Block: incomplete click coordinates', detail);
        return;
      }
      api.getSynctex(currentDocId).then((data) => {
        if (!data) {
          console.warn('Go to Block: no SyncTeX data (compile may have failed)');
          return;
        }
        if (!data.blocks.length) {
          console.warn('Go to Block: SyncTeX map is empty — recompile and retry');
          return;
        }
        const block = syncTexRectToLine(data, detail.page, detail.x, detail.y, {
          fx: detail.fx,
          fy: detail.fy,
        });
        if (block && block.line) {
          const view = viewRef.current;
          if (view) {
            const clamped = Math.min(Math.max(1, block.line), view.state.doc.lines);
            const line = view.state.doc.line(clamped);
            view.dispatch({
              selection: { anchor: line.from },
              effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
            });
            view.focus();
          }
        } else {
          console.warn(
            `Go to Block: no source block on page ${detail.page} — stale SyncTeX? Recompile and retry.`
          );
        }
      }).catch((err) => console.warn('Go to Block failed:', err));
    };

    const pending = consumePendingInverseSync(docId);
    if (pending) {
      runInverseSync(pending);
    }

    const unsubSync = onEvent('inverse-sync', runInverseSync);
    const unsubCompiled = onEvent('latex-compiled', () => api.invalidateSynctexCache(docIdRef.current));
    return () => {
      unsubSync();
      unsubCompiled();
    };
  }, [docId]);

  const bibEntriesRef = useRef(bibEntries);
  bibEntriesRef.current = bibEntries;

  const slashMenuRef = useRef(slashMenu);
  slashMenuRef.current = slashMenu;

  const menuContainerRef = useRef<HTMLDivElement>(null);
  const closeSlashMenu = useCallback(
    () => setSlashMenu((prev) => (prev.open ? { ...prev, open: false } : prev)),
    [],
  );
  useOutsideClick(menuContainerRef, slashMenu.open, closeSlashMenu);

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

        const words = countWords(newContent);
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
        const slashMatch = beforeCaret.match(SLASH_TRIGGER_RE);

        if (slashMatch) {
          const query = slashMatch[1].toLowerCase();
          const triggerLen = slashMatch[0].length;
          const startOffset = slashMatch[0].startsWith(' ') ? 1 : 0;
          const from = head - triggerLen + startOffset;
          const coords = v.view.coordsAtPos(head);

          if (coords) {
            const { left, top } = computePopoverCoords(
              coords,
              SLASH_MENU_BOUNDS.width,
              SLASH_MENU_BOUNDS.height,
              SLASH_MENU_BOUNDS.margin,
            );
            setSlashMenu({
              open: true,
              query,
              from,
              to: head,
              x: left,
              y: top,
              selectedIndex: 0,
            });
            return;
          }
        }

        setSlashMenu((prev) => (prev.open ? { ...prev, open: false } : prev));
      }
    });

    const runSelectedSlashCommand = () => {
      if (!slashMenuRef.current.open) return false;
      const cmds = filteredCommandsRef.current;
      if (cmds.length === 0) return false;
      const selected = cmds[slashMenuRef.current.selectedIndex] || cmds[0];
      if (selected) executeCommandRef.current(selected);
      return true;
    };

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
        { key: 'Enter', run: runSelectedSlashCommand },
        { key: 'Tab', run: runSelectedSlashCommand },
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
          onManualSaveRef.current?.(docStr);
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
                api.getSynctex(currentDocId).then((data) => {
                  if (!data) return;
                  const rect = syncTexLineToRect(data, line);
                  if (rect) {
                    emitEvent('scroll-to-rect', {
                      docId: currentDocId,
                      page: rect.page,
                      x: rect.left,
                      y: rect.bottom,
                      width: rect.width || 5,
                      height: rect.height || 10,
                    });
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
                  api.uploadWorkspaceAssets(workspaceIdRef.current, [file]).catch((err) =>
                    console.error('Drop upload failed', err)
                  );

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
        lineNumbersCompartmentRef.current.of(
          showLineNumbers ? [lineNumbers(), highlightActiveLineGutter()] : []
        ),
        wordWrapCompartmentRef.current.of(wordWrap ? EditorView.lineWrapping : []),
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
          '&': { height: '100%', fontSize: 'var(--editor-font-size, 14px)', backgroundColor: 'transparent', color: 'var(--text-primary)' },
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

    const handleScroll = () => {
      if (slashMenuRef.current.open && viewRef.current) {
        const sel = viewRef.current.state.selection.main;
        const coords = viewRef.current.coordsAtPos(sel.head);
        if (!coords) {
          setSlashMenu((prev) => (prev.open ? { ...prev, open: false } : prev));
          return;
        }
        const { left, top } = computePopoverCoords(
          coords,
          SLASH_MENU_BOUNDS.width,
          SLASH_MENU_BOUNDS.height,
          SLASH_MENU_BOUNDS.margin,
        );
        setSlashMenu((prev) => ({ ...prev, x: left, y: top }));
      }
    };
    view.scrollDOM.addEventListener('scroll', handleScroll);

    return () => {
      view.scrollDOM.removeEventListener('scroll', handleScroll);
      view.destroy();
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, []); // Run once on mount

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: lineNumbersCompartmentRef.current.reconfigure(
        showLineNumbers ? [lineNumbers(), highlightActiveLineGutter()] : []
      ),
    });
  }, [showLineNumbers]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: wordWrapCompartmentRef.current.reconfigure(
        wordWrap ? EditorView.lineWrapping : []
      ),
    });
  }, [wordWrap]);

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
    const applyCode = (rawCode: unknown, replaceSelection: boolean) => {
      if (rawCode == null || !viewRef.current) return;
      const view = viewRef.current;
      const selection = view.state.selection.main;
      const code = String(rawCode);
      view.dispatch({
        changes: { from: selection.from, to: replaceSelection ? selection.to : selection.from, insert: code },
        selection: replaceSelection
          ? { anchor: selection.from, head: selection.from + code.length }
          : { anchor: selection.from + code.length },
      });
      view.focus();
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      onChangeRef.current(view.state.doc.toString());
    };

    const unsubApply = onEvent('latex-apply', (d) => applyCode(d?.code, true));
    const unsubInsert = onEvent('latex-insert', (d) => applyCode(d?.code, false));
    return () => {
      unsubApply();
      unsubInsert();
    };
  }, []);

  useEffect(() => {
    const unsubErrors = onEvent('latex-errors', (detail) => {
      if (detail && detail.docId === docId && viewRef.current) {
        const view = viewRef.current;
        const doc = view.state.doc;
        const rawErrors = detail.errors || [];
        setActiveErrors(rawErrors);

        const seenDiags = new Set<string>();
        const cmDiagnostics: any[] = [];
        for (const err of rawErrors) {
          let lineNo = err.line ? err.line : 1;
          if (lineNo > doc.lines) lineNo = doc.lines;
          if (lineNo < 1) lineNo = 1;

          const line = doc.line(lineNo);
          const cleanMsg = (err.message || '').trim().replace(/\.+$/, '');
          const key = `${lineNo}:${err.severity || 'error'}:${cleanMsg.toLowerCase()}`;
          if (seenDiags.has(key)) continue;
          seenDiags.add(key);

          cmDiagnostics.push({
            from: line.from,
            to: line.to,
            severity: err.severity === 'warning' ? 'warning' : 'error',
            message: cleanMsg,
          });
        }

        diagnosticsRef.current = cmDiagnostics;
        view.dispatch(setDiagnostics(view.state, cmDiagnostics));
      }
    });

    const unsubCompiled = onEvent('latex-compiled', (detail) => {
      if (detail && detail.docId === docId && viewRef.current) {
        setActiveErrors([]);
        diagnosticsRef.current = [];
        try {
          viewRef.current.dispatch(setDiagnostics(viewRef.current.state, []));
        } catch {}
      }
    });

    return () => {
      unsubErrors();
      unsubCompiled();
    };
  }, [docId]);

  const askAiFix = useCallback((message: string, line: number) => {
    if (!message || !viewRef.current) return;
    const doc = viewRef.current.state.doc;
    const ctxStart = Math.max(1, line - 12);
    const ctxEnd = Math.min(doc.lines, line + 12);
    const startFrom = ctxStart >= 1 && ctxStart <= doc.lines ? doc.line(ctxStart).from : 0;
    const endTo = ctxEnd >= 1 && ctxEnd <= doc.lines ? doc.line(ctxEnd).to : doc.length;
    const contextText = doc.sliceString(startFrom, endTo);
    emitEvent('chat-send', {
      message: [
        '/fix Here is a Tectonic LaTeX error:',
        '',
        message,
        '',
        `The error is on line ${line} of ${doc.lines}. Source around it:`,
        '',
        '```latex',
        contextText,
        '```',
      ].join('\n'),
    });
  }, []);

  const handleJumpToError = (lineNo?: number | null) => {
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
      <SlashCommandMenu
        open={slashMenu.open}
        x={slashMenu.x}
        y={slashMenu.y}
        selectedIndex={slashMenu.selectedIndex}
        items={filteredCommands}
        onSelect={executeCommand}
        onHoverIndex={(idx) => setSlashMenu((prev) => ({ ...prev, selectedIndex: idx }))}
        onClose={() => setSlashMenu((prev) => ({ ...prev, open: false }))}
        containerRef={menuContainerRef}
      />

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
                backgroundColor: activeErrors[0].severity === 'warning' ? 'rgba(234, 179, 8, 0.12)' : 'rgba(239, 68, 68, 0.12)',
                color: activeErrors[0].severity === 'warning' ? '#ca8a04' : '#ef4444',
                border: `1px solid ${activeErrors[0].severity === 'warning' ? 'rgba(234, 179, 8, 0.28)' : 'rgba(239, 68, 68, 0.28)'}`,
                borderRadius: 'var(--radius-sm)',
                padding: '2px 7px',
                fontWeight: 600,
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
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
              <button
                type="button"
                className="latex-error-btn"
                onClick={() => handleJumpToError(activeErrors[0].line)}
              >
                Jump to line
              </button>
              <button
                type="button"
                className="latex-error-btn primary"
                onClick={() => askAiFix(activeErrors[0].message, activeErrors[0].line || 1)}
              >
                <IconSparkles size={12} />
                <span>Fix with AI</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
