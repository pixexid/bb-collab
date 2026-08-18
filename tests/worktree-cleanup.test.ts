import { describe, expect, it } from "vitest";
import { runWorktreeCleanup, type WorktreeEntry } from "../src/worktree-cleanup.js";

describe("worktree cleanup", () => {
  it("removes exactly the clean orphan and is idempotent", () => {
    const entries: WorktreeEntry[] = [
      { path: "/tmp/live", branch: "review-thr_live", head: "live", population: "scratch", threadId: "thr_live" },
      { path: "/tmp/orphan", branch: "review-thr_orphan", head: "orphan", population: "scratch", threadId: "thr_orphan" },
      { path: "/tmp/dirty", branch: "review-thr_dirty", head: "dirty", population: "scratch", threadId: "thr_dirty" },
    ];
    const live = new Set(["thr_live"]);
    const removed = new Set<string>();
    const options = {
      liveThreadIds: live,
      originMain: "origin/main",
      status: (path: string) => path === "/tmp/dirty" ? " M file" : "",
      reachable: () => true,
      apply: true,
      remove: (path: string) => removed.add(path),
    };
    const first = runWorktreeCleanup(entries, options);
    const firstOutput = { removed: first.removed, refused: first.refused.map(({ path, reason }) => ({ path, reason })) };
    expect(first.removed).toEqual(["/tmp/orphan"]);
    expect(first.refused.map(({ path }) => path)).toEqual(["/tmp/live", "/tmp/dirty"]);
    console.log(`fixture discrimination: ${JSON.stringify(firstOutput)}`);

    const second = runWorktreeCleanup(entries.filter((entry) => !removed.has(entry.path)), options);
    const secondOutput = { removed: second.removed, refused: second.refused.map(({ path, reason }) => ({ path, reason })) };
    expect(second.removed).toEqual([]);
    expect(second.refused.map(({ path }) => path)).toEqual(["/tmp/live", "/tmp/dirty"]);
    console.log(`idempotence: ${JSON.stringify(secondOutput)}`);
  });

  it("refuses managed orphans because no environment-record release exists", () => {
    const result = runWorktreeCleanup([{ path: "/Users/x/.bb/worktrees/env", branch: "bb/x-thr_orphan", head: "x", population: "managed", threadId: "thr_orphan" }], {
      liveThreadIds: new Set(), originMain: "origin/main", apply: true, status: () => "", reachable: () => true,
    });
    expect(result.removed).toEqual([]);
    expect(result.refused[0]?.reason).toContain("environment record cannot be released");
    expect(result.environmentRecordsReleased).toBe(false);
  });
});
