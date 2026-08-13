import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
type SidebarCollapseState = PluginRpcResult<typeof rpcContract["sidebarCollapseState"]>;

const MAX_VISIBLE_THREADS = 5;
const RUNNING_INDICATORS = new Set<PluginSidebarThread["indicator"]>([
  "working-draft",
  "workflow",
  "background-agent",
  "background-command",
  "plan-mode",
  "goal",
  "runtime",
  "draft",
]);
const ATTENTION_INDICATORS = new Set<PluginSidebarThread["indicator"]>(["unread-error", "waiting-for-input", "unread-success"]);

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

export type SidebarThreadSignal = "pending" | "attention" | "running" | "idle";

function activeCount(thread: PluginSidebarThread): number {
  return Object.values(thread.activity).reduce((total, count) => total + count, 0);
}

export function threadSignal(thread: PluginSidebarThread): { kind: SidebarThreadSignal; label: string } {
  if (thread.hasPendingInteraction) return { kind: "pending", label: thread.indicatorLabel ?? "Pending interaction" };
  if (ATTENTION_INDICATORS.has(thread.indicator)) return { kind: "attention", label: thread.indicatorLabel ?? "Needs attention" };
  if (activeCount(thread) > 0 || RUNNING_INDICATORS.has(thread.indicator)) {
    return { kind: "running", label: thread.indicatorLabel ?? "Running" };
  }
  return { kind: "idle", label: thread.indicatorLabel ?? "Idle" };
}

function isError(thread: PluginSidebarThread): boolean {
  return thread.indicator === "unread-error";
}

function indicatorClasses(thread: PluginSidebarThread): string {
  const signal = threadSignal(thread);
  if (signal.kind === "idle") return "border-l-transparent";
  if (signal.kind === "attention" && isError(thread)) return "border-l-destructive";
  return "border-l-primary";
}

// Four shapes, not four colours: the state stays readable with reduced motion on
// and at the 28px row height the native sidebar uses.
function signalShapeClasses(thread: PluginSidebarThread, kind: SidebarThreadSignal): string {
  if (kind === "running") return "size-2.5 animate-spin rounded-full border-2 border-primary border-t-transparent motion-reduce:animate-none";
  if (kind === "pending") return "flex size-3.5 animate-pulse items-center justify-center rounded-full bg-primary text-[9px] font-bold leading-none text-primary-foreground motion-reduce:animate-none";
  if (kind === "attention") return `size-2.5 rounded-full ${isError(thread) ? "bg-destructive" : "bg-primary"}`;
  return "size-1.5 rounded-full bg-muted-foreground/40";
}

function ThreadSignalIcon({ thread }: { thread: PluginSidebarThread }) {
  const signal = threadSignal(thread);
  return (
    <span
      className="flex w-3.5 shrink-0 items-center justify-center"
      role="img"
      aria-label={signal.label}
      title={signal.label}
      data-sidebar-thread-signal={signal.kind}
      data-active-count={activeCount(thread)}
    >
      <span className={signalShapeClasses(thread, signal.kind)} aria-hidden="true">{signal.kind === "pending" ? "!" : null}</span>
    </span>
  );
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

function sortSidebarThreads(threads: PluginSidebarThread[]): PluginSidebarThread[] {
  const inputIndex = new Map(threads.map((thread, index) => [thread.id, index]));
  return threads.sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    if (a.isPinned) return inputIndex.get(a.id)! - inputIndex.get(b.id)!;
    return sortRecent(a, b);
  });
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
  return [...groups.values()].map((group) => ({ ...group, threads: sortSidebarThreads(group.threads) }));
}

type ThreadTreeNode = { thread: PluginSidebarThread; children: ThreadTreeNode[] };

