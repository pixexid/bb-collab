import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = join(process.cwd(), "scripts/check-review-tier.mjs");

function check(body: string, files: string[]) {
  const directory = mkdtempSync(join(tmpdir(), "bb-collab-review-tier-"));
  const event = join(directory, "event.json");
  writeFileSync(event, JSON.stringify({ pull_request: { body } }));
  try {
    const result = spawnSync(process.execPath, [script, event], { input: `${files.join("\n")}\n`, encoding: "utf8" });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("pull-request review tier policy", () => {
  it("requires a declaration, derives risk, and encodes merge timing", () => {
    expect(check("Related GH-76", ["docs/operations-model.md"]).status).toBe(1);
    expect(check("Review tier: A\nReview tier: B", ["docs/operations-model.md"]).status).toBe(1);
    expect(check("<!-- Review tier: A -->", ["docs/operations-model.md"]).status).toBe(1);
    expect(check("```\nReview tier: A\n```", ["docs/operations-model.md"]).status).toBe(1);
    const tierC = check("Review tier: C", ["docs/issue-57-mechanism-1.md", "tests/review-policy.test.ts"]);
    expect(tierC.status).toBe(0);
    expect(tierC.stderr).not.toContain("Review finding");
    expect(tierC.stdout).toContain("local verify and CI only");
    const tierB = check("Review tier: B", ["src/awareness.ts"]);
    expect(tierB.status).toBe(0);
    expect(tierB.stderr).not.toContain("Review finding");
    expect(tierB.stdout).toContain("post-merge in parallel");
    for (const file of ["src/foundation.ts", "server.ts", "app.tsx", "dist/server.js", "plugins/example/dist/server.js", "scripts/build.mjs"]) {
      const tierA = check("Review tier: A", [file]);
      expect(tierA.status, file).toBe(0);
      expect(tierA.stderr, file).not.toContain("Review finding");
      expect(tierA.stdout, file).toContain("before merge");
    }
  });

  it("fails under-declarations, permits over-declarations, and prints the stricter rule", () => {
    const result = check("Review tier: C", ["src/foundation.ts"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("::error::Review finding");
    expect(result.stdout).toContain("Review tier A: cold exact-head review before merge");

    const overDeclared = check("Review tier: A", ["docs/issue-57-mechanism-1.md"]);
    expect(overDeclared.status).toBe(0);
    expect(overDeclared.stderr).toContain("::warning::Review finding: declared Tier A, but touched surfaces require Tier C.");
    expect(overDeclared.stdout).toContain("Review tier A: cold exact-head review before merge");
  });
});
