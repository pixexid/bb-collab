import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { definePluginApp, experimental_useSidebarThreadActions, experimental_useSidebarThreads, useRpc } from "@get-bb/plugin-sdk/app";
import type {
  PluginRpcResult,
  PluginSidebarProject,
  PluginSidebarThread,
  PluginThreadListProps,
} from "@get-bb/plugin-sdk/app";
import { providerMark, providerMarkKey } from "./src/provider-marks";
import type { rpcContract } from "./server";

type ThreadStates = PluginRpcResult<typeof rpcContract["threadStates"]>;
type ThreadModels = PluginRpcResult<typeof rpcContract["threadModels"]>;
type ThreadExecution = NonNullable<ThreadModels[string]>;
type SidebarCollapseState = PluginRpcResult<typeof rpcContract["sidebarCollapseState"]>;

const SETTINGS_ACTION_TITLE = "bb-collab settings";
const STATE_MIGRATION_NOTICE_KEY = "bb-plugin-threads-list.state-migration-notice";

function migrationNoticeVisible(): boolean {
  try {
    return window.localStorage.getItem(STATE_MIGRATION_NOTICE_KEY) !== "dismissed";
  } catch {
    // Unavailable storage must not hide the notice or take down the sidebar.
    return true;
  }
}

export function dismissMigrationNotice(): boolean {
  try {
    window.localStorage.setItem(STATE_MIGRATION_NOTICE_KEY, "dismissed");
    return true;
  } catch {
    // Keep the notice visible when persistence is unavailable.
    return false;
  }
}

function age(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}

const MAX_VISIBLE_THREADS = 5;
// The exact project reader returns at most 256 rows; keep the aggregate panel
// at that measured display budget and disclose the spill instead of hiding it.
const SIDEBAR_RPC_BATCH_SIZE = 256;
export function sidebarRpcBatches(ids: readonly string[]): string[][] {
  const batches: string[][] = [];
  for (let index = 0; index < ids.length; index += SIDEBAR_RPC_BATCH_SIZE) batches.push(ids.slice(index, index + SIDEBAR_RPC_BATCH_SIZE));
  return batches;
}

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

// Values arriving from the host DTO and from this plugin's own RPC are typed,
// not proven. A frontend bundle can outlive the server build it was compiled
// against — a stale bundle rendering a newer server's `{ model, reasoning }`
// object as a React child is what took the sidebar down — so anything that
// reaches JSX or a string method passes through here first.
function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function threadTitle(thread: PluginSidebarThread): string {
  return asText(thread.title) ?? asText(thread.titleFallback) ?? "Untitled thread";
}

