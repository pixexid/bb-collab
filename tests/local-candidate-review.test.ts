import { describe, expect, it } from "vitest";
import { parseApplyRequest, sha256 } from "../src/foundation.js";

const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const profile = { providerId: "codex", model: "reviewer", reasoningLevel: "medium", permissionMode: "full", serviceTier: "default", visibility: "visible" as const };
const frozenBrief = "Review the exact local candidate.";
const base = {
  projectId: "project",
  operationClass: "work_item_transition" as const,
  idempotencyKey: "review",
  repoTargetId: "target",
  workItemId: "item",
  lifecycleState: "review_pending" as const,
  expectedResourceRevision: 1,
};

const localAttempt = {
  laneId: "lane",
  assignmentKind: "review" as const,
  requestedProfile: profile,
  candidateKind: "local" as const,
  reviewBaseSha: SHA_A,
  reviewCandidateSha: SHA_B,
  reviewCandidateEnvironment: { bbServerId: "server", environmentId: "environment", sourceId: "source", hostId: "host", path: "/repo", mode: "managed-worktree" as const },
  reviewCandidateCheckout: { branchName: "bb/candidate", headSha: SHA_B },
  reviewCandidateObservation: { clean: true as const, reachable: true as const },
  reviewRoleRequirementId: "reviewer-v1",
  reviewRoleId: "independent-reviewer" as const,
  reviewRoleGeneration: 2,
  reviewFrozenBriefVersion: 1 as const,
  reviewFrozenBriefContent: frozenBrief,
  reviewFrozenBriefDigest: sha256(frozenBrief),
  reviewReturnPath: { threadId: "thread-parent", statuses: ["DONE", "BLOCKED", "WAITING"] as ["DONE", "BLOCKED", "WAITING"] },
};

describe("explicit local review candidates", () => {
  it("accepts a complete frozen local candidate and keeps PR identity separate", () => {
    const parsed = parseApplyRequest({ ...base, workAttempt: localAttempt });
    expect(parsed.workAttempt?.candidateKind).toBe("local");
    expect(parsed.workAttempt?.reviewCandidateSha).toBe(SHA_B);
    expect(() => parseApplyRequest({ ...base, workAttempt: { ...localAttempt, candidateKind: "pull-request", reviewPrNumber: 644 } })).toThrow(/pull-request reviews cannot carry local candidate identity/u);
  });

  it.each([
    ["missing candidate kind", { ...localAttempt, candidateKind: undefined }],
    ["dirty observation", { ...localAttempt, reviewCandidateObservation: { clean: false, reachable: true } }],
    ["moving checkout", { ...localAttempt, reviewCandidateCheckout: { branchName: "bb/candidate", headSha: SHA_A } }],
    ["probe", { ...localAttempt, assignmentKind: "probe" }],
  ])("refuses %s before canonical review intent", (_, attempt) => {
    expect(() => parseApplyRequest({ ...base, workAttempt: attempt })).toThrow();
  });

  it("retains exact PR review semantics", () => {
    const parsed = parseApplyRequest({
      ...base,
      workAttempt: { laneId: "lane", assignmentKind: "review", requestedProfile: profile, candidateKind: "pull-request", reviewPrNumber: 644, reviewPrHeadSha: SHA_B },
    });
    expect(parsed.workAttempt).toMatchObject({ candidateKind: "pull-request", reviewPrNumber: 644, reviewPrHeadSha: SHA_B });
    expect(() => parseApplyRequest({
      ...base,
      workAttempt: { laneId: "lane", assignmentKind: "review", requestedProfile: profile, candidateKind: "pull-request", reviewPrNumber: 644 },
    })).toThrow(/pull-request reviews require an exact PR number and head SHA/u);
    expect(() => parseApplyRequest({
      ...base,
      workAttempt: { laneId: "lane", assignmentKind: "review", requestedProfile: profile, candidateKind: "pull-request", reviewPrNumber: 644, reviewPrHeadSha: SHA_B.padEnd(64, "b") },
    })).toThrow();
  });
});
