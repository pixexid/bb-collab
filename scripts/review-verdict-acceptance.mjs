const PROFILE_FIELDS = ["providerId", "model", "reasoningLevel", "permissionMode", "serviceTier", "visibility"];

export const initialReviewAcceptanceState = {
  attempt: "initial",
  idleRetryUsed: false,
  replacementConsumed: false,
  qualifiedPassConsumed: false,
  blocked: false,
};

const sameProfile = (left, right) => PROFILE_FIELDS.every((field) => left?.[field] === right?.[field]);

const sameIdentity = (left, right) => left?.projectId === right?.projectId && left?.threadId === right?.threadId && left?.turnId === right?.turnId;

const refused = (reason, state) => ({ status: "refused", reason, qualifiedPassConsumed: false, state });

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
  if (state.blocked) return refused("review acceptance is blocked after the replacement failure", state);
  if (state.qualifiedPassConsumed) return refused("qualified review pass is already consumed", state);
  if (state.attempt === "replacement" && !state.replacementConsumed) return refused("replacement was not authorized by the initial failure", state);
  if (!sameIdentity(verdict, expected) || !sameIdentity(native, expected)) return refused("provisional review identity is not the exact project, thread, and turn", state);
  if (native.threadStatus !== "idle") return refused("reviewer thread is not natively idle", state);
  if (native.completion?.status !== "completed") return refused("exact reviewer turn has no successful native completion", state);
  if (native.completion.turnId !== expected.turnId || native.profile?.turnId !== expected.turnId) {
    return refused("native completion or profile readback is for a different turn", state);
  }
  if (native.profile.outcome !== "known" || !native.profile.executedProfile) return unknown({ ...input, state });
  if (!sameProfile(native.profile.executedProfile, requiredProfile)) return refused("native executed profile does not satisfy the frozen review requirement", state);
  if (!sameProfile(verdict.actualProfile, native.profile.executedProfile)) return refused("provisional actual-profile claim does not match native evidence", state);
  return {
    status: "accepted",
    verdict: verdict.verdict,
    executedProfile: native.profile.executedProfile,
    qualifiedPassConsumed: true,
    state: { ...state, qualifiedPassConsumed: true },
  };
}
