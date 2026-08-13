import { defineRpcContract, type BbPluginApi, type PluginCliContext } from "@bb/plugin-sdk";
import { z } from "zod";
import {
  BB_VERSION_RANGE,
  MIGRATIONS,
  PLUGIN_ID,
  PLUGIN_SDK_VERSION,
  applyRequestSchema,
  databaseIsReady,
  doctor,
  exportFoundation,
  operatorAuthRequired,
  parseApplyRequest,
  type FoundationResult,
  type SqliteDatabase,
} from "./src/foundation.js";

const projectIdSchema = z.string().trim().min(1).max(256);
const mutationReceiptSchema = z
  .object({
    projectId: projectIdSchema,
    idempotencyKey: z.string(),
    operationClass: z.string(),
    requestDigest: z.string(),
    committedEventSequence: z.number().int().positive(),
    createdAtMs: z.number().int().nonnegative(),
  })
  .strict();
const exportSchema = z
  .object({
    manifest: z
      .object({
        schemaVersion: z.number().int().positive(),
        contractVersion: z.number().int().positive(),
        pluginId: z.string(),
        projectId: projectIdSchema,
        migrationStatementIds: z.array(z.number().int().nonnegative()),
        schemaDigest: z.string(),
        contractDigest: z.string(),
        rowCount: z.number().int().nonnegative(),
        tableCounts: z.record(z.string(), z.number().int().nonnegative()),
        recordsDigest: z.string(),
        artifactIndexDigest: z.string(),
        exportRootDigest: z.string(),
      })
      .strict(),
    recordsNdjson: z.string(),
    artifactIndex: z.array(
      z
        .object({
          evidenceId: z.string(),
          evidenceKind: z.string(),
          sourceKind: z.string(),
          sourceRef: z.string(),
          executionAttemptId: z.string().nullable(),
          contentDigest: z.string(),
          redactedJson: z.string(),
          redactedDigest: z.string(),
          durableRefJson: z.string(),
          artifactIdentityDigest: z.string(),
        })
        .strict(),
    ),
    checksums: z.record(z.string(), z.string()),
  })
  .strict();
export const foundationResultSchema = z
  .object({
    outcome: z.string(),
    subject: z.string(),
    expected: z.number().int().nonnegative(),
    attempted: z.number().int().nonnegative(),
    verified: z.number().int().nonnegative(),
    message: z.string().optional(),
    currentConfigRevision: z.number().int().positive().optional(),
    expectedConfigRevision: z.number().int().nonnegative().optional(),
    currentGovernanceEpoch: z.number().int().positive().optional(),
    expectedGovernanceEpoch: z.number().int().nonnegative().optional(),
    currentResourceRevision: z.number().int().positive().optional(),
    expectedResourceRevision: z.number().int().positive().optional(),
    mutationReceipt: mutationReceiptSchema.optional(),
    eventSequence: z.number().int().positive().optional(),
    evidence: z.unknown().optional(),
    export: exportSchema.optional(),
  })
  .strict();

export const rpcContract = defineRpcContract({
  doctor: {
    input: z.object({ projectId: projectIdSchema }).strict(),
    output: foundationResultSchema,
  },
  export: {
    input: z.object({ projectId: projectIdSchema }).strict(),
    output: foundationResultSchema,
  },
  apply: {
    input: applyRequestSchema,
    output: foundationResultSchema,
  },
});

function jsonResult(result: FoundationResult): string {
  return JSON.stringify(result);
}

function cliResult(result: FoundationResult) {
  return {
    exitCode: result.outcome === "OK" ? 0 : 2,
    stdout: jsonResult(result),
  };
}

function invalidCli(message: string) {
  return cliResult({
    outcome: "INVALID_INPUT",
    subject: "cli",
    expected: 1,
    attempted: 0,
    verified: 0,
    message,
  });
}

function parseFlag(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  if (args.indexOf(name, index + 1) >= 0 || !args[index + 1] || args[index + 1].startsWith("--")) return "";
  return args[index + 1];
}

function unexpectedFlags(args: string[], allowed: readonly string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) return arg;
    if (!allowed.includes(arg)) return arg;
    index += 1;
    if (!args[index] || args[index].startsWith("--")) return arg;
  }
  return null;
}

async function runCli(
  db: SqliteDatabase | null,
  sdk: Parameters<typeof doctor>[1],
  argv: string[],
  _ctx: PluginCliContext,
) {
  const command = argv[0];
  const args = argv.slice(1);
  if (!command || !["doctor", "export", "apply"].includes(command)) return invalidCli("expected doctor, export, or apply");
  const projectId = parseFlag(args, "--project");
  if (!projectId) return invalidCli("--project PROJECT_ID is required; CLI context is never used as a fallback");
  if (command === "apply") {
    const unknown = unexpectedFlags(args, ["--project", "--request"]);
    if (unknown) return invalidCli(`unexpected flag ${unknown}`);
    const requestJson = parseFlag(args, "--request");
    if (!requestJson) return invalidCli("--request JSON is required");
    try {
      const request = parseApplyRequest(JSON.parse(requestJson));
      if (request.projectId !== projectId) return invalidCli("--project does not match request.projectId");
      return cliResult(operatorAuthRequired(projectId));
    } catch (error) {
      return invalidCli(error instanceof Error ? error.message : String(error));
    }
  }
  const unknown = unexpectedFlags(args, ["--project"]);
  if (unknown) return invalidCli(`unexpected flag ${unknown}`);
  if (command === "doctor") return cliResult(await doctor(db, sdk, projectId));
  return cliResult(exportFoundation(db, projectId));
}

export default async function plugin(bb: BbPluginApi) {
  let db: SqliteDatabase | null = null;
  try {
    db = bb.storage.database();
    databaseIsReady(db);
    bb.storage.migrate(db, MIGRATIONS);
  } catch (error) {
    bb.log.error(`canonical store unavailable: ${String(error)}`);
    db = null;
  }

  bb.rpc.register(rpcContract, {
    async doctor(input) {
      return doctor(db, bb.sdk, input.projectId);
    },
    async export(input) {
      return exportFoundation(db, input.projectId);
    },
    async apply(input) {
      return operatorAuthRequired(input.projectId);
    },
  });

  bb.cli.register({
    name: "collab",
    summary: "Inspect the bb-collab foundation and guarded conformance boundary",
    commands: [
      { name: "doctor", summary: "Read-only project/store conformance check", usage: "bb collab doctor --project PROJECT_ID" },
      { name: "export", summary: "Deterministic bounded foundation export", usage: "bb collab export --project PROJECT_ID" },
      {
        name: "apply",
        summary: "Explicit foundation apply (operator authentication required)",
        usage: "bb collab apply --project PROJECT_ID --request JSON",
      },
    ],
    run(argv, context) {
      return runCli(db, bb.sdk, argv, context);
    },
  });

  bb.log.info(`${PLUGIN_ID} loaded for BB ${BB_VERSION_RANGE}; plugin SDK ${PLUGIN_SDK_VERSION}`);
}
