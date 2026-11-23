/**
 * Auth API Proxy Plugin for Electron-Vite
 *
 * This plugin proxies all auth/device related API requests to Electron's
 * internal Auth API server, ensuring a single source of truth for device data.
 */

import http from "http";
import os from "os";
import type { IncomingMessage, ServerResponse } from "http";
import type { Plugin, ViteDevServer } from "vite";
import { sendJson, isLocalRequest } from "../shared/http-utils";
import { AUTH_API_PORT, WEB_PORT } from "../shared/ports";
import { isLocalGatewayRequest, isRemoteAccessRequestAllowed } from "../shared/remote-access-policy";
import type { RemoteAccessStatus } from "../shared/remote-access";

// Electron's internal Auth API server port (imported from shared/ports)

/**
 * Self-unregistering Service Worker served at `/sw.js` in Vite dev mode.
 * If a browser/phone previously visited the same origin/tunnel while running a
 * packaged build, Workbox's precache SW would otherwise stay stuck forever
 * because Vite's SPA fallback returns `text/html` for `/sw.js`.
 */
export const DEV_SW_CLEANUP_SCRIPT = `self.addEventListener("install", () => {
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const controlledClients = await self.clients.matchAll({ type: "window", includeUncontrolled: false });
    let deletedAnyCache = false;
    try {
      const keys = await self.caches.keys();
      const staleKeys = keys.filter((key) => key.startsWith("codemux-web-") || key.startsWith("workbox-"));
      deletedAnyCache = staleKeys.length > 0;
      await Promise.all(staleKeys.map((key) => self.caches.delete(key)));
    } catch {}
    await self.registration.unregister();
    if (!deletedAnyCache && controlledClients.length === 0) return;
    const targets = controlledClients.length > 0
      ? controlledClients
      : await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of targets) {
      try {
        await client.navigate(client.url);
      } catch {}
    }
  })());
});
`;

const VITE_CLIENT_PATH_SUFFIX = "/vite/dist/client/client.mjs";

export function isViteClientModuleId(id: string): boolean {
  const normalized = id.replaceAll("\\", "/").split("?")[0];
  return normalized === "/@vite/client" || normalized.endsWith(VITE_CLIENT_PATH_SUFFIX);
}

/**
 * Vite 6 still injects `/@vite/client` and opens a `vite-hmr` WebSocket even
 * when `server.hmr === false` (and when `server.ws === false`, `/@vite/client`
 * logs failed WebSocket connection errors). Over Microsoft Dev Tunnels or
 * mobile networks, idle `vite-hmr` sockets close every ~15-30s and trigger
 * `vite:ws:disconnect` -> `waitForSuccessfulPing()` -> `location.reload()`,
 * forcibly reloading the entire mobile page.
 */
export function patchViteClientCode(code: string, hmrDisabled: boolean): string {
  let next = code;
  if (hmrDisabled) {
    next = next
      .replace('console.debug("[vite] connecting...");', "")
      .replace(
        "transport.connect(createHMRHandler(handleMessage));",
        "/* codemux: hmr disabled — skip vite-hmr websocket */",
      );
  }
  next = next.replace(
    'if (payload.event === "vite:ws:disconnect") {',
    'if (payload.event === "vite:ws:disconnect" && /^(?:localhost|127\\.0\\.0\\.1|\\[::1\\]|::1)$/i.test(globalThis.location?.hostname ?? "")) {',
  );
  return next;
}

const virtualInterfacePatterns = [
  /^docker/i, /^br-/i, /^veth/i, /^vEthernet/i,
  /^vmnet/i, /^VMware/i, /^VirtualBox/i, /^vboxnet/i,
  /^Hyper-V/i, /^Default Switch/i, /^WSL/i,
  /^tun/i, /^tap/i, /^singbox/i, /^sing-box/i, /^clash/i, /^utun/i,
  /^tailscale/i, /^ZeroTier/i, /^zt/i,
  /^wg/i, /^wireguard/i, /^ham/i, /^Hamachi/i, /^npcap/i, /^lo/i,
];

function getLocalIp(): string {
  const interfaces = os.networkInterfaces();
  let fallback: string | null = null;

  for (const name of Object.keys(interfaces)) {
    const nets = interfaces[name];
    if (!nets) continue;
    const virtual = virtualInterfacePatterns.some((p) => p.test(name));
    for (const net of nets) {
      if (net.internal || net.family !== "IPv4") continue;
      if (!virtual) return net.address;
      if (!fallback) fallback = net.address;
    }
  }
  return fallback ?? "localhost";
}

/**
 * Proxy a request to Electron's Auth API server
 */
export function proxyToAuthApi(
  req: IncomingMessage,
  res: ServerResponse,
  targetPath?: string
): void {
  const path = targetPath || req.url || "/";

  // Collect request body if present
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const forwarded = req.headers["x-forwarded-for"];
    const forwardedChain = Array.isArray(forwarded) ? forwarded.join(", ") : forwarded;
    const peer = req.socket.remoteAddress || "unknown";
    const hostCount = req.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === "host").length;
    const options: http.RequestOptions = {
      hostname: "127.0.0.1",
      port: AUTH_API_PORT,
      path: path,
      method: req.method,
      headers: {
        ...req.headers,
        // Preserve the external authority and every hop used by local-auth checks.
        host: hostCount > 1 ? "" : req.headers.host ?? "",
        "x-forwarded-for": forwardedChain === undefined ? peer : `${forwardedChain}, ${peer}`,
      },
    };

    const proxyReq = http.request(options, (proxyRes) => {
      res.statusCode = proxyRes.statusCode || 500;

      // Copy response headers
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        if (value) res.setHeader(key, value);
      }

      proxyRes.pipe(res);
    });

    proxyReq.on("error", (err) => {
      console.error("[Auth Proxy] Failed to connect to Auth API:", err.message);
      sendJson(res, {
        error: "Auth service unavailable. Make sure Electron main process is running.",
        details: err.message
      }, 503);
    });

    if (body) {
      proxyReq.write(body);
    }
    proxyReq.end();
  });

  req.on("error", (err) => {
    console.error("[Auth Proxy] Request error:", err);
    sendJson(res, { error: "Request failed" }, 500);
  });
}

