import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as providers from "./providers";
import {
  adaptiveEmailProvider,
  gmailEmailProvider,
  isSafeMailbox,
} from "./providers";

describe("isSafeMailbox", () => {
  it("accepts plain mailboxes", () => {
    expect(isSafeMailbox("homeowner@example.com")).toBe(true);
    expect(isSafeMailbox("first.last+tag@sub.domain.co")).toBe(true);
  });

  it("rejects CRLF header-injection payloads", () => {
    expect(isSafeMailbox("victim@example.com\r\nBcc: evil@evil.com")).toBe(false);
    expect(isSafeMailbox("victim@example.com\nX-Injected: 1")).toBe(false);
  });

  it("rejects multiple recipients, display names, and whitespace", () => {
    expect(isSafeMailbox("a@example.com,b@example.com")).toBe(false);
    expect(isSafeMailbox("Evil <a@example.com>")).toBe(false);
    expect(isSafeMailbox(" a@example.com")).toBe(false);
    expect(isSafeMailbox("not-an-email")).toBe(false);
    expect(isSafeMailbox("")).toBe(false);
  });
});

describe("gmailEmailProvider", () => {
  it("refuses to send to an unsafe recipient before touching the network", async () => {
    await expect(
      gmailEmailProvider.send("victim@example.com\r\nBcc: evil@evil.com", "s", "b"),
    ).rejects.toThrow(/invalid recipient/i);
  });
});

describe("adaptiveEmailProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("propagates failure when Gmail throws and Resend is not configured", async () => {
    // Spy on the gmail provider to simulate a transient send failure.
    vi.spyOn(providers.gmailEmailProvider, "send").mockRejectedValue(
      new Error("connector not bound"),
    );
    await expect(
      adaptiveEmailProvider.send("user@example.com", "Subject", "Body"),
    ).rejects.toThrow(/connector not bound|All configured providers failed/i);
  });

  it("falls back to Resend when Gmail fails and Resend succeeds", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-resend-key");
    vi.spyOn(providers.gmailEmailProvider, "send").mockRejectedValue(
      new Error("gmail down"),
    );
    vi.spyOn(providers.resendEmailProvider, "send").mockResolvedValue({
      id: "resend-123",
      provider: "resend",
    });
    const result = await adaptiveEmailProvider.send("user@example.com", "Subject", "Body");
    expect(result.provider).toBe("resend");
    vi.unstubAllEnvs();
  });

  it("isSafeMailbox blocks header-injection before touching the network", () => {
    expect(isSafeMailbox("ok@example.com")).toBe(true);
    expect(isSafeMailbox("bad\r\nX-Header: injected@example.com")).toBe(false);
  });
});
