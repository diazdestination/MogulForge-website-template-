import {
  activitiesTable,
  contactsTable,
  db,
  leadsTable,
  organizationsTable,
} from "@workspace/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";

import { getDashboardSummary } from "./crm";

let org: { id: string };
let contact: { id: string };
let leadUnanswered: { id: string };
let leadAnswered: { id: string };
let leadNoMessages: { id: string };

beforeAll(async () => {
  const [o] = await db
    .insert(organizationsTable)
    .values({ name: "Dash Portal Org", slug: `dash-portal-${Date.now()}` })
    .returning();
  org = o;
  const [c] = await db
    .insert(contactsTable)
    .values({ organizationId: org.id, firstName: "Dana", email: `dash-${Date.now()}@example.com` })
    .returning();
  contact = c;
  const mkLead = async () => {
    const [l] = await db
      .insert(leadsTable)
      .values({ organizationId: org.id, contactId: contact.id })
      .returning();
    return l;
  };
  leadUnanswered = await mkLead();
  leadAnswered = await mkLead();
  leadNoMessages = await mkLead();

  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60 * 1000);

  await db.insert(activitiesTable).values([
    // Unanswered: portal message is the newest activity on the lead.
    {
      organizationId: org.id,
      leadId: leadUnanswered.id,
      type: "note",
      title: "Team note",
      occurredAt: at(60),
    },
    {
      organizationId: org.id,
      leadId: leadUnanswered.id,
      type: "portal_message",
      title: "Message from homeowner (portal)",
      body: "When will you come out?",
      occurredAt: at(10),
    },
    // Answered: team activity is newer than the portal message.
    {
      organizationId: org.id,
      leadId: leadAnswered.id,
      type: "portal_message",
      title: "Message from homeowner (portal)",
      body: "Question",
      occurredAt: at(60),
    },
    {
      organizationId: org.id,
      leadId: leadAnswered.id,
      type: "note",
      title: "Replied by phone",
      occurredAt: at(5),
    },
    // No portal messages at all.
    {
      organizationId: org.id,
      leadId: leadNoMessages.id,
      type: "note",
      title: "Just a note",
      occurredAt: at(30),
    },
  ]);
});

afterAll(async () => {
  await deleteTestOrgs(org.id);
});

describe("dashboard unanswered portal messages", () => {
  it("counts only leads whose latest portal message has no later team activity", async () => {
    const summary = await getDashboardSummary(org.id);
    expect(summary.unansweredPortalMessages).toBe(1);
  });

  it("drops the count once the team responds", async () => {
    await db.insert(activitiesTable).values({
      organizationId: org.id,
      leadId: leadUnanswered.id,
      type: "note",
      title: "Called homeowner back",
      occurredAt: new Date(),
    });
    const summary = await getDashboardSummary(org.id);
    expect(summary.unansweredPortalMessages).toBe(0);
  });

  it("an inline portal reply (team_message) also clears the count", async () => {
    // New homeowner message arrives, lead becomes unanswered again.
    await db.insert(activitiesTable).values({
      organizationId: org.id,
      leadId: leadUnanswered.id,
      type: "portal_message",
      title: "Message from homeowner (portal)",
      body: "Any update?",
      occurredAt: new Date(Date.now() + 1000),
    });
    expect((await getDashboardSummary(org.id)).unansweredPortalMessages).toBe(1);

    await db.insert(activitiesTable).values({
      organizationId: org.id,
      leadId: leadUnanswered.id,
      type: "team_message",
      title: "Reply from your roofing team",
      body: "Yes — Thursday morning.",
      occurredAt: new Date(Date.now() + 2000),
    });
    expect((await getDashboardSummary(org.id)).unansweredPortalMessages).toBe(0);
  });
});
