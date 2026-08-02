/**
 * Proves portal-message notifications reach someone: the assigned rep when
 * usable, otherwise every active org owner/admin (unassigned lead,
 * deactivated rep, or rep without a valid mailbox). Also covers the
 * homeowner-side notification when the team replies.
 */
import {
  activitiesTable,
  contactsTable,
  db,
  leadsTable,
  organizationsTable,
  orgSettingsTable,
  usersTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";

process.env.SESSION_SECRET ??= "test-session-secret";

const sent: { to: string; subject: string; body: string }[] = [];

vi.mock("./providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./providers")>();
  return {
    ...actual,
    providers: {
      ...actual.providers,
      email: {
        send: async (to: string, subject: string, body: string) => {
          sent.push({ to, subject, body });
          return { id: "mock", provider: "mock" };
        },
      },
    },
  };
});

const {
  notifyAssignedRepOfPortalMessage,
  notifyHomeownerOfTeamReply,
  HOMEOWNER_REPLY_EMAIL_QUIET_MS,
} = await import("./portal-message-email");
const { providers } = await import("./providers");

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const repEmail = `pm-rep-${suffix}@example.com`;
const adminEmail = `pm-admin-${suffix}@example.com`;
const ownerEmail = `pm-owner-${suffix}@example.com`;

let org: { id: string };
const userIds: string[] = [];
const leadIds: string[] = [];
const contactIds: string[] = [];
const activityIds: string[] = [];
let repId: string;

async function makeLead(
  assignedUserId: string | null,
  contactOverrides: Partial<typeof contactsTable.$inferInsert> = {},
) {
  const [contact] = await db
    .insert(contactsTable)
    .values({
      organizationId: org.id,
      firstName: "Pat",
      lastName: "Homeowner",
      ...contactOverrides,
    })
    .returning();
  contactIds.push(contact.id);
  const [lead] = await db
    .insert(leadsTable)
    .values({
      organizationId: org.id,
      contactId: contact.id,
      assignedUserId,
    })
    .returning();
  leadIds.push(lead.id);
  return lead;
}

beforeAll(async () => {
  const [row] = await db
    .insert(organizationsTable)
    .values({
      name: "Portal Msg Org",
      slug: `test-portal-msg-${suffix}`,
    })
    .returning();
  org = row;
  const users = await db
    .insert(usersTable)
    .values([
      {
        id: `test-pm-rep-${suffix}`,
        email: repEmail,
        firstName: "Riley",
        organizationId: org.id,
        role: "sales_rep",
      },
      {
        id: `test-pm-admin-${suffix}`,
        email: adminEmail,
        organizationId: org.id,
        role: "admin",
      },
      {
        id: `test-pm-owner-${suffix}`,
        email: ownerEmail,
        organizationId: org.id,
        role: "owner",
      },
    ])
    .returning();
  userIds.push(...users.map((u) => u.id));
  repId = users[0].id;
});

afterAll(async () => {
  await deleteTestOrgs(org.id);
});

