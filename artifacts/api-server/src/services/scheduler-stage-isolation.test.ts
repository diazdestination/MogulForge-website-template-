import { db } from "@workspace/db";
import { afterEach, describe, expect, it, vi } from "vitest";

// Spy on the webhook stage so we can prove it runs even when an earlier
// scheduler stage crashes.
vi.mock("./webhooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./webhooks")>();
  return {
    ...actual,
    processPendingDeliveries: vi.fn(async () => {}),
    cleanupExpiredPreviousSecrets: vi.fn(async () => {}),
  };
});

// Keep the abandoned-chat sweep observable (and side-effect free) too.
vi.mock("./concierge", () => ({
  markAbandonedConversations: vi.fn(async () => {}),
}));

import { markAbandonedConversations } from "./concierge";
import { processScheduledWork } from "./automation";
import {
  cleanupExpiredPreviousSecrets,
  processPendingDeliveries,
} from "./webhooks";

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("scheduler stage isolation", () => {
  it("still runs webhook retries and later stages when the scheduled-actions stage throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Make the first stage's DB query blow up (simulates a DB error while
    // querying due scheduled actions).
    vi.spyOn(db, "select").mockImplementationOnce(() => {
      throw new Error("boom: scheduled actions query failed");
    });

    await expect(processScheduledWork()).resolves.toBeUndefined();

    expect(processPendingDeliveries).toHaveBeenCalledTimes(1);
    expect(cleanupExpiredPreviousSecrets).toHaveBeenCalledTimes(1);
    expect(markAbandonedConversations).toHaveBeenCalledTimes(1);
    expect(
      errorSpy.mock.calls.some((args) =>
        String(args[0]).includes('scheduler stage "scheduled-actions" failed'),
      ),
    ).toBe(true);
  });

  it("still runs the abandoned-chat sweep when webhook retries throw", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(processPendingDeliveries).mockRejectedValueOnce(
      new Error("boom: webhook retry crashed"),
    );

    await expect(processScheduledWork()).resolves.toBeUndefined();

    expect(markAbandonedConversations).toHaveBeenCalledTimes(1);
    expect(
      errorSpy.mock.calls.some((args) =>
        String(args[0]).includes('scheduler stage "webhook-retries" failed'),
      ),
    ).toBe(true);
  });

  it("completes cleanly when no stage throws", async () => {
    await expect(processScheduledWork()).resolves.toBeUndefined();
    expect(processPendingDeliveries).toHaveBeenCalledTimes(1);
    expect(markAbandonedConversations).toHaveBeenCalledTimes(1);
  });
});
