import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import type { BbPluginApi } from "@bb/plugin-sdk";

const exec = promisify(execFile);
const ACTIVE = ["prepared", "armed", "content_delivered", "running", "dispatch_unknown"];
const BACKOFF_MS = 10 * 60_000;
const DECISION_THRESHOLD_MS = 5 * 60_000;
const STALE_ATTEMPT_MS = 10 * 60_000;
const ESCALATION_HOLD_MS = 24 * 60 * 60_000;
// ponytail: one export has no paging seam; 200 is the bounded ceiling, page the export when population exceeds it.
const SNAPSHOT_LIMIT = 200;
const TIMELINE_PAGE_LIMIT = 100;
// ponytail: ten pages is the bounded history ceiling; raise only with a smaller model input budget.
const TIMELINE_PAGE_MAX = 10;
const TOOL = "companion_read_snapshot";
const TITLE = "Alzheimer companion judgment";
type Coverage = "known" | "partial" | "blind";
type TimelineResponse = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["timeline"]>>;
type Snapshot = { sentAt: number; fingerprint: string; escalatedAt?: number };
type Anchor =
  | { kind: "work_item"; workItemId: string; resourceRevision: number }
  | { kind: "attempt"; executionAttemptId: string }
  | { kind: "pull_request"; number: number; headSha: string }
  | { kind: "queue_message"; queueMessageId: string };
export type Candidate = { id: string; kind: Anchor["kind"]; anchors: Anchor; finding: string; evidence: Record<string, unknown> };
type Judgment = { coverage: Coverage; illegitimate: boolean; findings: string; fingerprint: string };
type Pending = { projectId: string; orchestratorId: string; turnStartedAt?: number };
type ExportRow = Record<string, unknown>;
type CanonicalExport = { executionAttempts: ExportRow[]; externalWorkRefs: ExportRow[]; roleGenerationHeads: ExportRow[]; roleGenerations: ExportRow[]; workItems: ExportRow[]; parseIssues: string[] };
type ExportManifest = { projectId?: unknown; tableCounts?: unknown };
type CanonicalReader = (projectId: string, exportRoot: string) => Promise<CanonicalExport>;
type GithubReader = (remote: string | null) => Promise<unknown>;
type QueuedMessage = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["queuedMessages"]["list"]>>[number];
type GithubIssue = { number: number; title: string; labels: string[]; updatedAt: number };
type GithubPr = { number: number; headSha: string; updatedAt: number; ready: boolean };
export type CandidateSnapshot = { canonical: CanonicalExport; queued: QueuedMessage[]; githubIssues: GithubIssue[]; githubPrs: GithubPr[]; coverage: Coverage; observedAt: number; cycleStartedAt?: number };

type FieldCheck = (value: unknown) => boolean;
const REQUIRED_FIELDS: Record<string, Record<string, FieldCheck>> = {
  execution_attempts: {
    execution_attempt_id: (value) => typeof value === "string",
    observed_at_ms: (value) => typeof value === "number",
    origin: (value) => typeof value === "string",
    project_id: (value) => typeof value === "string",
    state: (value) => typeof value === "string",
    thread_id: (value) => value === null || typeof value === "string",
    work_item_id: (value) => value === null || typeof value === "string",
  },
  external_work_refs: {
    issue_number: (value) => value === null || typeof value === "number",
    project_id: (value) => typeof value === "string",
    provider: (value) => value === "github",
    work_item_id: (value) => typeof value === "string",
  },
  role_generation_heads: {
    current_generation: (value) => typeof value === "number",
    project_id: (value) => typeof value === "string",
    role_id: (value) => typeof value === "string",
  },
  role_generations: {
    generation: (value) => typeof value === "number",
    holder_execution_attempt_id: (value) => typeof value === "string",
    project_id: (value) => typeof value === "string",
    role_id: (value) => typeof value === "string",
  },
  work_items: {
    lifecycle_state: (value) => typeof value === "string",
    project_id: (value) => typeof value === "string",
    resource_revision: (value) => typeof value === "number",
    updated_at_ms: (value) => typeof value === "number",
    work_item_id: (value) => typeof value === "string",
  },
};

