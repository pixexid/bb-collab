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
  throw new Error("usage: check-composed-pr.mjs --title <title> (--body <body> | --body-file <path>) [--base <git-ref>] [--commit-message <message> [...]] --file <changed-path> [...]");
}

function deriveCommitMessages(base) {
  const result = spawnSync("git", ["log", `${base}..HEAD`, "--format=%B"], { encoding: "utf8" });
  if (result.status !== 0 || result.error) throw new Error(`could not derive commit messages from ${base}..HEAD`);
  if (result.stdout.trim() === "") throw new Error(`no commit messages found in ${base}..HEAD`);
  return [result.stdout];
}

const args = process.argv.slice(2);
if (args.length > 0) {
  let title;
  let body;
  let bodyFile;
  let base = "origin/main";
  const files = [];
  const commitMessages = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--title") title = args[++index];
    else if (args[index] === "--body") body = args[++index];
    else if (args[index] === "--body-file") bodyFile = args[++index];
    else if (args[index] === "--base") base = args[++index];
    else if (args[index] === "--commit-message") commitMessages.push(args[++index]);
    else if (args[index] === "--file") files.push(args[++index]);
    else usage();
  }
  if (typeof title !== "string" || (typeof body !== "string") === (typeof bodyFile !== "string") || files.length === 0) usage();
  const result = validateComposedPullRequest({ title, body: body ?? readFileSync(bodyFile, "utf8"), files, commitMessages: commitMessages.length ? commitMessages : deriveCommitMessages(base) });
  if (!result.ok) {
    console.error(`PR lifecycle pre-push check failed: ${result.error}`);
    process.exit(1);
  }
  console.log(`PR lifecycle pre-push check passed: ${result.disposition}; Review tier: ${result.reviewTier}`);
}
