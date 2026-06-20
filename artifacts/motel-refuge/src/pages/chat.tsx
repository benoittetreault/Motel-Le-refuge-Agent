import { useState, useRef, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useCreateAnthropicConversation,
  useListBookings,
  getGetAnthropicConversationQueryKey,
} from '@workspace/api-client-react';

type Message = {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
};

const URL_REGEX = /(https?:\/\/[^\s]+)/g;

function renderContent(text: string, isUser: boolean) {
  const parts = text.split(URL_REGEX);
  URL_REGEX.lastIndex = 0;
  return parts.map((part, i) => {
    if (/^https?:\/\/[^\s]+$/.test(part)) {
      return (
        <a
          key={i}
          href={part}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            color: isUser ? 'rgba(255,255,255,0.85)' : '#1e3f7a',
            textDecoration: 'underline',
            fontWeight: 500,
            wordBreak: 'break-all',
          }}
        >
          {part}
        </a>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

function formatTime(date: Date) {
  return date.toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit' });
}

const INITIAL_GREETING =
  "Bonjour, je suis l'assistant virtuel du Motel Le Refuge. Comment puis-je vous aider aujourd'hui ?\n\nHello, I am the virtual assistant for Motel Le Refuge. How may I help you today?";

const SendIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="22" y1="2" x2="11" y2="13" />
    <polygon points="22 2 15 22 11 13 2 9 22 2" />
  </svg>
);

const PinIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
    <circle cx="12" cy="10" r="3" />
  </svg>
);

const PhoneIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.65 3.5 2 2 0 0 1 3.62 1.35h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L7.91 9a16 16 0 0 0 6.13 6.13l.92-.92a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
  </svg>
);

const GlobeIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <line x1="2" y1="12" x2="22" y2="12" />
    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
  </svg>
);

