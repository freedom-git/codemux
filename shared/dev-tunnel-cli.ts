import { spawn, execFile, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, mkdtempSync, rmSync, rmdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";

export function getDevTunnelPath(): string | undefined {
  const name = process.platform === "win32" ? "devtunnel.exe" : "devtunnel";
  const directories = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  if (process.platform === "win32") {
    for (const root of [process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Microsoft", "WinGet"), process.env.ProgramFiles && join(process.env.ProgramFiles, "WinGet")]) {
      if (!root) continue;
      directories.push(join(root, "Links"));
      const packages = join(root, "Packages");
      try {
        for (const entry of readdirSync(packages)) {
          if (entry.startsWith("Microsoft.devtunnel_")) directories.push(join(packages, entry));
        }
      } catch { /* WinGet is optional. */ }
    }
  }
  return directories.map(directory => join(directory, name)).find(file => existsSync(file));
}

export class DevTunnelError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export function parseDevTunnelJson<T>(text: string): T {
  // The CLI can prepend update/network warnings even with --json.
  const clean = text.replace(/^\uFEFF/, "").trim();
  const start = clean.search(/^\s*\{/m);
  try { return JSON.parse(clean.slice(start, clean.lastIndexOf("}") + 1)) as T; }
  catch { throw new DevTunnelError("DEVTUNNEL_COMMAND_FAILED", "Dev Tunnels returned an invalid response."); }
}

export function parseDevTunnelList<T>(text: string): T[] {
  const result = parseDevTunnelJson<{ tunnels?: T[]; warning?: string }>(text);
  if (Array.isArray(result?.tunnels)) return result.tunnels;
  if (result?.warning === "No tunnels found.") return [];
  throw new DevTunnelError("DEVTUNNEL_COMMAND_FAILED", "Unable to list Dev Tunnels.");
}

export async function stopDevTunnelProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  if (process.platform === "win32") {
    // Login owns a visible CLI child; terminate that process tree, never other CLI sessions.
    await new Promise<void>((resolve, reject) => {
      execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 5000 }, error => {
        if (error && child.exitCode === null && child.signalCode === null) reject(new DevTunnelError("DEVTUNNEL_STOP_FAILED", "Unable to stop the owned Dev Tunnels process."));
        else resolve();
      });
    });
  } else child.kill("SIGTERM");
  let timer: ReturnType<typeof setTimeout>;
  await Promise.race([
    closed,
    new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else {
          child.kill("SIGKILL");
          reject(new DevTunnelError("DEVTUNNEL_STOP_FAILED", "Dev Tunnels process did not stop in time."));
        }
      }, 5000);
    }),
  ]).finally(() => clearTimeout(timer!));
}

const windowsLoginScript = `
$ErrorActionPreference = 'Stop'
$out = $env:CODEMUX_DEVTUNNEL_LOGIN_OUT
$err = $env:CODEMUX_DEVTUNNEL_LOGIN_ERR
function Read-LoginOutput {
  $parts = @()
  foreach ($p in @($out, $err)) {
    if ($p -and (Test-Path -LiteralPath $p)) {
      try {
        $content = Get-Content -LiteralPath $p -Raw -ErrorAction SilentlyContinue
        if ($content) { $parts += $content }
      } catch {}
    }
  }
  return ($parts -join "\`n").Trim()
}
$child = $null
try {
  $child = Start-Process -FilePath $env:CODEMUX_DEVTUNNEL_CLI -ArgumentList 'user','login','--entra','--use-browser-auth' -PassThru -WindowStyle Normal -RedirectStandardOutput $out -RedirectStandardError $err
  $handle = $null
  try { $handle = $child.Handle } catch {}
  while (-not $child.HasExited) {
    $text = Read-LoginOutput
    if ($text -match '(?i)device.code|login.microsoft.com/device') {
      Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue
      [Console]::Error.WriteLine('Device code fallback is disabled.')
      exit 2
    }
    Start-Sleep -Milliseconds 200
  }
  try { $child.WaitForExit() } catch {}
  $text = Read-LoginOutput
  if ($text -match '(?i)device.code|login.microsoft.com/device') {
    [Console]::Error.WriteLine('Device code fallback is disabled.')
    exit 2
  }
  $exitCode = $child.ExitCode
  if ($null -ne $exitCode -and $exitCode -ne 0) {
    if ($text) { [Console]::Error.WriteLine($text) }
    exit $exitCode
  }
} finally {
  if ($child -and -not $child.HasExited) { Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue }
  if ($out) { Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue }
  if ($err) { Remove-Item -LiteralPath $err -Force -ErrorAction SilentlyContinue }
}
`;

