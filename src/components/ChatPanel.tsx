import React, { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import type { ChatMessage, ChatSession } from '../types';
import { api } from '../services/api';
import { IconPlus, IconClose, IconTrash, IconDoc } from './Icons';

interface ChatPanelProps {
  /** Currently open document (for context attach) — panel is NOT keyed by it. */
  activeDocId: string | null;
  activeDocTitle: string;
  /** Title lookup for docs attached to a chat (may be deleted → null). */
  resolveDocTitle: (id: string) => string | null;
  style?: React.CSSProperties;
  dragHandle?: React.ReactNode;
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

const fmtWhen = (sec: number) =>
  new Date(sec * 1000).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

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
            <ReactMarkdown>{msg.content}</ReactMarkdown>
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
const ChatPanelInner = ({ activeDocId, activeDocTitle, resolveDocTitle, style, dragHandle }: ChatPanelProps) => {
  const [view, setView] = useState<'chat' | 'history'>('chat');
  const [chats, setChats] = useState<ChatSession[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isWaiting, setIsWaiting] = useState(false);
  const [attachedIds, setAttachedIds] = useState<string[]>(() =>
    activeDocId ? [activeDocId] : []
  );
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
    try {
      const history = await api.getChatMessages(chat.id);
      if (activeChatIdRef.current !== chat.id) return; // superseded
      setMessages(history);
      const fromMsgs: string[] = [];
      for (const m of history) {
        if (m.document_id && !fromMsgs.includes(m.document_id)) fromMsgs.push(m.document_id);
      }
      setAttachedIds(fromMsgs.length > 0 ? fromMsgs : chat.document_id ? [chat.document_id] : []);
      scrollToBottom();
    } catch (err) {
      console.warn('Failed to fetch chat messages:', err);
    }
  }, [scrollToBottom]);

  openChatRef.current = openChat;

  const startBlank = useCallback(() => {
    setActiveChatId(null);
    setMessages([]);
    setInput('');
    setView('chat');
    setConfirmDeleteId(null);
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
    }
    void refreshChats();
  }, [confirmDeleteId, refreshChats]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isWaiting) return;

    const text = input.trim();
    const userMessage: ChatMessage = {
      role: 'user',
      content: text,
      created_at: Date.now() / 1000,
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setIsWaiting(true);
    scrollToBottom();

    try {
      let chatId = activeChatIdRef.current;
      if (!chatId) {
        const created = await api.createChat({ document_id: attachedIds[0] ?? activeDocId });
        chatId = created.id;
        setActiveChatId(chatId);
      }
      const responseMsg = await api.sendChatMessage(chatId, text, attachedIds);
      if (activeChatIdRef.current !== chatId) return; // user moved on
      setMessages((prev) => [...prev, responseMsg]);
    } catch (err) {
      console.error('Chat error:', err);
    } finally {
      setIsWaiting(false);
      scrollToBottom();
      void refreshChats();
    }
  };

  const activeChat = chats.find((c) => c.id === activeChatId) ?? null;
  const headerTitle = activeChat ? activeChat.title : 'New chat';

  return (
    <aside className="chat-panel" id="chatPanel" style={style}>
      <div className="chat-container">
        <div className="chat-header">
          <div className="chat-header-left" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {dragHandle && <span className="drag-handle-wrapper">{dragHandle}</span>}
            {view === 'history' ? (
              <>
                <button className="icon-btn small" title="Back to chat" onClick={() => { setView('chat'); setConfirmDeleteId(null); }} type="button">‹</button>
                <h3>Chat history</h3>
              </>
            ) : (
              <>
                <h3 title={headerTitle}>{headerTitle}</h3>
                <div className="chat-header-actions">
                  <button className="icon-btn small" title="View past chats" onClick={() => { setView('history'); setConfirmDeleteId(null); }} type="button">
                    <IconDoc size={13} />
                  </button>
                  <button className="icon-btn small" title="Start a new blank chat" onClick={startBlank} type="button">
                    <IconPlus size={12} />
                  </button>
                </div>
              </>
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
            {(attachedIds.length > 0 || activeDocId) && (
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
                {activeDocId && !attachedIds.includes(activeDocId) && (
                  <button className="linkish" onClick={attachCurrent} title={`Attach "${activeDocTitle}" as context`} type="button">
                    + {activeDocTitle.length > 24 ? activeDocTitle.slice(0, 24) + '…' : activeDocTitle}
                  </button>
                )}
              </div>
            )}
            <form className="chat-input-form" onSubmit={handleSend}>
              <input
                type="text"
                className="chat-input"
                placeholder={attachedIds.length > 0 ? 'Ask about the attached PDFs...' : 'Ask anything...'}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                disabled={isWaiting}
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
      prev.style === next.style
    );
  }
);
