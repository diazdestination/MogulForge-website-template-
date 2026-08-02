import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import {
  activitiesTable,
  contactsTable,
  db,
  leadsTable,
  organizationsTable,
  usersTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";

import app from "../../app";
import { createSession } from "../../lib/auth";

/**
 * Route-level scoping tests for DELETE /v1/leads/:id/photos.
 *
 * The endpoint calls removeLeadPhoto which enforces both org-id and lead-id
 * scoping. These tests lock in that boundary so a future regression can't
 * silently allow one org to delete another org's photos, or a rep to delete a
 * photo from a lead they didn't intend.
 */

const stamp = Date.now();

let server: Server;
let baseUrl: string;

// Org A — the attacker's org
let orgA: { id: string };
let orgARepSid: string;

// Org B — the victim's org
let orgB: { id: string };

// Leads
let orgALead: { id: string };
let orgAOtherLead: { id: string };
let orgBLead: { id: string };

// Photo paths
const PHOTO_PATH_ORG_B = `/objects/uploads/photo-delete-orgb-${stamp}`;
const PHOTO_PATH_ORG_A_OTHER = `/objects/uploads/photo-delete-orga-other-${stamp}`;
const PHOTO_PATH_LAST = `/objects/uploads/photo-delete-last-${stamp}`;
const PHOTO_PATH_FIRST = `/objects/uploads/photo-delete-first-${stamp}`;
const PHOTO_PATH_SECOND = `/objects/uploads/photo-delete-second-${stamp}`;

async function makeRepSession(orgId: string, suffix: string) {
  const [user] = await db
    .insert(usersTable)
    .values({
      email: `photo-delete-rep-${suffix}-${stamp}@example.com`,
      organizationId: orgId,
      role: "sales_rep",
    })
    .returning();
  return createSession({
    user: {
      id: user.id,
      email: null,
      firstName: null,
      lastName: null,
      profileImageUrl: null,
    },
    access_token: "test-token",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });
}

async function makeLead(orgId: string, firstName: string) {
  const [contact] = await db
    .insert(contactsTable)
    .values({ organizationId: orgId, firstName, lastName: "PhotoDelete" })
    .returning();
  const [lead] = await db
    .insert(leadsTable)
    .values({ organizationId: orgId, contactId: contact.id })
    .returning();
  return lead;
}

async function seedPhotosActivity(
  orgId: string,
  leadId: string,
  contactId: string,
  actorUserId: string,
  photoPaths: string[],
) {
  const n = photoPaths.length;
  const [activity] = await db
    .insert(activitiesTable)
    .values({
      organizationId: orgId,
      leadId,
      contactId,
      actorUserId,
      type: "photos_attached",
      title: `Rep attached ${n} photo${n === 1 ? "" : "s"}`,
      metadata: { photoPaths },
    })
    .returning();
  return activity;
}

function deletePhoto(
  leadId: string,
  objectPath: string,
  sid: string,
): Promise<Response> {
  return fetch(`${baseUrl}/v1/leads/${encodeURIComponent(leadId)}/photos`, {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${sid}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ objectPath }),
  });
}

beforeAll(async () => {
  const [oA] = await db
    .insert(organizationsTable)
    .values({ name: "Photo Delete Org A", slug: `photo-delete-a-${stamp}` })
    .returning();
  orgA = oA;

  const [oB] = await db
    .insert(organizationsTable)
    .values({ name: "Photo Delete Org B", slug: `photo-delete-b-${stamp}` })
    .returning();
  orgB = oB;

  orgARepSid = await makeRepSession(orgA.id, "a");

  orgALead = await makeLead(orgA.id, "Alice");
  orgAOtherLead = await makeLead(orgA.id, "OtherAlice");
  orgBLead = await makeLead(orgB.id, "Bob");

  // Seed a photo on org B's lead so org A can try (and fail) to delete it.
  const [orgBUser] = await db
    .insert(usersTable)
    .values({
      email: `photo-delete-rep-b-${stamp}@example.com`,
      organizationId: orgB.id,
      role: "sales_rep",
    })
    .returning();
  await seedPhotosActivity(
    orgB.id,
    orgBLead.id,
    // contactId comes from the lead; re-query to get it
    (await db.select().from(leadsTable).where(eq(leadsTable.id, orgBLead.id)))[0]
      .contactId,
    orgBUser.id,
    [PHOTO_PATH_ORG_B],
  );

  // Seed a photo on org A's OTHER lead so the rep can try to delete it via
  // orgALead (wrong lead, same org).
  const [orgAUser] = await db
    .insert(usersTable)
    .values({
      email: `photo-delete-actor-a-${stamp}@example.com`,
      organizationId: orgA.id,
      role: "sales_rep",
    })
    .returning();
  await seedPhotosActivity(
    orgA.id,
    orgAOtherLead.id,
    (
      await db
        .select()
        .from(leadsTable)
        .where(eq(leadsTable.id, orgAOtherLead.id))
    )[0].contactId,
    orgAUser.id,
    [PHOTO_PATH_ORG_A_OTHER],
  );

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await deleteTestOrgs(orgA.id, orgB.id);
});

