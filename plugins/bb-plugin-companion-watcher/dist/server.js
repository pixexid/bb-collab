import { createRequire as __createRequire } from "node:module";
import { dirname as __pathDirname } from "node:path";
import { fileURLToPath as __fileURLToPath } from "node:url";
const require = __createRequire(import.meta.url);
var __filename = __fileURLToPath(import.meta.url);
var __dirname = __pathDirname(__filename);

// server.ts
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
var exec = promisify(execFile);
var ACTIVE = ["prepared", "armed", "content_delivered", "running", "dispatch_unknown"];
var BACKOFF_MS = 10 * 6e4;
var DECISION_THRESHOLD_MS = 5 * 6e4;
var STALE_ATTEMPT_MS = 10 * 6e4;
var ESCALATION_HOLD_MS = 24 * 60 * 6e4;
var SNAPSHOT_LIMIT = 200;
var TIMELINE_PAGE_LIMIT = 100;
var TIMELINE_PAGE_MAX = 10;
var TOOL = "companion_read_snapshot";
var TITLE = "Alzheimer companion judgment";
var REQUIRED_FIELDS = {
  execution_attempts: {
    assignment_kind: (value) => value === null || value === "write" || value === "review" || value === "probe",
    execution_attempt_id: (value) => typeof value === "string",
    observed_at_ms: (value) => typeof value === "number",
    origin: (value) => typeof value === "string",
    project_id: (value) => typeof value === "string",
    review_pr_head_sha: (value) => value === null || typeof value === "string",
    review_pr_number: (value) => value === null || typeof value === "number",
    state: (value) => typeof value === "string",
    thread_id: (value) => value === null || typeof value === "string",
    work_item_id: (value) => value === null || typeof value === "string"
  },
  external_work_refs: {
    issue_number: (value) => value === null || typeof value === "number",
    project_id: (value) => typeof value === "string",
    provider: (value) => value === "github",
    work_item_id: (value) => typeof value === "string"
  },
  role_generation_heads: {
    current_generation: (value) => typeof value === "number",
    project_id: (value) => typeof value === "string",
    role_id: (value) => typeof value === "string"
  },
  role_generations: {
    generation: (value) => typeof value === "number",
    holder_execution_attempt_id: (value) => typeof value === "string",
    project_id: (value) => typeof value === "string",
    role_id: (value) => typeof value === "string"
  },
  work_items: {
    lifecycle_state: (value) => typeof value === "string",
    project_id: (value) => typeof value === "string",
    resource_revision: (value) => typeof value === "number",
    updated_at_ms: (value) => typeof value === "number",
    work_item_id: (value) => typeof value === "string"
  }
};
function parseJudgment(output, snapshot, onDrop = () => {
}) {
  const candidates = extractCandidates(snapshot);
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const escalations = [...output.matchAll(/^ESCALATE:\s*yes\s*$/gimu)];
  const retained = [];
  const retainedIds = /* @__PURE__ */ new Set();
  for (const match of output.matchAll(/^FINDING:\s*(\{.+\})\s*$/gimu)) {
    try {
      const finding = JSON.parse(match[1]);
      const candidate = typeof finding.candidateId === "string" ? byId.get(finding.candidateId) : void 0;
      if (!candidate) {
        onDrop("unknown-candidate");
        continue;
      }
      if (JSON.stringify(finding.anchors) !== JSON.stringify(candidate.anchors)) {
        onDrop("anchor-mismatch");
        continue;
      }
      if (finding.finding !== candidate.finding) {
        onDrop("claim-mismatch");
        continue;
      }
      if (retainedIds.has(candidate.id)) {
        onDrop("candidate-duplicate");
        continue;
      }
      retainedIds.add(candidate.id);
      retained.push({ ...candidate, finding: finding.finding.trim() });
    } catch {
      onDrop("finding-malformed");
    }
  }
  const findings = retained.map((candidate) => `${candidate.finding} anchors=${JSON.stringify(candidate.anchors)}`);
  const illegitimate = escalations.length === 1 && retained.length > 0;
  const text = findings.join("; ").slice(0, 8e3);
  return { coverage: snapshot.coverage, illegitimate, findings: text, fingerprint: retained.map((candidate) => candidate.id).sort().join(";") };
}
function routeJudgment(prior, judgment, now, turnStartedAt) {
  if (!judgment.illegitimate) return void 0;
  const unchanged = prior?.fingerprint === judgment.fingerprint;
  if (unchanged && turnStartedAt !== void 0 && turnStartedAt > prior.sentAt && (!prior?.escalatedAt || now - prior.escalatedAt >= ESCALATION_HOLD_MS)) return "director";
  if (unchanged && prior?.escalatedAt && now - prior.escalatedAt < ESCALATION_HOLD_MS) return void 0;
  return !unchanged || !prior || now - prior.sentAt >= BACKOFF_MS ? "orchestrator" : void 0;
}
async function parseCanonicalExport(output, exportRoot, projectId) {
  const result = JSON.parse(output);
  if (result.outcome !== "OK") throw new Error(`canonical-export-${result.outcome ?? "invalid"}`);
  const inlineRecords = result.export?.recordsNdjson;
  const fileExport = result.evidence?.exportFile;
  const manifest = typeof inlineRecords === "string" ? result.export?.manifest : fileExport?.manifest;
  let recordsNdjson;
  if (typeof inlineRecords === "string") recordsNdjson = inlineRecords;
  else {
    if (fileExport?.complete !== true || typeof fileExport.directory !== "string") throw new Error("canonical-export-records-missing");
    const path = join(exportRoot, fileExport.directory, "records.ndjson");
    if (isAbsolute(fileExport.directory) || relative(exportRoot, path).startsWith("..")) throw new Error("canonical-export-directory-invalid");
    recordsNdjson = await readFile(path, "utf8");
  }
  if (manifest?.projectId !== projectId || !manifest.tableCounts || typeof manifest.tableCounts !== "object" || Array.isArray(manifest.tableCounts)) throw new Error("canonical-export-manifest-invalid");
  const tables = /* @__PURE__ */ new Map();
  for (const line of recordsNdjson.split("\n")) {
    if (!line) continue;
    const record = JSON.parse(line);
    if (typeof record.table !== "string" || !record.row || typeof record.row !== "object" || Array.isArray(record.row)) throw new Error("canonical-export-record-invalid");
    const rows = tables.get(record.table) ?? [];
    rows.push(record.row);
    tables.set(record.table, rows);
  }
  const canonical = {
    executionAttempts: tables.get("execution_attempts") ?? [],
    externalWorkRefs: tables.get("external_work_refs") ?? [],
    roleGenerationHeads: tables.get("role_generation_heads") ?? [],
    roleGenerations: tables.get("role_generations") ?? [],
    workItems: tables.get("work_items") ?? [],
    parseIssues: []
  };
  const counts = manifest.tableCounts;
  for (const [table, rows] of [["execution_attempts", canonical.executionAttempts], ["external_work_refs", canonical.externalWorkRefs], ["role_generation_heads", canonical.roleGenerationHeads], ["role_generations", canonical.roleGenerations], ["work_items", canonical.workItems]]) {
    if (counts[table] !== rows.length) throw new Error(`canonical-export-${table}-count-mismatch`);
    const validRows = [];
    for (const row of rows) {
      const invalidField = row.project_id !== void 0 && row.project_id !== projectId ? "project_id" : Object.entries(REQUIRED_FIELDS[table]).find(([field, valid]) => !valid(row[field]))?.[0];
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
  if (!readRoleThread({ projectId, ...canonical }, projectId, "project-orchestrator")) throw new Error("canonical-export-orchestrator-thread-unresolved");
  return { projectId, ...canonical };
}
async function readCanonicalExport(projectId, exportRoot) {
  const { stdout } = await exec(process.env.BB_CLI?.trim() || "bb", ["collab", "export", "--project", projectId], { timeout: 1e4 });
  return parseCanonicalExport(stdout, exportRoot, projectId);
}
function readRoleThread(canonical, projectId, roleId) {
  const head = canonical.roleGenerationHeads.find((row) => row.project_id === projectId && row.role_id === roleId);
  const generation = canonical.roleGenerations.find((row) => row.project_id === projectId && row.role_id === roleId && row.generation === head?.current_generation);
  const threadId = canonical.executionAttempts.find((row) => row.project_id === projectId && row.execution_attempt_id === generation?.holder_execution_attempt_id)?.thread_id;
  return typeof threadId === "string" && threadId.length > 0 ? threadId : void 0;
}
function hasActiveWorkers(canonical, projectId) {
  return canonical.executionAttempts.some((row) => row.project_id === projectId && row.work_item_id != null && row.origin === "work_item" && ACTIVE.includes(row.state));
}
function shouldJudgeOnIdle(canonical, projectId, observedAt) {
  const active = canonical.executionAttempts.filter((row) => row.project_id === projectId && row.work_item_id != null && row.origin === "work_item" && ACTIVE.includes(row.state));
  return active.length === 0 || active.some((row) => typeof row.observed_at_ms === "number" && observedAt - row.observed_at_ms >= STALE_ATTEMPT_MS);
}
function snapshotCanonical(canonical, queuedCount) {
  const executionAttempts = [...canonical.executionAttempts].sort((a, b) => Number(b.observed_at_ms) - Number(a.observed_at_ms)).slice(0, SNAPSHOT_LIMIT);
  const workItems = [...canonical.workItems].sort((a, b) => Number(b.updated_at_ms) - Number(a.updated_at_ms)).slice(0, SNAPSHOT_LIMIT);
  const externalWorkRefs = canonical.externalWorkRefs.slice(0, SNAPSHOT_LIMIT);
  const canonicalComplete = canonical.parseIssues.length === 0 && canonical.executionAttempts.length <= SNAPSHOT_LIMIT && canonical.externalWorkRefs.length <= SNAPSHOT_LIMIT && canonical.workItems.length <= SNAPSHOT_LIMIT;
  const coverage = !canonicalComplete || queuedCount >= SNAPSHOT_LIMIT ? "partial" : "known";
  return { coverage, canonicalComplete, executionAttempts, externalWorkRefs, workItems, parseIssues: canonical.parseIssues };
}
function timestamp(value) {
  if (typeof value !== "string") return void 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : void 0;
}
function githubLabels(value) {
  if (!Array.isArray(value)) return void 0;
  const labels = value.map((label) => label && typeof label === "object" ? label.name : void 0);
  return labels.every((label) => typeof label === "string") ? labels : void 0;
}
function githubChecks(value) {
  if (!Array.isArray(value)) return void 0;
  const checks = value.map((check) => {
    if (!check || typeof check !== "object") return void 0;
    if ("conclusion" in check) return check.conclusion;
    return check.state;
  });
  return checks.every((check) => typeof check === "string") ? checks : void 0;
}
function githubClosingIssueNumber(value, repository) {
  if (!repository || !value || typeof value !== "object" || Array.isArray(value)) return void 0;
  const reference = value;
  const refRepository = reference.repository;
  if (!refRepository || typeof refRepository !== "object" || Array.isArray(refRepository)) return void 0;
  const repo = refRepository;
  const owner = repo.owner;
  if (!owner || typeof owner !== "object" || Array.isArray(owner)) return void 0;
  const ownerLogin = owner.login;
  const name = repo.name;
  const number = reference.number;
  return typeof ownerLogin === "string" && typeof name === "string" && `${ownerLogin}/${name}` === repository && typeof number === "number" && Number.isSafeInteger(number) && number > 0 ? number : void 0;
}
function parseGithubEvidence(value, onInvalid = () => {
}) {
  if (!value || typeof value !== "object") throw new Error("github-payload-invalid");
  const raw = value;
  if (!Array.isArray(raw.issues) || !Array.isArray(raw.prs)) throw new Error("github-payload-invalid");
  let complete = raw.issues.length < SNAPSHOT_LIMIT && raw.prs.length < SNAPSHOT_LIMIT;
  const issues = raw.issues.flatMap((item, index) => {
    if (!item || typeof item !== "object") {
      onInvalid(`issue-${index}`);
      complete = false;
      return [];
    }
    const issue = item;
    const labels = githubLabels(issue.labels);
    const updatedAt = timestamp(issue.updatedAt);
    if (typeof issue.number !== "number" || typeof issue.title !== "string" || !labels || updatedAt === void 0) {
      onInvalid(`issue-${index}`);
      complete = false;
      return [];
    }
    return [{ number: issue.number, title: issue.title, labels, updatedAt }];
  });
  const prs = raw.prs.flatMap((item, index) => {
    if (!item || typeof item !== "object") {
      onInvalid(`pr-${index}`);
      complete = false;
      return [];
    }
    const pr = item;
    const checks = githubChecks(pr.statusCheckRollup);
    const updatedAt = timestamp(pr.updatedAt);
    const closingIssues = pr.closingIssuesReferences;
    const closingIssueNumber = typeof raw.repository === "string" && Array.isArray(closingIssues) && closingIssues.length === 1 ? githubClosingIssueNumber(closingIssues[0], raw.repository) : void 0;
    if (typeof pr.number !== "number" || !Number.isSafeInteger(pr.number) || typeof pr.state !== "string" || typeof pr.mergeStateStatus !== "string" || typeof pr.reviewDecision !== "string" || typeof pr.headRefOid !== "string" || !Array.isArray(pr.reviews) || !checks || updatedAt === void 0 || closingIssueNumber === void 0) {
      onInvalid(`pr-${index}`);
      complete = false;
      return [];
    }
    const ready = pr.state === "OPEN" && pr.mergeStateStatus === "CLEAN" && pr.reviewDecision === "" && pr.reviews.length === 0 && checks.length > 0 && checks.every((check) => check === "SUCCESS");
    return [{ number: pr.number, closingIssueNumber, headSha: pr.headRefOid, updatedAt, ready }];
  });
  return { issues, prs, complete };
}
function queuedFirstLine(message) {
  return message.content.find((part) => part.type === "text")?.text.split("\n", 1)[0]?.slice(0, 200) ?? "(non-text obligation)";
}
function parseQueuedEvidence(value, onInvalid = () => {
}) {
  if (!Array.isArray(value)) throw new Error("queue-payload-invalid");
  let complete = value.length < SNAPSHOT_LIMIT;
  const messages = value.flatMap((item, index) => {
    if (!item || typeof item !== "object") {
      onInvalid(`queue-${index}`);
      complete = false;
      return [];
    }
    const message = item;
    const contentValid = Array.isArray(message.content) && message.content.every((part) => part && typeof part === "object" && (part.type !== "text" || typeof part.text === "string"));
    if (typeof message.id !== "string" || typeof message.createdAt !== "number" || typeof message.updatedAt !== "number" || !contentValid) {
      onInvalid(`queue-${index}`);
      complete = false;
      return [];
    }
    return [message];
  });
  return { messages, complete };
}
function extractCandidates(snapshot) {
  const { projectId, canonical, githubIssues, githubPrs, observedAt, cycleStartedAt } = snapshot;
  if (canonical.projectId !== projectId) return [];
  const candidates = [];
  const sourcesKnown = (...sources) => sources.every((source) => (snapshot.sourceCoverage?.[source] ?? (snapshot.coverage === "known" ? "known" : "blind")) === "known");
  const activeAttempts = canonical.executionAttempts.filter((attempt) => attempt.project_id === projectId && ACTIVE.includes(attempt.state));
  const startableNumbers = new Set(githubIssues.filter((issue) => issue.labels.includes("queue:startable")).map((issue) => issue.number));
  const projectWorkItems = canonical.workItems.filter((workItem) => workItem.project_id === projectId);
  const projectRefs = canonical.externalWorkRefs.filter((row) => row.project_id === projectId);
  for (const workItem of sourcesKnown("canonical", "github") ? projectWorkItems : []) {
    const ref = projectRefs.find((row) => row.work_item_id === workItem.work_item_id && row.provider === "github" && typeof row.issue_number === "number");
    if (workItem.lifecycle_state !== "ready" || !ref || !startableNumbers.has(ref.issue_number) || activeAttempts.some((attempt) => attempt.work_item_id === workItem.work_item_id)) continue;
    const anchors = { projectId, kind: "work_item", workItemId: String(workItem.work_item_id), resourceRevision: Number(workItem.resource_revision) };
    candidates.push({ id: `${projectId}:work-item:${anchors.workItemId}:${anchors.resourceRevision}`, kind: anchors.kind, anchors, finding: `Work item ${anchors.workItemId} (revision ${anchors.resourceRevision}; issue #${ref.issue_number}) is queue:startable with zero active attempts.`, evidence: { projectId, lifecycleState: workItem.lifecycle_state, issueNumber: ref.issue_number, activeAttemptCount: 0 } });
  }
  for (const attempt of sourcesKnown("canonical", "timeline") ? activeAttempts : []) {
    if (attempt.origin !== "work_item" || typeof attempt.execution_attempt_id !== "string" || typeof attempt.observed_at_ms !== "number" || observedAt - attempt.observed_at_ms < STALE_ATTEMPT_MS) continue;
    const anchors = { projectId, kind: "attempt", executionAttemptId: attempt.execution_attempt_id };
    candidates.push({ id: `${projectId}:attempt:${anchors.executionAttemptId}`, kind: anchors.kind, anchors, finding: `Active attempt ${anchors.executionAttemptId} for work item ${String(attempt.work_item_id)} has produced no canonical evidence for at least ten minutes.`, evidence: { projectId, workItemId: attempt.work_item_id, state: attempt.state, observedAtMs: attempt.observed_at_ms } });
  }
  for (const pr of sourcesKnown("canonical", "github") ? githubPrs : []) {
    if (!pr.ready || observedAt - pr.updatedAt < DECISION_THRESHOLD_MS) continue;
    const linkedWorkItems = projectRefs.filter((ref) => ref.provider === "github" && ref.issue_number === pr.closingIssueNumber).map((ref) => projectWorkItems.find((workItem) => workItem.work_item_id === ref.work_item_id)).filter((workItem) => workItem !== void 0);
    if (linkedWorkItems.length !== 1) continue;
    const workItemId = linkedWorkItems[0].work_item_id;
    const runningReview = activeAttempts.some(
      (attempt) => attempt.origin === "work_item" && attempt.work_item_id === workItemId && attempt.assignment_kind === "review" && attempt.review_pr_number === pr.number && attempt.review_pr_head_sha === pr.headSha
    );
    if (runningReview) continue;
    const anchors = { projectId, kind: "pull_request", number: pr.number, headSha: pr.headSha };
    candidates.push({ id: `${projectId}:pr:${pr.number}:${pr.headSha}`, kind: anchors.kind, anchors, finding: `PR #${pr.number} at ${pr.headSha} is green, mergeable, decisionless, and unchanged past the five-minute decision threshold.`, evidence: { projectId, workItemId, closingIssueNumber: pr.closingIssueNumber, updatedAt: pr.updatedAt } });
  }
  const queueCutoff = cycleStartedAt ?? observedAt - DECISION_THRESHOLD_MS;
  for (const message of sourcesKnown("queue", "timeline") ? snapshot.queued : []) {
    if (message.createdAt >= queueCutoff) continue;
    const anchors = { projectId, kind: "queue_message", queueMessageId: message.id };
    candidates.push({ id: `${projectId}:queue:${message.id}`, kind: anchors.kind, anchors, finding: `Queued obligation ${message.id} remained unconsumed across the orchestrator cycle: "${queuedFirstLine(message)}".`, evidence: { projectId, createdAt: message.createdAt, updatedAt: message.updatedAt } });
  }
  return candidates;
}
function composeTimeline(latest, olderPages) {
  const rows = [...olderPages].reverse().flatMap((page) => page.rows).concat(latest.rows);
  const rowIndexes = /* @__PURE__ */ new Map();
  const deduplicated = rows.reduce((result, row) => {
    const index = rowIndexes.get(row.id);
    if (index === void 0) {
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
async function githubEvidence(remote) {
  const repo = remote?.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/u)?.[1];
  if (!repo) throw new Error("github-repository-unresolved");
  const [issues, prs] = await Promise.all([
    exec("gh", ["issue", "list", "--repo", repo, "--state", "open", "--label", "queue:startable", "--json", "number,title,labels,updatedAt", "--limit", String(SNAPSHOT_LIMIT)], { timeout: 1e4 }),
    exec("gh", ["pr", "list", "--repo", repo, "--state", "open", "--json", "number,title,state,mergeStateStatus,reviewDecision,headRefOid,reviews,statusCheckRollup,updatedAt,closingIssuesReferences", "--limit", String(SNAPSHOT_LIMIT)], { timeout: 1e4 })
  ]);
  return { repository: repo, issues: JSON.parse(issues.stdout), prs: JSON.parse(prs.stdout) };
}
var prompt = (projectId) => `Judge ONLY the verified candidates returned by ${TOOL}; do not discover or invent other work, and do not assert coverage because code computes it. Call the tool exactly once and do not mutate or message anything. If no candidate warrants a wake, output exactly SILENCE. Otherwise copy the selected candidate's id, anchors, and finding exactly into one line per candidate as FINDING: {"candidateId":"supplied id","anchors":supplied anchors,"finding":"supplied finding"}, followed by exactly ESCALATE: yes. Project: ${projectId}.`;
function companionWatcher(bb, readExport = readCanonicalExport, readGithub = githubEvidence, listProjects = async () => await bb.sdk.projects.list()) {
  const snapshots = /* @__PURE__ */ new Map();
  const companions = /* @__PURE__ */ new Map();
  const pending = /* @__PURE__ */ new Map();
  const candidateSnapshots = /* @__PURE__ */ new Map();
  const activeTurns = /* @__PURE__ */ new Map();
  const inFlight = /* @__PURE__ */ new Set();
  let loaded = false;
  let loadPromise;
  const load = () => {
    if (loaded) return Promise.resolve();
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      const saved = await bb.storage.kv.get("backoff");
      const savedCompanions = await bb.storage.kv.get("companions");
      if (saved) for (const [key, value] of Object.entries(saved)) snapshots.set(key, value);
      if (savedCompanions) for (const [key, value] of Object.entries(savedCompanions)) companions.set(key, value);
      loaded = true;
    })().finally(() => {
      loadPromise = void 0;
    });
    return loadPromise;
  };
  const canonical = async (projectId) => {
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
        const olderPages = [];
        for (let page = 1; recentTimeline.timelinePage.hasOlderRows && page < TIMELINE_PAGE_MAX; page += 1) {
          const cursor = recentTimeline.timelinePage.olderCursor;
          if (!cursor) break;
          recentTimeline = await bb.sdk.threads.timeline({ threadId: orchestratorId, segmentLimit: String(TIMELINE_PAGE_LIMIT), beforeAnchorSeq: String(cursor.anchorSeq), beforeAnchorId: cursor.anchorId });
          olderPages.push(recentTimeline);
        }
        recentTimeline = composeTimeline(latestTimeline, olderPages);
        const queuedFound = [];
        const queued = parseQueuedEvidence(await bb.sdk.threads.queuedMessages.list({ threadId: orchestratorId }), (reason) => queuedFound.push(reason));
        const { canonicalComplete, executionAttempts, externalWorkRefs, workItems, parseIssues } = snapshotCanonical(exported, queued.messages.length);
        if (parseIssues.length > 0) bb.log.warn(`companion-watcher coverage=partial event=snapshot reason=malformed-canonical-rows count=${parseIssues.length} fields=${parseIssues.join(",")}`);
        let githubIssues = [];
        let githubPrs = [];
        const sourceCoverage = {
          canonical: canonicalComplete ? "known" : "blind",
          timeline: recentTimeline.timelinePage.hasOlderRows ? "blind" : "known",
          github: "known",
          queue: queued.complete && queuedFound.length === 0 ? "known" : "blind"
        };
        let coverage = Object.values(sourceCoverage).every((value) => value === "known") ? "known" : "partial";
        if (recentTimeline.timelinePage.hasOlderRows) {
          bb.log.warn(`companion-watcher coverage=partial event=snapshot reason=timeline-${recentTimeline.timelinePage.olderCursor ? "ceiling" : "cursor-missing"}`);
        }
        if (sourceCoverage.queue === "blind") bb.log.warn(`companion-watcher coverage=partial event=snapshot reason=queue-population-incomplete details=${queuedFound.join(",") || "ceiling"}`);
        try {
          const githubIssuesFound = [];
          const github = parseGithubEvidence(await readGithub(project.gitRemoteUrl), (reason) => githubIssuesFound.push(reason));
          githubIssues = github.issues;
          githubPrs = github.prs;
          if (!github.complete || githubIssuesFound.length > 0) {
            sourceCoverage.github = "blind";
            coverage = "partial";
            bb.log.warn(`companion-watcher coverage=partial event=snapshot reason=github-population-incomplete details=${githubIssuesFound.join(",") || "ceiling"}`);
          }
        } catch (error) {
          sourceCoverage.github = "blind";
          coverage = "blind";
          bb.log.warn(`companion-watcher coverage=blind event=snapshot reason=${String(error)}`);
        }
        const snapshot = { projectId: context.projectId, canonical: { ...exported, executionAttempts, externalWorkRefs, workItems }, queued: queued.messages.slice(0, SNAPSHOT_LIMIT), githubIssues, githubPrs, coverage, sourceCoverage, observedAt: Date.now(), cycleStartedAt: pending.get(context.threadId)?.turnStartedAt };
        candidateSnapshots.set(context.threadId, snapshot);
        return JSON.stringify({ coverage, candidates: extractCandidates(snapshot) });
      } catch (error) {
        const reason = String(error);
        bb.log.warn(`companion-watcher coverage=blind event=snapshot reason=${reason}`);
        return { isError: true, content: [{ type: "text", text: `COVERAGE: blind
snapshot read failed: ${reason}` }] };
      }
    }
  });
  bb.agents.configure((context) => context.origin.pluginId === bb.pluginId && context.thread.title === TITLE ? { tools: [TOOL], skills: [] } : { tools: [], skills: [] });
  const judge = async (projectId, orchestratorId, turnStartedAt) => {
    await load();
    if ([...pending.values()].some((request) => request.projectId === projectId)) return;
    let threadId = companions.get(projectId);
    if (threadId) {
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        if (thread.projectId !== projectId) {
          companions.delete(projectId);
          threadId = void 0;
        } else if (thread.status !== "idle") return;
      } catch {
        companions.delete(projectId);
        threadId = void 0;
      }
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
  const handleJudgment = async (threadId, projectId, output) => {
    const request = pending.get(threadId);
    if (!request || request.projectId !== projectId) {
      if (request) bb.log.warn(`companion-watcher coverage=blind event=post-check reason=project-mismatch expected=${request.projectId} actual=${projectId}`);
      return;
    }
    let route;
    try {
      const snapshot = candidateSnapshots.get(threadId);
      candidateSnapshots.delete(threadId);
      if (!snapshot) {
        bb.log.warn("companion-watcher coverage=blind event=post-check reason=snapshot-missing");
        return;
      }
      if (snapshot.projectId !== request.projectId || snapshot.canonical.projectId !== request.projectId) {
        bb.log.warn(`companion-watcher coverage=blind event=post-check reason=project-mismatch expected=${request.projectId} actual=${snapshot.projectId}`);
        return;
      }
      const judgment = parseJudgment(output, snapshot, (reason) => bb.log.warn(`companion-watcher coverage=${snapshot.coverage} event=post-check reason=${reason}`));
      const prior = snapshots.get(request.projectId);
      const now = Date.now();
      route = routeJudgment(prior, judgment, now, request.turnStartedAt);
      bb.log.info(`companion-watcher coverage=${judgment.coverage} event=judgment illegitimate=${judgment.illegitimate} route=${route ?? "silence"}`);
      if (!route) return;
      const exported = await canonical(request.projectId);
      const target = route === "director" ? readRoleThread(exported, request.projectId, "director") : readRoleThread(exported, request.projectId, "project-orchestrator");
      if (!target || route === "orchestrator" && target !== request.orchestratorId) throw new Error(`${route}-head-unresolved`);
      await bb.sdk.threads.send({ threadId: target, mode: "auto", input: [{ type: "text", text: `Alzheimer companion ${route === "director" ? "escalation" : "wake"}: ${judgment.findings} (coverage: ${judgment.coverage}).`, mentions: [] }] });
      snapshots.set(request.projectId, { sentAt: now, fingerprint: judgment.fingerprint, escalatedAt: route === "director" ? now : prior?.fingerprint === judgment.fingerprint ? prior.escalatedAt : void 0 });
      await bb.storage.kv.set("backoff", Object.fromEntries(snapshots));
    } catch (error) {
      bb.log.warn(`companion-watcher coverage=blind event=${route} reason=${String(error)}`);
    } finally {
      pending.delete(threadId);
    }
  };
  bb.events.on("thread.active", ({ thread }) => {
    activeTurns.set(thread.id, Date.now());
  });
  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    if (pending.has(thread.id)) {
      await handleJudgment(thread.id, thread.projectId, lastAssistantText ?? "");
      return;
    }
    const turnStartedAt = activeTurns.get(thread.id);
    activeTurns.delete(thread.id);
    let projects;
    try {
      projects = await listProjects();
    } catch (error) {
      bb.log.warn(`companion-watcher coverage=blind event=project-inventory reason=${String(error)}`);
      return;
    }
    const project = projects.find((candidate) => candidate.id === thread.projectId);
    if (!project) return;
    let acquired = false;
    try {
      const exported = await canonical(project.id);
      const orchestratorId = readRoleThread(exported, project.id, "project-orchestrator");
      if (thread.id !== orchestratorId || !shouldJudgeOnIdle(exported, project.id, Date.now())) return;
      if (inFlight.has(project.id)) return;
      inFlight.add(project.id);
      acquired = true;
      await judge(project.id, orchestratorId, turnStartedAt);
    } catch (error) {
      bb.log.warn(`companion-watcher coverage=blind event=thread.idle project=${project.id} reason=${String(error)}`);
    } finally {
      if (acquired) inFlight.delete(project.id);
    }
  });
}
export {
  composeTimeline,
  companionWatcher as default,
  extractCandidates,
  hasActiveWorkers,
  parseCanonicalExport,
  parseGithubEvidence,
  parseJudgment,
  parseQueuedEvidence,
  readCanonicalExport,
  readRoleThread,
  routeJudgment,
  shouldJudgeOnIdle,
  snapshotCanonical
};
//# sourceMappingURL=server.js.map
