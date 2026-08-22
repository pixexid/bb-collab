import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginComposerThreadRowStatus, PluginNavPanelProps, PluginRpcResult } from "@get-bb/plugin-sdk/app";
import { laneListSchema } from "./contract";
import type { rpcContract } from "./contract";

type Lane = PluginRpcResult<typeof rpcContract["lanes"]>[number];

function age(ms: number): string { const minutes = Math.floor(ms / 60_000); if (minutes < 1) return "just now"; if (minutes < 60) return `${minutes}m`; const hours = Math.floor(minutes / 60); return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d`; }
function laneQueueLabel(lane: Lane): string { if (lane.queueState !== "deferred" && !lane.deferredReason) return lane.nextStartable ? "next startable" : lane.waitingOn ?? "worker"; return `Deferred · ${lane.deferredReason?.replace(/_/gu, " ") ?? "reason unavailable"}${typeof lane.deferredAgeMs === "number" ? ` · ${age(lane.deferredAgeMs)}` : ""}`; }

function LanesPanel(_props: PluginNavPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [lanes, setLanes] = useState<readonly Lane[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void rpc.call("lanes", {}).then((next) => { setLanes(next); setError(null); }).catch((reason: unknown) => setError(String(reason)));
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
                <div className="truncate text-xs text-muted-foreground">{lane.threadId ?? "worker not attached"}</div>
              </div>
              <div className="text-muted-foreground">{laneQueueLabel(lane)}</div>
              <time className="text-muted-foreground" title={`${lane.ageMs}ms old`}>{age(lane.ageMs)}</time>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}

export async function readPluginHttp(pluginId: string, signal: AbortSignal): Promise<readonly Lane[]> {
  const response = await fetch(`/api/v1/plugins/${pluginId}/http/lanes`, { credentials: "same-origin", signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return laneListSchema.parse(await response.json());
}

export function mountLanePulse({ pluginId, signal, setStatus }: { pluginId: string; signal: AbortSignal; setStatus: (threadId: string, status: PluginComposerThreadRowStatus | null) => void }): () => void {
  let previous = new Set<string>();
  const refresh = async () => {
    try {
      const lanes = await readPluginHttp(pluginId, signal);
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
  return () => {
    window.clearInterval(timer);
    for (const threadId of previous) setStatus(threadId, null);
    previous.clear();
  };
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "lanes",
    title: "Lanes",
    icon: "GitBranch",
    path: "lanes",
    component: LanesPanel,
  });
  app.contentScripts.register({
    id: "lane-thread-status",
    mount: ({ pluginId, signal, experimental_setThreadRowStatus }) => {
      if (!experimental_setThreadRowStatus) return;
      return mountLanePulse({ pluginId, signal, setStatus: experimental_setThreadRowStatus });
    },
  });
});
