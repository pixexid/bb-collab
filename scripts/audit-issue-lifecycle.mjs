import { pathToFileURL } from "node:url";
import { parsePullRequestDisposition } from "./pr-lifecycle.mjs";

const emptyAudit = () => ({ openCompleted: [], openIncomplete: [], unknown: [], status: "pass" });

export function auditGitHubFacts({ issues, mergedPullRequests }) {
  const audit = emptyAudit();
  for (const issue of issues) {
    if (issue.state === "closed") continue;
    if (issue.state !== "open" || typeof issue.number !== "number") {
      audit.unknown.push(String(issue.number ?? "unknown"));
      continue;
    }
    const related = mergedPullRequests.filter((pullRequest) => {
      const parsed = parsePullRequestDisposition({ title: pullRequest.title ?? "", body: pullRequest.body ?? "" });
      return parsed.ok && parsed.issueNumber === issue.number;
    });
    const completed = related.some((pullRequest) => {
      const parsed = parsePullRequestDisposition({ title: pullRequest.title ?? "", body: pullRequest.body ?? "" });
      return parsed.ok && parsed.kind === "closes" && parsed.acceptance === "complete";
    });
    const body = typeof issue.body === "string" ? issue.body : "";
    const unchecked = body.match(/^\s*[-*]\s*\[\s\]\s+/gmu)?.length ?? 0;
    if (completed) audit.openCompleted.push(String(issue.number));
    else if (unchecked > 0) audit.openIncomplete.push(String(issue.number));
    else audit.unknown.push(String(issue.number));
  }
  audit.status = audit.openCompleted.length > 0 ? "fail" : audit.unknown.length > 0 ? "unknown" : "pass";
  return audit;
}

async function readJson(url, token) {
  const response = await fetch(url, { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" } });
  if (!response.ok) throw new Error(`GitHub API returned ${response.status} for ${url}`);
  return response.json();
}

async function readAll(url, token) {
  const values = [];
  for (let page = 1; ; page += 1) {
    const batch = await readJson(`${url}${url.includes("?") ? "&" : "?"}per_page=100&page=${page}`, token);
    if (!Array.isArray(batch)) throw new Error("GitHub API returned a non-array collection");
    values.push(...batch);
    if (batch.length < 100) return values;
  }
}

export async function collectGitHubAudit({ apiUrl, repository, token }) {
  if (!apiUrl || !repository || !token) throw new Error("missing GitHub API identity; refusing to infer lifecycle state");
  const issues = (await readAll(`${apiUrl}/repos/${repository}/issues?state=all`, token)).filter((issue) => !issue.pull_request);
  const pullRequests = (await readAll(`${apiUrl}/repos/${repository}/pulls?state=closed&sort=updated&direction=desc`, token)).filter((pullRequest) => pullRequest.merged_at !== null);
  return { issues, mergedPullRequests: pullRequests };
}

export async function main() {
  try {
    const facts = await collectGitHubAudit({ apiUrl: process.env.GITHUB_API_URL ?? "https://api.github.com", repository: process.env.GITHUB_REPOSITORY, token: process.env.GITHUB_TOKEN });
    const report = { source: "GitHub API read-only projection", generatedAt: new Date().toISOString(), issueAcceptanceAudit: auditGitHubFacts(facts) };
    console.log(JSON.stringify(report, null, 2));
    if (report.issueAcceptanceAudit.status === "fail") process.exitCode = 1;
  } catch (error) {
    console.log(JSON.stringify({ source: "GitHub API read-only projection", generatedAt: new Date().toISOString(), issueAcceptanceAudit: { openCompleted: [], openIncomplete: [], unknown: ["github-api-unavailable"], status: "unknown" }, error: error instanceof Error ? error.message : String(error) }, null, 2));
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
