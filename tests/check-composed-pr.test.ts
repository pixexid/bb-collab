import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateComposedPullRequest } from "../scripts/check-composed-pr.mjs";

const files = ["src/awareness.ts"];
const good = { title: "Improve awareness", body: "Related GH-402\n\nReview tier: B", files, commitMessages: ["Improve awareness"] };
const runRealCommitCli = (message: string) => {
  const directory = mkdtempSync(join(tmpdir(), "bb-collab-real-commit-"));
  const remote = mkdtempSync(join(tmpdir(), "bb-collab-real-remote-"));
  const run = (args: string[], input?: string | Buffer) => spawnSync("git", ["-C", directory, ...args], { encoding: "utf8", input });
  try {
    expect(run(["init"]).status).toBe(0);
    expect(run(["config", "user.email", "test@example.com"]).status).toBe(0);
    expect(run(["config", "user.name", "Test"]).status).toBe(0);
    expect(run(["commit", "--allow-empty", "-m", "base"]).status).toBe(0);
    expect(spawnSync("git", ["init", "--bare", remote], { encoding: "utf8" }).status).toBe(0);
    expect(run(["branch", "-M", "main"]).status).toBe(0);
    expect(run(["remote", "add", "origin", `file://${remote}`]).status).toBe(0);
    expect(run(["push", "-q", "origin", "main"]).status).toBe(0);
    expect(run(["fetch", "-q", "origin", "main"]).status).toBe(0);
    expect(run(["commit", "--allow-empty", "-m", message]).status).toBe(0);
    const bodyFile = join(directory, "event-body.md");
    writeFileSync(bodyFile, "Related GH-402\n\nReview tier: B\n");
    return spawnSync(process.execPath, [new URL("../scripts/check-composed-pr.mjs", import.meta.url).pathname,
      "--title", "Invisible evidence", "--body-file", bodyFile, "--file", "src/awareness.ts"], {
      cwd: directory, encoding: "utf8",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
};

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
    const result = runRealCommitCli("\u200b");
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("commit-message lifecycle violation");
  });

  it("rejects a real combining-grapheme-joiner commit through the CLI", () => {
    const result = runRealCommitCli("\u034f");
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("commit-message lifecycle violation");
  });

  it("refuses a real shallow clone before deriving incomplete evidence", () => {
    const source = mkdtempSync(join(tmpdir(), "bb-collab-shallow-source-"));
    const clone = mkdtempSync(join(tmpdir(), "bb-collab-shallow-clone-"));
    const run = (directory: string, args: string[], input?: string | Buffer) => spawnSync("git", ["-C", directory, ...args], { encoding: "utf8", input });
    try {
      expect(run(source, ["init"]).status).toBe(0);
      expect(run(source, ["config", "user.email", "test@example.com"]).status).toBe(0);
      expect(run(source, ["config", "user.name", "Test"]).status).toBe(0);
      expect(run(source, ["commit", "--allow-empty", "-m", "base"]).status).toBe(0);
      expect(run(source, ["branch", "-M", "main"]).status).toBe(0);
      expect(run(source, ["switch", "-c", "feature"]).status).toBe(0);
      expect(run(source, ["commit", "--allow-empty", "-m", "Fixes #411"]).status).toBe(0);
      expect(run(source, ["commit", "--allow-empty", "-m", "ordinary tip"]).status).toBe(0);
      expect(run(".", ["clone", "--depth", "1", "--branch", "feature", `file://${source}`, clone]).status).toBe(0);
      expect(run(clone, ["fetch", "--depth", "1", "origin", "main:refs/remotes/origin/main"]).status).toBe(0);
      expect(run(clone, ["rev-parse", "--is-shallow-repository"]).stdout.trim()).toBe("true");
      const bodyFile = join(clone, "event-body.md");
      writeFileSync(bodyFile, "Related GH-411\n\nReview tier: B\n");
      const result = spawnSync(process.execPath, [new URL("../scripts/check-composed-pr.mjs", import.meta.url).pathname,
        "--title", "Shallow evidence", "--body-file", bodyFile, "--file", "src/awareness.ts"], {
        cwd: clone, encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain("repository is shallow");
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(clone, { recursive: true, force: true });
    }
  });

  it("refuses a moved local origin/main tracking ref", () => {
    const directory = mkdtempSync(join(tmpdir(), "bb-collab-moved-base-"));
    const remote = mkdtempSync(join(tmpdir(), "bb-collab-moved-base-remote-"));
    const run = (args: string[], input?: string | Buffer) => spawnSync("git", ["-C", directory, ...args], { encoding: "utf8", input });
    try {
      expect(run(["init"]).status).toBe(0);
      expect(run(["config", "user.email", "test@example.com"]).status).toBe(0);
      expect(run(["config", "user.name", "Test"]).status).toBe(0);
      expect(run(["commit", "--allow-empty", "-m", "base"]).status).toBe(0);
      const base = run(["rev-parse", "HEAD"]).stdout.trim();
      expect(run(["branch", "-M", "main"]).status).toBe(0);
      expect(spawnSync("git", ["init", "--bare", remote], { encoding: "utf8" }).status).toBe(0);
      expect(run(["remote", "add", "origin", `file://${remote}`]).status).toBe(0);
      expect(run(["push", "-q", "origin", "main"]).status).toBe(0);
      expect(run(["switch", "-c", "feature"]).status).toBe(0);
      expect(run(["commit", "--allow-empty", "-m", "Fixes #411"]).status).toBe(0);
      expect(run(["commit", "--allow-empty", "-m", "ordinary tip"]).status).toBe(0);
      const forbidden = run(["rev-parse", "HEAD^"]).stdout.trim();
      expect(forbidden).not.toBe(base);
      expect(run(["update-ref", "refs/remotes/origin/main", forbidden]).status).toBe(0);
      const bodyFile = join(directory, "event-body.md");
      writeFileSync(bodyFile, "Related GH-411\n\nReview tier: B\n");
      const result = spawnSync(process.execPath, [new URL("../scripts/check-composed-pr.mjs", import.meta.url).pathname,
        "--title", "Moved baseline", "--body-file", bodyFile, "--file", "src/awareness.ts"], {
        cwd: directory, encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain("differs from remote main");
    } finally {
      rmSync(directory, { recursive: true, force: true });
      rmSync(remote, { recursive: true, force: true });
    }
  });

  it("refuses a remote that advertises main more than once", () => {
    const directory = mkdtempSync(join(tmpdir(), "bb-collab-duplicate-main-"));
    const helperDirectory = mkdtempSync(join(tmpdir(), "bb-collab-duplicate-main-helper-"));
    try {
      const run = (args: string[], input?: string | Buffer) => spawnSync("git", ["-C", directory, ...args], { encoding: "utf8", input });
      expect(run(["init"]).status).toBe(0);
      expect(run(["config", "user.email", "test@example.com"]).status).toBe(0);
      expect(run(["config", "user.name", "Test"]).status).toBe(0);
      expect(run(["commit", "--allow-empty", "-m", "base"]).status).toBe(0);
      expect(run(["branch", "-M", "main"]).status).toBe(0);
      expect(run(["switch", "-c", "feature"]).status).toBe(0);
      expect(run(["commit", "--allow-empty", "-m", "Fixes #411"]).status).toBe(0);
      const forbidden = run(["rev-parse", "HEAD"]).stdout.trim();
      expect(run(["commit", "--allow-empty", "-m", "ordinary tip"]).status).toBe(0);
      expect(run(["update-ref", "refs/remotes/origin/main", forbidden]).status).toBe(0);
      const helper = join(helperDirectory, "git-remote-duplicate");
      writeFileSync(helper, `#!/bin/sh
while IFS= read -r command; do
  case "$command" in
    capabilities) printf 'fetch\\n\\n' ;;
    option*) printf 'ok\\n' ;;
    list*) printf '${forbidden} refs/heads/main\\n${forbidden} refs/heads/main\\n\\n' ;;
  esac
done
      `, { mode: 0o755 });
      expect(run(["remote", "add", "origin", "duplicate::remote"]).status).toBe(0);
      const advertised = spawnSync("git", ["-C", directory, "ls-remote", "origin", "refs/heads/main"], {
        encoding: "utf8", env: { ...process.env, PATH: `${helperDirectory}:${process.env.PATH}` },
      });
      expect(advertised.status).toBe(0);
      expect(advertised.stdout.trim().split(/\r?\n/u)).toHaveLength(2);
      const bodyFile = join(directory, "event-body.md");
      writeFileSync(bodyFile, "Related GH-411\n\nReview tier: B\n");
      const result = spawnSync(process.execPath, [new URL("../scripts/check-composed-pr.mjs", import.meta.url).pathname,
        "--title", "Duplicate baseline", "--body-file", bodyFile, "--file", "src/awareness.ts"], {
        cwd: directory, encoding: "utf8", env: { ...process.env, PATH: `${helperDirectory}:${process.env.PATH}` },
      });
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain("remote origin/main is unavailable");
    } finally {
      rmSync(directory, { recursive: true, force: true });
      rmSync(helperDirectory, { recursive: true, force: true });
    }
  });

  it("rejects a real NUL-bearing commit when framing produces extra records", () => {
    const directory = mkdtempSync(join(tmpdir(), "bb-collab-nul-commit-"));
    let remote: string | undefined;
    const run = (args: string[], input?: string | Buffer) => spawnSync("git", ["-C", directory, ...args], { encoding: "utf8", input });
    try {
      expect(run(["init"]).status).toBe(0);
      expect(run(["config", "user.email", "test@example.com"]).status).toBe(0);
      expect(run(["config", "user.name", "Test"]).status).toBe(0);
      expect(run(["commit", "--allow-empty", "-m", "base"]).status).toBe(0);
      const base = run(["rev-parse", "HEAD"]).stdout.trim();
      const tree = run(["mktree"], "").stdout.trim();
      const rawCommit = `tree ${tree}\nparent ${base}\nauthor Test <test@example.com> 0 +0000\ncommitter Test <test@example.com> 0 +0000\n\nalpha\0beta\n`;
      const nulCommit = run(["hash-object", "--stdin", "-t", "commit", "--literally", "-w"], Buffer.from(rawCommit));
      expect(nulCommit.status).toBe(0);
      expect(run(["update-ref", "HEAD", nulCommit.stdout.trim()]).status).toBe(0);
      remote = mkdtempSync(join(tmpdir(), "bb-collab-nul-remote-"));
      expect(spawnSync("git", ["init", "--bare", remote], { encoding: "utf8" }).status).toBe(0);
      expect(run(["branch", "-M", "main"]).status).toBe(0);
      expect(run(["remote", "add", "origin", `file://${remote}`]).status).toBe(0);
      expect(run(["push", "-q", "origin", `${base}:refs/heads/main`]).status).toBe(0);
      expect(run(["fetch", "-q", "origin", "main"]).status).toBe(0);
      const bodyFile = join(directory, "event-body.md");
      writeFileSync(bodyFile, "Related GH-402\n\nReview tier: B\n");
      const result = spawnSync(process.execPath, [new URL("../scripts/check-composed-pr.mjs", import.meta.url).pathname,
        "--title", "NUL evidence", "--body-file", bodyFile, "--file", "src/awareness.ts"], {
        cwd: directory, encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain("contains a NUL character");
    } finally {
      rmSync(directory, { recursive: true, force: true });
      if (remote) rmSync(remote, { recursive: true, force: true });
    }
  });
});
