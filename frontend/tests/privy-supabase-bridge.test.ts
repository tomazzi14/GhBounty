/**
 * Unit tests for `lib/privy-supabase-bridge.ts`.
 *
 * Covers:
 *   - Returns null when no Privy getter is registered.
 *   - Caches the minted Supabase token until it nears expiry.
 *   - Refreshes when within the safety window of expiry.
 *   - Dedupes concurrent calls so only one /api/auth/privy-bridge fires.
 *   - Recovers gracefully from non-200 / network errors.
 *   - `clearPrivySession` wipes both the getter and the cache.
 *
 * `vi.resetModules()` between tests gives us a fresh module-level state
 * (the bridge is a singleton-by-design).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FetchSpy = ReturnType<typeof vi.fn>;

interface BridgeModule {
  registerPrivyTokenGetter: (fn: () => Promise<string | null>) => void;
  clearPrivySession: () => void;
  getSupabaseAccessToken: () => Promise<string | null>;
}

async function loadFreshModule(): Promise<BridgeModule> {
  vi.resetModules();
  return (await import("@/lib/privy-supabase-bridge")) as unknown as BridgeModule;
}

function mockOkResponse(token: string, expiresAt: number) {
  return {
    ok: true,
    json: async () => ({
      supabaseAccessToken: token,
      expiresAt,
      sub: "did:privy:test",
    }),
  } as unknown as Response;
}

function mockErrorResponse(status = 500) {
  return {
    ok: false,
    status,
    json: async () => ({ error: "boom" }),
  } as unknown as Response;
}

let fetchSpy: FetchSpy;

beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  // Pin Date.now so we don't accidentally cross expiry boundaries.
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("getSupabaseAccessToken — no getter registered", () => {
  it("returns null and does NOT call /api/auth/privy-bridge", async () => {
    const m = await loadFreshModule();
    const result = await m.getSupabaseAccessToken();
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("getSupabaseAccessToken — happy path", () => {
  it("calls the bridge route and returns the minted token", async () => {
    const m = await loadFreshModule();
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    fetchSpy.mockResolvedValue(mockOkResponse("supabase-token-1", expiresAt));
    m.registerPrivyTokenGetter(async () => "privy-token");

    const result = await m.getSupabaseAccessToken();

    expect(result).toBe("supabase-token-1");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("/api/auth/privy-bridge");
    expect(init).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(JSON.parse(init.body)).toEqual({ privyAccessToken: "privy-token" });
  });

  it("returns null if the Privy getter resolves to null", async () => {
    const m = await loadFreshModule();
    m.registerPrivyTokenGetter(async () => null);

    const result = await m.getSupabaseAccessToken();
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("trims the call body to JSON-serialized payload", async () => {
    const m = await loadFreshModule();
    fetchSpy.mockResolvedValue(
      mockOkResponse("t", Math.floor(Date.now() / 1000) + 3600),
    );
    m.registerPrivyTokenGetter(async () => "tok");

    await m.getSupabaseAccessToken();
    const init = fetchSpy.mock.calls[0]![1];
    const body = JSON.parse(init.body);
    expect(Object.keys(body)).toEqual(["privyAccessToken"]);
  });
});

describe("getSupabaseAccessToken — caching", () => {
  it("returns the cached token on the second call (no refetch)", async () => {
    const m = await loadFreshModule();
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    fetchSpy.mockResolvedValue(mockOkResponse("cached", expiresAt));
    m.registerPrivyTokenGetter(async () => "tok");

    expect(await m.getSupabaseAccessToken()).toBe("cached");
    expect(await m.getSupabaseAccessToken()).toBe("cached");
    expect(await m.getSupabaseAccessToken()).toBe("cached");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("refetches when the token is past expiry", async () => {
    const m = await loadFreshModule();
    const nowS = Math.floor(Date.now() / 1000);
    fetchSpy
      .mockResolvedValueOnce(mockOkResponse("first", nowS + 100))
      .mockResolvedValueOnce(mockOkResponse("second", nowS + 7200));
    m.registerPrivyTokenGetter(async () => "tok");

    expect(await m.getSupabaseAccessToken()).toBe("first");

    // Advance past expiry
    vi.setSystemTime(new Date(Date.now() + 200_000));

    expect(await m.getSupabaseAccessToken()).toBe("second");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("refetches when within the 60s safety window before expiry", async () => {
    const m = await loadFreshModule();
    const nowS = Math.floor(Date.now() / 1000);
    fetchSpy
      .mockResolvedValueOnce(mockOkResponse("first", nowS + 90))
      .mockResolvedValueOnce(mockOkResponse("second", nowS + 7200));
    m.registerPrivyTokenGetter(async () => "tok");

    expect(await m.getSupabaseAccessToken()).toBe("first");

    // Advance 31s — now we have only 59s left, inside the safety window.
    vi.setSystemTime(new Date(Date.now() + 31_000));

    expect(await m.getSupabaseAccessToken()).toBe("second");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("does NOT refetch when comfortably outside the safety window", async () => {
    const m = await loadFreshModule();
    const nowS = Math.floor(Date.now() / 1000);
    fetchSpy.mockResolvedValueOnce(mockOkResponse("first", nowS + 3600));
    m.registerPrivyTokenGetter(async () => "tok");

    expect(await m.getSupabaseAccessToken()).toBe("first");
    vi.setSystemTime(new Date(Date.now() + 60_000)); // 1 min in
    expect(await m.getSupabaseAccessToken()).toBe("first");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("getSupabaseAccessToken — concurrent dedupe", () => {
  it("collapses parallel calls into a single fetch", async () => {
    const m = await loadFreshModule();
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    let resolveFetch: ((v: Response) => void) | undefined;
    fetchSpy.mockReturnValue(
      new Promise<Response>((res) => {
        resolveFetch = res;
      }),
    );
    m.registerPrivyTokenGetter(async () => "tok");

    const a = m.getSupabaseAccessToken();
    const b = m.getSupabaseAccessToken();
    const c = m.getSupabaseAccessToken();

    // The inflight fetch is launched from an async IIFE, so let the
    // microtask queue drain before asserting on the spy.
    await Promise.resolve();
    await Promise.resolve();

    // Only one fetch even though 3 callers asked.
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    resolveFetch!(mockOkResponse("the-token", expiresAt));
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect(ra).toBe("the-token");
    expect(rb).toBe("the-token");
    expect(rc).toBe("the-token");
  });

  it("after dedupe resolves, next call uses the cache", async () => {
    const m = await loadFreshModule();
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    fetchSpy.mockResolvedValue(mockOkResponse("the-token", expiresAt));
    m.registerPrivyTokenGetter(async () => "tok");

    await Promise.all([m.getSupabaseAccessToken(), m.getSupabaseAccessToken()]);
    await m.getSupabaseAccessToken();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("getSupabaseAccessToken — error handling", () => {
  it("returns null and clears cache on non-2xx response", async () => {
    const m = await loadFreshModule();
    fetchSpy.mockResolvedValue(mockErrorResponse(500));
    m.registerPrivyTokenGetter(async () => "tok");

    const result = await m.getSupabaseAccessToken();
    expect(result).toBeNull();
  });

  it("returns null on fetch network error", async () => {
    const m = await loadFreshModule();
    fetchSpy.mockRejectedValue(new TypeError("fetch failed"));
    m.registerPrivyTokenGetter(async () => "tok");

    const result = await m.getSupabaseAccessToken();
    expect(result).toBeNull();
  });

  it("retries on the next call after a transient error (no permanent breakage)", async () => {
    const m = await loadFreshModule();
    const nowS = Math.floor(Date.now() / 1000);
    fetchSpy
      .mockRejectedValueOnce(new TypeError("flaky"))
      .mockResolvedValueOnce(mockOkResponse("retry-success", nowS + 3600));
    m.registerPrivyTokenGetter(async () => "tok");

    expect(await m.getSupabaseAccessToken()).toBeNull();
    expect(await m.getSupabaseAccessToken()).toBe("retry-success");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("does NOT cache the result of an error response", async () => {
    const m = await loadFreshModule();
    fetchSpy
      .mockResolvedValueOnce(mockErrorResponse(500))
      .mockResolvedValueOnce(
        mockOkResponse(
          "ok-after-fail",
          Math.floor(Date.now() / 1000) + 3600,
        ),
      );
    m.registerPrivyTokenGetter(async () => "tok");

    expect(await m.getSupabaseAccessToken()).toBeNull();
    expect(await m.getSupabaseAccessToken()).toBe("ok-after-fail");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe("clearPrivySession", () => {
  it("wipes the getter so subsequent calls return null", async () => {
    const m = await loadFreshModule();
    fetchSpy.mockResolvedValue(
      mockOkResponse("t", Math.floor(Date.now() / 1000) + 3600),
    );
    m.registerPrivyTokenGetter(async () => "tok");
    await m.getSupabaseAccessToken();

    m.clearPrivySession();

    const result = await m.getSupabaseAccessToken();
    expect(result).toBeNull();
  });

  it("wipes the cached token so a re-registered getter triggers a fresh fetch", async () => {
    const m = await loadFreshModule();
    const nowS = Math.floor(Date.now() / 1000);
    fetchSpy
      .mockResolvedValueOnce(mockOkResponse("first-session", nowS + 3600))
      .mockResolvedValueOnce(mockOkResponse("second-session", nowS + 3600));
    m.registerPrivyTokenGetter(async () => "tok-a");

    expect(await m.getSupabaseAccessToken()).toBe("first-session");

    m.clearPrivySession();
    m.registerPrivyTokenGetter(async () => "tok-b");

    expect(await m.getSupabaseAccessToken()).toBe("second-session");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe("Privy getter rotation", () => {
  it("uses the most recently registered getter", async () => {
    const m = await loadFreshModule();
    const nowS = Math.floor(Date.now() / 1000);
    fetchSpy.mockResolvedValue(mockOkResponse("any", nowS + 3600));

    const getterA = vi.fn(async () => "tok-a");
    const getterB = vi.fn(async () => "tok-b");
    m.registerPrivyTokenGetter(getterA);
    m.registerPrivyTokenGetter(getterB);

    await m.getSupabaseAccessToken();
    expect(getterA).not.toHaveBeenCalled();
    expect(getterB).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0]![1];
    expect(JSON.parse(init.body)).toEqual({ privyAccessToken: "tok-b" });
  });
});
