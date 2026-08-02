import { describe, expect, it } from "vitest";

process.env.SESSION_SECRET ??= "test-secret";

const {
  buildSignatureHeader,
  verifySignatureHeader,
  clampGracePeriodHours,
  rotateEndpointSecret,
  MAX_GRACE_PERIOD_HOURS,
} = await import("./webhooks");

describe("webhook secret rotation signatures", () => {
  const body = JSON.stringify({ event: "lead.created", data: { id: "x" } });
  const oldSecret = "whsec_oldsecret";
  const newSecret = "whsec_newsecret";

  it("single-secret header still verifies", () => {
    const header = buildSignatureHeader(newSecret, body);
    expect(verifySignatureHeader(newSecret, body, header)).toBe(true);
    expect(verifySignatureHeader(oldSecret, body, header)).toBe(false);
  });

  it("dual-secret header carries two v1 entries and verifies with either secret", () => {
    const header = buildSignatureHeader([newSecret, oldSecret], body);
    expect(header.match(/v1=/g)?.length).toBe(2);
    expect(verifySignatureHeader(newSecret, body, header)).toBe(true);
    expect(verifySignatureHeader(oldSecret, body, header)).toBe(true);
    expect(verifySignatureHeader("whsec_other", body, header)).toBe(false);
  });

  it("rejects stale timestamps", () => {
    const stale = Math.floor(Date.now() / 1000) - 600;
    const header = buildSignatureHeader([newSecret, oldSecret], body, stale);
    expect(verifySignatureHeader(newSecret, body, header)).toBe(false);
  });
});

describe("grace period clamp", () => {
  it("clamps values above the 7-day max", () => {
    expect(clampGracePeriodHours(10_000)).toBe(MAX_GRACE_PERIOD_HOURS);
    expect(clampGracePeriodHours(169)).toBe(168);
  });

  it("passes through valid values", () => {
    expect(clampGracePeriodHours(0)).toBe(0);
    expect(clampGracePeriodHours(24)).toBe(24);
    expect(clampGracePeriodHours(168)).toBe(168);
  });

  it("rejects negatives and non-finite values", () => {
    expect(() => clampGracePeriodHours(-1)).toThrow(RangeError);
    expect(() => clampGracePeriodHours(Number.NaN)).toThrow(RangeError);
    expect(() => clampGracePeriodHours(Number.POSITIVE_INFINITY)).toThrow(
      RangeError,
    );
  });

  it("rotateEndpointSecret rejects negative grace windows before touching the db", async () => {
    await expect(rotateEndpointSecret("org", "id", -5)).rejects.toThrow(
      RangeError,
    );
  });
});
