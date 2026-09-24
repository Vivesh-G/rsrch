# Rsrch — Academic LaTeX & PDF Workspace Roadmap (TO-DO)

> **Vision:** Unify the modern researcher's fragmented workflow (PDF Reading + AI Literature Review + Conference-Grade LaTeX Authoring) into a single, high-performance, local-first environment.

---

## 1. The Core Synergy: Why PDF Workspaces × LaTeX Authoring is a 10× Advantage

Currently, research work is split across disconnected silos:
1. **Reading & Organization:** Zotero, Mendeley, or Preview.
2. **Writing & Typesetting:** Overleaf or local VS Code / TeXstudio.
3. **AI Assistance:** Chatting with web LLMs where papers must be re-uploaded and lack direct manuscript integration.

By deeply intertwining **PDF Document Workspaces** with a **Real-Time Reactive LaTeX Typesetter**, `rsrch` creates an interconnected scholar flywheel:

```
┌────────────────────────────────────────────────────────────────────────┐
│                          RSRCH UNIFIED WORKSPACE                       │
│                                                                        │
│   [ Reference Papers (PDFs) ] ───(One-Click Cite)───► [ Workspace .bib ]│
│                │                                              ▲        │
│          (Multi-Doc RAG)                                      │        │
│                ▼                                              │        │
│   [ Grounded AI Co-Author ] ───(Drafts & Tables)───► [ LaTeX Manuscript]
│                                                               ▲        │
│                                                     (SyncTeX) │        │
│                                                               ▼        │
│                                                      [ Compiled Output ]│
└────────────────────────────────────────────────────────────────────────┘
```

### Key Synergistic Workflows

1. **One-Click "Cite in LaTeX" (Literature $\rightarrow$ Manuscript):**
   * Highlighting a key result, equation, or theorem in a reference PDF automatically fetches its BibTeX entry (via CrossRef / arXiv API / DOI metadata), appends it to the workspace's `references.bib`, and inserts `\cite{key}` directly into your open LaTeX draft at the cursor.
   * Quotations from PDFs automatically insert with precise `[p. X]` citations formatted to conference standards.

2. **Workspace-Wide Automatic Bibliography:**
   * Every PDF added to a workspace immediately contributes its citation metadata to a shared workspace bibliography.
   * When typing `\cite{` in the LaTeX editor, you can search by author name, title fragment, or conference year across all papers in the active workspace without ever searching Google Scholar for BibTeX snippets.

3. **Grounded AI Literature Synthesis & Related Works:**
   * The Gemini chat assistant has direct context access to both your manuscript source and the extracted full texts of the workspace's reference PDFs.
   * Prompts like: *"Write a Related Works subsection contrasting our approach against [Attached Paper A] and [Attached Paper B], using our workspace's BibTeX citation keys."* produce publication-ready LaTeX markup.

4. **Automated Comparative Benchmark Table Generator:**
   * Automatically parses empirical evaluation sections across multiple workspace PDFs and generates publication-grade LaTeX tables (`\begin{table}` with `booktabs` formatting: `\toprule`, `\midrule`, `\bottomrule`) comparing baselines, datasets, and benchmark metrics against your own.

5. **Split-Screen Multi-Pane Composition:**
   * Configurable layout: Reference PDF on the left, CodeMirror LaTeX source in the middle, and live-rendered compiled submission preview on the right.

---

## 2. Engineering Roadmap & Implementation Milestones

### Phase 1: Multi-File Project Hierarchy & Asset Pipeline *(Foundation)*
- [ ] **Multi-File LaTeX Projects:**
  - [ ] Support subfiles via `\input{sections/...}` and `\include{...}`.
  - [ ] File tree management in sidebar for LaTeX projects (folders for `sections/`, `figures/`, `tables/`).
- [ ] **Asset & Figure Management:**
  - [ ] Project-level `figures/` directory to store images (`.png`, `.jpg`, `.pdf`, `.svg`).
  - [ ] Auto-resolve relative paths in `\includegraphics[...]{figures/...}` inside `compiler.py`.
  - [ ] Drag-and-drop image upload directly into the editor pane with auto-insertion of `\begin{figure}` templates.