export function buildThreadTree(threads: readonly PluginSidebarThread[]): ThreadTreeNode[] {
  const nodes = new Map(threads.map((thread) => [thread.id, { thread, children: [] as ThreadTreeNode[] }]));
  const roots: ThreadTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.thread.parentThreadId ? nodes.get(node.thread.parentThreadId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sort = (items: ThreadTreeNode[]) => {
    const inputIndex = new Map(items.map((item, index) => [item.thread.id, index]));
    items.sort((a, b) => {
      if (a.thread.isPinned !== b.thread.isPinned) return a.thread.isPinned ? -1 : 1;
      if (a.thread.isPinned) return inputIndex.get(a.thread.id)! - inputIndex.get(b.thread.id)!;
      return sortRecent(a.thread, b.thread);
    });
    items.forEach((item) => sort(item.children));
  };
  sort(roots);
  return roots;
}

function collapseMap(values: Record<string, boolean>): Set<string> {
  return new Set(Object.entries(values).filter(([, collapsed]) => collapsed).map(([id]) => id));
}

const MENU_ITEM = "flex h-7 w-full shrink-0 items-center rounded px-2 text-left text-xs transition-colors duration-150 hover:bg-muted motion-reduce:transition-none";

function ThreadRow({
  thread,
  model,
  active,
  customState,
  depth,
  collapsed,
  hasChildren,
  onToggleChildren,
  onPinnedDragStart,
  onPinnedDragOver,
  onPinnedDragEnd,
  onNavigate,
}: {
  thread: PluginSidebarThread;
  model: string | null;
  active: boolean;
  customState: string | undefined;
  depth: number;
  collapsed: boolean;
  hasChildren: boolean;
  onToggleChildren: () => void;
  onPinnedDragStart: (threadId: string) => void;
  onPinnedDragOver: (threadId: string) => void;
  onPinnedDragEnd: (threadId: string) => void;
  onNavigate: () => void;
}) {
  const actions = experimental_useSidebarThreadActions();
  const title = threadTitle(thread);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(title);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => setRenameValue(title), [title]);
  useEffect(() => {
    if (!menuOpen) return;
    const closeOnOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutside);
    return () => document.removeEventListener("pointerdown", closeOnOutside);
  }, [menuOpen]);
  const finishRename = () => {
    const nextTitle = renameValue.trim();
    if (!nextTitle || nextTitle === title) {
      setRenaming(false);
      return;
    }
    void actions.rename(thread.id, nextTitle).catch(() => undefined);
    setRenaming(false);
  };
  const menuAction = (run: () => void) => {
    setMenuOpen(false);
    triggerRef.current?.focus();
    run();
  };
  return (
    <div
      className={`group relative flex h-7 items-center gap-1.5 rounded-md border-l-2 pr-1 text-left text-sm transition-colors duration-150 select-none hover:bg-muted/50 motion-reduce:transition-none ${indicatorClasses(thread)} ${active ? "bg-muted" : ""}`}
      style={{ paddingLeft: `${8 + depth * 16}px` }}
      onPointerDown={(event) => { if (thread.isPinned && event.button === 0) onPinnedDragStart(thread.id); }}
      onPointerEnter={() => onPinnedDragOver(thread.id)}
      onPointerUp={() => onPinnedDragEnd(thread.id)}
    >
      {renaming ? (
        <input autoFocus className="min-w-0 flex-1 rounded border border-border bg-background px-1 text-sm text-foreground" aria-label={`Rename ${title}`} value={renameValue} onChange={(event) => setRenameValue(event.target.value)} onBlur={finishRename} onKeyDown={(event) => { if (event.key === "Enter") finishRename(); if (event.key === "Escape") setRenaming(false); }} />
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <a
            href="#"
            className="flex min-w-0 items-center gap-1.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-current={active ? "page" : undefined}
            data-sidebar-thread-shortcut-target=""
            data-sidebar-thread-id={thread.id}
            draggable={false}
            title={thread.environment?.branchName ? `${title} — ${thread.environment.branchName}` : title}
            onClick={(event) => { event.preventDefault(); actions.open(thread.id); onNavigate(); }}
          >
            <ThreadSignalIcon thread={thread} />
            <span className="min-w-0 truncate text-foreground">{title}</span>
          </a>
          {hasChildren ? <button type="button" className="inline-flex size-4 shrink-0 items-center justify-center rounded text-xs leading-none text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground motion-reduce:transition-none" aria-label={`${collapsed ? "Expand" : "Collapse"} ${title} children`} aria-expanded={!collapsed} onClick={onToggleChildren}>{collapsed ? "›" : "⌄"}</button> : null}
        </span>
      )}
      <span className="flex min-w-0 shrink items-center gap-1 text-[11px] text-muted-foreground group-hover:hidden group-focus-within:hidden">
        {customState ? <span className="shrink-0 truncate rounded bg-muted px-1 leading-4" data-custom-thread-state="">{customState}</span> : null}
        <span className="max-w-[9rem] truncate" title={`Provider: ${thread.providerId}; model: ${model ?? "unavailable"}`}>{thread.providerId}/{model ?? "unavailable"}</span>
      </span>
      <button
        ref={triggerRef}
        type="button"
        className={`inline-flex size-5 shrink-0 items-center justify-center rounded text-xs leading-none text-muted-foreground transition-opacity duration-150 hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary group-hover:opacity-100 motion-reduce:transition-none ${menuOpen ? "opacity-100" : "opacity-0"}`}
        aria-label="Thread actions"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((open) => !open)}
      >
        ⋯
      </button>
      {menuOpen ? <div
        ref={menuRef}
        role="menu"
        aria-label={`${title} actions`}
        className="absolute right-1 top-7 z-20 flex w-44 flex-col rounded-md border border-border bg-background p-1 shadow"
        onKeyDown={(event) => { if (event.key === "Escape") { setMenuOpen(false); triggerRef.current?.focus(); } }}
      >
        <button autoFocus type="button" role="menuitem" className={MENU_ITEM} onClick={() => menuAction(() => actions.open(thread.id, { split: true }))}>Open in split</button>
        <button type="button" role="menuitem" className={MENU_ITEM} onClick={() => menuAction(() => { void actions.setRead(thread.id, thread.isUnread).catch(() => undefined); })}>{thread.isUnread ? "Mark read" : "Mark unread"}</button>
        <button type="button" role="menuitem" className={MENU_ITEM} onClick={() => menuAction(() => { void actions.setPinned(thread.id, !thread.isPinned).catch(() => undefined); })}>{thread.isPinned ? "Unpin" : "Pin"}</button>
        <button type="button" role="menuitem" className={MENU_ITEM} onClick={() => menuAction(() => setRenaming(true))}>Rename</button>
        <button type="button" role="menuitem" className={MENU_ITEM} onClick={() => menuAction(() => actions.archive(thread.id))}>Archive</button>
        <span role="separator" className="my-1 border-t border-border" />
        <button type="button" role="menuitem" className={`${MENU_ITEM} text-destructive`} onClick={() => menuAction(() => actions.requestDelete(thread.id))}>Delete</button>
      </div> : null}
    </div>
  );
}

