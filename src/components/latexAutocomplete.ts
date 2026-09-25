import { CompletionContext, snippetCompletion as snip } from "@codemirror/autocomplete";

export interface LatexSlashCommand {
  id: string;
  label: string;
  description: string;
  badge: string;
  category: string;
  keywords: string[];
  template: string;
}

export const LATEX_SLASH_COMMANDS: LatexSlashCommand[] = [
  // Structure
  {
    id: 'sec',
    label: 'Section Header',
    description: 'Major section heading',
    badge: 'H1',
    category: 'Structure',
    keywords: ['sec', 'section', 'heading', 'title', 'h1', 'header'],
    template: '\\section{${1:Title}}',
  },
  {
    id: 'sub',
    label: 'Subsection Header',
    description: 'Subsection subdivision heading',
    badge: 'H2',
    category: 'Structure',
    keywords: ['sub', 'subsection', 'subheading', 'title', 'h2', 'header'],
    template: '\\subsection{${1:Title}}',
  },
  {
    id: 'subsub',
    label: 'Subsubsection Header',
    description: 'Small subsection subdivision heading',
    badge: 'H3',
    category: 'Structure',
    keywords: ['subsub', 'subsubsection', 'subheading', 'title', 'h3'],
    template: '\\subsubsection{${1:Title}}',
  },

  // Environments
  {
    id: 'table',
    label: 'Table Environment',
    description: 'Tabular grid with caption and label',
    badge: 'TAB',
    category: 'Environments',
    keywords: ['table', 'tabular', 'grid', 'columns', 'rows'],
    template: '\\begin{table}[htbp]\n\t\\centering\n\t\\begin{tabular}{c c}\n\t\t${1:Col1} & ${2:Col2} \\\\\n\t\t\\hline\n\t\t${3:Val1} & ${4:Val2} \\\\\n\t\\end{tabular}\n\t\\caption{${5:Caption}}\n\t\\label{tab:${6:label}}\n\\end{table}',
  },
  {
    id: 'fig',
    label: 'Figure Environment',
    description: 'Centered figure with caption & label',
    badge: 'FIG',
    category: 'Environments',
    keywords: ['fig', 'figure', 'image', 'picture', 'graphic', 'include'],
    template: '\\begin{figure}[htbp]\n\t\\centering\n\t\\includegraphics[width=0.8\\textwidth]{${1:image.png}}\n\t\\caption{${2:Caption}}\n\t\\label{fig:${3:label}}\n\\end{figure}',
  },
  {
    id: 'env',
    label: 'Environment Block',
    description: 'Generic \\begin{} ... \\end{} environment',
    badge: '{ }',
    category: 'Environments',
    keywords: ['env', 'environment', 'begin', 'end', 'block'],
    template: '\\begin{${1:equation}}\n\t${2}\n\\end{${1}}',
  },
  {
    id: 'code',
    label: 'Verbatim Code',
    description: 'Monospace preformatted code block',
    badge: '<>',
    category: 'Environments',
    keywords: ['code', 'verbatim', 'listing', 'snippet', 'syntax'],
    template: '\\begin{verbatim}\n${1}\n\\end{verbatim}',
  },
  {
    id: 'quote',
    label: 'Quote Block',
    description: 'Block quotation environment',
    badge: '"',
    category: 'Environments',
    keywords: ['quote', 'quotation', 'citation', 'cite', 'blockquote'],
    template: '\\begin{quote}\n${1}\n\\end{quote}',
  },

  // Math & Equations
  {
    id: 'math',
    label: 'Display Math',
    description: 'Centered equation display block',
    badge: '$$',
    category: 'Math',
    keywords: ['math', 'display', 'equation', 'formula', 'centered'],
    template: '$$\n\t${1}\n$$',
  },
  {
    id: 'inline',
    label: 'Inline Math',
    description: 'Inline mathematical expression',
    badge: '$',
    category: 'Math',
    keywords: ['inline', 'math', 'formula'],
    template: '$${1}$',
  },
  {
    id: 'frac',
    label: 'Fraction',
    description: 'Numerator over denominator fraction',
    badge: '½',
    category: 'Math',
    keywords: ['frac', 'fraction', 'division', 'math'],
    template: '\\frac{${1:num}}{${2:den}}',
  },
  {
    id: 'align',
    label: 'Aligned Math',
    description: 'Multi-line aligned mathematical equations',
    badge: '==',
    category: 'Math',
    keywords: ['align', 'aligned', 'equation', 'math', 'multiline'],
    template: '\\begin{align}\n\t${1:x} &= ${2:y + z} \\\\\n\t${3:a} &= ${4:b + c}\n\\end{align}',
  },
  {
    id: 'sum',
    label: 'Summation',
    description: 'Sum operator with index bounds',
    badge: '∑',
    category: 'Math',
    keywords: ['sum', 'summation', 'sigma', 'series', 'math'],
    template: '\\sum_{${1:i=1}}^{${2:N}} ${3:x_i}',
  },
  {
    id: 'int',
    label: 'Integral',
    description: 'Definite or indefinite calculus integral',
    badge: '∫',
    category: 'Math',
    keywords: ['int', 'integral', 'calculus', 'math'],
    template: '\\int_{${1:a}}^{${2:b}} ${3:f(x)} \\,d${4:x}',
  },
  {
    id: 'lim',
    label: 'Limit',
    description: 'Mathematical limit approaching value',
    badge: 'lim',
    category: 'Math',
    keywords: ['lim', 'limit', 'infinity', 'calculus', 'math'],
    template: '\\lim_{${1:x} \\to ${2:\\infty}} ${3:f(x)}',
  },
  {
    id: 'matrix',
    label: 'Matrix (bmatrix)',
    description: 'Bracketed 2x2 matrix environment',
    badge: '[M]',
    category: 'Math',
    keywords: ['matrix', 'bmatrix', 'brackets', 'array', 'math'],
    template: '\\begin{bmatrix}\n\t${1:1} & ${2:0} \\\\\n\t${3:0} & ${4:1}\n\\end{bmatrix}',
  },
  {
    id: 'cases',
    label: 'Cases Block',
    description: 'Piecewise equation case definitions',
    badge: '{=',
    category: 'Math',
    keywords: ['cases', 'piecewise', 'condition', 'math'],
    template: '\\begin{cases}\n\t${1:x} & \\text{if } ${2:condition} \\\\\n\t${3:y} & \\text{otherwise}\n\\end{cases}',
  },

  // Lists
  {
    id: 'item',
    label: 'Bulleted List',
    description: 'Itemize environment with bullet points',
    badge: '•',
    category: 'Lists',
    keywords: ['item', 'itemize', 'bullet', 'list', 'points'],
    template: '\\begin{itemize}\n\t\\item ${1}\n\\end{itemize}',
  },
  {
    id: 'enum',
    label: 'Numbered List',
    description: 'Enumerate environment with sequential items',
    badge: '1.',
    category: 'Lists',
    keywords: ['enum', 'enumerate', 'number', 'numbered', 'ordered', 'list'],
    template: '\\begin{enumerate}\n\t\\item ${1}\n\\end{enumerate}',
  },

  // Formatting & References
  {
    id: 'bold',
    label: 'Bold Text',
    description: 'Strong bold font formatting',
    badge: 'B',
    category: 'Formatting',
    keywords: ['bold', 'textbf', 'strong', 'weight'],
    template: '\\textbf{${1:text}}',
  },
  {
    id: 'ital',
    label: 'Italic Text',
    description: 'Emphasized italic font formatting',
    badge: 'I',
    category: 'Formatting',
    keywords: ['ital', 'italic', 'textit', 'emphasis'],
    template: '\\textit{${1:text}}',
  },
  {
    id: 'cite',
    label: 'Citation',
    description: 'Bibliographic reference citation',
    badge: '[@]',
    category: 'Formatting',
    keywords: ['cite', 'citation', 'bib', 'reference', 'bibliography'],
    template: '\\cite{${1:reference}}',
  },
  {
    id: 'ref',
    label: 'Cross-Reference',
    description: 'Reference figure, table, or section label',
    badge: 'REF',
    category: 'Formatting',
    keywords: ['ref', 'reference', 'cross-reference', 'label'],
    template: '\\ref{${1:label}}',
  },
];

// Backward-compatible fallback for autocompletion
export function slashCommandSource(context: CompletionContext) {
  const word = context.matchBefore(/\/\w*/);
  if (!word) return null;
  if (word.from === word.to && !context.explicit) return null;
  return {
    from: word.from,
    options: LATEX_SLASH_COMMANDS.map((c) =>
      snip(c.template, {
        label: `/${c.id}`,
        type: 'keyword',
        detail: c.label,
        info: c.description,
      })
    ),
    validFor: /^\/\w*$/,
  };
}
