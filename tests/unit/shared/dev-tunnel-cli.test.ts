import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: mocks.spawn, execFile: mocks.execFile };
});
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDevTunnelPath, runDevTunnelCommand, sanitizeDevTunnelDiagnostic } from "../../../shared/dev-tunnel-cli";

class Process extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = 123456;
  exitCode: number | null = null;
  signalCode: string | null = null;
  kill = vi.fn(() => { this.finish(1); return true; });
  finish(code: number) { this.exitCode = code; this.emit("close", code); }
}

function fixture() {
  const child = new Process();
  mocks.spawn.mockReturnValue(child);
  mocks.execFile.mockImplementation((_file, _args, _options, callback) => {
    child.finish(1);
    callback(null);
  });
  return child;
}

afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });

describe("runDevTunnelCommand", () => {
  it("keeps stderr diagnostics out of structured stdout", async () => {
    const child = fixture();
    const running = runDevTunnelCommand("devtunnel", ["user", "show", "--json"], { signal: new AbortController().signal });
    child.stderr.emit("data", Buffer.from("A diagnostic from the CLI\n"));
    child.stdout.emit("data", Buffer.from('{"status":"Logged in"}'));
    child.finish(0);
    expect(JSON.parse(await running)).toEqual({ status: "Logged in" });
  });

  it("terminates device-code fallback instead of returning or logging its challenge", async () => {
    const child = fixture();
    const running = runDevTunnelCommand("devtunnel", ["user", "login", "--use-browser-auth"], { signal: new AbortController().signal, login: true });
    const failed = expect(running).rejects.toMatchObject({ code: "DEVTUNNEL_LOGIN_REQUIRED" });
    child.stderr.emit("data", Buffer.from("Falling back to device code authentication. SECRET-CODE"));
    await failed;
    expect(child.exitCode).not.toBeNull();
    if (process.platform === "win32") {
      const encoded = mocks.spawn.mock.calls[0][1].at(-1);
      const script = Buffer.from(encoded, "base64").toString("utf16le");
      expect(script).toContain("--use-browser-auth");
      expect(script).toContain("Start-Process");
      expect(script).not.toContain("--use-device-code-auth");
      expect(mocks.execFile.mock.calls[0][1]).toEqual(["/PID", "123456", "/T", "/F"]);
    }
  });

  it("cancels only the owned CLI process", async () => {
    const child = fixture();
    const abort = new AbortController();
    const running = runDevTunnelCommand("devtunnel", ["host", "codemux-test"], { signal: abort.signal, timeout: 0 });
    const failed = expect(running).rejects.toMatchObject({ code: "DEVTUNNEL_CANCELLED" });
    abort.abort();
    await failed;
    expect(child.exitCode).not.toBeNull();
  });

  it.runIf(process.platform === "win32")("reports failed process termination instead of hanging or silently succeeding", async () => {
    fixture();
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => callback(new Error("Access denied")));
    const abort = new AbortController();
    const running = runDevTunnelCommand("devtunnel", ["host", "codemux-test"], { signal: abort.signal, timeout: 0 });
    const failed = expect(running).rejects.toMatchObject({ code: "DEVTUNNEL_STOP_FAILED" });
    abort.abort();
    await failed;
  });

  it("redacts raw CLI failure output while surfacing sanitized error details and times out stalled commands", async () => {
    const child = fixture();
    const running = runDevTunnelCommand("devtunnel", ["show", "codemux-test"], { signal: new AbortController().signal });
    child.stderr.emit("data", Buffer.from("Request failed (HTTP 403): Authorization: SECRET-TOKEN"));
    child.finish(1);
    let caught: Error | undefined;
    try { await running; } catch (err) { caught = err as Error; }
    expect(caught?.message).toContain("Dev Tunnels command failed.");
    expect(caught?.message).toContain("Request failed (HTTP 403): Authorization: [redacted]");
    expect(caught?.message).not.toContain("SECRET-TOKEN");
    expect(sanitizeDevTunnelDiagnostic("tkn=my-secret https://x.devtunnels.ms/?tkn=abc AADSTS53003: Blocked"))
      .toBe("tkn=[redacted] https://x.devtunnels.ms/ AADSTS53003: Blocked");
    vi.useFakeTimers();
    fixture();
    const stalled = runDevTunnelCommand("devtunnel", ["list"], { signal: new AbortController().signal, timeout: 100 });
    const failed = expect(stalled).rejects.toMatchObject({ code: "DEVTUNNEL_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(100);
    await failed;
  });

  it.runIf(process.platform === "win32")("executes Windows PowerShell 5.1 login wrapper with accurate exit code 0 and surfaces non-zero stderr", async () => {
    const child = fixture();
    const pending = runDevTunnelCommand("devtunnel", ["user", "login", "--entra", "--use-browser-auth"], {
      signal: new AbortController().signal,
      login: true,
    });
    const encoded = mocks.spawn.mock.calls[0][1].at(-1) as string;
    child.finish(0);
    await pending;

    const dir = mkdtempSync(join(tmpdir(), "devtunnel-ps51-test-"));
    try {
      const okCmd = join(dir, "ok.cmd");
      writeFileSync(okCmd, "@echo Logged in as user@microsoft.com\r\n@exit /b 0\r\n");
      const okRun = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
        env: {
          ...process.env,
          CODEMUX_DEVTUNNEL_CLI: okCmd,
          CODEMUX_DEVTUNNEL_LOGIN_OUT: join(dir, "ok.out"),
          CODEMUX_DEVTUNNEL_LOGIN_ERR: join(dir, "ok.err"),
        },
        windowsHide: true,
        encoding: "utf8",
      });
      expect(okRun.status).toBe(0);

      const failCmd = join(dir, "fail.cmd");
      writeFileSync(failCmd, "@echo WAM broker error AADSTS500011 1>&2\r\n@exit /b 5\r\n");
      const failRun = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
        env: {
          ...process.env,
          CODEMUX_DEVTUNNEL_CLI: failCmd,
          CODEMUX_DEVTUNNEL_LOGIN_OUT: join(dir, "fail.out"),
          CODEMUX_DEVTUNNEL_LOGIN_ERR: join(dir, "fail.err"),
        },
        windowsHide: true,
        encoding: "utf8",
      });
      expect(failRun.status).toBe(5);
      expect(failRun.stderr).toContain("WAM broker error AADSTS500011");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("getDevTunnelPath", () => {
  it.each([
    ["darwin", "arm64", "/Applications/CodeMux.app/Contents/Resources", "/Applications/CodeMux.app/Contents/Resources/devtunnel/darwin-arm64/devtunnel"],
    ["linux", "x64", "/opt/CodeMux/resources", "/opt/CodeMux/resources/devtunnel/linux-x64/devtunnel"],
    ["win32", "x64", "C:\\Program Files\\CodeMux\\resources", "C:\\Program Files\\CodeMux\\resources\\devtunnel\\win32-x64\\devtunnel.exe"],
  ] as const)("prefers the bundled binary in resourcesPath over system PATH on %s-%s", (platform, arch, resourcesPath, expected) => {
    const existing = new Set([
      expected,
      platform === "win32" ? "C:\\Tools\\devtunnel.exe" : "/usr/local/bin/devtunnel",
    ]);
    const resolved = getDevTunnelPath({
      platform,
      arch,
      env: { PATH: platform === "win32" ? "C:\\Tools" : "/usr/local/bin" },
      resourcesPath,
      exists: (file) => existing.has(file),
    });
    expect(resolved).toBe(expected);
  });

  it("reads CODEMUX_RESOURCES_PATH for the desktop local server child process and falls back to win32-x64 on ARM64 Windows", () => {
    const bundledX64 = "C:\\Users\\alice\\AppData\\Local\\Programs\\CodeMux\\resources\\devtunnel\\win32-x64\\devtunnel.exe";
    const resolved = getDevTunnelPath({
      platform: "win32",
      arch: "arm64",
      env: {
        CODEMUX_RESOURCES_PATH: "C:\\Users\\alice\\AppData\\Local\\Programs\\CodeMux\\resources",
        PATH: "C:\\Windows\\System32",
      },
      exists: (file) => file === bundledX64,
    });
    expect(resolved).toBe(bundledX64);
  });

  it("falls back to PATH and WinGet directories when no bundled binary exists", () => {
    const wingetExe = "C:\\Users\\alice\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Microsoft.devtunnel_Microsoft.Winget.Source_8wekyb3d8bbwe\\devtunnel.exe";
    const resolved = getDevTunnelPath({
      platform: "win32",
      arch: "x64",
      resourcesPath: "Q:\\Projects\\codemux\\node_modules\\electron\\dist\\resources",
      env: {
        PATH: "C:\\Windows\\System32",
        LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local",
      },
      exists: (file) => file === wingetExe,
      readDir: (dir) => dir.endsWith("\\Packages") ? ["Microsoft.devtunnel_Microsoft.Winget.Source_8wekyb3d8bbwe"] : [],
    });
    expect(resolved).toBe(wingetExe);
  });
});

