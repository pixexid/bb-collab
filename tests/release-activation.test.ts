import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { activateRelease, assertNonOverlappingRoots, systemAdapter } from "../scripts/activate-release.mjs";
import { canonicalJson, manifestFor, verifyRuntimeClosure } from "../scripts/release-artifact.mjs";

const PROJECT_ID = "proj_activationfixture";
const PRIOR_SCHEMA = "1".repeat(64);
const CANDIDATE_SCHEMA = "2".repeat(64);
const TOOLCHAIN = { bbVersion: "0.39.0", pluginSdkVersion: "0.4.8" };
const appMeta = (sdkVersion = TOOLCHAIN.pluginSdkVersion, bbVersion = TOOLCHAIN.bbVersion) => JSON.stringify({ sdkMajor: 0, sdkVersion, artifactFormatVersion: 1, pluginId: "bb-collab", pluginVersion: "0.1.0", builtWith: { bbVersion, pluginSdkVersion: sdkVersion } });

function makeBuildFree(root: string) {
  const source = Date.UTC(2000, 0, 1) / 1000;
  for (const path of [root, join(root, "package.json")]) utimesSync(path, source, source);
  utimesSync(join(root, "dist/app.js"), source + 60, source + 60);
}

function fixture(schemaImportMarker?: string, failSchemaImport = false, frontend = true) {
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
    bb: { name: "bb-collab", description: "fixture", branding: { icon: "Box" }, server: "./dist/server.js", ...(frontend ? { app: "./app.tsx" } : {}), skills: [] },
  };
  writeFileSync(join(sourceRoot, "package.json"), JSON.stringify(sourceManifest));
  const server = `import { defineRpcContract } from "@bb/plugin-sdk";\n${schemaImportMarker ? `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(schemaImportMarker)}, "imported");\n` : ""}${failSchemaImport ? 'throw new Error("schema import failed");\n' : ""}export const schemaDigest = '${CANDIDATE_SCHEMA}';\nexport default () => defineRpcContract;\n`;
  writeFileSync(join(sourceRoot, "dist/server.js"), server);
  if (frontend) {
    writeFileSync(join(sourceRoot, "dist/app.js"), "candidate app\n");
    writeFileSync(join(sourceRoot, "dist/app.meta.json"), `${appMeta()}\n`);
  }
  writeFileSync(join(releaseDirectory, "dist/server.js"), server);
  if (frontend) {
    writeFileSync(join(releaseDirectory, "dist/app.js"), "candidate app\n");
    writeFileSync(join(releaseDirectory, "dist/app.meta.json"), `${appMeta()}\n`);
  }
  writeFileSync(join(priorRoot, "package.json"), JSON.stringify(sourceManifest));
  writeFileSync(join(priorRoot, "dist/server.js"), "prior server\n");
  if (frontend) {
    writeFileSync(join(priorRoot, "dist/app.js"), "prior app\n");
    writeFileSync(join(priorRoot, "dist/app.meta.json"), `${appMeta()}\n`);
    makeBuildFree(priorRoot);
  }
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
  beforeOverlay?: (state: AdapterState, plan: any) => void;
  afterRename?: (state: AdapterState, plan: any) => void;
  afterSymlink?: (state: AdapterState, plan: any) => void;
  reloadFailure?: "before-resident" | "after-candidate" | "rollback";
  residentGeneration?: "prior" | "candidate" | "mixed";
  hostVersion?: string;
  settle?: (state: AdapterState) => void;
  resident?: (state: AdapterState, binding: any) => Record<string, unknown>;
  lawfulSchemaCutover?: boolean;
  sourceKind?: "path" | "git" | "npm";
  dataDir?: string;
} = {}) {
  const priorResolvedRoot = realpathSync(priorRoot);
  const kind = options.sourceKind ?? "path";
  const priorSource = { requested: `${kind}:${kind === "path" ? priorRoot : "fixture"}`, resolved: `${kind}:${kind === "path" ? priorRoot : "fixture"}`, engines: {}, installedAt: 1, history: [] };
  const priorServer = createHash("sha256").update(readFileSync(join(priorRoot, "dist/server.js"))).digest("hex");
  const state: AdapterState = { root: priorRoot, source: priorSource, status: "running", services: [], bound: false, rollbackCalls: 0, binding: null, plan: null, generation: "prior", commands: [] };
  const appHash = () => {
    const root = state.generation === "prior" ? (existsSync(priorRoot) ? priorRoot : state.plan?.priorSlotKind === "directory" ? state.plan.retainedRoot : priorResolvedRoot) : state.binding.resolvedRoot;
    if (!existsSync(join(root, "dist/app.js"))) return null;
    const hash = createHash("sha256").update(readFileSync(join(root, "dist/app.js")));
    if (existsSync(join(root, "dist/app.css"))) hash.update(readFileSync(join(root, "dist/app.css")));
    hash.update(readFileSync(join(root, "dist/app.meta.json")));
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
    version: () => options.hostVersion ?? TOOLCHAIN.bbVersion,
    status: () => ({ project: { id: PROJECT_ID }, dataDir: options.dataDir ?? join(priorRoot, "data") }),
    list: () => {
      const hash = appHash();
      return [{ id: "bb-collab", rootDir: priorRoot, status: state.status, services: state.services, app: hash === null ? { hasApp: false, bundle: null } : { hasApp: true, bundle: { compatible: true, hash } } }];
    },
    source: () => state.source,
    doctor,
    resident(binding: any) {
      if (options.resident) return options.resident(state, binding);
      if (state.generation === "prior") return { pluginId: binding.pluginId, serverEntry: join(priorRoot, "dist/server.js"), serverSha256: priorServer, services: [] };
      const server = binding.expectedFiles.find((file: any) => file.path === "dist/server.js");
      return { pluginId: binding.pluginId, serverEntry: binding.serverEntry, serverSha256: state.generation === "mixed" ? priorServer : server.sha256, services: [] };
    },
    beforeOverlay(plan: any) { state.plan = plan; options.beforeOverlay?.(state, plan); },
    afterRename(plan: any) { options.afterRename?.(state, plan); },
    afterSymlink(plan: any) { options.afterSymlink?.(state, plan); },
    reload(binding: any) {
      state.commands.push("reload");
      state.binding = binding;
      if (realpathSync(priorRoot) === realpathSync(binding.resolvedRoot)) {
        if (options.reloadFailure === "before-resident") throw new Error("reload failed before resident swap");
        state.generation = options.residentGeneration ?? "candidate";
        state.bound = true;
        options.bind?.(state, binding);
        if (options.reloadFailure === "after-candidate") throw new Error("reload failed after candidate resident swap");
        return {};
      }
      if (options.reloadFailure === "rollback") throw new Error("prior reload failed");
      state.generation = "prior";
      state.bound = false;
      state.status = "running";
      return {};
    },
    bind(binding: any) {
      state.bound = true;
      state.binding = binding;
      options.bind?.(state, binding);
    },
    settle: async () => { options.settle?.(state); },
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
  plan: any;
  generation: "prior" | "candidate" | "mixed";
  commands: string[];
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

function rewriteCandidateMeta(created: ReturnType<typeof fixture>, sdkVersion: string, bbVersion = TOOLCHAIN.bbVersion) {
  const bytes = `${appMeta(sdkVersion, bbVersion)}\n`;
  writeFileSync(join(created.sourceRoot, "dist/app.meta.json"), bytes);
  writeFileSync(join(created.releaseDirectory, "dist/app.meta.json"), bytes);
  execFileSync("git", ["add", "."], { cwd: created.sourceRoot });
  execFileSync("git", ["commit", "--quiet", "-m", "candidate metadata"], { cwd: created.sourceRoot });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: created.sourceRoot, encoding: "utf8" }).trim();
  writeFileSync(join(created.releaseDirectory, "release-manifest.json"), `${canonicalJson(manifestFor(created.releaseDirectory, commit, created.sourceRoot))}\n`);
}

