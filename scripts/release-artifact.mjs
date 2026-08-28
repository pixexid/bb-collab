import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { builtinModules, createRequire } from "node:module";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const releaseDirectory = join(root, "release");
const manifestName = "release-manifest.json";
const pinnedToolchain = Object.freeze({
  bbPackage: "bb-app@0.39.0",
  bbVersion: "0.39.0",
  nodeVersion: "v22.23.1",
  pluginSdkVersion: "0.4.8",
});

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function workspacePatterns(directory) {
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  const workspaces = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages ?? [];
  return workspaces.map((pattern) => {
    if (pattern !== "plugins/*" && pattern !== "packages/*") throw new Error(`unsupported artifact workspace: ${pattern}`);
    return pattern.slice(0, -2);
  });
}

function packageRoots(directory = root) {
  return [directory, ...workspacePatterns(directory).flatMap((parent) => {
    const parentPath = join(directory, parent);
    if (!existsSync(parentPath)) return [];
    return readdirSync(parentPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(parentPath, entry.name, "package.json")))
      .map((entry) => join(parentPath, entry.name));
  })].filter((packageRoot) => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    return Boolean(manifest.scripts?.build);
  }).sort();
}

function declaredArtifactRoots(directory = root) {
  return packageRoots(directory).map((packageRoot) => relative(directory, join(packageRoot, "dist")).split(sep).join("/"));
}

function observedArtifactRoots(directory) {
  const roots = [];
  const add = (path, relativePath) => {
    if (!existsSync(path)) return;
    if (!lstatSync(path).isDirectory()) throw new Error(`artifact root is not a directory: ${relativePath}`);
    roots.push(relativePath);
  };
  add(join(directory, "dist"), "dist");
  for (const parent of ["plugins", "packages"]) {
    const parentPath = join(directory, parent);
    if (!existsSync(parentPath)) continue;
    for (const entry of readdirSync(parentPath, { withFileTypes: true })) {
      if (entry.isDirectory()) add(join(parentPath, entry.name, "dist"), `${parent}/${entry.name}/dist`);
    }
  }
  return roots.sort();
}

function assertArtifactRoots(expected, actual) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const extra = actual.find((path) => !expectedSet.has(path));
  if (extra) throw new Error(`undeclared artifact root: ${extra}`);
  const missing = expected.find((path) => !actualSet.has(path));
  if (missing) throw new Error(`missing artifact root: ${missing}`);
}

function filesBelow(directory, base = directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error(`release closure contains a mutable or unsupported entry: ${slash(relative(base, path))}`);
    return entry.isDirectory() ? filesBelow(path, base) : [slash(relative(base, path))];
  });
}

const slash = (value) => value.split(sep).join("/");
const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

function importSpecifiers(path) {
  if (!/\.(?:c|m)?js$/u.test(path)) return [];
  const source = readFileSync(path, "utf8");
  const specifiers = [];
  const patterns = [
    /\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/gu,
    /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/gu,
  ];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  return [...new Set(specifiers)].filter((specifier) => !builtins.has(specifier)).sort();
}

function packageManifest(path, closureRoot) {
  for (let directory = dirname(path); directory.startsWith(`${closureRoot}${sep}`); directory = dirname(directory)) {
    const manifest = join(directory, "package.json");
    if (existsSync(manifest)) return manifest;
  }
  throw new Error(`runtime closure file has no candidate-owned package manifest: ${slash(relative(closureRoot, path))}`);
}

function runtimeEntries(directory, artifactRoots) {
  return artifactRoots.flatMap((artifactRoot) => {
    const entry = join(directory, artifactRoot, "server.js");
    return existsSync(entry) ? [{ entry: `${artifactRoot}/server.js`, specifiers: importSpecifiers(entry).filter((specifier) => !specifier.startsWith(".")) }] : [];
  });
}

