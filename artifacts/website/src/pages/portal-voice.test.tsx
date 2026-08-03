/**
 * Guards the claim portal's voice controls: the "Read updates aloud" toggle
 * (speechSynthesis) and the mic dictation button (SpeechRecognition). Both
 * must appear only when the browser supports them, and keep doing their job
 * as the portal page evolves.
 *
 * Also covers the 20-second safety timeout (mic can't stay armed forever) and
 * the error paths (permission blocked, generic failure) for both the portal
 * and concierge UIs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/* ------------------------- api-client mock ------------------------- */

const useGetPortalOverview = vi.fn();
const sendMessageMutate = vi.fn();

vi.mock('@workspace/api-client-react', () => ({
  useRequestPortalLoginCode: () => ({ mutate: vi.fn(), isPending: false }),
  useVerifyPortalLoginCode: () => ({ mutate: vi.fn(), isPending: false }),
  useGetPortalOverview: (...args: unknown[]) => useGetPortalOverview(...args),
  useGetPortalConversation: () => ({ data: undefined, isLoading: false, isError: false }),
  useGetPortalPhoto: () => ({ data: undefined, isError: false }),
  useSendPortalMessage: () => ({ mutate: sendMessageMutate, isPending: false }),
  useLogoutPortalSession: () => ({ mutate: vi.fn(), isPending: false }),
  useAddPortalClaimPhotos: () => ({ mutateAsync: vi.fn(), isPending: false }),
  requestPublicUploadUrl: vi.fn(),
  getGetPortalOverviewQueryKey: () => ['portal-overview'],
  getGetPortalConversationQueryKey: (id: string) => ['portal-conversation', id],
  useStartConciergeConversation: () => ({
    mutate: vi.fn((_data: unknown, callbacks?: { onSuccess?: (r: any) => void }) => {
      // Immediately resolve so conversationId is set and the mic button is enabled.
      callbacks?.onSuccess?.({
        conversationId: 'test-conv-1',
        messages: ['Hello! How can I help?'],
        quickReplies: [],
        emergency: false,
        done: false,
      });
    }),
    isPending: false,
  }),
  useSendConciergeMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useTrackAnalyticsEvent: () => ({ mutate: vi.fn() }),
}));

/* -------------------- analytics + router mocks --------------------- */

