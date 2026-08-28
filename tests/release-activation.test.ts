import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { activateRelease } from "../scripts/activate-release.mjs";
import { canonicalJson, manifestFor, verifyRuntimeClosure } from "../scripts/release-artifact.mjs";

const PROJECT_ID = "proj_activationfixture";
const PRIOR_SCHEMA = "1".repeat(64);
const CANDIDATE_SCHEMA = "2".repeat(64);

function fixture(schemaImportMarker?: string, failSchemaImport = false) {
  const root = mkdtempSync(join(tmpdir(), "bb-collab-activation-"));
  const sourceRoot = join(root, "source");
  const releaseDirectory = join(root, "release");
  const priorRoot = join(root, "prior");
  const stateDirectory = join(root, "state");
  for (const directory of [sourceRoot, releaseDirectory, priorRoot]) mkdirSync(join(directory, "dist"), { recursive: true });
  const sourceManifest = {
    name: "bb-plugin-bb-collab",
    version: "0.1.0",
    type: "module",
    scripts: { build: "node -e 0" },
    bb: { name: "bb-collab", description: "fixture", branding: { icon: "Box" }, server: "./dist/server.js", app: "./app.tsx", skills: [] },
  };
  writeFileSync(join(sourceRoot, "package.json"), JSON.stringify(sourceManifest));
  const server = `import { defineRpcContract } from "@bb/plugin-sdk";\n${schemaImportMarker ? `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(schemaImportMarker)}, "imported");\n` : ""}${failSchemaImport ? 'throw new Error("schema import failed");\n' : ""}export const schemaDigest = '${CANDIDATE_SCHEMA}';\nexport default () => defineRpcContract;\n`;
  writeFileSync(join(sourceRoot, "dist/server.js"), server);
  writeFileSync(join(sourceRoot, "dist/app.js"), "candidate app\n");
  writeFileSync(join(sourceRoot, "dist/app.meta.json"), "{}\n");
  writeFileSync(join(releaseDirectory, "dist/server.js"), server);
  writeFileSync(join(releaseDirectory, "dist/app.js"), "candidate app\n");
  writeFileSync(join(releaseDirectory, "dist/app.meta.json"), "{}\n");
  writeFileSync(join(priorRoot, "package.json"), JSON.stringify(sourceManifest));
  writeFileSync(join(priorRoot, "dist/server.js"), "prior server\n");
  writeFileSync(join(priorRoot, "dist/app.js"), "prior app\n");
  writeFileSync(join(priorRoot, "dist/app.meta.json"), "{}\n");
  const sdkRoot = join(releaseDirectory, "node_modules/@bb/plugin-sdk");
  mkdirSync(join(sdkRoot, "dist"), { recursive: true });
  writeFileSync(join(sdkRoot, "package.json"), JSON.stringify({ name: "@bb/plugin-sdk", version: "0.4.1", type: "module", exports: { ".": "./dist/index.js" } }));
  writeFileSync(join(sdkRoot, "dist/index.js"), "export const defineRpcContract = {};\n");
  execFileSync("git", ["init", "--quiet"], { cwd: sourceRoot });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: sourceRoot });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: sourceRoot });
  execFileSync("git", ["add", "."], { cwd: sourceRoot });
  execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: sourceRoot });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceRoot, encoding: "utf8" }).trim();
  const manifest = manifestFor(releaseDirectory, commit, sourceRoot);
  writeFileSync(join(releaseDirectory, "release-manifest.json"), `${canonicalJson(manifest)}\n`);
  return { root, sourceRoot, releaseDirectory, priorRoot, stateDirectory };
}

