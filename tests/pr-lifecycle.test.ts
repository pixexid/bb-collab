import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { handleMergedPullRequestLifecycle } from "../scripts/handle-merged-pr-lifecycle.mjs";
import { hasLifecycleMarker, lifecycleMarker, parsePullRequestDisposition, planMergedLifecycle, validateCommitMessages, validateIssueTarget, validateLifecycleComments } from "../scripts/pr-lifecycle.mjs";

const noIssuePullRequest = (number = 94, body = "No issue: the original lifecycle run lacked the required permission") => ({
  number,
  state: "closed",
  merged_at: "2026-08-15T00:00:00Z",
  title: "Backfill lifecycle evidence",
  body,
});

type LifecycleCall = { method: string; path: string; body?: BodyInit | null };
type FakeFetchOptions = { pullRequest?: { number: number; [key: string]: unknown }; commits?: unknown[]; comments?: unknown; postStatus?: number; calls?: LifecycleCall[] };
const fakeFetch = ({ pullRequest = noIssuePullRequest(), commits = [{ commit: { message: "ordinary implementation" } }], comments = [], postStatus = 201, calls = [] }: FakeFetchOptions = {}) => async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  calls.push({ method, path: url.pathname, body: init?.body });
  if (method === "POST") return { ok: postStatus >= 200 && postStatus < 300, status: postStatus, json: async () => ({}) } as Response;
  if (url.pathname.endsWith(`/pulls/${pullRequest.number}`)) return { ok: true, status: 200, json: async () => pullRequest } as Response;
  if (url.pathname.endsWith(`/pulls/${pullRequest.number}/commits`)) return { ok: true, status: 200, json: async () => commits } as Response;
  if (url.pathname.endsWith(`/issues/${pullRequest.number}/comments`)) return { ok: true, status: 200, json: async () => comments } as Response;
  return { ok: false, status: 404, json: async () => ({}) } as Response;
};