export function parseJudgment(output: string, snapshot: CandidateSnapshot, onDrop: (reason: string) => void = () => {}): Judgment {
  const candidates = extractCandidates(snapshot);
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const escalations = [...output.matchAll(/^ESCALATE:\s*yes\s*$/gimu)];
  const retained: Candidate[] = [];
  const retainedIds = new Set<string>();
  for (const match of output.matchAll(/^FINDING:\s*(\{.+\})\s*$/gimu)) {
    try {
      const finding = JSON.parse(match[1]!) as { candidateId?: unknown; anchors?: unknown; finding?: unknown };
      const candidate = typeof finding.candidateId === "string" ? byId.get(finding.candidateId) : undefined;
      if (!candidate) { onDrop("unknown-candidate"); continue; }
      if (JSON.stringify(finding.anchors) !== JSON.stringify(candidate.anchors)) { onDrop("anchor-mismatch"); continue; }
      if (finding.finding !== candidate.finding) { onDrop("claim-mismatch"); continue; }
      if (retainedIds.has(candidate.id)) { onDrop("candidate-duplicate"); continue; }
      retainedIds.add(candidate.id);
      retained.push({ ...candidate, finding: finding.finding.trim() });
    } catch { onDrop("finding-malformed"); }
  }
  const findings = retained.map((candidate) => `${candidate.finding} anchors=${JSON.stringify(candidate.anchors)}`);
  const illegitimate = escalations.length === 1 && retained.length > 0;
  const text = findings.join("; ").slice(0, 8_000);
  return { coverage: snapshot.coverage, illegitimate, findings: text, fingerprint: retained.map((candidate) => candidate.id).sort().join(";") };
}

export function routeJudgment(prior: Snapshot | undefined, judgment: Judgment, now: number, turnStartedAt?: number): "orchestrator" | "director" | undefined {
  if (!judgment.illegitimate) return undefined;
  const unchanged = prior?.fingerprint === judgment.fingerprint;
  if (unchanged && turnStartedAt !== undefined && turnStartedAt > prior!.sentAt && (!prior?.escalatedAt || now - prior.escalatedAt >= ESCALATION_HOLD_MS)) return "director";
  if (unchanged && prior?.escalatedAt && now - prior.escalatedAt < ESCALATION_HOLD_MS) return undefined;
  return !unchanged || !prior || now - prior.sentAt >= BACKOFF_MS ? "orchestrator" : undefined;
}

export async function parseCanonicalExport(output: string, exportRoot: string, projectId: string): Promise<CanonicalExport> {
  const result = JSON.parse(output) as {
    outcome?: string;
    export?: { recordsNdjson?: unknown; manifest?: ExportManifest };
    evidence?: { exportFile?: { complete?: unknown; directory?: unknown; manifest?: ExportManifest } };
  };
  if (result.outcome !== "OK") throw new Error(`canonical-export-${result.outcome ?? "invalid"}`);
  const inlineRecords = result.export?.recordsNdjson;
  const fileExport = result.evidence?.exportFile;
  const manifest = typeof inlineRecords === "string" ? result.export?.manifest : fileExport?.manifest;
  let recordsNdjson: string;
  if (typeof inlineRecords === "string") recordsNdjson = inlineRecords;
  else {
    if (fileExport?.complete !== true || typeof fileExport.directory !== "string") throw new Error("canonical-export-records-missing");
    const path = join(exportRoot, fileExport.directory, "records.ndjson");
    if (isAbsolute(fileExport.directory) || relative(exportRoot, path).startsWith("..")) throw new Error("canonical-export-directory-invalid");
    recordsNdjson = await readFile(path, "utf8");
  }
  if (manifest?.projectId !== projectId || !manifest.tableCounts || typeof manifest.tableCounts !== "object" || Array.isArray(manifest.tableCounts)) throw new Error("canonical-export-manifest-invalid");
  const tables = new Map<string, ExportRow[]>();
  for (const line of recordsNdjson.split("\n")) {
    if (!line) continue;
    const record = JSON.parse(line) as { table?: unknown; row?: unknown };
    if (typeof record.table !== "string" || !record.row || typeof record.row !== "object" || Array.isArray(record.row)) throw new Error("canonical-export-record-invalid");
    const rows = tables.get(record.table) ?? [];
    rows.push(record.row as ExportRow);
    tables.set(record.table, rows);
  }
  const canonical = {
    executionAttempts: tables.get("execution_attempts") ?? [],
    externalWorkRefs: tables.get("external_work_refs") ?? [],
    roleGenerationHeads: tables.get("role_generation_heads") ?? [],
    roleGenerations: tables.get("role_generations") ?? [],
    workItems: tables.get("work_items") ?? [],
    parseIssues: [] as string[],
  };
  const counts = manifest.tableCounts as Record<string, unknown>;
  for (const [table, rows] of [["execution_attempts", canonical.executionAttempts], ["external_work_refs", canonical.externalWorkRefs], ["role_generation_heads", canonical.roleGenerationHeads], ["role_generations", canonical.roleGenerations], ["work_items", canonical.workItems]] as const) {
    if (counts[table] !== rows.length) throw new Error(`canonical-export-${table}-count-mismatch`);
    const validRows: ExportRow[] = [];
    for (const row of rows) {
      const invalidField = row.project_id !== undefined && row.project_id !== projectId ? "project_id" : Object.entries(REQUIRED_FIELDS[table]!).find(([field, valid]) => !valid(row[field]))?.[0];
      if (!invalidField) {
        validRows.push(row);
        continue;
      }
      if (table !== "execution_attempts") throw new Error(`canonical-export-${table}-${invalidField}-invalid`);
      canonical.parseIssues.push(`execution_attempts.${invalidField}`);
    }
    if (table === "execution_attempts") canonical.executionAttempts = validRows;
  }
  const head = canonical.roleGenerationHeads.find((row) => row.project_id === projectId && row.role_id === "project-orchestrator");
  if (!head) throw new Error("canonical-export-orchestrator-head-missing");
  if (!readRoleThread(canonical, projectId, "project-orchestrator")) throw new Error("canonical-export-orchestrator-thread-unresolved");
  return canonical;
}

