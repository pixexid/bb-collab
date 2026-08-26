import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gitPath } from "./git-path.js";

export interface CheckoutDivergence {
  checkoutHead: string | null;
  originMainRef: string | null;
  behindCount: number | null;
  verdict: "clean" | "diverged" | "unavailable";
  processGroupReap: "not-attempted" | "reaped" | "absent" | "failed";
}

function readRef(gitDirs: string[], ref: string): string | null {
  for (const gitDir of gitDirs) {
    const looseRef = join(gitDir, ref);
    if (existsSync(looseRef)) return readFileSync(looseRef, "utf8").trim() || null;
    const packedRefs = join(gitDir, "packed-refs");
    if (!existsSync(packedRefs)) continue;
    for (const line of readFileSync(packedRefs, "utf8").split("\n")) {
      const [sha, name] = line.trim().split(" ");
      if (name === ref) return sha ?? null;
    }
  }
  return null;
}

function resolveGitDir(checkoutRoot: string): string | null {
  const dotGit = join(checkoutRoot, ".git");
  if (!existsSync(dotGit)) return null;
  if (statSync(dotGit).isDirectory()) return dotGit;
  const marker = readFileSync(dotGit, "utf8").trim();
  return marker.startsWith("gitdir:") ? resolve(checkoutRoot, marker.slice("gitdir:".length).trim()) : null;
}

function commonGitDir(gitDir: string): string {
  const commondir = join(gitDir, "commondir");
  return existsSync(commondir) ? resolve(gitDir, readFileSync(commondir, "utf8").trim()) : gitDir;
}

function readHead(gitDir: string, commonDir: string): string | null {
  const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
  if (!head.startsWith("ref: ")) return head || null;
  return readRef([gitDir, commonDir], head.slice("ref: ".length));
}

export function findCheckoutRoot(startPath: string): string | null {
  let current = resolve(startPath);
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function readCheckoutDivergence(checkoutRoot: string | null): CheckoutDivergence {
  const unavailable: CheckoutDivergence = { checkoutHead: null, originMainRef: null, behindCount: null, verdict: "unavailable", processGroupReap: "not-attempted" };
  if (!checkoutRoot) return unavailable;
  try {
    const gitDir = resolveGitDir(checkoutRoot);
    if (!gitDir) return unavailable;
    const commonDir = commonGitDir(gitDir);
    const checkoutHead = readHead(gitDir, commonDir);
    const originMainRef = readRef([commonDir, gitDir], "refs/remotes/origin/main");
    if (!checkoutHead || !originMainRef) return { checkoutHead, originMainRef, behindCount: null, verdict: "unavailable", processGroupReap: "not-attempted" };
    const executable = gitPath();
    if (!executable) return { checkoutHead, originMainRef, behindCount: null, verdict: "unavailable", processGroupReap: "not-attempted" };
    let behindCount: number | null = null;
    let processGroupReap: CheckoutDivergence["processGroupReap"] = "not-attempted";
    try {
      const options: SpawnSyncOptionsWithStringEncoding & { detached: true } = { cwd: checkoutRoot, encoding: "utf8", env: { ...process.env, GIT_NO_LAZY_FETCH: "1" }, stdio: ["ignore", "pipe", "ignore"], timeout: 1_000, killSignal: "SIGKILL", detached: true };
      const result = spawnSync(executable, ["rev-list", "--count", `${checkoutHead}..${originMainRef}`], options);
      if (typeof result.pid === "number" && result.pid > 0) {
        try {
          process.kill(-result.pid, "SIGKILL");
          processGroupReap = "reaped";
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") processGroupReap = "absent";
          else {
            processGroupReap = "failed";
            return { checkoutHead, originMainRef, behindCount: null, verdict: "unavailable", processGroupReap };
          }
        }
      }
      const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
      if (errorCode === "ENOENT" || errorCode === "EACCES" || errorCode === "ENOTDIR") {
        return { checkoutHead, originMainRef, behindCount: null, verdict: "unavailable", processGroupReap };
      }
      const count = result.stdout.trim();
      if (/^\d+$/u.test(count)) behindCount = Number(count);
    } catch {
      // Ref comparison remains useful even when the local object graph is incomplete.
    }
    return { checkoutHead, originMainRef, behindCount, verdict: checkoutHead === originMainRef ? "clean" : "diverged", processGroupReap };
  } catch {
    return unavailable;
  }
}
