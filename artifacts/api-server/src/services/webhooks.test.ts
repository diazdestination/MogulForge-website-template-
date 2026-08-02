import { beforeAll, describe, expect, it } from "vitest";

import {
  assertPublicDestination,
  buildSignatureHeader,
  decryptSecret,
  encryptSecret,
  isIpAllowed,
  isWebhookUrlAllowed,
  signPayload,
  verifySignatureHeader,
} from "./webhooks";

describe("webhook SSRF protections", () => {
  it("blocks non-http schemes and odd ports", () => {
    expect(isWebhookUrlAllowed("ftp://example.com/hook")).toBe(false);
    expect(isWebhookUrlAllowed("file:///etc/passwd")).toBe(false);
    expect(isWebhookUrlAllowed("https://example.com:8443/hook")).toBe(false);
    expect(isWebhookUrlAllowed("http://example.com:22/hook")).toBe(false);
    expect(isWebhookUrlAllowed("not a url")).toBe(false);
    expect(isWebhookUrlAllowed("https://example.com/hook")).toBe(true);
    expect(isWebhookUrlAllowed("http://example.com/hook")).toBe(true);
  });

  it("blocks localhost and internal hostnames", () => {
    expect(isWebhookUrlAllowed("http://localhost/hook")).toBe(false);
    expect(isWebhookUrlAllowed("http://foo.localhost/hook")).toBe(false);
    expect(isWebhookUrlAllowed("http://service.internal/hook")).toBe(false);
    expect(isWebhookUrlAllowed("http://printer.local/hook")).toBe(false);
    expect(isWebhookUrlAllowed("http://metadata.google.internal/computeMetadata")).toBe(false);
  });

  it("blocks private, loopback, link-local, metadata, and CGNAT IPv4", () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.5",
      "172.16.1.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "0.0.0.0",
      "100.64.0.1",
    ]) {
      expect(isIpAllowed(ip), ip).toBe(false);
      expect(isWebhookUrlAllowed(`http://${ip}/hook`), ip).toBe(false);
    }
    expect(isIpAllowed("8.8.8.8")).toBe(true);
    expect(isIpAllowed("172.32.0.1")).toBe(true);
  });

  it("blocks IPv6 loopback, link-local, ULA, and mapped-private addresses", () => {
    for (const ip of ["::1", "fe80::1", "fc00::1", "fd12::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"]) {
      expect(isIpAllowed(ip), ip).toBe(false);
    }
    expect(isIpAllowed("2607:f8b0::1")).toBe(true);
    expect(isWebhookUrlAllowed("http://[::1]/hook")).toBe(false);
  });

  it("assertPublicDestination rejects literal private IPs and blocked URLs", async () => {
    await expect(assertPublicDestination("http://169.254.169.254/latest")).rejects.toThrow();
    await expect(assertPublicDestination("http://localhost/hook")).rejects.toThrow();
    await expect(assertPublicDestination("ftp://example.com/hook")).rejects.toThrow();
  });

  it("assertPublicDestination rejects hostnames resolving to private IPs (DNS rebinding)", async () => {
    // localtest.me and *.nip.io style hosts resolve to 127.0.0.1 — if DNS is
    // unavailable in this environment, resolution failure also rejects.
    await expect(assertPublicDestination("http://localtest.me/hook")).rejects.toThrow();
  });

});

describe("webhook signing (v1 scheme)", () => {
  const ts = 1_754_000_000;

  it("signs payloads deterministically with HMAC-SHA256 over timestamp.body", () => {
    const sig = signPayload("whsec_test", '{"a":1}', ts);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(signPayload("whsec_test", '{"a":1}', ts)).toBe(sig);
    expect(signPayload("whsec_other", '{"a":1}', ts)).not.toBe(sig);
    expect(signPayload("whsec_test", '{"a":1}', ts + 1)).not.toBe(sig);
    expect(signPayload("whsec_test", '{"a":2}', ts)).not.toBe(sig);
  });

  it("builds a Stripe-style t=...,v1=... header", () => {
    const header = buildSignatureHeader("whsec_test", '{"a":1}', ts);
    expect(header).toBe(`t=${ts},v1=${signPayload("whsec_test", '{"a":1}', ts)}`);
  });

  it("verifies valid headers and rejects tampering", () => {
    const body = '{"event":"lead.created"}';
    const header = buildSignatureHeader("whsec_test", body, ts);
    expect(verifySignatureHeader("whsec_test", body, header, 300, ts + 10)).toBe(true);
    expect(verifySignatureHeader("whsec_other", body, header, 300, ts + 10)).toBe(false);
    expect(verifySignatureHeader("whsec_test", '{"event":"x"}', header, 300, ts + 10)).toBe(false);
    expect(verifySignatureHeader("whsec_test", body, "garbage", 300, ts + 10)).toBe(false);
  });

  it("rejects stale timestamps outside the tolerance window", () => {
    const body = "{}";
    const header = buildSignatureHeader("whsec_test", body, ts);
    expect(verifySignatureHeader("whsec_test", body, header, 300, ts + 301)).toBe(false);
    expect(verifySignatureHeader("whsec_test", body, header, 300, ts - 301)).toBe(false);
  });
});

describe("webhook secret encryption at rest", () => {
  beforeAll(() => {
    process.env.SESSION_SECRET ??= "test-session-secret";
  });

  it("round-trips secrets and never stores plaintext", () => {
    const secret = "whsec_abc123";
    const stored = encryptSecret(secret);
    expect(stored.startsWith("enc:v1:")).toBe(true);
    expect(stored).not.toContain(secret);
    expect(decryptSecret(stored)).toBe(secret);
    // Distinct IVs: encrypting twice yields different ciphertexts.
    expect(encryptSecret(secret)).not.toBe(stored);
  });

  it("passes legacy plaintext secrets through unchanged", () => {
    expect(decryptSecret("whsec_legacy")).toBe("whsec_legacy");
  });

  it("rejects malformed ciphertext", () => {
    expect(() => decryptSecret("enc:v1:not-valid")).toThrow();
  });
});
