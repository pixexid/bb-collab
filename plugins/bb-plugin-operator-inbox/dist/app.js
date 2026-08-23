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

// ../../node_modules/@phosphor-icons/react/dist/defs/Archive.es.js
var e = /* @__PURE__ */ new Map([
  [
    "bold",
    /* @__PURE__ */ createElement(Fragment, null, /* @__PURE__ */ createElement("path", { d: "M224,44H32A20,20,0,0,0,12,64V88a20,20,0,0,0,16,19.6V192a20,20,0,0,0,20,20H208a20,20,0,0,0,20-20V107.6A20,20,0,0,0,244,88V64A20,20,0,0,0,224,44ZM36,68H220V84H36ZM52,188V108H204v80Zm112-52a12,12,0,0,1-12,12H104a12,12,0,0,1,0-24h48A12,12,0,0,1,164,136Z" }))
  ],
  [
    "duotone",
    /* @__PURE__ */ createElement(Fragment, null, /* @__PURE__ */ createElement("path", { d: "M216,96v96a8,8,0,0,1-8,8H48a8,8,0,0,1-8-8V96Z", opacity: "0.2" }), /* @__PURE__ */ createElement("path", { d: "M224,48H32A16,16,0,0,0,16,64V88a16,16,0,0,0,16,16v88a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V104a16,16,0,0,0,16-16V64A16,16,0,0,0,224,48ZM208,192H48V104H208ZM224,88H32V64H224V88ZM96,136a8,8,0,0,1,8-8h48a8,8,0,0,1,0,16H104A8,8,0,0,1,96,136Z" }))
  ],
  [
    "fill",
    /* @__PURE__ */ createElement(Fragment, null, /* @__PURE__ */ createElement("path", { d: "M224,48H32A16,16,0,0,0,16,64V88a16,16,0,0,0,16,16v88a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V104a16,16,0,0,0,16-16V64A16,16,0,0,0,224,48Zm-72,96H104a8,8,0,0,1,0-16h48a8,8,0,0,1,0,16Zm72-56H32V64H224V88Z" }))
  ],
  [
    "light",
    /* @__PURE__ */ createElement(Fragment, null, /* @__PURE__ */ createElement("path", { d: "M224,50H32A14,14,0,0,0,18,64V88a14,14,0,0,0,14,14h2v90a14,14,0,0,0,14,14H208a14,14,0,0,0,14-14V102h2a14,14,0,0,0,14-14V64A14,14,0,0,0,224,50ZM210,192a2,2,0,0,1-2,2H48a2,2,0,0,1-2-2V102H210ZM226,88a2,2,0,0,1-2,2H32a2,2,0,0,1-2-2V64a2,2,0,0,1,2-2H224a2,2,0,0,1,2,2ZM98,136a6,6,0,0,1,6-6h48a6,6,0,0,1,0,12H104A6,6,0,0,1,98,136Z" }))
  ],
  [
    "regular",
    /* @__PURE__ */ createElement(Fragment, null, /* @__PURE__ */ createElement("path", { d: "M224,48H32A16,16,0,0,0,16,64V88a16,16,0,0,0,16,16v88a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V104a16,16,0,0,0,16-16V64A16,16,0,0,0,224,48ZM208,192H48V104H208ZM224,88H32V64H224V88ZM96,136a8,8,0,0,1,8-8h48a8,8,0,0,1,0,16H104A8,8,0,0,1,96,136Z" }))
  ],
  [
    "thin",
    /* @__PURE__ */ createElement(Fragment, null, /* @__PURE__ */ createElement("path", { d: "M224,52H32A12,12,0,0,0,20,64V88a12,12,0,0,0,12,12h4v92a12,12,0,0,0,12,12H208a12,12,0,0,0,12-12V100h4a12,12,0,0,0,12-12V64A12,12,0,0,0,224,52ZM212,192a4,4,0,0,1-4,4H48a4,4,0,0,1-4-4V100H212ZM228,88a4,4,0,0,1-4,4H32a4,4,0,0,1-4-4V64a4,4,0,0,1,4-4H224a4,4,0,0,1,4,4ZM100,136a4,4,0,0,1,4-4h48a4,4,0,0,1,0,8H104A4,4,0,0,1,100,136Z" }))
  ]
]);

