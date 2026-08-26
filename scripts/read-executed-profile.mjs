import { execFileSync } from "node:child_process";
import { createReadStream, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
export { acceptProvisionalReview, initialReviewAcceptanceState } from "./review-verdict-acceptance.mjs";

const PAGE_SIZE = 1_000;
const ACTIVE_PROFILE = Symbol("active profile");
const TERMINAL_TURN_STATUSES = new Set(["completed", "failed", "interrupted"]);
const CODEX_SCOPE_TURN_ID = /^bta[0-9a-z]{7}-[1-9][0-9]*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu;

function isTerminalTurnEvent(event) {
  return event?.type === "turn/completed" && TERMINAL_TURN_STATUSES.has(event.data?.status);
}

function realPathInside(root, candidate) {
  try {
    const realRoot = realpathSync(root);
    const realCandidate = realpathSync(candidate);
    const fromRoot = relative(realRoot, realCandidate);
    return fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot) ? realCandidate : null;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

function filesNamed(root, directory, predicate) {
  const realDirectory = realPathInside(root, directory);
  if (!realDirectory) return [];
  return readdirSync(realDirectory, { withFileTypes: true }).flatMap((entry) => {
    if (!predicate(entry.name)) return [];
    const path = realPathInside(root, join(realDirectory, entry.name));
    return path && isFile(path) ? [path] : [];
  });
}

function codexSessionDirectories(home, providerThreadId) {
  const compact = providerThreadId.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/iu.test(compact)) return [];
  const date = new Date(Number.parseInt(compact.slice(0, 12), 16));
  if (Number.isNaN(date.valueOf())) return [];
  return [0, -1, 1].map((offset) => {
    const candidate = new Date(date);
    candidate.setUTCDate(candidate.getUTCDate() + offset);
    return join(home, ".codex", "sessions", String(candidate.getUTCFullYear()), String(candidate.getUTCMonth() + 1).padStart(2, "0"), String(candidate.getUTCDate()).padStart(2, "0"));
  });
}

function claudeProjectDirectory(home, environmentPath, providerThreadId) {
  if (typeof environmentPath !== "string" || !isAbsolute(environmentPath) || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(providerThreadId)) return null;
  const projectDirectory = environmentPath.replace(/[^a-z0-9-]/giu, "-");
  return join(home, ".claude", "projects", projectDirectory);
}

function piBridgeDirectory(home, env) {
  return typeof env?.BB_PI_BRIDGE_SESSION_DIR === "string" && env.BB_PI_BRIDGE_SESSION_DIR !== ""
    ? env.BB_PI_BRIDGE_SESSION_DIR
    : join(home, ".bb", "pi-bridge-sessions");
}

function piBridgeFilename(providerThreadId) {
  const sanitized = providerThreadId.replace(/[^A-Za-z0-9._-]/gu, "_");
  return sanitized === providerThreadId ? `${sanitized}.jsonl` : null;
}

async function readJsonLines(path, visit) {
  const lines = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() !== "") visit(JSON.parse(line));
  }
}

function completedTurns(events) {
  return events.flatMap((event) => {
    const checkpointId = event?.data?.providerCheckpointId;
    const providerThreadId = event?.data?.providerThreadId;
    if (!isTerminalTurnEvent(event)) return [];
    return [{
      eventId: event.id,
      eventSeq: event.seq,
      checkpointId: typeof checkpointId === "string" && checkpointId !== "" ? checkpointId : null,
      providerThreadId: typeof providerThreadId === "string" && providerThreadId !== "" ? providerThreadId : null,
      scopeTurnId: typeof event.scope?.turnId === "string" && event.scope.turnId !== "" ? event.scope.turnId : null,
    }];
  });
}

export function environmentDependentFromEvents(thread, events) {
  if (thread.status === "active" || thread.providerId !== "codex") return true;
  const starts = events
    .filter((event) => event?.type === "turn/started" && typeof event.data?.providerThreadId === "string" && event.data.providerThreadId !== "")
    .sort((left, right) => left.seq - right.seq);
  const start = starts.at(-1);
  return Boolean(start && !events.some((event) => isTerminalTurnEvent(event) && event.seq > start.seq && event.data?.providerThreadId === start.data.providerThreadId));
}

