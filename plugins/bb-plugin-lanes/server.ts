import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { laneListSchema, rpcContract } from "./contract.js";

const CORE_PLUGIN_ID = "bb-collab";
const CORE_LANES_METHOD = "v1-lanes";

export default function plugin(bb: BbPluginApi) {
  const readLanes = async () => laneListSchema.parse(await bb.sdk.plugins.callRpc({
    pluginId: CORE_PLUGIN_ID,
    method: CORE_LANES_METHOD,
    input: {},
    outputSchema: laneListSchema,
  }));

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