// ../../node_modules/@phosphor-icons/react/dist/defs/ArrowClockwise.es.js
var a = /* @__PURE__ */ new Map([
  [
    "bold",
    /* @__PURE__ */ createElement(Fragment, null, /* @__PURE__ */ createElement("path", { d: "M244,56v48a12,12,0,0,1-12,12H184a12,12,0,1,1,0-24H201.1l-19-17.38c-.13-.12-.26-.24-.38-.37A76,76,0,1,0,127,204h1a75.53,75.53,0,0,0,52.15-20.72,12,12,0,0,1,16.49,17.45A99.45,99.45,0,0,1,128,228h-1.37A100,100,0,1,1,198.51,57.06L220,76.72V56a12,12,0,0,1,24,0Z" }))
  ],
  [
    "duotone",
    /* @__PURE__ */ createElement(Fragment, null, /* @__PURE__ */ createElement("path", { d: "M216,128a88,88,0,1,1-88-88A88,88,0,0,1,216,128Z", opacity: "0.2" }), /* @__PURE__ */ createElement("path", { d: "M240,56v48a8,8,0,0,1-8,8H184a8,8,0,0,1,0-16H211.4L184.81,71.64l-.25-.24a80,80,0,1,0-1.67,114.78,8,8,0,0,1,11,11.63A95.44,95.44,0,0,1,128,224h-1.32A96,96,0,1,1,195.75,60L224,85.8V56a8,8,0,1,1,16,0Z" }))
  ],
  [
    "fill",
    /* @__PURE__ */ createElement(Fragment, null, /* @__PURE__ */ createElement("path", { d: "M240,56v48a8,8,0,0,1-8,8H184a8,8,0,0,1-5.66-13.66l17-17-10.55-9.65-.25-.24a80,80,0,1,0-1.67,114.78,8,8,0,1,1,11,11.63A95.44,95.44,0,0,1,128,224h-1.32A96,96,0,1,1,195.75,60l10.93,10L226.34,50.3A8,8,0,0,1,240,56Z" }))
  ],
  [
    "light",
    /* @__PURE__ */ createElement(Fragment, null, /* @__PURE__ */ createElement("path", { d: "M238,56v48a6,6,0,0,1-6,6H184a6,6,0,0,1,0-12h32.55l-30.38-27.8c-.06-.06-.12-.13-.19-.19a82,82,0,1,0-1.7,117.65,6,6,0,0,1,8.24,8.73A93.46,93.46,0,0,1,128,222h-1.28A94,94,0,1,1,194.37,61.4L226,90.35V56a6,6,0,1,1,12,0Z" }))
  ],
  [
    "regular",
    /* @__PURE__ */ createElement(Fragment, null, /* @__PURE__ */ createElement("path", { d: "M240,56v48a8,8,0,0,1-8,8H184a8,8,0,0,1,0-16H211.4L184.81,71.64l-.25-.24a80,80,0,1,0-1.67,114.78,8,8,0,0,1,11,11.63A95.44,95.44,0,0,1,128,224h-1.32A96,96,0,1,1,195.75,60L224,85.8V56a8,8,0,1,1,16,0Z" }))
  ],
  [
    "thin",
    /* @__PURE__ */ createElement(Fragment, null, /* @__PURE__ */ createElement("path", { d: "M236,56v48a4,4,0,0,1-4,4H184a4,4,0,0,1,0-8h37.7L187.53,68.69l-.13-.12a84,84,0,1,0-1.75,120.51,4,4,0,0,1,5.5,5.82A91.43,91.43,0,0,1,128,220h-1.26A92,92,0,1,1,193,62.84l35,32.05V56a4,4,0,1,1,8,0Z" }))
  ]
]);