export interface AuthProxyPluginOptions {
  defaultPort?: number;
}

/** Fetch admission policy from the main process without caching mode changes. */
export function getElectronRemoteAccessStatus(): Promise<RemoteAccessStatus> {
  return new Promise((resolve, reject) => {
    const request = http.get({
      hostname: "127.0.0.1",
      port: AUTH_API_PORT,
      path: "/api/remote-access",
      timeout: 2000,
    }, response => {
      let body = "";
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => {
        try {
          if (response.statusCode !== 200) throw new Error("Remote access policy unavailable.");
          resolve(JSON.parse(body) as RemoteAccessStatus);
        } catch (error) {
          reject(error);
        }
      });
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error("Remote access policy timed out.")));
    request.on("error", reject);
  });
}

export async function isElectronRemoteRequestAllowed(req: IncomingMessage, gateway = false): Promise<boolean> {
  if (gateway ? isLocalGatewayRequest(req) : isLocalRequest(req)) return true;
  try {
    return isRemoteAccessRequestAllowed(req, await getElectronRemoteAccessStatus(), gateway);
  } catch {
    return false;
  }
}

/** Preserve peer and authority when the gateway is behind Vite's loopback proxy. */
export function preserveProxyRequestIdentity(proxyReq: http.ClientRequest, req: IncomingMessage): void {
  const hostCount = req.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === "host").length;
  proxyReq.setHeader("host", hostCount > 1 ? "" : req.headers.host ?? "");
  const forwarded = req.headers["x-forwarded-for"];
  const chain = Array.isArray(forwarded) ? forwarded.join(", ") : forwarded;
  const peer = req.socket.remoteAddress || "unknown";
  proxyReq.setHeader("x-forwarded-for", chain === undefined ? peer : `${chain}, ${peer}`);
}

export function createAuthProxyPlugin(options: AuthProxyPluginOptions = {}): Plugin {
  const { defaultPort = WEB_PORT } = options;
  let hmrDisabled = false;

  return {
    name: "auth-api-proxy",
    enforce: "post",

    configResolved(config) {
      hmrDisabled = config.server.hmr === false || config.server.ws === false;
    },

    transform(code, id) {
      if (!isViteClientModuleId(id)) return null;
      const patched = patchViteClientCode(code, hmrDisabled);
      return patched === code ? null : { code: patched, map: null };
    },
    configureServer(server: ViteDevServer) {
      server.middlewares.use(async (req, res, next) => {
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
        if (pathname === "/api/remote-access/status" && req.method === "GET") {
          proxyToAuthApi(req, res);
          return;
        }
        if (!await isElectronRemoteRequestAllowed(req)) {
          sendJson(res, { error: "Remote access is disabled for this entry point." }, 403);
          return;
        }
        next();
      });
      // ====================================================================
      // Proxy auth, admin, device, and channel API requests to Electron's
      // internal Auth API server
      // ====================================================================
      server.middlewares.use((req, res, next) => {
        const url = req.url || "";

        // List of API paths that should be proxied to Electron's Auth API
        const authApiPaths = [
          "/opencode-api",
          "/api/auth/",
          "/api/admin/",
          "/api/devices",
          "/api/settings/",
          "/api/remote-access",
          "/api/tunnel",
          "/api/channels",
          "/api/system/log",
        ];

        const shouldProxy = authApiPaths.some(p => url.startsWith(p));

        if (shouldProxy) {
          proxyToAuthApi(req, res);
          return;
        }

        next();
      });

      // ====================================================================
      // System: Get system info
      // GET /api/system/info
      // ====================================================================
      server.middlewares.use((req, res, next) => {
        if (req.url !== "/api/system/info" || req.method !== "GET") {
          next();
          return;
        }

        sendJson(res, {
          localIp: getLocalIp(),
          port: defaultPort,
        });
      });

      // ====================================================================

      // System: Check if request is from localhost
      // GET /api/system/is-local
      // ====================================================================
      server.middlewares.use((req, res, next) => {
        if (req.url !== "/api/system/is-local" || req.method !== "GET") {
          next();
          return;
        }

        const isLocal = isLocalRequest(req);
        sendJson(res, { isLocal });
      });

      // ====================================================================
      // Dev-mode PWA Service Worker eviction
      // GET /sw.js
      // ====================================================================
      server.middlewares.use((req, res, next) => {
        const pathname = req.url?.split("?")[0];
        if (pathname !== "/sw.js" || (req.method !== "GET" && req.method !== "HEAD")) {
          next();
          return;
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/javascript; charset=utf-8");
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
        res.end(req.method === "HEAD" ? undefined : DEV_SW_CLEANUP_SCRIPT);
      });

    },
  };
}
