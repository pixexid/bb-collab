#!/usr/bin/env node
// Host-supervised durable wait-validator (issue #93).
//
// This process is supervised by launchd (KeepAlive=true): the OS restarts it
// on death, so validation survives bb restarts, app crashes, and updates.
// Each cycle it invokes one in-plugin validation cycle through the sanctioned
// CLI seam (`bb plugin run bb-collab wait-validator --cycle`), then refreshes
// the liveness marker REGARDLESS of cycle success — a fresh marker proves this
// process lives even while bb is down, and a stale marker means launchd
// itself failed, which the second check escalates to the operator exactly
// once. All validation state (waits, fired-wake dedupe, escalation) lives in
// the plugin KV store, so a restart neither re-fires nor forgets.
//
// Environment:
//   BB_COLLAB_VALIDATOR_STATE_DIR     marker directory (default ~/.bb/bb-collab)
//   BB_COLLAB_VALIDATOR_INTERVAL_MS   cycle interval (default 15000)
//   BB_BIN                            bb binary (default "bb" on PATH)
//
// `--once` runs a single cycle and exits (manual drills, cron use).

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const stateDir = process.env.BB_COLLAB_VALIDATOR_STATE_DIR ?? join(homedir(), ".bb", "bb-collab");
const intervalMs = Number.isFinite(Number(process.env.BB_COLLAB_VALIDATOR_INTERVAL_MS)) && Number(process.env.BB_COLLAB_VALIDATOR_INTERVAL_MS) > 0
  ? Number(process.env.BB_COLLAB_VALIDATOR_INTERVAL_MS)
  : 15_000;
const bbBin = process.env.BB_BIN ?? "bb";
const once = process.argv.includes("--once");
const markerPath = join(stateDir, "wait-validator.liveness");

function touchMarker() {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(markerPath, String(Date.now()));
}

function runCycle() {
  const result = spawnSync(bbBin, ["plugin", "run", "bb-collab", "wait-validator", "--cycle"], {
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.error) {
    // Expected while bb is down: stay alive, keep the marker fresh, retry.
    console.error(`wait-validator: cycle unavailable: ${result.error.message}`);
    return;
  }
  if (result.stdout && result.stdout.trim()) console.log(result.stdout.trim());
  if (result.status !== 0) {
    console.error(`wait-validator: cycle exited ${result.status}${result.stderr && result.stderr.trim() ? `: ${result.stderr.trim()}` : ""}`);
  }
}

let running = true;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { running = false; });

while (running) {
  try {
    runCycle();
  } catch (error) {
    console.error(`wait-validator: cycle failed: ${String(error)}`);
  }
  touchMarker();
  if (once) break;
  const deadline = Date.now() + intervalMs;
  while (running && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now()))));
  }
}
