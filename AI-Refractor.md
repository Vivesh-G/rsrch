# AI Chat (uncommited layer) — debug report

All issues below are in uncommited changes on top of `main` (`git status`: 10 modified + `AI_PLAN.md`, `backend/ai/`, `backend/chunker.py`, `backend/reindex_pdfs.py` untracked).

## 1. Implemented architecture

```
ChatPanel.tsx (SSE loop, token/meta/error)
  -> POST /api/chats/{id}/stream (backend/server.py:628)
    -> get_dspy_lm() (backend/ai/config.py:5) => dspy.LM(gemini/<model>)
    -> with dspy.context(lm):
         /latex -> SafeLatexModule (backend/ai/modules/latex_copilot.py:5)
         /fix   -> FixTectonicErrorModule (backend/ai/modules/diagnostics.py:5)
         else   -> GroundedPaperQAModule (backend/ai/modules/paper_qa.py:5)
                   -> FTS5RetrieverModule (backend/ai/retriever.py:5)
                     -> search_chunks() (backend/database.py:683)
                   -> dspy.ChainOfThought(GroundedPaperQA) (backend/ai/signatures.py:3)
                   -> dspy.streamify + StreamListener(answer)
    -> SSE: status -> token* -> meta -> done / error
PDF ingest: upload_document -> asyncio.create_task(_index_document_chunks) (backend/server.py:290) -> chunker.chunk_pdf() (backend/chunker.py:49) -> store_chunks() (backend/database.py:668) -> document_chunks + FTS5 (backend/database.py:106-148)
```

Non-stream `POST .../messages` (backend/server.py:821) was also rewritten to DSPy, same failure modes.

## 2. Why you get garbage outs

**P0-1. `event_stream` fall-through, `backend/server.py:726-739`.** The `else:` only covers 2 lines (`yield status` + `qa_module = ...`). The `streamify(...)` + `async for chunk` block is dedented to `with` level, so it runs for **all** branches. `/latex` and `/fix` therefore stream a full answer and then crash on unbound `qa_module` (`UnboundLocalError`) — user sees one blob then `error` event. Normal QA path works by accident.

**P0-2. Streaming JSON unescape hack, `backend/server.py:746-784`.** `GroundedPaperQA` has 3 outputs (`reasoning, answer, cited_pages`). `streamify` yields incremental `StreamResponse.chunk` deltas, not cumulative JSON. Code treats them as cumulative (`if t.startswith(yielded_text): delta = ...`), regex-extracts `"answer"`, then does `replace("\\n","\n").replace('\\"','"')` on **partial** fragments with only a trailing-`\` guard. This corrupts escapes, drops/duplicates text, and leaks `{"reasoning":...}` fragments. Final `full_response` (from `hasattr(chunk,"answer")`) then differs from what streamed — classic garbled tokens + JSON leakage.

**P0-3. PDF context is empty unless FTS hits, `backend/server.py:668-679` + `paper_qa.py:11-16`.** `formatted_context` only gets `latex` docs; PDFs go solely through the retriever. Failure modes, all common:
- Old PDFs predate chunking and were never indexed (only new uploads index; `reindex_pdfs.py` is manual and never deletes before insert, so reruns duplicate).
- `search_chunks` builds `word1 OR word2 OR ...` including stopwords (`What OR is OR the...`), so BM25 returns noise or `[]`.
- Empty context + signature prompt "using ONLY excerpts" => "cannot determine" / empty => `Sorry, I received an empty response...`.
No fallback to `documents.extracted_text` remains (old code had it).

**P1-4. `dspy.context` does not cross `asyncio.to_thread`, `backend/server.py:700-719`.** `/latex` and `/fix` create the module inside `to_thread(run_*)` while `with dspy.context(lm)` lives on the event-loop thread. Worker thread has no LM configured => wrong-model/auth errors. Same class of bug in `retriever.py:24-43` (new thread + new event loop + blocking `join()` inside the stream).

**P1-5. No key/model validation, `backend/ai/config.py:5-23`.** Missing key => `dspy.LM(model="gemini/<model>", api_key="")`; `model=None` => `"gemini/None"`. LiteLLM raises cryptic errors, surfaced raw as SSE `error` => frontend throws => red error bubble. Stream endpoint (unlike the old JSON one) has no "API key required" friendly path.

**P1-6. Frontend has no fallback, `src/services/api.ts:189`, `ChatPanel.tsx:344-438`.** Plan required SSE-fail => JSON fallback + 120s abort. Impl has neither; token assembly also mutates state in place (`last.content +=`). Any P0 above becomes a stuck or error bubble.

**P2 minors:** `store_chunks` never clears old chunks (duplicates); `init_db` `FTS5 rebuild` on every boot (backend/database.py:159); section regex misses `3.1 Methods` (backend/chunker.py:9); single >1500-char paragraphs never split; `dspy.settings._ensure_configure_allowed` monkey-patch (backend/server.py:623) hides config errors; plan says `google/genai/` prefix, code (correctly for LiteLLM) uses `gemini/` — plan is stale.

## 3. Fix plan (minimal, in order)

1. **Fix control flow** (`server.py:726-739`): indent `streamify`/stream loop inside `else:`, `return` after `/latex` and `/fix` branches emit `meta`+`done`.
2. **Drop JSON-hack streaming:** either (a) simplest — non-stream DSPy call, then `yield token` in ~40-char slices; or (b) keep `streamify` but yield raw `chunk.chunk` deltas verbatim, no regex/unescape, and take `full_response/cited_pages` only from final `Prediction`. Remove `yielded_text` prefix logic.
3. **Restore context guarantee:** if `search_chunks` returns <1 hit (or `pdf_doc_ids` empty with attached PDFs), fall back to `doc.extracted_text[:per_doc]` formatted as `[p. ? | label]`. Strip stopwords or use `AND` + fallback `OR`; cap `k=8`.
4. **Fix threading:** run DSPy modules on the loop thread (no `to_thread` inside `dspy.context`), or configure LM inside the worker. Make retriever async-native instead of thread+new-loop.
5. **Validate before streaming:** if no key or model resolves to `None`, yield friendly "API key required" message, don't call DSPy. Fix `f"gemini/{model}"` None-guard.
6. **Dedup + reindex once:** `DELETE FROM document_chunks WHERE document_id` before insert in `store_chunks`/reindex; run `reindex_pdfs.py` once for old PDFs; remove per-boot FTS `rebuild` or gate it.
7. **Frontend:** add `AbortController` timeout + JSON-endpoint fallback on SSE error; stop mutating `messages` in place; handle `done.message_id`.

Do 1+2+3 first — that alone should turn garbage into coherent (if uncited) answers; 4+5 remove the error bubbles; 6 restores citations on old PDFs.

## 4. Decision: remove streaming completely (no-SSE architecture)

Streaming is deleted, not fixed. Rationale: `dspy.streamify` + manual JSON
delta-reassembly (P0-2) is the dominant garbage source, the SSE client has no
timeout/fallback (P1-6), and `dspy.context` across threads (P1-4) only exists
to serve the stream. A single JSON round-trip via `POST .../messages` gives
correct, citable answers first; streaming can be reconsidered later as dumb
slicing of a finished string, never as incremental JSON parsing.

Target architecture:

```
ChatPanel.tsx (sendChatMessage, Thinking... only)
  -> POST /api/chats/{id}/messages (backend/server.py:821, DSPy sync)
    -> get_dspy_lm() => dspy.LM(gemini/<model>)
    -> branch on message prefix:
         /latex -> SafeLatexModule -> {answer_md, code_patch, action_type}
         /fix   -> FixTectonicErrorModule -> {answer_md, code_patch, action_type}
         else   -> retrieve chunks -> GroundedPaperQAModule -> {answer, cited_pages}
    -> persist assistant message -> return {message}
