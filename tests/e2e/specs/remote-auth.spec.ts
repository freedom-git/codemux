import http from "node:http";
import type net from "node:net";
import { WebSocket } from "ws";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";

const TEST_CODE = "123456";
const WRONG_CODE = "000000";

test.describe("Remote Authentication", () => {
  test.beforeEach(async ({ page, request }) => {
    const baseUrl = process.env.TEST_BASE_URL!;
    // Reset auth state and switch to remote mode
    await request.post(`${baseUrl}/api/test/reset-auth`);
    await request.post(`${baseUrl}/api/test/set-local`, {
      data: { isLocal: false },
    });
    // Clear any stored tokens from previous tests
    await page.goto(baseUrl);
    await page.evaluate(() => {
      localStorage.removeItem("opencode_device_token");
      localStorage.removeItem("opencode_device_id");
    });
    // Reload so the app picks up isLocal=false with no cached token
    await page.reload();
  });

  test.afterEach(async ({ request }) => {
    const baseUrl = process.env.TEST_BASE_URL!;
    // Restore local mode for other specs
    await request.post(`${baseUrl}/api/test/set-local`, {
      data: { isLocal: true },
    });
  });

  test("should show 6-digit code input for remote access", async ({
    page,
  }) => {
    // Should NOT show "Open local chat" (that's local/host mode)
    await expect(
      page.getByRole("button", { name: /Open local chat/i }),
    ).not.toBeVisible({ timeout: 5_000 });

    // Should show login form with code input
    const codeInput = page.locator("input[maxlength='6']");
    await expect(codeInput).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Access Code")).toBeVisible();
  });

  test("submit button should be disabled until 6 digits entered", async ({
    page,
  }) => {
    const codeInput = page.locator("input[maxlength='6']");
    await expect(codeInput).toBeVisible({ timeout: 10_000 });

    const submitButton = page.getByRole("button", { name: /Connect/i });

    // Initially disabled
    await expect(submitButton).toBeDisabled();

    // Type 5 chars — still disabled
    await codeInput.fill("12345");
    await expect(submitButton).toBeDisabled();

    // Type 6th char — enabled
    await codeInput.fill(TEST_CODE);
    await expect(submitButton).toBeEnabled();
  });

  test("should show error for wrong access code", async ({ page }) => {
    const codeInput = page.locator("input[maxlength='6']");
    await expect(codeInput).toBeVisible({ timeout: 10_000 });

    await codeInput.fill(WRONG_CODE);
    await page.getByRole("button", { name: /Connect/i }).click();

    // Should show error message
    await expect(page.getByText(/Invalid/i)).toBeVisible({ timeout: 5_000 });
  });

  test("should complete remote auth flow after host approval", async ({
    page,
    request,
  }) => {
    const baseUrl = process.env.TEST_BASE_URL!;

    const codeInput = page.locator("input[maxlength='6']");
    await expect(codeInput).toBeVisible({ timeout: 10_000 });

    // Enter valid code and submit
    await codeInput.fill(TEST_CODE);
    await page.getByRole("button", { name: /Connect/i }).click();

    // Should transition to "Waiting for Approval" view
    await expect(
      page.getByText("Waiting for Approval"),
    ).toBeVisible({ timeout: 5_000 });

    // Get the pending request and approve it via admin API
    const pendingRes = await request.get(
      `${baseUrl}/api/admin/pending-requests`,
    );
    const { requests } = await pendingRes.json();
    expect(requests.length).toBeGreaterThan(0);

    await request.post(`${baseUrl}/api/admin/approve`, {
      data: { requestId: requests[0].id },
    });

    // Should navigate to /chat after next poll cycle (~2s)
    await expect(page).toHaveURL(/.*\/chat/, { timeout: 10_000 });
  });

  test("should show denied state when host denies request", async ({
    page,
    request,
  }) => {
    const baseUrl = process.env.TEST_BASE_URL!;

    const codeInput = page.locator("input[maxlength='6']");
    await expect(codeInput).toBeVisible({ timeout: 10_000 });

    await codeInput.fill(TEST_CODE);
    await page.getByRole("button", { name: /Connect/i }).click();

    await expect(
      page.getByText("Waiting for Approval"),
    ).toBeVisible({ timeout: 5_000 });

    // Deny the request
    const pendingRes = await request.get(
      `${baseUrl}/api/admin/pending-requests`,
    );
    const { requests } = await pendingRes.json();
    await request.post(`${baseUrl}/api/admin/deny`, {
      data: { requestId: requests[0].id },
    });

    // Should show denied state
    await expect(
      page.getByText("Access Denied"),
    ).toBeVisible({ timeout: 10_000 });

    // Should show "Try Again" button
    await expect(
      page.getByRole("button", { name: /Try Again/i }),
    ).toBeVisible();
  });

  test("should allow retrying after denial", async ({ page, request }) => {
    const baseUrl = process.env.TEST_BASE_URL!;

    const codeInput = page.locator("input[maxlength='6']");
    await expect(codeInput).toBeVisible({ timeout: 10_000 });

    await codeInput.fill(TEST_CODE);
    await page.getByRole("button", { name: /Connect/i }).click();

    await expect(
      page.getByText("Waiting for Approval"),
    ).toBeVisible({ timeout: 5_000 });

    // Deny the request
    const pendingRes = await request.get(
      `${baseUrl}/api/admin/pending-requests`,
    );
    const { requests } = await pendingRes.json();
    await request.post(`${baseUrl}/api/admin/deny`, {
      data: { requestId: requests[0].id },
    });

    await expect(
      page.getByText("Access Denied"),
    ).toBeVisible({ timeout: 10_000 });

    // Click "Try Again" — should return to code input form
    await page.getByRole("button", { name: /Try Again/i }).click();

    await expect(page.locator("input[maxlength='6']")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Connect/i }),
    ).toBeVisible();
  });

  test("should allow cancelling while waiting for approval", async ({
    page,
  }) => {
    const codeInput = page.locator("input[maxlength='6']");
    await expect(codeInput).toBeVisible({ timeout: 10_000 });

    await codeInput.fill(TEST_CODE);
    await page.getByRole("button", { name: /Connect/i }).click();

    await expect(
      page.getByText("Waiting for Approval"),
    ).toBeVisible({ timeout: 5_000 });

    // Cancel button should be visible and functional
    const cancelButton = page.getByRole("button", { name: /Cancel/i });
    await expect(cancelButton).toBeVisible();
    await cancelButton.click();

    // Should return to code input form
    await expect(page.locator("input[maxlength='6']")).toBeVisible();
  });
});