function rewriteCandidateServer(created: ReturnType<typeof fixture>) {
  const server = `import { defineRpcContract } from "@bb/plugin-sdk";\nexport const schemaDigest = '${CANDIDATE_SCHEMA}';\nexport const correction = true;\nexport default () => defineRpcContract;\n`;
  writeFileSync(join(created.sourceRoot, "dist/server.js"), server);
  writeFileSync(join(created.releaseDirectory, "dist/server.js"), server);
  execFileSync("git", ["add", "."], { cwd: created.sourceRoot });
  execFileSync("git", ["commit", "--quiet", "-m", "second candidate"], { cwd: created.sourceRoot });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: created.sourceRoot, encoding: "utf8" }).trim();
  writeFileSync(join(created.releaseDirectory, "release-manifest.json"), `${canonicalJson(manifestFor(created.releaseDirectory, commit, created.sourceRoot))}\n`);
}

function addPathBranding(created: ReturnType<typeof fixture>) {
  const path = "assets/logo.svg";
  const svg = readFileSync(join(process.cwd(), path), "utf8");
  for (const root of [created.sourceRoot, created.priorRoot]) {
    mkdirSync(join(root, "assets"), { recursive: true });
    writeFileSync(join(root, path), svg);
    const manifestPath = join(root, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.bb.branding = { logo: { light: `./${path}` } };
    writeFileSync(manifestPath, JSON.stringify(manifest));
  }
  const sourceEpoch = Date.UTC(2000, 0, 1) / 1000;
  for (const path of [join(created.priorRoot, "assets"), join(created.priorRoot, "assets/logo.svg")]) utimesSync(path, sourceEpoch, sourceEpoch);
  makeBuildFree(created.priorRoot);
  execFileSync("git", ["add", "."], { cwd: created.sourceRoot });
  execFileSync("git", ["commit", "--quiet", "-m", "path branding"], { cwd: created.sourceRoot });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: created.sourceRoot, encoding: "utf8" }).trim();
  writeFileSync(join(created.releaseDirectory, "release-manifest.json"), `${canonicalJson(manifestFor(created.releaseDirectory, commit, created.sourceRoot))}\n`);
  return { path, svg };
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
    const pending = Buffer.from("prior pending marker\n");
    const receipt = Buffer.from('{"state":"active","releaseDigest":"prior"}\n');
    try {
      mkdirSync(created.stateDirectory);
      writeFileSync(join(created.stateDirectory, "deployment.pending.json"), pending);
      writeFileSync(join(created.stateDirectory, "deployment.json"), receipt);
      state.services.push({ name: "prior-service", state: "running" });
      writeFileSync(join(created.releaseDirectory, "node_modules/@bb/plugin-sdk/extra.js"), "unmanifested\n");
      await expect(runFixture(created, adapter)).rejects.toThrow("release runtime closure file set does not match its imports");
      expect(existsSync(marker)).toBe(false);
      expect(state).toMatchObject({ root: created.priorRoot, status: "running", services: [{ name: "prior-service", state: "running" }], bound: false, rollbackCalls: 0 });
      expect(readFileSync(join(created.stateDirectory, "deployment.pending.json"))).toEqual(pending);
      expect(readFileSync(join(created.stateDirectory, "deployment.json"))).toEqual(receipt);
      expect(existsSync(join(created.stateDirectory, "activation.lock"))).toBe(false);
    } finally { cleanup(created.root); rmSync(markerRoot, { recursive: true, force: true }); }
  });

  it("leaves prior state exact when the staged schema import fails", async () => {
    const created = fixture(undefined, true);
    const { adapter, state } = fakeAdapter(created.priorRoot);
    const pending = Buffer.from("prior pending marker\n");
    const receipt = Buffer.from('{"state":"active","releaseDigest":"prior"}\n');
    try {
      mkdirSync(created.stateDirectory);
      writeFileSync(join(created.stateDirectory, "deployment.pending.json"), pending);
      writeFileSync(join(created.stateDirectory, "deployment.json"), receipt);
      state.services.push({ name: "prior-service", state: "running" });
      await expect(runFixture(created, adapter)).rejects.toThrow("schema import failed");
      expect(state).toMatchObject({ root: created.priorRoot, status: "running", services: [{ name: "prior-service", state: "running" }], bound: false, rollbackCalls: 0 });
      expect(readFileSync(join(created.stateDirectory, "deployment.pending.json"))).toEqual(pending);
      expect(readFileSync(join(created.stateDirectory, "deployment.json"))).toEqual(receipt);
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
    const { adapter, state } = fakeAdapter(created.priorRoot, { residentGeneration: "prior" });
    try {
      await expect(runFixture(created, adapter)).rejects.toThrow("resident server generation mismatch");
      expect(state.root).toBe(created.priorRoot);
      expect(state.commands).toEqual(["reload"]);
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
    const { adapter, state } = fakeAdapter(created.priorRoot, { residentGeneration: "prior" });
    try {
      await expect(runFixture(created, adapter)).rejects.toThrow("resident server generation mismatch");
      expect(state.commands).toEqual(["reload"]);
    } finally { cleanup(created.root); }
  });

  it("fails loudly when rollback is skipped after failed health", async () => {
    const created = fixture();
    const { adapter, state } = fakeAdapter(created.priorRoot, {
      bind: (current) => { current.status = "degraded"; },
      reloadFailure: "rollback",
    });
    try {
      await expect(runFixture(created, adapter)).rejects.toThrow("rollback failed: bb-collab: prior reload failed");
      expect(JSON.parse(readFileSync(join(created.stateDirectory, "deployment.pending.json"), "utf8"))).toMatchObject({ state: "rollback_failed" });
    } finally { cleanup(created.root); }
  });

  it("refuses a schema-changing candidate without backup and quiescence evidence", async () => {
    const created = fixture();
    const { adapter, state } = fakeAdapter(created.priorRoot, { priorSchema: PRIOR_SCHEMA });
    try {
      await expect(runFixture(created, adapter)).rejects.toThrow("schema-changing activation requires one canonical migration id");
      expect(state.rollbackCalls).toBe(0);
      expect(existsSync(join(created.stateDirectory, "deployment.pending.json"))).toBe(false);
    } finally { cleanup(created.root); }
  });

  it("restores the prior path registration when bind mutates and then throws", async () => {
    const created = fixture();
    const { adapter, state } = fakeAdapter(created.priorRoot, { bind: () => { throw new Error("reload failed after registration moved"); } });
    try {
      await expect(runFixture(created, adapter)).rejects.toThrow("reload failed after registration moved");
      expect(state.root).toBe(created.priorRoot);
      expect(state.source.requested).toBe(`path:${created.priorRoot}`);
      expect(state.commands).toEqual(["reload", "reload"]);
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

  it("uses overlay plus reload and never path install", async () => {
    const created = fixture();
    const { adapter, state } = fakeAdapter(created.priorRoot);
    try {
      const result = await runFixture(created, adapter);
      expect(state.commands).toEqual(["reload"]);
      expect(result.receipt.bindings[0].priorSource.requested).toBe(`path:${created.priorRoot}`);
      expect(realpathSync(created.priorRoot)).toBe(realpathSync(result.receipt.artifactRoot));
      expect(statSync(result.receipt.artifactRoot).mode & 0o222).toBe(0);
    } finally { cleanup(created.root); }
  });

  it("issues only the exact reload argv through the real command adapter", () => {
    const commands: string[][] = [];
    const adapter = systemAdapter(PROJECT_ID, "/tmp/state", (_command: string, args: string[]) => { commands.push(args); return {}; });
    adapter.reload({ pluginId: "bb-collab" });
    expect(commands).toEqual([["plugin", "reload", "bb-collab", "--json"]]);
  });

  it("normalizes staged wrappers to the exact deterministic mtime contract", async () => {
    const created = fixture();
    const { adapter } = fakeAdapter(created.priorRoot);
    try {
      const result = await runFixture(created, adapter);
      expect(statSync(join(result.receipt.artifactRoot, "package.json")).mtimeMs).toBe(Date.UTC(2000, 0, 1));
      expect(statSync(join(result.receipt.artifactRoot, "dist/app.js")).mtimeMs).toBe(Date.UTC(2000, 0, 1) + 60_000);
    } finally { cleanup(created.root); }
  });

  it.each(["git", "npm"] as const)("preserves the journaled %s root overlay and rollback path", async (sourceKind) => {
    const created = fixture();
    const { adapter, state } = fakeAdapter(created.priorRoot, { sourceKind, dataDir: created.root, reloadFailure: "after-candidate" });
    try {
      await expect(runFixture(created, adapter)).rejects.toThrow("reload failed after candidate resident swap");
      expect(state.commands).toEqual(["reload", "reload"]);
      expect(lstatSync(created.priorRoot).isDirectory()).toBe(true);
    } finally { cleanup(created.root); }
  });

  it("reloads a server-only path wrapper without frontend metadata", async () => {
    const created = fixture(undefined, false, false);
    const { adapter, state } = fakeAdapter(created.priorRoot);
    try {
      await expect(runFixture(created, adapter)).resolves.toMatchObject({ outcome: "activated" });
      expect(state.commands).toEqual(["reload"]);
    } finally { cleanup(created.root); }
  });

  it("performs an exact-prior no-op when overlay throws before mutation", async () => {
    const created = fixture();
    const { adapter, state } = fakeAdapter(created.priorRoot, { beforeOverlay: () => { throw new Error("before mutation"); } });
    try {
      await expect(runFixture(created, adapter)).rejects.toThrow("before mutation");
      expect(state.commands).toEqual([]);
      expect(lstatSync(created.priorRoot).isDirectory()).toBe(true);
      expect(existsSync(join(created.stateDirectory, "deployment.pending.json"))).toBe(false);
    } finally { cleanup(created.root); }
  });

  it("restores a rename-only intermediate with no BB command", async () => {
    const created = fixture();
    const { adapter, state } = fakeAdapter(created.priorRoot, { afterRename: () => { throw new Error("after rename"); } });
    try {
      await expect(runFixture(created, adapter)).rejects.toThrow("after rename");
      expect(state.commands).toEqual([]);
      expect(lstatSync(created.priorRoot).isDirectory()).toBe(true);
    } finally { cleanup(created.root); }
  });

  it("restores an overlay while the prior resident remains with no BB command", async () => {
    const created = fixture();
    const { adapter, state } = fakeAdapter(created.priorRoot, { afterSymlink: () => { throw new Error("after symlink"); } });
    try {
      await expect(runFixture(created, adapter)).rejects.toThrow("after symlink");
      expect(state.commands).toEqual([]);
      expect(lstatSync(created.priorRoot).isDirectory()).toBe(true);
    } finally { cleanup(created.root); }
  });

  it("restores a second-generation owned symlink gap to its exact receipted target", async () => {
    const created = fixture();
    try {
      await runFixture(created, fakeAdapter(created.priorRoot).adapter);
      const priorTarget = readlinkSync(created.priorRoot);
      const receipt = readFileSync(join(created.stateDirectory, "deployment.json"));
      rewriteCandidateServer(created);
      const { adapter, state } = fakeAdapter(created.priorRoot, { afterRename: (_current, plan) => {
        expect(plan.priorSlotKind).toBe("owned-symlink");
        expect(readlinkSync(plan.registeredRoot)).toBe(priorTarget);
        unlinkSync(plan.registeredRoot);
        throw new Error("owned symlink candidate creation failed");
      } });
      await expect(runFixture(created, adapter)).rejects.toThrow("owned symlink candidate creation failed");
      expect(readlinkSync(created.priorRoot)).toBe(priorTarget);
      expect(state.commands).toEqual([]);
      expect(readFileSync(join(created.stateDirectory, "deployment.json"))).toEqual(receipt);
      expect(existsSync(join(created.stateDirectory, "deployment.pending.json"))).toBe(false);
    } finally { cleanup(created.root); }
  });

  it("reload failure before resident swap restores filesystem without a second reload", async () => {
    const created = fixture();
    const { adapter, state } = fakeAdapter(created.priorRoot, { reloadFailure: "before-resident" });
    try {
      await expect(runFixture(created, adapter)).rejects.toThrow("reload failed before resident swap");
      expect(state.commands).toEqual(["reload"]);
      expect(lstatSync(created.priorRoot).isDirectory()).toBe(true);
    } finally { cleanup(created.root); }
  });

  it.each(["candidate", "mixed"] as const)("restores filesystem then reloads prior once from %s authority", async (generation) => {
    const created = fixture();
    const { adapter, state } = fakeAdapter(created.priorRoot, { residentGeneration: generation, reloadFailure: "after-candidate" });
    try {
      await expect(runFixture(created, adapter)).rejects.toThrow("reload failed after candidate resident swap");
      expect(state.commands).toEqual(["reload", "reload"]);
      expect(state.generation).toBe("prior");
    } finally { cleanup(created.root); }
  });

  it("preserves rollback_failed evidence when registration drifts", async () => {
    const created = fixture();
    const { adapter, state } = fakeAdapter(created.priorRoot, { afterSymlink: (current) => { current.source = { requested: "path:/foreign", resolved: "path:/foreign" }; throw new Error("legacy drift"); } });
    try {
      await expect(runFixture(created, adapter)).rejects.toThrow("registration drift is not exactly recoverable");
      expect(state.commands).toEqual([]);
      expect(JSON.parse(readFileSync(join(created.stateDirectory, "deployment.pending.json"), "utf8"))).toMatchObject({ state: "rollback_failed" });
    } finally { cleanup(created.root); }
  });

  it("refuses candidate SDK mismatch before pending or mutation", async () => {
    const created = fixture();
    rewriteCandidateMeta(created, "0.4.21");
    const { adapter, state } = fakeAdapter(created.priorRoot);
    try {
      await expect(runFixture(created, adapter)).rejects.toThrow("candidate SDK does not match");
      expect(state.commands).toEqual([]);
      expect(existsSync(join(created.stateDirectory, "deployment.pending.json"))).toBe(false);
    } finally { cleanup(created.root); }
  });

  it("refuses prior SDK mismatch before pending or mutation", async () => {
    const created = fixture();
    writeFileSync(join(created.priorRoot, "dist/app.meta.json"), `${appMeta("0.4.21")}\n`);
    makeBuildFree(created.priorRoot);
    const { adapter, state } = fakeAdapter(created.priorRoot);
    try {
      await expect(runFixture(created, adapter)).rejects.toThrow("prior SDK does not match");
      expect(state.commands).toEqual([]);
    } finally { cleanup(created.root); }
  });

  it("refuses candidate BB metadata mismatch before pending or mutation", async () => {
    const created = fixture();
    rewriteCandidateMeta(created, TOOLCHAIN.pluginSdkVersion, "0.40.0");
    const { adapter, state } = fakeAdapter(created.priorRoot);
    try {
      await expect(runFixture(created, adapter)).rejects.toThrow("candidate BB version does not match");
      expect(state.commands).toEqual([]);
      expect(existsSync(join(created.stateDirectory, "deployment.pending.json"))).toBe(false);
    } finally { cleanup(created.root); }
  });

  it("refuses a prior app mtime that cannot guarantee build-free rollback", async () => {
    const created = fixture();
    const now = Date.now() / 1000;
    utimesSync(join(created.priorRoot, "package.json"), now, now);
    const { adapter, state } = fakeAdapter(created.priorRoot);
    try {
      await expect(runFixture(created, adapter)).rejects.toThrow("prior app mtime is not build-free");
      expect(state.commands).toEqual([]);
      expect(existsSync(join(created.stateDirectory, "deployment.pending.json"))).toBe(false);
    } finally { cleanup(created.root); }
  });

  it("refuses an exact BB version mismatch before staging authority", async () => {
    const created = fixture();
    const { adapter, state } = fakeAdapter(created.priorRoot, { hostVersion: "0.40.0" });
    try {
      await expect(runFixture(created, adapter)).rejects.toThrow("activation BB version 0.40.0 does not match pinned 0.39.0");
      expect(state.commands).toEqual([]);
    } finally { cleanup(created.root); }
  });

  it("refuses a rebuilt prior byte baseline", async () => {
    const created = fixture();
    const { adapter } = fakeAdapter(created.priorRoot, { afterSymlink: (_state, plan) => { writeFileSync(join(plan.retainedRoot, "dist/app.js"), "ambient rebuild\n"); throw new Error("after rebuild"); } });
    try {
      await expect(runFixture(created, adapter)).rejects.toThrow("prior authoritative bytes changed");
      expect(JSON.parse(readFileSync(join(created.stateDirectory, "deployment.pending.json"), "utf8"))).toMatchObject({ state: "rollback_failed" });
    } finally { cleanup(created.root); }
  });

  it("binds a real path-shaped SVG to candidate byte verification", async () => {
    const created = fixture();
    const branding = addPathBranding(created);
    const { adapter, state } = fakeAdapter(created.priorRoot, { settle: (current) => {
      const path = join(current.binding.resolvedRoot, branding.path);
      chmodSync(dirname(path), 0o755);
      chmodSync(path, 0o644);
      writeFileSync(path, `${branding.svg}\n<!-- drift -->\n`);
    } });
    try {
      await expect(runFixture(created, adapter)).rejects.toThrow(`deployed artifact digest mismatch: bb-collab/${branding.path}`);
      expect(state.binding.expectedFiles).toContainEqual({ path: branding.path, sha256: createHash("sha256").update(branding.svg).digest("hex") });
      expect(state.commands).toEqual(["reload", "reload"]);
    } finally { cleanup(created.root); }
  });

  it("binds a real path-shaped SVG to exact-prior rollback bytes", async () => {
    const created = fixture();
    const branding = addPathBranding(created);
    const { adapter } = fakeAdapter(created.priorRoot, { afterSymlink: (_current, plan) => {
      writeFileSync(join(plan.retainedRoot, branding.path), `${branding.svg}\n<!-- drift -->\n`);
      throw new Error("prior branding drift");
    } });
    try {
      await expect(runFixture(created, adapter)).rejects.toThrow("prior authoritative bytes changed during activation");
      expect(JSON.parse(readFileSync(join(created.stateDirectory, "deployment.pending.json"), "utf8"))).toMatchObject({ state: "rollback_failed" });
    } finally { cleanup(created.root); }
  });

  it("preserves evidence on concurrent receipt movement", async () => {
    const created = fixture();
    const { adapter } = fakeAdapter(created.priorRoot, { afterSymlink: () => { writeFileSync(join(created.stateDirectory, "deployment.json"), "{\"concurrent\":true}\n"); throw new Error("receipt moved"); } });
    try {
      await expect(runFixture(created, adapter)).rejects.toThrow("deployment receipt changed during activation");
      expect(JSON.parse(readFileSync(join(created.stateDirectory, "deployment.pending.json"), "utf8"))).toMatchObject({ state: "rollback_failed" });
    } finally { cleanup(created.root); }
  });

  it("refuses stale reused stage metadata instead of repairing it", async () => {
    const created = fixture();
    const first = fakeAdapter(created.priorRoot);
    try {
      const result = await runFixture(created, first.adapter);
      chmodSync(result.receipt.artifactRoot, 0o755);
      chmodSync(join(result.receipt.artifactRoot, "package.json"), 0o644);
      const now = Date.now() / 1000;
      utimesSync(join(result.receipt.artifactRoot, "package.json"), now, now);
      await expect(runFixture(created, first.adapter)).rejects.toThrow("staged app mtime contract failed");
    } finally { cleanup(created.root); }
  });

  it("does not reuse the unversioned pre-correction stage root", async () => {
    const created = fixture();
    const manifest = JSON.parse(readFileSync(join(created.releaseDirectory, "release-manifest.json"), "utf8"));
    const old = join(created.stateDirectory, "releases", manifest.releaseDigest);
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "sentinel"), "old\n");
    const { adapter } = fakeAdapter(created.priorRoot);
    try {
      const result = await runFixture(created, adapter);
      expect(result.receipt.artifactRoot).toContain("/releases/path-load-v2/");
      expect(readFileSync(join(old, "sentinel"), "utf8")).toBe("old\n");
    } finally { cleanup(created.root); }
  });

  it("refuses arbitrary symlink registrations", async () => {
    const created = fixture();
    const backing = `${created.priorRoot}-backing`;
    execFileSync("mv", [created.priorRoot, backing]);
    symlinkSync(backing, created.priorRoot);
    const { adapter } = fakeAdapter(created.priorRoot);
    try { await expect(runFixture(created, adapter)).rejects.toThrow("arbitrary or unreceipted symlink"); }
    finally { unlinkSync(created.priorRoot); cleanup(backing); cleanup(created.root); }
  });

  it("refuses overlapping registered roots before planning mutation", () => {
    expect(() => assertNonOverlappingRoots([
      { pluginId: "parent", registeredRoot: "/tmp/plugins" },
      { pluginId: "child", registeredRoot: "/tmp/plugins/child" },
    ])).toThrow("overlapping registered roots are not supported: parent/child");
  });

  it("refuses path host artifacts before pending", async () => {
    const created = fixture();
    const priorManifest = JSON.parse(readFileSync(join(created.priorRoot, "package.json"), "utf8"));
    priorManifest.bb.host = "./dist/host.js";
    writeFileSync(join(created.priorRoot, "package.json"), JSON.stringify(priorManifest));
    writeFileSync(join(created.priorRoot, "dist/host.js"), "host\n");
    makeBuildFree(created.priorRoot);
    const { adapter } = fakeAdapter(created.priorRoot);
    try { await expect(runFixture(created, adapter)).rejects.toThrow("prior path host artifact"); }
    finally { cleanup(created.root); }
  });
});
