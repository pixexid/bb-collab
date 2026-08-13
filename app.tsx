import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useRpc } from "@bb/plugin-sdk/app";
import type { PluginComposerThreadRowStatus, PluginPendingInteractionProps, PluginRpcResult } from "@bb/plugin-sdk/app";
import { rpcContract } from "./server";

type Lane = PluginRpcResult<typeof rpcContract["lanes"]>[number];

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
