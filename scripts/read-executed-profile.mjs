import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const PAGE_SIZE = 1_000;

function filesNamed(root, predicate) {
  if (!existsSync(root)) return [];
  const found = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && predicate(entry.name)) found.push(path);
    }
  }
  return found;
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

function settle(turns, profiles, source) {
  const results = turns.map((turn) => {
    if (!turn.checkpointId || !turn.providerThreadId) {
      return { ...turn, status: "unknown", reason: "BB completion lacks provider correlation" };
    }
    const matches = profiles.get(turn.checkpointId) ?? [];
    const distinct = [...new Map(matches.map((profile) => [`${profile.model}\0${profile.reasoningLevel}`, profile])).values()];
    if (distinct.length !== 1) {
      return { ...turn, status: "unknown", reason: distinct.length === 0 ? "provider-native turn profile is absent" : "provider-native turn profiles conflict" };
    }
    return { ...turn, status: "known", executedProfile: { ...distinct[0], kind: "executed-provider-native", source } };
  });
  const knownTurns = results.filter((turn) => turn.status === "known").length;
  return {
    outcome: knownTurns === results.length && results.length > 0 ? "known" : knownTurns > 0 ? "partial" : "unknown",
    coverage: { completedTurns: results.length, knownTurns, unknownTurns: results.length - knownTurns },
    turns: results,
  };
}

export async function readExecutedProfiles({ thread, events, home = homedir() }) {
  const turns = completedTurns(events);
  const providerThreadIds = [...new Set(turns.map((turn) => turn.providerThreadId).filter(Boolean))];
  if (providerThreadIds.length !== 1) {
    return { outcome: "unknown", coverage: { completedTurns: turns.length, knownTurns: 0, unknownTurns: turns.length }, turns, reason: "BB completions do not resolve to one provider session" };
  }
  const providerThreadId = providerThreadIds[0];
  const profiles = new Map();
  const add = (turnId, model, reasoningLevel) => {
    if (![turnId, model, reasoningLevel].every((value) => typeof value === "string" && value !== "")) return;
    profiles.set(turnId, [...(profiles.get(turnId) ?? []), { providerId: thread.providerId, model, reasoningLevel }]);
  };

  if (thread.providerId === "codex") {
    try {
      const files = filesNamed(join(home, ".codex", "sessions"), (name) => name.endsWith(`-${providerThreadId}.jsonl`));
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
      const files = filesNamed(join(home, ".claude", "projects"), (name) => name === `${providerThreadId}.jsonl`);
      if (files.length !== 1) return { ...settle(turns, profiles, "Claude assistant envelope"), reason: `expected one Claude session log, found ${files.length}` };
      await readJsonLines(files[0], (record) => {
        if (record?.type === "assistant" && record.message?.model !== "<synthetic>") add(record.uuid, record.message?.model, record.effort);
      });
      return settle(turns, profiles, "Claude assistant envelope");
    } catch {
      profiles.clear();
      return { ...settle(turns, profiles, "Claude assistant envelope"), reason: "Claude session log is unreadable" };
    }
  }

  return { ...settle(turns, profiles, "unsupported provider"), reason: `provider ${thread.providerId} has no measured native read-back` };
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
  const result = await readExecutedProfiles({ thread: shown.thread, events: readAllEvents(threadId) });
  console.log(JSON.stringify({ threadId, projectId, providerId: shown.thread.providerId, ...result }, null, 2));
  if (result.outcome === "unknown") process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
