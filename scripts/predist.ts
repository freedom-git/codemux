#!/usr/bin/env bun
/**
 * Pre-distribution check script
 * Ensures all required resources are present before packaging with electron-builder.
 *
 * Usage: bun scripts/predist.ts
 */

import { existsSync } from "fs";
import { join } from "path";
import { repairNodePtyPermissions } from "./prepare-native";
import { DEVTUNNEL_VERSION, isBundledDevTunnelUpToDate } from "./update-devtunnel";

const ROOT = join(import.meta.dir, "..");
const CLOUDFLARED_DIR = join(ROOT, "resources", "cloudflared");
const DEVTUNNEL_DIR = join(ROOT, "resources", "devtunnel");

const platform = process.platform; // "darwin", "win32", or "linux"
const systemArch = process.arch; // "arm64" or "x64"
const targetArch = process.env.TARGET_ARCH || (systemArch === "arm64" ? "arm64" : "x64");

const expectedCloudflaredDir = join(CLOUDFLARED_DIR, `${platform}-${targetArch}`);
const cloudflaredBinaryName = platform === "win32" ? "cloudflared.exe" : "cloudflared";
const expectedCloudflaredBinary = join(expectedCloudflaredDir, cloudflaredBinaryName);

const expectedDevTunnelDir = join(DEVTUNNEL_DIR, `${platform}-${targetArch}`);
const devTunnelBinaryName = platform === "win32" ? "devtunnel.exe" : "devtunnel";
const expectedDevTunnelBinary = join(expectedDevTunnelDir, devTunnelBinaryName);

async function main() {
  console.log("🔍 Pre-dist check: verifying required resources...\n");

  await repairNodePtyPermissions(ROOT);

  // Check cloudflared binary
  if (existsSync(expectedCloudflaredBinary)) {
    console.log(`✅ Cloudflared binary found: ${expectedCloudflaredBinary}`);
  } else {
    console.log(`⚠️  Cloudflared binary not found at: ${expectedCloudflaredBinary}`);
    console.log("   Downloading automatically...\n");

    const proc = Bun.spawn(["bun", join(ROOT, "scripts", "update-cloudflared.ts")], {
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env },
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      console.error("\n❌ Failed to download cloudflared binary. Aborting dist build.");
      process.exit(1);
    }

    // Verify again after download
    if (!existsSync(expectedCloudflaredBinary)) {
      console.error(`\n❌ Cloudflared binary still not found after download: ${expectedCloudflaredBinary}`);
      console.error("   Please run manually: bun run update:cloudflared");
      process.exit(1);
    }
    console.log(`\n✅ Cloudflared binary downloaded successfully.`);
  }

  // Check pinned Microsoft devtunnel binary
  if (isBundledDevTunnelUpToDate(expectedDevTunnelDir, devTunnelBinaryName)) {
    console.log(`✅ Devtunnel binary (${DEVTUNNEL_VERSION}) found: ${expectedDevTunnelBinary}`);
  } else {
    console.log(`⚠️  Devtunnel binary (${DEVTUNNEL_VERSION}) missing or outdated at: ${expectedDevTunnelBinary}`);
    console.log("   Downloading automatically...\n");

    const proc = Bun.spawn(["bun", join(ROOT, "scripts", "update-devtunnel.ts")], {
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env },
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      console.error("\n❌ Failed to download devtunnel binary. Aborting dist build.");
      process.exit(1);
    }

    if (!isBundledDevTunnelUpToDate(expectedDevTunnelDir, devTunnelBinaryName)) {
      console.error(`\n❌ Devtunnel binary still not up to date after download: ${expectedDevTunnelBinary}`);
      console.error("   Please run manually: bun run update:devtunnel");
      process.exit(1);
    }
    console.log(`\n✅ Devtunnel binary (${DEVTUNNEL_VERSION}) downloaded successfully.`);
  }

  console.log("\n✅ All pre-dist checks passed. Proceeding with build...\n");
}

main();