// ../../node_modules/@phosphor-icons/react/dist/defs/EnvelopeOpen.es.js
var l = /* @__PURE__ */ new Map([
  [
    "bold",
    /* @__PURE__ */ createElement(Fragment, null, /* @__PURE__ */ createElement("path", { d: "M230.66,86l-96-64a12,12,0,0,0-13.32,0l-96,64A12,12,0,0,0,20,96V200a20,20,0,0,0,20,20H216a20,20,0,0,0,20-20V96A12,12,0,0,0,230.66,86ZM89.81,152,44,184.31v-65ZM114.36,164h27.28L187,196H69.05ZM166.19,152,212,119.29v65ZM128,46.42l74.86,49.91L141.61,140H114.39L53.14,96.33Z" }))
  ],
  [
    "duotone",
    /* @__PURE__ */ createElement(Fragment, null, /* @__PURE__ */ createElement("path", { d: "M224,96l-78.55,56h-34.9L32,96l96-64Z", opacity: "0.2" }), /* @__PURE__ */ createElement("path", { d: "M228.44,89.34l-96-64a8,8,0,0,0-8.88,0l-96,64A8,8,0,0,0,24,96V200a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V96A8,8,0,0,0,228.44,89.34ZM96.72,152,40,192V111.53Zm16.37,8h29.82l56.63,40H56.46Zm46.19-8L216,111.53V192ZM128,41.61l81.91,54.61-67,47.78H113.11l-67-47.78Z" }))
  ],
  [
    "fill",
    /* @__PURE__ */ createElement(Fragment, null, /* @__PURE__ */ createElement("path", { d: "M228.44,89.34l-96-64a8,8,0,0,0-8.88,0l-96,64A8,8,0,0,0,24,96V200a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V96A8,8,0,0,0,228.44,89.34ZM96.72,152,40,192V111.53Zm16.37,8h29.82l56.63,40H56.46Zm46.19-8L216,111.53V192Z" }))
  ],
  [
    "light",
    /* @__PURE__ */ createElement(Fragment, null, /* @__PURE__ */ createElement("path", { d: "M227.33,91l-96-64a6,6,0,0,0-6.66,0l-96,64A6,6,0,0,0,26,96V200a14,14,0,0,0,14,14H216a14,14,0,0,0,14-14V96A6,6,0,0,0,227.33,91ZM100.18,152,38,195.9V107.65Zm12.27,6h31.1l62.29,44H50.16Zm43.37-6L218,107.65V195.9ZM128,39.21l85.43,57L143.53,146H112.47L42.57,96.17Z" }))
  ],
  [
    "regular",
    /* @__PURE__ */ createElement(Fragment, null, /* @__PURE__ */ createElement("path", { d: "M228.44,89.34l-96-64a8,8,0,0,0-8.88,0l-96,64A8,8,0,0,0,24,96V200a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V96A8,8,0,0,0,228.44,89.34ZM96.72,152,40,192V111.53Zm16.37,8h29.82l56.63,40H56.46Zm46.19-8L216,111.53V192ZM128,41.61l81.91,54.61-67,47.78H113.11l-67-47.78Z" }))
  ],
  [
    "thin",
    /* @__PURE__ */ createElement(Fragment, null, /* @__PURE__ */ createElement("path", { d: "M226.22,92.67l-96-64a4,4,0,0,0-4.44,0l-96,64A4,4,0,0,0,28,96V200a12,12,0,0,0,12,12H216a12,12,0,0,0,12-12V96A4,4,0,0,0,226.22,92.67ZM103.63,152,36,199.76v-96Zm8.19,4h32.36l68,48H43.86Zm40.55-4L220,103.76v96ZM128,36.81,217,96.11,144.17,148H111.83L39.05,96.11Z" }))
  ]
]);