- [ ] **Custom Conference Style/Class Ingestion:**
  - [ ] Allow uploading and compiling alongside custom `.sty`, `.cls`, and `.bst` files (e.g. `neurips_2026.sty`, `acmart.cls`, `IEEEtran.cls`).

---

### Phase 2: Academic Citation & Bibliography System *(Ergonomics)*
- [ ] **Workspace `references.bib` File:**
  - [ ] Dedicated BibTeX editor / viewer tab within the workspace.
  - [ ] Tectonic pipeline configured to run BibTeX / Biber automatically and generate `.bbl` files.
- [ ] **Smart `\cite{...}` Autocomplete in CodeMirror:**
  - [ ] Parse `.bib` keys, titles, authors, and years in the background.
  - [ ] Autocomplete dropdown in CodeMirror showing full bibliographic details when typing `\cite{...}` or `\citep{...}`.
- [ ] **PDF-to-BibTeX Auto-Harvester:**
  - [ ] Extract DOI / arXiv ID from uploaded PDFs and automatically query Semantic Scholar / CrossRef / arXiv APIs to generate clean, standardized BibTeX entries.

---

### Phase 3: Interactive SyncTeX Engine *(Spatial Navigation)*
- [ ] **SyncTeX Artifact Preservation:**
  - [ ] Keep `.synctex.gz` during Tectonic compilation for active documents.
  - [ ] Expose an endpoint `/api/documents/{doc_id}/synctex` to query coordinates or parse the synctex map.
- [ ] **Forward Sync (Editor $\rightarrow$ PDF Viewer):**
  - [ ] `Ctrl + Click` or `Cmd + Click` on any line in `CodeMirrorLatexEditor` scrolls EmbedPDF to the exact page and paragraph bounding box.
- [ ] **Inverse Sync (PDF Viewer $\rightarrow$ Editor):**
  - [ ] Double-clicking any text block or formula in EmbedPDF jumps the CodeMirror editor cursor directly to the corresponding source line and column.

---

### Phase 4: Conference Boilerplates & Submission Packaging *(Publication-Ready)*
- [ ] **Conference Template Picker:**
  - [ ] 1-Click project initialization with official starter bundles:
    - NeurIPS / ICLR / ICML (Top ML conferences)
    - CVPR / ICCV (Computer Vision)
    - ACL / EMNLP (NLP)
    - IEEE Two-Column (`IEEEtran`)
    - ACM Master Article Template (`acmart`)
    - Standard arXiv Preprint Format
- [ ] **1-Click "Export for arXiv" (`.tar.gz` Packager):**
  - [ ] Bundle all `.tex` files, `.sty`/`.cls` packages, and referenced figure assets.
  - [ ] Include pre-compiled `.bbl` bibliography (required by arXiv).
  - [ ] Strip local auxiliary artifacts (`.aux`, `.log`, `.synctex.gz`, `.out`).
- [ ] **Pre-Flight Camera-Ready Validator:**
  - [ ] Linter pass scanning for undefined citations (`?`), missing references (`??`), and unincluded figures.
  - [ ] Page count limit checker (e.g. *8 pages excluding references* with visual threshold warnings).

---

### Phase 5: Rebuttal & Revision Review Tools *(Peer Review)*
- [ ] **Visual `latexdiff` Integration:**
  - [ ] Compare current draft against a previous milestone or git commit.
  - [ ] Compile a marked-up diff PDF with colored annotations (red strikethrough for deleted text, blue for new text) for rebuttal packages.
- [ ] **Track Changes & Commenting:**
  - [ ] LaTeX `\todo{...}` or `% [Comment]` visual badges rendered in the editor margin.

---

## 3. Immediate Action Items

1. **Phase 1 Step A:** Upgrade `compiler.py` and `database.py` from storing an isolated string to managing a project directory under `backend/data/projects/<doc_id>/` (containing `main.tex`, `figures/`, `references.bib`).
2. **Phase 2 Step A:** Implement `\cite{` autocomplete provider in `latexAutocomplete.ts` reading from the workspace's `.bib` collection.
3. **Phase 3 Step A:** Enable `--synctex` in Tectonic subprocess and wire click listeners between CodeMirror and EmbedPDF.
