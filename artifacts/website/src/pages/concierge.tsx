import { useEffect, useRef, useState } from 'react';
import { useSearch } from 'wouter';
import {
  useStartConciergeConversation,
  useSendConciergeMessage,
  type ConciergeReply,
} from '@workspace/api-client-react';
import { useAnalytics } from '@/lib/analytics';
import { useSpeechInput, useSpeechOutput } from '@/hooks/use-voice';
import {
  Bot,
  Loader2,
  Mic,
  MicOff,
  Phone,
  SendHorizonal,
  ShieldAlert,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { motion } from 'framer-motion';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export default function ConciergePage() {
  const search = useSearch();
  const intentHint = new URLSearchParams(search).get('intent') ?? undefined;
  const { track } = useAnalytics();

  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [quickReplies, setQuickReplies] = useState<string[]>([]);
  const [emergency, setEmergency] = useState(false);
  const [done, setDone] = useState(false);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [handsFree, setHandsFree] = useState(false);
  const handsFreeRef = useRef(false);

  const startConversation = useStartConciergeConversation();
  const sendMessage = useSendConciergeMessage();
  const startedRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<HTMLDivElement>(null);

  const speech = useSpeechOutput();
  const voiceInput = useSpeechInput((transcript) => {
    track('concierge_voice_input', {});
    send(transcript);
  });

  const setHandsFreeMode = (on: boolean) => {
    handsFreeRef.current = on;
    setHandsFree(on);
    if (on) {
      // Hands-free implies replies are read aloud.
      speech.setEnabled(true);
    } else {
      voiceInput.stop();
    }
    track('concierge_hands_free_toggled', { enabled: on });
  };

  const applyReply = (reply: ConciergeReply) => {
    setConversationId(reply.conversationId);
    setMessages((prev) => [
      ...prev,
      ...reply.messages.map((content) => ({ role: 'assistant' as const, content })),
    ]);
    setQuickReplies(reply.quickReplies);
    setEmergency(reply.emergency);
    setDone(reply.done);
    if (liveRef.current && reply.messages.length) {
      liveRef.current.textContent = reply.messages[reply.messages.length - 1];
    }
    if (reply.done) handsFreeRef.current = false;
    if (reply.done) setHandsFree(false);
    speech.speak(reply.messages, () => {
      // Hands-free: re-arm the mic after the reply finishes reading aloud.
      // Only ever runs after explicit opt-in via the hands-free toggle.
      if (handsFreeRef.current && !reply.done) {
        voiceInput.start();
      }
    });
  };

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    track('ai_conversation_started', { intent: intentHint ?? 'unknown' });
    startConversation.mutate(
      { data: { source: 'public-site', path: '/concierge', intent: intentHint } },
      {
        onSuccess: applyReply,
        onError: () => setError('The concierge is unavailable right now. Please call us instead.'),
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, sendMessage.isPending]);

  const send = (content: string) => {
    const text = content.trim();
    if (!text || !conversationId || sendMessage.isPending || done) return;
    setMessages((prev) => [...prev, { role: 'user', content: text }]);
    setQuickReplies([]);
    setInput('');
    sendMessage.mutate(
      { id: conversationId, data: { content: text } },
      {
        onSuccess: applyReply,
        onError: () => setError('Message failed to send. Please try again or call us.'),
      },
    );
  };

  return (
    <div className="flex-1 flex flex-col container mx-auto px-4 py-8 max-w-3xl w-full">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="text-center mb-6"
      >
        <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-primary/20 bg-primary/5 mb-4">
          <Bot className="w-4 h-4 text-primary" />
          <span className="text-sm font-medium text-primary">AI Roof Concierge</span>
        </div>
        <h1 className="text-3xl md:text-4xl font-display font-bold tracking-tight">
          Tell us what happened.
        </h1>
        <p className="text-muted-foreground mt-2 text-sm max-w-md mx-auto">
          Guidance in about a minute. This chat can't diagnose damage or quote pricing — a
          professional inspection does that.
        </p>
        {speech.supported && (
          <button
            type="button"
            role="switch"
            aria-checked={speech.enabled}
            onClick={() => {
              const next = !speech.enabled;
              speech.setEnabled(next);
              if (!next && handsFree) setHandsFreeMode(false);
              track('concierge_voice_output_toggled', { enabled: next });
            }}
            className={`mt-4 inline-flex items-center gap-2 px-3 py-1.5 rounded-full border text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-primary ${
              speech.enabled
                ? 'border-primary/40 bg-primary/10 text-primary'
                : 'border-white/10 bg-white/5 text-muted-foreground hover:text-foreground'
            }`}
          >
            {speech.enabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
            Read replies aloud: {speech.enabled ? 'on' : 'off'}
          </button>
        )}
        {speech.supported && voiceInput.supported && (
          <button
            type="button"
            role="switch"
            aria-checked={handsFree}
            onClick={() => setHandsFreeMode(!handsFree)}
            disabled={done}
            className={`mt-4 ml-2 inline-flex items-center gap-2 px-3 py-1.5 rounded-full border text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-40 ${
              handsFree
                ? 'border-primary/40 bg-primary/10 text-primary'
                : 'border-white/10 bg-white/5 text-muted-foreground hover:text-foreground'
            }`}
          >
            {handsFree ? <Mic className="w-4 h-4" /> : <MicOff className="w-4 h-4" />}
            Hands-free: {handsFree ? 'on' : 'off'}
          </button>
        )}
      </motion.div>

      {emergency && (
        <div
          role="alert"
          className="mb-4 flex items-center gap-3 rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3"
        >
          <ShieldAlert className="w-5 h-5 text-red-400 shrink-0" />
          <div className="text-sm text-red-200 flex-1">
            Treated as an emergency — same-day priority.
          </div>
          <a
            href="tel:+14044444476"
            onClick={() => track('phone_clicked', { label: 'concierge_emergency' })}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-destructive text-white text-sm font-semibold hover:opacity-90 transition-opacity"
          >
            <Phone className="w-4 h-4" /> Call now
          </a>
        </div>
      )}

      {handsFree && (
        <div
          role="status"
          className="mb-4 flex items-center gap-3 rounded-2xl border border-primary/30 bg-primary/10 px-4 py-3"
        >
          <Mic
            className={`w-5 h-5 text-primary shrink-0 ${voiceInput.listening ? 'motion-safe:animate-pulse' : ''}`}
          />
          <div className="text-sm text-foreground flex-1">
            Hands-free mode is on —{' '}
            {voiceInput.listening
              ? 'listening now, just speak your answer.'
              : 'the mic will turn on after each reply is read aloud.'}
          </div>
          <button
            type="button"
            onClick={() => setHandsFreeMode(false)}
            className="px-4 py-2 rounded-xl border border-primary/40 text-primary text-sm font-semibold hover:bg-primary/15 transition-colors focus:outline-none focus:ring-2 focus:ring-primary"
          >
            Stop hands-free
          </button>
        </div>
      )}

      <div className="flex-1 flex flex-col rounded-3xl border border-card-border bg-card/40 backdrop-blur-sm overflow-hidden min-h-[420px]">
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto p-4 md:p-6 space-y-4 max-h-[55vh]"
          aria-label="Conversation with the AI Roof Concierge"
        >
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              {m.role === 'assistant' && (
                <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center mr-3 shrink-0 mt-1">
                  <Bot className="w-4 h-4 text-primary" />
                </div>
              )}
              <div
                className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${
                  m.role === 'user'
                    ? 'bg-primary text-primary-foreground rounded-br-md'
                    : 'bg-white/5 border border-white/5 text-foreground rounded-bl-md'
                }`}
              >
                {m.content}
              </div>
            </div>
          ))}
          {(startConversation.isPending || sendMessage.isPending) && (
            <div className="flex items-center gap-2 text-muted-foreground text-sm pl-11">
              <Loader2 className="w-4 h-4 animate-spin" /> Concierge is typing…
            </div>
          )}
          {voiceInput.error && (
            <div role="status" className="text-sm text-muted-foreground pl-11">
              {voiceInput.error}
            </div>
          )}
          {error && (
            <div role="alert" className="text-sm text-red-400 pl-11">
              {error}{' '}
              <a href="tel:+14044444476" className="underline">
                (404) 444-4476
              </a>
            </div>
          )}
        </div>

        {quickReplies.length > 0 && !done && (
          <div className="px-4 md:px-6 pb-3 flex flex-wrap gap-2">
            {quickReplies.map((qr) => (
              <button
                key={qr}
                type="button"
                onClick={() => send(qr)}
                className="px-3 py-1.5 rounded-full border border-primary/30 bg-primary/5 text-primary text-sm hover:bg-primary/15 transition-colors focus:outline-none focus:ring-2 focus:ring-primary"
              >
                {qr}
              </button>
            ))}
          </div>
        )}

        <form
          className="border-t border-white/5 p-3 md:p-4 flex gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
        >
          <label htmlFor="concierge-input" className="sr-only">
            Type your message
          </label>
          {voiceInput.supported && (
            <button
              type="button"
              onClick={voiceInput.toggle}
              disabled={!conversationId || done || sendMessage.isPending}
              aria-label={voiceInput.listening ? 'Stop listening' : 'Speak your answer'}
              aria-pressed={voiceInput.listening}
              className={`px-4 py-3 rounded-xl border font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-40 ${
                voiceInput.listening
                  ? 'border-destructive/50 bg-destructive/15 text-red-300 motion-safe:animate-pulse'
                  : 'border-white/10 bg-white/5 text-muted-foreground hover:text-foreground'
              }`}
            >
              {voiceInput.listening ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
            </button>
          )}
          <input
            id="concierge-input"
            autoComplete="off"
            disabled={!conversationId || done}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              done
                ? 'Conversation complete — our team will reach out.'
                : voiceInput.listening
                  ? 'Listening… speak now'
                  : 'Type your answer…'
            }
            className="flex-1 bg-background/60 border border-white/10 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={!input.trim() || !conversationId || done || sendMessage.isPending}
            aria-label="Send message"
            className="px-4 py-3 rounded-xl bg-primary text-primary-foreground font-semibold disabled:opacity-40 hover:bg-accent transition-colors focus:outline-none focus:ring-2 focus:ring-primary"
          >
            <SendHorizonal className="w-5 h-5" />
          </button>
        </form>
      </div>

      <div ref={liveRef} aria-live="polite" className="sr-only" />

      <p className="text-xs text-muted-foreground/50 text-center mt-4 max-w-lg mx-auto">
        The concierge never determines damage, pricing, structural safety, or insurance outcomes —
        those require a professional on-site inspection.
      </p>
    </div>
  );
}
