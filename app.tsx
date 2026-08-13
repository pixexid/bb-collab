import { useCallback, useEffect, useMemo, useState } from "react";
import { definePluginApp, experimental_useSidebarThreadActions, experimental_useSidebarThreads, useRpc } from "@bb/plugin-sdk/app";
import type {
  PluginComposerThreadRowStatus,
  PluginPendingInteractionProps,
  PluginRpcResult,
  PluginSidebarProject,
  PluginSidebarThread,
  PluginThreadListProps,
} from "@bb/plugin-sdk/app";
import type { rpcContract } from "./server";

type Lane = PluginRpcResult<typeof rpcContract["lanes"]>[number];
type ThreadStates = PluginRpcResult<typeof rpcContract["threadStates"]>;
type ThreadModels = PluginRpcResult<typeof rpcContract["threadModels"]>;

const MAX_VISIBLE_THREADS = 5;

function threadTitle(thread: PluginSidebarThread): string {
  return thread.title ?? thread.titleFallback ?? "Untitled thread";
}

function projectAvatar(name: string): string {
  const initials = name
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
  return initials || "?";
}

function indicatorClasses(thread: PluginSidebarThread): string {
  if (thread.indicator === "unread-error") return "border-l-destructive text-destructive";
  if (thread.hasPendingInteraction || thread.indicator === "waiting-for-input") return "border-l-primary text-primary animate-pulse";
  if (thread.indicator !== "none") return "border-l-primary text-primary";
  return "border-l-border";
}

function matchesSearch(thread: PluginSidebarThread, project: PluginSidebarProject, searchQuery: string): boolean {
  const query = searchQuery.trim().toLocaleLowerCase();
  if (!query) return true;
  return [threadTitle(thread), thread.providerId, project.name, thread.environment?.branchName ?? ""]
    .some((value) => value.toLocaleLowerCase().includes(query));
}

function sortRecent(a: PluginSidebarThread, b: PluginSidebarThread): number {
  return b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id);
}

export function groupThreads(
  projects: readonly PluginSidebarProject[],
  threads: readonly PluginSidebarThread[],
  searchQuery = "",
) {
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const groups = new Map<string, { project: PluginSidebarProject; threads: PluginSidebarThread[] }>();
  for (const thread of threads) {
    const project = projectById.get(thread.projectId) ?? { id: thread.projectId, name: thread.projectId, isPersonal: false };
    if (!matchesSearch(thread, project, searchQuery)) continue;
    const group = groups.get(project.id) ?? { project, threads: [] };
    group.threads.push(thread);
    groups.set(project.id, group);
  }
  return [...groups.values()].map((group) => ({ ...group, threads: group.threads.sort(sortRecent) }));
}

function ThreadRow({
  thread,
  model,
  active,
  customState,
  onNavigate,
  onToggleState,
}: {
  thread: PluginSidebarThread;
  model: string | null;
  active: boolean;
  customState: string | undefined;
  onNavigate: () => void;
  onToggleState: () => void;
}) {
  const actions = experimental_useSidebarThreadActions();
  const title = threadTitle(thread);
  const pendingLabel = thread.hasPendingInteraction ? "Pending interaction" : thread.indicatorLabel;
  return (
    <div
      className={`group flex items-start gap-2 border-l-2 px-3 py-2 text-left text-sm hover:bg-muted/50 ${indicatorClasses(thread)} ${active ? "bg-muted" : ""}`}
      role="button"
      tabIndex={0}
      aria-current={active ? "page" : undefined}
      onClick={() => {
        actions.open(thread.id);
        onNavigate();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        actions.open(thread.id);
        onNavigate();
      }}
    >
      <span className="mt-1 w-2 shrink-0 text-center" aria-label={pendingLabel ?? undefined}>
        {thread.hasPendingInteraction || thread.indicator !== "none" ? "●" : "·"}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-foreground">{title}</span>
        <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          <span className="max-w-[12rem] truncate rounded bg-muted px-1.5 py-0.5" title={`Provider: ${thread.providerId}; model: ${model ?? "unavailable"}`}>{thread.providerId}/{model ?? "unavailable"}</span>
          {thread.environment?.branchName ? <span className="truncate">{thread.environment.branchName}</span> : null}
          {customState ? <span className="truncate rounded bg-muted px-1.5 py-0.5">{customState}</span> : null}
        </span>
      </span>
      <button
        type="button"
        className="shrink-0 rounded px-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label={customState ? "Clear custom state" : "Set custom state"}
        onClick={(event) => {
          event.stopPropagation();
          onToggleState();
        }}
      >
        {customState ? "✓" : "+"}
      </button>
    </div>
  );
}