export function sanitizeDevTunnelDiagnostic(raw: string): string {
  if (!raw) return "";
  const cleaned = raw
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/(x-tunnel-authorization|authorization)\s*[:=]\s*([^\r\n,;]+)/gi, "$1: [redacted]")
    .replace(/\b(bearer|tunnel)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]")
    .replace(/\b(token|tkn|access_token|refresh_token|client_secret|secret|password|code)\b(\s*[:=]\s*["']?)[^\s"',;&]+/gi, "$1$2[redacted]")
    .replace(/\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g, "[redacted-jwt]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, (match) => {
      try {
        const parsed = new URL(match);
        return `${parsed.origin}${parsed.pathname}`;
      } catch {
        return "[redacted-url]";
      }
    })
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !/^(At line:\d+|\+\s|CategoryInfo\s*:|FullyQualifiedErrorId\s*:)/i.test(line))
    .join(" ");
  return cleaned.length > 280 ? `${cleaned.slice(0, 277)}...` : cleaned;
}

export interface DevTunnelCommandOptions {
  signal: AbortSignal;
  login?: boolean;
  onOutput?: (output: string) => void;
  timeout?: number;
}

/** Never returns raw CLI failures: they can contain credentials and login URLs. */
export async function runDevTunnelCommand(
  executable: string,
  args: string[],
  options: DevTunnelCommandOptions,
): Promise<string> {
  options.signal.throwIfAborted();
  const nativeLogin = options.login && process.platform === "win32";
  const loginDirectory = nativeLogin ? mkdtempSync(join(tmpdir(), "codemux-devtunnel-login-")) : undefined;
  const loginOut = loginDirectory && join(loginDirectory, "stdout.log");
  const loginErr = loginDirectory && join(loginDirectory, "stderr.log");
  const child = nativeLogin
    ? spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(windowsLoginScript, "utf16le").toString("base64")], {
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env, CODEMUX_DEVTUNNEL_CLI: executable,
        CODEMUX_DEVTUNNEL_LOGIN_OUT: loginOut, CODEMUX_DEVTUNNEL_LOGIN_ERR: loginErr,
      },
    })
    : spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let stdout = "";
  let failure: Error | undefined;
  let stopping: Promise<void> | undefined;
  let rejectStopped: (error: Error) => void = () => {};
  const stop = (error: Error) => {
    failure ??= error;
    stopping ??= stopDevTunnelProcess(child);
    void stopping.catch(error => rejectStopped(error));
  };
  const abort = () => stop(new DevTunnelError("DEVTUNNEL_CANCELLED", "Dev Tunnels operation cancelled."));
  options.signal.addEventListener("abort", abort, { once: true });
  const timeout = options.timeout ?? (options.login ? 180_000 : 30_000);
  const timer = timeout > 0 ? setTimeout(() => stop(new DevTunnelError(
    options.login ? "DEVTUNNEL_LOGIN_REQUIRED" : "DEVTUNNEL_TIMEOUT",
    "Dev Tunnels operation timed out.",
  )), timeout) : undefined;
  const receive = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-1024 * 1024);
    if (/device.code|login\.microsoft\.com\/device/i.test(output)) {
      stop(new DevTunnelError("DEVTUNNEL_LOGIN_REQUIRED", "Interactive browser login is required. Device code fallback is disabled."));
      return;
    }
    options.onOutput?.(output);
  };
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout = (stdout + chunk.toString()).slice(-1024 * 1024);
    receive(chunk);
  });
  child.stderr?.on("data", receive);
  try {
    await new Promise<void>((resolve, reject) => {
      rejectStopped = reject;
      child.once("error", () => reject(new DevTunnelError("DEVTUNNEL_CLI_MISSING", "Unable to launch the devtunnel CLI.")));
      child.once("close", code => {
        if (failure) reject(failure);
        else if (code === 0) resolve();
        else {
          const detail = sanitizeDevTunnelDiagnostic(output);
          const isAuthFailure = options.login || /unauthorized|not logged in|token.*expired|login required|authentication/i.test(output);
          const base = options.login
            ? `Interactive Microsoft sign-in failed (exit code ${code ?? "unknown"}).`
            : "Dev Tunnels command failed. Check your CLI login, network, and tunnel permissions.";
          reject(new DevTunnelError(
            isAuthFailure ? "DEVTUNNEL_LOGIN_REQUIRED" : "DEVTUNNEL_COMMAND_FAILED",
            detail ? `${base} ${detail}` : base,
          ));
        }
      });
      if (options.signal.aborted) abort();
    });
    return stdout;
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", abort);
    try { await stopping; }
    finally {
      if (loginDirectory) {
        for (const file of [loginOut!, loginErr!]) {
          try { rmSync(file, { force: true }); } catch { /* A failed process shutdown may retain a file handle. */ }
        }
        try { rmdirSync(loginDirectory); } catch { /* Never recursively remove a shared temporary directory. */ }
      }
    }
  }
}