beforeEach(() => {
  sent.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("notifyAssignedRepOfPortalMessage", () => {
  it("emails the assigned rep when the rep is usable", async () => {
    const lead = await makeLead(repId);
    const result = await notifyAssignedRepOfPortalMessage({
      organizationId: org.id,
      leadId: lead.id,
      messageContent: "Hello from the porch",
    });
    expect(result.sent).toBe(true);
    expect(sent.map((s) => s.to)).toEqual([repEmail]);
    expect(sent[0].subject).toContain("Pat Homeowner");
    expect(sent[0].body).toContain(`/leads/${lead.id}`);
  });

  it("falls back to org admins when the lead has no assigned rep", async () => {
    const lead = await makeLead(null);
    const result = await notifyAssignedRepOfPortalMessage({
      organizationId: org.id,
      leadId: lead.id,
      messageContent: "Anyone there?",
    });
    expect(result.sent).toBe(true);
    expect(result.reason).toContain("no assigned rep");
    expect(sent.map((s) => s.to).sort()).toEqual(
      [adminEmail, ownerEmail].sort(),
    );
    // Same content: lead name in the subject, lead link in the body.
    expect(sent[0].subject).toContain("Pat Homeowner");
    expect(sent[0].body).toContain(`/leads/${lead.id}`);
  });

  it("falls back to org admins when the assigned rep is deactivated", async () => {
    const lead = await makeLead(repId);
    await db
      .update(usersTable)
      .set({ isActive: false })
      .where(eq(usersTable.id, repId));
    try {
      const result = await notifyAssignedRepOfPortalMessage({
        organizationId: org.id,
        leadId: lead.id,
        messageContent: "Still waiting",
      });
      expect(result.sent).toBe(true);
      expect(result.reason).toContain("deactivated");
      expect(sent.map((s) => s.to).sort()).toEqual(
        [adminEmail, ownerEmail].sort(),
      );
    } finally {
      await db
        .update(usersTable)
        .set({ isActive: true })
        .where(eq(usersTable.id, repId));
    }
  });

  it("emails the fallback inbox instead of all admins when one is configured", async () => {
    const fallbackEmail = `pm-fallback-${suffix}@example.com`;
    await db
      .update(orgSettingsTable)
      .set({ fallbackNotificationInbox: fallbackEmail })
      .where(eq(orgSettingsTable.organizationId, org.id));
    try {
      const lead = await makeLead(null);
      const result = await notifyAssignedRepOfPortalMessage({
        organizationId: org.id,
        leadId: lead.id,
        messageContent: "Route this to dispatch",
      });
      expect(result.sent).toBe(true);
      expect(result.reason).toContain("fallback inbox");
      expect(sent.map((s) => s.to)).toEqual([fallbackEmail]);
      expect(sent[0].subject).toContain("Pat Homeowner");
      expect(sent[0].body).toContain(`/leads/${lead.id}`);
    } finally {
      await db
        .update(orgSettingsTable)
        .set({ fallbackNotificationInbox: null })
        .where(eq(orgSettingsTable.organizationId, org.id));
    }
  });

  it("falls back to fallback inbox for a deactivated rep too", async () => {
    const fallbackEmail = `pm-fallback2-${suffix}@example.com`;
    await db
      .update(orgSettingsTable)
      .set({ fallbackNotificationInbox: fallbackEmail })
      .where(eq(orgSettingsTable.organizationId, org.id));
    await db
      .update(usersTable)
      .set({ isActive: false })
      .where(eq(usersTable.id, repId));
    try {
      const lead = await makeLead(repId);
      const result = await notifyAssignedRepOfPortalMessage({
        organizationId: org.id,
        leadId: lead.id,
        messageContent: "Rep is out",
      });
      expect(result.sent).toBe(true);
      expect(result.reason).toContain("fallback inbox");
      expect(sent.map((s) => s.to)).toEqual([fallbackEmail]);
    } finally {
      await db
        .update(usersTable)
        .set({ isActive: true })
        .where(eq(usersTable.id, repId));
      await db
        .update(orgSettingsTable)
        .set({ fallbackNotificationInbox: null })
        .where(eq(orgSettingsTable.organizationId, org.id));
    }
  });

  it("reports failure when there is no rep and no admins", async () => {
    const lead = await makeLead(null);
    // Deactivate both admins so the fallback has no recipients.
    await db
      .update(usersTable)
      .set({ isActive: false })
      .where(inArray(usersTable.email, [adminEmail, ownerEmail]));
    try {
      const result = await notifyAssignedRepOfPortalMessage({
        organizationId: org.id,
        leadId: lead.id,
        messageContent: "Echo?",
      });
      expect(result.sent).toBe(false);
      expect(result.reason).toContain("no admin recipients");
      expect(sent).toHaveLength(0);
    } finally {
      await db
        .update(usersTable)
        .set({ isActive: true })
        .where(inArray(usersTable.email, [adminEmail, ownerEmail]));
    }
  });
});

describe("notifyHomeownerOfTeamReply", () => {
  it("emails the contact with a portal link when they have an email", async () => {
    const lead = await makeLead(null, {
      firstName: "Holly",
      lastName: null,
      email: `holly-${suffix}@example.com`,
    });
    const result = await notifyHomeownerOfTeamReply({
      organizationId: org.id,
      leadId: lead.id,
      messageContent: "We'll be out Thursday morning.",
    });
    expect(result.sent).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toContain("holly-");
    expect(sent[0].subject.toLowerCase()).toContain("replied");
    expect(sent[0].body).toContain("We'll be out Thursday morning.");
    expect(sent[0].body).toContain("/portal");
  });

  it("no-ops when the contact has no email", async () => {
    const lead = await makeLead(null, { firstName: "Nomail", lastName: null });
    const result = await notifyHomeownerOfTeamReply({
      organizationId: org.id,
      leadId: lead.id,
      messageContent: "Hi",
    });
    expect(result.sent).toBe(false);
    expect(result.reason).toContain("no valid email");
    expect(sent).toHaveLength(0);
  });

  it("does not throw when the email provider fails", async () => {
    const lead = await makeLead(null, {
      firstName: "Holly",
      lastName: null,
      email: `holly2-${suffix}@example.com`,
    });
    vi.spyOn(providers.email, "send").mockRejectedValue(new Error("smtp down"));
    const result = await notifyHomeownerOfTeamReply({
      organizationId: org.id,
      leadId: lead.id,
      messageContent: "Hi",
    });
    expect(result.sent).toBe(false);
    expect(result.reason).toContain("smtp down");
  });

  it("no-ops for a lead in another organization", async () => {
    const result = await notifyHomeownerOfTeamReply({
      organizationId: org.id,
      leadId: "00000000-0000-0000-0000-000000000000",
      messageContent: "Hi",
    });
    expect(result.sent).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("suppresses subsequent replies within the quiet window", async () => {
    const homeownerEmail = `hw-debounce-${suffix}@example.com`;
    const lead = await makeLead(null, {
      firstName: "Debounce",
      lastName: null,
      email: homeownerEmail,
    });
    const now = new Date();

    // First reply: insert activity and pass its id — should send.
    const [activity1] = await db
      .insert(activitiesTable)
      .values({
        organizationId: org.id,
        leadId: lead.id,
        type: "team_message",
        title: "First reply",
      })
      .returning();
    activityIds.push(activity1.id);
    const r1 = await notifyHomeownerOfTeamReply({
      organizationId: org.id,
      leadId: lead.id,
      messageContent: "We'll be out Thursday.",
      activityId: activity1.id,
      now,
    });
    expect(r1.sent).toBe(true);
    expect(sent).toHaveLength(1);

    // Second reply within the quiet window — should be suppressed.
    const [activity2] = await db
      .insert(activitiesTable)
      .values({
        organizationId: org.id,
        leadId: lead.id,
        type: "team_message",
        title: "Second reply",
      })
      .returning();
    activityIds.push(activity2.id);
    const r2 = await notifyHomeownerOfTeamReply({
      organizationId: org.id,
      leadId: lead.id,
      messageContent: "Also bringing extra shingles.",
      activityId: activity2.id,
      now: new Date(now.getTime() + 30_000), // 30 s later — still inside window
    });
    expect(r2.sent).toBe(false);
    expect(r2.reason).toContain("quiet window");
    // Only the first email was sent.
    expect(sent).toHaveLength(1);
  });

  it("sends again after the quiet window elapses", async () => {
    const homeownerEmail = `hw-elapsed-${suffix}@example.com`;
    const lead = await makeLead(null, {
      firstName: "Elapsed",
      lastName: null,
      email: homeownerEmail,
    });
    const now = new Date();

    // First reply inside window — sends.
    const [activity1] = await db
      .insert(activitiesTable)
      .values({
        organizationId: org.id,
        leadId: lead.id,
        type: "team_message",
        title: "First reply",
      })
      .returning();
    activityIds.push(activity1.id);
    const r1 = await notifyHomeownerOfTeamReply({
      organizationId: org.id,
      leadId: lead.id,
      messageContent: "Reply one.",
      activityId: activity1.id,
      now,
    });
    expect(r1.sent).toBe(true);

    // Second reply after the window — sends again.
    const [activity2] = await db
      .insert(activitiesTable)
      .values({
        organizationId: org.id,
        leadId: lead.id,
        type: "team_message",
        title: "Second reply after window",
      })
      .returning();
    activityIds.push(activity2.id);
    const afterWindow = new Date(
      now.getTime() + HOMEOWNER_REPLY_EMAIL_QUIET_MS + 1_000,
    );
    const r2 = await notifyHomeownerOfTeamReply({
      organizationId: org.id,
      leadId: lead.id,
      messageContent: "Reply two, much later.",
      activityId: activity2.id,
      now: afterWindow,
    });
    expect(r2.sent).toBe(true);
    expect(sent).toHaveLength(2);
  });

  it("sends exactly one email when two replies fire concurrently", async () => {
    const homeownerEmail = `hw-concurrent-${suffix}@example.com`;
    const lead = await makeLead(null, {
      firstName: "Concurrent",
      lastName: null,
      email: homeownerEmail,
    });
    const now = new Date();

    // Insert two separate team_message activities to simulate two reps
    // replying at the same moment.
    const [activity1, activity2] = await db
      .insert(activitiesTable)
      .values([
        {
          organizationId: org.id,
          leadId: lead.id,
          type: "team_message",
          title: "Rep A reply",
        },
        {
          organizationId: org.id,
          leadId: lead.id,
          type: "team_message",
          title: "Rep B reply",
        },
      ])
      .returning();
    activityIds.push(activity1.id, activity2.id);

    // Fire both notifications at the exact same moment — the advisory lock
    // must ensure only one wins the quiet-window claim.
    const [r1, r2] = await Promise.all([
      notifyHomeownerOfTeamReply({
        organizationId: org.id,
        leadId: lead.id,
        messageContent: "Rep A: we'll be out Thursday.",
        activityId: activity1.id,
        now,
      }),
      notifyHomeownerOfTeamReply({
        organizationId: org.id,
        leadId: lead.id,
        messageContent: "Rep B: also bringing extra shingles.",
        activityId: activity2.id,
        now,
      }),
    ]);

    // Exactly one must have sent; the other must have been suppressed.
    const sentCount = [r1, r2].filter((r) => r.sent).length;
    const suppressedCount = [r1, r2].filter((r) => !r.sent).length;
    expect(sentCount).toBe(1);
    expect(suppressedCount).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toContain("hw-concurrent-");
  });

  it("releases the quiet window claim when the send fails", async () => {
    const homeownerEmail = `hw-release-${suffix}@example.com`;
    const lead = await makeLead(null, {
      firstName: "Release",
      lastName: null,
      email: homeownerEmail,
    });
    const now = new Date();

    // First reply fails to send.
    const [activity1] = await db
      .insert(activitiesTable)
      .values({
        organizationId: org.id,
        leadId: lead.id,
        type: "team_message",
        title: "Failed reply",
      })
      .returning();
    activityIds.push(activity1.id);
    vi.spyOn(providers.email, "send").mockRejectedValueOnce(
      new Error("smtp down"),
    );
    const r1 = await notifyHomeownerOfTeamReply({
      organizationId: org.id,
      leadId: lead.id,
      messageContent: "Will this arrive?",
      activityId: activity1.id,
      now,
    });
    expect(r1.sent).toBe(false);

    // A second reply on the same lead should now succeed (claim was released).
    const [activity2] = await db
      .insert(activitiesTable)
      .values({
        organizationId: org.id,
        leadId: lead.id,
        type: "team_message",
        title: "Retry reply",
      })
      .returning();
    activityIds.push(activity2.id);
    const r2 = await notifyHomeownerOfTeamReply({
      organizationId: org.id,
      leadId: lead.id,
      messageContent: "Retry — this should send.",
      activityId: activity2.id,
      now: new Date(now.getTime() + 5_000),
    });
    expect(r2.sent).toBe(true);
    expect(sent).toHaveLength(1);
  });
});
