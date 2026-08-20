import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePullRequestDisposition, validateCommitMessages } from "./pr-lifecycle.mjs";

const hostGotchas = "`gh run rerun` replays the original event payload, so only a new edited/synchronize/reopened event evaluates current content; `gh pr checks` shows the stale failed run until the new one completes.";

export function validateComposedPullRequest({ title, body, files, commitMessages }) {
  if (typeof title !== "string" || title.trim() === "") return { ok: false, error: "title is required and must not be blank" };
  if (typeof body !== "string") return { ok: false, error: "body is required" };
  if (!Array.isArray(files) || files.length === 0 || files.some((file) => typeof file !== "string" || file.trim() === "")) {
    return { ok: false, error: "changed files are required and each path must be a non-blank string" };
  }

  const parsed = parsePullRequestDisposition({ title, body });
  if (!parsed.ok) {
    return { ok: false, error: `title/body lifecycle disposition violation (the title is checked too; linkage verbs paired with #NN count): ${parsed.error}\n${hostGotchas}` };
  }
  const commitCheck = validateCommitMessages(parsed, commitMessages);
  if (!commitCheck.ok) return { ok: false, error: `commit-message lifecycle violation: ${commitCheck.error}\n${hostGotchas}` };

  const directory = mkdtempSync(join(tmpdir(), "bb-collab-composed-pr-"));
  const event = join(directory, "event.json");
  writeFileSync(event, JSON.stringify({ pull_request: { body } }));
  try {
    const result = spawnSync(process.execPath, [new URL("./check-review-tier.mjs", import.meta.url).pathname, event], {
      input: `${files.join("\n")}\n`, encoding: "utf8",
    });
    // check-review-tier signals wrong-tier declarations on stderr while retaining exit 0; the channel is the protocol, not its wording.
    if (result.status !== 0 || result.stderr.trim() !== "") {
      return { ok: false, error: `review tier violation: ${(result.stderr || result.stdout).trim()}\n${hostGotchas}` };
    }
    return { ok: true, disposition: parsed.disposition, reviewTier: result.stdout.match(/^Review tier ([ABC]):/mu)?.[1] ?? null };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function usage() {
  throw new Error("usage: check-composed-pr.mjs --title <title> (--body <body> | --body-file <path>) --file <changed-path> [...]");
}

function deriveCommitMessages() {
  // ponytail: main-targeting and network-required; offline cannot prove the push baseline, so add validated remote-base discovery if that changes.
  // ponytail: this is a fast LOCAL check against honest error and misconfiguration.
  // Its authority ends at the local environment — every guard here is enforced by code
  // a hostile caller could edit. Enforcement is CI's GitHub-sourced commit list
  // (scripts/check-pr-lifecycle.mjs:44, /pulls/<n>/commits), which is outside the caller's control.
  const remote = spawnSync("git", ["ls-remote", "origin", "refs/heads/main"], { encoding: "utf8" });
  const remoteLines = remote.stdout.split(/\r?\n/u);
  if (remoteLines.at(-1) === "") remoteLines.pop();
  const remoteMatch = remoteLines.length === 1 ? remoteLines[0].match(/^([0-9a-f]{40})\s+refs\/heads\/main$/u) : null;
  if (remote.status !== 0 || remote.error || !remoteMatch) throw new Error("cannot verify baseline: remote origin/main is unavailable");
  const remoteSha = remoteMatch[1];
  const local = spawnSync("git", ["rev-parse", "--verify", "refs/remotes/origin/main"], { encoding: "utf8" });
  const localSha = local.stdout.trim();
  if (local.status !== 0 || local.error || !/^[0-9a-f]{40}$/u.test(localSha)) throw new Error("cannot verify baseline: local origin/main is unavailable");
  if (remoteSha !== localSha) throw new Error("cannot verify baseline: local origin/main differs from remote main");
  const shallow = spawnSync("git", ["rev-parse", "--is-shallow-repository"], { encoding: "utf8" });
  if (shallow.status !== 0 || shallow.error || shallow.stdout.trim() === "true") throw new Error("cannot verify commit range: repository is shallow");
  const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", "origin/main", "HEAD"], { encoding: "utf8" });
  if (ancestry.status !== 0 || ancestry.error) throw new Error("cannot verify commit range: origin/main ancestry is unproven");
  const count = spawnSync("git", ["rev-list", "--count", "origin/main..HEAD"], { encoding: "utf8" });
  if (count.status !== 0 || count.error || !/^\d+\n?$/u.test(count.stdout)) throw new Error("cannot verify commit range: commit count is unavailable");
  const expectedCount = Number(count.stdout.trim());
  const commits = spawnSync("git", ["rev-list", "origin/main..HEAD"], { encoding: "utf8" });
  if (commits.status !== 0 || commits.error) throw new Error("cannot verify commit range: commit identities are unavailable");
  for (const commit of commits.stdout.trim().split(/\r?\n/u).filter(Boolean)) {
    const object = spawnSync("git", ["cat-file", "commit", commit], { encoding: "utf8" });
    if (object.status !== 0 || object.error) throw new Error(`cannot verify commit range: commit ${commit} is unreadable`);
    if (object.stdout.includes("\0")) throw new Error(`commit evidence is untrustworthy: commit ${commit} contains a NUL character`);
  }
  const result = spawnSync("git", ["log", "origin/main..HEAD", "--format=%B%x00"], { encoding: "utf8" });
  if (result.status !== 0 || result.error) throw new Error("could not derive commit messages from origin/main..HEAD");
  if (result.stdout === "") throw new Error("no commit messages found in origin/main..HEAD");
  const messages = result.stdout.split("\0").map((message, index) => index === 0 ? message : message.replace(/^\r?\n/u, ""));
  if (messages.at(-1) === "") messages.pop();
  // ponytail: defence-in-depth invariant, no known trigger. Not reached by a shallow clone
  // (the shallow check rejects first), a NUL-bearing commit (git truncates %B at the NUL, so the count
  // agrees), a blob-filtered clone, an empty commit message, a newline-only body, a merge
  // commit, or a git-replace graph. If this ever fires, records != rev-list means the derivation
  // saw a different population than the push — that is a new class, not a bug in this check.
  if (messages.length !== expectedCount) {
    const direction = messages.length > expectedCount ? "more" : "fewer";
    throw new Error(`commit evidence is untrustworthy: derived ${messages.length} records, but rev-list proves ${expectedCount} commits (${direction} evidence than commits)`);
  }
  if (messages.length === 0 || messages.some((message) => message.length === 0)) throw new Error("could not derive commit messages from origin/main..HEAD");
  return messages;
}

const args = process.argv.slice(2);
if (args.length > 0) {
  let title;
  let body;
  let bodyFile;
  const files = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--title") title = args[++index];
    else if (args[index] === "--body") body = args[++index];
    else if (args[index] === "--body-file") bodyFile = args[++index];
    else if (args[index] === "--file") files.push(args[++index]);
    else usage();
  }
  if (typeof title !== "string" || (typeof body !== "string") === (typeof bodyFile !== "string") || files.length === 0) usage();
  const result = validateComposedPullRequest({ title, body: body ?? readFileSync(bodyFile, "utf8"), files, commitMessages: deriveCommitMessages() });
  if (!result.ok) {
    console.error(`PR lifecycle pre-push check failed: ${result.error}`);
    process.exit(1);
  }
  console.log(`PR lifecycle pre-push check passed: ${result.disposition}; Review tier: ${result.reviewTier}`);
}
