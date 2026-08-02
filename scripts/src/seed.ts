/**
 * Seed the default organization plus demo CRM data.
 * Idempotent: skips seeding if demo data already exists.
 * Run: pnpm --filter @workspace/scripts run seed
 */
import {
  activitiesTable,
  appointmentsTable,
  consentRecordsTable,
  contactsTable,
  crmTasksTable,
  db,
  leadsTable,
  organizationsTable,
  propertiesTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";

const ORG_SLUG = "painless";

async function main() {
  let [org] = await db
    .select()
    .from(organizationsTable)
    .where(eq(organizationsTable.slug, ORG_SLUG));
  if (!org) {
    [org] = await db
      .insert(organizationsTable)
      .values({ name: "Painless Roofing & Water Restoration", slug: ORG_SLUG })
      .returning();
    console.log("Created default organization");
  }

  const existing = await db
    .select({ id: contactsTable.id })
    .from(contactsTable)
    .where(
      and(
        eq(contactsTable.organizationId, org.id),
        eq(contactsTable.email, "maria.gonzalez@example.com"),
      ),
    );
  if (existing.length > 0) {
    console.log("Demo data already seeded, skipping");
    return;
  }

  const [maria] = await db
    .insert(contactsTable)
    .values({
      organizationId: org.id,
      firstName: "Maria",
      lastName: "Gonzalez",
      email: "maria.gonzalez@example.com",
      phone: "+15125550101",
      preferredContactMethod: "sms",
    })
    .returning();
  const [james] = await db
    .insert(contactsTable)
    .values({
      organizationId: org.id,
      firstName: "James",
      lastName: "Whitfield",
      email: "james.whitfield@example.com",
      phone: "+15125550102",
      preferredContactMethod: "phone",
    })
    .returning();

  const [mariaHome] = await db
    .insert(propertiesTable)
    .values({
      organizationId: org.id,
      contactId: maria.id,
      addressLine1: "418 Cedar Bluff Dr",
      city: "Austin",
      state: "TX",
      postalCode: "78745",
      propertyType: "single_family",
    })
    .returning();
  const [jamesHome] = await db
    .insert(propertiesTable)
    .values({
      organizationId: org.id,
      contactId: james.id,
      addressLine1: "902 Lakeline Terrace",
      city: "Round Rock",
      state: "TX",
      postalCode: "78681",
      propertyType: "single_family",
    })
    .returning();

  const [leakLead] = await db
    .insert(leadsTable)
    .values({
      organizationId: org.id,
      contactId: maria.id,
      propertyId: mariaHome.id,
      status: "inspection_scheduled",
      urgency: "emergency",
      serviceType: "active-leak",
      source: "public-site",
      score: 85,
      scoreReasons: ["Active leak reported", "Marked as emergency urgency", "SMS consent granted (fast follow-up possible)"],
      summary: "[MOCK AI] active-leak request, urgency emergency. Water coming through kitchen ceiling after last storm.",
      estimatedValueCents: 1450000,
    })
    .returning();

  const [stormLead] = await db
    .insert(leadsTable)
    .values({
      organizationId: org.id,
      contactId: james.id,
      propertyId: jamesHome.id,
      status: "estimate_sent",
      urgency: "high",
      serviceType: "storm",
      source: "referral",
      score: 60,
      scoreReasons: ["Storm damage reported", "High urgency", "Email provided"],
      summary: "[MOCK AI] storm request, urgency high. Hail damage on north slope, insurance claim in progress.",
      estimatedValueCents: 2280000,
    })
    .returning();

  await db.insert(consentRecordsTable).values([
    {
      organizationId: org.id,
      contactId: maria.id,
      channel: "sms",
      granted: true,
      disclosureVersion: "2026-01",
      sourceIp: "203.0.113.10",
      userAgent: "seed-script",
    },
    {
      organizationId: org.id,
      contactId: maria.id,
      channel: "email",
      granted: true,
      disclosureVersion: "2026-01",
      sourceIp: "203.0.113.10",
      userAgent: "seed-script",
    },
  ]);

  await db.insert(crmTasksTable).values([
    {
      organizationId: org.id,
      leadId: leakLead.id,
      contactId: maria.id,
      title: "Confirm emergency tarp install",
      status: "open",
      priority: "emergency",
      dueAt: new Date(Date.now() + 4 * 3600_000),
    },
    {
      organizationId: org.id,
      leadId: stormLead.id,
      contactId: james.id,
      title: "Follow up on estimate #1042",
      status: "open",
      priority: "high",
      dueAt: new Date(Date.now() + 2 * 86_400_000),
    },
  ]);

  await db.insert(appointmentsTable).values({
    organizationId: org.id,
    leadId: leakLead.id,
    contactId: maria.id,
    propertyId: mariaHome.id,
    type: "inspection",
    status: "scheduled",
    scheduledStart: new Date(Date.now() + 86_400_000),
    notes: "Emergency leak inspection — bring tarp kit.",
  });

  await db.insert(activitiesTable).values([
    {
      organizationId: org.id,
      leadId: leakLead.id,
      contactId: maria.id,
      type: "lead_captured",
      title: "Assessment request submitted from public site",
      metadata: { seeded: true },
    },
    {
      organizationId: org.id,
      leadId: stormLead.id,
      contactId: james.id,
      type: "estimate_sent",
      title: "Estimate #1042 emailed to homeowner",
      metadata: { seeded: true },
    },
  ]);

  console.log("Seeded demo CRM data for", org.name);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