function requiredClosureFiles(directory, artifactRoots) {
  const directoryRoot = realpathSync(directory);
  const closurePath = join(directoryRoot, "node_modules");
  if (existsSync(closurePath) && lstatSync(closurePath).isSymbolicLink()) throw new Error("release closure contains a mutable or unsupported entry: node_modules");
  const closureRoot = existsSync(closurePath) ? realpathSync(closurePath) : closurePath;
  const entries = runtimeEntries(directory, artifactRoots);
  const required = new Set();
  const visited = new Set();
  const queue = entries.flatMap(({ entry, specifiers }) => specifiers.map((specifier) => ({ importer: join(directory, entry), specifier })));
  while (queue.length) {
    const { importer, specifier } = queue.shift();
    let resolved;
    try { resolved = createRequire(importer).resolve(specifier); }
    catch { throw new Error(`runtime external is missing from candidate closure: ${specifier} (${slash(relative(directory, importer))})`); }
    const real = realpathSync(resolved);
    if (!real.startsWith(`${closureRoot}${sep}`)) throw new Error(`runtime external resolved outside candidate closure: ${specifier} (${slash(relative(directory, importer))})`);
    if (visited.has(real)) continue;
    visited.add(real);
    required.add(slash(relative(directoryRoot, real)));
    required.add(slash(relative(directoryRoot, packageManifest(real, closureRoot))));
    for (const nested of importSpecifiers(real)) queue.push({ importer: real, specifier: nested });
  }
  return { entries, files: [...required].sort() };
}

function closureFiles(directory) {
  return filesBelow(join(directory, "node_modules")).map((path) => `node_modules/${path}`).sort();
}

function assertRuntimeClosure(directory, artifactRoots, expectedEntries) {
  const required = requiredClosureFiles(directory, artifactRoots);
  if (expectedEntries && canonicalJson(required.entries) !== canonicalJson(expectedEntries)) throw new Error("release runtime external inventory does not match server entries");
  if (canonicalJson(closureFiles(directory)) !== canonicalJson(required.files)) throw new Error("release runtime closure file set does not match its imports");
  return required;
}

function assertReadOnlyTree(directory, rootDirectory = directory) {
  if (!existsSync(directory)) return;
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || (stat.mode & 0o222) !== 0) throw new Error(`staged runtime closure is mutable: ${slash(relative(rootDirectory, directory)) || "."}`);
  if (!stat.isDirectory()) return;
  for (const entry of readdirSync(directory)) assertReadOnlyTree(join(directory, entry), rootDirectory);
}

function verifyRuntimeClosure(directory, manifest, requireReadOnly = false) {
  assertManifestShape(manifest);
  const runtimeClosure = assertRuntimeClosure(directory, manifest.artifactRoots, manifest.runtimeExternals);
  const actual = [...artifactFiles(directory, manifest.artifactRoots), ...runtimeClosure.files].sort();
  const expected = manifest.files.map(({ path }) => path);
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error("staged release file set does not match its manifest");
  for (const { path, sha256: digest } of manifest.files) {
    if (sha256(readFileSync(join(directory, path))) !== digest) throw new Error(`staged release digest mismatch: ${path}`);
  }
  if (requireReadOnly) assertReadOnlyTree(join(directory, "node_modules"));
  return runtimeClosure;
}

function copyRuntimeClosure(sourceDirectory, directory, artifactRoots) {
  const sourceNodeModules = realpathSync(join(sourceDirectory, "node_modules"));
  const queue = runtimeEntries(sourceDirectory, artifactRoots).flatMap(({ entry, specifiers }) => specifiers.map((specifier) => ({ importer: join(sourceDirectory, entry), specifier })));
  const copied = new Set();
  while (queue.length) {
    const { importer, specifier } = queue.shift();
    const resolved = realpathSync(createRequire(importer).resolve(specifier));
    if (!resolved.startsWith(`${sourceNodeModules}${sep}`)) throw new Error(`runtime external resolved outside source dependency root: ${specifier}`);
    if (copied.has(resolved)) continue;
    copied.add(resolved);
    const manifest = packageManifest(resolved, sourceNodeModules);
    for (const source of [manifest, resolved]) {
      const target = join(directory, relative(sourceDirectory, source));
      mkdirSync(dirname(target), { recursive: true });
      cpSync(source, target);
    }
    for (const nested of importSpecifiers(resolved)) queue.push({ importer: resolved, specifier: nested });
  }
}

function artifactFiles(directory, artifactRoots) {
  return artifactRoots.flatMap((dist) => filesBelow(join(directory, dist)).map((path) => `${dist}/${path}`)).sort();
}

function releasableFiles(directory, artifactRoots) {
  return artifactFiles(directory, artifactRoots).filter((path) => !path.endsWith(".map"));
}

function sourceCommit(directory = root) {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).trim();
}