export function SidebarThreadList({ activeThreadId, onNavigate, searchQuery }: PluginThreadListProps) {
  const sidebar = experimental_useSidebarThreads();
  const rpc = useRpc<typeof rpcContract>();
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set());
  const [customStates, setCustomStates] = useState<ThreadStates>({});
  const [threadModels, setThreadModels] = useState<ThreadModels>({});
  const threadIds = useMemo(() => sidebar.threads.map((thread) => thread.id), [sidebar.threads]);
  const threadIdsKey = threadIds.join("\u0000");

  useEffect(() => {
    let mounted = true;
    void rpc.call("threadStates", { threadIds }).then((states) => {
      if (mounted) setCustomStates(states);
    }).catch(() => {
      if (mounted) setCustomStates({});
    });
    void rpc.call("threadModels", { threadIds }).then((models) => {
      if (mounted) setThreadModels(models);
    }).catch(() => {
      if (mounted) setThreadModels(Object.fromEntries(threadIds.map((threadId) => [threadId, null])));
    });
    return () => {
      mounted = false;
    };
  }, [rpc, threadIdsKey]);

  const groups = groupThreads(sidebar.projects, sidebar.threads, searchQuery);
  if (sidebar.status === "loading") return <p className="p-3 text-sm text-muted-foreground">Loading threads…</p>;
  if (sidebar.status === "error") return <p className="p-3 text-sm text-destructive">Unable to load threads.</p>;
  if (groups.length === 0) return <p className="p-3 text-sm text-muted-foreground">No matching threads.</p>;

  const toggleCustomState = (threadId: string) => {
    const next = customStates[threadId] ? null : "tracked";
    void rpc.call("setThreadState", { threadId, state: next }).then(({ state }) => {
      setCustomStates((current) => {
        const updated = { ...current };
        if (state === null) delete updated[threadId];
        else updated[threadId] = state;
        return updated;
      });
    }).catch(() => undefined);
  };

  return (
    <div className="h-full overflow-y-auto">
      {groups.map(({ project, threads }) => {
        const expanded = expandedProjects.has(project.id);
        const visibleThreads = expanded ? threads : threads.slice(0, MAX_VISIBLE_THREADS);
        return (
          <section key={project.id} aria-labelledby={`project-${project.id}`}>
            <div className="flex items-center gap-2 px-3 py-2 text-xs font-semibold text-muted-foreground">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-foreground" aria-hidden="true">{projectAvatar(project.name)}</span>
              <span id={`project-${project.id}`} className="truncate">{project.name}</span>
              <span className="ml-auto tabular-nums">{threads.length}</span>
            </div>
            <div>
              {visibleThreads.map((thread) => (
                <ThreadRow
                  key={thread.id}
                  thread={thread}
                  model={threadModels[thread.id] ?? null}
                  active={thread.id === activeThreadId}
                  customState={customStates[thread.id]}
                  onNavigate={onNavigate}
                  onToggleState={() => toggleCustomState(thread.id)}
                />
              ))}
              {threads.length > MAX_VISIBLE_THREADS ? (
                <button
                  type="button"
                  className="w-full px-3 py-2 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() => setExpandedProjects((current) => {
                    const updated = new Set(current);
                    if (expanded) updated.delete(project.id);
                    else updated.add(project.id);
                    return updated;
                  })}
                >
                  {expanded ? "Show less" : `Show more (${threads.length - MAX_VISIBLE_THREADS})`}
                </button>
              ) : null}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function OperatorReceiptForm({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const payload = interaction.payload as {
    projectId?: unknown;
    mutationClass?: unknown;
    candidateHead?: unknown;
    retirementCondition?: unknown;
  };
  const [confirmed, setConfirmed] = useState(false);
  const valid = typeof payload.projectId === "string" && typeof payload.mutationClass === "string" && typeof payload.candidateHead === "string";
  const projectId = typeof payload.projectId === "string" ? payload.projectId : null;
  const mutationClass = typeof payload.mutationClass === "string" ? payload.mutationClass : null;
  const candidateHead = typeof payload.candidateHead === "string" ? payload.candidateHead : null;

  return (
    <form
      className="space-y-4 border-t border-border bg-background p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid || !confirmed) return;
        void submit({
          confirmed: true,
          projectId,
          mutationClass,
          candidateHead,
        });
      }}
    >
      <div>
        <h2 className="font-semibold">Confirm operator receipt</h2>
        <p className="text-sm text-muted-foreground">This records an interim confirmation only; it does not authorize a mutation.</p>
      </div>
      <dl className="grid gap-2 text-sm">
        <div><dt className="text-muted-foreground">Project</dt><dd className="font-mono">{String(payload.projectId ?? "invalid")}</dd></div>
        <div><dt className="text-muted-foreground">Mutation</dt><dd className="font-mono">{String(payload.mutationClass ?? "invalid")}</dd></div>
        <div><dt className="text-muted-foreground">Candidate head</dt><dd className="break-all font-mono">{String(payload.candidateHead ?? "invalid")}</dd></div>
        <div><dt className="text-muted-foreground">Retirement condition</dt><dd>{String(payload.retirementCondition ?? "invalid")}</dd></div>
      </dl>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
        <span>I confirm this exact project, mutation class, and candidate head.</span>
      </label>
      <div className="flex gap-2">
        <button className="rounded border border-border px-3 py-1 text-sm" type="button" onClick={() => void cancel()}>Cancel</button>
        <button className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground disabled:opacity-50" type="submit" disabled={!valid || !confirmed}>Confirm</button>
      </div>
    </form>
  );
}

function age(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}

function LanesPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const [lanes, setLanes] = useState<readonly Lane[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void rpc
      .call("lanes", {})
      .then((next) => {
        setLanes(next);
        setError(null);
      })
      .catch((reason: unknown) => setError(String(reason)));
  }, [rpc]);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 5_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return (
    <main className="h-full overflow-y-auto p-5">
      <div className="mx-auto max-w-4xl">
        <div className="mb-5 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold">Lanes</h1>
            <p className="text-sm text-muted-foreground">Open lanes from bb-collab storage.</p>
          </div>
          <button className="text-sm text-muted-foreground hover:text-foreground" onClick={refresh}>Refresh</button>
        </div>
        {error ? <p className="text-sm text-destructive">Unable to read lanes: {error}</p> : null}
        {lanes.length === 0 ? <p className="text-sm text-muted-foreground">No open lanes.</p> : null}
        <div className="divide-y divide-border border-y border-border">
          {lanes.map((lane) => (
            <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-4 py-3 text-sm" key={lane.executionAttemptId}>
              <div className="min-w-0">
                <div className="truncate font-medium">{lane.laneId}</div>
                <div className="truncate text-xs text-muted-foreground">{lane.assignmentKind} · {lane.threadId ?? "worker not attached"}</div>
              </div>
              <div className="text-muted-foreground">{lane.waitingOn ?? "worker"}</div>
              <time className="text-muted-foreground" title={`${lane.ageMs}ms old`}>{age(lane.ageMs)}</time>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}

async function readLanes(signal: AbortSignal): Promise<Lane[]> {
  const response = await fetch("/api/v1/plugins/bb-collab/http/lanes", { credentials: "same-origin", signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as Lane[];
}

function mountLanePulse({ signal, setStatus }: { signal: AbortSignal; setStatus: (threadId: string, status: PluginComposerThreadRowStatus | null) => void }): () => void {
  let previous = new Set<string>();
  const refresh = async () => {
    try {
      const lanes = await readLanes(signal);
      const next = new Set<string>();
      for (const lane of lanes) {
        if (!lane.threadId) continue;
        next.add(lane.threadId);
        setStatus(lane.threadId, {
          icon: lane.tone === "error" ? "AlertTriangle" : "GitBranch",
          label: lane.waitingOn ? `Lane ${lane.laneId}: waiting on ${lane.waitingOn}` : `Lane ${lane.laneId}: open`,
          tone: lane.tone,
        });
      }
      for (const threadId of previous) if (!next.has(threadId)) setStatus(threadId, null);
      previous = next;
    } catch {
      // A transient server/read failure must not clear the last known pulse.
    }
  };
  void refresh();
  const timer = window.setInterval(refresh, 5_000);
  return () => window.clearInterval(timer);
}

export default definePluginApp((app) => {
  app.slots.experimental_threadList({
    id: "bb-collab-threads",
    title: "bb-collab thread list",
    description: "Group threads by project with durable bb-collab state.",
    component: SidebarThreadList,
  });
  app.slots.pendingInteraction({ id: "operator-receipt", component: OperatorReceiptForm });
  app.slots.navPanel({
    id: "lanes",
    title: "Lanes",
    icon: "GitBranch",
    path: "lanes",
    component: LanesPanel,
  });
  app.contentScripts.register({
    id: "lane-thread-status",
    mount: ({ signal, experimental_setThreadRowStatus }) => {
      if (!experimental_setThreadRowStatus) return;
      return mountLanePulse({ signal, setStatus: experimental_setThreadRowStatus });
    },
  });
});
