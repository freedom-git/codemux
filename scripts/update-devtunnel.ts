#!/usr/bin/env bun
/**
 * Microsoft Dev Tunnels CLI binary update script
 * Downloads the pinned, SHA256-verified devtunnel binary from official Microsoft releases.
 *
 * Usage: bun scripts/update-devtunnel.ts
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DEVTUNNEL_VERSION = "1.0.2115+e16833f284";

const isWindows = process.platform === "win32";
const RESOURCES_DIR = join(import.meta.dir, "..", "resources", "devtunnel");

interface Platform {
  name: NodeJS.Platform;
  arch: string;
  url: string;
  sha256: string;
  archive: "raw" | "zip";
  binaryName: string;
}

// Official Microsoft Dev Tunnels CDN releases (MIT license, offline distribution supported)
// Reference: https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/cli-commands
const ALL_PLATFORMS: Platform[] = [
  {
    name: "darwin",
    arch: "arm64",
    url: `https://tunnelsassetsprod.blob.core.windows.net/cli/${DEVTUNNEL_VERSION}/osx-arm64-devtunnel-zip`,
    sha256: "f2fd04e1746345c7a009c17d6091b85b80b2633e0565623f851a8a298e8b56eb",
    archive: "zip",
    binaryName: "devtunnel",
  },
  {
    name: "darwin",
    arch: "x64",
    url: `https://tunnelsassetsprod.blob.core.windows.net/cli/${DEVTUNNEL_VERSION}/osx-x64-devtunnel-zip`,
    sha256: "e4a430bf2e8963fb6aec53be4a36a1dff40154369acb05906b822c47e439cae4",
    archive: "zip",
    binaryName: "devtunnel",
  },
  {
    name: "win32",
    arch: "x64",
    url: `https://tunnelsassetsprod.blob.core.windows.net/cli/${DEVTUNNEL_VERSION}/devtunnel.exe`,
    sha256: "f11c797e90397a0a8e9bee711d500473632be27839deeb4fb3d0f5dbc6ffd2dc",
    archive: "raw",
    binaryName: "devtunnel.exe",
  },
  {
    name: "linux",
    arch: "x64",
    url: `https://tunnelsassetsprod.blob.core.windows.net/cli/${DEVTUNNEL_VERSION}/linux-x64-devtunnel`,
    sha256: "723d6aebdc226064aef321258fb17c8a2770c9cc2bd05004c0fb83e72b302c3f",
    archive: "raw",
    binaryName: "devtunnel",
  },
];

function getPlatformsToDownload(): Platform[] {
  const currentPlatform = process.platform;
  const systemArch = process.arch;
  const envTargetArch = process.env.TARGET_ARCH;
  const targetArch = envTargetArch || (systemArch === "arm64" ? "arm64" : "x64");

  console.log(`🔍 System info: platform=${currentPlatform}, arch=${systemArch}`);
  console.log(`🔍 TARGET_ARCH env: ${envTargetArch || "(not set)"}`);

  const filtered = ALL_PLATFORMS.filter(
    (p) => p.name === currentPlatform && p.arch === targetArch,
  );

  if (filtered.length === 0) {
    console.error(`❌ No matching devtunnel binary for ${currentPlatform}-${targetArch}`);
    console.error(`   Available platforms: ${ALL_PLATFORMS.map((p) => `${p.name}-${p.arch}`).join(", ")}`);
    process.exit(1);
  }

  console.log(`🔧 Downloading devtunnel ${DEVTUNNEL_VERSION} for platform: ${currentPlatform}-${targetArch}`);
  return filtered;
}

async function downloadVerifiedFile(url: string, expectedSha256: string, destPath: string): Promise<void> {
  console.log(`  Downloading from: ${url}`);
  const response = await fetch(url, {
    headers: { "User-Agent": "codemux-updater" },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`Failed to download (${response.status}): ${response.statusText}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== expectedSha256.toLowerCase()) {
    throw new Error(`SHA256 mismatch for ${url}: expected ${expectedSha256}, got ${actualSha256}`);
  }

  await Bun.write(destPath, bytes);
  console.log(`  Verified SHA256 (${actualSha256.slice(0, 12)}...) and saved to: ${destPath}`);
}

async function extractZip(zipPath: string, destDir: string): Promise<void> {
  if (isWindows) {
    const psCommand = `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`;
    const proc = Bun.spawn(["powershell", "-NoProfile", "-Command", psCommand], {
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`PowerShell Expand-Archive failed with exit code ${exitCode}`);
    }
  } else {
    const proc = Bun.spawn(["unzip", "-o", "-q", zipPath, "-d", destDir], {
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`unzip extraction failed with exit code ${exitCode}`);
    }
  }
  unlinkSync(zipPath);
}

export function isBundledDevTunnelUpToDate(dirPath: string, binaryName: string): boolean {
  const binaryPath = join(dirPath, binaryName);
  const versionPath = join(dirPath, "version.txt");
  if (!existsSync(binaryPath) || !existsSync(versionPath)) return false;
  try {
    return readFileSync(versionPath, "utf-8").trim() === DEVTUNNEL_VERSION;
  } catch {
    return false;
  }
}

export async function updateDevTunnel(): Promise<void> {
  console.log(`🔍 Preparing Microsoft devtunnel CLI (${DEVTUNNEL_VERSION})...`);

  const platformsToDownload = getPlatformsToDownload();
  for (const platform of platformsToDownload) {
    const dirPath = join(RESOURCES_DIR, `${platform.name}-${platform.arch}`);
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
    }

    const destPath = join(dirPath, platform.binaryName);
    console.log(`\n📥 Downloading for ${platform.name}-${platform.arch}...`);

    if (platform.archive === "zip") {
      const zipPath = join(dirPath, "devtunnel.zip");
      await downloadVerifiedFile(platform.url, platform.sha256, zipPath);
      await extractZip(zipPath, dirPath);
    } else {
      await downloadVerifiedFile(platform.url, platform.sha256, destPath);
    }

    if (!existsSync(destPath)) {
      throw new Error(`Expected devtunnel binary not found after download: ${destPath}`);
    }

    if (platform.name !== "win32") {
      chmodSync(destPath, 0o755);
      console.log("   Set executable permission");
    }

    writeFileSync(join(dirPath, "version.txt"), `${DEVTUNNEL_VERSION}\n`, "utf-8");
  }

  console.log("\n✅ Microsoft devtunnel binaries updated successfully!");
}

if (import.meta.main) {
  updateDevTunnel().catch((error) => {
    console.error("❌ Devtunnel update failed:", error);
    process.exit(1);
  });
}
