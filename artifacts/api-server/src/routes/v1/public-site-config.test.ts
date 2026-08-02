import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { db, orgSettingsTable, type OrgSettings } from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import app from "../../app";
import { getDefaultOrganization } from "../../services/org";
import { getOrgSettings, updateOrgSettings } from "../../services/settings";

/**
 * Contract test for GET /v1/public/site-config: the website renders its
 * nav/listings from this payload, so it must return ONLY active services
 * and service areas plus the business profile. A regression here would
 * silently re-show deactivated services on the live site.
 *
 * The endpoint always reads the default organization's settings, so we
 * snapshot the current row and restore it after the test run.
 */

let server: Server;
let baseUrl: string;
let orgId: string;
let originalSettings: Pick<
  OrgSettings,
  "businessProfile" | "services" | "serviceAreas"
>;

const PROFILE = {
  businessName: "Site Config Test Roofing",
  phone: "(555) 010-0198",
  city: "Canton",
  state: "GA",
  postalCode: "30115",
  hours: "24/7",
  emergencyAvailability: true,
};

const SERVICES = [
  { slug: "roof-replacement", name: "Roof Replacement", isActive: true },
  { slug: "roof-repair", name: "Roof Repair", isActive: false },
  { slug: "storm-damage", name: "Storm Damage Restoration", isActive: true },
  { slug: "gutter-cleaning", name: "Gutter Cleaning", isActive: false },
];

const AREAS = [
  { slug: "canton-ga", name: "Canton", state: "GA", isActive: true },
  { slug: "woodstock-ga", name: "Woodstock", state: "GA", isActive: false },
  { slug: "marietta-ga", name: "Marietta", state: "GA", isActive: true },
];

beforeAll(async () => {
  const org = await getDefaultOrganization();
  orgId = org.id;
  const current = await getOrgSettings(orgId);
  originalSettings = {
    businessProfile: current.businessProfile,
    services: current.services,
    serviceAreas: current.serviceAreas,
  };

  await updateOrgSettings(orgId, {
    businessProfile: PROFILE,
    services: SERVICES,
    serviceAreas: AREAS,
  });

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterAll(async () => {
  // Restore the pre-test settings so other tests / dev data are untouched.
  await db
    .update(orgSettingsTable)
    .set(originalSettings)
    .where(eq(orgSettingsTable.organizationId, orgId));
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("GET /v1/public/site-config", () => {
  it("returns the business profile and only active services and areas", async () => {
    const res = await fetch(`${baseUrl}/v1/public/site-config`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      businessProfile: Record<string, unknown>;
      services: Array<{ slug: string; isActive: boolean }>;
      serviceAreas: Array<{ slug: string; isActive: boolean }>;
    };

    expect(body.businessProfile).toMatchObject(PROFILE);

    // Only active services, in config order — deactivated ones are hidden.
    expect(body.services.map((s) => s.slug)).toEqual([
      "roof-replacement",
      "storm-damage",
    ]);
    expect(body.services.every((s) => s.isActive)).toBe(true);
    expect(body.services.map((s) => s.slug)).not.toContain("roof-repair");
    expect(body.services.map((s) => s.slug)).not.toContain("gutter-cleaning");

    // Only active areas, in config order.
    expect(body.serviceAreas.map((a) => a.slug)).toEqual([
      "canton-ga",
      "marietta-ga",
    ]);
    expect(body.serviceAreas.every((a) => a.isActive)).toBe(true);
    expect(body.serviceAreas.map((a) => a.slug)).not.toContain("woodstock-ga");
  });
});
