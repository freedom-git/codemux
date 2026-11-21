import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isElectron: vi.fn<() => boolean>(),
}));

vi.mock("../../../../src/lib/platform", () => ({ isElectron: mocks.isElectron }));

import {
  buildTunnelReauthUrl,
  clearTunnelAuthIssue,
  isDevTunnelOrigin,
  probeTunnelAuth,
  resetTunnelAuthStateForTests,
  sanitizeClientReturnPath,
  setTunnelAuthNavigatorForTests,
  triggerTunnelReauth,
  tunnelAuthRedirecting,
  tunnelAuthStatus,
} from "../../../../src/lib/tunnel-auth";

describe("isDevTunnelOrigin", () => {
  it.each([
    ["https://codemux-test-8233.jpe1.devtunnels.ms", true],
    ["https://codemux-test-8233.devtunnels.ms", true],
    ["http://codemux-test-8233.jpe1.devtunnels.ms", false],
    ["https://demo.trycloudflare.com", false],
    ["https://codemux.example.com", false],
    ["http://localhost:8233", false],
    ["http://127.0.0.1:8233", false],
    ["", false],
  ])("classifies %s as %s", (origin, expected) => {
    expect(isDevTunnelOrigin(origin)).toBe(expected);
  });
});

describe("sanitizeClientReturnPath", () => {
  it.each([
    ["/chat", "/chat"],
    ["/chat?session=1#bottom", "/chat?session=1#bottom"],
    ["", "/"],
    ["https://evil.example/login", "/"],
    ["//evil.example/login", "/"],
    ["/\\evil.example", "/"],
    ["/api/auth/tunnel-return?returnTo=/chat", "/"],
    ["/ws", "/"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(sanitizeClientReturnPath(input)).toBe(expected);
  });
});

describe("tunnel-auth flow", () => {
  const fetchMock = vi.fn<typeof fetch>();
  let navigations: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    resetTunnelAuthStateForTests();
    mocks.isElectron.mockReturnValue(false);
    navigations = [];
    setTunnelAuthNavigatorForTests((url) => navigations.push(url));
    const session = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => session.get(key) ?? null,
      setItem: (key: string, value: string) => session.set(key, value),
      removeItem: (key: string) => session.delete(key),
    });
    vi.stubGlobal("window", {
      location: {
        origin: "https://codemux-test-8233.jpe1.devtunnels.ms",
        pathname: "/chat",
        search: "?from=mobile",
        hash: "",
      },
    });
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    resetTunnelAuthStateForTests();
    vi.unstubAllGlobals();
  });

  it("builds a Service-Worker-bypassing reauth URL for the current route", () => {
    expect(buildTunnelReauthUrl()).toBe("/api/auth/tunnel-return?returnTo=%2Fchat%3Ffrom%3Dmobile");
  });

  it("allows explicit user retry to bypass the automatic redirect cooldown", () => {
    expect(triggerTunnelReauth()).toBe(true);
    expect(triggerTunnelReauth()).toBe(false);
    expect(triggerTunnelReauth({ force: true })).toBe(true);
    expect(navigations).toEqual([
      "/api/auth/tunnel-return?returnTo=%2Fchat%3Ffrom%3Dmobile",
      "/api/auth/tunnel-return?returnTo=%2Fchat%3Ffrom%3Dmobile",
    ]);
  });

  it("probes gateway reachability on WebSocket disconnect and redirects once on tunnel sign-in expiry", async () => {
    fetchMock.mockResolvedValueOnce({
      type: "opaqueredirect",
      status: 0,
      ok: false,
      headers: new Headers(),
    } as Response);

    expect(await probeTunnelAuth()).toBe("reauth_required");
    expect(fetchMock).toHaveBeenCalledWith("/api/system/is-local", {
      cache: "no-store",
      redirect: "manual",
      signal: expect.any(AbortSignal),
    });
    expect(tunnelAuthStatus()).toBe("reauth_required");
    expect(tunnelAuthRedirecting()).toBe(true);
    expect(navigations).toEqual(["/api/auth/tunnel-return?returnTo=%2Fchat%3Ffrom%3Dmobile"]);

    clearTunnelAuthIssue();
    expect(tunnelAuthStatus()).toBe("ok");
    expect(tunnelAuthRedirecting()).toBe(false);
  });

  it("never redirects or probes in Electron desktop mode or on non-Dev-Tunnel origins", async () => {
    mocks.isElectron.mockReturnValue(true);
    expect(triggerTunnelReauth({ force: true })).toBe(false);
    expect(await probeTunnelAuth({ force: true })).toBe("ok");

    mocks.isElectron.mockReturnValue(false);
    vi.stubGlobal("window", {
      location: {
        origin: "https://demo.trycloudflare.com",
        pathname: "/chat",
        search: "",
        hash: "",
      },
    });
    expect(triggerTunnelReauth({ force: true })).toBe(false);
    expect(await probeTunnelAuth({ force: true })).toBe("ok");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(navigations).toEqual([]);
  });
});
