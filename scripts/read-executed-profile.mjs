import { execFileSync } from "node:child_process";
import { createReadStream, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const PAGE_SIZE = 1_000;

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

function codexSessionDirectory(home, providerThreadId) {
  const compact = providerThreadId.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/iu.test(compact)) return null;
  const date = new Date(Number.parseInt(compact.slice(0, 12), 16));
  if (Number.isNaN(date.valueOf())) return null;
  return join(home, ".codex", "sessions", String(date.getUTCFullYear()), String(date.getUTCMonth() + 1).padStart(2, "0"), String(date.getUTCDate()).padStart(2, "0"));
}

function claudeProjectDirectory(home, environmentPath, providerThreadId) {
  if (typeof environmentPath !== "string" || !isAbsolute(environmentPath) || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(providerThreadId)) return null;
  const projectDirectory = environmentPath.replace(/[^a-z0-9-]/giu, "-");
  return join(home, ".claude", "projects", projectDirectory);
}

function piProjectDirectory(home, environmentPath) {
  if (typeof environmentPath !== "string" || !isAbsolute(environmentPath)) return null;
  return join(home, ".pi", "agent", "sessions", `--${environmentPath.replace(/^[/\\]/u, "").replace(/[/\\:]/gu, "-")}--`);
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
    if (event?.type !== "turn/completed" || event.data?.status !== "completed") return [];
    return [{
      eventId: event.id,
      eventSeq: event.seq,
      checkpointId: typeof checkpointId === "string" && checkpointId !== "" ? checkpointId : null,
      providerThreadId: typeof providerThreadId === "string" && providerThreadId !== "" ? providerThreadId : null,
    }];
  });
}

