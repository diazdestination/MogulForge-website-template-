import {
  DEFAULT_SENDING_HOURS,
  consentRecordsTable,
  db,
  organizationsTable,
  playbookTouchesTable,
  playbooksTable,
  type Playbook,
  type SendingHoursSettings,
} from "@workspace/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";

import * as crm from "./crm";
import { adjustSendTime, MIN_WINDOW_SAMPLE } from "./playbook-learning";
import { autoEnrollLead } from "./playbooks";
import { isWithinWindow, nextAllowedSendTime } from "./send-gate";
import { getSendingHours, updateOrgSettings } from "./settings";

/**
 * "Never text or email homeowners in the middle of the night": org-local
 * permitted sending windows must gate playbook scheduling and the learning
 * loop's send-time optimization. Covers boundary times, timezone conversion,
 * and DST transitions.
 */

const NY_8_TO_20: SendingHoursSettings = {
  quietHoursEnabled: true,
  timezone: "America/New_York",
  startHour: 8,
  endHour: 20,
  days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  maxTouchesPerDay: 0,
};

let org: { id: string };

beforeAll(async () => {
  const slug = `test-sendwin-${Date.now()}`;
  const [row] = await db
    .insert(organizationsTable)
    .values({ name: "Send Window Test Org", slug })
    .returning();
  org = row;
});

afterAll(async () => {
  await deleteTestOrgs(org.id);
});

describe("default sending window", () => {
  it("is ON by default: 8am–8pm org-local, every day", async () => {
    const cfg = await getSendingHours(org.id);
    expect(cfg.quietHoursEnabled).toBe(true);
    expect(cfg.startHour).toBe(8);
    expect(cfg.endHour).toBe(20);
    expect(cfg.days).toHaveLength(7);
    expect(DEFAULT_SENDING_HOURS.quietHoursEnabled).toBe(true);
  });
});

describe("nextAllowedSendTime boundaries & timezone conversion", () => {
  it("allows sends inside the local window (winter, EST = UTC-5)", () => {
    // 2026-01-15 is a Thursday. 13:00Z = 8:00 EST — window opens.
    expect(nextAllowedSendTime(NY_8_TO_20, new Date("2026-01-15T13:00:00Z"))).toBeNull();
    // 00:59Z next day = 19:59 EST — last allowed minute.
    expect(nextAllowedSendTime(NY_8_TO_20, new Date("2026-01-16T00:59:00Z"))).toBeNull();
  });

  it("defers a 7:59am local send to 8:00am local", () => {
    const at = nextAllowedSendTime(NY_8_TO_20, new Date("2026-01-15T12:59:00Z"));
    expect(at?.toISOString()).toBe("2026-01-15T13:00:00.000Z");
  });

  it("defers an 8pm local send to 8am the next local day", () => {
    // 01:00Z Fri = 20:00 EST Thu — window just closed.
    const at = nextAllowedSendTime(NY_8_TO_20, new Date("2026-01-16T01:00:00Z"));
    expect(at?.toISOString()).toBe("2026-01-16T13:00:00.000Z"); // 8am EST Friday
  });

  it("defers a 3am local send to 8am the same local day", () => {
    const at = nextAllowedSendTime(NY_8_TO_20, new Date("2026-01-15T08:00:00Z")); // 3am EST
    expect(at?.toISOString()).toBe("2026-01-15T13:00:00.000Z");
  });

  it("respects allowed days: Saturday send waits for Monday morning", () => {
    const weekdaysOnly = { ...NY_8_TO_20, days: ["Mon", "Tue", "Wed", "Thu", "Fri"] };
    // 2026-01-17 is a Saturday; 15:00Z = 10:00 EST.
    const at = nextAllowedSendTime(weekdaysOnly, new Date("2026-01-17T15:00:00Z"));
    expect(at?.toISOString()).toBe("2026-01-19T13:00:00.000Z"); // Monday 8am EST
  });

  it("converts through the configured timezone, not the server's", () => {
    const chicago = { ...NY_8_TO_20, timezone: "America/Chicago" };
    // 14:00Z = 8:00 CST — open in Chicago but already 9am in New York.
    expect(nextAllowedSendTime(chicago, new Date("2026-01-15T14:00:00Z"))).toBeNull();
    // 13:30Z = 7:30 CST — closed; next top-of-hour inside window is 14:00Z.
    const at = nextAllowedSendTime(chicago, new Date("2026-01-15T13:30:00Z"));
    expect(at?.toISOString()).toBe("2026-01-15T14:00:00.000Z");
  });

  it("is off when quiet hours are disabled", () => {
    const off = { ...NY_8_TO_20, quietHoursEnabled: false };
    expect(nextAllowedSendTime(off, new Date("2026-01-15T08:00:00Z"))).toBeNull();
  });
});