function projectAvatar(name: unknown): string {
  const initials = (asText(name) ?? "")
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
  const activity: unknown = thread.activity;
  if (!activity || typeof activity !== "object") return 0;
  return Object.values(activity).reduce<number>((total, count) => total + (typeof count === "number" ? count : 0), 0);
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

// The native list gives status one 16px box at the row's trailing edge holding
// exactly one glyph. Measured off the built-in list in the running app: the
// wrapper is `size-4` (`size-5` on coarse pointers) and the dot inside it is
// 5px. Matching those numbers is the whole point — a different size or slot
// reads as a different control.
const TRAILING_SLOT = "inline-flex size-4 shrink-0 items-center justify-center max-md:pointer-coarse:size-5";
const LEADING_SLOT = "inline-flex size-3.5 shrink-0 items-center justify-center";
const NATIVE_DOT = "size-[5px] rounded-full max-md:pointer-coarse:size-1.5";

export function signalDotClasses(thread: PluginSidebarThread, kind: SidebarThreadSignal): string {
  if (kind === "attention" && isError(thread)) return "bg-destructive";
  if (kind === "pending") return "bg-primary";
  return "bg-muted-foreground/60";
}

// Native's spinner tick ring, so the working state reads as BB's own rather
// than a second dialect. Unlike native it takes a theme accent instead of a
// muted grey: this list is denser, and a muted spinner stops being scannable.
function RunningSpinner({ label }: { label: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-4 animate-spin text-primary max-md:pointer-coarse:size-5 motion-reduce:animate-none"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      role="img"
      aria-label={label}
      data-sidebar-thread-spinner=""
    >
      <path d="M12 3V6" />
      <path d="M12 18V21" />
      <path d="M21 12L18 12" />
      <path d="M6 12L3 12" />
      <path d="M18.3635 5.63672L16.2422 7.75804" />
      <path d="M7.75804 16.2422L5.63672 18.3635" />
      <path d="M18.3635 18.3635L16.2422 16.2422" />
      <path d="M7.75804 7.75804L5.63672 5.63672" />
    </svg>
  );
}

// Working state leads the row, ahead of the session name, so a scan down the
// left edge answers "what is running" without reading across. Nothing is
// reserved when idle: the spinner is absent, not invisible, so a still row
// never carries a blank gutter.
function ThreadRunningSpinner({ thread }: { thread: PluginSidebarThread }) {
  const signal = threadSignal(thread);
  if (signal.kind !== "running") return null;
  return (
    <span className={LEADING_SLOT} data-sidebar-thread-signal="running">
      <RunningSpinner label={signal.label} />
    </span>
  );
}

// State stays a small colour-only dot in the native trailing slot, the way the
// built-in list does it. Working rows are the spinner's job, so the dot never
// doubles as one; an idle read row draws nothing.
function ThreadStateDot({ thread }: { thread: PluginSidebarThread }) {
  const signal = threadSignal(thread);
  if (signal.kind === "idle" || signal.kind === "running") return null;
  return (
    <span className={TRAILING_SLOT} data-sidebar-thread-signal={signal.kind}>
      <span
        className={`${NATIVE_DOT} ${signalDotClasses(thread, signal.kind)}`}
        role="img"
        aria-label={signal.label}
        title={signal.label}
        data-sidebar-thread-dot=""
      />
    </span>
  );
}

// BB's own official marks, vendored verbatim from the host bundle (see
// src/provider-marks.ts). Monochrome `currentColor` so the glyph inherits the
// row's theme token, bundled so nothing is fetched. A provider BB ships no
// mark for renders no glyph rather than an invented one.
function ProviderMark({ providerId }: { providerId: string }) {
  const mark = providerMark(providerId);
  if (!mark) return null;
  return (
    <svg
      viewBox={mark.viewBox}
      className="size-3 shrink-0"
      fill="currentColor"
      fillRule={mark.fillRule}
      aria-hidden="true"
      focusable="false"
      data-provider-mark={providerMarkKey(providerId)}
    >
      {mark.paths.map((path) => <path key={path} d={path} />)}
    </svg>
  );
}

// Ordered: the family word is a suffix as often as a prefix, so the first hit
// wins and the prefix entries stay last.
const MODEL_SHORT_NAMES: readonly (readonly [string, string])[] = [
  ["luna", "Luna"],
  ["sol", "Sol"],
  ["opus", "Opus"],
  ["sonnet", "Sonnet"],
  ["haiku", "Haiku"],
  ["fable", "Fable"],
  ["kimi", "Kimi"],
  ["gemini", "Gemini"],
  ["grok", "Grok"],
  ["claude", "Claude"],
  ["gpt", "GPT"],
];
const UNAVAILABLE_SHORT_NAME = "—";

export function shortModelName(model: string | null): string {
  if (!model) return UNAVAILABLE_SHORT_NAME;
  const key = model.toLocaleLowerCase();
  const known = MODEL_SHORT_NAMES.find(([needle]) => key.includes(needle));
  if (known) return known[1];
  // Fallback still names what the host reported — the id's own first word, never
  // an invented family.
  const family = key.split("/").at(-1)!.split(/[-_.:]/u).find(Boolean);
  return family ? family[0].toUpperCase() + family.slice(1, 8) : UNAVAILABLE_SHORT_NAME;
}

const REASONING_LETTERS: Record<string, string> = { low: "L", medium: "M", high: "H", xhigh: "X", max: "MAX" };
const UNAVAILABLE_REASONING_LETTER = "–";

// Levels outside the operator's letter set keep the neutral mark; the exact SDK
// level still reaches the badge's accessible name.
export function reasoningLetter(reasoning: string | null): string {
  return REASONING_LETTERS[reasoning ?? ""] ?? UNAVAILABLE_REASONING_LETTER;
}

export function executionBadgeLabel(providerId: string, execution: ThreadExecution | null): string {
  const provider = asText(providerId) ?? "unavailable";
  return `${provider} · model ${asText(execution?.model) ?? "unavailable"} · reasoning ${asText(execution?.reasoning) ?? "unavailable"}`;
}

function ExecutionBadge({ providerId, execution }: { providerId: string; execution: ThreadExecution | null }) {
  const label = executionBadgeLabel(providerId, execution);
  return (
    <span className="flex min-w-0 items-center gap-1" role="img" aria-label={label} title={label} data-thread-execution-badge="">
      <ProviderMark providerId={providerId} />
      <span className="min-w-0 truncate">{shortModelName(asText(execution?.model))}·{reasoningLetter(asText(execution?.reasoning))}</span>
    </span>
  );
}

function matchesSearch(thread: PluginSidebarThread, project: PluginSidebarProject, searchQuery: string): boolean {
  const query = searchQuery.trim().toLocaleLowerCase();
  if (!query) return true;
  return [threadTitle(thread), asText(thread.providerId), asText(project.name), asText(thread.environment?.branchName)]
    .some((value) => (value ?? "").toLocaleLowerCase().includes(query));
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
  execution,
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
  execution: ThreadExecution | null;
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
      className={`group/row relative flex h-7 items-center gap-1.5 rounded-md pr-1 text-left text-sm transition-colors duration-150 select-none hover:bg-muted/50 motion-reduce:transition-none ${active ? "bg-muted" : ""}`}
      style={{ paddingLeft: `${8 + depth * 16}px` }}
      onPointerDown={(event) => { if (thread.isPinned && event.button === 0) onPinnedDragStart(thread.id); }}
      onPointerEnter={() => onPinnedDragOver(thread.id)}
      onPointerUp={() => onPinnedDragEnd(thread.id)}
    >
      {renaming ? (
        <input autoFocus className="min-w-0 flex-1 rounded border border-border bg-background px-1 text-sm text-foreground" aria-label={`Rename ${title}`} value={renameValue} onChange={(event) => setRenameValue(event.target.value)} onBlur={finishRename} onKeyDown={(event) => { if (event.key === "Enter") finishRename(); if (event.key === "Escape") setRenaming(false); }} />
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <ThreadRunningSpinner thread={thread} />
          <a
            href="#"
            className="min-w-0 truncate rounded-md text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-current={active ? "page" : undefined}
            data-sidebar-thread-shortcut-target=""
            data-sidebar-thread-id={thread.id}
            draggable={false}
            title={thread.environment?.branchName ? `${title} — ${thread.environment.branchName}` : title}
            onClick={(event) => { event.preventDefault(); actions.open(thread.id); onNavigate(); }}
          >
            {title}
          </a>
          {hasChildren ? <button type="button" className="inline-flex size-4 shrink-0 items-center justify-center rounded text-xs leading-none text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground motion-reduce:transition-none" aria-label={`${collapsed ? "Expand" : "Collapse"} ${title} children`} aria-expanded={!collapsed} onClick={onToggleChildren}>{collapsed ? "›" : "⌄"}</button> : null}
        </span>
      )}
      {/* Status sits outside the cross-fading cluster below. Native lets its
          indicator fade under the hover actions; here the row is denser and a
          working thread you are pointing at is exactly the one whose state you
          still want to read, so it stays put. */}
      <ThreadStateDot thread={thread} />
      {/* Meta and actions share one slot and only cross-fade: hovering a row
          must not reflow it, or whatever you were aiming at moves. Capped so
          the title keeps the majority of the row. */}
      <span className="relative flex min-w-5 max-w-[45%] shrink items-center justify-end">
        <span className={`flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground transition-opacity duration-150 group-focus-within/row:opacity-0 group-hover/row:opacity-0 motion-reduce:transition-none ${menuOpen ? "opacity-0" : ""}`}>
          {asText(customState) ? <span className="min-w-0 truncate rounded bg-muted px-1 leading-4" data-custom-thread-state="">{asText(customState)}</span> : null}
          <ExecutionBadge providerId={thread.providerId} execution={execution} />
        </span>
        <button
          ref={triggerRef}
          type="button"
          className={`absolute right-0 z-10 inline-flex size-5 shrink-0 items-center justify-center rounded text-xs leading-none text-muted-foreground transition-opacity duration-150 hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary group-hover/row:opacity-100 motion-reduce:transition-none ${menuOpen ? "opacity-100" : "opacity-0"}`}
          aria-label="Thread actions"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          ⋯
        </button>
      </span>
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
  const provenUnread = useRef(new Map<string, number>());
  const reportedBreak = useRef<string | null>(null);
  const dragTargetId = useRef<string | null>(null);
  const [customStates, setCustomStates] = useState<ThreadStates>({});
  const [indicatorBroken, setIndicatorBroken] = useState<string | null>(null);
  const [threadModels, setThreadModels] = useState<ThreadModels>({});
  const [stateMigrationNotice, setStateMigrationNotice] = useState(migrationNoticeVisible);
  const threadIds = useMemo(() => sidebar.threads.map((thread) => thread.id), [sidebar.threads]);
  const threadIdsKey = threadIds.join("\u0000");
  const projectIds = useMemo(() => sidebar.projects.map((project) => project.id), [sidebar.projects]);
  const projectIdsKey = projectIds.join("\u0000");

  useEffect(() => {
    let mounted = true;
    void Promise.all(sidebarRpcBatches(threadIds).map((batch) => rpc.call("threadStates", { threadIds: batch }))).then((states) => {
      const merged = Object.assign({}, ...states);
      if (mounted) setCustomStates(merged);
    }).catch(() => {
      if (mounted) setCustomStates({});
    });
    void Promise.all(sidebarRpcBatches(threadIds).map((batch) => rpc.call("threadModels", { threadIds: batch }))).then((models) => {
      const merged = Object.assign({}, ...models);
      if (mounted) setThreadModels(merged);
    }).catch(() => {
      if (mounted) setThreadModels(Object.fromEntries(threadIds.map((threadId) => [threadId, null])));
    });
    return () => {
      mounted = false;
    };
  }, [rpc, threadIdsKey]);

  useEffect(() => {
    let mounted = true;
    const projectBatches = sidebarRpcBatches(projectIds);
    const threadBatches = sidebarRpcBatches(threadIds);
    void Promise.all(Array.from({ length: Math.max(projectBatches.length, threadBatches.length) }, (_, index) => rpc.call("sidebarCollapseState", {
      projectIds: projectBatches[index] ?? [],
      threadIds: threadBatches[index] ?? [],
    }))).then((states) => {
      const state: SidebarCollapseState = {
        projects: Object.assign({}, ...states.map((result) => result.projects)),
        threads: Object.assign({}, ...states.map((result) => result.threads)),
      };
      if (!mounted) return;
      setCollapsedProjects(collapseMap(state.projects));
      setCollapsedThreads(collapseMap(state.threads));
    }).catch(() => undefined);
    return () => { mounted = false; };
  }, [projectIdsKey, rpc, threadIdsKey]);

  const groups = groupThreads(sidebar.projects, sidebar.threads, searchQuery);
  if (sidebar.status === "loading") return <><p className="p-3 text-sm text-muted-foreground">Loading threads…</p></>;
  if (sidebar.status === "error") return <><p className="p-3 text-sm text-destructive">Unable to load threads.</p></>;
  if (groups.length === 0) return <><p className="p-3 text-sm text-muted-foreground">No matching threads.</p></>;

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
    const byId = new Map(sidebar.threads.map((thread) => [thread.id, thread]));
    const dragged = byId.get(draggedId);
    const target = byId.get(targetId);
    if (!dragged?.isPinned || !target?.isPinned) return;
    // Pinned rows are only ever adjacent inside one project group, so the
    // neighbours handed to the host come from that group. A global pinned list
    // names neighbours the user never saw next to the row.
    if (dragged.projectId !== target.projectId) return;
    const order = sidebar.threads.filter((thread) => thread.isPinned && thread.projectId === dragged.projectId).map((thread) => thread.id);
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

  const renderNode = (node: ThreadTreeNode, execution: ThreadExecution | null, depth: number): ReactNode => {
    const childrenCollapsed = collapsedThreads.has(node.thread.id);
    return <div key={node.thread.id} className="space-y-px">
      <ThreadRow thread={node.thread} execution={execution} active={node.thread.id === activeThreadId} customState={customStates[node.thread.id]} depth={depth} collapsed={childrenCollapsed} hasChildren={node.children.length > 0} onToggleChildren={() => toggleThread(node.thread.id)} onPinnedDragStart={startPinnedDrag} onPinnedDragOver={trackPinnedDrag} onPinnedDragEnd={finishPinnedDrag} onNavigate={onNavigate} />
      {!childrenCollapsed ? node.children.map((child) => renderNode(child, threadModels[child.thread.id] ?? null, depth + 1)) : null}
    </div>;
  };

  return (
    <div className="h-full space-y-3 overflow-y-auto p-1">
      {stateMigrationNotice ? <p role="status" className="rounded-md border border-border p-2 text-xs text-muted-foreground">Thread-list collapse and custom state were reset during the plugin move. <button type="button" className="underline" onClick={() => { dismissMigrationNotice(); setStateMigrationNotice(false); }}>Dismiss</button></p> : null}
      {groups.map(({ project, threads }) => {
        const tree = buildThreadTree(threads);
        const collapsed = collapsedProjects.has(project.id);
        const expanded = expandedProjects.has(project.id);
        const visibleThreads = expanded ? tree : tree.slice(0, MAX_VISIBLE_THREADS);
        const projectName = asText(project.name) ?? asText(project.id) ?? "Untitled project";
        return (
          <section key={project.id} aria-labelledby={`project-${project.id}`}>
            <div className="flex h-6 items-center gap-1.5 rounded-md pl-2 pr-1 text-xs font-normal text-muted-foreground">
              <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[9px] leading-none text-foreground" aria-hidden="true">{projectAvatar(projectName)}</span>
              <span id={`project-${project.id}`} className="min-w-0 truncate">{projectName}</span>
              {/* No type utilities of its own: the counter inherits the header's
                  size, weight, colour and baseline so it never outweighs the name. */}
              <span className="ml-auto shrink-0" data-project-thread-count="">{threads.length}</span>
              <button type="button" className="inline-flex size-4 shrink-0 items-center justify-center rounded leading-none transition-colors duration-150 hover:bg-muted hover:text-foreground motion-reduce:transition-none" aria-label={`${collapsed ? "Expand" : "Collapse"} ${projectName} section`} aria-expanded={!collapsed} onClick={() => toggleProject(project.id)}>{collapsed ? "›" : "⌄"}</button>
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
export default definePluginApp((app) => {
  app.slots.experimental_threadList({ id: "threads-list", title: "Threads", description: "Project-grouped thread list.", component: SidebarThreadList });
});
