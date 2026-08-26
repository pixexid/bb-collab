import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const checker = join(root, "scripts", "check-production-reachability.mjs");

function writeImportOnlyFixture() {
  const directory = mkdtempSync(join(tmpdir(), "bb-collab-production-reachability-import-only-"));
  mkdirSync(join(directory, "src"));
  writeFileSync(join(directory, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(directory, "tsconfig.json"), JSON.stringify({
    compilerOptions: { module: "ESNext", moduleResolution: "Bundler", target: "ES2022" },
  }));
  writeFileSync(join(directory, "server.ts"), "export default {};\n");
  writeFileSync(join(directory, "src", "exported.ts"), "export function importedButUnused() {}\n");
  writeFileSync(join(directory, "src", "consumer.ts"), "import { importedButUnused } from \"./exported.js\";\n");
  return directory;
}

function writeFixture() {
  const directory = mkdtempSync(join(tmpdir(), "bb-collab-production-reachability-"));
  mkdirSync(join(directory, "src"));
  mkdirSync(join(directory, "tests"));
  writeFileSync(join(directory, "package.json"), JSON.stringify({
    exports: { "./api": "./dist/public-api.js" },
    type: "module",
  }));
  writeFileSync(join(directory, "tsconfig.json"), JSON.stringify({
    compilerOptions: { module: "ESNext", moduleResolution: "Bundler", target: "ES2022" },
  }));
  writeFileSync(join(directory, "server.ts"), "export default {};\nexport function serverNamed() {}\n");
  writeFileSync(join(directory, "src", "feature.ts"), `
export function calledInProduction() {}
export function testOnly() {}
export function unreferenced() {}
export function importedButUnused() {}
export function barrelOnly() {}
export interface Structural { value: string }
`);
  writeFileSync(join(directory, "src", "dynamic-target.ts"), "export function dynamicallySelected() {}\n");
  writeFileSync(join(directory, "src", "registry-target.ts"), "export function registrySelected() {}\n");
  writeFileSync(join(directory, "src", "consumer.ts"), `
import { calledInProduction } from "./feature.js";
calledInProduction();
`);
  writeFileSync(join(directory, "src", "import-only.ts"), `
import { importedButUnused } from "./feature.js";
`);
  writeFileSync(join(directory, "src", "barrel.ts"), "export { barrelOnly } from \"./feature.js\";\n");
  writeFileSync(join(directory, "src", "dynamic.ts"), `
import * as feature from "./dynamic-target.js";
const key = "dynamicallySelected";
feature[key];
`);
  writeFileSync(join(directory, "src", "registry.ts"), `
import { registrySelected } from "./registry-target.js";
const registry = { registrySelected };
const key = "registrySelected";
registry[key]();
`);
  writeFileSync(join(directory, "src", "public-api.ts"), "export function externalOnly() {}\n");
  writeFileSync(join(directory, "src", "test-support.ts"), `
export function seedFixtureReceipt() {}
export function assembleV17CachedConsumerRolloutEvidence() {}
`);
  writeFileSync(join(directory, "tests", "feature.test.ts"), `
import { testOnly } from "../src/feature.js";
import { assembleV17CachedConsumerRolloutEvidence } from "../src/test-support.js";
testOnly();
assembleV17CachedConsumerRolloutEvidence();
`);
  return directory;
}

function run(directory: string) {
  try {
    return { exitCode: 0, result: JSON.parse(execFileSync(process.execPath, [checker, "--root", directory], { encoding: "utf8" })) };
  } catch (error) {
    const failure = error as { status?: number; stdout: string };
    return { exitCode: failure.status ?? 1, result: JSON.parse(failure.stdout) };
  }
}

function report(directory: string) {
  return run(directory).result;
}

describe("production reachability report", () => {
  it("fails when production only imports an export without invoking it", () => {
    const directory = writeImportOnlyFixture();
    try {
      const execution = run(directory);
      expect(execution.exitCode).toBe(1);
      expect(execution.result.findings).toMatchObject([
        { names: ["importedButUnused"], status: "STATIC_UNREFERENCED" },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps unknown classes fail-closed and does not count a barrel as a caller", () => {
    const directory = writeFixture();
    try {
      const result = report(directory);
      expect(result.mode).toBe("enforced");
      expect(result.unknownIsNotReachable).toBe(true);
      const status = new Map(result.rows.flatMap((row: { names: string[]; status: string }) => row.names.map((name) => [name, row.status])));
      expect(status.get("calledInProduction")).toBe("STATIC_PRODUCTION_REFERENCE");
      expect(status.get("importedButUnused")).toBe("STATIC_UNREFERENCED");
      expect(status.get("barrelOnly")).toBe("STATIC_UNREFERENCED");
      expect(status.get("dynamicallySelected")).toBe("UNKNOWN_DYNAMIC");
      expect(status.get("registrySelected")).toBe("UNKNOWN_DYNAMIC");
      expect(result.rows.find((row: { names: string[] }) => row.names.includes("registrySelected"))).toMatchObject({ status: "UNKNOWN_DYNAMIC", productionReferenceCount: 0 });
      expect(result.unknown.dynamicExports.some((row: { names: string[] }) => row.names.includes("registrySelected"))).toBe(true);
      expect(status.get("externalOnly")).toBe("UNKNOWN_EXTERNAL");
      expect(status.get("Structural")).toBe("UNKNOWN_TYPE_ONLY");
      expect(status.get("default")).toBe("EXEMPT_PACKAGE_ENTRYPOINT");
      expect(result.exemptions.helperConvention.map((row: { names: string[] }) => row.names[0])).toContain("seedFixtureReceipt");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("flags the historical test-support shape while tolerating the wired calculator", () => {
    const directory = writeFixture();
    try {
      const result = report(directory);
      const findings = new Map(result.findings.map((row: { names: string[]; status: string }) => [row.names[0], row.status]));
      expect(findings.get("assembleV17CachedConsumerRolloutEvidence")).toBe("STATIC_TEST_ONLY");
      expect(findings.get("testOnly")).toBe("STATIC_TEST_ONLY");
      expect(findings.get("unreferenced")).toBe("STATIC_UNREFERENCED");
      expect(result.findings.some((row: { names: string[] }) => row.names.includes("calledInProduction"))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
