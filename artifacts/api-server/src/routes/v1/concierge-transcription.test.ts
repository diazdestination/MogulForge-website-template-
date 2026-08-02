import type { Server } from "http";
import type { AddressInfo } from "net";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Stub the OpenAI-backed transcription so the HTTP flow is exercised
// end-to-end without real network traffic or an API key requirement.
const transcribeAudioMock = vi.fn(async () => "hello roof");
vi.mock("../../services/providers", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../services/providers")>();
  return { ...actual, transcribeAudio: transcribeAudioMock };
});

// Import after the mock so the route module picks up the stub.
const { default: app } = await import("../../app");

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

afterEach(() => {
  transcribeAudioMock.mockClear();
});

async function post(body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/v1/public/concierge/transcriptions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/public/concierge/transcriptions", () => {
  it("rejects invalid bodies", async () => {
    const res = await post({ mimeType: "audio/m4a" });
    expect(res.status).toBe(400);
    expect(transcribeAudioMock).not.toHaveBeenCalled();
  });

  it("rejects unsupported audio types", async () => {
    const res = await post({ audioBase64: "aGVsbG8=", mimeType: "application/json" });
    expect(res.status).toBe(400);
    expect(transcribeAudioMock).not.toHaveBeenCalled();
  });

  it("rejects empty audio", async () => {
    const res = await post({ audioBase64: "", mimeType: "audio/m4a" });
    expect(res.status).toBe(400);
    expect(transcribeAudioMock).not.toHaveBeenCalled();
  });

  it("rejects audio above the 5MB cap without calling the provider", async () => {
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64");
    const res = await post({ audioBase64: oversized, mimeType: "audio/m4a" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/too large/i);
    expect(transcribeAudioMock).not.toHaveBeenCalled();
  });

  it("accepts a realistic multi-hundred-KB clip (body limit is raised for this route)", async () => {
    // ~20s of recorded audio easily exceeds Express's default ~100kb JSON
    // limit once base64-encoded; this guards the route-scoped parser.
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = prev ?? "test-key";
    try {
      const clip = Buffer.alloc(600 * 1024, 7).toString("base64");
      const res = await post({ audioBase64: clip, mimeType: "audio/m4a" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { text: string };
      expect(body.text).toBe("hello roof");
      expect(transcribeAudioMock).toHaveBeenCalledTimes(1);
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev;
    }
  });

  it("returns 503 when transcription is not configured", async () => {
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const res = await post({ audioBase64: "aGVsbG8=", mimeType: "audio/m4a" });
      expect(res.status).toBe(503);
      expect(transcribeAudioMock).not.toHaveBeenCalled();
    } finally {
      if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
    }
  });
});
