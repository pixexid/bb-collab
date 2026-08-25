import { accessSync, constants, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute } from "node:path";

const execFileAsync = promisify(execFile);
const HOST_PATTERN = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?::[1-9][0-9]{0,4})?$/u;
const REPOSITORY_PART_PATTERN = /^[A-Za-z0-9_.-]+$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$/iu;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const GH_JSON_FIELDS = "number,headRefOid,state,mergedAt,reviewDecision,reviews,statusCheckRollup,url";
const validatedGhPaths = new Set<string>();

export type GithubRepositoryIdentity = {
  host: string;
  owner: string;
  repo: string;
};

export type GithubPullRequestTarget = {
  repositoryIdentity: GithubRepositoryIdentity;
  pullRequestNumber: number;
};

export type PullRequestMergeState = "open" | "closed_unmerged" | "merged";
export type PullRequestChecksSummary = "pending" | "success" | "failure" | "cancelled" | "unknown";
export type PullRequestReviewDecision = "none" | "approved" | "changes_requested" | "dismissed_or_changed" | "unknown";

export type NormalizedPullRequestObservation = {
  repositoryIdentity: GithubRepositoryIdentity;
  pullRequestNumber: number;
  headSha: string;
  state: PullRequestMergeState;
  merged: boolean;
  checksSummary: PullRequestChecksSummary;
  reviewDecision: PullRequestReviewDecision;
};

export interface GithubPullRequestReadAdapter {
  read(target: GithubPullRequestTarget): Promise<unknown> | unknown;
}

export type GithubPullRequestObservationOptions = {
  adapter?: GithubPullRequestReadAdapter;
  ghPath?: string;
  timeoutMs?: number;
};

export type GithubPullRequestDegradedReason =
  | "invalid_target"
  | "adapter_unavailable"
  | "gh_unavailable"
  | "gh_path_invalid"
  | "timeout"
  | "malformed_response"
  | "identity_mismatch";

export class GithubPullRequestObservationError extends Error {
  readonly status = "degraded" as const;

  constructor(
    readonly reason: GithubPullRequestDegradedReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GithubPullRequestObservationError";
  }
}

function degraded(reason: GithubPullRequestDegradedReason, message: string, cause?: unknown): GithubPullRequestObservationError {
  return new GithubPullRequestObservationError(reason, message, cause === undefined ? undefined : { cause });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function validateTarget(target: GithubPullRequestTarget): void {
  if (!isRecord(target) || !isRecord(target.repositoryIdentity)) {
    throw degraded("invalid_target", "GitHub pull-request target is not an object with repository identity");
  }
  const identity = target.repositoryIdentity;
  if (typeof identity.host !== "string" || !HOST_PATTERN.test(identity.host)
    || typeof identity.owner !== "string" || !REPOSITORY_PART_PATTERN.test(identity.owner)
    || typeof identity.repo !== "string" || !REPOSITORY_PART_PATTERN.test(identity.repo)
    || !Number.isSafeInteger(target.pullRequestNumber) || target.pullRequestNumber < 1) {
    throw degraded("invalid_target", "GitHub pull-request target identity is invalid");
  }
}

function validateTimeout(timeoutMs: number | undefined): number {
  const value = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    throw degraded("invalid_target", `GitHub pull-request observation timeout must be 1-${MAX_TIMEOUT_MS}ms`);
  }
  return value;
}

function validatedGhPath(path: string): string {
  if (!isAbsolute(path) || path.includes("\0")) {
    throw degraded("gh_path_invalid", "GitHub CLI path must be fully qualified");
  }
  if (validatedGhPaths.has(path)) return path;
  try {
    if (!statSync(path).isFile()) throw new Error("not a file");
    accessSync(path, constants.X_OK);
  } catch (error) {
    throw degraded("gh_path_invalid", "GitHub CLI path is missing or not executable", error);
  }
  validatedGhPaths.add(path);
  return path;
}

