import { db, organizationsTable } from "@workspace/db";
import app from "./app";
import { logger } from "./lib/logger";
import {
  ensureDefaultAutomations,
  startAutomationScheduler,
} from "./services/automation";
import { ensureDefaultServiceAreas } from "./services/settings";

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
  // One-time (idempotent) seeding of default automations for existing orgs.
  void (async () => {
    const orgs = await db
      .select({ id: organizationsTable.id })
      .from(organizationsTable);
    for (const org of orgs) {
      await ensureDefaultAutomations(org.id);
      await ensureDefaultServiceAreas(org.id);
    }
  })().catch((err) =>
    logger.error({ err }, "Seeding default automations / service areas failed"),
  );
});
