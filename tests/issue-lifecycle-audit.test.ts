import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { auditGitHubFacts, collectGitHubAudit } from "../scripts/audit-issue-lifecycle.mjs";

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
});
