const PROFILE_FIELDS = ["providerId", "model", "reasoningLevel"];
const REVIEW_VERDICTS = new Set(["APPROVE", "REQUEST_CHANGES"]);

export const initialReviewAcceptanceState = {
  attempt: "initial",
  idleRetryUsed: false,
  replacementConsumed: false,
  qualifiedPassConsumed: false,
  blocked: false,
};

const sameProfile = (left, right) => PROFILE_FIELDS.every((field) => left?.[field] === right?.[field]);

const sameIdentity = (left, right) => ["projectId", "threadId", "turnId", "prNumber", "candidateHeadSha"].every((field) => left?.[field] === right?.[field]);

const validIdentity = (value) =>
  value &&
  ["projectId", "threadId", "turnId"].every((field) => typeof value[field] === "string" && value[field].length > 0) &&
  Number.isSafeInteger(value.prNumber) &&
  value.prNumber > 0 &&
  typeof value.candidateHeadSha === "string" &&
  /^[0-9a-f]{40}$/u.test(value.candidateHeadSha);

const failed = (reason, state) =>
  state.attempt === "replacement" && state.replacementConsumed
    ? { status: "blocked", action: "escalate-replacement-failure", reason, qualifiedPassConsumed: false, state: { ...state, blocked: true } }
    : { status: "refused", reason, qualifiedPassConsumed: false, state };

const unknown = (input) => {
  if (!input.state.idleRetryUsed) {
    return {
      status: "retry",
      action: "force-idle-and-reread-exact-turn",
      qualifiedPassConsumed: false,
      state: { ...input.state, idleRetryUsed: true },
    };
  }
  if (input.state.attempt === "initial") {
    return {
      status: "rejected",
      action: "consume-sole-replacement",
      reason: "executed profile remains UNKNOWN after the exact post-idle retry",
      qualifiedPassConsumed: false,
      state: { ...input.state, attempt: "replacement", idleRetryUsed: false, replacementConsumed: true },
    };
  }
  return {
    status: "blocked",
    action: "escalate-second-profile-failure",
    reason: "replacement executed profile remains UNKNOWN after the exact post-idle retry",
    qualifiedPassConsumed: false,
    state: { ...input.state, blocked: true },
  };
};

/**
 * Accepts only a provisional review whose native evidence is exact, completed,
 * idle, and known. Requested routing and the reviewer's claim are provenance;
 * neither can satisfy this gate.
 */
export function acceptProvisionalReview(input) {
  const { expected, requiredProfile, verdict, native, state = initialReviewAcceptanceState } = input;
  if (state.blocked) return failed("review acceptance is blocked after the replacement failure", state);
  if (state.qualifiedPassConsumed) return failed("qualified review pass is already consumed", state);
  if (state.attempt === "replacement" && !state.replacementConsumed) return failed("replacement was not authorized by the initial failure", state);
  if (!validIdentity(expected) || !validIdentity(verdict) || !validIdentity(native)) return failed("review acceptance identity is malformed", state);
  if (!REVIEW_VERDICTS.has(verdict.verdict)) return failed("provisional verdict enum is invalid", state);
  if (!sameIdentity(verdict, expected) || !sameIdentity(native, expected)) return failed("provisional review identity is not the exact project, thread, turn, PR, and candidate head", state);
  if (native.threadStatus !== "idle") return failed("reviewer thread is not natively idle", state);
  if (native.completion?.status !== "completed") return failed("exact reviewer turn has no successful native completion", state);
  if (native.completion.turnId !== expected.turnId || native.profile?.turnId !== expected.turnId) {
    return failed("native completion or profile readback is for a different turn", state);
  }
  if (native.profile?.outcome === "unknown") return unknown({ ...input, state });
  if (native.profile?.outcome !== "known" || !native.profile.executedProfile) return failed("native executed profile readback is malformed", state);
  if (!sameProfile(native.profile.executedProfile, requiredProfile)) return failed("native executed profile does not satisfy the frozen review requirement", state);
  if (!sameProfile(verdict.actualProfile, native.profile.executedProfile)) return failed("provisional actual-profile claim does not match native evidence", state);
  return {
    status: "accepted",
    verdict: verdict.verdict,
    executedProfile: native.profile.executedProfile,
    qualifiedPassConsumed: true,
    state: { ...state, qualifiedPassConsumed: true },
  };
}
