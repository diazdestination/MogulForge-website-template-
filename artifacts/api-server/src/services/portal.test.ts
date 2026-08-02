import { createHash } from "node:crypto";

import {
  activitiesTable,
  contactsTable,
  db,
  leadsTable,
  organizationsTable,
  portalLoginCodesTable,
  portalSessionsTable,
  rateLimitCountersTable,
  usersTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";

import {
  getPortalOverview,
  getPortalSession,
  isPortalPhotoForSession,
  normalizeIdentifier,
  postPortalMessage,
  requestLoginCode,
  verifyLoginCode,
} from "./portal";
import { PORTAL_MESSAGE_EMAIL_QUIET_MS } from "./portal-message-email";
import { providers } from "./providers";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

let org: { id: string };
let contactA: { id: string };
let contactB: { id: string };
let leadA: { id: string };
let leadB: { id: string };

const EMAIL_A = `portal-a-${Date.now()}@example.com`;
const EMAIL_B = `portal-b-${Date.now()}@example.com`;

async function insertCode(identifier: string, code: string, opts?: {
  expiresAt?: Date;
  attempts?: number;
}) {
  const [row] = await db
    .insert(portalLoginCodesTable)
    .values({
      organizationId: org.id,
      identifier,
      channel: "email",
      codeHash: sha256(code),
      attempts: opts?.attempts ?? 0,
      expiresAt: opts?.expiresAt ?? new Date(Date.now() + 10 * 60 * 1000),
    })
    .returning();
  return row;
}

beforeAll(async () => {
  const [o] = await db
    .insert(organizationsTable)
    .values({ name: "Portal Test Org", slug: `portal-test-${Date.now()}` })
    .returning();
  org = o;
  const [ca] = await db
    .insert(contactsTable)
    .values({ organizationId: org.id, firstName: "Alice", email: EMAIL_A })
    .returning();
  const [cb] = await db
    .insert(contactsTable)
    .values({ organizationId: org.id, firstName: "Bob", email: EMAIL_B })
    .returning();
  contactA = ca;
  contactB = cb;
  const [la] = await db
    .insert(leadsTable)
    .values({ organizationId: org.id, contactId: contactA.id })
    .returning();
  const [lb] = await db
    .insert(leadsTable)
    .values({ organizationId: org.id, contactId: contactB.id })
    .returning();
  leadA = la;
  leadB = lb;
});

/** Orgs created inside individual tests; cleaned up alongside the main org. */
const extraOrgIds: string[] = [];

afterAll(async () => {
  await deleteTestOrgs(org.id, ...extraOrgIds);
});

describe("normalizeIdentifier", () => {
  it("lowercases emails and rejects invalid mailboxes", () => {
    expect(normalizeIdentifier("Foo@Example.COM")).toEqual({
      identifier: "foo@example.com",
      channel: "email",
    });
    expect(normalizeIdentifier("bad@@example.com")).toBeNull();
  });
  it("normalizes phones to last 10 digits", () => {
    expect(normalizeIdentifier("+1 (555) 201-9988")).toEqual({
      identifier: "5552019988",
      channel: "sms",
    });
    expect(normalizeIdentifier("12345")).toBeNull();
  });
});

describe("requestLoginCode throttle", () => {
  it("throttles repeated requests per identifier and resets after the window", async () => {
    const sendSpy = vi
      .spyOn(providers.email, "send")
      .mockResolvedValue({ id: "test-email", provider: "mock-email" });
    try {
      // First 3 requests within the window create codes and send emails.
      for (let i = 0; i < 3; i++) {
        const result = await requestLoginCode({
          organizationId: org.id,
          rawIdentifier: EMAIL_A,
        });
        expect(result).toEqual({ ok: true, channel: "email" });
      }
      expect(sendSpy).toHaveBeenCalledTimes(3);

      // 4th request is throttled: same neutral response, but no new code row
      // and no email.
      const throttled = await requestLoginCode({
        organizationId: org.id,
        rawIdentifier: EMAIL_A,
      });
      expect(throttled).toEqual({ ok: true, channel: "email" });
      expect(sendSpy).toHaveBeenCalledTimes(3);
      const rows = await db
        .select()
        .from(portalLoginCodesTable)
        .where(eq(portalLoginCodesTable.identifier, EMAIL_A));
      expect(rows).toHaveLength(3);

      // Unknown identifiers are throttled with the same neutral shape too
      // (no enumeration signal), after their own budget is spent.
      const ghost = `ghost-${Date.now()}@example.com`;
      for (let i = 0; i < 4; i++) {
        expect(
          await requestLoginCode({ organizationId: org.id, rawIdentifier: ghost }),
        ).toEqual({ ok: true, channel: "email" });
      }
      expect(sendSpy).toHaveBeenCalledTimes(3);

      // Expire the window: the next request goes through again.
      await db
        .update(rateLimitCountersTable)
        .set({ resetAt: sql`now() - interval '1 second'` })
        .where(
          sql`${rateLimitCountersTable.key} like ${`portal-login-code:${org.id}:%`}`,
        );
      const afterReset = await requestLoginCode({
        organizationId: org.id,
        rawIdentifier: EMAIL_A,
      });
      expect(afterReset).toEqual({ ok: true, channel: "email" });
      expect(sendSpy).toHaveBeenCalledTimes(4);
    } finally {
      sendSpy.mockRestore();
      await db
        .delete(portalLoginCodesTable)
        .where(eq(portalLoginCodesTable.identifier, EMAIL_A));
      await db
        .delete(rateLimitCountersTable)
        .where(
          sql`${rateLimitCountersTable.key} like ${`portal-login-code:${org.id}:%`}`,
        );
    }
  });
});

describe("verifyLoginCode", () => {
  it("rejects a wrong code and counts the attempt", async () => {
    const row = await insertCode(EMAIL_A, "777777");
    const result = await verifyLoginCode({
      organizationId: org.id,
      rawIdentifier: EMAIL_A.toUpperCase(),
      code: "654321",
    });
    expect(result).toBeNull();
    const [after] = await db
      .select()
      .from(portalLoginCodesTable)
      .where(eq(portalLoginCodesTable.id, row.id));
    expect(after.attempts).toBe(1);
    await db
      .delete(portalLoginCodesTable)
      .where(eq(portalLoginCodesTable.id, row.id));
  });

  it("rejects an expired code", async () => {
    const row = await insertCode(EMAIL_A, "123456", {
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(
      await verifyLoginCode({
        organizationId: org.id,
        rawIdentifier: EMAIL_A,
        code: "123456",
      }),
    ).toBeNull();
    await db
      .delete(portalLoginCodesTable)
      .where(eq(portalLoginCodesTable.id, row.id));
  });

  it("rejects after the attempt limit", async () => {
    const row = await insertCode(EMAIL_A, "123456", { attempts: 5 });
    expect(
      await verifyLoginCode({
        organizationId: org.id,
        rawIdentifier: EMAIL_A,
        code: "123456",
      }),
    ).toBeNull();
    await db
      .delete(portalLoginCodesTable)
      .where(eq(portalLoginCodesTable.id, row.id));
  });

  it("accepts the right code, consumes it, and mints a session", async () => {
    const row = await insertCode(EMAIL_A, "654321");
    const result = await verifyLoginCode({
      organizationId: org.id,
      rawIdentifier: EMAIL_A.toUpperCase(),
      code: "654321",
    });
    expect(result).not.toBeNull();
    const session = await getPortalSession(result!.token);
    expect(session?.identifier).toBe(EMAIL_A);
    // Consumed code cannot be replayed.
    expect(
      await verifyLoginCode({
        organizationId: org.id,
        rawIdentifier: EMAIL_A,
        code: "654321",
      }),
    ).toBeNull();
    const [after] = await db
      .select()
      .from(portalLoginCodesTable)
      .where(eq(portalLoginCodesTable.id, row.id));
    expect(after.consumedAt).not.toBeNull();
  });
});

describe("portal claim isolation", () => {
  async function sessionFor(identifier: string) {
    const token = `tok-${identifier}-${Date.now()}`;
    const [session] = await db
      .insert(portalSessionsTable)
      .values({
        organizationId: org.id,
        tokenHash: sha256(token),
        identifier,
        channel: "email",
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning();
    return session;
  }

  it("overview only includes the verified identifier's own claims", async () => {
      const session = await sessionFor(EMAIL_A);
    const overview = await getPortalOverview(session);
    const ids = overview.claims.map((c) => c.id);
    expect(ids).toContain(leadA.id);
    expect(ids).not.toContain(leadB.id);
    expect(overview.contact?.firstName).toBe("Alice");
  });

  it("overview shows team replies alongside homeowner messages, but never internal notes", async () => {
    await db.insert(activitiesTable).values([
      {
        organizationId: org.id,
        leadId: leadA.id,
        type: "team_message",
        title: "Reply from your roofing team",
        body: "We'll be out Thursday morning.",
        metadata: { source: "crm-portal-reply" },
      },
      {
        organizationId: org.id,
        leadId: leadA.id,
        type: "note",
        title: "Internal note",
        body: "Homeowner is price-sensitive.",
      },
    ]);
    const session = await sessionFor(EMAIL_A);
    const overview = await getPortalOverview(session);
    if (!overview.contact) throw new Error("expected a matching contact");
    const claim = [...overview.claims].find((c) => c.id === leadA.id);
    const types = claim?.updates.map((u) => u.type) ?? [];
    expect(types).toContain("team_message");
    expect(types).not.toContain("note");
    const reply = claim?.updates.find((u) => u.type === "team_message");
    expect(reply?.body).toBe("We'll be out Thursday morning.");
  });

  it("cannot message another contact's lead", async () => {
      const session = await sessionFor(EMAIL_A);
    expect(
      await postPortalMessage({
        session,
        leadId: leadB.id,
        content: "should not land",
      }),
    ).toBe(false);
    expect(
      await postPortalMessage({
        session,
        leadId: leadA.id,
        content: "hello team",
      }),
    ).toBe(true);
  });

  it("cannot read or message another org's leads, even for the same identifier", async () => {
    // A second company with a contact using the SAME email as Alice.
    const [otherOrg] = await db
      .insert(organizationsTable)
      .values({ name: "Code Org B", slug: `portal-code-${Date.now()}` })
      .returning();
    extraOrgIds.push(otherOrg.id);
    const [foreignContact] = await db
      .insert(contactsTable)
      .values({ organizationId: otherOrg.id, firstName: "Alia", email: EMAIL_A })
      .returning();
    const [foreignLead] = await db
      .insert(leadsTable)
      .values({ organizationId: otherOrg.id, contactId: foreignContact.id })
      .returning();

    // Session minted in org A: overview never includes the other org's lead.
      const session = await sessionFor(EMAIL_A);
    const overview = await getPortalOverview(session);
    expect(overview.claims.map((c) => c.id)).not.toContain(foreignLead.id);

    // Messaging the other org's lead ID is rejected (route maps false → 404).
    expect(
      await postPortalMessage({
        session,
        leadId: foreignLead.id,
        content: "cross-org attempt",
      }),
    ).toBe(false);
  });

  it("a login code issued for one org cannot be verified in another org", async () => {
    const [otherOrg] = await db
      .insert(organizationsTable)
      .values({ name: "Code Org B", slug: `portal-code-${Date.now()}` })
      .returning();
    extraOrgIds.push(otherOrg.id);
    const row = await insertCode(EMAIL_A, "777777");
    expect(
      await verifyLoginCode({
        organizationId: otherOrg.id,
        rawIdentifier: EMAIL_A,
        code: "777777",
      }),
    ).toBeNull();
    await db
      .delete(portalLoginCodesTable)
      .where(eq(portalLoginCodesTable.id, row.id));
  });

  it("overview returns each claim's own attached photos, never another contact's", async () => {
    const photoA = `/objects/uploads/photo-a-${Date.now()}`;
    const photoB = `/objects/uploads/photo-b-${Date.now()}`;
    await db.insert(activitiesTable).values([
      {
        organizationId: org.id,
        leadId: leadA.id,
        contactId: contactA.id,
        type: "photos_attached",
        title: "Photos attached",
        metadata: { photoPaths: [photoA] },
      },
      {
        organizationId: org.id,
        leadId: leadB.id,
        contactId: contactB.id,
        type: "photos_attached",
        title: "Photos attached",
        metadata: { photoPaths: [photoB] },
      },
    ]);
    const session = await sessionFor(EMAIL_A);
    const overview = await getPortalOverview(session);
    if (!overview.contact) throw new Error("expected a matching contact");
    const claimA = overview.claims.find((c) => c.id === leadA.id);
    expect(claimA?.photos).toEqual([photoA]);
    expect(overview.claims.flatMap((c) => c.photos)).not.toContain(photoB);

    // Streaming ownership check mirrors the overview.
    expect(await isPortalPhotoForSession(session, photoA)).toBe(true);
    expect(await isPortalPhotoForSession(session, photoB)).toBe(false);
    expect(
      await isPortalPhotoForSession(session, "/objects/uploads/never-attached"),
    ).toBe(false);
  });

  it("reminder sends appear in the homeowner timeline with sanitized copy", async () => {
    await db.insert(activitiesTable).values({
      organizationId: org.id,
      leadId: leadA.id,
      contactId: contactA.id,
      type: "appointment_reminder_sent",
      title: "Inspection reminder sent via email",
      body: "Reminder for the morning inspection window sent to internal@example.com.",
      metadata: { provider: "mock-email", channel: "email" },
    });
    const session = await sessionFor(EMAIL_A);
    const overview = await getPortalOverview(session);
    if (!overview.contact) throw new Error("expected a matching contact");
    const claimA = overview.claims.find((c) => c.id === leadA.id);
    const update = claimA?.updates.find(
      (u) => u.type === "appointment_reminder_sent",
    );
    expect(update).toBeDefined();
    expect(update?.title).toBe("Appointment reminder sent");
    expect(update?.body).toBe(
      "We sent you a reminder about your upcoming inspection appointment.",
    );
    // No internal metadata or address-of-record leaks through.
    expect(JSON.stringify(update)).not.toContain("internal@example.com");
    expect(JSON.stringify(update)).not.toContain("mock-email");
  });

  it("posting a message notifies the assigned rep by email with lead name + link", async () => {
    const [rep] = await db
      .insert(usersTable)
      .values({
        email: `rep-${Date.now()}@example.com`,
        firstName: "Rita",
        organizationId: org.id,
        role: "sales_rep",
      })
      .returning();
    await db
      .update(leadsTable)
      .set({ assignedUserId: rep.id })
      .where(eq(leadsTable.id, leadA.id));

    const sendSpy = vi
      .spyOn(providers.email, "send")
      .mockResolvedValue({ id: "test-email", provider: "mock-email" });
    try {
      const session = await sessionFor(EMAIL_A);
      expect(
        await postPortalMessage({
          session,
          leadId: leadA.id,
          content: "roof still leaking",
        }),
      ).toBe(true);

      expect(sendSpy).toHaveBeenCalledTimes(1);
      const [to, subject, body] = sendSpy.mock.calls[0];
      expect(to).toBe(rep.email);
      expect(subject).toContain("Alice");
      expect(body).toContain("roof still leaking");
      expect(body).toContain(`/leads/${leadA.id}`);
    } finally {
      sendSpy.mockRestore();
      await db
        .update(leadsTable)
        .set({ assignedUserId: null })
        .where(eq(leadsTable.id, leadA.id));
    }
  });

  it("rapid consecutive messages send at most one email; a new one goes out after the quiet window", async () => {
    const [rep] = await db
      .insert(usersTable)
      .values({
        email: `rep-debounce-${Date.now()}@example.com`,
        firstName: "Dana",
        organizationId: org.id,
        role: "sales_rep",
      })
      .returning();
    await db
      .update(leadsTable)
      .set({ assignedUserId: rep.id })
      .where(eq(leadsTable.id, leadA.id));

    const sendSpy = vi
      .spyOn(providers.email, "send")
      .mockResolvedValue({ id: "test-email", provider: "mock-email" });
    try {
      // Earlier tests may have stamped a recent notification on this lead;
      // backdate them so this test starts outside any quiet window.
      await db
        .update(activitiesTable)
        .set({
          createdAt: new Date(
            Date.now() - PORTAL_MESSAGE_EMAIL_QUIET_MS - 1000,
          ),
        })
        .where(
          and(
            eq(activitiesTable.leadId, leadA.id),
            eq(activitiesTable.type, "portal_message"),
          ),
        );

      const session = await sessionFor(EMAIL_A);
      for (const content of ["msg one", "msg two", "msg three"]) {
        expect(
          await postPortalMessage({ session, leadId: leadA.id, content }),
        ).toBe(true);
      }
      // Only the first message emails the rep within the quiet window.
      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(sendSpy.mock.calls[0][2]).toContain("msg one");

      // Simulate the quiet window elapsing by backdating the notified row.
      await db
        .update(activitiesTable)
        .set({
          createdAt: new Date(
            Date.now() - PORTAL_MESSAGE_EMAIL_QUIET_MS - 1000,
          ),
        })
        .where(
          and(
            eq(activitiesTable.leadId, leadA.id),
            eq(activitiesTable.type, "portal_message"),
          ),
        );

      expect(
        await postPortalMessage({
          session,
          leadId: leadA.id,
          content: "after quiet period",
        }),
      ).toBe(true);
      expect(sendSpy).toHaveBeenCalledTimes(2);
      expect(sendSpy.mock.calls[1][2]).toContain("after quiet period");
    } finally {
      sendSpy.mockRestore();
      await db
        .update(leadsTable)
        .set({ assignedUserId: null })
        .where(eq(leadsTable.id, leadA.id));
    }
  });

  it("concurrent posts on the same lead send exactly one email", async () => {
    const [rep] = await db
      .insert(usersTable)
      .values({
        email: `rep-concurrent-${Date.now()}@example.com`,
        firstName: "Cora",
        organizationId: org.id,
        role: "sales_rep",
      })
      .returning();
    await db
      .update(leadsTable)
      .set({ assignedUserId: rep.id })
      .where(eq(leadsTable.id, leadA.id));

    const sendSpy = vi
      .spyOn(providers.email, "send")
      .mockResolvedValue({ id: "test-email", provider: "mock-email" });
    try {
      // Start outside any quiet window left over from earlier tests.
      await db
        .update(activitiesTable)
        .set({
          createdAt: new Date(
            Date.now() - PORTAL_MESSAGE_EMAIL_QUIET_MS - 1000,
          ),
        })
        .where(
          and(
            eq(activitiesTable.leadId, leadA.id),
            eq(activitiesTable.type, "portal_message"),
          ),
        );

      const session = await sessionFor(EMAIL_A);
      const results = await Promise.all(
        ["p1", "p2", "p3", "p4", "p5"].map((content) =>
          postPortalMessage({ session, leadId: leadA.id, content }),
        ),
      );
      expect(results.every(Boolean)).toBe(true);
      expect(sendSpy).toHaveBeenCalledTimes(1);
    } finally {
      sendSpy.mockRestore();
      await db
        .update(leadsTable)
        .set({ assignedUserId: null })
        .where(eq(leadsTable.id, leadA.id));
    }
  });

  it("posting a message on an unassigned lead sends no email and still succeeds", async () => {
    const sendSpy = vi
      .spyOn(providers.email, "send")
      .mockRejectedValue(new Error("smtp down"));
    try {
      const session = await sessionFor(EMAIL_A);
      expect(
        await postPortalMessage({
          session,
          leadId: leadA.id,
          content: "anyone there?",
        }),
      ).toBe(true);
      expect(sendSpy).not.toHaveBeenCalled();
    } finally {
      sendSpy.mockRestore();
    }
  });

  it("a failing notification email never blocks the homeowner's post", async () => {
    const [rep] = await db
      .insert(usersTable)
      .values({
        email: `rep-fail-${Date.now()}@example.com`,
        firstName: "Rex",
        organizationId: org.id,
        role: "sales_rep",
      })
      .returning();
    await db
      .update(leadsTable)
      .set({ assignedUserId: rep.id })
      .where(eq(leadsTable.id, leadA.id));

    const sendSpy = vi
      .spyOn(providers.email, "send")
      .mockRejectedValue(new Error("smtp down"));
    try {
      const session = await sessionFor(EMAIL_A);
      expect(
        await postPortalMessage({
          session,
          leadId: leadA.id,
          content: "still here",
        }),
      ).toBe(true);
    } finally {
      sendSpy.mockRestore();
      await db
        .update(leadsTable)
        .set({ assignedUserId: null })
        .where(eq(leadsTable.id, leadA.id));
    }
  });

  it("expired sessions are rejected", async () => {
    const token = `expired-${Date.now()}`;
    await db.insert(portalSessionsTable).values({
      organizationId: org.id,
      tokenHash: sha256(token),
      identifier: EMAIL_A,
      channel: "email",
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await getPortalSession(token)).toBeNull();
  });
});
