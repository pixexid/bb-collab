// bb-plugin-runtime-shim:react
var runtime = globalThis.__bbPluginRuntime;
if (runtime == null || runtime.react == null) {
  throw new Error('Cannot load "react": this bundle must be loaded by the BB app, which provides the shared plugin runtime (globalThis.__bbPluginRuntime).');
}
var mod = runtime.react;
var {
  Activity,
  Children,
  Component,
  Fragment,
  Profiler,
  PureComponent,
  StrictMode,
  Suspense,
  act,
  cache,
  cacheSignal,
  captureOwnerStack,
  cloneElement,
  createContext,
  createElement,
  createRef,
  forwardRef,
  isValidElement,
  lazy,
  memo,
  startTransition,
  unstable_useCacheRefresh,
  use,
  useActionState,
  useCallback,
  useContext,
  useDebugValue,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useId,
  useImperativeHandle,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useOptimistic,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  version
} = mod;

// bb-plugin-runtime-shim:@bb/plugin-sdk/app
var runtime2 = globalThis.__bbPluginRuntime;
if (runtime2 == null || runtime2.pluginSdkApp == null) {
  throw new Error('Cannot load "@bb/plugin-sdk/app": this bundle must be loaded by the BB app, which provides the shared plugin runtime (globalThis.__bbPluginRuntime).');
}
var mod2 = runtime2.pluginSdkApp;
var {
  Markdown,
  ThreadChat,
  definePluginApp,
  experimental_NewThreadComposer,
  experimental_useSidebarThreadActions,
  experimental_useSidebarThreadPullRequest,
  experimental_useSidebarThreadSplit,
  experimental_useSidebarThreads,
  useBbContext,
  useBbNavigate,
  useComposer,
  useComposerView,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useSettings
} = mod2;

// src/inbox-nav-indicator.ts
var INBOX_NAV_REGION_SELECTOR = '[data-testid="plugin-nav-sidebar-items"]';
var INBOX_NAV_ROW_TITLE = "Inbox";
var LANES_NAV_ROW_TITLE = "Lanes";
var INBOX_UNREAD_MARKER = "data-bb-collab-inbox-unread";
var INBOX_INDICATOR_BROKEN_TITLE = "Inbox unread indicator broken";
var DOT_STYLE = "margin-left:auto;flex:0 0 auto;width:0.5rem;height:0.5rem;border-radius:9999px;background-color:currentColor";
var RENDERING_ATTRIBUTES = [
  "d",
  "points",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "width",
  "height",
  "transform",
  "transform-origin",
  "style",
  "viewBox",
  "preserveAspectRatio",
  "href",
  "xlink:href",
  "offset"
];
function navRows(root) {
  const region = root.querySelector(INBOX_NAV_REGION_SELECTOR);
  return region === null ? null : Array.from(region.querySelectorAll("button"));
}
function rowsTitled(rows, title) {
  return rows.filter((row) => row.textContent?.trim() === title);
}
function paintInboxNavUnread(root, unread) {
  const rows = navRows(root);
  if (rows === null) {
    return { matched: false, reason: `no element matches ${INBOX_NAV_REGION_SELECTOR}` };
  }
  const matches = rowsTitled(rows, INBOX_NAV_ROW_TITLE);
  if (matches.length !== 1) {
    return { matched: false, reason: `${matches.length} of the ${rows.length} rows in ${INBOX_NAV_REGION_SELECTOR} are titled ${JSON.stringify(INBOX_NAV_ROW_TITLE)}, expected exactly 1` };
  }
  const row = matches[0];
  const existing = row.querySelector(`[${INBOX_UNREAD_MARKER}]`);
  if (unread < 1) {
    existing?.remove();
    return { matched: true };
  }
  const dot = existing ?? row.appendChild(row.ownerDocument.createElement("span"));
  dot.setAttribute(INBOX_UNREAD_MARKER, String(unread));
  dot.setAttribute("aria-hidden", "true");
  dot.setAttribute("title", `${unread} unread operator ${unread === 1 ? "message" : "messages"}`);
  dot.setAttribute("style", DOT_STYLE);
  return { matched: true };
}
function glyphFingerprint(row) {
  const asset = row.querySelector("[data-plugin-icon-asset]");
  if (asset !== null) return `asset:${asset.getAttribute("data-plugin-icon-asset") ?? ""}`;
  const shapes = Array.from(row.querySelectorAll("svg, svg *")).map((node) => {
    const geometry = RENDERING_ATTRIBUTES.flatMap((name) => {
      const value = node.getAttribute(name);
      return value === null ? [] : [`${name}=${value}`];
    });
    return geometry.length === 0 ? "" : `${node.tagName}[${geometry.join(",")}]`;
  }).filter((shape) => shape !== "");
  return shapes.length === 0 ? null : shapes.join("|");
}
function inspectInboxNavGlyph(root) {
  const rows = navRows(root);
  if (rows === null) return null;
  const inbox = rowsTitled(rows, INBOX_NAV_ROW_TITLE);
  const lanes = rowsTitled(rows, LANES_NAV_ROW_TITLE);
  if (inbox.length !== 1 || lanes.length !== 1) return null;
  const inboxGlyph = glyphFingerprint(inbox[0]);
  const lanesGlyph = glyphFingerprint(lanes[0]);
  if (inboxGlyph === null || lanesGlyph === null) return null;
  if (inboxGlyph !== lanesGlyph) return { matched: true };
  return { matched: false, reason: `the ${INBOX_NAV_ROW_TITLE} and ${LANES_NAV_ROW_TITLE} rows draw the same glyph (${inboxGlyph}) though they declare different icons` };
}

