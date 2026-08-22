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
var ESCALATION_HOLD_MS = 24 * 60 * 6e4;
var SNAPSHOT_LIMIT = 200;
var TOOL = "companion_read_snapshot";
var TITLE = "Alzheimer companion judgment";
var REQUIRED_FIELDS = {
  execution_attempts: {
    execution_attempt_id: (value) => typeof value === "string",
    observed_at_ms: (value) => typeof value === "number",
    origin: (value) => typeof value === "string",
    project_id: (value) => typeof value === "string",
    state: (value) => typeof value === "string",
    thread_id: (value) => typeof value === "string",
    work_item_id: (value) => value === null || typeof value === "string"
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
    updated_at_ms: (value) => typeof value === "number"
  }
};
function parseJudgment(output) {
  const coverages = [...output.matchAll(/^COVERAGE:\s*(known|partial|blind)\s*$/gimu)];
  const escalations = [...output.matchAll(/^ESCALATE:\s*yes\s*$/gimu)];
  const findings = [...output.matchAll(/^FINDING:\s*(.+)\s*$/gimu)].map((match) => match[1].trim());
  const coverage = coverages.length === 1 ? coverages[0][1].toLowerCase() : "blind";
  const illegitimate = escalations.length === 1 && findings.length > 0;
  const text = findings.join("; ").slice(0, 8e3);
  return { coverage, illegitimate, findings: text, fingerprint: text.toLowerCase() };
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
    roleGenerationHeads: tables.get("role_generation_heads") ?? [],
    roleGenerations: tables.get("role_generations") ?? [],
    workItems: tables.get("work_items") ?? []
  };
  const counts = manifest.tableCounts;
  for (const [table, rows] of [["execution_attempts", canonical.executionAttempts], ["role_generation_heads", canonical.roleGenerationHeads], ["role_generations", canonical.roleGenerations], ["work_items", canonical.workItems]]) {
    if (counts[table] !== rows.length) throw new Error(`canonical-export-${table}-count-mismatch`);
    for (const row of rows) {
      for (const [field, valid] of Object.entries(REQUIRED_FIELDS[table])) {
        if (!valid(row[field])) throw new Error(`canonical-export-${table}-${field}-invalid`);
      }
    }
  }
  const head = canonical.roleGenerationHeads.find((row) => row.project_id === projectId && row.role_id === "project-orchestrator");
  if (!head) throw new Error("canonical-export-orchestrator-head-missing");
  if (!readRoleThread(canonical, projectId, "project-orchestrator")) throw new Error("canonical-export-orchestrator-thread-unresolved");
  return canonical;
}
async function readCanonicalExport(projectId, exportRoot) {
  const { stdout } = await exec(process.env.BB_CLI?.trim() || "bb", ["collab", "export", "--project", projectId], { timeout: 1e4 });
  return parseCanonicalExport(stdout, exportRoot, projectId);
}
function readRoleThread(canonical, projectId, roleId) {
  const head = canonical.roleGenerationHeads.find((row) => row.project_id === projectId && row.role_id === roleId);
  const generation = canonical.roleGenerations.find((row) => row.project_id === projectId && row.role_id === roleId && row.generation === head?.current_generation);
  return canonical.executionAttempts.find((row) => row.project_id === projectId && row.execution_attempt_id === generation?.holder_execution_attempt_id)?.thread_id;
}
function hasActiveWorkers(canonical, projectId) {
  return canonical.executionAttempts.some((row) => row.project_id === projectId && row.work_item_id != null && row.origin === "work_item" && ACTIVE.includes(row.state));
}
function snapshotCanonical(canonical, queuedCount) {
  const executionAttempts = [...canonical.executionAttempts].sort((a, b) => Number(b.observed_at_ms) - Number(a.observed_at_ms)).slice(0, SNAPSHOT_LIMIT);
  const workItems = [...canonical.workItems].sort((a, b) => Number(b.updated_at_ms) - Number(a.updated_at_ms)).slice(0, SNAPSHOT_LIMIT);
  const coverage = queuedCount >= SNAPSHOT_LIMIT || canonical.executionAttempts.length > SNAPSHOT_LIMIT || canonical.workItems.length > SNAPSHOT_LIMIT ? "partial" : "known";
  return { coverage, executionAttempts, workItems };
}
async function githubEvidence(remote) {
  const repo = remote?.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/u)?.[1];
  if (!repo) throw new Error("github-repository-unresolved");
  const { stdout } = await exec("gh", ["pr", "list", "--repo", repo, "--state", "open", "--json", "number,title,state,mergeStateStatus,reviewDecision,headRefOid,statusCheckRollup", "--limit", String(SNAPSHOT_LIMIT)], { timeout: 1e4 });
  return JSON.parse(stdout);
}
var prompt = (projectId) => `Judge whether the project orchestrator's current idleness is illegitimate: compare its stated intentions with outcomes and identify undone stated work or work parked without cause. Call ${TOOL} exactly once; do not infer liveness from silence and do not mutate or message anything. Output exactly one anchored line COVERAGE: known|partial|blind. If and only if idleness is illegitimate, add one or more anchored FINDING: lines and the optional anchored affirmative line ESCALATE: yes. Project: ${projectId}.`;
function companionWatcher(bb, readExport = readCanonicalExport) {
  const snapshots = /* @__PURE__ */ new Map();
  const companions = /* @__PURE__ */ new Map();
  const pending = /* @__PURE__ */ new Map();
  const activeTurns = /* @__PURE__ */ new Map();
  let loaded = false;
  const load = async () => {
    if (loaded) return;
    const saved = await bb.storage.kv.get("backoff");
    const savedCompanions = await bb.storage.kv.get("companions");
    if (saved) for (const [key, value] of Object.entries(saved)) snapshots.set(key, value);
    if (savedCompanions) for (const [key, value] of Object.entries(savedCompanions)) companions.set(key, value);
    loaded = true;
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
        const recentTimeline = await bb.sdk.threads.timeline({ threadId: orchestratorId, segmentLimit: String(SNAPSHOT_LIMIT) });
        const queued = await bb.sdk.threads.queuedMessages.list({ threadId: orchestratorId });
        const { coverage: canonicalCoverage, executionAttempts, workItems } = snapshotCanonical(exported, queued.length);
        let github;
        let coverage = canonicalCoverage;
        try {
          github = await githubEvidence(project.gitRemoteUrl);
        } catch (error) {
          coverage = "blind";
          github = { error: String(error) };
        }
        return JSON.stringify({ coverage, orchestratorId, recentTimeline, queued: queued.slice(0, SNAPSHOT_LIMIT), executionAttempts, workItems, github });
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
    let threadId = companions.get(projectId);
    if (threadId) {
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        if (thread.projectId !== projectId || thread.status !== "idle") return;
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
  const handleJudgment = async (threadId, output) => {
    const request = pending.get(threadId);
    if (!request) return;
    pending.delete(threadId);
    const judgment = parseJudgment(output);
    const prior = snapshots.get(request.projectId);
    const now = Date.now();
    const route = routeJudgment(prior, judgment, now, request.turnStartedAt);
    bb.log.info(`companion-watcher coverage=${judgment.coverage} event=judgment illegitimate=${judgment.illegitimate} route=${route ?? "silence"}`);
    if (!route) return;
    try {
      const exported = await canonical(request.projectId);
      const target = route === "director" ? readRoleThread(exported, request.projectId, "director") : readRoleThread(exported, request.projectId, "project-orchestrator");
      if (!target || route === "orchestrator" && target !== request.orchestratorId) throw new Error(`${route}-head-unresolved`);
      await bb.sdk.threads.send({ threadId: target, mode: "auto", input: [{ type: "text", text: `Alzheimer companion ${route === "director" ? "escalation" : "wake"}: ${judgment.findings} (coverage: ${judgment.coverage}).`, mentions: [] }] });
      snapshots.set(request.projectId, { sentAt: now, fingerprint: judgment.fingerprint, escalatedAt: route === "director" ? now : prior?.fingerprint === judgment.fingerprint ? prior.escalatedAt : void 0 });
      await bb.storage.kv.set("backoff", Object.fromEntries(snapshots));
    } catch (error) {
      bb.log.warn(`companion-watcher coverage=blind event=${route} reason=${String(error)}`);
    }
  };
  bb.events.on("thread.active", ({ thread }) => {
    activeTurns.set(thread.id, Date.now());
  });
  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    if (pending.has(thread.id)) {
      await handleJudgment(thread.id, lastAssistantText ?? "");
      return;
    }
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
export {
  companionWatcher as default,
  hasActiveWorkers,
  parseCanonicalExport,
  parseJudgment,
  readCanonicalExport,
  readRoleThread,
  routeJudgment,
  snapshotCanonical
};
//# sourceMappingURL=server.js.map