export default function ChatPage() {
  const queryClient = useQueryClient();
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [messages, setMessages] = useState<Message[]>([
    { id: 0, role: 'assistant', content: INITIAL_GREETING, timestamp: new Date() },
  ]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const createConversation = useCreateAnthropicConversation();
  const { data: bookings } = useListBookings();
  const hasBooking = bookings?.some((b) => b.conversationId === conversationId);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isTyping]);

  const ensureConversation = async (): Promise<number> => {
    if (conversationId) return conversationId;
    return new Promise((resolve, reject) => {
      createConversation.mutate(
        { data: { title: `Chat ${new Date().toLocaleString('fr-CA')}` } },
        {
          onSuccess: (data) => {
            setConversationId(data.id);
            resolve(data.id);
          },
          onError: reject,
        }
      );
    });
  };

  const handleSend = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!input.trim() || isTyping) return;

    const userText = input.trim();
    setInput('');
    setIsTyping(true);

    const userMsgId = Date.now();
    setMessages((prev) => [
      ...prev,
      { id: userMsgId, role: 'user', content: userText, timestamp: new Date() },
    ]);

    try {
      const convId = await ensureConversation();
      const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

      const res = await fetch(`${BASE}/api/anthropic/conversations/${convId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: userText }),
      });

      if (!res.ok) throw new Error('Failed to send message');

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let assistantContent = '';
      const assistantMsgId = Date.now() + 1;

      setMessages((prev) => [
        ...prev,
        { id: assistantMsgId, role: 'assistant', content: '', timestamp: new Date() },
      ]);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const chunk = JSON.parse(line.slice(6));
              if (chunk.done) break;
              if (chunk.content) {
                assistantContent += chunk.content;
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantMsgId ? { ...m, content: assistantContent } : m
                  )
                );
              }
            } catch {
              // ignore parse errors
            }
          }
        }
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now(),
          role: 'assistant',
          content:
            "Désolé, une erreur s'est produite. Veuillez réessayer.\nSorry, an error occurred. Please try again.",
          timestamp: new Date(),
        },
      ]);
    } finally {
      setIsTyping(false);
      if (conversationId) {
        queryClient.invalidateQueries({
          queryKey: getGetAnthropicConversationQueryKey(conversationId),
        });
      }
    }
  };

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400&family=Inter:wght@300;400;500&display=swap');

        *, *::before, *::after { box-sizing: border-box; }
        body { margin: 0; padding: 0; }

        .lr {
          display: flex;
          flex-direction: column;
          height: 100dvh;
          background: #f0f4fa;
          font-family: 'Inter', sans-serif;
          font-weight: 400;
          color: #1a2840;
        }

        /* ── Header ── */
        .lr__header {
          background: #fff;
          border-bottom: 1px solid #d0dce8;
          padding: 0 28px;
          height: 72px;
          display: flex;
          align-items: center;
          gap: 16px;
          flex-shrink: 0;
          box-shadow: 0 1px 0 #d0dce8;
        }
        .lr__logo-mark {
          height: 48px;
          width: auto;
          flex-shrink: 0;
          display: flex;
          align-items: center;
        }
        .lr__logo-mark img {
          height: 48px;
          width: auto;
          object-fit: contain;
          display: block;
        }
        .lr__header-text {
          flex: 1;
        }
        .lr__name {
          font-family: 'Cormorant Garamond', serif;
          font-size: 22px;
          font-weight: 600;
          letter-spacing: 0.5px;
          line-height: 1;
          color: #0f1e33;
          margin: 0;
        }
        .lr__tagline {
          font-size: 11px;
          color: #5a7a9e;
          letter-spacing: 1.2px;
          text-transform: uppercase;
          margin-top: 4px;
          font-weight: 400;
        }
        .lr__online {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 11.5px;
          color: #6daa62;
          font-weight: 500;
          letter-spacing: 0.3px;
        }
        .lr__online-dot {
          width: 6px;
          height: 6px;
          background: #6daa62;
          border-radius: 50%;
          animation: lr-pulse 2.5s ease-in-out infinite;
        }
        @keyframes lr-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.5; transform: scale(0.8); }
        }

        /* ── Warning ── */
        .lr__warning {
          background: #eaf0fc;
          border-bottom: 1px solid #93b5e8;
          padding: 9px 28px;
          font-size: 12.5px;
          color: #1e3a6e;
          letter-spacing: 0.2px;
          text-align: center;
        }

        /* ── Messages ── */
        .lr__feed {
          flex: 1;
          overflow-y: auto;
          padding: 28px 24px;
          display: flex;
          flex-direction: column;
          gap: 18px;
          scroll-behavior: smooth;
        }
        .lr__feed::-webkit-scrollbar { width: 4px; }
        .lr__feed::-webkit-scrollbar-thumb {
          background: #d9c9b8;
          border-radius: 4px;
        }

        .lr__row {
          display: flex;
          flex-direction: column;
        }
        .lr__row--user { align-items: flex-end; }
        .lr__row--assistant { align-items: flex-start; }

        .lr__bubble {
          max-width: 68%;
          padding: 12px 17px;
          font-size: 14.5px;
          line-height: 1.7;
          white-space: pre-wrap;
          word-break: break-word;
          border-radius: 14px;
        }
        .lr__bubble--assistant {
          background: #fff;
          color: #1a2840;
          border: 1px solid #d0dce8;
          border-radius: 14px 14px 14px 3px;
          box-shadow: 0 1px 3px rgba(0,0,0,0.05);
          border-left: 2px solid #2a5298;
        }
        .lr__bubble--user {
          background: #2a5298;
          color: #fff;
          border-radius: 14px 14px 3px 14px;
          box-shadow: 0 2px 8px rgba(42,82,152,0.22);
        }

        .lr__time {
          font-size: 10.5px;
          color: #9ab4cc;
          margin-top: 5px;
          padding: 0 3px;
          letter-spacing: 0.3px;
        }

        /* ── Typing ── */
        .lr__typing {
          background: #fff;
          border: 1px solid #d0dce8;
          border-left: 2px solid #2a5298;
          border-radius: 14px 14px 14px 3px;
          padding: 14px 18px;
          display: flex;
          gap: 5px;
          align-items: center;
          box-shadow: 0 1px 3px rgba(0,0,0,0.05);
          width: fit-content;
        }
        .lr__dot {
          width: 6px;
          height: 6px;
          background: #2a5298;
          border-radius: 50%;
          animation: lr-bounce 1.3s ease-in-out infinite;
          opacity: 0.4;
        }
        .lr__dot:nth-child(2) { animation-delay: 0.2s; }
        .lr__dot:nth-child(3) { animation-delay: 0.4s; }
        @keyframes lr-bounce {
          0%, 100% { transform: translateY(0); opacity: 0.35; }
          50% { transform: translateY(-5px); opacity: 1; }
        }

        /* ── Divider with date label ── */
        .lr__divider {
          display: flex;
          align-items: center;
          gap: 12px;
          margin: 4px 0;
        }
        .lr__divider::before, .lr__divider::after {
          content: '';
          flex: 1;
          height: 1px;
          background: #d0dce8;
        }
        .lr__divider span {
          font-size: 11px;
          color: #9ab4cc;
          letter-spacing: 0.8px;
          text-transform: uppercase;
        }

        /* ── Input ── */
        .lr__input-wrap {
          background: #fff;
          border-top: 1px solid #d0dce8;
          padding: 14px 24px;
          flex-shrink: 0;
        }
        .lr__input-form {
          display: flex;
          gap: 10px;
          max-width: 800px;
          margin: 0 auto;
          align-items: center;
        }
        .lr__input {
          flex: 1;
          height: 46px;
          padding: 0 18px;
          border: 1.5px solid #c0d0e4;
          border-radius: 50px;
          font-size: 14px;
          font-family: 'Inter', sans-serif;
          font-weight: 400;
          color: #1a2840;
          background: #f0f4fa;
          outline: none;
          transition: border-color 0.2s, background 0.2s, box-shadow 0.2s;
        }
        .lr__input::placeholder {
          color: #90adc8;
          font-style: italic;
        }
        .lr__input:focus {
          border-color: #2a5298;
          background: #fff;
          box-shadow: 0 0 0 3px rgba(42,82,152,0.1);
        }
        .lr__send {
          width: 46px;
          height: 46px;
          border-radius: 50%;
          border: none;
          background: #2a5298;
          color: #fff;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          flex-shrink: 0;
          box-shadow: 0 2px 8px rgba(42,82,152,0.30);
          transition: background 0.2s, transform 0.15s, box-shadow 0.2s;
        }
        .lr__send:disabled {
          background: #b0c4de;
          box-shadow: none;
          cursor: not-allowed;
        }
        .lr__send:not(:disabled):hover {
          background: #1e3f7a;
          transform: scale(1.05);
          box-shadow: 0 3px 12px rgba(42,82,152,0.40);
        }
        .lr__send:not(:disabled):active { transform: scale(0.96); }

        /* ── Footer ── */
        .lr__footer {
          background: #0f1e33;
          color: rgba(255,255,255,0.55);
          padding: 11px 24px;
          font-size: 12px;
          text-align: center;
          flex-shrink: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 20px;
          flex-wrap: wrap;
          letter-spacing: 0.3px;
        }
        .lr__footer-item {
          display: flex;
          align-items: center;
          gap: 5px;
        }
        .lr__footer a {
          color: rgba(255,255,255,0.55);
          text-decoration: none;
          transition: color 0.15s;
        }
        .lr__footer a:hover { color: rgba(255,255,255,0.9); }
        .lr__sep {
          width: 1px;
          height: 12px;
          background: rgba(255,255,255,0.2);
        }
      `}</style>

      <div className="lr">
        {/* Header */}
        <header className="lr__header">
          <div className="lr__logo-mark">
            <img src="/motel-logo.png" alt="Motel Le Refuge" />
          </div>
          <div className="lr__header-text">
            <div className="lr__name">Motel Le Refuge</div>
            <div className="lr__tagline">Your comfort is our priority &middot; Votre confort, notre priorité</div>
          </div>
          <div className="lr__online">
            <div className="lr__online-dot" />
            En ligne
          </div>
        </header>

        {/* Warning */}
        {hasBooking && (
          <div className="lr__warning">
            Une demande de réservation a été enregistrée — notre équipe vous contactera bientôt.
          </div>
        )}

        {/* Messages */}
        <div ref={scrollRef} className="lr__feed">
          <div className="lr__divider">
            <span>Aujourd'hui &middot; Today</span>
          </div>

          {messages.map((msg) => (
            <div key={msg.id} className={`lr__row lr__row--${msg.role}`}>
              <div className={`lr__bubble lr__bubble--${msg.role}`}>
                {renderContent(msg.content, msg.role === 'user')}
              </div>
              <span className="lr__time">{formatTime(msg.timestamp)}</span>
            </div>
          ))}

          {isTyping && (
            <div className="lr__row lr__row--assistant">
              <div className="lr__typing">
                <div className="lr__dot" />
                <div className="lr__dot" />
                <div className="lr__dot" />
              </div>
            </div>
          )}
        </div>

        {/* Input */}
        <div className="lr__input-wrap">
          <form className="lr__input-form" onSubmit={handleSend}>
            <input
              className="lr__input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Posez une question… / Ask a question…"
              disabled={isTyping}
              data-testid="input-message"
            />
            <button
              type="submit"
              className="lr__send"
              disabled={!input.trim() || isTyping}
              data-testid="button-send"
            >
              <SendIcon />
            </button>
          </form>
        </div>

        {/* Footer */}
        <footer className="lr__footer">
          <div className="lr__footer-item">
            <PinIcon />
            <span>43 rue Queen, Sherbrooke</span>
          </div>
          <div className="lr__sep" />
          <div className="lr__footer-item">
            <PhoneIcon />
            <a href="tel:8195649005">819-564-9005</a>
          </div>
          <div className="lr__sep" />
          <div className="lr__footer-item">
            <GlobeIcon />
            <a href="https://www.motellerefuge.com" target="_blank" rel="noopener noreferrer">
              motellerefuge.com
            </a>
          </div>
        </footer>
      </div>
    </>
  );
}