function activeTurn(thread, events) {
  if (thread.status !== "active") return null;
  const start = events
    .filter((event) => event?.type === "turn/started" && typeof event.data?.providerThreadId === "string" && event.data.providerThreadId !== "")
    .sort((left, right) => left.seq - right.seq)
    .at(-1);
  if (!start) return { reason: "BB thread is active but its current turn start is missing" };
  if (typeof start.scope?.turnId !== "string" || start.scope.turnId === "") return { reason: "BB active turn identity is unavailable" };
  const completedAfterStart = events.some((event) => isTerminalTurnEvent(event) && event.seq > start.seq && event.data?.providerThreadId === start.data.providerThreadId);
  if (completedAfterStart) return { reason: "BB thread is active but its latest provider turn is already terminal" };
  const requested = new Map(events
    .filter((event) => event?.type === "client/turn/requested" && typeof event.data?.requestId === "string")
    .map((event) => [event.data.requestId, event]));
  const accepted = events.filter((event) => event?.type === "turn/input/accepted"
    && event.data?.providerThreadId === start.data.providerThreadId
    && event.scope?.turnId === start.scope?.turnId
    && requested.get(event.data?.clientRequestId)?.seq <= start.seq);
  if (accepted.length !== 1 || typeof accepted[0].data?.clientRequestId !== "string" || accepted[0].data.clientRequestId === "") {
    return { reason: "BB active turn input correlation is missing or ambiguous" };
  }
  const requests = events.filter((event) => event?.type === "client/turn/requested" && event.data?.requestId === accepted[0].data.clientRequestId);
  if (requests.length !== 1 || !Number.isSafeInteger(requests[0].createdAt)) return { reason: "BB active turn request timestamp is missing or ambiguous" };
  return {
    requestedAtMs: requests[0].createdAt,
    scopeTurnId: start.scope.turnId,
    turn: {
      eventId: start.id,
      eventSeq: start.seq,
      checkpointId: null,
      providerThreadId: start.data.providerThreadId,
      phase: "active",
    },
  };
}

function codexTurnIdFromScope(turn) {
  if (!turn.scopeTurnId || !turn.providerThreadId) return null;
  return turn.scopeTurnId.match(CODEX_SCOPE_TURN_ID)?.[1] ?? null;
}

function recordAtOrAfter(record, timestampMs) {
  const recordAtMs = typeof record?.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
  return Number.isFinite(recordAtMs) && recordAtMs >= timestampMs;
}

function settle(turns, profiles, source, { absentReason = "provider-native turn profile is absent", ambiguous = new Set(), missingCorrelationReason = "BB completion lacks provider correlation", classify } = {}) {
  const results = turns.map((turn) => {
    const correlationId = turn.phase === "active" ? ACTIVE_PROFILE : turn.checkpointId;
    if (!correlationId || !turn.providerThreadId) {
      return { ...turn, status: "unknown", reason: missingCorrelationReason };
    }
    if (ambiguous.has(correlationId)) return { ...turn, status: "unknown", reason: "provider-native turn correlation is ambiguous" };
    const matches = profiles.get(correlationId) ?? [];
    const distinct = [...new Map(matches.map((profile) => [JSON.stringify([profile.model, profile.reasoningLevel]), profile])).values()];
    if (distinct.length !== 1) {
      return { ...turn, status: "unknown", reason: distinct.length === 0 ? absentReason : "provider-native turn profiles conflict" };
    }
    const observedProfile = { ...distinct[0], kind: "observed-provider-native", source };
    const refusal = classify?.(observedProfile);
    if (refusal) return { ...turn, status: "unknown", reason: refusal, observedProfile };
    return { ...turn, status: "known", executedProfile: { ...observedProfile, kind: "executed-provider-native" } };
  });
  const knownTurns = results.filter((turn) => turn.status === "known").length;
  const observedOnlyTurns = results.filter((turn) => turn.observedProfile).length;
  const activeTurns = results.filter((turn) => turn.phase === "active").length;
  return {
    outcome: knownTurns === results.length && results.length > 0 ? "known" : knownTurns > 0 ? "partial" : "unknown",
    coverage: { ...(activeTurns > 0 ? { activeTurns } : {}), completedTurns: results.length - activeTurns, knownTurns, unknownTurns: results.length - knownTurns, observedOnlyTurns },
    turns: results,
  };
}

const ZCODE_ATTESTATION_SCHEMA = "zcode-acp.attestation/v1";

