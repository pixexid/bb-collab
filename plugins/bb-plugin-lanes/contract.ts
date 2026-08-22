import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const id = z.string().trim().min(1).max(256);

export const laneSchema = z.object({
  projectId: id,
  laneId: id,
  assignmentId: id.nullable(),
  assignmentKind: z.enum(["write", "review", "probe"]),
  workItemId: id,
  threadId: id.nullable(),
  executionAttemptId: id,
  attemptState: z.string(),
  workerStatus: z.enum(["active", "idle", "error", "starting", "stopping"]).nullable(),
  waitingOn: z.string().nullable(),
  ageMs: z.number().int().nonnegative(),
  tone: z.enum(["default", "running", "success", "error"]),
  queueState: z.enum(["ready", "running", "deferred"]),
  queueBlocked: z.boolean(),
  nextStartable: z.boolean(),
  deferredReason: z.literal("awaiting_operator").nullable(),
  deferredAtMs: z.number().int().nonnegative().nullable(),
  deferredAgeMs: z.number().int().nonnegative().nullable(),
}).strict();

export const laneListSchema = z.array(laneSchema);

export const rpcContract = defineRpcContract({
  lanes: {
    input: z.object({}).strict(),
    output: laneListSchema,
  },
});