```

### Removal checklist (done — implemented, verified `tsc --noEmit` + `py_compile` clean)

Backend (`backend/server.py`):
- [x] Deleted `POST /api/chats/{id}/stream`, `event_stream()`, `_sse()`.
- [x] Deleted `StreamingResponse` import, stream-only `import json` / duplicate
  `import dspy`, `dspy.settings._ensure_configure_allowed` monkey-patch,
  `StreamListener` / `dspy.streamify` / `yielded_text` / regex unescape blocks.
- [x] Deleted `error.txt` debug dump in the stream error path.
- [x] Kept one DSPy path: sync `_generate()` inside `send_chat_message`,
  with explicit `/latex` / `/fix` / QA branches (no fall-through variable),
  server-side FTS retrieval + `extracted_text` fallback, `_extract_page_citations`
  backup, `api_key_override` plumbed through `get_dspy_lm`, model None-guard.
- [x] `search_chunks`: stopword strip, AND-first with OR fallback.
- [x] `store_chunks`: delete-before-insert (no dupes); removed per-boot FTS rebuild.
- [x] `chunker.py`: section regex covers `3.1 Methods`; oversized paragraphs split.
- [x] `reindex_pdfs.py`: delete-before-store for one-shot backfill of old PDFs.

Frontend:
- [x] Deleted `api.streamChatMessage` (`src/services/api.ts` — back to HEAD state).
- [x] `ChatPanel.handleSend` reverted to `api.sendChatMessage`; deleted
  `streamStatus` state, `status/token/meta/error` switch.
- [x] Kept: textarea input, quick-action chips, `transformCitations`,
  `cited_pages` rendering, latex Insert/Copy/Replace toolbar, `rsrch:chat-send`
  listener (now drives the sync path; `latex_patch` auto-applies via response).
- [x] `ChatMessage` extended with `code_patch`/`action_type` (frontend types +
  backend pydantic model; attached to the JSON response, not a DB column).

Docs:
- [ ] Mark `AI_PLAN.md` Phase 1 (SSE) as dropped; streaming events
  (`status/token/meta/done`) no longer part of the contract.

## 5. Fix plan for remaining (non-stream) issues — implemented

> Status: all items implemented and verified (`py_compile` clean,
> `tsc --noEmit` clean, chunker/citation/FTS unit checks pass — see §6).
> Remaining manual step: run `python backend/reindex_pdfs.py` once to backfill
> chunks for PDFs uploaded before chunking existed, then exercise one PDF chat,
> one `.tex` `/latex` chat, and the no-key case.

1. **Branching + sync DSPy dispatch** (`server.py:899-913`): explicit
   `if /latex / elif /fix / else` returning `{answer_md, code_patch,
   action_type, cited_pages}`; no shared fall-through variable.
2. **Context guarantee** (P0-3): LaTeX docs -> `formatted_context` as today;
   PDFs -> `search_chunks(k=8)` first, fallback to
   `doc.extracted_text[:per_doc]` when 0 hits. Fix query: strip stopwords /
   punctuation, cap length, `AND` then fallback `OR`.
3. **Threading** (P1-4): call DSPy modules directly on the request thread
   inside `with dspy.context(lm)` (still via `asyncio.to_thread` for the whole
   `_generate`, not nested threads). Rewrite `FTS5RetrieverModule` to accept
   pre-retrieved passages or run `search_chunks` before entering DSPy —
   no `threading.Thread` + new event loop inside `forward`.
4. **Auth guard** (P1-5): in `send_chat_message` and `get_dspy_lm`, return the
   friendly "Gemini API Key Required" message when key missing; None-guard
   `model` before `f"gemini/{model}"`.
5. **Citations end-to-end**: parse `[p. X]` from final `answer` as backup when
   `cited_pages` is empty/malformed; persist `cited_pages` on the assistant
   message; verify `rsrch:scroll-to-page` wiring.
6. **Index health** (P2): `store_chunks` deletes existing chunks for the doc
   first; gate per-boot FTS `rebuild`; fix section regex (`3.1 Methods`);
   split >1500-char paragraphs; run `reindex_pdfs.py` once for pre-chunk PDFs.
7. **Verify**: one PDF + one `.tex` chat, plus no-key case; assert non-empty
   grounded answer, clickable `[p. X]`, balanced LaTeX patch, no `error.txt`.

## 6. Implementation notes (what actually changed vs. the plan)

- `src/services/api.ts` stream deletion restored the file to HEAD state
  (the SSE client was purely additive) — it no longer appears in `git diff`.
- `GroundedPaperQAModule` is now always constructed with `document_ids=[]`;
  retrieval happens in `send_chat_message` via async `search_chunks`, so the
  thread + fresh-event-loop bridge in `FTS5RetrieverModule` is unreachable
  from the chat path (left in place with a warning comment for other callers).
- `cited_pages` / `code_patch` / `action_type` ride on the JSON response only
  (`backend/models.py` + `src/types/index.ts`); `chat_messages` has no such
  columns, so history reloads won't show badges for old assistant messages —
  acceptable, matches pre-stream behavior.
- Dead `temp` parse removed from `send_chat_message` (temperature is read
  inside `get_dspy_lm`); `get_dspy_lm` now also accepts the per-request
  `api_key` override, which the old code ignored.
- Verified by execution: section-title heuristics (`3.1 Methods`, caps,
  `Abstract`), oversized-paragraph splitting (8 chunks, all ≤ ~1500 chars),
  citation regex backup, and FTS5 AND-first/OR-fallback MATCH validity.

## 7. Context picker: attach without opening (implemented)

Previously the only way to add context was opening the doc (`attachCurrent`
uses `activeDocId`). Now:

- Frontend: `+ Add Context` button in the context row opens a popover listing
  PDF/TeX docs in the active workspace (filter input, multi-add, closes on
  outside click). Top row: `≡ Add workspace: <name>` attaches the whole
  workspace as one removable `≡ <name>` chip. Data via stable ref-based
  `listContextDocs()` prop (same pattern as `resolveDocTitle`, no memo churn).
- API: `sendChatMessage(chatId, text, documentIds, workspaceIds)` sends
  `workspace_ids` alongside `document_ids`.
- Backend: `ChatSendRequest.workspace_ids` (max 2); server resolves via new
  `get_workspace_documents()` and fills remaining budget up to
  `WORKSPACE_CONTEXT_DOCS = 6` total (explicit ids first, deduped), flowing
  through the existing FTS + `extracted_text` fallback pipeline.
- Verified: `py_compile` + `tsc --noEmit` clean; request-model caps and merge
  order covered by execution test.

## 8. Citations only with PDF context (implemented)

`/latex` output was embedding `[p. 3, p. 14]` markers. Rule now enforced in
`send_chat_message` via `has_pdf_context` (any non-LaTeX doc in context):

| Path | No PDF context | PDF context |
|---|---|---|
| `/latex` code | markers stripped (always stripped — they don't compile) | stripped, `cited_pages: []` |
| `/fix` code | stripped | stripped |
| `/fix` explanation, QA answer | markers stripped, `cited_pages: []` | kept as model produced |
| `SafeLatexGenerator` signature | — | docstring now forbids `[p. X]` in code |

Strip helper `_strip_page_citations` covers `[p. N]`, `[p. N, p. M]`,
`[pp. N-M]`; leaves `[3]`, `$x_{3}$` untouched. Caught and fixed a regex bug
(`pps?` never matched `p.`) via execution test on the reported example.
