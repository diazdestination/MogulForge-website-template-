/**
 * Guards the nationwide travel-quote form: filling in contact info, property
 * address, project type, and an optional description then submitting must call
 * useSubmitAssessment with source:'nationwide-inquiry', the correct intent
 * derived from the selected project type, and the project type label prepended
 * to the description.  The success banner must appear once the mutation
 * resolves.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/* -------------------- api-client mock -------------------- */

let mutateArgs: [unknown, unknown] | null = null;
let onSuccessCb: (() => void) | null = null;
let mutateIsPending = false;

const useSubmitAssessment = vi.fn(() => ({
  mutate: (data: unknown, callbacks: { onSuccess?: () => void; onError?: () => void }) => {
    mutateArgs = [data, callbacks];
    onSuccessCb = callbacks.onSuccess ?? null;
  },
  isPending: mutateIsPending,
}));

vi.mock('@workspace/api-client-react', () => ({
  useSubmitAssessment: (...args: unknown[]) => useSubmitAssessment(...args),
}));

/* -------------------- analytics mock -------------------- */

vi.mock('@/lib/analytics', () => ({
  useAnalytics: () => ({ track: vi.fn() }),
  AnalyticsProvider: ({ children }: { children: React.ReactNode }) => children,
}));

/* -------------------- site-config mock -------------------- */

vi.mock('@/lib/site-config', () => ({
  useBusiness: () => ({
    phone: '(404) 444-4476',
    phoneHref: 'tel:+14044444476',
    phoneE164: '+14044444476',
    name: 'Painless Roofing',
    legalName: 'Painless Roofing & Water Restoration LLC',
    city: 'Canton',
    state: 'GA',
    postalCode: '30114',
    hours: 'Open 24 hours',
    facebook: 'https://facebook.com/painlessroofing',
    tagline: 'Test tagline',
  }),
}));

/* -------------------- wouter mock -------------------- */

vi.mock('wouter', async () => {
  const actual = await vi.importActual<typeof import('wouter')>('wouter');
  return { ...actual, useSearch: () => '' };
});

/* -------------------- seo / page-blocks stubs -------------------- */

vi.mock('@/lib/seo', () => ({
  Seo: () => null,
  breadcrumbJsonLd: () => ({}),
  localBusinessJsonLd: () => ({}),
}));