const SIMULATED_DEVTUNNEL_ORIGIN = "https://codemux-e2e-8233.jpe1.devtunnels.ms";
const SIMULATED_CLOUDFLARE_ORIGIN = "https://demo.trycloudflare.com";

interface SimulatedTunnelEdge {
  edgeUrl: string;
  idpHits: () => number;
  probeHits: () => number;
  activeWsCount: () => number;
  setMode: (mode: "valid" | "redirect_auto_login" | "redirect_cancel" | "forbidden_account") => void;
  closeAllSockets: () => void;
  stop: () => Promise<void>;
}

async function attachSimulatedTunnelEdge(
  context: BrowserContext,
  page: Page,
  upstreamBaseUrl: string,
  origin = SIMULATED_DEVTUNNEL_ORIGIN,
): Promise<SimulatedTunnelEdge> {
  let mode: "valid" | "redirect_auto_login" | "redirect_cancel" | "forbidden_account" = "valid";
  let validEpoch = 1;
  let idpHitCount = 0;
  let probeHitCount = 0;
  const wsBridges = new Set<{ close: () => void }>();

  const hasValidTunnelCookie = async () => {
    if (mode === "valid") return true;
    if (mode === "forbidden_account") return false;
    const cookies = await context.cookies(origin);
    return cookies.some((c) => c.name === "devtunnel_auth" && c.value === `epoch_${validEpoch}`);
  };

  // Real cross-origin IdP server so Chromium's 302 redirect target resolves over loopback without CORS headers
  const idpServer = http.createServer((req, res) => {
    if (req.headers["sec-fetch-mode"] === "navigate") {
      idpHitCount++;
    }
    const reqUrl = new URL(req.url || "/", "http://127.0.0.1");
    const postback = reqUrl.searchParams.get("pb") || `${origin}/`;
    if (mode === "redirect_cancel") {
      const fallbackUrl = new URL(postback);
      const rd = fallbackUrl.searchParams.get("rd") || "/chat";
      const target = `${fallbackUrl.origin}${rd.startsWith("/api/") ? "/chat" : rd}`;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><script>location.replace(${JSON.stringify(target)})</script>`);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><script>location.replace(${JSON.stringify(postback)})</script>`);
  });
  await new Promise<void>((resolve) => idpServer.listen(0, "127.0.0.1", resolve));
  const idpOrigin = `http://127.0.0.1:${(idpServer.address() as net.AddressInfo).port}`;

  await context.route(`${origin}/**`, async (route) => {
    const req = route.request();
    const reqUrl = new URL(req.url());

    if (reqUrl.pathname === "/api/system/is-local") {
      probeHitCount++;
    }

    if (reqUrl.pathname === "/auth/postback/aad") {
      const rd = reqUrl.searchParams.get("rd") || "/";
      await context.addCookies([
        {
          name: "devtunnel_auth",
          value: `epoch_${validEpoch}`,
          url: origin,
          httpOnly: true,
          secure: true,
        },
      ]);
      const target = `${origin}${rd}`;
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: `<!doctype html><script>location.replace(${JSON.stringify(target)})</script>`,
      });
      return;
    }

    const isBackendRoute = reqUrl.pathname === "/api" || reqUrl.pathname.startsWith("/api/");

    if (isBackendRoute && mode === "forbidden_account") {
      await route.fulfill({
        status: 403,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: "<html><body>403 Forbidden - Tunnel Access Denied</body></html>",
      });
      return;
    }

    if (isBackendRoute && !(await hasValidTunnelCookie())) {
      const postback = `${origin}/auth/postback/aad?rd=${encodeURIComponent(reqUrl.pathname + reqUrl.search)}`;
      await route.fulfill({
        status: 302,
        headers: {
          location: `${idpOrigin}/oauth2/authorize?pb=${encodeURIComponent(postback)}`,
        },
      });
      return;
    }

    const upstreamUrl = `${upstreamBaseUrl}${reqUrl.pathname}${reqUrl.search}`;
    const upstreamRes = await context.request.fetch(upstreamUrl, {
      method: req.method(),
      headers: req.headers(),
      data: req.postDataBuffer() ?? undefined,
      maxRedirects: 0,
    });
    const rawHeaders = upstreamRes.headers();
    const headers: Record<string, string> = { ...rawHeaders };
    if (upstreamRes.status() >= 300 && upstreamRes.status() < 400 && headers.location?.startsWith("/")) {
      const target = `${origin}${headers.location}`;
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        body: `<!doctype html><script>location.replace(${JSON.stringify(target)})</script>`,
      });
      return;
    }
    await route.fulfill({
      status: upstreamRes.status(),
      headers,
      body: await upstreamRes.body(),
    });
  });

  await page.routeWebSocket(`${origin.replace("https:", "wss:")}/ws`, async (ws) => {
    if (mode === "forbidden_account" || !(await hasValidTunnelCookie())) {
      await ws.close({ code: 1011, reason: "Tunnel authentication required" });
      return;
    }

    const backend = new WebSocket(`${upstreamBaseUrl.replace("http:", "ws:")}/ws`);
    const bridge = {
      close: () => {
        wsBridges.delete(bridge);
        try { backend.close(); } catch { /* ignore */ }
        void ws.close({ code: 1011, reason: "Tunnel authentication expired" });
      },
    };
    wsBridges.add(bridge);

    backend.on("message", (data, isBinary) => {
      ws.send(isBinary ? Buffer.from(data as ArrayBuffer) : data.toString());
    });
    backend.on("close", () => {
      wsBridges.delete(bridge);
      void ws.close({ code: 1000, reason: "" });
    });
    backend.on("error", () => bridge.close());

    ws.onMessage((msg) => {
      if (backend.readyState === WebSocket.OPEN) {
        backend.send(msg);
      } else {
        backend.once("open", () => backend.send(msg));
      }
    });
    ws.onClose(() => {
      wsBridges.delete(bridge);
      try { backend.close(); } catch { /* ignore */ }
    });
  });

  return {
    edgeUrl: origin,
    idpHits: () => idpHitCount,
    probeHits: () => probeHitCount,
    activeWsCount: () => wsBridges.size,
    setMode(nextMode) {
      validEpoch++;
      mode = nextMode;
    },
    closeAllSockets() {
      for (const bridge of [...wsBridges]) bridge.close();
      wsBridges.clear();
    },
    async stop() {
      for (const bridge of [...wsBridges]) bridge.close();
      wsBridges.clear();
      idpServer.closeAllConnections();
      await Promise.all([
        context.unrouteAll({ behavior: "ignoreErrors" }),
        new Promise<void>((resolve) => idpServer.close(() => resolve())),
      ]);
    },
  };
}

