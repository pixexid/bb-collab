import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { auditExitCode, auditGitHubFacts, collectGitHubAudit, main } from "../scripts/audit-issue-lifecycle.mjs";

describe("scheduled issue lifecycle audit", () => {
  it("distinguishes open completed, incomplete, and unknown GitHub evidence", () => {
    expect(auditGitHubFacts({
      issues: [
        { number: 80, state: "open", body: "acceptance" },
        { number: 81, state: "open", body: "- [ ] remaining acceptance" },
        { number: 82, state: "open", body: null },
        { number: 83, state: "closed", body: "- [x] done" },
      ],
      mergedPullRequests: [
        { number: 100, title: "complete", body: "Closes #80\nAcceptance: complete", merged_at: "2026-08-15T00:00:00Z" },
        { number: 101, title: "incomplete", body: "Related GH-81", merged_at: "2026-08-15T00:00:00Z" },
      ],
    })).toEqual({ openCompleted: ["80"], openIncomplete: ["81"], unknown: ["82"], status: "fail" });
    expect(auditGitHubFacts({
      issues: [{ number: 80, state: "open", body: "acceptance" }],
      mergedPullRequests: [{ title: "malformed", body: "Closes #80\nAcceptance: complete" }],
    })).toEqual({ openCompleted: [], openIncomplete: [], unknown: ["github-merged-pr-shape-unknown", "80"], status: "unknown" });
    expect(auditGitHubFacts({ issues: [{ state: "closed", body: null }], mergedPullRequests: [] })).toEqual({
      openCompleted: [], openIncomplete: [], unknown: ["github-issue-shape-unknown"], status: "unknown",
    });
  });

  it("fails closed when GitHub facts cannot be collected", async () => {
    await expect(collectGitHubAudit({ apiUrl: "https://api.github.test", repository: "acme/repo" })).rejects.toThrow("missing GitHub API identity");
  });

  it("exits nonzero while retaining an explicit unknown report when the API identity is unavailable", () => {
    const result = spawnSync(process.execPath, [join(process.cwd(), "scripts/audit-issue-lifecycle.mjs")], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_API_URL: "https://api.github.test", GITHUB_REPOSITORY: "", GITHUB_TOKEN: "" },
    });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ issueAcceptanceAudit: { unknown: ["github-api-unavailable"], status: "unknown" } });
  });

  it("exits nonzero for a collected unknown report and requires a fail-closed workflow pipeline", async () => {
    expect(auditExitCode("unknown")).toBe(1);
    const workflow = readFileSync(".github/workflows/issue-lifecycle-audit.yml", "utf8");
    expect(workflow).toContain("shell: bash");
    expect(workflow).toContain("set -o pipefail");

    const originalFetch = globalThis.fetch;
    const originalExitCode = process.exitCode;
    const originalEnvironment = { apiUrl: process.env.GITHUB_API_URL, repository: process.env.GITHUB_REPOSITORY, token: process.env.GITHUB_TOKEN };
    globalThis.fetch = (async (input) => ({
      ok: true,
      json: async () => String(input).includes("/issues?") ? [{ number: 82, state: "open", body: null }] : [],
    })) as typeof fetch;
    process.env.GITHUB_API_URL = "https://api.github.test";
    process.env.GITHUB_REPOSITORY = "acme/repo";
    process.env.GITHUB_TOKEN = "test-token";
    process.exitCode = 0;
    try {
      await main();
      expect(process.exitCode).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
      process.exitCode = originalExitCode;
      if (originalEnvironment.apiUrl === undefined) delete process.env.GITHUB_API_URL; else process.env.GITHUB_API_URL = originalEnvironment.apiUrl;
      if (originalEnvironment.repository === undefined) delete process.env.GITHUB_REPOSITORY; else process.env.GITHUB_REPOSITORY = originalEnvironment.repository;
      if (originalEnvironment.token === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = originalEnvironment.token;
    }
  });
});