function repositoryUrlMatches(value: unknown, target: GithubPullRequestTarget): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    const expectedPath = `/${target.repositoryIdentity.owner}/${target.repositoryIdentity.repo}/pull/${target.pullRequestNumber}`;
    return url.protocol === "https:"
      && url.host.toLowerCase() === target.repositoryIdentity.host.toLowerCase()
      && url.pathname === expectedPath
      && url.username === ""
      && url.password === ""
      && url.search === ""
      && url.hash === "";
  } catch {
    return false;
  }
}

function normalizeMergeState(value: Record<string, unknown>): { state: PullRequestMergeState; merged: boolean } {
  if (typeof value.state !== "string" || !hasOwn(value, "mergedAt")) {
    throw degraded("malformed_response", "GitHub pull-request response is missing merge fields");
  }
  const mergedAt = value.mergedAt;
  if (mergedAt !== null && (typeof mergedAt !== "string" || !Number.isFinite(Date.parse(mergedAt)))) {
    throw degraded("malformed_response", "GitHub pull-request mergedAt is invalid");
  }
  if (value.state === "OPEN") {
    if (mergedAt !== null) throw degraded("malformed_response", "open GitHub pull request has a merge timestamp");
    return { state: "open", merged: false };
  }
  if (value.state === "CLOSED") {
    if (mergedAt !== null) return { state: "merged", merged: true };
    return { state: "closed_unmerged", merged: false };
  }
  if (value.state === "MERGED") {
    if (mergedAt === null) throw degraded("malformed_response", "merged GitHub pull request has no merge timestamp");
    return { state: "merged", merged: true };
  }
  throw degraded("malformed_response", "GitHub pull-request merge state is unknown");
}

function checkValue(value: unknown): string {
  if (!isRecord(value)) throw degraded("malformed_response", "GitHub check entry is not an object");
  if (hasOwn(value, "conclusion")) {
    if (typeof value.conclusion === "string") return value.conclusion.toUpperCase();
    if (value.conclusion !== null || typeof value.status !== "string") {
      throw degraded("malformed_response", "GitHub check conclusion is partial or invalid");
    }
    return value.status.toUpperCase();
  }
  if (typeof value.state === "string") return value.state.toUpperCase();
  throw degraded("malformed_response", "GitHub check entry has no state or conclusion");
}

function normalizeChecks(value: unknown): PullRequestChecksSummary {
  if (!Array.isArray(value)) throw degraded("malformed_response", "GitHub status check rollup is not an array");
  if (value.length === 0) return "unknown";
  const values = value.map(checkValue);
  const known = new Set(["SUCCESS", "NEUTRAL", "SKIPPED", "FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED", "CANCELLED", "EXPECTED", "QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED"]);
  if (values.some((item) => !known.has(item))) return "unknown";
  if (values.some((item) => ["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED"].includes(item))) return "failure";
  if (values.some((item) => ["EXPECTED", "QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED"].includes(item))) return "pending";
  if (values.some((item) => item === "CANCELLED")) return "cancelled";
  return "success";
}

function reviewValues(value: unknown): string[] {
  if (!Array.isArray(value)) throw degraded("malformed_response", "GitHub reviews are not an array");
  return value.map((review) => {
    if (!isRecord(review) || typeof review.state !== "string") {
      throw degraded("malformed_response", "GitHub review entry is partial or invalid");
    }
    return review.state.toUpperCase();
  });
}

