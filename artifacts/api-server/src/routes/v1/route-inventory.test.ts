import { describe, expect, it } from "vitest";

import type { Permission } from "../../lib/permissions";
import v1Router from "./index";

/**
 * Route-inventory test: walks the actual mounted Express router and asserts
 * every non-public route is protected by `requireMember` with exactly the
 * permission the contract below expects. Fails when a route is added without
 * a guard, added without updating the contract, or mounted with the wrong
 * permission (e.g. a DELETE wired with crm.write).
 */

interface RouteEntry {
  method: string;
  path: string;
  /** Permissions of every requireMember guard on the route (usually one). */
  permissions: Permission[];
  /** Number of handlers on the route (guards + terminal handler). */
  handlerCount: number;
}

// Routes that are intentionally reachable without authentication.
// Adding a route here is an explicit, reviewable decision.
// - /public: unauthenticated marketing/lead-capture endpoints.
// - /portal: homeowner portal; authenticates with its own OTP magic-link
//   session token (x-portal-token) plus rate limiting, not requireMember.
const PUBLIC_ROUTE_PREFIXES = ["/public", "/portal"];

/**
 * The authorization contract: every protected `METHOD path` in the v1 API and
 * the permission its requireMember guard must carry.
 *
 * When you add, move, or remove a route, this test fails until you record the
 * route's expected permission here — that is the point. Choose deliberately:
 * - crm.read      — read CRM data (all active roles)
 * - crm.write     — create/update CRM records
 * - crm.delete    — destroy CRM records (owner/admin/sales_manager only)
 * - audit.read    — audit log (owner/admin)
 * - users.read    — list teammates
 * - users.manage  — invite/deactivate teammates (owner/admin)
 * - settings.manage — org configuration surfaces (owner/admin)
 */