// ../../node_modules/@phosphor-icons/react/dist/defs/PaperPlaneTilt.es.js
var e2 = /* @__PURE__ */ new Map([
  [
    "bold",
    /* @__PURE__ */ createElement(Fragment, null, /* @__PURE__ */ createElement("path", { d: "M230.14,25.86a20,20,0,0,0-19.57-5.11l-.22.07L18.44,79a20,20,0,0,0-3.06,37.25L99,157l40.71,83.65a19.81,19.81,0,0,0,18,11.38c.57,0,1.15,0,1.73-.07A19.82,19.82,0,0,0,177,237.56L235.18,45.65a1.42,1.42,0,0,0,.07-.22A20,20,0,0,0,230.14,25.86ZM156.91,221.07l-34.37-70.64,46-45.95a12,12,0,0,0-17-17l-46,46L34.93,99.09,210,46Z" }))
  ],
  [
    "duotone",
    /* @__PURE__ */ createElement(Fragment, null, /* @__PURE__ */ createElement(
      "path",
      {
        d: "M223.69,42.18l-58.22,192a8,8,0,0,1-14.92,1.25L108,148,20.58,105.45a8,8,0,0,1,1.25-14.92l192-58.22A8,8,0,0,1,223.69,42.18Z",
        opacity: "0.2"
      }
    ), /* @__PURE__ */ createElement("path", { d: "M227.32,28.68a16,16,0,0,0-15.66-4.08l-.15,0L19.57,82.84a16,16,0,0,0-2.49,29.8L102,154l41.3,84.87A15.86,15.86,0,0,0,157.74,248q.69,0,1.38-.06a15.88,15.88,0,0,0,14-11.51l58.2-191.94c0-.05,0-.1,0-.15A16,16,0,0,0,227.32,28.68ZM157.83,231.85l-.05.14,0-.07-40.06-82.3,48-48a8,8,0,0,0-11.31-11.31l-48,48L24.08,98.25l-.07,0,.14,0L216,40Z" }))
  ],
  [
    "fill",
    /* @__PURE__ */ createElement(Fragment, null, /* @__PURE__ */ createElement("path", { d: "M231.4,44.34s0,.1,0,.15l-58.2,191.94a15.88,15.88,0,0,1-14,11.51q-.69.06-1.38.06a15.86,15.86,0,0,1-14.42-9.15L107,164.15a4,4,0,0,1,.77-4.58l57.92-57.92a8,8,0,0,0-11.31-11.31L96.43,148.26a4,4,0,0,1-4.58.77L17.08,112.64a16,16,0,0,1,2.49-29.8l191.94-58.2.15,0A16,16,0,0,1,231.4,44.34Z" }))
  ],
  [
    "light",
    /* @__PURE__ */ createElement(Fragment, null, /* @__PURE__ */ createElement("path", { d: "M225.88,30.12a13.83,13.83,0,0,0-13.7-3.58l-.11,0L20.14,84.77A14,14,0,0,0,18,110.85l85.56,41.64L145.12,238a13.87,13.87,0,0,0,12.61,8c.4,0,.81,0,1.21-.05a13.9,13.9,0,0,0,12.29-10.09l58.2-191.93,0-.11A13.83,13.83,0,0,0,225.88,30.12Zm-8,10.4L159.73,232.43l0,.11a2,2,0,0,1-3.76.26l-40.68-83.58,49-49a6,6,0,1,0-8.49-8.49l-49,49L23.15,100a2,2,0,0,1,.31-3.74l.11,0L215.48,38.08a1.94,1.94,0,0,1,1.92.52A2,2,0,0,1,217.92,40.52Z" }))
  ],
  [
    "regular",
    /* @__PURE__ */ createElement(Fragment, null, /* @__PURE__ */ createElement("path", { d: "M227.32,28.68a16,16,0,0,0-15.66-4.08l-.15,0L19.57,82.84a16,16,0,0,0-2.49,29.8L102,154l41.3,84.87A15.86,15.86,0,0,0,157.74,248q.69,0,1.38-.06a15.88,15.88,0,0,0,14-11.51l58.2-191.94c0-.05,0-.1,0-.15A16,16,0,0,0,227.32,28.68ZM157.83,231.85l-.05.14,0-.07-40.06-82.3,48-48a8,8,0,0,0-11.31-11.31l-48,48L24.08,98.25l-.07,0,.14,0L216,40Z" }))
  ],
  [
    "thin",
    /* @__PURE__ */ createElement(Fragment, null, /* @__PURE__ */ createElement("path", { d: "M224.47,31.52a11.87,11.87,0,0,0-11.82-3L20.74,86.67a12,12,0,0,0-1.91,22.38L105,151l41.92,86.15A11.88,11.88,0,0,0,157.74,244c.34,0,.69,0,1,0a11.89,11.89,0,0,0,10.52-8.63l58.21-192,0-.08A11.85,11.85,0,0,0,224.47,31.52Zm-4.62,9.54-58.23,192a4,4,0,0,1-7.48.59l-41.3-84.86,50-50a4,4,0,1,0-5.66-5.66l-50,50-84.9-41.31a3.88,3.88,0,0,1-2.27-4,3.93,3.93,0,0,1,3-3.54L214.9,36.16A3.93,3.93,0,0,1,216,36a4,4,0,0,1,2.79,1.19A3.93,3.93,0,0,1,219.85,41.06Z" }))
  ]
]);

// ../../node_modules/@phosphor-icons/react/dist/lib/context.es.js
var o = createContext({
  color: "currentColor",
  size: "1em",
  weight: "regular",
  mirrored: false
});