function readZcodeAttestation(items) {
  const ids = [...new Set(items.map((item) => item.id))];
  if (ids.length !== 1) return null;
  const completed = items.filter((item) => item.eventType === "item/completed");
  if (completed.length !== 1 || typeof completed[0].result !== "string") return null;
  try {
    const attestation = JSON.parse(completed[0].result);
    if (!attestation || typeof attestation !== "object" || Array.isArray(attestation)
      || attestation.schema !== ZCODE_ATTESTATION_SCHEMA
      || ![attestation.providerId, attestation.modelId, attestation.variant].every((value) => typeof value === "string" && value !== "")) return null;
    return attestation;
  } catch {
    return null;
  }
}

function settleZcodeTurns(turns, events) {
  const results = turns.map((turn) => {
    if (!turn.scopeTurnId || !turn.providerThreadId) return { ...turn, status: "unknown", reason: "BB completion lacks provider correlation" };
    const items = events.flatMap((event) => {
      const item = event?.data?.item;
      return event?.scope?.turnId === turn.scopeTurnId
        && event?.data?.providerThreadId === turn.providerThreadId
        && item?.type === "toolCall"
        && typeof item.id === "string"
        && item.id.startsWith("zcode-attest-")
        ? [{ eventType: event.type, id: item.id, result: item.result }]
        : [];
    });
    if (items.length === 0) return { ...turn, status: "no-execution", reason: "acp-zcode attestation item is absent; no model call executed" };
    const attestation = readZcodeAttestation(items);
    if (!attestation) return { ...turn, status: "unknown", reason: "acp-zcode attestation item is malformed or unparseable" };
    return {
      ...turn,
      status: "known",
      executedProfile: {
        providerId: attestation.providerId,
        model: attestation.modelId,
        reasoningLevel: attestation.variant,
        kind: "executed-provider-native",
        source: "acp-zcode attestation",
      },
    };
  });
  const knownTurns = results.filter((turn) => turn.status === "known").length;
  const noExecutionTurns = results.filter((turn) => turn.status === "no-execution").length;
  const unknownTurns = results.filter((turn) => turn.status === "unknown").length;
  const activeTurns = results.filter((turn) => turn.phase === "active").length;
  return {
    outcome: knownTurns === results.length && results.length > 0 ? "known" : noExecutionTurns === results.length && results.length > 0 ? "no-execution" : knownTurns > 0 ? "partial" : "unknown",
    coverage: { ...(activeTurns > 0 ? { activeTurns } : {}), completedTurns: results.length - activeTurns, knownTurns, unknownTurns, noExecutionTurns, observedOnlyTurns: 0 },
    turns: results,
  };
}