function manifestFor(directory, commit = sourceCommit(root), sourceDirectory = root) {
  const artifactRoots = declaredArtifactRoots(sourceDirectory);
  assertArtifactRoots(artifactRoots, observedArtifactRoots(directory));
  const artifacts = artifactFiles(directory, artifactRoots);
  const unmanifested = artifacts.find((path) => path.endsWith(".map"));
  if (unmanifested) throw new Error(`unmanifested release file: ${unmanifested}`);
  for (const artifactRoot of artifactRoots) {
    if (!artifacts.some((path) => path.startsWith(`${artifactRoot}/`))) throw new Error(`empty artifact root: ${artifactRoot}`);
  }
  const runtimeClosure = assertRuntimeClosure(directory, artifactRoots);
  const paths = [...artifacts, ...runtimeClosure.files].sort();
  const files = paths.map((path) => ({ path, sha256: sha256(readFileSync(join(directory, path))) }));
  const payload = { version: 2, sourceCommit: commit, toolchain: pinnedToolchain, loadAuthority: "inactive", artifactRoots, runtimeExternals: runtimeClosure.entries, files };
  return { ...payload, releaseDigest: sha256(canonicalJson(payload)) };
}

function assertManifestShape(manifest) {
  if (!manifest || typeof manifest !== "object" || canonicalJson(Object.keys(manifest).sort()) !== canonicalJson(["artifactRoots", "files", "loadAuthority", "releaseDigest", "runtimeExternals", "sourceCommit", "toolchain", "version"])) {
    throw new Error("invalid release manifest fields");
  }
  const artifactRoots = Array.isArray(manifest.artifactRoots) ? manifest.artifactRoots : [];
  const runtimeExternals = Array.isArray(manifest.runtimeExternals) ? manifest.runtimeExternals : [];
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  if (manifest.version !== 2 || !/^[0-9a-f]{40}$/u.test(manifest.sourceCommit ?? "")) throw new Error("invalid release manifest identity");
  if (canonicalJson(manifest.toolchain) !== canonicalJson(pinnedToolchain)) throw new Error("release manifest does not name the pinned toolchain");
  if (manifest.loadAuthority !== "inactive") throw new Error("release manifest loadAuthority must be inactive");
  if (artifactRoots.length === 0 || artifactRoots.some((path) => typeof path !== "string" || !/^(?:dist|(?:plugins|packages)\/[^/.][^/]*\/dist)$/u.test(path) || path.includes("..") || path.includes("\\"))) {
    throw new Error("invalid release manifest artifact roots");
  }
  if (new Set(artifactRoots).size !== artifactRoots.length || artifactRoots.some((path, index) => index > 0 && artifactRoots[index - 1] > path)) {
    throw new Error("release manifest artifact roots must be unique and sorted");
  }
  if (runtimeExternals.some(({ entry, specifiers }) => typeof entry !== "string" || !artifactRoots.some((artifactRoot) => entry === `${artifactRoot}/server.js`) || !Array.isArray(specifiers) || specifiers.some((specifier) => typeof specifier !== "string" || specifier.startsWith(".") || builtins.has(specifier)) || new Set(specifiers).size !== specifiers.length || specifiers.some((specifier, index) => index > 0 && specifiers[index - 1] > specifier))) {
    throw new Error("invalid release runtime external inventory");
  }
  if (new Set(runtimeExternals.map(({ entry }) => entry)).size !== runtimeExternals.length || runtimeExternals.some(({ entry }, index) => index > 0 && runtimeExternals[index - 1].entry > entry)) throw new Error("release runtime external inventory must be unique and sorted");
  if (files.length === 0 || files.some(({ path, sha256: digest }) => typeof path !== "string" || path.startsWith("/") || path.includes("\\") || path.split("/").includes("..") || (!artifactRoots.some((artifactRoot) => path.startsWith(`${artifactRoot}/`)) && !path.startsWith("node_modules/")) || path.endsWith(".map") || !/^[0-9a-f]{64}$/u.test(digest ?? ""))) {
    throw new Error("invalid release manifest files");
  }
  const paths = files.map(({ path }) => path);
  if (new Set(paths).size !== paths.length || paths.some((path, index) => index > 0 && paths[index - 1] > path)) throw new Error("release manifest files must be unique and sorted");
  if (artifactRoots.some((artifactRoot) => !paths.some((path) => path.startsWith(`${artifactRoot}/`)))) throw new Error("release manifest contains an empty artifact root");
  const { releaseDigest, ...payload } = manifest;
  const expectedDigest = sha256(canonicalJson(payload));
  if (releaseDigest !== expectedDigest) throw new Error("release manifest digest does not match its contents");
}