vi.mock('@/lib/analytics', () => ({
  useAnalytics: () => ({ track: vi.fn() }),
  getVisitorContext: () => ({}),
  AnalyticsProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('wouter', async () => {
  const actual = await vi.importActual<typeof import('wouter')>('wouter');
  return { ...actual, useSearch: () => '' };
});

/* ----------------------- lazy page imports ------------------------- */

const { default: PortalPage } = await import('@/pages/portal');
const { default: ConciergePage } = await import('@/pages/concierge');

/* ----------------------------- fixtures ---------------------------- */

const CLAIM = {
  id: 'claim-1',
  createdAt: '2026-07-01T12:00:00Z',
  closed: false,
  property: null,
  steps: [
    { key: 'assessment', label: 'Assessment', description: 'Done.', state: 'complete' },
    {
      key: 'inspection',
      label: 'Inspection scheduled',
      description: 'Our inspector is on the calendar.',
      state: 'current',
    },
  ],
  appointments: [],
  photos: [],
  updates: [
    {
      id: 'u1',
      type: 'status',
      title: 'Inspection booked',
      body: null,
      occurredAt: '2026-07-20T15:00:00Z',
    },
  ],
};

function renderPortal() {
  window.localStorage.setItem('painless_portal_token', 'test-token');
  useGetPortalOverview.mockReturnValue({
    isLoading: false,
    isError: false,
    data: { contact: { firstName: 'Pat' }, claims: [CLAIM] },
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PortalPage />
    </QueryClientProvider>,
  );
}

function renderConcierge() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ConciergePage />
    </QueryClientProvider>,
  );
}

/* ------------------------- speech test doubles ------------------------- */

const speakSpy = vi.fn();
const cancelSpy = vi.fn();

class FakeUtterance {
  text: string;
  rate = 1;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

function installSpeechSynthesis() {
  (window as any).speechSynthesis = { speak: speakSpy, cancel: cancelSpy };
  (globalThis as any).SpeechSynthesisUtterance = FakeUtterance;
}

let lastRecognition: FakeRecognition | null = null;

class FakeRecognition {
  lang = '';
  continuous = false;
  interimResults = false;
  onresult: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn(() => this.onend?.());
  abort = vi.fn(() => this.onend?.());
  constructor() {
    lastRecognition = this;
  }
}

function installSpeechRecognition() {
  (window as any).SpeechRecognition = FakeRecognition;
}

function uninstallAll() {
  delete (window as any).speechSynthesis;
  delete (globalThis as any).SpeechSynthesisUtterance;
  delete (window as any).SpeechRecognition;
  delete (window as any).webkitSpeechRecognition;
}

beforeEach(() => {
  uninstallAll();
  lastRecognition = null;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  window.localStorage.clear();
  uninstallAll();
});

/* ------------------------------- tests ------------------------------- */

describe('portal voice controls', () => {
  it('hides both controls when the browser supports neither API', () => {
    renderPortal();
    expect(screen.getByTestId('card-claim-claim-1')).toBeTruthy();
    expect(screen.queryByTestId('button-read-aloud-claim-1')).toBeNull();
    expect(screen.queryByTestId('button-voice-message-claim-1')).toBeNull();
  });

  it('shows the read-aloud toggle only when speechSynthesis is supported', () => {
    installSpeechSynthesis();
    renderPortal();
    expect(screen.getByTestId('button-read-aloud-claim-1')).toBeTruthy();
    // Mic still hidden — SpeechRecognition is not available.
    expect(screen.queryByTestId('button-voice-message-claim-1')).toBeNull();
  });

  it('speaks the current status and recent updates when toggled on, and cancels when toggled off', () => {
    installSpeechSynthesis();
    renderPortal();
    const toggle = screen.getByTestId('button-read-aloud-claim-1');
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(toggle.textContent).toContain('on');

    const spoken = speakSpy.mock.calls.map((c) => (c[0] as FakeUtterance).text);
    expect(spoken.some((t) => t.includes('Current status: Inspection scheduled'))).toBe(true);
    expect(spoken.some((t) => t.includes('Our inspector is on the calendar'))).toBe(true);
    expect(spoken.some((t) => t.includes('Inspection booked'))).toBe(true);

    // Toggling off cancels any in-flight speech.
    cancelSpy.mockClear();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(cancelSpy).toHaveBeenCalled();
  });

  it('shows the mic button when SpeechRecognition is supported and appends transcripts to the message box', () => {
    installSpeechRecognition();
    renderPortal();
    const mic = screen.getByTestId('button-voice-message-claim-1');
    expect(mic.getAttribute('aria-pressed')).toBe('false');
    // Read-aloud toggle stays hidden without speechSynthesis.
    expect(screen.queryByTestId('button-read-aloud-claim-1')).toBeNull();

    fireEvent.click(mic);
    expect(lastRecognition).not.toBeNull();
    expect(lastRecognition!.start).toHaveBeenCalled();
    expect(mic.getAttribute('aria-pressed')).toBe('true');

    act(() => {
      lastRecognition!.onresult?.({
        results: [[{ transcript: 'my roof is leaking' }]],
      });
      lastRecognition!.onend?.();
    });

    const textarea = screen.getByTestId('input-message-claim-1') as HTMLTextAreaElement;
    expect(textarea.value).toBe('my roof is leaking');
    expect(mic.getAttribute('aria-pressed')).toBe('false');

    // A second dictation appends rather than replaces.
    fireEvent.click(mic);
    act(() => {
      lastRecognition!.onresult?.({ results: [[{ transcript: 'please help' }]] });
      lastRecognition!.onend?.();
    });
    expect(textarea.value).toBe('my roof is leaking please help');
  });

  it('aborts recognition and clears listening state after the 20-second safety timeout', () => {
    vi.useFakeTimers();
    installSpeechRecognition();
    renderPortal();

    const mic = screen.getByTestId('button-voice-message-claim-1');
    fireEvent.click(mic);
    expect(mic.getAttribute('aria-pressed')).toBe('true');
    expect(lastRecognition!.start).toHaveBeenCalled();

    // Advance past the 20-second safety cap.
    act(() => {
      vi.advanceTimersByTime(20000);
    });

    expect(lastRecognition!.abort).toHaveBeenCalled();
    expect(mic.getAttribute('aria-pressed')).toBe('false');
  });

  it('shows the blocked-mic message in the portal when the browser denies microphone access', () => {
    installSpeechRecognition();
    renderPortal();

    const mic = screen.getByTestId('button-voice-message-claim-1');
    fireEvent.click(mic);

    act(() => {
      lastRecognition!.onerror?.({ error: 'not-allowed' });
    });

    expect(screen.getByRole('status').textContent).toContain(
      'Microphone access was blocked. You can keep typing instead.',
    );
    expect(mic.getAttribute('aria-pressed')).toBe('false');
  });

  it('shows the generic fallback message in the portal when recognition hits an unexpected error', () => {
    installSpeechRecognition();
    renderPortal();

    const mic = screen.getByTestId('button-voice-message-claim-1');
    fireEvent.click(mic);

    act(() => {
      lastRecognition!.onerror?.({ error: 'network' });
    });

    expect(screen.getByRole('status').textContent).toContain(
      'Voice input hit a snag — please type your answer.',
    );
    expect(mic.getAttribute('aria-pressed')).toBe('false');
  });
});

describe('concierge voice error messages', () => {
  beforeEach(() => {
    // jsdom does not implement Element.prototype.scrollTo; stub it so the
    // concierge's scroll-to-bottom effect doesn't throw.
    Element.prototype.scrollTo = vi.fn() as any;
  });

  it('shows the blocked-mic message in the concierge when the browser denies microphone access', () => {
    installSpeechRecognition();
    installSpeechSynthesis();
    renderConcierge();

    // The concierge mic button is only rendered when both speech APIs are present.
    const mic = screen.getByRole('button', { name: /speak your answer/i });
    fireEvent.click(mic);

    act(() => {
      lastRecognition!.onerror?.({ error: 'not-allowed' });
    });

    const statusEl = screen.getByRole('status');
    expect(statusEl.textContent).toContain(
      'Microphone access was blocked. You can keep typing instead.',
    );
  });

  it('shows the generic fallback message in the concierge when recognition hits an unexpected error', () => {
    installSpeechRecognition();
    installSpeechSynthesis();
    renderConcierge();

    const mic = screen.getByRole('button', { name: /speak your answer/i });
    fireEvent.click(mic);

    act(() => {
      lastRecognition!.onerror?.({ error: 'audio-capture' });
    });

    const statusEl = screen.getByRole('status');
    expect(statusEl.textContent).toContain(
      'Voice input hit a snag — please type your answer.',
    );
  });

  it('aborts recognition and clears listening state after the 20-second safety timeout in the concierge', () => {
    vi.useFakeTimers();
    installSpeechRecognition();
    installSpeechSynthesis();
    renderConcierge();

    const mic = screen.getByRole('button', { name: /speak your answer/i });
    fireEvent.click(mic);
    expect(mic.getAttribute('aria-pressed')).toBe('true');
    expect(lastRecognition!.start).toHaveBeenCalled();

    // Advance past the 20-second safety cap.
    act(() => {
      vi.advanceTimersByTime(20000);
    });

    expect(lastRecognition!.abort).toHaveBeenCalled();
    expect(mic.getAttribute('aria-pressed')).toBe('false');
  });
});
