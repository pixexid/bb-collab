import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parsePullRequestDisposition, planMergedLifecycle, validateCommitMessages, validateIssueTarget, validateLifecycleComments } from "./pr-lifecycle.mjs";

export function parseBackfillPullRequestNumber(event) {
  const raw = event?.inputs?.pr_number;
  const number = typeof raw === "number" ? raw : typeof raw === "string" && /^[1-9]\d*$/u.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("workflow backfill requires exactly one positive pull-request number");
  return number;
}

export function validateBackfillPullRequest(pullRequest, expectedNumber) {
  if (!pullRequest || typeof pullRequest !== "object"
    || pullRequest.number !== expectedNumber
    || pullRequest.state !== "closed"
    || typeof pullRequest.merged_at !== "string"
    || Number.isNaN(Date.parse(pullRequest.merged_at))
    || typeof pullRequest.title !== "string"
    || typeof pullRequest.body !== "string") {
    throw new Error(`GitHub pull request #${expectedNumber} was not a single verifiable merged pull request; refusing lifecycle action`);
  }
  return pullRequest;
}

export async function handleMergedPullRequestLifecycle({ event, eventName, token, repository, apiUrl = "https://api.github.com", fetchImpl = fetch }) {
  const backfill = eventName === "workflow_dispatch";
  const eventPullRequest = event?.pull_request ?? {};
  if (!backfill && !eventPullRequest.merged) return { message: "Pull request was not merged; no lifecycle action.", actions: [] };

  const pullRequestNumber = backfill ? parseBackfillPullRequestNumber(event) : eventPullRequest.number;
  if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1) throw new Error("missing GitHub merge-event identity or token; refusing lifecycle action");
  if (!token || !repository) throw new Error("missing GitHub merge-event identity or token; refusing lifecycle action");
  const headers = { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "content-type": "application/json", "x-github-api-version": "2022-11-28" };
  const api = async (path, init = {}) => {
    const response = await fetchImpl(`${apiUrl}/repos/${repository}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
    if (!response.ok) throw new Error(`GitHub API ${init.method ?? "GET"} ${path} returned ${response.status}`);
    return response.status === 204 ? null : response.json();
  };
  const pullRequest = backfill
    ? validateBackfillPullRequest(await api(`/pulls/${pullRequestNumber}`), pullRequestNumber)
    : eventPullRequest;
  const comments = async (issueNumber) => {
    const values = [];
    for (let page = 1; ; page += 1) {
      const batch = await api(`/issues/${issueNumber}/comments?per_page=100&page=${page}`);
      if (!Array.isArray(batch)) throw new Error("GitHub returned an uncertain lifecycle comment collection");
      values.push(...batch);
      if (batch.length < 100) return values;
    }
  };
  const pullRequestCommits = async () => {
    const values = [];
    for (let page = 1; ; page += 1) {
      const batch = await api(`/pulls/${pullRequestNumber}/commits?per_page=100&page=${page}`);
      if (!Array.isArray(batch)) throw new Error("GitHub returned an uncertain commit collection");
      values.push(...batch);
      if (batch.length < 100) return values;
    }
  };
  const comment = async (issueNumber, body) => api(`/issues/${issueNumber}/comments`, { method: "POST", body: JSON.stringify({ body }) });

  const parsed = parsePullRequestDisposition({ title: pullRequest.title ?? "", body: pullRequest.body ?? "" });
  if (!parsed.ok) throw new Error(parsed.error);
  if (backfill && parsed.kind !== "no-issue") throw new Error("workflow backfill accepts only a merged no-issue pull request");
  const commitCheck = validateCommitMessages(parsed, (await pullRequestCommits()).map((commit) => commit?.commit?.message));
  if (!commitCheck.ok) throw new Error(commitCheck.error);
  const checked = await validateIssueTarget(parsed, (issueNumber) => api(`/issues/${issueNumber}`));
  if (!checked.ok) throw new Error(checked.error);
  const pullRequestComments = await comments(pullRequestNumber);
  const issueComments = parsed.kind === "related" ? await comments(parsed.issueNumber) : [];
  for (const evidence of [pullRequestComments, issueComments]) {
    const evidenceCheck = validateLifecycleComments(evidence);
    if (!evidenceCheck.ok) throw new Error(evidenceCheck.error);
  }

  const actions = planMergedLifecycle({
    pullRequestNumber,
    parsed,
    issueState: checked.issue?.state ?? null,
    pullRequestComments,
    issueComments,
  });
  for (const action of actions.actions) {
    if (action.kind === "close") await api(`/issues/${action.target}`, { method: "PATCH", body: JSON.stringify({ state: "closed" }) });
    else await comment(action.target, action.body);
  }
  return { message: actions.actions.length ? `Applied lifecycle disposition: ${parsed.disposition}` : `Lifecycle marker already present: ${actions.marker}`, actions: actions.actions, marker: actions.marker };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const eventPath = process.argv[2];
  if (!eventPath) throw new Error("usage: handle-merged-pr-lifecycle.mjs <github-event-path>");
  const event = JSON.parse(readFileSync(eventPath, "utf8"));
  const result = await handleMergedPullRequestLifecycle({
    event,
    eventName: process.env.GITHUB_EVENT_NAME,
    token: process.env.GITHUB_TOKEN,
    repository: process.env.GITHUB_REPOSITORY,
    apiUrl: process.env.GITHUB_API_URL,
  });
  console.log(result.message);
}
