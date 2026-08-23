import { describe, expect, it } from "vitest";
import {
  GITHUB_ISSUE_COMMENT_TAIL_LIMIT,
  MAINTAINED_ISSUE_BODY_MARKER,
  assertGithubIssueBriefAnchor,
  assertGithubIssueBriefBinding,
  composeGithubIssueBrief,
  maintainedIssueBody,
  type GithubIssueBriefSource,
} from "../src/github-issue-brief.js";

const maintained = maintainedIssueBody({ lifecycleState: "in_progress", scope: "Current scope" });
const source = (overrides: Partial<GithubIssueBriefSource> = {}): GithubIssueBriefSource => ({
  projectId: "project-a",
  owner: "owner",
  repo: "repo",
  issueNumber: 613,
  title: "Bounded brief",
  body: maintained,
  state: "open",
  labels: ["queue:startable"],
  externalRevision: "revision-1",
  comments: [],
  commentsReadComplete: true,
  commentsCapped: false,
  ...overrides,
});

const comments = (count: number) => Array.from({ length: count }, (_, index) => ({
  id: String(index + 1), body: `comment-${index + 1}`, externalRevision: `comment-revision-${index + 1}`,
}));

describe("GitHub issue brief source", () => {
  it("copies the maintained body and only the bounded recent tail from a 40+ comment issue", () => {
    const recent = comments(40).slice(-GITHUB_ISSUE_COMMENT_TAIL_LIMIT);
    const brief = composeGithubIssueBrief(source({ comments: recent, commentsCapped: true }));
    expect(brief.comments).toHaveLength(GITHUB_ISSUE_COMMENT_TAIL_LIMIT);
    expect(brief.content).toContain("comment-40");
    expect(brief.content).not.toContain("comment-1");
    expect(brief.content.length).toBeLessThan(maintained.length + 8_000);
  });

  it("refuses incomplete pagination and an omitted operative history without a maintained body", () => {
    expect(() => composeGithubIssueBrief(source({ bodyCurrent: false }))).toThrow(/body is stale/iu);
    expect(() => composeGithubIssueBrief(source({ commentsReadComplete: false }))).toThrow(/pagination is incomplete/iu);
    expect(() => composeGithubIssueBrief(source({ body: "stale body", comments: comments(8), commentsCapped: true }))).toThrow(/omitted history/iu);
  });

  it("fails closed when body or tail movement invalidates the same-snapshot anchor", () => {
    const brief = composeGithubIssueBrief(source({ comments: comments(2) }));
    expect(() => assertGithubIssueBriefAnchor(brief, source({ body: `${maintained}\nchanged` , comments: comments(2) }))).toThrow(/moved/iu);
    expect(() => assertGithubIssueBriefAnchor(brief, source({ comments: comments(2).map((comment) => ({ ...comment, body: "moved" })) }))).toThrow(/moved/iu);
  });

  it("refuses foreign project and repository bindings", () => {
    const brief = composeGithubIssueBrief(source());
    expect(() => assertGithubIssueBriefBinding(brief, { projectId: "project-b", owner: "owner", repo: "repo", issueNumber: 613 })).toThrow(/foreign/iu);
    expect(() => assertGithubIssueBriefBinding(brief, { projectId: "project-a", owner: "other", repo: "repo", issueNumber: 613 })).toThrow(/foreign/iu);
  });

  it("keeps comments append-only while body transitions produce the maintained marker", () => {
    const tail = comments(2);
    const brief = composeGithubIssueBrief(source({ comments: tail }));
    expect(brief.comments).toEqual(tail);
    expect(maintained).toContain(MAINTAINED_ISSUE_BODY_MARKER);
  });
});
