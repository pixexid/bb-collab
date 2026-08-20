import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateComposedPullRequest } from "../scripts/check-composed-pr.mjs";

const files = ["src/awareness.ts"];
const good = { title: "Improve awareness", body: "Related GH-402\n\nReview tier: B", files, commitMessages: ["Improve awareness"] };

describe("composed PR pre-push check", () => {
  it("rejects the four issue failures and accepts a known-good PR", () => {
    const cases = [
      ["#390 missing tier", { title: "Document lifecycle", body: "Related GH-390", files, commitMessages: ["Document lifecycle"] }, "review tier"],
      ["#397 title linkage", { title: "Fix GH-397", body: "Related GH-397\n\nReview tier: B", files, commitMessages: ["Fix GH-397"] }, "title/body lifecycle disposition"],
      ["#401 incomplete close", { title: "Complete GH-401", body: "Closes #401\n\nReview tier: B", files, commitMessages: ["Complete GH-401"] }, "Acceptance: complete"],
      ["#385 missing tier", { title: "Document queue", body: "Related GH-385", files, commitMessages: ["Document queue"] }, "review tier"],
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

  it.each([
    ["blank title", { ...good, title: "" }, "title"],
    ["missing changed path", { ...good, files: [undefined as unknown as string] }, "changed files"],
    ["blank changed path", { ...good, files: [""] }, "changed files"],
    ["missing commit messages", { ...good, commitMessages: undefined as unknown as string[] }, "commit-message"],
  ])("rejects %s before invoking the review-tier gate", (_name, input, message) => {
    const result = validateComposedPullRequest(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(message);
  });

  it("rejects a commit message that CI lifecycle validation rejects", () => {
    const result = validateComposedPullRequest({
      ...good,
      commitMessages: ["docs: Related GH-402"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("commit-message lifecycle violation");
    expect(result.error).toContain("conflicts with the PR disposition");
  });

  it.each(["", "   ", "\t"]) ("rejects a blank commit message: %j", (commitMessage) => {
    const result = validateComposedPullRequest({ ...good, commitMessages: [commitMessage] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("commit-message lifecycle violation");
  });

  it("rejects a real zero-width-space commit through the CLI", () => {
    const directory = mkdtempSync(join(tmpdir(), "bb-collab-zero-width-"));
    const run = (args: string[]) => spawnSync("git", ["-C", directory, ...args], { encoding: "utf8" });
    try {
      expect(run(["init"]).status).toBe(0);
      expect(run(["config", "user.email", "test@example.com"]).status).toBe(0);
      expect(run(["config", "user.name", "Test"]).status).toBe(0);
      expect(run(["commit", "--allow-empty", "-m", "base"]).status).toBe(0);
      expect(run(["update-ref", "refs/remotes/origin/main", "HEAD"]).status).toBe(0);
      expect(run(["commit", "--allow-empty", "-m", "\u200b"]).status).toBe(0);
      const bodyFile = join(directory, "event-body.md");
      writeFileSync(bodyFile, "Related GH-402\n\nReview tier: B\n");
      const result = spawnSync(process.execPath, [new URL("../scripts/check-composed-pr.mjs", import.meta.url).pathname,
        "--title", "Zero-width evidence", "--body-file", bodyFile, "--file", "src/awareness.ts"], {
        cwd: directory, encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain("commit-message lifecycle violation");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