test.describe("Tunnel edge re-authentication", () => {
  test("automatically re-authenticates on *.devtunnels.ms when cookie expires and preserves device token", async ({
    context,
    page,
    request,
  }) => {
    const baseUrl = process.env.TEST_BASE_URL!;
    await request.post(`${baseUrl}/api/test/reset-auth`);
    await request.post(`${baseUrl}/api/test/set-local`, { data: { isLocal: false } });

    const edge = await attachSimulatedTunnelEdge(context, page, baseUrl, SIMULATED_DEVTUNNEL_ORIGIN);
    try {
      await page.goto(edge.edgeUrl);
      const codeInput = page.locator("input[maxlength='6']");
      await expect(codeInput).toBeVisible({ timeout: 10_000 });
      await codeInput.fill(TEST_CODE);
      await page.getByRole("button", { name: /Connect/i }).click();

      const pendingRes = await request.get(`${baseUrl}/api/admin/pending-requests`);
      const { requests } = await pendingRes.json();
      await request.post(`${baseUrl}/api/admin/approve`, { data: { requestId: requests[0].id } });
      await expect(page).toHaveURL(`${SIMULATED_DEVTUNNEL_ORIGIN}/chat`, { timeout: 10_000 });

      await expect.poll(() => edge.activeWsCount(), { timeout: 10_000 }).toBeGreaterThan(0);
      await expect(page.getByText("Disconnected")).not.toBeVisible({ timeout: 5_000 });
      const pairedToken = await page.evaluate(() => localStorage.getItem("opencode_device_token"));
      expect(pairedToken).toBeTruthy();

      // 1. Mid-session cookie expiry: dropping WS automatically navigates through
      // /api/auth/tunnel-return?returnTo=%2Fchat -> mock Entra -> /auth/postback/aad -> /chat
      edge.setMode("redirect_auto_login");
      edge.closeAllSockets();
      await expect.poll(() => edge.idpHits(), { timeout: 10_000 }).toBe(1);
      await expect(page).toHaveURL(`${SIMULATED_DEVTUNNEL_ORIGIN}/chat`, { timeout: 10_000 });
      await expect.poll(() => edge.activeWsCount(), { timeout: 10_000 }).toBeGreaterThan(0);
      await expect(page.getByText("Disconnected")).not.toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId("chat-tunnel-auth-banner")).not.toBeVisible();

      // 2. Fresh navigation when cookie expired again
      await page.goto("about:blank");
      edge.setMode("redirect_auto_login");
      edge.closeAllSockets();
      await page.goto(`${edge.edgeUrl}/chat`);
      await expect.poll(() => edge.idpHits(), { timeout: 10_000 }).toBe(2);
      await expect(page).toHaveURL(`${SIMULATED_DEVTUNNEL_ORIGIN}/chat`, { timeout: 10_000 });
      await expect.poll(() => edge.activeWsCount(), { timeout: 10_000 }).toBeGreaterThan(0);
      await expect(page.getByText("Disconnected")).not.toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId("chat-tunnel-auth-banner")).not.toBeVisible();

      // Device pairing token was preserved across tunnel re-authentication
      expect(await page.evaluate(() => localStorage.getItem("opencode_device_token"))).toBe(pairedToken);
    } finally {
      await edge.stop();
      await request.post(`${baseUrl}/api/test/set-local`, { data: { isLocal: true } });
    }
  });

  test("surfaces actionable re-authentication UI on cancelled login or forbidden tunnel account and recovers on click", async ({
    context,
    page,
    request,
  }) => {
    const baseUrl = process.env.TEST_BASE_URL!;
    await request.post(`${baseUrl}/api/test/reset-auth`);
    await request.post(`${baseUrl}/api/test/set-local`, { data: { isLocal: false } });

    const edge = await attachSimulatedTunnelEdge(context, page, baseUrl, SIMULATED_DEVTUNNEL_ORIGIN);
    try {
      await page.goto(edge.edgeUrl);
      await page.locator("input[maxlength='6']").fill(TEST_CODE);
      await page.getByRole("button", { name: /Connect/i }).click();
      const pendingRes = await request.get(`${baseUrl}/api/admin/pending-requests`);
      const { requests } = await pendingRes.json();
      await request.post(`${baseUrl}/api/admin/approve`, { data: { requestId: requests[0].id } });
      await expect(page).toHaveURL(`${SIMULATED_DEVTUNNEL_ORIGIN}/chat`, { timeout: 10_000 });
      await expect.poll(() => edge.activeWsCount(), { timeout: 10_000 }).toBeGreaterThan(0);
      await expect(page.getByText("Disconnected")).not.toBeVisible({ timeout: 5_000 });

      // 1. Mid-session cancelled sign-in shows reauth banner without infinite redirect loop
      edge.setMode("redirect_cancel");
      edge.closeAllSockets();
      await expect(page.getByTestId("chat-tunnel-auth-banner")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId("chat-tunnel-reauth-pill")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      // 2. Forbidden account (edge 403 HTML) shows clear access-denied guidance when cached shell loads
      edge.setMode("forbidden_account");
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await expect(page.getByTestId("chat-tunnel-auth-banner")).toContainText(/authorized account|切换账号/i, { timeout: 10_000 });

      // 3. Clicking Re-authenticate after switching to an authorized session restores live WS
      edge.setMode("redirect_auto_login");
      await page.getByTestId("chat-tunnel-reauth-button").click();
      await expect(page).toHaveURL(`${SIMULATED_DEVTUNNEL_ORIGIN}/chat`, { timeout: 10_000 });
      await expect.poll(() => edge.activeWsCount(), { timeout: 10_000 }).toBeGreaterThan(0);
      await expect(page.getByTestId("chat-tunnel-auth-banner")).not.toBeVisible({ timeout: 10_000 });
      await expect(page.getByText("Disconnected")).not.toBeVisible({ timeout: 10_000 });
    } finally {
      await edge.stop();
      await request.post(`${baseUrl}/api/test/set-local`, { data: { isLocal: true } });
    }
  });

  test("does not run Dev Tunnel probes or show Dev Tunnel banners on Cloudflare Tunnel origins", async ({
    context,
    page,
    request,
  }) => {
    const baseUrl = process.env.TEST_BASE_URL!;
    await request.post(`${baseUrl}/api/test/reset-auth`);
    await request.post(`${baseUrl}/api/test/set-local`, { data: { isLocal: false } });

    const edge = await attachSimulatedTunnelEdge(context, page, baseUrl, SIMULATED_CLOUDFLARE_ORIGIN);
    try {
      await page.goto(edge.edgeUrl);
      await page.locator("input[maxlength='6']").fill(TEST_CODE);
      await page.getByRole("button", { name: /Connect/i }).click();
      const pendingRes = await request.get(`${baseUrl}/api/admin/pending-requests`);
      const { requests } = await pendingRes.json();
      await request.post(`${baseUrl}/api/admin/approve`, { data: { requestId: requests[0].id } });
      await expect(page).toHaveURL(`${SIMULATED_CLOUDFLARE_ORIGIN}/chat`, { timeout: 10_000 });
      await expect.poll(() => edge.activeWsCount(), { timeout: 10_000 }).toBeGreaterThan(0);

      const probesBeforeDrop = edge.probeHits();
      edge.setMode("forbidden_account");
      edge.closeAllSockets();

      await expect(page.getByText("Disconnected")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId("chat-tunnel-auth-banner")).not.toBeVisible();
      expect(edge.probeHits()).toBe(probesBeforeDrop);
      expect(edge.idpHits()).toBe(0);
    } finally {
      await edge.stop();
      await request.post(`${baseUrl}/api/test/set-local`, { data: { isLocal: true } });
    }
  });
});
