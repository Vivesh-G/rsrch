import { EditorView, Decoration, WidgetType } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { EditorState, RangeSetBuilder, StateField } from '@codemirror/state';
import katex from 'katex';
import 'katex/dist/katex.min.css';

class KaTeXWidget extends WidgetType {
  math: string;
  displayMode: boolean;
  constructor(math: string, displayMode: boolean) {
    super();
    this.math = math;
    this.displayMode = displayMode;
  }
  
  eq(other: KaTeXWidget) {
    return this.math === other.math && this.displayMode === other.displayMode;
  }
  
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-katex-widget';
    el.style.cursor = 'text';
    el.style.color = 'var(--text-primary)';
    
    if (this.displayMode) {
      el.style.display = 'inline-block';
      el.style.textAlign = 'center';
      el.style.margin = '0.5em 0';
      el.style.padding = '8px';
      el.style.background = 'var(--surface-subtle)';
      el.style.borderRadius = '4px';
    } else {
      el.style.display = 'inline-block';
      el.style.padding = '0 2px';
      el.style.color = 'var(--accent)';
    }
    
    try {
      katex.render(this.math, el, {
        displayMode: this.displayMode,
        throwOnError: true
      });
    } catch (e: any) {
      el.textContent = this.math + " (Error: " + (e.message || String(e)) + ")";
      el.style.color = '#ef4444';
      el.style.fontSize = '12px';
    }
    return el;
  }
}

function buildDecorations(state: EditorState) {
  const builder = new RangeSetBuilder<Decoration>();
  const text = state.doc.toString();
  
  const displayMathRegex = /\$\$([\s\S]*?)\$\$/g;
  const inlineMathRegex = /\$([^$\n]+?)\$/g;
  
  const matches: Array<{from: number, to: number, math: string, display: boolean}> = [];
  
  let match;
  while ((match = displayMathRegex.exec(text)) !== null) {
    matches.push({ from: match.index, to: match.index + match[0].length, math: match[1], display: true });
  }
  
  while ((match = inlineMathRegex.exec(text)) !== null) {
    matches.push({ from: match.index, to: match.index + match[0].length, math: match[1], display: false });
  }
  
  matches.sort((a, b) => a.from - b.from);
  
  let lastTo = 0;
  for (const m of matches) {
    if (m.from < lastTo) continue;
    
    const selection = state.selection.main;
    // Cursor is inside if it touches the block (inclusive)
    const isCursorInside = selection.from >= m.from && selection.to <= m.to;
    
    if (isCursorInside) {
      if (m.display) {
        // Show widget below the block as a preview
        builder.add(
          m.to,
          m.to,
          Decoration.widget({
            widget: new KaTeXWidget(m.math, m.display),
            side: 1,
            block: true
          })
        );
      }
      // For inline math, don't show a preview while editing to avoid visual clutter
    } else {
      // Replace the text with the rendered math
      builder.add(
        m.from,
        m.to,
        Decoration.replace({
          widget: new KaTeXWidget(m.math, m.display)
        })
      );
    }
    lastTo = m.to;
  }
  
  return builder.finish();
}

export const katexPlugin = StateField.define<DecorationSet>({
  create(state) {
    return buildDecorations(state);
  },
  update(decorations, tr) {
    if (tr.docChanged || tr.selection) {
      return buildDecorations(tr.state);
    }
    return decorations;
  },
  provide: f => EditorView.decorations.from(f)
});