export async function readCanonicalExport(projectId: string, exportRoot: string): Promise<CanonicalExport> {
  const { stdout } = await exec(process.env.BB_CLI?.trim() || "bb", ["collab", "export", "--project", projectId], { timeout: 10_000 });
  return parseCanonicalExport(stdout, exportRoot, projectId);
}

export function readRoleThread(canonical: CanonicalExport, projectId: string, roleId: "project-orchestrator" | "director"): string | undefined {
  const head = canonical.roleGenerationHeads.find((row) => row.project_id === projectId && row.role_id === roleId);
  const generation = canonical.roleGenerations.find((row) => row.project_id === projectId && row.role_id === roleId && row.generation === head?.current_generation);
  const threadId = canonical.executionAttempts.find((row) => row.project_id === projectId && row.execution_attempt_id === generation?.holder_execution_attempt_id)?.thread_id;
  return typeof threadId === "string" && threadId.length > 0 ? threadId : undefined;
}

export function hasActiveWorkers(canonical: CanonicalExport, projectId: string): boolean {
  return canonical.executionAttempts.some((row) => row.project_id === projectId && row.work_item_id != null && row.origin === "work_item" && ACTIVE.includes(row.state as typeof ACTIVE[number]));
}

export function snapshotCanonical(canonical: CanonicalExport, queuedCount: number) {
  const executionAttempts = [...canonical.executionAttempts].sort((a, b) => Number(b.observed_at_ms) - Number(a.observed_at_ms)).slice(0, SNAPSHOT_LIMIT);
  const workItems = [...canonical.workItems].sort((a, b) => Number(b.updated_at_ms) - Number(a.updated_at_ms)).slice(0, SNAPSHOT_LIMIT);
  const coverage: Coverage = canonical.parseIssues.length > 0 || queuedCount >= SNAPSHOT_LIMIT || canonical.executionAttempts.length > SNAPSHOT_LIMIT || canonical.workItems.length > SNAPSHOT_LIMIT ? "partial" : "known";
  return { coverage, executionAttempts, workItems, parseIssues: canonical.parseIssues };
}

function timestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function githubLabels(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const labels = value.map((label) => label && typeof label === "object" ? (label as { name?: unknown }).name : undefined);
  return labels.every((label): label is string => typeof label === "string") ? labels : undefined;
}

function githubChecks(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const checks = value.map((check) => {
    if (!check || typeof check !== "object") return undefined;
    if ("conclusion" in check) return (check as { conclusion?: unknown }).conclusion;
    return (check as { state?: unknown }).state;
  });
  return checks.every((check): check is string => typeof check === "string") ? checks : undefined;
}

