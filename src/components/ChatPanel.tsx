import React, { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import type { ChatMessage, ChatSession, DocumentItem } from '../types';
import { api, ApiError } from '../services/api';
import { IconPlus, IconClose, IconTrash, IconDoc } from './Icons';

/** Mirrors MAX_ATTACHED_DOCS in backend/server.py. */
const MAX_ATTACHED_DOCS = 6;

interface ChatPanelProps {
  /** Currently open document (for context attach) — panel is NOT keyed by it. */
  activeDocId: string | null;
  activeDocTitle: string;
  /** Title lookup for docs attached to a chat (may be deleted → null). */
  resolveDocTitle: (id: string) => string | null;
  /** PDF/TeX docs in the active workspace — polled when the picker opens. */
  listContextDocs: () => DocumentItem[];
  activeWorkspaceId: string | null;
  activeWorkspaceName: string | null;
  /** Queued 'rsrch:chat-send' message from outside the panel (App opens chat). */
  pendingSend?: string | null;
  onPendingSendConsumed?: () => void;
  style?: React.CSSProperties;
  dragHandle?: React.ReactNode;
  onClose?: () => void;
}

export const PERSISTED_CHAT_KEY = 'rschr-chat-id';

const readStored = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

const toMs = (ts: number): number => {
  if (!Number.isFinite(ts)) return Date.now();
  // Backend stores seconds (time.time()); accept ms defensively.
  return ts > 1e11 ? ts : ts * 1000;
};

const fmtWhen = (ts: number) =>
  new Date(toMs(ts)).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

/**
 * Citation marker forms the backend understands: [p. 3], [p. 3, p. 7],
 * [pp. 10-12], [pp. 10–12]. Must stay in sync with _PAGE_CITATION_RE in
 * backend/server.py — otherwise markers render as raw text.
 */
const CITATION_MARKER_RE = /\[p{1,2}s?\.\s*\d+(?:\s*[-\u2013]\s*\d+)?(?:\s*,\s*(?:p{1,2}s?\.\s*)?\d+(?:\s*[-\u2013]\s*\d+)?)*\]/g;

/** Pages referenced by one marker, expanding ranges like `10-12` or `10–12`.
 *  The range separator must accept the en dash (\u2013) the backend's
 *  `_CITATION_BODY` allows — otherwise `[pp. 10–12]` expands only the
 *  endpoints (10, 12) instead of every page (10, 11, 12). */
function pagesFromMarker(marker: string): number[] {
    const pages = new Set<number>();
    for (const part of marker.replace(/[[\]]/g, '').split(',')) {
        const nums = part.match(/\d+/g)?.map(Number) ?? [];
        if (nums.length === 2 && /[-\u2013]\s*\d/.test(part)) {
            const [lo, hi] = nums[0] <= nums[1] ? nums : [nums[1], nums[0]];
            if (lo >= 1 && hi - lo <= 500) {
                for (let p = lo; p <= hi; p++) pages.add(p);
                continue;
            }
        }
        nums.forEach((p) => pages.add(p));
    }
    return [...pages].filter((p) => p >= 1).sort((a, b) => a - b);
}

const scrollToPage = (page: number) => {
    window.dispatchEvent(new CustomEvent('rsrch:scroll-to-page', { detail: { page } }));
};

/** Replace `[p. N]` markers in rendered markdown text with clickable badges. */
function transformCitations(children: React.ReactNode): React.ReactNode {
    return React.Children.map(children, (child) => {
        if (typeof child !== 'string' || !CITATION_MARKER_RE.test(child)) return child;
        // Regex is global — reset lastIndex before reusing it.
        CITATION_MARKER_RE.lastIndex = 0;
        const out: React.ReactNode[] = [];
        let cursor = 0;
        for (const match of child.matchAll(CITATION_MARKER_RE)) {
            const start = match.index ?? 0;
            if (start > cursor) out.push(child.slice(cursor, start));
            for (const page of pagesFromMarker(match[0])) {
                out.push(
                    <button key={`cite-${start}-${page}`} className="citation-badge"
                        onClick={() => scrollToPage(page)}
                        title={`Scroll to page ${page}`}
                        type="button"
                    >
                        p. {page}
                    </button>,
                );
            }
            cursor = start + match[0].length;
        }
        if (cursor < child.length) out.push(child.slice(cursor));
        // Keys on every element: React warns on unkeyed array children.
        return out.map((node, i) =>
            typeof node === 'string' ? <React.Fragment key={`txt-${i}`}>{node}</React.Fragment> : node,
        );
    });
}

const MemoizedMessageList = React.memo(({ messages, isWaiting }: { messages: ChatMessage[], isWaiting: boolean }) => (
  <>
    {messages.length === 0 && (
      <div className="chat-empty">
        Start a new chat — attach a PDF for document context, or just ask.
      </div>
    )}
    {messages.map((msg, idx) => (
      <div key={msg.id ?? `${msg.created_at}-${idx}`} className={`chat-bubble ${msg.role}`}>
        {msg.role === 'assistant' ? (
          <div className="chat-content markdown-body">
            <ReactMarkdown 
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[rehypeKatex]}
              components={{
                p: ({children}) => <p>{transformCitations(children)}</p>,
                li: ({children}) => <li>{transformCitations(children)}</li>,
                code({ node, className, children, ...props }: any) {
                  const match = /language-(\w+)/.exec(className || '');
                  const lang = match?.[1]?.toLowerCase();
                  const isLatex = lang === 'latex' || lang === 'tex';
                  if (isLatex) {
                    const flatten = (n: React.ReactNode): string =>
                      Array.isArray(n)
                        ? n.map(flatten).join('')
                        : typeof n === 'string' || typeof n === 'number'
                          ? String(n)
                          : '';
                    const code = flatten(children).replace(/\n$/, '');
                    return (
                      <div className="ai-code-block" style={{ position: 'relative', marginTop: 8, marginBottom: 8 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--surface-subtle)', padding: '4px 8px', borderTopLeftRadius: 4, borderTopRightRadius: 4, fontSize: 12 }}>
                          <span style={{ color: 'var(--text-tertiary)' }}>LaTeX</span>
                          <div style={{ display: 'flex', gap: '6px' }}>
                            <button 
                              className="pdf-popup-btn" 
                              style={{ height: 22, padding: '0 8px', fontSize: 11 }}
                              onClick={() => {
                                navigator.clipboard.writeText(code);
                                // Optional: simple toast or visual feedback could be added here
                              }}
                              title="Copy to clipboard"
                              type="button"
                            >
                              Copy
                            </button>
                            <button 
                              className="pdf-popup-btn" 
                              style={{ height: 22, padding: '0 8px', fontSize: 11 }}
                              onClick={() => window.dispatchEvent(new CustomEvent('rsrch:latex-insert', { detail: { code } }))}
                              title="Insert at caret position"
                              type="button"
                            >
                              Insert
                            </button>
                            <button 
                              className="pdf-popup-btn primary" 
                              style={{ height: 22, padding: '0 8px', fontSize: 11 }}
                              onClick={() => window.dispatchEvent(new CustomEvent('rsrch:latex-apply', { detail: { code } }))}
                              title="Replace currently selected text"
                              type="button"
                            >
                              ✨ Replace Selection
                            </button>
                          </div>
                        </div>
                        <pre style={{ margin: 0, borderTopLeftRadius: 0, borderTopRightRadius: 0, padding: '12px' }}>
                          <code className={className} {...props}>
                            {children}
                          </code>
                        </pre>
                      </div>
                    );
                  }
                  return <code className={className} {...props}>{children}</code>;
                }
              }}
            >
              {msg.content}
            </ReactMarkdown>
            {(() => {
                // Pages already rendered as inline badges must not be repeated
                // in the summary chip row.
                const inline = new Set<number>();
                for (const m of msg.content.matchAll(CITATION_MARKER_RE)) {
                    pagesFromMarker(m[0]).forEach((p) => inline.add(p));
                }
                CITATION_MARKER_RE.lastIndex = 0;
                const extra = (msg.cited_pages ?? []).filter((p) => !inline.has(p));
                if (extra.length === 0) return null;
                return (
                  <div className="citation-list" style={{ marginTop: '8px', display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                    {extra.map((page) => (
                      <button key={page} className="citation-badge"
                          onClick={() => scrollToPage(page)}
                          title={`Scroll to page ${page}`}
                          type="button"
                      >
                        p. {page}
                      </button>
                    ))}
                  </div>
                );
            })()}
          </div>
        ) : (
          <div className="chat-content">{msg.content}</div>
        )}
      </div>
    ))}
    {isWaiting && (
      <div className="chat-bubble assistant waiting">
        <div className="chat-content">Thinking...</div>
      </div>
    )}
  </>
));

// Global chats, isolated from documents. The panel always opens on a blank
// draft (it unmounts on close, so state resets naturally); past chats open
// via the History view. Context = explicit attach chips, so a chat started
// on one PDF keeps working when continued on another.
const ChatPanelInner = ({ activeDocId, activeDocTitle, resolveDocTitle, listContextDocs, activeWorkspaceId, activeWorkspaceName, pendingSend, onPendingSendConsumed, style, dragHandle, onClose }: ChatPanelProps) => {
  const [view, setView] = useState<'chat' | 'history'>('chat');
  const [chats, setChats] = useState<ChatSession[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isWaiting, setIsWaiting] = useState(false);
  const [attachedIds, setAttachedIds] = useState<string[]>(() =>
    activeDocId ? [activeDocId] : []
  );
  const [attachedWs, setAttachedWs] = useState<{ id: string; name: string }[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState('');
  const pickerRef = useRef<HTMLDivElement>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeChatIdRef = useRef<string | null>(null);
  activeChatIdRef.current = activeChatId;
  // Stable handle for the mount-restore effect (openChat identity changes).
  const openChatRef = useRef<(chat: ChatSession) => Promise<void>>(async () => {});

  useEffect(() => {
    return () => {
      if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [pickerOpen]);

  useEffect(() => {
    const handleAppend = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail && detail.text) {
        setInput((prev) => prev ? prev + '\n\n' + detail.text : detail.text);
      }
    };
    
    // We can't call sendMessage directly here since it's defined below,
    // so we set the input and trigger a custom submit event or just define it in a way we can reach it.
    // Instead of doing it here, we'll do it via a flag or just handle it below.
    window.addEventListener('rsrch:chat-append', handleAppend);
    return () => {
      window.removeEventListener('rsrch:chat-append', handleAppend);
    };
  }, []);

  const refreshChats = useCallback(async (): Promise<ChatSession[]> => {
    try {
      const list = await api.getChats();
      setChats(list);
      return list;
    } catch (err) {
      console.warn('Failed to fetch chats:', err);
      return [];
    }
  }, []);

  // Mount: load list, then restore the open chat after a refresh (toggle
  // opens always start blank — closing clears the stored id in App).
  useEffect(() => {
    let cancelled = false;
    void refreshChats().then((list) => {
      if (cancelled) return;
      const stored = readStored<string | null>(PERSISTED_CHAT_KEY, null);
      const found = stored ? list.find((c) => c.id === stored) : undefined;
      if (found) void openChatRef.current(found);
    });
    return () => {
      cancelled = true;
    };
  }, [refreshChats]);

  // Persist the open chat (null = blank draft) for refresh-restore.
  useEffect(() => {
    try {
      if (activeChatId) localStorage.setItem(PERSISTED_CHAT_KEY, JSON.stringify(activeChatId));
      else localStorage.removeItem(PERSISTED_CHAT_KEY);
    } catch {}
  }, [activeChatId]);

  const scrollToBottom = useCallback(() => {
    if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 100);
  }, []);

  const openChat = useCallback(async (chat: ChatSession) => {
    setActiveChatId(chat.id);
    setView('chat');
    setConfirmDeleteId(null);
    // Clear stale messages immediately so the previous chat doesn't flash
    // while history loads (C8).
    setMessages([]);
    setIsWaiting(true);
    try {
      const history = await api.getChatMessages(chat.id);
      if (activeChatIdRef.current !== chat.id) return; // superseded
      setMessages(history);
      const fromMsgs: string[] = [];
      for (const m of history) {
        if (m.document_id && !fromMsgs.includes(m.document_id)) fromMsgs.push(m.document_id);
      }
      setAttachedIds(fromMsgs.length > 0 ? fromMsgs : chat.document_id ? [chat.document_id] : []);
      setAttachedWs([]);
      setPickerOpen(false);
      scrollToBottom();
    } catch (err) {
      console.warn('Failed to fetch chat messages:', err);
      if (activeChatIdRef.current !== chat.id) return;
      setMessages([
        {
          role: 'assistant',
          content: 'Could not load this chat. Please try again.',
          created_at: Date.now() / 1000,
        },
      ]);
    } finally {
      if (activeChatIdRef.current === chat.id) setIsWaiting(false);
    }
  }, [scrollToBottom]);

  openChatRef.current = openChat;

  const startBlank = useCallback(() => {
    setActiveChatId(null);
    setMessages([]);
    setInput('');
    setView('chat');
    setConfirmDeleteId(null);
    setAttachedWs([]);
    setPickerOpen(false);
  }, []);

  const attachCurrent = useCallback(() => {
    if (!activeDocId) return;
    setAttachedIds((prev) => (prev.includes(activeDocId) ? prev : [...prev, activeDocId]));
  }, [activeDocId]);

  const detach = useCallback((id: string) => {
    setAttachedIds((prev) => prev.filter((d) => d !== id));
  }, []);

  const handleDelete = useCallback(async (id: string) => {
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id);
      return;
    }
    setConfirmDeleteId(null);
    try {
      await api.deleteChat(id);
    } catch (err) {
      console.warn('Failed to delete chat:', err);
    }
    if (activeChatIdRef.current === id) {
      setActiveChatId(null);
      setMessages([]);
      setAttachedIds([]);
      setAttachedWs([]);
    }
    void refreshChats();
  }, [confirmDeleteId, refreshChats]);

  const handleSend = async (e?: React.FormEvent, overrideText?: string) => {
    if (e) e.preventDefault();
    const textToSend = overrideText !== undefined ? overrideText : input;
    if (!textToSend.trim() || isWaiting) return;

    const text = textToSend.trim().slice(0, 4000);
    const userMessage: ChatMessage = {
      role: 'user',
      content: text,
      created_at: Date.now() / 1000,
    };

    setMessages((prev) => [...prev, userMessage]);
    // Only clear the composer when the send originated from it — a queued
    // quick-action/external send must not wipe what the user was typing.
    if (overrideText === undefined) {
      setInput('');
    }
    setIsWaiting(true);
    scrollToBottom();

    try {
      let chatId = activeChatIdRef.current;
      if (!chatId) {
        const created = await api.createChat({ document_id: attachedIds[0] ?? activeDocId });
        chatId = created.id;
        setActiveChatId(chatId);
      }
      // Slice to the backend cap so the picker can never build a request the
      // API rejects with 422 (MAX_ATTACHED_DOCS on the server).
      const responseMsg = await api.sendChatMessage(
        chatId,
        text,
        attachedIds.slice(0, MAX_ATTACHED_DOCS),
        attachedWs.map((w) => w.id),
      );
      if (activeChatIdRef.current !== chatId) return; // user moved on
      setMessages((prev) => [...prev, responseMsg]);
      // A latex_patch is surfaced in-thread with Insert/Copy/Replace buttons.
      // It is NOT auto-applied: silently rewriting the user's selection (or
      // their whole document, when the selection is empty) is destructive.
    } catch (err) {
      console.error('Chat error:', err);
      const detail = err instanceof ApiError ? ` (${err.status})` : '';
      // Surface failures in-thread: the optimistic user bubble would
      // otherwise hang with no reply and no retry affordance.
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: `Send failed${detail} — please check your connection and try again.`,
          created_at: Date.now() / 1000,
        },
      ]);
    } finally {
      setIsWaiting(false);
      scrollToBottom();
      void refreshChats();
    }
  };

  // Fire a message queued by App (editor "Fix with AI"). App captures
  // 'rsrch:chat-send' globally so the panel works even when it starts closed.
  useEffect(() => {
    if (!pendingSend || !pendingSend.trim()) return;
    onPendingSendConsumed?.();
    void handleSend(undefined, pendingSend);
    // Intentionally keyed on the value only: re-running on unrelated state
    // changes would re-send the same queued message.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSend]);

  const activeChat = chats.find((c) => c.id === activeChatId) ?? null;
  const headerTitle = activeChat ? activeChat.title : 'New chat';

  // Context picker list: current workspace PDF/TeX docs, minus attached, filtered.
  const pickerFilter = pickerQuery.trim().toLowerCase();
  const pickerDocs = (pickerOpen ? listContextDocs() : []).filter(
    (d) =>
      !attachedIds.includes(d.id) &&
      (!pickerFilter || (d.note_title || d.name).toLowerCase().includes(pickerFilter))
  );
  const wsAlreadyAttached = !activeWorkspaceId || attachedWs.some((w) => w.id === activeWorkspaceId);
  // Hard cap so the picker can never build a request the API 422s on.
  const attachedCount = attachedIds.length;
  const attachFull = attachedCount >= MAX_ATTACHED_DOCS;

  const attachDoc = (docId: string) => {
    setAttachedIds((prev) =>
      prev.includes(docId) || prev.length >= MAX_ATTACHED_DOCS ? prev : [...prev, docId],
    );
  };

  // Whether any LaTeX doc is in play, so the quick-action chips match the
  // active context. Must use doc_type — titles don't carry the extension.
  const hasLatexContext =
    (activeDocId ? listContextDocs().find((d) => d.id === activeDocId)?.doc_type === 'latex' : false) ||
    attachedIds.some((id) => listContextDocs().find((d) => d.id === id)?.doc_type === 'latex');

  return (
    <aside className="chat-panel" id="chatPanel" style={style}>
      <div className="chat-container">
        <div className="chat-header" style={{ justifyContent: 'space-between' }}>
          <div className="chat-header-left" style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, flex: 1 }}>
            {dragHandle && <span className="drag-handle-wrapper">{dragHandle}</span>}
            {view === 'history' ? (
              <>
                <button className="icon-btn small" title="Back to chat" onClick={() => { setView('chat'); setConfirmDeleteId(null); }} type="button">‹</button>
                <h3 style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Chat history</h3>
              </>
            ) : (
              <h3 title={headerTitle} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{headerTitle}</h3>
            )}
          </div>
          <div className="chat-header-actions">
            {view !== 'history' && (
              <>
                <button className="icon-btn small" title="View past chats" aria-label="View past chats" onClick={() => { setView('history'); setConfirmDeleteId(null); }} type="button">
                  <IconDoc size={13} />
                </button>
                <button className="icon-btn small" title="Start a new blank chat" aria-label="Start a new blank chat" onClick={startBlank} type="button">
                  <IconPlus size={12} />
                </button>
              </>
            )}
            {onClose && (
              <button
                className="icon-btn small panel-close-btn"
                id="closeChatBtn"
                title="Close Chat panel (move to right sidebar)"
                aria-label="Close Chat panel"
                onClick={onClose}
                type="button"
              >
                <IconClose size={13} />
              </button>
            )}
          </div>
        </div>

        {view === 'history' ? (
          <div className="chat-messages chat-history-list">
            {chats.length === 0 && (
              <div className="chat-empty">No past chats yet.</div>
            )}
            {chats.map((c) => {
              const origin = c.document_id ? resolveDocTitle(c.document_id) ?? c.origin_title ?? 'Deleted document' : null;
              return (
                <div key={c.id} className={`chat-history-item ${c.id === activeChatId ? 'active' : ''}`} onClick={() => void openChat(c)}>
                  <div className="chat-history-main">
                    <b className="chat-history-title" title={c.title}>{c.title}</b>
                    <small className="chat-history-meta">
                      {origin ? `${origin} • ` : ''}{c.message_count} msg{c.message_count === 1 ? '' : 's'} • {fmtWhen(c.updated_at)}
                    </small>
                    {c.last_preview && (
                      <small className="chat-history-preview">{c.last_preview.slice(0, 90)}</small>
                    )}
                  </div>
                  <button
                    className={`icon-btn small tool-delete ${confirmDeleteId === c.id ? 'confirming' : ''}`}
                    title={confirmDeleteId === c.id ? 'Click again to confirm delete' : `Delete "${c.title}"`}
                    aria-label={confirmDeleteId === c.id ? `Confirm delete "${c.title}"` : `Delete "${c.title}"`}
                    onClick={(e) => { e.stopPropagation(); void handleDelete(c.id); }}
                    type="button"
                  >
                    {confirmDeleteId === c.id ? <IconClose size={11} /> : <IconTrash size={11} />}
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <>
            <div className="chat-messages">
              <MemoizedMessageList messages={messages} isWaiting={isWaiting} />
              <div ref={messagesEndRef} />
            </div>
            <div className="chat-context-row">
              {attachedIds.map((id) => (
                <span key={id} className="chat-context-chip" title={resolveDocTitle(id) ?? 'Deleted document'}>
                  <IconDoc size={11} />
                  <span>{resolveDocTitle(id) ?? 'Deleted document'}</span>
                  <button className="chip-x" onClick={() => detach(id)} title="Remove context" type="button">
                    <IconClose size={9} />
                  </button>
                </span>
              ))}
              {attachedWs.map((w) => (
                <span key={`ws-${w.id}`} className="chat-context-chip ws-chip" title={`Search all PDFs in ${w.name}`}>
                  <span>≡ {w.name}</span>
                  <button className="chip-x" onClick={() => setAttachedWs((prev) => prev.filter((x) => x.id !== w.id))} title="Remove workspace context" type="button">
                    <IconClose size={9} />
                  </button>
                </span>
              ))}
              {activeDocId && !attachedIds.includes(activeDocId) && (
                <button className="linkish" onClick={attachCurrent} title={`Attach "${activeDocTitle}" as context`} type="button">
                  + {activeDocTitle.length > 24 ? activeDocTitle.slice(0, 24) + '…' : activeDocTitle}
                </button>
              )}
              <div className="context-picker-wrap" ref={pickerRef}>
                <button className="linkish" onClick={() => { setPickerQuery(''); setPickerOpen((o) => !o); }} title="Attach a PDF or LaTeX file without opening it" type="button">
                  + Add Context
                </button>
                {pickerOpen && (
                  <div className="context-picker">
                    {activeWorkspaceName && !wsAlreadyAttached && (
                      <button
                        className="context-picker-item ws-add"
                        onClick={() => {
                          if (activeWorkspaceId) {
                            setAttachedWs((prev) =>
                              prev.some((w) => w.id === activeWorkspaceId)
                                ? prev
                                : [...prev, { id: activeWorkspaceId, name: activeWorkspaceName ?? 'Workspace' }]
                            );
                          }
                          setPickerOpen(false);
                        }}
                        title={`Search over all PDFs in ${activeWorkspaceName}`}
                        type="button"
                      >
                        <span>≡ Add workspace: {activeWorkspaceName}</span>
                      </button>
                    )}
                    <input
                      className="context-picker-search"
                      placeholder="Filter documents..."
                      aria-label="Filter documents"
                      value={pickerQuery}
                      onChange={(e) => setPickerQuery(e.target.value)}
                    />
                    {attachFull ? (
                      <div className="context-picker-empty">
                        Context limit reached ({attachedCount}/{MAX_ATTACHED_DOCS}). Remove a document to add another.
                      </div>
                    ) : pickerDocs.length === 0 ? (
                      <div className="context-picker-empty">No other PDFs in this workspace.</div>
                    ) : (
                      pickerDocs.map((d) => (
                        <button
                          key={d.id}
                          className="context-picker-item"
                          onClick={() => { attachDoc(d.id); setPickerOpen(false); }}
                          title={`Attach "${d.note_title || d.name}" as context`}
                          type="button"
                        >
                          <IconDoc size={11} />
                          <span>{d.note_title || d.name}</span>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            </div>
            
            <div className="chat-quick-actions" style={{ padding: '0 16px 8px', display: 'flex', gap: '8px', overflowX: 'auto', flexShrink: 0 }}>
              {/* Chips prefill the composer so the prompt stays editable.
                  Bare prompts like "Summarize this document." strip down to a
                  single stopword-ish term after FTS stopword removal, which
                  retrieves arbitrary chunks. */}
              {hasLatexContext ? (
                <>
                  <button type="button" className="quick-action-chip" onClick={() => setInput('/latex write a methodology section')}>
                    Methodology
                  </button>
                  <button type="button" className="quick-action-chip" onClick={() => setInput('/latex insert a figure for the architecture')}>
                    Figure
                  </button>
                  <button type="button" className="quick-action-chip" onClick={() => setInput('/latex add an equation for cross-entropy loss')}>
                    Equation
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="quick-action-chip" onClick={() => setInput('Summarize this document, citing the pages you used:')}>
                    Summarize
                  </button>
                  <button type="button" className="quick-action-chip" onClick={() => setInput('What is the main contribution of this work, and what problem does it solve?')}>
                    Main Contribution
                  </button>
                  <button type="button" className="quick-action-chip" onClick={() => setInput('Explain the methodology in detail:')}>
                    Methodology
                  </button>
                </>
              )}
            </div>

            <form className="chat-input-form" onSubmit={(e) => handleSend(e)}>
              <textarea
                className="chat-input"
                placeholder={attachedIds.length > 0 || attachedWs.length > 0 ? 'Ask about the attached context...' : 'Ask anything...'}
                aria-label="Chat message"
                value={input}
                onChange={(e) => {
                  setInput(e.target.value.slice(0, 4000));
                  e.target.style.height = 'auto';
                  e.target.style.height = `${Math.min(e.target.scrollHeight, 150)}px`;
                }}
                onKeyDown={(e) => {
                  // Enter sends; Shift+Enter inserts a newline.
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void handleSend();
                  }
                }}
                rows={1}
                maxLength={4000}
                disabled={isWaiting}
                style={{ resize: 'none', overflowY: 'auto' }}
              />
              <button type="submit" className="chat-send-btn pill-btn" disabled={!input.trim() || isWaiting}>
                Send
              </button>
            </form>
          </>
        )}
      </div>
    </aside>
  );
};

export const ChatPanel = React.memo(
  ChatPanelInner,
  (prev, next) => {
    return (
      prev.activeDocId === next.activeDocId &&
      prev.activeDocTitle === next.activeDocTitle &&
      prev.resolveDocTitle === next.resolveDocTitle &&
      prev.listContextDocs === next.listContextDocs &&
      prev.activeWorkspaceId === next.activeWorkspaceId &&
      prev.activeWorkspaceName === next.activeWorkspaceName &&
      prev.pendingSend === next.pendingSend &&
      prev.onPendingSendConsumed === next.onPendingSendConsumed &&
      prev.style === next.style &&
      prev.onClose === next.onClose &&
      prev.dragHandle === next.dragHandle
    );
  }
);