describe("pull-request lifecycle linkage", () => {
  it("accepts one related disposition and a completed close disposition", () => {
    expect(parsePullRequestDisposition({ title: "Related GH-80", body: "Related GH-80\n\nReview tier: A" }).ok).toBe(true);
    expect(parsePullRequestDisposition({ title: "Add weekly metrics for GH-80", body: "Related GH-80" }).ok).toBe(true);
    expect(parsePullRequestDisposition({ title: "Complete acceptance", body: "Closes #80\nAcceptance: complete" }).ok).toBe(true);
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
      "Closes #80\nRefs #80\nAcceptance: complete",
      "Closes #80\nFixes #81\nAcceptance: complete",
      "Fixes pixexid/bb-collab#80\nAcceptance: incomplete",
      "Fixes: pixexid/bb-collab#80\nAcceptance: incomplete",
      "<!--\nCloses #80\nAcceptance: complete\n-->",
      "```\nCloses #80\nAcceptance: complete\n```",
    ]) expect(parsePullRequestDisposition({ body }).ok, body).toBe(false);
    expect(parsePullRequestDisposition({ title: "Closes #81", body: "Closes #80\nAcceptance: complete" }).ok).toBe(false);
    expect(parsePullRequestDisposition({ title: "Related GH-81", body: "Related GH-80" }).ok).toBe(false);
  });

  it("fails closed for invalid and uncertain GitHub targets", async () => {
    const valid = parsePullRequestDisposition({ body: "Related GH-80" });
    await expect(validateIssueTarget(valid, async () => ({ number: 81, state: "open" }))).resolves.toMatchObject({ ok: false });
    await expect(validateIssueTarget(valid, async () => ({ number: 80, state: "open", pull_request: {} }))).resolves.toMatchObject({ ok: false });
    await expect(validateIssueTarget(valid, async () => ({ number: 80, state: "unknown" }))).resolves.toMatchObject({ ok: false });
    await expect(validateIssueTarget(valid, async () => ({ number: 80, state: "closed" }))).resolves.toMatchObject({ ok: false });
    await expect(validateIssueTarget(valid, async () => { throw new Error("rate limited"); })).resolves.toMatchObject({ ok: false });
    await expect(validateIssueTarget(valid, async () => ({ number: 80, state: "open" }))).resolves.toMatchObject({ ok: true });
  });

  it("rejects automatic GitHub closure hidden in commit messages", () => {
    const related = parsePullRequestDisposition({ body: "Related GH-80" });
    expect(validateCommitMessages(related, ["Fixes #80"]).ok).toBe(false);
    expect(validateCommitMessages(related, ["Fixes GH-80"]).ok).toBe(false);
    expect(validateCommitMessages(related, ["Fixes pixexid/bb-collab#80"]).ok).toBe(false);
    expect(validateCommitMessages(related, ["Fixes:  pixexid/bb-collab#80"]).ok).toBe(false);
    expect(validateCommitMessages(related, ["Fixes: https://github.com/pixexid/bb-collab/issues/80"]).ok).toBe(false);
    expect(validateCommitMessages(related, ["Fixes: #80"]).ok).toBe(false);
    expect(validateCommitMessages(related, ["Resolves: #80"]).ok).toBe(false);
    expect(validateCommitMessages(related, ["ordinary implementation"]).ok).toBe(true);
    const closes = parsePullRequestDisposition({ body: "Closes #80\nAcceptance: complete" });
    expect(validateCommitMessages(closes, ["Fixes #80"]).ok).toBe(true);
    expect(validateCommitMessages(closes, ["Fixes pixexid/bb-collab#80"]).ok).toBe(true);
    expect(validateCommitMessages(closes, ["Fixes: https://github.com/pixexid/bb-collab/issues/80"]).ok).toBe(true);
    expect(validateCommitMessages(closes, ["Fixes #81"]).ok).toBe(false);
    expect(validateCommitMessages(closes, ["Fixes pixexid/bb-collab#81"]).ok).toBe(false);
    expect(validateCommitMessages(related, null).ok).toBe(false);
  });

  it("uses one deterministic marker to make merge handling duplicate-safe", () => {
    const marker = lifecycleMarker(87, "issue-80", "related");
    expect(marker).toBe("<!-- bb-collab:issue-lifecycle:pr-87:issue-80:related -->");
    expect(hasLifecycleMarker([{ body: `status\n${marker}`, user: { login: "github-actions[bot]", type: "Bot" } }], marker)).toBe(true);
    expect(hasLifecycleMarker([{ body: `status\n${marker}`, user: { login: "attacker", type: "User" } }], marker)).toBe(false);
    expect(hasLifecycleMarker([{ body: "different status" }], marker)).toBe(false);
    expect(validateLifecycleComments([{ body: marker, user: { login: "github-actions[bot]", type: "Bot" } }]).ok).toBe(true);
    expect(validateLifecycleComments([{ body: marker }]).ok).toBe(false);
    expect(validateLifecycleComments([null]).ok).toBe(false);
  });

  it("plans related comments once and closes only a complete disposition", () => {
    const related = parsePullRequestDisposition({ body: "Related GH-80" });
    const planned = planMergedLifecycle({ pullRequestNumber: 91, parsed: related, issueState: "open" });
    expect(planned.actions).toMatchObject([{ kind: "comment", target: 80 }]);
    expect(planMergedLifecycle({ pullRequestNumber: 91, parsed: related, issueState: "open", issueComments: [{ body: planned.marker, user: { login: "github-actions[bot]", type: "Bot" } }] }).actions).toEqual([]);
    expect(planMergedLifecycle({ pullRequestNumber: 91, parsed: related, issueState: "open", issueComments: [{ body: planned.marker, user: { login: "attacker", type: "User" } }] }).actions).toMatchObject([{ kind: "comment", target: 80 }]);
    expect(() => planMergedLifecycle({ pullRequestNumber: 91, parsed: related, issueState: "closed" })).toThrow("requires an open issue");

    const closes = parsePullRequestDisposition({ body: "Closes #80\nAcceptance: complete" });
    expect(planMergedLifecycle({ pullRequestNumber: 92, parsed: closes, issueState: "open" }).actions.map(({ kind }) => kind)).toEqual(["close", "comment"]);
    expect(planMergedLifecycle({ pullRequestNumber: 92, parsed: closes, issueState: "closed" }).actions.map(({ kind }) => kind)).toEqual(["comment"]);
  });

  it("pins the write-token merge workflow to trusted default-branch code", () => {
    const workflow = readFileSync(".github/workflows/issue-lifecycle.yml", "utf8");
    expect(workflow).toContain("pull_request_target:");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("pr_number:");
    expect(workflow).toContain("ref: refs/heads/main");
    expect(workflow).not.toContain("github.event.pull_request.head.sha");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("issues: write");
    expect(workflow).toContain("pull-requests: write");
  });

  it("backfills one verified merged no-issue PR with one rationale comment", async () => {
    const calls: LifecycleCall[] = [];
    const result = await handleMergedPullRequestLifecycle({
      event: { inputs: { pr_number: 94 } },
      eventName: "workflow_dispatch",
      token: "test-token",
      repository: "pixexid/bb-collab",
      fetchImpl: fakeFetch({ calls }),
    });
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({ kind: "comment", target: 94 });
    expect(calls.filter(({ method }) => method === "POST")).toHaveLength(1);
    expect(String(calls.find(({ method }) => method === "POST")?.body)).toContain(result.marker);
  });

  it("does not re-post a deterministic marker during backfill", async () => {
    const marker = lifecycleMarker(94, "pr-94", "no-issue");
    const calls: LifecycleCall[] = [];
    const result = await handleMergedPullRequestLifecycle({
      event: { inputs: { pr_number: "94" } },
      eventName: "workflow_dispatch",
      token: "test-token",
      repository: "pixexid/bb-collab",
      fetchImpl: fakeFetch({ comments: [{ body: marker, user: { login: "github-actions[bot]", type: "Bot" } }], calls }),
    });
    expect(result.actions).toEqual([]);
    expect(calls.filter(({ method }) => method === "POST")).toEqual([]);
  });

  it("refuses unmerged, unknown, mismatched, ambiguous, and non-no-issue backfill targets", async () => {
    const cases = [
      { pullRequest: { ...noIssuePullRequest(), state: "open", merged_at: null } },
      { pullRequest: { ...noIssuePullRequest(), number: 95 } },
      { pullRequest: noIssuePullRequest(94, "No issue: one\nNo issue: two") },
      { pullRequest: noIssuePullRequest(94, "Related GH-80") },
    ];
    for (const options of cases) {
      const calls: LifecycleCall[] = [];
      await expect(handleMergedPullRequestLifecycle({
        event: { inputs: { pr_number: "94" } },
        eventName: "workflow_dispatch",
        token: "test-token",
        repository: "pixexid/bb-collab",
        fetchImpl: fakeFetch({ ...options, calls }),
      })).rejects.toThrow();
      expect(calls.filter(({ method }) => method === "POST")).toEqual([]);
    }
    await expect(handleMergedPullRequestLifecycle({
      event: { inputs: { pr_number: "94" } },
      eventName: "workflow_dispatch",
      token: "test-token",
      repository: "pixexid/bb-collab",
      fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }) as Response,
    })).rejects.toThrow("404");
    await expect(handleMergedPullRequestLifecycle({
      event: { inputs: { pr_number: "94" } },
      eventName: "workflow_dispatch",
      token: "test-token",
      repository: "pixexid/bb-collab",
      fetchImpl: fakeFetch({ postStatus: 403 }),
    })).rejects.toThrow("POST");
    await expect(handleMergedPullRequestLifecycle({
      event: { inputs: { pr_number: "94" } },
      eventName: "workflow_dispatch",
      token: "test-token",
      repository: "pixexid/bb-collab",
      fetchImpl: fakeFetch({ comments: { uncertain: true } }),
    })).rejects.toThrow("uncertain lifecycle comment collection");
  });

  it("keeps the merge-event parser fail-closed for a null body", async () => {
    await expect(handleMergedPullRequestLifecycle({
      event: { pull_request: { merged: true, number: 94, title: "", body: null } },
      eventName: "pull_request_target",
      token: "test-token",
      repository: "pixexid/bb-collab",
      fetchImpl: fakeFetch(),
    })).rejects.toThrow("Every pull request body must contain exactly one unambiguous disposition line");
  });
});
