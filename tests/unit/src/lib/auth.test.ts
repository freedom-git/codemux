import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isElectron: vi.fn<() => boolean>(),
  validateToken: vi.fn(),
}));

vi.mock("../../../../src/lib/platform", () => ({ isElectron: mocks.isElectron }));
vi.mock("../../../../src/lib/electron-api", () => ({ authAPI: { validateToken: mocks.validateToken } }));
vi.mock("../../../../src/lib/logger", () => ({ logger: { error: vi.fn() } }));

import { Auth } from "../../../../src/lib/auth";
import {
  resetTunnelAuthStateForTests,
  setTunnelAuthNavigatorForTests,
  tunnelAuthRedirecting,
  tunnelAuthStatus,
} from "../../../../src/lib/tunnel-auth";

describe("Auth.checkDeviceToken", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.clearAllMocks();
    resetTunnelAuthStateForTests();
    mocks.isElectron.mockReturnValue(false);
    const storage = new Map<string, string>();
    const session = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => session.get(key) ?? null,
      setItem: (key: string, value: string) => session.set(key, value),
      removeItem: (key: string) => session.delete(key),
    });
    vi.stubGlobal("fetch", fetchMock);
    Auth.saveToken("device-token");
    Auth.saveDeviceId("approved-device");
  });

  afterEach(() => {
    resetTunnelAuthStateForTests();
    vi.unstubAllGlobals();
  });

  function validationResponse(status: number, body: unknown = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  it("returns false without making a validation request when there is no token", async () => {
    Auth.clearAuth();
    expect(await Auth.checkDeviceToken()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the saved browser token and refreshes the device ID after successful validation", async () => {
    fetchMock.mockResolvedValueOnce(validationResponse(200, { valid: true, deviceId: "confirmed-device" }));
    expect(await Auth.checkDeviceToken()).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/validate", {
      headers: { Authorization: "Bearer device-token" }, cache: "no-store", signal: expect.any(AbortSignal),
    });
    expect(Auth.getToken()).toBe("device-token");
    expect(Auth.getDeviceId()).toBe("confirmed-device");
  });

  it.each([
    [401, { error: "Unauthorized" }],
    [200, { valid: false }],
  ])("clears device approval only after confirmed rejection (%i)", async (status, body) => {
    fetchMock.mockResolvedValueOnce(validationResponse(status as number, body));
    expect(await Auth.checkDeviceToken()).toBe(false);
    expect(Auth.getToken()).toBeNull();
    expect(Auth.getDeviceId()).toBeNull();
  });

  it.each([403, 429, 500, 502, 503])("preserves device approval when validation is unavailable (%i)", async status => {
    fetchMock.mockResolvedValueOnce(validationResponse(status, { valid: false, error: "Access unavailable" }));
    expect(await Auth.checkDeviceToken()).toBe(true);
    expect(Auth.getToken()).toBe("device-token");
    expect(Auth.getDeviceId()).toBe("approved-device");
  });

  it("validates the same approved device after remote access is enabled again", async () => {
    fetchMock.mockResolvedValueOnce(validationResponse(403, { error: "Remote access disabled" }));
    fetchMock.mockResolvedValueOnce(validationResponse(200, { valid: true, deviceId: "approved-device" }));
    expect(await Auth.checkDeviceToken()).toBe(true);
    expect(await Auth.checkDeviceToken()).toBe(true);
    expect(fetchMock.mock.calls.map(([, init]) => init?.headers)).toEqual([
      { Authorization: "Bearer device-token" },
      { Authorization: "Bearer device-token" },
    ]);
    expect(Auth.getDeviceId()).toBe("approved-device");
  });

  it("preserves device approval when the network fails", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect(await Auth.checkDeviceToken()).toBe(true);
    expect(Auth.getToken()).toBe("device-token");
    expect(Auth.getDeviceId()).toBe("approved-device");
  });

  it("preserves device approval when a successful response does not establish validity", async () => {
    fetchMock.mockResolvedValueOnce(validationResponse(200));
    expect(await Auth.checkDeviceToken()).toBe(true);
    expect(Auth.getToken()).toBe("device-token");
    expect(Auth.getDeviceId()).toBe("approved-device");
  });

  it("preserves device approval when a server response is unreadable", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>Unavailable</html>", { status: 200 }));
    expect(await Auth.checkDeviceToken()).toBe(true);
    expect(Auth.getToken()).toBe("device-token");
    expect(Auth.getDeviceId()).toBe("approved-device");
  });

  it("clears a device explicitly revoked through Electron IPC", async () => {
    mocks.isElectron.mockReturnValue(true);
    mocks.validateToken.mockResolvedValueOnce({ valid: false });
    expect(await Auth.checkDeviceToken()).toBe(false);
    expect(mocks.validateToken).toHaveBeenCalledWith("device-token");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(Auth.getToken()).toBeNull();
    expect(Auth.getDeviceId()).toBeNull();
  });

  it("does not revoke a new login when the old token's validation finishes late", async () => {
    let respond!: (response: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { respond = resolve; }));
    const checking = Auth.checkDeviceToken();
    Auth.saveToken("new-token");
    Auth.saveDeviceId("new-device");
    respond(validationResponse(401));
    expect(await checking).toBe(true);
    expect(Auth.getToken()).toBe("new-token");
    expect(Auth.getDeviceId()).toBe("new-device");
  });

  it("does not treat a transport failure after logout as an authenticated session", async () => {
    let fail!: (error: Error) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((_resolve, reject) => { fail = reject; }));
    const checking = Auth.checkDeviceToken();
    Auth.clearAuth();
    fail(new TypeError("Connection lost"));
    expect(await checking).toBe(false);
    expect(Auth.getToken()).toBeNull();
  });

  it("bounds an unresponsive validation request without forgetting the approved device", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementationOnce((_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Timed out", "AbortError")));
      }));
      const checking = Auth.checkDeviceToken();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await checking).toBe(true);
      expect(Auth.getDeviceId()).toBe("approved-device");
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds an incomplete response body without forgetting the approved device", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementationOnce(async (_input, init) => new Response(new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("Timed out", "AbortError")));
        },
      }), { status: 200 }));
      const checking = Auth.checkDeviceToken();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await checking).toBe(true);
      expect(Auth.getToken()).toBe("device-token");
      expect(Auth.getDeviceId()).toBe("approved-device");
    } finally {
      vi.useRealTimers();
    }
  });

  it("redirects through tunnel-return while preserving device approval when Dev Tunnels requires sign-in", async () => {
    const navigations: string[] = [];
    setTunnelAuthNavigatorForTests((url) => navigations.push(url));
    vi.stubGlobal("window", {
      location: {
        origin: "https://codemux-test-8233.jpe1.devtunnels.ms",
        pathname: "/chat",
        search: "",
        hash: "",
      },
    });

    fetchMock.mockResolvedValueOnce({
      type: "opaqueredirect",
      status: 0,
      ok: false,
      headers: new Headers(),
    } as Response);

    expect(await Auth.checkDeviceToken()).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/validate", {
      headers: { Authorization: "Bearer device-token" },
      cache: "no-store",
      redirect: "manual",
      signal: expect.any(AbortSignal),
    });
    expect(Auth.getToken()).toBe("device-token");
    expect(Auth.getDeviceId()).toBe("approved-device");
    expect(tunnelAuthStatus()).toBe("reauth_required");
    expect(tunnelAuthRedirecting()).toBe(true);
    expect(navigations).toEqual(["/api/auth/tunnel-return?returnTo=%2Fchat"]);

    // Immediate repeated redirect within cooldown does not loop top-level navigation.
    fetchMock.mockResolvedValueOnce({
      type: "opaqueredirect",
      status: 0,
      ok: false,
      headers: new Headers(),
    } as Response);
    expect(await Auth.checkDeviceToken()).toBe(true);
    expect(navigations).toHaveLength(1);
    expect(tunnelAuthStatus()).toBe("reauth_required");

    // Once sign-in succeeds, tunnel auth state resets cleanly.
    fetchMock.mockResolvedValueOnce(validationResponse(200, { valid: true, deviceId: "approved-device" }));
    expect(await Auth.checkDeviceToken()).toBe(true);
    expect(tunnelAuthStatus()).toBe("ok");
    expect(tunnelAuthRedirecting()).toBe(false);
  });

  it("distinguishes non-JSON tunnel 403 access denial from CodeMux JSON 403 policy responses on Dev Tunnels", async () => {
    const navigations: string[] = [];
    setTunnelAuthNavigatorForTests((url) => navigations.push(url));
    vi.stubGlobal("window", {
      location: {
        origin: "https://codemux-test-8233.jpe1.devtunnels.ms",
        pathname: "/chat",
        search: "",
        hash: "",
      },
    });

    fetchMock.mockResolvedValueOnce(new Response("<html>403 Forbidden</html>", {
      status: 403,
      headers: { "Content-Type": "text/html" },
    }));
    expect(await Auth.checkDeviceToken()).toBe(true);
    expect(Auth.getToken()).toBe("device-token");
    expect(tunnelAuthStatus()).toBe("access_denied");
    expect(navigations).toEqual([]);

    fetchMock.mockResolvedValueOnce(validationResponse(403, { error: "Remote access is disabled for this entry point." }));
    expect(await Auth.checkDeviceToken()).toBe(true);
    expect(tunnelAuthStatus()).toBe("ok");
  });

  it.each([
    "https://demo.trycloudflare.com",
    "https://codemux.example.com",
    "http://localhost:8233",
    "http://192.168.1.20:8233",
  ])("leaves non-Dev-Tunnel origin %s completely untouched", async (origin) => {
    const navigations: string[] = [];
    setTunnelAuthNavigatorForTests((url) => navigations.push(url));
    vi.stubGlobal("window", {
      location: { origin, pathname: "/chat", search: "", hash: "" },
    });

    fetchMock.mockResolvedValueOnce(new Response("<html>403 Forbidden</html>", {
      status: 403,
      headers: { "Content-Type": "text/html" },
    }));
    expect(await Auth.checkDeviceToken()).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/validate", {
      headers: { Authorization: "Bearer device-token" },
      cache: "no-store",
      signal: expect.any(AbortSignal),
    });
    expect(tunnelAuthStatus()).toBe("ok");
    expect(navigations).toEqual([]);
  });
});

describe("Auth.logout", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("clears local approval immediately and leaves a newer login intact after a late response", async () => {
    mocks.isElectron.mockReturnValue(false);
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    let respond!: (response: Response) => void;
    const request = vi.fn(() => new Promise<Response>((resolve) => { respond = resolve; }));
    vi.stubGlobal("fetch", request);
    Auth.saveToken("old-token");
    Auth.saveDeviceId("old-device");
    const loggingOut = Auth.logout();
    expect(Auth.getToken()).toBeNull();
    expect(Auth.getDeviceId()).toBeNull();
    expect(request).toHaveBeenCalledWith("/api/auth/logout", {
      method: "POST", headers: { Authorization: "Bearer old-token" }, cache: "no-store",
    });
    Auth.saveToken("new-token");
    Auth.saveDeviceId("new-device");
    respond(new Response(null, { status: 200 }));
    await loggingOut;
    expect(Auth.getToken()).toBe("new-token");
    expect(Auth.getDeviceId()).toBe("new-device");
  });
});
