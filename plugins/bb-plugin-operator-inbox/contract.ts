import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const id = z.string().trim().min(1).max(256);
const text = z.string().trim().min(1).max(16_000);
const messageId = z.number().int().positive();

export const operatorMessageSchema = z.object({
  messageId,
  projectId: id,
  recipient: z.enum(["operator", "supervisor"]),
  senderThreadId: id,
  senderLaneId: id.nullable(),
  severity: z.enum(["routine", "needs-decision", "urgent"]),
  text,
  createdAtMs: z.number().int().nonnegative(),
  readAtMs: z.number().int().nonnegative().nullable(),
  archivedAtMs: z.number().int().nonnegative().nullable(),
  senderTitle: z.string().nullable(),
  repliedAtMs: z.number().int().nonnegative().nullable(),
  replyText: text.nullable(),
  replyDeliveryError: z.string().nullable(),
  replyInProgress: z.boolean(),
  notificationStatus: z.enum(["not-requested", "deduplicated", "sent", "failed"]),
  notificationError: z.string().nullable(),
}).strict();

export const operatorMessagesInputSchema = z.object({
  projectId: id,
  recipient: z.enum(["operator", "supervisor"]).optional(),
  includeArchived: z.boolean().optional(),
  withSenderTitles: z.boolean().optional(),
}).strict();

export const operatorMessagesResultSchema = z.object({
  outcome: z.enum(["OK", "PROJECT_CONFIG_REQUIRED"]),
  message: z.string().optional(),
  messages: z.array(operatorMessageSchema),
}).strict();

export const messageMutationInputSchema = z.object({ projectId: id, messageId }).strict();
export const replyInputSchema = messageMutationInputSchema.extend({ text }).strict();

export const rpcContract = defineRpcContract({
  operatorMessages: { input: operatorMessagesInputSchema, output: operatorMessagesResultSchema },
  markOperatorMessageRead: { input: messageMutationInputSchema, output: operatorMessageSchema },
  archiveOperatorMessage: { input: messageMutationInputSchema, output: operatorMessageSchema },
  replyToOperatorMessage: { input: replyInputSchema, output: operatorMessageSchema },
});
