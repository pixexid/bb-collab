import { describe, expect, it } from "vitest";
import { validateComposedPullRequest } from "../scripts/check-composed-pr.mjs";

const files = ["src/awareness.ts"];
const good = { title: "Improve awareness", body: "Related GH-402\n\nReview tier: B", files };

describe("composed PR pre-push check", () => {
  it("rejects the four issue failures and accepts a known-good PR", () => {
    const cases = [
      ["#390 missing tier", { title: "Document lifecycle", body: "Related GH-390", files }, "review tier"],
      ["#397 title linkage", { title: "Fix GH-397", body: "Related GH-397\n\nReview tier: B", files }, "title/body lifecycle disposition"],
      ["#401 incomplete close", { title: "Complete GH-401", body: "Closes #401\n\nReview tier: B", files }, "Acceptance: complete"],
      ["#385 missing tier", { title: "Document queue", body: "Related GH-385", files }, "review tier"],
    ] as const;
    for (const [name, input, message] of cases) {
      const result = validateComposedPullRequest(input);
      expect(result.ok, name).toBe(false);
      if (result.ok) continue;
      expect(result.error, name).toContain(message);
      if (name === "#397 title linkage") {
        expect(result.error).toContain("gh run rerun");
        expect(result.error).toContain("gh pr checks");
      }
    }
    expect(validateComposedPullRequest(good)).toMatchObject({ ok: true, reviewTier: "B" });
  });
});