export function parseGithubEvidence(value: unknown, onInvalid: (reason: string) => void = () => {}): { issues: GithubIssue[]; prs: GithubPr[]; complete: boolean } {
  if (!value || typeof value !== "object") throw new Error("github-payload-invalid");
  const raw = value as { issues?: unknown; prs?: unknown };
  if (!Array.isArray(raw.issues) || !Array.isArray(raw.prs)) throw new Error("github-payload-invalid");
  let complete = raw.issues.length < SNAPSHOT_LIMIT && raw.prs.length < SNAPSHOT_LIMIT;
  const issues = raw.issues.flatMap((item, index) => {
    if (!item || typeof item !== "object") { onInvalid(`issue-${index}`); complete = false; return []; }
    const issue = item as Record<string, unknown>;
    const labels = githubLabels(issue.labels);
    const updatedAt = timestamp(issue.updatedAt);
    if (typeof issue.number !== "number" || typeof issue.title !== "string" || !labels || updatedAt === undefined) { onInvalid(`issue-${index}`); complete = false; return []; }
    return [{ number: issue.number, title: issue.title, labels, updatedAt }];
  });
  const prs = raw.prs.flatMap((item, index) => {
    if (!item || typeof item !== "object") { onInvalid(`pr-${index}`); complete = false; return []; }
    const pr = item as Record<string, unknown>;
    const checks = githubChecks(pr.statusCheckRollup);
    const updatedAt = timestamp(pr.updatedAt);
    if (typeof pr.number !== "number" || typeof pr.state !== "string" || typeof pr.headRefOid !== "string" || !Array.isArray(pr.reviews) || !checks || updatedAt === undefined) { onInvalid(`pr-${index}`); complete = false; return []; }
    const malformedApprovedReview = pr.reviews.some((review) => review && typeof review === "object" && (review as { state?: unknown }).state === "APPROVED" && typeof (review as { commit?: { oid?: unknown } }).commit?.oid !== "string");
    if (malformedApprovedReview) { onInvalid(`pr-${index}-approved-head`); complete = false; return []; }
    const approvedHeads = pr.reviews.flatMap((review) => review && typeof review === "object" && (review as { state?: unknown }).state === "APPROVED" ? [(review as { commit: { oid: string } }).commit.oid] : []);
    const ready = pr.state === "OPEN" && pr.mergeStateStatus === "CLEAN" && pr.reviewDecision === "APPROVED" && approvedHeads.includes(pr.headRefOid) && checks.length > 0 && checks.every((check) => check === "SUCCESS");
    return [{ number: pr.number, headSha: pr.headRefOid, updatedAt, ready }];
  });
  return { issues, prs, complete };
}

function queuedFirstLine(message: QueuedMessage): string {
  return message.content.find((part) => part.type === "text")?.text.split("\n", 1)[0]?.slice(0, 200) ?? "(non-text obligation)";
}

