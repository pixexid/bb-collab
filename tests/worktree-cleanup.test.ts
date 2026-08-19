import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalWorktreePath, classifyWorktree, cleanupGitWorktrees, listAllProjectThreads } from "../src/worktree-cleanup.js";

const roots: string[] = [];
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

function fixture() {
  const root = mkdtempSync("/tmp/bb-worktree-cleanup-");
  roots.push(root);
  git(root, "init", "--quiet");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "test");
  writeFileSync(join(root, "base.txt"), "base\n");
  git(root, "add", "base.txt");
  git(root, "commit", "--quiet", "-m", "base");
  git(root, "branch", "-M", "main");
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  const paths = ["live", "orphan", "dirty"].map((name) => join(root, name));
  for (const path of paths) git(root, "worktree", "add", "--quiet", "--detach", path, "HEAD");
  writeFileSync(join(paths[2], "dirty.txt"), "dirty\n");
  return { root, paths };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("worktree cleanup", () => {
  it("protects managed and candidate roots when HOME itself is under /tmp", () => {
    const managed = classifyWorktree("/tmp/home/.bb/worktrees/orphan", "/tmp/home");
    const candidate = classifyWorktree("/tmp/home/.bb/thread-storage/candidate", "/tmp/home");
    console.log(`overlap classification: ${JSON.stringify({ managed, candidate, preFixManaged: "scratch", preFixCandidate: "scratch" })}`);
    expect(managed).toBe("managed");
    expect(candidate).toBe("candidate");
  });

  it("reports exactly the clean detached orphan and refuses live and dirty entries", () => {
    const { root, paths } = fixture();
    const ownership = new Map(paths.map((path, index) => [canonicalWorktreePath(path), new Set(index === 0 ? ["thr_live"] : [])]));
    const result = cleanupGitWorktrees(root, new Set(["thr_live"]), ownership);
    expect(result.wouldRemove.map(({ path }) => path)).toEqual([canonicalWorktreePath(paths[1])]);
    expect(result.refused).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: canonicalWorktreePath(paths[0]), reason: "live thread thr_live" }),
      expect.objectContaining({ path: canonicalWorktreePath(paths[2]), reason: "uncommitted changes" }),
    ]));
    console.log(`fixture discrimination: ${JSON.stringify({ wouldRemove: result.wouldRemove.map(({ path }) => path), refused: result.refused.map(({ path, reason }) => ({ path, reason })) })}`);
  });

  it("refuses a clean worktree one commit ahead of origin/main", () => {
    const { root, paths } = fixture();
    writeFileSync(join(paths[1], "ahead.txt"), "ahead\n");
    git(paths[1], "add", "ahead.txt");
    git(paths[1], "commit", "--quiet", "-m", "ahead");
    const ownership = new Map([[canonicalWorktreePath(paths[1]), new Set<string>()]]);
    const result = cleanupGitWorktrees(root, new Set(), ownership);
    expect(result.wouldRemove).toEqual([]);
    expect(result.refused).toContainEqual(expect.objectContaining({ path: canonicalWorktreePath(paths[1]), reason: "commits are not reachable from origin/main" }));
  });

  it("pages the complete live-thread inventory past page 1000", async () => {
    const pages: string[][] = [Array.from({ length: 1000 }, (_, index) => `thr_${index}`), ["thr_1000"]];
    const threads = await listAllProjectThreads(async ({ offset }) => pages[offset / 1000].map((id) => ({ id })), "project");
    expect(threads).toHaveLength(1001);
    const { root, paths } = fixture();
    const result = cleanupGitWorktrees(root, new Set(["thr_1000"]), new Map([[canonicalWorktreePath(paths[1]), new Set(["thr_1000"])]]));
    expect(result.wouldRemove).toEqual([]);
  });

  it("is report-only and makes no removal callback available", () => {
    const { root, paths } = fixture();
    const result = cleanupGitWorktrees(root, new Set(), new Map(paths.map((path) => [canonicalWorktreePath(path), new Set()])));
    expect(result).not.toHaveProperty("removed");
    expect(result.environmentRecordsReleased).toBe(false);
  });
});