describe("DELETE /v1/leads/:id/photos — cross-org isolation", () => {
  it("returns 400 when a rep tries to delete a photo belonging to another org's lead", async () => {
    // org A rep targets org B's lead — the route first does getLead with the
    // rep's orgId, which returns null → 404, but even if the URL leadId were
    // org A's, the photo path doesn't exist there → 400.
    //
    // We target org B's lead directly so the isolation is unmistakeable.
    const res = await deletePhoto(orgBLead.id, PHOTO_PATH_ORG_B, orgARepSid);
    // The lead doesn't belong to org A, so the route returns 404.
    expect(res.status).toBe(404);
  });

  it("returns 400 when a rep targets the correct lead but a photo from a different lead in the same org", async () => {
    // The photo is on orgAOtherLead but we pass orgALead in the URL.
    // removeLeadPhoto scopes the activity lookup to leadId, so it won't find
    // the photo on this lead and returns false → route returns 400.
    const res = await deletePhoto(
      orgALead.id,
      PHOTO_PATH_ORG_A_OTHER,
      orgARepSid,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/not found/i);

    // Sanity: the photo is still present on its actual lead.
    const activities = await db
      .select()
      .from(activitiesTable)
      .where(
        and(
          eq(activitiesTable.leadId, orgAOtherLead.id),
          eq(activitiesTable.type, "photos_attached"),
        ),
      );
    const allPaths = activities.flatMap(
      (a) => (a.metadata as { photoPaths?: string[] }).photoPaths ?? [],
    );
    expect(allPaths).toContain(PHOTO_PATH_ORG_A_OTHER);
  });
});

describe("DELETE /v1/leads/:id/photos — activity lifecycle", () => {
  it("deletes the activity row entirely when the last photo is removed", async () => {
    // Seed a fresh lead with a single-photo activity.
    const lead = await makeLead(orgA.id, "LastPhoto");
    const [actor] = await db
      .insert(usersTable)
      .values({
        email: `photo-delete-last-actor-${stamp}@example.com`,
        organizationId: orgA.id,
        role: "sales_rep",
      })
      .returning();
    const actorSid = await createSession({
      user: {
        id: actor.id,
        email: null,
        firstName: null,
        lastName: null,
        profileImageUrl: null,
      },
      access_token: "test-token",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });

    const leadRow = (
      await db.select().from(leadsTable).where(eq(leadsTable.id, lead.id))
    )[0];
    const activity = await seedPhotosActivity(
      orgA.id,
      lead.id,
      leadRow.contactId,
      actor.id,
      [PHOTO_PATH_LAST],
    );

    const res = await deletePhoto(lead.id, PHOTO_PATH_LAST, actorSid);
    expect(res.status).toBe(204);

    // The activity row must be gone.
    const remaining = await db
      .select()
      .from(activitiesTable)
      .where(eq(activitiesTable.id, activity.id));
    expect(remaining).toHaveLength(0);
  });

  it("updates photoPaths and the title when a non-last photo is removed", async () => {
    // Seed a fresh lead with a two-photo activity.
    const lead = await makeLead(orgA.id, "TwoPhotos");
    const [actor] = await db
      .insert(usersTable)
      .values({
        email: `photo-delete-two-actor-${stamp}@example.com`,
        organizationId: orgA.id,
        role: "sales_rep",
      })
      .returning();
    const actorSid = await createSession({
      user: {
        id: actor.id,
        email: null,
        firstName: null,
        lastName: null,
        profileImageUrl: null,
      },
      access_token: "test-token",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });

    const leadRow = (
      await db.select().from(leadsTable).where(eq(leadsTable.id, lead.id))
    )[0];
    const activity = await seedPhotosActivity(
      orgA.id,
      lead.id,
      leadRow.contactId,
      actor.id,
      [PHOTO_PATH_FIRST, PHOTO_PATH_SECOND],
    );

    const res = await deletePhoto(lead.id, PHOTO_PATH_FIRST, actorSid);
    expect(res.status).toBe(204);

    // The activity must still exist but with only the second path.
    const [updated] = await db
      .select()
      .from(activitiesTable)
      .where(eq(activitiesTable.id, activity.id));
    expect(updated).toBeDefined();
    const paths = (updated.metadata as { photoPaths?: string[] }).photoPaths;
    expect(paths).toEqual([PHOTO_PATH_SECOND]);
    expect(updated.title).toBe("Rep attached 1 photo");
  });
});
