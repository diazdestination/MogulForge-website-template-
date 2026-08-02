import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  db,
  webhookDeliveriesTable,
  webhookEndpointsTable,
  type WebhookEndpoint,
} from "@workspace/db";
import { and, eq, isNotNull, isNull, lte, or, sql } from "drizzle-orm";

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = [0, 60_000, 300_000]; // immediate, 1m, 5m

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString("hex")}`;
}

// ---------- secret encryption at rest (AES-256-GCM) ----------

const ENC_PREFIX = "enc:v1:";

function encryptionKey(): Buffer {
  const raw = process.env.SESSION_SECRET;
  if (!raw) throw new Error("SESSION_SECRET is required to encrypt webhook secrets");
  return createHash("sha256").update(raw).digest();
}

/** Encrypt a webhook signing secret for storage. Format: enc:v1:<iv>:<tag>:<ciphertext> (base64). */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

/** Decrypt a stored secret. Legacy plaintext (`whsec_...`) values pass through. */
export function decryptSecret(stored: string): string {
  if (!stored.startsWith(ENC_PREFIX)) return stored;
  const [ivB64, tagB64, ctB64] = stored.slice(ENC_PREFIX.length).split(":");
  if (!ivB64 || !tagB64 || !ctB64) throw new Error("malformed encrypted secret");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

// ---------- signing (Stripe-style, scheme "v1") ----------
//
// The X-Painless-Signature header has the form:
//   t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">
// Receivers verify by recomputing HMAC-SHA256(secret, `${t}.${body}`) with
// the secret shown once at endpoint creation, comparing in constant time,
// and rejecting stale timestamps (e.g. older than 5 minutes) to prevent
// replay attacks.

export const SIGNATURE_VERSION = "v1";

export function signPayload(secret: string, body: string, timestamp: number): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/**
 * Build the full X-Painless-Signature header value. When multiple secrets
 * are provided (e.g. during a rotation grace window), the header carries one
 * `v1=` entry per secret — new secret first — so receivers can verify
 * against whichever secret they hold.
 */
export function buildSignatureHeader(
  secret: string | string[],
  body: string,
  timestamp: number = Math.floor(Date.now() / 1000),
): string {
  const secrets = Array.isArray(secret) ? secret : [secret];
  const parts = secrets.map((s) => `v1=${signPayload(s, body, timestamp)}`);
  return `t=${timestamp},${parts.join(",")}`;
}

/**
 * All secrets currently valid for signing an endpoint's deliveries: the
 * active secret plus, during a rotation grace window, the previous one.
 */
export function activeSigningSecrets(endpoint: WebhookEndpoint): string[] {
  const secrets = [decryptSecret(endpoint.secret)];
  if (
    endpoint.previousSecret &&
    endpoint.previousSecretExpiresAt &&
    endpoint.previousSecretExpiresAt.getTime() > Date.now()
  ) {
    secrets.push(decryptSecret(endpoint.previousSecret));
  }
  return secrets;
}

/**
 * Verify an X-Painless-Signature header (reference implementation for
 * receivers and for tests). Rejects if the timestamp is outside tolerance.
 */
export function verifySignatureHeader(
  secret: string,
  body: string,
  header: string,
  toleranceSeconds = 300,
  now: number = Math.floor(Date.now() / 1000),
): boolean {
  const pairs = header
    .split(",")
    .map((p) => p.split("=", 2) as [string, string]);
  const tRaw = pairs.find(([k]) => k === "t")?.[1];
  const v1s = pairs.filter(([k]) => k === "v1").map(([, v]) => v);
  const t = Number(tRaw);
  if (!Number.isFinite(t) || v1s.length === 0) return false;
  if (Math.abs(now - t) > toleranceSeconds) return false;
  const expected = Buffer.from(signPayload(secret, body, t), "hex");
  // A header may carry several v1 entries during secret rotation; the
  // signature is valid if any of them matches this secret.
  return v1s.some((v1) => {
    const a = Buffer.from(v1, "hex");
    return a.length === expected.length && timingSafeEqual(a, expected);
  });
}

/**
 * SSRF guard: only allow http(s) URLs on default ports pointing at public
 * hosts. Blocks localhost, private/link-local ranges, and cloud metadata.
 */
export function isWebhookUrlAllowed(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (url.port && url.port !== "80" && url.port !== "443") return false;
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "metadata.google.internal"
  ) {
    return false;
  }
  // Literal IP hosts must pass the IP-level policy directly.
  const literal = host.replace(/^\[|\]$/g, "");
  if (isIP(literal) && !isIpAllowed(literal)) return false;
  return true;
}

/** IP-level policy: reject loopback, private, link-local, ULA, and metadata ranges. */
export function isIpAllowed(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) {
    const parts = address.split(".").map(Number);
    const [a, b] = [parts[0], parts[1]];
    if (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) || // link-local incl. 169.254.169.254 metadata
      (a === 100 && b >= 64 && b <= 127) // CGNAT
    ) {
      return false;
    }
    return true;
  }
  if (kind === 6) {
    const h = address.toLowerCase();
    if (
      h === "::1" ||
      h === "::" ||
      h.startsWith("fe80") ||
      h.startsWith("fc") ||
      h.startsWith("fd") ||
      h.startsWith("::ffff:") // IPv4-mapped — validate the embedded IPv4
    ) {
      if (h.startsWith("::ffff:")) {
        const v4 = h.slice(7);
        return isIP(v4) === 4 ? isIpAllowed(v4) : false;
      }
      return false;
    }
    return true;
  }
  return false;
}

/**
 * Resolve a hostname and require EVERY resolved address (A + AAAA) to be
 * public. Defends against DNS-based SSRF where a public-looking hostname
 * resolves to an internal IP.
 */
export async function assertPublicDestination(rawUrl: string): Promise<void> {
  if (!isWebhookUrlAllowed(rawUrl)) throw new Error("blocked URL");
  const host = new URL(rawUrl).hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (!isIpAllowed(host)) throw new Error("blocked URL");
    return;
  }
  const records = await lookup(host, { all: true, verbatim: true });
  if (records.length === 0) throw new Error("unresolvable host");
  for (const record of records) {
    if (!isIpAllowed(record.address)) throw new Error("blocked URL");
  }
}

// ---------- endpoint CRUD (org-scoped) ----------

export async function listEndpoints(organizationId: string) {
  return db
    .select()
    .from(webhookEndpointsTable)
    .where(eq(webhookEndpointsTable.organizationId, organizationId))
    .orderBy(webhookEndpointsTable.createdAt);
}

export async function createEndpoint(
  organizationId: string,
  input: { url: string; events?: string[] },
) {
  const secret = generateWebhookSecret();
  const [row] = await db
    .insert(webhookEndpointsTable)
    .values({
      organizationId,
      url: input.url,
      events: input.events ?? [],
      secret: encryptSecret(secret),
    })
    .returning();
  // Return the plaintext secret exactly once, at creation time.
  return { ...row, secret };
}

export async function updateEndpoint(
  organizationId: string,
  id: string,
  input: { url?: string; events?: string[]; isActive?: boolean },
) {
  const [row] = await db
    .update(webhookEndpointsTable)
    .set(input)
    .where(
      and(
        eq(webhookEndpointsTable.id, id),
        eq(webhookEndpointsTable.organizationId, organizationId),
      ),
    )
    .returning();
  return row ?? null;
}

/** Longest allowed rotation grace window: 7 days. */
export const MAX_GRACE_PERIOD_HOURS = 168;

/**
 * Enforce the grace-window invariant for every caller: negatives (and
 * non-finite values) are rejected, anything above 7 days is clamped to
 * MAX_GRACE_PERIOD_HOURS.
 */
export function clampGracePeriodHours(gracePeriodHours: number): number {
  if (!Number.isFinite(gracePeriodHours) || gracePeriodHours < 0) {
    throw new RangeError(
      `gracePeriodHours must be a non-negative number, got ${gracePeriodHours}`,
    );
  }
  return Math.min(gracePeriodHours, MAX_GRACE_PERIOD_HOURS);
}

/**
 * Rotate an endpoint's signing secret. Returns the new plaintext secret
 * exactly once. When `gracePeriodHours > 0`, the old secret keeps being
 * honored (deliveries carry both signatures) until the window elapses.
 * The grace window is clamped to MAX_GRACE_PERIOD_HOURS regardless of caller.
 */
export async function rotateEndpointSecret(
  organizationId: string,
  id: string,
  gracePeriodHours: number,
) {
  gracePeriodHours = clampGracePeriodHours(gracePeriodHours);
  const [existing] = await db
    .select()
    .from(webhookEndpointsTable)
    .where(
      and(
        eq(webhookEndpointsTable.id, id),
        eq(webhookEndpointsTable.organizationId, organizationId),
      ),
    );
  if (!existing) return null;
  const secret = generateWebhookSecret();
  const grace = gracePeriodHours > 0;
  const [row] = await db
    .update(webhookEndpointsTable)
    .set({
      secret: encryptSecret(secret),
      previousSecret: grace ? existing.secret : null,
      previousSecretExpiresAt: grace
        ? new Date(Date.now() + gracePeriodHours * 3_600_000)
        : null,
    })
    .where(eq(webhookEndpointsTable.id, existing.id))
    .returning();
  // Return the plaintext secret exactly once, at rotation time.
  return { ...row, secret };
}

/**
 * End a rotation grace window early: the old secret stops being honored
 * immediately. No-op when no grace window is active.
 */
export async function expirePreviousSecret(organizationId: string, id: string) {
  const [row] = await db
    .update(webhookEndpointsTable)
    .set({ previousSecret: null, previousSecretExpiresAt: null })
    .where(
      and(
        eq(webhookEndpointsTable.id, id),
        eq(webhookEndpointsTable.organizationId, organizationId),
      ),
    )
    .returning();
  return row ?? null;
}
export async function deleteEndpoint(organizationId: string, id: string) {
  const rows = await db
    .update(webhookEndpointsTable)
    .set({ isActive: false })
    .where(
      and(
        eq(webhookEndpointsTable.id, id),
        eq(webhookEndpointsTable.organizationId, organizationId),
      ),
    )
    .returning({ id: webhookEndpointsTable.id });
  return rows.length > 0;
}

export async function listDeliveries(organizationId: string, endpointId?: string) {
  const scope = eq(webhookDeliveriesTable.organizationId, organizationId);
  return db
    .select()
    .from(webhookDeliveriesTable)
    .where(
      endpointId
        ? and(scope, eq(webhookDeliveriesTable.endpointId, endpointId))
        : scope,
    )
    .orderBy(sql`${webhookDeliveriesTable.createdAt} desc`)
    .limit(200);
}

// ---------- delivery ----------

/** Queue a signed delivery to every active endpoint subscribed to this event. */
export async function dispatchWebhookEvent(
  organizationId: string,
  event: string,
  payload: Record<string, unknown>,
): Promise<number> {
  const endpoints = await db
    .select()
    .from(webhookEndpointsTable)
    .where(
      and(
        eq(webhookEndpointsTable.organizationId, organizationId),
        eq(webhookEndpointsTable.isActive, true),
      ),
    );
  const matching = endpoints.filter(
    (e) => e.events.length === 0 || e.events.includes(event),
  );
  let queued = 0;
  for (const endpoint of matching) {
    const fullPayload = { event, timestamp: new Date().toISOString(), data: payload };
    const body = JSON.stringify(fullPayload);
    const [delivery] = await db
      .insert(webhookDeliveriesTable)
      .values({
        organizationId,
        endpointId: endpoint.id,
        event,
        payload: fullPayload,
        signature: buildSignatureHeader(activeSigningSecrets(endpoint), body),
        signatureVersion: SIGNATURE_VERSION,
        nextAttemptAt: new Date(),
      })
      .returning();
    queued++;
    // Attempt immediately, fire-and-forget; retries handled by the scheduler.
    void attemptDelivery(delivery.id, endpoint).catch(() => {});
  }
  return queued;
}

export async function attemptDelivery(
  deliveryId: string,
  endpointHint?: WebhookEndpoint,
): Promise<void> {
  const [delivery] = await db
    .select()
    .from(webhookDeliveriesTable)
    .where(eq(webhookDeliveriesTable.id, deliveryId));
  if (!delivery || delivery.status === "success") return;

  const endpoint =
    endpointHint ??
    (
      await db
        .select()
        .from(webhookEndpointsTable)
        .where(eq(webhookEndpointsTable.id, delivery.endpointId))
    )[0];
  if (!endpoint || !endpoint.isActive) {
    await db
      .update(webhookDeliveriesTable)
      .set({ status: "failed", lastError: "endpoint inactive", nextAttemptAt: null })
      .where(eq(webhookDeliveriesTable.id, deliveryId));
    return;
  }

  // SSRF gate at send time: string policy + DNS resolution of every address.
  try {
    await assertPublicDestination(endpoint.url);
  } catch (err) {
    await db
      .update(webhookDeliveriesTable)
      .set({
        status: "failed",
        lastError: err instanceof Error ? err.message : "blocked URL",
        nextAttemptAt: null,
      })
      .where(eq(webhookDeliveriesTable.id, deliveryId));
    return;
  }

  const attempts = delivery.attempts + 1;
  const body = JSON.stringify(delivery.payload);
  // Re-sign with a fresh timestamp on every attempt so receivers can apply
  // replay-window checks even for retried deliveries.
  const signature = buildSignatureHeader(activeSigningSecrets(endpoint), body);
  await db
    .update(webhookDeliveriesTable)
    .set({ signature, signatureVersion: SIGNATURE_VERSION })
    .where(eq(webhookDeliveriesTable.id, deliveryId));
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-painless-signature": signature,
        "x-painless-signature-version": SIGNATURE_VERSION,
        "x-painless-event": delivery.event,
        "x-painless-delivery-id": delivery.id,
      },
      body,
      signal: controller.signal,
      // Never follow redirects: a safe URL could redirect to an internal target.
      redirect: "manual",
    });
    clearTimeout(timer);
    if (res.status >= 300 && res.status < 400) {
      await recordFailure(deliveryId, attempts, "redirects not followed", res.status);
      return;
    }
    if (res.ok) {
      await db
        .update(webhookDeliveriesTable)
        .set({
          status: "success",
          attempts,
          responseStatus: res.status,
          deliveredAt: new Date(),
          nextAttemptAt: null,
        })
        .where(eq(webhookDeliveriesTable.id, deliveryId));
      return;
    }
    await recordFailure(deliveryId, attempts, `HTTP ${res.status}`, res.status);
  } catch (err) {
    await recordFailure(
      deliveryId,
      attempts,
      err instanceof Error ? err.message : "request failed",
    );
  }
}

async function recordFailure(
  deliveryId: string,
  attempts: number,
  error: string,
  responseStatus?: number,
) {
  const exhausted = attempts >= MAX_ATTEMPTS;
  await db
    .update(webhookDeliveriesTable)
    .set({
      status: exhausted ? "failed" : "pending",
      attempts,
      lastError: error,
      responseStatus: responseStatus ?? null,
      nextAttemptAt: exhausted
        ? null
        : new Date(Date.now() + (RETRY_DELAY_MS[attempts] ?? 300_000)),
    })
    .where(eq(webhookDeliveriesTable.id, deliveryId));
}

/**
 * Null out previous secrets whose rotation grace window has elapsed.
 * They are no longer honored for signing; keeping the expired encrypted
 * material around is unnecessary risk. Called by the scheduler tick.
 * Returns the number of endpoints cleaned.
 */
export async function cleanupExpiredPreviousSecrets(
  now: Date = new Date(),
): Promise<number> {
  const rows = await db
    .update(webhookEndpointsTable)
    .set({ previousSecret: null, previousSecretExpiresAt: null })
    .where(
      and(
        isNotNull(webhookEndpointsTable.previousSecret),
        lte(webhookEndpointsTable.previousSecretExpiresAt, now),
      ),
    )
    .returning({ id: webhookEndpointsTable.id });
  return rows.length;
}

/** Retry due pending deliveries. Called by the scheduler tick. */
export async function processPendingDeliveries(): Promise<number> {
  const due = await db
    .select({ id: webhookDeliveriesTable.id })
    .from(webhookDeliveriesTable)
    .where(
      and(
        eq(webhookDeliveriesTable.status, "pending"),
        or(
          isNull(webhookDeliveriesTable.nextAttemptAt),
          lte(webhookDeliveriesTable.nextAttemptAt, new Date()),
        ),
      ),
    )
    .limit(20);
  for (const row of due) {
    await attemptDelivery(row.id);
  }
  return due.length;
}
