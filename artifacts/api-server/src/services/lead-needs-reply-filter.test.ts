import {
  activitiesTable,
  contactsTable,
  db,
  leadsTable,
  organizationsTable,
  usersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";

import * as crm from "./crm";

/**
 * Confirms that hasUnreadPortalMessage is applied server-side by the
 * listLeads service function, not client-side.
 *
 * Key scenario: there are MORE than PAGE_SIZE (200) leads in the org.
 * A handful of them have unread portal messages. Calling listLeads with
 * hasUnreadPortalMessage:true must return exactly those leads — even though
 * they would be invisible to a client-side filter applied to the first 200
 * rows (which might not include any unread leads at all).
 */

const TOTAL = 205; // deliberately > MAX_LEAD_PAGE_SIZE (200)
const UNREAD_COUNT = 4; // unread leads seeded at known offsets

let org: { id: string };
let allIds: string[] = [];
let unreadIds: Set<string>;

beforeAll(async () => {
  const slug = `test-needs-reply-filter-${Date.now()}`;
  await db.delete(organizationsTable).where(eq(organizationsTable.slug, slug));
  const [o] = await db
    .insert(organizationsTable)
    .values({ name: "NeedsReply Org", slug })
    .returning();
  org = o;

  const [u] = await db
    .insert(usersTable)
    .values({ organizationId: org.id })
    .returning();

  const [contact] = await db
    .insert(contactsTable)
    .values({ organizationId: org.id, firstName: "Reply", lastName: "Test" })
    .returning();

  // Insert TOTAL leads with distinct createdAt so ordering is deterministic.
  const base = Date.parse("2025-06-01T00:00:00Z");
  const values = Array.from({ length: TOTAL }, (_, i) => ({
    organizationId: org.id,
    contactId: contact.id,
    createdAt: new Date(base + i * 1000),
  }));
  const rows = await db
    .insert(leadsTable)
    .values(values)
    .returning({ id: leadsTable.id });
  expect(rows).toHaveLength(TOTAL);
  allIds = rows.map((r) => r.id);

  // Mark UNREAD_COUNT leads as having an unread portal message.
  // Spread them across the list to make sure some fall beyond page 1 of 200
  // — specifically pick indexes 0, 50, 150, and 204 (the very last one).
  const unreadIndexes = [0, 50, 150, TOTAL - 1];
  expect(unreadIndexes).toHaveLength(UNREAD_COUNT);
  unreadIds = new Set(unreadIndexes.map((i) => allIds[i]));

  const now = new Date(base + TOTAL * 1000 + 1000);
  const activityValues = unreadIndexes.map((i) => ({
    organizationId: org.id,
    leadId: allIds[i],
    actorUserId: u.id,
    type: "portal_message",
    title: "Homeowner sent a message",
    occurredAt: now,
  }));
  await db.insert(activitiesTable).values(activityValues);
});

afterAll(async () => {
  await deleteTestOrgs(org?.id);
});

describe("listLeads — hasUnreadPortalMessage server-side filter", () => {
  it("returns only unread leads when hasUnreadPortalMessage:true, regardless of total count > PAGE_SIZE", async () => {
    // Without the filter the first page returns 200 leads.
    const firstPage = await crm.listLeads(org.id, { limit: 200, offset: 0 });
    expect(firstPage).toHaveLength(200);

    // With the server-side filter, all UNREAD_COUNT unread leads are returned
    // in a single call — even those that fall beyond position 200 in the
    // unfiltered list.
    const unreadPage = await crm.listLeads(org.id, {
      hasUnreadPortalMessage: true,
    });
    expect(unreadPage).toHaveLength(UNREAD_COUNT);
    const returnedIds = new Set(unreadPage.map((l) => l.id));
    for (const id of unreadIds) {
      expect(returnedIds.has(id)).toBe(true);
    }
    // Every returned lead must actually have the flag set.
    for (const lead of unreadPage) {
      expect(lead.hasUnreadPortalMessage).toBe(true);
    }
  });

  it("confirms the last lead (beyond page 1) is included when unread", async () => {
    // allIds is sorted by insertion order; the lead at index TOTAL-1 has the
    // earliest createdAt so it lands at position TOTAL in desc order — well
    // beyond the default page of 200.  With the server-side filter it must
    // still appear.
    const lastLeadId = allIds[TOTAL - 1];
    const unreadPage = await crm.listLeads(org.id, {
      hasUnreadPortalMessage: true,
    });
    const returnedIds = new Set(unreadPage.map((l) => l.id));
    expect(returnedIds.has(lastLeadId)).toBe(true);
  });

  it("returns an empty list when no leads have unread messages", async () => {
    const slug = `test-needs-reply-empty-${Date.now()}`;
    const [emptyOrg] = await db
      .insert(organizationsTable)
      .values({ name: "Empty NeedsReply Org", slug })
      .returning();
    try {
      const [contact] = await db
        .insert(contactsTable)
        .values({
          organizationId: emptyOrg.id,
          firstName: "No",
          lastName: "Messages",
        })
        .returning();
      await db.insert(leadsTable).values([
        { organizationId: emptyOrg.id, contactId: contact.id },
        { organizationId: emptyOrg.id, contactId: contact.id },
      ]);

      const result = await crm.listLeads(emptyOrg.id, {
        hasUnreadPortalMessage: true,
      });
      expect(result).toHaveLength(0);
    } finally {
      await deleteTestOrgs(emptyOrg.id);
    }
  });

  it("omits a lead once the team replies (team_message newer than portal_message)", async () => {
    const slug = `test-needs-reply-replied-${Date.now()}`;
    const [replyOrg] = await db
      .insert(organizationsTable)
      .values({ name: "Replied Org", slug })
      .returning();
    try {
      const [u] = await db
        .insert(usersTable)
        .values({ organizationId: replyOrg.id })
        .returning();
      const [contact] = await db
        .insert(contactsTable)
        .values({ organizationId: replyOrg.id, firstName: "R", lastName: "Test" })
        .returning();
      const [lead] = await db
        .insert(leadsTable)
        .values({ organizationId: replyOrg.id, contactId: contact.id })
        .returning();

      const t1 = new Date("2025-01-01T10:00:00Z");
      const t2 = new Date("2025-01-01T11:00:00Z"); // team reply is later

      await db.insert(activitiesTable).values([
        {
          organizationId: replyOrg.id,
          leadId: lead.id,
          actorUserId: u.id,
          type: "portal_message",
          title: "Homeowner message",
          occurredAt: t1,
        },
        {
          organizationId: replyOrg.id,
          leadId: lead.id,
          actorUserId: u.id,
          type: "team_message",
          title: "Team replied",
          occurredAt: t2,
        },
      ]);

      const result = await crm.listLeads(replyOrg.id, {
        hasUnreadPortalMessage: true,
      });
      expect(result).toHaveLength(0);
    } finally {
      await deleteTestOrgs(replyOrg.id);
    }
  });
});