vi.mock('@/components/page-blocks', () => ({
  Breadcrumbs: () => null,
  CtaSection: () => null,
  FaqList: () => null,
  PageHero: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SectionHeading: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

/* -------------------- lazy import after mocks -------------------- */

const { default: NationwidePage } = await import('@/pages/nationwide');

/* -------------------- helpers -------------------- */

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NationwidePage />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mutateArgs = null;
  onSuccessCb = null;
  mutateIsPending = false;
});

/* -------------------- tests -------------------- */

describe('NationwidePage travel-quote form', () => {
  it('calls useSubmitAssessment with source nationwide-inquiry, correct intent, and prepended project type', async () => {
    renderPage();

    // Contact info
    fireEvent.change(screen.getByLabelText(/first name/i), { target: { value: 'Alex' } });
    fireEvent.change(screen.getByLabelText(/last name/i), { target: { value: 'Rivera' } });
    fireEvent.change(screen.getByLabelText(/phone/i), { target: { value: '4045550001' } });
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'alex@example.com' } });

    // Property address
    fireEvent.change(screen.getByLabelText(/street address/i), { target: { value: '123 Oak Dr' } });
    fireEvent.change(screen.getByLabelText(/city/i), { target: { value: 'Dallas' } });
    fireEvent.change(screen.getByLabelText(/state/i), { target: { value: 'TX' } });
    fireEvent.change(screen.getByLabelText(/zip/i), { target: { value: '75001' } });

    // Project type — "large-loss" maps to intent:'storm'
    const largeLossRadio = screen.getByRole('radio', { name: /large-loss storm event/i });
    fireEvent.click(largeLossRadio);

    // Optional description
    fireEvent.change(screen.getByLabelText(/describe the project/i), {
      target: { value: 'Hail damage from last week' },
    });

    // Submit
    fireEvent.click(screen.getByRole('button', { name: /send travel quote request/i }));

    expect(mutateArgs).not.toBeNull();
    const [payload] = mutateArgs as [{ data: Record<string, unknown> }, unknown];

    expect(payload.data.source).toBe('nationwide-inquiry');
    expect(payload.data.intent).toBe('storm');
    expect(typeof payload.data.description).toBe('string');
    const desc = payload.data.description as string;
    expect(desc).toContain('Project type: Large-loss storm event');
    expect(desc).toContain('Hail damage from last week');
    // The project type line must come BEFORE the free-text description.
    expect(desc.indexOf('Project type:')).toBeLessThan(desc.indexOf('Hail damage'));

    expect(payload.data.firstName).toBe('Alex');
    expect(payload.data.lastName).toBe('Rivera');
    expect(payload.data.phone).toBe('4045550001');
    expect(payload.data.email).toBe('alex@example.com');
    expect(payload.data.addressLine1).toBe('123 Oak Dr');
    expect(payload.data.city).toBe('Dallas');
    expect(payload.data.state).toBe('TX');
    expect(payload.data.postalCode).toBe('75001');
  });

  it('prepends project type label even when description is blank', () => {
    renderPage();

    fireEvent.change(screen.getByLabelText(/first name/i), { target: { value: 'Sam' } });
    fireEvent.change(screen.getByLabelText(/phone/i), { target: { value: '4045550002' } });
    fireEvent.change(screen.getByLabelText(/street address/i), { target: { value: '456 Elm St' } });
    fireEvent.change(screen.getByLabelText(/city/i), { target: { value: 'Austin' } });
    fireEvent.change(screen.getByLabelText(/state/i), { target: { value: 'TX' } });
    fireEvent.change(screen.getByLabelText(/zip/i), { target: { value: '78701' } });

    // "commercial" → intent:'replacement'
    fireEvent.click(screen.getByRole('radio', { name: /commercial roofing/i }));

    fireEvent.click(screen.getByRole('button', { name: /send travel quote request/i }));

    expect(mutateArgs).not.toBeNull();
    const [payload] = mutateArgs as [{ data: Record<string, unknown> }, unknown];
    expect(payload.data.intent).toBe('replacement');
    expect(payload.data.description).toBe('Project type: Commercial roofing');
  });

  it('shows the success banner after the mutation resolves', () => {
    renderPage();

    fireEvent.change(screen.getByLabelText(/first name/i), { target: { value: 'Jordan' } });
    fireEvent.change(screen.getByLabelText(/phone/i), { target: { value: '4045550003' } });
    fireEvent.change(screen.getByLabelText(/street address/i), { target: { value: '789 Pine Ave' } });
    fireEvent.change(screen.getByLabelText(/city/i), { target: { value: 'Nashville' } });
    fireEvent.change(screen.getByLabelText(/state/i), { target: { value: 'TN' } });
    fireEvent.change(screen.getByLabelText(/zip/i), { target: { value: '37201' } });
    fireEvent.click(screen.getByRole('radio', { name: /insurance claim support/i }));

    fireEvent.click(screen.getByRole('button', { name: /send travel quote request/i }));

    // Form is visible before the mutation resolves.
    expect(screen.queryByRole('status')).toBeNull();

    // Trigger onSuccess.
    act(() => {
      onSuccessCb?.();
    });

    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Request received');
  });

  it('shows a validation error and does not submit when required fields are missing', () => {
    renderPage();

    // Do not fill anything in.
    fireEvent.click(screen.getByRole('button', { name: /send travel quote request/i }));

    expect(mutateArgs).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('first name');
  });

  it('shows an address error when address fields are incomplete', () => {
    renderPage();

    fireEvent.change(screen.getByLabelText(/first name/i), { target: { value: 'Pat' } });
    fireEvent.change(screen.getByLabelText(/phone/i), { target: { value: '4045550004' } });
    // Leave address blank.

    fireEvent.click(screen.getByRole('button', { name: /send travel quote request/i }));

    expect(mutateArgs).toBeNull();
    expect(screen.getByRole('alert').textContent).toMatch(/address/i);
  });
});
