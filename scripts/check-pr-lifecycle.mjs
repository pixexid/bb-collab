import { readFileSync } from "node:fs";
import { parsePullRequestDisposition, validateIssueTarget } from "./pr-lifecycle.mjs";

const eventPath = process.argv[2];
if (!eventPath) throw new Error("usage: check-pr-lifecycle.mjs <github-event-path>");

const event = JSON.parse(readFileSync(eventPath, "utf8"));
const pullRequest = event.pull_request ?? {};
const parsed = parsePullRequestDisposition({ title: pullRequest.title ?? "", body: pullRequest.body ?? "" });
if (!parsed.ok) {
  console.error(`::error::${parsed.error}`);
  process.exit(1);
}

if (parsed.issueNumber !== null) {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";
  if (!repository || !token) {
    console.error("::error::GitHub target validation requires GITHUB_REPOSITORY and GITHUB_TOKEN; refusing uncertain linkage.");
    process.exit(1);
  }
  const checked = await validateIssueTarget(parsed, async (issueNumber) => {
    const response = await fetch(`${apiUrl}/repos/${repository}/issues/${issueNumber}`, { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" } });
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
    return response.json();
  });
  if (!checked.ok) {
    console.error(`::error::${checked.error}`);
    process.exit(1);
  }
}

console.log(`Pull-request disposition: ${parsed.disposition}`);
