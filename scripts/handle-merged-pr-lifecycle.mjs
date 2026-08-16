import { readFileSync } from "node:fs";
import { parsePullRequestDisposition, planMergedLifecycle, validateCommitMessages, validateIssueTarget, validateLifecycleComments } from "./pr-lifecycle.mjs";

const eventPath = process.argv[2];
if (!eventPath) throw new Error("usage: handle-merged-pr-lifecycle.mjs <github-event-path>");
const event = JSON.parse(readFileSync(eventPath, "utf8"));
const pullRequest = event.pull_request ?? {};
if (!pullRequest.merged) {
  console.log("Pull request was not merged; no lifecycle action.");
  process.exit(0);
}

const token = process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;
const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";
if (!token || !repository || !pullRequest.number) throw new Error("missing GitHub merge-event identity or token; refusing lifecycle action");
const headers = { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "content-type": "application/json", "x-github-api-version": "2022-11-28" };
const api = async (path, init = {}) => {
  const response = await fetch(`${apiUrl}/repos/${repository}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  if (!response.ok) throw new Error(`GitHub API ${init.method ?? "GET"} ${path} returned ${response.status}`);
  return response.status === 204 ? null : response.json();
};
const comments = async (issueNumber) => {
  const values = [];
  for (let page = 1; ; page += 1) {
    const batch = await api(`/issues/${issueNumber}/comments?per_page=100&page=${page}`);
    values.push(...batch);
    if (batch.length < 100) return values;
  }
};
const pullRequestCommits = async () => {
  const values = [];
  for (let page = 1; ; page += 1) {
    const batch = await api(`/pulls/${pullRequest.number}/commits?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error("GitHub returned an uncertain commit collection");
    values.push(...batch);
    if (batch.length < 100) return values;
  }
};
const comment = async (issueNumber, body) => api(`/issues/${issueNumber}/comments`, { method: "POST", body: JSON.stringify({ body }) });

const parsed = parsePullRequestDisposition({ title: pullRequest.title ?? "", body: pullRequest.body ?? "" });
if (!parsed.ok) throw new Error(parsed.error);
const commitCheck = validateCommitMessages(parsed, (await pullRequestCommits()).map((commit) => commit?.commit?.message));
if (!commitCheck.ok) throw new Error(commitCheck.error);
const checked = await validateIssueTarget(parsed, (issueNumber) => api(`/issues/${issueNumber}`));
if (!checked.ok) throw new Error(checked.error);
const pullRequestComments = await comments(pullRequest.number);
const issueComments = parsed.kind === "related" ? await comments(parsed.issueNumber) : [];
for (const evidence of [pullRequestComments, issueComments]) {
  const evidenceCheck = validateLifecycleComments(evidence);
  if (!evidenceCheck.ok) throw new Error(evidenceCheck.error);
}

const actions = planMergedLifecycle({
  pullRequestNumber: pullRequest.number,
  parsed,
  issueState: checked.issue?.state ?? null,
  pullRequestComments,
  issueComments,
});
for (const action of actions.actions) {
  if (action.kind === "close") await api(`/issues/${action.target}`, { method: "PATCH", body: JSON.stringify({ state: "closed" }) });
  else await comment(action.target, action.body);
}

console.log(actions.actions.length ? `Applied lifecycle disposition: ${parsed.disposition}` : `Lifecycle marker already present: ${actions.marker}`);
