import { createHash } from "node:crypto";

export const GITHUB_ISSUE_COMMENT_TAIL_LIMIT = 8;
export const MAINTAINED_ISSUE_BODY_MARKER = "<!-- bb-collab:maintained-issue-body:v1 -->";

export type GithubIssueComment = {
  id: string;
  body: string;
  externalRevision: string;
};

export type GithubIssueBriefSource = {
  projectId: string;
  owner: string;
  repo: string;
  issueNumber: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: readonly string[];
  externalRevision: string;
  comments: readonly GithubIssueComment[];
  commentsReadComplete: boolean;
  commentsCapped: boolean;
  bodyCurrent: boolean;
  projection: GithubIssueBriefProjection;
};

export type GithubIssueBriefProjection = {
  projectionState: "pending" | "current" | "drifted" | "delivery_ambiguous";
  canonicalResourceRevision: number;
  attemptedResourceRevision: number;
  projectedResourceRevision: number | null;
  desiredDigest: string;
  observedExternalDigest: string | null;
  observedExternalRevision: string | null;
};

export type GithubIssueBriefAnchor = {
  projectId: string;
  owner: string;
  repo: string;
  issueNumber: number;
  bodyDigest: string;
  commentTailDigest: string;
  externalRevision: string;
  projectionState: GithubIssueBriefProjection["projectionState"];
  canonicalResourceRevision: number;
  attemptedResourceRevision: number;
  projectedResourceRevision: number | null;
  desiredDigest: string;
  observedExternalDigest: string | null;
  observedExternalRevision: string | null;
};

export type GithubIssueBrief = {
  content: string;
  comments: readonly GithubIssueComment[];
  anchor: GithubIssueBriefAnchor;
};

const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function exactIdentity(source: GithubIssueBriefSource): void {
  if (!source.projectId || !/^[A-Za-z0-9_.-]+$/u.test(source.owner) || !/^[A-Za-z0-9_.-]+$/u.test(source.repo)
    || !Number.isSafeInteger(source.issueNumber) || source.issueNumber < 1) {
    throw new Error("GitHub issue source identity is invalid");
  }
}

function hasMaintainedBody(body: string): boolean {
  const marker = body.indexOf(MAINTAINED_ISSUE_BODY_MARKER);
  return marker >= 0 && /^## Current state\s*$/mu.test(body.slice(marker + MAINTAINED_ISSUE_BODY_MARKER.length));
}

export function maintainedIssueBody(input: {
  lifecycleState: string;
  scope: string;
  blocker?: string | null;
  disposition?: string | null;
}): string {
  const lines = [
    MAINTAINED_ISSUE_BODY_MARKER,
    "## Current state",
    "",
    `- Lifecycle: ${input.lifecycleState}`,
    `- Blocker: ${input.blocker ?? "none"}`,
    `- Disposition: ${input.disposition ?? (input.lifecycleState === "succeeded" || input.lifecycleState === "failed" || input.lifecycleState === "cancelled" ? "closed" : "open")}`,
    "",
    "## Scope",
    "",
    input.scope,
  ];
  return lines.join("\n");
}

function anchorFor(source: GithubIssueBriefSource): GithubIssueBriefAnchor {
  return {
    projectId: source.projectId,
    owner: source.owner,
    repo: source.repo,
    issueNumber: source.issueNumber,
    bodyDigest: digest(source.body),
    commentTailDigest: digest(source.comments.map(({ id, body, externalRevision }) => ({ id, body, externalRevision }))),
    externalRevision: source.externalRevision,
    ...source.projection,
  };
}

export function composeGithubIssueBrief(source: GithubIssueBriefSource): GithubIssueBrief {
  exactIdentity(source);
  if (source.bodyCurrent !== true) throw new Error("GitHub issue body freshness is unavailable");
  if (source.projection.projectionState !== "current"
    || source.projection.canonicalResourceRevision !== source.projection.attemptedResourceRevision
    || source.projection.canonicalResourceRevision !== source.projection.projectedResourceRevision
    || source.projection.observedExternalDigest === null
    || source.projection.observedExternalRevision === null
    || source.projection.desiredDigest !== source.projection.observedExternalDigest
    || source.projection.desiredDigest.length === 0
    || source.projection.observedExternalRevision.length === 0) {
    throw new Error("GitHub issue projection is stale or mismatched for the canonical WorkItem");
  }
  if (!source.commentsReadComplete) throw new Error("GitHub issue comment pagination is incomplete");
  if (source.comments.length > GITHUB_ISSUE_COMMENT_TAIL_LIMIT) throw new Error("GitHub issue comment tail exceeds its bound");
  if (!hasMaintainedBody(source.body)) throw new Error("GitHub issue body is not a maintained current-state summary; omitted history may remain operative");
  const anchor = anchorFor(source);
  const tail = source.comments.length === 0
    ? "(no recent comments)"
    : source.comments.map((comment) => `### Comment ${comment.id}\n${comment.body}`).join("\n\n");
  return {
    content: `${source.body}\n\n## Recent comment tail\n\n${tail}`,
    comments: source.comments,
    anchor,
  };
}

export function assertGithubIssueBriefAnchor(brief: GithubIssueBrief, source: GithubIssueBriefSource): void {
  exactIdentity(source);
  const current = anchorFor(source);
  if (JSON.stringify(current) !== JSON.stringify(brief.anchor)) {
    throw new Error("GitHub issue body or comment tail moved after brief composition");
  }
}

export function assertGithubIssueBriefBinding(
  brief: GithubIssueBrief,
  expected: Pick<GithubIssueBriefAnchor, "projectId" | "owner" | "repo" | "issueNumber">,
): void {
  if (brief.anchor.projectId !== expected.projectId || brief.anchor.owner !== expected.owner
    || brief.anchor.repo !== expected.repo || brief.anchor.issueNumber !== expected.issueNumber) {
    throw new Error("GitHub issue brief is foreign to the requested project or repository");
  }
}
