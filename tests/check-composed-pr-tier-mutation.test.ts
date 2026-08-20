import { describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawnSync: () => ({ status: 0, stderr: "::warning::Tier declaration disagrees with required review level.", stdout: "Review tier C: local verify and CI only\n" }),
}));

describe("composed PR wrong-tier wording mutation", () => {
  it("rejects a reworded checker warning without matching its prose", async () => {
    const { validateComposedPullRequest } = await import("../scripts/check-composed-pr.mjs");
    const result = validateComposedPullRequest({
      title: "Improve awareness",
      body: "Related GH-402\n\nReview tier: C",
      files: ["src/foundation.ts"],
      commitMessages: ["Improve awareness"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Tier declaration disagrees");
  });
});
