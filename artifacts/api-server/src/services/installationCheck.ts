/**
 * "Test Installation" — server-side verification that a customer's website
 * actually carries the closer.js snippet with the right key.
 *
 * The check fetches the target domain's homepage (SSRF-guarded with the same
 * public-destination policy as outbound webhooks), scans the HTML for the
 * snippet, and classifies the result. Only the latest result per
 * (org, domain) is kept — rows are upserted.
 */
import {
  db,
  installationChecksTable,
  type InstallationCheck,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";

import {
  getActiveInstallationKey,
  isHostnameAuthorized,
  listAuthorizedDomains,
  normalizeDomain,
} from "./installation";
import { assertPublicDestination } from "./webhooks";

export type InstallationCheckStatus =
  | "installed"
  | "wrong_key"
  | "misconfigured"
  | "domain_not_authorized"
  | "not_detected"
  | "unreachable";

const FETCH_TIMEOUT_MS = 8_000;
const MAX_HTML_BYTES = 1_000_000; // scan at most ~1MB of the page

/** Matches any script tag whose src contains closer.js. */
const CLOSER_SCRIPT_RE = /<script\b[^>]*\bsrc\s*=\s*["'][^"']*closer\.js[^"']*["'][^>]*>/gi;
const ORG_ID_ATTR_RE = /\bdata-org-id\s*=\s*["']([^"']*)["']/i;

/**
 * Pure classification of a fetched page against the org's expected key and
 * whether the checked domain is on the authorized list. Exported for tests.
 */
export function classifyInstallation(params: {
  html: string;
  expectedKey: string;
  domainAuthorized: boolean;
}): { status: InstallationCheckStatus; detail: string } {
  const { html, expectedKey, domainAuthorized } = params;
  const tags = html.match(CLOSER_SCRIPT_RE) ?? [];
  if (tags.length === 0) {
    return {
      status: "not_detected",
      detail:
        "No closer.js script tag found on the page. Paste the snippet before the closing </body> tag, or publish your pending site changes.",
    };
  }
  const keys = tags
    .map((tag) => ORG_ID_ATTR_RE.exec(tag)?.[1]?.trim() ?? "")
    .filter((k, i, arr) => arr.indexOf(k) === i);
  if (keys.every((k) => !k)) {
    return {
      status: "misconfigured",
      detail:
        "The script tag is present but its data-org-id attribute is missing or empty. Re-copy the snippet from this page.",
    };
  }
  if (!keys.includes(expectedKey)) {
    return {
      status: "wrong_key",
      detail:
        "The script tag is present but carries a different installation key — likely a stale snippet from before a key rotation, or another organization's snippet. Replace it with the current one.",
    };
  }
  if (!domainAuthorized) {
    return {
      status: "domain_not_authorized",
      detail:
        "The snippet is installed correctly, but this domain isn't on your authorized list yet, so the widget won't load for visitors. Add the domain above.",
    };
  }
  return {
    status: "installed",
    detail: "Snippet found with the correct key on an authorized domain.",
  };
}

const MAX_REDIRECTS = 5;

/**
 * SSRF-safe GET: every hop — the initial URL and each redirect Location — is
 * re-validated against the public-destination policy before it is fetched.
 * Automatic redirect following would only validate the first URL, letting a
 * 30x bounce the request to an internal/metadata address.
 */
export async function fetchPublicUrl(startUrl: string): Promise<string> {
  let url = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicDestination(url);
    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "user-agent": "MogulForge-InstallCheck/1.0" },
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error(`HTTP ${res.status} without Location`);
      url = new URL(location, url).toString();
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    return text.slice(0, MAX_HTML_BYTES);
  }
  throw new Error("too many redirects");
}

/** Fetch the homepage HTML for a hostname; https first, http fallback. */
async function fetchHomepage(hostname: string): Promise<string> {
  let lastError: unknown;
  for (const scheme of ["https", "http"] as const) {
    try {
      return await fetchPublicUrl(`${scheme}://${hostname}/`);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("fetch failed");
}

/**
 * Run a check for one domain and persist the result. `fetchPage` is
 * injectable for tests (real sites can't be fetched from the test runner).
 */
export async function verifyInstallation(
  organizationId: string,
  rawDomain: string,
  fetchPage: (hostname: string) => Promise<string> = fetchHomepage,
): Promise<InstallationCheck | null> {
  const domain = normalizeDomain(rawDomain);
  if (!domain || domain.startsWith("*.")) return null;

  const [key, domains] = await Promise.all([
    getActiveInstallationKey(organizationId),
    listAuthorizedDomains(organizationId),
  ]);
  const domainAuthorized = isHostnameAuthorized(
    domain,
    domains.map((d) => d.domain),
  );

  let status: InstallationCheckStatus;
  let detail: string;
  try {
    const html = await fetchPage(domain);
    ({ status, detail } = classifyInstallation({
      html,
      expectedKey: key.publicKey,
      domainAuthorized,
    }));
  } catch (err) {
    status = "unreachable";
    detail = `Couldn't load https://${domain}/ — the site may be down, not public yet, or blocking automated requests (${err instanceof Error ? err.message : "fetch failed"}).`;
  }

  const [row] = await db
    .insert(installationChecksTable)
    .values({ organizationId, domain, status, detail })
    .onConflictDoUpdate({
      target: [
        installationChecksTable.organizationId,
        installationChecksTable.domain,
      ],
      set: { status, detail, checkedAt: new Date() },
    })
    .returning();
  return row;
}

/** Latest check per domain for the admin panel. */
export async function listInstallationChecks(
  organizationId: string,
): Promise<InstallationCheck[]> {
  return db
    .select()
    .from(installationChecksTable)
    .where(eq(installationChecksTable.organizationId, organizationId))
    .orderBy(installationChecksTable.domain);
}

/** Remove stored checks for a domain (used by tests / domain removal). */
export async function deleteInstallationCheck(
  organizationId: string,
  domain: string,
): Promise<void> {
  await db
    .delete(installationChecksTable)
    .where(
      and(
        eq(installationChecksTable.organizationId, organizationId),
        eq(installationChecksTable.domain, domain),
      ),
    );
}
