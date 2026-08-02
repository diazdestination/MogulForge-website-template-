import type { Server } from "http";
import type { AddressInfo } from "net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import app from "../../app";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

describe("GET /v1/storage/objects/* authentication", () => {
  it("returns 401 for unauthenticated requests", async () => {
    const res = await fetch(
      `${baseUrl}/api/v1/storage/objects/uploads/some-photo`,
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 for an invalid API key", async () => {
    const res = await fetch(
      `${baseUrl}/api/v1/storage/objects/uploads/some-photo`,
      { headers: { "x-api-key": "pk_not_a_real_key" } },
    );
    expect(res.status).toBe(401);
  });
});
