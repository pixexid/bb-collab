import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { registerDeploymentIdentityCli } from "../../src/deployment-identity.js";
import { laneListSchema, rpcContract } from "./contract.js";

const CORE_PLUGIN_ID = "bb-collab";
const CORE_LANES_METHOD = "v1-lanes";
const CORE_RPC_TIMEOUT_MS = 4_000;

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`bb-collab ${CORE_LANES_METHOD} timed out after ${CORE_RPC_TIMEOUT_MS}ms`)), CORE_RPC_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export default function plugin(bb: BbPluginApi) {
  registerDeploymentIdentityCli(bb, "lanes", "lanes", import.meta.url);
  let coreRead: Promise<unknown> | null = null;
  const readLanes = async () => {
    if (coreRead === null) {
      coreRead = bb.sdk.plugins.callRpc({
        pluginId: CORE_PLUGIN_ID,
        method: CORE_LANES_METHOD,
        input: {},
        outputSchema: laneListSchema,
      }).finally(() => { coreRead = null; });
    }
    return laneListSchema.parse(await withTimeout(coreRead));
  };

  bb.rpc.register(rpcContract, {
    lanes: readLanes,
  });

  bb.http.route("GET", "/lanes", async () => {
    try {
      return Response.json(await readLanes());
    } catch {
      return Response.json({ error: "Collaboration Lanes is unavailable" }, { status: 503 });
    }
  });
}
