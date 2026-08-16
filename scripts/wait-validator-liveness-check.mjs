#!/usr/bin/env node
// Second self-watch check (issue #93): alerts the OPERATOR exactly once when
// the wait-validator liveness marker goes stale — meaning launchd itself
// failed to keep the validator alive, which is operator territory. This is
// the trivial second mechanism; it never restarts anything and never repeats
// an alert within one staleness episode. A missing marker is never
// launchd-failure evidence (the agent may not be deployed), so it stays
// silent: fail closed against false alarms.
//
// The plugin's own `wait-validator-liveness` schedule runs this same rule
// while bb is up; this standalone form covers hosts that prefer cron or the
// notify plugin's schedule. Both share the same alert-flag file, so running
// both never double-alerts.
//
// Environment:
//   BB_COLLAB_VALIDATOR_STATE_DIR  marker directory (default ~/.bb/bb-collab)
//   BB_COLLAB_LIVENESS_STALE_MS    staleness threshold (default 300000)

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const stateDir = process.env.BB_COLLAB_VALIDATOR_STATE_DIR ?? join(homedir(), ".bb", "bb-collab");
const staleMs = Number.isFinite(Number(process.env.BB_COLLAB_LIVENESS_STALE_MS)) && Number(process.env.BB_COLLAB_LIVENESS_STALE_MS) > 0
  ? Number(process.env.BB_COLLAB_LIVENESS_STALE_MS)
  : 300_000;
const markerPath = join(stateDir, "wait-validator.liveness");
const flagPath = join(stateDir, "wait-validator.alerted");

function readMarkerAtMs() {
  try {
    const parsed = Number(readFileSync(markerPath, "utf8").trim());
    return Number.isFinite(parsed) && parsed > 0 ? parsed : statSync(markerPath).mtimeMs;
  } catch {
    return null;
  }
}

const markerAtMs = readMarkerAtMs();
if (markerAtMs === null) process.exit(0); // absent marker: not launchd-failure evidence

if (Date.now() - markerAtMs < staleMs) {
  // Validator is alive again: close the episode so a future one can alert.
  if (existsSync(flagPath)) rmSync(flagPath, { force: true });
  process.exit(0);
}

if (existsSync(flagPath)) process.exit(0); // already alerted for this episode

mkdirSync(stateDir, { recursive: true });
writeFileSync(flagPath, String(Date.now()));
const message = `bb-collab wait-validator marker stale since ${new Date(markerAtMs).toISOString()}: launchd supervision failed; operator attention required`;
console.error(`OPERATOR ALERT: ${message}`);
try {
  spawnSync("osascript", ["-e", `display notification "${message}" with title "bb-collab wait-validator"`], { stdio: "ignore" });
} catch {
  // A missed desktop notification is not a reason to fail the check.
}
process.exitCode = 1;
