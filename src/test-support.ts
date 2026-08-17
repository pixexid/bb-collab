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
  type NativeAssignmentAdapter,
  type NativeAssignmentEvidence,
  type NativeAssignmentInput,
  type NativeAssignmentInspection,
  type ReviewFactReader,
  type ReviewFacts,
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
    operatorReceiptId?: string | null;
    retirementCondition?: string | null;
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
      operatorReceiptId: input.operatorReceiptId ?? null,
      retirementCondition: input.retirementCondition ?? null,
    }),
  );
  db.prepare(
    `INSERT INTO actor_receipts
      (project_id, receipt_id, actor_kind, subject_id, role_id, role_generation,
       verification_state, receipt_digest, issued_at_ms, operator_receipt_id, retirement_condition)
     VALUES (?, ?, ?, ?, ?, ?, 'verified', ?, ?, ?, ?)`,
  ).run(
    input.projectId,
    input.receiptId,
    actorKind,
    subjectId,
    input.roleId ?? null,
    input.roleGeneration ?? null,
    receiptDigest,
    Date.now(),
    input.operatorReceiptId ?? null,
    input.retirementCondition ?? null,
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
    decisionClass?: "assignment_admission" | "role_succession" | "review_adjudication" | "legacy_adoption" | "operator_only";
    options?: Record<string, unknown>;
    resourceRevision?: number;
  },
): void {
  const scopeJson = canonicalJson(input.scope ?? { fixture: true });
  const decisionClass = input.decisionClass ?? "assignment_admission";
  const optionsJson = canonicalJson(input.options ?? {});
  const identityDigest = sha256(canonicalJson({
    projectId: input.projectId,
    configRevision: input.configRevision ?? 1,
    repoTargetId: input.repoTargetId ?? null,
    scope: JSON.parse(scopeJson),
    decisionClass,
    options: JSON.parse(optionsJson),
  }));
  db.prepare(
    `INSERT INTO decisions
      (decision_id, project_id, config_revision, repo_target_id, scope_json,
       scope_digest, current_resource_revision, decision_class, options_json,
       decision_identity_digest)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.decisionId,
    input.projectId,
    input.configRevision ?? 1,
    input.repoTargetId ?? null,
    scopeJson,
    sha256(scopeJson),
    input.resourceRevision ?? 1,
    decisionClass,
    optionsJson,
    identityDigest,
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

  serverId(): string {
    this.readCalls.push("server.id");
    return "bb-server-test";
  }

  thread(threadId: string): RoleThreadFact {
    this.readCalls.push(`thread:${threadId}`);
    if (this.facts.thread.id !== threadId) throw new Error("unknown thread");
    return structuredClone(this.facts.thread);
  }

  event(threadId: string, eventId: string, eventSeq: number): RoleEventFact {
    this.readCalls.push(`event:${threadId}:${eventId}:${eventSeq}`);
    if (this.facts.thread.id !== threadId) throw new Error("unknown thread");
    const events = this.facts.events.filter((event) => event.id === eventId && event.seq === eventSeq);
    if (events.length !== 1) throw new Error("unknown event");
    return structuredClone(events[0]!);
  }

  eventsAfter(threadId: string, afterSeq: number, limit: number): RoleEventFact[] {
    this.readCalls.push(`eventsAfter:${threadId}:${afterSeq}:${limit}`);
    if (this.facts.thread.id !== threadId) throw new Error("unknown thread");
    return structuredClone(this.facts.events.filter((event) => event.seq > afterSeq).slice(0, limit));
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

export class DeterministicNativeAssignmentAdapter implements NativeAssignmentAdapter {
  readonly inspectCalls: Array<{ projectId: string; repoTargetId: string; assignment: ApplyRequest["assignment"] }> = [];
  readonly dispatchCalls: NativeAssignmentInput[] = [];
  readonly reconcileCalls: Array<NativeAssignmentInput & { threadId: string | null; nativeRequestId: string | null }> = [];
  nextEvidence: Partial<NativeAssignmentEvidence> | null = null;
  nextInspection: Partial<NativeAssignmentInspection> | null = null;
  onInspect: ((input: { projectId: string; repoTargetId: string; assignment: NonNullable<ApplyRequest["assignment"]> }) => void) | null = null;
  onDispatch: ((input: NativeAssignmentInput) => void) | null = null;

  inspect(input: { projectId: string; repoTargetId: string; assignment: NonNullable<ApplyRequest["assignment"]> }): NativeAssignmentInspection {
    this.inspectCalls.push(structuredClone(input));
    this.onInspect?.(input);
    const override = this.nextInspection;
    this.nextInspection = null;
    return {
      bbServerId: input.assignment.environment.bbServerId,
      projectId: input.projectId,
      environmentId: input.assignment.environment.environmentId,
      sourceId: input.assignment.environment.sourceId,
      hostId: input.assignment.environment.hostId,
      environmentPath: input.assignment.environment.path,
      environmentMode: input.assignment.environment.mode,
      environmentStatus: "ready",
      workingTreeState: "clean",
      branchName: input.assignment.branchName,
      headSha: input.assignment.candidateSha ?? input.assignment.baseSha,
      baseSha: input.assignment.baseSha,
      candidateSha: input.assignment.candidateSha,
      defaultBranchName: "main",
      defaultBranchHeadSha: input.assignment.baseSha,
      mergeBaseSha: input.assignment.baseSha,
      threadId: input.assignment.attachThreadId,
      threadProviderId: input.assignment.attachThreadId ? input.assignment.requestedProfile.providerId : null,
      threadVisibility: input.assignment.attachThreadId ? input.assignment.requestedProfile.visibility : null,
      ...override,
    };
  }

  private evidence(input: NativeAssignmentInput): NativeAssignmentEvidence {
    const override = this.nextEvidence;
    this.nextEvidence = null;
    return {
      disposition: "confirmed",
      reasonCode: "exact_content_receipt",
      assignmentId: input.assignmentId,
      executionAttemptId: input.executionAttemptId,
      bbServerId: input.environment.bbServerId,
      projectId: input.projectId,
      environmentId: input.environment.environmentId,
      sourceId: input.environment.sourceId,
      hostId: input.environment.hostId,
      environmentPath: input.environment.path,
      threadId: input.attachThreadId ?? `thread-${input.assignmentId}`,
      providerThreadId: `provider-${input.executionAttemptId}`,
      nativeRequestId: `request-${input.executionAttemptId}`,
      requestEventId: `request-event-${input.executionAttemptId}`,
      requestEventSeq: 1,
      acceptedEventId: `accepted-event-${input.executionAttemptId}`,
      acceptedEventSeq: 2,
      firstActionEventId: `first-action-${input.executionAttemptId}`,
      firstActionEventSeq: 3,
      contentEventId: `content-event-${input.executionAttemptId}`,
      contentEventSeq: 4,
      contentDigest: input.frozenBriefDigest,
      actualProfile: structuredClone(input.requestedProfile),
      branchName: input.branchName,
      baseSha: input.baseSha,
      candidateSha: input.candidateSha,
      lastEventSeq: 4,
      observedAtMs: Date.now(),
      ...override,
    };
  }

  dispatch(input: NativeAssignmentInput): NativeAssignmentEvidence {
    this.dispatchCalls.push(structuredClone(input));
    this.onDispatch?.(input);
    return this.evidence(input);
  }

  reconcile(input: NativeAssignmentInput & { threadId: string | null; nativeRequestId: string | null }): NativeAssignmentEvidence {
    this.reconcileCalls.push(structuredClone(input));
    return this.evidence(input);
  }
}

export class DeterministicReviewFactReader implements ReviewFactReader {
  readonly readCalls: Parameters<ReviewFactReader["read"]>[0][] = [];
  facts: ReviewFacts | null = null;
  onRead: ((input: Parameters<ReviewFactReader["read"]>[0]) => void) | null = null;

  read(input: Parameters<ReviewFactReader["read"]>[0]): ReviewFacts {
    this.readCalls.push(structuredClone(input));
    this.onRead?.(input);
    if (!this.facts) throw new Error("review facts unavailable");
    return structuredClone(this.facts);
  }
}

export function applyWithFixtureReceipt(
  db: Database.Database,
  request: ApplyRequest,
  githubAdapter: GitHubIssueAdapter | null = null,
  roleFactReader: RoleFactReader | null = null,
  nativeAssignmentAdapter: NativeAssignmentAdapter | null = null,
  reviewFactReader: ReviewFactReader | null = null,
): FoundationResult {
  return applyFixtureMutation(db, request, githubAdapter, roleFactReader, nativeAssignmentAdapter, reviewFactReader);
}
