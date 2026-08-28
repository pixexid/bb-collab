import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, closeSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson, verifyRelease, verifyRuntimeClosure } from "./release-artifact.mjs";

const RECEIPT_VERSION = 1;
const SETTLE_MS = 15_000;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const slash = (value) => value.split(sep).join("/");
const pluginId = (name) => name.replace(/^@[^/]+\//u, "").replace(/^bb-plugin-/u, "");
const sourceKind = (source) => /^(path|git|npm):/u.exec(source)?.[1] ?? "unknown";
const identityCommand = (id) => id === "bb-collab" ? "collab" : id === "exec-tracking" ? "silent-wake" : id;
const defaultStateDirectory = (dataDir) => join(resolve(dataDir), "deployments", "bb-collab");

function jsonCommand(command, args, options = {}) {
  return JSON.parse(execFileSync(command, args, { encoding: "utf8", ...options }));
}

function atomicWrite(path, value) {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${canonicalJson(value)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function readReceipt(path) {
  if (!existsSync(path)) return { bytes: null, value: null };
  const bytes = readFileSync(path);
  return { bytes, value: JSON.parse(bytes.toString("utf8")) };
}

function assertAbsoluteDirectory(path, label) {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  if (existsSync(path) && !lstatSync(path).isDirectory()) throw new Error(`${label} is not a directory`);
}

function sourceManifest(sourceRoot, packageRoot) {
  const path = join(sourceRoot, packageRoot, "package.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (typeof manifest.name !== "string" || typeof manifest.bb !== "object" || manifest.bb === null) {
    throw new Error(`invalid plugin package manifest: ${slash(relative(sourceRoot, path))}`);
  }
  return manifest;
}

function expectedFiles(manifest, packageRoot) {
  const prefix = packageRoot === "." ? "" : `${packageRoot}/`;
  return manifest.files
    .filter(({ path }) => path.startsWith(`${prefix}dist/`))
    .map(({ path, sha256: digest }) => ({ path: path.slice(prefix.length), sha256: digest }));
}

function wrapperManifest(manifest, files) {
  const bb = { ...manifest.bb, skills: [] };
  if (files.some(({ path }) => path === "dist/server.js")) bb.server = "./dist/server.js";
  else delete bb.server;
  if (files.some(({ path }) => path === "dist/app.js")) bb.app = "./dist/app.js";
  else delete bb.app;
  if (files.some(({ path }) => path === "dist/host.js")) bb.host = "./dist/host.js";
  else delete bb.host;
  return {
    name: manifest.name,
    version: manifest.version,
    ...(manifest.description === undefined ? {} : { description: manifest.description }),
    type: "module",
    ...(manifest.engines === undefined ? {} : { engines: manifest.engines }),
    bb,
  };
}

function copyBrandingAssets(sourceRoot, packageRoot, wrapperRoot, branding) {
  for (const value of Object.values(branding ?? {}).flatMap((value) => typeof value === "object" && value !== null ? Object.values(value) : [value])) {
    if (typeof value !== "string" || !value.startsWith("./")) continue;
    const source = resolve(sourceRoot, packageRoot, value);
    const relativeAsset = value.slice(2);
    const target = resolve(wrapperRoot, relativeAsset);
    if (!source.startsWith(`${resolve(sourceRoot, packageRoot)}${sep}`) || !target.startsWith(`${resolve(wrapperRoot)}${sep}`)) throw new Error("branding asset escapes its package root");
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target);
  }
}

function makeReadOnly(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) makeReadOnly(child);
    else chmodSync(child, 0o444);
  }
  chmodSync(path, 0o555);
}

function makeWritable(path) {
  if (!existsSync(path)) return;
  chmodSync(path, lstatSync(path).isDirectory() ? 0o700 : 0o600);
  if (lstatSync(path).isDirectory()) for (const entry of readdirSync(path)) makeWritable(join(path, entry));
}

function verifyBindingFiles(binding) {
  for (const file of binding.expectedFiles) {
    const path = join(binding.resolvedRoot, file.path);
    if (!existsSync(path) || sha256(readFileSync(path)) !== file.sha256) throw new Error(`deployed artifact digest mismatch: ${binding.pluginId}/${file.path}`);
  }
}

