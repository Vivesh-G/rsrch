import { CompletionContext, snippetCompletion as snip } from "@codemirror/autocomplete";

const completions = [
  snip("$$ \n\t${1}\n$$", { label: "/math", type: "keyword", detail: "Display Math Block", info: "Inserts a centered math block." }),
  snip("$${1}$", { label: "/inline", type: "keyword", detail: "Inline Math", info: "Inserts an inline math block." }),
  snip("\\frac{${1:num}}{${2:den}}", { label: "/frac", type: "function", detail: "Fraction" }),
  snip("\\begin{${1:equation}}\n\t${2}\n\\end{${1}}", { label: "/env", type: "keyword", detail: "Environment Block" }),
  snip("\\begin{figure}[htbp]\n\t\\centering\n\t\\includegraphics[width=0.8\\textwidth]{${1:image.png}}\n\t\\caption{${2:Caption}}\n\t\\label{fig:${3:label}}\n\\end{figure}", { label: "/fig", type: "keyword", detail: "Figure Environment" }),
  snip("\\begin{table}[htbp]\n\t\\centering\n\t\\begin{tabular}{c c}\n\t\t${1:Col1} & ${2:Col2} \\\\\n\t\t\\hline\n\t\t${3:Val1} & ${4:Val2} \\\\\n\t\\end{tabular}\n\t\\caption{${5:Caption}}\n\t\\label{tab:${6:label}}\n\\end{table}", { label: "/table", type: "keyword", detail: "Table Environment" }),
  snip("\\begin{itemize}\n\t\\item ${1}\n\\end{itemize}", { label: "/item", type: "keyword", detail: "Bulleted List" }),
  snip("\\begin{enumerate}\n\t\\item ${1}\n\\end{enumerate}", { label: "/enum", type: "keyword", detail: "Numbered List" }),
  snip("\\section{${1:Title}}", { label: "/sec", type: "keyword", detail: "Section Header" }),
  snip("\\subsection{${1:Title}}", { label: "/sub", type: "keyword", detail: "Subsection Header" }),
  snip("\\textbf{${1:text}}", { label: "/bold", type: "keyword", detail: "Bold Text" }),
  snip("\\textit{${1:text}}", { label: "/ital", type: "keyword", detail: "Italic Text" }),
  snip("\\cite{${1:reference}}", { label: "/cite", type: "keyword", detail: "Citation" }),
  snip("\\ref{${1:label}}", { label: "/ref", type: "keyword", detail: "Cross-Reference" }),
  snip("\\begin{bmatrix}\n\t${1:1} & ${2:0} \\\\\n\t${3:0} & ${4:1}\n\\end{bmatrix}", { label: "/matrix", type: "keyword", detail: "Matrix (bmatrix)" }),
  snip("\\begin{align}\n\t${1:x} &= ${2:y + z} \\\\\n\t${3:a} &= ${4:b + c}\n\\end{align}", { label: "/align", type: "keyword", detail: "Aligned Math Equations" }),
  snip("\\begin{cases}\n\t${1:x} & \\text{if } ${2:condition} \\\\\n\t${3:y} & \\text{otherwise}\n\\end{cases}", { label: "/cases", type: "keyword", detail: "Cases Block" }),
  snip("\\sum_{${1:i=1}}^{${2:N}} ${3:x_i}", { label: "/sum", type: "keyword", detail: "Summation" }),
  snip("\\int_{${1:a}}^{${2:b}} ${3:f(x)} \\,d${4:x}", { label: "/int", type: "keyword", detail: "Integral" }),
  snip("\\lim_{${1:x} \\to ${2:\\infty}} ${3:f(x)}", { label: "/lim", type: "keyword", detail: "Limit" }),
];

export function slashCommandSource(context: CompletionContext) {
  let word = context.matchBefore(/\/\w*/);
  if (!word) return null;
  if (word.from == word.to && !context.explicit) return null;
  return {
    from: word.from,
    options: completions,
    validFor: /^\/\w*$/
  };
}
