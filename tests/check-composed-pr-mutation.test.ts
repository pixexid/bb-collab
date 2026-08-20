import { describe, expect, it, vi } from "vitest";

vi.mock("../scripts/pr-lifecycle.mjs", () => ({
  parsePullRequestDisposition: () => ({ ok: false, error: "mutated gate predicate" }),
}));

describe("composed PR gate linkage mutation", () => {
  it("rejects the known-good PR when the imported gate predicate rejects it", async () => {
    const { validateComposedPullRequest } = await import("../scripts/check-composed-pr.mjs");
    const result = validateComposedPullRequest({
      title: "Improve awareness",
      body: "Related GH-402\n\nReview tier: B",
      files: ["src/awareness.ts"],
      commitMessages: ["Improve awareness"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("mutated gate predicate");
  });
});