async function stageRelease({ releaseDirectory, sourceRoot, stateDirectory, manifest }) {
  const releases = join(stateDirectory, "releases");
  const artifactRoot = join(releases, manifest.releaseDigest);
  const temporary = `${artifactRoot}.tmp-${process.pid}`;
  if (existsSync(artifactRoot)) {
    verifyRuntimeClosure(artifactRoot, manifest, true);
    return artifactRoot;
  }
  mkdirSync(releases, { recursive: true, mode: 0o700 });
  mkdirSync(temporary, { recursive: false, mode: 0o700 });
  try {
    for (const distRoot of manifest.artifactRoots) {
      const packageRoot = dirname(distRoot) === "." ? "." : dirname(distRoot);
      const source = sourceManifest(sourceRoot, packageRoot);
      const files = expectedFiles(manifest, packageRoot);
      const wrapper = join(temporary, packageRoot);
      mkdirSync(wrapper, { recursive: true });
      cpSync(join(releaseDirectory, distRoot), join(wrapper, "dist"), { recursive: true });
      const stagedManifest = wrapperManifest(source, files);
      copyBrandingAssets(sourceRoot, packageRoot, wrapper, stagedManifest.bb.branding);
      writeFileSync(join(wrapper, "package.json"), `${canonicalJson(stagedManifest)}\n`);
    }
    cpSync(join(releaseDirectory, "node_modules"), join(temporary, "node_modules"), { recursive: true });
    makeReadOnly(temporary);
    verifyRuntimeClosure(temporary, manifest, true);
    renameSync(temporary, artifactRoot);
  } catch (error) {
    makeWritable(temporary);
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
  return artifactRoot;
}

function systemAdapter(projectId, stateDirectory) {
  const status = () => jsonCommand("bb", ["status", "--json"]);
  const list = () => jsonCommand("bb", ["plugin", "list", "--json"]).plugins;
  const source = (id) => jsonCommand("bb", ["plugin", "source", id, "--json"]);
  const doctor = () => jsonCommand("bb", ["collab", "doctor", "--project", projectId]);
  const installPath = (path) => jsonCommand("bb", ["plugin", "install", "--yes", "--json", `path:${path}`]);
  const reload = (id) => jsonCommand("bb", ["plugin", "reload", id, "--json"]);
  const resident = (binding) => jsonCommand("bb", [binding.identityCommand, "activation-identity", "--json"]);
  return {
    status, list, source, doctor, resident,
    settle: () => new Promise((resolvePromise) => setTimeout(resolvePromise, SETTLE_MS)),
    bind(binding, transactionId) {
      if (binding.sourceKind === "path") {
        installPath(binding.resolvedRoot);
        return { adapter: "path-install" };
      }
      const dataDir = resolve(status().dataDir);
      const registeredRoot = resolve(binding.registeredRoot);
      if (!registeredRoot.startsWith(`${dataDir}${sep}`)) throw new Error(`${binding.pluginId} managed root is outside the BB data directory`);
      const retainedRoot = join(stateDirectory, "rollback", transactionId, binding.pluginId);
      mkdirSync(dirname(retainedRoot), { recursive: true, mode: 0o700 });
      if (existsSync(retainedRoot) || lstatSync(registeredRoot).isSymbolicLink()) throw new Error(`${binding.pluginId} managed root is not safely bindable`);
      renameSync(registeredRoot, retainedRoot);
      symlinkSync(binding.resolvedRoot, registeredRoot);
      try { reload(binding.pluginId); }
      catch (error) {
        unlinkSync(registeredRoot);
        renameSync(retainedRoot, registeredRoot);
        try { reload(binding.pluginId); } catch (rollbackError) { throw new Error(`${error.message}; immediate rollback failed: ${rollbackError.message}`); }
        throw error;
      }
      return { adapter: "managed-root-symlink", retainedRoot };
    },
    rollback(binding, result) {
      if (binding.sourceKind === "path") installPath(binding.priorRoot);
      else {
        if (lstatSync(binding.registeredRoot).isSymbolicLink()) unlinkSync(binding.registeredRoot);
        renameSync(result.retainedRoot, binding.registeredRoot);
        reload(binding.pluginId);
      }
    },
  };
}

function schemaCutoverEvidence(doctor, migrationId, projectId, prior, candidate, liveSchema = prior) {
  if (!migrationId || !/^[a-z0-9][a-z0-9-]{2,127}$/u.test(migrationId)) throw new Error("schema-changing activation requires one canonical migration id");
  const evidence = doctor?.evidence;
  const governor = evidence?.governorshipHead;
  const migration = evidence?.activeMigrationRun;
  if (doctor.outcome !== "OK" || evidence?.project?.id !== projectId || evidence?.schema?.digest !== liveSchema
    || governor?.project_id !== projectId || governor.state !== "frozen" || !/^[0-9a-f]{48}$/u.test(governor.fence_token ?? "")
    || migration?.migration_id !== migrationId || migration.state !== "exported" || migration.target_runtime_id !== "bb-collab"
    || migration.retentionExpired !== false || migration.unresolvedProof?.length !== 0
    || !/^[0-9a-f]{64}$/u.test(migration.quiescence_digest ?? "") || !/^[0-9a-f]{64}$/u.test(migration.source_export_digest ?? "")
    || evidence.capacity?.activeWriterCount !== 0 || evidence.capacity?.blindWriterLaneIds?.length !== 0) {
    throw new Error("canonical schema-cutover evidence is unavailable or stale");
  }
  const bound = { projectId, priorSchemaFingerprint: prior, candidateSchemaFingerprint: candidate, governor, migration };
  return { digest: sha256(canonicalJson(bound)), fence: canonicalJson({ governor, migration }) };
}

async function candidateSchemaFingerprint(artifactRoot) {
  const module = await import(`${pathToFileURL(join(artifactRoot, "dist/server.js")).href}?schema=${Date.now()}`);
  if (!/^[0-9a-f]{64}$/u.test(module.schemaDigest ?? "")) throw new Error("candidate server does not export its canonical schema fingerprint");
  return module.schemaDigest;
}

function classifyBindings({ manifest, sourceRoot, artifactRoot, installed, sources }) {
  const installedById = new Map(installed.map((entry) => [entry.id, entry]));
  return manifest.artifactRoots.map((distRoot) => {
    const packageRoot = dirname(distRoot) === "." ? "." : dirname(distRoot);
    const packageManifest = sourceManifest(sourceRoot, packageRoot);
    const id = pluginId(packageManifest.name);
    const current = installedById.get(id);
    const currentSource = sources.get(id);
    if (!current || !currentSource) throw new Error(`release target is not installed: ${id}`);
    const kind = sourceKind(currentSource.requested);
    if (!new Set(["path", "git", "npm"]).has(kind)) throw new Error(`unclassified plugin source: ${id}`);
    const priorRoot = realpathSync(current.rootDir);
    const resolvedRoot = resolve(artifactRoot, packageRoot);
    const files = expectedFiles(manifest, packageRoot);
    const stagedManifest = JSON.parse(readFileSync(join(resolvedRoot, "package.json"), "utf8"));
    if (canonicalJson(stagedManifest) !== canonicalJson(wrapperManifest(packageManifest, files))) throw new Error(`staged binding manifest mismatch: ${id}`);
    const serverEntry = files.some(({ path }) => path === "dist/server.js") ? realpathSync(join(resolvedRoot, "dist/server.js")) : null;
    return {
      pluginId: id, packageRoot, sourceKind: kind, identityCommand: identityCommand(id), registeredRoot: resolve(current.rootDir), priorRoot, resolvedRoot,
      serverEntry, frontendArtifacts: files.filter(({ path }) => path === "dist/app.js" || path === "dist/app.css").map(({ path }) => realpathSync(join(resolvedRoot, path))),
      expectedFiles: files, priorSource: currentSource, priorStatus: current,
    };
  }).sort((a, b) => (a.pluginId === "bb-collab" ? 1 : b.pluginId === "bb-collab" ? -1 : a.pluginId.localeCompare(b.pluginId)));
}

function expectedAppHash(binding) {
  const paths = ["dist/app.js", "dist/app.css", "dist/app.meta.json"];
  const files = new Map(binding.expectedFiles.map((file) => [file.path, file]));
  if (!files.has("dist/app.js")) return null;
  const hash = createHash("sha256").update(readFileSync(join(binding.resolvedRoot, "dist/app.js")));
  if (files.has("dist/app.css")) hash.update(readFileSync(join(binding.resolvedRoot, "dist/app.css")));
  hash.update(readFileSync(join(binding.resolvedRoot, "dist/app.meta.json")));
  return hash.digest("hex").slice(0, 16);
}

function proveLoaded(bindings, installed, sources, residents) {
  const installedById = new Map(installed.map((entry) => [entry.id, entry]));
  for (const binding of bindings) {
    const current = installedById.get(binding.pluginId);
    const currentSource = sources.get(binding.pluginId);
    if (!current || current.status !== "running" || current.services?.some(({ state }) => state !== "running")) throw new Error(`plugin health failed: ${binding.pluginId}`);
    const expectsApp = binding.frontendArtifacts.some((path) => path.endsWith("/app.js"));
    if (realpathSync(current.rootDir) !== realpathSync(binding.resolvedRoot)) throw new Error(`loaded generation is not bound to candidate: ${binding.pluginId}`);
    if (Boolean(current.app?.hasApp) !== expectsApp || (expectsApp && (current.app?.bundle?.compatible !== true || current.app.bundle.hash !== expectedAppHash(binding)))) throw new Error(`resident frontend generation mismatch: ${binding.pluginId}`);
    if (binding.sourceKind === "path" && (currentSource.requested !== `path:${binding.resolvedRoot}` || currentSource.resolved !== `path:${binding.resolvedRoot}`)) throw new Error(`registered root remains on prior release: ${binding.pluginId}`);
    const packageManifest = JSON.parse(readFileSync(join(current.rootDir, "package.json"), "utf8"));
    const actualServer = packageManifest.bb?.server ? realpathSync(join(current.rootDir, packageManifest.bb.server)) : null;
    if (actualServer !== binding.serverEntry || actualServer?.endsWith("server.ts")) throw new Error(`server entry is not candidate dist/server.js: ${binding.pluginId}`);
    const resident = residents.get(binding.pluginId);
    const expectedServer = binding.expectedFiles.find(({ path }) => path === "dist/server.js")?.sha256 ?? null;
    if (!resident || resident.pluginId !== binding.pluginId || resident.serverEntry !== binding.serverEntry || resident.serverSha256 !== expectedServer) throw new Error(`resident server generation mismatch: ${binding.pluginId}`);
    const expectedServices = (current.services ?? []).map(({ name }) => name).sort();
    const residentServices = (resident.services ?? []).map(({ name, serverSha256 }) => ({ name, serverSha256 }));
    if (residentServices.length !== expectedServices.length || residentServices.some(({ name, serverSha256 }, index) => name !== expectedServices[index] || serverSha256 !== expectedServer)) throw new Error(`old or orphaned service generation remains authoritative: ${binding.pluginId}`);
    verifyBindingFiles(binding);
  }
}

function proveRollback(changes, installed, sources) {
  const installedById = new Map(installed.map((entry) => [entry.id, entry]));
  for (const { binding } of changes) {
    const current = installedById.get(binding.pluginId);
    const currentSource = sources.get(binding.pluginId);
    if (!current || current.status !== binding.priorStatus.status || realpathSync(current.rootDir) !== binding.priorRoot) throw new Error(`prior loaded generation was not restored: ${binding.pluginId}`);
    if (binding.sourceKind === "path" && (currentSource.requested !== binding.priorSource.requested || currentSource.resolved !== binding.priorSource.resolved)) throw new Error(`prior registration was not restored: ${binding.pluginId}`);
  }
}

function verifyActiveReceipt({ stateDirectory, adapter }) {
  const receipt = readReceipt(join(stateDirectory, "deployment.json")).value;
  if (receipt?.version !== RECEIPT_VERSION || receipt.state !== "active" || !/^proj_[a-z0-9]+$/u.test(receipt.projectId ?? "")) throw new Error("active deployment receipt is unavailable");
  const runtime = adapter ?? systemAdapter(receipt.projectId, stateDirectory);
  const ids = receipt.bindings.map(({ pluginId: id }) => id);
  proveLoaded(receipt.bindings, runtime.list(), new Map(ids.map((id) => [id, runtime.source(id)])), new Map(receipt.bindings.map((binding) => [binding.pluginId, runtime.resident(binding)])));
  const doctor = runtime.doctor();
  if (doctor.outcome !== "OK" || doctor.evidence?.schema?.digest !== receipt.schemaFingerprint) throw new Error("active receipt schema fingerprint is not loaded");
  return receipt;
}

async function activateRelease(options) {
  const { releaseDirectory, sourceRoot, stateDirectory, projectId } = options;
  assertAbsoluteDirectory(releaseDirectory, "release directory");
  assertAbsoluteDirectory(sourceRoot, "source root");
  assertAbsoluteDirectory(stateDirectory, "state directory");
  if (!/^proj_[a-z0-9]+$/u.test(projectId)) throw new Error("project id is invalid");
  const adapter = options.adapter ?? systemAdapter(projectId, stateDirectory);
  const initialHostStatus = adapter.status();
  if (!options.adapter && resolve(stateDirectory) !== defaultStateDirectory(initialHostStatus.dataDir)) throw new Error("deployment state directory is not the canonical BB host-local root");
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const lockPath = join(stateDirectory, "activation.lock");
  let lock;
  try { lock = openSync(lockPath, "wx", 0o600); } catch { throw new Error("another activation writer holds the host-local lock"); }
  const receiptPath = join(stateDirectory, "deployment.json");
  const pendingPath = join(stateDirectory, "deployment.pending.json");
  const priorReceipt = readReceipt(receiptPath);
  const transactionId = `${Date.now()}-${process.pid}`;
  const changed = [];
  let ownsPending = false;
  try {
    const manifest = verifyRelease(releaseDirectory, join(releaseDirectory, "release-manifest.json"), sourceRoot);
    if (manifest.loadAuthority !== "inactive") throw new Error("activation requires an inactive v2 release candidate");
    const hostStatus = initialHostStatus;
    if (hostStatus.project?.id !== projectId && hostStatus.projectId !== projectId) throw new Error("activation project does not match the current BB project");
    const artifactRoot = await stageRelease({ releaseDirectory, sourceRoot, stateDirectory, manifest });
    const candidateSchema = await candidateSchemaFingerprint(artifactRoot);
    verifyRuntimeClosure(artifactRoot, manifest, true);
    const doctorBefore = adapter.doctor();
    if (doctorBefore.outcome !== "OK" || !/^[0-9a-f]{64}$/u.test(doctorBefore.evidence?.schema?.digest ?? "")) throw new Error("current canonical schema fingerprint is unavailable");
    const priorSchema = doctorBefore.evidence.schema.digest;
    if (priorReceipt.value?.state === "active" && priorReceipt.value.releaseDigest === manifest.releaseDigest) {
      const bindings = priorReceipt.value.bindings;
      const ids = bindings.map(({ pluginId }) => pluginId);
      proveLoaded(bindings, adapter.list(), new Map(ids.map((id) => [id, adapter.source(id)])), new Map(bindings.map((binding) => [binding.pluginId, adapter.resident(binding)])));
      if (doctorBefore.evidence.schema.digest !== priorReceipt.value.schemaFingerprint) throw new Error("active receipt schema fingerprint is not loaded");
      return { outcome: "already_active", receipt: priorReceipt.value };
    }
    const schemaCutover = priorSchema === candidateSchema ? null : schemaCutoverEvidence(doctorBefore, options.schemaCutoverId, projectId, priorSchema, candidateSchema);
    const schemaEvidenceDigest = schemaCutover?.digest ?? null;
    const installed = adapter.list();
    const ids = manifest.artifactRoots.map((distRoot) => pluginId(sourceManifest(sourceRoot, dirname(distRoot) === "." ? "." : dirname(distRoot)).name));
    if (new Set(ids).size !== ids.length) throw new Error("release artifact roots do not map to unique installed plugin ids");
    const sources = new Map(ids.map((id) => [id, adapter.source(id)]));
    const bindings = classifyBindings({ manifest, sourceRoot, artifactRoot, installed, sources });
    for (const binding of bindings) verifyBindingFiles(binding);
    const pending = {
      version: RECEIPT_VERSION, state: "activating", transactionId, projectId, sourceCommit: manifest.sourceCommit,
      releaseDigest: manifest.releaseDigest, artifactRoot, schemaFingerprint: candidateSchema, priorSchemaFingerprint: priorSchema,
      schemaEvidenceDigest, previousReceiptDigest: priorReceipt.bytes ? sha256(priorReceipt.bytes) : null,
      bindings: bindings.map(({ priorStatus, ...binding }) => ({ ...binding, priorStatus: { rootDir: priorStatus.rootDir, status: priorStatus.status, services: priorStatus.services } })),
    };
    atomicWrite(pendingPath, pending);
    ownsPending = true;
    for (const binding of bindings) {
      const currentSource = adapter.source(binding.pluginId);
      const current = adapter.list().find(({ id }) => id === binding.pluginId);
      if (canonicalJson(currentSource) !== canonicalJson(binding.priorSource) || !current || realpathSync(current.rootDir) !== binding.priorRoot) throw new Error(`activation fence moved before binding: ${binding.pluginId}`);
      if (schemaCutover && schemaCutoverEvidence(adapter.doctor(), options.schemaCutoverId, projectId, priorSchema, candidateSchema).fence !== schemaCutover.fence) throw new Error("schema-cutover fence moved before binding");
      const change = { binding, result: null };
      if (binding.sourceKind === "path") changed.push(change);
      change.result = adapter.bind(binding, transactionId);
      if (binding.sourceKind !== "path") changed.push(change);
    }
    await adapter.settle();
    const afterSources = new Map(ids.map((id) => [id, adapter.source(id)]));
    proveLoaded(bindings, adapter.list(), afterSources, new Map(bindings.map((binding) => [binding.pluginId, adapter.resident(binding)])));
    const doctorAfter = adapter.doctor();
    if (doctorAfter.outcome !== "OK" || doctorAfter.evidence?.schema?.digest !== candidateSchema) throw new Error("loaded canonical schema fingerprint does not identify the candidate generation");
    if (schemaCutover && schemaCutoverEvidence(doctorAfter, options.schemaCutoverId, projectId, priorSchema, candidateSchema, candidateSchema).fence !== schemaCutover.fence) throw new Error("schema-cutover fence moved after binding");
    if (priorReceipt.bytes === null ? existsSync(receiptPath) : !readReceipt(receiptPath).bytes?.equals(priorReceipt.bytes)) throw new Error("deployment receipt changed concurrently");
    const receipt = { ...pending, state: "active", activatedAt: Date.now() };
    atomicWrite(receiptPath, receipt);
    rmSync(pendingPath, { force: true });
    return { outcome: "activated", receipt };
  } catch (error) {
    const rollbackErrors = [];
    const rollbackOrder = [...changed].reverse();
    for (const change of rollbackOrder) {
      try { adapter.rollback(change.binding, change.result); } catch (rollbackError) { rollbackErrors.push(`${change.binding.pluginId}: ${rollbackError.message}`); }
    }
    if (changed.length && rollbackErrors.length === 0) {
      try {
        const ids = changed.map(({ binding }) => binding.pluginId);
        proveRollback(changed, adapter.list(), new Map(ids.map((id) => [id, adapter.source(id)])));
      } catch (rollbackError) { rollbackErrors.push(rollbackError.message); }
    }
    if (ownsPending) rmSync(pendingPath, { force: true });
    if (rollbackErrors.length) throw new Error(`${error.message}; rollback failed: ${rollbackErrors.join("; ")}`);
    throw error;
  } finally {
    if (lock !== undefined) closeSync(lock);
    rmSync(lockPath, { force: true });
  }
}

function parseArgs(argv) {
  const value = (name) => { const index = argv.indexOf(name); return index < 0 ? undefined : argv[index + 1]; };
  if (argv[0] !== "activate") throw new Error("usage: activate-release.mjs activate --release <absolute-directory> --project <project-id> [--schema-cutover <canonical-migration-id>]");
  const projectId = value("--project");
  const status = jsonCommand("bb", ["status", "--json"]);
  return {
    releaseDirectory: resolve(value("--release") ?? ""), sourceRoot: process.cwd(), stateDirectory: defaultStateDirectory(status.dataDir),
    projectId, schemaCutoverId: value("--schema-cutover"),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  activateRelease(parseArgs(process.argv.slice(2))).then((result) => console.log(canonicalJson(result))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}

export { activateRelease, classifyBindings, defaultStateDirectory, proveLoaded, proveRollback, verifyActiveReceipt };