function verifyRelease(directory, manifestPath, sourceDirectory = root) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assertManifestShape(manifest);
  const commit = sourceCommit(sourceDirectory);
  if (manifest.sourceCommit !== commit) throw new Error(`release source ${manifest.sourceCommit} does not match source commit ${commit}`);
  const declared = declaredArtifactRoots(sourceDirectory);
  if (canonicalJson(manifest.artifactRoots) !== canonicalJson(declared)) throw new Error("release artifact roots do not match source package topology");
  assertArtifactRoots(manifest.artifactRoots, observedArtifactRoots(directory));
  for (const { path, sha256: digest } of manifest.files) {
    if (!existsSync(join(directory, path)) || sha256(readFileSync(join(directory, path))) !== digest) throw new Error(`release artifact digest mismatch: ${path}`);
  }
  const runtimeClosure = assertRuntimeClosure(directory, manifest.artifactRoots, manifest.runtimeExternals);
  const expected = manifest.files.map(({ path }) => path);
  const actual = [...artifactFiles(directory, manifest.artifactRoots), ...runtimeClosure.files].sort();
  const unmanifested = actual.find((path) => path.endsWith(".map"));
  if (unmanifested) throw new Error(`unmanifested release file: ${unmanifested}`);
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error("release artifact file set does not match its manifest");
  return manifest;
}

function assertPinnedToolchain() {
  let actualBb = "unavailable";
  try {
    actualBb = execFileSync("bb", ["--version"], { encoding: "utf8" }).trim();
  } catch {}
  if (process.version !== pinnedToolchain.nodeVersion || actualBb !== pinnedToolchain.bbVersion) {
    throw new Error(`release build requires Node ${pinnedToolchain.nodeVersion} and bb ${pinnedToolchain.bbVersion}; got Node ${process.version} and bb ${actualBb}`);
  }
}

function buildRelease() {
  assertPinnedToolchain();
  const artifactRoots = declaredArtifactRoots();
  const observedBeforeBuild = observedArtifactRoots(root);
  const undeclared = observedBeforeBuild.find((path) => !artifactRoots.includes(path));
  if (undeclared) throw new Error(`undeclared artifact root: ${undeclared}`);
  for (const artifactRoot of artifactRoots) rmSync(join(root, artifactRoot), { recursive: true, force: true });
  for (const packageRoot of packageRoots()) execFileSync("npm", ["run", "build", "--silent"], { cwd: packageRoot, stdio: "inherit" });
  assertArtifactRoots(artifactRoots, observedArtifactRoots(root));
  for (const path of releasableFiles(root, artifactRoots).filter((path) => path.endsWith(".meta.json"))) {
    const metadata = JSON.parse(readFileSync(join(root, path), "utf8"));
    if (metadata.sdkVersion !== pinnedToolchain.pluginSdkVersion
      || metadata.builtWith?.pluginSdkVersion !== pinnedToolchain.pluginSdkVersion
      || metadata.builtWith?.bbVersion !== pinnedToolchain.bbVersion) {
      throw new Error(`${path} does not carry the pinned bb/plugin SDK metadata`);
    }
  }
  execFileSync(process.execPath, [join(root, "scripts", "check-css-bundle.mjs")], { cwd: root, stdio: "inherit" });
  execFileSync(process.execPath, [join(root, "scripts", "role-brief-bundle.mjs")], { cwd: root, stdio: "inherit" });
  rmSync(releaseDirectory, { recursive: true, force: true });
  for (const path of releasableFiles(root, artifactRoots)) {
    const target = join(releaseDirectory, path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(root, path), target);
  }
  copyRuntimeClosure(root, releaseDirectory, artifactRoots);
  const manifest = manifestFor(releaseDirectory);
  writeFileSync(join(releaseDirectory, manifestName), `${canonicalJson(manifest)}\n`);
  verifyRelease(releaseDirectory, join(releaseDirectory, manifestName));
  console.log(`release ${manifest.releaseDigest}`);
}

function invokePinnedBuild() {
  const env = { ...process.env, BB_COLLAB_RELEASE_PINNED: "1" };
  delete env.BB_CLI;
  execFileSync("npm", ["exec", "--yes", `--package=${pinnedToolchain.bbPackage}`, "--", process.execPath, fileURLToPath(import.meta.url), "build"], {
    cwd: root,
    env,
    stdio: "inherit",
  });
}

function main(argv) {
  const [command = "build", argument] = argv;
  if (command === "build") {
    if (process.env.BB_COLLAB_RELEASE_PINNED === "1") buildRelease();
    else invokePinnedBuild();
    return;
  }
  if (command === "verify" && argument) {
    verifyRelease(resolve(argument), join(resolve(argument), manifestName));
    return;
  }
  throw new Error("usage: release-artifact.mjs [build | verify <release-directory>]");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main(process.argv.slice(2));

export { canonicalJson, manifestFor, pinnedToolchain, verifyRelease, verifyRuntimeClosure };