// ../../node_modules/@phosphor-icons/react/dist/lib/IconBase.es.js
var p = forwardRef(
  (s2, a3) => {
    const {
      alt: n,
      color: r2,
      size: t,
      weight: o4,
      mirrored: c2,
      children: i,
      weights: m3,
      ...x
    } = s2, {
      color: d = "currentColor",
      size: l2,
      weight: f = "regular",
      mirrored: g = false,
      ...w
    } = useContext(o);
    return /* @__PURE__ */ createElement(
      "svg",
      {
        ref: a3,
        xmlns: "http://www.w3.org/2000/svg",
        width: t != null ? t : l2,
        height: t != null ? t : l2,
        fill: r2 != null ? r2 : d,
        viewBox: "0 0 256 256",
        transform: c2 || g ? "scale(-1, 1)" : void 0,
        ...w,
        ...x
      },
      !!n && /* @__PURE__ */ createElement("title", null, n),
      i,
      m3.get(o4 != null ? o4 : f)
    );
  }
);
p.displayName = "IconBase";

// ../../node_modules/@phosphor-icons/react/dist/csr/Archive.es.js
var o2 = forwardRef((r2, c2) => /* @__PURE__ */ createElement(p, { ref: c2, ...r2, weights: e }));
o2.displayName = "ArchiveIcon";

// ../../node_modules/@phosphor-icons/react/dist/csr/ArrowClockwise.es.js
var r = forwardRef((e3, c2) => /* @__PURE__ */ createElement(p, { ref: c2, ...e3, weights: a }));
r.displayName = "ArrowClockwiseIcon";

// ../../node_modules/@phosphor-icons/react/dist/csr/EnvelopeOpen.es.js
var o3 = forwardRef((n, p2) => /* @__PURE__ */ createElement(p, { ref: p2, ...n, weights: l }));
o3.displayName = "EnvelopeOpenIcon";

