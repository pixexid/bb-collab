#!/usr/bin/env node
// Host-supervised succession-safe stall guard.
//
// launchd keeps this model-free loop alive. The plugin resolves the current
// role holder and persists artifact snapshots in its KV store on every cycle.
// The marker is refreshed regardless of cycle success.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const stateDir = process.env.BB_COLLAB_STALL_GUARD_STATE_DIR ?? join(homedir(), ".bb", "bb-collab");
const intervalMs = Number.isFinite(Number(process.env.BB_COLLAB_STALL_GUARD_INTERVAL_MS)) && Number(process.env.BB_COLLAB_STALL_GUARD_INTERVAL_MS) > 0
  ? Number(process.env.BB_COLLAB_STALL_GUARD_INTERVAL_MS)
  : 15_000;
const bbBin = process.env.BB_BIN ?? "bb";
const once = process.argv.includes("--once");
const markerPath = join(stateDir, "stall-guard.liveness");

function touchMarker() {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(markerPath, String(Date.now()));
}

function runCycle() {
  const result = spawnSync(bbBin, ["plugin", "run", "bb-collab", "stall-guard", "--cycle"], {
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.error) {
    console.error(`stall-guard: cycle unavailable: ${result.error.message}`);
    return;
  }
  if (result.stdout && result.stdout.trim()) console.log(result.stdout.trim());
  if (result.status !== 0) {
    console.error(`stall-guard: cycle exited ${result.status}${result.stderr && result.stderr.trim() ? `: ${result.stderr.trim()}` : ""}`);
  }
}

let running = true;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { running = false; });

while (running) {
  try {
    runCycle();
  } catch (error) {
    console.error(`stall-guard: cycle failed: ${String(error)}`);
  }
  touchMarker();
  if (once) break;
  const deadline = Date.now() + intervalMs;
  while (running && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now()))));
  }
}