export async function readExecutedProfiles({ thread, environment, events, expectedTurnId, home = homedir(), env = process.env }) {
  const active = activeTurn(thread, events);
  if (active?.reason) {
    return { outcome: "unknown", coverage: { activeTurns: 1, completedTurns: 0, knownTurns: 0, unknownTurns: 1, observedOnlyTurns: 0 }, turns: [], reason: active.reason };
  }
  const allTurns = active ? [active.turn] : completedTurns(events);
  const turns = expectedTurnId === undefined
    ? allTurns
    : allTurns.filter((turn) => turn.scopeTurnId === expectedTurnId);
  if (expectedTurnId !== undefined && turns.length !== 1) {
    const reason = `exact requested turn is unavailable or ambiguous: expected ${expectedTurnId}, found ${turns.length}`;
    return { outcome: "unknown", coverage: { ...(active ? { activeTurns: 1 } : {}), completedTurns: turns.length, knownTurns: 0, unknownTurns: turns.length || 1, observedOnlyTurns: 0 }, turns, reason };
  }
  const providerThreadIds = [...new Set(turns.map((turn) => turn.providerThreadId).filter(Boolean))];
  if (providerThreadIds.length !== 1) {
    const reason = active ? "active BB turn does not resolve to one provider session" : "BB completions do not resolve to one provider session";
    return { outcome: "unknown", coverage: { ...(active ? { activeTurns: 1 } : {}), completedTurns: active ? 0 : turns.length, knownTurns: 0, unknownTurns: turns.length, observedOnlyTurns: 0 }, turns, reason };
  }
  const providerThreadId = providerThreadIds[0];
  const profiles = new Map();
  const add = (turnId, model, reasoningLevel) => {
    if (turnId !== ACTIVE_PROFILE && (typeof turnId !== "string" || turnId === "")) return;
    if (![model, reasoningLevel].every((value) => typeof value === "string" && value !== "")) return;
    profiles.set(turnId, [...(profiles.get(turnId) ?? []), { providerId: thread.providerId, model, reasoningLevel }]);
  };

  if (thread.providerId === "codex") {
    const codexTurns = turns.map((turn) => turn.checkpointId ? turn : { ...turn, checkpointId: codexTurnIdFromScope(turn) });
    try {
      const root = join(home, ".codex", "sessions");
      const directories = codexSessionDirectories(home, providerThreadId);
      const files = directories.flatMap((directory) => filesNamed(root, directory, (name) => name.endsWith(`-${providerThreadId}.jsonl`)));
      if (files.length !== 1) return { ...settle(codexTurns, profiles, "codex turn_context"), reason: `${active ? "active BB turn: " : ""}expected one Codex session log, found ${files.length}` };
      const activeProfiles = [];
      const requiresSessionMatch = active || turns.some((turn) => !turn.checkpointId && codexTurnIdFromScope(turn));
      const sessionMetas = [];
      await readJsonLines(files[0], (record) => {
        if (record?.type === "session_meta") sessionMetas.push(record.payload);
        if (record?.type === "turn_context") {
          add(record.payload?.turn_id, record.payload?.model, record.payload?.effort);
          if (active && typeof record.payload?.turn_id === "string" && recordAtOrAfter(record, active.requestedAtMs) && active.scopeTurnId.endsWith(`-${record.payload.turn_id}`)) activeProfiles.push(record.payload);
        }
      });
      const exactSession = sessionMetas.length === 1
        && sessionMetas[0]?.id === providerThreadId
        && sessionMetas[0]?.originator === "bb"
        && sessionMetas[0]?.cwd === environment?.path;
      if (requiresSessionMatch && !exactSession) {
        profiles.clear();
        return { ...settle(codexTurns, profiles, "codex turn_context"), reason: `${active ? "active BB turn: " : ""}Codex session_meta does not match the BB session and exact environment path` };
      }
      for (const profile of activeProfiles) add(ACTIVE_PROFILE, profile.model, profile.effort);
      return settle(codexTurns, profiles, "codex turn_context", { absentReason: active ? "active Codex turn_context at or after the BB turn request is absent" : undefined });
    } catch {
      profiles.clear();
      return { ...settle(codexTurns, profiles, "codex turn_context"), reason: `${active ? "active BB turn: " : ""}Codex session log is unreadable` };
    }
  }

  if (thread.providerId === "claude-code") {
    try {
      const root = join(home, ".claude", "projects");
      const candidateDirectory = claudeProjectDirectory(home, environment?.path, providerThreadId);
      const directory = candidateDirectory ? realPathInside(root, candidateDirectory) : null;
      const path = directory ? realPathInside(root, join(directory, `${providerThreadId}.jsonl`)) : null;
      const files = path && isFile(path) ? [path] : [];
      if (files.length !== 1) return { ...settle(turns, profiles, "Claude assistant envelope"), reason: `${active ? "active BB turn: " : ""}expected one Claude session log, found ${files.length}` };
      const activeProfiles = [];
      await readJsonLines(files[0], (record) => {
        if (record?.type === "assistant" && record.message?.model !== "<synthetic>") {
          add(record.uuid, record.message?.model, record.effort);
          if (active && recordAtOrAfter(record, active.requestedAtMs)) activeProfiles.push({ model: record.message?.model, reasoningLevel: record.effort });
        }
      });
      for (const profile of activeProfiles) add(ACTIVE_PROFILE, profile.model, profile.reasoningLevel);
      return settle(turns, profiles, "Claude assistant envelope", {
        absentReason: active ? "active Claude assistant envelope at or after the BB turn request is absent" : undefined,
        classify: (profile) => /\[[^\]]+\]$/u.test(profile.model) ? null : "provider-native model does not establish the exact dispatched SKU or context-window suffix",
      });
    } catch {
      profiles.clear();
      return { ...settle(turns, profiles, "Claude assistant envelope"), reason: `${active ? "active BB turn: " : ""}Claude session log is unreadable` };
    }
  }

  if (thread.providerId === "pi") {
    let failureReason = "Pi session log is unreadable";
    try {
      const root = piBridgeDirectory(home, env);
      const filename = piBridgeFilename(providerThreadId);
      if (!filename) {
        const reason = `${active ? "active BB turn: " : ""}Pi provider session id requires lossy filename sanitization`;
        return { ...settle(turns, profiles, "Pi assistant envelope and thinking state", { absentReason: reason }), reason };
      }
      const candidate = realPathInside(root, join(root, filename));
      if (!candidate || !isFile(candidate)) {
        const reason = `${active ? "active BB turn: " : ""}expected the exact Pi bridge session log, found 0`;
        return { ...settle(turns, profiles, "Pi assistant envelope and thinking state", { absentReason: reason }), reason };
      }
      const entries = [];
      await readJsonLines(candidate, (record) => {
        if (entries.length === 0 && (record?.type !== "session" || record.cwd !== environment?.path)) {
          failureReason = "Pi session header does not match the exact BB environment path";
          throw new Error("Pi session scope mismatch");
        }
        entries.push(record);
      });
      if (entries.length === 0) throw new Error("empty Pi session log");
      const entryIds = entries.flatMap((entry) => typeof entry?.id === "string" ? [entry.id] : []);
      if (new Set(entryIds).size !== entryIds.length) {
        failureReason = "Pi session entry ids are ambiguous";
        throw new Error("duplicate Pi entry id");
      }
      const byId = new Map(entries.flatMap((entry) => typeof entry?.id === "string" ? [[entry.id, entry]] : []));
      const piProfiles = new Map();
      const addPi = (turnId, profile) => piProfiles.set(turnId, [...(piProfiles.get(turnId) ?? []), profile]);
      const profileForAssistant = (assistant) => {
        const nativeProvider = assistant.message?.provider;
        const nativeModel = assistant.message?.model;
        const model = typeof nativeProvider === "string" && nativeProvider !== "" && typeof nativeModel === "string" && nativeModel !== ""
          ? nativeModel.startsWith(`${nativeProvider}/`) ? nativeModel : `${nativeProvider}/${nativeModel}`
          : null;
        let reasoningLevel = null;
        let selectedModel = null;
        let ancestor = assistant;
        const seen = new Set();
        while (typeof ancestor?.parentId === "string" && !seen.has(ancestor.parentId)) {
          seen.add(ancestor.parentId);
          ancestor = byId.get(ancestor.parentId);
          if (!ancestor) break;
          if (!reasoningLevel && ancestor.type === "thinking_level_change" && typeof ancestor.thinkingLevel === "string" && ancestor.thinkingLevel !== "") reasoningLevel = ancestor.thinkingLevel;
          if (!selectedModel && ancestor.type === "model_change" && typeof ancestor.provider === "string" && ancestor.provider !== "" && typeof ancestor.modelId === "string" && ancestor.modelId !== "") {
            selectedModel = ancestor.modelId.startsWith(`${ancestor.provider}/`) ? ancestor.modelId : `${ancestor.provider}/${ancestor.modelId}`;
          }
        }
        return { model, reasoningLevel, selectionMismatch: Boolean(model && selectedModel && model !== selectedModel) };
      };
      const assistantFrom = (entry) => {
        let current = entry;
        const seen = new Set();
        while (current && !(current.type === "message" && current.message?.role === "assistant")) {
          if (current.type === "message" && current.message?.role === "user") return null;
          if (typeof current.parentId !== "string" || seen.has(current.parentId)) return null;
          seen.add(current.parentId);
          current = byId.get(current.parentId);
        }
        return current ?? null;
      };
      if (active) {
        for (const record of entries) {
          if (record?.type === "message" && record.message?.role === "assistant" && recordAtOrAfter(record, active.requestedAtMs)) addPi(ACTIVE_PROFILE, profileForAssistant(record));
        }
      } else {
        for (const turn of turns) {
          const assistant = assistantFrom(byId.get(turn.checkpointId));
          if (assistant) addPi(turn.checkpointId, profileForAssistant(assistant));
        }
      }
      const results = turns.map((turn) => {
        const correlationId = turn.phase === "active" ? ACTIVE_PROFILE : turn.checkpointId;
        if (!correlationId || !turn.providerThreadId) return { ...turn, status: "unknown", reason: "BB completion lacks provider correlation" };
        const matches = piProfiles.get(correlationId) ?? [];
        const models = [...new Set(matches.map((profile) => profile.model).filter(Boolean))];
        const reasoningLevels = [...new Set(matches.map((profile) => profile.reasoningLevel).filter(Boolean))];
        const model = matches.length > 0 && matches.every((profile) => profile.model) && models.length === 1 ? models[0] : null;
        const reasoningLevel = matches.length > 0 && matches.every((profile) => profile.reasoningLevel) && reasoningLevels.length === 1 ? reasoningLevels[0] : null;
        const unknownElements = [...(!model ? ["model"] : []), ...(!reasoningLevel ? ["reasoningLevel"] : [])];
        const selectionMismatch = matches.some((profile) => profile.selectionMismatch);
        const executedProfile = model || reasoningLevel ? {
          ...(model ? { providerId: thread.providerId, model } : {}),
          ...(reasoningLevel ? { reasoningLevel } : {}),
          kind: "executed-provider-native",
          source: model && reasoningLevel ? "Pi assistant envelope and thinking state" : model ? "Pi assistant envelope" : "Pi thinking state",
        } : null;
        if (unknownElements.length === 0) return { ...turn, status: "known", executedProfile, ...(selectionMismatch ? { selectionMismatch: true } : {}) };
        const reason = matches.length === 0
          ? active ? "active Pi assistant envelope at or after the BB turn request is absent" : "Pi checkpoint parent chain does not reach an assistant envelope"
          : `Pi ${unknownElements.join(" and ")} evidence is absent or ambiguous`;
        return { ...turn, status: "unknown", reason, ...(executedProfile ? { executedProfile, unknownElements } : {}), ...(selectionMismatch ? { selectionMismatch: true } : {}) };
      });
      const knownTurns = results.filter((turn) => turn.status === "known").length;
      const activeTurns = results.filter((turn) => turn.phase === "active").length;
      const result = {
        outcome: knownTurns === results.length && results.length > 0 ? "known" : knownTurns > 0 ? "partial" : "unknown",
        coverage: { ...(activeTurns > 0 ? { activeTurns } : {}), completedTurns: results.length - activeTurns, knownTurns, unknownTurns: results.length - knownTurns, observedOnlyTurns: 0 },
        turns: results,
      };
      return result.outcome === "unknown" ? { ...result, reason: results[0]?.reason ?? "Pi turn evidence is absent or ambiguous" } : result;
    } catch {
      profiles.clear();
      return { ...settle(turns, profiles, "Pi assistant envelope and thinking state", { absentReason: failureReason }), reason: `${active ? "active BB turn: " : ""}${failureReason}` };
    }
  }

  if (thread.providerId === "acp-zcode") return settleZcodeTurns(turns, events);

  const reason = `provider ${thread.providerId} has no measured native read-back`;
  return { ...settle(turns, profiles, "unsupported provider", { absentReason: reason, missingCorrelationReason: reason }), reason };
}

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) args.set(argv[index], argv[index + 1]);
  const projectId = args.get("--project");
  const threadId = args.get("--thread") ?? process.env.BB_THREAD_ID;
  const turnId = args.get("--turn");
  if (!projectId || !threadId || [...args.keys()].some((key) => !["--project", "--thread", "--turn"].includes(key))) {
    throw new Error("usage: node scripts/read-executed-profile.mjs --project <project-id> [--thread <thread-id>] [--turn <turn-id>]");
  }
  return { projectId, threadId, turnId };
}

