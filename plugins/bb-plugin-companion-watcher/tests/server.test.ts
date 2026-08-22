import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BbPluginApi } from "@bb/plugin-sdk";
import { describe, expect, it } from "vitest";
import companionWatcher, { composeTimeline, extractCandidates, hasActiveWorkers, parseCanonicalExport, parseGithubEvidence, parseJudgment, parseQueuedEvidence, readRoleThread, routeJudgment, snapshotCanonical, type CandidateSnapshot } from "../server.js";

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const projectId = "proj_a8zzfsx36j";
const affirmative = { coverage: "known" as const, illegitimate: true, findings: "verified finding", fingerprint: "candidate-1" };

async function capturedExport() {
  return parseCanonicalExport(await readFile(join(fixtureRoot, "live-export.json"), "utf8"), fixtureRoot, projectId);
}

const inlineExport = (recordsNdjson: string, tableCounts: Record<string, number>) => JSON.stringify({
  outcome: "OK",
  export: { recordsNdjson, manifest: { projectId, tableCounts: { external_work_refs: 0, ...tableCounts } } },
});

async function emptySnapshot(overrides: Partial<CandidateSnapshot> = {}): Promise<CandidateSnapshot> {
  return { projectId, canonical: await capturedExport(), queued: [], githubIssues: [], githubPrs: [], coverage: "known", observedAt: 1_000_000, ...overrides };
}

const queuedMessage = (id: string, createdAt = 1) => ({ id, content: [{ type: "text" as const, text: "merge the verified head", mentions: [] }], model: "gpt", reasoningLevel: "medium" as const, permissionMode: "auto" as const, serviceTier: "default" as const, groupWithNext: false, createdAt, updatedAt: createdAt });

