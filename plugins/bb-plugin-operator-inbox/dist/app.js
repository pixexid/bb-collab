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

// bb-plugin-runtime-shim:@get-bb/plugin-sdk/app
var runtime2 = globalThis.__bbPluginRuntime;
if (runtime2 == null || runtime2.pluginSdkApp == null) {
  throw new Error('Cannot load "@get-bb/plugin-sdk/app": this bundle must be loaded by the BB app, which provides the shared plugin runtime (globalThis.__bbPluginRuntime).');
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
function asText(value) {
  return typeof value === "string" && value.trim() ? value : null;
}
var MAX_VISIBLE_INBOX_MESSAGES = 256;
var INBOX_FILTER_STORAGE_KEY = "bb-collab.inbox-filters";
var UNREGISTERED_INBOX_PROJECT = "PROJECT_CONFIG_REQUIRED";
var NON_OPERATOR_MESSAGE_ERROR = "operator inbox response included a non-operator message";
function isUnregisteredInboxProject(result) {
  return result.outcome === UNREGISTERED_INBOX_PROJECT;
}
function operatorOnlyMessages(result) {
  if (result.messages.some((message) => message.recipient !== "operator")) throw new Error(NON_OPERATOR_MESSAGE_ERROR);
  return result.messages;
}
function readInboxFilters() {
  try {
    const value = JSON.parse(window.localStorage.getItem(INBOX_FILTER_STORAGE_KEY) ?? "null");
    return { projectId: typeof value?.projectId === "string" ? value.projectId : "", showArchived: value?.showArchived === true };
  } catch {
    return { projectId: "", showArchived: false };
  }
}
function writeInboxFilters(filters) {
  try {
    window.localStorage.setItem(INBOX_FILTER_STORAGE_KEY, JSON.stringify(filters));
  } catch {
  }
}
function messageKey(message) {
  return `${message.projectId}:${message.messageId}`;
}
function formatTime(timestamp) {
  return new Date(timestamp).toLocaleString(void 0, { dateStyle: "medium", timeStyle: "short" });
}
function formatRelativeTime(timestamp) {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1e3));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
function severityLabel(severity) {
  return severity === "needs-decision" ? "Needs decision" : severity[0].toUpperCase() + severity.slice(1);
}
function senderLabel(message) {
  return asText(message.senderTitle) ?? "Sender unavailable";
}
function deliveryLabel(message) {
  if (message.repliedAtMs != null) return "Delivered";
  if (message.replyInProgress) return "Delivery pending";
  if (message.replyDeliveryError) return "Delivery failed";
  return null;
}
function stateLabel(message) {
  if (message.archivedAtMs != null) return "Archived";
  return deliveryLabel(message) ?? (message.readAtMs === null ? "Unread" : "Read");
}
function InboxPanel(_props) {
  const sidebar = experimental_useSidebarThreads();
  const navigate = useBbNavigate();
  const rpc = useRpc();
  const [filters, setFilters] = useState(readInboxFilters);
  const projectId = filters.projectId && sidebar.projects.some((project) => project.id === filters.projectId) ? filters.projectId : "";
  const { showArchived } = filters;
  const [messages, setMessages] = useState([]);
  const [selectedMessageKey, setSelectedMessageKey] = useState(null);
  const [loading, setLoading] = useState(true);
  const [drafts, setDrafts] = useState({});
  const [replyingMessageKey, setReplyingMessageKey] = useState(null);
  const [errors, setErrors] = useState([]);
  const [notice, setNotice] = useState(null);
  const [indicatorBroken, setIndicatorBroken] = useState(null);
  const provenUnread = useRef(/* @__PURE__ */ new Map());
  const reportedBreak = useRef(null);
  const refreshSequence = useRef(0);
  const showArchivedRef = useRef(showArchived);
  showArchivedRef.current = showArchived;
  const projects = useMemo(() => projectId ? sidebar.projects.filter((candidate) => candidate.id === projectId) : sidebar.projects, [projectId, sidebar.projects]);
  const projectNames = useMemo(() => new Map(sidebar.projects.map((candidate) => [candidate.id, candidate.name])), [sidebar.projects]);
  const visibleMessages = messages.slice(0, MAX_VISIBLE_INBOX_MESSAGES);
  const selectedKey = selectedMessageKey && visibleMessages.some((message) => messageKey(message) === selectedMessageKey) ? selectedMessageKey : visibleMessages[0] ? messageKey(visibleMessages[0]) : null;
  const selectedMessage = selectedKey === null ? void 0 : visibleMessages.find((message) => messageKey(message) === selectedKey);
  const unreadCount = messages.filter((message) => message.readAtMs === null).length;
  useEffect(() => {
    if (!document.querySelector(INBOX_NAV_REGION_SELECTOR)) return;
    let cancelled = false;
    const paint = async () => {
      const results = await Promise.allSettled(sidebar.projects.map((project) => rpc.call("operatorMessages", { projectId: project.id, recipient: "operator" })));
      if (cancelled) return;
      const unread = results.reduce((total, result, index) => {
        const currentProjectId = sidebar.projects[index].id;
        if (result.status === "fulfilled") {
          try {
            const count = operatorOnlyMessages(result.value).filter((message) => message.readAtMs === null).length;
            provenUnread.current.set(currentProjectId, count);
            return total + count;
          } catch {
            return total + (provenUnread.current.get(currentProjectId) ?? 0);
          }
        }
        return total + (provenUnread.current.get(currentProjectId) ?? 0);
      }, 0);
      const painted = paintInboxNavUnread(document, unread);
      const broken = painted.matched === false ? painted : inspectInboxNavGlyph(document);
      if (broken === null || broken.matched) {
        reportedBreak.current = null;
        setIndicatorBroken(null);
        return;
      }
      if (reportedBreak.current !== broken.reason) {
        console.error(`[operator-inbox] ${INBOX_INDICATOR_BROKEN_TITLE}: ${broken.reason}`);
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
    setLoading(true);
    if (projects.length === 0) {
      setMessages([]);
      setErrors([]);
      setLoading(false);
      return;
    }
    void Promise.allSettled(projects.map((project) => rpc.call("operatorMessages", { projectId: project.id, recipient: "operator", withSenderTitles: true, ...showArchived ? { includeArchived: true } : {} }))).then((results) => {
      if (sequence !== refreshSequence.current) return;
      const loaded = [];
      const failed = [];
      results.forEach((result, index) => {
        const label = `${projects[index].name} (${projects[index].id})`;
        if (result.status === "rejected") failed.push(`${label}: ${String(result.reason)}`);
        else if (!isUnregisteredInboxProject(result.value)) {
          try {
            loaded.push(...operatorOnlyMessages(result.value));
          } catch (reason) {
            failed.push(`${label}: ${String(reason)}`);
          }
        } else if (projectId !== "") failed.push(`${label}: ${result.value.outcome}`);
      });
      loaded.sort((left, right) => Number(left.readAtMs !== null) - Number(right.readAtMs !== null) || right.createdAtMs - left.createdAtMs || right.messageId - left.messageId);
      setMessages(loaded);
      setErrors(failed);
    }).finally(() => {
      if (sequence === refreshSequence.current) setLoading(false);
    });
  }, [projects, projectId, rpc, showArchived]);
  useEffect(refresh, [refresh]);
  const updateMessage = (next) => setMessages((current) => current.map((message) => messageKey(message) === messageKey(next) ? next : message));
  const currentProjectLabel = projectId ? projectNames.get(projectId) ?? projectId : "All projects";
  const selectedProjectLabel = selectedMessage ? projectNames.get(selectedMessage.projectId) ?? selectedMessage.projectId : null;
  const replyKey = selectedMessage ? messageKey(selectedMessage) : null;
  const replyText = selectedMessage && replyKey ? drafts[replyKey] ?? selectedMessage.replyText ?? "" : "";
  const selectedSenderId = selectedMessage ? asText(selectedMessage.senderThreadId) : null;
  return /* @__PURE__ */ jsx("main", { className: "h-full overflow-y-auto p-4 md:p-5", children: /* @__PURE__ */ jsxs("div", { className: "mx-auto grid max-w-5xl gap-4", style: { minWidth: 0, width: "100%" }, children: [
    indicatorBroken ? /* @__PURE__ */ jsxs("p", { role: "alert", className: "text-sm text-destructive", children: [
      INBOX_INDICATOR_BROKEN_TITLE,
      " \u2014 open Inbox to check for unread messages. Cause: ",
      indicatorBroken
    ] }) : null,
    /* @__PURE__ */ jsxs("header", { className: "grid gap-1", children: [
      /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap items-center justify-between gap-2", children: [
        /* @__PURE__ */ jsxs("div", { children: [
          /* @__PURE__ */ jsx("p", { className: "text-xs font-medium uppercase tracking-wide text-muted-foreground", children: "Operator workspace" }),
          /* @__PURE__ */ jsx("h1", { className: "text-xl font-semibold tracking-tight", children: "Inbox" })
        ] }),
        /* @__PURE__ */ jsx("p", { className: "text-sm text-muted-foreground", "aria-live": "polite", children: unreadCount ? `${unreadCount} unread` : "All caught up" })
      ] }),
      /* @__PURE__ */ jsx("p", { className: "max-w-2xl text-sm text-muted-foreground", children: "Review messages from your project agents, then reply, mark read, or archive from one place." })
    ] }),
    /* @__PURE__ */ jsxs("section", { "aria-label": "Inbox toolbar", className: "grid gap-3 rounded-lg border border-border bg-muted/10 p-3 md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-end", children: [
      /* @__PURE__ */ jsxs("label", { className: "grid min-w-0 gap-1 text-sm", children: [
        /* @__PURE__ */ jsx("span", { className: "text-xs font-medium text-muted-foreground", children: "Project" }),
        /* @__PURE__ */ jsxs("select", { className: "w-full min-w-0 rounded-md border border-border bg-background px-3 py-2", value: projectId, onChange: (event) => setFiltersAndPersist({ projectId: event.target.value, showArchived }), children: [
          /* @__PURE__ */ jsx("option", { value: "", children: "All projects" }),
          sidebar.projects.map((candidate) => /* @__PURE__ */ jsx("option", { value: candidate.id, children: candidate.name }, candidate.id))
        ] })
      ] }),
      /* @__PURE__ */ jsxs("label", { className: "flex min-h-10 items-center gap-2 px-1 text-sm", children: [
        /* @__PURE__ */ jsx("input", { type: "checkbox", checked: showArchived, onChange: (event) => setFiltersAndPersist({ projectId, showArchived: event.target.checked }) }),
        "Show archived"
      ] }),
      /* @__PURE__ */ jsx("button", { type: "button", "aria-label": "Refresh inbox", title: "Refresh inbox", className: "min-h-10 min-w-10 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted active:bg-muted/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none", onClick: refresh, disabled: loading, children: /* @__PURE__ */ jsx("span", { "aria-hidden": "true", children: "\u21BB" }) })
    ] }),
    errors.map((loadError) => /* @__PURE__ */ jsxs("p", { role: "alert", className: "rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive", children: [
      "Refresh failed: ",
      loadError
    ] }, loadError)),
    notice ? /* @__PURE__ */ jsx("p", { role: "status", className: "rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm text-primary", children: notice }) : null,
    sidebar.projects.length === 0 ? /* @__PURE__ */ jsxs("section", { className: "rounded-lg border border-dashed border-border p-6 text-center", children: [
      /* @__PURE__ */ jsx("h2", { className: "font-medium", children: "No projects available" }),
      /* @__PURE__ */ jsx("p", { className: "mt-1 text-sm text-muted-foreground", children: "A registered project is required before operator messages can appear here." })
    ] }) : /* @__PURE__ */ jsxs("section", { "aria-labelledby": "inbox-list-heading", className: "grid min-w-0 gap-3 md:grid-cols-[minmax(16rem,0.42fr)_minmax(0,1fr)]", children: [
      /* @__PURE__ */ jsxs("div", { className: "min-w-0 overflow-hidden rounded-lg border border-border", children: [
        /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap items-baseline justify-between gap-2 border-b border-border bg-muted/10 px-3 py-3", children: [
          /* @__PURE__ */ jsxs("div", { children: [
            /* @__PURE__ */ jsx("h2", { id: "inbox-list-heading", className: "font-semibold", children: "Messages" }),
            /* @__PURE__ */ jsx("p", { className: "text-xs text-muted-foreground", children: currentProjectLabel })
          ] }),
          /* @__PURE__ */ jsxs("span", { className: "text-xs text-muted-foreground", children: [
            messages.length,
            " ",
            messages.length === 1 ? "message" : "messages"
          ] })
        ] }),
        loading ? /* @__PURE__ */ jsx("p", { role: "status", className: "p-5 text-sm text-muted-foreground", children: "Loading messages\u2026" }) : null,
        !loading && messages.length === 0 ? /* @__PURE__ */ jsxs("div", { className: "p-5", children: [
          /* @__PURE__ */ jsx("p", { className: "font-medium", children: "No messages in this view" }),
          /* @__PURE__ */ jsx("p", { className: "mt-1 text-sm text-muted-foreground", children: "Try another project or show archived messages." })
        ] }) : null,
        messages.length > MAX_VISIBLE_INBOX_MESSAGES ? /* @__PURE__ */ jsxs("p", { className: "border-b border-border bg-muted/10 p-3 text-xs text-muted-foreground", children: [
          "Showing the first ",
          MAX_VISIBLE_INBOX_MESSAGES,
          " of ",
          messages.length,
          " messages. Unread messages appear first."
        ] }) : null,
        /* @__PURE__ */ jsx("div", { role: "list", "aria-label": "Operator messages", children: visibleMessages.map((message) => {
          const key = messageKey(message);
          const selected = key === selectedKey;
          const sender = senderLabel(message);
          const delivery = deliveryLabel(message);
          return /* @__PURE__ */ jsx("article", { role: "listitem", className: `border-b border-border last:border-b-0 ${selected ? "bg-primary/5" : "bg-transparent"}`, children: /* @__PURE__ */ jsxs("button", { type: "button", "aria-pressed": selected, "aria-label": `${selected ? "Selected. " : "Select "}message from ${sender}. ${projectNames.get(message.projectId) ?? message.projectId}. ${severityLabel(message.severity)}. ${stateLabel(message)}. ${formatTime(message.createdAtMs)}`, style: { textAlign: "left", width: "100%" }, onClick: () => setSelectedMessageKey(key), className: `grid min-w-0 gap-2 px-3 py-3 transition-colors duration-150 hover:bg-muted/60 active:bg-muted/80 focus-visible:z-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary motion-reduce:transition-none ${selected ? "border-l-2 border-primary pl-[0.625rem]" : "border-l-2 border-transparent"}`, children: [
            /* @__PURE__ */ jsxs("span", { className: "flex min-w-0 items-start gap-2", children: [
              /* @__PURE__ */ jsx("span", { className: `mt-1.5 h-2 w-2 shrink-0 rounded-full ${message.readAtMs === null ? "bg-primary" : "bg-transparent"}`, "aria-label": message.readAtMs === null ? "Unread" : void 0 }),
              /* @__PURE__ */ jsx("span", { className: `min-w-0 flex-1 break-words text-sm ${message.readAtMs === null ? "font-semibold" : "font-medium"}`, children: sender }),
              /* @__PURE__ */ jsx("time", { className: "shrink-0 text-xs text-muted-foreground", dateTime: new Date(message.createdAtMs).toISOString(), title: formatTime(message.createdAtMs), "aria-label": `Received ${formatTime(message.createdAtMs)}`, children: formatRelativeTime(message.createdAtMs) })
            ] }),
            /* @__PURE__ */ jsx("span", { className: "break-words text-sm leading-5 text-muted-foreground", children: selected ? "Selected \u2014 details shown here" : message.text.length > 96 ? `${message.text.slice(0, 96).trimEnd()}\u2026` : message.text }),
            /* @__PURE__ */ jsxs("span", { className: "flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground", children: [
              /* @__PURE__ */ jsx("span", { children: projectNames.get(message.projectId) ?? message.projectId }),
              /* @__PURE__ */ jsx("span", { "aria-hidden": "true", children: "\xB7" }),
              /* @__PURE__ */ jsx("span", { children: severityLabel(message.severity) }),
              delivery ? /* @__PURE__ */ jsxs(Fragment2, { children: [
                /* @__PURE__ */ jsx("span", { "aria-hidden": "true", children: "\xB7" }),
                /* @__PURE__ */ jsx("span", { className: delivery === "Delivery failed" ? "text-destructive" : "", children: delivery })
              ] }) : null,
              message.archivedAtMs != null ? /* @__PURE__ */ jsxs(Fragment2, { children: [
                /* @__PURE__ */ jsx("span", { "aria-hidden": "true", children: "\xB7" }),
                /* @__PURE__ */ jsx("span", { children: "Archived" })
              ] }) : null
            ] })
          ] }) }, key);
        }) })
      ] }),
      selectedMessage ? /* @__PURE__ */ jsxs("article", { "aria-labelledby": "selected-message-heading", className: "min-w-0 rounded-lg border border-border bg-background", children: [
        /* @__PURE__ */ jsx("header", { className: "grid gap-3 border-b border-border bg-muted/10 p-4", children: /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap items-start justify-between gap-3", children: [
          /* @__PURE__ */ jsxs("div", { className: "min-w-0", children: [
            /* @__PURE__ */ jsx("p", { className: "text-xs font-medium uppercase tracking-wide text-muted-foreground", children: "Selected message" }),
            /* @__PURE__ */ jsx("h2", { id: "selected-message-heading", className: "mt-1 text-lg font-semibold", children: "Message" }),
            /* @__PURE__ */ jsxs("p", { className: "mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground", children: [
              /* @__PURE__ */ jsx("span", { children: "From" }),
              selectedSenderId && asText(selectedMessage.senderTitle) ? /* @__PURE__ */ jsx("a", { href: "#", className: "min-w-0 break-words font-medium text-foreground underline decoration-muted-foreground/50 underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary", "aria-label": `Open sender session ${selectedMessage.senderTitle}`, onClick: (event) => {
                event.preventDefault();
                navigate.toThread(selectedSenderId);
              }, children: selectedMessage.senderTitle }) : /* @__PURE__ */ jsx("span", { children: "Sender unavailable" }),
              /* @__PURE__ */ jsx("span", { "aria-hidden": "true", children: "\xB7" }),
              /* @__PURE__ */ jsx("span", { children: selectedProjectLabel }),
              /* @__PURE__ */ jsx("span", { "aria-hidden": "true", children: "\xB7" }),
              /* @__PURE__ */ jsx("span", { children: severityLabel(selectedMessage.severity) }),
              /* @__PURE__ */ jsx("span", { "aria-hidden": "true", children: "\xB7" }),
              /* @__PURE__ */ jsx("time", { dateTime: new Date(selectedMessage.createdAtMs).toISOString(), title: formatTime(selectedMessage.createdAtMs), "aria-label": `Received ${formatTime(selectedMessage.createdAtMs)}`, children: formatRelativeTime(selectedMessage.createdAtMs) })
            ] })
          ] }),
          /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap gap-2 text-xs", children: [
            /* @__PURE__ */ jsx("span", { className: `rounded-full px-2.5 py-1 font-medium ${selectedMessage.readAtMs === null ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`, children: selectedMessage.readAtMs === null ? "Unread" : "Read" }),
            selectedMessage.archivedAtMs != null ? /* @__PURE__ */ jsx("span", { className: "rounded-full bg-muted px-2.5 py-1 font-medium text-muted-foreground", children: "Archived" }) : null,
            deliveryLabel(selectedMessage) ? /* @__PURE__ */ jsx("span", { className: `rounded-full px-2.5 py-1 font-medium ${deliveryLabel(selectedMessage) === "Delivery failed" ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground"}`, children: deliveryLabel(selectedMessage) }) : null
          ] })
        ] }) }),
        /* @__PURE__ */ jsxs("div", { className: "grid gap-5 p-4", children: [
          /* @__PURE__ */ jsxs("section", { "aria-labelledby": "message-body-heading", className: "grid gap-2", children: [
            /* @__PURE__ */ jsx("h3", { id: "message-body-heading", className: "text-xs font-semibold uppercase tracking-wide text-muted-foreground", children: "Message" }),
            /* @__PURE__ */ jsx("p", { className: "whitespace-pre-wrap break-words text-sm leading-6", children: selectedMessage.text }),
            selectedMessage.notificationError ? /* @__PURE__ */ jsxs("p", { role: "alert", className: "rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive", children: [
              "Urgent notification could not be sent: ",
              selectedMessage.notificationError
            ] }) : null
          ] }),
          selectedMessage.repliedAtMs != null ? /* @__PURE__ */ jsxs("section", { "aria-label": "Reply delivered", className: "grid gap-2 rounded-md border border-border bg-muted/10 p-3", children: [
            /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap items-center justify-between gap-2", children: [
              /* @__PURE__ */ jsx("h3", { className: "text-sm font-semibold", children: "Reply delivered" }),
              /* @__PURE__ */ jsx("time", { className: "text-xs text-muted-foreground", dateTime: new Date(selectedMessage.repliedAtMs).toISOString(), title: formatTime(selectedMessage.repliedAtMs), "aria-label": `Delivered ${formatTime(selectedMessage.repliedAtMs)}`, children: formatRelativeTime(selectedMessage.repliedAtMs) })
            ] }),
            /* @__PURE__ */ jsx("p", { className: "whitespace-pre-wrap break-words text-sm leading-6", children: selectedMessage.replyText }),
            /* @__PURE__ */ jsx("p", { className: "text-xs text-muted-foreground", children: "BB confirmed the matching input in the sender thread." })
          ] }) : /* @__PURE__ */ jsxs("section", { "aria-labelledby": "reply-heading", className: "grid gap-3 border-t border-border pt-4", children: [
            /* @__PURE__ */ jsxs("div", { children: [
              /* @__PURE__ */ jsx("h3", { id: "reply-heading", className: "text-sm font-semibold", children: "Reply to sender" }),
              /* @__PURE__ */ jsx("p", { className: "mt-1 text-xs text-muted-foreground", children: "Your reply is delivered only after BB confirms the matching input in the sender thread." })
            ] }),
            selectedMessage.replyInProgress ? /* @__PURE__ */ jsx("p", { role: "status", className: "rounded-md border border-border bg-muted/10 px-3 py-2 text-sm text-primary", children: "Delivery pending. Keep this message open; the outcome is not yet known." }) : null,
            selectedMessage.replyDeliveryError ? /* @__PURE__ */ jsxs("p", { role: "alert", className: "rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive", children: [
              "Delivery failed: ",
              selectedMessage.replyDeliveryError,
              " You can retry without losing this message."
            ] }) : null,
            /* @__PURE__ */ jsxs("label", { className: "grid gap-1 text-sm", htmlFor: `operator-reply-${replyKey}`, children: [
              /* @__PURE__ */ jsx("span", { className: "text-xs font-medium text-muted-foreground", children: "Reply text" }),
              /* @__PURE__ */ jsx("textarea", { id: `operator-reply-${replyKey}`, className: "min-h-24 w-full rounded-md border border-border bg-background p-2.5 text-sm leading-5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary", value: replyText, onChange: (event) => setDrafts((current) => ({ ...current, [replyKey]: event.target.value })) })
            ] })
          ] }),
          /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap gap-2 border-t border-border pt-4", children: [
            /* @__PURE__ */ jsx("button", { type: "button", "aria-label": replyingMessageKey === replyKey ? "Delivering reply" : selectedMessage.repliedAtMs != null ? "Reply delivered" : selectedMessage.replyDeliveryError ? "Retry reply" : "Send reply", title: replyingMessageKey === replyKey ? "Delivering reply" : selectedMessage.repliedAtMs != null ? "Reply delivered" : selectedMessage.replyDeliveryError ? "Retry reply" : "Send reply", disabled: replyingMessageKey !== null || selectedMessage.repliedAtMs != null || !replyText.trim(), className: "min-h-10 min-w-10 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-opacity duration-150 hover:opacity-90 active:opacity-80 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary motion-reduce:transition-none", onClick: () => {
              const text = replyText.trim();
              if (!text || !replyKey) return;
              setErrors([]);
              setNotice(null);
              setReplyingMessageKey(replyKey);
              void rpc.call("replyToOperatorMessage", { projectId: selectedMessage.projectId, messageId: selectedMessage.messageId, text }).then((replied) => {
                updateMessage(replied);
                setNotice(replied.repliedAtMs != null ? "Reply delivered. BB confirmed the matching input." : replied.replyInProgress ? "Delivery pending. The outcome is not yet known." : replied.replyDeliveryError ? "Delivery failed. The message remains retryable." : "Reply delivery is not confirmed.");
              }).catch((reason) => setErrors([String(reason)])).finally(() => setReplyingMessageKey(null));
            }, children: /* @__PURE__ */ jsx("span", { "aria-hidden": "true", children: "\u2197" }) }),
            selectedMessage.readAtMs === null ? /* @__PURE__ */ jsx("button", { type: "button", "aria-label": "Mark message read", title: "Mark message read", className: "min-h-10 min-w-10 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted active:bg-muted/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary motion-reduce:transition-none", onClick: () => {
              setErrors([]);
              setNotice(null);
              void rpc.call("markOperatorMessageRead", { projectId: selectedMessage.projectId, messageId: selectedMessage.messageId }).then((read) => {
                updateMessage(read);
                setNotice("Marked read. This message is no longer counted as unread.");
              }).catch((reason) => setErrors([String(reason)]));
            }, children: /* @__PURE__ */ jsx("span", { "aria-hidden": "true", children: "\u2713" }) }) : null,
            selectedMessage.archivedAtMs === null ? /* @__PURE__ */ jsx("button", { type: "button", "aria-label": "Archive message", title: "Archive message", className: "min-h-10 min-w-10 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted active:bg-muted/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary motion-reduce:transition-none", onClick: () => {
              const sequence = refreshSequence.current;
              setErrors([]);
              setNotice(null);
              void rpc.call("archiveOperatorMessage", { projectId: selectedMessage.projectId, messageId: selectedMessage.messageId }).then((archived) => {
                if (sequence === refreshSequence.current) setMessages((current) => showArchivedRef.current ? current.map((item) => messageKey(item) === replyKey ? archived : item) : current.filter((item) => messageKey(item) !== replyKey));
                setNotice("Archived. Turn on Show archived to include it again.");
              }).catch((reason) => setErrors([String(reason)]));
            }, children: "\u25B1" }) : null
          ] })
        ] })
      ] }) : /* @__PURE__ */ jsxs("section", { className: "min-w-0 rounded-lg border border-dashed border-border p-6 text-center", children: [
        /* @__PURE__ */ jsx("h2", { className: "font-medium", children: "Select a message" }),
        /* @__PURE__ */ jsx("p", { className: "mt-1 text-sm text-muted-foreground", children: "Choose a message from the list to read it and see available actions." })
      ] })
    ] })
  ] }) });
}
var app_default = definePluginApp((app) => {
  app.slots.navPanel({ id: "inbox", title: "Inbox", icon: "Mail", path: "inbox", component: InboxPanel });
});
export {
  app_default as default
};