// ../../node_modules/@phosphor-icons/react/dist/csr/PaperPlaneTilt.es.js
var a2 = forwardRef((o4, r2) => /* @__PURE__ */ createElement(p, { ref: r2, ...o4, weights: e2 }));
a2.displayName = "PaperPlaneTiltIcon";

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
var INBOX_INDICATOR_BROKEN_TITLE = "Inbox unread indicator broken";
var LEGACY_UNREAD_MARKER = "[data-bb-collab-inbox-unread]";
var navSnapshots = /* @__PURE__ */ new WeakMap();
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
function restoreAttribute(element, name, value) {
  if (value === null) element.removeAttribute(name);
  else element.setAttribute(name, value);
}
function restoreNavState(row) {
  row.querySelector(LEGACY_UNREAD_MARKER)?.remove();
  const snapshot = navSnapshots.get(row);
  if (snapshot === void 0) return;
  restoreAttribute(row, "aria-label", snapshot.ariaLabel);
  restoreAttribute(row, "title", snapshot.title);
  const glyph = row.querySelector("svg");
  if (glyph !== null) {
    restoreAttribute(glyph, "class", snapshot.glyphClass);
    restoreAttribute(glyph, "style", snapshot.glyphStyle);
  }
  navSnapshots.delete(row);
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
  if (unread < 1) {
    restoreNavState(row);
    return { matched: true };
  }
  if (!navSnapshots.has(row)) {
    navSnapshots.set(row, {
      ariaLabel: row.getAttribute("aria-label"),
      title: row.getAttribute("title"),
      glyphClass: row.querySelector("svg")?.getAttribute("class") ?? null,
      glyphStyle: row.querySelector("svg")?.getAttribute("style") ?? null
    });
  }
  row.querySelector(LEGACY_UNREAD_MARKER)?.remove();
  row.querySelector("svg")?.classList.add("text-primary");
  const countLabel = `${unread} unread operator ${unread === 1 ? "message" : "messages"}`;
  const snapshot = navSnapshots.get(row);
  row.setAttribute("aria-label", `${snapshot.ariaLabel ?? INBOX_NAV_ROW_TITLE}, ${countLabel}`);
  row.setAttribute("title", `${snapshot.title === null ? "" : `${snapshot.title} \u2014 `}${countLabel}`);
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
function formatExactTime(timestamp) {
  const date = new Date(timestamp);
  try {
    return new Intl.DateTimeFormat(void 0, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "shortOffset" }).format(date);
  } catch {
    return `${date.toISOString().replace("T", " ").replace(".000Z", "")} UTC`;
  }
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
  const [pendingAction, setPendingAction] = useState(null);
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
  const pendingSelectedAction = pendingAction?.key === replyKey ? pendingAction.action : null;
  const markReadPending = pendingSelectedAction === "mark-read";
  const archivePending = pendingSelectedAction === "archive";
  const markSelectedMessageRead = () => {
    if (!selectedMessage || !replyKey || pendingAction !== null) return;
    const action = { key: replyKey, action: "mark-read" };
    setPendingAction(action);
    setErrors([]);
    setNotice(null);
    void rpc.call("markOperatorMessageRead", { projectId: selectedMessage.projectId, messageId: selectedMessage.messageId }).then((read) => {
      updateMessage(read);
      setNotice("Marked read. This message is no longer counted as unread.");
    }).catch((reason) => setErrors([String(reason)])).finally(() => setPendingAction((current) => current === action ? null : current));
  };
  const archiveSelectedMessage = () => {
    if (!selectedMessage || !replyKey) return;
    void archiveMessage(selectedMessage).catch(() => void 0);
  };
  const archiveOperations = useRef(/* @__PURE__ */ new Map());
  const archiveMessage = (message) => {
    const key = messageKey(message);
    const existing = archiveOperations.current.get(key);
    if (existing) return existing;
    const action = { key, action: "archive" };
    const sequence = refreshSequence.current;
    setPendingAction(action);
    setErrors([]);
    setNotice(null);
    const operation = rpc.call("archiveOperatorMessage", { projectId: message.projectId, messageId: message.messageId }).then((archived) => {
      if (sequence === refreshSequence.current) setMessages((current) => showArchivedRef.current ? current.map((item) => messageKey(item) === key ? archived : item) : current.filter((item) => messageKey(item) !== key));
      setNotice("Archived. Turn on Show archived to include it again.");
      return archived;
    }).catch((reason) => {
      setErrors([String(reason)]);
      throw reason;
    }).finally(() => {
      archiveOperations.current.delete(key);
      setPendingAction((current) => current === action ? null : current);
    });
    archiveOperations.current.set(key, operation);
    return operation;
  };
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
      /* @__PURE__ */ jsx("button", { type: "button", "aria-label": "Refresh inbox", title: "Refresh inbox", className: "min-h-10 min-w-10 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted active:bg-muted/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none", onClick: refresh, disabled: loading, children: /* @__PURE__ */ jsx(r, { "aria-hidden": "true", focusable: "false", color: "currentColor", weight: "duotone", size: 18 }) })
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
          return /* @__PURE__ */ jsxs("article", { role: "listitem", className: `border-b border-border last:border-b-0 ${selected ? "bg-primary/5 ring-2 ring-inset ring-primary" : message.readAtMs === null ? "bg-primary/10" : "bg-transparent"}`, children: [
            /* @__PURE__ */ jsxs("button", { type: "button", "aria-pressed": selected, "aria-label": `${selected ? "Selected. " : "Select "}message from ${sender}. ${projectNames.get(message.projectId) ?? message.projectId}. ${severityLabel(message.severity)}. ${stateLabel(message)}. ${formatExactTime(message.createdAtMs)}`, style: { textAlign: "left", width: "100%" }, onClick: () => setSelectedMessageKey(key), className: "grid min-w-0 gap-2 px-3 py-3 transition-colors duration-150 hover:bg-muted/60 active:bg-muted/80 focus-visible:z-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary motion-reduce:transition-none", children: [
              /* @__PURE__ */ jsx("span", { className: "sr-only", children: message.readAtMs === null ? "Unread message. " : "" }),
              /* @__PURE__ */ jsxs("span", { className: "flex min-w-0 items-start gap-2", children: [
                /* @__PURE__ */ jsx("span", { className: `min-w-0 flex-1 break-words text-sm ${message.readAtMs === null ? "font-semibold" : "font-medium"}`, children: sender }),
                /* @__PURE__ */ jsx("time", { className: "shrink-0 text-xs text-muted-foreground", dateTime: new Date(message.createdAtMs).toISOString(), title: formatExactTime(message.createdAtMs), "aria-label": `Received ${formatExactTime(message.createdAtMs)}`, children: formatRelativeTime(message.createdAtMs) })
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
            ] }),
            message.archivedAtMs === null ? /* @__PURE__ */ jsx("div", { className: "flex justify-end px-3 pb-2", children: /* @__PURE__ */ jsx("button", { type: "button", "aria-busy": pendingAction?.key === key && pendingAction.action === "archive", "aria-label": pendingAction?.key === key && pendingAction.action === "archive" ? "Archiving message" : "Archive message", title: pendingAction?.key === key && pendingAction.action === "archive" ? "Archiving message" : "Archive message", disabled: pendingAction !== null, className: "min-h-8 min-w-8 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground transition-colors hover:bg-muted active:bg-muted/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none", onClick: () => {
              void archiveMessage(message).catch(() => void 0);
            }, children: /* @__PURE__ */ jsx(o2, { "aria-hidden": "true", focusable: "false", color: "currentColor", weight: "duotone", size: 16 }) }) }) : null
          ] }, key);
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
              /* @__PURE__ */ jsx("time", { dateTime: new Date(selectedMessage.createdAtMs).toISOString(), title: formatExactTime(selectedMessage.createdAtMs), "aria-label": `Received ${formatExactTime(selectedMessage.createdAtMs)}`, children: formatRelativeTime(selectedMessage.createdAtMs) })
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
              /* @__PURE__ */ jsx("time", { className: "text-xs text-muted-foreground", dateTime: new Date(selectedMessage.repliedAtMs).toISOString(), title: formatExactTime(selectedMessage.repliedAtMs), "aria-label": `Delivered ${formatExactTime(selectedMessage.repliedAtMs)}`, children: formatRelativeTime(selectedMessage.repliedAtMs) })
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
            /* @__PURE__ */ jsx("button", { type: "button", "aria-label": replyingMessageKey === replyKey ? "Delivering reply" : selectedMessage.repliedAtMs != null ? "Reply delivered" : selectedMessage.replyDeliveryError ? "Retry reply" : "Send reply", title: replyingMessageKey === replyKey ? "Delivering reply" : selectedMessage.repliedAtMs != null ? "Reply delivered" : selectedMessage.replyDeliveryError ? "Retry reply" : "Send reply", disabled: replyingMessageKey !== null || pendingAction !== null || selectedMessage.repliedAtMs != null || !replyText.trim(), className: "min-h-10 min-w-10 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-opacity duration-150 hover:opacity-90 active:opacity-80 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary motion-reduce:transition-none", onClick: () => {
              const text = replyText.trim();
              if (!text || !replyKey) return;
              setErrors([]);
              setNotice(null);
              setReplyingMessageKey(replyKey);
              void rpc.call("replyToOperatorMessage", { projectId: selectedMessage.projectId, messageId: selectedMessage.messageId, text }).then((replied) => {
                updateMessage(replied);
                setNotice(replied.repliedAtMs != null ? "Reply delivered. BB confirmed the matching input." : replied.replyInProgress ? "Delivery pending. The outcome is not yet known." : replied.replyDeliveryError ? "Delivery failed. The message remains retryable." : "Reply delivery is not confirmed.");
              }).catch((reason) => setErrors([String(reason)])).finally(() => setReplyingMessageKey(null));
            }, children: /* @__PURE__ */ jsx(a2, { "aria-hidden": "true", focusable: "false", color: "currentColor", weight: "duotone", size: 18 }) }),
            selectedMessage.readAtMs === null ? /* @__PURE__ */ jsx("button", { type: "button", "aria-busy": markReadPending, "aria-label": markReadPending ? "Marking message read" : "Mark message read", title: markReadPending ? "Marking message read" : "Mark message read", disabled: pendingAction !== null, className: "min-h-10 min-w-10 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted active:bg-muted/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none", onClick: markSelectedMessageRead, children: /* @__PURE__ */ jsx(o3, { "aria-hidden": "true", focusable: "false", color: "currentColor", weight: "duotone", size: 18 }) }) : null,
            selectedMessage.archivedAtMs === null ? /* @__PURE__ */ jsx("button", { type: "button", "aria-busy": archivePending, "aria-label": archivePending ? "Archiving message" : "Archive message", title: archivePending ? "Archiving message" : "Archive message", disabled: pendingAction !== null, className: "min-h-10 min-w-10 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted active:bg-muted/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none", onClick: archiveSelectedMessage, children: /* @__PURE__ */ jsx(o2, { "aria-hidden": "true", focusable: "false", color: "currentColor", weight: "duotone", size: 18 }) }) : null
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
  app.slots.navPanel({ id: "inbox", title: "Inbox", icon: "./assets/envelope-simple-duotone.svg", path: "inbox", component: InboxPanel });
});
export {
  app_default as default
};
