const dispositionPattern = /^\s*(Closes #[1-9]\d*|Related GH-[1-9]\d*|No issue:\s*\S.*)\s*$/iu;
const acceptancePattern = /^\s*Acceptance\s*:\s*(complete|incomplete|unknown)\s*$/iu;
const linkageCandidatePattern = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?|references?|related)\b[^\r\n]*(?:#|GH-)\S+/iu;
const linkageMentionPattern = /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?|references?|related)\s+(?:#|GH-)([1-9]\d*)\b/giu;

function visibleMarkdown(text) {
  const withoutComments = text.replace(/<!--[\s\S]*?(?:-->|$)/gu, "");
  let inFence = false;
  let fenceCharacter = "";
  let fenceLength = 0;
  return withoutComments.split(/\r?\n/u).filter((line) => {
    const opening = line.match(/^\s*(`{3,}|~{3,})/u);
    if (!inFence && opening) {
      inFence = true;
      fenceCharacter = opening[1][0];
      fenceLength = opening[1].length;
      return false;
    }
    if (inFence) {
      const closing = new RegExp(`^\\s*${fenceCharacter}{${fenceLength},}\\s*$`, "u").test(line);
      if (closing) inFence = false;
      return false;
    }
    return true;
  }).join("\n");
}

export function parsePullRequestDisposition({ title = "", body = "" }) {
  const visibleTitle = visibleMarkdown(title);
  const visibleBody = visibleMarkdown(body);
  const lines = visibleBody.split(/\r?\n/u);
  const dispositions = lines.flatMap((line) => {
    const match = line.match(dispositionPattern);
    return match ? [match[1]] : [];
  });
  const acceptance = lines.flatMap((line) => {
    const match = line.match(acceptancePattern);
    return match ? [match[1].toLowerCase()] : [];
  });
  const invalidLinkage = `${visibleTitle}\n${visibleBody}`.split(/\r?\n/u).filter((line) => linkageCandidatePattern.test(line)
    && !/^\s*(?:Closes #[1-9]\d*|Related GH-[1-9]\d*)\s*$/iu.test(line));

  if (dispositions.length !== 1 || invalidLinkage.length > 0) {
    return { ok: false, error: "Every pull request body must contain exactly one unambiguous disposition line: `Closes #NN`, `Related GH-NN`, or `No issue: <rationale>`." };
  }
  if (acceptance.length > 1) return { ok: false, error: "Pull request body must contain at most one `Acceptance: complete|incomplete|unknown` line." };

  const disposition = dispositions[0];
  const closes = /^Closes #[1-9]\d*$/iu.test(disposition);
  const text = `${visibleTitle}\n${visibleBody}`;
  const linkageMentions = [...text.matchAll(linkageMentionPattern)].map((match) => {
    const index = match.index ?? 0;
    const lineStart = text.lastIndexOf("\n", index) + 1;
    const lineEnd = text.indexOf("\n", index);
    return {
      kind: match[1].toLowerCase(),
      target: Number(match[2]),
      line: text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd).trim(),
    };
  });
  const relatedMentions = linkageMentions.filter(({ kind }) => kind === "related");
  const closeLikeMentions = linkageMentions.filter(({ kind }) => kind !== "related");
  const target = Number(disposition.match(/[1-9]\d*$/u)?.[0]);
  if (closes && (closeLikeMentions.length !== 1
    || closeLikeMentions.some(({ kind, target: mentionedTarget, line }) => kind !== "closes"
      || mentionedTarget !== target
      || line !== disposition.trim())
    || relatedMentions.length > 0)) {
    return { ok: false, error: "Closes, fix, resolve, and reference linkage must contain exactly one matching target in the disposition line." };
  }
  if (closes && acceptance[0] !== "complete") {
    return { ok: false, error: "Close, fix, and resolve keywords require exactly `Closes #NN` plus `Acceptance: complete`; otherwise use `Related GH-NN`." };
  }
  if (!closes && closeLikeMentions.length > 0) {
    return { ok: false, error: "Close, fix, and resolve keywords require exactly `Closes #NN` plus `Acceptance: complete`; otherwise use `Related GH-NN`." };
  }
  if (!closes && /^Related GH-/iu.test(disposition)
    && (relatedMentions.length === 0 || relatedMentions.some(({ target: mentionedTarget }) => mentionedTarget !== target))) {
    return { ok: false, error: "Every Related GH-NN linkage must name the single disposition target." };
  }
  if (!closes && /^No issue:/iu.test(disposition) && relatedMentions.length > 0) {
    return { ok: false, error: "No-issue dispositions cannot include an issue linkage." };
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

const trustedLifecycleComment = (entry) => entry?.user?.login === "github-actions[bot]" && entry.user.type === "Bot";
export const hasLifecycleMarker = (comments, marker) => comments.some((entry) => trustedLifecycleComment(entry)
  && typeof entry.body === "string" && entry.body.includes(marker));
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
  if (parsed.kind === "related" && issueState !== "open") throw new Error("Related disposition requires an open issue; refusing contradictory GitHub state");
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