describe("semantic idle guard", () => {
  it("parses only verified candidate anchors and takes coverage from code", async () => {
    const snapshot = await emptySnapshot({ queued: [queuedMessage("queue-1")], cycleStartedAt: 2 });
    const candidate = extractCandidates(snapshot)[0]!;
    const line = `FINDING: ${JSON.stringify({ candidateId: candidate.id, anchors: candidate.anchors, finding: candidate.finding })}\nESCALATE: yes`;
    expect(parseJudgment(line, snapshot)).toMatchObject({ illegitimate: true, coverage: "known" });
    expect(parseJudgment("COVERAGE: known\nFINDING: parked\nESCALATE: yes", snapshot)).toMatchObject({ illegitimate: false, coverage: "known" });
    expect(parseJudgment("SILENCE", { ...snapshot, coverage: "partial" })).toMatchObject({ illegitimate: false, coverage: "partial" });
  });

  it("extracts a real queue:startable zero-attempt candidate with stable anchors", async () => {
    const base = await capturedExport();
    const workItem = { ...base.workItems[0], work_item_id: "wi-gh-560", lifecycle_state: "ready", resource_revision: 3 };
    const snapshot = await emptySnapshot({
      canonical: { ...base, workItems: [workItem], externalWorkRefs: [{ project_id: projectId, work_item_id: "wi-gh-560", provider: "github", issue_number: 560 }] },
      githubIssues: [{ number: 560, title: "Companion architecture", labels: ["queue:startable"], updatedAt: 1 }],
    });
    expect(extractCandidates(snapshot)).toEqual([expect.objectContaining({ id: `${projectId}:work-item:wi-gh-560:3`, anchors: { projectId, kind: "work_item", workItemId: "wi-gh-560", resourceRevision: 3 }, evidence: { projectId, lifecycleState: "ready", issueNumber: 560, activeAttemptCount: 0 } })]);
  });

  it("excludes the captured wi-gh-141 wrongful-idle control", async () => {
    const base = await capturedExport();
    const control = { ...base.workItems[0], work_item_id: "wi-gh-141", lifecycle_state: "ready", resource_revision: 2 };
    const writers = [560, 564].map((issue) => ({
      ...base.executionAttempts[1],
      execution_attempt_id: `attempt-gh${issue}`,
      observed_at_ms: 1_000_000,
      state: "running",
      work_item_id: `wi-gh-${issue}`,
    }));
    const snapshot = await emptySnapshot({
      canonical: {
        ...base,
        executionAttempts: [base.executionAttempts[0]!, ...writers],
        workItems: [control],
        externalWorkRefs: [{ project_id: projectId, work_item_id: "wi-gh-141", provider: "github", issue_number: 141 }],
      },
      githubIssues: [
        { number: 141, title: "Legacy queue head", labels: ["queue:blocked"], updatedAt: 1 },
        { number: 560, title: "Companion architecture", labels: ["queue:startable"], updatedAt: 1 },
        { number: 564, title: "Other active writer", labels: ["queue:startable"], updatedAt: 1 },
      ],
    });
    const dropped: string[] = [];
    const falseClaim = `FINDING: ${JSON.stringify({ candidateId: "work-item:wi-gh-141:2", anchors: { kind: "work_item", workItemId: "wi-gh-141", resourceRevision: 2 }, finding: "Wrongful idle: queue head wi-gh-141 is startable. Inspect the queue and act or record the blocker." })}\nESCALATE: yes`;
    expect(hasActiveWorkers(snapshot.canonical, projectId)).toBe(true);
    expect(extractCandidates(snapshot)).toEqual([]);
    expect(parseJudgment(falseClaim, snapshot, (reason) => dropped.push(reason))).toMatchObject({ illegitimate: false, coverage: "known" });
    expect(dropped).toEqual(["unknown-candidate"]);
  });

  it("drops fabricated and stale anchors while retaining and routing a valid finding", async () => {
    const snapshot = await emptySnapshot({ queued: [queuedMessage("queue-1")], cycleStartedAt: 2 });
    const candidate = extractCandidates(snapshot)[0]!;
    const dropped: string[] = [];
    const output = [
      `FINDING: ${JSON.stringify({ candidateId: "queue-fabricated", anchors: { kind: "queue_message", queueMessageId: "fake" }, finding: "invented" })}`,
      `FINDING: ${JSON.stringify({ candidateId: candidate.id, anchors: { kind: "queue_message", queueMessageId: "stale" }, finding: "stale" })}`,
      `FINDING: ${JSON.stringify({ candidateId: candidate.id, anchors: candidate.anchors, finding: "The obligation was already completed." })}`,
      `FINDING: ${JSON.stringify({ candidateId: candidate.id, anchors: candidate.anchors, finding: candidate.finding })}`,
      "ESCALATE: yes",
    ].join("\n");
    const judgment = parseJudgment(output, snapshot, (reason) => dropped.push(reason));
    expect(dropped).toEqual(["unknown-candidate", "anchor-mismatch", "claim-mismatch"]);
    expect(judgment).toMatchObject({ illegitimate: true, findings: expect.stringContaining('"queueMessageId":"queue-1"') });
    expect(routeJudgment(undefined, judgment, 10)).toBe("orchestrator");
  });

  it("extracts stale active-attempt and queue anchors at their established bounds", async () => {
    const base = await capturedExport();
    const stale = { ...base.executionAttempts[1], execution_attempt_id: "attempt-stale", state: "running", origin: "work_item", observed_at_ms: 399_999 };
    const snapshot = await emptySnapshot({ canonical: { ...base, executionAttempts: [base.executionAttempts[0]!, stale] }, queued: [queuedMessage("queue-old", 10)], observedAt: 1_000_000, cycleStartedAt: 20 });
    expect(extractCandidates(snapshot).map((candidate) => candidate.anchors)).toEqual([
      { projectId, kind: "attempt", executionAttemptId: "attempt-stale" },
      { projectId, kind: "queue_message", queueMessageId: "queue-old" },
    ]);
  });

  it("binds the realistic green decisionless PR shape to its exact head and drops head drift", async () => {
    const head = "a".repeat(40);
    const nextHead = "b".repeat(40);
    const parsed = parseGithubEvidence({ issues: [], prs: [{ number: 566, title: "Ready", state: "OPEN", mergeStateStatus: "CLEAN", reviewDecision: "", headRefOid: head, reviews: [], statusCheckRollup: [{ conclusion: "SUCCESS" }], updatedAt: "1970-01-01T00:00:01.000Z" }] });
    const snapshot = await emptySnapshot({ githubPrs: parsed.prs, observedAt: 1_000_000 });
    const candidate = extractCandidates(snapshot)[0]!;
    expect(candidate).toMatchObject({ anchors: { kind: "pull_request", number: 566, headSha: head }, finding: expect.stringContaining("green, mergeable, decisionless") });
    const drops: string[] = [];
    const drifted = parseJudgment(`FINDING: ${JSON.stringify({ candidateId: `${projectId}:pr:566:${nextHead}`, anchors: { projectId, kind: "pull_request", number: 566, headSha: nextHead }, finding: "stale head" })}\nESCALATE: yes`, snapshot, (reason) => drops.push(reason));
    expect(drifted.illegitimate).toBe(false);
    expect(drops).toEqual(["unknown-candidate"]);
  });

  it("keeps duplicate tenant identifiers and findings isolated", async () => {
    const base = await capturedExport();
    const projectB = "proj_two";
    const workItem = { ...base.workItems[0], work_item_id: "wi-shared", lifecycle_state: "ready", resource_revision: 3 };
    const make = (id: string) => emptySnapshot({
      projectId: id,
      canonical: { ...base, projectId: id, workItems: [workItem], externalWorkRefs: [{ project_id: id, work_item_id: "wi-shared", provider: "github", issue_number: 591 }] },
      githubIssues: [{ number: 591, title: "Shared number", labels: ["queue:startable"], updatedAt: 1 }],
    });
    const a = await make(projectId);
    const b = await make(projectB);
    const aCandidate = extractCandidates(a)[0]!;
    const bCandidate = extractCandidates(b)[0]!;
    expect(aCandidate.id).not.toBe(bCandidate.id);
    expect(aCandidate.anchors.projectId).toBe(projectId);
    expect(bCandidate.anchors.projectId).toBe(projectB);
    const drops: string[] = [];
    const crossProject = parseJudgment(`FINDING: ${JSON.stringify({ candidateId: aCandidate.id, anchors: aCandidate.anchors, finding: aCandidate.finding })}\nESCALATE: yes`, b, (reason) => drops.push(reason));
    expect(crossProject.illegitimate).toBe(false);
    expect(drops).toEqual(["unknown-candidate"]);
  });

  it("fails closed per incomplete source through post-check and routing", async () => {
    const base = await capturedExport();
    const workItem = { ...base.workItems[0], work_item_id: "wi-gh-560", lifecycle_state: "ready", resource_revision: 5 };
    const stale = { ...base.executionAttempts[1], execution_attempt_id: "attempt-stale", observed_at_ms: 399_999, state: "running", work_item_id: "wi-gh-560" };
    const head = "a".repeat(40);
    const github = parseGithubEvidence({ issues: [{ number: 560, title: "Ready", labels: [{ name: "queue:startable" }], updatedAt: "1970-01-01T00:00:01.000Z" }], prs: [{ number: 566, title: "Ready", state: "OPEN", mergeStateStatus: "CLEAN", reviewDecision: "", headRefOid: head, reviews: [], statusCheckRollup: [{ conclusion: "SUCCESS" }], updatedAt: "1970-01-01T00:00:01.000Z" }] });
    const known = { canonical: "known", timeline: "known", github: "known", queue: "known" } as const;
    const snapshots = {
      canonical: await emptySnapshot({ canonical: { ...base, executionAttempts: [base.executionAttempts[0]!], workItems: [workItem], externalWorkRefs: [{ project_id: projectId, work_item_id: "wi-gh-560", provider: "github", issue_number: 560 }] }, githubIssues: github.issues, sourceCoverage: known }),
      timeline: await emptySnapshot({ canonical: { ...base, executionAttempts: [base.executionAttempts[0]!, stale] }, sourceCoverage: known }),
      github: await emptySnapshot({ githubPrs: github.prs, sourceCoverage: known }),
      queue: await emptySnapshot({ queued: [queuedMessage("queue-old", 1)], cycleStartedAt: 2, sourceCoverage: known }),
    };
    for (const [source, snapshot] of Object.entries(snapshots) as Array<[keyof typeof snapshots, CandidateSnapshot]>) {
      const candidate = extractCandidates(snapshot)[0]!;
      const output = `FINDING: ${JSON.stringify({ candidateId: candidate.id, anchors: candidate.anchors, finding: candidate.finding })}\nESCALATE: yes`;
      const dropped: string[] = [];
      const incomplete = { ...snapshot, coverage: "partial" as const, sourceCoverage: { ...known, [source]: "blind" as const } };
      const judgment = parseJudgment(output, incomplete, (reason) => dropped.push(reason));
      expect({ source, candidate: candidate.kind, dropped, route: routeJudgment(undefined, judgment, 1) }).toEqual({ source, candidate: candidate.kind, dropped: ["unknown-candidate"], route: undefined });
    }
  });

  it("marks GitHub populations incomplete at the declared ceiling", () => {
    const issues = Array.from({ length: 200 }, (_, number) => ({ number: number + 1, title: `Issue ${number + 1}`, labels: [{ name: "queue:startable" }], updatedAt: "1970-01-01T00:00:01.000Z" }));
    expect(parseGithubEvidence({ issues, prs: [] }).complete).toBe(false);
  });

  it("marks queued populations blind at the declared ceiling or a malformed row", () => {
    expect(parseQueuedEvidence(Array.from({ length: 200 }, (_, index) => queuedMessage(`queue-${index}`))).complete).toBe(false);
    const invalid: string[] = [];
    expect(parseQueuedEvidence([{ id: "broken" }], (reason) => invalid.push(reason))).toEqual({ messages: [], complete: false });
    expect(invalid).toEqual(["queue-0"]);
  });

  it("parses the captured canonical export shape", async () => {
    const canonical = await capturedExport();
    expect(readRoleThread(canonical, projectId, "project-orchestrator")).toBe("thr_7bjw9e7mgd");
    expect(canonical.parseIssues).toEqual([]);
    expect(hasActiveWorkers(canonical, projectId)).toBe(true);
    expect(hasActiveWorkers({ ...canonical, executionAttempts: canonical.executionAttempts.filter((row) => row.state !== "running") }, projectId)).toBe(false);
  });

  it("production idle trigger judges stale attempts but defers for healthy active writers", async () => {
    const base = await capturedExport();
    const now = Date.now();
    let canonical = { ...base, executionAttempts: [base.executionAttempts[0]!, { ...base.executionAttempts[1], observed_at_ms: 0, state: "running" }] };
    let idle: ((event: { thread: { id: string; projectId: string }; lastAssistantText?: string }) => Promise<void>) | undefined;
    let spawns = 0;
    const bb = {
      pluginId: "companion-watcher",
      log: { info: () => undefined, warn: () => undefined },
      storage: { kv: { get: async () => undefined, set: async () => undefined } },
      agents: { registerTool: () => undefined, configure: () => undefined },
      sdk: {
        system: { config: async () => ({ dataDir: "/unused" }) },
        projects: { list: async () => [{ id: projectId, gitRemoteUrl: null }] },
        threads: {
          spawn: async () => { spawns += 1; return { id: "companion" }; },
          get: async () => ({ projectId, status: "idle" }),
          send: async () => undefined,
        },
      },
      events: { on: (event: string, handler: typeof idle) => { if (event === "thread.idle") idle = handler; } },
    } as unknown as BbPluginApi;
    companionWatcher(bb, async () => canonical, async () => ({ issues: [], prs: [] }));
    await idle!({ thread: { id: "thr_7bjw9e7mgd", projectId } });
    expect(spawns).toBe(1);
    canonical = { ...canonical, executionAttempts: [base.executionAttempts[0]!, { ...base.executionAttempts[1], observed_at_ms: now, state: "running" }] };
    await idle!({ thread: { id: "thr_7bjw9e7mgd", projectId } });
    expect(spawns).toBe(1);
  });

  it("keeps a concurrent holder event alive when a non-holder read is outstanding", async () => {
    const base = await capturedExport();
    const canonical = { ...base, executionAttempts: [base.executionAttempts[0]!, { ...base.executionAttempts[1], observed_at_ms: 0, state: "running" }] };
    let idle: ((event: { thread: { id: string; projectId: string }; lastAssistantText?: string }) => Promise<void>) | undefined;
    let readCount = 0;
    let releaseNonHolder!: (value: typeof canonical) => void;
    let markFirstRead!: () => void;
    const firstReadStarted = new Promise<void>((resolve) => { markFirstRead = resolve; });
    const nonHolderRead = new Promise<typeof canonical>((resolve) => { releaseNonHolder = resolve; });
    const spawned: string[] = [];
    const bb = {
      pluginId: "companion-watcher",
      log: { info: () => undefined, warn: () => undefined },
      storage: { kv: { get: async () => undefined, set: async () => undefined } },
      agents: { registerTool: () => undefined, configure: () => undefined },
      sdk: {
        system: { config: async () => ({ dataDir: "/unused" }) },
        projects: { list: async () => [{ id: projectId, gitRemoteUrl: null }] },
        threads: {
          spawn: async ({ projectId: id }: { projectId: string }) => { spawned.push(id); return { id: "companion" }; },
          get: async () => ({ projectId, status: "idle" }),
          send: async () => undefined,
        },
      },
      events: { on: (event: string, handler: typeof idle) => { if (event === "thread.idle") idle = handler; } },
    } as unknown as BbPluginApi;
    companionWatcher(bb, async () => {
      readCount += 1;
      if (readCount === 1) { markFirstRead(); return nonHolderRead; }
      return canonical;
    }, async () => ({ issues: [], prs: [] }));
    const nonHolder = idle!({ thread: { id: "thread-a-other", projectId } });
    await firstReadStarted;
    await idle!({ thread: { id: "thr_7bjw9e7mgd", projectId } });
    expect(spawned).toEqual([projectId]);
    releaseNonHolder(canonical);
    await nonHolder;
    expect(spawned).toEqual([projectId]);
  });

  it("replaces a persisted foreign companion but suppresses an active local one", async () => {
    const base = await capturedExport();
    const canonical = { ...base, executionAttempts: [base.executionAttempts[0]!, { ...base.executionAttempts[1], observed_at_ms: 0, state: "running" }] };
    const run = async (savedThreadId: string, companionProjectId: string, status: string) => {
      let idle: ((event: { thread: { id: string; projectId: string }; lastAssistantText?: string }) => Promise<void>) | undefined;
      const spawned: string[] = [];
      const bb = {
        pluginId: "companion-watcher",
        log: { info: () => undefined, warn: () => undefined },
        storage: { kv: { get: async (key: string) => key === "companions" ? { [projectId]: savedThreadId } : undefined, set: async () => undefined } },
        agents: { registerTool: () => undefined, configure: () => undefined },
        sdk: {
          system: { config: async () => ({ dataDir: "/unused" }) },
          projects: { list: async () => [{ id: projectId, gitRemoteUrl: null }] },
          threads: {
            spawn: async ({ projectId: id }: { projectId: string }) => { spawned.push(id); return { id: "replacement" }; },
            get: async () => ({ projectId: companionProjectId, status }),
            send: async () => undefined,
          },
        },
        events: { on: (event: string, handler: typeof idle) => { if (event === "thread.idle") idle = handler; } },
      } as unknown as BbPluginApi;
      companionWatcher(bb, async () => canonical, async () => ({ issues: [], prs: [] }));
      await idle!({ thread: { id: "thr_7bjw9e7mgd", projectId } });
      return spawned;
    };
    expect(await run("foreign-companion", "proj_foreign", "idle")).toEqual([projectId]);
    expect(await run("active-companion", projectId, "active")).toEqual([]);
  });

  it("does not consume a pending judgment from a wrong-project completion", async () => {
    const base = await capturedExport();
    const canonical = { ...base, executionAttempts: [base.executionAttempts[0]!, { ...base.executionAttempts[1], observed_at_ms: 0, state: "running" }] };
    let idle: ((event: { thread: { id: string; projectId: string }; lastAssistantText?: string }) => Promise<void>) | undefined;
    let tool: { execute(params: unknown, context: { threadId: string; projectId: string }): Promise<unknown> } | undefined;
    const sent: string[] = [];
    const bb = {
      pluginId: "companion-watcher",
      log: { info: () => undefined, warn: () => undefined },
      storage: { kv: { get: async () => undefined, set: async () => undefined } },
      agents: { registerTool: (value: typeof tool) => { tool = value; }, configure: () => undefined },
      sdk: {
        system: { config: async () => ({ dataDir: "/unused" }) },
        projects: { list: async () => [{ id: projectId, gitRemoteUrl: null }], get: async () => ({ gitRemoteUrl: null }) },
        threads: {
          spawn: async () => ({ id: "companion" }),
          get: async ({ threadId }: { threadId: string }) => threadId === "companion"
            ? { projectId, title: "Alzheimer companion judgment", originPluginId: "companion-watcher", status: "idle" }
            : { projectId, status: "idle" },
          send: async ({ threadId }: { threadId: string }) => { sent.push(threadId); },
          timeline: async () => ({ rows: [], timelinePage: { hasOlderRows: false, kind: "latest", segmentLimit: 100, returnedSegmentCount: 0, olderCursor: null }, maxSeq: 0 }),
          queuedMessages: { list: async () => [] },
        },
      },
      events: { on: (event: string, handler: typeof idle) => { if (event === "thread.idle") idle = handler; } },
    } as unknown as BbPluginApi;
    companionWatcher(bb, async () => canonical, async () => ({ issues: [], prs: [] }));
    await idle!({ thread: { id: "thr_7bjw9e7mgd", projectId } });
    const snapshot = JSON.parse(await tool!.execute({}, { threadId: "companion", projectId }) as string) as { candidates: Array<{ id: string; anchors: unknown; finding: string }> };
    const candidate = snapshot.candidates[0]!;
    const output = `FINDING: ${JSON.stringify({ candidateId: candidate.id, anchors: candidate.anchors, finding: candidate.finding })}\nESCALATE: yes`;
    await idle!({ thread: { id: "companion", projectId: "proj_foreign" }, lastAssistantText: output });
    expect(sent).toEqual([]);
    await idle!({ thread: { id: "companion", projectId }, lastAssistantText: output });
    expect(sent).toEqual(["thr_7bjw9e7mgd"]);
  });

  it("coalesces sequential repeated holder events through companion completion", async () => {
    const base = await capturedExport();
    const canonical = { ...base, executionAttempts: [base.executionAttempts[0]!, { ...base.executionAttempts[1], observed_at_ms: 0, state: "running" }] };
    let idle: ((event: { thread: { id: string; projectId: string }; lastAssistantText?: string }) => Promise<void>) | undefined;
    let sends = 0;
    let totalTurnRequests = 0;
    const bb = {
      pluginId: "companion-watcher",
      log: { info: () => undefined, warn: () => undefined },
      storage: { kv: { get: async (key: string) => key === "companions" ? { [projectId]: "companion" } : undefined, set: async () => undefined } },
      agents: { registerTool: () => undefined, configure: () => undefined },
      sdk: {
        system: { config: async () => ({ dataDir: "/unused" }) },
        projects: { list: async () => [{ id: projectId, gitRemoteUrl: null }] },
        threads: {
          spawn: async () => { totalTurnRequests += 1; return { id: "companion" }; },
          get: async () => ({ projectId, status: "idle" }),
          send: async () => { sends += 1; totalTurnRequests += 1; },
        },
      },
      events: { on: (event: string, handler: typeof idle) => { if (event === "thread.idle") idle = handler; } },
    } as unknown as BbPluginApi;
    companionWatcher(bb, async () => canonical, async () => ({ issues: [], prs: [] }));
    await idle!({ thread: { id: "thr_7bjw9e7mgd", projectId } });
    await idle!({ thread: { id: "thr_7bjw9e7mgd", projectId } });
    expect({ sends, totalTurnRequests }).toEqual({ sends: 1, totalTurnRequests: 1 });
  });

  it("coalesces concurrent repeated holder events while the send is outstanding", async () => {
    const base = await capturedExport();
    const canonical = { ...base, executionAttempts: [base.executionAttempts[0]!, { ...base.executionAttempts[1], observed_at_ms: 0, state: "running" }] };
    let idle: ((event: { thread: { id: string; projectId: string }; lastAssistantText?: string }) => Promise<void>) | undefined;
    let sends = 0;
    let markSendStarted!: () => void;
    let releaseSend!: () => void;
    const sendStarted = new Promise<void>((resolve) => { markSendStarted = resolve; });
    const sendResult = new Promise<void>((resolve) => { releaseSend = resolve; });
    const bb = {
      pluginId: "companion-watcher",
      log: { info: () => undefined, warn: () => undefined },
      storage: { kv: { get: async (key: string) => key === "companions" ? { [projectId]: "companion" } : undefined, set: async () => undefined } },
      agents: { registerTool: () => undefined, configure: () => undefined },
      sdk: {
        system: { config: async () => ({ dataDir: "/unused" }) },
        projects: { list: async () => [{ id: projectId, gitRemoteUrl: null }] },
        threads: {
          spawn: async () => ({ id: "companion" }),
          get: async () => ({ projectId, status: "idle" }),
          send: async () => { sends += 1; markSendStarted(); await sendResult; },
        },
      },
      events: { on: (event: string, handler: typeof idle) => { if (event === "thread.idle") idle = handler; } },
    } as unknown as BbPluginApi;
    companionWatcher(bb, async () => canonical, async () => ({ issues: [], prs: [] }));
    const first = idle!({ thread: { id: "thr_7bjw9e7mgd", projectId } });
    await sendStarted;
    const second = idle!({ thread: { id: "thr_7bjw9e7mgd", projectId } });
    await second;
    expect(sends).toBe(1);
    releaseSend();
    await first;
    expect(sends).toBe(1);
  });

  it("retries a repeated holder event after terminal companion failure", async () => {
    const base = await capturedExport();
    const canonical = { ...base, executionAttempts: [base.executionAttempts[0]!, { ...base.executionAttempts[1], observed_at_ms: 0, state: "running" }] };
    let idle: ((event: { thread: { id: string; projectId: string }; lastAssistantText?: string }) => Promise<void>) | undefined;
    let sends = 0;
    const bb = {
      pluginId: "companion-watcher",
      log: { info: () => undefined, warn: () => undefined },
      storage: { kv: { get: async (key: string) => key === "companions" ? { [projectId]: "companion" } : undefined, set: async () => undefined } },
      agents: { registerTool: () => undefined, configure: () => undefined },
      sdk: {
        system: { config: async () => ({ dataDir: "/unused" }) },
        projects: { list: async () => [{ id: projectId, gitRemoteUrl: null }] },
        threads: {
          spawn: async () => ({ id: "companion" }),
          get: async () => ({ projectId, status: "idle" }),
          send: async () => { sends += 1; if (sends === 1) throw new Error("companion timeout"); },
        },
      },
      events: { on: (event: string, handler: typeof idle) => { if (event === "thread.idle") idle = handler; } },
    } as unknown as BbPluginApi;
    companionWatcher(bb, async () => canonical, async () => ({ issues: [], prs: [] }));
    await idle!({ thread: { id: "thr_7bjw9e7mgd", projectId } });
    await idle!({ thread: { id: "thr_7bjw9e7mgd", projectId } });
    expect(sends).toBe(2);
  });

  it("releases coalescing after a terminal empty companion completion", async () => {
    const base = await capturedExport();
    const canonical = { ...base, executionAttempts: [base.executionAttempts[0]!, { ...base.executionAttempts[1], observed_at_ms: 0, state: "running" }] };
    let idle: ((event: { thread: { id: string; projectId: string }; lastAssistantText?: string }) => Promise<void>) | undefined;
    let spawns = 0;
    let sends = 0;
    const bb = {
      pluginId: "companion-watcher",
      log: { info: () => undefined, warn: () => undefined },
      storage: { kv: { get: async () => undefined, set: async () => undefined } },
      agents: { registerTool: () => undefined, configure: () => undefined },
      sdk: {
        system: { config: async () => ({ dataDir: "/unused" }) },
        projects: { list: async () => [{ id: projectId, gitRemoteUrl: null }] },
        threads: {
          spawn: async () => { spawns += 1; return { id: "companion" }; },
          get: async () => ({ projectId, status: "idle" }),
          send: async () => { sends += 1; },
        },
      },
      events: { on: (event: string, handler: typeof idle) => { if (event === "thread.idle") idle = handler; } },
    } as unknown as BbPluginApi;
    companionWatcher(bb, async () => canonical, async () => ({ issues: [], prs: [] }));
    await idle!({ thread: { id: "thr_7bjw9e7mgd", projectId } });
    await idle!({ thread: { id: "companion", projectId } });
    await idle!({ thread: { id: "thr_7bjw9e7mgd", projectId } });
    expect({ spawns, sends }).toEqual({ spawns: 1, sends: 1 });
  });

  it("keeps project failure isolation on independent project-scoped events", async () => {
    const base = await capturedExport();
    const projectB = "proj_two";
    const projectBExport = {
      ...base,
      projectId: projectB,
      executionAttempts: base.executionAttempts.filter((row) => row.origin !== "work_item").map((row) => ({ ...row, project_id: projectB })),
      externalWorkRefs: base.externalWorkRefs.map((row) => ({ ...row, project_id: projectB })),
      roleGenerationHeads: base.roleGenerationHeads.map((row) => ({ ...row, project_id: projectB })),
      roleGenerations: base.roleGenerations.map((row) => ({ ...row, project_id: projectB })),
      workItems: base.workItems.map((row) => ({ ...row, project_id: projectB })),
    };
    let idle: ((event: { thread: { id: string; projectId: string }; lastAssistantText?: string }) => Promise<void>) | undefined;
    const spawned: string[] = [];
    const bb = {
      pluginId: "companion-watcher",
      log: { info: () => undefined, warn: () => undefined },
      storage: { kv: { get: async () => undefined, set: async () => undefined } },
      agents: { registerTool: () => undefined, configure: () => undefined },
      sdk: {
        system: { config: async () => ({ dataDir: "/unused" }) },
        projects: { list: async () => [{ id: projectId, gitRemoteUrl: null }, { id: projectB, gitRemoteUrl: null }] },
        threads: {
          spawn: async ({ projectId: id }: { projectId: string }) => { spawned.push(id); return { id: `companion-${id}` }; },
          get: async () => ({ projectId: "unused", status: "idle" }),
          send: async () => undefined,
        },
      },
      events: { on: (event: string, handler: typeof idle) => { if (event === "thread.idle") idle = handler; } },
    } as unknown as BbPluginApi;
    companionWatcher(bb, async (id) => {
      if (id === projectId) throw new Error("project-a-unavailable");
      return projectBExport;
    }, async () => ({ issues: [], prs: [] }));
    await idle!({ thread: { id: "thread-a", projectId } });
    expect(spawned).toEqual([]);
    await idle!({ thread: { id: "thr_7bjw9e7mgd", projectId: projectB } });
    expect(spawned).toEqual([projectB]);
  });

  it("never lets a project A idle event drive project B", async () => {
    const base = await capturedExport();
    const projectB = "proj_two";
    const projectAExport = { ...base, executionAttempts: base.executionAttempts.filter((row) => row.origin !== "work_item") };
    const projectBExport = {
      ...projectAExport,
      projectId: projectB,
      executionAttempts: projectAExport.executionAttempts.map((row) => ({ ...row, project_id: projectB })),
      externalWorkRefs: projectAExport.externalWorkRefs.map((row) => ({ ...row, project_id: projectB })),
      roleGenerationHeads: projectAExport.roleGenerationHeads.map((row) => ({ ...row, project_id: projectB })),
      roleGenerations: projectAExport.roleGenerations.map((row) => ({ ...row, project_id: projectB })),
      workItems: projectAExport.workItems.map((row) => ({ ...row, project_id: projectB })),
    };
    let idle: ((event: { thread: { id: string; projectId: string }; lastAssistantText?: string }) => Promise<void>) | undefined;
    const spawned: string[] = [];
    const bb = {
      pluginId: "companion-watcher",
      log: { info: () => undefined, warn: () => undefined },
      storage: { kv: { get: async () => undefined, set: async () => undefined } },
      agents: { registerTool: () => undefined, configure: () => undefined },
      sdk: {
        system: { config: async () => ({ dataDir: "/unused" }) },
        projects: { list: async () => [{ id: projectId, gitRemoteUrl: null }, { id: projectB, gitRemoteUrl: null }] },
        threads: {
          spawn: async ({ projectId: id }: { projectId: string }) => { spawned.push(id); return { id: `companion-${id}` }; },
          get: async () => ({ projectId: "unused", status: "idle" }),
          send: async () => undefined,
        },
      },
      events: { on: (event: string, handler: typeof idle) => { if (event === "thread.idle") idle = handler; } },
    } as unknown as BbPluginApi;
    companionWatcher(bb, async (id) => id === projectId ? projectAExport : projectBExport, async () => ({ issues: [], prs: [] }));
    await idle!({ thread: { id: "thread-a-other", projectId } });
    expect(spawned).toEqual([]);
    await idle!({ thread: { id: "thr_7bjw9e7mgd", projectId } });
    expect(spawned).toEqual([projectId]);
    await idle!({ thread: { id: "thr_7bjw9e7mgd", projectId: projectB } });
    expect(spawned).toEqual([projectId, projectB]);
  });

  it("accepts nullable execution-attempt fields, including the captured review boundary", async () => {
    const records = (await readFile(join(fixtureRoot, "live-export", "records.ndjson"), "utf8")).split("\n").filter(Boolean).map((line) => {
      const record = JSON.parse(line) as { table: string; row: Record<string, unknown> };
      if (record.table === "execution_attempts" && record.row.origin === "work_item") {
        record.row.execution_attempt_id = "fd94c2f39e7bc72ecc454bb3cf5b5d6b95d7a5b44dcf7942bd846e3c3565dd2c";
        record.row.state = "superseded";
        record.row.thread_id = null;
        record.row.work_item_id = "wi-gh-559";
      }
      return JSON.stringify(record);
    }).join("\n");
    const canonical = await parseCanonicalExport(inlineExport(records, { execution_attempts: 2, role_generation_heads: 1, role_generations: 1, work_items: 1 }), fixtureRoot, projectId);
    expect(canonical.parseIssues).toEqual([]);
    expect(canonical.executionAttempts.find((row) => row.execution_attempt_id === "fd94c2f39e7bc72ecc454bb3cf5b5d6b95d7a5b44dcf7942bd846e3c3565dd2c")).toMatchObject({ thread_id: null, work_item_id: "wi-gh-559", state: "superseded" });
  });

  it("keeps a canonical population over 100 rows bounded and fully known below the ceiling", async () => {
    const canonical = await capturedExport();
    const expanded = {
      ...canonical,
      executionAttempts: Array.from({ length: 150 }, (_, index) => ({ ...canonical.executionAttempts[0], execution_attempt_id: `attempt-${index}` })),
      workItems: Array.from({ length: 125 }, (_, index) => ({ ...canonical.workItems[0], work_item_id: `work-item-${index}` })),
    };
    const snapshot = snapshotCanonical(expanded, 0);
    expect(snapshot).toMatchObject({ coverage: "known" });
    expect(snapshot.executionAttempts).toHaveLength(150);
    expect(snapshot.workItems).toHaveLength(125);
  });

  it("keeps the native timeline page bounded and reports older rows as partial", async () => {
    let tool: { execute(params: unknown, context: { threadId: string; projectId: string }): Promise<unknown> } | undefined;
    let hasOlderRows = true;
    let timelineCalls = 0;
    let timelineArgs: { segmentLimit?: string } | undefined;
    const bb = {
      pluginId: "companion-watcher",
      log: { warn: () => undefined },
      storage: { kv: { get: async () => undefined, set: async () => undefined } },
      agents: { registerTool: (value: typeof tool) => { tool = value; }, configure: () => undefined },
      sdk: {
        system: { config: async () => ({ dataDir: "/unused" }) },
        projects: { get: async () => ({ gitRemoteUrl: null }) },
        threads: {
          get: async () => ({ projectId, title: "Alzheimer companion judgment", originPluginId: "companion-watcher" }),
          timeline: async (args: typeof timelineArgs) => { timelineArgs = args; timelineCalls += 1; return { rows: [], timelinePage: { hasOlderRows, kind: "latest", segmentLimit: Number(args?.segmentLimit), returnedSegmentCount: 0, olderCursor: hasOlderRows ? { anchorSeq: timelineCalls, anchorId: `anchor-${timelineCalls}` } : null }, maxSeq: 0 }; },
          queuedMessages: { list: async () => [] },
        },
      },
      events: { on: () => undefined },
    } as unknown as BbPluginApi;
    companionWatcher(bb, capturedExport, async () => ({ issues: [], prs: [] }));
    const run = async () => JSON.parse(await tool!.execute({}, { threadId: "companion", projectId }) as string) as { coverage: string };
    expect((await run()).coverage).toBe("partial");
    expect(timelineArgs?.segmentLimit).toBe("100");
    expect(timelineCalls).toBe(10);
    hasOlderRows = false;
    expect((await run()).coverage).toBe("known");
  });

  it("follows native timeline cursors to recover the bounded current history", async () => {
    let tool: { execute(params: unknown, context: { threadId: string; projectId: string }): Promise<unknown> } | undefined;
    const calls: Array<Record<string, string>> = [];
    const bb = {
      pluginId: "companion-watcher",
      log: { warn: () => undefined },
      storage: { kv: { get: async () => undefined, set: async () => undefined } },
      agents: { registerTool: (value: typeof tool) => { tool = value; }, configure: () => undefined },
      sdk: {
        system: { config: async () => ({ dataDir: "/unused" }) },
        projects: { get: async () => ({ gitRemoteUrl: null }) },
        threads: {
          get: async () => ({ projectId, title: "Alzheimer companion judgment", originPluginId: "companion-watcher" }),
          timeline: async (args: Record<string, string>) => {
            calls.push(args);
            return calls.length === 1
              ? { rows: [{ id: "new" }], timelinePage: { hasOlderRows: true, kind: "latest", segmentLimit: 100, returnedSegmentCount: 1, olderCursor: { anchorSeq: 9, anchorId: "old-anchor" } }, maxSeq: 10 }
              : { rows: [{ id: "old" }], timelinePage: { hasOlderRows: false, kind: "older", segmentLimit: 100, returnedSegmentCount: 1, olderCursor: null }, maxSeq: 10 };
          },
          queuedMessages: { list: async () => [] },
        },
      },
      events: { on: () => undefined },
    } as unknown as BbPluginApi;
    companionWatcher(bb, capturedExport, async () => ({ issues: [], prs: [] }));
    const result = JSON.parse(await tool!.execute({}, { threadId: "companion", projectId }) as string) as { coverage: string };
    expect(result.coverage).toBe("known");
    expect(calls).toEqual([
      { threadId: "thr_7bjw9e7mgd", segmentLimit: "100" },
      { threadId: "thr_7bjw9e7mgd", segmentLimit: "100", beforeAnchorSeq: "9", beforeAnchorId: "old-anchor" },
    ]);
  });

  it("composes paged timelines in native order with latest metadata and envelope", () => {
    const latest = {
      rows: [{ id: "boundary", text: "new boundary" }, { id: "newest", text: "newest" }],
      activePromptMode: { mode: "plan", providerId: "codex", prompt: "latest" },
      activeThinking: { id: "thinking", text: "latest", startedAt: 3, updatedAt: 4 },
      activeWorkflows: [{ id: "workflow-latest" }],
      activeBackgroundCommands: [{ id: "command-latest" }],
      contextWindowUsage: { usedTokens: 9, modelContextWindow: 10, estimated: false },
      pendingTodos: { sourceSeq: 8, updatedAt: 8, items: [] },
      modelFallback: { sourceSeq: 8, detectedAt: 8, originalModel: "old", fallbackModel: "latest", reason: "provider", message: "latest" },
      timelinePage: { kind: "latest", segmentLimit: 100, returnedSegmentCount: 2, hasOlderRows: true, olderCursor: { anchorSeq: 2, anchorId: "anchor" } },
      maxSeq: 100,
    } as unknown as Parameters<typeof composeTimeline>[0];
    const older = {
      rows: [{ id: "oldest", text: "oldest" }, { id: "boundary", text: "old boundary" }],
      activePromptMode: null,
      activeThinking: null,
      activeWorkflows: [],
      activeBackgroundCommands: [],
      contextWindowUsage: { usedTokens: 1, modelContextWindow: 2, estimated: true },
      pendingTodos: null,
      modelFallback: null,
      timelinePage: { kind: "older", segmentLimit: 100, returnedSegmentCount: 2, hasOlderRows: false, olderCursor: null },
      maxSeq: 2,
    } as unknown as Parameters<typeof composeTimeline>[0];
    const oldest = {
      ...older,
      rows: [{ id: "very-old", text: "very old" }],
      timelinePage: { ...older.timelinePage, hasOlderRows: false, olderCursor: null },
    } as unknown as Parameters<typeof composeTimeline>[0];
    const composed = composeTimeline(latest, [older, oldest]);
    expect(composed.rows.map((row) => row.id)).toEqual(["very-old", "oldest", "boundary", "newest"]);
    expect(composed.rows.find((row) => row.id === "boundary")).toMatchObject({ text: "new boundary" });
    expect(composed).toMatchObject({ activePromptMode: latest.activePromptMode, activeThinking: latest.activeThinking, activeWorkflows: latest.activeWorkflows, activeBackgroundCommands: latest.activeBackgroundCommands, contextWindowUsage: latest.contextWindowUsage, pendingTodos: latest.pendingTodos, modelFallback: latest.modelFallback, maxSeq: 100, timelinePage: { hasOlderRows: false, returnedSegmentCount: 4 } });
  });

  it("rejects a non-OK canonical export outcome", async () => {
    await expect(parseCanonicalExport('{"outcome":"CANONICAL_STORE_UNAVAILABLE"}', fixtureRoot, projectId)).rejects.toThrow("canonical-export-CANONICAL_STORE_UNAVAILABLE");
  });

  it("rejects a missing canonical export payload", async () => {
    await expect(parseCanonicalExport('{"outcome":"OK"}', fixtureRoot, projectId)).rejects.toThrow("canonical-export-records-missing");
  });

  it("rejects an unreadable canonical export payload", async () => {
    const output = JSON.stringify({ outcome: "OK", evidence: { exportFile: { complete: true, directory: "missing-export", manifest: { projectId, tableCounts: {} } } } });
    await expect(parseCanonicalExport(output, fixtureRoot, projectId)).rejects.toThrow(/ENOENT/u);
  });

  it("rejects a canonical export without the orchestrator head", async () => {
    const records = (await readFile(join(fixtureRoot, "live-export", "records.ndjson"), "utf8")).split("\n").filter((line) => !line.includes('"table":"role_generation_heads"')).join("\n");
    await expect(parseCanonicalExport(inlineExport(records, { execution_attempts: 2, role_generation_heads: 0, role_generations: 1, work_items: 1 }), fixtureRoot, projectId)).rejects.toThrow("canonical-export-orchestrator-head-missing");
  });

  it("rejects unparseable canonical export records", async () => {
    await expect(parseCanonicalExport(inlineExport('{"table":', { execution_attempts: 0, role_generation_heads: 0, role_generations: 0, work_items: 0 }), fixtureRoot, projectId)).rejects.toThrow(SyntaxError);
  });

  it("rejects a partial export missing declared work items", async () => {
    const records = (await readFile(join(fixtureRoot, "live-export", "records.ndjson"), "utf8")).split("\n").filter((line) => !line.includes('"table":"work_items"')).join("\n");
    await expect(parseCanonicalExport(inlineExport(records, { execution_attempts: 2, role_generation_heads: 1, role_generations: 1, work_items: 1 }), fixtureRoot, projectId)).rejects.toThrow("canonical-export-work_items-count-mismatch");
  });

  it("skips a malformed non-holder attempt and marks the snapshot partial", async () => {
    const records = (await readFile(join(fixtureRoot, "live-export", "records.ndjson"), "utf8")).split("\n").filter(Boolean).map((line) => {
      const record = JSON.parse(line) as { table: string; row: Record<string, unknown> };
      if (record.table === "execution_attempts" && record.row.origin === "work_item") delete record.row.state;
      return JSON.stringify(record);
    }).join("\n");
    const canonical = await parseCanonicalExport(inlineExport(records, { execution_attempts: 2, role_generation_heads: 1, role_generations: 1, work_items: 1 }), fixtureRoot, projectId);
    expect(canonical.executionAttempts).toHaveLength(1);
    expect(canonical.parseIssues).toEqual(["execution_attempts.state"]);
    expect(snapshotCanonical(canonical, 0)).toMatchObject({ coverage: "partial", parseIssues: ["execution_attempts.state"] });
  });

  it("fails closed when a malformed attempt is the current orchestrator holder", async () => {
    const records = (await readFile(join(fixtureRoot, "live-export", "records.ndjson"), "utf8")).split("\n").filter(Boolean).map((line) => {
      const record = JSON.parse(line) as { table: string; row: Record<string, unknown> };
      if (record.table === "execution_attempts" && record.row.origin === "role_holder") delete record.row.state;
      return JSON.stringify(record);
    }).join("\n");
    await expect(parseCanonicalExport(inlineExport(records, { execution_attempts: 2, role_generation_heads: 1, role_generations: 1, work_items: 1 }), fixtureRoot, projectId)).rejects.toThrow("canonical-export-orchestrator-thread-unresolved");
  });

  it("degrades the snapshot to blind and logs the reason when the export CLI fails", async () => {
    let tool: { execute(params: unknown, context: { threadId: string; projectId: string }): Promise<unknown> } | undefined;
    const warnings: string[] = [];
    const bb = {
      pluginId: "companion-watcher",
      log: { warn: (message: string) => warnings.push(message) },
      storage: { kv: { get: async () => undefined, set: async () => undefined } },
      agents: { registerTool: (value: typeof tool) => { tool = value; }, configure: () => undefined },
      sdk: {
        system: { config: async () => ({ dataDir: "/unused" }) },
        threads: { get: async () => ({ projectId: "p", title: "Alzheimer companion judgment", originPluginId: "companion-watcher" }) },
      },
      events: { on: () => undefined },
    } as unknown as BbPluginApi;
    companionWatcher(bb, async () => { throw new Error("export CLI failed"); });
    const result = await tool!.execute({}, { threadId: "companion", projectId: "p" });
    expect(result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("COVERAGE: blind") }] });
    expect(result).toMatchObject({ content: [{ text: expect.stringContaining("export CLI failed") }] });
    expect(warnings).toEqual(["companion-watcher coverage=blind event=snapshot reason=Error: export CLI failed"]);
  });

  it("retries KV initialization after one rejection", async () => {
    let tool: { execute(params: unknown, context: { threadId: string; projectId: string }): Promise<unknown> } | undefined;
    let kvReads = 0;
    const bb = {
      pluginId: "companion-watcher",
      log: { warn: () => undefined },
      storage: { kv: { get: async () => { kvReads += 1; if (kvReads === 1) throw new Error("transient KV failure"); return undefined; }, set: async () => undefined } },
      agents: { registerTool: (value: typeof tool) => { tool = value; }, configure: () => undefined },
      sdk: {
        system: { config: async () => ({ dataDir: "/unused" }) },
        projects: { get: async () => ({ gitRemoteUrl: null }) },
        threads: {
          get: async () => ({ projectId, title: "Alzheimer companion judgment", originPluginId: "companion-watcher" }),
          timeline: async () => ({ rows: [], timelinePage: { hasOlderRows: false, kind: "latest", segmentLimit: 100, returnedSegmentCount: 0, olderCursor: null }, maxSeq: 0 }),
          queuedMessages: { list: async () => [] },
        },
      },
      events: { on: () => undefined },
    } as unknown as BbPluginApi;
    companionWatcher(bb, capturedExport, async () => ({ issues: [], prs: [] }));
    await expect(tool!.execute({}, { threadId: "companion", projectId })).rejects.toThrow("transient KV failure");
    const result = await tool!.execute({}, { threadId: "companion", projectId });
    expect(JSON.parse(result as string).coverage).toBe("known");
    expect(kvReads).toBe(3);
  });

  it("logs the parser degradation reason", async () => {
    let tool: { execute(params: unknown, context: { threadId: string; projectId: string }): Promise<unknown> } | undefined;
    const warnings: string[] = [];
    const bb = {
      pluginId: "companion-watcher",
      log: { warn: (message: string) => warnings.push(message) },
      storage: { kv: { get: async () => undefined, set: async () => undefined } },
      agents: { registerTool: (value: typeof tool) => { tool = value; }, configure: () => undefined },
      sdk: {
        system: { config: async () => ({ dataDir: "/unused" }) },
        threads: { get: async () => ({ projectId, title: "Alzheimer companion judgment", originPluginId: "companion-watcher" }) },
      },
      events: { on: () => undefined },
    } as unknown as BbPluginApi;
    companionWatcher(bb, async () => parseCanonicalExport(inlineExport("", { execution_attempts: 0, role_generation_heads: 0, role_generations: 0, work_items: 0 }), fixtureRoot, projectId));
    await tool!.execute({}, { threadId: "companion", projectId });
    expect(warnings).toEqual(["companion-watcher coverage=blind event=snapshot reason=Error: canonical-export-orchestrator-head-missing"]);
  });

  it("backs off unchanged findings, then routes a post-turn repeat to the director", () => {
    const prior = { sentAt: 100, fingerprint: affirmative.fingerprint };
    expect(routeJudgment(prior, affirmative, 200, undefined)).toBeUndefined();
    expect(routeJudgment(prior, affirmative, 600_100, undefined)).toBe("orchestrator");
    expect(routeJudgment(prior, affirmative, 200, 101)).toBe("director");
  });

  it("holds repeated director escalations for 24 hours", () => {
    const prior = { sentAt: 100, fingerprint: affirmative.fingerprint, escalatedAt: 150 };
    expect(routeJudgment(prior, affirmative, 23 * 60 * 60_000, 200)).toBeUndefined();
    expect(routeJudgment(prior, affirmative, 25 * 60 * 60_000, 200)).toBe("director");
  });
});
