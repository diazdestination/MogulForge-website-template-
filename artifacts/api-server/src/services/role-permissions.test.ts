import { db, organizationsTable, usersTable, type User } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";

import { hasPermission, type Permission } from "../lib/permissions";
import { requireMember } from "../middlewares/requireMember";

/**
 * Role-permission matrix tests.
 *
 * These assert, for every role:
 *  1. The server permission matrix (`hasPermission`) grants/denies the
 *     operations each CRM route family uses (contacts, leads, tasks,
 *     appointments read/write/delete + audit log read).
 *  2. The real `requireMember` middleware enforces the same decisions
 *     against actual users stored in the database.
 *  3. The frontend permission helpers in
 *     `command-center/src/lib/permissions.ts` agree with the server matrix,
 *     so UI/API drift fails this suite.
 */

const ALL_ROLES = [
  "owner",
  "admin",
  "sales_manager",
  "sales_rep",
  "inspector",
  "production",
  "office",
  "viewer",
] as const;

type Role = (typeof ALL_ROLES)[number];

// Expected server-side matrix. If lib/permissions.ts changes, this fails
// loudly and forces a deliberate review of both server and UI.
const EXPECTED: Record<Permission, Role[]> = {
  "crm.read": [...ALL_ROLES],
  "crm.write": [
    "owner",
    "admin",
    "sales_manager",
    "sales_rep",
    "inspector",
    "production",
    "office",
  ],
  "crm.delete": ["owner", "admin", "sales_manager"],
  "audit.read": ["owner", "admin"],
  "users.read": [...ALL_ROLES],
  "users.manage": ["owner", "admin"],
  "settings.manage": ["owner", "admin"],
};

// Permissions each CRM route family requires (mirrors routes/v1/*.ts).
const ROUTE_OPERATIONS: Record<string, Permission[]> = {
  contacts: ["crm.read", "crm.write", "crm.delete"],
  leads: ["crm.read", "crm.write"],
  tasks: ["crm.read", "crm.write", "crm.delete"],
  appointments: ["crm.read", "crm.write"],
  auditLog: ["audit.read"],
};

let usersByRole: Record<Role, User>;
let org: { id: string };

// Frontend permission helpers, loaded at runtime from the command-center
// artifact. Dynamic (non-literal) import keeps this file out of the
// api-server tsc project graph while vitest still resolves and runs it.
/* eslint-disable @typescript-eslint/no-explicit-any */
let fe: {
  RoleHierarchy: Record<string, number>;
  canWrite: (role?: string | null) => boolean;
  canDelete: (role?: string | null) => boolean;
  canViewAuditLog: (role?: string | null) => boolean;
  canManageSettings: (role?: string | null) => boolean;
};

beforeAll(async () => {
  const fePath = new URL(
    "../../../command-center/src/lib/permissions.ts",
    import.meta.url,
  ).pathname;
  fe = await import(fePath);
  const slug = `test-perms-${Date.now()}`;
  const [o] = await db
    .insert(organizationsTable)
    .values({ name: `Perm Test Org ${slug}`, slug })
    .returning();
  org = o;

  usersByRole = {} as Record<Role, User>;
  for (const role of ALL_ROLES) {
    const [user] = await db
      .insert(usersTable)
      .values({
        email: `perm-${role}-${Date.now()}@test.example.com`,
        firstName: "Perm",
        lastName: role,
        organizationId: org.id,
        role,
        isActive: true,
      })
      .returning();
    usersByRole[role] = user;
  }
});

afterAll(async () => {
  await deleteTestOrgs(org.id);
});

/** Run the real requireMember middleware for a user; returns HTTP-ish result. */
async function runMiddleware(
  userId: string | null,
  permission: Permission,
): Promise<{ status: number | null; nextCalled: boolean }> {
  let status: number | null = null;
  let nextCalled = false;
  const req = {
    isAuthenticated: () => userId !== null,
    user: userId ? { id: userId } : undefined,
    header: () => undefined,
  } as unknown as Request;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json() {
      return this;
    },
  } as unknown as Response;
  const next: NextFunction = () => {
    nextCalled = true;
  };
  await requireMember(permission)(req, res, next);
  return { status, nextCalled };
}