export function extractCandidates(snapshot: CandidateSnapshot): Candidate[] {
  const { canonical, githubIssues, githubPrs, observedAt, cycleStartedAt } = snapshot;
  const candidates: Candidate[] = [];
  const activeAttempts = canonical.executionAttempts.filter((attempt) => ACTIVE.includes(attempt.state as typeof ACTIVE[number]));
  const startableNumbers = new Set(githubIssues.filter((issue) => issue.labels.includes("queue:startable")).map((issue) => issue.number));
  for (const workItem of canonical.workItems) {
    const ref = canonical.externalWorkRefs.find((row) => row.work_item_id === workItem.work_item_id && row.provider === "github" && typeof row.issue_number === "number");
    if (workItem.lifecycle_state !== "ready" || !ref || !startableNumbers.has(ref.issue_number as number) || activeAttempts.some((attempt) => attempt.work_item_id === workItem.work_item_id)) continue;
    const anchors = { kind: "work_item", workItemId: String(workItem.work_item_id), resourceRevision: Number(workItem.resource_revision) } as const;
    candidates.push({ id: `work-item:${anchors.workItemId}:${anchors.resourceRevision}`, kind: anchors.kind, anchors, finding: `Work item ${anchors.workItemId} (revision ${anchors.resourceRevision}; issue #${ref.issue_number}) is queue:startable with zero active attempts.`, evidence: { lifecycleState: workItem.lifecycle_state, issueNumber: ref.issue_number, activeAttemptCount: 0 } });
  }
  for (const attempt of activeAttempts) {
    if (attempt.origin !== "work_item" || typeof attempt.execution_attempt_id !== "string" || typeof attempt.observed_at_ms !== "number" || observedAt - attempt.observed_at_ms < STALE_ATTEMPT_MS) continue;
    const anchors = { kind: "attempt", executionAttemptId: attempt.execution_attempt_id } as const;
    candidates.push({ id: `attempt:${anchors.executionAttemptId}`, kind: anchors.kind, anchors, finding: `Active attempt ${anchors.executionAttemptId} for work item ${String(attempt.work_item_id)} has produced no canonical evidence for at least ten minutes.`, evidence: { workItemId: attempt.work_item_id, state: attempt.state, observedAtMs: attempt.observed_at_ms } });
  }
  for (const pr of githubPrs) {
    if (!pr.ready || observedAt - pr.updatedAt < DECISION_THRESHOLD_MS) continue;
    const anchors = { kind: "pull_request", number: pr.number, headSha: pr.headSha } as const;
    candidates.push({ id: `pr:${pr.number}:${pr.headSha}`, kind: anchors.kind, anchors, finding: `PR #${pr.number} at ${pr.headSha} is approved on that head, green, mergeable, and unchanged past the five-minute decision threshold.`, evidence: { updatedAt: pr.updatedAt } });
  }
  const queueCutoff = cycleStartedAt ?? observedAt - DECISION_THRESHOLD_MS;
  for (const message of snapshot.queued) {
    if (message.createdAt >= queueCutoff) continue;
    const anchors = { kind: "queue_message", queueMessageId: message.id } as const;
    candidates.push({ id: `queue:${message.id}`, kind: anchors.kind, anchors, finding: `Queued obligation ${message.id} remained unconsumed across the orchestrator cycle: "${queuedFirstLine(message)}".`, evidence: { createdAt: message.createdAt, updatedAt: message.updatedAt } });
  }
  return candidates;
}

export function composeTimeline(latest: TimelineResponse, olderPages: TimelineResponse[]): TimelineResponse {
  const rows = [...olderPages].reverse().flatMap((page) => page.rows).concat(latest.rows);
  const rowIndexes = new Map<string, number>();
  const deduplicated = rows.reduce<TimelineResponse["rows"]>((result, row) => {
    const index = rowIndexes.get(row.id);
    if (index === undefined) {
      rowIndexes.set(row.id, result.length);
      result.push(row);
    } else {
      result[index] = row;
    }
    return result;
  }, []);
  const finalPage = olderPages.at(-1) ?? latest;
  return { ...latest, rows: deduplicated, timelinePage: { ...finalPage.timelinePage, returnedSegmentCount: deduplicated.length } };
}

async function githubEvidence(remote: string | null): Promise<unknown> {
  const repo = remote?.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/u)?.[1];
  if (!repo) throw new Error("github-repository-unresolved");
  const [issues, prs] = await Promise.all([
    exec("gh", ["issue", "list", "--repo", repo, "--state", "open", "--label", "queue:startable", "--json", "number,title,labels,updatedAt", "--limit", String(SNAPSHOT_LIMIT)], { timeout: 10_000 }),
    exec("gh", ["pr", "list", "--repo", repo, "--state", "open", "--json", "number,title,state,mergeStateStatus,reviewDecision,headRefOid,reviews,statusCheckRollup,updatedAt", "--limit", String(SNAPSHOT_LIMIT)], { timeout: 10_000 }),
  ]);
  return { issues: JSON.parse(issues.stdout), prs: JSON.parse(prs.stdout) };
}

const prompt = (projectId: string) => `Judge ONLY the verified candidates returned by ${TOOL}; do not discover or invent other work, and do not assert coverage because code computes it. Call the tool exactly once and do not mutate or message anything. If no candidate warrants a wake, output exactly SILENCE. Otherwise copy the selected candidate's id, anchors, and finding exactly into one line per candidate as FINDING: {"candidateId":"supplied id","anchors":supplied anchors,"finding":"supplied finding"}, followed by exactly ESCALATE: yes. Project: ${projectId}.`;