const EXPECTED_PERMISSIONS: Record<string, Permission> = {
  // me / users
  "GET /me": "crm.read",
  "GET /users": "users.read",
  "POST /users/invite": "users.manage",
  "POST /users/:id/resend-invite": "users.manage",
  "PATCH /users/:id": "users.manage",
  // contacts & properties
  "GET /contacts": "crm.read",
  "POST /contacts": "crm.write",
  "GET /contacts/:id": "crm.read",
  "PATCH /contacts/:id": "crm.write",
  "DELETE /contacts/:id": "crm.delete",
  "GET /properties": "crm.read",
  "POST /properties": "crm.write",
  "GET /properties/:id": "crm.read",
  "PATCH /properties/:id": "crm.write",
  // leads
  "GET /leads": "crm.read",
  "POST /leads": "crm.write",
  "POST /leads/bulk": "crm.write",
  "GET /leads/duplicates": "crm.read",
  "GET /leads/:id": "crm.read",
  "PATCH /leads/:id": "crm.write",
  // Merging combines two records the rep can already edit; the losing lead
  // is archived (not destroyed), so plain write access is the right bar.
  "POST /leads/:id/merge": "crm.write",
  "GET /leads/:id/activities": "crm.read",
  "GET /leads/:id/behavior": "crm.read",
  "GET /leads/:id/conversations": "crm.read",
  "POST /leads/:id/activities": "crm.write",
  // Sends real outbound mail on behalf of the org, so it needs write access.
  "POST /leads/:id/send-email": "crm.write",
  // Rep photo upload — generates a presigned URL and attaches photos to timeline.
  "POST /leads/:id/photos/request-url": "crm.write",
  "POST /leads/:id/photos": "crm.write",
  "DELETE /leads/:id/photos": "crm.write",
  // assistant history is personal to the requesting user (scoped by user id);
  // reading and saving your own history only needs crm.read.
  "GET /assistant/history": "crm.read",
  "POST /assistant/history": "crm.read",
  // assistant chat only reads CRM data on the member's behalf; the route
  // itself performs no writes, so crm.read is the right bar.
  "POST /assistant/chat": "crm.read",
  // saved filters are personal to the requesting user (service layer scopes
  // them to user id), so managing your own only needs crm.read.
  "GET /saved-filters": "crm.read",
  "POST /saved-filters": "crm.read",
  "DELETE /saved-filters/:id": "crm.read",
  // estimates & projects
  "GET /estimates": "crm.read",
  "POST /estimates": "crm.write",
  "GET /estimates/:id": "crm.read",
  "PATCH /estimates/:id": "crm.write",
  "DELETE /estimates/:id": "crm.delete",
  "GET /projects": "crm.read",
  "POST /projects": "crm.write",
  "GET /projects/:id": "crm.read",
  "PATCH /projects/:id": "crm.write",
  "DELETE /projects/:id": "crm.delete",
  // tasks & appointments
  "GET /tasks": "crm.read",
  "POST /tasks": "crm.write",
  "PATCH /tasks/:id": "crm.write",
  "DELETE /tasks/:id": "crm.delete",
  "GET /appointments": "crm.read",
  "POST /appointments": "crm.write",
  "PATCH /appointments/:id": "crm.write",
  // dashboard & audit
  "GET /dashboard/summary": "crm.read",
  "GET /dashboard/marketing": "crm.read",
  "GET /audit-events": "audit.read",
  // settings surfaces
  "GET /settings": "crm.read",
  // read-only effective availability; needed by anyone booking appointments
  "GET /settings/inspection-availability": "crm.read",
  "GET /settings/email-provider": "settings.manage",
  "GET /settings/sms-provider": "settings.manage",
  "PUT /settings": "settings.manage",
  "GET /installation": "settings.manage",
  "POST /installation/checks": "settings.manage",
  "GET /forms": "settings.manage",
  "POST /forms": "settings.manage",
  "PATCH /forms/:id": "settings.manage",
  "DELETE /forms/:id": "settings.manage",
  "GET /forms/:id/submissions": "settings.manage",
  "GET /forms/:id/share": "settings.manage",
  "GET /knowledge": "settings.manage",
  "POST /knowledge": "settings.manage",
  "PATCH /knowledge/:id": "settings.manage",
  "DELETE /knowledge/:id": "settings.manage",
  "POST /installation/rotate": "settings.manage",
  "POST /installation/domains": "settings.manage",
  "DELETE /installation/domains/:id": "settings.manage",
  "GET /api-keys": "settings.manage",
  "POST /api-keys": "settings.manage",
  "PATCH /api-keys/:id": "settings.manage",
  "DELETE /api-keys/:id": "settings.manage",
  "GET /templates": "crm.read",
  "POST /templates": "settings.manage",
  "PATCH /templates/:id": "settings.manage",
  "DELETE /templates/:id": "settings.manage",
  "GET /automations": "crm.read",
  "POST /automations": "settings.manage",
  "PATCH /automations/:id": "settings.manage",
  "DELETE /automations/:id": "settings.manage",
  "GET /automation-runs": "crm.read",
  "GET /playbook-insights": "crm.read",
  "GET /next-actions": "crm.read",
  "GET /leads/:id/next-action": "crm.read",
  "POST /leads/:id/next-action/feedback": "crm.write",
  "GET /playbooks": "crm.read",
  "POST /playbooks": "settings.manage",
  "PATCH /playbooks/:id": "settings.manage",
  "GET /leads/:id/enrollment": "crm.read",
  "POST /enrollments/:id/pause": "crm.write",
  "POST /enrollments/:id/resume": "crm.write",
  "POST /enrollments/:id/skip": "crm.write",
  // reactivation (CSV import + win-back campaigns)
  "POST /lead-imports": "crm.write",
  "GET /lead-imports": "crm.read",
  "GET /reactivation/segments": "crm.read",
  "POST /reactivation/segments/preview": "crm.read",
  "GET /reactivation/campaigns": "crm.read",
  "POST /reactivation/campaigns": "crm.write",
  "POST /reactivation/campaigns/preview-outreach": "crm.write",
  "GET /reactivation/campaigns/:id": "crm.read",
  "POST /reactivation/campaigns/:id/launch": "crm.write",
  "POST /reactivation/campaigns/:id/pause": "crm.write",
  "POST /reactivation/campaigns/:id/resume": "crm.write",
  "POST /reactivation/campaigns/:id/cancel": "crm.write",
  "GET /webhooks": "settings.manage",
  "POST /webhooks": "settings.manage",
  "PATCH /webhooks/:id": "settings.manage",
  "POST /webhooks/:id/rotate-secret": "settings.manage",
  "DELETE /webhooks/:id/previous-secret": "settings.manage",
  "DELETE /webhooks/:id": "settings.manage",
  "GET /webhook-deliveries": "settings.manage",
  // tags
  "GET /tags": "crm.read",
  "POST /tags": "crm.write",
  // storage (photo streaming; service layer verifies org linkage)
  "GET /storage/objects/*path": "crm.read",
};

// DELETE routes allowed to use something weaker than crm.delete, with the
// reason. Everything else destructive must be crm.delete or settings.manage.
const DELETE_EXEMPTIONS: Record<string, Permission> = {
  // Personal, per-user resource — deleting your own saved filter.
  "DELETE /saved-filters/:id": "crm.read",
  // Removes one photo path from a lead's activity row, not the lead itself;
  // write-level access is the correct bar.
  "DELETE /leads/:id/photos": "crm.write",
};

