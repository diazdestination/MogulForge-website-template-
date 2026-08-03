import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { db, organizationsTable, usersTable } from "@workspace/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";

import app from "../../app";
import { createSession } from "../../lib/auth";

/**
 * Real-world win-back CSVs are much bigger than express.json()'s default
 * 100kb body cap. The lead-imports route mounts its own larger JSON limit —
 * this guards against a refactor silently reinstating the 100kb cap and
 * breaking imports for any file bigger than a toy sample.
 */

let server: Server;
let baseUrl: string;
let orgId: string;
let sid: string;

beforeAll(async () => {
  const [org] = await db
    .insert(organizationsTable)
    .values({ name: "Import Size Org", slug: `import-size-${Date.now()}` })
    .returning();
  orgId = org.id;
  const [u] = await db
    .insert(usersTable)
    .values({
      email: `import-size-${Date.now()}@example.com`,
      organizationId: orgId,
      role: "admin",
    })
    .returning();
  sid = await createSession({
    user: { id: u.id, email: null, firstName: null, lastName: null, profileImageUrl: null },
    access_token: "test-token",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await deleteTestOrgs(orgId);
});

describe("POST /v1/lead-imports body size", () => {
  it("accepts a CSV payload well above the 100kb default JSON limit", async () => {
    // >100kb (default express limit) and <5MB (route cap). Long name fields
    // keep the byte count high without making the row-by-row import slow.
    const pad = "x".repeat(90);
    const lines = ["First,Last,Email"];
    for (let i = 0; i < 1500; i++) {
      lines.push(`Big${i}${pad},Import${i}${pad},big-import-${i}@size-test.example.com`);
    }
    const csv = lines.join("\n");
    expect(csv.length).toBeGreaterThan(100 * 1024);

    const res = await fetch(`${baseUrl}/v1/lead-imports`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${sid}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        csv,
        mapping: { firstName: 0, lastName: 1, email: 2 },
        fileName: "big.csv",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { imported: number; totalRows: number };
    expect(body.totalRows).toBe(1500);
    expect(body.imported).toBe(1500);
  }, 60_000);

  it("rejects a CSV above the 5MB cap with a clear error", async () => {
    const csv = `First,Last,Email\n${"x".repeat(5 * 1024 * 1024 + 10)}`;
    const res = await fetch(`${baseUrl}/v1/lead-imports`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${sid}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ csv, mapping: { firstName: 0, lastName: 1, email: 2 } }),
    });
    expect(res.status).toBe(400);
  });
});
