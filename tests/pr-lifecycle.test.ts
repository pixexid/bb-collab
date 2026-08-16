import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { hasLifecycleMarker, lifecycleMarker, parsePullRequestDisposition, planMergedLifecycle, validateIssueTarget } from "../scripts/pr-lifecycle.mjs";

describe("pull-request lifecycle linkage", () => {
  it("accepts one related disposition and a completed close disposition", () => {
    expect(parsePullRequestDisposition({ title: "Related GH-80", body: "Related GH-80\n\nReview tier: A" }).ok).toBe(true);
    expect(parsePullRequestDisposition({ title: "Add weekly metrics for GH-80", body: "Related GH-80" }).ok).toBe(true);
    expect(parsePullRequestDisposition({ title: "Closes #80", body: "Closes #80\nAcceptance: complete" }).ok).toBe(true);
    expect(parsePullRequestDisposition({ body: "No issue: documentation-only typo with no tracked issue" }).ok).toBe(true);
  });

  it("rejects missing, ambiguous, and premature close linkage", () => {
    for (const body of [
      "Review tier: A",
      "Related GH-80\nRelated GH-81",
      "Closes #80",
      "Fixes GH-80\nAcceptance: incomplete",
      "Related GH-80\nAcceptance: complete",
      "Refs #80",
      "Related GH-0",
      "No issue: GH-80 is not tracked",
    ]) expect(parsePullRequestDisposition({ body }).ok, body).toBe(false);
  });

  it("fails closed for invalid and uncertain GitHub targets", async () => {
    const valid = parsePullRequestDisposition({ body: "Related GH-80" });
    await expect(validateIssueTarget(valid, async () => ({ number: 81, state: "open" }))).resolves.toMatchObject({ ok: false });
    await expect(validateIssueTarget(valid, async () => ({ number: 80, state: "open", pull_request: {} }))).resolves.toMatchObject({ ok: false });
    await expect(validateIssueTarget(valid, async () => ({ number: 80, state: "unknown" }))).resolves.toMatchObject({ ok: false });
    await expect(validateIssueTarget(valid, async () => { throw new Error("rate limited"); })).resolves.toMatchObject({ ok: false });
    await expect(validateIssueTarget(valid, async () => ({ number: 80, state: "open" }))).resolves.toMatchObject({ ok: true });
  });

  it("uses one deterministic marker to make merge handling duplicate-safe", () => {
    const marker = lifecycleMarker(87, "issue-80", "related");
    expect(marker).toBe("<!-- bb-collab:issue-lifecycle:pr-87:issue-80:related -->");
    expect(hasLifecycleMarker([{ body: `status\n${marker}` }], marker)).toBe(true);
    expect(hasLifecycleMarker([{ body: "different status" }], marker)).toBe(false);
  });

  it("plans related comments once and closes only a complete disposition", () => {
    const related = parsePullRequestDisposition({ body: "Related GH-80" });
    const planned = planMergedLifecycle({ pullRequestNumber: 91, parsed: related, issueState: "open" });
    expect(planned.actions).toMatchObject([{ kind: "comment", target: 80 }]);
    expect(planMergedLifecycle({ pullRequestNumber: 91, parsed: related, issueState: "open", issueComments: [{ body: planned.marker }] }).actions).toEqual([]);

    const closes = parsePullRequestDisposition({ body: "Closes #80\nAcceptance: complete" });
    expect(planMergedLifecycle({ pullRequestNumber: 92, parsed: closes, issueState: "open" }).actions.map(({ kind }) => kind)).toEqual(["close", "comment"]);
    expect(planMergedLifecycle({ pullRequestNumber: 92, parsed: closes, issueState: "closed" }).actions.map(({ kind }) => kind)).toEqual(["comment"]);
  });

  it("pins the write-token merge workflow to trusted default-branch code", () => {
    const workflow = readFileSync(".github/workflows/issue-lifecycle.yml", "utf8");
    expect(workflow).toContain("pull_request_target:");
    expect(workflow).toContain("ref: refs/heads/main");
    expect(workflow).not.toContain("github.event.pull_request.head.sha");
    expect(workflow).toContain("issues: write");
  });
});
