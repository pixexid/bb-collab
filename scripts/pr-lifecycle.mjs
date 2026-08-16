const dispositionPattern = /^\s*(Closes #[1-9]\d*|Related GH-[1-9]\d*|No issue:\s*\S.*)\s*$/iu;
const acceptancePattern = /^\s*Acceptance\s*:\s*(complete|incomplete|unknown)\s*$/iu;
const linkageCandidatePattern = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?|references?|related)\b[^\r\n]*(?:#|GH-)\S+/iu;

export function parsePullRequestDisposition({ title = "", body = "" }) {
  const lines = body.split(/\r?\n/u);
  const dispositions = lines.flatMap((line) => {
    const match = line.match(dispositionPattern);
    return match ? [match[1]] : [];
  });
  const acceptance = lines.flatMap((line) => {
    const match = line.match(acceptancePattern);
    return match ? [match[1].toLowerCase()] : [];
  });
  const invalidLinkage = lines.filter((line) => linkageCandidatePattern.test(line)
    && !/^\s*(?:Closes #[1-9]\d*|Related GH-[1-9]\d*)\s*$/iu.test(line));
  const invalidTitleReference = /\b(?:refs?|references?|fix(?:e[sd])?|resolve[sd]?)\b[^\r\n]*(?:#|GH-)\S+/iu.test(title);

  if (dispositions.length !== 1 || invalidLinkage.length > 0 || invalidTitleReference) {
    return { ok: false, error: "Every pull request body must contain exactly one unambiguous disposition line: `Closes #NN`, `Related GH-NN`, or `No issue: <rationale>`." };
  }
  if (acceptance.length > 1) return { ok: false, error: "Pull request body must contain at most one `Acceptance: complete|incomplete|unknown` line." };

  const disposition = dispositions[0];
  const closes = /^Closes #[1-9]\d*$/iu.test(disposition);
  const closeMentions = `${title}\n${body}`.match(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:#|GH-)[1-9]\d*\b/giu) ?? [];
  if (closeMentions.length && (!closes || acceptance[0] !== "complete")) {
    return { ok: false, error: "Close, fix, and resolve keywords require exactly `Closes #NN` plus `Acceptance: complete`; otherwise use `Related GH-NN`." };
  }
  if (acceptance[0] === "complete" && !closes) {
    return { ok: false, error: "`Acceptance: complete` requires the single disposition line to be `Closes #NN`." };
  }
  if (/^No issue:/iu.test(disposition) && /(?:#|GH-)[1-9]\d*\b/iu.test(disposition)) {
    return { ok: false, error: "`No issue: <rationale>` cannot name an issue target; use `Related GH-NN` or `Closes #NN`." };
  }

  const match = disposition.match(/^(?:Closes #|Related GH-)([1-9]\d*)$/iu);
  return {
    ok: true,
    kind: closes ? "closes" : disposition.toLowerCase().startsWith("related") ? "related" : "no-issue",
    issueNumber: match ? Number(match[1]) : null,
    acceptance: acceptance[0] ?? null,
    disposition,
  };
}

export async function validateIssueTarget(parsed, readIssue) {
  if (!parsed.ok || parsed.issueNumber === null) return parsed.ok ? { ok: true, issue: null } : parsed;
  try {
    const issue = await readIssue(parsed.issueNumber);
    if (!issue || issue.number !== parsed.issueNumber || issue.pull_request || !["open", "closed"].includes(issue.state)) {
      return { ok: false, error: `GitHub target #${parsed.issueNumber} is missing, not an issue, or has uncertain state.` };
    }
    return { ok: true, issue };
  } catch {
    return { ok: false, error: `GitHub target #${parsed.issueNumber} could not be verified; refusing closed-world inference.` };
  }
}

export const hasLifecycleMarker = (comments, marker) => comments.some((entry) => typeof entry.body === "string" && entry.body.includes(marker));
export const lifecycleMarker = (pullRequestNumber, target, kind) => `<!-- bb-collab:issue-lifecycle:pr-${pullRequestNumber}:${target}:${kind} -->`;

export function planMergedLifecycle({ pullRequestNumber, parsed, issueState, pullRequestComments = [], issueComments = [] }) {
  if (!parsed.ok) throw new Error(parsed.error);
  const target = parsed.issueNumber === null ? `pr-${pullRequestNumber}` : `issue-${parsed.issueNumber}`;
  const marker = lifecycleMarker(pullRequestNumber, target, parsed.kind);
  if (hasLifecycleMarker(pullRequestComments, marker)) return { marker, actions: [] };
  if (parsed.kind === "no-issue") {
    return { marker, actions: [{ kind: "comment", target: pullRequestNumber, body: `${marker}\nMerged PR #${pullRequestNumber}: no tracked issue applies. Rationale: ${parsed.disposition.slice("No issue:".length).trim()}` }] };
  }
  if (parsed.kind === "related" && hasLifecycleMarker(issueComments, marker)) return { marker, actions: [] };
  if (parsed.kind === "closes" && parsed.acceptance !== "complete") throw new Error("Closes disposition lacks Acceptance: complete; refusing auto-close");
  const actions = [];
  if (parsed.kind === "closes" && issueState === "open") actions.push({ kind: "close", target: parsed.issueNumber });
  actions.push({
    kind: "comment",
    target: parsed.kind === "related" ? parsed.issueNumber : pullRequestNumber,
    body: parsed.kind === "related"
      ? `${marker}\nMerged PR #${pullRequestNumber} is related work; the issue remains open pending its complete acceptance.`
      : `${marker}\nMerged PR #${pullRequestNumber} completed the declared acceptance for #${parsed.issueNumber}; the issue was closed.`,
  });
  return { marker, actions };
}
