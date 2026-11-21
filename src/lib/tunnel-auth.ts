import { createSignal, untrack } from "solid-js";
import { readDevTunnelUrl } from "../../shared/dev-tunnel-metadata";
import { isElectron } from "./platform";

export type TunnelAuthStatus = "ok" | "reauth_required" | "access_denied";

const REAUTH_COOLDOWN_KEY = "codemux_tunnel_reauth_ts";
const REAUTH_COOLDOWN_MS = 15_000;
const REDIRECT_HOLD_MS = 4_000;
const PROBE_TIMEOUT_MS = 5_000;
const PROBE_MIN_INTERVAL_MS = 5_000;
const DISALLOWED_RETURN_PREFIXES = ["/api", "/opencode-api", "/webhook", "/ws"];

const [_tunnelAuthStatus, setTunnelAuthStatus] = createSignal<TunnelAuthStatus>("ok");
const [_tunnelAuthRedirecting, setTunnelAuthRedirecting] = createSignal(false);

export const tunnelAuthStatus = _tunnelAuthStatus;
export const tunnelAuthRedirecting = _tunnelAuthRedirecting;

let customNavigator: ((url: string) => void) | undefined;
let redirectHoldTimer: ReturnType<typeof setTimeout> | undefined;
let activeProbe: Promise<TunnelAuthStatus> | undefined;
let lastProbeAt = 0;

function readSessionCooldown(): number | null {
  try {
    if (typeof sessionStorage === "undefined") return null;
    const raw = sessionStorage.getItem(REAUTH_COOLDOWN_KEY);
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeSessionCooldown(timestamp: number): void {
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem(REAUTH_COOLDOWN_KEY, String(timestamp));
    }
  } catch {
    // Ignore storage failures in restricted browsing modes.
  }
}

function clearSessionCooldown(): void {
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.removeItem(REAUTH_COOLDOWN_KEY);
    }
  } catch {
    // Ignore storage failures in restricted browsing modes.
  }
}

export function isDevTunnelOrigin(origin?: string | null): boolean {
  return typeof origin === "string" && Boolean(readDevTunnelUrl(origin));
}

export function isDevTunnelLocation(): boolean {
  if (isElectron() || typeof window === "undefined") return false;
  return isDevTunnelOrigin(window.location?.origin);
}