export default function companionWatcher(bb: BbPluginApi, readExport: CanonicalReader = readCanonicalExport, readGithub: GithubReader = githubEvidence) {
  const snapshots = new Map<string, Snapshot>();
  const companions = new Map<string, string>();
  const pending = new Map<string, Pending>();
  const candidateSnapshots = new Map<string, CandidateSnapshot>();
  const activeTurns = new Map<string, number>();
  let loaded = false;

  const load = async () => {
    if (loaded) return;
    const saved = await bb.storage.kv.get<Record<string, Snapshot>>("backoff");
    const savedCompanions = await bb.storage.kv.get<Record<string, string>>("companions");
    if (saved) for (const [key, value] of Object.entries(saved)) snapshots.set(key, value);
    if (savedCompanions) for (const [key, value] of Object.entries(savedCompanions)) companions.set(key, value);
    loaded = true;
  };

  const canonical = async (projectId: string) => {
    const config = await bb.sdk.system.config();
    return readExport(projectId, join(config.dataDir, "plugins", "bb-collab"));
  };

  bb.agents.registerTool({
    name: TOOL,
    description: "Read one bounded canonical snapshot for semantic idle judgment.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async (_params, context) => {
      await load();
      const caller = await bb.sdk.threads.get({ threadId: context.threadId });
      if (caller.projectId !== context.projectId || caller.title !== TITLE || caller.originPluginId !== bb.pluginId) return { isError: true, content: [{ type: "text", text: "companion-thread-mismatch" }] };
      try {
        const exported = await canonical(context.projectId);
        const orchestratorId = readRoleThread(exported, context.projectId, "project-orchestrator");
        if (!orchestratorId) throw new Error("orchestrator-head-unresolved");
        const project = await bb.sdk.projects.get({ projectId: context.projectId });
        const latestTimeline = await bb.sdk.threads.timeline({ threadId: orchestratorId, segmentLimit: String(TIMELINE_PAGE_LIMIT) });
        let recentTimeline = latestTimeline;
        const olderPages: TimelineResponse[] = [];
        for (let page = 1; recentTimeline.timelinePage.hasOlderRows && page < TIMELINE_PAGE_MAX; page += 1) {
          const cursor = recentTimeline.timelinePage.olderCursor;
          if (!cursor) break;
          recentTimeline = await bb.sdk.threads.timeline({ threadId: orchestratorId, segmentLimit: String(TIMELINE_PAGE_LIMIT), beforeAnchorSeq: String(cursor.anchorSeq), beforeAnchorId: cursor.anchorId });
          olderPages.push(recentTimeline);
        }
        recentTimeline = composeTimeline(latestTimeline, olderPages);
        const queued = await bb.sdk.threads.queuedMessages.list({ threadId: orchestratorId });
        const { coverage: canonicalCoverage, executionAttempts, workItems, parseIssues } = snapshotCanonical(exported, queued.length);
        if (parseIssues.length > 0) bb.log.warn(`companion-watcher coverage=partial event=snapshot reason=malformed-canonical-rows count=${parseIssues.length} fields=${parseIssues.join(",")}`);
        let githubIssues: GithubIssue[] = [];
        let githubPrs: GithubPr[] = [];
        let coverage: Coverage = canonicalCoverage;
        if (recentTimeline.timelinePage.hasOlderRows) {
          coverage = "partial";
          bb.log.warn(`companion-watcher coverage=partial event=snapshot reason=timeline-${recentTimeline.timelinePage.olderCursor ? "ceiling" : "cursor-missing"}`);
        }
        try {
          const githubIssuesFound: string[] = [];
          const github = parseGithubEvidence(await readGithub(project.gitRemoteUrl), (reason) => githubIssuesFound.push(reason));
          githubIssues = github.issues;
          githubPrs = github.prs;
          if (!github.complete || githubIssuesFound.length > 0) {
            coverage = "partial";
            bb.log.warn(`companion-watcher coverage=partial event=snapshot reason=github-population-incomplete details=${githubIssuesFound.join(",") || "ceiling"}`);
          }
        } catch (error) {
          coverage = "blind";
          bb.log.warn(`companion-watcher coverage=blind event=snapshot reason=${String(error)}`);
        }
        const snapshot: CandidateSnapshot = { canonical: { ...exported, executionAttempts, workItems }, queued: queued.slice(0, SNAPSHOT_LIMIT), githubIssues, githubPrs, coverage, observedAt: Date.now(), cycleStartedAt: pending.get(context.threadId)?.turnStartedAt };
        candidateSnapshots.set(context.threadId, snapshot);
        return JSON.stringify({ coverage, candidates: extractCandidates(snapshot) });
      } catch (error) {
        const reason = String(error);
        bb.log.warn(`companion-watcher coverage=blind event=snapshot reason=${reason}`);
        return { isError: true, content: [{ type: "text", text: `COVERAGE: blind\nsnapshot read failed: ${reason}` }] };
      }
    },
  });
  bb.agents.configure((context) => context.origin.pluginId === bb.pluginId && context.thread.title === TITLE ? { tools: [TOOL], skills: [] } : { tools: [], skills: [] });

  const judge = async (projectId: string, orchestratorId: string, turnStartedAt?: number) => {
    await load();
    let threadId = companions.get(projectId);
    if (threadId) {
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        if (thread.projectId !== projectId || thread.status !== "idle") return;
      } catch { companions.delete(projectId); threadId = undefined; }
    }
    if (!threadId) {
      const thread = await bb.sdk.threads.spawn({ projectId, environment: { type: "project-default" }, title: TITLE, visibility: "hidden", providerId: "codex", model: "gpt-5.6-luna", reasoningLevel: "medium", permissionMode: "auto", executionInputSources: { providerId: "explicit", model: "explicit", reasoningLevel: "explicit", permissionMode: "explicit" }, prompt: prompt(projectId) });
      threadId = thread.id;
      companions.set(projectId, threadId);
      await bb.storage.kv.set("companions", Object.fromEntries(companions));
    } else {
      await bb.sdk.threads.send({ threadId, mode: "auto", input: [{ type: "text", text: prompt(projectId), mentions: [] }] });
    }
    pending.set(threadId, { projectId, orchestratorId, turnStartedAt });
  };

  const handleJudgment = async (threadId: string, output: string) => {
    const request = pending.get(threadId);
    if (!request) return;
    pending.delete(threadId);
    const snapshot = candidateSnapshots.get(threadId);
    candidateSnapshots.delete(threadId);
    if (!snapshot) {
      bb.log.warn("companion-watcher coverage=blind event=post-check reason=snapshot-missing");
      return;
    }
    const judgment = parseJudgment(output, snapshot, (reason) => bb.log.warn(`companion-watcher coverage=${snapshot.coverage} event=post-check reason=${reason}`));
    const prior = snapshots.get(request.projectId);
    const now = Date.now();
    const route = routeJudgment(prior, judgment, now, request.turnStartedAt);
    bb.log.info(`companion-watcher coverage=${judgment.coverage} event=judgment illegitimate=${judgment.illegitimate} route=${route ?? "silence"}`);
    if (!route) return;
    try {
      const exported = await canonical(request.projectId);
      const target = route === "director" ? readRoleThread(exported, request.projectId, "director") : readRoleThread(exported, request.projectId, "project-orchestrator");
      if (!target || (route === "orchestrator" && target !== request.orchestratorId)) throw new Error(`${route}-head-unresolved`);
      await bb.sdk.threads.send({ threadId: target, mode: "auto", input: [{ type: "text", text: `Alzheimer companion ${route === "director" ? "escalation" : "wake"}: ${judgment.findings} (coverage: ${judgment.coverage}).`, mentions: [] }] });
      snapshots.set(request.projectId, { sentAt: now, fingerprint: judgment.fingerprint, escalatedAt: route === "director" ? now : prior?.fingerprint === judgment.fingerprint ? prior.escalatedAt : undefined });
      await bb.storage.kv.set("backoff", Object.fromEntries(snapshots));
    } catch (error) {
      bb.log.warn(`companion-watcher coverage=blind event=${route} reason=${String(error)}`);
    }
  };

  bb.events.on("thread.active", ({ thread }) => { activeTurns.set(thread.id, Date.now()); });
  // ponytail: idle-triggered judgment cannot detect silent plugin death; liveness currently relies on existing schedule-health monitoring (doctor schedule last-run checks / fleet-watchdog / launchd stall-guard); add interval receipts only if silent death is observed.
  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    if (pending.has(thread.id)) { await handleJudgment(thread.id, lastAssistantText ?? ""); return; }
    const turnStartedAt = activeTurns.get(thread.id);
    activeTurns.delete(thread.id);
    try {
      const exported = await canonical(thread.projectId);
      const orchestratorId = readRoleThread(exported, thread.projectId, "project-orchestrator");
      if (thread.id !== orchestratorId || hasActiveWorkers(exported, thread.projectId)) return;
      await judge(thread.projectId, orchestratorId, turnStartedAt);
    } catch (error) {
      bb.log.warn(`companion-watcher coverage=blind event=thread.idle reason=${String(error)}`);
    }
  });
}