function bbJson(args) {
  const env = { ...process.env };
  delete env.BB_CLI;
  return JSON.parse(execFileSync("bb", args, { encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] }));
}

function readAllEvents(threadId) {
  const events = [];
  let afterSeq = 0;
  while (true) {
    const page = bbJson(["thread", "log", threadId, "--format", "json", "--limit", String(PAGE_SIZE), "--after-seq", String(afterSeq)]);
    if (!Array.isArray(page)) throw new Error("bb thread log did not return an event array");
    events.push(...page);
    if (page.length < PAGE_SIZE) return events;
    const next = page.at(-1)?.seq;
    if (!Number.isSafeInteger(next) || next <= afterSeq) throw new Error("bb thread log pagination did not advance");
    afterSeq = next;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { projectId, threadId, turnId } = parseArgs(argv);
  const shown = bbJson(["thread", "show", threadId, "--json"]);
  if (shown?.thread?.id !== threadId || shown.thread.projectId !== projectId) throw new Error("thread does not belong to the exact project");
  const events = readAllEvents(threadId);
  const result = await readExecutedProfiles({ thread: shown.thread, environment: shown.environment, events, expectedTurnId: turnId });
  const environmentDependent = environmentDependentFromEvents(shown.thread, events);
  console.log(JSON.stringify({ threadId, projectId, providerId: shown.thread.providerId, environmentDependent, ...result }, null, 2));
  if (result.outcome !== "known") process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
