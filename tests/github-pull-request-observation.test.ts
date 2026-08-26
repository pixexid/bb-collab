import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  observeGithubPullRequest,
  type GithubPullRequestTarget,
} from "../src/github-pull-request-observation-provenance.js";

const target: GithubPullRequestTarget = {
  repositoryIdentity: { host: "github.test", owner: "pixexid", repo: "bb-collab" },
  pullRequestNumber: 658,
};
const headSha = "a".repeat(40);
const temporaryDirectories: string[] = [];

const response = (overrides: Record<string, unknown> = {}) => ({
  number: target.pullRequestNumber,
  headRefOid: headSha,
  state: "OPEN",
  mergedAt: null,
  reviewDecision: "",
  reviews: [],
  statusCheckRollup: [{ conclusion: "SUCCESS" }],
  url: "https://github.test/pixexid/bb-collab/pull/658",
  ...overrides,
});

const adapter = (value: unknown) => ({ read: async () => value });

function executable(contents: string): string {
  const directory = mkdtempSync(join(tmpdir(), "bb-gh-observation-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "gh");
  writeFileSync(path, contents, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

describe("GitHub pull-request observation", () => {
  it("normalizes open, closed-unmerged, and merged pull requests", async () => {
    await expect(observeGithubPullRequest(target, { adapter: adapter(response()) })).resolves.toMatchObject({ state: "open", merged: false });
    await expect(observeGithubPullRequest(target, { adapter: adapter(response({ state: "CLOSED" })) })).resolves.toMatchObject({ state: "closed_unmerged", merged: false });
    await expect(observeGithubPullRequest(target, { adapter: adapter(response({ state: "MERGED", mergedAt: "2026-08-25T00:00:00Z" })) })).resolves.toMatchObject({ state: "merged", merged: true });
  });

  it.each([
    ["pending", [{ state: "IN_PROGRESS" }]],
    ["success", [{ conclusion: "SUCCESS" }, { conclusion: "NEUTRAL" }, { conclusion: "SKIPPED" }]],
    ["failure", [{ conclusion: "FAILURE" }]],
    ["cancelled", [{ conclusion: "CANCELLED" }]],
    ["unknown", [{ conclusion: "NOT_A_REAL_CONCLUSION" }]],
  ] as const)("normalizes %s checks", async (checksSummary, checks) => {
    await expect(observeGithubPullRequest(target, { adapter: adapter(response({ statusCheckRollup: checks })) })).resolves.toMatchObject({ checksSummary });
  });

  it.each([
    ["none", "", []],
    ["approved", "APPROVED", [{ state: "APPROVED" }]],
    ["changes_requested", "CHANGES_REQUESTED", [{ state: "CHANGES_REQUESTED" }]],
    ["dismissed_or_changed", "REVIEW_REQUIRED", [{ state: "DISMISSED" }]],
    ["unknown", "SOMETHING_NEW", []],
  ] as const)("normalizes %s review state", async (reviewDecision, decision, reviews) => {
    await expect(observeGithubPullRequest(target, { adapter: adapter(response({ reviewDecision: decision, reviews })) })).resolves.toMatchObject({ reviewDecision });
  });

  it("rejects partial, malformed, and foreign responses instead of coercing them", async () => {
    for (const mutant of [
      response({ number: 659 }),
      response({ headRefOid: "not-a-sha" }),
      response({ url: "https://foreign.test/pixexid/bb-collab/pull/658" }),
      response({ statusCheckRollup: undefined }),
      response({ reviews: [{ }] }),
      response({ state: "UNKNOWN" }),
      null,
    ]) {
      await expect(observeGithubPullRequest(target, { adapter: adapter(mutant) })).rejects.toMatchObject({ status: "degraded" });
    }
  });

  it("prefers the configured read adapter and never mutates the process environment", async () => {
    const inheritedHost = process.env.GH_HOST;
    const ghPath = join(tmpdir(), "missing-gh-binary");
    await expect(observeGithubPullRequest(target, { adapter: adapter(response()), ghPath })).resolves.toMatchObject({ pullRequestNumber: 658 });
    expect(process.env.GH_HOST).toBe(inheritedHost);
  });

  it("uses an exact per-target host and repository through an absolute gh path", async () => {
    const inheritedHost = process.env.GH_HOST;
    const ghPath = executable(`#!/bin/sh
if [ "$1" != "pr" ] || [ "$2" != "view" ] || [ "$4" != "--repo" ] || [ "$5" != "pixexid/bb-collab" ] || [ "$GH_HOST" != "github.test" ]; then exit 19; fi
printf '%s' '${JSON.stringify(response())}'
`);
    await expect(observeGithubPullRequest(target, { ghPath })).resolves.toMatchObject({ repositoryIdentity: target.repositoryIdentity });
    expect(process.env.GH_HOST).toBe(inheritedHost);
  });

  it("surfaces timeout, missing, and unresolvable gh as degraded", async () => {
    const slowGh = executable("#!/bin/sh\nsleep 2\n");
    await expect(observeGithubPullRequest(target, { ghPath: slowGh, timeoutMs: 25 })).rejects.toMatchObject({ status: "degraded", reason: "timeout" });
    await expect(observeGithubPullRequest(target, { ghPath: join(tmpdir(), "missing-gh-binary") })).rejects.toMatchObject({ status: "degraded", reason: "gh_path_invalid" });
    const relativeGh = executable(`#!/bin/sh
printf '%s' '${JSON.stringify(response())}'
`);
    await expect(observeGithubPullRequest(target, { ghPath: relative(process.cwd(), relativeGh) })).rejects.toMatchObject({ status: "degraded", reason: "gh_path_invalid" });
    await expect(observeGithubPullRequest(target)).rejects.toMatchObject({ status: "degraded", reason: "gh_unavailable" });
  });

  it("falls back to gh only when the configured adapter is unavailable", async () => {
    const ghPath = executable(`#!/bin/sh
printf '%s' '${JSON.stringify(response({ state: "CLOSED" }))}'
`);
    await expect(observeGithubPullRequest(target, { adapter: { read: () => { throw new Error("offline"); } }, ghPath })).resolves.toMatchObject({ state: "closed_unmerged" });
  });
});
