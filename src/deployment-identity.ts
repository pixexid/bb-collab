import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

type ResidentService = { pluginId: string; name: string; serverSha256: string; token: string };
const servicesKey = Symbol.for("bb-collab.resident-services.v1");

function residentServices(): Map<string, ResidentService> {
  const root = globalThis as typeof globalThis & { [servicesKey]?: Map<string, ResidentService> };
  return root[servicesKey] ??= new Map();
}

export function residentServerIdentity(pluginId: string, moduleUrl: string) {
  const serverEntry = realpathSync(fileURLToPath(moduleUrl));
  const serverSha256 = createHash("sha256").update(readFileSync(serverEntry)).digest("hex");
  return {
    pluginId,
    serverEntry,
    serverSha256,
    services: [...residentServices().values()]
      .filter((service) => service.pluginId === pluginId)
      .sort((a, b) => a.name.localeCompare(b.name) || a.token.localeCompare(b.token)),
  };
}

export function registerResidentService(pluginId: string, moduleUrl: string, name: string): () => void {
  const identity = residentServerIdentity(pluginId, moduleUrl);
  const token = randomUUID();
  residentServices().set(token, { pluginId, name, serverSha256: identity.serverSha256, token });
  return () => residentServices().delete(token);
}

export function registerDeploymentIdentityCli(bb: BbPluginApi, command: string, pluginId: string, moduleUrl: string): void {
  // Isolated plugin unit harnesses may intentionally omit unrelated SDK surfaces.
  if (!bb.cli?.register) return;
  bb.cli.register({
    name: command,
    summary: `Inspect the resident ${pluginId} generation`,
    commands: [{ name: "activation-identity", summary: "Return the resident server generation", usage: `bb ${command} activation-identity --json` }],
    run(argv) {
      if (argv[0] !== "activation-identity") throw new Error("expected activation-identity");
      return { exitCode: 0, stdout: `${JSON.stringify(residentServerIdentity(pluginId, moduleUrl))}\n` };
    },
  });
}
