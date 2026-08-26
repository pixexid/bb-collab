import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";

export function gitPath(): string | null {
  const configured = process.env.BB_COLLAB_GIT_PATH;
  if (configured !== undefined) return isAbsolute(configured) ? configured : null;
  try {
    const result = spawnSync("which", ["git"], { encoding: "utf8", timeout: 2_000 });
    const path = result.error || result.status !== 0 ? null : result.stdout.trim();
    return path && isAbsolute(path) ? path : null;
  } catch {
    return null;
  }
}