function normalizeReview(value: Record<string, unknown>): PullRequestReviewDecision {
  if (!hasOwn(value, "reviewDecision")) throw degraded("malformed_response", "GitHub response is missing review decision");
  const reviews = reviewValues(value.reviews);
  const knownReviews = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED", "COMMENTED", "PENDING"]);
  if (reviews.some((item) => !knownReviews.has(item))) return "unknown";
  if (value.reviewDecision !== null && typeof value.reviewDecision !== "string") {
    throw degraded("malformed_response", "GitHub review decision is invalid");
  }
  const decision = typeof value.reviewDecision === "string" ? value.reviewDecision.toUpperCase() : "";
  if (decision === "APPROVED") return "approved";
  if (decision === "CHANGES_REQUESTED") return "changes_requested";
  if (decision === "DISMISSED" || decision === "CHANGED") return "dismissed_or_changed";
  if (decision === "REVIEW_REQUIRED") return reviews.length === 0 ? "none" : "dismissed_or_changed";
  if (decision !== "") return "unknown";
  if (reviews.includes("DISMISSED")) return "dismissed_or_changed";
  if (reviews.includes("CHANGES_REQUESTED")) return "changes_requested";
  if (reviews.includes("APPROVED")) return "approved";
  return "none";
}

function normalizeResponse(value: unknown, target: GithubPullRequestTarget): NormalizedPullRequestObservation {
  if (!isRecord(value)) throw degraded("malformed_response", "GitHub pull-request response is not an object");
  if (typeof value.number !== "number" || !Number.isSafeInteger(value.number) || value.number < 1
    || value.number !== target.pullRequestNumber || typeof value.headRefOid !== "string" || !SHA_PATTERN.test(value.headRefOid)
    || !repositoryUrlMatches(value.url, target)) {
    throw degraded("identity_mismatch", "GitHub pull-request response does not match the exact target identity");
  }
  if (!hasOwn(value, "statusCheckRollup")) throw degraded("malformed_response", "GitHub response is missing status checks");
  const merge = normalizeMergeState(value);
  return {
    repositoryIdentity: { ...target.repositoryIdentity },
    pullRequestNumber: target.pullRequestNumber,
    headSha: value.headRefOid,
    state: merge.state,
    merged: merge.merged,
    checksSummary: normalizeChecks(value.statusCheckRollup),
    reviewDecision: normalizeReview(value),
  };
}

async function readWithGh(target: GithubPullRequestTarget, ghPath: string, timeoutMs: number): Promise<unknown> {
  const executable = validatedGhPath(ghPath);
  const env = { ...process.env, GH_HOST: target.repositoryIdentity.host };
  let stdout: string;
  try {
    const result = await execFileAsync(executable, [
      "pr", "view", String(target.pullRequestNumber), "--repo",
      `${target.repositoryIdentity.owner}/${target.repositoryIdentity.repo}`, "--json", GH_JSON_FIELDS,
    ], { encoding: "utf8", env, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: MAX_OUTPUT_BYTES });
    stdout = result.stdout;
  } catch (error) {
    const candidate = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string; code?: string };
    if (candidate.code === "ETIMEDOUT" || candidate.killed === true || candidate.signal === "SIGKILL") {
      throw degraded("timeout", `GitHub pull-request observation exceeded ${timeoutMs}ms`, error);
    }
    throw degraded("gh_unavailable", "GitHub CLI observation failed", error);
  }
  try {
    return JSON.parse(stdout.trim()) as unknown;
  } catch (error) {
    throw degraded("malformed_response", "GitHub CLI returned invalid JSON", error);
  }
}

export async function observeGithubPullRequest(
  target: GithubPullRequestTarget,
  options: GithubPullRequestObservationOptions = {},
): Promise<NormalizedPullRequestObservation> {
  validateTarget(target);
  const timeoutMs = validateTimeout(options.timeoutMs);
  let response: unknown;
  if (options.adapter) {
    try {
      response = await options.adapter.read(target);
    } catch (error) {
      if (options.ghPath === undefined) throw degraded("adapter_unavailable", "Configured GitHub adapter is unavailable", error);
      response = await readWithGh(target, options.ghPath, timeoutMs);
    }
  } else {
    if (options.ghPath === undefined) throw degraded("gh_unavailable", "No configured GitHub adapter or configured gh path is available");
    response = await readWithGh(target, options.ghPath, timeoutMs);
  }
  return normalizeResponse(response, target);
}
