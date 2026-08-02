import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  customFetch,
  setAuthTokenGetter,
  setBaseUrl,
  setUnauthorizedHandler,
} from "./custom-fetch";

function jsonResponse(
  status: number,
  body: unknown,
  statusText = "",
): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(response: Response) {
  const spy = vi.fn(async () => response);
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  setUnauthorizedHandler(null);
  setBaseUrl(null);
  setAuthTokenGetter(null);
  vi.unstubAllGlobals();
});

describe("customFetch unauthorized handler", () => {
  it("fires the handler exactly once on a 401 and still throws the ApiError", async () => {
    mockFetch(jsonResponse(401, { message: "session expired" }, "Unauthorized"));
    const handler = vi.fn();
    setUnauthorizedHandler(handler);

    const error = await customFetch("/api/leads").catch((e) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(error);
  });

  it("awaits an async handler before throwing", async () => {
    mockFetch(jsonResponse(401, { message: "expired" }));
    const order: string[] = [];
    setUnauthorizedHandler(async () => {
      await Promise.resolve();
      order.push("handler");
    });

    await customFetch("/api/leads").catch(() => order.push("throw"));

    expect(order).toEqual(["handler", "throw"]);
  });

  it.each([400, 403, 404, 500])(
    "does not fire the handler on HTTP %i",
    async (status) => {
      mockFetch(jsonResponse(status, { message: "nope" }));
      const handler = vi.fn();
      setUnauthorizedHandler(handler);

      const error = await customFetch("/api/leads").catch((e) => e);

      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(status);
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it("does not fire the handler on success", async () => {
    mockFetch(jsonResponse(200, { ok: true }));
    const handler = vi.fn();
    setUnauthorizedHandler(handler);

    await expect(customFetch("/api/leads")).resolves.toEqual({ ok: true });
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not fire the handler on a network error", async () => {
    const failure = new TypeError("Network request failed");
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(failure)));
    const handler = vi.fn();
    setUnauthorizedHandler(handler);

    await expect(customFetch("/api/leads")).rejects.toBe(failure);
    expect(handler).not.toHaveBeenCalled();
  });

  it("a throwing handler does not mask the original ApiError", async () => {
    mockFetch(jsonResponse(401, { message: "expired" }));
    setUnauthorizedHandler(() => {
      throw new Error("handler exploded");
    });

    const error = await customFetch("/api/leads").catch((e) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
  });

  it("a rejecting async handler does not mask the original ApiError", async () => {
    mockFetch(jsonResponse(401, { message: "expired" }));
    setUnauthorizedHandler(async () => {
      throw new Error("async handler exploded");
    });

    const error = await customFetch("/api/leads").catch((e) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
  });

  it("throws the ApiError without invoking anything when no handler is set (401)", async () => {
    mockFetch(jsonResponse(401, { message: "expired" }));

    const error = await customFetch("/api/leads").catch((e) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect((error as ApiError).data).toEqual({ message: "expired" });
  });

  it("stops firing after the handler is cleared with null", async () => {
    mockFetch(jsonResponse(401, { message: "expired" }));
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    setUnauthorizedHandler(null);

    await expect(customFetch("/api/leads")).rejects.toBeInstanceOf(ApiError);
    expect(handler).not.toHaveBeenCalled();
  });

  it("passes the parsed error body to the handler", async () => {
    mockFetch(jsonResponse(401, { message: "token revoked" }));
    let received: ApiError | null = null;
    setUnauthorizedHandler((error) => {
      received = error;
    });

    await customFetch("/api/leads").catch(() => {});

    expect(received).not.toBeNull();
    expect(received!.data).toEqual({ message: "token revoked" });
    expect(received!.method).toBe("GET");
  });
});