// bb-plugin-runtime-shim:react/jsx-runtime
var runtime3 = globalThis.__bbPluginRuntime;
if (runtime3 == null || runtime3.jsxRuntime == null) {
  throw new Error('Cannot load "react/jsx-runtime": this bundle must be loaded by the BB app, which provides the shared plugin runtime (globalThis.__bbPluginRuntime).');
}
var mod3 = runtime3.jsxRuntime;
var {
  Fragment: Fragment2,
  jsx,
  jsxs
} = mod3;

// app.tsx
var SETTINGS_ACTION_TITLE = "bb-collab settings";
function age(ms) {
  const minutes = Math.floor(ms / 6e4);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d`;
}
function asText(value) {
  return typeof value === "string" && value.trim() ? value : null;
}
function laneQueueLabel(lane) {
  if (lane.queueState !== "deferred" && !lane.deferredReason) return lane.nextStartable ? "next startable" : lane.waitingOn ?? "worker";
  return `Deferred \xB7 ${lane.deferredReason?.replace(/_/gu, " ") ?? "reason unavailable"}${typeof lane.deferredAgeMs === "number" ? ` \xB7 ${age(lane.deferredAgeMs)}` : ""}`;
}
var MAX_VISIBLE_INBOX_MESSAGES = 256;
var INBOX_FILTER_STORAGE_KEY = "bb-collab.inbox-filters";
var UNREGISTERED_INBOX_PROJECT = "PROJECT_CONFIG_REQUIRED";
function isUnregisteredInboxProject(result) {
  return result.outcome === UNREGISTERED_INBOX_PROJECT;
}
function readInboxFilters() {
  try {
    const value = JSON.parse(window.localStorage.getItem(INBOX_FILTER_STORAGE_KEY) ?? "null");
    return { projectId: typeof value?.projectId === "string" ? value.projectId : "", recipient: value?.recipient === "operator" || value?.recipient === "supervisor" ? value.recipient : "", showArchived: value?.showArchived === true };
  } catch {
    return { projectId: "", recipient: "", showArchived: false };
  }
}
function writeInboxFilters(filters) {
  try {
    window.localStorage.setItem(INBOX_FILTER_STORAGE_KEY, JSON.stringify(filters));
  } catch {
  }
}
function LanesPanel(_props) {
  const rpc = useRpc();
  const [lanes, setLanes] = useState([]);
  const [error, setError] = useState(null);
  const refresh = useCallback(() => {
    void rpc.call("lanes", {}).then((next) => setLanes(next)).catch((reason) => setError(String(reason)));
  }, [rpc]);
  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 5e3);
    return () => window.clearInterval(timer);
  }, [refresh]);
  return /* @__PURE__ */ jsx("main", { className: "h-full overflow-y-auto p-5", children: /* @__PURE__ */ jsxs("div", { className: "mx-auto max-w-4xl", children: [
    /* @__PURE__ */ jsxs("div", { className: "mb-5 flex items-center justify-between", children: [
      /* @__PURE__ */ jsxs("div", { children: [
        /* @__PURE__ */ jsx("h1", { className: "text-lg font-semibold", children: "Lanes" }),
        /* @__PURE__ */ jsx("p", { className: "text-sm text-muted-foreground", children: "Open lanes from bb-collab storage." })
      ] }),
      /* @__PURE__ */ jsx("button", { className: "text-sm text-muted-foreground hover:text-foreground", onClick: refresh, children: "Refresh" })
    ] }),
    error ? /* @__PURE__ */ jsxs("p", { className: "text-sm text-destructive", children: [
      "Unable to read lanes: ",
      error
    ] }) : null,
    lanes.length === 0 ? /* @__PURE__ */ jsx("p", { className: "text-sm text-muted-foreground", children: "No open lanes." }) : null,
    /* @__PURE__ */ jsx("div", { className: "divide-y divide-border border-y border-border", children: lanes.map((lane) => /* @__PURE__ */ jsxs("div", { className: "grid grid-cols-[minmax(0,1fr)_auto_auto] gap-4 py-3 text-sm", children: [
      /* @__PURE__ */ jsxs("div", { className: "min-w-0", children: [
        /* @__PURE__ */ jsx("div", { className: "truncate font-medium", children: lane.laneId }),
        /* @__PURE__ */ jsx("div", { className: "truncate text-xs text-muted-foreground", children: lane.threadId ?? "worker not attached" })
      ] }),
      /* @__PURE__ */ jsx("div", { className: "text-muted-foreground", children: laneQueueLabel(lane) }),
      /* @__PURE__ */ jsx("time", { className: "text-muted-foreground", title: `${lane.ageMs}ms old`, children: age(lane.ageMs) })
    ] }, lane.executionAttemptId)) })
  ] }) });
}
function InboxPanel(_props) {
  const sidebar = experimental_useSidebarThreads();
  const navigate = useBbNavigate();
  const rpc = useRpc();
  const [filters, setFilters] = useState(readInboxFilters);
  const projectId = filters.projectId && sidebar.projects.some((project) => project.id === filters.projectId) ? filters.projectId : "";
  const { recipient, showArchived } = filters;
  const [messages, setMessages] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [replyingMessageKey, setReplyingMessageKey] = useState(null);
  const [errors, setErrors] = useState([]);
  const [notice, setNotice] = useState(null);
  const [indicatorBroken, setIndicatorBroken] = useState(null);
  const provenUnread = useRef(/* @__PURE__ */ new Map());
  const reportedBreak = useRef(null);
  const refreshSequence = useRef(0);
  const projects = useMemo(() => projectId ? sidebar.projects.filter((candidate) => candidate.id === projectId) : sidebar.projects, [projectId, sidebar.projects]);
  const projectNames = useMemo(() => new Map(sidebar.projects.map((candidate) => [candidate.id, candidate.name])), [sidebar.projects]);
  const messageKey = (message) => `${message.projectId}:${message.messageId}`;
  const visibleMessages = messages.slice(0, MAX_VISIBLE_INBOX_MESSAGES);
  useEffect(() => {
    if (!document.querySelector(INBOX_NAV_REGION_SELECTOR)) return;
    let cancelled = false;
    const paint = async () => {
      const results = await Promise.allSettled(sidebar.projects.map((project) => rpc.call("operatorMessages", { projectId: project.id })));
      if (cancelled) return;
      const unread = results.reduce((total, result, index) => {
        const projectId2 = sidebar.projects[index].id;
        if (result.status === "fulfilled") {
          const count = result.value.messages.filter((message) => message.readAtMs === null).length;
          provenUnread.current.set(projectId2, count);
          return total + count;
        }
        return total + (provenUnread.current.get(projectId2) ?? 0);
      }, 0);
      const painted = paintInboxNavUnread(document, unread);
      const broken = painted.matched === false ? painted : inspectInboxNavGlyph(document);
      if (broken === null || broken.matched) {
        reportedBreak.current = null;
        setIndicatorBroken(null);
        return;
      }
      if (reportedBreak.current !== broken.reason) {
        console.error(`[bb-collab] ${INBOX_INDICATOR_BROKEN_TITLE}: ${broken.reason}`);
        reportedBreak.current = broken.reason;
      }
      setIndicatorBroken(broken.reason);
    };
    void paint();
    const timer = window.setInterval(() => void paint(), 3e4);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      paintInboxNavUnread(document, 0);
    };
  }, [rpc, sidebar.projects]);
  const setFiltersAndPersist = (next) => {
    setFilters(next);
    writeInboxFilters(next);
  };
  const refresh = useCallback(() => {
    const sequence = ++refreshSequence.current;
    setNotice(null);
    if (projects.length === 0) {
      setMessages([]);
      setErrors([]);
      return;
    }
    void Promise.allSettled(projects.map((project) => rpc.call("operatorMessages", {
      projectId: project.id,
      ...recipient ? { recipient } : {},
      withSenderTitles: true,
      ...showArchived ? { includeArchived: true } : {}
    }))).then((results) => {
      if (sequence !== refreshSequence.current) return;
      const loaded = [];
      const failed = [];
      results.forEach((result, index) => {
        const label = `${projects[index].name} (${projects[index].id})`;
        if (result.status === "rejected") failed.push(`${label}: ${String(result.reason)}`);
        else if (!isUnregisteredInboxProject(result.value)) loaded.push(...result.value.messages);
        else if (projectId !== "") failed.push(`${label}: ${result.value.outcome}`);
      });
      loaded.sort((left, right) => Number(left.readAtMs !== null) - Number(right.readAtMs !== null) || right.createdAtMs - left.createdAtMs || right.messageId - left.messageId);
      setMessages(loaded);
      setErrors(failed);
    });
  }, [projects, projectId, recipient, rpc]);
  useEffect(refresh, [refresh]);
  const updateMessage = (next) => setMessages((current) => current.map((message) => messageKey(message) === messageKey(next) ? next : message));
  return /* @__PURE__ */ jsx("main", { className: "h-full overflow-y-auto p-5", children: /* @__PURE__ */ jsxs("div", { className: "mx-auto max-w-4xl", children: [
    indicatorBroken ? /* @__PURE__ */ jsxs("p", { role: "alert", className: "mb-3 text-sm text-destructive", children: [
      INBOX_INDICATOR_BROKEN_TITLE,
      " \u2014 open Inbox to check for unread messages. Cause: ",
      indicatorBroken
    ] }) : null,
    /* @__PURE__ */ jsxs("div", { className: "mb-5 flex flex-wrap items-end gap-3", children: [
      /* @__PURE__ */ jsxs("label", { className: "grid gap-1 text-sm", children: [
        /* @__PURE__ */ jsx("span", { className: "text-muted-foreground", children: "Project" }),
        /* @__PURE__ */ jsxs("select", { className: "rounded-md border border-border bg-background px-3 py-2", value: projectId, onChange: (event) => setFiltersAndPersist({ projectId: event.target.value, recipient, showArchived }), children: [
          /* @__PURE__ */ jsx("option", { value: "", children: "All projects" }),
          sidebar.projects.map((candidate) => /* @__PURE__ */ jsxs("option", { value: candidate.id, children: [
            candidate.name,
            " \xB7 ",
            candidate.id
          ] }, candidate.id))
        ] })
      ] }),
      /* @__PURE__ */ jsxs("label", { className: "grid gap-1 text-sm", children: [
        /* @__PURE__ */ jsx("span", { className: "text-muted-foreground", children: "Recipient" }),
        /* @__PURE__ */ jsxs("select", { className: "rounded-md border border-border bg-background px-3 py-2", value: recipient, onChange: (event) => setFiltersAndPersist({ projectId, recipient: event.target.value, showArchived }), children: [
          /* @__PURE__ */ jsx("option", { value: "", children: "All recipients" }),
          /* @__PURE__ */ jsx("option", { value: "operator", children: "Operator" }),
          /* @__PURE__ */ jsx("option", { value: "supervisor", children: "Supervisor" })
        ] })
      ] }),
      /* @__PURE__ */ jsxs("label", { className: "flex items-center gap-2 py-2 text-sm", children: [
        /* @__PURE__ */ jsx("input", { type: "checkbox", checked: showArchived, onChange: (event) => setFiltersAndPersist({ projectId, recipient, showArchived: event.target.checked }) }),
        "Show archived"
      ] }),
      /* @__PURE__ */ jsx("button", { type: "button", className: "rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground", onClick: refresh, children: "Refresh" })
    ] }),
    sidebar.projects.length === 0 ? /* @__PURE__ */ jsx("p", { className: "text-sm text-muted-foreground", children: "No registered projects." }) : null,
    errors.map((loadError) => /* @__PURE__ */ jsxs("p", { className: "text-sm text-destructive", children: [
      "Unable to read inbox: ",
      loadError
    ] }, loadError)),
    notice ? /* @__PURE__ */ jsx("p", { role: "status", className: "text-sm text-primary", children: notice }) : null,
    sidebar.projects.length > 0 ? /* @__PURE__ */ jsxs("section", { "aria-labelledby": "inbox-project-heading", children: [
      /* @__PURE__ */ jsx("h2", { id: "inbox-project-heading", className: "mb-2 text-sm font-semibold", children: projectId ? projectNames.get(projectId) ?? projectId : "All projects" }),
      messages.length === 0 ? /* @__PURE__ */ jsx("p", { className: "text-sm text-muted-foreground", children: "No messages for this project and recipient filter." }) : null,
      messages.length > MAX_VISIBLE_INBOX_MESSAGES ? /* @__PURE__ */ jsxs("p", { className: "mb-3 text-sm text-muted-foreground", children: [
        "Showing the first ",
        MAX_VISIBLE_INBOX_MESSAGES,
        " of ",
        messages.length,
        " messages; unread messages are first. Select a project to narrow the list."
      ] }) : null,
      /* @__PURE__ */ jsx("div", { className: "space-y-3", children: visibleMessages.map((message) => /* @__PURE__ */ jsxs("article", { className: `rounded-lg border p-4 ${message.readAtMs === null ? "border-primary/50" : "border-border"}`, children: [
        /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap items-center gap-2 text-xs text-muted-foreground", children: [
          /* @__PURE__ */ jsx("span", { className: "font-medium text-foreground", children: projectNames.get(message.projectId) ?? message.projectId }),
          /* @__PURE__ */ jsx("span", { className: "font-medium text-foreground", children: message.recipient }),
          /* @__PURE__ */ jsx("span", { children: message.severity }),
          /* @__PURE__ */ jsx("span", { className: "inline-grid", children: asText(message.senderThreadId) ? /* @__PURE__ */ jsxs(Fragment2, { children: [
            /* @__PURE__ */ jsx(
              "a",
              {
                href: "#",
                className: "font-medium text-foreground underline decoration-muted-foreground/50 underline-offset-2 hover:text-foreground",
                "aria-label": `Open sender session ${asText(message.senderThreadId)}`,
                title: `Open sender session ${asText(message.senderThreadId)}`,
                onClick: (event) => {
                  event.preventDefault();
                  navigate.toThread(asText(message.senderThreadId));
                },
                children: asText(message.senderTitle) ?? asText(message.senderThreadId)
              }
            ),
            asText(message.senderTitle) ? /* @__PURE__ */ jsxs("span", { children: [
              asText(message.senderLaneId) ? `${asText(message.senderLaneId)} \xB7 ` : "",
              asText(message.senderThreadId)
            ] }) : asText(message.senderLaneId) ? /* @__PURE__ */ jsx("span", { children: asText(message.senderLaneId) }) : null
          ] }) : /* @__PURE__ */ jsx("span", { children: "Sender unavailable" }) }),
          /* @__PURE__ */ jsx("time", { className: "ml-auto", dateTime: new Date(message.createdAtMs).toISOString(), children: new Date(message.createdAtMs).toLocaleString() })
        ] }),
        /* @__PURE__ */ jsx("p", { className: "my-3 whitespace-pre-wrap text-sm", children: message.text }),
        message.notificationError ? /* @__PURE__ */ jsxs("p", { className: "mb-2 text-xs text-destructive", children: [
          "Urgent notification failed: ",
          message.notificationError
        ] }) : null,
        message.replyDeliveryError ? /* @__PURE__ */ jsxs("p", { className: "mb-2 text-xs text-destructive", children: [
          "Reply delivery failed: ",
          message.replyDeliveryError
        ] }) : null,
        message.repliedAtMs === null ? /* @__PURE__ */ jsxs("div", { className: "grid gap-2", children: [
          /* @__PURE__ */ jsx("label", { className: "text-xs text-muted-foreground", htmlFor: `operator-reply-${messageKey(message)}`, children: "Reply" }),
          /* @__PURE__ */ jsx(
            "textarea",
            {
              id: `operator-reply-${messageKey(message)}`,
              className: "min-h-20 rounded-md border border-border bg-background p-2 text-sm",
              value: drafts[messageKey(message)] ?? message.replyText ?? "",
              onChange: (event) => setDrafts((current) => ({ ...current, [messageKey(message)]: event.target.value }))
            }
          ),
          /* @__PURE__ */ jsxs("div", { className: "flex gap-2", children: [
            /* @__PURE__ */ jsx("button", { type: "button", disabled: replyingMessageKey !== null, className: "rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50", onClick: () => {
              const text = (drafts[messageKey(message)] ?? message.replyText ?? "").trim();
              if (!text) return;
              setErrors([]);
              setNotice(null);
              setReplyingMessageKey(messageKey(message));
              void rpc.call("replyToOperatorMessage", { projectId: message.projectId, messageId: message.messageId, text }).then((replied) => {
                updateMessage(replied);
                setNotice("Reply delivered.");
              }).catch((reason) => setErrors([String(reason)])).finally(() => setReplyingMessageKey(null));
            }, children: replyingMessageKey === messageKey(message) ? "Delivering\u2026" : "Reply" }),
            message.readAtMs === null ? /* @__PURE__ */ jsx("button", { type: "button", className: "rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-muted", onClick: () => {
              setErrors([]);
              setNotice(null);
              void rpc.call("markOperatorMessageRead", { projectId: message.projectId, messageId: message.messageId }).then((read) => {
                updateMessage(read);
                setNotice("Marked read.");
              }).catch((reason) => setErrors([String(reason)]));
            }, children: "Mark read" }) : null
          ] })
        ] }) : /* @__PURE__ */ jsxs("p", { className: "text-sm text-muted-foreground", children: [
          "Reply delivered: ",
          message.replyText
        ] })
      ] }, messageKey(message))) })
    ] }) : null
  ] }) });
}
async function readPluginHttp(path, signal) {
  const response = await fetch(`/api/v1/plugins/bb-collab/http/${path}`, { credentials: "same-origin", signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json();
}
function mountLanePulse({ signal, setStatus }) {
  let previous = /* @__PURE__ */ new Set();
  const refresh = async () => {
    try {
      const lanes = await readPluginHttp("lanes", signal);
      const next = /* @__PURE__ */ new Set();
      for (const lane of lanes) {
        if (!lane.threadId) continue;
        next.add(lane.threadId);
        setStatus(lane.threadId, {
          icon: lane.tone === "error" ? "AlertTriangle" : "GitBranch",
          label: lane.waitingOn ? `Lane ${lane.laneId}: waiting on ${lane.waitingOn}` : `Lane ${lane.laneId}: open`,
          tone: lane.tone
        });
      }
      for (const threadId of previous) if (!next.has(threadId)) setStatus(threadId, null);
      previous = next;
    } catch {
    }
  };
  void refresh();
  const timer = window.setInterval(refresh, 5e3);
  return () => window.clearInterval(timer);
}
var app_default = definePluginApp((app) => {
  app.slots.sidebarFooterAction({
    id: "bb-collab-settings",
    title: SETTINGS_ACTION_TITLE,
    icon: "Settings",
    run: ({ openSettings }) => openSettings()
  });
  app.slots.navPanel({
    id: "lanes",
    title: "Lanes",
    icon: "GitBranch",
    path: "lanes",
    component: LanesPanel
  });
  app.slots.navPanel({
    id: "inbox",
    title: "Inbox",
    icon: "Mail",
    path: "inbox",
    component: InboxPanel
  });
  app.contentScripts.register({
    id: "lane-thread-status",
    mount: ({ signal, experimental_setThreadRowStatus }) => {
      if (!experimental_setThreadRowStatus) return;
      return mountLanePulse({ signal, setStatus: experimental_setThreadRowStatus });
    }
  });
});
export {
  app_default as default
};
