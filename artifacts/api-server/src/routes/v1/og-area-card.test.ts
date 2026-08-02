import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { db, orgSettingsTable, type OrgSettings } from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import app from "../../app";
import { getDefaultOrganization } from "../../services/org";
import { getOrgSettings, updateOrgSettings } from "../../services/settings";

/**
 * GET /v1/public/og/area/:slug — server-rendered share card for service
 * areas. Areas added only through CRM site settings are not part of the
 * website's committed og-area-<slug>.png set, so their pages point og:image
 * at this endpoint. It must serve a real PNG for any active configured area
 * and 404 for inactive/unknown slugs (never a silent fallback image).
 */

let server: Server;
let baseUrl: string;
let orgId: string;
let originalSettings: Pick<
  OrgSettings,
  "businessProfile" | "serviceAreas"
>;

const AREAS = [
  // Config-only area (no static content / committed PNG on the website).
  { slug: "woodstock-ga", name: "Woodstock", state: "GA", isActive: true },
  { slug: "marietta-ga", name: "Marietta", isActive: false },
  // Static area — endpoint serves it too, though the website prefers its
  // committed card.
  { slug: "canton-ga", name: "Canton", state: "GA", isActive: true },
];

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

beforeAll(async () => {
  const org = await getDefaultOrganization();
  orgId = org.id;
  const current = await getOrgSettings(orgId);
  originalSettings = {
    businessProfile: current.businessProfile,
    serviceAreas: current.serviceAreas,
  };
  await updateOrgSettings(orgId, { serviceAreas: AREAS });

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterAll(async () => {
  await db
    .update(orgSettingsTable)
    .set(originalSettings)
    .where(eq(orgSettingsTable.organizationId, orgId));
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("GET /v1/public/og/area/:slug", () => {
  it("renders a PNG share card for a config-only active area", async () => {
    const res = await fetch(`${baseUrl}/v1/public/og/area/woodstock-ga.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("max-age");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
    // 1200x630 branded card is far bigger than an empty/blank PNG.
    expect(body.length).toBeGreaterThan(5_000);
  });

  it("also works without the .png suffix", async () => {
    const res = await fetch(`${baseUrl}/v1/public/og/area/canton-ga`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  it("404s for an inactive area", async () => {
    const res = await fetch(`${baseUrl}/v1/public/og/area/marietta-ga.png`);
    expect(res.status).toBe(404);
  });

  it("404s for an unknown slug", async () => {
    const res = await fetch(`${baseUrl}/v1/public/og/area/nowhere-ga.png`);
    expect(res.status).toBe(404);
  });
});
