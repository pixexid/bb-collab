import type { BbPluginApi } from "@bb/plugin-sdk";
import { expect, it } from "vitest";
import { readLiveRoleFactReader } from "../server.js";
import {
  ROLE_CONTEXT_EVENT_PAGE_SIZE,
  resolveRoleContext,
  type ApplyRequest,
  type RoleEventFact,
} from "../src/foundation.js";

const PROJECT_ID = "proj_a8zzfsx36j";
const DIRECTOR_PROFILES = [
  { providerId: "claude-code", model: "claude-opus-5[1m]", reasoningLevel: "medium" },
  { providerId: "pi", model: "zai/glm-5.3", reasoningLevel: "high" },
] as const;

type LiveEvent = RoleEventFact & { scope?: { turnId?: string } };

async function readJson<T>(baseUrl: string, path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`);
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return await response.json() as T;
}

async function readAllEvents(baseUrl: string, threadId: string): Promise<LiveEvent[]> {
  const events: LiveEvent[] = [];
  let afterSeq = 0;
  while (true) {
    const page = await readJson<LiveEvent[]>(baseUrl, `/api/v1/threads/${threadId}/events?afterSeq=${afterSeq}&limit=256`);
    events.push(...page);
    if (page.length < 256) return events;
    afterSeq = page.at(-1)!.seq;
  }
}

function liveSdk(baseUrl: string, eventReads: Array<{ afterSeq?: string; limit?: string }>): BbPluginApi["sdk"] {
  const get = <T>(path: string) => readJson<T>(baseUrl, path);
  return {
    threads: {
      get: ({ threadId }: { threadId: string }) => get(`/api/v1/threads/${threadId}`),
      events: {
        list: ({ threadId, afterSeq, limit }: { threadId: string; afterSeq?: string; limit?: string }) => {
          eventReads.push({ afterSeq, limit });
          return get(`/api/v1/threads/${threadId}/events?afterSeq=${afterSeq ?? "0"}&limit=${limit ?? "256"}`);
        },
      },
    },
    environments: { get: ({ environmentId }: { environmentId: string }) => get(`/api/v1/environments/${environmentId}`) },
    projects: { get: ({ projectId }: { projectId: string }) => get(`/api/v1/projects/${projectId}`) },
    hosts: { get: ({ hostId }: { hostId: string }) => get(`/api/v1/hosts/${hostId}`) },
    system: { version: () => get("/api/v1/system/version") },
  } as unknown as BbPluginApi["sdk"];
}

// Live-shape assumption: this acceptance test discovers turns from the complete sanctioned
// SDK surface. It treats sparse sequences and returned delta/compacted events as native facts.
it.runIf(process.env.BB_LIVE_ROLE_CONTEXT === "1")(
  "settles exact role contexts on a purpose-made live fixture thread",
  async () => {
    const baseUrl = process.env.BB_SERVER_URL;
    if (!baseUrl) throw new Error("BB_SERVER_URL is required for live role-context settling");
    const threadId = process.env.BB_LIVE_ROLE_CONTEXT_THREAD_ID;
    if (!threadId) throw new Error("BB_LIVE_ROLE_CONTEXT_THREAD_ID must name the purpose-made live fixture thread");
    const events = await readAllEvents(baseUrl, threadId);
    expect(events.length).toBeGreaterThan(18_238);

    const candidates = events.flatMap((request, requestIndex) => {
      const execution = request.data.execution as Record<string, unknown> | undefined;
      const requestId = request.data.requestId;
      const profile = DIRECTOR_PROFILES.find((candidate) =>
        execution?.model === candidate.model && execution.reasoningLevel === candidate.reasoningLevel,
      );
      if (
        request.type !== "client/turn/requested" || typeof requestId !== "string" ||
        !profile ||
        execution?.permissionMode !== "full" || execution?.serviceTier !== "default"
      ) return [];
      const acceptedIndex = events.findIndex((event, index) =>
        index > requestIndex && event.type === "turn/input/accepted" && event.data.clientRequestId === requestId,
      );
      const accepted = events[acceptedIndex];
      const turnId = accepted?.scope?.turnId;
      if (!accepted || !turnId) return [];
      const completionIndex = events.findIndex((event, index) =>
        index > acceptedIndex && event.type === "turn/completed" && event.scope?.turnId === turnId,
      );
      if (completionIndex < 0) return [];
      const completion = events[completionIndex]!;
      const returned = events.slice(requestIndex + 1, completionIndex + 1);
      const providerThreadId = accepted.data.providerThreadId;
      if (
        completion.data.status !== "completed" || typeof providerThreadId !== "string" ||
        returned.filter((event) => event.type === "turn/input/accepted" && event.data.clientRequestId === requestId).length !== 1 ||
        returned.filter((event) => event.type === "turn/started" && event.data.providerThreadId === providerThreadId).length !== 1 ||
        returned.filter((event) => event.type === "turn/completed" && event.data.providerThreadId === providerThreadId).length !== 1 ||
        returned.some((event) => event.type === "provider/modelFallback" && event.data.providerThreadId === providerThreadId)
      ) return [];
      return [{ request, completion, interiorCount: returned.length - 1, profile }];
    });
    const latest = [...candidates].sort((left, right) => right.request.seq - left.request.seq)[0];
    const busy = [...candidates].sort((left, right) => right.interiorCount - left.interiorCount)[0];
    if (!latest || !busy) throw new Error("no live director role-context candidate is available");
    expect(busy.interiorCount).toBeGreaterThanOrEqual(100);

    const eventReads: Array<{ afterSeq?: string; limit?: string }> = [];
    const sdk = liveSdk(baseUrl, eventReads);
    for (const candidate of [latest, busy]) {
      const request = {
        projectId: PROJECT_ID,
        operationClass: "qualification_observation_record",
        roleContext: {
          threadId,
          requestEventId: candidate.request.id,
          requestEventSeq: candidate.request.seq,
          completionEventId: candidate.completion.id,
          completionEventSeq: candidate.completion.seq,
        },
      } as ApplyRequest;
      const reader = await readLiveRoleFactReader(sdk, baseUrl, request);
      if (!reader) throw new Error("live role fact reader was not constructed");
      expect(resolveRoleContext(reader, request).profile).toEqual({
        ...candidate.profile,
        permissionMode: "full",
        serviceTier: "default",
        visibility: "visible",
      });
    }
    const correlationPageCount = [latest, busy].reduce(
      (count, candidate) => count + Math.ceil((candidate.interiorCount + 1) / ROLE_CONTEXT_EVENT_PAGE_SIZE),
      0,
    );
    expect(eventReads).toHaveLength(4 + correlationPageCount);
    expect(eventReads.filter((read) => read.limit === "1")).toHaveLength(4);
    expect(eventReads.filter((read) => read.limit === String(ROLE_CONTEXT_EVENT_PAGE_SIZE))).toHaveLength(correlationPageCount);
    expect(eventReads.every((read) => Number(read.limit) <= ROLE_CONTEXT_EVENT_PAGE_SIZE)).toBe(true);

    const firstSeq = events[0]!.seq;
    const lastSeq = events.at(-1)!.seq;
    console.info(JSON.stringify({
      surface: "sanctioned SDK /api/v1/threads/:threadId/events paged by afterSeq at 256 rows",
      eventCount: events.length,
      sequenceRange: [firstSeq, lastSeq],
      presentToWidthDensity: events.length / (lastSeq - firstSeq + 1),
      latest: { requestId: latest.request.id, requestSeq: latest.request.seq, completionId: latest.completion.id, completionSeq: latest.completion.seq, interiorCount: latest.interiorCount },
      busy: { requestId: busy.request.id, requestSeq: busy.request.seq, completionId: busy.completion.id, completionSeq: busy.completion.seq, interiorCount: busy.interiorCount },
    }));
  },
  60_000,
);
