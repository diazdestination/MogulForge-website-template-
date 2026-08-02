import { createHash } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  activitiesTable,
  automationRunsTable,
  automationsTable,
  contactsTable,
  db,
  leadsTable,
  organizationsTable,
  portalSessionsTable,
  usersTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";

import app from "../../app";
import { ObjectStorageService } from "../../lib/objectStorage";

/**
 * Route-level tests for POST /v1/portal/claims/:id/photos — the homeowner
 * "add more damage photos" endpoint. Auth, ownership, and object validation
 * are all enforced server-side.
 */

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// Smallest valid PNG (1x1 transparent pixel).
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

let server: Server;
let baseUrl: string;
let org: { id: string };
let token: string;
let lead: { id: string };
let otherLead: { id: string };
let uploadedImagePath: string;
let uploadedTextPath: string;

const EMAIL = `portal-add-photo-${Date.now()}@example.com`;
const EMAIL_OTHER = `portal-add-photo-other-${Date.now()}@example.com`;

beforeAll(async () => {
  const [o] = await db
    .insert(organizationsTable)
    .values({
      name: "Portal Add Photo Org",
      slug: `portal-add-photo-${Date.now()}`,
    })
    .returning();
  org = o;

  const [contact] = await db
    .insert(contactsTable)
    .values({ organizationId: org.id, firstName: "Pat", email: EMAIL })
    .returning();
  const [otherContact] = await db
    .insert(contactsTable)
    .values({ organizationId: org.id, firstName: "Sam", email: EMAIL_OTHER })
    .returning();
  [lead] = await db
    .insert(leadsTable)
    .values({ organizationId: org.id, contactId: contact.id })
    .returning();
  [otherLead] = await db
    .insert(leadsTable)
    .values({ organizationId: org.id, contactId: otherContact.id })
    .returning();

  // Upload a real image and a non-image object to exercise validation.
  const storage = new ObjectStorageService();
  const imageUrl = await storage.getObjectEntityUploadURL();
  const putImage = await fetch(imageUrl, {
    method: "PUT",
    headers: { "content-type": "image/png" },
    body: PNG_BYTES,
  });
  if (!putImage.ok) throw new Error(`test upload failed: ${putImage.status}`);
  uploadedImagePath = storage.normalizeObjectEntityPath(imageUrl);

  const textUrl = await storage.getObjectEntityUploadURL();
  const putText = await fetch(textUrl, {
    method: "PUT",
    headers: { "content-type": "text/plain" },
    body: "not an image",
  });
  if (!putText.ok) throw new Error(`test upload failed: ${putText.status}`);
  uploadedTextPath = storage.normalizeObjectEntityPath(textUrl);

  token = `portal-add-photo-token-${Date.now()}`;
  await db.insert(portalSessionsTable).values({
    organizationId: org.id,
    tokenHash: sha256(token),
    identifier: EMAIL,
    channel: "email",
    expiresAt: new Date(Date.now() + 60_000),
  });

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await deleteTestOrgs(org.id);
});

