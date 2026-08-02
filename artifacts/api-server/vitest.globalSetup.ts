/**
 * Vitest global setup: make sure the test database has the schema before any
 * test runs. On a fresh checkout the database is empty, which previously
 * produced 40+ cryptic 42P01 "relation does not exist" failures.
 *
 * Strategy: probe for a core table; if missing, run the drizzle schema push
 * automatically. If either the connection or the push fails, abort the run
 * with one clear, actionable message.
 */
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

const PUSH_HINT =
  "Run `pnpm --filter @workspace/db run push` to set up the database schema, then re-run the tests.";

export default async function globalSetup(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is not set — api-server tests need a database. Did you forget to provision one? " +
        PUSH_HINT,
    );
  }

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
  } catch (err) {
    throw new Error(
      `Could not connect to the database at DATABASE_URL: ${(err as Error).message}. ` +
        "Make sure the database is running before executing api-server tests.",
    );
  }

  try {
    const { rows } = await client.query<{ ok: boolean }>(
      "SELECT to_regclass('public.organizations') IS NOT NULL AS ok",
    );
    if (rows[0]?.ok) return; // schema is present — nothing to do

    console.log(
      "[api-server tests] Database schema missing (fresh checkout?) — running drizzle push...",
    );
    const repoRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../..",
    );
    try {
      execSync("pnpm --filter @workspace/db run push-force", {
        cwd: repoRoot,
        stdio: "inherit",
        env: process.env,
      });
    } catch {
      throw new Error(
        `Automatic schema push failed. ${PUSH_HINT}`,
      );
    }

    // Verify the push actually created the schema.
    const check = await client.query<{ ok: boolean }>(
      "SELECT to_regclass('public.organizations') IS NOT NULL AS ok",
    );
    if (!check.rows[0]?.ok) {
      throw new Error(
        `Schema push ran but the schema is still missing. ${PUSH_HINT}`,
      );
    }
    console.log("[api-server tests] Database schema is ready.");
  } finally {
    await client.end();
  }
}