function isTaggedGuard(
  handle: unknown,
): handle is { requiredPermission: Permission } {
  return (
    typeof handle === "function" &&
    typeof (handle as { requiredPermission?: unknown }).requiredPermission ===
      "string"
  );
}

/** Recursively collect every route mounted on a router. */
function collectRoutes(router: unknown, routes: RouteEntry[] = []): RouteEntry[] {
  const stack = (router as { stack?: unknown[] }).stack;
  if (!Array.isArray(stack)) return routes;
  for (const layer of stack as Array<{
    route?: {
      path: string | string[];
      stack: Array<{ method?: string; handle: unknown }>;
    };
    handle?: unknown;
  }>) {
    if (layer.route) {
      const paths = Array.isArray(layer.route.path)
        ? layer.route.path
        : [layer.route.path];
      const methods = new Set(
        layer.route.stack
          .map((l) => l.method)
          .filter((m): m is string => typeof m === "string"),
      );
      const permissions = layer.route.stack
        .map((l) => l.handle)
        .filter(isTaggedGuard)
        .map((h) => h.requiredPermission);
      for (const path of paths) {
        for (const method of methods) {
          routes.push({
            method: method.toUpperCase(),
            path,
            permissions,
            handlerCount: layer.route.stack.length,
          });
        }
      }
    } else if (
      layer.handle &&
      Array.isArray((layer.handle as { stack?: unknown[] }).stack)
    ) {
      // Nested router mounted via router.use()
      collectRoutes(layer.handle, routes);
    }
  }
  return routes;
}

const routes = collectRoutes(v1Router);
const isPublic = (path: string) =>
  PUBLIC_ROUTE_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
const protectedRoutes = routes.filter((r) => !isPublic(r.path));
const keyOf = (r: RouteEntry) => `${r.method} ${r.path}`;

describe("v1 route inventory", () => {
  it("discovers a non-trivial number of routes (walker sanity check)", () => {
    // If Express internals change and the walker silently finds nothing,
    // every other assertion would vacuously pass. Guard against that.
    expect(routes.length).toBeGreaterThanOrEqual(50);
    expect(protectedRoutes.length).toBeGreaterThanOrEqual(40);
  });

  it("every non-public route is guarded by requireMember", () => {
    const unguarded = protectedRoutes
      .filter((r) => r.permissions.length === 0)
      .map(keyOf);
    expect(unguarded, `Routes missing requireMember: ${unguarded.join(", ")}`)
      .toEqual([]);
  });

  it("every non-public route carries exactly the permission the contract expects", () => {
    const violations: string[] = [];
    for (const r of protectedRoutes) {
      const expected = EXPECTED_PERMISSIONS[keyOf(r)];
      if (!expected) {
        violations.push(
          `${keyOf(r)} is not in EXPECTED_PERMISSIONS — new routes must declare their permission in this contract`,
        );
        continue;
      }
      if (r.permissions.length !== 1 || r.permissions[0] !== expected) {
        violations.push(
          `${keyOf(r)} expected requireMember("${expected}"), found [${r.permissions.join(", ")}]`,
        );
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("the contract has no stale entries for routes that no longer exist", () => {
    const mounted = new Set(protectedRoutes.map(keyOf));
    const stale = Object.keys(EXPECTED_PERMISSIONS).filter(
      (key) => !mounted.has(key),
    );
    expect(stale, `Remove stale contract entries: ${stale.join(", ")}`)
      .toEqual([]);
  });

  it("DELETE routes are destructive-grade (crm.delete / settings.manage) unless explicitly exempted", () => {
    // Guards the contract itself: even a contract edit cannot quietly grant a
    // weak permission to a destructive route without an explicit exemption.
    const violations: string[] = [];
    for (const [key, expected] of Object.entries(EXPECTED_PERMISSIONS)) {
      if (!key.startsWith("DELETE ")) continue;
      const exemption = DELETE_EXEMPTIONS[key];
      if (exemption) {
        if (expected !== exemption) {
          violations.push(
            `${key} exemption says ${exemption} but contract says ${expected}`,
          );
        }
        continue;
      }
      if (expected !== "crm.delete" && expected !== "settings.manage") {
        violations.push(
          `${key} uses ${expected}; destructive routes need crm.delete or settings.manage (or an explicit exemption with rationale)`,
        );
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("requireMember runs alongside a terminal handler (guard is not the only handler)", () => {
    const suspicious = protectedRoutes
      .filter((r) => r.permissions.length > 0 && r.handlerCount < 2)
      .map(keyOf);
    expect(suspicious).toEqual([]);
  });
});
