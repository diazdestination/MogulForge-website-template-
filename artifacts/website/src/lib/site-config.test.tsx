import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { SiteConfig } from '@/lib/site-config';
import { BUSINESS } from '@/lib/business';
import { SERVICES } from '@/content/services';
import { AREAS } from '@/content/areas';

// Mock the generated api-client hook so no network/query-client is needed.
const useGetPublicSiteConfig = vi.fn();
vi.mock('@workspace/api-client-react', () => ({
  useGetPublicSiteConfig: (...args: unknown[]) => useGetPublicSiteConfig(...args),
}));

// Import after the mock is registered.
const { SiteConfigProvider, useSiteConfig } = await import('@/lib/site-config');

let captured: SiteConfig | undefined;

function Capture() {
  captured = useSiteConfig();
  return <div data-testid="done" />;
}

function renderWithConfig(data: unknown) {
  useGetPublicSiteConfig.mockReturnValue({ data });
  render(
    <SiteConfigProvider>
      <Capture />
    </SiteConfigProvider>,
  );
  expect(screen.getByTestId('done')).toBeTruthy();
  return captured!;
}

beforeEach(() => {
  captured = undefined;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SiteConfigProvider merge logic', () => {
  it('falls back to full static config when no data is available', () => {
    const config = renderWithConfig(undefined);
    expect(config.services).toEqual(SERVICES);
    expect(config.areas).toEqual(AREAS);
    expect(config.business).toEqual(BUSINESS);
  });

  it('merges static copy by slug, with the config name winning', () => {
    const staticService = SERVICES[0];
    const config = renderWithConfig({
      businessProfile: {},
      services: [{ slug: staticService.slug, name: 'Renamed Service' }],
      serviceAreas: [],
    });

    expect(config.services).toHaveLength(1);
    const merged = config.services[0];
    expect(merged.name).toBe('Renamed Service');
    // Rich static copy is preserved.
    expect(merged.intro).toBe(staticService.intro);
    expect(merged.faqs).toEqual(staticService.faqs);
    expect(merged.process).toEqual(staticService.process);
    expect(config.servicesBySlug.get(staticService.slug)).toBe(merged);
  });

  it('keeps the static name when the config name is empty', () => {
    const staticService = SERVICES[0];
    const config = renderWithConfig({
      services: [{ slug: staticService.slug, name: '' }],
      serviceAreas: [],
    });
    expect(config.services[0].name).toBe(staticService.name);
  });

  it('builds a fallback entry for a config-only service', () => {
    const config = renderWithConfig({
      services: [{ slug: 'solar-panels', name: 'Solar Panels', description: 'Panels installed right.' }],
      serviceAreas: [],
    });

    expect(config.services).toHaveLength(1);
    const fallback = config.services[0];
    expect(fallback.slug).toBe('solar-panels');
    expect(fallback.name).toBe('Solar Panels');
    expect(fallback.shortName).toBe('Solar Panels');
    expect(fallback.teaser).toBe('Panels installed right.');
    expect(fallback.intro).toBe('Panels installed right.');
    expect(fallback.metaTitle).toContain('Solar Panels');
    expect(fallback.metaDescription).toContain(BUSINESS.name);
    // Empty-but-present structures so pages render without crashing.
    expect(fallback.problems).toEqual([]);
    expect(fallback.process).toEqual([]);
    expect(fallback.faqs).toEqual([]);
    expect(fallback.relatedSlugs).toEqual([]);
    expect(fallback.icon).toBeTruthy();
    expect(config.servicesBySlug.get('solar-panels')).toBe(fallback);
  });

  it('generates a generic teaser when a config-only service has no description', () => {
    const config = renderWithConfig({
      services: [{ slug: 'skylights', name: 'Skylights', description: '   ' }],
      serviceAreas: [],
    });
    expect(config.services[0].teaser).toBe('Skylights handled by our licensed, family-owned team.');
  });

  it('builds a fallback entry for a config-only area', () => {
    const config = renderWithConfig({
      services: [],
      serviceAreas: [{ slug: 'macon-ga', name: 'Macon', state: 'GA' }],
    });

    expect(config.areas).toHaveLength(1);
    const fallback = config.areas[0];
    expect(fallback.slug).toBe('macon-ga');
    expect(fallback.city).toBe('Macon');
    expect(fallback.metaTitle).toBe('Roofing Contractor in Macon, GA');
    expect(fallback.headline).toContain('Macon');
    expect(fallback.localContext).toContain('Macon');
    expect(fallback.commonNeeds).toEqual([]);
    expect(fallback.featuredServiceSlugs).toEqual([]);
    expect(config.areasBySlug.get('macon-ga')).toBe(fallback);
  });

  it('defaults a config-only area state to GA when omitted', () => {
    const config = renderWithConfig({
      services: [],
      serviceAreas: [{ slug: 'chattanooga-tn', name: 'Chattanooga' }],
    });
    expect(config.areas[0].metaTitle).toBe('Roofing Contractor in Chattanooga, GA');
  });

  it('merges static area copy by slug with the config name winning', () => {
    const staticArea = AREAS[0];
    const config = renderWithConfig({
      services: [],
      serviceAreas: [{ slug: staticArea.slug, name: 'Canton Renamed' }],
    });
    const merged = config.areas[0];
    expect(merged.city).toBe('Canton Renamed');
    expect(merged.localContext).toBe(staticArea.localContext);
    expect(merged.commonNeeds).toEqual(staticArea.commonNeeds);
  });

  it('overrides business profile fields, including derived phone variants', () => {
    const config = renderWithConfig({
      businessProfile: {
        businessName: 'Acme Roofing',
        phone: '(770) 555-1234',
        city: 'Marietta',
        state: 'TN',
        postalCode: '30060',
        hours: 'Mon–Fri 9–5',
        facebookUrl: 'https://facebook.com/acme',
      },
      services: [],
      serviceAreas: [],
    });

    expect(config.business.name).toBe('Acme Roofing');
    expect(config.business.legalName).toBe('Acme Roofing');
    expect(config.business.phone).toBe('(770) 555-1234');
    expect(config.business.phoneHref).toBe('tel:+17705551234');
    expect(config.business.phoneE164).toBe('+17705551234');
    expect(config.business.city).toBe('Marietta');
    expect(config.business.state).toBe('TN');
    expect(config.business.postalCode).toBe('30060');
    expect(config.business.hours).toBe('Mon–Fri 9–5');
    expect(config.business.facebook).toBe('https://facebook.com/acme');
    // Untouched static field survives.
    expect(config.business.tagline).toBe(BUSINESS.tagline);
  });

  it('falls back to static business fields for blank/missing profile values', () => {
    const config = renderWithConfig({
      businessProfile: { businessName: '   ', phone: '' },
      services: [],
      serviceAreas: [],
    });
    expect(config.business.name).toBe(BUSINESS.name);
    expect(config.business.phone).toBe(BUSINESS.phone);
    expect(config.business.phoneHref).toBe(BUSINESS.phoneHref);
    expect(config.business.phoneE164).toBe(BUSINESS.phoneE164);
  });

  it('keeps an already-E.164 phone number intact', () => {
    const config = renderWithConfig({
      businessProfile: { phone: '+441234567890' },
      services: [],
      serviceAreas: [],
    });
    expect(config.business.phoneE164).toBe('+441234567890');
    expect(config.business.phoneHref).toBe('tel:+441234567890');
  });
});