export function SidebarThreadList({ activeThreadId, onNavigate, searchQuery }: PluginThreadListProps) {
  const sidebar = experimental_useSidebarThreads();
  const rpc = useRpc<typeof rpcContract>();
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set());
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set());
  const [collapsedThreads, setCollapsedThreads] = useState<Set<string>>(() => new Set());
  const draggingThreadId = useRef<string | null>(null);
  const dragTargetId = useRef<string | null>(null);
  const [customStates, setCustomStates] = useState<ThreadStates>({});
  const [threadModels, setThreadModels] = useState<ThreadModels>({});
  const threadIds = useMemo(() => sidebar.threads.map((thread) => thread.id), [sidebar.threads]);
  const threadIdsKey = threadIds.join("\u0000");
  const projectIds = useMemo(() => sidebar.projects.map((project) => project.id), [sidebar.projects]);
  const projectIdsKey = projectIds.join("\u0000");

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

  useEffect(() => {
    let mounted = true;
    void rpc.call("sidebarCollapseState", { projectIds, threadIds }).then((state: SidebarCollapseState) => {
      if (!mounted) return;
      setCollapsedProjects(collapseMap(state.projects));
      setCollapsedThreads(collapseMap(state.threads));
    }).catch(() => undefined);
    return () => { mounted = false; };
  }, [projectIdsKey, rpc, threadIdsKey]);

  const groups = groupThreads(sidebar.projects, sidebar.threads, searchQuery);
  if (sidebar.status === "loading") return <p className="p-3 text-sm text-muted-foreground">Loading threads…</p>;
  if (sidebar.status === "error") return <p className="p-3 text-sm text-destructive">Unable to load threads.</p>;
  if (groups.length === 0) return <p className="p-3 text-sm text-muted-foreground">No matching threads.</p>;

  const toggleProject = (projectId: string) => {
    const collapsed = !collapsedProjects.has(projectId);
    setCollapsedProjects((current) => { const next = new Set(current); if (collapsed) next.add(projectId); else next.delete(projectId); return next; });
    void rpc.call("setSidebarCollapse", { kind: "project", id: projectId, collapsed }).catch(() => undefined);
  };
  const toggleThread = (threadId: string) => {
    const collapsed = !collapsedThreads.has(threadId);
    setCollapsedThreads((current) => { const next = new Set(current); if (collapsed) next.add(threadId); else next.delete(threadId); return next; });
    void rpc.call("setSidebarCollapse", { kind: "thread", id: threadId, collapsed }).catch(() => undefined);
  };
  // Placement mirrors a sortable list: dragging down lands after the target,
  // dragging up lands before it. Anchoring on the target alone made every
  // downward drag a no-op.
  const reorderPinned = (draggedId: string, targetId: string) => {
    if (!draggedId || !targetId || draggedId === targetId) return;
    const order = sidebar.threads.filter((thread) => thread.isPinned).map((thread) => thread.id);
    const from = order.indexOf(draggedId);
    const to = order.indexOf(targetId);
    if (from < 0 || to < 0) return;
    const remaining = order.filter((id) => id !== draggedId);
    const insertionIndex = remaining.indexOf(targetId) + (from < to ? 1 : 0);
    void rpc.call("reorderPinned", { threadId: draggedId, previousThreadId: remaining[insertionIndex - 1] ?? null, nextThreadId: remaining[insertionIndex] ?? null }).catch(() => undefined);
  };
  const startPinnedDrag = (threadId: string) => {
    draggingThreadId.current = threadId;
    dragTargetId.current = null;
    // The row's own handler runs first. Reaching here with a source still armed
    // means the release missed every row: commit to the last row crossed on a
    // real release, discard on cancel, and never leave a stale source behind.
    const settle = (event: Event) => {
      if (event.type === "pointerup" && draggingThreadId.current) finishPinnedDrag("");
      draggingThreadId.current = null;
      dragTargetId.current = null;
      window.removeEventListener("pointerup", settle);
      window.removeEventListener("pointercancel", settle);
    };
    window.addEventListener("pointerup", settle);
    window.addEventListener("pointercancel", settle);
  };
  const trackPinnedDrag = (threadId: string) => { if (draggingThreadId.current) dragTargetId.current = threadId; };
  const finishPinnedDrag = (targetId: string) => {
    const draggedId = draggingThreadId.current ?? "";
    draggingThreadId.current = null;
    reorderPinned(draggedId, targetId || dragTargetId.current || "");
    dragTargetId.current = null;
  };

  const renderNode = (node: ThreadTreeNode, model: string | null, depth: number): ReactNode => {
    const childrenCollapsed = collapsedThreads.has(node.thread.id);
    return <div key={node.thread.id} className="space-y-px">
      <ThreadRow thread={node.thread} model={model} active={node.thread.id === activeThreadId} customState={customStates[node.thread.id]} depth={depth} collapsed={childrenCollapsed} hasChildren={node.children.length > 0} onToggleChildren={() => toggleThread(node.thread.id)} onPinnedDragStart={startPinnedDrag} onPinnedDragOver={trackPinnedDrag} onPinnedDragEnd={finishPinnedDrag} onNavigate={onNavigate} />
      {!childrenCollapsed ? node.children.map((child) => renderNode(child, threadModels[child.thread.id] ?? null, depth + 1)) : null}
    </div>;
  };

  return (
    <div className="h-full space-y-3 overflow-y-auto p-1">
      {groups.map(({ project, threads }) => {
        const tree = buildThreadTree(threads);
        const collapsed = collapsedProjects.has(project.id);
        const expanded = expandedProjects.has(project.id);
        const visibleThreads = expanded ? tree : tree.slice(0, MAX_VISIBLE_THREADS);
        return (
          <section key={project.id} aria-labelledby={`project-${project.id}`}>
            <div className="flex h-6 items-center gap-1.5 rounded-md pl-2 pr-1 text-xs font-normal text-muted-foreground">
              <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[9px] leading-none text-foreground" aria-hidden="true">{projectAvatar(project.name)}</span>
              <span id={`project-${project.id}`} className="min-w-0 truncate">{project.name}</span>
              <span className="ml-auto shrink-0 tabular-nums">{threads.length}</span>
              <button type="button" className="inline-flex size-4 shrink-0 items-center justify-center rounded leading-none transition-colors duration-150 hover:bg-muted hover:text-foreground motion-reduce:transition-none" aria-label={`${collapsed ? "Expand" : "Collapse"} ${project.name} section`} aria-expanded={!collapsed} onClick={() => toggleProject(project.id)}>{collapsed ? "›" : "⌄"}</button>
            </div>
            {!collapsed ? <div className="mt-0.5 space-y-px">
              {visibleThreads.map((node) => renderNode(node, threadModels[node.thread.id] ?? null, 0))}
              {tree.length > MAX_VISIBLE_THREADS ? (
                <button
                  type="button"
                  className="flex h-6 w-full items-center rounded-md pl-2 text-left text-xs text-muted-foreground transition-colors duration-150 hover:bg-muted/50 hover:text-foreground motion-reduce:transition-none"
                  onClick={() => setExpandedProjects((current) => {
                    const updated = new Set(current);
                    if (expanded) updated.delete(project.id);
                    else updated.add(project.id);
                    return updated;
                  })}
                >
                  {expanded ? "Show less" : `Show more (${tree.length - MAX_VISIBLE_THREADS})`}
                </button>
              ) : null}
            </div> : null}
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