export function sanitizeClientReturnPath(raw?: string | null): string {
  const candidate = typeof raw === "string"
    ? raw.trim()
    : typeof window !== "undefined"
      ? `${window.location.pathname}${window.location.search}${window.location.hash}`
      : "/";
  if (!candidate.startsWith("/") || candidate.startsWith("//") || /[\u0000-\u001f\u007f\\]/.test(candidate)) {
    return "/";
  }
  try {
    const parsed = new URL(candidate, "http://codemux.local");
    if (parsed.origin !== "http://codemux.local") return "/";
    if (DISALLOWED_RETURN_PREFIXES.some(prefix => parsed.pathname === prefix || parsed.pathname.startsWith(`${prefix}/`))) {
      return "/";
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "/";
  }
}

/**
 * Uses a `/api/auth/*` path so the PWA Service Worker `navigateFallback`
 * never serves cached HTML instead of hitting the upstream tunnel edge.
 */
export function buildTunnelReauthUrl(returnTo?: string): string {
  const safePath = sanitizeClientReturnPath(returnTo);
  return `/api/auth/tunnel-return?returnTo=${encodeURIComponent(safePath)}`;
}

export function isGatewayAuthRedirect(response: Pick<Response, "type" | "status">): boolean {
  return response.type === "opaqueredirect" || (response.status >= 301 && response.status < 400);
}

export function isGatewayEdgeForbidden(response: Pick<Response, "status" | "headers">): boolean {
  if (response.status !== 403) return false;
  const contentType = response.headers?.get?.("content-type") ?? "";
  return !contentType.toLowerCase().includes("application/json");
}

export function clearTunnelAuthIssue(): void {
  if (redirectHoldTimer) {
    clearTimeout(redirectHoldTimer);
    redirectHoldTimer = undefined;
  }
  setTunnelAuthRedirecting(false);
  if (untrack(_tunnelAuthStatus) !== "ok") {
    setTunnelAuthStatus("ok");
  }
  clearSessionCooldown();
}

/**
 * Initiates a top-level navigation through `/api/auth/tunnel-return` so the
 * browser can complete Microsoft Dev Tunnels (or reverse-proxy SSO) sign-in
 * and return to the current route without losing paired device credentials.
 */
export function triggerTunnelReauth(options?: { force?: boolean; returnTo?: string }): boolean {
  if (!isDevTunnelLocation()) return false;
  if (untrack(_tunnelAuthStatus) === "ok") {
    setTunnelAuthStatus("reauth_required");
  }
  const navigate = customNavigator ?? (
    typeof window !== "undefined" && typeof window.location?.assign === "function"
      ? (url: string) => window.location.assign(url)
      : undefined
  );
  if (!navigate) return false;

  const now = Date.now();
  const lastAttempt = readSessionCooldown();
  if (!options?.force && lastAttempt !== null && now - lastAttempt < REAUTH_COOLDOWN_MS) {
    return false;
  }

  writeSessionCooldown(now);
  setTunnelAuthRedirecting(true);
  if (redirectHoldTimer) clearTimeout(redirectHoldTimer);
  redirectHoldTimer = setTimeout(() => {
    redirectHoldTimer = undefined;
    setTunnelAuthRedirecting(false);
  }, REDIRECT_HOLD_MS);
  (redirectHoldTimer as { unref?: () => void }).unref?.();

  navigate(buildTunnelReauthUrl(options?.returnTo));
  return true;
}

export function inspectGatewayResponse(
  response: Pick<Response, "type" | "status" | "ok" | "headers">,
  options?: { autoRedirect?: boolean; returnTo?: string },
): TunnelAuthStatus {
  if (!isDevTunnelLocation()) return "ok";
  if (isGatewayAuthRedirect(response)) {
    setTunnelAuthStatus("reauth_required");
    if (options?.autoRedirect !== false) {
      triggerTunnelReauth({ returnTo: options?.returnTo });
    }
    return "reauth_required";
  }
  if (isGatewayEdgeForbidden(response)) {
    setTunnelAuthStatus("access_denied");
    return "access_denied";
  }
  const contentType = response.headers?.get?.("content-type") ?? "";
  if (response.ok || response.status === 401 || contentType.toLowerCase().includes("application/json")) {
    clearTunnelAuthIssue();
  }
  return "ok";
}

export function probeTunnelAuth(options?: { autoRedirect?: boolean; force?: boolean }): Promise<TunnelAuthStatus> {
  if (!isDevTunnelLocation()) return Promise.resolve("ok");
  const currentStatus = untrack(_tunnelAuthStatus);
  if (typeof navigator !== "undefined" && navigator.onLine === false) return Promise.resolve(currentStatus);
  if (activeProbe) return activeProbe;

  const now = Date.now();
  if (!options?.force && now - lastProbeAt < PROBE_MIN_INTERVAL_MS && currentStatus !== "ok") {
    return Promise.resolve(currentStatus);
  }
  lastProbeAt = now;

  const autoRedirect = options?.autoRedirect ?? (currentStatus === "ok");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  (timer as { unref?: () => void }).unref?.();

  activeProbe = fetch("/api/system/is-local", {
    cache: "no-store",
    redirect: "manual",
    signal: controller.signal,
  })
    .then((response) => inspectGatewayResponse(response, { autoRedirect }))
    .catch(() => untrack(_tunnelAuthStatus))
    .finally(() => {
      clearTimeout(timer);
      activeProbe = undefined;
    });

  return activeProbe;
}

export function setTunnelAuthNavigatorForTests(fn?: (url: string) => void): void {
  customNavigator = fn;
}

export function resetTunnelAuthStateForTests(): void {
  customNavigator = undefined;
  activeProbe = undefined;
  lastProbeAt = 0;
  clearTunnelAuthIssue();
}