function settle(turns, profiles, source, { absentReason = "provider-native turn profile is absent", ambiguous = new Set(), missingCorrelationReason = "BB completion lacks provider correlation", classify } = {}) {
  const results = turns.map((turn) => {
    if (!turn.checkpointId || !turn.providerThreadId) {
      return { ...turn, status: "unknown", reason: missingCorrelationReason };
    }
    if (ambiguous.has(turn.checkpointId)) return { ...turn, status: "unknown", reason: "provider-native turn correlation is ambiguous" };
    const matches = profiles.get(turn.checkpointId) ?? [];
    const distinct = [...new Map(matches.map((profile) => [`${profile.model}\0${profile.reasoningLevel}`, profile])).values()];
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
  return {
    outcome: knownTurns === results.length && results.length > 0 ? "known" : knownTurns > 0 ? "partial" : "unknown",
    coverage: { completedTurns: results.length, knownTurns, unknownTurns: results.length - knownTurns, observedOnlyTurns },
    turns: results,
  };
}

export async function readExecutedProfiles({ thread, environment, events, home = homedir() }) {
  const turns = completedTurns(events);
  const providerThreadIds = [...new Set(turns.map((turn) => turn.providerThreadId).filter(Boolean))];
  if (providerThreadIds.length !== 1) {
    return { outcome: "unknown", coverage: { completedTurns: turns.length, knownTurns: 0, unknownTurns: turns.length, observedOnlyTurns: 0 }, turns, reason: "BB completions do not resolve to one provider session" };
  }
  const providerThreadId = providerThreadIds[0];
  const profiles = new Map();
  const add = (turnId, model, reasoningLevel) => {
    if (![turnId, model, reasoningLevel].every((value) => typeof value === "string" && value !== "")) return;
    profiles.set(turnId, [...(profiles.get(turnId) ?? []), { providerId: thread.providerId, model, reasoningLevel }]);
  };

  if (thread.providerId === "codex") {
    try {
      const root = join(home, ".codex", "sessions");
      const directory = codexSessionDirectory(home, providerThreadId);
      const files = directory ? filesNamed(root, directory, (name) => name.endsWith(`-${providerThreadId}.jsonl`)) : [];
      if (files.length !== 1) return { ...settle(turns, profiles, "codex turn_context"), reason: `expected one Codex session log, found ${files.length}` };
      await readJsonLines(files[0], (record) => {
        if (record?.type === "turn_context") add(record.payload?.turn_id, record.payload?.model, record.payload?.effort);
      });
      return settle(turns, profiles, "codex turn_context");
    } catch {
      profiles.clear();
      return { ...settle(turns, profiles, "codex turn_context"), reason: "Codex session log is unreadable" };
    }
  }

  if (thread.providerId === "claude-code") {
    try {
      const root = join(home, ".claude", "projects");
      const candidateDirectory = claudeProjectDirectory(home, environment?.path, providerThreadId);
      const directory = candidateDirectory ? realPathInside(root, candidateDirectory) : null;
      const path = directory ? realPathInside(root, join(directory, `${providerThreadId}.jsonl`)) : null;
      const files = path && isFile(path) ? [path] : [];
      if (files.length !== 1) return { ...settle(turns, profiles, "Claude assistant envelope"), reason: `expected one Claude session log, found ${files.length}` };
      await readJsonLines(files[0], (record) => {
        if (record?.type === "assistant" && record.message?.model !== "<synthetic>") add(record.uuid, record.message?.model, record.effort);
      });
      return settle(turns, profiles, "Claude assistant envelope", {
        classify: (profile) => /\[[^\]]+\]$/u.test(profile.model) ? null : "provider-native model does not establish the exact dispatched SKU or context-window suffix",
      });
    } catch {
      profiles.clear();
      return { ...settle(turns, profiles, "Claude assistant envelope"), reason: "Claude session log is unreadable" };
    }
  }

  if (thread.providerId === "pi") {
    let failureReason = "Pi session log is unreadable";
    try {
      const root = join(home, ".pi", "agent", "sessions");
      const directory = piProjectDirectory(home, environment?.path);
      const files = directory ? filesNamed(root, directory, (name) => /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.jsonl$/iu.test(name)) : [];
      const ambiguous = new Set();
      const assistantIds = new Set();
      for (const file of files) {
        const entries = [];
        await readJsonLines(file, (record) => {
          if (entries.length === 0 && (record?.type !== "session" || record.cwd !== environment.path)) {
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
        for (const record of entries) {
          if (record?.type !== "message" || record.message?.role !== "assistant") continue;
          let ancestor = record;
          const seen = new Set();
          while (typeof ancestor?.parentId === "string" && !seen.has(ancestor.parentId)) {
            seen.add(ancestor.parentId);
            ancestor = byId.get(ancestor.parentId);
            if (ancestor?.type === "thinking_level_change") break;
          }
          const nativeProvider = record.message?.provider;
          const nativeModel = record.message?.model;
          const model = typeof nativeProvider === "string" && nativeProvider !== "" && typeof nativeModel === "string" && nativeModel !== ""
            ? nativeModel.startsWith(`${nativeProvider}/`) ? nativeModel : `${nativeProvider}/${nativeModel}`
            : null;
          if (assistantIds.has(record.id)) ambiguous.add(record.id);
          assistantIds.add(record.id);
          add(record.id, model, ancestor?.thinkingLevel);
        }
      }
      const reason = !directory
        ? "BB environment path cannot identify an exact Pi project directory"
        : files.length === 0
        ? "expected at least one Pi session log in the exact environment-derived project directory, found 0"
        : "Pi checkpoints do not correlate to assistant message ids carrying model and reasoning level";
      const result = settle(turns, profiles, "Pi assistant message", { absentReason: reason, ambiguous });
      return result.outcome === "unknown" ? { ...result, reason } : result;
    } catch {
      profiles.clear();
      return { ...settle(turns, profiles, "Pi assistant message", { absentReason: failureReason }), reason: failureReason };
    }
  }

  const reason = `provider ${thread.providerId} has no measured native read-back`;
  return { ...settle(turns, profiles, "unsupported provider", { absentReason: reason, missingCorrelationReason: reason }), reason };
}

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) args.set(argv[index], argv[index + 1]);
  const projectId = args.get("--project");
  const threadId = args.get("--thread") ?? process.env.BB_THREAD_ID;
  if (!projectId || !threadId || [...args.keys()].some((key) => key !== "--project" && key !== "--thread")) {
    throw new Error("usage: node scripts/read-executed-profile.mjs --project <project-id> [--thread <thread-id>]");
  }
  return { projectId, threadId };
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
  const { projectId, threadId } = parseArgs(argv);
  const shown = bbJson(["thread", "show", threadId, "--json"]);
  if (shown?.thread?.id !== threadId || shown.thread.projectId !== projectId) throw new Error("thread does not belong to the exact project");
  const result = await readExecutedProfiles({ thread: shown.thread, environment: shown.environment, events: readAllEvents(threadId) });
  console.log(JSON.stringify({ threadId, projectId, providerId: shown.thread.providerId, ...result }, null, 2));
  if (result.outcome === "unknown") process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
