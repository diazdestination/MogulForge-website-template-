/**
 * Browser voice helpers for the concierge: speech-to-text (Web Speech API
 * SpeechRecognition) and text-to-speech (speechSynthesis). Both degrade
 * gracefully — `supported` flags let the UI hide controls when unavailable,
 * so text mode always remains the fallback.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onend: (() => void) | null;
};

function getRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === 'undefined') return null;
  const w = window as any;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function useSpeechInput(onTranscript: (text: string) => void) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  useEffect(() => {
    setSupported(getRecognitionCtor() !== null);
    return () => {
      recognitionRef.current?.abort();
    };
  }, []);

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    clearTimer();
    recognitionRef.current?.stop();
    setListening(false);
  }, [clearTimer]);

  const start = useCallback(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) return;
    setError(null);
    clearTimer();
    const recognition = new Ctor();
    recognition.lang = 'en-US';
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onresult = (event: any) => {
      const transcript = Array.from(event.results as ArrayLike<any>)
        .map((r) => r[0]?.transcript ?? '')
        .join(' ')
        .trim();
      if (transcript) onTranscriptRef.current(transcript);
    };
    recognition.onerror = (event: any) => {
      setListening(false);
      if (event?.error === 'not-allowed' || event?.error === 'service-not-allowed') {
        setError('Microphone access was blocked. You can keep typing instead.');
      } else if (event?.error !== 'aborted' && event?.error !== 'no-speech') {
        setError('Voice input hit a snag — please type your answer.');
      }
    };
    recognition.onend = () => {
      clearTimer();
      setListening(false);
    };
    recognitionRef.current = recognition;
    try {
      recognition.start();
      setListening(true);
      // Safety net: never leave the mic armed for more than 20 seconds.
      timeoutRef.current = setTimeout(() => {
        recognition.abort();
        setListening(false);
      }, 20000);
    } catch {
      setListening(false);
      setError('Voice input hit a snag — please type your answer.');
    }
  }, [clearTimer]);

  const toggle = useCallback(() => {
    if (listening) stop();
    else start();
  }, [listening, start, stop]);

  return { supported, listening, error, start, stop, toggle };
}

export function useSpeechOutput() {
  const [supported, setSupported] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const enabledRef = useRef(false);

  useEffect(() => {
    setSupported(typeof window !== 'undefined' && 'speechSynthesis' in window);
    return () => {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const setEnabledSafe = useCallback((next: boolean) => {
    enabledRef.current = next;
    setEnabled(next);
    if (!next && typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  }, []);

  const speak = useCallback((texts: string[], onDone?: () => void) => {
    if (!enabledRef.current) return;
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utterances: SpeechSynthesisUtterance[] = [];
    for (const text of texts) {
      // Strip bullets/emoji-ish markers that read poorly aloud.
      const clean = text.replace(/[•⚠️]/g, '').trim();
      if (!clean) continue;
      const utterance = new SpeechSynthesisUtterance(clean);
      utterance.rate = 1;
      utterances.push(utterance);
    }
    if (onDone && utterances.length > 0) {
      let fired = false;
      const fire = () => {
        if (fired) return;
        fired = true;
        onDone();
      };
      const last = utterances[utterances.length - 1];
      last.onend = fire;
      last.onerror = fire;
    }
    for (const utterance of utterances) {
      window.speechSynthesis.speak(utterance);
    }
  }, []);

  return { supported, enabled, setEnabled: setEnabledSafe, speak };
}
