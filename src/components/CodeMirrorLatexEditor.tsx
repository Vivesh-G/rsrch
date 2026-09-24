import React, { useEffect, useRef, useState } from 'react';
import { EditorState, StateField } from '@codemirror/state';
import { EditorView, lineNumbers, keymap, showTooltip } from '@codemirror/view';
import type { Tooltip } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { StreamLanguage } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { autocompletion, nextSnippetField, prevSnippetField, clearSnippet } from '@codemirror/autocomplete';
import { lintGutter, setDiagnostics, linter } from '@codemirror/lint';
import { katexPlugin } from './katexDecoration';
import { slashCommandSource } from './latexAutocomplete';

const selectionTooltip = StateField.define<Tooltip | null>({
  create: getCursorTooltip,
  update(tooltip, tr) {
    if (!tr.docChanged && !tr.selection) return tooltip;
    return getCursorTooltip(tr.state);
  },
  provide: f => showTooltip.from(f)
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
    create: () => {
      const dom = document.createElement("div");
      dom.className = "pdf-selection-popup";
      dom.style.position = "relative";
      dom.style.transform = "none";
      
      const btn = document.createElement("button");
      btn.textContent = "Ask AI";
      btn.className = "pdf-popup-btn primary";
      btn.type = "button";
      btn.onclick = () => {
         window.dispatchEvent(new CustomEvent('rsrch:chat-append', { 
            detail: { text: "Regarding this LaTeX block:\n```latex\n" + selectedText + "\n```\n" } 
         }));
      };
      
      dom.appendChild(btn);
      return { dom };
    }
  }
}

interface CodeMirrorLatexEditorProps {
  docId: string;
  content: string;
  onChange: (content: string) => void;
  onManualSave?: (content: string) => void;
  onWordCountChange?: (count: number) => void;
}

export const CodeMirrorLatexEditor: React.FC<CodeMirrorLatexEditorProps> = ({
  docId,
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
  const contentRef = useRef(content);
  contentRef.current = content;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onWordCountRef = useRef(onWordCountChange);
  onWordCountRef.current = onWordCountChange;

  const [activeErrors, setActiveErrors] = useState<{ line: number | null; message: string; severity: string }[]>([]);
  const diagnosticsRef = useRef<any[]>([]);

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
    });

    const keymapConfig = keymap.of([
      ...defaultKeymap,
      ...historyKeymap,
      { key: "Tab", run: nextSnippetField, shift: prevSnippetField },
      { key: "Escape", run: clearSnippet },
      {
        key: 'Mod-s',
        run: (view) => {
          const docStr = view.state.doc.toString();
          if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
          onChangeRef.current(docStr);
          onManualSave?.(docStr);
          return true;
        }
      }
    ]);

    const state = EditorState.create({
      doc: content,
      extensions: [
        lineNumbers(),
        history(),
        keymapConfig,
        StreamLanguage.define(stex),
        autocompletion({ override: [slashCommandSource] }),
        linter(() => diagnosticsRef.current),
        lintGutter(),
        katexPlugin,
        selectionTooltip,
        onUpdate,
        EditorView.theme({
          "&": { height: "100%", fontSize: "14px", backgroundColor: "transparent", color: "var(--text-primary)" },
          ".cm-scroller": { overflow: "auto", fontFamily: "var(--font-mono, monospace)", lineHeight: "1.6" },
          ".cm-content": { padding: "16px 16px 16px 12px", minHeight: "100%" },
          "&.cm-focused": { outline: "none" },
          ".cm-gutters": {
            backgroundColor: "var(--surface)",
            borderRight: "1px solid var(--border)",
            color: "var(--text-tertiary)",
            position: "sticky",
            left: 0,
            zIndex: 10,
            boxShadow: "2px 0 4px -2px rgba(0, 0, 0, 0.05)"
          },
          ".cm-gutter": {
            backgroundColor: "var(--surface)"
          },
          ".cm-lineNumbers": {
            backgroundColor: "var(--surface)"
          },
          ".cm-gutterElement": {
            padding: "0 8px 0 10px",
            minWidth: "36px",
            textAlign: "right",
            backgroundColor: "var(--surface)"
          },
          ".cm-activeLineGutter": {
            backgroundColor: "var(--surface-subtle) !important",
            color: "var(--text-primary)",
            fontWeight: "600"
          },
          ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text-primary)" },
          "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "var(--accent-alpha)" },
          ".cm-tooltip": { backgroundColor: "var(--surface)", border: "1px solid var(--border)", borderRadius: "6px", overflow: "hidden", boxShadow: "var(--shadow-md)", color: "var(--text-primary)", zIndex: 20 },
          ".cm-tooltip.cm-tooltip-autocomplete > ul > li": { padding: "6px 12px", fontFamily: "var(--font-sans)", fontSize: "13px" },
          ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--surface-subtle)", color: "var(--accent)" },
          ".cm-completionIcon": { display: "none" },
          ".cm-completionLabel": { color: "var(--text-primary)", fontWeight: "bold" },
          ".cm-completionDetail": { color: "var(--text-tertiary)", fontStyle: "italic", fontSize: "11px", marginLeft: "12px" },
          ".cm-tooltip.cm-tooltip-lint": { padding: "4px", backgroundColor: "var(--surface)", border: "1px solid var(--border)", borderRadius: "8px", boxShadow: "var(--shadow-md)", zIndex: 20 },
          ".cm-diagnostic": { padding: "6px 12px", fontFamily: "var(--font-sans)", fontSize: "12.5px", color: "var(--text-primary)", borderLeft: "3px solid var(--danger)", borderRadius: "4px", backgroundColor: "var(--surface-subtle)", margin: "2px", fontWeight: "500" },
          ".cm-diagnostic-error": { borderLeftColor: "var(--danger)" },
          ".cm-diagnostic-warning": { borderLeftColor: "var(--warning)" },
        })
      ]
    });

    const view = new EditorView({
      state,
      parent: editorRef.current
    });
    viewRef.current = view;

    return () => {
      view.destroy();
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
          changes: { from: 0, to: currentDoc.length, insert: content }
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
          changes: { from: 0, to: currentDoc.length, insert: content }
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
          selection: { anchor: selection.from, head: selection.from + code.length }
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
            message: err.message
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
      scrollIntoView: true
    });
    view.focus();
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', backgroundColor: 'transparent', overflow: 'hidden', position: 'relative' }}>
      <div ref={editorRef} style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }} />
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
            flexShrink: 0
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
                flexShrink: 0
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
                whiteSpace: 'nowrap'
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
                fontWeight: 500
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