describe("DST transitions", () => {
  it("spring forward (2026-03-08): 1:30am EST defers to 8am EDT (12:00Z)", () => {
    const at = nextAllowedSendTime(NY_8_TO_20, new Date("2026-03-08T06:30:00Z"));
    expect(at?.toISOString()).toBe("2026-03-08T12:00:00.000Z");
    expect(isWithinWindow(NY_8_TO_20, at!)).toBe(true);
  });

  it("fall back (2026-11-01): 1:30am EDT defers to 8am EST (13:00Z)", () => {
    const at = nextAllowedSendTime(NY_8_TO_20, new Date("2026-11-01T05:30:00Z"));
    expect(at?.toISOString()).toBe("2026-11-01T13:00:00.000Z");
    expect(isWithinWindow(NY_8_TO_20, at!)).toBe(true);
  });
});

describe("adjustSendTime respects the permitted window", () => {
  async function seedHours(pb: Playbook, enrollmentId: string, leadId: string) {
    // Hour 23 UTC replies great, hour 15 poorly — both with enough volume.
    for (let i = 0; i < MIN_WINDOW_SAMPLE; i++) {
      for (const [hour, replied] of [[23, true], [15, i === 0]] as const) {
        await db.insert(playbookTouchesTable).values({
          organizationId: org.id,
          playbookId: pb.id,
          enrollmentId,
          leadId,
          stepIndex: 0,
          variantKey: "default",
          channel: "email",
          provider: "mock-email",
          sentHourUtc: hour,
          repliedAt: replied ? new Date() : null,
        });
      }
    }
  }

  it("never shifts a follow-up into an hour outside the org window", async () => {
    // Make auto-enrollment deterministic for this suite's org.
    await updateOrgSettings(org.id, {
      sendingHours: { ...DEFAULT_SENDING_HOURS, quietHoursEnabled: false },
    });
    const contact = await crm.createContact(org.id, {
      firstName: "Night",
      lastName: "Owl",
      phone: "+15550009999",
      email: "owl@test.example",
    });
    await db.insert(consentRecordsTable).values({
      organizationId: org.id,
      contactId: contact.id,
      channel: "sms",
      granted: true,
      disclosureVersion: "v1",
    });
    const lead = await crm.createLead(org.id, { contactId: contact.id });
    const enrollment = await autoEnrollLead(org.id, lead!.id);
    const [pb] = await db
      .insert(playbooksTable)
      .values({
        organizationId: org.id,
        name: `Window test ${Date.now()}`,
        isActive: false,
        enrollmentRules: {},
        steps: [{ channel: "email", delayMinutes: 5, prompt: "p" }],
      })
      .returning();
    await seedHours(pb, enrollment!.id, lead!.id);

    // Base at 15:00Z; best-performing bucket is 23:00Z (= 6pm EST — fine),
    // but with a UTC 8–17 window, 23:00Z is the middle of the night.
    const base = new Date("2026-01-15T15:00:00Z");
    const utcDay: SendingHoursSettings = {
      ...NY_8_TO_20,
      timezone: "UTC",
      startHour: 8,
      endHour: 17,
    };
    const guarded = await adjustSendTime(org.id, base, utcDay);
    expect(guarded.adjusted).toBe(false);
    expect(guarded.runAt.getTime()).toBe(base.getTime());

    // Same data with the window open until midnight UTC: shift is allowed.
    const openLate = { ...utcDay, endHour: 24 };
    const shifted = await adjustSendTime(org.id, base, openLate);
    expect(shifted.adjusted).toBe(true);
    expect(shifted.runAt.getUTCHours()).toBe(23);

    // With quiet hours disabled the historical behavior is unchanged.
    const off = { ...utcDay, quietHoursEnabled: false };
    const legacy = await adjustSendTime(org.id, base, off);
    expect(legacy.adjusted).toBe(true);
    expect(legacy.runAt.getUTCHours()).toBe(23);
  });
});
