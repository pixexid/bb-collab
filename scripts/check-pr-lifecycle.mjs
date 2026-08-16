import { readFileSync } from "node:fs";
import { parsePullRequestDisposition, validateCommitMessages, validateIssueTarget } from "./pr-lifecycle.mjs";

const eventPath = process.argv[2];
if (!eventPath) throw new Error("usage: check-pr-lifecycle.mjs <github-event-path>");

const event = JSON.parse(readFileSync(eventPath, "utf8"));
const pullRequest = event.pull_request ?? {};
const parsed = parsePullRequestDisposition({ title: pullRequest.title ?? "", body: pullRequest.body ?? "" });
if (!parsed.ok) {
  console.error(`::error::${parsed.error}`);
  process.exit(1);
}

const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";
if (!repository || !token || !pullRequest.number) {
  console.error("::error::GitHub lifecycle validation requires repository, PR number, and token; refusing uncertain linkage.");
  process.exit(1);
}
const request = async (path) => {
  const response = await fetch(`${apiUrl}/repos/${repository}${path}`, { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" } });
  if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
  return response.json();
};
const readAll = async (path) => {
  const values = [];
  for (let page = 1; ; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const batch = await request(`${path}${separator}per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error("GitHub returned an uncertain collection");
    values.push(...batch);
    if (batch.length < 100) return values;
  }
};
if (parsed.issueNumber !== null) {
  const checked = await validateIssueTarget(parsed, async (issueNumber) => request(`/issues/${issueNumber}`));
  if (!checked.ok) {
    console.error(`::error::${checked.error}`);
    process.exit(1);
  }
}
const commitCheck = validateCommitMessages(parsed, (await readAll(`/pulls/${pullRequest.number}/commits`)).map((commit) => commit?.commit?.message));
if (!commitCheck.ok) {
  console.error(`::error::${commitCheck.error}`);
  process.exit(1);
}

console.log(`Pull-request disposition: ${parsed.disposition}`);
