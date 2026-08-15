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
    expect(check("Related GH-76", ["docs/roadmap.md"]).status).toBe(1);
    expect(check("Review tier: A\nReview tier: B", ["docs/roadmap.md"]).status).toBe(1);
    expect(check("Review tier: C", ["docs/roadmap.md", "tests/review-policy.test.ts"]).stdout).toContain("local verify and CI only");
    expect(check("Review tier: B", ["src/awareness.ts"]).stdout).toContain("post-merge in parallel");
    expect(check("Review tier: A", ["src/foundation.ts"]).stdout).toContain("before merge");
  });

  it("keeps wrong-tiering visible as a review finding without changing merge policy", () => {
    const result = check("Review tier: C", ["src/foundation.ts"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("Review finding");
  });
});