function fakeAdapter(priorRoot: string, options: {
  priorSchema?: string;
  bind?: (state: AdapterState, binding: any) => void;
  settle?: (state: AdapterState) => void;
  rollback?: (state: AdapterState) => void;
  resident?: (state: AdapterState, binding: any) => Record<string, unknown>;
  lawfulSchemaCutover?: boolean;
} = {}) {
  const priorSource = { requested: `path:${priorRoot}`, resolved: `path:${priorRoot}`, engines: {}, installedAt: 1, history: [] };
  const state: AdapterState = { root: priorRoot, source: priorSource, status: "running", services: [], bound: false, rollbackCalls: 0, binding: null };
  const appHash = () => {
    const hash = createHash("sha256").update(readFileSync(join(state.root, "dist/app.js")));
    if (existsSync(join(state.root, "dist/app.css"))) hash.update(readFileSync(join(state.root, "dist/app.css")));
    hash.update(readFileSync(join(state.root, "dist/app.meta.json")));
    return hash.digest("hex").slice(0, 16);
  };
  const doctor = () => ({
    outcome: "OK",
    evidence: {
      project: { id: PROJECT_ID },
      schema: { digest: state.bound ? CANDIDATE_SCHEMA : (options.priorSchema ?? CANDIDATE_SCHEMA) },
      ...(options.lawfulSchemaCutover ? {
        governorshipHead: { project_id: PROJECT_ID, governance_epoch: 7, fence_token: "a".repeat(48), state: "frozen" },
        activeMigrationRun: { migration_id: "migration-schema-change", state: "exported", target_runtime_id: "bb-collab", retentionExpired: false, unresolvedProof: [], quiescence_digest: "b".repeat(64), source_export_digest: "c".repeat(64) },
        capacity: { activeWriterCount: 0, blindWriterLaneIds: [] },
      } : {}),
    },
  });
  const adapter = {
    status: () => ({ project: { id: PROJECT_ID } }),
    list: () => [{ id: "bb-collab", rootDir: state.root, status: state.status, services: state.services, app: { hasApp: true, bundle: { compatible: true, hash: appHash() } } }],
    source: () => state.source,
    doctor,
    resident(binding: any) {
      if (options.resident) return options.resident(state, binding);
      const server = binding.expectedFiles.find((file: any) => file.path === "dist/server.js");
      return { pluginId: binding.pluginId, serverEntry: binding.serverEntry, serverSha256: server.sha256, services: [] };
    },
    bind(binding: any) {
      state.bound = true;
      state.binding = binding;
      state.root = binding.resolvedRoot;
      state.source = { requested: `path:${binding.resolvedRoot}`, resolved: `path:${binding.resolvedRoot}`, engines: {}, installedAt: 2, history: [] };
      options.bind?.(state, binding);
      return { adapter: "fixture" };
    },
    settle: async () => { options.settle?.(state); },
    rollback() {
      state.rollbackCalls += 1;
      if (options.rollback) options.rollback(state);
      else {
        state.bound = false;
        state.root = priorRoot;
        state.source = priorSource;
        state.status = "running";
      }
    },
  };
  return { adapter, state };
}

interface AdapterState {
  root: string;
  source: Record<string, unknown>;
  status: string;
  services: Array<{ name: string; state: string }>;
  bound: boolean;
  rollbackCalls: number;
  binding: any;
}

function cleanup(path: string) {
  if (!lstatSync(path).isDirectory()) return;
  chmodSync(path, 0o700);
  for (const entry of readdirSync(path)) {
    const child = join(path, entry);
    if (lstatSync(child).isDirectory()) cleanup(child);
    else chmodSync(child, 0o600);
  }
  rmSync(path, { recursive: true, force: true });
}

async function runFixture(created: ReturnType<typeof fixture>, adapter: ReturnType<typeof fakeAdapter>["adapter"], extra = {}) {
  return activateRelease({
    releaseDirectory: created.releaseDirectory,
    sourceRoot: created.sourceRoot,
    stateDirectory: created.stateDirectory,
    projectId: PROJECT_ID,
    adapter,
    ...extra,
  });
}