function post(
  leadId: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl}/v1/portal/claims/${leadId}/photos`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/portal/claims/:id/photos", () => {
  it("rejects requests without a portal session (401)", async () => {
    const res = await post(lead.id, { photoPaths: [uploadedImagePath] });
    expect(res.status).toBe(401);
  });

  it("rejects an invalid body (400)", async () => {
    const res = await post(
      lead.id,
      { photoPaths: [] },
      { "x-portal-token": token },
    );
    expect(res.status).toBe(400);
  });

  it("rejects a non-image object (400)", async () => {
    const res = await post(
      lead.id,
      { photoPaths: [uploadedTextPath] },
      { "x-portal-token": token },
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 for another homeowner's claim, even in the same org", async () => {
    const res = await post(
      otherLead.id,
      { photoPaths: [uploadedImagePath] },
      { "x-portal-token": token },
    );
    expect(res.status).toBe(404);
  });

  it("attaches a valid photo to the homeowner's own claim (201) and records a photos_attached activity", async () => {
    const res = await post(
      lead.id,
      { photoPaths: [uploadedImagePath] },
      { "x-portal-token": token },
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ attached: 1 });

    const activities = await db
      .select()
      .from(activitiesTable)
      .where(
        and(
          eq(activitiesTable.leadId, lead.id),
          eq(activitiesTable.type, "photos_attached"),
        ),
      );
    expect(activities).toHaveLength(1);
    expect(
      (activities[0].metadata as { photoPaths?: string[] }).photoPaths,
    ).toEqual([uploadedImagePath]);

    // The newly attached photo is now streamable through the portal gallery.
    const photoRes = await fetch(
      `${baseUrl}/v1/portal/photos${uploadedImagePath}`,
      { headers: { "x-portal-token": token } },
    );
    expect(photoRes.status).toBe(200);
  });

  it("re-attaching the same photo is a no-op, not a duplicate", async () => {
    const res = await post(
      lead.id,
      { photoPaths: [uploadedImagePath] },
      { "x-portal-token": token },
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ attached: 0 });

    const activities = await db
      .select()
      .from(activitiesTable)
      .where(
        and(
          eq(activitiesTable.leadId, lead.id),
          eq(activitiesTable.type, "photos_attached"),
        ),
      );
    expect(activities).toHaveLength(1);
  });
});

describe("team alerts when a homeowner adds photos", () => {
  async function waitFor<T>(
    fn: () => Promise<T | undefined>,
    ms = 5000,
  ): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v !== undefined) return v;
      if (Date.now() > deadline)
        throw new Error("timed out waiting for condition");
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  it("emails the assigned rep and fires portal.photos_added with the photo count", async () => {
    const { addPortalClaimPhotos } = await import("../../services/portal");
    const { providers } = await import("../../services/providers");

    // Fresh claim for the same homeowner so the cap tests above don't interfere.
    const [contact] = await db
      .select()
      .from(contactsTable)
      .where(
        and(
          eq(contactsTable.organizationId, org.id),
          eq(contactsTable.email, EMAIL),
        ),
      );
    const [alertLead] = await db
      .insert(leadsTable)
      .values({ organizationId: org.id, contactId: contact.id })
      .returning();
    const [rep] = await db
      .insert(usersTable)
      .values({
        email: `photo-rep-${Date.now()}@example.com`,
        firstName: "Rita",
        organizationId: org.id,
        role: "sales_rep",
      })
      .returning();
    await db
      .update(leadsTable)
      .set({ assignedUserId: rep.id })
      .where(eq(leadsTable.id, alertLead.id));

    // Automation rule matching the new event, so admins can wire their own.
    const [rule] = await db
      .insert(automationsTable)
      .values({
        organizationId: org.id,
        name: "New portal photos task",
        event: "portal.photos_added",
        conditions: { "photos.source": "homeowner-portal" },
        actions: [
          { type: "create_task", params: { title: "Review new damage photos" } },
        ],
        isActive: true,
      })
      .returning();

    const sendSpy = vi
      .spyOn(providers.email, "send")
      .mockResolvedValue({ id: "test-email", provider: "mock-email" });
    try {
      const session = {
        organizationId: org.id,
        identifier: EMAIL,
        channel: "email",
      } as Parameters<typeof addPortalClaimPhotos>[0]["session"];
      const attached = await addPortalClaimPhotos({
        session,
        leadId: alertLead.id,
        photoPaths: ["/objects/uploads/alert-1", "/objects/uploads/alert-2"],
      });
      expect(attached).toBe(2);

      // Rep email includes lead name, photo count, and CRM link.
      expect(sendSpy).toHaveBeenCalledTimes(1);
      const [to, subject, body] = sendSpy.mock.calls[0];
      expect(to).toBe(rep.email);
      expect(subject).toContain("Pat");
      expect(subject).toContain("2");
      expect(body).toContain("2 new damage photos");
      expect(body).toContain(`/leads/${alertLead.id}`);

      // The automation rule ran (event is fire-and-forget, so poll).
      const run = await waitFor(async () => {
        const [r] = await db
          .select()
          .from(automationRunsTable)
          .where(eq(automationRunsTable.automationId, rule.id));
        return r;
      });
      expect(run.event).toBe("portal.photos_added");
      expect(run.entityId).toBe(alertLead.id);
      expect(run.status).toBe("success");
    } finally {
      sendSpy.mockRestore();
    }
  });

  it("falls back to emailing org admins when the lead has no assigned rep", async () => {
    const { addPortalClaimPhotos } = await import("../../services/portal");
    const { providers } = await import("../../services/providers");

    const [contact] = await db
      .select()
      .from(contactsTable)
      .where(
        and(
          eq(contactsTable.organizationId, org.id),
          eq(contactsTable.email, EMAIL),
        ),
      );
    const [unassignedLead] = await db
      .insert(leadsTable)
      .values({ organizationId: org.id, contactId: contact.id })
      .returning();

    // Seed an org admin so the fallback has a recipient.
    const [admin] = await db
      .insert(usersTable)
      .values({
        email: `photo-admin-${Date.now()}@example.com`,
        firstName: "Ada",
        organizationId: org.id,
        role: "owner",
      })
      .returning();

    const sendSpy = vi
      .spyOn(providers.email, "send")
      .mockResolvedValue({ id: "test-admin-email", provider: "mock-email" });
    try {
      const session = {
        organizationId: org.id,
        identifier: EMAIL,
        channel: "email",
      } as Parameters<typeof addPortalClaimPhotos>[0]["session"];
      const attached = await addPortalClaimPhotos({
        session,
        leadId: unassignedLead.id,
        photoPaths: ["/objects/uploads/unassigned-1"],
      });
      expect(attached).toBe(1);

      // Admin receives the fallback email instead of a rep.
      expect(sendSpy).toHaveBeenCalledTimes(1);
      const [to, subject, body] = sendSpy.mock.calls[0];
      expect(to).toBe(admin.email);
      expect(subject).toContain("photo");
      expect(body).toContain("Pat");
      expect(body).toContain(`/leads/${unassignedLead.id}`);
    } finally {
      sendSpy.mockRestore();
    }
  });

  it("never blocks the upload even when the admin fallback email fails", async () => {
    const { addPortalClaimPhotos } = await import("../../services/portal");
    const { providers } = await import("../../services/providers");

    const [contact] = await db
      .select()
      .from(contactsTable)
      .where(
        and(
          eq(contactsTable.organizationId, org.id),
          eq(contactsTable.email, EMAIL),
        ),
      );
    const [unassignedLead] = await db
      .insert(leadsTable)
      .values({ organizationId: org.id, contactId: contact.id })
      .returning();

    // admin user already present from the previous test; smtp is down here.
    const sendSpy = vi
      .spyOn(providers.email, "send")
      .mockRejectedValue(new Error("smtp down"));
    try {
      const session = {
        organizationId: org.id,
        identifier: EMAIL,
        channel: "email",
      } as Parameters<typeof addPortalClaimPhotos>[0]["session"];
      const attached = await addPortalClaimPhotos({
        session,
        leadId: unassignedLead.id,
        photoPaths: ["/objects/uploads/unassigned-fallback-fail"],
      });
      // Photos are persisted regardless of the notification outcome.
      expect(attached).toBe(1);
    } finally {
      sendSpy.mockRestore();
    }
  });
});

describe("per-claim photo cap", () => {
  it("rejects attachments once the claim would exceed the cap", async () => {
    const { addPortalClaimPhotos } = await import("../../services/portal");
    const session = {
      organizationId: org.id,
      identifier: EMAIL,
      channel: "email",
    } as Parameters<typeof addPortalClaimPhotos>[0]["session"];

    // Cap lowered to 3 for the test; 1 photo already attached above.
    const first = await addPortalClaimPhotos({
      session,
      leadId: lead.id,
      photoPaths: ["/objects/uploads/cap-a", "/objects/uploads/cap-b"],
      maxPhotosPerClaim: 3,
    });
    expect(first).toBe(2);

    const over = await addPortalClaimPhotos({
      session,
      leadId: lead.id,
      photoPaths: ["/objects/uploads/cap-c"],
      maxPhotosPerClaim: 3,
    });
    expect(over).toBe("limit_exceeded");

    // Nothing was written for the rejected batch.
    const activities = await db
      .select()
      .from(activitiesTable)
      .where(
        and(
          eq(activitiesTable.leadId, lead.id),
          eq(activitiesTable.type, "photos_attached"),
        ),
      );
    const allPaths = activities.flatMap(
      (a) => (a.metadata as { photoPaths?: string[] }).photoPaths ?? [],
    );
    expect(allPaths).not.toContain("/objects/uploads/cap-c");
    expect(allPaths).toHaveLength(3);
  });

  it("concurrent attaches cannot race past the cap", async () => {
    const { addPortalClaimPhotos } = await import("../../services/portal");
    const session = {
      organizationId: org.id,
      identifier: EMAIL,
      channel: "email",
    } as Parameters<typeof addPortalClaimPhotos>[0]["session"];

    // 3 photos already attached; cap 5 leaves room for exactly one 2-photo
    // batch. Fire two 2-photo batches at once: exactly one must win.
    const results = await Promise.all([
      addPortalClaimPhotos({
        session,
        leadId: lead.id,
        photoPaths: ["/objects/uploads/race-a1", "/objects/uploads/race-a2"],
        maxPhotosPerClaim: 5,
      }),
      addPortalClaimPhotos({
        session,
        leadId: lead.id,
        photoPaths: ["/objects/uploads/race-b1", "/objects/uploads/race-b2"],
        maxPhotosPerClaim: 5,
      }),
    ]);
    expect(results.filter((r) => r === 2)).toHaveLength(1);
    expect(results.filter((r) => r === "limit_exceeded")).toHaveLength(1);

    const activities = await db
      .select()
      .from(activitiesTable)
      .where(
        and(
          eq(activitiesTable.leadId, lead.id),
          eq(activitiesTable.type, "photos_attached"),
        ),
      );
    const allPaths = activities.flatMap(
      (a) => (a.metadata as { photoPaths?: string[] }).photoPaths ?? [],
    );
    expect(allPaths).toHaveLength(5);
  });

  it("route maps limit_exceeded to a friendly 400", async () => {
    // The claim now holds 5 photos; production cap is 50, so pad up to the
    // cap directly, then hit the real route once more.
    const { addPortalClaimPhotos, MAX_PORTAL_PHOTOS_PER_CLAIM } = await import(
      "../../services/portal"
    );
    const session = {
      organizationId: org.id,
      identifier: EMAIL,
      channel: "email",
    } as Parameters<typeof addPortalClaimPhotos>[0]["session"];
    const pad = Array.from(
      { length: MAX_PORTAL_PHOTOS_PER_CLAIM - 5 },
      (_, i) => `/objects/uploads/pad-${i}`,
    );
    // Pad in batches of 10 (service has no per-batch limit; the route does).
    for (let i = 0; i < pad.length; i += 10) {
      await addPortalClaimPhotos({
        session,
        leadId: lead.id,
        photoPaths: pad.slice(i, i + 10),
      });
    }

    // A genuinely new, valid image now bounces off the cap with a 400.
    const storage = new ObjectStorageService();
    const freshUrl = await storage.getObjectEntityUploadURL();
    const put = await fetch(freshUrl, {
      method: "PUT",
      headers: { "content-type": "image/png" },
      body: PNG_BYTES,
    });
    if (!put.ok) throw new Error(`test upload failed: ${put.status}`);
    const freshPath = storage.normalizeObjectEntityPath(freshUrl);

    const res = await post(
      lead.id,
      { photoPaths: [freshPath] },
      { "x-portal-token": token },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/maximum number of photos/i);
  });
});
