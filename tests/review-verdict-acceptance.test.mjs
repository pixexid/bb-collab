import { describe, expect, it } from "vitest";
import { acceptProvisionalReview, initialReviewAcceptanceState } from "../scripts/review-verdict-acceptance.mjs";

const requestedProfile = (overrides = {}) => ({
  providerId: "codex",
  model: "gpt-5.6-sol",
  reasoningLevel: "medium",
  permissionMode: "full",
  serviceTier: "default",
  visibility: "visible",
  ...overrides,
});
const executedProfile = (overrides = {}) => ({ providerId: "codex", model: "gpt-5.6-sol", reasoningLevel: "medium", ...overrides });
const identity = {
  projectId: "project-a",
  threadId: "thread-reviewer",
  turnId: "turn-1",
  prNumber: 628,
  candidateHeadSha: "41ff55c86c96114754793c47db253902d9f69f53",
};
const verdict = (overrides = {}) => ({ ...identity, verdict: "REQUEST_CHANGES", actualProfile: executedProfile(), ...overrides });
const native = (overrides = {}) => ({
  ...identity,
  threadStatus: "idle",
  completion: { status: "completed", turnId: identity.turnId },
  profile: { outcome: "known", turnId: identity.turnId, executedProfile: executedProfile() },
  ...overrides,
});
const accept = (overrides = {}) => acceptProvisionalReview({
  expected: identity,
  requestedProfile: requestedProfile(),
  requiredProfile: requestedProfile(),
  verdict: verdict(),
  native: native(),
  state: initialReviewAcceptanceState,
  ...overrides,
});

describe("provisional review verdict acceptance", () => {
  it("refuses pre-completion and active-not-idle evidence without consuming a pass", () => {
    expect(accept({ native: native({ completion: null }) })).toMatchObject({ status: "refused", qualifiedPassConsumed: false });
    expect(accept({ native: native({ threadStatus: "active" }) })).toMatchObject({ status: "refused", qualifiedPassConsumed: false });
  });

  it("accepts the same exact known tuple naturally after completion and idle", () => {
    expect(accept()).toMatchObject({ status: "accepted", verdict: "REQUEST_CHANGES", qualifiedPassConsumed: true, executedProfile: executedProfile() });
    expect(accept().executedProfile).not.toHaveProperty("permissionMode");
    expect(accept().executedProfile).not.toHaveProperty("serviceTier");
    expect(accept().executedProfile).not.toHaveProperty("visibility");
  });

  it("does not substitute requested routing or a claimed profile for native evidence", () => {
    expect(accept({ native: native({ profile: { outcome: "unknown", turnId: identity.turnId } }) })).toMatchObject({ status: "retry", qualifiedPassConsumed: false });
    expect(accept({ verdict: verdict({ actualProfile: executedProfile({ model: "requested-only" }) }) })).toMatchObject({ status: "refused", qualifiedPassConsumed: false });
    expect(accept({ native: native({ profile: { ...native().profile, executedProfile: executedProfile({ model: "wrong-native" }) } }) })).toMatchObject({ status: "refused", qualifiedPassConsumed: false });
  });

  it("refuses foreign project, thread, and turn identities", () => {
    for (const field of ["projectId", "threadId", "turnId", "prNumber", "candidateHeadSha"]) {
      expect(accept({ verdict: verdict({ [field]: `foreign-${field}` }) })).toMatchObject({ status: "refused", qualifiedPassConsumed: false });
      expect(accept({ native: native({ [field]: `foreign-${field}` }) })).toMatchObject({ status: "refused", qualifiedPassConsumed: false });
    }
    expect(accept({ native: native({ completion: { status: "completed", turnId: "turn-2" } }) })).toMatchObject({ status: "refused", qualifiedPassConsumed: false });
  });

  it("forces one exact post-idle retry, rejects persistent UNKNOWN, and consumes the sole replacement", () => {
    const first = accept({ native: native({ profile: { outcome: "unknown", turnId: identity.turnId } }) });
    expect(first).toMatchObject({ status: "retry", action: "force-idle-and-reread-exact-turn" });
    const rejected = accept({
      native: native({ profile: { outcome: "unknown", turnId: identity.turnId } }),
      state: first.state,
    });
    expect(rejected).toMatchObject({ status: "rejected", action: "consume-sole-replacement", qualifiedPassConsumed: false, state: { attempt: "replacement", replacementConsumed: true } });
  });

  it("accepts a known replacement, but blocks after its second UNKNOWN", () => {
    const initial = accept({ native: native({ profile: { outcome: "unknown", turnId: identity.turnId } }) });
    const rejected = accept({
      native: native({ profile: { outcome: "unknown", turnId: identity.turnId } }),
      state: initial.state,
    });
    const retry = accept({
      native: native({ profile: { outcome: "unknown", turnId: identity.turnId } }),
      state: rejected.state,
    });
    expect(retry).toMatchObject({ status: "retry" });
    const blocked = accept({
      native: native({ profile: { outcome: "unknown", turnId: identity.turnId } }),
      state: retry.state,
    });
    expect(blocked).toMatchObject({ status: "blocked", action: "escalate-second-profile-failure", qualifiedPassConsumed: false });
    const knownReplacement = accept({
      native: native(),
      state: { ...rejected.state, idleRetryUsed: false },
    });
    expect(knownReplacement).toMatchObject({ status: "accepted", qualifiedPassConsumed: true });
  });

  it("rejects malformed verdicts and malformed or wrong candidate bindings before consuming a pass", () => {
    expect(accept({ verdict: verdict({ verdict: "PASS" }) })).toMatchObject({ status: "refused", qualifiedPassConsumed: false });
    expect(accept({ expected: { ...identity, candidateHeadSha: "not-a-sha" } })).toMatchObject({ status: "refused", qualifiedPassConsumed: false });
    expect(accept({ native: native({ candidateHeadSha: "0000000000000000000000000000000000000000" }) })).toMatchObject({ status: "refused", qualifiedPassConsumed: false });
  });

  it("blocks any replacement failure, including off-matrix native proof and claim mismatch", () => {
    const initial = accept({ native: native({ profile: { outcome: "unknown", turnId: identity.turnId } }) });
    const replacement = accept({
      native: native({ profile: { outcome: "unknown", turnId: identity.turnId } }),
      state: initial.state,
    });
    for (const overrides of [
      { native: native({ profile: { outcome: "known", turnId: identity.turnId, executedProfile: executedProfile({ model: "off-matrix" }) } }) },
      { verdict: verdict({ actualProfile: executedProfile({ model: "claimed-wrong" }) }) },
    ]) {
      expect(accept({ ...overrides, state: replacement.state })).toMatchObject({ status: "blocked", action: "escalate-replacement-failure", qualifiedPassConsumed: false, state: { blocked: true } });
    }
  });
});