describe("server permission matrix (hasPermission)", () => {
  for (const [family, permissions] of Object.entries(ROUTE_OPERATIONS)) {
    for (const permission of permissions) {
      for (const role of ALL_ROLES) {
        const allowed = EXPECTED[permission].includes(role);
        it(`${family}: ${role} is ${allowed ? "allowed" : "denied"} ${permission}`, () => {
          expect(hasPermission(role, permission)).toBe(allowed);
        });
      }
    }
  }

  it("viewer can never write or delete any CRM record", () => {
    expect(hasPermission("viewer", "crm.write")).toBe(false);
    expect(hasPermission("viewer", "crm.delete")).toBe(false);
    expect(hasPermission("viewer", "audit.read")).toBe(false);
    expect(hasPermission("viewer", "settings.manage")).toBe(false);
    expect(hasPermission("viewer", "crm.read")).toBe(true);
  });
});

describe("requireMember middleware enforces the matrix against real users", () => {
  const checkedPermissions: Permission[] = [
    "crm.read",
    "crm.write",
    "crm.delete",
    "audit.read",
    "settings.manage",
  ];

  for (const permission of checkedPermissions) {
    for (const role of ALL_ROLES) {
      const allowed = EXPECTED[permission].includes(role);
      it(`${role} → ${permission}: ${allowed ? "passes" : "403"}`, async () => {
        const result = await runMiddleware(usersByRole[role].id, permission);
        if (allowed) {
          expect(result.nextCalled).toBe(true);
          expect(result.status).toBeNull();
        } else {
          expect(result.nextCalled).toBe(false);
          expect(result.status).toBe(403);
        }
      });
    }
  }

  it("unauthenticated requests get 401", async () => {
    const result = await runMiddleware(null, "crm.read");
    expect(result.status).toBe(401);
    expect(result.nextCalled).toBe(false);
  });

  it("inactive users get 403 even with a privileged role", async () => {
    const owner = usersByRole.owner;
    const [inactive] = await db
      .insert(usersTable)
      .values({
        email: `perm-inactive-${Date.now()}@test.example.com`,
        organizationId: owner.organizationId,
        role: "owner",
        isActive: false,
      })
      .returning();
    const result = await runMiddleware(inactive.id, "crm.read");
    expect(result.status).toBe(403);
    expect(result.nextCalled).toBe(false);
  });

  it("users without an organization get 403", async () => {
    const [orphan] = await db
      .insert(usersTable)
      .values({
        email: `perm-orphan-${Date.now()}@test.example.com`,
        role: "owner",
        isActive: true,
      })
      .returning();
    const result = await runMiddleware(orphan.id, "crm.read");
    expect(result.status).toBe(403);
    expect(result.nextCalled).toBe(false);
  });
});

describe("frontend permission helpers stay in sync with server matrix", () => {
  it("frontend knows exactly the same set of roles", () => {
    expect(Object.keys(fe.RoleHierarchy).sort()).toEqual([...ALL_ROLES].sort());
  });

  for (const role of ALL_ROLES) {
    it(`${role}: canWrite matches server crm.write`, () => {
      expect(fe.canWrite(role)).toBe(hasPermission(role, "crm.write"));
    });
    it(`${role}: canDelete matches server crm.delete`, () => {
      expect(fe.canDelete(role)).toBe(hasPermission(role, "crm.delete"));
    });
    it(`${role}: canViewAuditLog matches server audit.read`, () => {
      expect(fe.canViewAuditLog(role)).toBe(hasPermission(role, "audit.read"));
    });
    it(`${role}: canManageSettings matches server settings.manage`, () => {
      expect(fe.canManageSettings(role)).toBe(
        hasPermission(role, "settings.manage"),
      );
    });
  }

  it("frontend helpers deny everything for missing role", () => {
    expect(fe.canWrite(null)).toBe(false);
    expect(fe.canDelete(undefined)).toBe(false);
    expect(fe.canViewAuditLog(null)).toBe(false);
    expect(fe.canManageSettings(null)).toBe(false);
  });
});
