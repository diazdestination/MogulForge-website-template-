import { db, organizationsTable } from "@workspace/db";
import app from "./app";
import { logger } from "./lib/logger";
import {
  ensureDefaultAutomations,
  startAutomationScheduler,
} from "./services/automation";
import { ensureDefaultServiceAreas, getOrgSettings } from "./services/settings";
import { ensureInstallation } from "./services/installation";
import { ensurePlatformAdmins } from "./services/org";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  startAutomationScheduler();
  // One-time (idempotent) grant: default-org owners become platform admins.
  void ensurePlatformAdmins().catch((err: unknown) =>
    logger.error({ err }, "Ensuring platform admins failed"),
  );
  // One-time (idempotent) seeding of default automations for existing orgs.
  void (async () => {
    const orgs = await db
      .select({ id: organizationsTable.id })
      .from(organizationsTable);
    for (const org of orgs) {
      await ensureDefaultAutomations(org.id);
      await ensureDefaultServiceAreas(org.id);
      // Seed an installation key + authorized domains so the existing
      // first-party website keeps working when it starts sending its key.
      const settings = await getOrgSettings(org.id).catch(() => null);
      const seedDomains = ["localhost"];
      const site = settings?.businessProfile?.website;
      if (site) seedDomains.push(site);
      if (process.env.REPLIT_DEV_DOMAIN) {
        seedDomains.push(process.env.REPLIT_DEV_DOMAIN);
      }
      await ensureInstallation(org.id, seedDomains).catch((err) =>
        logger.error({ err, orgId: org.id }, "Seeding installation failed"),
      );
    }
  })().catch((err) =>
    logger.error({ err }, "Seeding default automations / service areas failed"),
  );
});