describe("inactive release activation", () => {
  it("imports schema from the staged wrapper without source node_modules", async () => {
    const created = fixture();
    const { adapter } = fakeAdapter(created.priorRoot);
    try {
      expect(existsSync(join(created.sourceRoot, "node_modules"))).toBe(false);
      await expect(runFixture(created, adapter)).resolves.toMatchObject({ outcome: "activated" });
    } finally { cleanup(created.root); }
  });

  it("rejects an invalid closure before schema import or activation state", async () => {
    const markerRoot = mkdtempSync(join(tmpdir(), "bb-collab-schema-import-marker-"));
    const marker = join(markerRoot, "imported");
    const created = fixture(marker);
    const { adapter, state } = fakeAdapter(created.priorRoot);
    try {
      writeFileSync(join(created.releaseDirectory, "node_modules/@bb/plugin-sdk/extra.js"), "unmanifested\n");
      await expect(runFixture(created, adapter)).rejects.toThrow("release runtime closure file set does not match its imports");
      expect(existsSync(marker)).toBe(false);
      expect(state).toMatchObject({ root: created.priorRoot, bound: false, rollbackCalls: 0 });
      expect(existsSync(join(created.stateDirectory, "deployment.pending.json"))).toBe(false);
      expect(existsSync(join(created.stateDirectory, "deployment.json"))).toBe(false);
      expect(existsSync(join(created.stateDirectory, "activation.lock"))).toBe(false);
    } finally { cleanup(created.root); rmSync(markerRoot, { recursive: true, force: true }); }
  });

  it("leaves prior state exact when the staged schema import fails", async () => {
    const created = fixture(undefined, true);
    const { adapter, state } = fakeAdapter(created.priorRoot);
    try {
      await expect(runFixture(created, adapter)).rejects.toThrow("schema import failed");
      expect(state).toMatchObject({ root: created.priorRoot, bound: false, rollbackCalls: 0 });
      expect(existsSync(join(created.stateDirectory, "deployment.pending.json"))).toBe(false);
      expect(existsSync(join(created.stateDirectory, "deployment.json"))).toBe(false);
      expect(existsSync(join(created.stateDirectory, "activation.lock"))).toBe(false);
    } finally { cleanup(created.root); }
  });

  it("refuses a mutable staged closure independently", async () => {
    const created = fixture();
    const { adapter } = fakeAdapter(created.priorRoot);
    try {
      const result = await runFixture(created, adapter);
      const manifest = JSON.parse(readFileSync(join(created.releaseDirectory, "release-manifest.json"), "utf8"));
      const sdk = join(result.receipt.artifactRoot, "node_modules/@bb/plugin-sdk/dist/index.js");
      chmodSync(sdk, 0o644);
      expect(() => verifyRuntimeClosure(result.receipt.artifactRoot, manifest, true)).toThrow("staged runtime closure is mutable");
    } finally { cleanup(created.root); }
  });

  it("activates an unchanged schema without backup or quiescence ceremony", async () => {
    const created = fixture();
    const { adapter } = fakeAdapter(created.priorRoot);
    try {
      const result = await runFixture(created, adapter);
      expect(result.outcome).toBe("activated");
      expect(result.receipt).toMatchObject({ state: "active", projectId: PROJECT_ID, schemaFingerprint: CANDIDATE_SCHEMA, schemaEvidenceDigest: null });
      expect(JSON.parse(readFileSync(join(created.stateDirectory, "deployment.json"), "utf8"))).toMatchObject({ state: "active" });
    } finally { cleanup(created.root); }
  });

  it("rejects candidate bytes staged elsewhere while registration remains prior", async () => {
    const created = fixture();
    const { adapter, state } = fakeAdapter(created.priorRoot, { bind: (current) => { current.root = created.priorRoot; } });
    try {
      await expect(runFixture(created, adapter)).rejects.toThrow("loaded generation is not bound to candidate");
      expect(state.root).toBe(created.priorRoot);
      expect(state.rollbackCalls).toBe(1);
    } finally { cleanup(created.root); }
  });

  it("rejects a path binding whose actual server entry resolves to server.ts", async () => {
    const created = fixture();
    const { adapter, state } = fakeAdapter(created.priorRoot, { bind: (_current, binding) => {
      chmodSync(binding.resolvedRoot, 0o755);
      chmodSync(join(binding.resolvedRoot, "package.json"), 0o644);
      const manifest = JSON.parse(readFileSync(join(binding.resolvedRoot, "package.json"), "utf8"));
      manifest.bb.server = "./server.ts";
      writeFileSync(join(binding.resolvedRoot, "package.json"), JSON.stringify(manifest));
      writeFileSync(join(binding.resolvedRoot, "server.ts"), "export default () => {};\n");
    } });
    try {
      await expect(runFixture(created, adapter)).rejects.toThrow("server entry is not candidate dist/server.js");
      expect(state.root).toBe(created.priorRoot);
    } finally { cleanup(created.root); }
  });

  it("detects a post-settle frontend rewrite and rolls back", async () => {
    const created = fixture();
    const { adapter, state } = fakeAdapter(created.priorRoot, { settle: (current) => {
      chmodSync(join(current.root, "dist"), 0o755);
      chmodSync(join(current.root, "dist/app.js"), 0o644);
      writeFileSync(join(current.root, "dist/app.js"), "ambient rebuild\n");
    } });
    try {
      await expect(runFixture(created, adapter)).rejects.toThrow("deployed artifact digest mismatch: bb-collab/dist/app.js");
      expect(state.root).toBe(created.priorRoot);
    } finally { cleanup(created.root); }
  });

  it("rejects reload success while the prior generation remains resident", async () => {
    const created = fixture();
    const priorServer = createHash("sha256").update(readFileSync(join(created.priorRoot, "dist/server.js"))).digest("hex");
    const { adapter, state } = fakeAdapter(created.priorRoot, { resident: (_current, binding) => ({ pluginId: binding.pluginId, serverEntry: binding.serverEntry, serverSha256: priorServer, services: [] }) });
    try {
      await expect(runFixture(created, adapter)).rejects.toThrow("resident server generation mismatch");
      expect(state.rollbackCalls).toBe(1);
    } finally { cleanup(created.root); }
  });

  it("fails loudly when rollback is skipped after failed health", async () => {
    const created = fixture();
    const { adapter, state } = fakeAdapter(created.priorRoot, {
      bind: (current) => { current.status = "degraded"; },
      rollback: () => {},
    });
    try {
      await expect(runFixture(created, adapter)).rejects.toThrow("rollback failed: prior loaded generation was not restored");
      expect(state.root).not.toBe(created.priorRoot);
    } finally { cleanup(created.root); }
  });

  it("refuses a schema-changing candidate without backup and quiescence evidence", async () => {
    const created = fixture();
    const { adapter, state } = fakeAdapter(created.priorRoot, { priorSchema: PRIOR_SCHEMA });
    try {
      await expect(runFixture(created, adapter)).rejects.toThrow("schema-changing activation requires one canonical migration id");
      expect(state.rollbackCalls).toBe(0);
    } finally { cleanup(created.root); }
  });

  it("restores the prior path registration when bind mutates and then throws", async () => {
    const created = fixture();
    const { adapter, state } = fakeAdapter(created.priorRoot, { bind: () => { throw new Error("reload failed after registration moved"); } });
    try {
      await expect(runFixture(created, adapter)).rejects.toThrow("reload failed after registration moved");
      expect(state.root).toBe(created.priorRoot);
      expect(state.source.requested).toBe(`path:${created.priorRoot}`);
      expect(state.rollbackCalls).toBe(1);
    } finally { cleanup(created.root); }
  });

  it("refuses caller-crafted schema evidence", async () => {
    const created = fixture();
    const { adapter, state } = fakeAdapter(created.priorRoot, { priorSchema: PRIOR_SCHEMA });
    try {
      await expect(runFixture(created, adapter, { schemaCutoverId: JSON.stringify({ verified: true, quiescence: "d".repeat(64) }) })).rejects.toThrow("one canonical migration id");
      expect(state.rollbackCalls).toBe(0);
    } finally { cleanup(created.root); }
  });

  it("accepts a schema change only with the live frozen canonical cutover", async () => {
    const created = fixture();
    const { adapter } = fakeAdapter(created.priorRoot, { priorSchema: PRIOR_SCHEMA, lawfulSchemaCutover: true });
    try {
      const result = await runFixture(created, adapter, { schemaCutoverId: "migration-schema-change" });
      expect(result.outcome).toBe("activated");
      expect(result.receipt.schemaEvidenceDigest).toMatch(/^[0-9a-f]{64}$/u);
    } finally { cleanup(created.root); }
  });
});
