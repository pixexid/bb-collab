import type Database from "better-sqlite3";
import {
  applyFixtureMutation,
  canonicalJson,
  GitHubIssueAdapterError,
  sha256,
  type ApplyRequest,
  type FoundationResult,
  type GitHubIssueAdapter,
  type GitHubIssueMutation,
  type GitHubIssueSnapshot,
  type RoleEnvironmentFact,
  type RoleEventFact,
  type RoleFactReader,
  type RoleHostFact,
  type RoleProjectFact,
  type RoleThreadFact,
  type SqliteDatabase,
} from "./foundation.js";

export function seedVerifiedFixtureReceipt(
  db: SqliteDatabase,
  input: {
    projectId: string;
    receiptId: string;
    actorKind?: string;
    subjectId?: string;
    roleId?: string | null;
    roleGeneration?: number | null;
  },
): void {
  const actorKind = input.actorKind ?? "fixture";
  const subjectId = input.subjectId ?? input.receiptId;
  const receiptDigest = sha256(
    canonicalJson({
      projectId: input.projectId,
      receiptId: input.receiptId,
      actorKind,
      subjectId,
      roleId: input.roleId ?? null,
      roleGeneration: input.roleGeneration ?? null,
      verificationState: "verified",
    }),
  );
  db.prepare(
    `INSERT INTO actor_receipts
      (project_id, receipt_id, actor_kind, subject_id, role_id, role_generation,
       verification_state, receipt_digest, issued_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, 'verified', ?, ?)`,
  ).run(
    input.projectId,
    input.receiptId,
    actorKind,
    subjectId,
    input.roleId ?? null,
    input.roleGeneration ?? null,
    receiptDigest,
    Date.now(),
  );
}

export function seedFixtureDecision(
  db: SqliteDatabase,
  input: {
    projectId: string;
    decisionId: string;
    configRevision?: number;
    repoTargetId?: string | null;
    scope?: unknown;
    resourceRevision?: number;
  },
): void {
  const scopeJson = canonicalJson(input.scope ?? { fixture: true });
  db.prepare(
    `INSERT INTO decisions
      (decision_id, project_id, config_revision, repo_target_id, scope_json,
       scope_digest, current_resource_revision)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.decisionId,
    input.projectId,
    input.configRevision ?? 1,
    input.repoTargetId ?? null,
    scopeJson,
    sha256(scopeJson),
    input.resourceRevision ?? 1,
  );
}

export class DeterministicGitHubIssueAdapter implements GitHubIssueAdapter {
  readonly mutationCalls: GitHubIssueMutation[] = [];
  readonly readCalls: Array<{ owner: string; repo: string; issueNumber: number }> = [];
  readonly issues = new Map<string, GitHubIssueSnapshot>();
  available = true;
  nextIssueNumber = 1;
  nextMutationOutcome: "normal" | "ambiguous" | "wrong_identity" = "normal";
  readonly readOutcomes: Array<"normal" | "missing" | "invalid" | "unavailable"> = [];

  constructor(readonly connectorHost = "github.test") {}

  private key(owner: string, repo: string, issueNumber: number): string {
    return `${owner}/${repo}#${issueNumber}`;
  }

  put(snapshot: GitHubIssueSnapshot): void {
    this.issues.set(this.key(snapshot.owner, snapshot.repo, snapshot.issueNumber), structuredClone(snapshot));
    this.nextIssueNumber = Math.max(this.nextIssueNumber, snapshot.issueNumber + 1);
  }

  remove(owner: string, repo: string, issueNumber: number): void {
    this.issues.delete(this.key(owner, repo, issueNumber));
  }

  snapshot(owner: string, repo: string, issueNumber: number): GitHubIssueSnapshot | undefined {
    const value = this.issues.get(this.key(owner, repo, issueNumber));
    return value ? structuredClone(value) : undefined;
  }

  read(owner: string, repo: string, issueNumber: number): GitHubIssueSnapshot | null {
    this.readCalls.push({ owner, repo, issueNumber });
    const outcome = this.readOutcomes.shift() ?? "normal";
    if (outcome === "unavailable") throw new GitHubIssueAdapterError("unavailable");
    if (outcome === "missing") return null;
    if (outcome === "invalid") return { owner } as never;
    return this.snapshot(owner, repo, issueNumber) ?? null;
  }

  mutate(input: GitHubIssueMutation): GitHubIssueSnapshot {
    this.mutationCalls.push(structuredClone(input));
    const outcome = this.nextMutationOutcome;
    this.nextMutationOutcome = "normal";
    if (outcome === "ambiguous") throw new GitHubIssueAdapterError("ambiguous");
    const issueNumber = input.kind === "create" ? this.nextIssueNumber++ : input.issueNumber!;
    const previous = this.snapshot(input.owner, input.repo, issueNumber);
    if (input.kind === "update" && !previous) throw new GitHubIssueAdapterError("ambiguous");
    const labels = new Set(previous?.labels ?? []);
    input.removeLabels.forEach((label) => labels.delete(label));
    input.addLabels.forEach((label) => labels.add(label));
    const snapshot: GitHubIssueSnapshot = {
      owner: input.owner,
      repo: input.repo,
      issueNumber,
      title: input.title,
      body: input.body,
      state: input.state,
      labels: [...labels].sort(),
      externalRevision: `fixture-${this.mutationCalls.length}`,
    };
    this.put(snapshot);
    return outcome === "wrong_identity" ? { ...snapshot, repo: "wrong-repo" } : structuredClone(snapshot);
  }
}

export class DeterministicRoleFactReader implements RoleFactReader {
  readonly readCalls: string[] = [];

  constructor(
    readonly facts: {
      thread: RoleThreadFact;
      events: RoleEventFact[];
      environment: RoleEnvironmentFact;
      project: RoleProjectFact;
      host: RoleHostFact;
      version: string;
    },
  ) {}

  thread(threadId: string): RoleThreadFact {
    this.readCalls.push(`thread:${threadId}`);
    if (this.facts.thread.id !== threadId) throw new Error("unknown thread");
    return structuredClone(this.facts.thread);
  }

  events(threadId: string): RoleEventFact[] {
    this.readCalls.push(`events:${threadId}`);
    if (this.facts.thread.id !== threadId) throw new Error("unknown thread");
    return structuredClone(this.facts.events);
  }

  environment(environmentId: string): RoleEnvironmentFact {
    this.readCalls.push(`environment:${environmentId}`);
    if (this.facts.environment.id !== environmentId) throw new Error("unknown environment");
    return structuredClone(this.facts.environment);
  }

  project(projectId: string): RoleProjectFact {
    this.readCalls.push(`project:${projectId}`);
    if (this.facts.project.id !== projectId) throw new Error("unknown project");
    return structuredClone(this.facts.project);
  }

  host(hostId: string): RoleHostFact {
    this.readCalls.push(`host:${hostId}`);
    if (this.facts.host.id !== hostId) throw new Error("unknown host");
    return structuredClone(this.facts.host);
  }

  version(): string {
    this.readCalls.push("system.version");
    return this.facts.version;
  }
}

export function applyWithFixtureReceipt(
  db: Database.Database,
  request: ApplyRequest,
  githubAdapter: GitHubIssueAdapter | null = null,
  roleFactReader: RoleFactReader | null = null,
): FoundationResult {
  return applyFixtureMutation(db, request, githubAdapter, roleFactReader);
}
