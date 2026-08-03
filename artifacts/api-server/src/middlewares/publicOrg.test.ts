/**
 * Regression: keyed public routes must never trust request headers to decide
 * that a request is "same-origin". An attacker who forges x-forwarded-host
 * (and Host) to match their own Origin must still be forced through the
 * authorized-domain allow-list — otherwise any stolen public key works from
 * any website.
 */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { db, organizationsTable } from "@workspace/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import app from "../app";
import { getActiveInstallationKey } from "../services/installation";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";

import { ownHostnames } from "./publicOrg";

let server: Server;
let baseUrl: string;
let org: { id: string };
let publicKey: string;

beforeAll(async () => {
  const [row] = await db
    .insert(organizationsTable)
    .values({ name: "PublicOrg Bypass Test", slug: `test-publicorg-${Date.now()}` })
    .returning();
  org = row;
  const key = await getActiveInstallationKey(org.id);
  publicKey = key.publicKey;
  server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  server?.close();
  await deleteTestOrgs(org.id);
});

describe("resolvePublicOrg same-host allowance", () => {
  it("rejects a forged x-forwarded-host/Host matching the attacker's Origin", async () => {
    const res = await fetch(
      `${baseUrl}/api/v1/public/forms/roof-assessment?installationKey=${publicKey}`,
      {
        headers: {
          Origin: "https://attacker.example",
          "X-Forwarded-Host": "attacker.example",
          Host: "attacker.example",
        },
      },
    );
    // Not on the allow-list and NOT recognized as our own host → 403.
    expect(res.status).toBe(403);
  });

  it("rejects keyed requests with no Origin/Referer at all", async () => {
    const res = await fetch(
      `${baseUrl}/api/v1/public/forms/roof-assessment?installationKey=${publicKey}`,
    );
    expect(res.status).toBe(403);
  });

  it("accepts a same-origin request only for hosts from trusted env vars", async () => {
    const own = [...ownHostnames()];
    expect(own.length).toBeGreaterThan(0);
    const res = await fetch(
      `${baseUrl}/api/v1/public/forms/roof-assessment?installationKey=${publicKey}`,
      { headers: { Origin: `https://${own[0]}` } },
    );
    // Own-host origin passes authz; the seeded default form exists → 200.
    expect(res.status).toBe(200);
  });
});
